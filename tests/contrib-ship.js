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

check("THE IDENTITY IS READ, NOT TYPED — the checkout's git config first, " +
      "then the gh account's noreply address; the fields the operator used " +
      "to paste by hand",
    sec.includes('["config", "user.name"]')
    && sec.includes('["config", "user.email"]')
    && sec.includes("@users.noreply.github.com"), null);

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

check("THE LANES BUMP IN-RUN when asked — RELEASE.json official +1 and both " +
      "package.json patch versions, the step the by-hand ritual kept " +
      "forgetting",
    sec.includes("rel.official = Number(rel.official) + 1")
    && (sec.match(/bumpPkg\(path\.join\(repo,/g) || []).length === 2, null);

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

/* ---- the renderer side ---- */
check("the Patch menu carries the entry and the action opens the panel",
    html.includes('data-action="ship-release"')
    && js.includes('"ship-release": () => openShipPanel()'), null);

check("the panel shows the six steps with dots and per-step consoles, the " +
      "drafted fields stay EDITABLE, and the version/bump line comes from " +
      "the plan — not from anything typed",
    js.includes("const SHIP_STEPS = [")
    && ["bump", "add", "commit", "push", "gate", "publish"]
        .every(sid => js.includes(`["${sid}",`))
    && js.includes('$("ship-commit-msg").value = d.commitMessage')
    && js.includes("bump the lanes to v"), null);

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
    && js.includes("Ship this release?"), null);

check("closing the panel hides the VIEW only — a live run keeps running in " +
      "main (the same ownership rule the knowledge batch earned)",
    js.includes("closing hides the VIEW")
    && !js.includes('$("ship-close").addEventListener("click", () => window.lcl.contribCancel'), null);

check("the panel is styled — scrim, step dots, mono consoles",
    ["#ship-scrim {", "#ship-panel {", ".ship-step-dot {", ".ship-step-out {"]
        .every(c => css.includes(c)), null);

console.log(`\n${pass}/${pass + fail} contrib-ship checks passed`);
process.exit(fail ? 1 : 0);
