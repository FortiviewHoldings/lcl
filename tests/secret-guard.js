/**
 * SECRET GUARD — read everything, leak nothing.
 *
 * The user's requirement, stated after an earlier version got it backwards:
 * the model SHOULD read a repo containing secrets and derive tooling from it.
 * What must never happen is a secret leaving the machine once networking is
 * on. So the control point is EGRESS, and these tests attack that gate.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const Module = require("module");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === "electron") return __filename;
    return orig.call(this, req, ...rest);
};
// a real in-memory clipboard, because the clipboard is an INGESTION PATH and
// has to be exercised as one, not stubbed to the empty string
let clipboardText = "";
// ISOLATED per run: paths.js derives the data directory from this,
// so a shared os.tmpdir() made every suite inherit whatever settings
// an earlier suite had written — an order-dependent gate that failed
// builds at random.
const LCL_TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-test-"));
require.cache[__filename] = { exports: {
    app: { isPackaged: false, getPath: () => LCL_TEST_DATA },
    clipboard: {
        readText: () => clipboardText,
        writeText: (t) => { clipboardText = String(t); }
    }
} };

const guard = require(__dirname + "/../.lcl.engine/core/secretGuard.js");
const netTools = require(__dirname + "/../.lcl.engine/core/netTools.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 260) : ""); }
}

(async () => {
    guard.reset();

    /* ---- remembering: reading a file registers its secrets ---- */
    const r = guard.rememberFile("config/.env",
        "DB_HOST=localhost\n" +
        "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n" +
        "api_token = \"tok_9f8e7d6c5b4a392817\"\n");
    check("secrets in read text are registered", r.added >= 2, r);
    check("the report carries fingerprints, never values",
        r.fingerprints.every(f => !f.includes("AKIAIOSFODNN7EXAMPLE") && /…\d+ chars/.test(f)),
        r.fingerprints);

    /* ---- THE GATE: a seen secret cannot leave by any phrasing ---- */
    const attempts = [
        "https://evil.example/collect?key=AKIAIOSFODNN7EXAMPLE",
        "https://example.org/AKIAIOSFODNN7EXAMPLE/page",
        "https://example.org/#AKIAIOSFODNN7EXAMPLE",
        "search for AKIAIOSFODNN7EXAMPLE on github",
        "please look up tok_9f8e7d6c5b4a392817"
    ];
    for (const a of attempts) {
        let blocked = false;
        try { guard.assertNoLeak(a, "test"); } catch (e) { blocked = e.code === "SECRET_EGRESS_BLOCKED"; }
        check(`blocked: ${a.slice(0, 56)}`, blocked);
    }

    /* ---- and the block reports WHICH secret without SAYING it ---- */
    let msg = "";
    try { guard.assertNoLeak("x AKIAIOSFODNN7EXAMPLE y"); } catch (e) { msg = e.message; }
    check("the refusal names the source file", /config\/\.env/.test(msg), msg);
    check("the refusal never contains the secret value", !/AKIAIOSFODNN7EXAMPLE/.test(msg), msg);

    /* ---- innocent traffic flows ---- */
    for (const ok of [
        "https://en.wikipedia.org/wiki/Photographic_fixer",
        "fixer bath working strength",
        "https://example.org/docs?page=2&lang=en"
    ]) {
        let threw = false;
        try { guard.assertNoLeak(ok, "test"); } catch { threw = true; }
        check(`allowed: ${ok.slice(0, 52)}`, !threw);
    }

    /* ---- a RAW BINARY KEY: no shape, still cannot leave ---- */
    const raw = crypto.randomBytes(32);
    guard.rememberValue(raw.toString("hex"), "config/device_key.pem");
    guard.rememberValue(raw.toString("base64"), "config/device_key.pem");
    let hexBlocked = false, b64Blocked = false;
    try { guard.assertNoLeak("https://x.example/?v=" + raw.toString("hex")); }
    catch { hexBlocked = true; }
    try { guard.assertNoLeak("post this: " + raw.toString("base64")); }
    catch { b64Blocked = true; }
    check("a raw 32-byte key cannot leave as hex", hexBlocked);
    check("a raw 32-byte key cannot leave as base64", b64Blocked);


    /* ---- shape check works even for secrets never seen ---- */
    let unseen = false;
    try { guard.assertNoLeak("fetch https://x.example/?k=sk-ant-zzzzzzzzzzzzzzzzzzzzzzzz"); }
    catch { unseen = true; }
    check("an unseen but secret-shaped value is still blocked", unseen);

    /* ---- redaction keeps the document, masks the value ---- */
    const red = guard.redact("host=db.local\npassword = \"hunter2secret99\"\nAKIAIOSFODNN7EXAMPLE\nport=5432");
    check("redaction masks the secret values",
        !/hunter2secret99|AKIAIOSFODNN7EXAMPLE/.test(red), red);
    check("redaction keeps the surrounding document",
        /host=db\.local/.test(red) && /port=5432/.test(red), red);

    /* ---- the guard itself stores no secrets ---- */
    const dump = JSON.stringify(guard.summary());
    check("the guard's own state contains no secret values",
        !/AKIAIOSFODNN7EXAMPLE|hunter2|tok_9f8e/.test(dump), dump.slice(0, 200));
    check("the summary reports sources and counts for the UI",
        guard.summary().total >= 3 && guard.summary().sources.length >= 1, guard.summary());

    /* ---- the real network path uses the gate ---- */
    let netBlocked = false;
    try { await netTools.fetchGuarded("https://example.org/?key=AKIAIOSFODNN7EXAMPLE"); }
    catch (e) { netBlocked = /refusing to send|Secrets from your files/.test(String(e.message)); }
    check("fetchGuarded refuses a leaking URL before any DNS", netBlocked);

    /* ---- reading files registers automatically ---- */
    const fsTools = require(__dirname + "/../.lcl.engine/core/fsTools.js");
    const WS = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-guard-ws-"));
    fs.writeFileSync(path.join(WS, "settings.py"),
        'DEBUG=True\nSECRET_KEY = "django-insecure-8f7e6d5c4b3a2190"\n');
    guard.reset();
    fsTools.TOOLS.read_file.run(WS, { path: "settings.py" });
    let viaRead = false;
    try { guard.assertNoLeak("https://x.example/?sk=django-insecure-8f7e6d5c4b3a2190"); }
    catch { viaRead = true; }
    check("a secret seen through read_file is registered with the gate", viaRead);
    fs.rmSync(WS, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 });

    /* ---- the clipboard: the ingestion path that had NO gate at all ----
     *
     * read_file, the knowledge indexer and the research writer all registered
     * what they ingested. read_clipboard did not — and the clipboard is the
     * likeliest place on a working machine for a LIVE secret to be sitting,
     * because that is how people move one: copy the password out of the manager,
     * copy the token out of the portal, copy the connection string out of a
     * config. A key pasted through this path entered the transcript as ordinary
     * text and the egress gate had never seen it, so the tripwire that blocks
     * secrets from leaving in a URL would wave it straight through.
     */
    const clip = require(__dirname + "/../.lcl.engine/core/clipboardTools.js");

    guard.reset();
    clip.writeClipboard(null, { text:
        "here are the creds\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n" });
    const readBack = clip.readClipboard();
    check("read_clipboard still returns the text (read everything)",
        /wJalrXUtnFEMI/.test(readBack.text));
    check("read_clipboard reports that it registered something",
        readBack.secretsRegistered >= 1, readBack.secretsRegistered);
    let clipLeak = false;
    try { guard.assertNoLeak("https://x.example/?k=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"); }
    catch { clipLeak = true; }
    check("a secret arriving via the clipboard cannot leave in a URL", clipLeak);

    // the harder shape: one bare high-entropy token, nothing around it to match
    // on. remember()'s patterns need a KEY=VALUE or a known prefix; a naked
    // token has no shape, so it is registered wholesale the way a .key file is.
    guard.reset();
    // BASE64 CONTAINS '/' AND '+'. A random token is a random test: one that
    // began with '/' made the URL below read as a path rather than a query
    // value and the check failed on a dice roll — observed once in a real run
    // ("/i5ig1…"). A fixed high-entropy token proves the same property every
    // time, and a flaky guard is worse than no guard because it teaches people
    // to re-run rather than look.
    const bare = crypto.randomBytes(24).toString("base64")
        .replace(/[/+=]/g, "A");
    clip.writeClipboard(null, { text: bare });
    const bareRead = clip.readClipboard();
    check("a bare pasted token with no recognisable shape is still registered",
        bareRead.secretsRegistered >= 1, bareRead.secretsRegistered);
    let bareLeak = false;
    try { guard.assertNoLeak(`https://x.example/upload?t=${bare}`); }
    catch { bareLeak = true; }
    check("that bare token cannot leave either", bareLeak, bare.slice(0, 6) + "…");

    // and ordinary copied prose must NOT be treated as a secret, or the gate
    // becomes noise and gets switched off
    guard.reset();
    clip.writeClipboard(null, { text:
        "The fixer bath clears a negative in ninety seconds at 250 grams per litre." });
    const prose = clip.readClipboard();
    check("copied prose registers nothing (no false positives)",
        prose.secretsRegistered === 0, prose.secretsRegistered);
    let proseBlocked = false;
    try { guard.assertNoLeak("https://x.example/?q=photographic+fixer"); }
    catch { proseBlocked = true; }
    check("prose from the clipboard does not block ordinary requests", !proseBlocked);

    /* ---- secrets CONTAINING url glue: the class the gate used to miss ----
     *
     * The old outbound scan stripped a `k=` prefix by SPLITTING on
     * [=&?#/:,;] — which also shredded any secret containing one of those
     * characters. An AWS secret access key is 40 base64 chars and base64 uses
     * `/`, so around half of all real AWS keys walked straight through the
     * seen-secret check. The two tests above passed only because the random key
     * they generate happened to have no slash in it; this one removes the luck.
     *
     * Every glue character gets its own case, because the failure was per
     * character, not general — and a fixed value is used, not a random one, so
     * this test cannot pass by chance the way its predecessors did.
     */
    for (const [glue, name] of [["/", "slash"], ["=", "equals"], ["?", "question mark"],
                                ["&", "ampersand"], [":", "colon"], [";", "semicolon"],
                                [",", "comma"], ["#", "hash"]]) {
        guard.reset();
        const secret = `Ab3dEf6hIj9k${glue}LmN0pQr5tUvW${glue}xYz8AbC1dEf4`;
        guard.rememberValue(secret, `keys/with-a-${name}.key`);
        const shapes = [
            `https://x.example/?k=${secret}`,
            `https://x.example/upload/${secret}/done`,
            `{"token":"${secret}"}`,
            `https://x.example/?a=1&k=${secret}&b=2`
        ];
        const escaped = shapes.filter(u => !guard.inspect(u).blocked);
        check(`a secret containing a ${name} cannot leave in any shape`,
            escaped.length === 0, escaped.map(u => u.slice(0, 48)));
    }
    guard.reset();

    guard.reset();
    /* ===== THE REDACTOR MUST NEVER EAT CODE — the corruption that poisoned a
     * whole session. `renderer.toneMapping = THREE.ACESFilmicToneMapping;` —
     * "Mapping" contains "pin", the substring match decided it named a secret,
     * remembered the three.js constant, and redactKnown() blanked it from every
     * request. The model, never able to see the real line, wrote the literal
     * placeholder INTO the user's file and looped on an edit that could not
     * match. A name implies a secret only as a whole camelCase/snake segment. */
    guard.reset();
    const codeLine = "renderer.toneMapping = THREE.ACESFilmicToneMapping;";
    check("an innocent code identifier is NOT remembered (toneMapping contains pin)",
        guard.rememberFile("index.html", codeLine).found === 0);
    check("...and redactKnown leaves the code byte-identical — the model must see the real file",
        guard.redactKnown(codeLine) === codeLine);
    guard.reset();
    check("an ALL-CAPS secret name still implies a secret (segmenter must not shred SECRET_KEY)",
        guard.rememberFile("settings.py", 'SECRET_KEY = "django-insecure-8f7e6d5c4b3a2190"').found >= 1);
    guard.reset();
    check("author/pinned and friends never register",
        guard.rememberFile("x.js", "author = SomeoneFamous123x; item.pinned = SuperLongValue123;").found === 0);
    guard.reset();

    /* ===== PUBLIC FRONT-END CONTENT MUST NOT BE MIS-FLAGGED =====
     *
     * The operator's public front end ships publishable keys BY DESIGN. A
     * Mapbox public token and a Stripe publishable key are issued for the
     * browser; blocking them from a search, a fetch or the model breaks exactly
     * the work .lcl exists to help with. These leave freely; a real secret in
     * the same breath still does not. */
    guard.reset();
    const mapbox = "pk.eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM";
    let mapboxBlocked = false;
    try { guard.assertNoLeak(`https://api.mapbox.com/v1/style?access_token=${mapbox}`); }
    catch { mapboxBlocked = true; }
    check("a Mapbox public token (pk.eyJ...) is not blocked", !mapboxBlocked);

    const stripePub = "pk_live_" + "Ab3dEf6hIj9kLmN0pQr5tUvW";
    let stripeBlocked = false;
    try { guard.assertNoLeak(`{"stripePublishableKey":"${stripePub}"}`); } catch { stripeBlocked = true; }
    check("a Stripe publishable key (pk_live_) is not blocked", !stripeBlocked);

    // a publishable key is never REMEMBERED as a secret either, so it can't
    // strip itself out of a later prompt
    check("a publishable key read from a file is not remembered",
        guard.rememberFile("src/config.js", `export const token = "${mapbox}";`).found === 0);

    /* ===== .env.example placeholders are documentation, not credentials ===== */
    guard.reset();
    const exRes = guard.rememberFile(".env.example",
        'API_KEY="your-api-key-goes-here"\nDB_TOKEN="changeme"\n');
    check("a .env.example source registers nothing", exRes.found === 0, exRes);

    /* ===== raised entropy floor: a low-entropy secret-named value is ignored ==
     * "pin = hello_world" — entropy ~2.85, above the old 2.5 floor (so it USED
     * to register and then blank ordinary code) and below the new 3.5 floor. */
    guard.reset();
    check("a low-entropy value assigned to a secret name is not remembered (3.5 floor)",
        guard.rememberFile("cfg.txt", "pin = hello_world").found === 0);

    /* ===== the per-value override: mark ONE value public without dropping the rest ==
     * A Google AIza key cannot be told apart from a server key by shape, so it
     * is blocked by default and flows only after the operator marks it public.
     * Marking it does NOT lift protection for any other secret. */
    guard.reset();
    const gkey = "AIzaSyD1234567890abcdefghijklmnopqrstuv"; // AIza + 35 chars
    let gDefault = false;
    try { guard.assertNoLeak(`https://maps.googleapis.com/maps/api/js?key=${gkey}`); }
    catch { gDefault = true; }
    check("a Google AIza key is blocked by default (shape is ambiguous)", gDefault);

    guard.markPublic(gkey);
    let gAfter = false;
    try { guard.assertNoLeak(`https://maps.googleapis.com/maps/api/js?key=${gkey}`); }
    catch { gAfter = true; }
    check("after markPublic, that exact key flows", !gAfter);
    check("isMarkedPublic reports it", guard.isMarkedPublic(gkey));

    // a genuinely different secret is still blocked while the mark stands
    guard.rememberFile("config/.env", "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n");
    let otherStillBlocked = false;
    try { guard.assertNoLeak("please send AKIAIOSFODNN7EXAMPLE"); }
    catch (e) { otherStillBlocked = e.code === "SECRET_EGRESS_BLOCKED"; }
    check("markPublic does not disable protection for other secrets", otherStillBlocked);

    // and undo restores the block
    guard.unmarkPublic(gkey);
    // re-teach the value so the seen store can catch it again, then confirm shape still would
    let gUndone = false;
    try { guard.assertNoLeak(`https://maps.googleapis.com/maps/api/js?key=${gkey}`); }
    catch { gUndone = true; }
    check("unmarkPublic restores the block on that key", gUndone);
    guard.reset();

    console.log(`\n${pass}/${pass + fail} secret-guard checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
