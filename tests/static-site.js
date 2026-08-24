/**
 * THE STATIC SITE IS PART OF THE PRODUCT — same bar as everything else.
 *
 * The operator's ask: "the index for the static page that is going to serve
 * .lcl to utilize in browser, and download with a link to click. the download
 * should install and be the latest release ... a lite version of .lcl,
 * showcasing its full functionality ... all local, in the static site and
 * browser."
 *
 * What this pins:
 *   - the page exists at the repo root (GitHub Pages serves it as-is)
 *   - every LOCAL asset it references exists and is TRACKED (a Pages deploy
 *     serves the repo tree — an untracked asset is a broken image in prod)
 *   - the download button resolves the LATEST release's installer via the
 *     GitHub API, with a static fallback to the releases page when JS/API fail
 *   - the lite chat is CLIENT-SIDE local inference (WebLLM/WebGPU), refuses
 *     honestly without WebGPU, and the page carries no analytics or trackers
 *   - the claims stay honest: lite-vs-full is a table, not a blur
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FILE = path.join(ROOT, "index.html");

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 240) : ""); }
}

check("index.html exists at the repo root", fs.existsSync(FILE));
const s = fs.existsSync(FILE) ? fs.readFileSync(FILE, "utf8") : "";

/* ---- local assets: present AND tracked ---- */
{
    const refs = [...s.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1])
        .filter(u => !/^https?:|^#|^mailto:/.test(u));
    check("the page references local assets (brand art, favicon)", refs.length >= 2, refs);
    const missing = refs.filter(r => !fs.existsSync(path.join(ROOT, r)));
    check("every local asset it references exists on disk", missing.length === 0, missing);
    let untracked = [];
    try {
        const tracked = new Set(execFileSync("git", ["-C", ROOT, "ls-files"],
            { encoding: "utf8" }).split(/\r?\n/));
        untracked = refs.filter(r => !tracked.has(r.replace(/\\/g, "/")));
    } catch { /* no git — existence check above stands */ }
    check("...and every one is TRACKED — Pages serves the repo tree, so an " +
          "untracked asset is a broken image in production", untracked.length === 0, untracked);
}

/* ---- the download: latest release, one click, honest fallback ---- */
check("the download button resolves the LATEST release's installer via the API",
    s.includes("api.github.com/repos/FortiviewHoldings/lcl/releases/latest")
    && /Installer.*\\.exe\$\/i?\.test|\/Installer\.\*\\\.exe\$\/i/.test(s), null);
check("...with a static fallback href to the releases page when JS or the API fail",
    s.includes('href="https://github.com/FortiviewHoldings/lcl/releases/latest"'), null);
check("...and it says the release is signed and verified, because that is the story",
    /Ed25519-signed release/.test(s), null);

/* ---- the lite chat: local, honest, no trackers ---- */
check("the lite chat runs CLIENT-SIDE via WebLLM", /esm\.run\/@mlc-ai\/web-llm/.test(s), null);
check("...gated on WebGPU with an honest refusal when absent",
    /navigator\.gpu/.test(s) && /no WebGPU/.test(s), null);
check("...streaming, so the demo feels like the app", /stream:\s*true/.test(s), null);
check("...and it says plainly that inference is local and nothing typed leaves the page",
    /nothing you type leaves this page/i.test(s), null);
check("NO analytics, trackers, or beacons — a page about local-first computing " +
      "must not phone home itself",
    !/gtag|googletagmanager|google-analytics|plausible|fathom|hotjar|segment\.com|facebook|mixpanel|sentry/i.test(s), null);

/* ---- IT LOOKS LIKE THE APP, because that is the entire point ----
 * The operator's correction, verbatim: "i said i wanted it to open with my
 * new session animation, the audio file that plays, all the logo, style,
 * all of that good stuff ... a lite version meaning, it looks the same, so
 * a user actually sees what they are getting before they download." */
check("the page OPENS AS THE APP OPENS — the real new-session landing: the same " +
      "video clip, veil, wordmark and subtitle the app shows",
    s.includes('src="app/assets/landing.mp4"')
    && /landing-veil/.test(s)
    && s.includes('src="app/assets/wordmark-trim.png"')
    && s.includes("AI on your own machine — nothing leaves it unless you say so"), null);
