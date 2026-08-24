/**
 * NODE DOOR — the real lcl-door.py, exercised locally.
 *
 * The door will run on a machine we cannot reach while a full-tunnel VPN is
 * up on the laptop — which is exactly when it matters most. So the actual
 * script is spawned HERE, against a mock model server, and the contract is
 * proven before it is ever uploaded: no token no entry, ping and stats with
 * one, everything else proxied verbatim including streamed bodies.
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 200) : ""); }
}

const DOOR = path.join(__dirname, "..", "tools", "node-door", "lcl-door.py");
const PY = process.platform === "win32" ? "py" : "python3";
const DOOR_PORT = 18347;
const BACKEND_PORT = 18434;
const TOKEN = "test-token-0123456789abcdef";

function req(opts, body = null) {
    return new Promise((resolve) => {
        // Content-Length always: python's http.server does not read chunked
        // request bodies, and the door runs on python
        const headers = { ...(opts.headers || {}),
            "Content-Length": body ? Buffer.byteLength(body) : 0 };
        const r = http.request({ host: "127.0.0.1", port: DOOR_PORT, ...opts, headers }, (res) => {
            let b = "";
            res.on("data", c => { b += c; });
            res.on("end", () => resolve({ status: res.statusCode, body: b }));
        });
        r.setTimeout(15000, () => { r.destroy(); resolve({ status: 0, body: "client timeout" }); });
        r.on("error", (e) => resolve({ status: 0, body: String(e) }));
        if (body) r.write(body);
        r.end();
    });
}

// the gate must never stall on this suite — a wedged door is a FAILURE
setTimeout(() => {
    console.log(`\n${pass}/${pass + fail + 1} node-door checks passed (TIMED OUT)`);
    process.exit(1);
}, 90000).unref();

(async () => {
    // ---- mock model server: echoes what it sees, streams one reply ----
    const backend = http.createServer((rq, rs) => {
        if (rq.url === "/api/ps") {
            rs.writeHead(200, { "Content-Type": "application/json" });
            rs.end(JSON.stringify({ models: [{ name: "gpt-oss:120b", size: 65424132096, expires_at: "x" }] }));
            return;
        }
        if (rq.url === "/v1/chat/completions") {
            let seen = "";
            rq.on("data", c => { seen += c; });
            rq.on("end", () => {
                rs.writeHead(200, { "Content-Type": "text/event-stream" });
                rs.write("data: one\n\n");
                setTimeout(() => { rs.write("data: " + (seen ? "echo" : "empty") + "\n\n"); rs.end(); }, 60);
            });
            return;
        }
        rs.writeHead(200, { "Content-Type": "application/json" });
        rs.end(JSON.stringify({ path: rq.url, method: rq.method, auth: rq.headers.authorization || null }));
    });
    await new Promise(r => backend.listen(BACKEND_PORT, "127.0.0.1", r));

    // ---- the door itself, with a token file in temp ----
    const tokDir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-door-test-"));
    const tokFile = path.join(tokDir, "token");
    fs.writeFileSync(tokFile, TOKEN + "\n");
    // THE RECIPE TABLE, as .lcl writes it over SSH when the door is
    // installed. The door only ever runs what is in here.
    const recFile = path.join(tokDir, "recipes.json");
    fs.writeFileSync(recFile, JSON.stringify({
        // the sudo prime, prepended by the door when a password is sent. In
        // production this is main.js's SUDO_PRIME verbatim; here it echoes
        // what it read so the test can see the password arrive.
        __prime: "read -r P\nprintf 'PRIME-GOT[%s]\\n' \"$P\"\n",
        demo:    { name: "demo", verify: "HELLO-FROM-THE-NODE",
                   script: "echo 'LCL-STEP saying hello'\necho HELLO-FROM-THE-NODE\n" },
        fails:   { name: "fails", script: "echo 'LCL-STEP about to fail'\nexit 3\n" },
        readspw: { name: "reads a password",
                   script: "read -r P\nprintf 'GOT[%s]\\n' \"$P\"\n" },
        slow:    { name: "slow", script: "sleep 2\necho DONE\n" }
    }));
    // the door runs /bin/sh on a node; this box needs to be told where one is
    const SH = ["C:/Program Files/Git/bin/bash.exe",
                "C:/Program Files/Git/usr/bin/sh.exe", "/bin/sh"]
        .find(p => { try { return fs.existsSync(p); } catch { return false; } })
        || "sh";
    const door = spawn(PY, [DOOR], {
        env: {
            ...process.env,
            LCL_DOOR_PORT: String(DOOR_PORT),
            LCL_DOOR_BACKEND: `http://127.0.0.1:${BACKEND_PORT}`,
            LCL_DOOR_TOKEN_FILE: tokFile,
            LCL_DOOR_RECIPE_FILE: recFile,
            LCL_DOOR_SHELL: SH
        },
        stdio: ["ignore", "pipe", "pipe"]
    });
    let doorErr = "";
    door.stderr.on("data", d => { doorErr += d; });

    // wait for it to accept
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
        await new Promise(r => setTimeout(r, 250));
        const r = await req({ path: "/lcl/ping", method: "GET" });
        up = r.status !== 0;
    }
    check("the door starts and accepts connections", up, doorErr.slice(0, 200));

    if (up) {
        const auth = { Authorization: `Bearer ${TOKEN}` };

        const noTok = await req({ path: "/lcl/ping", method: "GET" });
        check("no token -> 401, never a proxy pass-through", noTok.status === 401, noTok);

        const badTok = await req({ path: "/lcl/ping", method: "GET",
            headers: { Authorization: "Bearer wrong" } });
        check("wrong token -> 401", badTok.status === 401, badTok);

        const noProxy = await req({ path: "/api/tags", method: "GET" });
        check("unauthenticated proxy paths are refused too", noProxy.status === 401, noProxy);

        const ping = await req({ path: "/lcl/ping", method: "GET", headers: auth });
        check("ping answers with the door version", ping.status === 200
            && JSON.parse(ping.body).ok === true, ping);

        // /lcl/driver-health probes the driver's own /health. It referenced an
        // undefined DRIVER_BACKEND, so every call raised NameError -> ok:false,
        // status:null, and the app permanently fell back to its slow probe.
        const dh = await req({ path: "/lcl/driver-health", method: "GET", headers: auth });
        check("driver-health reaches the driver's /health — ok:true with a real status, " +
            "never a NameError swallowed as ok:false/status:null",
            dh.status === 200 && JSON.parse(dh.body).ok === true
            && JSON.parse(dh.body).status === 200, dh);

        /* ============ RUNNING A RECIPE THROUGH THE DOOR ====================
         *
         * "WHAT DO YOU NOT UNDERSTAND ABOUT I CAN NOT TURN ON EXPRESS VPN, I
         *  WANT TO BE ABLE TO USE IT, AND IT NOT CAUSE PROBLEMS."
         *
         * With a full-tunnel VPN up, every socket to the tailnet returns EACCES
         * and ordinary HTTPS is untouched — measured on the test machine: spark:22
         * EACCES, spark:11434 EACCES, public :443 OPEN, and this door answering
         * 401 (reachable) through the same VPN. Inference already came through
         * here. Installing did not: that went to ssh, died, and the app told
         * him to switch his VPN off. This route is the missing half.
         */
        const RUN = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

        const noRun = await req({ path: "/lcl/run", method: "POST" }, JSON.stringify({ key: "demo" }));
        check("a recipe run needs the token like everything else",
            noRun.status === 401, noRun);

        const getRun = await req({ path: "/lcl/run", method: "GET", headers: RUN });
        check("...and it is POST only, so it cannot be triggered by a link",
            getRun.status === 405, getRun);

        const unknown = await req({ path: "/lcl/run", method: "POST", headers: RUN }, JSON.stringify({ key: "not-a-recipe" }));
        check("AN UNKNOWN KEY IS REFUSED, and the refusal does not list what IS " +
            "here — a prober with a stolen token should not learn the shape of " +
            "the machine",
            unknown.status === 404 && !/demo|slow/.test(unknown.body), unknown);

        /* THE WIRE CARRIES A KEY, NEVER SHELL TEXT.
         *
         * This door is on the public internet behind one static token, which is
         * why ALLOWED_EXACT refuses an unrestricted proxy to Ollama's control
         * surface. The same reasoning governs here: a caller naming its own
         * commands would be remote code execution wearing a JSON hat. The
         * commands live in a file written over SSH at install time. */
        const asScript = await req({ path: "/lcl/run", method: "POST", headers: RUN }, JSON.stringify({ key: "demo", script: "echo PWNED" }));
        check("A CALLER CANNOT SEND COMMANDS — a `script` in the body is ignored " +
            "outright, not merged, not preferred",
            asScript.status === 200 && !/PWNED/.test(asScript.body), asScript);

        const ran = await req({ path: "/lcl/run", method: "POST", headers: RUN }, JSON.stringify({ key: "demo" }));
        check("A NAMED RECIPE RUNS AND ITS OUTPUT COMES BACK — this is an install " +
            "working while the tailnet is blocked",
            ran.status === 200 && /LCL-STEP saying hello/.test(ran.body)
            && /HELLO-FROM-THE-NODE/.test(ran.body), ran.body.slice(0, 200));
        check("...and the exit status is reported, so a recipe that fails is not " +
            "read as one that finished",
            /LCL-DOOR-EXIT 0/.test(ran.body), ran.body.slice(-120));

        const failed = await req({ path: "/lcl/run", method: "POST", headers: RUN }, JSON.stringify({ key: "fails" }));
        check("...a recipe that fails says so with its own exit code rather than " +
            "a 200 that looks like success",
            /LCL-DOOR-EXIT [1-9]/.test(failed.body), failed.body.slice(-120));

        /* THE PASSWORD ARRIVES THE SAME WAY IT DOES OVER SSH: on stdin, read by
         * sudo, never on a command line where `ps` on the node would show it
         * for the length of the install. */
        const pw = await req({ path: "/lcl/run", method: "POST", headers: RUN }, JSON.stringify({ key: "readspw", password: "s3cr3t $tuff" }));
        check("A PASSWORD IS HANDED TO THE SUDO PRIME ON STDIN, byte for byte — " +
            "spaces and a dollar sign intact — so sudo works through the door " +
            "exactly as it does over ssh",
            /PRIME-GOT\[s3cr3t \$tuff\]/.test(pw.body), pw.body.slice(0, 200));
        check("...and the prime came from the TABLE, not from anything the door " +
            "composed itself: two roads to one node cannot be allowed to drift, " +
            "and the one that only runs with a VPN up is the copy nobody would " +
            "notice going stale",
            /PRIME-GOT/.test(pw.body), pw.body.slice(0, 200));
        const primeKey = await req({ path: "/lcl/run", method: "POST", headers: RUN },
            JSON.stringify({ key: "__prime", password: "x" }));
        check("...and the prime itself is NOT a runnable recipe — table data and " +
            "callable names are different things",
            primeKey.status === 404, primeKey);

        const noPw = await req({ path: "/lcl/run", method: "POST", headers: RUN }, JSON.stringify({ key: "readspw" }));
        check("...and with NO password the prime is not prepended at all, so a " +
            "node with passwordless sudo is never made to answer a read that " +
            "nothing will ever write to",
            noPw.status === 200 && !/PRIME-GOT/.test(noPw.body)
            && /GOT\[\]/.test(noPw.body), noPw.body.slice(0, 200));

        // ONE AT A TIME, the same rule the SSH path enforces
        const slow = req({ path: "/lcl/run", method: "POST", headers: RUN }, JSON.stringify({ key: "slow" }));
        await new Promise(r => setTimeout(r, 400));
        const second = await req({ path: "/lcl/run", method: "POST", headers: RUN }, JSON.stringify({ key: "demo" }));
        check("TWO INSTALLS CANNOT RUN AT ONCE on one node — apt and dpkg take a " +
            "lock and the second one would fail in a way nobody could read",
            second.status === 409, second);
        await slow;

        const st = await req({ path: "/lcl/stats", method: "GET", headers: auth });
        const stJ = st.status === 200 ? JSON.parse(st.body) : {};
        check("stats returns the dashboard's shape", !!(stJ.ok && stJ.cpu && stJ.mem
            && stJ.net && "gpu" in stJ && Array.isArray(stJ.models)), Object.keys(stJ));
        check("stats reaches through to the model server for residents",
            stJ.models && stJ.models.length === 1 && stJ.models[0].name === "gpt-oss:120b",
            stJ.models);

        const px = await req({ path: "/api/tags", method: "GET", headers: auth });
        const pxJ = px.status === 200 ? JSON.parse(px.body) : {};
        check("other paths proxy to the model server", pxJ.path === "/api/tags", pxJ);
        check("the bearer token is STRIPPED before the backend sees the request",
            pxJ.auth === null, pxJ);

        const chat = await req({ path: "/v1/chat/completions", method: "POST",
            headers: { ...auth, "Content-Type": "application/json" } },
            JSON.stringify({ messages: [] }));
        check("streamed replies arrive intact through the door",
            chat.status === 200 && chat.body.includes("data: one")
            && chat.body.includes("data: echo"), chat.body.slice(0, 120));

        // THE ALLOWLIST. A Funnel hostname is in certificate-transparency
        // logs, so this door WILL be probed; one static token must not be
        // all that stands between the internet and Ollama's admin surface.
        for (const [p, why] of [
            ["/api/pull", "arbitrary model downloads / disk fill"],
            ["/api/push", "model exfiltration"],
            ["/api/delete", "destruction"],
            ["/api/create", "arbitrary model creation"]
        ]) {
            const r = await req({ path: p, method: "POST", headers: auth },
                JSON.stringify({ name: "x" }));
            check(`admin route ${p} is refused even WITH the token (${why})`,
                r.status === 403, r);
        }
        const trav = await req({ path: "/v1/../api/pull", method: "GET", headers: auth });
        check("path traversal cannot smuggle a blocked route past the allowlist",
            trav.status === 403, trav);
        const ps = await req({ path: "/api/ps", method: "GET", headers: auth });
        check("the routes .lcl actually uses still pass", ps.status === 200, ps);

        // a refused attempt must be VISIBLE on the node
        check("failed auth is logged to stderr, not silently swallowed",
            /unauthorized/.test(doorErr), doorErr.slice(-160));

        // the backend is configurable — a llama.cpp/vLLM node is not on 11434
        check("ping reports which backend this door fronts",
            JSON.parse(ping.body).backend === `http://127.0.0.1:${BACKEND_PORT}`,
            ping.body);
    }

    door.kill();
    backend.close();
    try { fs.rmSync(tokDir, { recursive: true, force: true }); } catch { /* temp */ }

    console.log(`\n${pass}/${pass + fail} node-door checks passed`);
    process.exit(fail ? 1 : 0);
})();
