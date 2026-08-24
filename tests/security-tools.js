/**
 * Tests for the seven newly-implemented tools. Security-critical behaviour
 * gets adversarial attention: secret detection, SSRF blocking, and the
 * engagement authorization gate on every offensive tool.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
// packaged mode reads process.resourcesPath (undefined under plain node);
// the repo root carries the same tools/ and knowledge/ layout, read-only
process.resourcesPath = path.join(__dirname, "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-secdata-"));
require.cache[__filename] = { exports: {
    // isPackaged: TRUE, deliberately — in dev mode paths.dataDir() resolves
    // to the REPO's shared data/ directory, so the engagement this suite
    // opens would land in the developer's own engagements.json. Packaged
    // mode routes through getPath, which is this run's throwaway directory.
    app: { isPackaged: true, getPath: () => DATA }
} };

const sec = require(__dirname + "/../.lcl.engine/core/securityTools.js");
const net = require(__dirname + "/../.lcl.engine/core/netTools.js");
const eng = require(__dirname + "/../.lcl.engine/core/engagements.js");
const off = require(__dirname + "/../.lcl.engine/core/offensiveTools.js");
const { ToolError } = require(__dirname + "/../.lcl.engine/core/fsTools.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 160) : ""); }
}
async function expectError(name, fn, re, anyError = false) {
    try { await fn(); check(name, false, "no error"); }
    catch (e) {
        // tool functions throw ToolError; the engagement layer throws plain
        // Error (it is called from IPC guard(), not the tool dispatcher)
        const typeOk = anyError ? e instanceof Error : e instanceof ToolError;
        check(name, typeOk && (!re || re.test(e.message)), e.message);
    }
}

(async () => {
    // ================= scan_secrets =================
    const WS = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-scan-"));
    fs.writeFileSync(path.join(WS, "config.js"),
        'const AWS = "AKIAIOSFODNN7EXAMPLE";\nconst gh = "ghp_' + "a".repeat(36) + '";\n');
    fs.writeFileSync(path.join(WS, "key.pem"), "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\n");
    fs.writeFileSync(path.join(WS, "app.py"), 'password = "hunter2istooshort"\napi_key = "x8Kf3pQ9vNw2mZ7bYtR4sL6dHcA1jE0"\n');
    fs.writeFileSync(path.join(WS, "readme.md"), "# Just docs\nThe memory of secrets past. Nothing here.\n");

    const s = sec.scanSecrets(WS);
    const kinds = s.findings.map(f => f.kind).join("|");
    check("finds AWS key", /AWS access key/.test(kinds), kinds);
    check("finds GitHub token", /GitHub token/.test(kinds), kinds);
    check("finds private key block", /private key/.test(kinds), kinds);
    check("finds high-entropy api_key", s.findings.some(f => /entropy|generic/.test(f.kind)), kinds);
    check("redacts the secret value", s.findings.every(f => !/AKIAIOSFODNN7EXAMPLE/.test(f.match)), s.findings[0]);
    check("does not flag the prose readme", !s.findings.some(f => f.file === "readme.md"), s.findings);
    check("entropy: random string is high", sec.entropy("x8Kf3pQ9vNw2mZ7bYtR4sL6") > 3.5);
    check("entropy: repeated string is low", sec.entropy("aaaaaaaaaaaaaaaa") < 1);

    // ================= review_config =================
    fs.writeFileSync(path.join(WS, "settings.env"), "DEBUG=true\nSSL_VERIFY=false\nHOST=0.0.0.0\n");
    const rc = sec.reviewConfig(WS);
    check("flags DEBUG=true", rc.findings.some(f => /debug/i.test(f.issue)), rc.findings);
    check("flags disabled TLS verify", rc.findings.some(f => /TLS/i.test(f.issue)), rc.findings);
    check("review_config is contained",
        await (async () => { try { sec.reviewConfig(WS, { path: "../../etc/passwd" }); return false; } catch (e) { return /escapes/.test(e.message); } })());

    // ================= audit_dependencies =================
    fs.writeFileSync(path.join(WS, "package.json"), JSON.stringify({
        dependencies: { express: "^4.18.0", lodash: "*", evil: "git+https://x/y.git" }
    }));
    const ad = sec.auditDependencies(WS);
    check("counts dependencies", ad.dependencies === 3, ad.dependencies);
    check("flags unpinned version", ad.findings.some(f => /unpinned/.test(f.issue)), ad.findings);
    check("flags git-source install", ad.findings.some(f => /supply-chain/.test(f.issue)), ad.findings);
    fs.rmSync(WS, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });

    // ================= http_fetch SSRF =================
    check("blocks loopback IPv4", net.isBlockedAddress("127.0.0.1") === "loopback");
    check("blocks private 10/8", net.isBlockedAddress("10.1.2.3") === "private");
    check("blocks private 192.168", net.isBlockedAddress("192.168.1.1") === "private");
    check("blocks metadata 169.254", net.isBlockedAddress("169.254.169.254") === "link-local/metadata");
    check("blocks IPv6 loopback", net.isBlockedAddress("::1") === "loopback");
    check("blocks IPv4-mapped v6 private", net.isBlockedAddress("::ffff:10.0.0.1") === "private");
    check("allows a public IP", net.isBlockedAddress("8.8.8.8") === null);
    await expectError("assertPublicHost blocks localhost", () => net.assertPublicHost("localhost"), /internal/);
    await expectError("assertPublicHost blocks 127.0.0.1", () => net.assertPublicHost("127.0.0.1"), /loopback/);
    await expectError("assertPublicHost blocks .internal", () => net.assertPublicHost("db.internal"), /internal/);
    await expectError("http_fetch rejects file://", () => net.httpFetch(null, { url: "file:///etc/passwd" }), /http and https/);
    await expectError("http_fetch rejects ftp://", () => net.httpFetch(null, { url: "ftp://8.8.8.8/x" }), /http and https/);
    await expectError("http_fetch rejects creds-in-url", () => net.httpFetch(null, { url: "http://user:pass@8.8.8.8/" }), /credential/);
    // DNS-rebinding fix: assertPublicHost now RETURNS the pinned address so the
    // socket connects to the validated IP (not a fresh, attacker-swappable one)
    check("assertPublicHost returns the vetted IP to pin",
        await (async () => { const r = await net.assertPublicHost("8.8.8.8"); return r && r.address === "8.8.8.8"; })());

    // unquoted .env secret (review finding: quoted-only missed these)
    const envWS = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-env-"));
    fs.writeFileSync(path.join(envWS, ".env"), "API_KEY=x8Kf3pQ9vNw2mZ7bYtR4sL6dHcA\nNAME=bob\n");
    const envScan = sec.scanSecrets(envWS);
    check("finds an UNQUOTED high-entropy secret", envScan.findings.some(f => /entropy/.test(f.kind)), envScan.findings);
    check("does not flag a low-entropy unquoted value", !envScan.findings.some(f => /NAME/.test(JSON.stringify(f))), envScan.findings);
    fs.rmSync(envWS, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });

    // null / non-object manifest must not crash the auditor (review finding)
    const nullWS = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-null-"));
    fs.writeFileSync(path.join(nullWS, "package.json"), "null");
    check("audit_dependencies survives a 'null' manifest",
        (() => { try { const r = sec.auditDependencies(nullWS); return r.dependencies === 0; } catch { return false; } })());
    fs.rmSync(nullWS, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });

    // ================= engagement gate on offensive tools =================
    // no engagement yet -> every offensive tool refuses
    await expectError("port_scan denied without engagement",
        () => off.portScan(null, { target: "scanme.example.com" }), /no active engagement/);
    await expectError("fuzz_target denied without engagement",
        () => off.fuzzTarget(null, { target: "http://scanme.example.com/?q=1", param: "q" }), /no active engagement/);
    await expectError("exploit_validate denied without engagement",
        () => off.exploitValidate(null, { target: "https://scanme.example.com/", check: "security-headers" }), /no active engagement/);

    // engagement creation guards
    await expectError("engagement refuses without authorization",
        async () => eng.create({ target: "scanme.example.com", authorized: false }), /authorization/, true);
    check("engagement refuses CIDR", (() => { try { eng.normalizeTarget("10.0.0.0/24"); return false; } catch (e) { return /CIDR/.test(e.message); } })());
    check("engagement refuses wildcard", (() => { try { eng.normalizeTarget("*.example.com"); return false; } catch (e) { return /wildcard/.test(e.message); } })());
    check("normalizes a URL to its host", eng.normalizeTarget("https://scanme.example.com/path?x=1") === "scanme.example.com");
    // IPv6: splitting on the first colon used to truncate "2001:db8::1" to the
    // meaningless host "2001", authorising the wrong target entirely.
    check("keeps a bare IPv6 literal whole (not truncated to its first hextet)",
        eng.normalizeTarget("2001:db8::1") === "2001:db8::1");
    check("strips the :port from a bracketed IPv6, keeping the address",
        eng.normalizeTarget("[2001:db8::1]:443") === "2001:db8::1");
    check("still strips a :port from an IPv4 host", eng.normalizeTarget("10.0.0.5:8080") === "10.0.0.5");

    // create a live engagement -> tools now pass the GATE (they still fail to
    // connect to a fake host, but past the authorization check)
    const e = eng.create({ target: "scanme.example.com", authorized: true, hours: 1 });
    check("engagement created live", eng.anyActive() && eng.activeFor("scanme.example.com") !== null, e.id);
    check("exploit_validate rejects a non-whitelist check",
        await (async () => { try { await off.exploitValidate(null, { target: "scanme.example.com", check: "rce-shell" }); return false; } catch (er) { return /must be one of/.test(er.message); } })());
    check("port_scan past the gate targets the engagement host only",
        await (async () => {
            const r = await off.portScan(null, { target: "scanme.example.com", ports: "1" });
            return r.target === "scanme.example.com" && r.engagementId === e.id;
        })());
    // a target OTHER than the engagement is still refused
    await expectError("offensive tool refuses a different target",
        () => off.portScan(null, { target: "not-authorized.example.com" }), /no active engagement/);

    // revoke -> back to denied
    eng.revoke(e.id);
    check("revoked engagement re-locks the tools", !eng.anyActive());
    await expectError("port_scan denied again after revoke",
        () => off.portScan(null, { target: "scanme.example.com" }), /no active engagement/);

    // expiry math
    const short = eng.create({ target: "expiry.example.com", authorized: true, hours: 1 });
    check("engagement has a bounded expiry",
        short.expiresAt > Date.now() && short.expiresAt <= Date.now() + 3600_000 + 5000, short.expiresAt);
    eng.revoke(short.id);

    // ================= crypto_auth_review =================
    const CW = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-crypto-"));
    fs.writeFileSync(path.join(CW, "auth.js"),
        "const crypto = require('crypto');\n" +
        "function hashPw(p){ return crypto.createHash('md5').update(p).digest('hex'); }\n" +
        "const token = Math.random().toString(36);\n" +
        "const opts = { algorithm: 'none' };\n");
    fs.writeFileSync(path.join(CW, "good.js"),
        "const argon2 = require('argon2');\nasync function h(p){ return argon2.hash(p); }\n");
    fs.writeFileSync(path.join(CW, "ui.js"), "const x = Math.random() * width;\n");
    const cr = sec.cryptoAuthReview(CW);
    const crWhy = cr.findings.map(f => f.why).join(" | ");
    check("crypto_auth_review flags MD5 used for hashing", /MD5/.test(crWhy), crWhy);
    check("crypto_auth_review flags Math.random for a token", /Math\.random/.test(crWhy));
    check("crypto_auth_review flags JWT alg:none", /alg:none/i.test(crWhy) || /forged/.test(crWhy));
    check("crypto_auth_review CONFIRMS strong password hashing (Argon2) is present",
        cr.strongPasswordHashing === true);
    check("crypto_auth_review does NOT flag Math.random outside a security context",
        !cr.findings.some(f => f.file === "ui.js"));
    fs.rmSync(CW, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });

    // ================= audit_code (SAST-lite) =================
    const AW = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-sast-"));
    fs.writeFileSync(path.join(AW, "db.js"),
        'db.query("SELECT * FROM users WHERE id = " + req.params.id);\n');
    fs.writeFileSync(path.join(AW, "run.js"),
        'const { exec } = require("child_process");\nexec("ls " + req.query.dir);\n');
    fs.writeFileSync(path.join(AW, "view.js"), 'el.innerHTML = req.body.comment;\n');
    fs.writeFileSync(path.join(AW, "danger.py"), 'result = eval(request.args.get("x"))\n');
    const ac = sec.auditCode(AW);
    const acWhy = ac.findings.map(f => f.why).join(" | ");
    check("audit_code flags SQL built by concatenation", /parameterized/.test(acWhy), acWhy);
    check("audit_code flags command injection", /shell command/.test(acWhy));
    check("audit_code flags an XSS sink", /HTML sink/.test(acWhy));
    check("audit_code flags eval / unsafe deserialization", /dynamic code/.test(acWhy));
    fs.rmSync(AW, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });

    // ================= scan_secret_history =================
    const { spawnSync } = require("child_process");
    const HW = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-hist-"));
    const g = (aa) => spawnSync("git", ["-C", HW, ...aa], { encoding: "utf8", windowsHide: true });
    const gitOk = g(["init"]).status === 0;
    if (gitOk) {
        g(["config", "user.email", "t@t.test"]); g(["config", "user.name", "t"]);
        g(["config", "commit.gpgsign", "false"]);
        fs.writeFileSync(path.join(HW, "cfg.txt"), "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n");
        g(["add", "."]); g(["commit", "-m", "add config"]);
        // "remove" the secret in a later commit — it stays in history
        fs.writeFileSync(path.join(HW, "cfg.txt"), "AWS_ACCESS_KEY_ID=(moved to env)\n");
        g(["add", "."]); g(["commit", "-m", "remove secret"]);
        const sh = sec.scanSecretHistory(HW);
        check("scan_secret_history recognises a git repo", sh.isRepo === true);
        check("scan_secret_history finds the committed-then-removed secret",
            sh.findings.some(f => f.kind === "AWS access key id"), sh.summary);
        check("...naming the commit and file, never the value",
            sh.findings.length > 0 && sh.findings.every(f =>
                f.commit && f.file && !JSON.stringify(f).includes("AKIAIOSFODNN7EXAMPLE")));
        const wt = sec.scanSecrets(HW);
        check("the working-tree scan alone would MISS it (history-only leak)",
            !wt.findings.some(f => f.kind === "AWS access key id"));
    } else {
        check("scan_secret_history: git unavailable on this machine, skipped", true);
    }
    fs.rmSync(HW, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });

    fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });
    console.log(`\n${pass}/${pass + fail} security-tool checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