check("...with the app's intro-sound toggle, and the app's own fallback: play " +
      "with audio, drop to muted when the autoplay policy refuses",
    /intro-sound/.test(s) && /video.muted = true/.test(s)
    && /♪/.test(s) && /✕/.test(s), null);
check("...and the app's own two-action choice — the download in the primary " +
      "slot, 'Just chat' dropping into the lite chat like the real transition",
    /Just chat/.test(s) && /landing-skip/.test(s)
    && s.includes('classList.add("hidden")'), null);
check("THE SKIN IS THE APP'S SKIN — its ground (#050505), its font stack, and " +
      "the white-fill primary button, not a website's invented palette",
    s.includes("#050505")
    && s.includes('"Segoe UI Variable Display"')
    && s.includes("linear-gradient(180deg, #ffffff, #d8d8da)")
    && s.includes("#030303"), null);
check("...down to the app's bubble geometry for the lite chat",
    s.includes("linear-gradient(180deg, #1e1e22, #131316)"), null);

/* ---- THE WORKBENCH CHROME, AS DEMO STUBS ----
 * "the lite chat should have a majority of the ui likeness, as demo stubs" —
 * the sidebar with session cards and status dots, the machine dock, the
 * workspace panel's modular sections, the composer's icon row (folder, book,
 * shield, mic, the model selector joining it), and the permission popup AT
 * the composer — live where the lite really does the thing, honest stubs
 * where only the full app can. */
check("the bench is the app's three-pane arrangement — sessions sidebar, chat, " +
      "workspace panel — with working collapse toggles like the app's",
    /id="sidebar"/.test(s) && /id="workspace"/.test(s)
    && /tg-side/.test(s) && /tg-ws/.test(s)
    && s.includes('classList.toggle("collapsed")'), null);
check("the sidebar carries session cards with the app's status dots and the " +
      "machine dock pinned at the bottom, reading REAL facts (cores, WebGPU)",
    /session-card/.test(s) && /dot working/.test(s) && /dot approval/.test(s)
    && /machine-dock/.test(s) && /hardwareConcurrency/.test(s), null);
check("the composer carries the app's icon row — folder, book, shield, mic — " +
      "with the model selector JOINING that row and Send staying with the field",
    /data-stub="folder"/.test(s) && /data-stub="book"/.test(s)
    && /data-stub="shield"/.test(s) && /data-stub="mic"/.test(s)
    && /id="model-btn"/.test(s), null);
check("every stub raises the app's own ask — a perm-prompt AT the composer, " +
      "naming the capability and pointing at the download, never a dead button",
    /perm-popup-layer/.test(s) && /perm-prompt/.test(s)
    && /Get the full app/.test(s), null);
check("the model menu is the app's grouped picker in miniature — the local tier " +
      "live, the node/API/GPU tiers present and honestly marked full-app",
    /Local — in this browser/.test(s)
    && s.includes("Local nodes · APIs · rented GPU — full app"), null);
check("the workspace panel has the app's modular sections — Files, Tasks, " +
      "Activity, Permissions — with minimize controls, Tasks and Activity LIVE",
    /ws-sec/.test(s) && /data-min/.test(s)
    && s.includes("setTask(") && s.includes("logAct("), null);
check("an answered turn carries the app's meta chips — $0.00 on your own GPU, " +
      "said the way the app says it",
    /msg-meta/.test(s) && s.includes("$0.00 · your GPU"), null);

/* ---- the claims stay honest ---- */
check("the tagline is the README's tagline — one product, one sentence",
    /An AI workbench that runs on your machine, with the network switched off/.test(s), null);
check("lite-vs-full is an explicit table, not a blur — the lite page does not " +
      "pretend to carry the tools, the library, or the hardware",
    /Lite vs full/.test(s) && /60\+, permission-gated/.test(s), null);
check("the system prompt tells the model what it IS — a lite in-browser demo " +
      "that points capability questions at the full app",
    /You are \.lcl lite/.test(s), null);

console.log(`\n${pass}/${pass + fail} static-site checks passed`);
process.exit(fail ? 1 : 0);
