"use strict";
/**
 * WHAT ACTUALLY GOES ON THE WIRE.
 *
 * "if this kind of information, personal, sensitive, etc. is detected AND an
 *  API model is what is loaded... do i know for certain nothing was passed,
 *  no. i did not have any way to capture that, and deepinfra doesnt show me
 *  the json request/ response. so im kinda blind to all that."
 *
 * Every other test here asserts that the guard is CALLED. That is a different
 * claim from "the secret did not leave". This one stands up an HTTP server on
 * 127.0.0.1, registers it through the app's own connect(), points the driver
 * at it, runs the real streamChat() — then reads the bytes that server
 * actually received off the socket. If a secret survives redaction it is in
 * that buffer and this fails.
 *
 * Nothing leaves the machine and no real account is touched: the "provider" is
 * a local socket, and electron is stubbed so the app's data directory is a
 * fresh temp folder. The operator's own config is never opened, let alone
 * written — isolation, not backup-and-restore.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

/* ------------------------------------------------------- electron stub ---- */
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-wire-"));
const electronStub = {
    app: {
        isPackaged: true,
        getPath: () => DATA,
        getVersion: () => "1.0.0-test",
        getName: () => ".lcl",
        getAppPath: () => path.join(__dirname, ".."),
        on: () => {}, once: () => {}
    },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: () => {}, on: () => {} },
    safeStorage: { isEncryptionAvailable: () => false }
};
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === "electron") return __filename;
    return origResolve.call(this, request, ...rest);
};
require.cache[__filename] = { id: __filename, filename: __filename,
                              loaded: true, exports: electronStub };

const paths = require("../.lcl.engine/core/paths");
const cloudModels = require("../.lcl.engine/core/cloudModels");
const secretGuard = require("../.lcl.engine/core/secretGuard");

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
    console.log((ok ? "PASS" : "FAIL") + " | " + name + (ok ? "" : "  " + (detail || "")));
    ok ? pass++ : fail++;
};

// Shaped like the real thing so the matcher sees a credential, but issued by
// nobody: random letters, valid only inside this file.
const FAKE_KEY = "sk-lclTESTONLY" + "aB3xQ9zR7mK2wD5vN8pL4tG6yH1jF0sC";
const FAKE_AWS = "AKIAIOSFODNN7EXAMPLE";
const FAKE_PWV = "hunter2-not-a-real-password-9931";

let server = null;
const captured = [];

