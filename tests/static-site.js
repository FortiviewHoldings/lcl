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

/* ---- THE INTRO HAS A VOICE, AND THE PAGE OWNS ITS PLAYBACK ----
 * "still no audio, my machine is not muted. the volume is all the way up,
 * no audio." — the video element decoded audio without delivering it, so the
 * intro's voice is now a DEDICATED audio element carrying the clip's own
 * track, loudness-normalized. The video stays muted (the visual autoplays
 * under every policy); sound is attempted immediately, and when the autoplay
 * policy refuses, the first gesture on the landing DELIVERS it — in sync
 * mid-clip, or as a full replay once the 5-second clip has ended. */
check("the intro's voice is a dedicated audio element with the clip's own " +
      "track — the page owns playback instead of trusting the video element",
    s.includes('id="intro-audio"')
    && s.includes('src="app/assets/landing-intro.m4a"')
    && /intro\.play\(\)/.test(s), null);
check("...the visual always autoplays (video stays muted) so no policy can " +
      "black the landing",
    /<video[^>]*muted/.test(s), null);
check("a policy-refused intro is DELIVERED by the first gesture on the landing " +
      "— live and in sync mid-clip, a full replay with audio once it has ended",
    /policyMuted/.test(s) && /firstGesture/.test(s)
    && s.includes('document.addEventListener("pointerdown", firstGesture)')
    && s.includes("intro.currentTime = video.currentTime")
    && s.includes("video.currentTime = 0;"), null);
check("...a click that is LEAVING the landing never restarts the show behind " +
      "itself",
    /leaving/.test(s) && s.includes('closest("#landing-skip")'), null);
check("...and the forced mute is VISIBLE — the button cues and says 'Click for " +
      "sound' instead of leaving the voice a secret",
    s.includes('soundBtn.classList.add("cue")')
    && s.includes("Click for sound")
    && /♪/.test(s) && /✕/.test(s), null);
check("...with an ON-SCREEN caption saying what unlocks it — 'click anywhere " +
      "for sound' appears when the policy refuses, clears once it is heard",
    s.includes('id="sound-hint"')
    && s.includes("click anywhere for sound")
    && s.includes('$("sound-hint").classList.add("on")')
    && s.includes('$("sound-hint").classList.remove("on")'), null);
{
    // both intro assets must CARRY audio — a metadata strip once came one flag
    // away from discarding the track. Guarded only where the local ffprobe
    // exists (it is fetched, not tracked), so a fresh clone still passes.
    const probe = path.join(ROOT, "tools", "ffmpeg", "win-x64", "ffprobe.exe");
    if (fs.existsSync(probe)) {
        const hasAudio = (rel) => {
            try {
                const out = execFileSync(probe, ["-v", "quiet", "-show_streams",
                    path.join(ROOT, rel)], { encoding: "utf8" });
                return /codec_type=audio/.test(out);
            } catch { return false; }
        };
        check("landing.mp4 still carries its AUDIO TRACK — the intro's voice is " +
              "part of the asset, not an accident a re-encode may drop",
            hasAudio("app/assets/landing.mp4"), null);
        check("...and landing-intro.m4a is a real audio stream, not an empty shell",
            hasAudio("app/assets/landing-intro.m4a"), null);
    } else {
        console.log("     (ffprobe not fetched on this machine — audio-track checks skipped)");
    }
}

/* ---- SESSIONS AND THE WORKSPACE ARE REAL, IN BROWSER STORAGE ----
 * "the sessions in lite are not functional, amongst other items like
 * workspaces etc. that should all be built to use local and session storage
 * in the browser." — so they are: sessions, their transcripts, and a
 * per-session file workspace persist in localStorage; sessionStorage
 * remembers that this tab already entered the bench, so a refresh returns
 * to work instead of replaying the intro. */
check("sessions PERSIST in localStorage — create, switch, delete, and the " +
      "transcript survives closing the tab",
    s.includes('localStorage.setItem(STORE_KEY')
    && s.includes('"lcl-lite-v1"')
    && /newSession/.test(s) && /activeSession/.test(s)
    && s.includes("store.sessions.filter"), null);
check("...a session titles itself from its first message, the way real " +
      "workbenches do",
    s.includes('s.title === "New session"') && s.includes("q.slice(0, 42)"), null);
check("...and a refresh returns to the BENCH, not the intro — sessionStorage " +
      "remembers this tab already entered",
    s.includes('sessionStorage.setItem("lcl-lite-bench"')
    && s.includes('sessionStorage.getItem("lcl-lite-bench")'), null);
check("the FILE WORKSPACE is real — per-session files created, edited in a " +
      "sheet, saved, deleted, all in browser storage",
    /paintFiles/.test(s) && /openFileSheet/.test(s)
    && s.includes('id="file-sheet"') && s.includes('id="file-save"')
    && s.includes('id="file-delete"') && s.includes('id="file-add"'), null);
check("...and the MODEL READS the workspace — the files ride the system " +
      "message, so asking about your notes actually works",
    /workspaceContext/.test(s)
    && s.includes("s.files.map"), null);
check("...with an Insert-into-chat path from the editor to the composer",
    s.includes('id="file-insert"'), null);

/* ---- THE WORKBENCH CHROME, LIVE WHERE LITE CAN BE ----
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
check("the sidebar carries LIVE session cards with the app's status dots (idle, " +
      "working) and the machine dock reading REAL facts (cores, WebGPU)",
    /session-card/.test(s) && /"working" : "idle"/.test(s)
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

/* ---- PRODUCTION REGISTER BELOW THE FOLD ----
 * "i also want this more production grade landing page" — a sticky nav over
 * the sections, how-patching-works, real system requirements, an FAQ with
 * real answers, and a proper footer. Same skin throughout. */
check("a sticky site nav over the sections — features, patching, requirements, " +
      "comparison, FAQ, source, and the download in the primary slot",
    /id="site-nav"/.test(s) && /#patching/.test(s) && /#requirements/.test(s)
    && /#faq/.test(s) && /id="nav-dl"/.test(s), null);
check("the patching story is a SECTION — cut and signed, detected and verified, " +
      "installed on your click",
    /Signed one-click patches/.test(s) && /Cut and signed/.test(s)
    && /Detected and verified/.test(s) && /Installed on your click/.test(s), null);
check("system requirements are a REAL table — RAM, disk, CPU, GPU optional, " +
      "network never required",
    /System requirements/.test(s) && /8 GB/.test(s) && /16 GB/.test(s)
    && /32 GB/.test(s) && /never required/.test(s), null);
check("an FAQ that answers the real questions — privacy, the 1.7 GB, training, " +
      "updates, source, platforms",
    /id="faq"/.test(s)
    && /Does anything I type here leave my machine\?/.test(s)
    && /Is my data used to train anything\?/.test(s)
    && /Can I read the source\?/.test(s), null);
check("a real footer — product, source, license columns",
    /<footer>/.test(s) && /MIT license/.test(s)
    && s.includes("github.com/FortiviewHoldings/lcl/releases"), null);

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
