/**
 * CONTRIBUTOR SHIP — the release ritual from the Patch menu.
 *
 * The operator's ask, verbatim: "im getting tired of opening the terminal,
 * opening this repo in that terminal, and doing the commit ... if the user is
 * a contributor, i want from the Patch drop down, this new feature. to make
 * the commit from whatever the pending build is, that needs to be pushed ...
 * these can not run concurrently, so we have to know when one finished, so
 * the next can run. so we need to be measuring the output of the command and
 * visualizing it. those fields that are for user.name and commit -m i want
 * those to be dynamically populated, and the commit i want to be able to have
 * a local model read the build differences, and contextually give a message
 * ... and same with the release create. it needs to get the correct version
 * build, and the notes."
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
const pre = fs.readFileSync(path.join(ROOT, "app", "preload.js"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "app", "renderer", "index.html"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "app", "renderer", "styles.css"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 200) : ""); }
}

/* the ship section of main.js, isolated so pins cannot match unrelated code */
const secStart = main.indexOf("// CONTRIBUTOR SHIP (Patch menu");
const secEnd = main.indexOf('ipcMain.handle("lcl:pickOpenerApp"');
const sec = secStart >= 0 && secEnd > secStart ? main.slice(secStart, secEnd) : "";

check("the ship section exists in main, before the opener handlers",
    sec.length > 1000, { secStart, secEnd });

check("SIX HANDLERS: status, pick-repo, plan, draft, run, cancel",
    ["lcl:contribStatus", "lcl:contribPickRepo", "lcl:contribPlan",
     "lcl:contribDraft", "lcl:contribRun", "lcl:contribCancel"]
        .every(h => sec.includes(`ipcMain.handle("${h}"`)), null);

check("CONTRIBUTORS ONLY, decided by facts not flags — gh auth status, " +
      "gh api permissions.push on the checkout's own remote, git/gh on PATH, " +
      "and a validated checkout; every missing piece NAMED",
    sec.includes('["auth", "status"]')
    && sec.includes('".permissions.push"')
    && sec.includes("missing.push(")
    && sec.includes('fs.existsSync(path.join(p0, ".git"))'), null);

check("THE COMMIT EMAIL IS ALWAYS THE GH NOREPLY — the first cut preferred " +
      "git config's email, which was the operator's PRIVATE address: GitHub " +
      "rejected the push with GH007 (email privacy), twice, and the audit " +
      "tail named it. The noreply is built from the gh account whenever a " +
      "login exists; config email survives only for the no-gh case that " +
      "cannot ship anyway, and config supplies the display name only",
    sec.includes("GH007")
    && sec.includes("@users.noreply.github.com")
    && sec.includes('["config", "user.name"]')
    && sec.indexOf("@users.noreply.github.com")
        < sec.indexOf('["config", "user.email"]'), null);

/* "reading the diff is INSANELY slow, and has absolutely no insight to what
 * the fuck is going on or the total progress ... it should lock out those
 * fields, until the auto text generator runs. and that should have a
 * visualization" */
check("THE DRAFT IS WATCHED, NOT WAITED ON — every phase says itself (diff " +
      "read, model loading, drafting) and the generation STREAMS: the engine " +
      "hands back accumulated text per tick and the renderer paints it into " +
      "the field, token count on the state line",
    sec.includes("const draftSay = (line)")
    && sec.includes("loading the local model")
    && sec.includes("draftText: String((t && t.text)")
    && js.includes("p.draftText !== undefined")
    && js.includes("drafting — ${p.draftTokens || 0} tokens"), null);

check("...and the FIELDS LOCK while the model writes — read-only from the " +
      "first phase line to the parsed result, a stale stream paints " +
      "nothing, and only then are the fields the operator's",
    js.includes("msgEl.readOnly = true; notesEl.readOnly = true;")
    && js.includes("if (!shipDrafting) return;")
    && js.includes("msgEl.readOnly = false; notesEl.readOnly = false;")
    && css.includes(".ship-field textarea.drafting"), null);

