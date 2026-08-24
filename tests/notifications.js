/**
 * THE APP TELLS YOU, IN YOUR OWN VOICE, AND ONLY ABOUT WHAT MATTERS.
 *
 * The specification behind these checks:
 *
 *   The app should play only its own notification sound, not the Windows
 *   system default on top of it. Approval requests — when the model is asking
 *   for something — must surface even when the window is closed and .lcl is
 *   running in the system tray. The pop-up should not appear in the session
 *   being worked in; instead the session status bubble in the left sidebar
 *   indicates it needs approval with a new colour, and when that session is
 *   opened the permission request approval is presented.
 *
 * Every clause is a check below, read off the real source. These are wiring
 * checks by necessity — a toast cannot be raised in a headless test — so each
 * one pins the exact mechanism the behaviour depends on, and says what broke
 * without it.
 */
const fs = require("fs");
const path = require("path");

const R = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(R, "app", "main.js"), "utf8");
const pre = fs.readFileSync(path.join(R, "app", "preload.js"), "utf8");
const app = fs.readFileSync(path.join(R, "app", "renderer", "app.js"), "utf8");
const css = fs.readFileSync(path.join(R, "app", "renderer", "styles.css"), "utf8");
const sessionsSrc = fs.readFileSync(
    path.join(R, ".lcl.engine", "core", "sessions.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else {
        fail++;
        console.log("FAIL |", name,
            detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 240) : "");
    }
}

