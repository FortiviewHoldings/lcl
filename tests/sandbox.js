/**
 * SANDBOX — build it, prove it, then let it out.
 *
 * The load-bearing property is the PROMOTE GATE: nothing leaves the box until
 * the checks run against it have passed. Everything else is containment, and
 * how strong that containment is depends on the machine — so these tests also
 * pin the two things that are true even in the weakest mode, both of which were
 * genuinely wrong before: code ran in the user's HOME with the user's FULL
 * environment, including any API keys the app was launched with.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-sandbox-"));
const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
require.cache[__filename] = { exports: {
    app: { isPackaged: true, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

const sandbox = require(__dirname + "/../.lcl.engine/core/sandbox.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 300) : ""); }
}

(async () => {
    /* ---- honesty about what isolation is actually in force ---- */
    const iso = sandbox.isolation();
    check("isolation names the mechanism and whether it is a real boundary",
        typeof iso.kind === "string" && typeof iso.strong === "boolean"
        && iso.detail.length > 20, iso);
    check("with no container runtime it does NOT claim to be a security boundary",
        iso.strong || /not a security boundary/i.test(iso.detail), iso.detail);

    /* ---- boxes are disposable and contained ---- */
    const box = sandbox.create({ name: "test" });
    check("a box is created inside the sandbox root",
        fs.existsSync(box.dir) && box.dir.includes("sandbox"), box.dir);

    sandbox.write(box.id, "hello.txt", "hi");
    check("a file can be written into the box",
        fs.readFileSync(path.join(box.dir, "hello.txt"), "utf8") === "hi");

    let escaped = false;
    try { sandbox.write(box.id, "../../escape.txt", "nope"); escaped = true; } catch { /* refused */ }
    check("a path that escapes the box is refused", !escaped);
    check("nothing was written outside the box",
        !fs.existsSync(path.join(DATA, "escape.txt")));

    let badBox = false;
    try { sandbox.boxDir("../.."); badBox = true; } catch { /* refused */ }
    check("a sandbox id cannot traverse out of the root", !badBox);

    /* ---- the environment must NOT carry the user's secrets ---- */
    const env = sandbox.scrubbedEnv(box.dir);
    check("the scrubbed environment keeps PATH so interpreters still run", !!env.PATH);
    check("HOME points into the box, not the user's profile",
        env.HOME === box.dir && env.USERPROFILE === box.dir, { home: env.HOME });
    check("TEMP points into the box", env.TEMP === box.dir);
    check("the sandbox marks itself, so code can tell", env.LCL_SANDBOX === "1");
    // the real check: an API key in the parent process must not survive
    process.env.LCL_TEST_SECRET_KEY = "sk-ant-not-a-real-key-0123456789";
    const env2 = sandbox.scrubbedEnv(box.dir);
    check("a secret in the parent environment is NOT passed to sandboxed code",
        !Object.values(env2).some(v => String(v).includes("not-a-real-key")),
        Object.keys(env2));
    delete process.env.LCL_TEST_SECRET_KEY;

    /* ---- running code, and seeing failure as a result ---- */
    const good = await sandbox.runScript(box.id, {
        language: "node", code: 'console.log("works"); process.exit(0);'
    });
    check("code runs and reports success", good.ok && /works/.test(good.output), good);

    const bad = await sandbox.runScript(box.id, {
        language: "node", code: 'console.error("boom"); process.exit(3);'
    });
    check("a failing script is a RESULT, not a throw",
        bad.ok === false && bad.code === 3 && /boom/.test(bad.output), bad);

    const slow = await sandbox.runScript(box.id, {
        language: "node", code: "setTimeout(()=>{}, 60000);", timeoutMs: 1500
    });
    check("a hanging script is killed by the timeout",
        slow.ok === false && slow.timedOut === true, { ok: slow.ok, timedOut: slow.timedOut });

    // code really does run inside the box
    await sandbox.runScript(box.id, {
        language: "node", code: 'require("fs").writeFileSync("made-here.txt","x");'
    });
    check("a script's writes land in the box",
        fs.existsSync(path.join(box.dir, "made-here.txt")));

    /* ---- preflight: one honest verdict ---- */
    const green = await sandbox.preflight(box.id, [
        { name: "arithmetic", language: "node", code: "if (2+2!==4) process.exit(1);" },
        { name: "file present", language: "node",
          code: 'require("fs").statSync("hello.txt");' }
    ]);
    check("preflight passes when every check passes",
        green.green === true && green.passed === 2 && green.failed === 0, green);

    const red = await sandbox.preflight(box.id, [
        { name: "ok", language: "node", code: "process.exit(0);" },
        { name: "broken", language: "node", code: "process.exit(1);" }
    ]);
    check("ONE failing check makes the whole run red",
        red.green === false && red.failed === 1, red);
    check("a failing check keeps its output for diagnosis",
        red.checks.every(c => typeof c.output === "string"));
    check("preflight with no checks is not green",
        (await sandbox.preflight(box.id, [])).green === false);

    /* ---- THE GATE: nothing leaves unproven ---- */
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-dest-"));
    let promoted = false;
    try { sandbox.promote(box.id, dest, { verified: false }); promoted = true; }
    catch { /* refused */ }
    check("promote is REFUSED when preflight has not passed", !promoted);
    check("nothing was copied out", fs.readdirSync(dest).length === 0);

    const res = sandbox.promote(box.id, dest, { verified: true });
    check("promote copies files once verified", res.count > 0, res);
    check("the promoted file really arrived",
        fs.readFileSync(path.join(dest, "hello.txt"), "utf8") === "hi");
    check("the sandbox's own runner script is not promoted",
        !fs.readdirSync(dest).some(f => f.startsWith("_lcl_run")), fs.readdirSync(dest));

    /* ---- disposal ---- */
    check("boxes are listed", sandbox.list().some(b => b.id === box.id));
    sandbox.destroy(box.id);
    check("a destroyed box is gone from disk", !fs.existsSync(box.dir));
    check("a destroyed box is no longer listed", !sandbox.list().some(b => b.id === box.id));

    fs.rmSync(dest, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });
    fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });
    console.log(`\n${pass}/${pass + fail} sandbox checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
