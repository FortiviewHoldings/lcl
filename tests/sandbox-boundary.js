/**
 * THE SANDBOX IS A BOUNDARY, NOT A WORD.
 *
 * What this proves, by running real processes rather than by reading the code:
 *   - the strongest boundary the machine can enforce is USED, not merely named
 *   - a script inside it can do real work
 *   - its attempt to write the user's files is REFUSED BY THE OS
 *   - the user's environment (their keys) does not reach it
 *   - a runaway is killed and leaves no orphan
 *   - a session owns its box; it exists only while in use
 *   - files the operator put in the box are flagged as theirs
 *   - a boundary that cannot be tested is NEVER reported as one
 *
 * On a machine with Docker or WSL the top tier differs and the escape checks
 * are skipped with a note — this suite states what it measured rather than
 * pretending every machine is this one.
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
process.getSystemMemoryInfo = () => ({ total: 1, free: 1, swapTotal: 1, swapFree: 1 });
// packaged mode reads process.resourcesPath (undefined under plain node);
// the repo root carries the same tools/ and knowledge/ layout, read-only
process.resourcesPath = path.join(__dirname, "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-sbx-"));
require.cache[__filename] = { exports: {
    // isPackaged: TRUE, deliberately — in dev mode paths.dataDir() resolves
    // to the REPO's shared data/ directory, so the scripts this suite stages
    // would pile up in the developer's own data/scripts. Packaged mode routes
    // through getPath, which is this run's throwaway directory.
    app: { isPackaged: true, getPath: () => DATA },
    clipboard: { readText: () => "", writeText: () => {} }
} };

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 240) : ""); }
}
setTimeout(() => {
    console.log(`\n${pass}/${pass + fail + 1} sandbox-boundary checks passed (TIMED OUT)`);
    process.exit(1);
}, 180000).unref();

const ROOT = path.join(__dirname, "..");
const sandbox = require(path.join(ROOT, ".lcl.engine", "core", "sandbox.js"));
const scriptRunner = require(path.join(ROOT, ".lcl.engine", "core", "scriptRunner.js"));
const perms = require(path.join(ROOT, ".lcl.engine", "core", "sessionPerms.js"));

const ESCAPE = path.join(os.homedir(), "lcl-test-escape.txt");
const rmEscape = () => { try { fs.unlinkSync(ESCAPE); } catch { /* absent */ } };