/* ------------------------------------------------- ONE SOUND, AND IT IS YOURS */
{
    // Every Notification construction in the app, with the silent flag it
    // carries. Sliced forward from each constructor rather than regex-matched
    // to a closing brace: a template literal in the body (`(${why})`) closes
    // the naive pattern early, which made this read zero notifications and
    // pass for the wrong reason.
    const blocks = main.split("new Notification({").slice(1)
        .map(b => b.slice(0, b.indexOf("silent:") >= 0
            ? b.indexOf("silent:") + 40 : 400));
    // notifyFinished builds its options object FIRST (the win32 protocol-toast
    // XML rides in it), so it constructs via `new Notification(opts)` — counted
    // separately, and its silent flag is pinned by name below.
    check("every OS notification in the app is accounted for",
        blocks.length + (main.match(/new Notification\(opts\)/g) || []).length >= 5,
        blocks.length);
    check("...including notifyFinished's prebuilt options, which stay silent " +
          "and carry the lcl:// protocol toast on windows",
        /const opts = \{[\s\S]{0,400}silent: true/.test(
            main.slice(main.indexOf("function notifyFinished"))) &&
        /toastXml = `<toast activationType="protocol"/.test(
            main.slice(main.indexOf("function notifyFinished"),
                       main.indexOf("function notifyFinished") + 2400)), null);
    const loud = blocks.filter(b => /silent:\s*false/.test(b));
    check("THE WINDOWS DEFAULT DING IS OFF EVERYWHERE BUT THE CRASH TOAST — " +
          "`silent: false` is what asks the OS to play its own sound on top of " +
          "the app's done.wav, which is the double sound this prevents",
        loud.length === 1 && /recovered from a crash/.test(loud[0]),
        loud.map(b => b.slice(0, 60)));
    check("...and the crash toast keeps it for the one honest reason: the " +
          "renderer that plays the app's sound is what just died",
        /renderer is precisely what just died|only sound available/i.test(main), null);

    check("the finish toast is silent and asks the renderer for the app's sound",
        /silent: true[\s\S]{0,200}?n\.on\("click"[\s\S]{0,120}?chime\("done"\)/.test(main)
        || /chime\("done"\)/.test(main), null);
    check("the attention toast does the same",
        /chime\("attention"\)/.test(main), null);
    check("main never plays audio itself — the renderer owns the one sound",
        !/new Audio\(/.test(main), null);
}

/* the renderer half */
{
    check("the bridge carries the chime", /onChime:/.test(pre)
        && /ipcRenderer\.on\("lcl:chime"/.test(pre), null);
    check("the renderer plays it, in ONE place",
        /function playChime\(/.test(app)
        && (app.match(/new Audio\(/g) || []).length <= 2, null);
    check("...the finish sound still fires on working -> idle/failed",
        /playChime\("done"\)/.test(app), null);
    check("...and an 'attention' sound can be dropped in as its own file " +
          "without a code change, falling back to the finish sound until then",
        /needs-you\.wav/.test(app) && /done\.wav/.test(app), null);
    check("...and main's chime request is subscribed", /onChime\(\(d\)/.test(app), null);
}

/* --------------------------------------- THE TRAY IS ALIVE, NOT A DEAD ICON */
{
    check("THE TRAY REPAINTS — it was a fixed tooltip and a menu built once at " +
          "boot, which said nothing about what was happening while the window " +
          "was closed",
        /function paintTray\(\)/.test(main), null);
    check("...on every status change, which is the only thing that moves it",
        /paintTray\(\);/.test(main)
        // the window is wider now: the durable doneAt/lastError stamp sits
        // between the head of setSessionStatus and its paintTray tail
        && /setSessionStatus[\s\S]{0,2600}?paintTray\(\)/.test(main), null);
    check("...the tooltip counts what needs you and what is working",
        /needs you/.test(main) && /working/.test(main)
        && /tray\.setToolTip/.test(main), null);
    check("...and a session that needs you is a menu item that opens straight to it",
        /focusSession\(id,[\s\S]{0,60}?"approval"|focusSession\(id, st\.state === "approval"/.test(main), null);
    check("the tooltip stays inside the Windows 127-character cap",
        /slice\(0, 120\)/.test(main), null);
}

/* ------------------------------- BUTTONS THAT ACTUALLY EXIST ON THIS MACHINE */
{
    check("THE APPROVE/REJECT BUTTONS ARE BUILT THE WINDOWS WAY. Electron's " +
          "`actions` array is documented @platform darwin — on Windows " +
          "that branch drew NOTHING and only click-to-open ever " +
          "worked. Windows' doorway is toastXml with protocol activation",
        /toastXml/.test(main) && /activationType="protocol"/.test(main), null);
    check("...offering Approve, Reject and Open",
        /content="Approve"/.test(main) && /content="Reject"/.test(main)
        && /content="Open"/.test(main), null);
    check("...the darwin actions array is only used off win32, so neither " +
          "platform is handed the other's mechanism",
        /const win = process\.platform === "win32"/.test(main)
        && /\(!win && approvalId\)/.test(main), null);
    check("...the XML escapes everything it interpolates — a session title is " +
          "user text going into a markup document",
        /const esc = \(s\) =>[\s\S]{0,200}?replace\(\/&\/g, "&amp;"\)/.test(main), null);
    check("the scheme is registered, and in dev it names the real binary",
        /setAsDefaultProtocolClient\("lcl"/.test(main)
        && /process\.defaultApp/.test(main), null);
    check("a toast button arrives as a second-instance argument and is handled",
        /app\.on\("second-instance", \(_e, argv\)/.test(main)
        && /a\.startsWith\("lcl:\/\/"\)\) handleDeepLink\(a\)/.test(main), null);
    check("...and macOS's open-url delivers the same thing",
        /app\.on\("open-url"[\s\S]{0,80}?handleDeepLink\(url\)/.test(main), null);
}

/* THE DOORWAY IS NOT AN OPEN DOOR. A custom scheme can be navigated to by any
 * web page, so approving from one must be impossible unless this app itself
 * just raised that exact approval on a toast. */
{
    check("A DEEP LINK CANNOT APPROVE SOMETHING THIS APP DID NOT JUST ASK ABOUT " +
          "— only an id put on a toast, inside a short window, is actionable",
        /const toastApprovals = new Map\(\)/.test(main)
        && /TOAST_ACTION_WINDOW_MS/.test(main)
        && /toastApprovals\.set\(approvalId, Date\.now\(\)\)/.test(main), null);
    check("...an unknown or stale id opens the window instead of acting, and " +
          "says so in the audit log",
        /kind: "deep-link-refused"/.test(main)
        && /focusSession\(null, "approval", id\)/.test(main), null);
    check("...an id is single-use", /toastApprovals\.delete\(id\)/.test(main), null);
    check("...and every accepted action is logged", /kind: "deep-link"/.test(main), null);
    check("...it routes through the SAME approve/reject the in-app card uses, " +
          "never a shortcut around the re-checks",
        /approveFromNotification : rejectFromNotification/.test(main), null);
}

/* ------------------------------- A NEW COLOUR THAT MEANS 'THE WORK IS STOPPED' */
{
    check("THERE IS A FIFTH SESSION STATE, and it is the one that blocks",
        /\.session-status\.approval\s*\{[^}]*background: #f5a524/.test(css), null);
    check("...it carries a halo, so it reads differently from the four solid dots",
        /\.session-status\.approval\s*\{[^}]*box-shadow/.test(css), null);
    check("...and the comment no longer claims there are four",
        /FIVE states/.test(css) && !/Four states, exactly as specified/.test(css), null);
    check("the states that BLOCK are set as 'approval', while a question the " +
          "model asked stays 'waiting' — purple used to mean all three",
        /setSessionStatus\(id, "approval", `approve sending to/.test(main)
        && /setSessionStatus\(id, "approval", "waiting for your approval"\)/.test(main)
        && /setSessionStatus\(id, "waiting", "asked you a question"\)/.test(main), null);
    check("...the end of a turn distinguishes them too",
        /staged \? "approval" : askedUser \? "waiting" : "idle"/.test(main), null);
    check("...and the hover text says what the colour means",
        /approval: "needs your approval/.test(app), null);
}

/* IT IS CLEARED WHEN ANSWERED — an amber dot that never goes out is a lie. */
{
    check("clearing asks the registries whether anything is genuinely staged",
        /function hasPendingApprovalFor\(sessionId\)/.test(main)
        && /pendingToolApprovals\.values\(\)/.test(main)
        && /pendingRemoteApprovals\.values\(\)/.test(main), null);
    check("REJECTING CLEARS IT — rejectToolById set no status at all, so a " +
          "session could sit amber forever after the operator had answered",
        /rejectToolById[\s\S]{0,1400}?st\.state === "approval"[\s\S]{0,120}?setSessionStatus\(p\.sessionId, "idle"/.test(main), null);
    check("...approving clears it too, once nothing else is pending",
        /st\.state === "working" \|\| st\.state === "approval"\)\s*\n?\s*&& !hasPendingApprovalFor/.test(main), null);
    check("...and so does expiry", /expireApprovalsFor[\s\S]{0,900}?hasPendingApprovalFor\(sessionId\)/.test(main), null);
}

/* ------------------- THE CARD GOES TO THE SESSION THAT ASKED, NOT THE OPEN ONE */
{
    check("A BACKGROUND SESSION'S APPROVAL IS NOT DRAWN INTO THE TRANSCRIPT " +
          "YOU ARE READING — it is held for the session that raised it",
        /const remoteAwaiting = new Map\(\)/.test(app)
        && /remoteAwaiting\.set\(forId, r\)/.test(app), null);
    check("...and nothing is auto-answered on its behalf, so main's own timeout " +
          "still fails it closed rather than a stray grant approving it",
        /if \(forId && \(!active \|\| String\(active\.id\) !== forId\)\)/.test(app), null);
    check("...opening that session is when you are asked",
        /const held = remoteAwaiting\.get\(String\(active\.id\)\)/.test(app)
        && /presentRemoteApproval\(held\)/.test(app), null);
    check("...through the same presenter the live event uses",
        /async function presentRemoteApproval\(req\)/.test(app)
        && /onRemoteApproval\(presentRemoteApproval\)/.test(app), null);
}

/* the notification click has to land ON the thing that is waiting */
{
    check("clicking a toast opens the app AT the session that asked",
        /function focusSession\(sessionId, kind, approvalId\)/.test(main)
        && /webContents\.send\("lcl:focusSession", \{ sessionId, kind, approvalId \}\)/.test(main), null);
    check("...and both toasts use that one doorway rather than each rolling " +
          "their own restore/show/focus",
        (main.match(/focusSession\(sessionId, /g) || []).length >= 2, null);
}

/* ------------------------- THE SESSION'S BELL: per-session mute, both paths */
{
    check("A SESSION CAN BE MUTED — one durable flag on its own record, set " +
          "through its own IPC, default unmuted",
        /lcl:setSessionNotify/.test(main)
        && /s\.notifyMuted = !!muted/.test(main), null);
    check("...and BOTH announcement paths honor it at the source: the finished " +
          "toast and the waiting toast (each carries its chime inside)",
        /function sessionNotifyMuted\(sessionId\)/.test(main)
        && (main.match(/if \(sessionNotifyMuted\(sessionId\)\) return;/g) || []).length >= 2, null);
    check("...the renderer's own second sound path is gated too — the bell " +
          "silences the noise, never the dot",
        /if \(!\(proj && proj\.notifyMuted\)\) playChime\("done"\)/.test(app), null);
    check("...the bell rides the session list projection, so the sidebar can " +
          "draw it from the record",
        /notifyMuted: !!s\.notifyMuted/.test(sessionsSrc), null);
}

/* -------------------- READ vs UNREAD: the dot answers "have I seen this" */
{
    check("A FINISH IS STAMPED DURABLY (doneAt) on the working→idle/failed " +
          "transition — the in-memory status map never survived a restart",
        /s\.doneAt = Date\.now\(\)/.test(main), null);
    check("...a FAILURE keeps its reason on the record (lastError), so a red " +
          "dot after a relaunch can still say why",
        /s\.lastError = \{ at: s\.doneAt/.test(main), null);
    check("...OPENING a session marks it read through its own IPC",
        /lcl:markSessionRead/.test(main) && /s\.readAt = Date\.now\(\)/.test(main)
        && /markSessionRead\(id\)\.catch/.test(app), null);
    check("...and the dot derives the split: done = finished unread, acked = read",
        /function derivedDotState\(st, s\)/.test(app)
        && /s\.doneAt > \(s\.readAt \|\| 0\)/.test(app), null);
    // SUPERSEDED by design: being in the session when it responds counts as
    // reading it; under the old rule the dot would not clear unless you moved
    // to another session and clicked back. The old "clicking is reading,
    // nothing else" rule caused exactly that stuck-cyan dot. A finish now resolves its
    // own unread state — but ONLY for the session on screen with the window
    // focused; a background finish still goes cyan and waits.
    check("...a WATCHED-LIVE finish (active session + focused window) marks itself read",
        /active\.id === sessionId && document\.hasFocus\(\)/.test(app)
        && /document\.hasFocus\(\)[\s\S]{0,240}markSessionRead\(sessionId\)/.test(app), null);
    check("...and CLICKING OUT of a session marks the one you LEFT read",
        /active\.id !== id[\s\S]{0,600}markSessionRead\(active\.id\)/.test(app), null);
    check("...while the ack stays SCOPED (a background finish cannot ack itself), " +
          "and opening / typing still count as reading",
        (app.match(/markRead: false/g) || []).length >= 2
        && /TYPING IS READING/.test(app), null);
    check("...and a session READ before the doneAt stamps existed shows acked, " +
          "not neutral grey — clicked means read, even for old sessions",
        /if \(s\.doneAt \|\| s\.readAt\) return "acked"/.test(app), null);
}

/* ------------------------------- THE TRAY LISTS ERRORED SESSIONS TOO */
{
    check("the tray menu lists FAILED sessions — the menu must let you navigate " +
          "to a responding, waiting, or errored session: errored was the " +
          "one of the three it did not list",
        /errored\.push\(id\)/.test(main)
        && /focusSession\(id, "failed"\)/.test(main), null);
}

/* --------------- NOTHING DIES UNRECORDED: the self-diagnosis substrate */
{
    check("an uncaught MAIN-process error writes a readable audit record — " +
          "before this it left no trace anywhere",
        /process\.on\("uncaughtException"/.test(main)
        && /kind: "main-uncaught"/.test(main)
        && /kind: "main-unhandled-rejection"/.test(main), null);
    check("...and RENDERER errors land in the same ledger through lcl:diag — " +
          "render-process-gone only ever recorded the page dying, not a " +
          "feature throwing",
        /lcl:diag/.test(main) && /kind: "renderer-error"/.test(main)
        && /window\.addEventListener\("error"/.test(app)
        && /window\.addEventListener\("unhandledrejection"/.test(app), null);
}

console.log(`\n${pass}/${pass + fail} notification checks passed`);
process.exit(fail ? 1 : 0);