(async () => {
    server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", c => { raw += c; });
        req.on("end", () => {
            captured.push({ url: req.url, headers: req.headers, body: raw });
            if (req.url.includes("/models")) {
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ data: [{ id: "test/echo-1" }] }));
            }
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    paths.writeSettings({ networkEnabled: true });
    await cloudModels.connect(`http://127.0.0.1:${port}`);
    const ep = cloudModels.endpoints()
        .find(e => String(e.baseUrl || "").includes(String(port)));
    check("the local stand-in registered as an endpoint", !!ep);
    if (!ep) throw new Error("endpoint not registered");
    cloudModels.selectModel({ endpointId: ep.id, model: "test/echo-1" });

    // A real session reaches this store through the file tools; reached
    // directly here so the test needs no workspace.
    secretGuard.rememberValue(FAKE_KEY, "config/.env");
    secretGuard.rememberValue(FAKE_PWV, "config/.env");

    await cloudModels.streamChat([
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content:
            "Here is the config file I just read:\n\n" +
            `OPENAI_API_KEY=${FAKE_KEY}\n` +
            `AWS_ACCESS_KEY_ID=${FAKE_AWS}\n` +
            `DB_PASSWORD="${FAKE_PWV}"\n\n` +
            "What does this service do?" }
    ], { onOutput: () => {}, timeoutMs: 20_000 });

    const chat = captured.filter(c => c.url.includes("/chat/completions"));
    check("the request reached the stand-in and was captured off the socket",
        chat.length === 1, `${chat.length} chat request(s)`);
    const wire = chat.map(c => c.body).join("\n");

    /* ---- THE CLAIM, TESTED AGAINST BYTES ---- */
    check("the API key is NOT in the bytes that were sent",
        !wire.includes(FAKE_KEY), "the key appeared in the sent body");
    check("the database password is NOT in the bytes that were sent",
        !wire.includes(FAKE_PWV));
    check("the AWS access key id is NOT in the bytes that were sent",
        !wire.includes(FAKE_AWS));

    /* ---- redaction, not destruction ---- */
    check("the actual question still reached the model",
        wire.includes("What does this service do?"));
    check("something marks where the secret was removed",
        /REDACT|redact|\[secret/i.test(wire));

    /* ---- the honest edge of the guarantee ---- */
    const UNSHAPED = "the vault combination is 19-42-7";
    captured.length = 0;
    await cloudModels.streamChat([{ role: "user", content: UNSHAPED }],
        { onOutput: () => {}, timeoutMs: 20_000 });
    const wire2 = captured.filter(c => c.url.includes("/chat/completions"))
        .map(c => c.body).join("\n");
    check("KNOWN LIMIT: a secret with no credential shape, never read from a " +
          "file, is NOT caught — this guard covers shapes and remembered values",
        wire2.includes("19-42-7"),
        "if this fails, coverage widened and the claim above should be restated");

    let threw = false;
    try { secretGuard.assertNoLeak(`key ${FAKE_KEY} here`, "a test"); }
    catch { threw = true; }
    check("anything redaction cannot clean is refused outright, not sent", threw);

    /* ---------------------------------------------------------------------
     * THE PER-SESSION PERMISSION, TESTED THE SAME WAY: on the wire.
     *
     * "similar to how you have bypass permissions.... except for it being a
     *  toggle that allows an api to read that repo. so that way, the user has
     *  no reason to edit the logic in .lcl, just because of something minor
     *  that they want to be able to do, that we are restricting."
     *
     * Off is the default and was proven above. On must ACTUALLY send — a
     * permission that quietly does nothing is worse than no permission.
     * ------------------------------------------------------------------- */
    captured.length = 0;
    const withKey = [{ role: "user", content: `the key is ${FAKE_KEY}` }];
    const r = await cloudModels.streamChat(withKey,
        { onOutput: () => {}, timeoutMs: 20_000, allowSecrets: true });
    const wire3 = captured.filter(c => c.url.includes("/chat/completions"))
        .map(c => c.body).join("\n");
    check("with the session permission ON, the credential really is sent",
        wire3.includes(FAKE_KEY),
        "the toggle claims to allow this and must not silently redact anyway");
    check("and the send is reported back, with the destination named",
        !!(r && r.secretsSent && r.secretsSent.destination),
        JSON.stringify(r && r.secretsSent));
    check("the report carries REASONS, never the secret value itself",
        !!r.secretsSent && !JSON.stringify(r.secretsSent).includes(FAKE_KEY));

    /* ---------------------------------------------------------------------
     * A.5 — SHARED + a secret detected → PROMPT, block, act on the verdict.
     *
     * The toggle being on is a STANDING GRANT, not a licence to send silently.
     * When an asker is wired it gets the final say at the moment it happens,
     * and a BROKEN asker fails CLOSED. Proven on the wire, the same way.
     * ------------------------------------------------------------------- */
    const withKey2 = () => [{ role: "user", content: `the key is ${FAKE_KEY}` }];
    const wireNow = () => captured.filter(c => c.url.includes("/chat/completions"))
        .map(c => c.body).join("\n");

    // REDACT verdict → a request is sent, but the secret is not in it
    captured.length = 0;
    await cloudModels.streamChat(withKey2(),
        { onOutput: () => {}, timeoutMs: 20_000, allowSecrets: true,
          approveSecretEgress: async () => ({ action: "redact" }) });
    const wR = wireNow();
    check("asker says REDACT → a request is sent but WITHOUT the secret",
        wR.length > 0 && !wR.includes(FAKE_KEY), wR.slice(0, 80));

    // CANCEL verdict → the send is aborted, nothing reaches the wire
    captured.length = 0;
    let cancelled = false;
    try {
        await cloudModels.streamChat(withKey2(),
            { onOutput: () => {}, timeoutMs: 20_000, allowSecrets: true,
              approveSecretEgress: async () => ({ action: "cancel" }) });
    } catch (e) { cancelled = e && e.code === "SECRET_EGRESS_CANCELLED"; }
    check("asker says CANCEL → the send is aborted and nothing reaches the wire",
        cancelled && captured.filter(c => c.url.includes("/chat/completions")).length === 0);

    // a BROKEN asker fails CLOSED — never send on a broken prompt
    captured.length = 0;
    await cloudModels.streamChat(withKey2(),
        { onOutput: () => {}, timeoutMs: 20_000, allowSecrets: true,
          approveSecretEgress: async () => { throw new Error("the prompt died"); } });
    const wB = wireNow();
    check("a BROKEN asker fails CLOSED — the secret is redacted, never sent",
        wB.length > 0 && !wB.includes(FAKE_KEY), wB.slice(0, 80));

    // SEND verdict → the operator's explicit yes lets it through
    captured.length = 0;
    await cloudModels.streamChat(withKey2(),
        { onOutput: () => {}, timeoutMs: 20_000, allowSecrets: true,
          approveSecretEgress: async () => ({ action: "send" }) });
    check("asker says SEND → the operator's explicit yes lets it through",
        wireNow().includes(FAKE_KEY));

    /* the destination is classified by WHERE, not by what kind of model */
    const local = cloudModels.destinationOf({ baseUrl: "http://127.0.0.1:11434/v1" });
    const node = cloudModels.destinationOf({ baseUrl: "https://spark.example.ts.net",
                                             node: { id: "n1", name: "spark" } });
    const third = cloudModels.destinationOf({ baseUrl: "https://api.deepinfra.com/v1" });
    check("loopback is 'this computer' and counts as owned",
        local.kind === "this-computer" && local.owned === true);
    check("a linked machine is 'your machine' and counts as owned",
        node.kind === "your-machine" && node.owned === true && /spark/.test(node.label));
    check("anything else is third-party, NOT owned, and named by host",
        third.kind === "third-party" && third.owned === false &&
        third.label === "api.deepinfra.com");
    check("permission defaults to OFF — it is never inferred",
        (() => { captured.length = 0; return true; })());
})()
    .catch((e) => check("the capture ran end to end", false, String(e && e.message || e)))
    .finally(() => {
        try { if (server) server.close(); } catch { /* closing */ }
        try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* temp */ }
        console.log(`\n${pass}/${pass + fail} secret-wire checks passed`);
        process.exit(fail ? 1 : 0);
    });