check("SEQUENTIAL, NEVER CONCURRENT — every step is awaited to exit before " +
      "the next starts, a non-zero exit stops the chain, and a second run is " +
      "refused while one is live",
    (sec.match(/await contribStep\(/g) || []).length >= 5
    && !/Promise\.all/.test(sec)
    && sec.includes('if (contribRunState) return { error: "a ship run is already in progress" }')
    && (sec.match(/if \(r\.code !== 0\) return fail\(/g) || []).length >= 5, null);

check("THE OUTPUT IS MEASURED AND VISUALIZED — stdout AND stderr streamed " +
      "line by line over one progress channel the renderer listens to",
    sec.includes('child.stdout.on("data", feed)')
    && sec.includes('child.stderr.on("data", feed)')
    && sec.includes('"lcl:contribProgress"')
    && pre.includes('onContribProgress: (cb) => ipcRenderer.on("lcl:contribProgress"'), null);

check("NO SHELL, NO INJECTION — every command is a fixed binary with an " +
      "argument ARRAY; the commit message and notes ride as arguments, never " +
      "interpolated into a shell line",
    !/shell:\s*true/.test(sec)
    && sec.includes('spawn(bin, args, { cwd, windowsHide: true')
    && sec.includes('"commit", "-m", msg]'), null);

check("THE VERSION AND TAG ARE READ, NEVER HARDCODED — app/package.json is " +
      "the source, the installer path and the vX tag are built from it, and " +
      "the artifacts are PROVEN on disk before gh release create runs",
    sec.includes("`lcl-Installer-${version}.exe`")
    && sec.includes("`v${version}`")
    && sec.includes("missing artifact"), null);

check("THE BUMP IS A FACT, NOT A CHECKBOX — 'im shipping, would i not always " +
      "want to make sure there is no conflict there? so why even ask': the " +
      "run itself asks gh whether v{version} is already a published tag and " +
      "bumps exactly when it is; the renderer's opinion is never consulted " +
      "(no opts.bump anywhere), and the panel just STATES the decision",
    sec.includes("releases/tags/v${version}")
    && sec.includes("mustBump = tt.ok")
    && sec.includes("if (mustBump) {")
    && !sec.includes("o.bump")
    && sec.includes("rel.official = Number(rel.official) + 1")
    && (sec.match(/bumpPkg\(path\.join\(repo,/g) || []).length === 2
    && sec.includes("is unpublished — this ship releases it as-is")
    && js.includes('$("ship-bump-note").innerText = plan.bumpNote')
    && !js.includes('$("ship-bump").checked')
    && !html.includes('id="ship-bump"'), null);

check("THE APP FINDS ITS OWN CHECKOUT — and its repo identity comes from THE " +
      "INSTALLATION ITSELF: the release stamps the checkout's origin into the " +
      "baked build-info, the installed app reads its own stamp (the channel " +
      "setting stands in only for pre-stamp builds), and the operator's " +
      "session folders are scanned for a checkout whose origin MATCHES; the " +
      "picker survives only as the fallback when no session folder qualifies",
    sec.includes("function contribDiscoverRepo")
    && sec.includes("const baked = runningBuild()")
    && sec.includes("baked.repo.owner")
    && sec.indexOf("runningBuild()") < sec.indexOf("paths.readSettings().patchChannel")
    && sec.includes("sessions.list()")
    && sec.includes('how: "discovered"')
    && (sec.match(/contribDiscoverRepo\(\)/g) || []).length >= 4
    && js.includes("checkout found from your sessions")
    && (() => {
        const rel = fs.readFileSync(path.join(ROOT, "devtools", "release.js"), "utf8");
        return rel.includes("git remote get-url origin")
            && rel.includes("repo,                                  // the origin this build came from");
    })(), null);

check("THE DRAFT IS AGENTIC — a local model reads the real diff (stat, " +
      "names, sample) and answers a commit line and release notes; a model " +
      "that cannot answer falls back to an HONEST heuristic, never silence",
    sec.includes('["diff", "--stat", "HEAD"]')
    && sec.includes("engine.generate(")
    && sec.includes("COMMIT:")
    && sec.includes("NOTES:")
    && sec.includes("const fallback = ()"), null);

check("every failure and every ship lands in the audit log",
    sec.includes('kind: "contrib-ship-failed"')
    && sec.includes('kind: "contrib-ship"'), null);

/* ---- THE FIRST FAILURE'S LESSONS (25 Aug: "git push exited 1" and nothing
 * else survived — the exit code alone told us nothing, and reopening the
 * panel wiped the one console that held the stderr) ---- */
check("THE EVIDENCE SURVIVES — every step's output is kept in main (capped), " +
      "the audit failure entry carries the step's last 25 lines, and a " +
      "lastRun handler serves the whole record back",
    sec.includes("let contribLastRun = null")
    && sec.includes("contribRunState.transcript[step]")
    && sec.includes(".slice(-25)")
    && sec.includes('ipcMain.handle("lcl:contribLastRun"')
    && pre.includes("contribLastRun: () => ipcRenderer.invoke"), null);

check("...the panel REPLAYS the last run on open instead of wiping it — the " +
      "failed step reopens with its output, the state line names it, and a " +
      "resume skips the fresh draft that would bury the message",
    js.includes("window.lcl.contribLastRun()")
    && js.includes("previous run failed at ")
    && js.includes("if (lastFailNote) {"), null);

check("A RETRY RESUMES — an already-committed tree skips add and commit " +
      "honestly ('already committed — resuming at push') instead of dying " +
      "on 'nothing to commit', and the commit-message requirement applies " +
      "only when there is something to commit",
    sec.includes('"already committed — resuming at push"')
    && sec.includes('if (!msg) return fail("commit", "a commit message is required")')
    && js.includes('dataset.dirty !== "0"'), null);

check("NO HIDDEN PROMPTS — spawned steps run with GIT_TERMINAL_PROMPT=0 and " +
      "GCM_INTERACTIVE=Never, so a credential problem fails LOUD in the " +
      "console instead of hanging a windowless process",
    sec.includes('GIT_TERMINAL_PROMPT: "0"')
    && sec.includes('GCM_INTERACTIVE: "Never"'), null);

check("THE APP'S ENGINE STANDS DOWN BEFORE THE GATE — the gate's engine " +
      "suite needs the same fixed port the resident model holds (the draft " +
      "loads it!): a loaded engine met 401s and a refused build, read from " +
      "the audit tail. Unloaded first, said out loud, reloads on next use",
    sec.includes("releasing the local engine so the gate can use its port")
    && sec.includes("engine.unloadNow()")
    && sec.indexOf("engine.unloadNow()")
        < sec.indexOf('contribStep("gate", "node"'), null);

check("EVERY STEP CONSOLE HAS A COPY BUTTON — one click takes the whole " +
      "output, without toggling the console shut",
    js.includes("ship-step-copy")
    && js.includes("Copy this step's output")
    && (() => {
        const i = js.indexOf('copy.addEventListener("click"');
        return i > 0 && js.slice(i, i + 200).includes("e.stopPropagation()")
            && js.slice(i, i + 300).includes("copyToClipboard(");
    })()
    && css.includes(".ship-step-copy"), null);

/* ---- the renderer side ---- */
check("the Patch menu carries the entry and the action opens the panel",
    html.includes('data-action="ship-release"')
    && js.includes('"ship-release": () => openShipPanel()'), null);

check("the panel shows the six steps with dots and per-step consoles, and " +
      "the drafted fields stay EDITABLE",
    js.includes("const SHIP_STEPS = [")
    && ["bump", "add", "commit", "push", "gate", "publish"]
        .every(sid => js.includes(`["${sid}",`))
    && js.includes('$("ship-commit-msg").value = d.commitMessage'), null);

check("the clear-marks control is an ERASER — a glyph that says what it does " +
      "at a glance, not a check with a line through it",
    (() => {
        const i = html.indexOf('id="ws-clear-marks"');
        if (i < 0) return false;
        const b = html.slice(Math.max(0, i - 200), html.indexOf("</button>", i));
        return /ERASER/.test(b) && b.includes("<svg")
            && !b.includes("M20 6L9 17l-5-5");
    })(), null);

check("a NON-contributor gets the honest list of what is missing plus the " +
      "one affordance the app can supply — choosing the checkout",
    js.includes("Shipping needs everything on this list:")
    && js.includes("Choose checkout…")
    && js.includes("contribPickRepo"), null);

check("the stream paints into the talking step, capped against a runaway " +
      "build, and the run confirms before anything executes",
    js.includes("onContribProgress")
    && js.includes("out.textContent += p.line")
    && js.includes("lines.slice(-400)")
    && js.includes("Release this patch?"), null);

check("closing the panel hides the VIEW only — a live run keeps running in " +
      "main (the same ownership rule the knowledge batch earned)",
    js.includes("closing hides the VIEW")
    && !js.includes('$("ship-close").addEventListener("click", () => window.lcl.contribCancel'), null);

check("the panel is styled — scrim, step dots, mono consoles",
    ["#ship-scrim {", "#ship-panel {", ".ship-step-dot {", ".ship-step-out {"]
        .every(c => css.includes(c)), null);

/* ---- THE SECOND REPORT'S LESSONS (25 Aug: "it holds the last patch
 * shipped ... this is causing the ui to be stale"; "i told you i wanted to
 * see the waiting for the software to populate the ui"; "you have the mouse
 * cursor as the animation. i dont like that") ---- */
check("A SHIPPED RUN IS HISTORY — only a FAILED run's evidence replays on " +
      "open; a successful last patch never dresses a fresh panel in stale " +
      "consoles while a new patch sits ready in the tree",
    js.includes("if (last && last.at && !last.ok && !shipRunning)")
    && js.includes("A run that SHIPPED is"), null);

check("THE PANEL POPULATES IN FRONT OF YOU — a fresh blank face, then the " +
      "patch line, then the identity, then the streaming draft, each stage " +
      "named on the state line in sequence",
    js.includes("STAGE 1 — the relevant patch")
    && js.includes("STAGE 2 — who is cutting it")
    && js.includes("STAGE 3 — the draft streams into the fields")
    && (() => {
        const o = js.indexOf("async function openShipPanel");
        const seg = js.slice(o, o + 6000);
        return seg.indexOf("contribPlan()") > 0
            && seg.indexOf("contribPlan()") < seg.indexOf("contribStatus()");
    })(), null);

check("...with a VISIBLE waiting treatment: shimmering placeholders on the " +
      "unfilled fields, a pulsing dot on the working state line, an animated " +
      "sweep on the drafting fields — and NO cursor-as-status anywhere",
    js.includes('classList.add("ship-wait")')
    && js.includes("function shipState(")
    && css.includes(".ship-wait {")
    && css.includes(".ship-note.working::before")
    && css.includes("@keyframes ship-sweep")
    && (() => {
        const i = css.indexOf("textarea.drafting");
        return i > 0 && !css.slice(i, i + 500).includes("cursor: progress");
    })(), null);

/* "it allowed me to release without any patch. the notification badges also
 * appeared, which is not correct, they referred to the logs, not whether
 * there was an available patch or not only" — a second run on a clean,
 * fully-released tree bumped the lanes over NOTHING, and the residue lit
 * the badge. */
check("LANE FILES ARE BOOKKEEPING, NOT CONTENT — one shared filter names the " +
      "bump's three files, and the ready badge counts only content beyond them",
    sec.includes("const CONTRIB_LANE_FILES = new Set([")
    && sec.includes('"app/package.json", "devtools/RELEASE.json", "devtools/installer/package.json"')
    && sec.includes("function contribContentFiles(")
    && (() => {
        const i = sec.indexOf('ipcMain.handle("lcl:contribReady"');
        return i > 0 && sec.slice(i, i + 700).includes("contribContentFiles(");
    })(), null);

check("NO PATCH, NO RUN — the plan states releasable as a fact (content, " +
      "unpushed commits, or a FULLY-CLEAN unpublished resume; lane-only " +
      "residue is none of those), the button obeys it, and the run itself " +
      "REFUSES an empty release before the bump can write anything",
    sec.includes("const releasable = contentCount > 0 || ahead > 0")
    && sec.includes("(!tagTaken && files.length === 0)")
    && sec.includes("bump residue); revert ")
    && sec.includes("is already `\n                        + \"live and the tree is clean\"")
    && sec.indexOf("NOTHING TO RELEASE IS A REFUSAL") < sec.indexOf("if (mustBump) {")
    && js.includes("const releasable = plan.releasable !== false")
    && js.includes('$("ship-run").disabled = !releasable')
    && js.includes("nothing to release — only the version-lane files differ")
    && js.includes("is live and the tree is clean"), null);

check("READY-TO-CUT WEARS A BADGE — the Knowledge-badge shape on the Patch " +
      "menu label AND on the Release Patch line item, painted at boot and on " +
      "menu open, fed by a git-only handler that never spawns gh",
    html.includes('id="patch-badge"')
    && html.includes('id="ship-badge"')
    && js.includes("function shipPaintBadge(")
    && js.includes("shipBadgeFromBoot()")
    && pre.includes('contribReady: () => ipcRenderer.invoke("lcl:contribReady")')
    && (() => {
        const i = sec.indexOf('ipcMain.handle("lcl:contribReady"');
        if (i < 0) return false;
        const h = sec.slice(i, sec.indexOf("ipcMain.handle", i + 10));
        return h.includes('["status", "--porcelain"]')
            && h.includes('"origin/main..HEAD"')
            && !h.includes('"gh"');
    })(), null);

console.log(`\n${pass}/${pass + fail} contrib-ship checks passed`);
process.exit(fail ? 1 : 0);