(async () => {
    rmEscape();

    /* ---------------------------------------------- the ladder, and proof */
    const iso0 = sandbox.isolation();
    check("a boundary is DETECTED before it is claimed proven",
        typeof iso0.kind === "string" && iso0.verified === false,
        { kind: iso0.kind, verified: iso0.verified });
    check("on a plain Windows machine the OS's own boundary is found, rather " +
          "than concluding there is nothing (Docker and WSL are not the only " +
          "options Windows has)",
        process.platform !== "win32" || iso0.kind !== "none", iso0.kind);

    const iso = await sandbox.verify();
    console.log("  measured on this machine:", iso.kind, "|", iso.proof);
    check("the boundary is PROVEN by a canary, not asserted",
        iso.verified === true && /canary|container/.test(String(iso.proof || "")),
        { verified: iso.verified, proof: iso.proof });
    check("a boundary that could not be exercised is never reported as one",
        iso.verified ? true : iso.kind === "none",
        { kind: iso.kind, verified: iso.verified });
    check("when it is not the strongest boundary available, the upgrade is " +
          "NAMED — and nothing is installed and no admin rights are requested",
        iso.kind === "docker" || iso.kind === "wsl"
            ? iso.offer === null
            : !!(iso.offer && iso.offer.how && iso.offer.why),
        iso.offer);

    /* ------------------------------------------------ a session owns a box */
    const a1 = sandbox.forSession("sess-A");
    const a2 = sandbox.forSession("sess-A");
    const b1 = sandbox.forSession("sess-B");
    check("one box per session — asking twice gives the same one",
        a1.id === a2.id && a2.reused === true, { a1: a1.id, a2: a2.id });
    check("several at once ACROSS sessions — two conversations do not queue " +
          "behind each other",
        a1.id !== b1.id, { a: a1.id, b: b1.id });
    check("the box lives in one consistent, findable place",
        String(a1.dir).startsWith(sandbox.sandboxRoot()), a1.dir);

    /* --------------------------------------------------- real work happens */
    let r = await sandbox.runScript(a1.id, { language: "node",
        code: "const fs=require('fs');fs.writeFileSync('out.txt','real work');" +
              "console.log('WORKED:'+fs.readFileSync('out.txt','utf8'));",
        timeoutMs: 60000 });
    check("a script inside the boundary can do real work — a sandbox that " +
          "cannot work is not a sandbox, it is an obstacle",
        r.ok && /WORKED:real work/.test(r.output || ""), (r.output || "").slice(0, 200));

    /* ------------------------------------------- and cannot reach outside */
    rmEscape();
    r = await sandbox.runScript(a1.id, { language: "node",
        code: `const fs=require('fs');try{fs.writeFileSync(${JSON.stringify(ESCAPE)},'x');` +
              `console.log('ESCAPED');}catch(e){console.log('REFUSED:'+e.code);}`,
        timeoutMs: 60000 });
    const escaped = fs.existsSync(ESCAPE);
    if (iso.strong) {
        check("THE DEFECT THIS FIXES: a script's write into the user's own " +
              "files is refused — by the OS, not by this app's good manners",
            !escaped && /REFUSED/.test(r.output || ""), (r.output || "").slice(0, 200));
    } else {
        check("no boundary on this machine, and the report says so rather " +
              "than implying one", iso.kind === "none" && !iso.strong);
    }
    rmEscape();

    /* ------------------------------------------------- no keys get through */
    process.env.LCL_TEST_SECRET = "sk-must-not-be-seen";
    r = await sandbox.runScript(a1.id, { language: "node",
        code: "console.log('SECRET='+(process.env.LCL_TEST_SECRET?'LEAKED':'absent'));" +
              "console.log('HOME='+(process.env.USERPROFILE||process.env.HOME||''));",
        timeoutMs: 60000 });
    check("the user's environment — every API key the app was launched with — " +
          "does not reach code the model wrote",
        /SECRET=absent/.test(r.output || ""), (r.output || "").slice(0, 200));
    check("...and HOME points into the box, so a program writing to '~' writes " +
          "there rather than into the user's profile",
        new RegExp(a1.id).test(r.output || ""), (r.output || "").slice(0, 200));

    /* ------------------------------------------------------- runaway dies */
    const t0 = Date.now();
    r = await sandbox.runScript(b1.id, { language: "node",
        code: "setInterval(()=>{},50);console.log('spinning');", timeoutMs: 4000 });
    const took = Date.now() - t0;
    check("a script that will not stop is stopped, near its deadline",
        r.timedOut === true && took < 30000, { timedOut: r.timedOut, took });

    /* ------------------------------------------- whose file is whose */
    fs.writeFileSync(path.join(a1.dir, "operator-notes.txt"), "I put this here");
    const inv = sandbox.inventory(a1.id);
    const mine = inv.files.find(f => f.path === "operator-notes.txt");
    // the ledger itself is deliberately OUTSIDE the box (a low-integrity child
    // must not be able to forge its own provenance), so the app-written file to
    // look for is the runner
    const ours = inv.files.find(f => f.origin === "app");
    const made = inv.files.find(f => f.path === "out.txt");
    check("a file the operator put in the box is flagged as THEIRS",
        !!mine && mine.origin === "user" && inv.userAdded >= 1, mine);
    check("a file .lcl wrote is not confused for theirs",
        !!ours && ours.origin === "app", ours);
    check("the ledger that decides provenance lives OUTSIDE the box, where the " +
          "code being audited cannot rewrite its own origin tags",
        !fs.existsSync(path.join(a1.dir, "_lcl_box.json")) &&
        fs.existsSync(path.join(path.dirname(a1.dir), path.basename(a1.dir) + ".ledger.json")));
    check("a file a RUN produced is neither — it is credited to the run",
        !!made && made.origin === "run", made);
    check("their files are listed first, because those are the ones to look at",
        inv.files[0] && inv.files[0].origin === "user", inv.files.map(f => f.origin));

    /* ------------------------------------ exists only while in use */
    const dirA = a1.dir;
    /* ------------------------------- the cap does not eat a box in use */
    /* THIS SUITE FAILED UNDER A FULL RELEASE GATE AND PASSED ON ITS OWN,
     * which is the signature of a real bug wearing a flake's clothes:
     *
     *   ENOENT: open '...\sandbox\session-msthpsrk\operator-notes.txt'
     *
     * Boxes are capped at twenty and the oldest are collected to make room.
     * A box a live SESSION owned was already spared. A box this process was
     * merely holding was not — so with a full sandbox root, opening one box
     * deleted another that was still being written to. Standalone the root
     * was empty, the cap was never reached, and nothing evicted anything. */
    {
        const held = sandbox.create({ name: "held" });
        fs.writeFileSync(path.join(held.dir, "operator-notes.txt"), "still mine");
        const boxRoot = path.dirname(held.dir);
        // boxes left by earlier runs — the ordinary state of a working machine,
        // and the state the gate reproduces by running seventy suites in a row
        const preExisting = fs.readdirSync(boxRoot)
            .filter(n => n !== "_bin" && !n.endsWith(".ledger.json")).length;
        for (let i = 0; i < 25; i++) {
            const d = path.join(boxRoot, `stale-run-${i}`);
            fs.mkdirSync(d, { recursive: true });
            // backdated: eviction is oldest-first, and on a machine whose shared
            // root holds other old junk a brand-new stale dir would survive while
            // the older junk went — the check must own the OLDEST dirs to be
            // deterministic
            const old = new Date(Date.now() - 30 * 24 * 3600_000);
            try { fs.utimesSync(d, old, old); } catch { /* best effort */ }
        }
        const later = sandbox.create({ name: "later" });
        check("A BOX THIS PROCESS IS STILL HOLDING IS NEVER EVICTED to make room " +
              "for a new one — the user's own file was in it",
            fs.existsSync(held.dir) &&
            fs.readFileSync(path.join(held.dir, "operator-notes.txt"), "utf8") === "still mine",
            held.dir);
        // measured by DELTA, not by which names survived: eviction is oldest-first
        // by birthtime (which utimes cannot backdate on NTFS), so on a machine
        // whose shared root holds older junk the fresh stale dirs may outlive it —
        // the cap is proven by unowned count shrinking below seeded+existing
        const pruneDelta = (25 + preExisting) - fs.readdirSync(boxRoot)
            .filter(n => n !== "_bin" && !n.endsWith(".ledger.json")).length;
        check("...and the ones nobody is holding ARE collected, so the cap is " +
              "still a cap rather than a suggestion",
            pruneDelta >= 1, { pruneDelta });
        sandbox.destroy(held.id);
        sandbox.destroy(later.id);
        for (const n of fs.readdirSync(boxRoot)) {
            if (n.startsWith("stale-run-")) {
                try { fs.rmSync(path.join(boxRoot, n), { recursive: true, force: true }); }
                catch { /* another run has it */ }
            }
        }
    }

    sandbox.releaseSession("sess-A");
    check("the box is gone when the session lets go of it",
        !fs.existsSync(dirA), dirA);
    const a3 = sandbox.forSession("sess-A");
    check("a later ask gets a fresh box, not the old one back",
        a3.id !== a1.id);

    /* ----------------------------- the user's own path: propose+approve */
    const script = process.platform === "win32"
        ? ['Write-Output "approved script ran"',
           'if ($env:LCL_TEST_SECRET) { Write-Output "SECRET=LEAKED" } else { Write-Output "SECRET=absent" }',
           'try { Set-Content -Path "' + ESCAPE + '" -Value x -ErrorAction Stop; Write-Output "ESCAPED" }',
           'catch { Write-Output ("REFUSED: " + $_.Exception.GetType().Name) }'].join("\n")
        : 'echo "approved script ran"; echo "SECRET=absent"; echo "REFUSED: n/a"';
    const staged = scriptRunner.propose({
        script, language: process.platform === "win32" ? "powershell" : "bash",
        purpose: "prove where an approved script actually runs",
        rollback: "delete the file it attempts to create; nothing else changes",
        sessionId: "sess-C" });
    check("the guard still inspects a script before a human ever sees it",
        staged.ok === true, staged.error);
    if (staged.ok) {
        rmEscape();
        const ran = await scriptRunner.approve(staged.proposal.id, { timeoutMs: 60000 });
        check("AN APPROVED SCRIPT RUNS INSIDE THE BOUNDARY — it used to run as " +
              "the user, from their home folder, with their whole environment",
            ran.isolation === iso.kind && !!ran.sandboxId,
            { isolation: ran.isolation, box: ran.sandboxId });
        check("...and the result SAYS where it ran, so a run that quietly fell " +
              "out of the sandbox could not pass for one that did not",
            typeof ran.isolation === "string" && "isolationVerified" in ran,
            { isolation: ran.isolation, verified: ran.isolationVerified });
        if (iso.strong) {
            check("...its write into the user's files is refused",
                !fs.existsSync(ESCAPE) && /REFUSED/.test(ran.output || ""),
                (ran.output || "").slice(0, 200));
            check("...and it never sees the user's keys",
                /SECRET=absent/.test(ran.output || ""), (ran.output || "").slice(0, 160));
        }
        rmEscape();
        sandbox.releaseSession("sess-C");
    }

    /* -------------------------- wired to the EXISTING permission, not a new one */
    const permKeys = perms.CATALOG.map(c => c.key);
    check("the sandbox is governed by the per-session permission that already " +
          "existed — requireIsolation — and no second permission system was " +
          "built beside it",
        permKeys.includes("requireIsolation") &&
        perms.forSession({ perms: { requireIsolation: true } }).requireIsolation === true);
    const agentSrc = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "agent.js"), "utf8");
    check("a session that demands a real boundary is refused when none exists, " +
          "before a card it could never legally approve is ever shown",
        /const strict = sessionPerms\.forSession\(session\)\.requireIsolation/.test(agentSrc) &&
        /const staged = \(strict && !iso\.strong\)/.test(agentSrc));

    /* ============================================================
     * EVERY ONE OF THESE WAS A REAL DEFECT IN THE FIRST CUT, found by an
     * adversarial review that attacked the boundary rather than reading it.
     * ========================================================== */

    // Docker/WSL were RANKED above the boundary that works, reported as the
    // tier in force, and certified "verified" by a local echo - while exec()
    // had no container path at all. Installing the recommended upgrade
    // silently removed the only working boundary and stamped it tested.
    check("a tier is only claimed if it is IMPLEMENTED — detection of Docker " +
          "and WSL is kept as a diagnostic and decides nothing",
        ["windows-low-il", "none"].includes(iso.kind) &&
        iso.present && typeof iso.present.docker === "boolean",
        { kind: iso.kind, present: iso.present });
    {
        const sbxSrc = fs.readFileSync(
            path.join(ROOT, ".lcl.engine", "core", "sandbox.js"), "utf8");
        check("...and nothing certifies a boundary by running a local echo",
            !/container filesystem is separate/.test(sbxSrc));
        check("the canary probes EVERY known way out, not one, and names the " +
              "ones it cannot stop",
            /localLow/.test(sbxSrc) && /tempLow/.test(sbxSrc) &&
            Array.isArray(iso.reached) && Array.isArray(iso.held),
            { reached: iso.reached, held: iso.held });
        check("the honest limit is stated where the operator reads it, not " +
              "only in a code comment",
            /LocalLow/.test(String((iso.offer && iso.offer.why) || "")),
            iso.offer && iso.offer.why);
    }

    // The ledger decided what the panel presents as fact, and lived inside a
    // box the audited code can write to.
    {
        const led = path.join(path.dirname(b1.dir), path.basename(b1.dir) + ".ledger.json");
        check("the provenance ledger is a sibling of the box at normal " +
              "integrity, so sandboxed code cannot forge its own origin tags",
            fs.existsSync(led) && !fs.existsSync(path.join(b1.dir, "_lcl_box.json")));
    }

    // Pruning sorted by NAME and could evict a live session's box - with the
    // operator's own files in it - while the conversation was still using it.
    {
        const live = sandbox.forSession("sess-live");
        fs.writeFileSync(path.join(live.dir, "precious.txt"), "the user's own file");
        const spares = [];
        for (let i = 0; i < 24; i++) spares.push(sandbox.create({ name: "aaa-filler" }));
        check("a box a live session owns is NEVER evicted to make room, even " +
              "when it sorts first by name",
            fs.existsSync(live.dir) && fs.existsSync(path.join(live.dir, "precious.txt")),
            live.dir);
        for (const sp of spares) sandbox.destroy(sp.id);
        sandbox.releaseSession("sess-live");
    }

    // A script returning -1 was reported as a timeout, complete with a
    // fabricated "exceeded Ns" line the operator would read as fact.
    {
        const rr = await sandbox.runScript(b1.id, { language: "node",
            code: "process.exit(-1)", timeoutMs: 30000 });
        check("a script that exits -1 is NOT reported as a timeout — the " +
              "launcher reports being killed for time as its own fact",
            rr.timedOut === false && !/exceeded/.test(rr.output || ""),
            { timedOut: rr.timedOut, output: (rr.output || "").slice(0, 80) });
    }

    // The sandboxed path merged stderr into stdout, so a half-failed
    // PowerShell script reported "Finished cleanly".
    if (process.platform === "win32") {
        const rr = await sandbox.exec(b1.id, { command: "powershell.exe",
            args: ["-NoProfile", "-NonInteractive", "-Command",
                   "Write-Output 'fine'; Write-Error 'not fine'"],
            timeoutMs: 45000 });
        check("stderr is kept as its own diagnostic — a script that printed " +
              "errors is never reported as clean",
            rr.stderrChars > 0 && rr.clean === false && rr.hadErrors === true,
            { stderrChars: rr.stderrChars, clean: rr.clean });
    }

    // Two runs in one box shared _lcl_out.txt and could show each other's output.
    {
        const [r1, r2] = await Promise.all([
            sandbox.runScript(b1.id, { language: "node", code: "console.log('FIRST')", timeoutMs: 45000 }),
            sandbox.runScript(b1.id, { language: "node", code: "console.log('SECOND')", timeoutMs: 45000 })
        ]);
        const outs = [r1.output || "", r2.output || ""];
        check("two runs in the same box do not collide — neither is shown the " +
              "other's output",
            outs.every(o => !(/FIRST/.test(o) && /SECOND/.test(o))),
            outs.map(o => o.trim().slice(0, 40)));
    }

    // promote() carried the box's own bookkeeping - including the machine's
    // full PATH - into the user's real directory.
    {
        const dest = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-promote-"));
        sandbox.write(b1.id, "deliverable.txt", "the thing worth keeping");
        const out = sandbox.promote(b1.id, dest, { verified: true });
        const leaked = fs.readdirSync(dest).filter(f => f.startsWith("_lcl_"));
        check("promoting verified work never carries the box's own bookkeeping " +
              "— _lcl_env.txt holds the machine's full PATH",
            leaked.length === 0 && out.copied.includes("deliverable.txt"),
            { leaked, copied: out.copied });
        fs.rmSync(dest, { recursive: true, force: true, maxRetries: 4 });
    }

    // releaseSession had no caller anywhere, so boxes were never cleaned up.
    {
        const mainSrc2 = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
        check("something actually CALLS releaseSession — a box that is only " +
              "cleaned up in theory is not cleaned up",
            /sandbox\.releaseSession\(String\(id\)\)/.test(mainSrc2));
        check("...and boxes orphaned by a previous run are swept at startup",
            /for \(const b of sandbox\.list\(\)\) sandbox\.destroy\(b\.id\)/.test(mainSrc2));
    }

    // The compiled interop was cached under a fixed name, so an updated
    // launcher kept loading the OLD assembly and its new code never ran.
    {
        const ps1 = fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "lowbox.ps1"), "utf8");
        check("the cached interop is versioned by the source that built it, so " +
              "an updated launcher is not ignored forever",
            /ComputeHash/.test(ps1) && /lcl-lowbox-/.test(ps1));
        check("the launcher's own header no longer claims more than it does",
            !/it CANNOT write to the user's profile: the attempt is refused/.test(ps1) &&
            /LocalLow/.test(ps1));
    }

    /* --------------------------------------------------- the readouts exist */
    const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
    const appSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
    const cssSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "styles.css"), "utf8");
    check("the boundary is proven at startup, and the proof is auditable",
        /sandbox\.verify\(\)/.test(mainSrc) && /kind: "sandbox-verified"/.test(mainSrc));
    // THE PANEL IS FOR FLIPPING SWITCHES. This asserted the boundary essay was
    // rendered inline in the permissions panel — the proof narrative, the
    // writable-path caveats, the file inventory — which is exactly what made
    // it "a whole page, not just a simple drop down". The essay is KEPT, in
    // full and now copyable, behind the one line that states the verdict.
    check("the panel states the boundary and whether it was TESTED, in one line, " +
          "with the full account one click away rather than in the way",
        /perm-boundary/.test(appSrc) &&
        /Scripts run behind a tested boundary/.test(appSrc) &&
        // the account expands INLINE under the line now — a modal here queued
        // behind the open Permissions sheet and the click read as dead
        /perm-boundary-detail/.test(appSrc) &&
        /detail\.classList\.toggle\("hidden"\)/.test(appSrc));
    check("...and that account still carries everything it used to: the detail, " +
          "the proof, the offer of something stronger, and the box's own path",
        (() => {
            const i = appSrc.indexOf('detail.className = "perm-boundary-detail');
            const b = appSrc.slice(i, i + 900);
            return /iso\.detail/.test(b) && /How it was tested: /.test(b) &&
                   /iso\.offer\.why/.test(b) && /sandboxRoot/.test(b);
        })());
    check("and it is styled in the existing token system",
        /\.perm-boundary \{/.test(cssSrc) && /\.perm-boundary\.proven/.test(cssSrc) &&
        /var\(--radius-sm\)/.test(cssSrc.slice(cssSrc.indexOf(".perm-boundary {"),
                                                cssSrc.indexOf(".perm-boundary {") + 400)));
    check("no rollback machinery was built — uninstall and re-download is the " +
          "revert, as asked",
        !/function rollbackSandbox|restoreFromSnapshot/.test(
            fs.readFileSync(path.join(ROOT, ".lcl.engine", "core", "sandbox.js"), "utf8")));

    sandbox.releaseSession("sess-A");
    sandbox.releaseSession("sess-B");
    rmEscape();
    try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 8 }); } catch { /* held */ }
    console.log(`\n${pass}/${pass + fail} sandbox-boundary checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => {
    console.error("HARNESS ERROR:", e && e.stack || e);
    rmEscape();
    process.exit(1);
});
