// =============================================================
// .lcl renderer
// =============================================================
const $ = (id) => document.getElementById(id);

const bodyEl = $("body");
const titleEl = $("session-title");
const subtitleEl = $("chat-subtitle");
const chat = $("chat");
const chatScroll = $("chat-scroll");
const composer = $("composer-input");
const sendBtn = $("send");
const linkBtn = $("link-repo");
const jumpBtn = $("jump-latest");
const sessionListEl = $("session-list");
const searchEl = $("session-search");
const newSessionBtn = $("new-session");
const statusDot = $("status-dot");
const statusText = $("status-text");
const sessionCountEl = $("session-count");
const composerWorkspaceEl = $("composer-workspace");
$("session-perms-btn").addEventListener("click", () => openSessionPerms());
const workspaceEl = $("workspace");
const landingEl = $("landing");

// -------------------------------------------------------------
// STATE
// -------------------------------------------------------------
let sessions = [];
let active = null;
// Sessions run turns INDEPENDENTLY. pendingSessions holds every session with
// a turn in flight; `pending` (kept as a getter for all existing call sites)
// means "THIS session is busy" — which is what the composer and send button
// actually care about. Switching to another session is always allowed.
const pendingSessions = new Set();
// The in-flight QUESTION per session. A turn's user message is only written to
// the session file when the turn ends, so this is the only record of it while
// the turn runs — and switching sessions re-renders from that file.
const pendingQuestions = new Map();
// Which in-flight turns are REMOTE. A remote turn occupies no local engine, so
// it must not lock the model picker the way a local turn has to.
const remotePending = new Set();
const anyPending = () => pendingSessions.size > 0;
Object.defineProperty(window, "pending", {
    get() { return !!(active && pendingSessions.has(active.id)); }
});
let ready = false;
let filter = "";
let appInfo = { name: ".lcl", version: "" };
const landingDismissed = new Set();

// =============================================================
// BRANDED MODAL  (replaces unbranded OS dialogs)
// =============================================================
let modalResolve = null;

/**
 * Modals queue rather than clobber. Two concurrent modal() calls used to share
 * one modalResolve slot — the second overwrote the first, whose awaiter then
 * hung forever (and switchModel awaits its failure modal mid-recovery, so a
 * badly-timed memory warning could deadlock the whole switch path).
 */
let modalChain = Promise.resolve();
function modal(opts) {
    const run = () => showModal(opts);
    const p = modalChain.then(run, run);
    modalChain = p.then(() => {}, () => {});
    return p;
}

/**
 * The selection-API route, kept as a named function so the async path can
 * actually REACH it. It used to be the tail of copyText, unreachable whenever
 * navigator.clipboard existed.
 */
function copyTextFallback(s) {
    try {
        const ta = document.createElement("textarea");
        ta.value = s;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok !== false;
    } catch { return false; }
}

/**
 * PUT TEXT ON THE CLIPBOARD, from a file:// renderer. Resolves TRUE only when
 * the text is actually on the clipboard.
 *
 * navigator.clipboard is not available in every Electron context a file://
 * page can end up in, so the textarea route is the fallback rather than the
 * assumption. Either way the caller does not have to care.
 *
 * It used to return `true` on the line AFTER navigator.clipboard.writeText(),
 * without awaiting it. A synchronous try/catch cannot see a promise reject, so
 * the fallback below was dead code whenever the async API was present but
 * failing — and the async API rejects for an everyday reason: the document is
 * not focused. Click DevTools, then a copy button, and nothing is copied while
 * the button says "Copied". copyToClipboard() in this same file already had
 * this right; this is now the same shape, as a promise the caller can paint on.
 */
function copyText(text) {
    const s = String(text || "");
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return Promise.resolve(navigator.clipboard.writeText(s))
                .then(() => true, () => copyTextFallback(s));
        }
    } catch { /* the API is not usable here at all: fall through */ }
    return Promise.resolve(copyTextFallback(s));
}

function showModal({ title = "Confirm", message = "", detail = "", path = null,
                 scope = false, confirmLabel = "OK", cancelLabel = "Cancel",
                 danger = false, confirmOnly = false, node = null, size = null } = {}) {
    // "max" fills the app window (minus a margin) — for dashboards, which are
    // unreadable at dialog size. Toggled per call, so a confirm box that
    // follows a dashboard is not accidentally wall-sized.
    $("modal").classList.toggle("max", size === "max");
    $("modal").classList.toggle("wide", size === "wide");
    $("modal").classList.toggle("xwide", size === "xwide");
    $("modal-title").innerText = title;
    $("modal-message").innerText = message;
    $("modal-message").classList.toggle("hidden", !message);
    // a settings panel builds real DOM instead of being flattened into a string
    const nodeEl = $("modal-node");
    nodeEl.innerHTML = "";
    if (node) nodeEl.appendChild(node);
    nodeEl.classList.toggle("hidden", !node);
    $("modal-detail").innerText = detail || "";
    $("modal-detail").classList.toggle("hidden", !detail);

    const pathEl = $("modal-path");
    pathEl.innerText = path || "";
    pathEl.classList.toggle("hidden", !path);

    $("modal-scope").classList.toggle("hidden", !scope);

    const confirmBtn = $("modal-confirm");
    confirmBtn.innerText = confirmLabel;
    confirmBtn.className = danger ? "ghost danger-text" : "primary";

    const cancelBtn = $("modal-cancel");
    cancelBtn.innerText = cancelLabel;
    cancelBtn.classList.toggle("hidden", confirmOnly);

    // the copy control takes whatever this panel is showing right now
    const copyBtn = $("modal-copy");
    if (copyBtn) {
        copyBtn.classList.remove("copied");
        copyBtn.classList.remove("copy-failed");
        copyBtn.title = "Copy everything in this panel";
        copyBtn.onclick = () => {
            // EVERY BODY REGION THIS DIALOG RENDERS, IN DOM ORDER.
            //
            // modal-scope was missing from this list — and it is the ONLY
            // element in the dialog that states what is being granted. Someone
            // copying a workspace-access prompt to keep a record of the grant
            // got the title, the message and the path, and no scope: the record
            // of the grant was exactly the part that did not copy. The button
            // says "Copy everything in this panel", so it copies everything.
            const parts = [$("modal-title").innerText];
            for (const id of ["modal-message", "modal-node", "modal-detail",
                              "modal-path", "modal-scope"]) {
                const el = $(id);
                if (el && !el.classList.contains("hidden")) {
                    const t = (el.innerText || "").trim();
                    if (t) parts.push(t);
                }
            }
            // and it says "Copied" only when the text is ACTUALLY on the
            // clipboard — copyText resolves the real outcome now
            Promise.resolve(copyText(parts.filter(Boolean).join("\n\n")))
                .then(ok => {
                    copyBtn.classList.toggle("copied", !!ok);
                    copyBtn.classList.toggle("copy-failed", !ok);
                    copyBtn.title = ok
                        ? "Copied"
                        : "Copy failed — this window has to be focused to reach the clipboard";
                    setTimeout(() => {
                        copyBtn.classList.remove("copied");
                        copyBtn.classList.remove("copy-failed");
                        copyBtn.title = "Copy everything in this panel";
                    }, ok ? 1200 : 2600);
                });
        };
    }

    $("modal-scrim").classList.remove("hidden");
    confirmBtn.focus();

    return new Promise(resolve => { modalResolve = resolve; });
}

// =============================================================
// LOADING FEEDBACK — every wait gets a moving part
// =============================================================
/**
 * "we have some things that take like 15 seconds to open or more. so there
 *  needs to be not only speed, but animations."
 *
 * A static "probing…" is indistinguishable from a hang. One spinner, used by
 * every panel that waits on something slower than a settings read.
 */
/**
 * A dialog that cannot load must SAY SO.
 *
 * Fourteen call sites ended in `catch { return; }`, several of them the first
 * line of a dialog opener — so a failed IPC meant clicking a menu item did
 * nothing at all, with no error anywhere. Silence is the worst possible
 * report: it is indistinguishable from a dead button.
 */
function dialogFailed(what, e) {
    return modal({
        title: what + " could not open",
        message: "Something this dialog needs did not answer.",
        detail: String((e && e.message) || e || "no detail"),
        confirmLabel: "Close", confirmOnly: true
    });
}

/**
 * The press ripple needs to know where the pointer went down.
 *
 * PragOptics pins a radial gradient to --rx/--ry on the button itself; the
 * CSS is inert without someone writing those. One delegated listener covers
 * every button in the app, including ones built later, and costs two style
 * writes per press.
 */
document.addEventListener("pointerdown", (e) => {
    const b = e.target && e.target.closest && e.target.closest("button");
    if (!b || b.disabled) return;
    const r = b.getBoundingClientRect();
    if (!r.width || !r.height) return;
    b.style.setProperty("--rx", ((e.clientX - r.left) / r.width * 100).toFixed(1) + "%");
    b.style.setProperty("--ry", ((e.clientY - r.top) / r.height * 100).toFixed(1) + "%");
}, true);

function spinnerEl() {
    const s = document.createElement("span");
    s.className = "lcl-spin";
    return s;
}

/**
 * EVERYTHING THE APP SAYS IS COPYABLE.
 *
 * Standing rule: anything this software throws as an
 * error, warning, or notification should be clickable. Retyping an error
 * to ask about it is work the app created, and a message you cannot quote
 * is a message you cannot get help with.
 *
 * Done once, by delegation, rather than by adding a button to each site:
 * any element carrying a message class is selectable, shows a copy cursor,
 * and copies its own text on click — including ones built long after this
 * was written, and ones inside dialogs that did not exist yet.
 */
// THIS LIST AND THE CSS RULE MUST NOT DRIFT.
//
// "it is not copyable, so there is another failure in your ui development ...
// even after the instructions are to not omit that, and it is global across
// the ui." Correct: every container added since has to be added HERE and in
// styles.css, and I kept adding containers and forgetting. A check in
// tests/renderer-wiring.js now diffs the two lists, so an omission fails the
// build instead of being found by the person using it.
const COPYABLE_SEL = [
    ".msg-notice", ".pref-note", ".eng-meta", ".machine-note-inline",
    ".cloud-ep-status", ".nd-vpn-note", ".node-cand-meta", ".eng-empty",
    "#modal-message", "#modal-detail", "#modal-path", ".spend-detail-row",
    ".sec-note", ".cap-note", ".kn-note", ".err-detail", ".msg-error",
    ".wiz-window", ".wiz-fingerprint", ".wiz-check-row",
    ".node-ssh-why", ".eng-host", ".nd-model-row", ".nd-strip-item",
    ".node-state-now", ".node-state-why"
].join(",");

function flashCopied(el) {
    // the element says so about ITSELF — no toast, no layout shift
    if (el.classList.contains("just-copied")) return;
    el.classList.add("just-copied");
    setTimeout(() => el.classList.remove("just-copied"), 1100);
}

document.addEventListener("click", (e) => {
    const el = e.target.closest && e.target.closest(COPYABLE_SEL);
    if (!el) return;
    // never hijack a real control, a link, or an active text selection
    if (e.target.closest("button, a, input, select, textarea")) return;
    if (String(window.getSelection()).length > 0) return;
    const text = (el.innerText || "").trim();
    if (!text) return;
    copyToClipboard(text, null);
    flashCopied(el);
});

// =============================================================
// DROPDOWNS — every one of them, everywhere
// =============================================================
/**
 * The dropdowns are wrong throughout the app — the same problem everywhere.
 *
 * Correct, and no amount of CSS can fix it: the popup list of a native
 * <select> is drawn by Windows and cannot be styled — the one grey Win32
 * surface left in the app, and it opened from every preferences pane. The
 * design source (PragOptics dropdown.css) never uses a native select; it
 * draws its own panel.
 *
 * So every <select> is progressively enhanced. The real select STAYS in the
 * DOM as the value holder — every existing change-listener, save flash and
 * test keeps working untouched — but it is hidden, and a button plus an
 * app-drawn listbox stand in front of it:
 *
 *   - the toggle mirrors the select's classes live, so .cap-level tones,
 *     .saved / .save-failed flashes and .pref-select widths apply unchanged
 *   - the menu is a portal on <body> with position:fixed, so no modal edge,
 *     overflow:hidden or scroll container can ever clip it
 *   - full keyboard: Down/Up/Home/End move, Enter/Space choose, Escape
 *     closes, typing jumps to a match; roles are combobox/listbox/option
 *   - optgroups render as section labels with a rule, like the design
 *     source's .menu-section
 *
 * Enhancement is automatic for any select that ever enters the DOM — the
 * same no-future-instance-can-be-missed reasoning as the old base CSS rule,
 * moved up a level.
 */
let ddOpen = null;          // { sel, toggle, menu } while a menu is open

function ddCloseOpen(refocus) {
    if (!ddOpen) return;
    const { toggle, menu } = ddOpen;
    ddOpen = null;
    menu.remove();
    toggle.setAttribute("aria-expanded", "false");
    if (refocus) toggle.focus();
}

function enhanceSelect(sel) {
    if (sel.dataset.dd === "1" || sel.multiple) return;
    sel.dataset.dd = "1";

    const wrap = document.createElement("span");
    wrap.className = "dd";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.setAttribute("role", "combobox");
    toggle.setAttribute("aria-haspopup", "listbox");
    toggle.setAttribute("aria-expanded", "false");

    const label = document.createElement("span");
    label.className = "dd-label";
    toggle.appendChild(label);

    const syncFromSelect = () => {
        // the select's classes ARE the toggle's classes, live — tones,
        // saved-flash, widths all ride along
        toggle.className = "dd-toggle " + sel.className;
        toggle.disabled = sel.disabled;
        const o = sel.selectedOptions && sel.selectedOptions[0];
        label.innerText = o ? o.innerText : "";
    };
    syncFromSelect();

    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    wrap.appendChild(toggle);

    sel.addEventListener("change", syncFromSelect);
    new MutationObserver(syncFromSelect).observe(sel, {
        attributes: true, attributeFilter: ["class", "disabled"],
        childList: true, subtree: true
    });

    const choose = (value) => {
        if (sel.value !== value) {
            sel.value = value;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
        syncFromSelect();
        ddCloseOpen(true);
    };

    const openMenu = () => {
        if (ddOpen && ddOpen.sel === sel) { ddCloseOpen(true); return; }
        ddCloseOpen(false);

        const menu = document.createElement("div");
        menu.className = "dd-menu";
        menu.setAttribute("role", "listbox");

        // options are read fresh on every open, so a select whose options
        // were rebuilt since is always rendered truthfully
        const addOption = (o) => {
            const it = document.createElement("button");
            it.type = "button";
            it.className = "dd-item" + (o.selected ? " selected" : "");
            it.setAttribute("role", "option");
            it.setAttribute("aria-selected", o.selected ? "true" : "false");
            it.disabled = o.disabled;
            it.innerText = o.innerText;
            it.dataset.value = o.value;
            it.addEventListener("click", () => choose(o.value));
            menu.appendChild(it);
        };
        for (const child of sel.children) {
            if (child.tagName === "OPTGROUP") {
                const s = document.createElement("div");
                s.className = "dd-section";
                s.innerText = child.label;
                menu.appendChild(s);
                for (const o of child.children) addOption(o);
            } else if (child.tagName === "OPTION") {
                addOption(child);
            }
        }

        // fixed-position portal: measured from the toggle, clipped by nothing
        const r = toggle.getBoundingClientRect();
        menu.style.minWidth = Math.ceil(r.width) + "px";
        menu.style.left = Math.round(r.left) + "px";
        document.body.appendChild(menu);
        const mh = menu.offsetHeight;
        const below = window.innerHeight - r.bottom;
        menu.style.top = Math.round(
            below >= mh + 8 || below >= r.top ? r.bottom + 4
                                              : Math.max(8, r.top - mh - 4)) + "px";

        toggle.setAttribute("aria-expanded", "true");
        ddOpen = { sel, toggle, menu };

        const items = () => [...menu.querySelectorAll(".dd-item:not(:disabled)")];
        const current = menu.querySelector(".dd-item.selected:not(:disabled)") || items()[0];
        if (current) current.focus();

        let typed = "", typedAt = 0;
        menu.addEventListener("keydown", (e) => {
            const list = items();
            const i = list.indexOf(document.activeElement);
            const go = (j) => { const t = list[Math.max(0, Math.min(list.length - 1, j))];
                                if (t) t.focus(); };
            if (e.key === "ArrowDown") { e.preventDefault(); go(i + 1); }
            else if (e.key === "ArrowUp") { e.preventDefault(); go(i - 1); }
            else if (e.key === "Home") { e.preventDefault(); go(0); }
            else if (e.key === "End") { e.preventDefault(); go(list.length - 1); }
            else if (e.key === "Escape") { e.preventDefault(); ddCloseOpen(true); }
            else if (e.key === "Tab") { ddCloseOpen(false); }
            else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
                const now = Date.now();
                typed = (now - typedAt < 600 ? typed : "") + e.key.toLowerCase();
                typedAt = now;
                const hit = list.find(x =>
                    x.innerText.toLowerCase().startsWith(typed));
                if (hit) hit.focus();
            }
        });
    };

    toggle.addEventListener("click", openMenu);
    toggle.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault(); openMenu();
        }
    });
}

// closed by anything that would leave it floating over the wrong pixels
document.addEventListener("pointerdown", (e) => {
    if (!ddOpen) return;
    if (e.target.closest(".dd-menu") || e.target === ddOpen.toggle
        || ddOpen.toggle.contains(e.target)) return;
    ddCloseOpen(false);
}, true);
window.addEventListener("resize", () => ddCloseOpen(false));
document.addEventListener("scroll", (e) => {
    if (ddOpen && !(e.target.closest && e.target.closest(".dd-menu"))) ddCloseOpen(false);
}, true);

new MutationObserver((muts) => {
    for (const m of muts) {
        for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.tagName === "SELECT") enhanceSelect(node);
            else if (node.querySelectorAll)
                node.querySelectorAll("select").forEach(enhanceSelect);
        }
    }
}).observe(document.documentElement, { childList: true, subtree: true });
document.querySelectorAll("select").forEach(enhanceSelect);

function loadingNote(text, extraClass = "pref-note") {
    const n = document.createElement("div");
    n.className = extraClass + " loading-note";
    n.appendChild(spinnerEl());
    n.appendChild(document.createTextNode(text));
    return n;
}

function closeModal(result) {
    $("modal-scrim").classList.add("hidden");
    // a rates popup is parented to <body>, not to the modal — closing the
    // modal it was opened from must take it with it, or it is left floating
    // over the main window
    document.querySelectorAll(".rate-pop").forEach(el => el.remove());
    if (modalResolve) {
        const r = modalResolve;
        modalResolve = null;
        r(result);
    }
}

// the header ✕ dismisses without confirming — same as Esc, same as the backdrop
$("modal-close").addEventListener("click", () => closeModal(false));
$("modal-confirm").addEventListener("click", () => closeModal(true));
$("modal-cancel").addEventListener("click", () => closeModal(false));
$("modal-scrim").addEventListener("click", (e) => {
    if (e.target === $("modal-scrim")) closeModal(false);
});

// =============================================================
// WINDOW CHROME
// =============================================================
$("win-min").addEventListener("click", () => window.lcl.windowAction("minimize"));
$("win-max").addEventListener("click", () => window.lcl.windowAction("toggleMaximize"));
$("win-close").addEventListener("click", () => window.lcl.windowAction("close"));

// =============================================================
// MENU BAR
// =============================================================
const menus = [...document.querySelectorAll(".menu")];
const closeMenus = () => menus.forEach(m => m.classList.remove("open"));

menus.forEach(menu => {
    const label = menu.querySelector(".menu-label");
    label.addEventListener("click", (e) => {
        e.stopPropagation();
        const wasOpen = menu.classList.contains("open");
        closeMenus();
        if (!wasOpen) { menu.classList.add("open"); syncMenuState(); }
    });
    label.addEventListener("mouseenter", () => {
        if (menus.some(m => m.classList.contains("open"))) {
            closeMenus();
            menu.classList.add("open");
            syncMenuState();
        }
    });
});

document.addEventListener("click", closeMenus);
document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (fileMenuEl) closeFileContextMenu();
    else if (!$("modal-scrim").classList.contains("hidden")) closeModal(false);
    else if (!$("security-scrim").classList.contains("hidden")) closeSecurity();
    else if (!$("knowledge-scrim").classList.contains("hidden")) closeKnowledge();
    else if (!$("context-scrim").classList.contains("hidden")) closeContextPanel();
    else if (!$("cap-scrim").classList.contains("hidden")) closeCapabilities();
    else if (machineOpen()) closeMachine();
    else closeMenus();
});

function syncMenuState() {
    const hasSession = !!active;
    const hasRepo = !!(active && active.repoPath);
    const set = (action, enabled) => {
        const b = document.querySelector(`.menu-panel button[data-action="${action}"]`);
        if (b) b.disabled = !enabled;
    };
    set("link-repo", hasSession && !pending);
    set("unlink-repo", hasRepo && !pending);
    // openLinkKnowledge returns silently with no active session, which from the
    // menu is indistinguishable from a dead item — the same defect Jump to
    // latest was reported for. Greyed instead.
    set("link-knowledge", hasSession && !pending);
    set("rename-session", hasSession && !pending);
    set("answer-like", hasSession);
    set("delete-session", hasSession && !pending);
    set("new-session", true);        // always available — sessions are independent

    // Jump to latest read as broken because clicking it while already at the
    // bottom does nothing visible. It is not broken; there was nowhere to go.
    // Greying it out when there is nothing below says that without a dialog.
    set("scroll-bottom", !atBottom(120));

    // live state on the toggles, so the menu says what it will do next rather
    // than making you click to find out
    const label = (action, text) => {
        const b = document.querySelector(`.menu-panel button[data-action="${action}"]`);
        const slot = b && b.querySelector(".menu-value");
        if (slot) slot.innerText = text;
    };
    label("toggle-motion", motion.pref);
    label("toggle-sidebar", bodyEl.classList.contains("no-sidebar") ? "hidden" : "shown");
    label("toggle-workspace", bodyEl.classList.contains("with-ws") ? "shown" : "hidden");
}

/**
 * Collapse or restore the sidebar.
 *
 * The class is mirrored onto <html> because #titlebar sits BEFORE #body in the
 * document and no CSS combinator reaches backwards. That is what lets the
 * title-bar status readout appear exactly when the sidebar copy is gone.
 */
function setSidebar(hidden) {
    bodyEl.classList.toggle("no-sidebar", hidden);
    document.documentElement.classList.toggle("no-sidebar", hidden);
    // The header toggle and the edge handle are ONE control in two places, and
    // they have to agree about which way it points. aria-expanded is the state
    // both the screen reader and the CSS read, so it is written here rather
    // than at each call site.
    const t = $("sidebar-toggle");
    if (t) {
        t.setAttribute("aria-expanded", hidden ? "false" : "true");
        t.title = hidden ? "Show the session list (Ctrl+B)" : "Hide the session list (Ctrl+B)";
        t.setAttribute("aria-label", t.title);
    }
    syncMenuState();
}

const menuActions = {
    "new-session": () => createSession(),
    "link-repo": () => linkRepo(),
    "unlink-repo": () => unlinkRepo(),
    "open-data": () => window.lcl.revealFolder(appInfo.dataDir),
    // Exit really exits. The titlebar's × hides to the tray so a turn in
    // flight survives; this is the one that ends the process.
    "quit": () => window.lcl.windowAction("quit"),
    "rename-session": () => renameActiveSession(),
    "delete-session": () => active && deleteSession(active.id),
    "focus-search": () => searchEl.focus(),
    "toggle-sidebar": () => setSidebar(!bodyEl.classList.contains("no-sidebar")),
    "toggle-workspace": () => toggleWorkspace(),
    "toggle-terminal": () => toggleTerminal(),
    "machine": () => openMachine(),
    "session-perms": () => openSessionPerms(),
    "security": () => openSecurity(),
    "connections": () => openConnections(),
    "spend": () => openSpend(),
    "export-training": () => openTrainingExport(),
    "escalation": () => openEscalation(),
    "knowledge": () => openKnowledge(),
    "code-shape": () => openCodeShape(),
    "patch-bay": () => openPatchBay(),
    // "capabilities" left the menus with the Permissions dropdown — the
    // capability map stays reachable from the command palette and the approval
    // card's pointer; the menu action is gone with its menu
    "default-model": () => openPreferredModel(),
    "profile": () => openProfile(),
    "learned": () => openLearned(),
    "import-training": () => openTrainingImport(),
    "ancient-knowledge": () => openAncientSettings(),
    "answer-like": () => openAnswerLike(),
    // SESSION SCOPE, and it had no menu item at all: the only way to link
    // knowledge to a conversation was a small button on the composer row.
    // It writes setSessionKnowledge(active.id, ids) and nothing else, so the
    // Session menu is where it belongs.
    "link-knowledge": () => openLinkKnowledge(),
    "models": () => openModels(),
    "toggle-motion": () => {
        motion.pref = ({ auto: "on", on: "off", off: "auto" })[motion.pref] || "auto";
        applyMotion();
        window.lcl.setMotionPref(motion.pref);
    },
    // animated, so it is visible that something happened — the instant jump was
    // indistinguishable from a dead button when the distance was short
    "scroll-bottom": () => {
        chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: "smooth" });
        updateJumpButton();
    },
    "about": () => {
        const c = appInfo.capabilities || {};
        const gb = appInfo.totalMemBytes
            ? (appInfo.totalMemBytes / 1e9).toFixed(1) + " GB RAM" : null;
        const can = [
            c.languageModels ? `${c.languageModels} language model${c.languageModels === 1 ? "" : "s"}` : null,
            c.vision ? "vision" : null,
            c.imageGen ? "image generation" : null,
            c.embedding ? "semantic search" : null,
            c.ocr ? "OCR" : null
        ].filter(Boolean).join(" · ");
        modal({
            title: "About .lcl",
            // "compute layer" is vocabulary this product invented — nobody
            // outside the project reads it and knows what they have.
            message: ".lcl — runs AI models on your own hardware",
            detail:
                `Version ${appInfo.version || "dev"}\n` +
                `Electron ${appInfo.electron || "?"} · Node ${appInfo.node || "?"}\n` +
                `${appInfo.cpus || "?"} cores${gb ? " · " + gb : ""}\n\n` +
                `${c.modelsInstalled || 0} of ${c.modelsKnown || 0} models installed` +
                `${c.flagship ? ` (flagship: ${c.flagship})` : ""}\n` +
                `${c.toolCount || 0} tools available\n` +
                (can ? `${can}\n` : "") +
                // TRUE IN EVERY CONFIGURATION. The old line said "No cloud
                // calls" in an app that ships Models & API, connects
                // third-party endpoints, and has an internet switch in its own
                // title bar. A promise the product contradicts on the next
                // screen is worse than no promise at all.
                "\nLocal by default: nothing leaves this machine until you turn on " +
                "internet access or pick a model that runs somewhere else.",
            confirmLabel: "Close",
            confirmOnly: true
        });
    }
};

/**
 * Actions that CYCLE a setting rather than going somewhere.
 *
 * Background motion has three states and lived in a menu that closed on every
 * click, so seeing all three meant reopening the menu twice: "its a click and
 * disappear. keep it there. you are closing the menu tree for no reason."
 * Correct. A menu item that changes a value in place has no reason to dismiss
 * the menu — the value it just changed is the feedback, and you can only read
 * it if the menu is still on screen.
 */
const KEEPS_MENU_OPEN = new Set([
    "toggle-motion", "toggle-sidebar", "toggle-workspace"
]);

document.querySelectorAll(".menu-panel button").forEach(btn => {
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        if (!KEEPS_MENU_OPEN.has(action)) closeMenus();
        const fn = menuActions[action];
        if (fn) fn();
        if (KEEPS_MENU_OPEN.has(action)) syncMenuState();   // repaint the value in place
    });
});

// =============================================================
// SHORTCUTS
// =============================================================
document.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "n") { e.preventDefault(); createSession(); }
    else if (ctrl && e.key.toLowerCase() === "o") { e.preventDefault(); linkRepo(); }
    else if (ctrl && e.key.toLowerCase() === "f") { e.preventDefault(); searchEl.focus(); }
    else if (ctrl && e.key.toLowerCase() === "b") { e.preventDefault(); setSidebar(!bodyEl.classList.contains("no-sidebar")); }
    else if (ctrl && e.key.toLowerCase() === "j") { e.preventDefault(); toggleWorkspace(); }
    else if (ctrl && e.key.toLowerCase() === "m") { e.preventDefault(); openMachine(); }
    // Ctrl+K opens the SESSION Permissions now — the global panel's menu is
    // gone; permissions are per conversation
    else if (ctrl && e.key.toLowerCase() === "k") { e.preventDefault(); openSessionPerms(); }
    else if (e.key === "F2") { e.preventDefault(); renameActiveSession(); }
});

// =============================================================
// SLASH COMMANDS — typable commands in the chat box
// Ported from opencode's unified CommandOption registry: one registration
// gives slash, keybind, and palette entry points. Each command maps to an
// existing function — /process_list runs the tool, /compact compacts, etc.
// =============================================================
const slashMenu = $("slash-menu");
let slashOpen = false, slashItems = [], slashSelected = 0;

const COMMANDS = [
    {
        slash: "help", title: "Help", description: "List available commands",
        run: () => {
            const lines = COMMANDS.filter(c => !c.hidden)
                .map(c => `/${c.slash} — ${c.description}`);
            addMessageRow("assistant",
                "Available commands:\n\n" + lines.join("\n"),
                active ? active.messages.length : 0,
                { model: "commands" });
            scrollToBottom(true);
        }
    },
    {
        slash: "model", title: "Model", description: "Choose which model answers",
        run: () => { const mp = $("model-pick"); if (mp) mp.click(); }
    },
    {
        slash: "compact", title: "Compact", description: "Summarize old messages to free context (optional: /compact focus on code changes)",
        run: (source, args) => compactConversation(args)
    },
    {
        slash: "process_list", title: "Process List", description: "Show running processes",
        run: () => runSlashTool("process_list", {})
    },
    {
        slash: "system_stats", title: "System Stats", description: "Show CPU, RAM, and engine status",
        run: () => runSlashTool("system_stats", {})
    },
    {
        slash: "clear", title: "Clear", description: "Start a new session",
        run: () => createSession()
    },
    {
        // The capabilities OVERVIEW — "what .lcl can do," reachable here and from
        // the approval-card pointer (ui-capability-panel.js keeps it reachable).
        // It is NOT the settings UI: permissions are set PER CONVERSATION in
        // Session › Permissions. Its dials write the SESSION's policy, never a
        // global one (that global write was the consolidation stray).
        slash: "capabilities", title: "Capabilities", description: "What .lcl can do",
        run: () => openCapabilities()
    },
    {
        slash: "machine", title: "Machine", description: "Machine resources and memory",
        run: () => openMachine()
    },
    {
        slash: "models", title: "Local Models", description: "Models on this machine",
        run: () => openModels()
    },
    {
        slash: "connections", title: "API's & Connections", description: "Link APIs, nodes and rented GPUs",
        run: () => openConnections()
    },
];

async function runSlashTool(toolName, args) {
    if (!active) return;
    addMessageRow("user", `/${toolName}`, active.messages.length);
    scrollToBottom(true);
    try {
        const res = await window.lcl.chat(active.id, `Run the ${toolName} tool now.`);
        if (res && res.new_messages) {
            for (const m of res.new_messages) {
                if (m.role === "assistant") addMessageRow("assistant", m.content, active.messages.length, m.meta);
            }
        }
        if (res && res.changes) {
            for (const c of res.changes) { const chip = changeChip(c); chat.appendChild(chip); }
        }
    } catch (err) {
        addError(String((err && err.message) || err));
    }
    scrollToBottom(true);
}

/**
 * COMPACT — ASKED OF THE MAIN PROCESS, WHICH OWNS THE SESSION FILE.
 *
 * This used to do the whole job here: it sent the summarisation request through
 * sendText, so "Please summarize this conversation so far…" plus the entire
 * transcript was recorded as a message the OPERATOR had typed, and then it
 * reassigned `active.messages` in this window. Nothing carries a message list
 * to the main process, and every turn reloads the session from disk — so the
 * full history went back to the model on the next message and the request was
 * never smaller. The transcript looked compacted; nothing was.
 *
 * The summariser now runs in its own context in the main process, edits the
 * session that the engine actually reads, and saves it. This asks, then shows
 * the result in the user's own numbers.
 */
async function compactConversation(instructions) {
    if (!active || !active.messages || active.messages.length < 4) {
        addNotice("Not enough messages to compact.");
        return;
    }
    const ses = active;
    addNotice("Compacting — summarizing the older part of this conversation…");
    let res;
    try {
        res = await window.lcl.compact(ses.id, instructions || "");
    } catch (err) {
        addNotice("Compacting failed: " + String((err && err.message) || err));
        return;
    }
    if (!res || res.error) {
        addNotice("Compacting failed: " + ((res && res.error) || "no answer"));
        return;
    }
    // the operator may have moved on while the summariser ran
    if (res.messages && active && active.id === ses.id) {
        active.messages = res.messages;
        renderMessages(active.messages);
        refreshContextRing();
    } else if (res.messages) {
        ses.messages = res.messages;
    }
    if (!res.ok) {
        // a prune with no summary is still a real reduction, and is reported as one
        addNotice(res.pruned
            ? `Pruned ${res.pruned} old tool result${res.pruned === 1 ? "" : "s"} — ${res.reason}.`
            : `Nothing was compacted — ${res.reason}.`);
        return;
    }
    // SAID IN TOKENS, NOT IN ADJECTIVES. "Compacted." told the operator nothing
    // about whether it had been worth doing.
    const saved = (res.before || 0) - (res.after || 0);
    const pct = res.before ? Math.round((saved / res.before) * 100) : 0;
    addNotice(
        `Compacted: ${res.replaced} message${res.replaced === 1 ? "" : "s"} replaced by a summary` +
        (res.pruned ? `, ${res.pruned} tool result${res.pruned === 1 ? "" : "s"} pruned` : "") +
        (saved > 0 ? ` — about ${saved.toLocaleString()} tokens freed (${pct}% smaller).` : "."));
}

function showSlashMenu(query) {
    slashItems = COMMANDS.filter(c => !c.hidden && c.slash.startsWith(query));
    if (!slashItems.length) { hideSlashMenu(); return; }
    slashSelected = 0;
    slashOpen = true;
    slashMenu.innerHTML = "";
    slashMenu.classList.remove("hidden");
    slashItems.forEach((cmd, i) => {
        const row = document.createElement("div");
        row.className = "slash-item" + (i === 0 ? " selected" : "");
        row.innerHTML = `<span class="slash-cmd">/${cmd.slash}</span><span class="slash-desc">${cmd.description}</span>`;
        row.addEventListener("click", () => { executeSlashCommand(i); });
        slashMenu.appendChild(row);
    });
    positionSlashMenu();
}

function positionSlashMenu() {
    const r = composer.getBoundingClientRect();
    slashMenu.style.position = "fixed";
    // anchor ABOVE the composer, aligned to its left edge, no gap
    // so it looks connected to the chat bar
    slashMenu.style.bottom = (window.innerHeight - r.top) + "px";
    slashMenu.style.left = r.left + "px";
    slashMenu.style.width = r.width + "px";
}

function hideSlashMenu() {
    slashOpen = false;
    slashMenu.classList.add("hidden");
    slashMenu.innerHTML = "";
}

function executeSlashCommand(index) {
    const cmd = slashItems[index];
    if (!cmd) return;
    const text = composer.value;
    // extract any args after the command (e.g. /compact focus on code → "focus on code")
    const parts = text.split(/\s+/);
    const args = parts.slice(1).join(" ");
    composer.value = "";
    autoGrow();
    hideSlashMenu();
    cmd.run("slash", args);
}

composer.addEventListener("input", () => {
    const v = composer.value;
    if (v === "/") {
        // show ALL commands when just / is typed
        showSlashMenu("");
    } else if (v.startsWith("/") && !v.includes("\n")) {
        // show filtered commands matching the first word
        const firstWord = v.split(/\s+/)[0];
        const query = firstWord.slice(1);
        if (query) showSlashMenu(query);
        else showSlashMenu("");
    } else {
        hideSlashMenu();
    }
});

composer.addEventListener("keydown", (e) => {
    if (!slashOpen) return;
    if (e.key === "ArrowDown") {
        e.preventDefault();
        slashSelected = Math.min(slashSelected + 1, slashItems.length - 1);
        updateSlashSelection();
    } else if (e.key === "ArrowUp") {
        e.preventDefault();
        slashSelected = Math.max(slashSelected - 1, 0);
        updateSlashSelection();
    } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        executeSlashCommand(slashSelected);
    } else if (e.key === "Escape") {
        e.preventDefault();
        hideSlashMenu();
    }
});

function updateSlashSelection() {
    const rows = slashMenu.querySelectorAll(".slash-item");
    rows.forEach((r, i) => r.classList.toggle("selected", i === slashSelected));
}

document.addEventListener("click", (e) => {
    if (slashOpen && !slashMenu.contains(e.target) && e.target !== composer) hideSlashMenu();
});
// keep the popover glued to the composer when the window resizes (which moves
// the composer's fixed-position anchor) — it was only positioned on show
window.addEventListener("resize", () => { if (slashOpen) positionSlashMenu(); });

// =============================================================
// CONTEXT DONUT — SVG ring showing context window usage
// Ported from opencode's session-context-metrics: total / limit * 100
// =============================================================
/* ======================================= WHAT THE NODE IS DOING, RIGHT NOW
 *
 * The reported symptom: after clicking run, there was no way to tell whether a
 * command had finished — its output seemed to vanish into the ether.
 *
 * The lines were going into the ether, and this is why. The progress listener
 * was registered INSIDE openModelLibrary, behind an `openModelLibrary._wired`
 * guard — so it belonged to one invocation of one panel, and measured in the
 * harness it was never registered at all: handlers 0, while the node sent
 * three lines. Every attempt to render a step readout wrote into a channel
 * nobody was listening on.
 *
 * One listener, at module scope, registered once at startup, before any panel
 * exists. A running install parks its handlers here; nothing else can lose
 * them.
 */
let stackRun = null;      // { onLine, onDone } while an install is running

/* REGISTERED ON FIRST USE, NOT AT LOAD.
 *
 * At module scope this ran before the bridge existed — `window.lcl` is not
 * there yet when the top of this file executes, so the registration was a
 * no-op inside its own try/catch and every line the node sent went nowhere.
 * That was the third and last hiding place for the same defect: measured,
 * handlers 0 while the node sent three lines, twice over.
 *
 * Called at the moment an install starts, when the bridge is certainly up.
 * Idempotent, so it registers exactly once however many installs are run. */
let stackListenerOn = false;
function ensureStackListener() {
    if (stackListenerOn) return true;
    try {
        if (!window.lcl || !window.lcl.onModelInstallProgress) return false;
        window.lcl.onModelInstallProgress((d) => {
            if (!d || !stackRun) return;
            if (d.phase === "line") stackRun.onLine(String(d.line || ""));
            else if (d.phase === "done") stackRun.onDone(d);
        });
        stackListenerOn = true;
        return true;
    } catch { return false; }
}

/* ================================================== THE PLAN WINDOW DONUT
 *
 * The 5-hour window ring is a dynamic element, shown only when the responding
 * model or provider actually has such a ceiling (GO does; Zen does not), so it
 * is visible only in the scenario where the session is using that model or
 * provider.
 *
 * It reads the same IPC the context panel does, so the two can
 * never disagree, and it hides itself for every session whose endpoint has no
 * such ceiling — Zen, DeepInfra, a node, the local engine.
 *
 * It shows the TIGHTEST of the three tiers, because that is the one that will
 * stop the operator working: $12/5h bites long before $60/month.
 */
const planRingWrap = $("plan-ring-wrap");
const planRingFill = $("plan-ring-fill");
const planRingPct = $("plan-ring-pct");

/**
 * THE FIVE-HOUR RING — a productivity window everywhere, a CEILING where one
 * actually exists.
 *
 * "context in all modes, and the 5 hour being a productivity context measure,
 *  just one that resets after 5 hours. in all modes except for Go, or any
 *  other api or provider that does this as an actual limiter, and in those
 *  modes it should be based on the actual 5 hour context window that you are
 *  given as part of the subscription."
 *
 * Two readings of the same five hours, and which one applies is a fact about
 * the provider, not a setting:
 *
 *   PLAN mode   — the endpoint meters a subscription window (GO: $12 per five
 *                 hours). The ring is a GAUGE: share of the ceiling spent, and
 *                 running out means the work stops.
 *   WORK mode   — everything else: the local engine, a node, Zen, DeepInfra, a
 *                 rented GPU. Nothing stops at five hours, so a percentage of
 *                 a ceiling would be a lie. It reports what has been DONE in
 *                 the current five hours instead, and the ring fills with time
 *                 elapsed in the window rather than with spend.
 *
 * Same ring, same place, and the tooltip always says which of the two it is.
 */
async function refreshPlanRing() {
    if (!planRingWrap) return;
    let u = null;
    try { u = await window.lcl.usageWindow(active ? active.id : null); }
    catch { u = null; }

    const circ = 94.25;
    const draw = (pct, stroke, label, title) => {
        const p = Math.max(0, Math.min(100, Math.round(pct)));
        planRingFill.setAttribute("stroke-dasharray", `${(p / 100) * circ} ${circ}`);
        planRingFill.setAttribute("stroke", stroke);
        planRingPct.innerText = label;
        planRingWrap.title = title;
        planRingWrap.classList.remove("hidden");
    };

    /* ---- PLAN MODE: a real ceiling, so a real gauge ---- */
    if (u && !u.planless && Array.isArray(u.tiers) && u.tiers.length) {
        // `tightest` is a KEY ("h5"), not a tier — reading it as the tier gave
        // a ring labelled undefined out of undefined
        const t = u.tiers.find(x => x.key === u.tightest)
            || u.tiers.slice().sort((a, b) => (b.pct || 0) - (a.pct || 0))[0];
        if (t) {
            const pct = Number(t.pct) || 0;
            const spend = Number(t.usd) > 0
                ? `$${Number(t.usd).toFixed(2)} of $${t.budgetUsd}`
                : (t.active
                    ? `open · ${(Number(t.inputTokens) + Number(t.outputTokens))
                        .toLocaleString()} tokens, no published price`
                    : `nothing spent yet of $${t.budgetUsd}`);
            draw(pct,
                pct >= 90 ? "#f0716c" : pct >= 70 ? "#e0a050" : "#8fd8ff",
                t.label || "5h",
                `${u.planName || "plan"} · ${t.label} SUBSCRIPTION WINDOW — ` +
                `${spend}` + (t.resetsWords ? ` · ${t.resetsWords}` : "") +
                ` — click for the window breakdown`);
            planRingWrap.dataset.mode = "plan";
            return;
        }
    }

    /* ---- WORK MODE: no ceiling anywhere, so no percentage of one ---- */
    const w = (u && u.work) || null;
    if (!w || !w.calls) {
        // nothing done in this window yet: draw it empty rather than vanish,
        // because "you have five hours and have used none of it" is a reading
        draw(0, "#5a5a62", "5h",
            "Five-hour work window — nothing yet. This mode has no subscription " +
            "ceiling, so this counts what you have DONE, not what is left.");
        planRingWrap.dataset.mode = "work";
        return;
    }
    // THE RING FILLS WITH TOKENS, NOT THE CLOCK. Filled by time it hit 100%
    // just for staying open five hours — it filled up too fast. Now it is the
    // share of a generous productivity budget actually spent: 1M input and 1M
    // output tokens, averaged (usageWindow.workWindowPct, computed in main).
    // Conservative on purpose, and only here — a provider with a real ceiling
    // keeps its own gauge above.
    const inTok = Number(w.inputTokens) || 0;
    const outTok = Number(w.outputTokens) || 0;
    const pct = Number(w.pct) || 0;
    const inPct = Math.round(Number(w.inPct) || 0);
    const outPct = Math.round(Number(w.outPct) || 0);
    draw(pct,
        pct >= 90 ? "#f0716c" : pct >= 70 ? "#e0a050" : "#8fe0a8",
        "5h",
        `Five-hour work window — ${inTok.toLocaleString()} in / ${outTok.toLocaleString()} out ` +
        `of 1M each (${inPct}% / ${outPct}%, avg ${Math.round(pct)}%)` +
        (Number(w.usd) > 0 ? ` · ${Number(w.usd).toFixed(2)}` : "") +
        (w.resetsWords ? ` · ${w.resetsWords}` : "") +
        ` — a productivity budget, not a ceiling; resets after 5h — click for the breakdown`);
    planRingWrap.dataset.mode = "work";
}

const contextRingWrap = $("context-ring-wrap");
const contextRingFill = $("context-ring-fill");
const contextRingPct = $("context-ring-pct");

/**
 * THE WINDOW THIS SESSION IS WORKING IN — whatever is answering it.
 *
 * The context ring should appear for ALL sessions, no matter the mode —
 * including on a local node — not only for one provider such as DeepInfra.
 *
 * Two separate reasons it vanished, and both were the same mistake in
 * different clothes: it needed a MESSAGE before it would draw anything, and it
 * needed the LIMIT to arrive on that message's metadata. A fresh session has
 * no message. A node turn and a local turn carry no `window` in their meta. So
 * the one mode whose provider happens to report both — an API — was the only
 * one that ever showed a ring.
 *
 * The window is a property of the MODEL, and the picker already knows every
 * model's window. So it is resolved from the selection, drawn at 0% before the
 * first turn, and hidden only when nothing anywhere knows the number.
 */
/* A LOCAL NODE PUBLISHES NO WINDOW, AND THAT IS NOT THE SAME AS HAVING NONE.
 *
 * A session on a local node shows no context ring at all.
 *
 * Both earlier sources are absent for a node: describeSelection does not set
 * contextLength, and a node row often carries no contextMax because nothing
 * published one. So the ring hid itself — for the mode the operator uses most.
 *
 * The window is a property of the MODEL, so the session's own selected row is
 * asked before the running one, and a serving that never said gets a stated
 * assumption rather than silence. A ring drawn against an assumed window is
 * worth more than no ring, PROVIDED it says so — the tooltip does.
 */
const ASSUMED_CONTEXT = 32768;

function contextLimitForSession() {
    if (sessionModelState && sessionModelState.contextLength) {
        return { limit: sessionModelState.contextLength, assumed: false };
    }
    // the row this SESSION picked, before the row that happens to be running
    const mine = modelsCache.find(m => sameModelRef(sessionModelState, m))
        || modelsCache.find(m => m.active);
    if (mine && mine.contextMax) return { limit: mine.contextMax, assumed: false };
    return { limit: ASSUMED_CONTEXT, assumed: true };
}

function refreshContextRing() {
    if (!active) { contextRingWrap.classList.add("hidden"); return; }
    // A SESSION WITH NOTHING IN IT STILL HAS A WINDOW. Drawing it empty is the
    // honest reading and it is the one the operator asked to keep: the ring is
    // how much room this conversation has, not a badge for having used some.
    if (!active.messages || !active.messages.length) {
        const only = contextLimitForSession().limit;
        if (!only) { contextRingWrap.classList.add("hidden"); return; }
        const circ0 = 94.25;
        contextRingFill.setAttribute("stroke-dasharray", `0 ${circ0}`);
        contextRingFill.setAttribute("stroke", "#e0c98f");
        contextRingPct.innerText = "0%";
        contextRingWrap.title = `0 / ${only.toLocaleString()} tokens — nothing sent yet`;
        contextRingWrap.classList.remove("hidden");
        return;
    }
    // find the last assistant message with token info
    let last = null;
    for (let i = active.messages.length - 1; i >= 0; i--) {
        const m = active.messages[i];
        if (m.role === "assistant" && m.meta && (m.meta.inTokens || m.meta.tokens)) {
            last = m;
            break;
        }
    }
    // THE RING MUST NOT VANISH ON A NODE JUST BECAUSE THE ENDPOINT IS QUIET.
    //
    // A streaming llama.cpp turn reports no usage, so no assistant message
    // carries tokens — and the ring, which needed one, hid the instant a node
    // session had messages. That read as the context ring being killed. The
    // window is known (contextLimitForSession); what is unknown is exactly how
    // full it is, and a rough estimate from the transcript is a far better
    // answer than nothing. ~4 chars per token is the standard approximation;
    // the tooltip says it is estimated so the number is never mistaken for a
    // measured one.
    let inTok, outTok, total, estimatedTokens = false;
    if (last && last.meta) {
        inTok = last.meta.inTokens || 0;
        outTok = last.meta.outTokens || 0;
        total = inTok + outTok;
    } else {
        // estimate the whole conversation the model would be re-sent: every
        // message body, plus the system prompt if the last turn measured it
        let chars = 0;
        for (const m of active.messages) {
            const c = typeof m.content === "string" ? m.content
                    : (m.content ? JSON.stringify(m.content) : "");
            chars += c.length;
        }
        const sysChars = (() => {
            for (let i = active.messages.length - 1; i >= 0; i--) {
                const mt = active.messages[i].meta;
                if (mt && mt.systemChars) return mt.systemChars;
            }
            return 0;
        })();
        total = Math.round((chars + sysChars) / 4);
        inTok = total; outTok = 0;
        estimatedTokens = true;
    }
    // context limit, resolved from whatever knows it. sessionModelState rarely
    // carries contextLength (describeSelection does not set it) and a local turn
    // has no meta.window — so without the third source below the ring never
    // appeared for a local model and usually not for a remote one either. The
    // picker already knows every model's window (contextMax), so the active
    // row is the reliable fallback.
    // the session's own selection first, then whatever the turn reported, then
    // the picker — a node and a local turn report no window at all, which is
    // why the ring only ever appeared for an API
    const lim = contextLimitForSession();
    const metaWindow = (last && last.meta && last.meta.window) || 0;
    // THE LIVE SELECTION'S WINDOW OUTRANKS THE ONE STAMPED ON THE LAST TURN.
    // The stamp describes the model that answered LAST; after a model or mode
    // switch the ring must describe the model that answers NEXT. The stamp is
    // still the best answer when the live chain only holds the flat assumption.
    let limit = (!lim.assumed && lim.limit) || metaWindow || lim.limit || 0;
    const limitAssumed = lim.assumed && !metaWindow;
    if (!limit) { contextRingWrap.classList.add("hidden"); return; }
    const pct = Math.min(100, Math.round((total / limit) * 100));
    // SVG ring: circumference = 2 * PI * 15 ≈ 94.25
    const circ = 94.25;
    contextRingFill.setAttribute("stroke-dasharray", `${(pct / 100) * circ} ${circ}`);
    contextRingPct.innerText = (estimatedTokens ? "~" : "") + pct + "%";
    // color: amber under 70%, orange under 90%, red above
    const stroke = pct >= 90 ? "#f0716c" : pct >= 70 ? "#e0a050" : "#e0c98f";
    contextRingFill.setAttribute("stroke", stroke);
    contextRingWrap.classList.remove("hidden");
    // the tooltip has to describe what the click DOES. It said "click to
    // compact" after the click had been changed to open the panel — a control
    // that promises one action and performs another is the truth-grade rule
    // broken at one remove.
    contextRingWrap.title = `${estimatedTokens ? "~" : ""}${total.toLocaleString()} / ` +
        `${limit.toLocaleString()} tokens (${estimatedTokens ? "~" : ""}${pct}% of context)` +
        (estimatedTokens ? " — estimated: this serving does not report token counts,"
                         + " so this is measured from the transcript at ~4 chars/token" : "") +
        (limitAssumed ? " — this serving publishes no window, so 32k is assumed" : "") +
        " — click for the context panel";
    // WHAT is filling it, not only how much. Denominator is the last request's
    // INPUT tokens — what was actually re-sent — never the cumulative total.
    try {
        renderContextBreakdown(contextBreakdown(
            active.messages, inTok, (last && last.meta && last.meta.systemChars) || 0));
    } catch { /* a readout must never break the view */ }

    // SAY IT BEFORE IT BREAKS, DO NOT REWRITE IT BEHIND THEIR BACK.
    //
    // opencode auto-compacts when the window is nearly full. .lcl warns and
    // offers the same action on a click instead: compaction permanently
    // rewrites the conversation, and a program that silently deletes the
    // middle of your work to save itself is the kind of helpfulness this app
    // exists not to be. The value opencode's version delivers — never
    // discovering the ceiling by hitting it — is kept; the silent part is not.
    // Once per session, so it is a warning rather than nagging.
    if (pct >= 85 && !overflowWarned.has(active.id)) {
        overflowWarned.add(active.id);
        addNotice(`This conversation is using ${pct}% of the context window. ` +
                  `The next long message may not fit.`, {
            label: "Compact it now",
            onClick: () => compactConversation()
        });
    }
    // dropped back down (a compaction, or a fresh session) — arm it again
    if (pct < 70) overflowWarned.delete(active.id);
}
// sessions already warned about a nearly-full window, so the notice appears
// once and not on every turn after it
const overflowWarned = new Set();

/**
 * WHAT IS ACTUALLY FILLING THE WINDOW.
 *
 * The ring says HOW FULL. This says WITH WHAT — the share of the last
 * request's input tokens taken by the system contract, the conversation, and
 * tool output. "Why did 'hello' cost 20,000 tokens?" has an answer and this
 * is it, without having to read the code to find out.
 *
 * The arithmetic is opencode's (session-context-breakdown.ts), and its one
 * good idea is the honesty rule: the measured buckets are estimates from
 * character counts, so they are always NORMALISED against the input count the
 * engine actually reported, and whatever the estimate cannot explain is shown
 * as a labelled "other" slice rather than hidden or silently absorbed. The bar
 * therefore always sums to 100% of a number something vouched for.
 *
 * Two deliberate differences from the original: .lcl's message model is a flat
 * {role, content, meta} rather than message+parts, so the part walk collapses
 * to a role walk over exactly the roles buildModelMessages puts on the wire;
 * and the denominator is the last request's INPUT tokens, never the cumulative
 * turn total — mixing those is the obvious mistake and it is not made here.
 */
const BREAKDOWN_KINDS = [
    { key: "system", label: "instructions", color: "#e0c98f" },
    { key: "user", label: "your messages", color: "#5fd0e0" },
    { key: "assistant", label: "replies", color: "#9adfae" },
    { key: "tool", label: "tool output", color: "#c9a0dc" },
    { key: "other", label: "other", color: "#55555e" }
];

function contextBreakdown(messages, inputTokens, systemChars) {
    if (!inputTokens || inputTokens <= 0) return null;
    const chars = { system: Math.max(0, systemChars || 0),
                    user: 0, assistant: 0, tool: 0 };
    for (const m of (messages || [])) {
        if (!m) continue;
        const n = String(m.content || "").length;
        if (m.role === "user") chars.user += n;
        else if (m.role === "assistant") chars.assistant += n;
        else if (m.role === "tool") chars.tool += n;
    }
    // ~4 characters per token is the same rough rule the rest of the app uses
    const est = {};
    let estTotal = 0;
    for (const k of ["system", "user", "assistant", "tool"]) {
        est[k] = Math.ceil(chars[k] / 4);
        estTotal += est[k];
    }
    const out = {};
    if (estTotal <= inputTokens) {
        for (const k of Object.keys(est)) out[k] = est[k];
        out.other = inputTokens - estTotal;
    } else {
        // the estimate over-counted: shrink every bucket proportionally and
        // let the rounding slack land in "other" rather than inventing tokens
        const scale = inputTokens / estTotal;
        let sum = 0;
        for (const k of Object.keys(est)) { out[k] = Math.floor(est[k] * scale); sum += out[k]; }
        out.other = Math.max(0, inputTokens - sum);
    }
    const segs = BREAKDOWN_KINDS
        .map(k => ({ ...k, tokens: out[k.key] || 0 }))
        .filter(s => s.tokens > 0)
        .map(s => ({ ...s,
            width: (s.tokens / inputTokens) * 100,
            percent: Math.round((s.tokens / inputTokens) * 1000) / 10 }));
    return { inputTokens, segments: segs };
}

/** Draw it under the ring's own tooltip surface, in .lcl's palette. */
function renderContextBreakdown(bd) {
    const host = $("context-breakdown");
    if (!host) return;
    host.innerHTML = "";
    if (!bd || !bd.segments.length) { host.classList.add("hidden"); return; }
    const bar = document.createElement("div");
    bar.className = "ctx-bd-bar";
    for (const s of bd.segments) {
        const seg = document.createElement("div");
        seg.className = "ctx-bd-seg";
        seg.style.width = s.width + "%";
        seg.style.background = s.color;
        seg.title = `${s.label} — ${s.tokens.toLocaleString()} tokens (${s.percent}%)`;
        bar.appendChild(seg);
    }
    host.appendChild(bar);
    const legend = document.createElement("div");
    legend.className = "ctx-bd-legend";
    for (const s of bd.segments) {
        const item = document.createElement("span");
        item.className = "ctx-bd-item";
        const sw = document.createElement("span");
        sw.className = "ctx-bd-swatch";
        sw.style.background = s.color;
        const txt = document.createElement("span");
        txt.innerText = `${s.label} ${s.percent}%`;
        item.append(sw, txt);
        legend.appendChild(item);
    }
    host.appendChild(legend);
    host.classList.remove("hidden");
}

/* ======================================================== THE CONTEXT PANEL
 *
 * opencode's context tab, in .lcl's own UI and .lcl's own numbers.
 *
 * Ported by SHAPE, not by code: the facts it shows (packages/app/src/components/
 * session/session-context-tab.tsx), the last-assistant-with-tokens rule for
 * which message the figures come from (session-context-metrics.ts), and the
 * scale-the-estimate-to-the-real-count honesty rule already in
 * contextBreakdown() above (session-context-breakdown.ts).
 *
 * Two deliberate departures.
 *
 * ONE — clicking the ring used to run compactConversation() IMMEDIATELY. A
 * single mis-click permanently rewrote the conversation, with no preview and
 * nothing to undo it. The ring opens this panel now, and compaction is a
 * button here with its consequence written next to it. opencode goes further
 * and compacts AUTOMATICALLY when the window fills; .lcl will not silently
 * delete the middle of someone's work to save itself.
 *
 * TWO — a number nobody reported is "—", never 0. Reasoning and cache tokens
 * are absent from most endpoints, and printing 0 for "did not say" is the same
 * class of lie as a full ring on a model that publishes no window.
 */
const CTX_SCRIM = $("context-scrim");

function ctxLastMetered() {
    if (!active || !active.messages) return null;
    for (let i = active.messages.length - 1; i >= 0; i--) {
        const m = active.messages[i];
        if (m.role === "assistant" && m.meta && (m.meta.inTokens || m.meta.tokens)) return m;
    }
    return null;
}
function ctxLimit(last) {
    if (sessionModelState && sessionModelState.contextLength) return sessionModelState.contextLength;
    if (last && last.meta && last.meta.window) return last.meta.window;
    const act = modelsCache.find(m => m.active);
    return (act && act.contextMax) || 0;
}
const ctxNum = (v) => (typeof v === "number" && Number.isFinite(v)) ? v.toLocaleString() : "—";

function renderContextPanel() {
    const last = ctxLastMetered();
    const meta = (last && last.meta) || {};
    const inTok = meta.inTokens || 0;
    const outTok = meta.outTokens || 0;
    const total = inTok + outTok;
    const limit = ctxLimit(last);
    const pct = limit ? Math.min(100, Math.round((total / limit) * 100)) : null;

    const pctEl = $("ctx-usage-pct");
    pctEl.innerText = pct === null ? "—" : pct + "%";
    pctEl.classList.toggle("warn", pct !== null && pct >= 70 && pct < 90);
    pctEl.classList.toggle("hot", pct !== null && pct >= 90);
    $("ctx-usage-of").innerText = limit
        ? `of ${limit.toLocaleString()} tokens` : "of the window";
    $("ctx-usage-tokens").innerText = total ? `${total.toLocaleString()} tokens in play` : "no turn measured yet";

    // WHAT THIS CONVERSATION HAS COST, added up from what was actually billed.
    // Local and node turns carry no usd and contribute nothing, which is the
    // honest answer rather than an estimate.
    let usd = 0, billed = 0;
    for (const m of (active.messages || [])) {
        if (m && m.meta && typeof m.meta.usd === "number") { usd += m.meta.usd; billed++; }
    }
    // FOUR DECIMALS UNDER A DOLLAR. Two decimals rounded $0.0123 to "$0.01" —
    // an 19% error, on exactly the magnitudes a local-first app spends most of
    // its time in. Cents only start being the right unit once there are cents.
    $("ctx-usage-cost").innerText = billed
        ? `$${usd.toFixed(usd < 1 ? 4 : 2)} billed` : "nothing billed";

    // the bar
    const bd = (() => {
        try { return contextBreakdown(active.messages, inTok, meta.systemChars || 0); }
        catch { return null; }
    })();
    const bar = $("ctx-bar"), legend = $("ctx-legend");
    bar.innerHTML = ""; legend.innerHTML = "";
    if (bd && bd.segments.length) {
        for (const s of bd.segments) {
            const seg = document.createElement("span");
            seg.style.width = s.width + "%";
            seg.style.background = s.color;
            seg.title = `${s.label} — ${s.tokens.toLocaleString()} tokens (${s.percent}%)`;
            bar.appendChild(seg);
            const item = document.createElement("span");
            item.className = "ctx-leg";
            const dot = document.createElement("span");
            dot.className = "ctx-dot"; dot.style.background = s.color;
            const txt = document.createElement("span");
            txt.innerText = s.label + " ";
            const n = document.createElement("span");
            n.className = "ctx-leg-n";
            n.innerText = `${s.percent}% · ${s.tokens.toLocaleString()}`;
            item.append(dot, txt, n);
            legend.appendChild(item);
        }
        $("ctx-bar-wrap").classList.remove("hidden");
    } else {
        $("ctx-bar-wrap").classList.add("hidden");
    }

    const counts = (active.messages || []).reduce((a, m) => {
        if (!m) return a;
        if (m.role === "user") a.user++;
        else if (m.role === "assistant") a.assistant++;
        else if (m.role === "tool") a.tool++;
        if (m.meta && m.meta.model === "ancient-knowledge") a.audit++;
        return a;
    }, { user: 0, assistant: 0, tool: 0, audit: 0 });

    const stats = [
        ["Session", active.title || "(untitled)"],
        ["Model", meta.model || (sessionModelState && sessionModelState.label) || "—"],
        ["Where", meta.endpoint || (sessionModelState && sessionModelState.where) || "this machine"],
        ["Context window", limit ? limit.toLocaleString() : "—"],
        ["Last request in", ctxNum(meta.inTokens)],
        ["Last reply out", ctxNum(meta.outTokens)],
        ["Reasoning tokens", ctxNum(meta.reasoningTokens)],
        ["Cached tokens", ctxNum(meta.cachedTokens)],
        ["Messages", String((active.messages || []).length)],
        ["Yours", String(counts.user)],
        ["The model's", String(counts.assistant)],
        ["Tool results", String(counts.tool)],
        // Ancient Knowledge is its OWN context and is deliberately kept out of
        // the model's window — it is counted here because it is still part of
        // the total the operator is paying for and reading.
        ["Ancient Knowledge", counts.audit ? `${counts.audit} audit${counts.audit === 1 ? "" : "s"}` : "—"],
        ["Billed so far", billed ? `$${usd.toFixed(4)}` : "—"]
    ];
    const host = $("ctx-stats");
    host.innerHTML = "";
    for (const [k, v] of stats) {
        const cell = document.createElement("div");
        cell.className = "ctx-stat";
        const kk = document.createElement("div"); kk.className = "ctx-k"; kk.innerText = k;
        const vv = document.createElement("div"); vv.className = "ctx-v";
        vv.innerText = String(v); vv.title = String(v);
        cell.append(kk, vv);
        host.appendChild(cell);
    }

    const btn = $("ctx-compact");
    const enough = (active.messages || []).length >= 4;
    btn.disabled = !enough;
    btn.innerText = enough ? "Compact this conversation" : "Too short to compact";
}

/**
 * THE AUDIT TRAIL: what the next request actually carries.
 *
 * opencode's context tab is not just numbers — it shows the system prompt
 * itself and an accordion of the raw messages, each a clickable title
 * (session-context-tab.tsx: the systemPrompt block and the RawMessage
 * Accordion). The first port of this panel stopped at the stats, but the goal
 * is a full audit trail in the context window, the way comparable tools expose
 * one.
 *
 * The data comes from lcl:contextSnapshot, which computes it with the SAME
 * functions the turn uses — so what this shows is what will be sent, not a
 * paraphrase of the transcript. Messages the window budget dropped are said
 * out loud rather than silently absent.
 */
async function renderContextAudit(forSession) {
    const list = $("ctx-audit-list");
    const note = $("ctx-audit-note");
    list.innerHTML = "";
    note.innerText = "";
    // each open starts with the instructions FOLDED — the panel leads with the
    // numbers, and a 6,000-character contract left expanded from last time
    // would bury them
    $("ctx-system").open = false;
    let snap = null;
    try { snap = await window.lcl.contextSnapshot(forSession.id); } catch { snap = null; }
    if (!active || active.id !== forSession.id) return;   // moved on meanwhile
    if (!snap || snap.error) {
        note.innerText = "The window contents could not be read" +
            (snap && snap.error ? ` — ${snap.error}` : "") + ".";
        return;
    }

    // the system prompt, verbatim, with its real size
    $("ctx-system-body").innerText = snap.system || "";
    $("ctx-system-size").innerText = snap.system
        ? `· ${snap.system.length.toLocaleString()} chars` : "";

    // a snapshot with no messages array is a valid answer about an empty
    // session, not a licence to throw — this rejection fired on every
    // background repaint and nothing ever surfaced it
    const inWindow = (snap.messages || []).filter(m => m.role !== "system");
    const left = Math.max(0, (snap.totalMessages || 0) - inWindow.length);
    note.innerText =
        `${inWindow.length} message${inWindow.length === 1 ? "" : "s"} go to the model` +
        (snap.window ? ` in a ${snap.window.toLocaleString()}-token window` : "") +
        (left > 0
            ? ` — ${left} older message${left === 1 ? "" : "s"} stay out of the request ` +
              `(the transcript keeps them)` : "") + ".";

    for (const m of inWindow) {
        const row = document.createElement("details");
        row.className = "ctx-msg";
        const sum = document.createElement("summary");
        const role = document.createElement("span");
        role.className = "ctx-msg-role " + m.role;
        role.innerText = m.role === "user" ? "you" : m.role;
        const head = document.createElement("span");
        head.className = "ctx-msg-head";
        head.innerText = String(m.content).split("\n")[0].slice(0, 110);
        const size = document.createElement("span");
        size.className = "ctx-msg-size";
        size.innerText = fmtBytes(String(m.content).length);
        sum.append(role, head, size);
        row.appendChild(sum);
        const pre = document.createElement("pre");
        pre.innerText = m.content;
        row.appendChild(pre);
        list.appendChild(row);
    }
}

/**
 * THE GO STRIP — the subscription's five-hour window, in the panel where the
 * operator already reads cost. Three facts: spent this window, when it
 * resets, and — only once they have entered their plan's ceiling — how close.
 * A warning lands once per window at 85%, not a nag on every open.
 */
let goWarnedWindow = 0;
async function renderGoStrip() {
    let u = null;
    try { u = await window.lcl.usageWindow(active ? active.id : null); } catch { u = null; }
    // NO PLAN, NO STRIP. A per-token vendor is not metered in windows, and
    // showing GO's ceilings over a DeepInfra session was noise wearing a
    // gauge — "the GO stuff should only be visible when a GO model is
    // selected."
    if (!u || u.error || u.planless || !Array.isArray(u.tiers)) {
        $("ctx-plan").classList.add("hidden"); return;
    }
    $("ctx-plan").classList.remove("hidden");
    $("ctx-plan-name").innerText = u.planName || "GO";
    // the provider's own console is the authoritative view — GO publishes no
    // usage API, so the strip and the console are compared by eye
    $("ctx-plan-name").title = (u.endpointLabel ? u.endpointLabel + " · " : "")
        + "the plan's own console: " + (u.console || "opencode.ai/auth");

    // GO meters three ceilings AT ONCE — $12/5h, $30/wk, $60/mo — and the one
    // closest to its ceiling is the one the operator is living against
    const host = $("ctx-plan-tiers");
    host.innerHTML = "";
    let anyActive = false;
    for (const t of u.tiers) {
        const s = document.createElement("span");
        s.className = "ctx-tier" + (t.key === u.tightest ? " tight" : "")
            + (t.active && t.pct !== null && t.pct >= 85 ? " hot" : "");
        s.innerText = t.active
            ? `${t.label} $${t.usd.toFixed(t.usd < 1 ? 2 : 2)}/$${t.budgetUsd}`
            : `${t.label} $0/$${t.budgetUsd}`;
        s.title = t.active
            ? `${t.pct}% of this ${t.label} window · ${t.resetsWords}`
            : "opens with your next billed call";
        host.appendChild(s);
        if (t.active) anyActive = true;
    }
    const tight = u.tiers.find(t => t.key === u.tightest);
    $("ctx-plan-reset").innerText =
        tight && tight.active ? "· " + tight.resetsWords
        : anyActive ? "" : "· no open window";
    if (tight && tight.pct >= 85 && goWarnedWindow !== tight.start) {
        goWarnedWindow = tight.start;
        addNotice(`The GO ${tight.label} window has used ${tight.pct}% of its $${tight.budgetUsd} — it ${tight.resetsWords}.`);
    }
    for (const t of u.tiers) {
        const input = $("ctx-plan-b-" + t.key);
        if (input && document.activeElement !== input) {
            input.value = String(t.budgetUsd);
        }
    }
}
async function saveGoBudgets() {
    await window.lcl.setGoPlan({
        h5: Number($("ctx-plan-b-h5").value),
        week: Number($("ctx-plan-b-week").value),
        month: Number($("ctx-plan-b-month").value)
    }).catch(() => null);
    renderGoStrip();
    // the top-bar plan ring is scored against this same budget, so repaint it —
    // otherwise it keeps showing the old percentage and colour band until an
    // unrelated turn or model switch happens to refresh it
    refreshPlanRing();
}
for (const k of ["h5", "week", "month"]) {
    $("ctx-plan-b-" + k).addEventListener("change", saveGoBudgets);
}

function openContextPanel() {
    if (!active) return;
    renderContextPanel();
    renderGoStrip();
    // the stats paint immediately; the audit trail fills as the snapshot
    // arrives — never the other way around, a panel that blocks on IPC is a
    // panel that feels broken on a slow disk
    renderContextAudit(active);
    CTX_SCRIM.classList.remove("hidden");
}
function closeContextPanel() { CTX_SCRIM.classList.add("hidden"); }
$("ctx-export").addEventListener("click", async () => {
    if (!active) return;
    const res = await window.lcl.exportSession(active.id).catch(() => null);
    // `res.path` only when the main process really returned one — "Exported
    // to undefined" is a sentence this app must never print
    if (res && res.ok) addNotice(res.path ? `Exported to ${res.path}` : "Exported.");
    else if (res && !res.cancelled) addNotice("Export failed" + (res.error ? `: ${res.error}` : "."));
});

contextRingWrap.addEventListener("click", () => openContextPanel());
/**
 * THE WINDOW PANEL — its own, not the context one.
 *
 * The 5-hour window ring and the main context ring should be two separate
 * things, not share one context menu.
 *
 * They measure different things on different clocks: one is how full THIS
 * conversation is, the other is what the last five hours have cost or
 * produced. Sharing a panel said they were two views of one fact.
 */
async function openWindowPanel() {
    let u = null;
    try { u = await window.lcl.usageWindow(active ? active.id : null); }
    catch { u = null; }

    const wrap = document.createElement("div");
    wrap.className = "pref-wrap";

    const plan = u && !u.planless && Array.isArray(u.tiers) && u.tiers.length;
    if (plan) {
        const intro = document.createElement("div");
        intro.className = "pref-note";
        /* WHAT ACTUALLY HAPPENS WHEN A WINDOW RUNS OUT, per opencode.ai/docs/go.
         *
         * The panel said the work "stops", which is not what their literature
         * says and is the sort of half-truth that makes an operator plan around
         * a cliff that is not there. Two things are true instead: the free
         * models keep working, and if "Use balance" is switched on in the
         * OpenCode console, GO falls back to the Zen balance rather than
         * blocking. That is why GO is ad-hoc as well as metered.
         *
         * Also from the same page, and the reason one rate table serves both:
         * GO's per-token prices are IDENTICAL to Zen's. The 6x is bulk
         * discount and reserved capacity that OpenCode negotiates, not cheaper
         * tokens.
         */
        intro.innerText = `${u.planName || "This plan"} meters a SUBSCRIPTION ` +
            `window on ${u.endpointLabel || "this endpoint"}. Its per-token ` +
            `prices are the same as Zen's — the subscription buys reserved ` +
            `capacity, not cheaper tokens.\n\n` +
            `When a window runs out, standard requests stop, the FREE models ` +
            `keep working, and if you have switched on "Use balance" in the ` +
            `OpenCode console it falls back to your Zen balance instead of ` +
            `blocking. So this is a ceiling on the subscription, not on you.`;
        wrap.appendChild(intro);
        for (const t of u.tiers) {
            const row = document.createElement("div");
            row.className = "win-tier";
            const nm = document.createElement("span");
            nm.className = "win-tier-name";
            nm.innerText = t.label;
            const bar = document.createElement("div");
            bar.className = "win-tier-bar";
            const fill = document.createElement("div");
            fill.className = "win-tier-fill";
            fill.style.width = Math.max(0, Math.min(100, Number(t.pct) || 0)) + "%";
            bar.appendChild(fill);
            const val = document.createElement("span");
            val.className = "win-tier-val";
            // an OPEN window with no published price is not an idle one, and
            // reporting $0.00 of $12 would read as untouched
            val.innerText = Number(t.usd) > 0
                ? `${Number(t.usd).toFixed(2)} / ${t.budgetUsd}`
                : (t.active
                    ? `open · ${(Number(t.inputTokens) + Number(t.outputTokens))
                        .toLocaleString()} tokens · no published price`
                    : `unused · ${t.budgetUsd}`);
            const rst = document.createElement("span");
            rst.className = "win-tier-reset";
            rst.innerText = t.resetsWords || "";
            row.append(nm, bar, val, rst);
            wrap.appendChild(row);
        }
        if (u.console) {
            const link = document.createElement("button");
            link.className = "ghost small";
            link.innerText = "Open the provider's console";
            link.addEventListener("click", () => {
                try { window.lcl.openExternal(u.console); } catch { }
            });
            wrap.appendChild(link);
        }
    } else {
        const w = (u && u.work) || { calls: 0, inputTokens: 0, outputTokens: 0,
                                     usd: 0, resetsWords: null };
        const intro = document.createElement("div");
        intro.className = "pref-note";
        intro.innerText = "Nothing in this mode stops after five hours, so this " +
            "is not a ceiling — it is what the last five hours actually " +
            "produced. The window opens at the first turn and closes five " +
            "hours later.";
        wrap.appendChild(intro);
        const facts = [
            ["turns", String(w.calls || 0)],
            ["tokens in", Number(w.inputTokens || 0).toLocaleString()],
            ["tokens out", Number(w.outputTokens || 0).toLocaleString()],
            ["spent", Number(w.usd) > 0 ? `${Number(w.usd).toFixed(2)}`
                                        : "nothing billed"],
            ["window", w.resetsWords || "not open yet"]
        ];
        for (const [k, v] of facts) {
            const row = document.createElement("div");
            row.className = "win-tier";
            const nm = document.createElement("span");
            nm.className = "win-tier-name";
            nm.innerText = k;
            const val = document.createElement("span");
            val.className = "win-tier-val";
            val.innerText = v;
            row.append(nm, val);
            wrap.appendChild(row);
        }
    }

    await modal({ title: plan ? "Subscription window" : "Five-hour work window",
                  node: wrap, confirmLabel: "Close", confirmOnly: true });
}

if (planRingWrap) planRingWrap.addEventListener("click", () => openWindowPanel());
$("context-close").addEventListener("click", closeContextPanel);
CTX_SCRIM.addEventListener("click", (e) => { if (e.target === CTX_SCRIM) closeContextPanel(); });
$("ctx-compact").addEventListener("click", async () => {
    const btn = $("ctx-compact");
    btn.disabled = true;
    btn.innerText = "Compacting…";
    try { await compactConversation(); } finally {
        closeContextPanel();
    }
});

// =============================================================
// SCROLL
// =============================================================
const atBottom = (slack = 60) =>
    chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < slack;

function scrollToBottom(force = false) {
    if (force || atBottom(160)) chatScroll.scrollTop = chatScroll.scrollHeight;
    updateJumpButton();
}

const updateJumpButton = () => jumpBtn.classList.toggle("hidden", atBottom(120));

chatScroll.addEventListener("scroll", updateJumpButton);
jumpBtn.addEventListener("click", () => {
    chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: "smooth" });
    jumpBtn.classList.add("hidden");
});

// =============================================================
// MESSAGE RENDERING
// =============================================================
function copyToClipboard(text, btn) {
    // the async API rejects when the document is unfocused or a permission
    // handler says no — and a copy button that silently does nothing reads
    // as broken, because it is. Fall back to the selection API before giving up.
    navigator.clipboard.writeText(text).then(() => flashCheck(btn), () => {
        try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand("copy");
            ta.remove();
            if (ok) flashCheck(btn);
        } catch { /* nothing left to try */ }
    });
}

// --- icons (inline SVG: no icon font, no external file, CSP-safe) ---
const SVG_NS = "http://www.w3.org/2000/svg";

function svgIcon(paths, opts = {}) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(opts.size || 14));
    svg.setAttribute("height", String(opts.size || 14));
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", String(opts.weight || 1.9));
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const d of paths) {
        const el = document.createElementNS(SVG_NS, d.tag || "path");
        for (const [k, v] of Object.entries(d)) {
            if (k !== "tag") el.setAttribute(k, v);
        }
        svg.appendChild(el);
    }
    return svg;
}

const ICONS = {
    copy: () => svgIcon([
        { tag: "rect", x: 9, y: 9, width: 12, height: 12, rx: 2 },
        { d: "M5 15V5a2 2 0 0 1 2-2h10" }
    ]),
    check: () => svgIcon([{ d: "M20 6L9 17l-5-5" }]),
    trash: () => svgIcon([
        { d: "M3 6h18" },
        { d: "M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" },
        { d: "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" },
        { d: "M10 11v6" }, { d: "M14 11v6" }
    ]),
    resend: () => svgIcon([
        { d: "M4 9h11a4 4 0 0 1 0 8H9" },
        { d: "M7 5L3 9l4 4" }
    ]),
    undo: () => svgIcon([
        { d: "M3 8h10a5 5 0 0 1 0 10H8" },
        { d: "M6 4L2 8l4 4" }
    ]),
    // circular double-arrow for Refresh — the icon everyone reads as "reload"
    refresh: () => svgIcon([
        { d: "M21 12a9 9 0 1 1-3-6.7" },
        { d: "M21 3v5h-5" }
    ]),
    // a small check-in-circle for Test's resting state
    test: () => svgIcon([
        { tag: "circle", cx: 12, cy: 12, r: 9 },
        { d: "M8.5 12.5l2.5 2.5 4.5-5" }
    ]),
    // a gauge/dashboard glyph for a node's Dashboard
    dashboard: () => svgIcon([
        { tag: "path", d: "M12 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" },
        { d: "M12 9V5" },
        { d: "M4 20a8 8 0 0 1 16 0" }
    ])
};

/** Icon-only action button. Label is the tooltip + accessible name. */
function actionButton(icon, title, onClick, cls = "") {
    const b = document.createElement("button");
    b.className = ("icon-btn " + cls).trim();
    b.title = title;
    b.setAttribute("aria-label", title);
    b.appendChild(ICONS[icon] ? ICONS[icon]() : ICONS.copy());
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(b); });
    return b;
}

/** Swap an icon button to a checkmark briefly, for copy feedback. */
function flashCheck(btn) {
    // copies now also come from click-to-copy on a notice, which has no
    // button to flash — the element flashes itself instead
    if (!btn || !btn.firstChild) return;
    const original = btn.firstChild;
    btn.replaceChild(ICONS.check(), original);
    btn.classList.add("copied");
    setTimeout(() => {
        if (btn.firstChild) btn.replaceChild(original, btn.firstChild);
        btn.classList.remove("copied");
    }, 1200);
}

/** A message with its hover action bar. index === position in session.messages */
/**
 * FORK — a new linked conversation that begins where this one was.
 *
 * The requirement: forking into N linked sessions. Semantics are
 * opencode's Session.fork (title becomes "<title> (fork #N)", messages copied
 * up to the chosen point, settings carried, link recorded); the clone itself
 * lives in .lcl.engine/core/sessionFork.js where it is tested.
 *
 * Two doors, matching how forking is actually used:
 *   - the session menu forks the WHOLE conversation as it stands,
 *   - "fork from here" on a message forks everything BEFORE it — re-ask that
 *     question differently without losing the original thread.
 * Forking never blocks on a busy session: the parent keeps working and the
 * fork owns the transcript as it stood.
 */
async function forkSessionRow(id, messageIndex) {
    const res = await window.lcl.forkSession(id, messageIndex).catch(() => null);
    if (!res || res.error) {
        addNotice("Fork failed" + (res && res.error ? `: ${res.error}` : "."));
        return;
    }
    await refreshSessions();
    await switchSession(res.id);
    addNotice(`Forked — this is "${res.title}", carrying ` +
        `${res.messages} message${res.messages === 1 ? "" : "s"}. ` +
        `The original conversation is untouched.`);
}

function addMessageRow(role, text, index, meta, attachments) {
    const row = document.createElement("div");
    row.className = `msg-row ${role === "user" ? "user" : "assistant"}`;

    // FORK FROM HERE — on the user's own messages, where a fork makes
    // sense: everything BEFORE this question comes along, and this question
    // can be asked differently. Hover-revealed so the transcript stays quiet.
    if (role === "user" && active && Number.isInteger(index)) {
        const fk = document.createElement("button");
        fk.className = "msg-fork";
        fk.innerText = "⑂ fork from here";
        fk.title = "Start a linked session carrying everything before this message";
        const sid = active.id, at = index;
        fk.addEventListener("click", (e) => {
            e.stopPropagation();
            forkSessionRow(sid, at);
        });
        row.appendChild(fk);
    }

    // A MACHINE NOTICE IS NOT AN ANSWER.
    //
    // "asked for an image of a donkey, got a refusal about closing apps to free
    //  memory. Wrong refusal, wrong reason." Half of that is the engine's, and
    // it is fixed there; the other half is that a memory refusal arrived on the
    // same wire as the model's reply and was drawn as the reply. engine.js now
    // tags those `guard`, and agent.js carries meta.guard onto the transcript
    // message. Drawn here as the app speaking, in its own frame, so it can never
    // again be read as the model answering the question that was asked.
    if (role === "assistant" && meta && meta.guard) {
        const note = document.createElement("div");
        note.className = "msg-guard";
        const head = document.createElement("div");
        head.className = "msg-guard-head";
        head.innerText = meta.guardKind ? ".lcl · " + meta.guardKind : ".lcl";
        const bodyLine = document.createElement("div");
        bodyLine.innerText = text;
        note.appendChild(head); note.appendChild(bodyLine);
        row.className = "msg-row notice";
        row.appendChild(note);
        chat.appendChild(row);
        return row;
    }

    // ANCIENT KNOWLEDGE AUDIT — drawn as the overseer speaking, not as a plain
    // assistant reply. agent.js tags the audit message meta.model
    // "ancient-knowledge"; here it becomes its own bubble with the brain mark,
    // so "the model checked its own work" reads as exactly that rather than as
    // one more answer. The brain is CLONED from the composer button so the two
    // are always the same glyph.
    if (role === "assistant" && meta && meta.model === "ancient-knowledge") {
        const note = document.createElement("div");
        note.className = "msg-ancient";
        const head = document.createElement("div");
        head.className = "msg-ancient-head";
        const srcSvg = document.querySelector("#brain-btn svg");
        if (srcSvg) {
            const svg = srcSvg.cloneNode(true);
            svg.setAttribute("width", "17");
            svg.setAttribute("height", "17");
            head.appendChild(svg);
        }
        const label = document.createElement("span");
        label.innerText = "Ancient Knowledge";
        head.appendChild(label);
        const bodyLine = document.createElement("div");
        bodyLine.className = "msg-ancient-body";
        // the stored content carries a redundant "**Ancient Knowledge Audit:**"
        // prefix — the header says it now, so strip it before rendering
        const auditText = String(text).replace(/^\s*\*\*Ancient Knowledge Audit:\*\*\s*/, "");
        if (window.lclSyntax) window.lclSyntax.renderMessageBody(bodyLine, auditText, { markdown: true });
        else bodyLine.innerText = auditText;
        note.appendChild(head); note.appendChild(bodyLine);
        row.className = "msg-row assistant ancient";
        row.appendChild(note);
        // copy affordance, like every other message
        const acts = document.createElement("div");
        acts.className = "msg-actions";
        acts.appendChild(actionButton("copy", "Copy this audit", (b) => copyToClipboard(text, b)));
        row.appendChild(acts);
        chat.appendChild(row);
        return row;
    }

    // THE POPPED BUBBLES, REPLAYED. meta.steps is the engine's persisted step
    // transcript for the turn that produced this reply (agent.js recordStep,
    // orchestrator.js goalSteps). Drawn flat, above the reply, through the
    // same stepLine() wording the live bubble used — finishing a turn, or
    // re-rendering, or restarting changes nothing about what the run showed.
    // Chat turns carry no tool/tool-done entries here by the engine's stated
    // dedupe choice: each call already persists as its own work row below.
    if (role === "assistant" && meta && Array.isArray(meta.steps) && meta.steps.length) {
        const stepsEl = document.createElement("div");
        stepsEl.className = "msg-steps";
        for (const s of meta.steps.slice(-200)) {
            const line = s && stepLine(s.phase, s.d || {});
            if (!line) continue;
            const div = document.createElement("div");
            div.className = "msg-step " + line.kind;
            div.innerText = line.text;
            stepsEl.appendChild(div);
        }
        if (stepsEl.children.length) row.appendChild(stepsEl);
    }

    const bubble = document.createElement("div");
    bubble.className = role === "user" ? "msg-user" : "msg-assistant";
    // assistant prose renders as real markdown structure; the user's own text
    // is shown exactly as typed
    if (window.lclSyntax) {
        window.lclSyntax.renderMessageBody(bubble, text, { markdown: role === "assistant" });
    } else bubble.innerText = text;
    // the files that rode this message, as chips above the operator's text
    if (role === "user" && Array.isArray(attachments) && attachments.length) {
        const chipStrip = document.createElement("div");
        chipStrip.className = "msg-attachments";
        for (const a of attachments) {
            const chip = document.createElement("span");
            chip.className = "attach-chip";
            chip.innerText = `${a.name} · ${wsFmtBytes(a.bytes)}`;
            chip.title = a.rel ? a.rel : (a.path || a.name);
            chipStrip.appendChild(chip);
        }
        bubble.prepend(chipStrip);
    }

    // CHOICE BUTTONS on a question.
    //
    // A question waiting on free text stalls until the user reads it, works out
    // what it wants, and types. The same question with three buttons is answered
    // in a second — which is the difference between background work that finishes
    // and background work you come back to hours later.
    //
    // Free text stays available: the composer is right there, and the model's
    // three guesses are often all wrong. The buttons are a shortcut, not a cage.
    if (role === "assistant" && meta && meta.clarify
        && Array.isArray(meta.choices) && meta.choices.length >= 2) {
        const picks = document.createElement("div");
        picks.className = "msg-choices";
        for (const choice of meta.choices.slice(0, 5)) {
            const b = document.createElement("button");
            b.className = "choice-btn";
            b.innerText = choice;
            b.addEventListener("click", () => {
                // disable the whole set so a double-click cannot send twice
                picks.querySelectorAll("button").forEach(x => { x.disabled = true; });
                b.classList.add("chosen");
                // sendMessage() reads the composer, which is also the right
                // behaviour here: the pick appears as something the user said,
                // in the transcript, exactly as if they had typed it.
                composer.value = choice;
                sendMessage();
            });
            picks.appendChild(b);
        }
        if (meta.offer) {
            // "Other" must open a REAL input field, inline — not just point at
            // the composer (see the design notes). Clicking it reveals a text
            // box right in the questionnaire; Enter or the arrow sends it as the
            // answer, exactly as a typed reply would appear.
            const otherBtn = document.createElement("button");
            otherBtn.className = "choice-btn choice-other";
            otherBtn.innerText = "Other…";
            const wrap = document.createElement("div");
            wrap.className = "choice-other-input hidden";
            const inp = document.createElement("input");
            inp.type = "text";
            inp.placeholder = "Type your own answer…";
            inp.setAttribute("aria-label", "Your own answer");
            const go = document.createElement("button");
            go.className = "choice-other-send";
            go.innerText = "→";
            go.setAttribute("aria-label", "Send this answer");
            const submit = () => {
                const v = inp.value.trim();
                if (!v) { inp.focus(); return; }
                picks.querySelectorAll("button, input").forEach(x => { x.disabled = true; });
                composer.value = v;
                sendMessage();
            };
            go.addEventListener("click", submit);
            inp.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); submit(); }
            });
            otherBtn.addEventListener("click", () => {
                otherBtn.classList.add("hidden");
                wrap.classList.remove("hidden");
                inp.focus();
            });
            wrap.appendChild(inp);
            wrap.appendChild(go);
            picks.appendChild(otherBtn);
            picks.appendChild(wrap);
        }
        bubble.appendChild(picks);
    }

    // PLAN-CONFIRM IS A CLICK, NOT A TYPING TASK. "if this is truly a confirm
    // before acting, then the model should offer a button to click to approve,
    // or just do that step." The pause stays — a big build still confirms
    // before it spends — but confirming is now one button, and "go" rides the
    // same one-shot skip a typed "go" always did (prior bubble is planConfirm).
    if (role === "assistant" && meta && meta.planConfirm) {
        const picks = document.createElement("div");
        picks.className = "msg-choices";
        const go = document.createElement("button");
        go.className = "choice-btn primary";
        go.innerText = "Go — build it";
        go.addEventListener("click", () => {
            picks.querySelectorAll("button").forEach(x => { x.disabled = true; });
            go.classList.add("chosen");
            composer.value = "go";
            sendMessage();
        });
        picks.appendChild(go);
        const adjust = document.createElement("button");
        adjust.className = "choice-btn";
        adjust.innerText = "Adjust";
        adjust.addEventListener("click", () => { composer.focus(); });
        picks.appendChild(adjust);
        const hint = document.createElement("div");
        hint.className = "msg-choices-hint";
        hint.innerText = "or type a change below";
        picks.appendChild(hint);
        bubble.appendChild(picks);
    }

    // A REPLY THAT CAME FROM SOMEWHERE ELSE SAYS SO ON ITS FACE. Eight
    // rerouted answers wore the refused model's name while a different model
    // on a different company's hardware wrote every word of them — the exact
    // "something funky" a user could sense but not see. The
    // banner sits ABOVE the text: provenance this surprising is not footnote
    // material.
    if (role === "assistant" && meta && meta.fellBackFrom) {
        const fb = document.createElement("div");
        fb.className = "msg-fallback";
        fb.innerText = `${meta.fellBackFrom} refused this turn` +
            (meta.fallbackReason ? ` (${String(meta.fallbackReason).slice(0, 140)})` : "") +
            ` — answered by ${meta.model || "another model"}` +
            (meta.endpoint ? ` on ${meta.endpoint}` : "");
        bubble.prepend(fb);
    }

    // Measured provenance on assistant replies: which model, how many tokens,
    // how fast. Real numbers from the generation, not decoration.
    if (role === "assistant" && meta && meta.model) {
        const foot = document.createElement("div");
        foot.className = "msg-meta";
        const bits = [meta.model];
        // Provider-reported in/out when we have them; the local estimate only
        // when we do not — never both, so the number is never ambiguous.
        if (meta.inTokens !== undefined) {
            bits.push(`${meta.inTokens.toLocaleString()} in · ${(meta.outTokens || 0).toLocaleString()} out`);
        } else if (meta.tokens) bits.push(`${meta.tokens} tokens`);
        if (meta.tps) bits.push(`${meta.tps} t/s`);
        foot.innerText = bits.join(" · ");
        // WHAT THIS ONE ANSWER COST. Its own element so it can be tinted and
        // read at a glance without hunting through the provenance line.
        if (meta.usd) {
            const c = document.createElement("span");
            c.className = "msg-cost";
            c.innerText = meta.usd < 0.01 ? "$" + meta.usd.toFixed(4) : "$" + meta.usd.toFixed(2);
            c.title = "what this reply cost, from the provider's own token counts";
            foot.appendChild(c);
        }
        // WHAT THE REVIEW DID, ON THE ANSWER IT REVIEWED. A chip rather than a
        // sentence, because it is provenance: how many rounds, how many fixes,
        // what is still open — and its own cost when the reviewers were paid.
        if (meta.audit) {
            const a = meta.audit;
            const chip = document.createElement("span");
            chip.className = "msg-audit" + (a.open ? " open" : "");
            const parts = [`reviewed ×${a.rounds || 1}`];
            if (a.repaired) parts.push(`${a.repaired} fixed`);
            if (a.open) parts.push(`${a.open} open${a.contested ? ` (${a.contested} contested)` : ""}`);
            if (a.usd) parts.push(a.usd < 0.01 ? "$" + a.usd.toFixed(4) : "$" + a.usd.toFixed(2));
            chip.innerText = "⚖ " + parts.join(" · ");
            chip.title = a.open
                ? "independent reviewers still disagree with part of this — see the notes above"
                : "four independent reviewers found nothing further — weak evidence, not proof";
            foot.appendChild(chip);
        }
        bubble.appendChild(foot);
    }
    row.appendChild(bubble);

    const actions = document.createElement("div");
    actions.className = "msg-actions";

    actions.appendChild(actionButton("copy",
        role === "user" ? "Copy this request" : "Copy this response",
        (b) => copyToClipboard(text, b)));

    if (role === "user") {
        actions.appendChild(actionButton("resend", "Edit and resend", () => {
            composer.value = text;
            autoGrow();
            composer.focus();
        }));
    }

    if (typeof index === "number") {
        actions.appendChild(actionButton("trash", "Delete this message", async () => {
            const ok = await modal({
                title: "Delete message",
                message: "Delete this message from the conversation?",
                detail: "It will no longer be sent to the model as context. Files are not affected.",
                confirmLabel: "Delete",
                danger: true
            });
            if (!ok) return;
            const res = await window.lcl.deleteMessages(active.id, [index]);
            if (res && res.messages) {
                active.messages = res.messages;
                renderMessages(active.messages);
                await refreshSessions();
            }
        }, "danger-text"));
    }

    row.appendChild(actions);
    chat.appendChild(row);
    return row;
}

const CHIP_SIGILS = { created: "+", modified: "±", moved: "→", deleted: "−", mkdir: "+/" };
const REVERT_COPY = {
    created: "Delete the file the agent created?",
    modified: "Restore this file to its previous contents?",
    moved: "Move the file back to where it was?",
    deleted: "Restore the deleted file from its backup?"
};

function changeChip(change) {
    const chip = document.createElement("div");
    const kind = change.reverted ? "reverted" : change.kind;
    chip.className = `change-chip ${kind}`;

    const sigil = document.createElement("span");
    sigil.className = "sigil";
    sigil.innerText = change.reverted ? "−" : (CHIP_SIGILS[change.kind] || "±");
    chip.appendChild(sigil);

    // a deleted file has nothing to preview; a directory opens the panel only
    const previewable = !change.reverted && change.kind !== "deleted";

    const label = document.createElement("span");
    label.innerText = change.reverted
        ? `${change.path} · reverted`
        : change.kind === "moved"
            ? `${change.from} → ${change.path}`
            : `${change.path} · ${change.kind === "mkdir" ? "folder created" : change.kind}` +
              `${change.bytes ? ` · ${change.bytes} B` : ""}`;
    if (previewable) {
        // the chip is also the door to the file: click → preview in the panel
        label.className = "chip-open";
        label.title = change.kind === "mkdir" ? "Open the workspace panel" : "Preview this file";
        label.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleWorkspace(true);
            if (change.kind !== "mkdir") openFileViewer(change.path);
        });
    }
    chip.appendChild(label);

    // A LABELLED "Open" so opening the file in the workspace is discoverable —
    // the whole label was already clickable, but nothing said so. "open in
    // workspace, prompted from the ui chat."
    if (previewable && change.kind !== "mkdir") {
        const openBtn = document.createElement("button");
        openBtn.className = "ghost small chip-openbtn";
        openBtn.innerText = "Open";
        openBtn.title = "Open this file in the workspace panel";
        openBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleWorkspace(true);
            openFileViewer(change.path);
        });
        chip.appendChild(openBtn);
    }

    // Revert exists only where an undo path exists: mkdir has none, and a
    // delete without a snapshot (file too large to back up) is permanent —
    // offering a Revert that must fail promises what cannot happen.
    const revertable = !change.reverted && change.id
        && change.kind !== "mkdir"
        && !(change.kind === "deleted" && !change.backupId);
    if (change.kind === "deleted" && !change.backupId && !change.reverted) {
        const note = document.createElement("span");
        note.className = "chip-note";
        note.innerText = "no backup (too large) — permanent";
        chip.appendChild(note);
    }

    if (revertable) {
        chip.appendChild(actionButton("undo", "Revert this file change", async () => {
            const ok = await modal({
                title: "Revert file change",
                message: REVERT_COPY[change.kind] || "Undo this change?",
                path: change.kind === "moved" ? `${change.path} → ${change.from}` : change.path,
                confirmLabel: "Revert",
                danger: true
            });
            if (!ok) return;

            const res = await window.lcl.revertChange(active.id, change.id);
            if (!res || res.error) {
                await modal({
                    title: "Could not revert",
                    message: (res && res.error) || "unknown error",
                    confirmLabel: "Close", confirmOnly: true
                });
                return;
            }
            change.reverted = true;
            renderMessages(active.messages);
            if (workspaceOpen()) loadWorkspaceFiles();
        }));
    }

    // EXPANDABLE INLINE PREVIEW — the modified chunk visible in the chat,
    // not only in the workspace panel. A small chevron toggles a code block
    // fetched on demand (so a long transcript of edits does not load every
    // file until you ask). Cached on the chip so re-expand is instant.
    if (previewable && change.kind !== "mkdir") {
        const exp = document.createElement("button");
        exp.className = "chip-expand";
        exp.title = "Show the change inline";
        const chev = document.createElement("span");
        chev.className = "chip-chev";
        chev.innerText = "▸";
        exp.appendChild(chev);
        let body = null, loaded = false;
        exp.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (!body) {
                body = document.createElement("div");
                body.className = "chip-preview hidden";
                chip.parentNode && chip.parentNode.insertBefore(body, chip.nextSibling);
            }
            const open = !body.classList.contains("hidden");
            body.classList.toggle("hidden");
            chev.innerText = open ? "▸" : "▾";
            if (open) return;
            if (!loaded) {
                loaded = true;
                body.innerText = "reading…";
                try {
                    const res = await window.lcl.viewFile(active.id, change.path);
                    if (res && res.error) { body.innerText = res.error; return; }
                    body.innerHTML = "";
                    if (res && res.kind === "text" && typeof res.text === "string") {
                        const lang = (change.path.match(/\.([a-z0-9]+)$/i) || [])[1] || "";
                        body.appendChild(window.lclSyntax.codeBlock(res.text.slice(0, 8000), lang));
                    } else if (res && res.kind === "image" && res.dataUrl) {
                        const img = document.createElement("img");
                        img.src = res.dataUrl; img.className = "chip-preview-img";
                        body.appendChild(img);
                    } else {
                        body.innerText = res && res.kind
                            ? `(${res.kind} — open in the workspace panel to view)`
                            : "could not read the file";
                    }
                } catch (err) {
                    body.innerText = String((err && err.message) || err);
                }
            }
        });
        chip.appendChild(exp);
    }

    return chip;
}

/**
 * Script approval card.
 *
 * The script is shown in full, highlighted, BEFORE anything runs — that is the
 * actual safety control, so this card is deliberately not collapsible and the
 * rollback is visible without a click.
 */
function addScriptCard(proposal) {
    const card = document.createElement("div");
    card.className = "script-card";
    card.dataset.proposalId = proposal.id;

    const head = document.createElement("div");
    head.className = "script-head";

    const title = document.createElement("span");
    title.className = "script-title";
    title.innerText = proposal.mutating ? "Proposed change to this machine" : "Proposed script";
    head.appendChild(title);

    const badge = document.createElement("span");
    badge.className = "script-badge " + (proposal.mutating ? "mutating" : "readonly");
    badge.innerText = proposal.mutating ? "changes system state" : "read-only";
    head.appendChild(badge);
    card.appendChild(head);

    // WHERE IT RUNS — stated before the buttons, because the click is consent
    // to exactly this and nothing else. Truthful about the boundary: low IL
    // blocks writes, not reads; a workspace run is not sandboxed at all.
    const where = document.createElement("div");
    where.className = "script-where " +
        (proposal.runsIn === "workspace" ? "in-workspace" : "in-box");
    where.innerText = proposal.runsIn === "workspace"
        ? "Runs in your linked folder — " + (proposal.workspaceDir || "") +
          " — with your file permissions. It is not sandboxed: it can change " +
          "anything you can, starting there." +
          (proposal.detectedWorkspace && !proposal.declaredWorkspace
              ? " (It references your folder, so it was staged to run there.)" : "")
        : proposal.runsIn === "scratch"
        ? "Runs in a scratch folder outside your files — no workspace is linked, " +
          "so nothing of yours is in reach."
        : proposal.workspaceDir
        ? "Runs in this session's sandbox — the box lives under your workspace at " +
          (proposal.workspaceDir || "") + "\\.lcl-sandbox, so you can see its work. " +
          "It cannot change files outside the box; it can still read files you can read."
        : "Runs in this session's sandbox box. It cannot change your linked " +
          "folder; it can still read files you can read.";
    card.appendChild(where);

    // THE EXACT DIRECTORY, MADE UNMISTAKABLE. A script that writes your real
    // folder is the one that can land in the WRONG folder when two share a name
    // — the case where a script overwrites the wrong backend — so the absolute path it will run in
    // and write to is shown on its own line, as a path, not buried in the
    // sentence above. Read it before you click.
    const runDir = proposal.runsIn === "workspace" ? proposal.workspaceDir
        : (proposal.workspaceDir ? proposal.workspaceDir + "\\.lcl-sandbox" : null);
    if (runDir) {
        const pathEl = document.createElement("div");
        pathEl.className = "script-path " + (proposal.runsIn === "workspace" ? "writes" : "boxed");
        const lbl = document.createElement("span");
        lbl.className = "script-path-label";
        lbl.innerText = proposal.runsIn === "workspace" ? "writes into" : "runs in";
        const val = document.createElement("code");
        val.className = "script-path-value";
        val.innerText = runDir;
        pathEl.appendChild(lbl);
        pathEl.appendChild(val);
        card.appendChild(pathEl);
    }

    if (proposal.purpose) {
        const why = document.createElement("div");
        why.className = "script-purpose";
        why.innerText = proposal.purpose;
        card.appendChild(why);
    }

    // the script itself, highlighted, never truncated
    const body = document.createElement("div");
    body.className = "script-body";
    if (window.lclSyntax) {
        body.appendChild(window.lclSyntax.codeBlock(proposal.script, proposal.language));
    } else {
        const pre = document.createElement("pre");
        pre.innerText = proposal.script;
        body.appendChild(pre);
    }
    card.appendChild(body);

    if (proposal.rollback) {
        const rb = document.createElement("details");
        rb.className = "script-rollback";
        const sum = document.createElement("summary");
        sum.innerText = "How to undo this";
        rb.appendChild(sum);
        const pre = document.createElement("pre");
        pre.innerText = proposal.rollback;
        rb.appendChild(pre);
        card.appendChild(rb);
    }

    const actions = document.createElement("div");
    actions.className = "script-actions";

    const note = document.createElement("span");
    note.className = "script-note";
    note.innerText = "Nothing has run yet.";
    actions.appendChild(note);

    const reject = document.createElement("button");
    reject.className = "ghost";
    reject.innerText = "Reject";

    const approve = document.createElement("button");
    approve.className = "primary";
    approve.innerText = proposal.runsIn === "workspace" ? "Run in my folder"
        : proposal.runsIn === "sandbox" ? "Run in sandbox"
        : proposal.mutating ? "Run it" : "Run";

    const output = document.createElement("pre");
    output.className = "script-output hidden";

    const finish = (text, cls) => {
        approve.remove();
        reject.remove();
        note.innerText = text;
        note.className = "script-note " + cls;
    };

    reject.addEventListener("click", async () => {
        await window.lcl.rejectScript(proposal.id);
        card.classList.add("rejected");
        finish("Rejected — nothing ran.", "rejected");
    });

    approve.addEventListener("click", async () => {
        approve.disabled = true;
        reject.disabled = true;
        note.innerText = "Running…";
        output.classList.remove("hidden");
        output.innerText = "";
        card.classList.add("running");

        const res = await window.lcl.approveScript(proposal.id);
        card.classList.remove("running");

        // exit 0 with stderr output is NOT a clean run — say so rather than
        // reporting success over the top of an error the user should read
        const clean = !!(res && res.clean);
        const warned = !!(res && res.ok && res.hadErrors);
        card.classList.add(clean ? "succeeded" : warned ? "warned" : "failed");

        if (res && typeof res.output === "string" && res.output.trim()) {
            output.innerText = res.output;
        } else if (!output.innerText.trim()) {
            output.innerText = "(no output)";
        }

        const secs = ((res && res.durationMs || 0) / 1000).toFixed(1);
        finish(
            clean ? `Finished cleanly · ${secs}s`
                : warned ? `Finished with errors · exit 0 · ${secs}s — read the output`
                : `Failed · exit ${res && res.exitCode !== undefined ? res.exitCode : "?"}` +
                  (res && res.error ? ` · ${res.error}` : ""),
            clean ? "ok" : warned ? "warned" : "failed"
        );
        scrollToBottom(true);
    });

    actions.appendChild(reject);
    actions.appendChild(approve);
    card.appendChild(actions);
    card.appendChild(output);

    chat.appendChild(card);
    scrollToBottom(true);
    return card;
}

// stream stdout/stderr into the card while the script runs
window.lcl.onScriptOutput(({ id, chunk }) => {
    const card = chat.querySelector(`.script-card[data-proposal-id="${id}"]`);
    if (!card) return;
    const out = card.querySelector(".script-output");
    if (!out) return;
    out.classList.remove("hidden");
    out.innerText += chunk;
    scrollToBottom(false);
});

/**
 * WHAT THIS CALL WAS ABOUT, AND HOW IT WENT — in two short strings.
 *
 * opencode's tool row is title / subtitle / action: the tool's name, the thing
 * it operated on, and the outcome (packages/session-ui/src/components/
 * basic-tool.tsx). `.lcl` printed `tool · write_file` and a wall of raw JSON,
 * so reading a run meant expanding every row to find out which FILE each one
 * touched — the transcript said work happened and never said what.
 *
 * The subject and the outcome are DERIVED here rather than stored, because the
 * tool message carries neither: it has a name, a result, and (for mutating
 * tools) a change record. Everything below reads from those. Nothing is
 * invented — when a result says nothing useful, the row says nothing rather
 * than guessing, and the detail is one click away exactly as before.
 */
function toolRowFacts(msg) {
    const name = String(msg.name || "tool");
    let subject = "";
    let outcome = "";

    // the change record is the most reliable subject there is: it is what the
    // engine recorded as actually written
    if (msg.change && msg.change.path) subject = String(msg.change.path);

    let data = null;
    const raw = String(msg.content || "");
    if (raw.startsWith("{") || raw.startsWith("[")) {
        try { data = JSON.parse(raw); } catch { data = null; }
    }

    if (data && typeof data === "object" && !Array.isArray(data)) {
        if (!subject) {
            for (const k of ["path", "written", "file", "name", "query", "url", "target"]) {
                if (typeof data[k] === "string" && data[k]) { subject = data[k]; break; }
            }
        }
        if (typeof data.bytes === "number") outcome = fmtBytes(data.bytes);
        else if (Array.isArray(data.entries)) outcome = `${data.entries.length} item${data.entries.length === 1 ? "" : "s"}`;
        else if (Array.isArray(data.results)) outcome = `${data.results.length} match${data.results.length === 1 ? "" : "es"}`;
        else if (Array.isArray(data.processes)) outcome = `${data.processes.length} processes`;
        else if (typeof data.content === "string") outcome = fmtBytes(data.content.length);
        if (data.truncated === true) outcome += outcome ? " · truncated" : "truncated";
    }

    if (msg.failed) {
        // the first sentence of the error is the useful part; the rest is
        // advice that belongs in the expanded detail
        const first = raw.replace(/^ERROR:\s*/i, "").split(/[.\n]/)[0].trim();
        outcome = first.slice(0, 70) || "failed";
    }
    if (!subject && !msg.failed) {
        const line = raw.split("\n")[0].trim();
        if (line && line.length <= 60 && !/^[[{]/.test(line)) subject = line;
    }
    return { name, subject, outcome };
}

function addToolBubble(msg) {
    const details = document.createElement("details");
    // THE WORK VIEW: one dense row per operation, not a bubble per result.
    // Same <details> element, so it is still click-to-expand and every existing
    // behaviour below (change chips, image cards, approval cards) is untouched.
    details.className = "msg-tool work-row" + (msg.failed ? " failed" : "");

    const facts = toolRowFacts(msg);
    const summary = document.createElement("summary");

    const dot = document.createElement("span");
    dot.className = "wr-dot" + (msg.failed ? " bad" : msg.notified ? " note" : " ok");
    // the indicator carries its meaning as text too — colour alone is not a
    // status anyone can read
    dot.title = msg.failed ? "failed" : msg.notified ? "you were notified" : "completed";

    const nm = document.createElement("span");
    nm.className = "wr-name";
    nm.innerText = facts.name;

    summary.append(dot, nm);
    if (facts.subject) {
        const sub = document.createElement("span");
        sub.className = "wr-subject";
        sub.innerText = facts.subject;
        sub.title = facts.subject;      // the full path, when it is elided
        summary.appendChild(sub);
    }
    if (msg.repaired) {
        const chip = document.createElement("span");
        chip.className = "wr-flag";
        chip.innerText = "repaired";
        chip.title = "the model's tool call was malformed and was repaired before running";
        summary.appendChild(chip);
    }
    if (facts.outcome) {
        const act = document.createElement("span");
        act.className = "wr-outcome";
        act.innerText = facts.outcome;
        summary.appendChild(act);
    }
    details.appendChild(summary);

    const pre = document.createElement("pre");
    pre.innerText = msg.content;
    details.appendChild(pre);

    // THE DOCUMENT, NOT JUST THE RECEIPT. A write_file result is a stat line;
    // the text that was actually written rides msg.written now — so expanding
    // the row shows what landed in the file, in the chat log, permanently.
    if (msg.written) {
        const lab = document.createElement("div");
        lab.className = "wr-written-label";
        lab.innerText = "written to " + (msg.name === "edit_file" ? "the file (replacement text)" : "the file");
        const body = document.createElement("pre");
        body.className = "wr-written";
        body.innerText = msg.written;
        details.append(lab, body);
    }

    chat.appendChild(details);

    if (msg.change) chat.appendChild(changeChip(msg.change));
    // a generated image is the point of the call — show it, not just a chip
    if (msg.name === "generate_image" && !msg.failed && msg.change && !msg.change.reverted) {
        chat.appendChild(imageCard(msg.change));
    }
    // SERVE IT WITHOUT LEAVING THE CHAT. serve_folder returns a localhost url but
    // there was no way to open it from here — "the ability to launch from the chat
    // does not exist." Give the served folder a one-click Open, and check the
    // server is still LIVE first (they die on an app restart while this persisted
    // message keeps the old port) so a dead link explains itself instead of
    // opening a broken page.
    if (msg.name === "serve_folder" && !msg.failed) {
        let url = null;
        try {
            const raw = String(msg.content || "").trim();
            if (raw.startsWith("{")) url = (JSON.parse(raw) || {}).url || null;
        } catch { /* not json — no button */ }
        if (url) {
            const row = document.createElement("div");
            row.className = "serve-open-row";
            // the LIVE server for this button — the exact one, or (if its port died
            // on a restart and a fresh server is up) whatever is being served now,
            // so the button acts on reality instead of a dead port
            const resolveLive = async () => {
                const r = await window.lcl.listServers().catch(() => null);
                const live = (r && r.ok && Array.isArray(r.servers)) ? r.servers : [];
                const same = (a, b) => a === b || a === b + "/" || b === a + "/";
                return live.find(s => same(s.url, url)) || live[live.length - 1] || null;
            };
            const gone = "Nothing is being served right now (local servers stop when the app " +
                "closes). Ask me to serve the folder again and this button will work.";
            // PRIMARY: launch the served site INSIDE the workspace panel — the
            // the design: the clean inverted button, not a small ghost one.
            const launch = document.createElement("button");
            launch.className = "primary";
            launch.innerText = "Launch in Workspace";
            launch.title = url;
            launch.addEventListener("click", async (e) => {
                e.stopPropagation();
                const hit = await resolveLive();
                if (hit) launchServedInWorkspace(hit.url); else addError(gone);
            });
            // secondary: the external browser, for anyone who wants a full tab
            const browser = document.createElement("button");
            browser.className = "ghost small";
            browser.innerText = "Open in browser";
            browser.title = "Open the served site in your external browser instead";
            browser.addEventListener("click", async (e) => {
                e.stopPropagation();
                const hit = await resolveLive();
                if (hit) window.lcl.openExternal(hit.url); else addError(gone);
            });
            const where = document.createElement("span");
            where.className = "serve-open-url";
            where.innerText = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
            row.append(launch, browser, where);
            chat.appendChild(row);
        }
    }
    // a staged script or confirm-class tool gets a full approval card
    if (msg.proposal) {
        if (msg.proposal.kind === "tool") addToolApprovalCard(msg.proposal);
        else addScriptCard(msg.proposal);
    }
    return details;
}

// =============================================================
// THE INLINE PERMISSION PROMPT
// -------------------------------------------------------------
// "capable of selecting enable or trust, or allow, and that toggle the setting
//  without accessing it from the drop down ... or an only this once. but note
//  where the user can also set this, to avoid it in the next session, if they
//  like. make that noticable too, because most people just click yes and dont
//  read."
//
// Every word of that is a requirement, so each is built here rather than
// paraphrased:
//
//   ASKED IN PLACE     the prompt is a card in the transcript, where the work
//                      is. Not a dropdown you have to know exists, and not a
//                      modal that trains you to dismiss things.
//   THREE ANSWERS      only this once · for this conversation · deny. The
//                      middle one is the "enable or trust" that was missing:
//                      it decides the capability for the rest of the session
//                      without ever opening a settings panel.
//   SESSION SCOPED     "for this conversation" is held per session id and is
//                      never written to the app-wide policy. Opening a
//                      different session starts from the app default again.
//   THE POINTER, LOUD  where to set it for FUTURE sessions is a full-width
//                      bar with its own colour and its own button, because
//                      "most people just click yes and dont read" is a design
//                      constraint, not an excuse.
//
// WHAT IT WILL NOT DO. A grant for this conversation is never applied to an
// action that cannot be undone (a delete with no possible backup): those keep
// asking every time, and the card says why instead of quietly not offering it.
// =============================================================

/** sessionId -> Set of capability keys the operator trusted for that session. */
const sessionCapabilityGrants = new Map();
/** Proposal ids this renderer has already auto-answered, so a re-render of the
 *  same transcript cannot approve the same thing twice. */
const autoAnsweredProposals = new Set();

function capabilityGrantsFor(sessionId) {
    const id = String(sessionId || (active && active.id) || "");
    if (!sessionCapabilityGrants.has(id)) sessionCapabilityGrants.set(id, new Set());
    return sessionCapabilityGrants.get(id);
}
function isCapabilityGranted(sessionId, key) {
    return capabilityGrantsFor(sessionId).has(String(key));
}
function grantCapabilityForSession(sessionId, key) {
    capabilityGrantsFor(sessionId).add(String(key));
    paintPermChip();
    // If main ever grows a session-scoped tool policy, use it — the renderer's
    // own memory is the floor, not the ceiling. Probed rather than assumed,
    // because calling a method the bridge does not expose is a TypeError that
    // takes the click handler with it.
    if (typeof window.lcl.setSessionToolPolicy === "function") {
        window.lcl.setSessionToolPolicy(sessionId, String(key), "allow")
            .catch(() => { /* the renderer-side grant still holds for this run */ });
    }
}
function revokeCapabilityForSession(sessionId, key) {
    capabilityGrantsFor(sessionId).delete(String(key));
    paintPermChip();
    if (typeof window.lcl.setSessionToolPolicy === "function") {
        window.lcl.setSessionToolPolicy(sessionId, String(key), "ask")
            .catch(() => { /* the renderer-side revoke still holds */ });
    }
}
// NOTE: no per-CARD app-wide "always allow" — a card decision never widens a
// grant past the conversation it was raised in (fallback-consent.js enforces
// this: pre-authorising conversations that do not exist yet is not a card's
// call). An app-wide grant lives in Session › Permissions, the deliberate place
// for it. The card's real fix was serve_folder's sessionFloor, so "Allow for
// this conversation" now actually sticks instead of being clamped to confirm.

/**
 * Build one inline prompt. Returns the card; the caller appends it.
 *
 * spec = {
 *   kind      "capability" | "remote"  — the badge and the wording
 *   title     one line: what is being asked for
 *   subject   the thing itself (a tool name, a model id) — mono
 *   detail    a sentence of what it will do
 *   notes     [string] extra facts, each on its own line
 *   answers   [{ id, label, cls, sub }] in the order they should be read
 *   pointer   { label, where, onOpen } — the loud "set this for next time" bar
 *   onAnswer  (id) => void
 * }
 */
function buildInlinePrompt(spec) {
    const card = document.createElement("div");
    card.className = "perm-prompt " + (spec.kind === "remote" ? "remote" : "capability");

    const head = document.createElement("div");
    head.className = "perm-prompt-head";
    const badge = document.createElement("span");
    badge.className = "perm-prompt-badge";
    badge.innerText = spec.kind === "remote" ? "leaves this machine" : "permission";
    head.appendChild(badge);
    const title = document.createElement("span");
    title.className = "perm-prompt-title";
    title.innerText = spec.title;
    head.appendChild(title);
    card.appendChild(head);

    if (spec.subject) {
        const s = document.createElement("div");
        s.className = "perm-prompt-subject";
        s.innerText = spec.subject;
        card.appendChild(s);
    }
    if (spec.detail) {
        const d = document.createElement("div");
        d.className = "perm-prompt-detail";
        d.innerText = spec.detail;
        card.appendChild(d);
    }
    for (const n of spec.notes || []) {
        if (!n) continue;
        const el = document.createElement("div");
        el.className = "perm-prompt-note";
        el.innerText = n;
        card.appendChild(el);
    }

    const actions = document.createElement("div");
    actions.className = "perm-prompt-actions";
    const state = document.createElement("div");
    state.className = "perm-prompt-state";

    const answer = (id) => {
        for (const b of actions.querySelectorAll("button")) b.disabled = true;
        card.classList.add("answered");
        card.dataset.answer = id;
        spec.onAnswer(id, state, card);
    };

    for (const a of spec.answers) {
        const wrap = document.createElement("div");
        wrap.className = "perm-prompt-answer";
        const b = document.createElement("button");
        b.className = a.cls || "ghost";
        b.innerText = a.label;
        b.dataset.answerId = a.id;
        b.addEventListener("click", () => answer(a.id));
        wrap.appendChild(b);
        if (a.sub) {
            const s = document.createElement("span");
            s.className = "perm-prompt-answer-sub";
            s.innerText = a.sub;
            wrap.appendChild(s);
        }
        actions.appendChild(wrap);
    }
    card.appendChild(actions);
    card.appendChild(state);

    // THE POINTER. Loud on purpose: full width, its own ink, its own button,
    // below the answers rather than beside them, so it is the last thing read
    // before the click rather than a footnote after it.
    if (spec.pointer) {
        const bar = document.createElement("div");
        bar.className = "perm-prompt-where";
        const lab = document.createElement("div");
        lab.className = "perm-prompt-where-label";
        lab.innerText = "Where to change this for next time";
        bar.appendChild(lab);
        const txt = document.createElement("div");
        txt.className = "perm-prompt-where-text";
        txt.innerText = spec.pointer.where;
        bar.appendChild(txt);
        const go = document.createElement("button");
        go.className = "perm-prompt-where-go";
        go.innerText = spec.pointer.label;
        go.addEventListener("click", () => spec.pointer.onOpen());
        bar.appendChild(go);
        card.appendChild(bar);
    }
    return card;
}

/* =====================================================================
 * THE ASK IS A POPUP AT THE COMPOSER, NOT A CHAT MESSAGE.
 *
 * "it should be a pop up, that appears near the chat input, and goes away
 *  when clicked, on whatever the message was." The card floats directly
 * above the input (OpenCode docks its permission prompt in the same spot),
 * one at a time — a second ask queues behind the first. Esc denies; Enter
 * answers with the primary button when focus is not in a text field.
 * ===================================================================== */
const permPopupQueue = [];
function permPopupLayer() {
    // it lives in the markup (inside #composer) — built here only if a host
    // page somehow lacks it, so this never returns null to a caller
    let layer = $("perm-popup-layer");
    if (!layer) {
        layer = document.createElement("div");
        layer.id = "perm-popup-layer";
        $("composer").appendChild(layer);
    }
    return layer;
}
/* IS THE POPUP THE TOP LAYER? The card's own pointer opens the Permissions
 * sheet, and showModal focuses its Close button — so a capture-phase key
 * handler that fired regardless would turn "Enter to close the sheet" into
 * "approve the paid send", and Esc into a silent deny behind the scrim. The
 * popup only owns the keyboard when nothing is stacked over it. */
function permPopupOnTop() {
    const scrim = $("modal-scrim");
    if (scrim && !scrim.classList.contains("hidden")) return false;
    if (document.querySelector(".rate-pop")) return false;
    const menu = $("model-menu");
    if (menu && !menu.classList.contains("hidden")) return false;
    return true;
}
/* HOW MUCH ROOM IS THERE ABOVE THE INPUT? Measured, because the composer's
 * height is not knowable in CSS: a grown textarea plus a tall card could put
 * the head — badge, title, copy button — above the window edge. */
function permPopupFit() {
    const layer = $("perm-popup-layer");
    const comp = $("composer");
    if (!layer || !comp) return;
    const top = comp.getBoundingClientRect().top;
    const room = Math.max(180, Math.round(top - 16));
    layer.style.setProperty("--perm-pop-max", room + "px");
}
window.addEventListener("resize", () => { try { permPopupFit(); } catch { } });

function permPopupShow(card) {
    const layer = permPopupLayer();
    if (layer.firstChild) { permPopupQueue.push(card); return; }
    layer.appendChild(card);
    permPopupFit();
    const onKey = (e) => {
        if (!card.isConnected) { document.removeEventListener("keydown", onKey, true); return; }
        if (card.classList.contains("answered")) return;
        if (!permPopupOnTop()) return;      // a sheet is over it; keys are its own
        if (e.key === "Escape") {
            e.preventDefault(); e.stopPropagation();
            const deny = card.querySelector('[data-answer-id="deny"]');
            if (deny) deny.click();
        } else if (e.key === "Enter") {
            // A FOCUSED CONTROL KEEPS ITS OWN ENTER. Excluding only text
            // fields meant Enter on ANY button — the card's copy button, a
            // sheet's Close — fired the card's primary answer, which is the
            // approve. Enter is the card's only when focus is nowhere
            // interactive, or already inside the card's answer row.
            const el = e.target;
            const tag = (el && el.tagName) || "";
            const inActions = !!(el && el.closest && el.closest(".perm-prompt-actions"));
            if (!inActions
                && /^(TEXTAREA|INPUT|SELECT|BUTTON|A)$/.test(tag)) return;
            if (inActions) return;          // the button's own click handles it
            e.preventDefault(); e.stopPropagation();
            const first = card.querySelector(".perm-prompt-actions button");
            if (first) first.click();
        }
    };
    document.addEventListener("keydown", onKey, true);
    card._popKeyOff = () => document.removeEventListener("keydown", onKey, true);
}
function permPopupDismiss(card) {
    if (card._popKeyOff) { try { card._popKeyOff(); } catch { } card._popKeyOff = null; }
    card.classList.add("perm-pop-leaving");
    setTimeout(() => {
        card.remove();
        // only ever show a card belonging to the conversation on screen; the
        // rest wait in the queue until their own session is opened
        const i = permPopupQueue.findIndex(c => permCardSession(c) === (active && active.id));
        if (i >= 0) permPopupShow(permPopupQueue.splice(i, 1)[0]);
    }, 200);
}
function permCardSession(card) { return (card && card.dataset && card.dataset.sessionId) || null; }

/* THE ASK DIED WITHOUT AN ANSWER. Main settles its own request on timeout or
 * Stop; before this channel existed the card floated on with live buttons,
 * blocking every later ask behind it and printing "sent once" for a turn that
 * had been denied minutes earlier. */
function permPopupWithdraw(id, reason) {
    const withdrawnNote = reason === "timeout"
        ? "This ask expired without an answer — nothing was sent."
        : reason === "no-window"
            ? "This ask was closed — nothing was sent."
            : "This ask was withdrawn — nothing was sent.";
    const layer = permPopupLayer();
    const mounted = [...layer.children].find(c => c.dataset && c.dataset.approvalId === String(id));
    if (mounted && !mounted.classList.contains("answered")) {
        mounted.classList.add("answered");
        for (const b of mounted.querySelectorAll("button[data-answer-id]")) b.disabled = true;
        const st = mounted.querySelector(".perm-prompt-state");
        if (st) st.innerText = withdrawnNote;
        permReceipt(withdrawnNote, false, permCardSession(mounted));
        setTimeout(() => permPopupDismiss(mounted), 1200);
        return true;
    }
    const qi = permPopupQueue.findIndex(c => c.dataset && c.dataset.approvalId === String(id));
    if (qi >= 0) { permPopupQueue.splice(qi, 1); return true; }
    // never shown (it was held for a background session) — drop the held copy,
    // or opening that session would present a dead ask as a live one
    for (const [sid, held] of remoteAwaiting) {
        if (held && String(held.id) === String(id)) { remoteAwaiting.delete(sid); return true; }
    }
    return false;
}

/* the one-line trace the transcript keeps once the popup is answered — into
 * the transcript of the session that ASKED, never whichever one is on screen */
function permReceipt(text, allowed, sessionId) {
    if (sessionId && active && active.id !== sessionId) return;
    const chip = document.createElement("div");
    chip.className = "perm-receipt " + (allowed ? "allowed" : "denied");
    chip.innerText = text;
    chat.appendChild(chip);
    scrollToBottom(true);
}

/* SESSION SWITCH: a card belongs to the conversation that raised it. Anything
 * mounted for another session goes back to the queue rather than floating over
 * a conversation it has nothing to do with. */
function permPopupSyncToSession() {
    const layer = permPopupLayer();
    for (const card of [...layer.children]) {
        if (card.classList.contains("answered")) continue;
        if (permCardSession(card) && permCardSession(card) !== (active && active.id)) {
            if (card._popKeyOff) { try { card._popKeyOff(); } catch { } card._popKeyOff = null; }
            card.remove();
            permPopupQueue.unshift(card);
        }
    }
    if (!layer.firstChild) {
        const i = permPopupQueue.findIndex(c => permCardSession(c) === (active && active.id));
        if (i >= 0) permPopupShow(permPopupQueue.splice(i, 1)[0]);
    }
}

/**
 * Approval card for confirm-class tools (delete_file and future peers).
 * Same contract as the script card: nothing runs until the human decides,
 * and the id is the only handle the approve IPC accepts.
 */
function addToolApprovalCard(proposal) {
    const card = document.createElement("div");
    card.className = "script-card tool-approval";
    card.dataset.proposalId = proposal.id;
    // a card replayed from history for a decided (or restart-expired) proposal
    // shows its outcome — never live buttons that point at nothing
    const resolved = proposal.resolved;

    const head = document.createElement("div");
    head.className = "script-head";
    const title = document.createElement("span");
    title.className = "script-title";
    title.innerText = `Approval needed: ${proposal.tool.replace(/_/g, " ")}`;
    head.appendChild(title);
    const badge = document.createElement("span");
    badge.className = "script-badge mutating";
    badge.innerText = proposal.classification || "destructive";
    head.appendChild(badge);
    card.appendChild(head);

    const what = document.createElement("div");
    what.className = "script-purpose";
    what.innerText = proposal.digest || JSON.stringify(proposal.args);
    card.appendChild(what);

    if (proposal.tool === "delete_file") {
        const note = document.createElement("div");
        note.className = "tool-approval-note";
        // honest per-file: a >2 MB file cannot be snapshotted, and promising a
        // restore that cannot happen is worse than saying it is permanent
        const backupPossible = !proposal.target || proposal.target.backupPossible !== false;
        note.innerText = backupPossible
            ? "A backup is taken first — this can be restored from the change chip."
            : "⚠ This file is too large to back up. Deleting it is PERMANENT.";
        if (!backupPossible) note.classList.add("permanent");
        card.appendChild(note);
    }

    const actions = document.createElement("div");
    actions.className = "script-actions";
    const state = document.createElement("span");
    state.className = "script-note";
    actions.appendChild(state);

    if (resolved) {
        const text = {
            approved: "Approved — it ran.",
            rejected: "Rejected — nothing ran.",
            failed: "Approved, but the run failed — see the tool result below."
        }[resolved] || resolved;
        state.innerText = text;
        state.className = "script-note " + (resolved === "approved" ? "ok"
            : resolved === "rejected" ? "rejected" : "failed");
        card.classList.add(resolved === "approved" ? "succeeded"
            : resolved === "rejected" ? "rejected" : "failed");
        card.appendChild(actions);
        chat.appendChild(card);
        return card;
    }

    state.innerText = "Nothing has run yet.";
    card.appendChild(actions);

    // the approve/reject outcome belongs to the PROPOSAL's session — apply it
    // only if that session is still the one on screen
    const applyToSession = (res) => {
        if (active && active.id === proposal.sessionId && res && res.messages) {
            active.messages = res.messages;
            if (res.changes) active.changes = res.changes;
            renderMessages(active.messages);
            if (workspaceOpen()) loadWorkspaceFiles();
        }
    };
    const finish = (text, cls) => {
        state.innerText = text;
        state.className = "script-note " + cls;
    };

    const doReject = async () => {
        const r = await window.lcl.rejectTool(proposal.id);
        card.classList.add("rejected");
        finish("Rejected — nothing ran.", "rejected");
        if (active && active.id === proposal.sessionId) {
            const fresh = await window.lcl.getSession(active.id);
            if (fresh && fresh.messages) active.messages = fresh.messages;
        }
        void r;
    };

    const doApprove = async () => {
        state.innerText = "Running…";
        const res = await window.lcl.approveTool(proposal.id);
        if (res && res.ok) {
            card.classList.add("succeeded");
            finish(res.backupTaken === false
                ? say("job.done", "Done.") +
                  " (No backup was possible for this one — it is permanent.)"
                : say("job.done", "Done."), "ok");
            applyToSession(res);
        } else if (res && res.error && /unknown or expired/i.test(res.error)) {
            // app restarted since staging: the in-memory proposal is gone
            card.classList.add("failed");
            finish("Expired (the app restarted) — ask again to re-stage it.", "failed");
        } else if (res && res.error) {
            // pre-flight refusal (folder changed, file changed, policy):
            // the reason IS the content — show it, and take the refreshed
            // transcript which now carries the expiry note
            card.classList.add("failed");
            finish(res.error, "failed");
            applyToSession(res);
        } else {
            // the tool ran and failed: the transcript gained the failed tool
            // result — show it rather than leaving a live-looking card
            card.classList.add("failed");
            finish(`Failed${res && res.output ? ` · ${String(res.output).slice(0, 120)}` : ""}`, "failed");
            applyToSession(res);
        }
        scrollToBottom(true);
    };

    // AN IRREVERSIBLE ACTION IS NEVER COVERED BY A STANDING GRANT. A delete
    // whose file is too large to back up keeps asking every single time; the
    // card says so where the missing button would have been, rather than
    // silently offering two answers instead of three.
    const permanent = proposal.tool === "delete_file" &&
        !!(proposal.target && proposal.target.backupPossible === false);
    const capKey = String(proposal.tool);
    const granted = isCapabilityGranted(proposal.sessionId, capKey);

    const answers = [{ id: "once", label: "Only this once", cls: "primary",
                       sub: "runs it, changes no setting" }];
    if (!permanent) {
        answers.push({ id: "session", label: "Allow for this conversation", cls: "ghost",
                       sub: "stops asking until you close this session" });
    }
    answers.push({ id: "deny", label: "Deny", cls: "ghost danger-text",
                   sub: "nothing runs" });

    const prompt = buildInlinePrompt({
        kind: "capability",
        title: `Allow ${proposal.tool.replace(/_/g, " ")}?`,
        // THE EXACT NAME, in mono. The row you would go and change is labelled
        // `http_fetch`, not "http fetch", and a prompt that prettifies the name
        // sends you looking for something that is not in the list.
        subject: proposal.tool,
        detail: permanent
            ? "This one cannot be granted for the whole conversation — it cannot " +
              "be undone, so it asks every time."
            : "This is a capability of .lcl, decided for this conversation.",
        answers,
        pointer: {
            /* PER SESSION, NOT GLOBAL — a regression, fixed to match the
               remote-send card below (the one that was done right). This
               pointed at the app-wide capabilities panel and said the row
               applied app-wide to every conversation: the exact global framing
               the grouped-per-session consolidation had removed, crept back in.
               "Allow for this conversation" above already writes the per-session
               tool policy that Session Permissions reads, so the group toggle
               there and this prompt are two views of ONE switch — and no other
               conversation is ever touched. */
            where: (proposal.capabilityLabel
                    ? `Session › Permissions › Tools › ${proposal.capabilityLabel} — turning the ` +
                      `“${proposal.capabilityLabel}” switch ON allows this and its group-mates for ` +
                      `this conversation; the button above grants just ${proposal.tool}. `
                    : "Session › Permissions › Tools — this sits in a group with the rest of what " +
                      "THIS conversation can do, and that switch is the same one the button above flips. ") +
                   "No other session is changed. The shield under the chat input opens it too.",
            label: "Session Permissions",
            onOpen: () => openSessionPerms()
        },
        onAnswer: (id, st) => {
            // CLOSE ON ANSWER. The decision is what this dialog is FOR; once it is
            // made the dialog's job is done. The action then RUNS — and its
            // progress and result belong in the turn's normal status line and
            // transcript, not behind a dialog held open for the whole run. The
            // old path AWAITED the approval before resolving, which kept this card
            // sitting on "Running…" for the entire execution — reported as "it
            // just sits there while it does whatever". So: record the decision,
            // fire the action WITHOUT awaiting, and dismiss the card. Re-render the
            // resolved result into the transcript; if the card is still on screen
            // when that lands, this removes it.
            if (id === "deny") {
                st.innerText = "Denied — nothing ran.";
                doReject();
            } else {
                if (id === "session") grantCapabilityForSession(proposal.sessionId, capKey);
                st.innerText = id === "session"
                    ? `Allowed for this conversation — ${proposal.tool} runs now; it won't ` +
                      "ask again until you close this session."
                    : `Allowed once — ${proposal.tool} runs now. Nothing was changed.`;
                doApprove();      // NOT awaited — the dialog must not hold open through the run
            }
            setTimeout(() => { try { card.remove(); } catch (_) { /* already gone */ } }, 900);
        }
    });
    card.appendChild(prompt);

    chat.appendChild(card);
    scrollToBottom(true);

    // ALREADY TRUSTED IN THIS CONVERSATION. The card is still drawn, still
    // says what ran and still offers a way to take the grant back — a
    // permission that acts silently is one you forget you gave.
    if (granted && !autoAnsweredProposals.has(proposal.id)) {
        autoAnsweredProposals.add(proposal.id);
        prompt.classList.add("answered", "auto");
        prompt.dataset.answer = "session-auto";
        for (const b of prompt.querySelectorAll(".perm-prompt-actions button")) b.disabled = true;
        const st = prompt.querySelector(".perm-prompt-state");
        st.innerText = "Allowed automatically — you trusted " + proposal.tool +
            " for this conversation.";
        const undo = document.createElement("button");
        undo.className = "ghost small";
        undo.innerText = "Stop allowing it";
        undo.addEventListener("click", () => {
            revokeCapabilityForSession(proposal.sessionId, capKey);
            undo.disabled = true;
            st.innerText = "Stopped. " + proposal.tool + " will ask again next time.";
        });
        st.appendChild(document.createElement("br"));
        st.appendChild(undo);
        doApprove();
    }
    return card;
}

/** Inline preview of a generated image, loaded through the sandboxed viewer IPC. */
function imageCard(change) {
    const card = document.createElement("div");
    card.className = "image-card";
    card.title = "Open in the workspace panel";

    const img = document.createElement("img");
    img.alt = change.path;
    card.appendChild(img);

    const cap = document.createElement("div");
    cap.className = "image-cap";
    cap.innerText = change.path;
    card.appendChild(cap);

    window.lcl.viewFile(active.id, change.path).then((res) => {
        if (res && res.kind === "image") img.src = res.dataUri;
        else cap.innerText = `${change.path} · preview unavailable`;
    });

    card.addEventListener("click", () => {
        toggleWorkspace(true);
        openFileViewer(change.path);
    });
    return card;
}

/** Neutral in-chat notice: information, not an error — no red, no alarm.
 *  Selectable and copyable like every other message; a notice about a memory
 *  stop is exactly the text someone wants to paste into a bug report. */
function addNotice(text, action = null) {
    const row = document.createElement("div");
    row.className = "msg-row assistant";
    const el = document.createElement("div");
    el.className = "msg-notice";
    el.innerText = text;
    // a notice that names a fix the user could click should CARRY the click
    if (action && action.label && action.onClick) {
        const btn = document.createElement("button");
        btn.className = "notice-action";
        btn.innerText = action.label;
        btn.addEventListener("click", () => action.onClick(btn));
        el.appendChild(btn);
    }
    row.appendChild(el);
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    actions.appendChild(actionButton("copy", "Copy", (b) => copyToClipboard(text, b)));
    row.appendChild(actions);
    chat.appendChild(row);
    scrollToBottom(true);
    return row;
}

/**
 * Mark the question that was on screen as never having been sent.
 *
 * The turn failed, so this text is not in the session file and will not be
 * there on reload — but it IS on screen, and erasing it is how the app used to
 * lose someone's question. Labelling it says both true things at once: this did
 * not go through, and here is exactly what you wrote.
 */
function markLastUserUnsent(text) {
    const rows = [...chat.querySelectorAll(".msg-row.user")];
    const row = rows[rows.length - 1];
    if (!row) return;
    row.classList.add("unsent");
    if (row.querySelector(".unsent-tag")) return;
    const tag = document.createElement("div");
    tag.className = "unsent-tag";
    tag.innerText = "not sent";
    tag.title = "Not saved — copy it or send it again.";
    row.appendChild(tag);
    row._unsentText = text;
}

/**
 * An error in the transcript.
 *
 * Selectable and copyable, always — error messages were not always copyable
 * in the modal versions of these, and there is no reason a
 * user should have to retype an error to search for it. When the error killed a
 * turn, the offer to send it again comes with it, because the alternative is
 * scrolling up and retyping the question.
 */
function addError(text, opts = {}) {
    // never dump a wall of log into the transcript
    const clipped = text.length > 600 ? text.slice(0, 600) + "\n…(truncated)" : text;
    const row = document.createElement("div");
    row.className = "msg-row assistant";

    const el = document.createElement("div");
    el.className = "msg-error";
    el.innerText = clipped;
    row.appendChild(el);

    const actions = document.createElement("div");
    actions.className = "msg-actions";
    actions.appendChild(actionButton("copy", "Copy full error", (b) => copyToClipboard(text, b)));

    if (opts.retry) {
        const again = actionButton("resend", "Send it again", () => {
            row.remove();
            const unsent = [...chat.querySelectorAll(".msg-row.user.unsent")].pop();
            if (unsent) unsent.remove();
            sendText(opts.retry, opts.session);
        });
        actions.appendChild(again);
    }
    row.appendChild(actions);

    chat.appendChild(row);
    scrollToBottom(true);
    return row;
}

/**
 * Live status bubble: the bouncing dots stay (they read as "alive"), but the
 * bubble also carries what the agent is actually doing, the elapsed time, and a
 * Stop button — so waiting is informative instead of a blind spinner.
 */
function addTyping() {
    const el = document.createElement("div");
    el.className = "msg-typing";

    const head = document.createElement("div");
    head.className = "typing-head";

    const dots = document.createElement("span");
    dots.className = "typing-dots";
    for (let i = 0; i < 3; i++) dots.appendChild(document.createElement("i"));
    head.appendChild(dots);

    const body = document.createElement("span");
    body.className = "typing-body";

    const phase = document.createElement("span");
    phase.className = "typing-phase";
    phase.innerText = "thinking";
    body.appendChild(phase);

    const detail = document.createElement("span");
    detail.className = "typing-detail";
    body.appendChild(detail);

    head.appendChild(body);

    // no Stop button here — stopping belongs on the composer button, which is
    // the one control the user already reaches for
    const meta = document.createElement("span");
    meta.className = "typing-meta";

    const elapsed = document.createElement("span");
    elapsed.className = "typing-elapsed";
    elapsed.innerText = "0s";
    meta.appendChild(elapsed);

    head.appendChild(meta);
    el.appendChild(head);

    // The step log. Every real thing the agent does — which model is thinking,
    // which tool ran with which args, what came back — lands here as it
    // happens, so waiting is never a blind spinner.
    const log = document.createElement("div");
    log.className = "typing-log";
    el.appendChild(log);

    // The live text preview: the tail of the answer as it streams. Real
    // output forming in real time, replaced by the final bubble when done.
    const preview = document.createElement("div");
    preview.className = "typing-preview hidden";
    el.appendChild(preview);

    chat.appendChild(el);

    el._phase = phase;
    el._detail = detail;
    el._elapsed = elapsed;
    el._log = log;
    el._preview = preview;
    return el;
}

/**
 * Append one line to the live step log (or update the last, for progress
 * ticks). `bar` is {pct} | {indeterminate: true} | null — a row with a bar
 * renders a real progress track under its label and updates IN PLACE, so a
 * ticking percent never floods the log and never eats the milestone notes
 * around it (bars replace only bars: the dataset-kind rule below).
 */
function pushActivity(bubble, kind, text, replaceLast = false, bar = null) {
    const log = bubble._log;
    if (!log) return;

    // THE LIVE STATUS OF THIS TURN IS ONE LINE, NOT A CHAIN.
    //
    // sent / reasoning / generating are all "what is happening right now" —
    // the wait, the thinking, the writing. They used to be three different
    // `kind` values, so each phase change added a NEW line instead of
    // replacing, and a reasoning model that alternates thinking → writing
    // → thinking stacked a chain of them while the line cap scrolled
    // the older ones off. Reported: "I see a chain of this while it is
    // sending a question to the local node." They share one `live` kind so
    // they replace each other in place; the run reads as one updating line.
    const LIVE_KINDS = { sent: "live", reasoning: "live", gen: "live" };
    let effectiveKind = LIVE_KINDS[kind] || kind;
    // bars on non-live kinds replace ONLY other bars — a ticking compile bar
    // must never swallow the "compiled. uploading…" milestone note beside it
    if (bar && !LIVE_KINDS[kind]) effectiveKind = "bar";
    const prevKind = log.lastChild && (LIVE_KINDS[log.lastChild.dataset.kind]
                                       || log.lastChild.dataset.kind);

    const setBar = (row) => {
        let track = row.querySelector(".typing-step-bar");
        if (!bar) { if (track) track.remove(); return; }
        if (!track) {
            track = document.createElement("div");
            track.className = "typing-step-bar";
            track.appendChild(document.createElement("i"));
            row.appendChild(track);
        }
        const fill = track.firstChild;
        fill.classList.toggle("indeterminate", !!bar.indeterminate);
        fill.style.width = bar.indeterminate ? "30%"
            : Math.max(0, Math.min(100, Math.round(bar.pct || 0))) + "%";
    };

    if (replaceLast && log.lastChild && prevKind === effectiveKind) {
        const row = log.lastChild;
        // the row can change species in place (a gen bar replacing the
        // "sent — waiting Ns" line) — refresh the class so it picks up its
        // own color and the has-bar layout, not just its words
        row.className = "typing-step " + kind + (bar ? " has-bar" : "");
        row.dataset.kind = effectiveKind;
        let label = row.querySelector(".typing-step-text");
        if (!label) {
            // a row built before bars existed: rebuild it with the label
            // span so the bar track is never destroyed by an innerText write
            row.textContent = "";
            label = document.createElement("span");
            label.className = "typing-step-text";
            row.appendChild(label);
        }
        label.innerText = text;
        setBar(row);
    } else {
        const row = document.createElement("div");
        row.className = "typing-step " + kind + (bar ? " has-bar" : "");
        row.dataset.kind = effectiveKind;
        const label = document.createElement("span");
        label.className = "typing-step-text";
        label.innerText = text;
        row.appendChild(label);
        setBar(row);
        log.appendChild(row);
        // the log is a permanent record of the turn now, not a ten-line
        // status ticker — capped only against runaway turns, matching the
        // engine's persisted STEP_CAP so the live view and the persisted
        // transcript hold the same run
        while (log.children.length > 200) log.removeChild(log.firstChild);
    }
    scrollToBottom(false);
}

function renderMessages(messages) {
    chat.innerHTML = "";
    messages.forEach((m, i) => {
        if (m.role === "tool") addToolBubble(m);
        else if (m.role === "user" || m.role === "assistant") addMessageRow(m.role, m.content, i, m.meta, m.attachments);
    });
    scrollToBottom(true);
    updateLanding();
    // THE RING IS ONLY TRUE IF SOMETHING REDRAWS IT.
    //
    // It had exactly ONE caller — inside compaction — so it was never redrawn
    // when a turn finished, when a session was opened, or at startup. The
    // reported symptom was simply that the context ring never appeared, and
    // that was right: nothing in normal use could ever make it appear.
    //
    // It belongs HERE because the ring describes the conversation currently on
    // screen. Hanging it off the render means no future path can draw a
    // transcript and forget the readout that goes with it.
    //
    // The UI harness passed throughout, because it calls refreshContextRing()
    // itself — proving the ring RENDERS, never that anything CALLS it. A
    // painted-pixels harness still needs its wiring asserted separately, which
    // tests/renderer-wiring.js now does.
    try { refreshContextRing(); } catch { /* a readout never breaks the transcript */ }
}

// =============================================================
// LANDING PAGE
// =============================================================
let landingWasVisible = false;
let introPlayedFor = null;     // session the intro has already run for

function updateLanding() {
    const show = !!active
        && (active.messages || []).length === 0
        && !landingDismissed.has(active.id)
        && !pending;
    landingEl.classList.toggle("hidden", !show);
    // the landing REPLACES the transcript rather than covering it, so the
    // composer below stays reachable and the on-screen copy stays true
    chatScroll.classList.toggle("hidden", show);
    if (show) jumpBtn.classList.add("hidden");

    // The intro plays once per arrival on this page. That means a real
    // hidden -> shown transition OR landing on a different blank session
    // (creating one is a fresh visit) — but never on the many incidental
    // re-renders of the same session. Inside a session it is fully stopped,
    // so nothing decodes.
    if (show && (!landingWasVisible || introPlayedFor !== active.id)) {
        introPlayedFor = active.id;
        startIntro();
    } else if (!show) {
        stopIntro();
    }

    landingWasVisible = show;
}

function dismissLanding() {
    if (active) landingDismissed.add(active.id);
    updateLanding();
}

$("landing-skip").addEventListener("click", () => { dismissLanding(); composer.focus(); });
$("landing-link").addEventListener("click", () => linkRepo());

// Stop spending CPU/GPU on the animation when it cannot be seen.
// The blur/focus pair is load-bearing on Windows: Electron does not report
// window occlusion there, so visibilityState stays "visible" even when another
// window fully covers us — the backdrop would keep compositing while the model
// generates. Do not remove these.
const video = $("landing-video");
const soundBtn = $("intro-sound");
let introMuted = false;

// The clip's audio rises all the way to its last frame, so it ends abruptly.
// Ramp the gain down over the tail instead of re-encoding the file — no quality
// loss, the asset stays pristine, and the curve stays tunable here.
const INTRO_FADE_SEC = 1.6;
let fadeTimer = null;

function stopVolumeFade() {
    if (fadeTimer) {
        clearInterval(fadeTimer);
        fadeTimer = null;
    }
}

function startVolumeFade() {
    stopVolumeFade();
    if (!video) return;

    video.volume = 1;
    fadeTimer = setInterval(() => {
        const d = video.duration;
        if (!isFinite(d) || d <= 0) return;

        const remaining = d - video.currentTime;
        if (remaining > INTRO_FADE_SEC) {
            if (video.volume !== 1) video.volume = 1;
            return;
        }

        // quadratic taper: perceptually smoother than a straight linear ramp
        const t = Math.max(0, Math.min(1, remaining / INTRO_FADE_SEC));
        video.volume = t * t;
    }, 40);
}

if (video) {
    video.addEventListener("ended", () => {
        stopVolumeFade();
        video.volume = 0;          // land on silence, not a clipped tail
    });
    video.addEventListener("pause", stopVolumeFade);
}

function setSoundUI() {
    if (!soundBtn) return;
    soundBtn.classList.toggle("muted", introMuted);
    $("intro-sound-icon").innerText = introMuted ? "✕" : "♪";
    soundBtn.title = introMuted ? "Unmute the intro" : "Mute the intro";
}

/** Play the intro from the start. One shot — the element does not loop. */
async function startIntro() {
    if (!video || motionMode() !== "full") return;

    try { video.currentTime = 0; } catch { /* not seekable yet */ }
    video.muted = introMuted;
    video.volume = 1;

    try {
        await video.play();
        startVolumeFade();
    } catch {
        // Chromium's autoplay policy can refuse AUDIBLE playback without a user
        // gesture. Retry silently so the intro still shows, and reflect that in
        // the control rather than pretending sound is on.
        introMuted = true;
        video.muted = true;
        setSoundUI();
        try { await video.play(); } catch { /* give up quietly */ }
    }
}

function stopIntro() {
    if (video) video.pause();
}

/**
 * Pause/resume without rewinding. Pausing the element stops H.264 decode, which
 * is the real cost — a CSS-only pause would keep decoding.
 */
function setAnimPaused(paused) {
    landingEl.classList.toggle("paused", paused);
    if (!video) return;

    const shouldRun = !paused
        && motionMode() === "full"
        && !landingEl.classList.contains("hidden")
        && !video.ended;                     // a finished one-shot stays finished

    if (shouldRun) {
        video.play().then(startVolumeFade).catch(() => {});
    } else {
        video.pause();          // the 'pause' listener clears the fade timer
    }
}

if (soundBtn) {
    soundBtn.addEventListener("click", () => {
        introMuted = !introMuted;
        if (video) video.muted = introMuted;
        setSoundUI();
        window.lcl.setIntroSound(!introMuted);
        // unmuting counts as a user gesture, so audible playback is allowed now
        if (!introMuted && video && !video.ended) video.play().catch(() => {});
    });
}

document.addEventListener("visibilitychange", () => setAnimPaused(document.hidden));
window.addEventListener("blur", () => setAnimPaused(true));
window.addEventListener("focus", () => setAnimPaused(document.hidden));

// ---- motion mode: full (play) / still (frame 0, no further decode) ----
const motion = {
    pref: "auto",                                       // auto | on | off
    reduce: matchMedia("(prefers-reduced-motion: reduce)"),
    software: false,
    battery: false
};

function motionMode() {
    if (motion.pref === "off") return "still";
    if (motion.pref === "on") return "full";            // explicit user override wins
    if (motion.reduce.matches) return "still";
    // Software rendering means CPU-decoding 720p24 next to inference. On battery
    // with a working GPU, hardware decode is cheap enough to keep the animation.
    if (motion.software) return "still";
    return "full";
}

function applyMotion() {
    const mode = motionMode();
    document.documentElement.setAttribute("data-motion", mode);

    if (video) {
        if (mode === "full") setAnimPaused(document.hidden || !document.hasFocus());
        else video.pause();                             // current frame stays painted
    }
    setSoundUI();

    // THE VALUE GOES IN THE VALUE SLOT. This used to write textContent on the
    // whole button, which DELETED the <span class="menu-value"> the markup
    // ships and syncMenuState() writes — so from the first applyMotion() at
    // boot the row was a flat string and every later state update went into a
    // span that no longer existed. Two writers, one of them destroying the
    // other's element, is why the row could disagree with the setting.
    const b = document.querySelector('.menu-panel button[data-action="toggle-motion"]');
    const slot = b && b.querySelector(".menu-value");
    if (slot) slot.innerText = ({ auto: "auto", on: "on", off: "off" }[motion.pref] || "auto");
}

motion.reduce.addEventListener("change", applyMotion);
applyMotion();

// =============================================================
// PROGRESS
// =============================================================
let progressTimer = null;
let progressStart = 0;
let liveBubble = null;      // the status bubble for the in-flight turn

/**
 * ONE WORDING PER STEP, EVERYWHERE. The live status bubble, the mid-turn
 * activity replay and the persisted meta.steps transcript all draw their
 * lines from HERE — what you watched happen live and what the transcript
 * shows after a re-render or a restart are literally the same strings. The
 * engine decides what persists (agent.js recordStep); this only decides how
 * a phase reads. Returns {kind, text}, or null for phases with no step line.
 */
function stepLine(phase, d = {}) {
    switch (phase) {
        case "planning":
            return { kind: "think",
                     text: `✎ thinking through a plan${d.model ? ` · ${d.model}` : ""}` };
        case "plan-confirm":
            return { kind: "warn",
                     text: "⏸ plan ready — nothing builds until you say go" };
        case "tool":
            return { kind: "tool",
                     text: `▸ ${d.tool}${d.digest ? ` — ${d.digest}` : (d.path ? ` — ${d.path}` : "")}` };
        case "tool-done":
            return { kind: d.failed ? "bad" : "good",
                     text: `${d.failed ? "✗" : "✓"} ${d.tool}${d.summary ? ` — ${d.summary}` : ""}` };
        case "tool-progress":
            return { kind: "note", text: `· ${d.note || ""}` };
        case "correcting":
            return { kind: "warn", text: `↻ ${d.reason || "correcting a wrong refusal"}` };
        case "clarify":
            return { kind: "ask", text: "asked for details rather than guessing" };
        case "grounding":
            return { kind: "note",
                     text: `📚 grounded on ${d.sources} passage${d.sources === 1 ? "" : "s"} from your knowledge library`
                         + (d.top ? ` · top: ${d.top}` : "") };
        case "denied":
            return { kind: "bad", text: `⛔ ${d.tool} denied — ${d.reason || "policy"}` };
        case "needs-approval":
            return { kind: "warn", text: `⏸ ${d.tool} needs your approval` };
        case "script-proposed":
            return { kind: "warn",
                     text: `⏸ script proposed${d.lines ? ` (${d.lines} lines)` : ""} — nothing runs until you approve` };
        case "script-refused":
            return { kind: "bad", text: `✗ script refused${d.reason ? ` — ${d.reason}` : ""}` };
        case "spin-warned":
            return { kind: "warn",
                     text: `↻ ${d.tool} repeated ${d.repeats} times with identical arguments — told to stop and do the work` };
        case "spin-stopped":
            return { kind: "bad",
                     text: `✗ stopped — ${d.tool} called ${d.repeats} times in a row with identical results` };
        case "step-limit":
            return { kind: "warn",
                     text: `⏸ paused at the ${d.limit}-step limit${d.dropped ? ` — next would have been ${d.dropped}` : ""}; send "continue" to carry on` };
        case "fabricated-tool-result":
            return { kind: "warn",
                     text: `↻ the model wrote pretend tool results${d.besideCall ? ` beside its ${d.besideCall} call` : ""} — stripped, and told to call the tool for real` };
        case "audit-done":
            if (d.forcing) return { kind: "warn",
                text: `🜂 Ancient Knowledge · gaps found in round ${d.round} — forcing a response` };
            if (d.error) return { kind: "bad",
                text: "🜂 Ancient Knowledge · audit failed" };
            if (d.stopped) {
                const clean = d.stopped === "closed" || d.stopped === "user-test";
                return { kind: clean ? "good" : "warn",
                    text: `🜂 Ancient Knowledge · stopped after ${d.rounds || 1} round${d.rounds === 1 ? "" : "s"}`
                        + ` — ${AK_STOP[d.stopped] || d.stopped}` };
            }
            return null;
        default:
            return null;
    }
}

const PHASE_TEXT = {
    "planning": "thinking through a plan",
    "plan-confirm": "waiting for your go-ahead",
    "sent": "waiting for the model",
    "thinking": "thinking",
    "thinking-again": "thinking",
    "generating": "writing",
    "reasoning": "reasoning",
    "grounding": "grounding",
    "clarify": "asking",
    "correcting": "correcting itself",
    "tool": "running tool",
    "tool-progress": "working",
    "tool-done": "tool finished",
    "denied": "blocked by policy",
    "needs-approval": "waiting for approval",
    "script-proposed": "waiting for approval",
    "script-refused": "script refused",
    "spin-warned": "breaking a repeat loop",
    "spin-stopped": "stopped repeating itself",
    "step-limit": "paused at the step limit",
    "fabricated-tool-result": "correcting invented results",
    // the audit pass gets its own phase, so the wait while four reviewers
    // read the work is legible instead of a silent stretch of "writing"
    "audit": "reviewing its own work",
    "audit-reviewer": "reviewing its own work",
    "audit-done": "audit finished",
    "done": "finishing up"
};

/**
 * WHY THE AUDIT STOPPED, IN THE OPERATOR'S FEED.
 *
 * Mirrors ancientKnowledge.STOP_WORDS. The renderer cannot require an engine
 * module, so this is a copy — and a copy that drifts is worse than none, so
 * tests/ancient-knowledge-orchestrated.js fails the build if the two ever
 * disagree on a key or lose one.
 *
 * Every exit is named on purpose. The one thing that must never happen here
 * is an audit that ends with nothing in the feed: that is indistinguishable
 * from an audit that quietly gave up, which is exactly what was
 * reported — the audit just stopped and the model ran away unguided.
 */
const AK_STOP = {
    "closed": "all gaps closed",
    "user-test": "awaiting your function test",
    "nothing-new": "the audit stopped finding new gaps",
    "no-progress": "the model did no work that round — asking again will not change it; gaps remain OPEN",
    "rounds": "round ceiling reached — gaps remain OPEN",
    "budget": "spend ceiling reached — gaps remain OPEN",
    "review-unavailable": "the auditor did not answer — completion NOT verified",
    "cancelled": "cancelled by you",
    "round-failed": "the forced response failed — gaps remain OPEN",
    "no-response": "there was nothing to audit",
    "awaiting-approval": "waiting on your approval — gaps remain OPEN"
};

function startProgress(bubble, startedAt) {
    liveBubble = bubble;
    // a restored bubble keeps the ORIGINAL start time, so the elapsed counter
    // reads true after a session switch instead of restarting at 0s
    progressStart = startedAt || Date.now();
    clearInterval(progressTimer);
    progressTimer = setInterval(() => {
        if (!liveBubble || !liveBubble._elapsed) return;
        const s = Math.floor((Date.now() - progressStart) / 1000);
        liveBubble._elapsed.innerText = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
    }, 500);
}

function stopProgress() {
    clearInterval(progressTimer);
    progressTimer = null;
    // the waiting counter belongs to the turn — a cancelled or failed turn
    // must not leave a timer ticking against a bubble nobody is watching
    if (liveBubble && liveBubble._waitTimer) {
        clearInterval(liveBubble._waitTimer);
        liveBubble._waitTimer = null;
    }
    liveBubble = null;
}

/** Cancel the in-flight turn from the composer button. */
async function cancelTurn() {
    if (!pending) return;
    if (liveBubble) {
        liveBubble._phase.innerText = "stopping";
        liveBubble._detail.innerText = "";
    }
    await window.lcl.cancelChat(active && active.id);
}

// =============================================================
// TASK PANEL — live orchestrator plan/steps in the workspace sidebar
// =============================================================
const taskEls = new Map();   // task id -> row element

/**
 * Draw or update one task row. The live IPC stream and the durable ledger both
 * go through here, so a row restored after a restart is indistinguishable from
 * a live one — and a later update from the running job lands on that same row
 * instead of creating a duplicate.
 */
function renderTask(task) {
    $("task-panel").classList.remove("hidden");

    let row = taskEls.get(task.id);
    if (!row) {
        row = document.createElement("div");
        row.className = "task-row";
        const dot = document.createElement("span"); dot.className = "task-dot";
        const body = document.createElement("div"); body.className = "task-body";
        const title = document.createElement("div"); title.className = "task-title";
        const detail = document.createElement("div"); detail.className = "task-detail";
        // the bar: actual progress, because "running for 4 minutes" answers
        // nothing — hidden until a task reports a real total
        const bar = document.createElement("div"); bar.className = "task-bar hidden";
        const fill = document.createElement("div"); fill.className = "task-bar-fill";
        bar.appendChild(fill);
        body.appendChild(title); body.appendChild(detail); body.appendChild(bar);
        // Long work must be stoppable. The button trips a cancel token the
        // worker polls, so it stops at a safe point rather than being severed
        // mid-file — the index stays consistent either way.
        const stop = document.createElement("button");
        stop.className = "task-stop hidden";
        stop.innerText = "Stop";
        stop.title = "Stop this task";
        stop.addEventListener("click", async () => {
            stop.disabled = true;
            detail.innerText = "stopping…";
            try { await window.lcl.cancelTask(task.id); } catch { /* reported by the stream */ }
        });
        row.appendChild(dot); row.appendChild(body); row.appendChild(stop);
        row._title = title; row._detail = detail; row._dot = dot; row._stop = stop;
        row._bar = bar; row._fill = fill;
        $("task-list").appendChild(row);
        taskEls.set(task.id, row);
    }

    if (task.title) {
        row._title.innerText = task.title;
        // the full line survives any clipping a narrow quadrant cell does
        row._title.title = task.title;
    }
    // mirrors eta.human() in the engine — kept short enough for a progress row
    function fmtDuration(ms) {
        const s = Math.round(ms / 1000);
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60), rs = s % 60;
        if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
        const h = Math.floor(m / 60), rm = m % 60;
        return rm ? `${h}h ${rm}m` : `${h}h`;
    }
    if (task.detail !== undefined) row._detail.innerText = task.detail || "";
    const status = task.status || "running";
    // real progress when the task knows its total: count, percent, and a bar.
    // An interrupted job keeps its frozen bar — "stopped at 312/1449" is
    // information; a bar that vanishes on interruption is amnesia.
    const total = +task.total || 0;
    if (total > 0 && (status === "running" || status === "interrupted")) {
        const n = Math.min(+task.n || 0, total);
        const pct = Math.floor((n / total) * 100);
        // TIME REMAINING, when the app honestly has one. It starts absent — a
        // machine that has never done this work does not know how long it takes,
        // and a made-up duration is worse than a blank. Once a rate exists it
        // appears and keeps sharpening as the run proves itself, so the number
        // you glance at after ten seconds is better than the one at submit.
        // The "~" stays until the estimate is driven purely by the live rate.
        const eta = status === "running" && task.etaMs > 0
            ? ` · ${task.etaBasis === "live" ? "" : "~"}${fmtDuration(task.etaMs)} left`
            : "";
        row._title.innerText = `${task.title || ""} — ${n}/${total} (${pct}%)${eta}`;
        // the live count and ETA must never be lost to a narrow cell's edge —
        // the tooltip carries the whole line
        row._title.title = row._title.innerText;
        row._bar.classList.remove("hidden");
        row._fill.style.width = pct + "%";
    } else {
        row._bar.classList.add("hidden");
    }
    row.className = "task-row " + status;
    // only offer Stop for work that is running AND reachable from this process
    row._stop.classList.toggle("hidden", !(status === "running" && task.cancellable));
    if (status === "running") row._stop.disabled = false;
    return row;
}

// An OS notification was clicked: open the session that is waiting, so the card
// is the first thing on screen rather than something to go hunting for.
window.lcl.onFocusSession(async ({ sessionId }) => {
    if (!sessionId) return;
    if (!active || active.id !== sessionId) { try { await switchSession(sessionId); } catch { /* gone */ } }
    scrollToBottom();
});

window.lcl.onTask((task) => {
    // library indexing is app-scoped: it outlives a session switch and can be
    // started with no session at all, so it must not be filtered by session —
    // otherwise its row never updates and sticks on "running" forever
    if (task.scope !== "library" && (!active || task.sessionId !== active.id)) return;
    // a running plan is worth seeing — surface the panel
    if (!workspaceOpen()) toggleWorkspace(true);
    renderTask(task);
});

/**
 * Re-hydrate the panel from the DURABLE ledger at startup.
 *
 * Without this an hour-long index simply disappears from view when the app
 * restarts, and a job the app interrupted looks like it never happened. The
 * ledger reclassifies anything still marked running in a dead process as
 * "interrupted", so that state becomes visible rather than silent — which is
 * the whole point: the app must never lose sight of its own work.
 */
async function restoreTasks() {
    let res = null;
    try { res = await window.lcl.listTasks({ limit: 25 }); } catch { return; }
    let rows = (res && res.tasks) || [];
    // THE PANEL IS PER-SESSION. The ledger's rows carry sessionId/scope now;
    // hydration shows only the ACTIVE session's work plus app-scoped library
    // jobs — never another conversation's servers ("4 stale rows, all serving
    // the workspace"). Legacy rows written before the schema carried identity
    // have neither field; they stay hidden rather than painted into whatever
    // session happens to be open.
    rows = rows.filter(t => t.scope === "library"
        || (t.sessionId && active && t.sessionId === active.id));
    if (!rows.length) return;
    // oldest first, so the newest ends up at the bottom like the live stream
    for (const t of rows.slice().reverse()) {
        renderTask({
            id: t.id, title: t.title, status: t.status,
            detail: t.status === "interrupted"
                ? (t.note || "the app stopped before this finished")
                : (t.detail || ""),
            // the ledger carries the last-known progress in meta, so a
            // restarted app still shows how far an interrupted job got
            n: t.meta && t.meta.n, total: t.meta && t.meta.total,
            // only a task whose cancel token still lives in THIS process can be
            // stopped; a restored row from a dead process cannot
            cancellable: !!(t.cancellable && t.live)
        });
    }
}

$("task-panel-clear").addEventListener("click", async () => {
    for (const [id, row] of taskEls) {
        if (row.classList.contains("done") || row.classList.contains("failed")
            || row.classList.contains("cancelled") || row.classList.contains("interrupted")) {
            row.remove(); taskEls.delete(id);
        }
    }
    try { await window.lcl.clearFinishedTasks(); } catch { /* ledger is best-effort */ }
    if (!taskEls.size) $("task-panel").classList.add("hidden");
});

// =============================================================
// ACTIVITY — every consequential step, per session, KEPT.
// The live bubble's log dies with each re-render; this feed is the durable
// record: which tool, what it was given, what came back, and how long it took.
// =============================================================
const sessionActivity = new Map();     // sessionId -> [{at, kind, text, detail}]
const ACTIVITY_CAP = 300;

function recordActivity(sessionId, kind, text, detail = "") {
    if (!sessionId) return;
    let log = sessionActivity.get(sessionId);
    if (!log) { log = []; sessionActivity.set(sessionId, log); }
    log.push({ at: Date.now(), kind, text: String(text), detail: String(detail || "") });
    if (log.length > ACTIVITY_CAP) log.splice(0, log.length - ACTIVITY_CAP);
    if (active && active.id === sessionId) appendActivityRow(log[log.length - 1]);
}

function appendActivityRow(entry) {
    const list = $("activity-list");
    $("activity-panel").classList.remove("hidden");
    const row = document.createElement("div");
    row.className = "act-row " + entry.kind;
    const time = document.createElement("span");
    time.className = "act-time";
    // a row rebuilt from the transcript has no clock of its own — an honest
    // dot beats a fabricated timestamp
    time.innerText = entry.at
        ? new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
        : "·";
    const text = document.createElement("span");
    text.className = "act-text";
    text.innerText = entry.text;
    row.appendChild(time); row.appendChild(text);
    if (entry.detail) {
        // click expands the full detail — a real action, so the row is a control
        const d = document.createElement("div");
        d.className = "act-detail hidden";
        d.innerText = entry.detail;
        row.appendChild(d);
        row.classList.add("expandable");
        row.addEventListener("click", () => d.classList.toggle("hidden"));
    }
    list.appendChild(row);
    list.scrollTop = list.scrollHeight;
}

/**
 * THE FEED SURVIVES A RESTART. sessionActivity is in-memory, so a patch (or
 * any app restart) used to blank the Activity panel of a session that has a
 * whole history — "this session had history of that is no longer present
 * after the patch." The transcript already persists every consequential step
 * (assistant meta.steps); an empty feed rebuilds itself from them.
 */
function hydrateActivityFromTranscript(session) {
    const KEEP = new Set(["planning", "plan-confirm", "tool", "tool-done",
        "clarify", "grounding", "denied", "needs-approval", "correcting"]);
    const out = [];
    for (const m of (session.messages || [])) {
        if (!m || !m.meta || !Array.isArray(m.meta.steps)) continue;
        for (const st of m.meta.steps) {
            if (!st || !KEEP.has(st.phase)) continue;
            let l = null;
            try { l = stepLine(st.phase, st.d || {}); } catch { /* shape drift */ }
            if (!l) continue;
            const d = st.d || {};
            out.push({ at: 0, kind: l.kind, text: l.text,
                       detail: String(d.summary || d.digest || d.path
                                      || d.question || d.reason || "") });
        }
    }
    return out.slice(-ACTIVITY_CAP);
}

// a session the operator CLEARED stays cleared this run — without this, the
// transcript hydration would resurrect the feed one render after the clear
const activityCleared = new Set();

function renderActivity() {
    const list = $("activity-list");
    list.innerHTML = "";
    let log = sessionActivity.get(active && active.id) || [];
    if (!log.length && active && !activityCleared.has(active.id)) {
        log = hydrateActivityFromTranscript(active);
        if (log.length) sessionActivity.set(active.id, log);
    }
    $("activity-panel").classList.toggle("hidden", log.length === 0);
    for (const e of log) appendActivityRow(e);
}

$("activity-clear").addEventListener("click", () => {
    if (active) {
        sessionActivity.delete(active.id);
        activityCleared.add(active.id);
    }
    renderActivity();
});

// LIVE WORKSPACE REFRESH — a file the model just wrote has to show up in the
// panel NOW, not at turn end. During a long turn the device got flashed
// mid-turn while the file panel sat stale until the whole (sometimes
// minutes-long) turn finished: "it writes the logic to the device but not the
// workspace". Coalesced so a burst of edits does not thrash the re-read.
const FILE_WRITING_TOOLS = new Set([
    "write_file", "edit_file", "move_file", "make_dir", "delete_file",
    "generate_image", "build_model", "draw_diagram", "export_schematic",
    "edit_image", "edit_pdf", "media_transform", "capture_drawing", "redline_drawing"
]);
let wsLiveRefreshTimer = null;
function scheduleWsLiveRefresh() {
    if (wsLiveRefreshTimer) return;
    wsLiveRefreshTimer = setTimeout(() => {
        wsLiveRefreshTimer = null;
        if (workspaceOpen()) loadWorkspaceFiles();
        if (viewerPath) openFileViewer(viewerPath);   // re-read the open file too
    }, 400);
}

window.lcl.onProgress((info) => {
    // the durable activity feed sees EVERY session's events, viewed or not
    const d0 = info.detail || {};
    // a file-writing tool finished in the VIEWED session — refresh the panel
    // live so the workspace tracks the device instead of lagging a whole turn.
    if (info.phase === "tool-done" && !d0.failed && active &&
        info.sessionId === active.id && FILE_WRITING_TOOLS.has(d0.tool)) {
        scheduleWsLiveRefresh();
    }
    switch (info.phase) {
        case "tool": {
            const l = stepLine("tool", d0);
            recordActivity(info.sessionId, l.kind, l.text, d0.digest || d0.path || "");
            break;
        }
        case "tool-done": {
            const l = stepLine("tool-done", d0);
            recordActivity(info.sessionId, l.kind, l.text, d0.summary || "");
            // THE WORK ROW, LIVE IN THE CHAT LOG. The event carries the full
            // tool message (document included); if the viewer is watching this
            // session, the row lands NOW — expandable, permanent-looking —
            // instead of the whole turn hiding inside the thinking bubble.
            // The end-of-turn re-render replaces it with the persisted copy.
            if (d0.msg && active && info.sessionId === active.id) {
                try {
                    const el = addToolBubble(d0.msg);
                    el.classList.add("live-row");
                    // keep the thinking bubble LAST. The selector said ".typing"
                    // for an era while the class said "msg-typing", so this
                    // re-append was dead and every live tool row stacked BELOW
                    // the bubble — burying the only liveness indicator at the
                    // top of a long turn. Reported: "you keep the thinking
                    // portion at the top. it doesnt move down as it prints."
                    const t = chat.querySelector(".msg-typing");
                    if (t) chat.appendChild(t);
                    scrollToBottom(false);
                } catch { /* the durable feed above still recorded it */ }
            }
            break;
        }
        case "clarify": {
            const l = stepLine("clarify", d0);
            recordActivity(info.sessionId, l.kind, l.text, d0.question || "");
            break;
        }
        case "grounding": {
            const l = stepLine("grounding", d0);
            recordActivity(info.sessionId, l.kind, l.text, d0.top || "");
            break;
        }
        case "denied": {
            const l = stepLine("denied", d0);
            recordActivity(info.sessionId, l.kind, l.text, d0.reason || "");
            break;
        }
        case "needs-approval": {
            const l = stepLine("needs-approval", d0);
            recordActivity(info.sessionId, l.kind, l.text, "");
            break;
        }
        // THE ONCE-LIVE-ONLY PHASES, NOW KEPT — so the mid-turn replay after
        // a session switch shows the same run the viewer watched live. The
        // tick phases (sent / generating / reasoning) stay live-only by
        // design: a counter is not a record.
        case "correcting":
        case "script-proposed":
        case "script-refused":
        case "spin-warned":
        case "spin-stopped":
        case "step-limit":
        case "fabricated-tool-result":
        case "planning":
        case "plan-confirm": {
            const l = stepLine(info.phase, d0);
            if (l) recordActivity(info.sessionId, l.kind, l.text, "");
            break;
        }
        case "tool-progress": {
            // milestones only — bar frames (pct / indeterminate) and
            // "step N/M" counters are live ticks, not records; the engine's
            // recordStep makes exactly the same cut for meta.steps
            if (typeof d0.pct === "number" || d0.indeterminate
                || /step \d+\/\d+/.test(String(d0.note || ""))) break;
            const l = stepLine("tool-progress", d0);
            recordActivity(info.sessionId, l.kind, l.text, "");
            break;
        }
        // THE REVIEW IS KEPT, NOT JUST WATCHED. What each mandate came back
        // with is exactly the kind of thing the durable feed exists for: it is
        // the evidence behind "done", and it must outlive the live bubble.
        case "audit":
            // ANCIENT KNOWLEDGE SHARES THIS PHASE AND IS NOT THE SAME THING.
            // The self-review panel sets d0.status; the audit sets
            // d0.phase === "ancient-knowledge" and never a status, so every
            // round of it fell through this whole block and left no trace in
            // the durable feed. A long orchestrated goal could then run its
            // audit for minutes with nothing recorded — one of the ways the
            // feature read as "it just stopped".
            if (d0.phase === "ancient-knowledge") {
                recordActivity(info.sessionId, "note",
                    `🜂 Ancient Knowledge · interrogating round ${d0.round}` +
                    (d0.of ? ` of ${d0.of}` : ""), "");
                break;
            }
            if (d0.status === "reviewed") {
                recordActivity(info.sessionId, d0.found ? "warn" : "good",
                    `⚖ review round ${d0.round}: ` +
                    (d0.found ? `${d0.found} finding${d0.found === 1 ? "" : "s"}` +
                        (d0.contested ? `, ${d0.contested} contested` : "")
                              : "no objections"),
                    d0.fresh !== undefined ? `${d0.fresh} new this round` : "");
            } else if (d0.status === "repairing") {
                recordActivity(info.sessionId, "note",
                    `⚙ fixing ${d0.fixing} issue${d0.fixing === 1 ? "" : "s"} from review`, "");
            }
            break;
        case "audit-reviewer":
            if (d0.status && d0.status !== "running") {
                recordActivity(info.sessionId, d0.count ? "warn" : "note",
                    `⚖ ${d0.label}: ${d0.detail || ""}`, "");
            }
            break;
        // HOW THE AUDIT ENDED, ALWAYS. A forced round records that it is
        // forcing; a terminal round records the named stop. An exit with
        // nothing in the feed is the failure mode this whole case exists to
        // rule out — the operator has to be able to tell "it passed" from
        // "it gave up" without opening a file.
        case "audit-done":
            if (d0.forcing) {
                recordActivity(info.sessionId, "warn",
                    `🜂 Ancient Knowledge · gaps found in round ${d0.round} — ` +
                    `forcing a response`, "");
            } else if (d0.error) {
                recordActivity(info.sessionId, "bad",
                    `🜂 Ancient Knowledge · audit failed`, d0.error);
            } else if (d0.stopped) {
                const clean = d0.stopped === "closed" || d0.stopped === "user-test";
                recordActivity(info.sessionId, clean ? "good" : "warn",
                    `🜂 Ancient Knowledge · stopped after ` +
                    `${d0.rounds || 1} round${d0.rounds === 1 ? "" : "s"}`,
                    AK_STOP[d0.stopped] || d0.stopped);
            }
            break;
    }

    if (!active || info.sessionId !== active.id || !liveBubble) return;

    liveBubble._phase.innerText = PHASE_TEXT[info.phase] || info.phase;
    const d = info.detail || {};

    // The single overwriting line is gone: each event becomes a step in the
    // log, so the whole run stays visible — the real tool, the real args,
    // the real result.
    switch (info.phase) {
        case "thinking":
        case "thinking-again":
            liveBubble._detail.innerText = d.model ? `· ${d.model}` : "";
            pushActivity(liveBubble, "think",
                (info.phase === "thinking" ? "thinking" : "thinking again")
                + (d.model ? ` · ${d.model}` : ""));
            if (liveBubble._preview) {
                liveBubble._preview.innerText = "";
                liveBubble._preview.classList.add("hidden");
            }
            break;
        case "sent":
            // THE WAIT BEFORE THE FIRST TOKEN, COUNTED OUT LOUD.
            //
            // A big model has to be paged in before it can answer — minutes
            // for a 100 GB one — and nothing streamed during that, so the app
            // sat silent and looked hung. This ticks, names the model and the
            // machine, and says what the silence IS.
            if (liveBubble._waitTimer) clearInterval(liveBubble._waitTimer);
            {
                const t0 = d.at || Date.now();
                // d.where is already a full phrase ("spark — your machine"),
                // so prefixing another "on" produced "on spark on spark — your
                // machine". One preposition, from one place.
                const where = d.where ? ` · ${d.where}` : "";
                const tick = () => {
                    const s = Math.round((Date.now() - t0) / 1000);
                    liveBubble._detail.innerText = `· waiting ${s}s`;
                    // THE SILENCE MEANS A DIFFERENT THING PER DESTINATION.
                    //
                    // The "large model is loaded into memory" phrase was
                    // appended to ANY wait over 20s, regardless of where the
                    // model runs — so a hosted API call claimed a local load
                    // that was not happening, and a turn to the user's own
                    // Spark claimed this laptop was paging a 100 GB GGUF when
                    // the Spark already had it resident. Each is a different
                    // lie, and the silence is real enough that the words
                    // alongside it have to be the true ones.
                    let note = "";
                    if (s > 20) {
                        if (d.remote && d.node) {
                            // the model loads on the NODE, not here — and only
                            // if it is not already resident there
                            note = " (the model is being paged in on your node " +
                                   "before it can answer; this is that)";
                        } else if (d.remote) {
                            // an API call: nothing loads locally; the wait is
                            // the provider's queue / network, not a local load
                            note = " (waiting on the provider; nothing is " +
                                   "loading on this machine)";
                        } else {
                            // the one case the original phrase was true for:
                            // a local GGUF being paged into this laptop's RAM
                            note = " (a large model is loaded into memory " +
                                   "before it can answer; this is that)";
                        }
                    }
                    pushActivity(liveBubble, "sent",
                        `sent to ${d.model || "the model"}${where} — waiting ${s}s` + note, true);
                };
                tick();
                liveBubble._waitTimer = setInterval(tick, 1000);
            }
            break;
        case "generating":
            // the first token has landed — stop counting the silence
            if (liveBubble._waitTimer) {
                clearInterval(liveBubble._waitTimer);
                liveBubble._waitTimer = null;
            }
            // the stream itself: live token count, tokens/s, and the text
            // taking shape — the model visibly working, not a spinner
            liveBubble._detail.innerText =
                `· ${d.tokens || 0} tokens${d.tps ? ` · ${d.tps} t/s` : ""}`;
            {
                // % of the reply-token cap actually in force — agent.js keeps
                // the budget live across refits and fallbacks. Capacity, not
                // time: capped at 99 because the model, not the count, decides
                // when it is done, and most replies rightly finish far below
                // 100% — that is honesty, not a stuck bar.
                const budget = Number(d.budget) || 0;
                const used = budget > 0
                    ? Math.min(99, Math.round(((d.tokens || 0) / budget) * 100)) : null;
                pushActivity(liveBubble, "gen",
                    `writing — ${d.tokens || 0} tokens${d.tps ? ` · ${d.tps} t/s` : ""}`
                    + (used !== null ? ` · ${used}% of reply budget` : ""),
                    true, used !== null ? { pct: used } : null);
            }
            if (liveBubble._preview && typeof d.preview === "string" && d.preview) {
                liveBubble._preview.classList.remove("hidden");
                liveBubble._preview.innerText =
                    (d.preview.length >= 240 ? "…" : "") + d.preview;
            }
            break;
        case "tool": {
            liveBubble._detail.innerText = `· ${d.tool}`;
            const l = stepLine("tool", d);
            pushActivity(liveBubble, l.kind, l.text);
            break;
        }
        case "clarify": {
            // asking for what it needs is a real outcome, not a failure
            const l = stepLine("clarify", d);
            pushActivity(liveBubble, l.kind, l.text);
            break;
        }
        case "correcting": {
            const l = stepLine("correcting", d);
            pushActivity(liveBubble, l.kind, l.text);
            break;
        }
        case "grounding": {
            // the model was handed real passages from the user's library, with
            // citations — show it, so a grounded answer is visibly grounded
            const l = stepLine("grounding", d);
            pushActivity(liveBubble, l.kind, l.text);
            break;
        }
        case "reasoning":
            // stop the sent timer — reasoning is now the live status
            if (liveBubble._waitTimer) { clearInterval(liveBubble._waitTimer); liveBubble._waitTimer = null; }
            // A reasoning model thinks out loud before it answers. Shown so the
            // work is visible, and updated in place so a thousand words of chain
            // of thought does not bury the run history. It is NEVER parsed for
            // tool calls — see router.js: the model writing "I should call
            // read_file" while thinking is not a decision to call it.
            pushActivity(liveBubble, "note",
                `thinking… ${(d.chars || 0).toLocaleString()} characters`, true);
            break;
        case "tool-progress": {
            // Milestones stay as their own lines — "model unloaded", "loading
            // SDXL-Turbo", "decoding" each remain visible in the run history.
            // A note carrying pct / etaMs / indeterminate is a PROGRESS BAR
            // frame: it draws as a real bar and updates IN PLACE (bars replace
            // only bars — see pushActivity — so a ticking bar can never
            // swallow the milestone notes around it). Plain "step N/M"
            // counters keep updating in place as before.
            const l = stepLine("tool-progress", d);
            const bar = (typeof d.pct === "number" && isFinite(d.pct)) ? { pct: d.pct }
                      : (d.indeterminate ? { indeterminate: true } : null);
            const ticking = !!bar || /step \d+\/\d+/.test(String(d.note || ""));
            pushActivity(liveBubble, l.kind, l.text, ticking, bar);
            break;
        }
        case "tool-done": {
            const l = stepLine("tool-done", d);
            pushActivity(liveBubble, l.kind, l.text);
            break;
        }
        case "denied": {
            const l = stepLine("denied", d);
            pushActivity(liveBubble, l.kind, l.text);
            break;
        }
        case "needs-approval": {
            const l = stepLine("needs-approval", d);
            pushActivity(liveBubble, l.kind, l.text);
            break;
        }
        case "script-proposed": {
            const l = stepLine("script-proposed", d);
            pushActivity(liveBubble, l.kind, l.text);
            break;
        }
        case "script-refused": {
            const l = stepLine("script-refused", d);
            pushActivity(liveBubble, l.kind, l.text);
            break;
        }
        // the phases that used to exist only as a headline (or not at all) —
        // one stepLine each, so the live log, the mid-turn replay and the
        // persisted transcript agree on the wording, string for string
        case "planning":
        case "plan-confirm":
        case "spin-warned":
        case "spin-stopped":
        case "step-limit":
        case "fabricated-tool-result":
        case "audit-done": {
            const l = stepLine(info.phase, d);
            if (l) pushActivity(liveBubble, l.kind, l.text);
            break;
        }
    }
});

// =============================================================
// HEADER
// =============================================================
function folderName(p) {
    if (!p) return "";
    const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

function renderHeader() {
    // "undefined" WAS THE SESSION TITLE ON SCREEN.
    //
    // `active ? active.title : ".lcl"` prints the string "undefined" the moment
    // a session record reaches the renderer without a title — which is every
    // session created before one is derived from the first message, and every
    // session restored from a file written by an older build. The session LIST
    // has always used `s.title || "Untitled"` two hundred lines below; the
    // header was the one surface that trusted the field. Same fallback, so the
    // two rows can never say different things about the same session.
    titleEl.innerText = active ? (active.title || "Untitled") : ".lcl";

    if (active && active.repoPath) {
        // the folder NAME in the header; the full path lives once, on the
        // chip's hover — it was printed three times on one screen
        subtitleEl.innerText = `workspace · ${folderName(active.repoPath)}`;
        subtitleEl.classList.add("linked");
        linkBtn.classList.add("linked");
        linkBtn.title = "Change the workspace folder (Ctrl+O)";
        // Say what the chip IS. A bare folder name under the message bar read
        // as a mystery word — "what is the little thing that says test".
        composerWorkspaceEl.innerText = `workspace: ${folderName(active.repoPath)}`;
        composerWorkspaceEl.title = `Linked workspace (read + write): ${active.repoPath}`;
    } else {
        subtitleEl.innerText = "no workspace linked";
        subtitleEl.classList.remove("linked");
        linkBtn.classList.remove("linked");
        linkBtn.title = "Link a workspace folder (Ctrl+O)";
        composerWorkspaceEl.innerText = "";
        composerWorkspaceEl.title = "";
    }
    renderKnowledgeChip();
    paintPermChip();
    refreshSessionCost();
    syncMenuState();
}

/** The read-only twin of the workspace chip. */
function renderKnowledgeChip() {
    const el = $("composer-knowledge");
    if (!el) return;
    const n = (active && Array.isArray(active.knowledgeIds)) ? active.knowledgeIds.length : 0;
    el.innerText = n ? `knowledge: ${n} librar${n === 1 ? "y" : "ies"}` : "";
    el.title = n ? "Knowledge linked to this session (read-only). Click the book to change." : "";
    $("link-knowledge").classList.toggle("linked", n > 0);
}

// =============================================================
// SESSION LIST
// =============================================================
function relativeTime(ts) {
    if (!ts) return "";
    const secs = Math.max(0, Date.now() / 1000 - ts);
    if (secs < 60) return "just now";
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
    return new Date(ts * 1000).toLocaleDateString();
}

function groupFor(ts) {
    const secs = Math.max(0, Date.now() / 1000 - (ts || 0));
    if (secs < 86400) return "Today";
    if (secs < 172800) return "Yesterday";
    if (secs < 604800) return "This week";
    return "Earlier";
}

/**
 * THE PER-SESSION MENU. Anchored to the row it belongs to.
 *
 * Deliberately a real list rather than two hard-wired buttons, because the set
 * grows: "there is more than just those two options. maybe not coded yet, but
 * in general." Adding one is a line here, not another control in a header.
 */
let sessionMenuEl = null;
function closeSessionMenu() {
    if (sessionMenuEl) { sessionMenuEl.remove(); sessionMenuEl = null; }
    const oi = document.getElementById("ws-open");
    if (oi) oi.setAttribute("aria-expanded", "false");
}
document.addEventListener("click", closeSessionMenu);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSessionMenu(); });

/**
 * WORKSPACE MENU — on the session row's link mark.
 * Change the folder, unlink it, or reveal it in Explorer — without going
 * to the workspace panel. The link mark was just an indicator; now it's a
 * button with the three actions a linked folder actually needs.
 */
function openWorkspaceMenu(s, anchor) {
    closeSessionMenu();
    const menu = document.createElement("div");
    menu.className = "session-menu";
    menu.addEventListener("click", (e) => e.stopPropagation());

    const items = [
        { label: "Open in Explorer", run: () => {
            if (s.repoPath) window.lcl.revealFolder(s.repoPath);
        }},
        { sep: true },
        { label: "Change folder…", run: () => {
            if (active && active.id === s.id) linkRepo();
        }},
        { label: "Unlink", danger: true, run: () => {
            if (active && active.id === s.id) unlinkRepo();
        }},
    ];

    for (const it of items) {
        if (it.sep) {
            const sep = document.createElement("div");
            sep.className = "session-menu-sep";
            menu.appendChild(sep);
            continue;
        }
        const b = document.createElement("button");
        b.className = it.danger ? "danger-text" : "";
        b.innerText = it.label;
        b.addEventListener("click", () => { closeSessionMenu(); it.run(); });
        menu.appendChild(b);
    }

    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const h = menu.offsetHeight;
    const top = (r.bottom + h + 8 > window.innerHeight) ? Math.max(8, r.top - h - 4) : r.bottom + 4;
    menu.style.top = top + "px";
    menu.style.left = Math.max(8, Math.min(r.left - 120, window.innerWidth - menu.offsetWidth - 8)) + "px";
    sessionMenuEl = menu;
}

function openSessionMenu(s, anchor) {
    closeSessionMenu();
    const menu = document.createElement("div");
    menu.className = "session-menu";
    menu.addEventListener("click", (e) => e.stopPropagation());

    // THE GUARD IS ABOUT THIS ROW, NOT THE ROW THAT HAPPENS TO BE OPEN.
    //
    // Both handlers used to open with `if (pending) return;`, which asks
    // whether the CURRENTLY OPEN session is busy. Inherited from the header
    // button, where that was the same question; on a per-row menu it is a
    // different session entirely. `when` was checked below and never populated,
    // so both items drew as live and then did nothing at all.
    const rowBusy = () => pendingSessions.has(s.id);
    const items = [
        { label: "Rename…", when: () => !rowBusy(), run: () => renameSessionRow(s.id) },
        // FORKING IS ALLOWED WHILE THE ROW IS BUSY, deliberately: the parent
        // keeps working and the fork owns the transcript as it stood. That is
        // half the point — exploring a second direction while the first runs.
        { label: "Fork", run: () => forkSessionRow(s.id) },
        { sep: true, when: () => !rowBusy() },
        { label: "Delete", danger: true, when: () => !rowBusy(), run: () => deleteSession(s.id) },
        // the menu never opens empty: when the row IS busy it says why
        { note: true, when: () => rowBusy(),
          label: "This session is working. Rename and delete wait for the turn to finish." }
    ];

    for (const it of items) {
        if (it.when && !it.when()) continue;          // not built yet: do not offer it
        if (it.note) {
            const n = document.createElement("div");
            n.className = "session-menu-note";
            n.innerText = it.label;
            menu.appendChild(n);
            continue;
        }
        if (it.sep) {
            const sep = document.createElement("div");
            sep.className = "session-menu-sep";
            menu.appendChild(sep);
            continue;
        }
        const b = document.createElement("button");
        b.className = it.danger ? "danger-text" : "";
        b.innerText = it.label;
        b.addEventListener("click", () => { closeSessionMenu(); it.run(); });
        menu.appendChild(b);
    }

    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    // open below the dots, and flip up if there is no room underneath
    const h = menu.offsetHeight;
    const top = (r.bottom + h + 8 > window.innerHeight) ? Math.max(8, r.top - h - 4) : r.bottom + 4;
    menu.style.top = top + "px";
    menu.style.left = Math.max(8, Math.min(r.left - 120, window.innerWidth - menu.offsetWidth - 8)) + "px";
    sessionMenuEl = menu;
}

function renderSessionList() {
    sessionListEl.innerHTML = "";
    const needle = filter.trim().toLowerCase();
    const shown = needle
        ? sessions.filter(s => (s.title || "").toLowerCase().includes(needle)
            || (s.repoPath || "").toLowerCase().includes(needle))
        : sessions;

    sessionCountEl.innerText = sessions.length
        ? `${sessions.length} session${sessions.length === 1 ? "" : "s"}` : "";

    if (!shown.length) {
        const empty = document.createElement("div");
        empty.className = "session-empty";
        empty.innerText = needle ? "No matching sessions"
            : say("session.empty", "Nothing here yet. Type something to begin.");
        sessionListEl.appendChild(empty);
        return;
    }

    // GROUPED BY THE FOLDER THEY BELONG TO.
    //
    // The requirement: sessions categorized and grouped under their assigned
    //  workspace.
    //
    // Sessions with a linked folder are gathered under that folder's name,
    // most-recently-touched folder first; everything unlinked keeps the old
    // by-age grouping underneath. Sorting is by the newest session in each
    // group, so the folder you were just working in stays at the top.
    const byWorkspace = new Map();
    const loose = [];
    for (const s of shown) {
        if (s.repoPath) {
            if (!byWorkspace.has(s.repoPath)) byWorkspace.set(s.repoPath, []);
            byWorkspace.get(s.repoPath).push(s);
        } else {
            loose.push(s);
        }
    }
    const workspaces = [...byWorkspace.entries()]
        .sort((a, b) => Math.max(...b[1].map(x => x.updatedAt || 0))
                      - Math.max(...a[1].map(x => x.updatedAt || 0)));

    // TWO LEVELS, NOT A FLAT RUN OF HEADINGS.
    //
    // "if you are going to title that, you would need to title the workspaces
    //  and group them under workspaces, subgrouped by workspace"
    //
    // So "Workspaces" is the section, and each folder is a subheading inside
    // it. Before this every folder name was a full-weight heading at the same
    // level as "Today", which read as a flat list of unrelated sections and,
    // with a heading's worth of padding on each, made a handful of sessions
    // fill the whole column: "its all to far apart. it makes the list massive
    // for only a small amount of items."
    const groupHead = (text, full, level = "section") => {
        const head = document.createElement("div");
        head.className = "session-group" + (level === "sub" ? " sub" : "");
        head.innerText = text;
        // the full path on hover: the name alone is ambiguous when two
        // folders on different drives share it
        if (full) head.title = full;
        sessionListEl.appendChild(head);
    };

    let lastGroup = null;
    const drawOne = (s) => {

        const item = document.createElement("div");
        item.className = "session-item" + (active && s.id === active.id ? " active" : "");
        item.dataset.sessionId = s.id;

        // STATUS, leftmost — the at-a-glance answer to "what is this session
        // doing": grey pulse working, purple waiting on you, red failed, cyan
        // finished-unread, dim acknowledged. Live states come from main; the
        // read/unread split is DURABLE (doneAt vs readAt on the session file),
        // so knowing what has been read survives an app restart — the
        // in-memory status map never did.
        const st = sessionStatuses[s.id] || { state: "idle", detail: "" };
        const dot = document.createElement("span");
        dot.className = "session-status " + derivedDotState(st, s);
        dot.title = statusTitle(st, s);
        item.appendChild(dot);

        const main = document.createElement("div");
        main.className = "session-main";

        const name = document.createElement("div");
        name.className = "session-name";
        name.innerText = s.title || "Untitled";
        main.appendChild(name);

        const sub = document.createElement("div");
        sub.className = "session-sub";
        const bits = [relativeTime(s.updatedAt)];
        if (s.messageCount) bits.push(`${s.messageCount} msg`);
        sub.innerText = bits.filter(Boolean).join(" · ");
        main.appendChild(sub);
        item.appendChild(main);

        if (s.repoPath) {
            // a chain link to the RIGHT of the name: this session has a folder.
            // A BUTTON, not an indicator — click opens a workspace menu so the
            // operator can change, unlink, or reveal the folder right from the
            // session row, without going to the workspace panel.
            const mark = document.createElement("button");
            mark.className = "session-link-mark";
            mark.title = s.repoPath + " — click to change, unlink, or reveal";
            mark.innerHTML =
                '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" ' +
                'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
                'stroke-linejoin="round">' +
                '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
                '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' +
                '</svg>';
            mark.addEventListener("click", (e) => {
                e.stopPropagation();
                openWorkspaceMenu(s, mark);
            });
            item.appendChild(mark);
        }

        // EVERYTHING YOU DO TO A SESSION, ON THE SESSION.
        //
        // The requirement: each session needs a triple-dot menu next to it for
        //  options like rename and delete — more than just those two, in general.
        //
        // Rename used to be a text button in the chat header — nowhere near
        // the thing it renamed, and only reachable for the session already
        // open. A bare ✕ lived here and was the only per-row action. One menu
        // now, on the row, so anything else that belongs to a session has an
        // obvious place to go rather than becoming another button somewhere.
        // THE SESSION'S BELL, left of the options menu with room for a finger.
        // It mutes THIS session's announcements — the tray toast and the sound
        // — and nothing else: the dot keeps reporting, blocked work still shows
        // its card, the tray menu still lists it. Default is on. The intro and
        // its music-note toggle are a different thing entirely and untouched.
        const bell = document.createElement("button");
        bell.className = "session-bell" + (s.notifyMuted ? " muted" : "");
        bell.title = s.notifyMuted
            ? "Notifications muted for this session — click to turn them back on"
            : "Notifications on for this session — click to mute (tray + sound)";
        bell.setAttribute("aria-label", bell.title);
        bell.innerHTML = s.notifyMuted
            ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
              'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
              'stroke-linejoin="round">' +
              '<path d="M8.7 3A6 6 0 0 1 18 8c0 4.5 1.2 6.3 2 7"/>' +
              '<path d="M17 17H4s3-2 3-9c0-.7.1-1.4.3-2"/>' +
              '<path d="M13.73 21a2 2 0 0 1-3.46 0"/>' +
              '<line x1="2" y1="2" x2="22" y2="22"/></svg>'
            : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
              'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
              'stroke-linejoin="round">' +
              '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>' +
              '<path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
        bell.addEventListener("click", async (e) => {
            e.stopPropagation();
            bell.classList.add("ring");
            const r = await window.lcl.setSessionNotify(s.id, !s.notifyMuted)
                .catch(() => null);
            if (r && !r.error) { s.notifyMuted = r.notifyMuted; renderSessionList(); }
            else bell.classList.remove("ring");
        });
        item.appendChild(bell);

        const more = document.createElement("button");
        more.className = "session-more";
        more.title = "Session options";
        more.setAttribute("aria-label", "Session options");
        more.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">' +
            '<circle cx="8" cy="3.4" r="1.35"/><circle cx="8" cy="8" r="1.35"/>' +
            '<circle cx="8" cy="12.6" r="1.35"/></svg>';
        more.addEventListener("click", (e) => {
            e.stopPropagation();
            openSessionMenu(s, more);
        });
        item.appendChild(more);

        // A ROW BEING RENAMED IS NOT A ROW BEING OPENED.
        //
        // .session-name is a DESCENDANT of this row, so while it is
        // contentEditable every click a person makes to put the cursor after a
        // word bubbled up here and switched sessions — which repaints the whole
        // sidebar and destroys the node being edited, losing the rename with no
        // message and opening a session nobody asked for. The "editing" class
        // was set by both rename paths and READ BY NOTHING; it is the guard now,
        // which is why the handler takes its event.
        item.addEventListener("click", (e) => {
            if (item.querySelector(".session-name.editing")) {
                e.stopPropagation();
                return;
            }
            switchSession(s.id);
        });
        sessionListEl.appendChild(item);
    };

    if (workspaces.length) {
        groupHead(workspaces.length === 1 ? "Workspace" : "Workspaces", null);
        for (const [repoPath, list] of workspaces) {
            groupHead(folderName(repoPath), repoPath, "sub");
            for (const s of list) drawOne(s);
        }
    }
    if (loose.length) {
        // only label the leftovers when there is something above them to
        // distinguish from — otherwise it is a heading over the whole list
        if (workspaces.length) groupHead("No workspace", null);
        for (const s of loose) {
            const g = groupFor(s.updatedAt);
            if (g !== lastGroup) { lastGroup = g; groupHead(g, null); }
            drawOne(s);
        }
    }
}

searchEl.addEventListener("input", () => { filter = searchEl.value; renderSessionList(); });

// ---- session status: live state per session, driven by main ----
let sessionStatuses = {};

// ---- spark mode switch progress: the ONE surface currently interested
// (picker fold or node dash) registers its note here; module-level because
// BOTH top-level functions assign it — the gate's scope checker caught this
// declared inside the picker and read by openNodeDash, a shipped ReferenceError
let sparkModeNote = null;
if (window.lcl.onSparkModeState) {
    window.lcl.onSparkModeState((d) => {
        // the fold/dash note, WHEN one is open
        try { if (sparkModeNote) sparkModeNote(d); } catch { /* note gone */ }
        // …and a PERSISTENT badge on the always-visible model-pick button, so
        // closing the picker never makes a running switch look stopped. The
        // reported symptom — closing the model selector made it stop trying to
        // switch — was this: the only feedback lived in the fold that just got
        // torn down.
        try {
            const pill = $("spark-switch-pill");
            if (!pill || !d) return;
            if (d.phase === "ready" || d.phase === "failed") {
                pill.classList.add("hidden");
                pill.classList.toggle("failed", d.phase === "failed");
                refreshModelPick();   // repaint the label with the new truth
                if (d.phase === "failed") {
                    pill.classList.remove("hidden");
                    pill.innerText = "switch failed";
                    setTimeout(() => pill.classList.add("hidden"), 4000);
                }
            } else {
                pill.classList.remove("hidden", "failed");
                pill.innerText = String(d.detail || "switching…").slice(0, 48);
                pill.title = d.detail || "";
            }
        } catch { /* the badge is a convenience, never a blocker */ }
    });
}

/** The dot's ANSWER for a session with no live activity: finished-and-unread
 *  ("done", cyan — there is something here you have not seen) vs acknowledged
 *  ("acked", black dot with an outline — you read it). Live states pass
 *  straight through. A session the operator READ that predates the doneAt
 *  stamp (readAt set, doneAt never stamped) is read, not neutral — "all these
 *  other sessions that i have clicked on are still grey" was this branch. */
function derivedDotState(st, s) {
    if (st.state !== "idle" || !s) return st.state;
    if (s.doneAt && s.doneAt > (s.readAt || 0)) return "done";
    if (s.doneAt || s.readAt) return "acked";
    return "idle";
}

function statusTitle(st, s) {
    const names = { working: "working on a task", waiting: "waiting for you",
                    approval: "needs your approval — the work is stopped",
                    failed: "the last task failed", idle: "idle — up to date",
                    done: "finished — you have not read it yet",
                    acked: "read — up to date" };
    const state = derivedDotState(st, s);
    return (names[state] || state) + (st.detail ? ` — ${st.detail}` : "");
}

/** Update one row in place — re-rendering the whole list on every status
 *  change would fight the user's scroll position. */
function paintSessionStatus(sessionId, st) {
    const prev = sessionStatuses[sessionId];
    sessionStatuses[sessionId] = st;
    const proj = sessions.find(x => x.id === sessionId);
    const row = sessionListEl.querySelector(`[data-session-id="${sessionId}"]`);

    // A FINISHED TURN moves the durable split: doneAt here. readAt follows ONLY
    // when you were watching it land. The blanket watched-live auto-ack was
    // removed once because a BACKGROUND finish could ack itself; the operator
    // then hit the opposite wall — "if I am in the session when it responds,
    // I'm reading it... it will not clear unless I move to another session then
    // click back." So the ack is back, but SCOPED: the session must be the one
    // on screen AND the window must have focus. A background finish still goes
    // cyan and waits for you; the turn you actually sat and watched clears
    // itself the instant it finishes.
    if (prev && prev.state === "working" && (st.state === "idle" || st.state === "failed")) {
        if (proj) proj.doneAt = Date.now();
        if (proj && active && active.id === sessionId && document.hasFocus()) {
            proj.readAt = proj.doneAt;   // equal is enough: derivedDotState needs doneAt > readAt for "done"
            window.lcl.markSessionRead(sessionId).catch(() => { /* stamped again on next open */ });
        }
        // the session's bell gates the SOUND too — main's chime path is muted
        // at the source, and this is the renderer's own second sound path
        if (!(proj && proj.notifyMuted)) playChime("done");
        // refresh the context ring when a turn finishes — the new tokens
        // from the answer are now in the session's messages
        setTimeout(refreshContextRing, 200);
    }

    /* AN ORPHANED COMPLETION STILL LANDS. A turn's result is applied by the
     * sendText call that awaits it — and that promise dies with a renderer
     * reload or a dropped IPC reply, leaving main's completed turn with no
     * living code path to paint it: the status line says "an action needs
     * your approval" while the transcript shows no ask. Reported, verbatim:
     * "it was waiting on something that it never asked me, but said it was
     * asking me." The status event is the one signal that always arrives, so
     * it heals the transcript: when the ACTIVE session settles (idle, failed,
     * waiting, approval) and no live send in THIS renderer owns it, refetch
     * from disk and repaint — the staged card, the answer, whatever landed. */
    const settled = ["idle", "failed", "waiting", "approval"].includes(st.state);
    if (settled && (!prev || prev.state === "working")
        && active && active.id === sessionId
        && !pendingSessions.has(sessionId)) {
        (async () => {
            try {
                const fresh = await window.lcl.getSession(sessionId);
                if (!fresh || fresh.error) return;
                if (!active || active.id !== sessionId) return;
                if ((fresh.messages || []).length !== (active.messages || []).length) {
                    active.messages = fresh.messages;
                    if (fresh.changes) active.changes = fresh.changes;
                    stopProgress();
                    renderMessages(active.messages);
                    setControls();
                }
            } catch { /* the next open still shows the disk truth */ }
        })();
    }

    if (!row) return;
    const dot = row.querySelector(".session-status");
    if (dot) { dot.className = "session-status " + derivedDotState(st, proj);
               dot.title = statusTitle(st, proj); }
}

/**
 * THE APP'S OWN SOUND, AND ONLY THE APP'S OWN SOUND.
 *
 * A reported bug: the app played both its own notification sound and the
 * Windows system default, when only the app's own sound is wanted. Both fired
 * because main raised its toast
 * with `silent: false` at the same instant this played done.wav. Every toast
 * is silent at the OS level now (see chime() in main.js) and this is the whole
 * audible half of the app.
 *
 * `attention` looks for its own file first, so dropping an assets/needs-you.wav
 * in gives a distinct sound for "something is blocked on you" with no code
 * change; until then it falls back to the finish sound.
 */
function playChime(kind) {
    const attention = kind === "attention";
    const play = (file, volume, onFail) => {
        try {
            const audio = new Audio("../assets/" + file);
            audio.volume = volume;
            const p = audio.play();
            if (p && p.catch) p.catch(() => { if (onFail) onFail(); });
        } catch { if (onFail) onFail(); }
    };
    if (attention) play("needs-you.wav", 0.7, () => play("done.wav", 0.6, null));
    else play("done.wav", 0.6, null);
}

// main asks for the sound; the renderer owns it, so there is exactly one
if (window.lcl.onChime) window.lcl.onChime((d) => playChime(d && d.kind));

// EVERY RENDERER ERROR LANDS IN THE AUDIT LEDGER. render-process-gone only
// records the page DYING — a thrown click handler or an unhandled promise
// left no trace at all, which is why "it did nothing" bugs could not be
// diagnosed from the logs. This is the renderer's half of the self-diagnosis
// substrate the patch pipeline reads.
window.addEventListener("error", (e) => {
    try {
        window.lcl.diag({ error: String(e.message || e.error || "error"),
            stack: String((e.error && e.error.stack) || ""),
            where: `${e.filename || "?"}:${e.lineno || 0}` }).catch(() => {});
    } catch { /* logging never hurts the page */ }
});
window.addEventListener("unhandledrejection", (e) => {
    try {
        const r = e.reason;
        window.lcl.diag({ error: String((r && r.message) || r || "unhandled rejection"),
            stack: String((r && r.stack) || ""), where: "promise" }).catch(() => {});
    } catch { /* ditto */ }
});

window.lcl.onSessionStatus((s) => paintSessionStatus(s.sessionId, s));

/* PATCH NOTIFICATION — a real button that appears when the running .lcl is older
 * than an installer waiting in the patch channel, and installs it in one click
 * (launches the installer exactly like double-clicking it; .lcl reopens after).
 * The requirement: a physical button that pops up when the running .lcl differs
 * from the installer — a real patch system clickable from the UI. */
// TWO LANES, NOT A TIMESTAMP (see the design notes). The OFFICIAL base is the shared
// identity; the LOCAL marker rides alongside it and never impersonates it. The
// operator reads "Official #8 ready — you're on #7 · +2 local": what they will
// move to, what they are on, and the customizations that ride along. The offer
// names its source once a network channel exists. Build date is a tooltip.
function patchLabel(p) {
    const off = Number.isInteger(p.latestOfficial) ? p.latestOfficial : null;
    const onOff = Number.isInteger(p.runningOfficial) ? p.runningOfficial : null;
    const local = Number.isInteger(p.runningLocal) ? p.runningLocal : 0;
    const from = p.source && p.source !== "local" ? ` from ${p.source}` : "";
    // what the running copy is on: the base, plus any local divergence
    const on = onOff !== null
        ? ` — you're on #${onOff}${local > 0 ? ` · +${local} local` : ""}`
        : "";
    if (off === null) return `a new build is waiting${on}`;
    return `Official #${off} ready${from}${on}`;
}
function showPatchBanner(p) {
    const existing = document.getElementById("patch-banner");
    if (!p || !p.available) { if (existing) existing.remove(); return; }
    const offer = (p.latest && p.latest.buildId) || "";
    const when = p.builtAt ? "built " + new Date(p.builtAt).toLocaleString() : "";
    // A NEWER BUILD CAN LAND WHILE THE BANNER IS STILL UP. The first cut returned
    // here unconditionally, so the label froze at whatever build was in dist when
    // it first appeared — it read "Patch #5" long after #7 had replaced it. Now a
    // changed offer REFRESHES the number in place instead of going stale.
    if (existing) {
        if (existing.dataset.offer === offer) return;   // same offer, nothing new
        existing.dataset.offer = offer;
        const m = existing.querySelector(".patch-msg");
        if (m) { m.innerText = patchLabel(p); m.title = when; }
        const g = existing.querySelector(".patch-go");
        if (g) { g.disabled = false; const s = g.querySelector("span"); if (s) s.innerText = "Patch Ready"; }
        return;
    }
    const el = document.createElement("div");
    el.id = "patch-banner";
    el.dataset.offer = offer;
    const msg = document.createElement("span");
    msg.className = "patch-msg";
    msg.title = when;                           // the date lives here, not the label
    msg.innerText = patchLabel(p);
    // THE PATCH BUTTON IS A PUZZLE PIECE saying "Patch Ready" — the operator's
    // ask. Static SVG (a jigsaw piece), no model text, so innerHTML is safe here.
    const go = document.createElement("button");
    go.className = "primary small patch-go";
    go.innerHTML =
        '<svg class="patch-puzzle" width="15" height="15" viewBox="0 0 24 24" ' +
        'fill="currentColor" aria-hidden="true"><path d="M9 3a2 2 0 0 1 4 0v1a1 1 0 0 0 ' +
        '1 1h4a1 1 0 0 1 1 1v4a1 1 0 0 0 1 1h1a2 2 0 0 1 0 4h-1a1 1 0 0 0-1 1v4a1 1 0 0 1' +
        '-1 1h-4a1 1 0 0 1-1-1v-1a2 2 0 0 0-4 0v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4a1 1 0 ' +
        '0 1 1-1h1a2 2 0 0 0 0-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4a1 1 0 0 0 1-1V3z"/></svg>' +
        '<span>Patch Ready</span>';
    go.addEventListener("click", async () => {
        const ok = await modal({
            title: "Install the update",
            message: "This launches the installer and closes .lcl so it can replace the " +
                "running files. It reopens automatically when the update finishes. Continue?",
            confirmLabel: "Install & restart"
        });
        if (!ok) return;
        go.disabled = true;
        const lbl = go.querySelector("span"); if (lbl) lbl.innerText = "starting…";
        // THE DOWNLOAD IS NOT A BLACK BOX. A network patch fetches ~1.7 GB
        // before anything visible happens; a frozen "launching…" for that whole
        // stretch reads as "nothing fires" (measured: the operator gave up on a
        // working update). Main streams progress; say it on the button, and say
        // what comes after the download too — the Windows permission prompt.
        if (window.lcl.onPatchProgress && !showPatchBanner._progressWired) {
            showPatchBanner._progressWired = true;
            window.lcl.onPatchProgress((pr) => {
                const l = showPatchBanner._activeLbl;
                if (!l) return;
                // BUTTON LABELS STAY SHORT — a sentence on the button grew it
                // past its container (measured on the #6→#7 patch). The button
                // says the state; the banner's message line carries the guidance.
                if (pr && pr.pct >= 100) {
                    l.innerText = "verifying…";
                    const m = showPatchBanner._activeMsg;
                    if (m) m.innerText = "approve the Windows prompt when it appears";
                } else if (pr && typeof pr.pct === "number") {
                    l.innerText = `downloading… ${pr.pct}%`;
                }
            });
        }
        showPatchBanner._activeLbl = lbl;
        showPatchBanner._activeMsg = msg;
        const r = await window.lcl.applyPatch().catch(e => ({ ok: false, error: String(e) }));
        showPatchBanner._activeLbl = null;
        if (r && !r.ok) {
            go.disabled = false;
            if (lbl) lbl.innerText = "Patch Ready";
            addError("Could not start the update: " + (r.error || "unknown error"));
        }
    });
    const later = document.createElement("button");
    later.className = "ghost small";
    later.innerText = "Later";
    later.title = "Dismiss — the button returns on the next check";
    later.addEventListener("click", () => el.remove());
    el.append(go, msg, later);
    // ABOVE the New Session button, where the operator asked for it — not a
    // floating top-center card. Falls back to the body if the button is absent.
    const anchor = document.getElementById("new-session");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(el, anchor);
    else document.body.appendChild(el);
}
window.lcl.onPatchAvailable(showPatchBanner);
window.lcl.patchStatus().then(showPatchBanner).catch(() => {});

/* CLICKABLE / COPIABLE LINKS in rendered chat markdown. "if there is a link to a
 * path, it should be clickable or copiable." A URL opens in the browser; a path
 * (or any non-URL reference) copies to the clipboard and says so on the link. */
chat.addEventListener("click", (e) => {
    const a = e.target && e.target.closest && e.target.closest("a.md-link");
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const href = a.getAttribute("data-href") || "";
    if (/^https?:\/\//i.test(href)) {
        try { window.lcl.openExternal(href); } catch { /* nothing to open */ }
        return;
    }
    copyToClipboard(href);
    const prev = a.title;
    a.classList.add("copied");
    a.title = "copied to clipboard";
    setTimeout(() => { a.classList.remove("copied"); a.title = prev; }, 1200);
});

async function loadSessionStatuses() {
    try {
        const res = await window.lcl.sessionStatuses();
        sessionStatuses = (res && res.statuses) || {};
    } catch { /* sidebar just shows idle */ }
}

// =============================================================
// WORKSPACE PANEL
// =============================================================
const workspaceOpen = () => bodyEl.classList.contains("with-ws");

// =============================================================
// WORKSPACE RESIZE
// =============================================================
/**
 * The panel's width is a CSS variable on #body (--ws-w) so one number drives
 * every grid template that mentions the third column. Dragging the left edge
 * sets it; the choice persists across launches because a width you had to set
 * twice is a width the app forgot.
 */
const WS_MIN = 240, WS_MAX_FRACTION = 0.6;

function setWorkspaceWidth(px) {
    const max = Math.round(window.innerWidth * WS_MAX_FRACTION);
    const w = Math.max(WS_MIN, Math.min(max, Math.round(px)));
    bodyEl.style.setProperty("--ws-w", w + "px");
    try { localStorage.setItem("wsWidth", String(w)); } catch { /* private mode */ }
}
try {
    const saved = Number(localStorage.getItem("wsWidth"));
    if (saved >= WS_MIN) bodyEl.style.setProperty("--ws-w", saved + "px");
} catch { /* default width stands */ }

$("ws-resize").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const handle = $("ws-resize");
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    bodyEl.classList.add("ws-resizing");
    // the module rows re-pack as the panel width changes — the slack
    // measurement must follow (it is rAF-debounced, so per-move is cheap)
    const move = (ev) => {
        setWorkspaceWidth(window.innerWidth - ev.clientX);
        sbFillSlack();
    };
    const up = () => {
        handle.releasePointerCapture(e.pointerId);
        handle.classList.remove("dragging");
        bodyEl.classList.remove("ws-resizing");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        sbFillSlack();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
});

function toggleWorkspace(force) {
    const open = force === undefined ? !workspaceOpen() : force;
    bodyEl.classList.toggle("with-ws", open);
    workspaceEl.classList.toggle("collapsed", !open);
    // the header button in the chat bar and the panel's own header button are
    // the same control seen from two sides; both say which way they point
    // one control now, in the header — the in-panel duplicate is gone
    {
        const b = $("workspace-toggle");
        if (b) {
            b.setAttribute("aria-expanded", open ? "true" : "false");
            b.title = open ? "Hide the workspace panel (Ctrl+J)" : "Show the workspace panel (Ctrl+J)";
            b.setAttribute("aria-label", b.title);
        }
    }
    if (open) {
        renderWorkspace();
        // the panel's grid column takes ~200ms to slide open; measuring the
        // slack before the slide lands reads a half-width panel. One late
        // call after the transition settles the layout at true width —
        // nothing else fires on expand (the class flips happen on ancestors
        // the module observer cannot see).
        setTimeout(() => sbFillSlack(), 230);
    }
    syncMenuState();
}

$("btn-workspace").addEventListener("click", () => toggleWorkspace());
// THE HEADER TOGGLES — "a proper SVG toggle button in the TOP RIGHT of the
// header, like the sidebar svg buttons that literally everyone uses."
$("workspace-toggle").addEventListener("click", () => toggleWorkspace());
// ...and the panel collapses from its OWN head — "a true hero section that
// is collapsable", not a panel that can only be dismissed from across the
// window
$("ws-collapse").addEventListener("click", () => toggleWorkspace(false));
$("sidebar-toggle").addEventListener("click",
    () => setSidebar(!bodyEl.classList.contains("no-sidebar")));
// ...and the handle on the edge, which is the only way back once the panel
// that holds the toggle is gone
$("btn-sidebar").addEventListener("click", () => setSidebar(false));
$("workspace-link").addEventListener("click", () => linkRepo());
$("ws-change").addEventListener("click", () => linkRepo());
$("ws-unlink").addEventListener("click", () => unlinkRepo());
$("ws-refresh").addEventListener("click", () => loadWorkspaceFiles());
// The search is a RENDER, not a read: the folder is already in memory, so
// typing filters instantly and never touches the disk.
$("ws-search").addEventListener("input", (e) => {
    wsFilter = e.target.value || "";
    renderWsFiles();
    $("ws-files").scrollTop = 0;
});
// Escape clears the search rather than leaving the operator to select-all-
// delete their way back to the tree
$("ws-search").addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();          // never let this close the panel too
    if (!wsFilter) return;
    wsFilter = "";
    e.target.value = "";
    renderWsFiles();
});
/**
 * OPEN IN — the workspace folder, in the app the operator lives in. File
 * Explorer and VS Code are offered when present; "Other…" runs the OS app
 * picker once and remembers the choice, so the next time it is one click.
 * "there are other softwares capable of things."
 */
async function openOpenInMenu(anchor) {
    closeSessionMenu();
    if (!(active && active.repoPath)) { addError("Link a workspace folder first."); return; }
    const folder = active.repoPath;
    const menu = document.createElement("div");
    menu.className = "session-menu open-in-menu";
    menu.addEventListener("click", (e) => e.stopPropagation());

    const res = await window.lcl.listOpeners().catch(() => null);
    const openers = (res && res.ok && res.openers)
        || [{ id: "explorer", name: "File Explorer", builtin: true }];

    const launch = async (id) => {
        const r = await window.lcl.openWith(id, folder).catch(e => ({ ok: false, error: String(e) }));
        if (r && !r.ok) addError("Could not open the workspace: " + (r.error || "unknown error"));
    };

    for (const op of openers) {
        const b = document.createElement("button");
        b.className = "open-in-row";
        const label = document.createElement("span");
        label.innerText = op.name;
        b.appendChild(label);
        b.addEventListener("click", () => { closeSessionMenu(); launch(op.id); });
        if (op.removable) {
            const x = document.createElement("span");
            x.className = "open-in-remove";
            x.innerText = "✕";
            x.title = "Remove this app from the list";
            x.addEventListener("click", async (e) => {
                e.stopPropagation();
                await window.lcl.removeOpener(op.id).catch(() => {});
                b.remove();
            });
            b.appendChild(x);
        }
        menu.appendChild(b);
    }

    const sep = document.createElement("div");
    sep.className = "session-menu-sep";
    menu.appendChild(sep);
    const other = document.createElement("button");
    other.innerText = "Other…";
    other.title = "Pick another app and add it to this list";
    other.addEventListener("click", async () => {
        closeSessionMenu();
        const r = await window.lcl.pickOpenerApp().catch(e => ({ error: String(e) }));
        if (!r || r.canceled) return;
        if (r.ok && r.opener) return launch(r.opener.id);
        if (r.error) addError(r.error);
    });
    menu.appendChild(other);

    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    const h = menu.offsetHeight;
    const top = (rect.bottom + h + 8 > window.innerHeight) ? Math.max(8, rect.top - h - 4) : rect.bottom + 4;
    menu.style.top = top + "px";
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)) + "px";
    sessionMenuEl = menu;
    anchor.setAttribute("aria-expanded", "true");
}
$("ws-open").addEventListener("click", (e) => {
    e.stopPropagation();
    // toggle: a second click on the trigger closes it
    if (sessionMenuEl && sessionMenuEl.classList.contains("open-in-menu")) { closeSessionMenu(); return; }
    openOpenInMenu($("ws-open"));
});

function renderWorkspace() {
    const linked = !!(active && active.repoPath);
    $("workspace-empty").classList.toggle("hidden", linked);
    const wsNone = $("workspace-empty").querySelector("p");
    if (wsNone) wsNone.innerText = say("workspace.none", "No folder linked.");
    // the card and the file list are separate MODULES now — both belong to
    // the linked folder, so both follow it; the preview follows the FILE and
    // closes with the folder that held it
    $("workspace-body").classList.toggle("hidden", !linked);
    $("ws-files-wrap").classList.toggle("hidden", !linked);
    if (!linked) { closeFileViewer(); return; }

    // A DIFFERENT FOLDER IS A DIFFERENT TREE. Keeping wsCwd across a relink
    // would open the new folder somewhere in the old one's hierarchy.
    if (wsRenderedFor !== active.repoPath) {
        wsRenderedFor = active.repoPath;
        wsCwd = "";
        wsFilter = "";
        const box = $("ws-search");
        if (box) box.value = "";
    }
    $("ws-name").innerText = folderName(active.repoPath);
    $("ws-path").innerText = active.repoPath;
    $("ws-meta").innerText = "read + write access for this session";
    loadWorkspaceFiles();
}

/** most recent non-reverted change per path, for colouring the file list */
/**
 * Change marks the user has dismissed, per session.
 *
 * "refresh does nothing to clear those" — correct, and refresh was the wrong
 * place to clear them anyway: refresh re-reads the DISK, and the marks come
 * from the session's change log, which a re-read of the disk rightly does not
 * touch. Dismissal is its own explicit act, and it only hides the markers —
 * the change log itself stays intact, because it is also the revert history.
 */
const dismissedMarks = new Map();     // sessionId -> Set of change ids

function changeIndex() {
    const map = new Map();
    const dismissed = (active && dismissedMarks.get(active.id)) || null;
    for (const c of (active && active.changes) || []) {
        if (c.reverted) map.delete(c.path);
        else if (dismissed && dismissed.has(c.id)) map.delete(c.path);
        else map.set(c.path, c);
    }
    return map;
}

$("ws-clear-marks").addEventListener("click", () => {
    if (!active) return;
    const set = dismissedMarks.get(active.id) || new Set();
    for (const c of active.changes || []) if (c.id) set.add(c.id);
    dismissedMarks.set(active.id, set);
    loadWorkspaceFiles();
});

/* ===================================================== THE FILE EXPLORER
 *
 * "in the files explorer that is in the right sidebar. we have folders and
 *  such, and you have all items listed as full path, not as folders that can
 *  actually be clicked in to view. there should be a search function in this
 *  as well, to search through all the files by name"
 *
 * It listed `docs/codex/vendor/highlight.min.js` — every entry its whole path,
 * every path competing for one narrow column. A folder of any size read as a
 * wall of text with no structure and no way to narrow it.
 *
 * The read is unchanged (one call, up to 20,000 entries, sorted). What
 * changed is that the flat list is now the SOURCE for a tree: walk into a
 * folder, walk back out by its crumb, or type a name and search every file at
 * once regardless of where you are standing.
 */
let wsEntries = [];        // [{ rel, bytes }] — the whole folder, read once
let wsTotal = 0;           // what the folder really holds, cap or no cap
let wsTruncated = false;
let wsCwd = "";            // "" is the root; otherwise "src/components"
let wsFilter = "";         // a name search runs across EVERY entry, not the cwd
let wsRenderedFor = null;  // which repoPath the tree above belongs to

const wsDirOf = (rel) => {
    const i = rel.lastIndexOf("/");
    return i < 0 ? "" : rel.slice(0, i);
};
const wsBaseOf = (rel) => rel.slice(rel.lastIndexOf("/") + 1);
const wsFmtBytes = (bytes) =>
    !Number.isFinite(bytes) || bytes < 0 ? "—"
        : bytes < 1024 ? `${bytes} B`
        : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB`
        : `${(bytes / 1048576).toFixed(1)} MB`;

async function loadWorkspaceFiles() {
    if (!active || !active.repoPath) return;

    const filesEl = $("ws-files");
    filesEl.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "ws-note";
    loading.innerText = "reading…";
    filesEl.appendChild(loading);

    const res = await window.lcl.listFiles(active.id);

    if (!res || res.error) {
        filesEl.innerHTML = "";
        const err = document.createElement("div");
        err.className = "ws-note";
        err.innerText = (res && res.error) || "could not read folder";
        filesEl.appendChild(err);
        return;
    }

    wsEntries = (Array.isArray(res.entries) ? res.entries : []).map(entry => {
        const m = /^(.*)\s\((-?\d+) bytes\)$/.exec(entry);
        return { rel: m ? m[1] : entry, bytes: m ? Number(m[2]) : NaN };
    });
    wsTotal = Number(res.total) || wsEntries.length;
    wsTruncated = !!res.truncated;

    // a folder that no longer exists must not leave the view stranded inside it
    if (wsCwd && !wsEntries.some(e => e.rel.startsWith(wsCwd + "/"))) wsCwd = "";

    renderWsFiles();
}

/**
 * Paint the current view: a search result, or one level of the tree.
 *
 * Pure render — it reads wsEntries and never touches the disk, so walking
 * into a folder or typing in the search box costs nothing.
 */
function renderWsFiles() {
    const filesEl = $("ws-files");
    if (!filesEl) return;
    filesEl.innerHTML = "";

    const changed = changeIndex();
    $("ws-clear-marks").classList.toggle("hidden", changed.size === 0);
    const present = new Set(wsEntries.map(e => e.rel));

    const q = wsFilter.trim().toLowerCase();
    const searching = q.length > 0;

    /* ---- what the header says about the folder ---- */
    $("ws-meta").innerText =
        (wsEntries.length < wsTotal
            ? `${wsEntries.length} of ${wsTotal} files`
            : `${wsTotal} file${wsTotal === 1 ? "" : "s"}`) +
        " · read + write for this session";

    /* ---- the crumb trail: where you are, and every way back ---- */
    if (!searching && wsCwd) {
        const crumbs = document.createElement("div");
        crumbs.className = "ws-crumbs";
        const parts = wsCwd.split("/");
        const mk = (label, target, isLast) => {
            const b = document.createElement("button");
            b.className = "ws-crumb" + (isLast ? " here" : "");
            b.innerText = label;
            b.title = target ? target : "the linked folder";
            if (!isLast) b.addEventListener("click", () => { wsCwd = target; renderWsFiles(); });
            return b;
        };
        crumbs.appendChild(mk(folderName(active.repoPath), "", false));
        parts.forEach((p, i) => {
            const sep = document.createElement("span");
            sep.className = "ws-crumb-sep";
            sep.innerText = "/";
            crumbs.appendChild(sep);
            crumbs.appendChild(mk(p, parts.slice(0, i + 1).join("/"), i === parts.length - 1));
        });
        filesEl.appendChild(crumbs);
    }

    /* ---- one file row, shared by both views ---- */
    const fileRow = (rel, bytes, showPath) => {
        const change = changed.get(rel);
        const row = document.createElement("div");
        row.className = "ws-file" + (change ? ` ${change.kind}` : "");
        if (change) {
            const flag = document.createElement("span");
            flag.className = "flag";
            flag.innerText = change.kind === "created" ? "+" : "±";
            flag.title = `${change.kind} by the agent`;
            row.appendChild(flag);
        }
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.innerText = showPath ? rel : wsBaseOf(rel);
        nm.title = rel;
        row.appendChild(nm);
        if (Number.isFinite(bytes)) {
            const sz = document.createElement("span");
            sz.className = "sz";
            sz.innerText = wsFmtBytes(bytes);
            row.appendChild(sz);
        }
        row.dataset.rel = rel;
        row.classList.toggle("viewing", viewerPath === rel);
        row.addEventListener("click", (ev) => {
            // Alt+click stages the file onto the next message
            if (ev.altKey) { stageWorkspaceFile(rel); return; }
            openFileViewer(rel);
        });
        row.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            openFileContextMenu(e, rel);
        });
        return row;
    };

    /* ================================================== SEARCH BY NAME */
    if (searching) {
        // the NAME is what is being searched, but a path fragment ("core/")
        // is the same act from the operator's side, so both count — name
        // matches first, because that is what was typed
        const byName = [], byPath = [];
        for (const e of wsEntries) {
            if (wsBaseOf(e.rel).toLowerCase().includes(q)) byName.push(e);
            else if (e.rel.toLowerCase().includes(q)) byPath.push(e);
        }
        byName.sort((a, b) => a.rel.localeCompare(b.rel));
        byPath.sort((a, b) => a.rel.localeCompare(b.rel));
        const hits = byName.concat(byPath);
        const SHOW = 400;
        const head = document.createElement("div");
        head.className = "ws-note ws-search-count";
        head.innerText = hits.length
            ? `${hits.length} file${hits.length === 1 ? "" : "s"} matching “${wsFilter.trim()}”`
            : `nothing named “${wsFilter.trim()}” in ${wsTotal} files`;
        filesEl.appendChild(head);
        // the full path is the point in a search result — a bare filename
        // gives no way to tell four index.js apart
        for (const e of hits.slice(0, SHOW)) filesEl.appendChild(fileRow(e.rel, e.bytes, true));
        if (hits.length > SHOW) {
            const more = document.createElement("div");
            more.className = "ws-note";
            more.innerText = `…and ${hits.length - SHOW} more — narrow the search`;
            filesEl.appendChild(more);
        }
        try { sbFillSlack(); } catch { }
        return;
    }

    /* ================================================== ONE LEVEL OF TREE */
    const prefix = wsCwd ? wsCwd + "/" : "";
    const dirs = new Map();          // name -> file count beneath it
    const files = [];
    for (const e of wsEntries) {
        if (prefix && !e.rel.startsWith(prefix)) continue;
        const rest = e.rel.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash < 0) files.push(e);
        else {
            const dir = rest.slice(0, slash);
            dirs.set(dir, (dirs.get(dir) || 0) + 1);
        }
    }

    if (!dirs.size && !files.length) {
        const none = document.createElement("div");
        none.className = "ws-note";
        none.innerText = wsCwd ? "nothing here" : "no readable files";
        filesEl.appendChild(none);
    }

    // FOLDERS FIRST, then files — every explorer ever written, and the
    // ordering that makes a deep tree walkable instead of scannable
    for (const dir of [...dirs.keys()].sort()) {
        const count = dirs.get(dir);
        const row = document.createElement("div");
        row.className = "ws-file ws-dir";
        const caret = document.createElement("span");
        caret.className = "ws-dir-caret";
        caret.innerText = "▸";
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.innerText = dir;
        const sz = document.createElement("span");
        sz.className = "sz";
        sz.innerText = `${count} file${count === 1 ? "" : "s"}`;
        row.appendChild(caret); row.appendChild(nm); row.appendChild(sz);
        row.title = `Open ${prefix}${dir}`;
        row.addEventListener("click", () => {
            wsCwd = prefix + dir;
            renderWsFiles();
            $("ws-files").scrollTop = 0;
        });
        filesEl.appendChild(row);
    }

    // SORTED HERE, NOT HOPED FOR. fsTools sorts before it cuts, so this list
    // arrives sorted today — but a level of the tree is a SLICE of that list,
    // and its order would be inherited rather than owned.
    files.sort((a, b) => a.rel.localeCompare(b.rel));
    for (const e of files) filesEl.appendChild(fileRow(e.rel, e.bytes, false));

    // the previewed file may have just been rewritten by the agent — re-render
    // it so the pane never shows stale content (and close it if it is gone)
    if (viewerPath) {
        if (present.has(viewerPath)) openFileViewer(viewerPath);
        else closeFileViewer();
    }

    // a change whose file is gone now shows as deleted (red), in the folder
    // it used to live in
    for (const [p, c] of changed) {
        if (present.has(p) || wsDirOf(p) !== wsCwd) continue;
        const row = document.createElement("div");
        row.className = "ws-file deleted";
        const flag = document.createElement("span");
        flag.className = "flag";
        flag.innerText = "−";
        row.appendChild(flag);
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.innerText = wsBaseOf(p);
        nm.title = p;
        row.appendChild(nm);
        filesEl.appendChild(row);
        void c;
    }

    if (wsTruncated) {
        const note = document.createElement("div");
        note.className = "ws-note";
        note.innerText = `showing ${wsEntries.length} of ${wsTotal} — the rest are ` +
            "in the folder, just not listed here";
        filesEl.appendChild(note);
    }

    // THE LIST ARRIVES AFTER THE LAYOUT THAT SIZES THE MODULES.
    //
    // sbFillSlack measures the sidebar and hands the flexible module its
    // height; it runs on a panel drag and on expand, both of which happen
    // BEFORE the async read returns. So a freshly linked folder could paint
    // its rows into a container that had been sized while it was empty — the
    // files existed and the module showed none of them until something
    // re-measured. Popping the card out and docking it again is exactly that
    // re-measure, which is why it "fixed" it: the files did not appear until
    // manual intervention.
    try { sbFillSlack(); } catch { /* layout helper absent in a bare page */ }
}

// =============================================================
// FILE CONTEXT MENU
// =============================================================
/**
 * Right-click on a workspace file.
 *
 * "i can not right click on an item and open in... like a browser window or
 *  something similar... so open in Workspace, New Window. those options would
 *  solve that issue."
 *
 * Styled like the title-bar menus, positioned at the pointer, dismissed by any
 * click or Escape. One instance ever exists — opening a second closes the
 * first, which is what every OS menu does.
 */
let fileMenuEl = null;

function closeFileContextMenu() {
    if (fileMenuEl) { fileMenuEl.remove(); fileMenuEl = null; }
}

function openFileContextMenu(e, relPath) {
    closeFileContextMenu();
    if (!active) return;
    const sessionId = active.id;

    const menu = document.createElement("div");
    menu.className = "ctx-menu";

    const title = document.createElement("div");
    title.className = "ctx-title";
    title.innerText = relPath.split("/").pop();
    title.title = relPath;
    menu.appendChild(title);

    const item = (label, fn) => {
        const b = document.createElement("button");
        b.innerText = label;
        b.addEventListener("click", async (ev) => {
            ev.stopPropagation();
            closeFileContextMenu();
            const r = await fn();
            if (r && r.ok === false && r.error) {
                modal({ title: "Could not open", message: r.error,
                        confirmLabel: "Close", confirmOnly: true });
            }
        });
        menu.appendChild(b);
        return b;
    };

    item("Open in workspace", async () => { openFileViewer(relPath); });
    item("Add to chat", async () => { stageWorkspaceFile(relPath); });
    item("Copy path into message", async () => {
        composer.value = (composer.value ? composer.value + " " : "") + relPath;
        autoGrow();
        composer.focus();
    });
    item("Open in new window", () => window.lcl.openFileWindow(sessionId, relPath));
    item("Open with default app", () => window.lcl.openFileExternal(sessionId, relPath));
    const sep = document.createElement("div");
    sep.className = "menu-sep";
    menu.appendChild(sep);
    item("Show in Explorer", () => window.lcl.revealFile(sessionId, relPath));

    document.body.appendChild(menu);
    // place at the pointer, then pull back inside the window if it overflows
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(e.clientX, window.innerWidth - r.width - 8) + "px";
    menu.style.top = Math.min(e.clientY, window.innerHeight - r.height - 8) + "px";
    fileMenuEl = menu;
}

document.addEventListener("click", closeFileContextMenu);
document.addEventListener("contextmenu", (e) => {
    // right-clicking anything that is not a workspace row closes an open menu
    if (!e.target.closest || !e.target.closest(".ws-file")) closeFileContextMenu();
});

// =============================================================
// FILE VIEWER  (bottom half of the workspace panel)
// =============================================================
let viewerPath = null;

/**
 * IT HAD NO GIGABYTES. This stopped at MB, which was invisible while it only
 * sized file previews — and then the model library started reporting a node's
 * free space and a model's weights, and 128 GB of memory rendered as
 * "122070.3 MB". A number nobody can read is a number nobody checks, which is
 * exactly the check this feature exists to make.
 */
function fmtBytes(n) {
    const v = Number(n) || 0;
    const unit = (x, u) => `${String(+x.toFixed(1))} ${u}`;   // 128.0 -> 128
    return v < 1024 ? `${v} B`
        : v < 1048576 ? unit(v / 1024, "KB")
        : v < 1073741824 ? unit(v / 1048576, "MB")
        : v < 1099511627776 ? unit(v / 1073741824, "GB")
        : unit(v / 1099511627776, "TB");
}

/* ========================================================== THE MODULES
 *
 * "you are not modularizing the right and left sidebars, compartmentalizing
 *  each function as its own container, that is fully resizeable and pick and
 *  place, like an actual HERO ... all the contents bound by the workspace
 *  sidebar."
 *
 * So the panel is THE QUADRANT DOCK — tasks, the workspace card, activity,
 * files as 1|2 over 3|4, preview as its own column when active — and this
 * manager owns three things about the cards:
 *
 *   RESIZE    the grid's row and column SPLITS, dragged from any card's
 *             edges; an own-column card's side edge sets that column's width.
 *   PLACE     drag a card's grip strip into any slot; DOM order is the grid.
 *   REMEMBER  order, splits, per-card modes and pop geometry, per machine.
 *
 * Every live row keeps a 58px reading floor; minimized cards drop to the
 * tray at the bottom; a card whose inner block is hidden disappears whole
 * (the CSS :has rule hides the wrapper).
 */
const SB_MODS = {
    wscard: { fixed: true }             // an info card: moveable, never resized
};
const SB_ORDER_KEY = "lcl-sb-order";
// lcl-sb-h-*/lcl-sb-w-* (per-card px sizes) belonged to the wrapping-row
// era; the grid persists its geometry as splits under lcl-sb-grid instead.
// Old keys are simply ignored — stale values must never shape the quadrant.
const SB_MIN_W = 140;

const sbModEls = () => [...$("sb-mods").querySelectorAll(":scope > .sb-mod")];
const sbVisibleMods = () =>
    sbModEls().filter(m => getComputedStyle(m).display !== "none");
const sbKey = (m) => m.dataset.mod;

function sbApplyOrder() {
    let order = null;
    try { order = JSON.parse(localStorage.getItem(SB_ORDER_KEY) || "null"); } catch { }
    // THE DEFAULT QUADRANT, in the operator's own numbering: "top left =
    // position 1, top right = 2, bottom left = 3, bottom right = 4 ...
    // 1 = Tasks, 2 = Workspace, 3 = Activity, 4 = Files" — with Preview as
    // its own column when active. Grid placement is DOM order, row-major, so
    // the order array IS the quadrant. A saved order still wins: positions
    // are "the suggested default by me", not a cage.
    if (!Array.isArray(order)) order = ["tasks", "wscard", "activity", "files", "preview"];
    const host = $("sb-mods");
    for (const key of order) {
        const el = sbModEls().find(m => sbKey(m) === key);
        if (el) host.appendChild(el);
    }
}

/* ======================= THE QUADRANT DOCK =======================
 * "i feel like ordering is important here ... the right side bar should be a
 * quadrant, like a true hero section card would be. right now all the borders
 * touch, i would rather them be their own containers, within that sidepanel."
 *
 * The dock is a GRID now. Quadrant cards take the 2-wide grid in DOM order —
 * row-major, so the saved order IS the operator's 1|2 / 3|4 numbering. A card
 * expanded into its OWN COLUMN (.sb-col) becomes a full-height track beside
 * the quadrant — Preview is born that way ("position 5, being Preview and it
 * being its own third column, when active"). Minimized cards drop to the
 * bottom of the panel as full-width header bars: the tray. Resize handles
 * survived the change by moving up a level: they drag the grid's row and
 * column SPLITS (and an own-column card's width) instead of one card's box.
 */
const SB_GRID_KEY = "lcl-sb-grid";
function sbGrid() {
    try {
        const g = JSON.parse(localStorage.getItem(SB_GRID_KEY) || "{}") || {};
        return {
            colSplit: Number.isFinite(+g.colSplit) && +g.colSplit > 0 ? +g.colSplit : 50,
            colW: (g.colW && typeof g.colW === "object") ? g.colW : {},
            // per-card dragged heights — THE card the operator grabbed, alone.
            // (rowSplit, the shared band drag, is dead: "its the controls to
            // move the shit around and resize it, one container affects
            // another." A stale rowSplit key is simply ignored.)
            cardH: (g.cardH && typeof g.cardH === "object") ? g.cardH : {}
        };
    } catch { return { colSplit: 50, colW: {}, cardH: {} }; }
}
function sbSaveGrid(g) {
    try {
        localStorage.setItem(SB_GRID_KEY, JSON.stringify(
            { colSplit: g.colSplit, colW: g.colW, cardH: g.cardH }));
    } catch { }
}

const SB_COL_KEY = "lcl-sb-col-";
const SB_COL_DEFAULT = { preview: true };
function sbColOn(key) {
    let v = null; try { v = localStorage.getItem(SB_COL_KEY + key); } catch { }
    if (v === "1") return true;
    if (v === "0") return false;
    return !!SB_COL_DEFAULT[key];
}

function sbApplySizes() {
    for (const m of sbModEls()) {
        m.classList.toggle("sb-col", sbColOn(sbKey(m)));
    }
    sbFillSlack();
}

/* The max-min fair share-out (sbShareOut) and its measured essay lived here
 * for the wrapping-row era. The dock is a grid now: tracks do the dividing,
 * splits are the operator's dragged geometry, and nothing is measured to be
 * shared out. sbFillSlack keeps its name and its rAF debounce because every
 * caller and observer still speaks it. */
let sbFillPending = false;
let sbApplying = false;           // true while the layout pass writes style


function sbFillSlack() {
    if (sbFillPending) return;
    sbFillPending = true;
    requestAnimationFrame(() => {
        sbFillPending = false;
        sbApplying = true;              // the measuring pass dirties style too
        try { sbFillSlackNow(); } finally { sbApplying = false; }
    });
}

function sbFillSlackNow() { sbLayout(); }

/**
 * THE GRID, laid — CARDS OWN THEIR SIZE. Rows are content-sized (auto), a
 * filler row absorbs the leftover panel, and NOTHING stretches to fill:
 * two lonely cards are two tidy cards over open ground, never two skinny
 * full-height columns. An unsized card opens at natural height capped to
 * ~half the panel (its inner block scrolls); a dragged height (g.cardH)
 * belongs to THAT card alone. Own-column cards span down to the filler's
 * end, so they are full-height without inflating anyone's content rows.
 * A panel too narrow for two legible columns stacks everything in one.
 */
function sbLayout(gOverride) {
    const host = document.getElementById("sb-mods");
    // clientWidth 0 = the panel is collapsed or mid-slide — a layout written
    // in that state is nonsense the reopen never corrects
    if (!host || !host.clientHeight || !host.clientWidth) return;
    const vis = sbVisibleMods().filter(m => !m.classList.contains("sb-popped"));
    if (!vis.length) return;
    const g = gOverride || sbGrid();
    const minim = vis.filter(m => m.classList.contains("sb-minimized"));
    const live = vis.filter(m => !m.classList.contains("sb-minimized"));
    // a panel under 360px cannot hold two readable columns — stack ONE, and
    // treat column cards as ordinary members while it lasts
    const narrow = host.clientWidth < 360;
    const cols = narrow ? [] : live.filter(m => m.classList.contains("sb-col"));
    const quad = narrow ? live : live.filter(m => !m.classList.contains("sb-col"));
    const twoCol = !narrow && quad.length > 1;
    const R = twoCol ? Math.ceil(quad.length / 2) : quad.length;

    const tracks = [];
    if (quad.length) {
        if (twoCol) {
            const a = Math.max(15, Math.min(85, g.colSplit));
            tracks.push("minmax(0, " + a + "fr)", "minmax(0, " + (100 - a) + "fr)");
        } else tracks.push("minmax(0, 1fr)");
    }
    for (const m of cols) {
        // no quadrant on screen: the columns simply share the panel — a saved
        // px width against nothing to trade with left-anchors a lone column
        // beside dead space
        if (!quad.length) { tracks.push("minmax(0, 1fr)"); continue; }
        const w = Number(g.colW[sbKey(m)]);
        if (Number.isFinite(w) && w >= SB_MIN_W) {
            // clamped against the LIVE panel, not the panel the width was
            // saved against — a wide monitor's record must never crush the
            // quadrant's tracks to zero on a narrow one
            const wc = Math.min(Math.round(w), Math.round(host.clientWidth * 0.75));
            tracks.push("minmax(" + SB_MIN_W + "px, " + wc + "px)");
        } else tracks.push("minmax(0, 100fr)");
    }
    host.style.gridTemplateColumns = tracks.join(" ");

    // rows: R content rows, ONE filler that soaks up the leftover panel,
    // then the tray. Content rows are auto — a card is as tall as itself.
    const rows = [];
    for (let i = 0; i < R; i++) rows.push("auto");
    rows.push("minmax(0, 1fr)");
    for (const _ of minim) rows.push("auto");
    host.style.gridTemplateRows = rows.join(" ");

    const quadCols = quad.length ? (twoCol ? 2 : 1) : 0;
    const capPx = Math.round(host.clientHeight * 0.48);
    quad.forEach((m, i) => {
        m.style.gridColumn = twoCol ? String((i % 2) + 1) : "1";
        m.style.gridRow = twoCol ? String(Math.floor(i / 2) + 1) : String(i + 1);
        m.style.alignSelf = "";
        const spec = SB_MODS[sbKey(m)] || {};
        const h = Number(g.cardH[sbKey(m)]);
        if (!spec.fixed && Number.isFinite(h) && h >= 58) {
            // a dragged height is THIS card's height — nobody else moves
            m.style.height = Math.min(h, Math.round(host.clientHeight * 0.9)) + "px";
            m.style.maxHeight = "none";
            m.classList.add("sb-hset");
        } else {
            m.style.height = "";
            // natural height, capped so one huge listing cannot eat the
            // panel — the card's inner block scrolls past the cap
            m.style.maxHeight = spec.fixed ? "" : capPx + "px";
            m.classList.remove("sb-hset");
        }
    });
    cols.forEach((m, i) => {
        m.style.gridColumn = String(quadCols + i + 1);
        // span the content rows AND the filler — full height, without
        // inflating any content row (the filler absorbs the demand)
        m.style.gridRow = "1 / " + (R + 2);
        m.style.alignSelf = "stretch";
        m.style.height = ""; m.style.maxHeight = "";
        m.classList.remove("sb-hset");
    });
    minim.forEach((m, i) => {
        m.style.gridColumn = "1 / -1";
        m.style.gridRow = String(R + 2 + i);
        m.style.alignSelf = "";
        m.style.width = ""; m.style.maxHeight = "";
    });
}

/**
 * EDGE HANDLES — the container's own edges, sizing THE CONTAINER.
 *
 * "one container affects another" was the failure: the bottom edge dragged a
 * shared row split, so growing one card shrank its neighbor. The bottom
 * edge now sets THIS card's own height (g.cardH) — a delta on where the
 * card started, nobody else moves. The one shared control left is the
 * vertical COLUMN BOUNDARY on a quadrant card's side edge, which is how
 * every two-pane splitter works; an own-column card's side edge sets that
 * column's own width. Double-click any handle to reset what it drags.
 */
function sbAttachHandles(mod) {
    const spec = SB_MODS[sbKey(mod)] || {};
    const mk = (cls, cursorTitle) => {
        const h = document.createElement("div");
        h.className = "sb-handle " + cls;
        h.title = cursorTitle;
        mod.appendChild(h);
        return h;
    };
    const reset = (wantW, wantH) => {
        const g = sbGrid();
        if (wantH) delete g.cardH[sbKey(mod)];
        if (wantW) {
            if (mod.classList.contains("sb-col")) delete g.colW[sbKey(mod)];
            else g.colSplit = 50;
        }
        sbSaveGrid(g);
        sbFillSlack();
    };
    const startDrag = (e, handle, wantW, wantH) => {
        e.preventDefault();
        e.stopPropagation();
        try { handle.setPointerCapture(e.pointerId); } catch { }
        handle.classList.add("dragging");
        const r0 = mod.getBoundingClientRect();
        const x0 = e.clientX, y0 = e.clientY;
        const gLive = sbGrid();
        // deltas on the starting geometry — a grab never leaps, whatever
        // edge it is (the absolute-position mapping teleported; reviewed)
        const g0 = { colSplit: gLive.colSplit,
                     cardH: Number(gLive.cardH[sbKey(mod)]) || r0.height,
                     colW: Number(gLive.colW[sbKey(mod)]) || r0.width };
        const quadSpan = (() => {
            const qs = sbVisibleMods().filter(m =>
                !m.classList.contains("sb-popped")
                && !m.classList.contains("sb-minimized")
                && !m.classList.contains("sb-col"));
            if (!qs.length) return null;
            let L = Infinity, R = 0;
            for (const q of qs) {
                const r = q.getBoundingClientRect();
                L = Math.min(L, r.left); R = Math.max(R, r.right);
            }
            return { w: R - L };
        })();
        const move = (ev) => {
            const host = $("sb-mods");
            const hr = host.getBoundingClientRect();
            if (!hr.width || !hr.height) return;
            if (wantH) {
                // THIS card's height, alone — floor for legibility, ceiling
                // so one card cannot swallow the panel
                gLive.cardH[sbKey(mod)] = Math.max(58,
                    Math.min(Math.round(hr.height * 0.9),
                             Math.round(g0.cardH + (ev.clientY - y0))));
            }
            if (wantW) {
                if (mod.classList.contains("sb-col")) {
                    // the handle is the card's left edge: dragging LEFT
                    // widens the column — a delta on its starting width
                    gLive.colW[sbKey(mod)] = Math.max(SB_MIN_W,
                        Math.min(Math.round(hr.width * 0.75),
                                 Math.round(g0.colW - (ev.clientX - x0))));
                } else if (quadSpan && quadSpan.w > 40) {
                    gLive.colSplit = Math.max(15, Math.min(85,
                        g0.colSplit + ((ev.clientX - x0) / quadSpan.w) * 100));
                }
            }
            sbLayout(gLive);
        };
        const up = () => {
            try { handle.releasePointerCapture(e.pointerId); } catch { }
            handle.classList.remove("dragging");
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
            sbSaveGrid(gLive);
            sbFillSlack();
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
    };
    if (!spec.fixed) {
        const b = mk("sb-h-bottom", "Drag this card's height · double-click to reset");
        b.addEventListener("pointerdown", (e) => startDrag(e, b, false, true));
        b.addEventListener("dblclick", () => reset(false, true));
        const c = mk("sb-h-corner", "Drag this card's height and the column boundary · double-click to reset");
        c.addEventListener("pointerdown", (e) => startDrag(e, c, true, true));
        c.addEventListener("dblclick", () => reset(true, true));
    }
    const sde = mk("sb-h-side", "Drag the column boundary · double-click to reset");
    sde.addEventListener("pointerdown", (e) => startDrag(e, sde, true, false));
    sde.addEventListener("dblclick", () => reset(true, false));
}

function sbGripDrag(e, mod) {
    // a popped card floats over the dock — its grip must not reorder, or the
    // drag re-parents the FLOATING card into the dock beside its own
    // placeholder (two copies of the section, one of them absolute-positioned)
    if (mod.classList.contains("sb-popped")) return;
    e.preventDefault();
    const grip = e.currentTarget;
    try { grip.setPointerCapture(e.pointerId); } catch { }
    mod.classList.add("sb-lifting");
    const move = (ev) => {
        // read the panel width per move, not once at pointerdown — reordering
        // can change the stack height mid-drag, and the scrollbar appearing
        // shrinks clientWidth enough that a stale value misclassifies every
        // full-width module as a shared-row target
        const panelW = $("sb-mods").clientWidth;
        for (const other of sbVisibleMods()) {
            if (other === mod) continue;
            const r = other.getBoundingClientRect();
            // only a module whose row band the pointer is inside can be the
            // drop target — no leaping over distant sections
            if (ev.clientY < r.top || ev.clientY > r.bottom) continue;
            // side-by-side rows exist now: within a shared row the X axis
            // decides before/after; a full-width row still splits on Y
            const shared = r.width < panelW - 12;
            const before = shared
                ? ev.clientX < r.left + r.width / 2
                : ev.clientY < r.top + r.height / 2;
            if (before
                && mod.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_PRECEDING) {
                other.before(mod); sbLayout(); break;
            }
            if (!before
                && mod.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) {
                other.after(mod); sbLayout(); break;
            }
        }
    };
    const up = () => {
        try { grip.releasePointerCapture(e.pointerId); } catch { }
        mod.classList.remove("sb-lifting");
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        try {
            // a POPPED module holds its dock spot via its placeholder — the
            // saved order walks the dock's children and reads a placeholder as
            // the module it stands for, so floating a section never drops it
            // from the layout it returns to
            const orderNow = [...$("sb-mods").children]
                .map(el => el.classList.contains("sb-mod-placeholder")
                    ? el.dataset.for : (el.dataset.mod || null))
                .filter(Boolean);
            localStorage.setItem(SB_ORDER_KEY, JSON.stringify(orderNow));
        } catch { }
        sbApplySizes();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
}

/* =====================================================================
 * TRUE MODULARITY. Each section gets a header bar with:
 * minimize (collapse to the bar), pop-out (float as a movable card), and the
 * grip (reorder). A triple-dot menu in the panel head shows/hides which
 * sections appear in the dock — hiding removes the VIEW, never the function.
 * "a full fledged true hero assistant … pop out and minimize … move in and
 * out of the sidebar." State (minimized, popped position, hidden) persists.
 * ===================================================================== */
const SB_TITLES = { tasks: "Tasks", activity: "Activity", wscard: "Workspace",
                    files: "Files", preview: "Preview" };
const SB_MIN_KEY = "lcl-sb-min-";       // minimized flag per module
const SB_HIDE_KEY = "lcl-sb-hidden";    // JSON array of hidden module keys
const SB_POP_KEY = "lcl-sb-pop-";       // JSON {x,y,w,h} per popped module

const sbHidden = () => {
    try { return new Set(JSON.parse(localStorage.getItem(SB_HIDE_KEY) || "[]")); }
    catch { return new Set(); }
};
const sbSetHidden = (set) => {
    try { localStorage.setItem(SB_HIDE_KEY, JSON.stringify([...set])); } catch { }
};

/* build the header bar on a module, once */
function sbBuildHeader(mod) {
    if (mod.querySelector(":scope > .sb-mod-head")) return;
    const key = sbKey(mod);
    const head = document.createElement("div");
    head.className = "sb-mod-head";

    const grip = document.createElement("span");
    grip.className = "sb-mod-grip";
    grip.title = "Drag to move this section";
    grip.innerText = "⠿";
    grip.addEventListener("pointerdown", (e) => sbGripDrag(e, mod));
    head.appendChild(grip);

    const title = document.createElement("span");
    title.className = "sb-mod-title";
    title.innerText = SB_TITLES[key] || key;
    head.appendChild(title);

    const mkBtn = (cls, label, glyph, fn) => {
        const b = document.createElement("button");
        b.className = "sb-mod-btn " + cls;
        b.title = label;
        b.setAttribute("aria-label", label);
        b.innerHTML = glyph;
        b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
        head.appendChild(b);
    };
    // own column: the middle life between a quadrant slot and a floating
    // card — "pop it out into its own column ... that should be a new button
    // on the card". Full height, still in the dock, no floating real estate.
    mkBtn("sb-colbtn", "Expand into its own full-height column",
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="4" y="4" width="16" height="16" rx="1"/><line x1="14" y1="4" x2="14" y2="20"/></svg>',
        () => sbToggleCol(mod));
    // pop-out (dock-back lives on the minimize button while floating)
    mkBtn("sb-pop", "Pop out as a floating card",
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>',
        () => sbTogglePop(mod));
    // minimize / expand — and on a FLOATING card, the dock-back control:
    // "we dont need the pop out button when popped out, we need the minimize
    // button to minimize the popped out window back into the tray to its slot"
    mkBtn("sb-min", "Minimize to the header",
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>',
        () => {
            if (mod.classList.contains("sb-popped")) { sbDock(mod); return; }
            sbToggleMin(mod);
        });

    // the old bare grip strip, if present, is replaced by this header
    const oldGrip = mod.querySelector(":scope > .sb-mod-grip");
    if (oldGrip) oldGrip.remove();
    mod.insertBefore(head, mod.firstChild);
}

/**
 * MINIMIZED IS A CLASS AND A KEY, MOVED TOGETHER. Column mode and pop-out
 * both expand a minimized card; when they stripped only the class, the stale
 * key resurrected a tray bar on reload that the operator had left expanded —
 * the session's end state and the restored state diverged. Every path that
 * changes the minimized STATE goes through here.
 */
function sbSetMin(mod, on) {
    mod.classList.toggle("sb-minimized", on);
    try { localStorage.setItem(SB_MIN_KEY + sbKey(mod), on ? "1" : "0"); } catch { }
}
function sbToggleMin(mod) {
    sbSetMin(mod, !mod.classList.contains("sb-minimized"));
    sbPaintModBtns(mod);
    sbFillSlack();
}

/** Own-column mode: a full-height track in the dock, toggled per card. */
function sbToggleCol(mod) {
    const on = mod.classList.toggle("sb-col");
    try { localStorage.setItem(SB_COL_KEY + sbKey(mod), on ? "1" : "0"); } catch { }
    // a card entering its own column has the whole height — nothing to hide,
    // and the minimized KEY clears with the class or a reload brings it back
    if (on) sbSetMin(mod, false);
    sbPaintModBtns(mod);
    sbFillSlack();
}

/** The header buttons say what they will DO from this state. */
function sbPaintModBtns(mod) {
    const popped = mod.classList.contains("sb-popped");
    const minB = mod.querySelector(":scope > .sb-mod-head .sb-min");
    if (minB) {
        minB.title = popped
            ? "Return this card to its slot in the dock"
            : mod.classList.contains("sb-minimized")
                ? "Expand from the header" : "Minimize to the header";
        minB.setAttribute("aria-label", minB.title);
    }
    const colB = mod.querySelector(":scope > .sb-mod-head .sb-colbtn");
    if (colB) {
        colB.title = mod.classList.contains("sb-col")
            ? "Return to the quadrant" : "Expand into its own full-height column";
        colB.setAttribute("aria-label", colB.title);
    }
}

/* pop a module OUT of the dock into a floating, draggable card */
function sbTogglePop(mod) {
    if (mod.classList.contains("sb-popped")) { sbDock(mod); return; }
    const key = sbKey(mod);
    const r = mod.getBoundingClientRect();
    mod.classList.add("sb-popped");
    sbSetMin(mod, false);      // the key clears WITH the class — see sbSetMin
    // a placeholder holds its spot in the dock so order/return is stable
    const ph = document.createElement("div");
    ph.className = "sb-mod-placeholder";
    ph.dataset.for = key;
    mod.after(ph);
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SB_POP_KEY + key) || "null"); } catch { }
    let x = saved ? saved.x : Math.max(20, r.left - 320);
    let y = saved ? saved.y : Math.max(50, r.top);
    // FIRST POP OPENS AT THE CONTENT'S OWN SIZE — a card cropped in the dock
    // must not pop out still cropped. Measure the inner block's scroll size
    // (plus the header) and open big enough to show it, capped to the viewport.
    const inner = mod.querySelector(":scope > .sb-mod-inner");
    const wantW = Math.max(320, r.width, inner ? inner.scrollWidth + 12 : 0);
    const wantH = Math.max(200, (inner ? inner.scrollHeight : r.height || 240) + 26);
    const w = saved ? saved.w : Math.min(wantW, Math.round(window.innerWidth * 0.6));
    const h = saved ? saved.h : Math.min(wantH, Math.round(window.innerHeight * 0.7));
    // CLAMP THE RESTORED POSITION to the current viewport — a position saved on
    // a wide external monitor would otherwise place the card fully off-screen on
    // a laptop panel, with no header to grab it back (only reload recovers).
    x = Math.max(0, Math.min(window.innerWidth - 80, x));
    y = Math.max(0, Math.min(window.innerHeight - 40, y));
    mod.style.left = x + "px"; mod.style.top = y + "px";
    mod.style.width = w + "px"; mod.style.height = h + "px";
    document.body.appendChild(mod);          // float above everything
    // save only a FIRST pop — a restore already has its record, and re-saving
    // here would overwrite the operator's geometry with the viewport-clamped
    // values (or with a 0-rect during the boot re-pop, before layout)
    if (!saved) sbSavePop(mod);
    // persist the native bottom-right resize (debounced), so a card keeps its
    // size across pop/dock and reload
    try {
        let t = null;
        const ro = new ResizeObserver(() => {
            if (t) clearTimeout(t);
            t = setTimeout(() => { if (mod.classList.contains("sb-popped")) sbSavePop(mod); }, 200);
        });
        ro.observe(mod);
        mod._popRO = ro;
    } catch { /* no ResizeObserver: size still saves on drag-end */ }
    sbPaintModBtns(mod);
    sbFillSlack();
}
function sbDock(mod) {
    const key = sbKey(mod);
    if (mod._popRO) { try { mod._popRO.disconnect(); } catch { } mod._popRO = null; }
    mod.classList.remove("sb-popped");
    mod.style.left = mod.style.top = mod.style.width = mod.style.height = "";
    const ph = $("sb-mods").querySelector('.sb-mod-placeholder[data-for="' + key + '"]')
        || document.querySelector('.sb-mod-placeholder[data-for="' + key + '"]');
    if (ph) ph.replaceWith(mod); else $("sb-mods").appendChild(mod);
    try { localStorage.removeItem(SB_POP_KEY + key); } catch { }
    sbPaintModBtns(mod);
    sbApplySizes();
    sbFillSlack();
}
function sbSavePop(mod) {
    const r = mod.getBoundingClientRect();
    // a hidden or not-yet-laid-out card measures 0×0 — writing that would
    // destroy the real geometry the record exists to keep
    if (!r.width && !r.height) return;
    try {
        localStorage.setItem(SB_POP_KEY + sbKey(mod),
            JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top),
                             w: Math.round(r.width), h: Math.round(r.height) }));
    } catch { }
}

/* dragging a popped card by its header */
function sbPopDrag(e, mod) {
    if (!mod.classList.contains("sb-popped")) return;
    e.preventDefault();
    const head = e.currentTarget;
    try { head.setPointerCapture(e.pointerId); } catch { }
    const r = mod.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => {
        mod.style.left = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - dx)) + "px";
        mod.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy)) + "px";
    };
    const up = () => {
        try { head.releasePointerCapture(e.pointerId); } catch { }
        head.removeEventListener("pointermove", move);
        head.removeEventListener("pointerup", up);
        sbSavePop(mod);
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
}

/* apply hidden / minimized / popped state on load */
function sbApplyModStates() {
    const hidden = sbHidden();
    for (const m of sbModEls().concat([...document.querySelectorAll("body > .sb-mod")])) {
        const key = sbKey(m);
        m.classList.toggle("sb-hidden-view", hidden.has(key));
        m.classList.toggle("sb-col", sbColOn(key));
        let mn = "0"; try { mn = localStorage.getItem(SB_MIN_KEY + key) || "0"; } catch { }
        m.classList.toggle("sb-minimized", mn === "1" && !m.classList.contains("sb-popped"));
        // POP STATE SURVIVES A RELOAD: a saved pop record whose module is
        // still docked means the card was floating when the app closed — float
        // it again. sbTogglePop reads the same record for position/size.
        if (!m.classList.contains("sb-popped") && !hidden.has(key)) {
            let pop = null;
            try { pop = localStorage.getItem(SB_POP_KEY + key); } catch { }
            if (pop) sbTogglePop(m);
        }
        sbPaintModBtns(m);
    }
}

/* the triple-dot show/hide-view menu */
function sbToggleViewMenu() {
    const menu = $("sb-view-menu");
    if (!menu) return;
    if (!menu.classList.contains("hidden")) { menu.classList.add("hidden"); return; }
    menu.innerHTML = "";
    const hidden = sbHidden();
    const title = document.createElement("div");
    title.className = "sb-view-menu-title";
    title.innerText = "Sections in the sidebar";
    menu.appendChild(title);
    for (const m of sbModEls()) {
        const key = sbKey(m);
        const row = document.createElement("label");
        row.className = "sb-view-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !hidden.has(key);
        cb.addEventListener("change", () => {
            const set = sbHidden();
            if (cb.checked) set.delete(key); else set.add(key);
            sbSetHidden(set);
            // hiding a POPPED section docks it first — otherwise the floating
            // card stays on screen while the dock calls it hidden
            if (!cb.checked && m.classList.contains("sb-popped")) sbDock(m);
            m.classList.toggle("sb-hidden-view", !cb.checked);
            sbFillSlack();
        });
        const nm = document.createElement("span");
        nm.innerText = SB_TITLES[key] || key;
        row.appendChild(cb); row.appendChild(nm);
        menu.appendChild(row);
    }
    const note = document.createElement("div");
    note.className = "sb-view-note";
    note.innerText = "Hiding a section removes its view only — its work keeps running.";
    menu.appendChild(note);
    menu.classList.remove("hidden");
}

(function sbInit() {
    if (!document.getElementById("sb-mods")) return;
    sbApplyOrder();
    sbApplySizes();
    for (const m of sbModEls()) {
        sbBuildHeader(m);
        // header drags a popped card; grip inside it reorders a docked one
        const head = m.querySelector(":scope > .sb-mod-head");
        if (head) head.addEventListener("pointerdown", (e) => {
            if (e.target.closest(".sb-mod-grip, .sb-mod-btn")) return;
            sbPopDrag(e, m);
        });
        sbAttachHandles(m);
    }
    sbApplyModStates();
    const vb = $("sb-view-menu-btn");
    if (vb) vb.addEventListener("click", (e) => { e.stopPropagation(); sbToggleViewMenu(); });
    document.addEventListener("click", (e) => {
        const menu = $("sb-view-menu");
        if (menu && !menu.classList.contains("hidden")
            && !e.target.closest("#sb-view-menu, #sb-view-menu-btn")) {
            menu.classList.add("hidden");
        }
    });
    // the slack measurement goes stale whenever a section shows or hides or
    // the panel changes size — both are class flips or window geometry, and
    // sbFillSlack is rAF-debounced so observing broadly costs one measure a
    // frame at worst
    new MutationObserver(() => { if (!sbApplying) sbFillSlack(); }).observe($("sb-mods"),
        { attributes: true, attributeFilter: ["class"], subtree: true });
    window.addEventListener("resize", () => sbFillSlack());
})();

async function openFileViewer(relPath) {
    if (!active || !active.repoPath) return;

    const pane = $("ws-viewer");
    const body = $("ws-viewer-body");
    pane.classList.remove("hidden");
    $("ws-viewer-name").innerText = relPath;
    $("ws-viewer-name").title = relPath;
    $("ws-viewer-size").innerText = "";
    viewerPath = relPath;

    document.querySelectorAll("#ws-files .ws-file").forEach(r =>
        r.classList.toggle("viewing", r.dataset.rel === relPath));

    body.innerHTML = "";
    const note = document.createElement("div");
    note.className = "ws-note";
    note.innerText = "reading…";
    body.appendChild(note);

    const res = await window.lcl.viewFile(active.id, relPath);
    if (viewerPath !== relPath) return;        // user clicked something else meanwhile
    body.innerHTML = "";

    if (!res || res.error) {
        const err = document.createElement("div");
        err.className = "ws-note";
        err.innerText = (res && res.error) || "could not read file";
        body.appendChild(err);
        return;
    }

    $("ws-viewer-size").innerText = fmtBytes(res.size);

    if (res.kind === "pdf") {
        // the document itself, in Chromium's own viewer — never its extraction
        const fr = document.createElement("iframe");
        fr.className = "kdoc-pdf";
        fr.src = res.fileUrl;
        body.appendChild(fr);
    } else if (res.kind === "image") {
        const img = document.createElement("img");
        img.className = "viewer-image";
        img.src = res.dataUri;
        img.alt = res.name;
        body.appendChild(img);
    } else if (res.kind === "binary") {
        const b = document.createElement("div");
        b.className = "ws-note";
        b.innerText = "binary file — no preview";
        body.appendChild(b);
    } else if (/\.(md|markdown)$/i.test(res.name)) {
        body.appendChild(renderMarkdown(res.content));
    } else {
        const lang = res.ext ? res.ext.slice(1) : "";
        if (window.lclSyntax) {
            body.appendChild(window.lclSyntax.codeBlock(res.content, lang));
        } else {
            const pre = document.createElement("pre");
            pre.innerText = res.content;
            body.appendChild(pre);
        }
    }

    if (res.truncated) {
        const t = document.createElement("div");
        t.className = "ws-note";
        t.innerText = "preview truncated — file is larger than 2 MB";
        body.appendChild(t);
    }
}

function closeFileViewer() {
    viewerPath = null;
    // the module wrapper follows via the :has rule, and the manager's
    // observer withdraws its divider — a divider with one side is a line
    $("ws-viewer").classList.add("hidden");
    $("ws-viewer-body").innerHTML = "";
    document.querySelectorAll("#ws-files .ws-file.viewing")
        .forEach(r => r.classList.remove("viewing"));
}

$("ws-viewer-close").addEventListener("click", closeFileViewer);

/**
 * LAUNCH IN WORKSPACE — render a served site INSIDE the workspace panel, not a
 * browser tab. The requirement: the control should read Launch in Workspace and
 * actually launch the served folder in the workspace sidebar. A loopback
 * iframe (the CSP now permits 127.0.0.1/localhost frames) shows the live site in
 * the preview pane; it is cross-origin from this file:// app, so it cannot touch
 * window.lcl. Sandboxed to scripts/forms only.
 */
function launchServedInWorkspace(url) {
    toggleWorkspace(true);
    const pane = $("ws-viewer");
    const body = $("ws-viewer-body");
    pane.classList.remove("hidden");
    const shown = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    $("ws-viewer-name").innerText = shown;
    $("ws-viewer-name").title = url;
    $("ws-viewer-size").innerText = "live";
    viewerPath = null;
    document.querySelectorAll("#ws-files .ws-file").forEach(r => r.classList.remove("viewing"));
    body.innerHTML = "";
    const frame = document.createElement("iframe");
    frame.className = "ws-served-frame";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
    frame.src = url;
    body.appendChild(frame);
}

/**
 * ANCIENT KNOWLEDGE'S LIVING DOCUMENT, kept live in the sidebar.
 *
 * The engine writes ancient_knowledge.md into the linked folder every audit
 * round; this keeps what is on screen honest about it after each turn:
 *   - the file list reloads, and loadWorkspaceFiles re-opens viewerPath on
 *     its own — so a review already on screen updates in place, free;
 *   - when a turn was audited and NOTHING else is open in the viewer, the
 *     review opens itself (the audit is the news of the turn);
 *   - a file the operator chose to read is never stolen from under them.
 */
async function refreshReviewDoc(newMessages, forSession) {
    // THE SESSION IS CAPTURED, NOT RE-READ. This gated on the global `active`
    // and then awaited twice; switching sessions inside either window meant
    // the next line was reasoning about a different conversation, and the
    // review of the session that just finished got opened over the one the
    // operator had just moved to. sendText threads its own captured session
    // through everything else for exactly this reason.
    const ses = forSession || active;
    if (!ses || ses.ancientKnowledge !== true || !ses.repoPath) return;
    const stillViewing = () => active && active.id === ses.id;
    if (!stillViewing()) return;

    const audited = (newMessages || []).some(m =>
        m && m.meta && m.meta.model === "ancient-knowledge");
    if (!workspaceOpen()) {
        if (!audited) return;
        toggleWorkspace(true);
    }
    const wasViewing = viewerPath;
    await loadWorkspaceFiles();                 // re-opens viewerPath itself
    if (!audited || wasViewing || !stillViewing()) return;

    // WHICH REVIEW IS THIS SESSION'S. The engine records the exact filename on
    // the session record (`akReviewFile`) because two sessions sharing one
    // folder get different files. Scanning for the first name that merely
    // LOOKS like a review picked the other session's suffixed file, which
    // sorts before the plain one — the operator would have been reading a
    // different conversation's audit.
    const res = await window.lcl.listFiles(ses.id).catch(() => null);
    if (!stillViewing()) return;
    const entries = (res && Array.isArray(res.entries)) ? res.entries : [];
    const names = entries.map(e => {
        const m = /^(.*)\s\(-?\d+ bytes\)$/.exec(e); return String(m ? m[1] : e);
    });
    const mine = ses.akReviewFile ? String(ses.akReviewFile) : null;
    const suffixed = "ancient_knowledge-" + String(ses.id).slice(0, 8) + ".md";
    const hit = (mine && names.find(p => p.toLowerCase() === mine.toLowerCase()))
        || names.find(p => p.toLowerCase() === suffixed.toLowerCase())
        // the plain name, for a session that has not recorded one yet
        || names.find(p => /^ancient_knowledge\.md$/i.test(p))
        // LEGACY, LAST. Folders written before the rename still hold
        // SESSION-REVIEW.md; the engine migrates it on the next write, but
        // until then it is still this session's review and must still open.
        // This was the ONLY fallback for a while after the rename, which meant
        // a session with no akReviewFile on record could not find the file the
        // app itself had just written.
        || names.find(p => /^SESSION-REVIEW\.md$/i.test(p));
    if (hit) openFileViewer(hit);
}

/**
 * Minimal markdown → DOM. Built with createElement/textContent throughout —
 * file contents are UNTRUSTED input and must never reach innerHTML. Links
 * render as styled text with the destination in the tooltip: this app is
 * offline by promise, so nothing in a preview navigates anywhere.
 */
function renderMarkdown(src) {
    const rootEl = document.createElement("div");
    rootEl.className = "md";
    const lines = String(src).split(/\r?\n/);

    let i = 0;
    // one entry per open list LEVEL, so nesting is a real tree rather than a
    // single flat list that loses every indent
    const stack = [];
    const para = [];

    // lists are appended as they are created, so closing is just forgetting the
    // open levels — the DOM is already correct
    const closeList = () => { stack.length = 0; };
    const flushPara = () => {
        if (!para.length) return;
        const p = document.createElement("p");
        appendMdInline(p, para.join(" "));
        rootEl.appendChild(p);
        para.length = 0;
    };

    while (i < lines.length) {
        const line = lines[i];

        const fence = /^\s*```\s*(\w*)\s*$/.exec(line);
        if (fence) {
            flushPara(); closeList();
            const buf = [];
            i++;
            while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
            i++;
            if (window.lclSyntax) {
                rootEl.appendChild(window.lclSyntax.codeBlock(buf.join("\n"), fence[1] || ""));
            } else {
                const pre = document.createElement("pre");
                pre.innerText = buf.join("\n");
                rootEl.appendChild(pre);
            }
            continue;
        }

        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h) {
            flushPara(); closeList();
            const el = document.createElement("h" + h[1].length);
            appendMdInline(el, h[2].trim().replace(/\s+#+\s*$/, ""));  // closing ### is decoration
            rootEl.appendChild(el);
            i++; continue;
        }

        // SETEXT HEADINGS — Title\n===== and Title\n----- . Common in real
        // documents and READMEs, and previously rendered as a paragraph
        // followed by a horizontal rule, which is not what it means.
        if (line.trim() && i + 1 < lines.length && !para.length
            && /^\s*(=+|-+)\s*$/.test(lines[i + 1]) && lines[i + 1].trim().length >= 2) {
            flushPara(); closeList();
            const el = document.createElement(/=/.test(lines[i + 1]) ? "h1" : "h2");
            appendMdInline(el, line.trim());
            rootEl.appendChild(el);
            i += 2; continue;
        }

        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            flushPara(); closeList();
            rootEl.appendChild(document.createElement("hr"));
            i++; continue;
        }

        /* LISTS, INCLUDING NESTED AND TASK LISTS.
         *
         * The old version matched one flat level and threw the indent away, so
         * every sub-item jumped back to the left margin — on a document with a
         * real outline that is not "sort of rendered", it is wrong. Indent is
         * measured (tab = 4), and a deeper item opens a child list inside the
         * previous <li>; a shallower one closes back down to its level.
         *
         * `- [ ]` / `- [x]` become real disabled checkboxes rather than
         * literal brackets in the text.
         */
        const ulm = /^(\s*)[-*+]\s+(.*)$/.exec(line);
        const olm = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
        if (ulm || olm) {
            flushPara();
            const indent = (ulm ? ulm[1] : olm[1]).replace(/\t/g, "    ").length;
            const type = ulm ? "ul" : "ol";
            let text = ulm ? ulm[2] : olm[3];

            // close deeper levels than this one
            while (stack.length && indent < stack[stack.length - 1].indent) stack.pop();

            let top = stack[stack.length - 1];
            if (!top || indent > top.indent) {
                const el = document.createElement(type);
                if (olm && olm[2] !== "1") el.setAttribute("start", olm[2]);
                if (top) {
                    // nest inside the last item of the level above
                    const host = top.el.lastElementChild || top.el;
                    host.appendChild(el);
                } else {
                    rootEl.appendChild(el);
                }
                stack.push({ el, indent, type });
                top = stack[stack.length - 1];
            } else if (top.type !== type) {
                // same depth, different kind of list — start a sibling list
                stack.pop();
                const el = document.createElement(type);
                const parent = stack.length
                    ? (stack[stack.length - 1].el.lastElementChild || stack[stack.length - 1].el)
                    : rootEl;
                parent.appendChild(el);
                stack.push({ el, indent, type });
                top = stack[stack.length - 1];
            }

            const li = document.createElement("li");
            const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
            if (task) {
                const box = document.createElement("input");
                box.type = "checkbox";
                box.disabled = true;
                box.checked = task[1].toLowerCase() === "x";
                box.className = "md-task";
                li.appendChild(box);
                text = task[2];
                li.classList.add("md-task-item");
            }
            appendMdInline(li, text.trim());
            top.el.appendChild(li);
            i++; continue;
        }

        const q = /^\s*>\s?(.*)$/.exec(line);
        if (q) {
            flushPara(); closeList();
            const bq = document.createElement("blockquote");
            const buf = [q[1]];
            i++;
            for (;;) {
                const qq = i < lines.length ? /^\s*>\s?(.*)$/.exec(lines[i]) : null;
                if (!qq) break;
                buf.push(qq[1]); i++;
            }
            appendMdInline(bq, buf.join(" "));
            rootEl.appendChild(bq);
            continue;
        }

        // | table | with a separator row
        if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length
            && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
            flushPara(); closeList();
            const parseRow = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
            const table = document.createElement("table");
            const thead = document.createElement("thead");
            const trh = document.createElement("tr");
            for (const c of parseRow(line)) {
                const th = document.createElement("th");
                appendMdInline(th, c);
                trh.appendChild(th);
            }
            thead.appendChild(trh);
            table.appendChild(thead);
            i += 2;
            const tbody = document.createElement("tbody");
            while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
                const tr = document.createElement("tr");
                for (const c of parseRow(lines[i])) {
                    const td = document.createElement("td");
                    appendMdInline(td, c);
                    tr.appendChild(td);
                }
                tbody.appendChild(tr);
                i++;
            }
            table.appendChild(tbody);
            rootEl.appendChild(table);
            continue;
        }

        if (!line.trim()) { flushPara(); closeList(); i++; continue; }

        para.push(line.trim());
        i++;
    }
    flushPara(); closeList();
    return rootEl;
}

/** Inline markdown: `code`, **bold**, *italic*, [text](url). Text nodes only. */
function appendMdInline(el, text) {
    /* Order matters: code first so nothing inside backticks is re-read, then
     * the two-character marks (**, __, ~~) before their single-character
     * cousins, then images before links because `![x](y)` starts like `[x](y)`,
     * then bare autolinks last so they cannot eat a link's URL. */
    const re = new RegExp([
        "(`+)([^`]+?)\\1",                    // 1,2  `code`
        "~~([^~]+)~~",                        // 3    ~~strike~~
        "\\*\\*([^*]+)\\*\\*",                // 4    **bold**
        "__([^_]+)__",                        // 5    __bold__
        "\\*([^*\\s][^*]*)\\*",               // 6    *italic*
        "_([^_\\s][^_]*)_",                   // 7    _italic_
        "!\\[([^\\]]*)\\]\\(([^)\\s]+)[^)]*\\)",   // 8,9  ![alt](src)
        "\\[([^\\]]*)\\]\\(([^)\\s]+)[^)]*\\)",    // 10,11 [text](href)
        "<((?:https?|mailto):[^>\\s]+)>",     // 12   <https://…>
        "\\b(https?://[^\\s<>()]+)"           // 13   bare url
    ].join("|"), "g");

    let last = 0, m;
    while ((m = re.exec(text))) {
        if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
        if (m[2] !== undefined) {
            const c = document.createElement("code");
            c.textContent = m[2];
            el.appendChild(c);
        } else if (m[3] !== undefined) {
            const s = document.createElement("del");
            s.textContent = m[3];
            el.appendChild(s);
        } else if (m[4] !== undefined || m[5] !== undefined) {
            const b = document.createElement("strong");
            appendMdInline(b, m[4] !== undefined ? m[4] : m[5]);   // bold can hold code/italic
            el.appendChild(b);
        } else if (m[6] !== undefined || m[7] !== undefined) {
            const it = document.createElement("em");
            appendMdInline(it, m[6] !== undefined ? m[6] : m[7]);
            el.appendChild(it);
        } else if (m[9] !== undefined) {
            // AN IMAGE IS AN IMAGE. It used to render as the alt text in link
            // styling, so every diagram in a document was a grey word. Only
            // local and data sources are drawn — this app does not fetch from
            // the network to preview a file.
            const src = m[9];
            if (/^(data:image\/|file:|\.{0,2}\/)/i.test(src)) {
                const img = document.createElement("img");
                img.className = "md-img";
                img.alt = m[8] || "";
                img.src = src;
                el.appendChild(img);
            } else {
                const ph = document.createElement("span");
                ph.className = "md-img-missing";
                ph.textContent = m[8] ? `ðŸ–¼ ${m[8]}` : "ðŸ–¼ image";
                ph.title = src + " — not loaded, this preview stays offline";
                el.appendChild(ph);
            }
        } else if (m[11] !== undefined) {
            const a = document.createElement("span");
            a.className = "md-link";
            a.textContent = m[10] || m[11];
            a.title = m[11];
            el.appendChild(a);
        } else {
            const url = m[12] !== undefined ? m[12] : m[13];
            const a = document.createElement("span");
            a.className = "md-link";
            a.textContent = url;
            a.title = url;
            el.appendChild(a);
        }
        last = m.index + m[0].length;
    }
    if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

// =============================================================
// MODEL PICKER  (composer — which model answers)
// =============================================================
const modelPickBtn = $("model-pick");
const modelMenu = $("model-menu");
let modelsCache = [];
// is the ACTIVE model a linked endpoint's? kept current by refreshModelPick
const remoteActive = () => modelsCache.some(m => m.remote && m.active);

/**
 * CAN THE SESSION ON SCREEN BE SENT TO RIGHT NOW?
 *
 * `ready` is one flag for one local engine, which is honest — there IS only
 * one llama-server. What was not honest was using it as the gate for EVERY
 * session. A session bound to the operator's Spark, or to an API, needs no
 * local engine at all.
 *
 * The engine-state handler already declines to touch `ready` while a remote
 * model drives (see its `if (remoteActive()) return`) — but that answers for
 * whichever session was being VIEWED when the event arrived. Watch the local
 * session while the memory guard stops it, then switch to the API session:
 * `ready` is false, nothing re-evaluates it, and the composer is dead in a
 * conversation the cloud was serving perfectly. Three sessions at once is
 * exactly the situation that produces it.
 *
 * Asking at USE time, about the session actually on screen, is the fix. Both
 * halves stay true: one engine, one flag; and a session that does not need
 * the engine is never blocked by it.
 */
const canSend = () => ready || remoteActive();

/** Is a LOCAL turn generating in some OTHER session right now? */
const localTurnElsewhere = () => [...pendingSessions].some(
    id => id !== (active && active.id) && !remotePending.has(id));

/**
 * THE APP'S OWN WORDS, IN THE OPERATOR'S TONE.
 *
 * voice.js holds a small table of conversational strings with one line per
 * tone. It lives in the main process, so the renderer keeps a resolved copy and
 * refreshes it whenever the tone changes. The fallback is the exact string that
 * used to be hard-coded at each site, so a failed fetch changes nothing.
 *
 * DIAGNOSTICS ARE NOT IN THE TABLE AND NEVER WILL BE. An error, a warning, a
 * refusal or a count reads the same in every tone; only these conversational
 * surfaces move.
 */
let appLines = {};
const say = (key, fallback) => appLines[key] || fallback;
async function refreshAppLines() {
    const r = await window.lcl.voiceLines().catch(() => null);
    if (r && r.ok && r.lines) appLines = r.lines;
}
let imageModelsCache = [];
// true while a model switch is in flight: gates the picker, and tells the
// engine-state handler that switchModel owns error reporting right now
let switching = false;
// the session's resolved model, as the main process reported it — kept so the
// picker menu can say when a stored choice can no longer be honoured
let sessionModelState = null;

async function refreshModelPick() {
    let res = null;
    // asked FOR THIS SESSION, so the tick names the model that will answer
    // this conversation rather than whatever the app default happens to be
    try { res = await window.lcl.listModels(active ? active.id : null); }
    catch { return; }
    if (!res || !Array.isArray(res.models)) return;
    // Order the picker most-capable first — bigger models on top, so the
    // strongest option is the obvious one. Parameter count is the primary
    // signal; the registry's reasoning/code traits break ties.
    const paramNum = (p) => parseFloat(String(p || "0").replace(/[^0-9.]/g, "")) || 0;
    const power = (m) => paramNum(m.params) * 100 +
        ((m.reasoning || 0) + (m.code || 0) + (m.chat || 0));

    // WHERE IT RUNS FIRST, HOW BIG IT IS SECOND.
    //
    // This sorted purely by parameter count, so a 123B on a machine across the
    // room outranked everything on the local machine and sat at the top of the
    // list — a remote node's models listed before the local machine's own.
    // Size is the right tiebreak, but it is not the first question.
    // The first question is which machine answers, because that decides
    // whether it costs anything, whether it needs the network, and whether it
    // works at all right now.
    //
    // 0 this machine · 1 machines you own · 2 endpoints you pay for
    // THE ORDER, AS SPECIFIED: Local, Local Nodes, API, GPU.
    //   0 this machine
    //   1 machines you own — "not a GPU that is rented"
    //   2 API vendors
    //   3 a GPU rented by the hour: somebody else's hardware, billed by time
    const tier = (m) => !m.remote ? 0
        : m.rented ? 3
        : (m.localNode || m.isNode) ? 1
        : 2;
    modelsCache = res.models.slice()
        .sort((a, b) => (tier(a) - tier(b)) || (power(b) - power(a)));
    // the group each entry belongs to, so the menu can head them rather than
    // running three different kinds of thing together in one list
    // A RENTED GPU IS NOT AN API VENDOR. Tier 3 had no group key of its own, so
    // every rented endpoint fell into the "api:" bucket and was grouped with
    // hardware billed per token — the exact conflation the fourth tier exists to
    // undo. It keys and labels by PROVIDER, because that is the name the person
    // renting it recognises.
    for (const m of modelsCache) {
        m.groupKey = tier(m) === 0 ? "local"
            : tier(m) === 1 ? "node:" + (m.endpointLabel || "your machine")
            : tier(m) === 3 ? "gpu:" + (m.provider || m.endpointLabel || "rented GPU")
            : "api:" + (m.endpointLabel || "endpoint");
        m.groupLabel = tier(m) === 0 ? "This machine"
            : tier(m) === 1 ? (m.endpointLabel || "Your machine")
            : tier(m) === 3 ? (m.provider || m.endpointLabel || "Rented GPU")
            : (m.endpointLabel || "API");
    }
    imageModelsCache = Array.isArray(res.imageModels) ? res.imageModels : [];

    const act = modelsCache.find(m => m.active);

    // WHAT WILL ANSWER THIS CONVERSATION — from the one place that knows.
    //
    // These labels used to be derived from the models LIST, which reports what
    // is RUNNING. So a session that chose a local model the engine has not
    // loaded yet was labelled with the resident model's name and plan, and a
    // remote pick read "api" — the literal params string — including for a
    // node, which every other surface insists is not an API. Same source as
    // the status line and the cost meter now, so they cannot disagree.
    let ses = null;
    try {
        const st = await window.lcl.cloudState(active ? active.id : null);
        ses = st && st.session;
        // THE LIVE WINDOW, from the same limits the router will use for the
        // next turn. describeSelection never carried contextLength, so the
        // donut's first-priority source was a dead branch and every surface
        // fell back to the picker cache — which nothing refreshed on a spark
        // mode switch. router.limits() reads the endpoint store fresh, so this
        // figure follows every switch the moment this function runs.
        if (ses && st.limits && Number(st.limits.contextLength)) {
            ses.contextLength = Number(st.limits.contextLength);
        }
    } catch { /* fall back to the list below */ }
    sessionModelState = ses;

    const shortName = (label) => String(label || "").split("/").pop();
    if (ses) {
        $("model-pick-label").innerText = ses.kind === "local"
            ? (act && !ses.id ? act.params : shortName(ses.model) || "model")
            : shortName(ses.model);
        modelPickBtn.title = ses.kind === "local"
            ? `Model: ${ses.label} — on this computer. Click to switch.`
            : `Model: ${ses.model} on ${ses.endpoint} — click to switch`;
    } else {
        // a REMOTE active row is named by its model, not its parameter count —
        // "35B" alone says nothing about WHAT is answering
        $("model-pick-label").innerText = act
            ? (act.remote ? shortName(act.modelId || act.id) : act.params)
            : "model";
        modelPickBtn.title = act
            ? (act.remote
                ? `Model: ${act.modelId || act.id} on ${act.endpointLabel || "endpoint"} — click to switch`
                : `Model: ${act.family} ${act.params} ${act.quant} — click to switch`)
            : "Choose model";
    }

    // the engine label reports where the model actually landed — cpu or gpu
    // and at what context — because that is decided per-load by the planner
    let planBit = "";
    try {
        const st = await window.lcl.engineStatus();
        if (st && st.running && st.plan) {
            planBit = ` · ${st.plan.accelerator} · ${Math.round(st.plan.ctxSize / 1024)}k`;
        }
    } catch { /* label stays short */ }
    // the sidebar footer says WHO answers: the model's short name, and where.
    // When nobody does, it says nothing — the status line directly above it
    // already reports "no model selected", and a third simultaneous statement
    // of the same absence was part of the too-much-clutter problem.
    // The plan detail (cpu/gpu, context) describes the RESIDENT model, so it is
    // only shown when the resident model is the one this session is on —
    // otherwise it would describe someone else's load.
    const residentIsOurs = !!(ses && ses.kind === "local" && ses.loaded !== false);
    $("engine-label").innerText = ses
        ? (ses.kind === "local"
            ? `.lcl.engine · ${ses.label}${residentIsOurs ? planBit : " · loads on next message"}`
            : `${shortName(ses.model)} · ${ses.endpoint}`)
        : (act
            ? (act.remote
                ? `${shortName(act.modelId)} · ${act.endpointLabel}`
                : `.lcl.engine · ${act.family} ${act.params}${planBit}`)
            : "");

    // EVERY context surface re-derives here, not just the labels. This is the
    // one function every model-changing path already runs (switch, session
    // change, engine events, endpoint edits — and now the spark-mode paths),
    // so the donut, the plan ring and the cost meter can never be left
    // describing the previous model while the labels describe the new one.
    try { refreshContextRing(); } catch { /* a readout never breaks the picker */ }
    try { refreshPlanRing(); } catch { /* ditto */ }
    try { refreshCostMeter(); } catch { /* hides itself when the model is local */ }

    // THE DESTINATION MAY HAVE CHANGED, SO THE RISK MUST RE-DERIVE TOO.
    // This is the one function every model-changing path runs (its comment
    // above says so), and the risk shield was the surface a model switch used
    // to leave stale — painting it here closes that gap on every path at once.
    try { paintPermChip(); } catch { /* a readout never breaks the picker */ }
    // COMPOSER READINESS re-derives from the freshly-swapped modelsCache too.
    // switchSession fires this WITHOUT awaiting and then runs setControls
    // synchronously against the PREVIOUS session's cache, which left the box
    // disabled after switching INTO a session whose model is remote ("i can not
    // type even though a model is loaded"). Re-running it here, after the cache
    // is current, settles the composer's enabled/placeholder state.
    try { setControls(); } catch { /* a readout never breaks the picker */ }
}

/**
 * THE ONE DOOR for "the model under this session just changed outside
 * switchModel" — a spark-mode switch from the picker fold or the node
 * dashboard. It re-derives every surface, and when the new window is smaller
 * than what the conversation already holds, it says so ONCE, plainly: what
 * still gets sent, what stays out, that nothing is deleted.
 */
async function modelSurfacesChanged() {
    const before = contextLimitForSession();
    await refreshModelPick();
    const after = contextLimitForSession();
    try {
        if (!active || !active.messages || !active.messages.length) return;
        if (after.assumed || !after.limit || !before.limit) return;
        if (after.limit >= before.limit) return;
        // rough tokens this conversation holds (same estimate the ring uses)
        let chars = 0;
        for (const m of active.messages) {
            const c = typeof m.content === "string" ? m.content
                    : (m.content ? JSON.stringify(m.content) : "");
            chars += c.length;
        }
        const held = Math.round(chars / 4);
        if (held <= after.limit) return;
        const k = (n) => Math.round(n / 1024) + "k";
        addNotice(
            `The context window just shrank: ${k(before.limit)} → ${k(after.limit)}. ` +
            `This conversation holds ~${k(held)} tokens, so each request now sends the newest ` +
            `slice that fits — older messages stay in the transcript, they just don't ride along.`,
            { label: "Compact it now", onClick: () => compactConversation() }
        );
    } catch { /* the toast is advice, never a blocker */ }
}

/**
 * A REUSABLE grouped model picker, styled like the chat selector: a
 * trigger that opens a panel of models grouped by MODE. The four modes are
 * ALWAYS shown, even empty — the operator asked that a mode with nothing linked
 * (GPU today) still hold its place, so the slot is visible before he fills it.
 * Used by Model Orchestration's task→model fields; never touches the chat's own
 * selection. `models` is listModels().models; `value` is the encoded string
 * ("" | "local|id" | "endpointId|modelId|label"); onPick(value) fires on choose.
 */
function modelTail(id) { return String(id || "").split("/").pop(); }
function encodeModel(m) {
    return m.remote
        ? (m.endpointId || "") + "|" + m.modelId + "|" + (m.endpointLabel || "")
        : "local|" + m.id;
}
/* Does this encoded value name this model? Compared on ENDPOINT ID + MODEL ID
 * only — the label segment is display text, and matching on it made a renamed
 * endpoint read every assignment as "not linked now". */
function sameModelRef(value, m) {
    if (!value) return false;
    if (value.startsWith("local|")) return !m.remote && value.slice(6) === m.id;
    // the MODEL ID may itself contain "|" (nothing forbids it); the label is
    // always the LAST segment, so the model is everything between the first
    // pipe and the last — parsing on the SECOND pipe truncated such an id
    const first = value.indexOf("|"), last = value.lastIndexOf("|");
    if (first < 0) return false;
    const epId = value.slice(0, first);
    const modelId = last > first ? value.slice(first + 1, last) : value.slice(first + 1);
    return !!m.remote && m.endpointId === epId && String(m.modelId) === modelId;
}
function modelLabelForValue(models, value) {
    if (!value) return "no preference — session's own model";
    for (const m of models) {
        if (sameModelRef(value, m)) {
            return m.remote ? modelTail(m.modelId) + " · " + m.endpointLabel
                            : (m.family + " " + m.params).trim();
        }
    }
    // a value pointing at something no longer linked
    const parts = value.startsWith("local|") ? [value.slice(6)] : value.split("|");
    return (parts[1] || parts[0] || "chosen model") + "  (not linked now)";
}
function mkModePicker(models, value, onPick) {
    let cur = value || "";
    const wrap = document.createElement("div");
    wrap.className = "mode-pick";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "mode-pick-trigger";
    const setLabel = () => { trigger.innerText = modelLabelForValue(models, cur); };
    setLabel();
    wrap.appendChild(trigger);

    // THE PANEL IS THE CHAT MODEL SELECTOR, to the class. It reuses .model-menu
    // and the whole tier→provider→row tree (same CSS, same collapse behaviour),
    // so an orchestration field looks and works EXACTLY like the composer's
    // picker — the chat model selector is the reference for exactly how each of
    // these dropdowns should be styled and function.
    const panel = document.createElement("div");
    panel.className = "model-menu mode-pick-panel hidden";
    wrap.appendChild(panel);

    const choose = (v) => {
        cur = v; setLabel();
        panel.classList.add("hidden");
        try { onPick(v); } catch { }
    };

    const caretSvg = () => {
        const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        s.setAttribute("viewBox", "0 0 24 24");
        s.setAttribute("width", "9"); s.setAttribute("height", "9");
        s.setAttribute("fill", "none");
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", "M9 5l7 7-7 7");
        p.setAttribute("stroke", "currentColor"); p.setAttribute("stroke-width", "3");
        p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
        s.appendChild(p);
        return s;
    };

    const rebuild = () => {
        panel.innerHTML = "";
        // "No preference" as the inherit row at the top — the same shape the
        // chat picker uses for "Follow the app default"
        const none = document.createElement("button");
        none.className = "model-row model-inherit" + (cur ? "" : " active");
        const nnm = document.createElement("div");
        nnm.className = "model-name";
        nnm.innerText = "No preference";
        const nmeta = document.createElement("div");
        nmeta.className = "model-meta";
        nmeta.innerText = "the session's own model handles this kind of work";
        none.append(nnm, nmeta);
        none.addEventListener("click", (e) => { e.stopPropagation(); choose(""); });
        panel.appendChild(none);

        const usable = models.filter(m => m.remote ? m.usable : m.present);
        // named modeTiers, not the chat picker's name, so the model-picker
        // test's regex that lifts the tier table out of app.js matches only the
        // real one and not this second copy at a deeper indent
        const modeTiers = [
            { key: "local", label: "Local",       of: (m) => !m.remote },
            { key: "node",  label: "Local Nodes",
          // A FLEET ENGINE IS NOT A THING TO TALK TO. vLLM exists to serve
          // twenty agents at once; llama.cpp exists to serve one, with the
          // bigger window. Listing both here asked the operator to choose
          // between engines that do different jobs — and the right answer is
          // both at once. The fleet gets its own row below, per session.
          of: (m) => m.remote && m.localNode && !m.rented && m.nodeRole !== "fleet" },
            { key: "api",   label: "API",         of: (m) => m.remote && !m.localNode && !m.rented },
            { key: "gpu",   label: "$ GPU",       of: (m) => m.remote && m.rented }
        ];

        const buildRow = (m) => {
            const v = encodeModel(m);
            const row = document.createElement("button");
            row.className = "model-row" + (m.remote ? " remote" : "")
                + (sameModelRef(cur, m) ? " active" : "");
            const name = document.createElement("div");
            name.className = "model-name";
            name.innerText = m.remote ? modelTail(m.modelId) : (m.family + " " + m.params).trim();
            const kind = !m.remote ? "local" : m.rented ? "gpu" : m.localNode ? "node" : "api";
            const chip = document.createElement("span");
            chip.className = "model-kind " + kind;
            chip.innerText = kind;
            name.appendChild(chip);
            const meta = document.createElement("div");
            meta.className = "model-meta";
            meta.innerText = m.remote
                ? (m.localNode ? "your machine · free"
                    : m.rate ? `$${m.rate.in}/$${m.rate.out} per M` : (m.endpointLabel || ""))
                : `${Math.round((m.contextMax || 0) / 1024)}k ctx`;
            row.append(name, meta);
            row.title = m.remote ? m.modelId + " on " + (m.endpointLabel || "") : (m.family + " " + m.params);
            row.addEventListener("click", (e) => { e.stopPropagation(); choose(v); });
            return row;
        };

        for (const t of modeTiers) {
            const mine = usable.filter(t.of);
            const head = document.createElement("button");
            head.className = "model-tier" + (mine.length ? "" : " empty");
            head.setAttribute("aria-expanded", "false");
            const rowEl = document.createElement("div");
            rowEl.className = "model-tier-row";
            const caret = document.createElement("span");
            caret.className = "model-tier-caret";
            caret.appendChild(caretSvg());
            const nm = document.createElement("span");
            nm.className = "model-tier-name";
            nm.innerText = t.label;
            const count = document.createElement("span");
            count.className = "model-tier-count";
            count.innerText = String(mine.length);
            rowEl.append(caret, nm, count);
            head.appendChild(rowEl);

            const body = document.createElement("div");
            body.className = "model-tier-body hidden";
            const chosenHere = mine.some(m => sameModelRef(cur, m));
            head.addEventListener("click", (e) => {
                e.stopPropagation();
                if (!mine.length) return;
                const open = head.getAttribute("aria-expanded") !== "true";
                head.setAttribute("aria-expanded", open ? "true" : "false");
                body.classList.toggle("hidden", !open);
            });
            if (chosenHere) { head.setAttribute("aria-expanded", "true"); body.classList.remove("hidden"); }

            /* THREE LEVELS, NOT TWO.
             *
             * GO and Zen are not distinct groups under OpenCode: they sit on
             * the same layer with the same root paths, so treating them as
             * separate groups is wrong.
             *
             * Zen and GO are two endpoints of ONE product, on
             * one account, and listing them side by side says they are as
             * unrelated as DeepInfra and a rented box. A FAMILY level goes
             * between the mode and the endpoint — but only when a family has
             * more than one endpoint in it, because wrapping a lone DeepInfra
             * in a "DeepInfra" folder containing one "DeepInfra" is a click for
             * nothing.
             */
            /* INSIDE A FAMILY FOLDER, THE CHILD DROPS THE FAMILY NAME.
             *
             * The requirement: one OpenCode entry in the menu that opens to Go
             * and Zen, rather than flat opencode.go / opencode.zen entries.
             *
             * The endpoint LABEL is "OpenCode GO" because that is what it is called
             * everywhere else — on its card, in the cost ledger, in an error. Under
             * a folder already named OpenCode it reads as a stutter, so the preset
             * carries a short name for exactly this position. */
            const subNameOf = (m, inFamily) => t.key === "local" ? null
                : ((inFamily && m.shortLabel) || m.provider || m.endpointLabel ||
                   (t.key === "node" ? "your machine"
                    : t.key === "gpu" ? "rented GPU" : "endpoint"));

            /** A collapsible header + body, at whatever depth. */
            const foldable = (label, count, open, cls) => {
                const h = document.createElement("button");
                h.className = cls + (open ? " here" : "");
                h.setAttribute("aria-expanded", open ? "true" : "false");
                const c = document.createElement("span");
                c.className = "model-tier-caret";
                c.appendChild(caretSvg());
                const nm2 = document.createElement("span");
                nm2.className = "model-tier-name";
                nm2.innerText = label;
                const ct = document.createElement("span");
                ct.className = "model-tier-count";
                ct.innerText = String(count);
                h.append(c, nm2, ct);
                const b = document.createElement("div");
                b.className = "model-provider-body" + (open ? "" : " hidden");
                h.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const now = h.getAttribute("aria-expanded") !== "true";
                    h.setAttribute("aria-expanded", now ? "true" : "false");
                    b.classList.toggle("hidden", !now);
                });
                return { h, b };
            };

            // group by family first, keeping the order `mine` arrived in
            const families = [];
            const famIndex = new Map();
            for (const m of mine) {
                // providerFamily, NOT family: on a model row `family` already
                // means its WEIGHT family (qwen2.5-coder), so keying on it would
                // fold the local models into folders named after their
                // architecture. Two meanings under one key is a bug waiting for
                // a quiet afternoon.
                const key = m.providerFamily || ("\u0000" + (subNameOf(m, false) || "one"));
                if (!famIndex.has(key)) {
                    famIndex.set(key, { key, label: m.providerFamilyLabel || null, rows: [] });
                    families.push(famIndex.get(key));
                }
                famIndex.get(key).rows.push(m);
            }

            for (const fam of families) {
                // how many DISTINCT endpoints are under this family
                const subs = [];
                const subIndex = new Map();
                for (const m of fam.rows) {
                    const sn = subNameOf(m, true);
                    const k = sn || "\u0000rows";
                    if (!subIndex.has(k)) {
                        subIndex.set(k, { name: sn, rows: [] });
                        subs.push(subIndex.get(k));
                    }
                    subIndex.get(k).rows.push(m);
                }

                // a family folder earns its click only when it holds more than
                // one endpoint; otherwise the endpoint speaks for itself
                let host = body;
                /* THE FOLDER IS ABOUT THE PRODUCT, NOT ABOUT HOW MANY ARE LINKED.
                 *
                 * This required TWO endpoints under the family before it
                 * would draw one, which quietly made the whole tree
                 * conditional on the operator's store holding two distinct
                 * records. If the two OpenCode subscriptions ever collapsed
                 * into one slot — which the shared "custom" id did for a
                 * long time — subs.length is 1, the folder never renders,
                 * and the picker looks exactly as it did before. Four
                 * rounds of "it works here" against "it is still unchanged"
                 * hinge on that single comparison.
                 *
                 * OpenCode is a product with named tiers whether or not you
                 * happen to have both, so the folder belongs to the family.
                 * DeepInfra carries no family and is still never wrapped in
                 * a folder containing only itself. */
                if (fam.label) {
                    const chosen = fam.rows.some(x => sameModelRef(cur, x));
                    const f = foldable(fam.label, fam.rows.length, chosen, "model-family");
                    body.append(f.h, f.b);
                    host = f.b;
                }

                for (const sub of subs) {
                    if (!sub.name) {
                        for (const m of sub.rows) host.appendChild(buildRow(m));
                        continue;
                    }
                    const chosen = sub.rows.some(x => sameModelRef(cur, x));
                    const sfold = foldable(sub.name, sub.rows.length, chosen,
                                           "model-provider");
                    host.append(sfold.h, sfold.b);
                    for (const m of sub.rows) sfold.b.appendChild(buildRow(m));
                }
            }
            panel.append(head, body);
        }
    };
    rebuild();

    trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        const wasHidden = panel.classList.contains("hidden");
        // close any other open picker first
        document.querySelectorAll(".mode-pick-panel").forEach(p => p.classList.add("hidden"));
        panel.classList.toggle("hidden", !wasHidden);
    });
    // A click outside closes it — but the listener is scoped to THIS picker's
    // lifetime, not the document's. It was a document-level listener added on
    // every instantiation and never removed, so reopening the modal leaked one
    // per open. It self-removes once the picker leaves the DOM.
    const onDocClick = () => {
        if (!wrap.isConnected) { document.removeEventListener("click", onDocClick); return; }
        panel.classList.add("hidden");
    };
    document.addEventListener("click", onDocClick);

    return { el: wrap, value: () => cur };
}

function openModelMenu() {
    modelMenu.innerHTML = "";
    modelMenu._providers = [];
    // which of the four modes holds the model that is answering. Declared here
    // because the filter box is built BEFORE the tree and has to be able to put
    // the tree back the way it opened when the box is cleared.
    let activeTierKey = "local";

    // A linked endpoint brings its whole catalogue — 92 chat models from one
    // host is normal now. Past a screenful, scanning stops working and typing
    // three letters of the name is how a person actually finds GLM-5.2.
    {
        const bar = document.createElement("div");
        bar.className = "model-menu-bar";
        if (modelsCache.length > 12) {
            const filter = document.createElement("input");
            filter.className = "model-filter";
            filter.type = "text";
            filter.placeholder = `Filter ${modelsCache.length} models`;
            filter.addEventListener("click", (e) => e.stopPropagation());
            filter.addEventListener("input", () => {
                const q = filter.value.trim().toLowerCase();
                for (const row of modelMenu.querySelectorAll(".model-row")) {
                    row.classList.toggle("hidden",
                        !!q && !row.innerText.toLowerCase().includes(q));
                }
                // A MATCH INSIDE A CLOSED BRANCH IS A MATCH NOBODY SEES.
                // Typing opens every mode that still has a visible row and
                // shuts the ones that do not, so the filter answers with the
                // list rather than with four collapsed headings. Clearing the
                // box puts the tree back the way it opened.
                for (const t of (modelMenu._tiers || [])) {
                    const hits = [...t.body.querySelectorAll(".model-row")]
                        .filter(r => !r.classList.contains("hidden")).length;
                    if (!q) t.head._setOpen(t.head.dataset.tier === activeTierKey);
                    else t.head._setOpen(hits > 0);
                    t.head.classList.toggle("hidden", !!q && hits === 0);
                }
                // a match inside a closed PROVIDER is a match nobody sees —
                // same rule one level down
                for (const p of (modelMenu._providers || [])) {
                    const hits = [...p.body.querySelectorAll(".model-row")]
                        .filter(r => !r.classList.contains("hidden")).length;
                    if (!q) p.head._setOpen(p.head.classList.contains("here"));
                    else p.head._setOpen(hits > 0);
                    p.head.classList.toggle("hidden", !!q && hits === 0);
                }
            });
            bar.appendChild(filter);
            setTimeout(() => filter.focus(), 0);
        }
        // the way IN to linking more: same row as the filter, asked for by
        // shape — "a styled + button ... next to the filter input field"
        const add = document.createElement("button");
        add.className = "model-add";
        add.innerText = "+";
        add.title = "Manage Models — every reachable model, by device";
        add.addEventListener("click", (e) => {
            e.stopPropagation();
            modelMenu.classList.add("hidden");
            openModels();
        });
        bar.appendChild(add);
        modelMenu.appendChild(bar);
    }

    // A CHOICE THAT CANNOT BE HONOURED SAYS SO.
    //
    // resolveSelection falls back to the app default when the endpoint a
    // session picked has been unlinked or lost its key — and reports what is
    // missing. Without this the menu simply ticked a model nobody chose, which
    // is the quiet substitution this whole feature exists to end.
    if (sessionModelState && sessionModelState.missing) {
        const warn = document.createElement("div");
        warn.className = "model-group grp-missing";
        // ...and it names the REAL destination. A broken choice falls to the
        // local engine, not to "the app default" — saying the wrong one is
        // the same class of substitution the banner exists to expose.
        warn.innerText = "THE MODEL THIS SESSION CHOSE IS NOT AVAILABLE ("
            + String((sessionModelState.missing && sessionModelState.missing.model)
                     || "unknown model").split("/").pop()
            + ") — ANSWERING ON THIS MACHINE";
        modelMenu.appendChild(warn);
    }

    // FOLLOW THE APP DEFAULT — the inherit state, same shape as the per-session
    // permissions. Without a way back, a session that once chose a model was
    // pinned to it forever and changing the app default silently skipped it.
    // Drawn only when this session HAS chosen, because that is the only time
    // there is anything to undo.
    if (active && active.modelSel) {
        const back = document.createElement("button");
        back.className = "model-row model-inherit";
        const nm = document.createElement("div");
        nm.className = "model-name";
        nm.innerText = "Follow the app default";
        const meta = document.createElement("div");
        meta.className = "model-meta";
        // WHAT GOING BACK ACTUALLY DOES. A session with no choice runs on
        // THIS MACHINE — resolveSelection returns the local engine, never the
        // global role — so naming a remote model here promised a destination
        // the routing refuses.
        const def = modelsCache.find(m => m.preferred && !m.remote);
        meta.innerText = def
            ? `this session chose its own model — go back to ${def.family} ${def.params} on this machine`
            : "this session chose its own model — go back to this machine";
        back.appendChild(nm); back.appendChild(meta);
        back.addEventListener("click", async () => {
            modelMenu.classList.add("hidden");
            active.modelSel = null;
            await window.lcl.setSessionModel(active.id, null).catch(() => null);
            await refreshModelPick();
            setModelStatus();
            refreshCostMeter();
        });
        modelMenu.appendChild(back);
    }

    // THE SPECIFIED ORDER, and this time all of it:
    //
    //   Local        > everything on the local machine
    //   Local Nodes  > each machine you own, named, its models under it
    //   API          > each connected vendor, named, its models under it
    //
    // The model selector's priority was laid out deliberately: the local
    // machine is the top level.
    //
    // The previous cut put the nodes ABOVE the local machine's models — the exact
    // inversion reported — and headed them "ON SPARK" instead of naming the
    // level and the device. Active still opens the list, because the first
    // question a picker answers is "what am I talking to"; the hierarchy
    // starts immediately under it. Groups are dynamic: whatever machines and
    // vendors are actually connected, in most-capable-first order inside each.
    // The rented bucket is drawn out explicitly rather than left to fall through
    // the API filter: it is a separate tier with its own heading and its own
    // group key, and "whatever is left over" is not a description of it.
    const ordered = [
        ...modelsCache.filter(m => m.active),
        ...modelsCache.filter(m => !m.active && !m.remote),
        ...modelsCache.filter(m => !m.active && m.remote && m.localNode),
        ...modelsCache.filter(m => !m.active && m.remote && !m.localNode && !m.rented),
        ...modelsCache.filter(m => !m.active && m.remote && !m.localNode && m.rented)
    ];

    // TWO HEADER LEVELS: the tier ("Local" / "Local Nodes" / "API"), then a
    // named subgroup for each machine or vendor inside it — "Local Nodes >
    // spark", "API > api.deepinfra.com" — both from the data, never hardcoded,
    // because the spark is not the only possible node and DeepInfra is not the
    // only possible vendor.
    const mkHeader = (cls, text, sub, host) => {
        const h = document.createElement("div");
        h.className = "model-group " + cls + (sub ? " model-subgroup" : "");
        h.innerText = text;
        (host || modelMenu).appendChild(h);
    };

    /**
     * ONE ROW, BUILT ONCE.
     *
     * This was the body of a single loop that also decided headings, which is
     * why it could not be reused and why the tree had nowhere to put a model.
     * It is now a function: the tree calls it, and so does the "answering now"
     * line at the top, so those two can never render a model differently.
     */
    function buildModelRow(m) {
        const row = document.createElement("button");
        // CONTRACT K4 — THE MACHINE IS SWITCHED OFF AND THE PICKER SAYS SO.
        //
        // "the picker still lists the Spark's models while the machine is
        //  unreachable, and the UI reported the model as switched with no
        //  weights loaded." cloudModels now stamps every record from an
        //  endpoint it could not reach with `offline` and `offlineReason`; this
        //  is the half that acts on it. Greyed, not clickable, and the reason on
        //  the row — the model is NOT removed from the list, because "where did
        //  my model go" is a worse question than "why is it grey".
        const offline = !!m.offline;
        // A MODEL THE FIT RULE REFUSES ON AN EMPTY MACHINE. Not "grey until
        // it answers" — grey until the operator changes something real (a
        // smaller quant on the node, or a bigger node). mistral-large q6_K
        // needs ~135 GB by the guard's arithmetic on a 130.66 GB machine; the
        // row used to offer it anyway, and every click bought a half-second
        // refusal. Twice, before the guard existed, it bought a dead machine.
        const neverFits = !!m.neverFits;
        row.className = "model-row"
            + (m.active ? " active" : "")
            + (m.remote ? " remote" : "")
            + (offline ? " offline" : "")
            + (neverFits ? " never-fits" : "")
            // retired is a WARNING, not a refusal: the provider still serves
            // it, and the operator may have a reason. It is dimmed and it says
            // why, but the click still works.
            + (m.retired ? " retired" : "")
            + ((m.remote ? m.usable : m.present) ? "" : " absent");
        // a remote model with no usable key stays CLICKABLE — clicking is how you
        // find out what to do about it — but a missing local file is final, and
        // so is an endpoint that is not answering, and so is a model that
        // cannot fit its machine with everything else unloaded
        row.disabled = (!m.remote && !m.present) || offline || neverFits;

        // SHORT NAME IN THE ROW, EVERYTHING ELSE IN THE TOOLTIP.
        //
        // "deepseek-ai/DeepSeek-V4-Pro · api.deepinfra.com" is three facts
        // crammed into one line, twice as wide as the menu, 92 times over —
        // "these model names... are also pretty wordy and hard to distinguish."
        // The row now carries what distinguishes models from each other (the
        // part after the vendor prefix) plus a kind chip; the vendor, the host
        // and the full id live in the tooltip, which is what tooltips are for.
        const name = document.createElement("div");
        name.className = "model-name";
        // THE CHIP SAYS WHERE IT RUNS. `kind` used to be declared at the top of
        // this loop; adding the GPU tier renamed it to `tier`, which also
        // carries "current" for the active row — and a chip reading "current"
        // says nothing about where the model lives. So the chip is derived
        // here from the model itself, and the two never drift again.
        //
        // Left as a bare `kind` reference, this threw a ReferenceError on the
        // FIRST row of the picker, so the menu could not open at all once a
        // single model existed. Nothing in the suite noticed, because nothing
        // tested the picker — see tests/model-picker.js, added for this.
        const kind = !m.remote ? "local" : m.rented ? "gpu" : m.localNode ? "node" : "api";
        const chip = document.createElement("span");
        chip.className = "model-kind " + kind;
        chip.innerText = kind;
        if (m.remote) {
            name.innerText = String(m.modelId).split("/").pop();
            // the meta line under the name already says "your node · free" —
            // the tooltip carries only what the row does not
            row.title = m.modelId + "\non " + m.endpointLabel
                + (m.contextMax ? `\n${Math.round(m.contextMax / 1024)}k context` : "")
                + (!m.localNode && m.rate
                    ? `\n$${m.rate.in}/M in · $${m.rate.out}/M out` : "");
        } else {
            name.innerText = `${m.family} ${m.params}`;
            row.title = `${m.family} · ${m.params} · ${m.quant || ""}`.trim()
                + (m.present ? `\n${(m.sizeBytes / GB).toFixed(1)} GB on disk` : "\nnot installed");
        }
        name.appendChild(chip);
        row.appendChild(name);

        const meta = document.createElement("div");
        meta.className = "model-meta";
        if (m.remote) {
            // A remote row answers three questions: where it runs, whether it can
            // run at all right now, and what it costs. A key that was encrypted
            // for a different Windows account decrypts to nothing, and THAT is the
            // case that must not fail silently at send time — it says so here.
            // one short fact per row; anything longer is in the tooltip
            const bits = [];
            if (m.keyLost) bits.push("key unreadable — paste it again");
            else if (m.keyRequired && !m.hasKey) bits.push("needs an API key");
            // "$0/$0 per M" is arithmetically right and reads as a bug. The row
            // for a machine the user owns says whose machine it is instead.
            else if (m.localNode) bits.push("your machine · free");
            else if (m.rate) bits.push(`$${m.rate.in}/$${m.rate.out} per M`);
            // THE WINDOW IS A FACT ABOUT THE MODEL, NOT ABOUT WHOSE MACHINE IT
            // IS ON. This was gated on localNode, so the number the provider
            // publishes for every hosted model — the one that decides whether
            // a long file fits — was shown only for the user's own node.
            if (m.contextMax) bits.push(`${Math.round(m.contextMax / 1024)}k ctx`);
            // WHAT THE PROVIDER SAYS IT CAN DO. Computed for every remote model
            // and rendered nowhere: an agent whose model cannot call tools can
            // only talk, and finding that out by watching the loop fail is the
            // worst possible way to learn it.
            if (m.toolCalling === false) bits.push("no tool calling");
            if (m.vision) bits.push("sees images");
            if (m.active) bits.push("running");
            // the unreachable endpoint speaks LAST and alone: whatever it costs
            // and however much context it has are irrelevant while nothing on
            // the other end is answering
            if (offline) {
                meta.innerText = "not answering — " +
                    (m.offlineReason || "this machine did not respond");
            } else if (neverFits) {
                meta.innerText = `too big for this machine — ` +
                    `${(m.sizeBytes / GB).toFixed(1)} GB model, and the whole ` +
                    `node cannot hold it even empty`;
            } else if (m.retired) {
                // THE PROVIDER RETIRED IT, AND SAYS SO IN ITS OWN CATALOGUE.
                // A retired serving is exactly the kind that answers a clean
                // 200 with nothing in it — which is what happened, four times,
                // on a deprecated gemini the picker offered as an equal.
                meta.innerText = "retired by the provider"
                    + (m.replacedBy ? ` — use ${m.replacedBy} instead`
                                    : " — no replacement named")
                    + (bits.length ? " · " + bits.join(" · ") : "");
            } else meta.innerText = bits.join(" · ");
        } else {
            meta.innerText = m.present
                ? `${(m.sizeBytes / GB).toFixed(1)} GB · ${Math.round(m.contextMax / 1024)}k ctx`
                    + (m.vision ? " · sees images" : "")
                    + (m.active ? " · running" : "")
                    // no model is loaded; this is the one the planner will
                    // start on the next message — a plan, not a state, and it
                    // must never wear the active tick (that lie is exactly how
                    // "the green check says 1.5B is loaded" happened)
                    + (m.wouldLoad ? " · loads on next message" : "")
                : "not on this machine";
        }
        row.appendChild(meta);

        // Ask the planner whether this model fits RIGHT NOW. The answer lands
        // async so the menu opens instantly; a model that does not fit stays
        // clickable — clicking gives the full numbers — but says so up front.
        if (!m.remote && m.present && !m.active) {
            const fit = document.createElement("div");
            fit.className = "model-fit";
            row.appendChild(fit);
            window.lcl.planModel(m.id).then((r) => {
                const p = r && r.plan;
                if (!p) return;
                if (p.fits) {
                    fit.innerText = `fits now · ${p.accelerator} · ` +
                        `${Math.round(p.ctxSize / 1024)}k ctx`;
                    fit.classList.add("ok");
                } else {
                    fit.innerText = `needs ~${(p.shortfallBytes / GB).toFixed(1)} ` +
                        `GB more free memory`;
                    fit.classList.add("tight");
                }
            }).catch(() => { /* row just has no hint */ });
        }

        // An offline row REFUSES selection. Not "tries and fails" — the whole
        // point of K4 is that the app stops reporting a switch that did not
        // happen, so the click never reaches switchModel at all.
        if (offline) {
            row.title = (row.title ? row.title + "\n" : "") +
                "Not answering — " + (m.offlineReason || "no response") +
                "\nThis model cannot be selected until the machine answers again.";
        } else if (neverFits) {
            // the click never reaches switchModel — same rule as offline: the
            // app does not offer a selection it already knows it will refuse
            row.title = (row.title ? row.title + "\n" : "") +
                `Cannot load on ${m.endpointLabel}: the model is ` +
                `${(m.sizeBytes / GB).toFixed(1)} GB and the load guard's fit rule ` +
                `cannot be satisfied even with the machine empty.\n` +
                `A smaller quantization of the same model would fit — the largest ` +
                `models running on this node are in the 65-70 GB range.`;
        } else if (!m.active && m.present) {
            row.addEventListener("click", () => switchModel(m.id));
        }
        return row;
    }

    /* ------------------------------------------------------------------
     * THE TREE. Four modes, collapsed, each one opening to what is in it.
     *
     * "when you click on it, it opens and shows the 4 modes. Local, Local
     *  Nodes. API and $ GPU. that way you can declutter it. and categorize.
     *  then it doesnt need to be multicolored."
     *
     * All four are ALWAYS drawn, even empty — "$ GPU" with nothing in it is
     * the answer to "can I rent one", and a mode that appears only once it is
     * populated is a mode nobody discovers. An empty one is dimmed and does
     * not open. `ordered` above still decides the sequence inside each mode,
     * so the most capable model in a mode is still its first row.
     * ------------------------------------------------------------------ */
    const TIERS = [
        { key: "local", label: "Local",       of: (m) => !m.remote },
        { key: "node",  label: "Local Nodes",
          // A FLEET ENGINE IS NOT A THING TO TALK TO. vLLM exists to serve
          // twenty agents at once; llama.cpp exists to serve one, with the
          // bigger window. Listing both here asked the operator to choose
          // between engines that do different jobs — and the right answer is
          // both at once. The fleet gets its own row below, per session.
          of: (m) => m.remote && m.localNode && !m.rented && m.nodeRole !== "fleet" },
        { key: "api",   label: "API",         of: (m) => m.remote && !m.localNode && !m.rented },
        { key: "gpu",   label: "$ GPU",       of: (m) => m.remote && m.rented }
    ];
    const activeModel = modelsCache.find(m => m.active);
    {
        const t = activeModel && TIERS.find(x => x.of(activeModel));
        activeTierKey = t ? t.key : "local";
    }

    // "▸ ANSWERING NOW" IS KEPT. In the flat list it headed a pulled-out copy of
    // the running model; in a tree that model belongs in its own branch, so this
    // is now one line that NAMES it rather than a second clickable row. The
    // readout survives, the duplicate row does not — and the mode it lives in
    // wears an "answering" chip, so the fact is legible with every branch shut.
    if (activeModel) {
        mkHeader("grp-current", "▸ ANSWERING NOW · " +
            (activeModel.remote
                ? String(activeModel.modelId || "").split("/").pop() + " on " +
                  (activeModel.endpointLabel || "endpoint")
                : `${activeModel.family} ${activeModel.params}`), false);
    }

    // the caret, drawn once per tier — rotation is CSS, so open and closed can
    // never be two different glyphs that disagree with each other
    const caretSvg = () => {
        const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        s.setAttribute("viewBox", "0 0 24 24");
        s.setAttribute("width", "9"); s.setAttribute("height", "9");
        s.setAttribute("fill", "none");
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", "M9 5l7 7-7 7");
        p.setAttribute("stroke", "currentColor");
        p.setAttribute("stroke-width", "3");
        p.setAttribute("stroke-linecap", "round");
        p.setAttribute("stroke-linejoin", "round");
        s.appendChild(p);
        return s;
    };

    // every tier body, so the filter can open them all and count what survives
    const tierBodies = [];

    /* One row per fleet ENGINE, not per model: vLLM serving one model and
       vLLM serving four are the same offer — a place for agents to run. */
    /* THE MACHINE'S TWO MODELS, AND THE MODES OF THE LOADED ONE. Model choice
     * (gpt-oss vs Qwen) is a plain selectable row — clicking one unloads the
     * other and loads it at its default window. Then the CONCURRENCY modes for
     * the RESIDENT model only appear as small labelled buttons under it:
     * deep/balanced/wide for gpt-oss, vast/swarm for Qwen. The other model's
     * modes are hidden until you switch to it. */
    /* MODE ICONS — one glyph per KIND of mode, named the same across both models.
     * bulb = "Vast", a single conversation given the whole window (one bright
     * idea). scales = "Balanced", two conversations weighed evenly. bee =
     * "Swarm", many light agents at once. Each mode carries its own `icon` id
     * (from SPARK_MODES), so deep and vast both draw the bulb, wide and swarm
     * both draw the bee. All strokes/fills are currentColor, so a glyph glows in
     * the accent when its mode is the loaded one. */
    const MODE_ICONS = {
        bulb: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8.4 15.1a6 6 0 1 1 7.2 0c-.8.6-1.25 1.35-1.35 2.4H9.75c-.1-1.05-.55-1.8-1.35-2.4Z"/><line x1="9.6" y1="20" x2="14.4" y2="20"/><line x1="10.6" y1="22" x2="13.4" y2="22"/></svg>`,
        scales: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="4.6" x2="12" y2="19"/><circle cx="12" cy="3.7" r="1.15" fill="currentColor" stroke="none"/><line x1="5" y1="7.6" x2="19" y2="7.6"/><line x1="8.4" y1="19.4" x2="15.6" y2="19.4"/><path d="M5 7.6V9.2"/><path d="M2.7 9.2a2.55 2.2 0 0 0 4.6 0Z"/><path d="M19 7.6V9.2"/><path d="M16.7 9.2a2.55 2.2 0 0 0 4.6 0Z"/></svg>`,
        bee: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="10.4" y1="5.2" x2="9" y2="3.3"/><line x1="13.6" y1="5.2" x2="15" y2="3.3"/><circle cx="9" cy="3.1" r=".75" fill="currentColor" stroke="none"/><circle cx="15" cy="3.1" r=".75" fill="currentColor" stroke="none"/><ellipse cx="12" cy="13" rx="4.1" ry="5.2"/><line x1="8.1" y1="11.4" x2="15.9" y2="11.4"/><line x1="8" y1="14.4" x2="16" y2="14.4"/><path d="M8.1 9.6C4.6 7.6 2.6 9.1 4.1 11.1c1 1.3 3.2.8 4.4-.5"/><path d="M15.9 9.6C19.4 7.6 21.4 9.1 19.9 11.1c-1 1.3-3.2.8-4.4-.5"/></svg>`
    };
    // THE SPARK'S llama.cpp DRIVER — one fold that OWNS the model list. Each
    // model the box can serve is a row; the running one is marked; clicking a
    // row only REVEALS that model's modes (accordion, one open at a time).
    // Loading happens when a MODE is picked. No context on the rows, and no
    // second copy of the model anywhere — the generic fold below renders only
    // OFFLINE node models now, so nothing shows twice.
    const appendSparkEngine = (body, drv) => {
        const foldH = document.createElement("button");
        foldH.className = "model-provider spark-engine";
        foldH.setAttribute("aria-expanded", "true");
        const fcar = document.createElement("span");
        fcar.className = "model-tier-caret";
        fcar.appendChild(caretSvg());
        const fnm = document.createElement("span");
        fnm.className = "model-tier-name";
        fnm.innerText = "llama";
        const fct = document.createElement("span");
        fct.className = "model-tier-count";
        foldH.append(fcar, fnm, fct);
        const fbody = document.createElement("div");
        fbody.className = "model-provider-body";
        foldH.addEventListener("click", (e) => {
            e.stopPropagation();
            const now = foldH.getAttribute("aria-expanded") !== "true";
            foldH.setAttribute("aria-expanded", now ? "true" : "false");
            fbody.classList.toggle("hidden", !now);
        });
        body.append(foldH, fbody);

        window.lcl.sparkModes().then((sm) => {
            if (!sm || !sm.ok || !sm.modes) { foldH.remove(); fbody.remove(); return; }
            const byModel = [];
            for (const [key, m] of Object.entries(sm.modes)) {
                let g = byModel.find(x => x.model === m.model);
                if (!g) { g = { model: m.model, label: m.label, modes: [] }; byModel.push(g); }
                g.modes.push({ key, ctx: m.ctx, blurb: m.blurb, name: m.name, icon: m.icon });
            }
            // THE BARE MODEL ID. Picker rows wear "api:<endpoint>|<model>" in
            // .id and carry the bare model only in .modelId - reading .id
            // first meant NOTHING matched the mode table's bare ids, so no row
            // showed running and no mode highlighted on the real machine (the
            // harness stub's bare .id masked it).
            let residentModel = String((drv && (drv.modelId || drv.model || drv.id)) || "").toLowerCase();
            // WHICH MODE: main remembers the last switch it drove (sm.current);
            // ctx arithmetic cannot tell a 2-slot mode from a measured pool.
            // The ctx compare survives only as the fallback.
            let currentMode = sm.current || null;
            let residentCtx = Number(drv && (drv.contextMax || drv.contextLength)) || 0;
            let expanded = null;
            const note = document.createElement("div");
            note.className = "mm-note";
            // LIVE switch progress from main - door lines, loading seconds,
            // ready/failed - replaces the valueless "allow 1-5 minutes" timer.
            // The terminal phases also RESOLVE a rejoined switch: this fold's
            // own invoke may belong to a closed menu's dead closure, so the
            // event stream is the only finish line it is guaranteed to see.
            sparkModeNote = (d) => {
                if (!d) return;
                if (d.detail) {
                    note.innerText = d.phase === "door" ? ("box: " + d.detail) : d.detail;
                }
                if (d.phase === "ready" && d.mode && sm.modes[d.mode]) {
                    const rm = sm.modes[d.mode];
                    switching = null;
                    currentMode = d.mode;
                    residentModel = String(rm.model || "").toLowerCase();
                    residentCtx = Number(rm.ctx) || 0;
                    expanded = rm.model;
                    render();
                } else if (d.phase === "failed") {
                    switching = null;
                    render();
                }
            };

            // ATTACH THIS SESSION to the model the box already serves -
            // instant, no recipe, no reload. This path did not exist: the fold
            // had no selection semantics at all, so a new session could stare
            // at a loaded model it could not use.
            const selectForSession = async (bareModel) => {
                const want = String(bareModel || "").toLowerCase();
                const row = modelsCache.find(x => x.remote && x.localNode
                    && x.nodeRole !== "fleet" && !x.offline
                    && String(x.modelId || "").toLowerCase() === want);
                if (!row || row.active) return;
                try {
                    await switchModel(row.id);
                    note.innerText = "this conversation now answers on " + (row.label || row.modelId);
                } catch { /* the picker's own error surfaces handle it */ }
            };

            // the TRANSITIONAL state: which mode was clicked and which model it
            // loads. The instant a mode is clicked the UI must answer — the
            // clicked button turns pending, the STALE active highlight drops,
            // and the model rows say what is really happening (reloading /
            // loading / unloading). "i clicked balanced ... vast still shows
            // as selected" was the missing state this carries.
            let switching = null;   // { mode, model } while a switch is in flight
            // REJOIN a switch main is already running — closing the picker
            // used to orphan it: reopening showed rest-state buttons over live
            // work, and a second click could stack a recipe. Main owns the
            // in-flight record; this fold re-enters it on build, and the
            // progress events resume painting the note.
            if (sm.inFlight && sm.modes[sm.inFlight.mode]) {
                const im = sm.modes[sm.inFlight.mode];
                switching = { mode: sm.inFlight.mode,
                              model: String(im.model || "").toLowerCase() };
                expanded = im.model;
                note.innerText = im.label + " switch in flight — rejoining…";
            }

            const switchTo = async (mode, targetModel) => {
                switching = { mode, model: String(targetModel || "").toLowerCase() };
                expanded = targetModel || expanded;
                note.innerText = "starting the switch\u2026";
                render();
                const r = await window.lcl.sparkMode(drv ? drv.endpointId : "", mode)
                    .catch(err => ({ error: String(err && err.message || err) }));
                switching = null;
                if (r && r.ok) {
                    // the resolve IS readiness now - main measured the model
                    // serving before answering, so "running" is finally true
                    residentModel = String(r.model || "").toLowerCase();
                    residentCtx = Number(r.ctx) || 0;
                    currentMode = mode;
                    expanded = r.model;
                    note.innerText = r.note || "";
                    try { renderHeader(); } catch { /* repaints on close */ }
                    await modelSurfacesChanged().catch(() => { /* heals on next trigger */ });
                    // the session follows the switch it asked for
                    selectForSession(targetModel || r.model);
                    render();
                } else {
                    note.innerText = (r && r.error) || "the switch did not go through";
                    render();
                }
            };

            const render = () => {
                fbody.innerHTML = "";
                fct.innerText = String(byModel.length);
                for (const g of byModel) {
                    const gModel = String(g.model || "").toLowerCase();
                    const isResident = gModel === residentModel;
                    const isTarget = !!(switching && switching.model === gModel);
                    if (expanded === null && isResident) expanded = g.model;
                    const isOpen = expanded === g.model;
                    const row = document.createElement("div");
                    row.className = "model-row node-model-row"
                        + (isResident && !switching ? " on" : "")
                        + (isOpen ? " open" : "");
                    const rcar = document.createElement("span");
                    rcar.className = "node-model-caret";
                    rcar.appendChild(caretSvg());
                    const nm = document.createElement("span");
                    nm.className = "model-name model-row-name";
                    nm.innerText = g.label;
                    const st = document.createElement("span");
                    st.className = "model-row-state";
                    // DURING A SWITCH the states tell the truth in motion:
                    // same-model mode change reads "reloading", a cross-model
                    // target reads "loading" while the old resident reads
                    // "unloading". At rest: "running" on the resident only.
                    if (switching) {
                        if (isTarget && isResident) { st.innerText = "reloading\u2026"; st.classList.add("loading"); }
                        else if (isTarget)          { st.innerText = "loading\u2026";   st.classList.add("loading"); }
                        else if (isResident)        { st.innerText = "unloading\u2026"; st.classList.add("draining"); }
                        else st.innerText = "";
                    } else {
                        st.innerText = isResident ? "running" : "";
                    }
                    row.append(rcar, nm, st);
                    row.addEventListener("click", (e) => {
                        e.stopPropagation();
                        expanded = isOpen ? null : g.model;
                        // opening the RESIDENT model also points this session
                        // at it - already loaded means already usable, now.
                        // While a switch runs, rows still expand (reading is
                        // free) but never re-select or fire anything.
                        if (!isOpen && isResident && !switching) selectForSession(g.model);
                        render();
                    });
                    fbody.appendChild(row);
                    if (isOpen) {
                        const modeRow = document.createElement("div");
                        modeRow.className = "mode-btns";
                        for (const md of g.modes) {
                            const activeMode = !switching && isResident &&
                                (currentMode ? md.key === currentMode
                                             : Number(md.ctx) === residentCtx);
                            const isPending = !!(switching && switching.mode === md.key
                                && switching.model === gModel);
                            const bt = document.createElement("button");
                            bt.className = "mode-btn" + (activeMode ? " on" : "")
                                + (isPending ? " pending" : "");
                            if (switching) bt.disabled = true;
                            const ic = document.createElement("span");
                            ic.className = "mode-ic";
                            ic.innerHTML = MODE_ICONS[md.icon] || MODE_ICONS[md.key] || "";
                            const lb = document.createElement("span");
                            lb.className = "mode-lb";
                            lb.textContent = md.name || md.key;
                            bt.append(ic, lb);
                            bt.title = md.blurb + " \u00b7 " + Math.round(md.ctx / 1024) + "k";
                            bt.addEventListener("click", (e) => {
                                e.stopPropagation();
                                // the ACTIVE mode attaches the session to the
                                // loaded model - it NEVER re-runs the recipe
                                // (that restarted llama-server and took the
                                // node dark while claiming success)
                                if (switching) return;
                                if (activeMode) selectForSession(g.model);
                                else switchTo(md.key, g.model);
                            });
                            modeRow.appendChild(bt);
                        }
                        fbody.appendChild(modeRow);
                        // THE NOTE LIVES WITH THE MODEL IT DESCRIBES — under
                        // the open model's own mode buttons. Appended at the
                        // fold's end it sat physically beneath the LAST row,
                        // reading as if Qwen were the thing loading while
                        // gpt-oss loaded.
                        fbody.appendChild(note);
                    }
                }
                if (!note.parentElement) fbody.appendChild(note);
            };
            render();
        }).catch(() => { foldH.remove(); fbody.remove(); });
    };
    const appendFleetRows = (body, fleetModels) => {
        const seen = new Map();
        for (const m of fleetModels) {
            if (!seen.has(m.endpointId)) seen.set(m.endpointId, m);
        }
        for (const m of seen.values()) {
            const row = document.createElement("div");
            row.className = "model-fleet-row";
            const nm2 = document.createElement("span");
            nm2.className = "model-fleet-name";
            nm2.innerText = (m.endpointLabel || "fleet") + " · agents";
            const why = document.createElement("span");
            why.className = "model-fleet-why";
            const b = document.createElement("button");
            const paint = () => {
                const on = !!(active && active.taskModels && active.taskModels.agentic
                    && active.taskModels.agentic.endpointId === m.endpointId);
                row.classList.toggle("on", on);
                why.innerText = on
                    ? "this conversation's agents run here"
                    : "many streams at once — the fleet, not the model you talk to";
                // A PLAY AND A STOP, because that is what it is: this fleet is
                // either carrying this conversation's agents or it is not.
                b.className = (on ? "ghost small" : "primary small") + " model-fleet-btn";
                b.innerText = on ? "■" : "▶";
                b.title = on ? "Stop running this conversation's agents here"
                             : "Run this conversation's agents here";
                b.setAttribute("aria-label", b.title);
                return on;
            };
            let on = paint();
            b.addEventListener("click", async (e) => {
                e.stopPropagation();
                if (!active || !active.id) return;
                const map = { ...(active.taskModels || {}) };
                if (on) delete map.agentic;
                else map.agentic = { model: m.modelId, endpointId: m.endpointId,
                                     endpointLabel: m.endpointLabel };
                const r = await window.lcl.setSessionTaskModels(active.id, map)
                    .catch(() => null);
                if (r && r.ok) active.taskModels = r.taskModels;
                on = paint();
            });
            row.appendChild(nm2); row.appendChild(why); row.appendChild(b);
            body.appendChild(row);
        }
    };

    for (const t of TIERS) {
        const mine = ordered.filter(t.of);
        const head = document.createElement("button");
        head.className = "model-tier" + (mine.length ? "" : " empty");
        head.dataset.tier = t.key;
        head.setAttribute("aria-expanded", "false");

        const rowEl = document.createElement("div");
        rowEl.className = "model-tier-row";
        const caret = document.createElement("span");
        caret.className = "model-tier-caret";
        caret.appendChild(caretSvg());
        const nm = document.createElement("span");
        nm.className = "model-tier-name";
        nm.innerText = t.label;
        const count = document.createElement("span");
        count.className = "model-tier-count";
        count.innerText = String(mine.length);
        rowEl.appendChild(caret); rowEl.appendChild(nm); rowEl.appendChild(count);
        // which mode is answering right now, marked on the mode itself, so the
        // answer is visible with every branch shut
        if (mine.some(m => m.active)) {
            const here = document.createElement("span");
            here.className = "model-tier-here";
            here.innerText = "answering";
            rowEl.appendChild(here);
        }
        head.appendChild(rowEl);

        const body = document.createElement("div");
        body.className = "model-tier-body hidden";
        body.dataset.tier = t.key;
        tierBodies.push({ head, body });

        /* THE FLEET, WHERE IT BELONGS: UNDER THE MACHINE, NOT IN THE LIST.
         *
         * "instead of making vLLM its own selector, when in local nodes and
         *  available, make it a session based toggle. as in the local node
         *  model running on llama.cpp can run larger context, and invoke
         *  agents running on vLLM"
         *
         * PER SESSION, because .lcl is multi-session and two conversations on
         * one machine may want different arrangements. It writes the SAME
         * orchestration map the assignment panel writes — taskModels.agentic,
         * "multi-step agent work" — so the session model is already told, in
         * its own system prompt, to route that work there. No second
         * mechanism, and nothing new for the engine to learn. */
        // THE MODE SELECTOR LIVES WHERE THE ACTION IS. The dashboard keeps its
        // buttons, but hot-swapping the machine belongs HERE, in the model
        // picker — five SVG icons, each a mode, tooltip carrying the detail.

        // EACH PROVIDER IS ITS OWN BRANCH, CLOSED BY DEFAULT. A vendor's
        // whole catalogue used to flood open the moment its tier did — 92
        // DeepInfra models in one wall. "the model selector should be grouped
        // to where deep infra is clickable to view the models under it, not
        // expanded all the time ... i could have an infinite amount of
        // connected apis." The provider that owns the ANSWERING model opens,
        // because the first question a picker answers is what it is talking
        // to; everything else is one click.
        /* THREE LEVELS HERE TOO.
         *
         * This is the CHAT picker, and it keeps its own copy of the grouping
         * loop — which is exactly how the family level landed in the reusable
         * picker and not in the one the operator actually opens. Same rule:
         * a FAMILY folder between the mode and the endpoint, and only when the
         * family holds more than one endpoint.
         */
        /* INSIDE A FAMILY FOLDER, THE CHILD DROPS THE FAMILY NAME.
         *
         * The requirement: one OpenCode entry in the menu that opens to Go
         * and Zen, rather than flat opencode.go / opencode.zen entries.
         *
         * The endpoint LABEL is "OpenCode GO" because that is what it is called
         * everywhere else — on its card, in the cost ledger, in an error. Under
         * a folder already named OpenCode it reads as a stutter, so the preset
         * carries a short name for exactly this position. */
        const subNameOf = (m, inFamily) => t.key === "local" ? null
            : ((inFamily && m.shortLabel) || m.provider || m.endpointLabel ||
               (t.key === "node" ? "your machine"
                : t.key === "gpu" ? "rented GPU" : "endpoint"));

        const fold = (label, count, open, cls) => {
            const h = document.createElement("button");
            h.className = cls + (open ? " here" : "");
            h.setAttribute("aria-expanded", open ? "true" : "false");
            const c = document.createElement("span");
            c.className = "model-tier-caret";
            c.appendChild(caretSvg());
            const nm2 = document.createElement("span");
            nm2.className = "model-tier-name";
            nm2.innerText = label;
            const ct = document.createElement("span");
            ct.className = "model-tier-count";
            ct.innerText = String(count);
            h.append(c, nm2, ct);
            const b = document.createElement("div");
            b.className = "model-provider-body" + (open ? "" : " hidden");
            h.addEventListener("click", (e) => {
                e.stopPropagation();
                const now = h.getAttribute("aria-expanded") !== "true";
                h.setAttribute("aria-expanded", now ? "true" : "false");
                b.classList.toggle("hidden", !now);
            });
            return { h, b };
        };

        // LOCAL NODES groups by MACHINE first. Each node (spark, and any you add
        // later) is its own fold, and INSIDE it live that node's engines:
        // llama.cpp (the driver — its models and their modes) and vLLM (the
        // agent fleet, a session toggle). A second machine simply gets its own
        // fold beside this one; the shape never changes.
        if (t.key === "node") {
            const nodeOrder = [];
            const nodeIdx = new Map();
            // KEYED BY THE MACHINE, NOT THE ENDPOINT LABEL. The driver and the
            // fleet are two endpoints with two labels on ONE box — label-keying
            // split them into two "machines", and the fleet's fold then grew a
            // llama engine it does not serve (models + modes hallucinated onto
            // vLLM). The row's `node` record is the machine identity.
            for (const m of ordered) {
                if (!(m.remote && m.localNode && !m.rented)) continue;
                const key = (m.node && (m.node.id || m.node.host))
                    || String(m.endpointId || "").replace(/-\d+$/, "")
                    || m.endpointLabel || "node";
                if (!nodeIdx.has(key)) {
                    nodeIdx.set(key, { name: null, driver: [], fleet: [], offline: [] });
                    nodeOrder.push(nodeIdx.get(key));
                }
                const g = nodeIdx.get(key);
                // the machine is named by its node record (or the driver's
                // label), never by the fleet endpoint's label
                if (!g.name || m.nodeRole !== "fleet") {
                    g.name = (m.node && m.node.name) || m.endpointLabel || g.name || "node";
                }
                if (m.offline) g.offline.push(m);
                else if (m.nodeRole === "fleet") g.fleet.push(m);
                else g.driver.push(m);
            }
            for (const node of nodeOrder) {
                const engines = (node.driver.length ? 1 : 0) + (node.fleet.length ? 1 : 0);
                const nf = fold(node.name || "node", engines, true, "model-provider model-node");
                body.append(nf.h, nf.b);
                // the llama engine fold exists ONLY where a driver does — a
                // fleet-only machine gets the vLLM card and nothing invented
                if (node.driver.length) appendSparkEngine(nf.b, node.driver[0]);
                if (node.fleet.length) appendFleetRows(nf.b, node.fleet);
                for (const m of node.offline) nf.b.appendChild(buildModelRow(m));
            }
        }

        const fams = [];
        const famIdx = new Map();
        const foldList = t.key === "node" ? [] : mine;
        for (const m of foldList) {
            // providerFamily, NOT family: on a model row `family` already means
            // its weight family (qwen2.5-coder)
            const k = m.providerFamily || ("\u0000" + (subNameOf(m, false) || "one"));
            if (!famIdx.has(k)) {
                famIdx.set(k, { label: m.providerFamilyLabel || null, rows: [] });
                fams.push(famIdx.get(k));
            }
            famIdx.get(k).rows.push(m);
        }

        for (const fam of fams) {
            const subs = [];
            const subIdx = new Map();
            for (const m of fam.rows) {
                const sn = subNameOf(m, true);
                const k = sn || "\u0000rows";
                if (!subIdx.has(k)) { subIdx.set(k, { name: sn, rows: [] }); subs.push(subIdx.get(k)); }
                subIdx.get(k).rows.push(m);
            }
            let host = body;
            /* THE FOLDER IS ABOUT THE PRODUCT, NOT ABOUT HOW MANY ARE LINKED.
                 *
                 * This required TWO endpoints under the family before it
                 * would draw one, which quietly made the whole tree
                 * conditional on the operator's store holding two distinct
                 * records. If the two OpenCode subscriptions ever collapsed
                 * into one slot — which the shared "custom" id did for a
                 * long time — subs.length is 1, the folder never renders,
                 * and the picker looks exactly as it did before. Four
                 * rounds of "it works here" against "it is still unchanged"
                 * hinge on that single comparison.
                 *
                 * OpenCode is a product with named tiers whether or not you
                 * happen to have both, so the folder belongs to the family.
                 * DeepInfra carries no family and is still never wrapped in
                 * a folder containing only itself. */
                if (fam.label) {
                const open = fam.rows.some(x => x.active);
                const f = fold(fam.label, fam.rows.length, open, "model-family");
                body.append(f.h, f.b);
                host = f.b;
            }
            for (const sub of subs) {
                if (!sub.name) {
                    for (const m of sub.rows) host.appendChild(buildModelRow(m));
                    continue;
                }
                const open = sub.rows.some(x => x.active);
                const sf = fold(sub.name, sub.rows.length, open, "model-provider");
                host.append(sf.h, sf.b);
                for (const m of sub.rows) sf.b.appendChild(buildModelRow(m));
            }
        }
        // the way into the NODE'S OWN model library, where it belongs — it
        // was in the global dropdown, a node-only tool categorized as if it
        // were about the whole app — placed in the global dropdown instead of
        // a UI smart enough to categorize it by where it belongs.
        if (t.key === "node" && mine.length) {
            const lib = document.createElement("button");
            lib.className = "model-row model-inherit";
            const lnm = document.createElement("div");
            lnm.className = "model-name";
            lnm.innerText = "Local Models — add or remove models on this machine…";
            const lmeta = document.createElement("div");
            lmeta.className = "model-meta";
            lmeta.innerText = "look one up, see what it costs in disk and memory, install it";
            lib.append(lnm, lmeta);
            lib.addEventListener("click", (e) => {
                e.stopPropagation();
                modelMenu.classList.add("hidden");
                openModelLibrary();
            });
            body.appendChild(lib);
        }
        if (!mine.length) {
            const none = document.createElement("div");
            none.className = "model-tier-empty model-meta";
            none.innerText = t.key === "local" ? "no model files on this machine"
                : t.key === "node" ? "no machines of your own are linked"
                : t.key === "gpu" ? "no rented GPU is linked"
                : "no API endpoint is linked";
            body.appendChild(none);
        }

        const setOpen = (open) => {
            head.setAttribute("aria-expanded", open ? "true" : "false");
            body.classList.toggle("hidden", !open);
        };
        if (mine.length) {
            head.addEventListener("click", (e) => {
                e.stopPropagation();
                setOpen(head.getAttribute("aria-expanded") !== "true");
            });
        }
        // EVERY tier starts SHUT — the picker opens as a compact list of group
        // headers (Local, Local Nodes, API, GPU), not with one tree already
        // spilled open that you have to collapse to reach the others. What is
        // answering is still named by the "ANSWERING NOW" line at the top, so
        // nothing needs to pre-expand to tell you what you are talking to.
        setOpen(false);
        head._setOpen = setOpen;

        modelMenu.appendChild(head);
        modelMenu.appendChild(body);
    }
    modelMenu._tiers = tierBodies;

    // Installed engines that are not chat models. Not selectable — the agent
    // invokes them per call — but visible, so "is image generation on this
    // machine?" is answered by looking, not wondering.
    if (imageModelsCache.length) {
        const head = document.createElement("div");
        head.className = "model-section";
        head.innerText = "image engine";
        modelMenu.appendChild(head);

        for (const m of imageModelsCache) {
            const row = document.createElement("div");
            row.className = "model-row engine-row" + (m.ready ? "" : " absent");

            const name = document.createElement("div");
            name.className = "model-name";
            name.innerText = `${m.family} · ${m.params} ${m.quant}`;
            row.appendChild(name);

            const meta = document.createElement("div");
            meta.className = "model-meta";
            meta.innerText = m.ready
                ? `ready · ${(m.sizeBytes / GB).toFixed(1)} GB · runs per image, never stays loaded`
                : (m.present ? "model on disk, runtime missing" : "not on this machine");
            row.appendChild(meta);

            const fit = document.createElement("div");
            fit.className = "model-fit" + (m.ready ? " ok" : "");
            fit.innerText = m.ready
                ? "ask for an image in any linked session"
                : "";
            if (m.ready) row.appendChild(fit);
            modelMenu.appendChild(row);
        }
    }

    // THE WAY TO ADD A MODEL, PERMANENTLY.
    //
    // Four screens named the absence — the picker greys absent models out,
    // Preferred model files them under "download these first", the capability
    // table tags them "not installed" — and not one carried a control. The
    // only file picker in the app fired once, automatically, from
    // waitForBackend() when the engine reported no model, and never again
    // after you declined it. So the single door to installing a model
    // destroyed itself and left four screens describing the problem.
    const addFile = document.createElement("button");
    addFile.className = "model-row model-add-file";
    const afName = document.createElement("span");
    afName.className = "model-name";
    afName.innerText = "Add a model file…";
    const afMeta = document.createElement("span");
    afMeta.className = "model-meta";
    afMeta.innerText = "choose a .gguf already on this computer";
    addFile.appendChild(afName); addFile.appendChild(afMeta);
    addFile.addEventListener("click", async (e) => {
        e.stopPropagation();
        modelMenu.classList.add("hidden");
        const r = await window.lcl.chooseModel().catch(() => null);
        // lcl:chooseModel answers { modelPath, plan } — it has never returned
        // an `ok` field, so testing for one meant picking a model that loaded
        // perfectly well still left the app sitting on "no model".
        if (r && r.modelPath) { await refreshModelPick(); await waitForBackend(); }
        else if (r && r.error) {
            modal({ title: "Could not add that model", message: r.error,
                    confirmLabel: "Close", confirmOnly: true });
        }
    });
    modelMenu.appendChild(addFile);

    modelMenu.classList.remove("hidden");
}

/**
 * Switch models with the truth on screen the whole way. The old version fired
 * the IPC and slept 1.8 s — when the 7B died loading, nothing ever updated and
 * every control stayed grey. Now the main process refuses un-loadable models
 * BEFORE touching the running one, reports failure with numbers, and this side
 * always lands the UI in a live state.
 */
async function switchModel(id) {
    if (switching) return;
    modelMenu.classList.add("hidden");
    const target = modelsCache.find(m => m.id === id);
    const label = target ? `${target.family} ${target.params}` : "model";

    // THE CHOICE BELONGS TO THIS CONVERSATION.
    //
    // Picking a model used to set the ONE global driver, so choosing GLM here
    // silently moved every other session onto it too — and the per-session
    // choice that was written alongside it was never read back by the routing.
    // The session is recorded FIRST, and it is what answers; the global engine
    // work below is only about which gguf is resident on this laptop.
    if (active) {
        active.modelSel = id;
        const saved = await window.lcl.setSessionModel(active.id, id)
            .catch(() => null);
        if (saved && saved.resolved) active.modelResolved = saved.resolved;
    }

    // A REMOTE model needs nothing loaded here: recording the session's choice
    // IS the switch. No engine work, no waiting, and — importantly — no touching
    // the global selection that other sessions are still using.
    if (target && target.remote) {
        await refreshModelPick();
        updateContextGuess();
        refreshCostMeter();
        // the picker and the session carry WHICH model answers; the sidebar row
        // reports the engine on this machine and is repainted from it
        paintEngineStatus();
        // THE COMPOSER HAS TO BE TURNED BACK ON HERE.
        //
        // There is a second copy of this fix 25 lines below, with a comment
        // explaining exactly why it is needed — and this early return makes
        // that copy dead code for every remote model, which is the only kind
        // of model that reaches it. So the app said "remote · <endpoint>",
        // wrote "Message .lcl…" into the placeholder, ticked the row, and left
        // the textarea disabled: everything reported success except the one
        // thing the operator was trying to do.
        //   "i can not type a message into the message prompt, even though
        //    ... there is a model currently loaded"
        ready = true;
        composer.placeholder = "Message .lcl…   (Ctrl+Enter to send)";
        setControls();
        composer.focus();
        return;
    }

    /* THE ONE ENGINE, GUARDED AT THE POINT IT WOULD BE TAKEN.
     *
     * Everything above this line is remote and has already returned. Only a
     * LOCAL model reaches here, and only a local model can pull llama-server
     * out from under a turn running in another session. */
    if (localTurnElsewhere()) {
        const busy = [...pendingSessions].find(
            id => id !== (active && active.id) && !remotePending.has(id));
        const who = (sessions.find(x => x.id === busy) || {}).title || "another session";
        addNotice(`${label} is a local model, and “${who}” is generating on this ` +
                  `machine’s engine right now — there is only one, so loading a ` +
                  `different one would pull it out from under that turn. It will ` +
                  `switch as soon as that finishes. Endpoints and nodes are ` +
                  `available now.`);
        return;
    }

    switching = true;
    ready = false;
    setControls();
    $("model-pick-label").innerText = "switching…";
    setStatus("busy", `switching to ${label}…`);
    composer.placeholder = `Loading ${label}…`;

    let res = null;
    // scope "session": load the gguf on this machine, but do not touch the
    // app-wide remote selection other sessions inherit
    try { res = await window.lcl.setModel(id, active ? "session" : null); }
    catch (err) { res = { error: String(err && err.message || err) }; }

    // A REMOTE model loads nothing on this machine, so there is no backend to
    // wait for and no memory plan to report. Waiting on waitForBackend() here
    // would hang the picker on a local engine that is deliberately idle.
    if (res && res.ok && res.remote) {
        switching = false;
        // THE LINE THIS WHOLE PATH WAS MISSING. `ready = false` is set at the
        // top of every switch, and the local path restores it via
        // waitForBackend — which this path correctly skips, and then restored
        // nothing. Result: picking a remote model "worked" (status said
        // remote, the row ticked) while the composer stayed disabled with no
        // way to type: clicking a model like GLM5.2 appeared to do nothing —
        // this line.
        ready = true;
        setControls();
        await refreshModelPick();
        updateContextGuess();
        refreshCostMeter();
        paintEngineStatus();
        composer.placeholder = "Message .lcl…   (Ctrl+Enter to send)";
        composer.focus();
        return;
    }

    // A load that failed but RECOVERED onto another model is not an error state
    // to shout about — say what happened and carry on with a working app.
    if (res && res.recovered) {
        switching = false;
        setControls();
        await refreshModelPick();          // repaints which row is really active
        await waitForBackend();
        setModelStatus();
        await modal({
            title: label + " did not fit",
            message: res.error || "",
            detail: res.note || "A model that fits is loaded instead.",
            confirmLabel: "Close", confirmOnly: true
        });
        return;
    }

    if (!res || res.error) {
        const kept = !!(res && res.kept);
        // THE CHOICE IS UNDONE WHEN IT CANNOT BE HONOURED. Recording it before
        // the load is what makes the session the source of truth — but leaving
        // it recorded after a failed load pins the conversation to a model
        // that cannot start, and every later message fails the same way.
        if (active) {
            active.modelSel = null;
            await window.lcl.setSessionModel(active.id, null).catch(() => null);
        }
        await modal({
            title: res && res.refusal ? "Not enough memory for " + label : "Model not loaded",
            message: (res && res.error) || "unknown error",
            detail: (kept
                ? "Your current model was not touched — it is still loaded and working."
                : "No model is loaded right now. Free some memory and pick a model again.")
                + (modelsCache.some(m => m.remote && m.usable)
                    ? " Or pick one of your linked API models — those need no local memory."
                    : ""),
            confirmLabel: "Close", confirmOnly: true
        });
        switching = false;
        await recoverEngineUi(kept);
        return;
    }

    const ok = await waitForBackend();
    switching = false;
    setControls();
    await refreshModelPick();
    updateContextGuess();
    refreshCostMeter();              // hides itself when the model is local
    if (ok && res.plan) {
        setModelStatus();
    }
}

/** After a failed load: either the old model still runs, or nothing does. */
async function recoverEngineUi(kept) {
    await refreshModelPick();
    if (kept) {
        await waitForBackend();
    } else {
        ready = false;
        setStatus("down", "no model loaded");
        composer.placeholder = "No model loaded — click the model button to pick one";
        setControls();
    }
}

modelPickBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    // THE BUTTON'S LOOK AND ITS BEHAVIOUR ARE ONE FACT.
    //
    // This asked the blunt question (is ANY turn in flight anywhere) while
    // setControls() deliberately asks the precise one (is a LOCAL turn in
    // flight elsewhere — see the note there). So during a remote turn in
    // another session the button stayed lit, hovered, rippled on press, and
    // did nothing at all. Clicking a live-looking control three times and
    // getting silence reads as a broken app.
    if (modelPickBtn.disabled) return;
    if (modelMenu.classList.contains("hidden")) {
        // NEVER STALE: every open paints from the freshest list. The menu
        // renders instantly from the cache, then refetches; it re-renders ONLY
        // if the list actually changed while it sat closed — an endpoint
        // added, a node coming online, a model installed — so an unchanged
        // tree never resets under the pointer.
        // contextMax is IN the signature: a spark-mode switch changes only the
        // window (same model id, same flags), and an open menu that ignores it
        // keeps painting the old "Nk ctx" figures.
        const sig = () => JSON.stringify((modelsCache || []).map(m =>
            [m.id || m.modelId, m.present, m.usable, m.offline, m.active, m.contextMax]));
        const before = sig();
        openModelMenu();
        refreshModelPick().then(() => {
            if (!modelMenu.classList.contains("hidden") && sig() !== before) openModelMenu();
        }).catch(() => { /* the cached render stands */ });
    }
    else modelMenu.classList.add("hidden");
});
document.addEventListener("click", (e) => {
    if (!modelMenu.classList.contains("hidden") && !modelMenu.contains(e.target)) {
        modelMenu.classList.add("hidden");
    }
});

// =============================================================
// SESSION OPERATIONS
// =============================================================
function setControls() {
    const enabled = canSend() && !pending && !!active;
    // AN AFTERTHOUGHT IS NOT A SECOND TURN. With Ancient Knowledge on, the
    // composer stays live while this session works: what you send is captured
    // as an addendum to the request being answered right now, so the audit
    // covers it. Without AK there is nothing to carry it, and the field locks
    // as it always did rather than pretending the message landed somewhere.
    const addendaOK = !!active && active.ancientKnowledge === true && pending;
    // ...and WITHOUT Ancient Knowledge the field still takes the message; it
    // waits in the queue instead of joining this turn. A locked composer was
    // the whole complaint, and "there is nowhere to put it" was never true —
    // there just was not anywhere built.
    const queueOK = !!active && pending && !addendaOK;
    composer.disabled = !(enabled || addendaOK || queueOK);
    composer.placeholder = addendaOK
        ? "Add a thought — Ancient Knowledge folds it into this request…"
        : queueOK
            ? "Type your next message — it sends when this turn finishes…"
            : "Message .lcl…";
    // Linking a folder needs NO model — it is a file-picker and a settings
    // write. Gating it on `ready` meant that with no model loaded there was
    // "no ability to link a workspace", which turned a model problem into a
    // whole-app problem.
    linkBtn.disabled = pending || !active;
    newSessionBtn.disabled = false;   // other sessions running never blocks a new one

    // Switching models mid-turn would pull the engine out from under the
    // agent, and re-clicking mid-switch would race the switch — but "no model
    // loaded" is exactly when the picker is needed most. Review flagged the
    // old `|| !ready` here as the reason every failure state said "click the
    // model button" while that button sat disabled.
    // WHO ACTUALLY HOLDS THE ENGINE.
    //
    // There is ONE local engine, so switching models while a LOCAL turn runs
    // anywhere would pull it out from under that turn — that invariant is real
    // and tests/concurrency.js guards it. But a REMOTE turn holds no local
    // engine at all, and blocking on anyPending() punished it anyway: open a
    // second session while the first thinks on GLM and the model button was
    // dead for no reason. So the gate asks the precise question — is a LOCAL
    // turn in flight somewhere else — instead of the blunt one.
    // THE LOCK WAS WIDER THAN THE INVARIANT, AND IT BLOCKED THE TEST.
    //
    // "i am trying to run a local node session, then an api session, then a
    //  plain local session, all at the same time" — and while session one
    //  generated, this button was dead, so sessions two and three could not be
    //  pointed at anything. He could not reach step two.
    //
    // The real invariant is narrow: do not LOAD a different gguf while a local
    // turn is live. Choosing a REMOTE model does no engine work at all —
    // switchModel's remote branch records the choice and returns before any
    // engine call, and the IPC behind it is a settings write. Collapsing both
    // into one disabled button charged the remote case for the local one's
    // constraint. The refusal moved to switchModel, where the consequence is.
    const localElsewhere = localTurnElsewhere();
    modelPickBtn.disabled = pending || switching;
    if (modelPickBtn.disabled) modelMenu.classList.add("hidden");
    modelPickBtn.title = localElsewhere
        ? "A local model is generating in another session — you can still pick "
          + "a node or an API here; only a different local model has to wait"
        // NOT generating elsewhere any more: a prior setControls clobbered the
        // real per-session tooltip with the "generating" line, and preserving it
        // left the button asserting a turn that already finished. Drop the stale
        // line; the next refreshModelPick restores the real "Model: X on Y".
        : (/generating in another session/.test(modelPickBtn.title || "")
            ? "Choose model" : (modelPickBtn.title || "Choose model"));

    // The composer button is the single doorway: it sends, becomes Stop while
    // the model works, then flips back. It must stay live during a turn.
    sendBtn.disabled = pending ? false : !enabled;
    sendBtn.classList.toggle("stopping", pending);
    sendBtn.title = pending ? "Stop generating" : "Send (Enter)";
    sendBtn.setAttribute("aria-label", pending ? "Stop generating" : "Send");
    $("send-icon").classList.toggle("hidden", pending);
    $("stop-icon").classList.toggle("hidden", !pending);

    syncMenuState();
}

async function refreshSessions() {
    const res = await window.lcl.listSessions();
    if (res && Array.isArray(res.sessions)) sessions = res.sessions;
    renderSessionList();
}

async function switchSession(id, opts = {}) {
    // switching away from a BUSY session is fine — its turn continues in main
    // and lands in its file; we just must not double-open the same one
    if (active && active.id === id) return;

    const res = await window.lcl.getSession(id);
    if (!res || res.error) {
        addError("Could not load session: " + ((res && res.error) || "unknown error"));
        return;
    }

    // The outgoing session's status bubble is about to be destroyed by the
    // re-render. Release it FIRST — leaving liveBubble pointing at a detached
    // node is how one session's "thinking…" kept animating over another's
    // transcript, and how a finishing turn could clear the wrong bubble.
    stopProgress();

    // LEAVING A SESSION YOU WERE IN IS ALSO READING IT. If a turn finished while
    // you sat in the session unfocused (so the watched-live ack in
    // paintSessionStatus did not fire), its dot stayed cyan until you clicked
    // away and back. Clicking OUT now marks the session you are LEAVING read —
    // it should clear when you click out of the session — so moving on stops it
    // shouting. Only the session actually being left, and only on a real switch.
    if (active && active.id && active.id !== id) {
        const out = sessions.find(x => x.id === active.id);
        if (out) {
            out.readAt = Date.now();
            window.lcl.markSessionRead(active.id).catch(() => { /* stamped again next open */ });
            const outRow = sessionListEl.querySelector(`[data-session-id="${active.id}"]`);
            const outDot = outRow && outRow.querySelector(".session-status");
            if (outDot) {
                outDot.className = "session-status " + derivedDotState(sessionStatuses[active.id] || { state: "idle" }, out);
                outDot.title = statusTitle(sessionStatuses[active.id] || { state: "idle" }, out);
            }
        }
    }

    // CLICKING IS READING — and ONLY clicking. "me clicking on the session is
    // reading the session." The startup auto-open and the delete-fallback pass
    // markRead:false, because a session the app opened FOR you was never read
    // BY you — that silent ack was how a background finish resolved itself.
    if (opts.markRead !== false) {
        const proj = sessions.find(x => x.id === id);
        if (proj) proj.readAt = Date.now();
        window.lcl.markSessionRead(id).catch(() => { /* stamped again next open */ });
    }

    active = res;
    closeFileViewer();      // the preview belongs to the previous session's folder

    // EACH SESSION KEEPS ITS OWN MODEL — and now the ROUTING reads it, so
    // arriving in a session no longer has to re-apply anything globally. It
    // used to call switchModel() here, which set the one global driver: the
    // act of LOOKING at a session changed what every other session was
    // talking to. Switching sessions is a repaint now; the model that answers
    // is resolved per turn from the session's own record.
    refreshModelPick();
    setModelStatus();
    refreshCostMeter();
    renderActivity();       // this session's own durable feed
    renderQueued();         // ...and anything typed while it was working
    renderAttachStrip();    // ...and the files staged for its next message
    // the plan window belongs to the SESSION's endpoint, so it is re-asked
    // when the session changes, not only when a turn ends
    refreshPlanRing();
    renderHeader();
    renderMessages(active.messages);
    // THE TASKS PANEL FOLLOWS THE SESSION: drop the previous conversation's
    // rows and hydrate this one's from the ledger (library rows come back with
    // it). The panel is per-session, not a global spill.
    {
        for (const [tid, trow] of taskEls) { trow.remove(); taskEls.delete(tid); }
        $("task-panel").classList.add("hidden");
        restoreTasks().catch(() => { /* the live stream still paints */ });
    }
    // A turn still running in this session has a question that is not on disk
    // yet, and a status bubble that was destroyed by the re-render. Put both
    // back, so returning to a working session shows the work.
    if (pendingSessions.has(active.id)) {
        const q = pendingQuestions.get(active.id);
        if (q) addMessageRow("user", q.text, active.messages.length, undefined, q.attachments);
        const typing = addTyping();
        startProgress(typing, q ? q.at : Date.now());
        // REPLAY THE TURN SO FAR. The live log was destroyed by the
        // re-render, but every consequential step of the in-flight turn is
        // already in sessionActivity — put them back through the same
        // pushActivity the live handler uses, so returning to a working
        // session shows the work instead of an empty bubble. (A turn started
        // before a renderer restart has records but no pendingQuestions
        // entry — an empty replay there is normal, not a bug.)
        const since = q ? q.at : 0;
        for (const e of (sessionActivity.get(active.id) || [])) {
            if (e.at >= since) pushActivity(typing, e.kind, e.text);
        }
        scrollToBottom(true);
    }
    renderSessionList();
    if (workspaceOpen()) renderWorkspace();
    setControls();
    composer.focus();

    // OPENING THE SESSION IS WHEN YOU GET ASKED. A remote approval raised
    // while this session was in the background was deliberately not drawn
    // into whatever transcript was open — it was held for exactly this
    // moment. Still unanswered means main is still waiting on it.
    // a card raised for ANOTHER conversation must not float over this one —
    // it goes back to the queue and returns when its own session is opened
    permPopupSyncToSession();
    const held = remoteAwaiting.get(String(active.id));
    if (held) {
        remoteAwaiting.delete(String(active.id));
        presentRemoteApproval(held);
    }

    // THE PER-SESSION CONTROLS MUST RE-READ THIS SESSION. The brain (Ancient
    // Knowledge) and the reasoning slider sync off lcl:activeSession, which was
    // only ever dispatched from unlinkRepo — so switching conversations left
    // both showing the PREVIOUS session's state. "they are ... not acting [per
    // session]". Fire it on every switch so both re-read this session.
    document.dispatchEvent(new CustomEvent("lcl:activeSession"));
}

async function createSession() {

    const res = await window.lcl.createSession("");
    if (!res || res.error) {
        addError("Could not create session: " + ((res && res.error) || "unknown error"));
        return;
    }

    active = res;
    // A NEW SESSION FOLLOWS THE APP DEFAULT — and every model surface has to
    // say so. Without this repaint the picker, the sidebar label, the status
    // line and the cost meter all still showed the PREVIOUS session's model,
    // which is not what the new conversation will be answered by.
    refreshModelPick();
    setModelStatus();
    refreshCostMeter();
    await refreshSessions();
    renderHeader();
    renderMessages([]);      // shows the animated landing page
    renderSessionList();
    if (workspaceOpen()) renderWorkspace();
    setControls();
    composer.focus();
}

async function deleteSession(id) {
    // Keyed to the TARGET session, and it REPORTS. `pending` asks about the
    // open session, so deleting an idle session B while session A streamed was
    // refused — silently, with no modal and no disabled menu item.
    if (pendingSessions.has(id)) {
        await modal({
            title: "That session is working",
            message: "It can be deleted as soon as the turn it is running finishes.",
            confirmLabel: "Close", confirmOnly: true
        });
        return;
    }

    const target = sessions.find(s => s.id === id);
    const ok = await modal({
        title: "Delete session",
        message: `Delete “${(target && target.title) || "this session"}”?`,
        detail: "The conversation history is removed. Files in your workspace are not touched.",
        confirmLabel: "Delete",
        danger: true
    });
    if (!ok) return;

    await window.lcl.deleteSession(id);
    if (active && active.id === id) active = null;
    await refreshSessions();

    if (!active) {
        if (sessions.length) await switchSession(sessions[0].id, { markRead: false });
        else await createSession();
    }
}

/**
 * Rename ANY session from its own row, not only the one that happens to be
 * open. The rename control now lives on each row's menu, so it has to be able
 * to act on that row; the old path could only ever edit `.session-item.active`
 * because the only way to reach it was a button in the open session's header.
 */
async function renameSessionRow(id) {
    // ASK ABOUT THE ROW, NOT ABOUT WHATEVER IS OPEN. `pending` means "the
    // currently open session has a turn in flight", so this used to refuse to
    // rename an unrelated IDLE session while another one streamed — and refuse
    // in silence: no modal, no notice, no disabled item. The row menu hides
    // both actions while the target is busy (see openSessionMenu); this is the
    // backstop for every other way in, and it SAYS what happened.
    if (pendingSessions.has(id)) {
        await modal({
            title: "That session is working",
            message: "It can be renamed as soon as the turn it is running finishes.",
            confirmLabel: "Close", confirmOnly: true
        });
        return;
    }
    if (active && id === active.id) return renameActiveSession();
    const row = sessionListEl.querySelector(`.session-item[data-session-id="${id}"] .session-name`);
    if (!row) return;
    const rec = sessions.find(x => x.id === id);
    const original = row.innerText;
    row.contentEditable = "true";
    row.classList.add("editing");
    row.focus();
    document.execCommand("selectAll", false, null);
    // ONE EDIT, ONE SET OF LISTENERS. Escape returns WITHOUT re-rendering the
    // list, so this row node survives with its keydown closure still attached —
    // blur was registered { once: true } but keydown was not, and neither was
    // ever removed. Rename → Escape → Rename → Enter therefore fired the rename
    // IPC twice, once per surviving closure. Aborting as the first statement of
    // finish() drops both listeners on every exit path.
    const editAc = new AbortController();
    const finish = async (commit) => {
        editAc.abort();
        row.contentEditable = "false";
        row.classList.remove("editing");
        const next = (row.innerText || "").trim().slice(0, 120);
        if (!commit || !next || next === original) { row.innerText = original; return; }
        const res = await window.lcl.renameSession(id, next).catch(() => null);
        if (res && !res.error) {
            if (rec) rec.title = res.title;
            await refreshSessions();
        } else { row.innerText = original; }
    };
    row.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        if (e.key === "Escape") { e.preventDefault(); finish(false); }
    }, { signal: editAc.signal });
    row.addEventListener("blur", () => finish(true), { once: true, signal: editAc.signal });
}

async function renameActiveSession() {
    if (!active || pending) return;

    const item = sessionListEl.querySelector(".session-item.active .session-name");
    if (!item) return;

    const original = active.title;
    item.contentEditable = "true";
    item.classList.add("editing");
    item.focus();
    document.execCommand("selectAll", false, null);

    // the identical listener-accumulation guard as renameSessionRow: F2 →
    // Escape → F2 → Enter left the first edit's keydown closure attached
    const editAc = new AbortController();
    const finish = async (commit) => {
        editAc.abort();
        item.contentEditable = "false";
        item.classList.remove("editing");
        const next = (item.innerText || "").trim().slice(0, 120);
        if (!commit || !next || next === original) { item.innerText = original; return; }

        const res = await window.lcl.renameSession(active.id, next);
        if (res && !res.error) {
            active.title = res.title;
            renderHeader();
            await refreshSessions();
        } else {
            item.innerText = original;
        }
    };

    item.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    }, { signal: editAc.signal });
    item.addEventListener("blur", () => finish(true), { once: true, signal: editAc.signal });
}

// btn-rename is gone from the header: rename lives on each session row now.
// F2 and the Session menu still reach it for the open conversation.

/** Native folder picker, then a BRANDED permission modal. */
async function linkRepo() {
    if (!active || pending) return;

    const picked = await window.lcl.pickFolder(active.id);
    if (!picked || picked.canceled) return;

    if (picked.error) {
        await modal({
            title: "Cannot use that folder",
            message: picked.error,
            confirmLabel: "Close", confirmOnly: true
        });
        return;
    }

    const ok = await modal({
        title: "Grant workspace access",
        message: "Give .lcl access to this folder?",
        detail: picked.fileCount
            ? `${picked.fileCount} readable file${picked.fileCount === 1 ? "" : "s"} found.`
            : "",
        path: picked.folder,
        scope: true,
        confirmLabel: "Grant access"
    });
    if (!ok) return;

    const res = await window.lcl.grantFolder(active.id, picked.folder);
    if (!res || res.error) {
        await modal({
            title: "Could not link folder",
            message: (res && res.error) || "unknown error",
            confirmLabel: "Close", confirmOnly: true
        });
        return;
    }

    active.repoPath = res.repoPath;
    renderHeader();
    await refreshSessions();
    toggleWorkspace(true);
    updateLanding();
}

async function unlinkRepo() {
    if (!active || !active.repoPath || pending) return;

    const ok = await modal({
        title: "Unlink workspace",
        message: "Unlink this folder?",
        detail: ".lcl loses file access for this session. Nothing on disk changes.",
        path: active.repoPath,
        confirmLabel: "Unlink",
        danger: true
    });
    if (!ok) return;

    const res = await window.lcl.unlinkRepo(active.id);
    if (res && !res.error) {
        active.repoPath = null;
        // ANCIENT KNOWLEDGE CANNOT OUTLIVE ITS LEDGER. Enabling it demands a
        // workspace because the session review has to live somewhere; taking
        // that workspace away has to be the same decision in reverse, or the
        // brain stays lit while every audit runs, bills, and writes its
        // findings nowhere the operator will ever read them.
        if (active.ancientKnowledge === true) {
            active.ancientKnowledge = false;
            try {
                await window.lcl.setSessionAncientKnowledge(active.id, false);
                await window.lcl.setSessionPerm(active.id, "selfReview", false);
                if (active.perms) active.perms.selfReview = false;
            } catch {}
            document.dispatchEvent(new CustomEvent("lcl:activeSession"));
            addNotice("Ancient Knowledge turned off — it writes the session " +
                      "review into a workspace folder, and this session no longer has one.");
        }
        renderHeader();
        await refreshSessions();
        renderWorkspace();
    }
}

// =============================================================
// COMPOSER
// =============================================================
function autoGrow() {
    composer.style.height = "auto";
    composer.style.height = Math.min(composer.scrollHeight, 220) + "px";
    // the slash popover is anchored to the composer's top edge; a taller
    // composer (multi-line) moves that edge, so re-anchor while it is open
    if (slashOpen) positionSlashMenu();
}

composer.addEventListener("input", autoGrow);

/**
 * LIVE TOKEN AND COST METER.
 *
 * Shown only when a paid remote model is selected. A local model costs nothing
 * per token, so a meter reading $0 forever would be noise.
 *
 * The input side is real arithmetic, not a forecast: the characters exist and the
 * rate is known. The output side is quoted per thousand tokens of reply instead
 * of guessed, because the model has not answered — adding a made-up output
 * figure to a real input figure would ruin the only half worth trusting.
 *
 * Debounced at 180 ms and computed by plain division in the main process, so
 * typing never waits on it.
 */
const costEl = $("composer-cost");
let costTimer = null;
let contextTokensGuess = 0;      // what the conversation will resend

function updateContextGuess() {
    // Everything already in the transcript goes back with the next message, and
    // on a long thread that is most of the bill. Estimated from characters here
    // and corrected by the provider's real count after each call.
    if (!active || !Array.isArray(active.messages)) { contextTokensGuess = 0; return; }
    const chars = active.messages.reduce(
        (n, m) => n + String((m && m.content) || "").length, 0);
    contextTokensGuess = Math.round(chars / 3.6);
}

/**
 * THIS SESSION'S RUNNING TOTAL, beside the composer.
 *
 * "cost per message, and total cost per session ... seen per session, then
 * globally". The Spend dashboard answers the global question; this answers the
 * one you have while you are typing — what has this conversation cost so far.
 * Real ledger rows, not estimates.
 */
async function refreshSessionCost() {
    const el = $("session-cost");
    if (!el || !active) return;
    let c = null;
    try { c = await window.lcl.costForSession(active.id); } catch { /* silent */ }
    if (!c || !c.usd) { el.classList.add("hidden"); el.innerText = ""; return; }
    const money = c.usd < 0.01 ? "$" + c.usd.toFixed(4) : "$" + c.usd.toFixed(2);

    // A SESSION TOTAL IS A HISTORY, NOT A PRICE TAG ON THE MODEL IN THE BOX.
    //
    // Reported: Mistral still shows a cost. It did, and the number was real — but
    // none of it was Mistral's. That conversation had spent $0.02 on a paid API
    // earlier in its life; switching it to a model on the user's own node left the
    // lifetime total sitting beside the composer, where the only reasonable
    // reading is "this is what the thing I am typing to costs". Command-a
    // looked free purely because it was tried in a fresh session with no rows.
    //
    // The total still shows — deleting a real number to stop it being
    // misread is not an option — but when the model actually selected is free,
    // the badge says the money is behind it, and the tooltip names the model
    // that is not charging. Same figure, no longer a lie about the present.
    el.innerText = "session " + money + (activeModelFree ? " earlier" : "");
    el.title = `${c.calls} paid call${c.calls === 1 ? "" : "s"} · ` +
        `${c.inputTokens.toLocaleString()} in · ${c.outputTokens.toLocaleString()} out\n` +
        (activeModelFree
            ? "All of it from earlier turns in this session on a paid endpoint. "
              + "The model selected now runs on hardware you own and adds nothing to it.\n"
            : "") +
        "Click for the full spend breakdown.";
    el.classList.toggle("historical", activeModelFree);
    el.classList.remove("hidden");
}

/**
 * DOES THE MODEL IN THE BOX RIGHT NOW CHARGE ANYTHING?
 *
 * Read by the session-cost badge so a lifetime total cannot be misread as the
 * running cost of a model that is free. Set from the one call that already
 * knows — nothing else has to ask.
 */
let activeModelFree = true;      // a local model is the default, and it is free

async function refreshCostMeter() {
    // THE SEND ESTIMATE MUST NEVER LAG THE TRANSCRIPT. contextTokensGuess used
    // to be written only inside switchModel, so after a session switch or a turn
    // completing the meter priced the PREVIOUS thread (a fresh session still
    // read "+ ~50k context"; a grown thread under-counted the turn just added).
    // Recomputing here, where the meter is painted, makes the guess follow the
    // conversation on every path that repaints the meter.
    updateContextGuess();
    let r = null;
    try { r = await window.lcl.estimateCost(composer.value, contextTokensGuess,
                                            active ? active.id : null); }
    catch { costEl.classList.add("hidden"); return; }
    // not remote at all == the built-in engine on this machine: also free
    activeModelFree = !r || !r.remote || !!r.localNode;
    if (!r || !r.remote) {
        costEl.classList.add("hidden"); costEl.innerHTML = "";
        refreshSessionCost();          // the badge's wording depends on the line above
        return;
    }

    const fmt = (n) => n === null || n === undefined ? ""
        : n === 0 ? "$0" : n < 0.001 ? "<$0.001" : n < 1 ? "$" + n.toFixed(3) : "$" + n.toFixed(2);
    const parts = [];
    // WHICH model, first — "it doesnt show the model that is selected, when
    // its an api". The short name is the answer to "who am I talking to";
    // the host and full id stay in the tooltip.
    if (r.model) parts.push(`<b>${String(r.model).split("/").pop()}</b>`);
    parts.push(`<b>${r.typedTokens.toLocaleString()}</b> tok`);
    if (r.contextTokens > 0) {
        parts.push(`+ ${r.contextTokens.toLocaleString()} context = ` +
                   `<b>${r.inputTokens.toLocaleString()}</b> in`);
    }
    if (r.localNode) {
        // YOUR OWN HARDWARE, SAID ONCE. Repeating "$0 to send · typical reply ≈
        // $0" is the arithmetic of a price list applied to something that has no
        // price list, and it makes the user read two numbers to learn one fact.
        // The token counts above still matter — they are what the node's memory
        // is spent on — but the money question has a one-word answer.
        parts.push("<b>$0</b> · your own hardware");
    } else if (r.inputUsd !== null) {
        parts.push(`<b>${fmt(r.inputUsd)}</b> to send`);
        // "$0.002/1k reply" read as a riddle — "the 1k reply?". Same number,
        // stated as what it is: the cost of a typical reply. 1,000 output
        // tokens IS a typical full reply (about 750 words); the exact rate and
        // the tokens-vs-words arithmetic live in the tooltip.
        parts.push(`typical reply ≈ <b>${fmt(r.outputUsdPer1k)}</b>`);
    } else {
        parts.push("no rate set");
    }
    costEl.innerHTML = parts.join(" · ");
    costEl.title = `${r.model} on ${r.endpoint}
${r.note || ""}
` + (r.localNode
        // "$0 · your own hardware" is the visible text — this adds only the
        // one thing it does not say: what the real budget is
        ? "The token counts are what your machine's memory is spent on, which is "
          + "the real budget."
        : `"typical reply" is 1,000 output tokens — roughly 750 words.`)
      + `\nToken counts are estimated at ${r.charsPerToken.toFixed(2)} chars/token ` +
        "and corrected from the provider's own figures after each call.";
    // a single message costing real money is worth a colour change
    costEl.classList.toggle("warn", !r.localNode && (r.inputUsd || 0) >= 0.05);
    costEl.classList.remove("hidden");
    refreshSessionCost();      // free-ness just changed; the badge's wording follows it
}

composer.addEventListener("input", () => {
    clearTimeout(costTimer);
    costTimer = setTimeout(refreshCostMeter, 180);
});
/**
 * ENTER IS A NEW LINE. CTRL+ENTER SENDS.
 *
 * The requirement: Enter should not submit. Enter (and Shift+Enter) should
 * insert a new line, and submitting should happen only by clicking Send or
 * pressing Ctrl+Enter.
 *
 * This is the right way round for a composer people write PARAGRAPHS in: the
 * common keystroke should be the harmless one, and the one that spends money
 * and starts work should take a deliberate two-key press or a click. Enter
 * and Shift+Enter both just break the line — the textarea's own default, so
 * nothing is intercepted at all.
 */
composer.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    // Ctrl+Enter (or Cmd+Enter) is the send. Everything else falls through to
    // the textarea and inserts a newline, which is what it did for Shift+Enter.
    if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        sendMessage();
    }
});

sendBtn.addEventListener("click", () => {
    // STOP still stops. A queued message is added with Enter or Ctrl+Enter,
    // never by clicking the button that says Stop — clicking Stop while
    // meaning "send this too" would kill the turn being waited on.
    if (pending) cancelTurn();
    else sendMessage();
});
newSessionBtn.addEventListener("click", createSession);
linkBtn.addEventListener("click", () => {
    if (active && active.repoPath) toggleWorkspace(true);
    else linkRepo();
});

/* ========================================================== THE SEND QUEUE
 *
 * "i still can not add questions while a model is thinking, which means you
 *  dont have this at all fully wired."
 *
 * Correct. The composer DID stay live during a turn — but only with Ancient
 * Knowledge on, where a message becomes an addendum to the request being
 * answered. With AK off there was nothing to carry it, so the field locked,
 * and locking the field is what he has been hitting.
 *
 * His objection to a queue was specific and still holds: "i do not want a
 * queue ... it beats a queue because a queue answers in order." That is an
 * argument for AK where AK exists, not for a dead input where it does not.
 * So: AK on, it still folds into this turn. AK off, it waits here — in
 * plain sight, in order, and revocable until the moment it is sent.
 */
const queuedSends = new Map();          // sessionId -> [text]

function renderQueued() {
    const strip = $("queued-strip");
    if (!strip) return;
    const list = (active && queuedSends.get(active.id)) || [];
    strip.innerHTML = "";
    strip.classList.toggle("hidden", list.length === 0);
    list.forEach((text, i) => {
        const row = document.createElement("div");
        row.className = "queued-msg";
        const mark = document.createElement("span");
        mark.className = "q-mark";
        mark.innerText = list.length > 1 ? `queued ${i + 1}` : "queued";
        const body = document.createElement("span");
        body.className = "q-text";
        body.innerText = text;
        body.title = text;
        const drop = document.createElement("button");
        drop.className = "q-drop";
        drop.title = "Do not send this";
        drop.setAttribute("aria-label", "Remove this queued message");
        drop.innerText = "✕";
        drop.addEventListener("click", () => {
            const cur = (active && queuedSends.get(active.id)) || [];
            cur.splice(i, 1);
            // THE TEXT COMES BACK TO THE COMPOSER. Dropping a queued message
            // is "not like that", not "forget it" — throwing the words away
            // would make the ✕ a trap.
            if (!composer.value.trim()) { composer.value = text; autoGrow(); }
            if (!cur.length) queuedSends.delete(active.id);
            renderQueued();
        });
        row.appendChild(mark); row.appendChild(body); row.appendChild(drop);
        strip.appendChild(row);
    });
}

/** Send the next queued message for a session, if its turn is over. */
async function drainQueue(sessionId) {
    const list = queuedSends.get(sessionId);
    if (!list || !list.length) return;
    if (pendingSessions.has(sessionId)) return;      // still working

    /* A SESSION SUMMARY IS NOT A SESSION.
     *
     * `sessions` holds the LIST rows — id, title, timestamps — with no
     * `messages` array, and sendText indexes `session.messages.length` on its
     * first line. Queue something, switch away, let the turn finish, and the
     * drain would have thrown inside a setTimeout with nothing on screen
     * saying why. The full record is fetched for a session that is not the
     * one on screen. */
    let target = (active && active.id === sessionId) ? active : null;
    if (!target) {
        const res = await window.lcl.getSession(sessionId).catch(() => null);
        target = res && !res.error ? res : null;
        // ...and the turn it was waiting on may have been superseded while we
        // asked; re-check rather than sending into a busy session
        if (pendingSessions.has(sessionId)) return;
    }
    if (!target) return;                             // session gone: leave it queued

    const text = list.shift();
    if (!list.length) queuedSends.delete(sessionId);
    renderQueued();
    sendText(text, target);
}

async function sendMessage() {
    const text = composer.value.trim();
    if (!text || !active) return;
    // `pending` is no longer a refusal here — sendText decides whether this
    // becomes an addendum, a queued send, or a turn. Readiness still gates a
    // fresh turn (nothing to send it to) but never a queued one: the engine
    // has minutes to come back before the queue is drained. And it is the
    // SESSION's readiness, not the app's — see canSend.
    if (!pending && !canSend()) return;
    composer.value = "";
    autoGrow();
    // TYPING IS READING TOO: the operator sending the next message has read
    // this session — the only ack besides clicking its row.
    {
        const proj = sessions.find(x => x.id === active.id);
        if (proj) proj.readAt = Date.now();
        window.lcl.markSessionRead(active.id).catch(() => { /* stamped on next open */ });
    }
    // everything below belongs to THIS session, even if the user switches away
    return sendText(text, active);
}

/**
 * Send one turn.
 *
 * Split out of sendMessage so a failed turn can be sent again from the error
 * bubble without the text having to survive a round trip through the composer —
 * the composer is where the user is already typing their next thought.
 */
async function sendText(text, session) {
    if (!text || !session) return;

    // THE AFTERTHOUGHT PATH. This session is already working and Ancient
    // Knowledge is on, so the message is not a new turn — it joins the request
    // being answered right now. main captures it; the interrogation reads it
    // as part of the original ask, which is what makes "did you do everything"
    // cover it. Drawn as its own line so it is never mistaken for a turn that
    // is about to be answered on its own.
    if (pending && active && active.id === session.id
        && active.ancientKnowledge === true) {
        const res = await window.lcl.chat(session.id, text).catch(() => null);
        if (res && res.addendum) {
            addNotice(`Added to this request — Ancient Knowledge will hold the ` +
                      `model to it: “${text.slice(0, 120)}”`);
            scrollToBottom(true);
        } else {
            addError((res && res.error) || "That could not be added to this request.");
        }
        return;
    }
    // NO ANCIENT KNOWLEDGE, SO IT WAITS — visibly. Falling through to the
    // silent `return` below is what made the composer feel dead: the text
    // vanished from the box and landed nowhere.
    if (pending && active && active.id === session.id) {
        const list = queuedSends.get(session.id) || [];
        if (list.length >= 10) {
            addError("Ten messages are already waiting — let this turn finish.");
            return;
        }
        list.push(text);
        queuedSends.set(session.id, list);
        renderQueued();
        return;
    }
    if (pending || !canSend()) return;

    dismissLanding();

    const baseIndex = session.messages.length;
    // snapshot the chips this send takes with it — the optimistic bubble and
    // the mid-turn re-add (switchSession) both draw from this list
    const sentAtts = (active && active.id === session.id
        && Array.isArray(active.stagedAttachments)) ? active.stagedAttachments.slice() : [];
    addMessageRow("user", text, baseIndex, undefined, sentAtts);
    scrollToBottom(true);

    // Remember the QUESTION, not just the fact of being busy. It is not in the
    // session file until the turn completes, so switching away and back would
    // otherwise re-render from disk and lose both the question and the live
    // status bubble — the turn continues in main, but the UI goes blank.
    pendingSessions.add(session.id);
    if (remoteActive()) remotePending.add(session.id);
    pendingQuestions.set(session.id, { text, at: Date.now(), attachments: sentAtts });
    setControls();
    setStatus("busy", "working…");
    const typing = addTyping();
    startProgress(typing);
    scrollToBottom(true);

    // is the user still LOOKING at the session this turn belongs to?
    const viewing = () => active && active.id === session.id;

    try {
        const res = await window.lcl.chat(session.id, text);
        if (viewing()) typing.remove();

        if (!res || typeof res !== "object" || res.error) {
            if (viewing()) {
                // DO NOT RE-RENDER FROM THE SESSION FILE HERE.
                //
                // This used to call renderMessages(session.messages) to "drop
                // the optimistic user bubble", which wipes chat.innerHTML — and
                // takes the question, the thinking bubble and the error message
                // that was appended one line earlier down with it. From the
                // outside: while it is thinking, the thinking and the question
                // disappear, with nothing left on screen saying why.
                //
                // A failed turn is not persisted, which is correct, but that is
                // an argument for MARKING the question unsent, not for erasing
                // it. The user still has to be able to read what they asked and
                // send it again.
                markLastUserUnsent(text);
                if (res && res.cancelled) addError("Stopped.");
                else addError("Error: " + ((res && res.error) || "No response."),
                              { retry: text, session });
            }
            return;
        }

        const newMessages = Array.isArray(res.new_messages) ? res.new_messages : [];
        // the turn consumed its chips — drop exactly those from the strip,
        // keeping anything staged while it ran (mirrors main's disk merge)
        if (sentAtts.length && active && active.id === session.id) {
            const sent = new Set(sentAtts.map(a => a.id));
            active.stagedAttachments = (active.stagedAttachments || []).filter(a => !sent.has(a.id));
            renderAttachStrip();
        }
        session.messages.push(...newMessages);
        if (res.changes && res.changes.length) {
            session.changes = [...(session.changes || []), ...res.changes];
        }
        if (res.title) session.title = res.title;

        if (viewing()) {
            // re-render so indexes, actions and change chips all line up
            renderMessages(session.messages);
            renderHeader();
            if (res.changes && res.changes.length && workspaceOpen()) loadWorkspaceFiles();
            refreshReviewDoc(newMessages, session);   // the turn's OWN session
            // THE FLEET THAT RAN UNASSIGNED: ask_fleet found a free fleet
            // seat and ran there. Offered through the SAME strip and the
            // SAME task-map write as the \u25B6 row — keeping it is one
            // click and the row paints "on". Shown before modelOffer on
            // purpose: its sweep removes older .model-offer strips, and
            // losing this strip to a same-turn model offer is the one
            // interaction the design accepts.
            if (res.fleetOffer) showModelOffer({
                cap: "agentic",
                // its OWN dismissal key: waving off this keep-the-fleet strip
                // must not silently mute every future genuine agentic model
                // offer (they shared "sessionId|agentic" before)
                kind: "fleet",
                reason: "your agents just ran there — a free machine you own",
                suggested: {
                    id: res.fleetOffer.model,
                    endpointId: res.fleetOffer.endpointId,
                    endpointLabel: res.fleetOffer.endpointLabel || undefined,
                    label: res.fleetOffer.model + " on "
                         + (res.fleetOffer.endpointLabel || "your fleet")
                }
            }, session);
            if (res.modelOffer) showModelOffer(res.modelOffer, session);
            if (res.routeBroken) showRouteBroken(res.routeBroken, session);
            if (res.modelNotice) showModelNotice(res.modelNotice, session);
            // the ring redraws inside renderMessages above — it describes the
            // conversation on screen, so it is hung off the render rather than
            // repeated at every call site that produces one
        }
        await refreshSessions();
    } finally {
        pendingSessions.delete(session.id);
        remotePending.delete(session.id);
        pendingQuestions.delete(session.id);
        if (viewing()) {
            stopProgress();
            setControls();
            // the engine can die MID-turn (watchdog, OOM) — reporting green here
            // would contradict the failure the engine-state handler just showed
            if (ready) setModelStatus();
            refreshSessionCost();      // the turn just added rows to the ledger
            // the plan window can only have moved because of this turn
            refreshPlanRing();
            // the send estimate must include the turn that just landed — it
            // recomputes the context guess itself now, so this one call heals it
            refreshCostMeter();
            scrollToBottom(true);
            composer.focus();
        }
        // ...and whatever was typed while this ran now goes, whether or not
        // the operator is still looking at this session. Deferred a tick so
        // this turn is fully unwound (pendingSessions cleared, controls
        // settled) before the next one claims the session.
        setTimeout(() => drainQueue(session.id), 0);
    }
}

// =============================================================
// MACHINE RESOURCES
// =============================================================
const GB = 1024 ** 3;
let lastMemLevel = "ok";
let memWarnShown = false;
// which model substitutions have already been announced this run — the same
// fallback repeated every session open is a nag, not information
const fallbackNoticed = new Set();

function fmtGB(bytes) {
    // NEVER PRINT NaN AT A HUMAN. Every caller here feeds this a field off a
    // stats object, and any one of them can be absent when a probe half-fails
    // — measured in the UI harness, the memory panel read "11.2 GB free of
    // NaN GB". A missing number is a thing we do not know, and saying so is
    // both true and readable; "NaN" is neither.
    const n = Number(bytes);
    if (!Number.isFinite(n)) return "unknown";
    return (n / GB).toFixed(1) + " GB";
}

async function pollResources() {
    let s = null;
    try { s = await window.lcl.systemStats(); } catch { return; }
    if (!s) return;

    // Bar shows memory IN USE against physical RAM. Availability is the signal
    // that governs paging; commit-vs-limit is reported separately in the
    // tooltip because it answers a different question (will allocations fail).
    const usedPct = Math.min(100, Math.round((1 - s.availRatio) * 100));
    $("mem-fill").style.width = usedPct + "%";
    $("mem-fill").className = s.level;                 // ok | low | critical
    // NAMES ITSELF. It sits under one "Memory" heading shared with the linked
    // machines, so this row has to say which machine it is. That used to be a
    // whole heading of its own, costing 29px of a column the session list
    // needed far more than the word "This machine" did.
    $("mem-text").innerText =
        `this machine · ${fmtGB(s.availableBytes)} free of ${fmtGB(s.physTotalBytes)}`;

    // only what the visible line does NOT say — the available-of-total is
    // the text under the cursor, and model state is the status line above it
    $("resource-bar").title =
        `Committed:  ${fmtGB(s.commitUsedBytes)} of ${fmtGB(s.commitLimitBytes)} limit ` +
        `(${Math.round(s.commitRatio * 100)}%)\n` +
        `Room for a second model: ${s.headroomForAnotherModel ? "yes" : "no"}`;

    // The low-memory warning only matters while work is ACTUALLY running — a
    // resident-but-idle model is not consuming cycles, and warning at an idle
    // chat just nags. Only interrupt when a turn/plan is in flight (that is
    // when a memory dip can actually stall something the user is waiting on).
    const busy = (typeof pending !== "undefined" && pending) || taskEls.size > 0;
    if (busy && s.level === "critical" && lastMemLevel !== "critical" && !memWarnShown) {
        memWarnShown = true;
        await modal({
            title: "Low available memory",
            message: "A task is running and this machine is short on usable memory.",
            detail:
                `${fmtGB(s.availableBytes)} available of ${fmtGB(s.physTotalBytes)}.\n\n` +
                "Below about 1 GB available, Windows pages actively and things slow " +
                "down. Close some other apps if the current task stalls.\n\n" +
                "Open View > Machine to see what is holding memory.",
            confirmLabel: "Got it",
            confirmOnly: true
        });
        setTimeout(() => { memWarnShown = false; }, 300000);
    }
    lastMemLevel = s.level;
}

// =============================================================
// NODE GAUGES (sidebar) — the Spark's memory, live, beside the laptop's
// =============================================================
/**
 * "just like we have ram monitoring on our local machine, when one of these
 *  bad boys is connected, we would need its monitor as well, in the ui."
 *
 * Same grammar as the bar directly above: fill against total, colour by
 * headroom, what is resident underneath. The number is the node's own
 * /proc/meminfo over one SSH round trip — on GB10 unified memory that file
 * is the truth and nvidia-smi is not. It lived in the Machine panel behind
 * Ctrl+M, which is where a readout goes to not be seen; a live gauge belongs
 * where the eye already is while a model runs.
 *
 * The poll is polite about failure: a node that does not answer costs the
 * full ssh timeout, so an unreachable node is asked again in a minute, not
 * every tick. In-flight guard because a slow answer must never stack behind
 * the next tick's question.
 */
const nodeBars = new Map();          // node id -> { root, name, val, fill, sub }
const nodeRetryAt = new Map();       // node id -> epoch ms before which we skip
let nodeBarsBusy = false;

function nodeBarEl(n) {
    const root = document.createElement("button");
    root.className = "node-bar";
    // the node's OWN dashboard — not the laptop's Machine panel
    root.addEventListener("click", () => openNodeDash(n));

    const head = document.createElement("div");
    head.className = "node-bar-head";
    const name = document.createElement("span");
    name.className = "node-bar-name";
    name.innerText = n.name || n.host;
    head.appendChild(name);

    const track = document.createElement("div");
    track.className = "node-bar-track";
    const fill = document.createElement("div");
    fill.className = "node-bar-fill";
    track.appendChild(fill);

    const val = document.createElement("div");
    val.className = "node-bar-val";
    val.innerText = "checking…";
    const sub = document.createElement("div");
    sub.className = "node-bar-sub hidden";

    root.appendChild(head);
    root.appendChild(track);
    root.appendChild(val);
    root.appendChild(sub);
    return { root, name, val, fill, sub, track };
}

async function pollNodeBars() {
    if (nodeBarsBusy) return;
    nodeBarsBusy = true;
    try {
        let res = null;
        try { res = await window.lcl.nodeList(); } catch { return; }
        const nodes = (res && res.nodes) || [];
        const host = $("node-bars");

        // reconcile the element set with the node set — update in place, so a
        // 8-second repaint never resets a hover or scroll mid-look
        const liveIds = new Set(nodes.map(n => n.id));
        for (const [id, el] of nodeBars) {
            if (!liveIds.has(id)) {
                el.root.remove();
                nodeBars.delete(id);
                nodeRetryAt.delete(id);
            }
        }
        for (const n of nodes) {
            if (!nodeBars.has(n.id)) {
                const el = nodeBarEl(n);
                nodeBars.set(n.id, el);
                host.appendChild(el.root);
            }
            nodeBars.get(n.id).name.innerText = n.name || n.host;
        }
        // ONE HEADING OVER THE WHOLE GROUP, and it is "Memory", shared with
        // this machine's own gauge above. Every row carries its machine name,
        // so there is nothing to relabel here — and that is one fewer row
        // between the session list and the footer.
        const sect = $("node-section");
        if (sect) sect.classList.toggle("hidden", !nodes.length);

        for (const n of nodes) {
            const el = nodeBars.get(n.id);
            if ((nodeRetryAt.get(n.id) || 0) > Date.now()) continue;
            const s = await window.lcl.nodeStats(n.id).catch(() => null);
            if (!s || !s.ok || !s.physTotalBytes) {
                nodeRetryAt.set(n.id, Date.now() + 60_000);
                // TOLD TWICE: a node that is not connected has no memory
                // reading, so it has no business occupying a memory gauge in
                // the sidebar. The whole row goes. It is still listed, with
                // its real state, in Network > Connections.
                el.root.classList.add("down", "hidden");
                el.fill.style.width = "0%";
                el.fill.className = "node-bar-fill";
                // An empty TRACK reads as a live device sitting at zero. A
                // device that is not answering has no memory reading at all,
                // so the gauge is removed and the row collapses to a name and
                // a state — visibly a different kind of thing.
                el.track.classList.add("hidden");
                // name the culprit when there is one — "unreachable" with
                // the VPN up is a routing problem, not a Spark problem
                const vpn = s && s.vpn && s.vpn.active ? (s.vpn.name || true) : null;
                const who = vpn === true ? "local filter" : vpn;
                el.val.innerText = vpn
                    ? (n.relayUrl
                        ? `unreachable — remote access not answering`
                        : `blocked by ${who} — needs remote access set up`)
                    : "unreachable — retrying in a minute";
                el.sub.classList.add("hidden");
                // the visible val line already names the blocker; the full
                // VPN explanation lives once, in the Connections banner
                el.root.title = n.relayUrl && vpn
                    ? `${n.name || n.host} is not answering directly or through remote ` +
                      "access. Is it powered on?"
                    : `${n.name || n.host} is not answering`;
                continue;
            }
            nodeRetryAt.delete(n.id);
            el.root.classList.remove("down", "hidden");
            el.track.classList.remove("hidden");
            el.fill.style.width = Math.min(100, Math.round(
                (1 - s.availableBytes / s.physTotalBytes) * 100)) + "%";
            el.fill.className = "node-bar-fill " + s.level;
            el.val.innerText =
                `${fmtGB(s.availableBytes)} available of ${fmtGB(s.physTotalBytes)}` +
                (s.via === "door" ? " · via remote access" : "");
            if (s.loaded && s.loaded.length) {
                el.sub.innerText = s.loaded.map(m =>
                    `${m.name} · ${fmtGB(m.sizeBytes)} resident`).join("\n");
                el.sub.classList.remove("hidden");
            } else {
                el.sub.innerText = "";
                el.sub.classList.add("hidden");
            }
            // Only what the visible row does NOT say. The old tooltip
            // interpolated el.val.innerText — a literal copy of the line
            // under the cursor — plus the resident list the sub already shows.
            el.root.title = `${n.name || n.host}` +
                (s.loaded && s.loaded.length ? ""
                    : " — no model resident; loads on first message") +
                "\nclick for the full dashboard";
        }
    } finally {
        // The header only stands over rows that exist. Offline nodes remove
        // their row, so counting the node LIST would leave "Local node"
        // labelling nothing. Re-queried rather than closed over, because an
        // early return can skip the declaration above.
        const sect2 = document.getElementById("node-section");
        if (sect2) {
            const vis = [...nodeBars.values()]
                .filter(e => !e.root.classList.contains("hidden")).length;
            sect2.classList.toggle("hidden", vis === 0);
        }
        nodeBarsBusy = false;
    }
}

// =============================================================
// NODE DASHBOARD — a resource monitor for a machine you own
// =============================================================
/**
 * The requirement: a robust resource monitor — comparable to the GNOME system
 * monitor or a DGX dashboard — giving true insight into the node.
 *
 * Click the node's sidebar bar and get the whole machine, live: CPU, unified
 * memory, GPU utilisation, temperature, power draw, network throughput, disk,
 * and what Ollama holds resident — each with a minute and a half of history
 * drawn as a sparkline, refreshed every 3 seconds while the dashboard is open
 * and not a second longer. Rates (CPU %, MB/s) are computed HERE from the
 * kernel's cumulative counters, because a rate is two readings and only this
 * window knows when it last asked.
 */
const ND_KEEP = 90;                       // samples of history per metric

function sparkline(cv, series, maxOverride = null) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 260, h = cv.clientHeight || 54;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const all = series.flatMap(s => s.values);
    if (!all.length) return;
    const max = maxOverride !== null ? maxOverride : Math.max(...all, 1e-9);
    for (const s of series) {
        const v = s.values;
        if (v.length < 2) continue;
        const step = w / (ND_KEEP - 1);      // fixed step: history fills right-to-left
        const x0 = w - (v.length - 1) * step;
        ctx.beginPath();
        v.forEach((val, i) => {
            const x = x0 + i * step;
            const y = h - 2 - Math.min(1, val / (max || 1)) * (h - 6);
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        });
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.lineTo(x0 + (v.length - 1) * step, h);
        ctx.lineTo(x0, h);
        ctx.closePath();
        ctx.fillStyle = s.color + "22";      // same hue, mostly transparent
        ctx.fill();
    }
}

const fmtRate = (bps) => bps >= 1e9 ? (bps / 1e9).toFixed(2) + " GB/s"
    : bps >= 1e6 ? (bps / 1e6).toFixed(1) + " MB/s"
    : bps >= 1e3 ? (bps / 1e3).toFixed(0) + " kB/s"
    : Math.round(bps) + " B/s";

const fmtUptime = (sec) => {
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
          m = Math.floor((sec % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

async function openNodeDash(n) {
    const wrap = document.createElement("div");
    wrap.className = "nodedash-wrap";

    // ---- SPARK MODES: the operating-mode switch, right on the machine ----
    // deep thought to multiversal — each mode names the model it runs and the
    // window each conversation gets; a click drives the node's door recipe.
    if (n.relayUrl) {
        try {
            const sm = await window.lcl.sparkModes();
            if (sm && sm.ok) {
                const sec = document.createElement("div");
                sec.className = "spark-modes";
                const head = document.createElement("div");
                head.className = "sm-head";
                head.innerText = "Operating mode";
                sec.appendChild(head);
                const row = document.createElement("div");
                row.className = "sm-row";
                const note = document.createElement("div");
                note.className = "sm-note";
                // the CURRENT mode: main remembers the last switch it drove
                // (sm.current); the model+window compare is only the fallback,
                // reading modelId FIRST — picker row .id wears the api: prefix
                const curDrv = modelsCache.find(x => x.remote && x.localNode
                    && x.nodeRole !== "fleet" && !x.offline);
                const curModel = String((curDrv && (curDrv.modelId || curDrv.id)) || "").toLowerCase();
                const curCtx = Number(curDrv && (curDrv.contextMax || curDrv.contextLength)) || 0;
                // live progress from main while a switch runs — door output,
                // loading seconds, ready — instead of a dead "switching…";
                // terminal phases move the highlight even when the switch was
                // started from the picker or before this dashboard opened
                sparkModeNote = (d) => {
                    if (!d) return;
                    if (d.detail) {
                        note.innerText = d.phase === "door" ? ("box: " + d.detail) : d.detail;
                    }
                    if (d.phase === "ready" && d.mode) {
                        row.querySelectorAll("button").forEach(x => {
                            x.disabled = false; x.classList.remove("pending");
                            x.classList.toggle("on", x.innerText === d.mode);
                        });
                    } else if (d.phase === "failed") {
                        row.querySelectorAll("button").forEach(x => {
                            x.disabled = false; x.classList.remove("pending");
                            // A REJOINED switch that fails has no local wasOn to
                            // restore, so the strip used to show NOTHING selected
                            // while the box still served the prior mode. Re-derive
                            // the highlight the same way the strip was first built.
                            const key = x.innerText;
                            const mm = sm.modes[key];
                            const on = sm.current ? key === sm.current
                                : (mm && String(mm.model || "").toLowerCase() === curModel
                                   && Number(mm.ctx) === curCtx);
                            x.classList.toggle("on", !!on);
                        });
                    }
                };
                for (const [key, m] of Object.entries(sm.modes)) {
                    const b = document.createElement("button");
                    b.className = "sm-btn";
                    b.innerText = key;
                    b.title = m.label + " — " + m.blurb;
                    if (sm.current ? key === sm.current
                        : (String(m.model || "").toLowerCase() === curModel
                           && Number(m.ctx) === curCtx)) b.classList.add("on");
                    b.addEventListener("click", async () => {
                        // the active mode is already serving — a re-run would
                        // restart llama-server for nothing
                        if (b.classList.contains("on")) return;
                        // THE CLICK ANSWERS INSTANTLY: the stale highlight
                        // drops, the clicked mode pulses pending — the same
                        // transitional state the picker fold shows
                        const wasOn = [...row.querySelectorAll("button")]
                            .find(x => x.classList.contains("on"));
                        row.querySelectorAll("button").forEach(x => {
                            x.disabled = true; x.classList.remove("on", "pending");
                        });
                        b.classList.add("pending");
                        note.innerText = "starting the switch…";
                        const r = await window.lcl.sparkMode(n.id, key)
                            .catch(e => ({ error: String(e && e.message || e) }));
                        row.querySelectorAll("button").forEach(x => {
                            x.disabled = false; x.classList.remove("pending");
                        });
                        if (r && r.ok) {
                            note.innerText = key + " — " + r.label + ", " +
                                Math.round(r.ctx / 1024) + "k per conversation. " + r.note;
                            row.querySelectorAll("button").forEach(x =>
                                x.classList.toggle("on", x.innerText === key));
                            try { renderHeader(); } catch { /* not visible */ }
                            modelSurfacesChanged().catch(() => { /* heals on next trigger */ });
                        } else {
                            note.innerText = (r && r.error) || "the switch did not go through";
                            // the switch never happened — the old truth returns
                            if (wasOn) wasOn.classList.add("on");
                        }
                    });
                    row.appendChild(b);
                }
                // REJOIN a switch already in flight when this dashboard opens
                // (after the buttons exist — they are what gets marked)
                if (sm.inFlight) {
                    row.querySelectorAll("button").forEach(x => {
                        x.disabled = true;
                        x.classList.toggle("pending", x.innerText === sm.inFlight.mode);
                        x.classList.remove("on");
                    });
                    note.innerText = "switch to " + sm.inFlight.mode + " in flight — rejoining…";
                }
                sec.appendChild(row);
                sec.appendChild(note);
                wrap.appendChild(sec);
            }
        } catch { /* dashboard renders without the strip */ }
    }

    // ---- header strip: the machine's vitals in one line ----
    const strip = document.createElement("div");
    strip.className = "nodedash-strip";
    const stripItem = (label) => {
        const s = document.createElement("span");
        s.className = "nd-strip-item";
        const v = document.createElement("b");
        v.innerText = "—";
        s.appendChild(v);
        s.appendChild(document.createTextNode(" " + label));
        strip.appendChild(s);
        return v;
    };
    const stHost = stripItem("");
    stHost.innerText = n.host;
    const stUp = stripItem("uptime");
    const stLoad = stripItem("load");
    const stCores = stripItem("cores");
    const stState = document.createElement("span");
    stState.className = "nd-strip-state wait";
    stState.innerText = "connecting…";
    strip.appendChild(stState);
    wrap.appendChild(strip);

    // ---- tiles, each with its own sparkline ----
    const grid = document.createElement("div");
    grid.className = "nodedash-grid";
    wrap.appendChild(grid);
    const tile = (label) => {
        const t = document.createElement("div");
        t.className = "nd-tile";
        const v = document.createElement("div");
        v.className = "nd-val";
        v.innerText = "—";
        const l = document.createElement("div");
        l.className = "nd-label";
        l.innerText = label;
        const cv = document.createElement("canvas");
        cv.className = "nd-canvas";
        const sub = document.createElement("div");
        sub.className = "nd-sub";
        t.appendChild(v); t.appendChild(l); t.appendChild(cv); t.appendChild(sub);
        grid.appendChild(t);
        return { val: v, cv, sub };
    };
    const tCpu = tile("cpu");
    const tMem = tile("unified memory");
    const tGpu = tile("gpu");
    const tTemp = tile("gpu temperature");
    const tPow = tile("power draw");
    const tNet = tile("network");

    // ---- disk: a bar, not a sparkline — it moves in days, not seconds ----
    const diskRow = document.createElement("div");
    diskRow.className = "nd-disk";
    const diskHead = document.createElement("div");
    diskHead.className = "nd-disk-head";
    const diskName = document.createElement("span");
    diskName.className = "nd-label";
    diskName.innerText = "disk";
    const diskVal = document.createElement("span");
    diskVal.className = "nd-disk-val";
    diskVal.innerText = "—";
    diskHead.appendChild(diskName); diskHead.appendChild(diskVal);
    const diskTrack = document.createElement("div");
    diskTrack.className = "nd-disk-track";
    const diskFill = document.createElement("div");
    diskFill.className = "nd-disk-fill";
    diskTrack.appendChild(diskFill);
    diskRow.appendChild(diskHead); diskRow.appendChild(diskTrack);
    wrap.appendChild(diskRow);

    // ---- resident models ----
    const modHead = document.createElement("div");
    modHead.className = "nd-label nd-models-head";
    modHead.innerText = "resident models";
    const modList = document.createElement("div");
    modList.className = "nd-models";
    modList.innerText = "—";
    wrap.appendChild(modHead);
    wrap.appendChild(modList);

    // ---- the live loop ----
    const hist = { cpu: [], mem: [], gpu: [], temp: [], pow: [], rx: [], tx: [] };
    const push = (k, v2) => {
        hist[k].push(v2);
        if (hist[k].length > ND_KEEP) hist[k].shift();
    };
    let prev = null;
    let closed = false;
    let ticking = false;

    const tick = async () => {
        if (ticking || closed) return;
        ticking = true;
        try {
            const s = await window.lcl.nodeDash(n.id).catch(() => null);
            if (closed) return;
            if (!s || !s.ok) {
                const vpn = s && s.vpn && s.vpn.active
                    ? (s.vpn.name || "a local filter") : null;
                stState.innerText = vpn
                    ? `blocked by ${vpn} — remote access takes over once set up`
                    : `unreachable — ${(s && s.error) || "no answer"}`;
                stState.classList.remove("wait");
                stState.classList.add("down");
                prev = null;             // a gap in cumulative counters is not a rate
                return;
            }
            stState.classList.remove("down", "wait");
            stState.innerText = s.via === "door" ? "live · via remote access" : "live";
            stUp.innerText = fmtUptime(s.uptimeSec);
            stLoad.innerText = (s.load || []).map(x => x.toFixed(2)).join(" ");
            if (s.cpu.cores) stCores.innerText = String(s.cpu.cores);

            // cpu % — delta over the polling interval
            if (prev && s.cpu.totalTicks > prev.cpu.totalTicks) {
                const dT = s.cpu.totalTicks - prev.cpu.totalTicks;
                const dI = s.cpu.idleTicks - prev.cpu.idleTicks;
                const pct = Math.min(100, Math.max(0, Math.round((1 - dI / dT) * 100)));
                push("cpu", pct);
                tCpu.val.innerText = pct + "%";
            } else {
                tCpu.val.innerText = "measuring…";
            }
            sparkline(tCpu.cv, [{ values: hist.cpu, color: "#8fb8e8" }], 100);

            // unified memory
            if (s.mem.totalBytes) {
                const used = s.mem.totalBytes - s.mem.availableBytes;
                push("mem", used);
                tMem.val.innerText = fmtGB(used) + " of " + fmtGB(s.mem.totalBytes);
                tMem.sub.innerText = fmtGB(s.mem.availableBytes) + " available";
                sparkline(tMem.cv, [{ values: hist.mem, color: "#9adfae" }], s.mem.totalBytes);
            }

            // gpu — utilisation, temperature, power. Each field stands alone:
            // GB10 answers some of these with N/A and the rest still matter.
            if (s.gpu && s.gpu.util !== null) {
                push("gpu", s.gpu.util);
                tGpu.val.innerText = Math.round(s.gpu.util) + "%";
                sparkline(tGpu.cv, [{ values: hist.gpu, color: "#8fb8e8" }], 100);
            } else { tGpu.val.innerText = "—"; }
            if (s.gpu && s.gpu.tempC !== null) {
                push("temp", s.gpu.tempC);
                tTemp.val.innerText = Math.round(s.gpu.tempC) + " °C";
                sparkline(tTemp.cv, [{ values: hist.temp, color: "#e0b56f" }], 100);
            } else { tTemp.val.innerText = "—"; }
            if (s.gpu && s.gpu.powerW !== null) {
                push("pow", s.gpu.powerW);
                tPow.val.innerText = Math.round(s.gpu.powerW) + " W";
                sparkline(tPow.cv, [{ values: hist.pow, color: "#e0b56f" }]);
            } else { tPow.val.innerText = "—"; }
            if (!s.gpu) tGpu.sub.innerText = "nvidia-smi not answering";

            // network — bytes per second from cumulative counters
            if (prev && s.at > prev.at) {
                const dt = (s.at - prev.at) / 1000;
                const rx = Math.max(0, (s.net.rxBytes - prev.net.rxBytes) / dt);
                const tx = Math.max(0, (s.net.txBytes - prev.net.txBytes) / dt);
                push("rx", rx); push("tx", tx);
                tNet.val.innerText = "↓ " + fmtRate(rx);
                tNet.sub.innerText = "↑ " + fmtRate(tx);
            } else {
                tNet.val.innerText = "measuring…";
            }
            sparkline(tNet.cv, [
                { values: hist.rx, color: "#8fb8e8" },
                { values: hist.tx, color: "#9adfae" }
            ]);

            // disk
            if (s.disk) {
                const pct = Math.round((s.disk.usedBytes / s.disk.totalBytes) * 100);
                diskFill.style.width = pct + "%";
                diskVal.innerText =
                    `${fmtGB(s.disk.usedBytes)} used of ${fmtGB(s.disk.totalBytes)} (${pct}%)`;
            }

            // resident models
            modList.innerHTML = "";
            if (s.models.length) {
                for (const m of s.models) {
                    const row = document.createElement("div");
                    row.className = "nd-model-row";
                    const nm = document.createElement("span");
                    nm.innerText = m.name;
                    const sz = document.createElement("span");
                    sz.className = "nd-model-size";
                    sz.innerText = fmtGB(m.sizeBytes);
                    row.appendChild(nm); row.appendChild(sz);
                    modList.appendChild(row);
                }
            } else {
                modList.innerText = "none resident";
            }
            prev = s;
        } finally {
            ticking = false;
        }
    };

    tick();
    const timer = setInterval(tick, 3000);
    await modal({ title: (n.name || n.host) + " — node dashboard", node: wrap,
                  confirmLabel: "Close", confirmOnly: true, size: "max" });
    closed = true;
    clearInterval(timer);
}

// =============================================================
// MACHINE VIEW  (read-only)
// =============================================================
// SECURITY PANEL — network toggle + engagement management (user-only)
// =============================================================
async function openSecurity() {
    $("security-scrim").classList.remove("hidden");
    await refreshSecurity();
}
function closeSecurity() {
    $("security-scrim").classList.add("hidden");
}

async function refreshSecurity() {
    let state = null;
    try { state = await window.lcl.securityState(); } catch { return; }
    if (!state) return;

    $("net-toggle").checked = !!state.networkEnabled;

    const list = $("engagement-list");
    list.innerHTML = "";
    const live = state.engagements || [];
    if (!live.length) {
        const empty = document.createElement("div");
        empty.className = "eng-empty";
        empty.innerText = "No active engagements — offensive tools are off.";
        list.appendChild(empty);
    }
    for (const e of live) {
        const row = document.createElement("div");
        row.className = "eng-item";
        const mins = Math.max(0, Math.round((e.expiresAt - Date.now()) / 60000));
        const left = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
        const info = document.createElement("div");
        info.innerHTML = "";
        const host = document.createElement("div");
        host.className = "eng-host";
        host.innerText = e.target;
        const meta = document.createElement("div");
        meta.className = "eng-meta";
        meta.innerText = `expires in ${left}${e.note ? ` · ${e.note}` : ""}`;
        info.appendChild(host); info.appendChild(meta);
        const revoke = document.createElement("button");
        revoke.className = "ghost";
        revoke.innerText = "Revoke";
        revoke.addEventListener("click", async () => {
            await window.lcl.revokeEngagement(e.id);
            await refreshSecurity();
        });
        row.appendChild(info); row.appendChild(revoke);
        list.appendChild(row);
    }
}

$("security-close").addEventListener("click", closeSecurity);
$("security-scrim").addEventListener("click", (e) => {
    if (e.target === $("security-scrim")) closeSecurity();
});

$("net-toggle").addEventListener("change", async (e) => {
    await window.lcl.setNetworkEnabled(e.target.checked);
    paintNetPill(e.target.checked);
});

// =============================================================
// NETWORK — the one switch, on the surface
// =============================================================
/**
 * Internet access had exactly one control: a checkbox inside the Security
 * panel, behind a menu named "Security". Nothing on the way in said the word
 * network, so the capability the app exists to offer was invisible until you
 * went looking for a guard rail. This paints it in the title bar, always,
 * whether it is on or off.
 */
let netOn = false;

function paintNetPill(on) {
    // THE TOPBAR ONLINE ICON IS GONE. This only tracks the boolean for
    // the callers that read `netOn`; there is no pill to paint.
    netOn = !!on;
}

// toggleNetwork and the topbar pill were removed. Network is enabled
// automatically when an endpoint is linked, and the Network-access-for-testing
// item governs that mode; there is no global on/off switch in the title bar.

async function refreshNetPill() {
    try {
        const st = await window.lcl.securityState();
        if (st) paintNetPill(!!st.networkEnabled);
    } catch { /* leave the pill as it is */ }
}

// the Create button unlocks only when the authorization box is ticked — the
// affirmation is the gate, mirrored on both sides of the IPC
$("eng-authorized").addEventListener("change", () => {
    $("eng-create").disabled = !$("eng-authorized").checked;
});

$("engagement-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const err = $("eng-error");
    err.classList.add("hidden");
    const spec = {
        target: $("eng-target").value.trim(),
        hours: Number($("eng-hours").value) || 8,
        note: $("eng-note").value.trim(),
        authorized: $("eng-authorized").checked
    };
    const res = await window.lcl.createEngagement(spec);
    if (!res || res.error) {
        err.innerText = (res && res.error) || "could not create the engagement";
        err.classList.remove("hidden");
        return;
    }
    $("eng-target").value = "";
    $("eng-note").value = "";
    $("eng-authorized").checked = false;
    $("eng-create").disabled = true;
    await refreshSecurity();
});

// ---- Capability map: what this install can actually do ----
// model/memory scale — distinct from fmtBytes above, which formats file sizes
const fmtBig = (b) => !b ? "—"
    : b < 0.1e9 ? Math.round(b / 1e6) + " MB" : (b / 1e9).toFixed(1) + " GB";

/**
 * YOUR CODE AS CONTEXT — AND WHAT IT WOULD ACTUALLY KEEP.
 *
 * "I can see what was excluded and why, and I can review a sample of what will
 *  be stored before it is stored."
 *
 * Both halves, side by side: the shape it keeps, and the count of what it
 * withheld. Nothing is stored by this panel — the survey is read, shown and
 * dropped. Keeping it is the next decision, not this one.
 */
async function openCodeShape() {
    const wrap = document.createElement("div");
    wrap.className = "pref-wrap";
    const h = document.createElement("div");
    h.className = "pref-head";
    h.innerText = "Survey a code folder";
    wrap.appendChild(h);
    const note = document.createElement("div");
    note.className = "pref-note";
    note.innerText = "Reads the SHAPE of your code: the tree, languages, sizes, " +
        "definition counts, and the public packages it imports. File contents are " +
        "read and discarded, and any path segment that is not a plainly generic " +
        "word is replaced. Nothing is stored by this screen.";
    wrap.appendChild(note);

    const btn = document.createElement("button");
    btn.className = "primary";
    btn.innerText = "Choose a folder...";
    wrap.appendChild(btn);
    const out = document.createElement("div");
    out.className = "shape-out";
    wrap.appendChild(out);

    btn.addEventListener("click", async () => {
        btn.disabled = true; btn.innerText = "Surveying...";
        const r = await window.lcl.surveyRepoShape()
            .catch(e => ({ error: String((e && e.message) || e) }));
        btn.disabled = false; btn.innerText = "Choose another folder...";
        out.innerHTML = "";
        if (!r || r.canceled) return;
        if (r.error) { out.innerText = r.error; return; }
        const line = (t, cls) => {
            const d = document.createElement("div");
            d.className = cls || "pref-note";
            d.innerText = t;
            out.appendChild(d);
        };
        const q = r.summary;
        line(q.fileCount + " files \u00b7 " + q.totalLines.toLocaleString() + " lines \u00b7 " +
             Object.entries(q.byLanguage).map(([k, v]) => k + " " + v).join(", "), "shape-head");
        line("structure: depth " + q.depth.max + " (mean " + q.depth.mean + ") \u00b7 " +
             q.fanOut.directories + " directories, widest " + q.fanOut.widest + " \u00b7 " +
             "median file " + q.sizeSpread.medianLines + " lines \u00b7 tests " +
             Math.round(q.testRatio * 100) + "%");
        line("public packages kept: " + (q.publicDependencies.length
            ? q.publicDependencies.slice(0, 12).map(d => d.name + " (" + d.uses + ")").join(", ")
            : "none \u2014 no manifest, or nothing imported from one"));
        /* THE WITHHELD BLOCK IS THE AUDIT SURFACE. Every counter the survey
         * keeps has to reach this line, or the operator is reviewing an
         * exclusion list that is quietly shorter than the exclusions. Four of
         * these were being counted and never shown \u2014 a truncated survey in
         * particular looked exactly like a complete one. */
        const w = r.withheld || {};
        line("WITHHELD \u2014 " + (w.paths || 0) + " path names generalised, " +
             (w.skippedDirs || 0) + " build directories skipped, " +
             (w.binaries || 0) + " binary files, " +
             (w.nonSourceText || 0) + " non-code text files, " +
             (w.dependencies || 0) + " dependency names that could not be " +
             "proven public, " + (w.oversized || 0) + " oversized",
             "shape-withheld");
        if (w.truncated || w.unwalkedDirs) {
            line("THIS SURVEY IS PARTIAL \u2014 it stopped at the file limit with " +
                 (w.truncated || 0) + " more file" + ((w.truncated === 1) ? "" : "s") +
                 " and " + (w.unwalkedDirs || 0) + " director" +
                 ((w.unwalkedDirs === 1) ? "y" : "ies") + " unread. Every number " +
                 "above describes only the part that was walked.", "shape-withheld");
        }
        line("stores: " + r.stores);
        line("never stores: " + r.neverStores, "shape-withheld");
        const pre = document.createElement("pre");
        pre.className = "shape-sample";
        pre.innerText = (r.sample || []).map(f =>
            f.path.padEnd(34) + String(f.lines || 0).padStart(6) + " lines  " + f.lang).join("\n");
        out.appendChild(pre);
    });

    await modal({ title: "Survey my code", node: wrap,
                  confirmLabel: "Close", confirmOnly: true, size: "wide" });
}

/**
 * PATCH .lcl WITH .lcl.
 *
 * A patch session is a git worktree of this repo, placed outside the repo, on
 * its own branch, scoped to an allowlist agreed before anything runs. Review
 * judges the diff and COMMITS what passes, then stops. Landing it is one
 * command the operator runs themselves, which is what makes a bricked app
 * impossible rather than merely unlikely.
 */
async function openPatchBay() {
    const wrap = document.createElement("div");
    wrap.className = "pref-wrap";
    const av = await window.lcl.patchAvailable().catch(() => null);
    if (!av || !av.ok) {
        const n = document.createElement("div");
        n.className = "pref-note";
        n.innerText = (av && av.reason) || "the patch bay is unavailable here";
        wrap.appendChild(n);
        const n2 = document.createElement("div");
        n2.className = "pref-note";
        n2.innerText = "This needs the source and git. It works on a development " +
            "checkout; an installed build ships compiled, without either.";
        wrap.appendChild(n2);
        await modal({ title: "Patch .lcl itself", node: wrap,
                      confirmLabel: "Close", confirmOnly: true, size: "wide" });
        return;
    }

    const h = document.createElement("div");
    h.className = "pref-head";
    h.innerText = "What may this patch touch?";
    wrap.appendChild(h);
    const note = document.createElement("div");
    note.className = "pref-note";
    note.innerText = "Written down before anything runs. The kernel, the loop that " +
        "obeys it, the guards and the tests can never be in scope, however the " +
        "scope is written.";
    wrap.appendChild(note);

    const input = document.createElement("input");
    input.className = "pref-input";
    input.type = "text";
    input.placeholder = "app/renderer/, .lcl.engine/core/knowledge.js";
    wrap.appendChild(input);

    const out = document.createElement("div");
    out.className = "shape-out";
    wrap.appendChild(out);

    const row = document.createElement("div");
    row.className = "kb-actions";
    const openBtn = document.createElement("button");
    openBtn.className = "primary";
    openBtn.innerText = "Open a patch session";
    const reviewBtn = document.createElement("button");
    reviewBtn.className = "ghost";
    reviewBtn.innerText = "Review changes";
    reviewBtn.disabled = true;
    const dropBtn = document.createElement("button");
    dropBtn.className = "ghost danger-text";
    dropBtn.innerText = "Discard";
    dropBtn.disabled = true;
    row.appendChild(openBtn); row.appendChild(reviewBtn); row.appendChild(dropBtn);
    wrap.appendChild(row);

    let current = null;
    const panelLine = (t, cls) => {
        const d = document.createElement("div");
        d.className = cls || "pref-note";
        d.innerText = t;
        out.appendChild(d);
    };

    openBtn.addEventListener("click", async () => {
        out.innerHTML = "";
        const scope = input.value.split(",").map(x => x.trim()).filter(Boolean);
        if (!scope.length) { panelLine("Name at least one path this patch may touch."); return; }
        const r = await window.lcl.patchOpen(active ? active.id : "s", scope)
            .catch(e => ({ ok: false, error: String((e && e.message) || e) }));
        if (!r.ok) {
            panelLine(r.error || "could not open a patch session");
            for (const ref of ((r.scope && r.scope.refused) || [])) {
                panelLine("refused: " + ref.entry + " \u2014 " + ref.why, "shape-withheld");
            }
            return;
        }
        current = r.id;
        reviewBtn.disabled = false; dropBtn.disabled = false;
        panelLine("Working copy: " + r.dir, "shape-head");
        panelLine("Branch " + r.branch + ", from " + String(r.base).slice(0, 8));
        panelLine("in scope: " + r.scope.allowed.join(", "));
        for (const ref of r.scope.refused) {
            panelLine("refused: " + ref.entry + " \u2014 " + ref.why, "shape-withheld");
        }
        panelLine("Edit files in that folder \u2014 by hand, or by pointing a session at it " +
            "\u2014 then come back and review.");
    });

    reviewBtn.addEventListener("click", async () => {
        out.innerHTML = "";
        const r = await window.lcl.patchReview(current)
            .catch(e => ({ ok: false, error: String((e && e.message) || e) }));
        if (!r.ok) {
            panelLine(r.error || "the patch did not pass review", "shape-withheld");
            for (const pr of (r.problems || [])) {
                panelLine("\u00b7 " + (pr.file ? pr.file + ": " : "") + pr.why, "shape-withheld");
            }
            if (r.diff) {
                const pre = document.createElement("pre");
                pre.className = "shape-sample";
                pre.innerText = r.diff.slice(0, 8000);
                out.appendChild(pre);
            }
            return;
        }
        panelLine(r.files.length + " file" + (r.files.length === 1 ? "" : "s") +
            ", +" + r.addedTotal + " lines \u2014 committed as " +
            String(r.sha).slice(0, 8), "shape-head");
        const pre = document.createElement("pre");
        pre.className = "shape-sample";
        pre.innerText = r.diff.slice(0, 20000);
        out.appendChild(pre);
        panelLine(r.note);
        panelLine(r.howToLand, "shape-head");
    });

    dropBtn.addEventListener("click", async () => {
        await window.lcl.patchDiscard(current).catch(() => null);
        current = null;
        reviewBtn.disabled = true; dropBtn.disabled = true;
        out.innerHTML = "";
        panelLine("Discarded. The repository was never touched.");
    });

    await modal({ title: "Patch .lcl itself", node: wrap,
                  confirmLabel: "Close", confirmOnly: true, size: "max" });
}

async function openCapabilities() {
    $("cap-scrim").classList.remove("hidden");
    const body = $("cap-body");
    let snap = null;
    try { snap = await window.lcl.capabilityMap(); } catch { /* handled below */ }
    if (!snap || snap.error) {
        $("cap-machine").innerText = (snap && snap.error) || "could not read capabilities";
        return;
    }

    const m = snap.machine, s = snap.summary, f = snap.features || {};
    const mach = $("cap-machine");
    mach.innerHTML = "";
    const facts = [
        [`${m.cores} cores`, ""],
        [`${fmtBig(m.totalBytes)} RAM`, ""],
        [`${fmtBig(m.availableBytes)} free now`, m.availableBytes < 4e9 ? "warn" : ""],
        [`${s.loadableNow} of ${s.languageModels} models loadable now`,
            s.loadableNow ? "" : "warn"],
        [f.networkEnabled ? "network ON" : "offline", f.networkEnabled ? "warn" : "good"]
    ];
    for (const [text, tone] of facts) {
        const chip = document.createElement("span");
        chip.className = "cap-chip" + (tone ? " " + tone : "");
        chip.innerText = text;
        mach.appendChild(chip);
    }
    const extras = [
        ["semantic search", f.semanticSearch], ["reranking", f.reranker],
        ["OCR", f.ocr], [`${f.libraries || 0} knowledge librar${f.libraries === 1 ? "y" : "ies"}`,
            (f.libraries || 0) > 0]
    ];
    for (const [label, on] of extras) {
        const chip = document.createElement("span");
        chip.className = "cap-chip " + (on ? "good" : "off");
        chip.innerText = (on ? "✓ " : "· ") + label;
        mach.appendChild(chip);
    }

    // ---- system requirements
    const reqs = snap.requirements;
    const rw = $("cap-reqs");
    rw.innerHTML = "";
    if (reqs) {
        const rt = document.createElement("table");
        rt.className = "cap-table";
        rt.innerHTML = "<thead><tr><th></th><th>Minimum</th><th>Comfortable</th>" +
                       "<th>To run everything</th></tr></thead>";
        const rb = document.createElement("tbody");
        for (const row of reqs.rows) {
            const tr = document.createElement("tr");
            const cells = [row.label, row.min, row.ok, row.all];
            cells.forEach((v, i) => {
                const td = document.createElement("td");
                td.innerText = (i > 0 && row.bytes) ? fmtBig(v) : String(v);
                if (i === 0) td.className = "cap-req-label";
                tr.appendChild(td);
            });
            rb.appendChild(tr);
        }
        rt.appendChild(rb);
        rw.appendChild(rt);
        $("cap-formula").innerText =
            `How it is calculated: ${reqs.formula}.\n\n${reqs.sharedMemoryNote}`;
    }

    // ---- behavior toggles: every app-function dial in one place
    const bh = snap.behaviors || {};
    const bwrap = $("cap-behaviors");
    bwrap.innerHTML = "";
    const behaviorRow = (label, sub, control) => {
        const row = document.createElement("div");
        row.className = "cap-brow";
        const info = document.createElement("div");
        const t = document.createElement("div");
        t.className = "cap-brow-label";
        t.innerText = label;
        const d = document.createElement("div");
        d.className = "cap-brow-sub";
        d.innerText = sub;
        info.appendChild(t); info.appendChild(d);
        row.appendChild(info); row.appendChild(control);
        bwrap.appendChild(row);
    };
    const flash = (el, ok) => {
        el.classList.add(ok ? "saved" : "save-failed");
        setTimeout(() => el.classList.remove("saved", "save-failed"), 900);
    };

    // in-scope writes: notify vs confirm
    {
        const sel = document.createElement("select");
        sel.className = "cap-level auto";
        for (const [v, l] of [["notify", "run, then show the change"], ["confirm", "ask before every write"]]) {
            const o = document.createElement("option");
            o.value = v; o.innerText = l; if (bh.writeMode === v) o.selected = true;
            sel.appendChild(o);
        }
        sel.addEventListener("change", async () => {
            const r = await window.lcl.setBehavior("writeMode", sel.value).catch(() => null);
            flash(sel, !!(r && r.ok));
        });
        behaviorRow("File writes in the workspace",
            "every change is recorded and revertable either way", sel);
    }
    // auto-grounding
    {
        const sel = document.createElement("select");
        sel.className = "cap-level auto";
        for (const [v, l] of [["on", "automatic"], ["off", "only when asked"]]) {
            const o = document.createElement("option");
            o.value = v; o.innerText = l;
            if ((bh.groundingEnabled !== false) === (v === "on")) o.selected = true;
            sel.appendChild(o);
        }
        sel.addEventListener("change", async () => {
            const r = await window.lcl.setBehavior("groundingEnabled", sel.value === "on").catch(() => null);
            flash(sel, !!(r && r.ok));
        });
        behaviorRow("Knowledge grounding",
            "search your libraries before answering and cite what was used", sel);
    }
    // The network switch used to be HERE as well as in Security and now in
    // Models & API — three places for one boolean. Reported: "SECURITY? WHY. WHY
    // IS THAT HAVE NETWORK." Adding a fourth copy with a note saying where the
    // real one is would have been worse, not better.
    //
    // It lives in Models & API, beside the endpoints that are the only reason to
    // turn it on. Security still governs what the network may DO once it is on —
    // which tools, which approvals — and that is a different question.

    // The remote-model connect box used to live HERE, inside the capability
    // panel. Reported: linking an API did not belong on the knowledge panel.
    // Correct — an API endpoint has nothing to
    // do with what the app can do, and nobody would look for it here. It now
    // lives in Models & API, where a person would actually go looking.

    // ---- models table
    const wrap = $("cap-models");
    wrap.innerHTML = "";
    const t = document.createElement("table");
    t.className = "cap-table";
    t.innerHTML = "<thead><tr><th>Model</th><th>Size</th><th>Good at</th>" +
                  "<th>Needs</th><th>Context now</th></tr></thead>";
    const tb = document.createElement("tbody");
    for (const mm of snap.models) {
        const tr = document.createElement("tr");
        if (!mm.installed) tr.className = "cap-missing";
        else if (mm.isLLM && !mm.fitsNow) tr.className = "cap-nofit";

        const name = document.createElement("td");
        const id = document.createElement("span");
        id.className = "cap-id";
        id.innerText = mm.id;
        name.appendChild(id);
        if (mm.roles.length) {
            const r = document.createElement("span");
            r.className = "cap-role";
            r.innerText = mm.roles.join(" · ");
            name.appendChild(r);
        }
        if (!mm.installed) {
            const r = document.createElement("span");
            r.className = "cap-role warn";
            r.innerText = "not installed";
            name.appendChild(r);
        }
        if (mm.notes) name.title = mm.notes;

        const size = document.createElement("td");
        size.innerText = fmtBig(mm.sizeBytes);
        const good = document.createElement("td");
        good.innerText = mm.traits.length
            ? mm.traits.map(x => x.label).join(", ") : "—";
        const need = document.createElement("td");
        need.innerText = fmtBig(mm.needBytes);
        const ctx = document.createElement("td");
        if (!mm.isLLM) {
            ctx.innerText = "—";
        } else if (mm.contextNow) {
            ctx.innerText = mm.contextNow.toLocaleString();
        } else {
            // "needs more RAM" is a dead end; say how much, so it is a task
            ctx.innerText = `free ${fmtBig(mm.shortfallBytes)}`;
            ctx.className = "cap-short";
        }
        // the band answers "is freeing memory worth it, and how much?"
        if (mm.band) {
            const usable = mm.band.filter(b => b.context);
            ctx.title = usable.length
                ? "context by free memory — " +
                  usable.map(b => `${b.freeGB} GB: ${b.context.toLocaleString()}`).join(" · ")
                : "does not fit at any tested memory level";
        }

        for (const cell of [name, size, good, need, ctx]) tr.appendChild(cell);
        tb.appendChild(tr);
    }
    t.appendChild(tb);
    wrap.appendChild(t);

    // The table above is the LOCAL ladder — what fits in this machine's RAM.
    // Linked API models are not in it because memory maths does not apply to
    // them, but saying nothing made them look missing: "i still show 11 out
    // of 13 models installed... i see nothing of the new api models."
    try {
        const cs = await window.lcl.cloudState();
        const eps = (cs && cs.endpoints) || [];
        const nApi = eps.reduce((n, e) => n + ((e.models || []).length), 0);
        if (nApi) {
            const line = document.createElement('div');
            line.className = 'cap-formula';
            line.innerText = 'Plus ' + nApi + ' API model' + (nApi === 1 ? '' : 's') +
                ' on ' + eps.map(e => e.label).join(', ') +
                ' — no local memory needed; pick them from the model button or Global > Manage Models.';
            wrap.appendChild(line);
        }
    } catch { /* the local table stands alone */ }

    // ---- tools by capability
    const tools = $("cap-tools");
    tools.innerHTML = "";

    // THREE LAYERS, NOT ONE.
    //
    // The requirement: permissions need a master toggle across the grouped
    //  commands and functions (like Media conversion or network), not only
    //  one-by-one control. There should be three layers — individual, by group,
    //  and master — so all permissions can be set one way and then tweaked
    //  as needed.
    //
    // Exactly right, and the per-tool dial was the only one that existed. There
    // are dozens of tools; setting a posture meant dozens of clicks, so nobody
    // sets a posture and the deny-by-default kernel gets used at whatever it
    // shipped with.
    //
    // The bulk dials do NOT bypass the kernel. Each one applies the chosen level
    // per tool through the same setToolPolicy call the individual dial uses, so
    // every floor still clamps: asking for "run without asking" across a group
    // leaves anything with a confirm floor on confirm, and the result reports
    // how many were clamped rather than pretending it worked.
    const allTools = snap.toolGroups.flatMap(g => g.tools);
    const master = document.createElement("div");
    master.className = "cap-master";
    const mText = document.createElement("div");
    const mTitle = document.createElement("div");
    mTitle.className = "cap-master-title";
    mTitle.innerText = "All permissions";
    const mNote = document.createElement("div");
    mNote.className = "cap-master-note";
    mNote.innerText = `${allTools.length} tools across ${snap.toolGroups.length} capabilities. ` +
        "Tools with a fixed floor keep it — nothing here can lower one.";
    mText.appendChild(mTitle); mText.appendChild(mNote);
    master.appendChild(mText);
    master.appendChild(bulkDial("Set all", allTools, () => openCapabilities()));
    tools.appendChild(master);

    for (const g of snap.toolGroups) {
        const h = document.createElement("div");
        h.className = "cap-group";
        const hLabel = document.createElement("span");
        hLabel.innerText = g.label;
        h.appendChild(hLabel);
        // GROUP DIAL — set every tool in this capability at once.
        h.appendChild(bulkDial(`Set all ${g.tools.length}`, g.tools, () => openCapabilities()));
        tools.appendChild(h);
        const list = document.createElement("div");
        list.className = "cap-tool-list";
        for (const tool of g.tools) {
            const el = document.createElement("div");
            el.className = "cap-tool" + (tool.available ? "" : " off");
            const n = document.createElement("code");
            n.innerText = tool.name;
            el.appendChild(n);

            // THE DIAL. Every tool's behaviour is a selector, not a label:
            // pick a level and it takes effect immediately, kernel-clamped to
            // the tool's floor (the selector only offers legal levels).
            const sel = document.createElement("select");
            sel.className = "cap-level " + tool.tone;
            for (const opt of tool.options) {
                const o = document.createElement("option");
                o.value = opt.value;
                o.innerText = opt.label + (opt.value === tool.defaultLevel ? " (default)" : "");
                if (opt.value === tool.level) o.selected = true;
                sel.appendChild(o);
            }
            if (tool.options.length === 2 && tool.floor === "confirm") {
                sel.title = "this tool can never run without asking — that floor is fixed";
            }
            sel.addEventListener("change", async () => {
                sel.disabled = true;
                const chosen = sel.value;
                // choosing the default clears the override rather than pinning it
                const level = chosen === tool.defaultLevel ? "default" : chosen;
                let ok = false;
                try {
                    // PER-SESSION, never global — the setting applies to THIS
                    // conversation, matching Session › Permissions. (Was a global
                    // setToolPolicy: the consolidation stray this removes.)
                    const r = active
                        ? await window.lcl.setSessionToolPolicy(active.id, tool.name, level)
                        : { ok: false, error: "open a conversation to change this" };
                    ok = !!(r && r.ok);
                    if (!ok && r && r.error) sel.title = r.error;
                } catch { /* stays not-ok */ }
                // confirmation of the click: flash saved / revert on failure
                sel.classList.add(ok ? "saved" : "save-failed");
                if (!ok) sel.value = tool.level;
                setTimeout(() => {
                    sel.classList.remove("saved", "save-failed");
                    sel.disabled = false;
                }, 900);
                // tone tracks the new level so the row reads truthfully
                sel.className = "cap-level " +
                    ((sel.value === "allow" || sel.value === "notify") ? "auto"
                        : sel.value === "deny" ? "deny" : "ask") +
                    (sel.classList.contains("saved") ? " saved" : "");
            });
            el.appendChild(sel);
            if (!tool.available) el.title = "not available in this session";
            list.appendChild(el);
        }
        tools.appendChild(list);
    }
}
/**
 * A dial that sets many tools at once.
 *
 * The levels offered are the union of what the tools in the set actually
 * support, so the control never offers something no tool can be. Applying walks
 * the set and calls setToolPolicy per tool — the same path the per-tool dial
 * takes, which means the policy kernel clamps each one to its own floor. A tool
 * that cannot go below "ask" stays on "ask" and is counted, not silently
 * skipped and not silently forced.
 */
function bulkDial(label, toolSet, onDone) {
    const sel = document.createElement("select");
    sel.className = "cap-level cap-bulk";

    const head = document.createElement("option");
    head.value = "";
    head.innerText = label + "…";
    sel.appendChild(head);

    // union of supported levels, in the order the tools themselves list them
    const seen = new Map();
    for (const t of toolSet) {
        for (const o of t.options || []) if (!seen.has(o.value)) seen.set(o.value, o.label);
    }
    for (const [value, text] of seen) {
        const o = document.createElement("option");
        o.value = value;
        o.innerText = text;
        sel.appendChild(o);
    }
    const reset = document.createElement("option");
    reset.value = "__default";
    reset.innerText = "back to defaults";
    sel.appendChild(reset);

    sel.addEventListener("change", async () => {
        const want = sel.value;
        if (!want) return;
        sel.disabled = true;

        const targets = want === "__default"
            ? toolSet
            : toolSet.filter(t => (t.options || []).some(o => o.value === want));
        const skipped = toolSet.length - targets.length;

        let applied = 0, clamped = 0, failed = 0;
        for (const t of targets) {
            const level = want === "__default"
                ? "default"
                : (want === t.defaultLevel ? "default" : want);
            try {
                // PER-SESSION group/master toggle — writes THIS conversation's
                // policy, not a global one (the consolidation is per-conversation).
                const r = active
                    ? await window.lcl.setSessionToolPolicy(active.id, t.name, level)
                    : { ok: false, error: "no conversation open" };
                if (r && r.ok) applied++;
                // The kernel REFUSES rather than quietly clamping — it returns
                // { error, floor } when the requested level is looser than the
                // tool's fixed floor. That is the tool holding its ground, not
                // a failure, and it is the difference between "3 refused" and
                // "3 held at their floor" in the summary below. Checked against
                // lcl:setToolPolicy in main.js rather than assumed.
                else if (r && r.floor) clamped++;
                else failed++;
            } catch { failed++; }
        }

        sel.classList.add(failed ? "save-failed" : "saved");
        setTimeout(() => { sel.classList.remove("saved", "save-failed"); }, 900);
        sel.value = "";
        sel.disabled = false;

        const parts = [`${applied} set`];
        if (clamped) parts.push(`${clamped} held at their floor`);
        if (skipped) parts.push(`${skipped} do not offer that level`);
        if (failed) parts.push(`${failed} refused`);
        sel.title = parts.join(" · ");
        if (onDone) onDone();
    });

    return sel;
}

function closeCapabilities() { $("cap-scrim").classList.add("hidden"); }

$("cap-close").addEventListener("click", closeCapabilities);
$("cap-scrim").addEventListener("click", (e) => {
    if (e.target === $("cap-scrim")) closeCapabilities();
});

// =============================================================
// KNOWLEDGE — ONE UI, CONTRACT K6
// -------------------------------------------------------------
// The requirement: one knowledge UI, not two — showing the knowledge that
// ships with .lcl with real PDF views, while the extracted text stays hidden
// and is used only for searching.
//
// There were two surfaces. One ("Read the knowledge…") listed the shipped
// corpus and, in an installed build where the PDFs were never downloaded, had
// nothing to show but the extraction. The other ("Knowledge libraries…")
// listed only folders the operator had added, and its View button said "not on
// disk". Two dropdown items, two half-answers, one shelf underneath.
//
// This is the one surface. Every library — shipped and added — is in ONE list,
// labelled by which it is. A document opens as ITSELF: a PDF goes to Chromium's
// own PDF viewer, markdown renders, an image draws. A source that was never
// installed says exactly that, names the URL it would come from, and offers the
// download; it never says "not on disk" and stops.
//
// EXTRACTED TEXT IS NOT A DOCUMENT. That is enforced in knowledge.js — the
// inventory is built from each document's SOURCE path and openKnowledgeDoc
// refuses any id resolving inside knowledge/text/ — and this UI never asks for
// one. What the extraction earns is a READOUT: a document says it is searchable,
// so a corpus with no PDFs on disk reads as "indexed, sources not installed"
// rather than as broken.
// =============================================================

/** The document open in the reading pane, so a refresh can restore it. */
let kbOpenDocId = null;

async function openKnowledge() {
    $("knowledge-scrim").classList.remove("hidden");
    await refreshKnowledge();
}
function closeKnowledge() {
    $("knowledge-scrim").classList.add("hidden");
}

/**
 * THE INVENTORY, from the contract when it is there and from the old calls
 * when it is not.
 *
 * K6 is `window.lcl.knowledgeLibraries()`. main.js exposes it; a build where it
 * has not landed yet still has listLibraries() and knowledgeShelf(), and a
 * knowledge panel that renders nothing because a bridge method is missing is
 * exactly the class of failure this pass exists to stop. So: try the contract,
 * fall back, and record WHICH answered so the panel can say so rather than
 * quietly showing less.
 */
async function loadKnowledgeInventory() {
    if (typeof window.lcl.knowledgeLibraries === "function") {
        let res = null;
        try { res = await window.lcl.knowledgeLibraries(); } catch { res = null; }
        const libs = Array.isArray(res) ? res
            : (res && Array.isArray(res.libraries)) ? res.libraries : null;
        if (libs) return { libs: libs.map(normaliseLibrary), api: "k6" };
    }
    return await legacyKnowledgeInventory();
}

/** One library shape, whatever answered. */
function normaliseLibrary(lib) {
    const l = lib || {};
    const docs = (Array.isArray(l.docs) ? l.docs : []).map(d => ({
        id: d.id || `${l.id}::${d.file || d.title || ""}`,
        libraryId: d.libraryId || l.id,
        title: d.title || d.file || "untitled",
        file: d.file || "",
        ext: d.ext || "",
        pages: d.pages || null,
        bytes: d.bytes || 0,
        sourceOnDisk: d.sourceOnDisk !== false,
        sourceUrl: d.sourceUrl || null,
        sourceUrlKnown: d.sourceUrlKnown !== undefined ? !!d.sourceUrlKnown : !!d.sourceUrl,
        searchBacked: !!d.searchBacked,
        subject: d.subject || null,
        addedByUser: d.addedByUser !== undefined ? !!d.addedByUser : !!l.addedByUser
    }));
    // docCount is the EXACT number even when the array is capped; a library
    // that reports 2,000 documents and lists 2,000 of 4,000 must not read as
    // if the other half does not exist.
    const docCount = Number.isFinite(l.docCount) ? l.docCount : docs.length;
    return {
        id: l.id, title: l.title || l.name || l.id || "library",
        addedByUser: !!l.addedByUser,
        builtin: l.builtin !== undefined ? !!l.builtin : !l.addedByUser,
        sourceOnDisk: !!l.sourceOnDisk,
        sourceUrl: l.sourceUrl || null,
        root: l.root || null,
        missing: !!l.missing,
        docs, docCount,
        docsTruncated: !!l.docsTruncated,
        sourcesPresent: Number.isFinite(l.sourcesPresent)
            ? l.sourcesPresent : docs.filter(d => d.sourceOnDisk).length,
        sourcesMissing: Number.isFinite(l.sourcesMissing)
            ? l.sourcesMissing : docs.filter(d => !d.sourceOnDisk).length,
        searchBackedDocs: Number.isFinite(l.searchBackedDocs)
            ? l.searchBackedDocs : docs.filter(d => d.searchBacked).length,
        extractedTextFiles: l.extractedTextFiles || 0,
        manifest: l.manifest || null,
        // carried through from the old library manager so its readouts survive
        files: l.files, chunks: l.chunks, emptied: !!l.emptied
    };
}

/**
 * The same list, assembled from the two calls that existed before K6.
 * knowledgeShelf() knows the shipped corpus AND the added folders' documents;
 * listLibraries() knows the index statistics and is the only thing that can
 * rescan or remove one. Merged by library id so the panel is one list either
 * way, and no readout from either half is lost.
 */
async function legacyKnowledgeInventory() {
    let shelf = null, mgr = null;
    try { shelf = await window.lcl.knowledgeShelf(); } catch { /* below */ }
    try { mgr = await window.lcl.listLibraries(); } catch { /* below */ }
    const stats = new Map();
    for (const l of (mgr && mgr.libraries) || []) stats.set(String(l.id), l);

    const byId = new Map();
    for (const sub of (shelf && shelf.subjects) || []) {
        const added = sub.layer === "added";
        const id = added ? String(sub.libraryId) : "builtin-knowledge";
        if (!byId.has(id)) {
            byId.set(id, normaliseLibrary({
                id, name: added ? sub.name : "Ships with .lcl",
                addedByUser: added, builtin: !added, docs: []
            }));
        }
        const lib = byId.get(id);
        for (const d of sub.docs || []) {
            // A built-in doc's real source is the PDF beside the extraction.
            // `file` on a built-in shelf record is the .txt, which is the one
            // thing this UI must never open, so the source path is used and
            // the record is marked not-installed when there is none.
            const rel = added ? d.file : (d.source || "");
            lib.docs.push({
                id: `${id}::${rel}`, libraryId: id,
                title: d.title || rel, file: rel,
                ext: (rel.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase(),
                pages: d.pages || null, bytes: d.bytes || 0,
                // legacy has no truth about this for the built-in corpus; the
                // open attempt is what settles it, and it says so when it does
                sourceOnDisk: added ? true : !!rel,
                sourceUrl: null, sourceUrlKnown: false,
                searchBacked: !added ? true : false,
                subject: added ? null : sub.name, addedByUser: added
            });
        }
    }
    // libraries the shelf did not reach (empty folder, or missing on disk)
    for (const l of (mgr && mgr.libraries) || []) {
        const id = String(l.id);
        if (!byId.has(id)) {
            byId.set(id, normaliseLibrary({
                id, name: l.name, addedByUser: !l.builtin, builtin: !!l.builtin, docs: []
            }));
        }
    }
    const libs = [...byId.values()].map(lib => {
        const s = stats.get(String(lib.id));
        if (s) {
            lib.root = s.root || lib.root;
            lib.files = s.files; lib.chunks = s.chunks;
            lib.missing = !!s.missing; lib.emptied = !!s.emptied;
            if (s.name) lib.title = s.name;
        }
        lib.docCount = lib.docs.length;
        lib.sourcesPresent = lib.docs.filter(d => d.sourceOnDisk).length;
        lib.sourcesMissing = lib.docCount - lib.sourcesPresent;
        lib.searchBackedDocs = lib.docs.filter(d => d.searchBacked).length;
        return lib;
    });
    // shipped first, then the user's own — the two layers stay legible
    libs.sort((a, b) => (a.addedByUser ? 1 : 0) - (b.addedByUser ? 1 : 0));
    return { libs, api: "legacy" };
}

/**
 * THE BADGE ON THE MENU. "a badge that appears in the knowledge dropdown,
 * prefixing the Knowledge button ... when there is knowledge in the source
 * list, that is not downloaded to the machine." The count is the FETCHABLE
 * number — missing sources with a recorded URL, exactly what Download-all
 * will act on — so the badge never promises what no button can deliver.
 * Painted at boot from the cheap count, and again from every inventory
 * refresh and finished batch.
 */
function kbPaintBadge(fetchable) {
    const b = $("kb-badge");
    if (!b) return;
    const n = Number(fetchable) || 0;
    b.innerText = n > 99 ? "99+" : String(n);
    b.title = n
        ? n + " shipped source" + (n === 1 ? "" : "s") +
          " not downloaded to this machine yet"
        : "";
    b.classList.toggle("hidden", n <= 0);
}
async function kbBadgeFromBoot() {
    if (typeof window.lcl.knowledgeMissingCount !== "function") return;
    try {
        const r = await window.lcl.knowledgeMissingCount();
        if (r && !r.error) kbPaintBadge(r.fetchable);
    } catch { /* the badge just stays hidden */ }
}

// the last Download-all outcome, keyed by library — refreshKnowledge rebuilds
// the panel, so a note appended to the old DOM would die instantly; the render
// re-attaches this instead
let kbFetchAllNote = null;
// THE RUNNING BATCH IS OWNED HERE, NOT BY A BUTTON. The first cut kept the
// download loop in the button's own click closure — and clicking outside the
// panel closed it and took the run down with it, stranding a half-fetched
// shelf. The module owns the run now: closing the panel changes what is
// painted, never what is happening, and a re-render re-attaches to the live
// run. The operator's rule: "the download should run until all the files are
// added."
let kbBatch = null;
function kbBatchPaint() {
    if (!kbBatch || kbBatch.finished) return;
    const btn = document.querySelector(".kb-fetch-all");
    if (btn) {
        btn.disabled = true;
        btn.innerText = "Downloading " + kbBatch.n + "/" + kbBatch.total +
            " — " + kbBatch.current + "…";
    }
}
async function kbStartBatch(lib) {
    if (kbBatch && !kbBatch.finished) return;      // one run at a time
    const fn = window.lcl.fetchKnowledgeSource || window.lcl.fetchKnowledgeDoc;
    if (typeof fn !== "function") return;
    const want = lib.docs.filter(x => !x.sourceOnDisk && !x.extracted && x.sourceUrl);
    if (!want.length) return;
    kbBatch = { libId: lib.id, total: want.length, n: 0, current: "", finished: false };
    let done = 0; const failed = []; let netOff = false;
    for (const doc of want) {
        kbBatch.n = done + failed.length + 1;
        kbBatch.current = String(doc.title || doc.file).slice(0, 36);
        kbBatchPaint();
        const r = await fn(doc.id, { approved: true })
            .catch(e => ({ ok: false, error: String((e && e.message) || e) }));
        if (r && r.ok) { done++; continue; }
        if (r && r.blocked === "network") { netOff = true; break; }
        failed.push({ title: String(doc.title || doc.file),
                      error: (r && (r.error || r.reason)) || "failed" });
    }
    kbBatch = null;
    kbFetchAllNote = {
        libId: lib.id,
        stale: !!(failed.length || netOff),
        text: netOff
            ? done + " downloaded, then stopped — internet access is off. Turn it on and click again."
            : failed.length
                ? done + " downloaded · " + failed.length + " failed: " +
                  failed.slice(0, 4).map(f => f.title + " (" + f.error + ")").join(" · ") +
                  (failed.length > 4 ? " · and " + (failed.length - 4) + " more — see data/logs/errors.jsonl" : "")
                : done + " downloaded — every source in this library is on disk."
    };
    await refreshKnowledge();
}
async function refreshKnowledge() {
    const list = $("kb-list");
    $("kb-error").classList.add("hidden");
    list.innerHTML = "";
    // SAY IT IS WORKING. The wipe above used to be followed by a silent await
    // on the whole inventory — the panel frame appeared instantly and then
    // sat BLANK for the entire walk, which reads as "takes really long to
    // open". The wait is the same; now it is a wait with a face.
    list.appendChild(loadingNote("reading the shelf…", "kb-empty"));

    const inv = await loadKnowledgeInventory();
    const libs = inv.libs || [];
    list.innerHTML = "";
    // the panel now knows the truth the badge estimates — repaint it in
    // passing, and every finished batch lands here too via its own refresh
    kbPaintBadge(libs.filter(l => !l.addedByUser)
        .reduce((a, l) => a + l.docs.filter(
            d => !d.sourceOnDisk && d.sourceUrl).length, 0));

    if (!libs.length) {
        const empty = document.createElement("div");
        empty.className = "kb-empty";
        empty.innerText = "No libraries yet — add a folder of reference material below.";
        list.appendChild(empty);
    }

    for (const lib of libs) list.appendChild(buildLibraryGroup(lib));

    applyKnowledgeFilter();
    await refreshResearch(libs);
}

/** One library and its documents, as one collapsible group in the one list. */
function buildLibraryGroup(lib) {
    const group = document.createElement("div");
    group.className = "kb-group";
    group.dataset.libraryId = String(lib.id);

    const head = document.createElement("div");
    head.className = "kb-group-head";

    const toggle = document.createElement("button");
    toggle.className = "kb-group-toggle";
    toggle.setAttribute("aria-expanded", "false");

    const caret = document.createElement("span");
    caret.className = "kb-caret";
    caret.innerText = "›";
    toggle.appendChild(caret);

    const name = document.createElement("span");
    name.className = "kb-group-name";
    name.innerText = lib.title;
    toggle.appendChild(name);

    // WHICH LAYER THIS IS. The standing rule: reference material
    // that ships is never confused with material the user added. One list, two
    // labels — not two panels.
    const tag = document.createElement("span");
    tag.className = "kb-tag " + (lib.addedByUser ? "added" : "shipped");
    tag.innerText = lib.addedByUser ? "added by you" : "ships with .lcl";
    toggle.appendChild(tag);
    head.appendChild(toggle);

    const meta = document.createElement("div");
    meta.className = "kb-group-meta";
    const bits = [`${lib.docCount} document${lib.docCount === 1 ? "" : "s"}`];
    if (lib.sourcesMissing) bits.push(`${lib.sourcesPresent} of ${lib.docCount} installed`);
    if (lib.searchBackedDocs) bits.push(`${lib.searchBackedDocs} searchable`);
    if (Number.isFinite(lib.chunks) && lib.chunks) bits.push(`${lib.chunks} passages`);
    if (lib.extractedTextFiles) {
        // Counted, never listed. A folder holding 62 extraction files and no
        // sources looked empty, which reads as "the corpus is gone".
        bits.push(`${lib.extractedTextFiles} extraction file` +
            `${lib.extractedTextFiles === 1 ? "" : "s"} (search only)`);
    }
    if (lib.missing) bits.push("folder missing");
    else if (lib.emptied) bits.push("folder is empty");
    if (lib.root) bits.push(lib.root);
    meta.innerText = bits.join(" · ");
    if (lib.missing || lib.emptied) meta.classList.add("stale");
    head.appendChild(meta);

    /* WHY THE NUMBERS ARE STILL THERE WHEN THE FOLDER IS NOT.
     *
     * `emptied` is the case that actually happened: the folder still resolves,
     * every document inside it was deleted, and the index remembers all of
     * them. So the row above goes on reporting passages and searchable
     * documents — which is TRUE of the index and false of the disk, and
     * "12 documents · 412 passages · folder is empty" read on its own is a
     * contradiction the operator has to guess his way out of.
     *
     * The counts are not removed. Deleting a readout to resolve a contradiction
     * loses the one fact that says a reindex will cost you the library. It is
     * explained instead, and the explanation names the fix. */
    if (lib.emptied || lib.missing) {
        const why = document.createElement("div");
        why.className = "kb-group-note stale";
        why.innerText = lib.missing
            ? "The folder this library points at is gone. The counts above are " +
              "from documents that are gone: they are what the index still " +
              "remembers, not what is on disk. Search answers from them until " +
              "this is rescanned, and rescanning will empty it."
            : "The folder is still there and every document in it is not. The " +
              "counts above are from documents that are gone: they are what the " +
              "index still remembers, not what is on disk. Rescanning will " +
              "empty this library.";
        head.appendChild(why);
    }

    if (lib.manifest && lib.manifest.note) {
        const mn = document.createElement("div");
        mn.className = "kb-group-note";
        mn.innerText = lib.manifest.note;
        head.appendChild(mn);
    }
    if (kbFetchAllNote && kbFetchAllNote.libId === lib.id) {
        const bn = document.createElement("div");
        bn.className = "kb-group-note kb-fetch-all-note" + (kbFetchAllNote.stale ? " stale" : "");
        bn.innerText = kbFetchAllNote.text;
        head.appendChild(bn);
    }

    // MANAGEMENT, kept exactly where it was in capability terms: a folder the
    // operator added can be rescanned and removed; the shipped corpus cannot,
    // because it is not theirs to delete.
    const actions = document.createElement("div");
    actions.className = "kb-actions";
    if (lib.addedByUser) {
        const rescan = document.createElement("button");
        rescan.className = "ghost small";
        rescan.innerText = "Rescan";
        rescan.title = "Look for new, changed or deleted files and update the index";
        rescan.disabled = !!lib.missing;
        rescan.addEventListener("click", async () => {
            rescan.disabled = true;
            const was = rescan.innerText;
            rescan.innerText = "Scanning…";
            try {
                const r = await window.lcl.reindexLibrary(active && active.id, lib.id);
                rescan.innerText = (r && r.error) ? "Failed" : "Started";
            } catch { rescan.innerText = "Failed"; }
            setTimeout(() => { rescan.innerText = was; rescan.disabled = false; }, 2000);
            setTimeout(refreshKnowledge, 1500);   // stats grow as it indexes
        });
        actions.appendChild(rescan);

        const remove = document.createElement("button");
        remove.className = "ghost small icon-act icon-only danger-text";
        remove.appendChild(ICONS.trash());
        remove.title = "Forget this folder and delete its index";
        remove.setAttribute("aria-label", remove.title);
        remove.addEventListener("click", async () => {
            const sure = await modal({
                title: "Remove " + (lib.title || "this library") + "?",
                message: "Its index is deleted. The folder on disk is untouched.",
                confirmLabel: "Remove", danger: true });
            if (!sure) return;
            remove.disabled = true;
            remove.innerText = "Removing…";
            await window.lcl.removeLibrary(active && active.id, lib.id);
            // the chip counts active.knowledgeIds RAW, so a removed library kept
            // being counted (and the book stayed lit) until the link dialog was
            // reopened and saved. Scrub the dead id from this session and repaint.
            if (active && Array.isArray(active.knowledgeIds)) {
                active.knowledgeIds = active.knowledgeIds.filter(x => x !== lib.id);
            }
            renderKnowledgeChip();
            await refreshKnowledge();
        });
        actions.appendChild(remove);
    }
    if (!lib.addedByUser && lib.sourcesMissing > 0) {
        // DOWNLOAD ALL — the operator's ask, verbatim: "the knowledge should
        // download with one button to download all, not just one of the
        // knowledge sources." The button only STARTS the module-owned batch
        // (kbStartBatch) — see the runner above for why ownership matters.
        //
        // THE COUNT IS THE FETCHABLE COUNT. The label used to say
        // sourcesMissing (every absent doc) while the batch only ever
        // attempted the absent-WITH-URL ones — with sources.json missing the
        // button could promise (62) and the batch attempt zero. The number on
        // the button is now the number of downloads the click will start, the
        // badge shows the same number, and a fresh patch that records new
        // URLs re-arms a button that had gone quiet.
        const fetchable = lib.docs.filter(d => !d.sourceOnDisk && d.sourceUrl).length;
        const all = document.createElement("button");
        all.className = "primary small kb-fetch-all";
        const live = kbBatch && kbBatch.libId === lib.id && !kbBatch.finished;
        all.innerText = live
            ? "Downloading " + kbBatch.n + "/" + kbBatch.total + " — " + kbBatch.current + "…"
            : "Download all (" + fetchable + ")";
        all.disabled = !!live || (!live && fetchable === 0);
        all.title = fetchable || live
            ? "Fetch every missing source document for this library"
            : lib.sourcesMissing + " missing, but no download URLs are " +
              "recorded for them — a patch that records the URLs re-enables this";
        all.addEventListener("click", () => { kbStartBatch(lib); });
        actions.appendChild(all);
    }
    if (lib.root) {
        const show = document.createElement("button");
        show.className = "ghost small";
        show.innerText = "Folder";
        show.title = "Show this library's folder on disk";
        show.addEventListener("click", () => window.lcl.revealFolder(lib.root));
        actions.appendChild(show);
    }
    if (actions.children.length) head.appendChild(actions);
    group.appendChild(head);

    const docs = document.createElement("div");
    docs.className = "kb-docs";
    for (const d of lib.docs) docs.appendChild(buildDocRow(d, lib));
    if (lib.docsTruncated) {
        const more = document.createElement("div");
        more.className = "kb-empty";
        more.innerText = `showing ${lib.docs.length} of ${lib.docCount} documents`;
        docs.appendChild(more);
    }
    if (!lib.docs.length) {
        const none = document.createElement("div");
        none.className = "kb-empty";
        none.innerText = lib.missing
            ? "the folder this library points at is not there any more"
            : "no readable documents in this library";
        docs.appendChild(none);
    }
    group.appendChild(docs);

    toggle.addEventListener("click", () => {
        const open = group.classList.toggle("open");
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });

    /* THE SHIPPED SHELF IS THE FOCAL POINT, so it is open when the panel opens.
     *
     * "its just not being made the focal point" — every group started collapsed,
     * so the sixty-odd documents that come WITH the product were behind a
     * disclosure triangle, and the only thing with any visual weight was a
     * button that leaves for a folder picker. The library that ships is the
     * thing to look at first; a library the user added is their own and they
     * know what is in it. */
    if (!lib.addedByUser && lib.docs.length) {
        group.classList.add("open");
        toggle.setAttribute("aria-expanded", "true");
    }
    return group;
}

/** One document. A button, because it opens; never a dead row of text. */
function buildDocRow(doc, lib) {
    const row = document.createElement("button");
    row.className = "kb-doc" + (doc.sourceOnDisk ? "" : " absent");
    row.dataset.docId = String(doc.id);
    if (String(doc.id) === String(kbOpenDocId)) row.classList.add("on");

    const t = document.createElement("span");
    t.className = "kb-doc-title";
    t.innerText = doc.title;
    row.appendChild(t);

    const s = document.createElement("span");
    s.className = "kb-doc-state";
    // The row states the TWO independent facts, because they come apart: the
    // source may be absent while the text still backs search. "not on disk"
    // alone was the whole of the old defect.
    s.innerText = doc.sourceOnDisk
        ? [(doc.ext || "").replace(".", "").toUpperCase() || "file",
           doc.pages ? doc.pages + " pages" : null].filter(Boolean).join(" · ")
        : (doc.searchBacked ? "not installed · searchable" : "not installed");
    row.appendChild(s);

    row.title = doc.title + (doc.file ? "  —  " + doc.file : "");
    row.addEventListener("click", () => {
        for (const b of $("kb-list").querySelectorAll(".kb-doc.on")) b.classList.remove("on");
        row.classList.add("on");
        kbOpenDocId = doc.id;
        openKnowledgeDoc(doc, lib);
    });
    return row;
}

/** Filter the ONE list: documents by name, groups by whether any survived. */
function applyKnowledgeFilter() {
    const q = ($("kb-filter").value || "").trim().toLowerCase();
    for (const group of $("kb-list").querySelectorAll(".kb-group")) {
        let any = false;
        for (const d of group.querySelectorAll(".kb-doc")) {
            const hit = !q || d.innerText.toLowerCase().includes(q);
            d.classList.toggle("hidden", !hit);
            if (hit) any = true;
        }
        group.classList.toggle("hidden", !!q && !any);
        // a search that matches inside a collapsed library must show it
        if (q && any) group.classList.add("open");
    }
}

/**
 * OPEN A DOCUMENT — as itself.
 *
 * CONTRACT K6: window.lcl.openKnowledgeDoc(id) opens the real PDF, or returns
 * { ok:false, needsFetch:true, sourceUrl } when the source was never
 * downloaded. Both answers are drawn here; neither is ever "not on disk".
 */
async function openKnowledgeDoc(doc, lib) {
    const view = $("kb-view");
    view.innerHTML = '<div class="kb-empty">opening…</div>';

    let res = null;
    if (typeof window.lcl.openKnowledgeDoc === "function") {
        res = await window.lcl.openKnowledgeDoc(doc.id).catch(() => null);
    }
    // THE CONTRACT'S ANSWER IS FINAL WHEN THERE IS ONE.
    //
    // The legacy call below is a FALLBACK FOR A BUILD THAT HAS NO K6, never a
    // second opinion on a K6 refusal. openKnowledgeDoc is the layer that says
    // "that is extracted text, not a document" — asking a different bridge the
    // same question afterwards is how a guard gets walked around, and it is the
    // exact shape of the failure that put this list together.
    if (res === null) {
        const legacy = await window.lcl.viewKnowledgeFile(doc.libraryId, doc.file)
            .catch(e => ({ error: String((e && e.message) || e) }));
        if (legacy && !legacy.error) return paintKnowledgeDoc(legacy, doc);
        // A missing file is not an error message, it is a state with an action:
        // the source was never installed. Say that, and offer the download.
        if (legacy && /not on disk|does not exist|no such/i.test(String(legacy.error))) {
            return paintNeedsFetch({
                needsFetch: true, id: doc.id, title: doc.title,
                sourceUrl: doc.sourceUrl,
                reason: doc.sourceUrl
                    ? "the source document is not installed — it can be downloaded"
                    : "the source document is not installed, and no download URL " +
                      "is recorded for it",
                searchBacked: doc.searchBacked, pages: doc.pages
            }, doc, lib);
        }
        if (!res || res.error === undefined) {
            res = { ok: false, error: (legacy && legacy.error) || "could not open that document" };
        }
    }

    if (res.ok) {
        // main may hand back a viewable payload (fileUrl / content) or just
        // the path it opened. Prefer painting it here; fall back to the legacy
        // viewer call; and if neither can draw it, SAY where it is rather than
        // leaving a blank pane that looks like a failure.
        if (res.fileUrl || res.dataUri || res.content) return paintKnowledgeDoc(res, doc);
        const v = await window.lcl.viewKnowledgeFile(doc.libraryId, doc.file)
            .catch(() => null);
        if (v && !v.error) return paintKnowledgeDoc(v, doc);
        view.innerHTML = "";
        const ok = document.createElement("div");
        ok.className = "kb-empty";
        ok.innerText = "Opened " + (res.path || doc.title) + " outside the panel.";
        view.appendChild(ok);
        return;
    }
    if (res.extracted) return paintExtractedRefusal(res, doc);
    if (res.needsFetch) return paintNeedsFetch(res, doc, lib);

    view.innerHTML = "";
    const e = document.createElement("div");
    e.className = "kb-empty";
    e.innerText = res.error || "could not open that document";
    view.appendChild(e);
}

/** Draw a viewer payload — the SAME renderer the workspace viewer uses. */
function paintKnowledgeDoc(res, doc) {
    const view = $("kb-view");
    view.innerHTML = "";

    const bar = document.createElement("div");
    bar.className = "kb-view-bar";
    const t = document.createElement("span");
    t.className = "kb-view-title";
    t.innerText = doc.title;
    bar.appendChild(t);
    if (res.path || res.file) {
        const open = document.createElement("button");
        open.className = "ghost small";
        open.innerText = "Show on disk";
        open.addEventListener("click", () => window.lcl.revealFolder(res.path || res.file));
        bar.appendChild(open);
    }
    view.appendChild(bar);

    if (res.kind === "pdf" || /\.pdf$/i.test(res.name || doc.file || "")) {
        // THE ACTUAL DOCUMENT, in Chromium's own PDF viewer — toolbar,
        // thumbnails, zoom, find. Never an extraction of it.
        const fr = document.createElement("iframe");
        fr.className = "kdoc-pdf kb-pdf";
        fr.src = res.fileUrl;
        view.appendChild(fr);
    } else if (res.kind === "image") {
        const img = document.createElement("img");
        img.className = "viewer-image";
        img.src = res.dataUri;
        view.appendChild(img);
    } else if (res.kind === "binary") {
        const e = document.createElement("div");
        e.className = "kb-empty";
        e.innerText = `${res.name} — ${Math.round((res.size || 0) / 1024)} KB, ` +
            "a binary format this viewer cannot draw.";
        view.appendChild(e);
    } else if (/\.(md|markdown)$/i.test(res.name || doc.file || "")) {
        const md = document.createElement("div");
        md.className = "kb-page";
        md.appendChild(renderMarkdown(res.content));
        view.appendChild(md);
    } else if (/\.(html?|xhtml)$/i.test(res.name || doc.file || "")) {
        /* AN HTML DOCUMENT IS A PAGE, NOT SOURCE CODE. There was no branch for
         * it at all, so every .html in a library rendered as syntax-highlighted
         * markup — the tags, not the document. It is drawn in a sandboxed frame
         * with NO scripts and no network: allow-same-origin is deliberately
         * absent, so the page cannot call out, and this app's offline promise
         * holds while the document still lays out as its author wrote it.
         *
         * A toggle switches to the source, because for a reference document
         * both views are legitimately useful. */
        const wrap = document.createElement("div");
        wrap.className = "kb-html-wrap";

        const toggle = document.createElement("button");
        toggle.className = "ghost small kb-html-toggle";
        toggle.innerText = "View source";
        bar.appendChild(toggle);

        const fr = document.createElement("iframe");
        fr.className = "kb-html";
        fr.setAttribute("sandbox", "");           // no scripts, no same-origin, no forms
        fr.srcdoc = String(res.content || "");
        wrap.appendChild(fr);

        const src = document.createElement("div");
        src.className = "kb-page hidden";
        src.appendChild(window.lclSyntax.codeBlock(res.content || "", "html"));
        wrap.appendChild(src);

        let showingSource = false;
        toggle.addEventListener("click", () => {
            showingSource = !showingSource;
            fr.classList.toggle("hidden", showingSource);
            src.classList.toggle("hidden", !showingSource);
            toggle.innerText = showingSource ? "View page" : "View source";
        });

        view.appendChild(wrap);
    } else {
        const pre = document.createElement("div");
        pre.className = "kb-page";
        // res.ext carries the dot (".py"); the highlighter wants the bare
        // language, as the workspace viewer does.
        pre.appendChild(window.lclSyntax.codeBlock(res.content || "",
            res.ext ? String(res.ext).slice(1) : ""));
        view.appendChild(pre);
    }
    if (res.truncated) {
        const tr = document.createElement("div");
        tr.className = "kb-empty";
        tr.innerText = "shown in part — the file is larger than the viewer's limit";
        view.appendChild(tr);
    }
    view.scrollTop = 0;
}

/**
 * THE SOURCE WAS NEVER DOWNLOADED — said plainly, with the action attached.
 *
 * "View says 'not on disk'." That sentence is true and useless: it does not say
 * why, whether it ever was, whether search still works, or what to do. This
 * does all four.
 */
function paintNeedsFetch(res, doc, lib) {
    const view = $("kb-view");
    view.innerHTML = "";

    const card = document.createElement("div");
    card.className = "kb-fetch";

    const h = document.createElement("div");
    h.className = "kb-fetch-title";
    h.innerText = doc.title;
    card.appendChild(h);

    const why = document.createElement("div");
    why.className = "kb-fetch-why";
    why.innerText = res.reason ||
        "the source document is not installed on this computer";
    card.appendChild(why);

    // What still WORKS. Without this the panel reads as a dead corpus.
    const still = document.createElement("div");
    still.className = "kb-fetch-still";
    still.innerText = res.searchBacked || doc.searchBacked
        ? "It is still indexed: this document is searched and cited when you ask " +
          "a question. Only the readable original is missing."
        : "This document is not indexed either, so it cannot be searched yet.";
    card.appendChild(still);

    const url = res.sourceUrl || doc.sourceUrl || (lib && lib.sourceUrl) || null;
    if (url) {
        const u = document.createElement("div");
        u.className = "kb-fetch-url";
        u.innerText = url;
        card.appendChild(u);
    }

    const row = document.createElement("div");
    row.className = "kb-fetch-actions";
    const state = document.createElement("span");
    state.className = "kb-fetch-state";

    if (url) {
        const get = document.createElement("button");
        get.className = "primary";
        get.innerText = "Download it";
        get.addEventListener("click", async () => {
            get.disabled = true;
            state.innerText = "downloading…";
            const fn = window.lcl.fetchKnowledgeSource || window.lcl.fetchKnowledgeDoc;
            if (typeof fn !== "function") {
                // Honest about the seam rather than pretending to try: this
                // half of K6 is main.js's to expose.
                state.innerText = "this build cannot download it yet — " +
                    "the source URL above is the document.";
                get.disabled = false;
                return;
            }
            const r = await fn(doc.id, { approved: true })
                .catch(e => ({ ok: false, error: String((e && e.message) || e) }));
            if (r && r.ok) {
                state.innerText = "downloaded.";
                await refreshKnowledge();
                return openKnowledgeDoc(doc, lib);
            }
            // The refusal reports which gate stopped it, so the operator is
            // told what to change instead of being told no.
            state.innerText = r && r.blocked === "network"
                ? "internet access is off — turn it on in Global › Internet access"
                : (r && (r.error || r.reason)) || "the download did not complete";
            get.disabled = false;
        });
        row.appendChild(get);

        const site = document.createElement("button");
        site.className = "ghost small";
        site.innerText = "Open the source page";
        site.addEventListener("click", () => window.lcl.openExternal(url));
        row.appendChild(site);
    }
    row.appendChild(state);
    card.appendChild(row);

    if (res.networkEnabled === false) {
        const net = document.createElement("div");
        net.className = "kb-fetch-net";
        net.innerText = "Internet access is off. Downloading a source turns " +
            "nothing on by itself — the switch is in Global › Internet access.";
        card.appendChild(net);
    }
    view.appendChild(card);
}

/** The one refusal this panel is built to make, said out loud. */
function paintExtractedRefusal(res, doc) {
    const view = $("kb-view");
    view.innerHTML = "";
    const card = document.createElement("div");
    card.className = "kb-fetch";
    const h = document.createElement("div");
    h.className = "kb-fetch-title";
    h.innerText = doc.title;
    card.appendChild(h);
    const why = document.createElement("div");
    why.className = "kb-fetch-why";
    why.innerText = res.error ||
        "that is extracted text, not a document — it backs search and citation only";
    card.appendChild(why);
    view.appendChild(card);
}

/**
 * Folders the agent researched. These close the loop: you ask it to look into
 * something, it searches, reads the sources and writes them out — and then this
 * is where you adopt the result as a searchable library.
 */
async function refreshResearch(libs = []) {
    const block = $("kb-research-block");
    const list = $("kb-research");
    let res = null;
    try { res = await window.lcl.listResearch(); } catch { /* none */ }
    const folders = (res && res.folders) || [];
    if (!folders.length) { block.classList.add("hidden"); return; }
    block.classList.remove("hidden");

    const added = new Set(libs.map(l => String(l.root || "").toLowerCase()));
    list.innerHTML = "";
    for (const f of folders) {
        const row = document.createElement("div");
        row.className = "eng-item";
        const info = document.createElement("div");
        const name = document.createElement("div");
        name.className = "eng-host";
        name.innerText = f.topic;
        const meta = document.createElement("div");
        meta.className = "eng-meta";
        meta.innerText = `${f.documents} document${f.documents === 1 ? "" : "s"}`
            + (f.createdAt ? ` · ${f.createdAt.slice(0, 10)}` : "");
        info.appendChild(name); info.appendChild(meta);

        const actions = document.createElement("div");
        actions.className = "kb-actions";
        const already = added.has(String(f.dir).toLowerCase());
        const add = document.createElement("button");
        add.className = "ghost small";
        add.innerText = already ? "Added" : "Add";
        add.disabled = already;
        add.title = already ? "already a knowledge library" : "index this folder and search it";
        add.addEventListener("click", async () => {
            add.disabled = true;
            add.innerText = "Adding…";
            try {
                const r = await window.lcl.adoptResearch(active && active.id, f.dir);
                add.innerText = (r && r.error) ? "Failed" : "Added";
            } catch { add.innerText = "Failed"; }
            setTimeout(refreshKnowledge, 1200);
        });
        const open = document.createElement("button");
        open.className = "ghost small";
        open.innerText = "Open";
        open.title = "show the folder on disk";
        open.addEventListener("click", () => window.lcl.revealFolder(f.dir));
        actions.appendChild(add); actions.appendChild(open);
        row.appendChild(info); row.appendChild(actions);
        list.appendChild(row);
    }
}

$("knowledge-close").addEventListener("click", closeKnowledge);
$("knowledge-scrim").addEventListener("click", (e) => {
    if (e.target === $("knowledge-scrim")) closeKnowledge();
});
$("kb-filter").addEventListener("input", applyKnowledgeFilter);
$("kb-add").addEventListener("click", async () => {
    const err = $("kb-error");
    err.classList.add("hidden");
    $("kb-add").disabled = true;
    try {
        const res = await window.lcl.addLibrary(active && active.id);
        if (res && res.error) {
            err.innerText = res.error;
            err.classList.remove("hidden");
        }
    } finally {
        $("kb-add").disabled = false;
    }
    await refreshKnowledge();
    setTimeout(refreshKnowledge, 1800);   // reflect the background index build
});

function machineOpen() {
    return !$("machine-scrim").classList.contains("hidden");
}

async function openMachine() {
    $("machine-scrim").classList.remove("hidden");
    await refreshMachine();
}

function closeMachine() {
    $("machine-scrim").classList.add("hidden");
}

async function refreshMachine() {
    const procsEl = $("machine-procs");
    procsEl.innerHTML = "";
    procsEl.appendChild(loadingNote("reading processes…", "machine-note-inline"));

    let stats = null;
    try { stats = await window.lcl.systemStats(); } catch { /* ignore */ }

    if (stats) {
        const physPct = Math.round((stats.physUsedBytes / stats.physTotalBytes) * 100);
        $("g-phys").style.width = physPct + "%";
        $("g-phys").className = "gauge-fill " +
            (stats.availableBytes < 1.0e9 ? "critical" : stats.availableBytes < 2.5e9 ? "low" : "ok");
        $("g-phys-val").innerText =
            `${fmtGB(stats.availableBytes)} available / ${fmtGB(stats.physTotalBytes)}`;

        const commitPct = Math.round(stats.commitRatio * 100);
        $("g-commit").style.width = commitPct + "%";
        $("g-commit").className = "gauge-fill " +
            (commitPct >= 92 ? "critical" : commitPct >= 80 ? "low" : "ok");
        $("g-commit-val").innerText =
            `${fmtGB(stats.commitUsedBytes)} / ${fmtGB(stats.commitLimitBytes)} (${commitPct}%)`;

        // The verdict is the INTERPRETATION only. The number is on the gauge
        // ~20px above it; printing it again as the verdict's opening words was
        // the same figure twice inside one card.
        const verdict = $("machine-verdict");
        verdict.className = stats.level;
        verdict.innerText = stats.availableBytes < 1.0e9
            ? "Windows is paging actively, which is what makes clicking and " +
              "selecting files feel slow."
            : stats.level === "low"
                ? "Getting tight — freeing memory now will keep the desktop responsive."
                : "Healthy.";

        $("engine-state").innerText = stats.engineLoaded
            ? `Model loaded · idle ${Math.round(stats.engineIdleSeconds / 60)}m`
            : "Model unloaded (reloads on next message)";
        $("engine-unload").disabled = !stats.engineLoaded;
    }

    renderComputePanel();

    let res = null;
    try { res = await window.lcl.processList(); } catch { /* ignore */ }
    procsEl.innerHTML = "";

    if (!res || res.error || !res.processes) {
        const err = document.createElement("div");
        err.className = "machine-note-inline";
        err.innerText = (res && res.error) || "could not read process list";
        procsEl.appendChild(err);
        return;
    }

    const max = Math.max(...res.processes.map(p => p.commitBytes), 1);
    for (const p of res.processes.slice(0, 16)) {
        if (p.commitBytes < 40e6) continue;             // ignore noise

        // A row is a button because it does something. It was a div for as long
        // as this panel was read-only, and not being able to close them from
        // here was the entirely reasonable complaint about that.
        const row = document.createElement("button");
        row.className = "proc-row" + (p.mine ? " mine" : "");

        const name = document.createElement("span");
        name.className = "proc-name";
        name.innerText = p.name + (p.count > 1 ? ` ×${p.count}` : "");
        row.appendChild(name);

        const barWrap = document.createElement("span");
        barWrap.className = "proc-bar";
        const bar = document.createElement("span");
        bar.style.width = Math.round((p.commitBytes / max) * 100) + "%";
        barWrap.appendChild(bar);
        row.appendChild(barWrap);

        const val = document.createElement("span");
        val.className = "proc-val";
        val.innerText = fmtGB(p.commitBytes);
        row.appendChild(val);

        const act = document.createElement("span");
        act.className = "proc-act";
        act.innerText = p.mine ? "" : "End";
        row.appendChild(act);

        if (p.mine) {
            row.disabled = true;
            row.title = ".lcl's own processes — use Unload model above";
        } else {
            row.title = `End ${p.name}${p.count > 1 ? ` (all ${p.count})` : ""}`;
            row.addEventListener("click", () => endProcessRow(p));
        }

        procsEl.appendChild(row);
    }
}

/**
 * End a process from the Machine panel.
 *
 * Closing an application is not undoable and can lose unsaved work, so this
 * always asks first and always says how many instances are about to go. The
 * main process refuses Windows components outright; anything that gets past
 * that refusal is an ordinary user application.
 */
async function endProcessRow(p) {
    const many = p.count > 1;
    // the app's own modal, not window.lcl.confirm — that one is a native Win32
    // message box, which is the grey chrome this whole sweep is removing
    const ok = await modal({
        title: `End ${p.name}?`,
        message: many
            ? `${p.name} is running as ${p.count} processes holding ${fmtGB(p.commitBytes)} between them. All ${p.count} will be closed.`
            : `${p.name} is holding ${fmtGB(p.commitBytes)}. It will be closed.`,
        detail: "Anything unsaved in that application is lost. This cannot be undone.",
        confirmLabel: many ? `End all ${p.count}` : "End it",
        danger: true
    });
    if (!ok) return;

    const note = $("machine-note");
    const prev = note.innerText;
    note.innerText = `ending ${p.name}…`;

    let res = null;
    try { res = await window.lcl.endProcess(p.name); }
    catch (e) { res = { ok: false, error: String(e && e.message || e) }; }

    if (!res || !res.ok) {
        note.innerText = prev;
        modal({
            title: `Could not end ${p.name}`,
            message: (res && res.error) || "Windows would not end that process.",
            confirmLabel: "Close",
            confirmOnly: true
        });
        return;
    }

    note.innerText = res.ended
        ? `ended ${p.name}${res.ended > 1 ? ` ×${res.ended}` : ""}`
        : (res.note || `${p.name} had already exited`);
    setTimeout(() => { note.innerText = prev; }, 4000);
    await refreshMachine();
    pollResources();
}

// The Machine panel's node gauges are gone: the SAME gauge — available-of-
// total, colour by headroom, resident models — is permanently on screen in
// the sidebar bar, and the full instrumentation is one click away in the
// node dashboard. A third copy behind Ctrl+M was drawing the same number in
// three panes. The Machine panel is this machine's.

/**
 * Compute panel: what silicon .lcl can actually spend, not just what exists.
 * A device with no usable runtime is shown as unavailable rather than counted
 * as capacity — the same inventory the router will consult.
 */
function computeRow(label, value, detail, state) {
    const row = document.createElement("div");
    row.className = "compute-row" + (state ? ` ${state}` : "");

    const name = document.createElement("span");
    name.className = "compute-name";
    name.innerText = label;
    row.appendChild(name);

    const val = document.createElement("span");
    val.className = "compute-value";
    val.innerText = value;
    row.appendChild(val);

    const det = document.createElement("span");
    det.className = "compute-detail";
    det.innerText = detail || "";
    row.appendChild(det);

    return row;
}

async function renderComputePanel() {
    const panel = $("compute-panel");
    panel.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "machine-note-inline";
    loading.innerText = "probing…";
    panel.appendChild(loading);

    let inv = null;
    try { inv = await window.lcl.machineInventory(); } catch { /* ignore */ }
    panel.innerHTML = "";
    if (!inv) {
        const e = document.createElement("div");
        e.className = "machine-note-inline";
        e.innerText = "could not read compute inventory";
        panel.appendChild(e);
        return;
    }

    // CPU
    panel.appendChild(computeRow(
        "CPU",
        `${inv.cpu.threads} threads`,
        `${inv.cpu.model.replace(/\(R\)|\(TM\)/g, "").trim()} · ` +
        `${Math.round(inv.cpu.busyRatio * 100)}% busy · using ${inv.cpu.threadsUsed}`,
        "active"
    ));

    // GPU — the number the inference runtime actually reports
    const dev = inv.gpu && inv.gpu.devices && inv.gpu.devices[0];
    if (dev) {
        panel.appendChild(computeRow(
            "GPU",
            `${fmtGB(dev.freeBytes)} free of ${fmtGB(dev.totalBytes)}`,
            `${dev.name.replace(/\(R\)|\(TM\)/g, "").trim()} · via ${inv.gpu.accelerator} · in use`,
            "active"
        ));
    } else {
        panel.appendChild(computeRow(
            "GPU", "not in use",
            (inv.gpu && inv.gpu.note) || "no accelerated device", "idle"
        ));
    }

    // NPU — present is not the same as usable
    if (inv.npu.present) {
        panel.appendChild(computeRow(
            "NPU",
            inv.npu.usable ? "available" : "present, unusable",
            inv.npu.reason || `via ${inv.npu.runtime}`,
            inv.npu.usable ? "active" : "idle"
        ));
    }

    // memory restated in compute terms: what is left for another model
    panel.appendChild(computeRow(
        "Model",
        inv.model.info ? inv.model.info.id : "none",
        inv.model.bytes
            ? `${fmtGB(inv.model.bytes)} · room for a second: ${inv.headroomForAnotherModel ? "yes" : "no"}`
            : "no model selected",
        inv.model.bytes ? "active" : "idle"
    ));
}

/* ---------------- memory optimiser ---------------- */

$("optimize-scan").addEventListener("click", async () => {
    const btn = $("optimize-scan");
    const out = $("optimize-results");
    btn.disabled = true;
    btn.innerText = "Analysing…";
    out.innerHTML = "";

    let res = null;
    try { res = await window.lcl.analyseMemory(); } catch { /* ignore */ }

    btn.disabled = false;
    btn.innerText = "Analyse memory";

    if (!res || res.error) {
        const e = document.createElement("div");
        e.className = "machine-note-inline";
        e.innerText = (res && res.error) || "analysis failed";
        out.appendChild(e);
        return;
    }

    if (!res.findings.length) {
        const none = document.createElement("div");
        none.className = "machine-note-inline";
        none.innerText = "Nothing worth closing — no reclaimable background apps found.";
        out.appendChild(none);
        return;
    }

    const head = document.createElement("div");
    head.className = "optimize-summary";
    head.innerText = `About ${fmtGB(res.reclaimableBytes)} could be freed by closing ` +
                     `${res.findings.length} background app${res.findings.length === 1 ? "" : "s"}.`;
    out.appendChild(head);

    const chosen = new Set(res.findings.map(f => f.process));

    for (const f of res.findings) {
        const row = document.createElement("label");
        row.className = "optimize-item";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.addEventListener("change", () => {
            if (cb.checked) chosen.add(f.process);
            else chosen.delete(f.process);
            propose.disabled = chosen.size === 0;
        });
        row.appendChild(cb);

        const text = document.createElement("span");
        text.className = "optimize-text";
        const strong = document.createElement("strong");
        strong.innerText = f.label + (f.count > 1 ? ` ×${f.count}` : "");
        text.appendChild(strong);
        const why = document.createElement("span");
        why.className = "optimize-why";
        why.innerText = " — " + f.why;
        text.appendChild(why);
        row.appendChild(text);

        const size = document.createElement("span");
        size.className = "optimize-size";
        size.innerText = fmtGB(f.commitBytes);
        row.appendChild(size);

        out.appendChild(row);
    }

    const note = document.createElement("div");
    note.className = "machine-note-inline";
    note.innerText = res.protectedNote;
    out.appendChild(note);

    const propose = document.createElement("button");
    propose.className = "primary optimize-propose";
    propose.innerText = "Review a script to close these";
    propose.addEventListener("click", async () => {
        propose.disabled = true;
        const staged = await window.lcl.proposeMemoryScript(
            [...chosen], active ? active.id : null);
        if (!staged || staged.error || !staged.proposal) {
            await modal({
                title: "Could not prepare the script",
                message: (staged && staged.error) || "unknown error",
                confirmLabel: "Close", confirmOnly: true
            });
            propose.disabled = false;
            return;
        }
        // same approval card as anything the model proposes
        closeMachine();
        addScriptCard(staged.proposal);
    });
    out.appendChild(propose);
});

$("machine-close").addEventListener("click", closeMachine);
$("open-taskmgr").addEventListener("click", async () => {
    const r = await window.lcl.openSystemTool("processes");
    if (!r || !r.ok) modal({
        title: "Could not open Task Manager",
        message: (r && r.error) || "Windows would not start taskmgr.exe.",
        confirmLabel: "Close", confirmOnly: true
    });
});
$("open-resmon").addEventListener("click", async () => {
    const r = await window.lcl.openSystemTool("performance");
    if (!r || !r.ok) modal({
        title: "Could not open Resource Monitor",
        message: (r && r.error) || "Windows would not start perfmon.exe.",
        confirmLabel: "Close", confirmOnly: true
    });
});

$("machine-refresh").addEventListener("click", refreshMachine);
$("machine-scrim").addEventListener("click", (e) => {
    if (e.target === $("machine-scrim")) closeMachine();
});
$("engine-unload").addEventListener("click", async () => {
    await window.lcl.unloadModel();
    setTimeout(refreshMachine, 600);
});
$("resource-bar").addEventListener("click", openMachine);

// =============================================================
// STATUS / READINESS
// =============================================================
/**
 * One state, two places to read it.
 *
 * The sidebar copy is the primary — it sits directly above the memory bar, so
 * "stopped to protect memory" and the number that caused it are one glance
 * apart. The titlebar copy only paints when the sidebar is collapsed, which CSS
 * handles; writing both unconditionally costs nothing and means the collapsed
 * case can never show a stale string.
 */
function setStatus(kind, text) {
    statusDot.className = kind;
    statusText.innerText = text;
    // the sidebar-status element was removed — per-session status dots carry
    // the state now, and the machine readout lives in the Memory section
}

/**
 * WHERE THE LOAD IS, IN WORDS, WHILE IT HAPPENS.
 *
 * The requirement: model loading needs visible progress — the exact state of
 * the load, at every point, until it is loaded.
 *
 * The engine reports a real phase (see LOAD_PHASES in engine.js) driven by
 * llama.cpp's own output. This paints it: which step of how many, what it is
 * doing, how long it has been doing it, and — once a model has loaded on this
 * machine once — roughly how long it usually takes.
 */
function paintLoad(load) {
    const row = $("load-progress");
    if (!row) return;
    if (!load || load.phase === "ready") { row.classList.add("hidden"); return; }
    row.classList.remove("hidden");
    const secs = Math.round((load.elapsedMs || 0) / 1000);
    const eta = load.etaMs ? Math.round(load.etaMs / 1000) : null;
    $("load-phase").innerText = `${load.label} · step ${load.step} of ${load.steps}`;
    $("load-elapsed").innerText = eta
        ? `${secs}s of about ${eta}s`
        : `${secs}s`;
    // the bar is honest: a real fraction against a LEARNED duration, or the
    // phase count when this model has never been loaded here before
    const fill = $("load-bar-fill");
    const pct = eta
        ? Math.min(99, Math.round(((load.elapsedMs || 0) / load.etaMs) * 100))
        : Math.round((load.step / load.steps) * 100);
    fill.style.width = pct + "%";
    // clamped to two lines in CSS so one long tensor line cannot resize the
    // sidebar; the whole line stays readable on hover rather than being lost
    const ln = $("load-line");
    ln.innerText = load.line || "";
    ln.title = load.line || "";
}

async function waitForBackend() {
    setStatus("busy", "checking the model…");
    setControls();

    // ASK THE BACKEND FIRST, THEN DECIDE — in that order, and never the reverse.
    //
    // Two bugs lived in getting this backwards. The loop used to poll forever
    // saying "Starting local model…" whether or not anything was starting, so
    // an engine nobody launched looked identical to one mid-load. Then the fix
    // for that asked for a start BEFORE finding out which backend this session
    // even uses, and spawned a local model — gigabytes of RAM — for a
    // conversation pointed at a machine on the network.
    //
    // checkHealth resolves the session's own model the same way the router
    // does, so one question answers both: who has to be alive, and are they.
    let asked = false;
    for (;;) {
        let h = null;
        try { h = await window.lcl.checkHealth(active && active.id); } catch { /* retry */ }

        // NOTHING IS COMING UNLESS SOMEBODY STARTS IT. Only once, only when the
        // answer is a LOCAL engine that is not running, not loading and has not
        // failed. A remote session never reaches here.
        if (!asked && h && h.kind === "local" && h.status !== "ok") {
            let st0 = null;
            try { st0 = await window.lcl.engineStatus(); } catch { /* below reports */ }
            if (st0 && !st0.running && !(st0.load && st0.load.phase !== "ready")
                && !st0.lastError && !st0.lastRefusal && !st0.guardStopped
                && h.status !== "no_model") {
                asked = true;
                composer.placeholder = "Starting local model…";
                window.lcl.restartEngine().catch(() => null);
            }
        }
        // A REMOTE model answering is a healthy backend. Nothing is loading, so
        // none of the local-engine failure branches below apply — falling into
        // them is how a session with a linked API sat on "Model not loaded"
        // waiting for a local model it did not need and might not have.
        if (h && h.status === "ok" && h.kind === "remote") {
            ready = true;
            setModelStatus();
            composer.placeholder = "Message .lcl…   (Ctrl+Enter to send)";
            setControls();
            composer.focus();
            return true;
        }
        // THE MODEL IS ON ANOTHER MACHINE AND THE NETWORK SWITCH IS OFF.
        //
        // This is not a failure to report and walk away from — it is one
        // switch, and the app knows exactly which one. Say it, and offer it.
        if (h && h.status === "network_off") {
            ready = false;
            setStatus("down", "internet access is off");
            composer.placeholder = `${h.endpoint} is on the network — internet access is off`;
            setControls();
            const turnOn = await modal({
                title: "Internet access is off",
                message: `${h.model} runs on ${h.endpoint}, which is reached over the ` +
                         `network. Internet access is switched off, so nothing can be sent.`,
                detail: "Turn it on and this conversation will use that model. " +
                        "Local models never need it, and secrets from your files are " +
                        "blocked from leaving either way.",
                confirmLabel: "Turn on internet access"
            });
            if (!turnOn) return false;
            await window.lcl.setNetworkEnabled(true).catch(() => null);
            paintNetPill(true);
            const box = $("net-toggle");
            if (box) box.checked = true;
            continue;                       // re-ask; the switch just moved
        }

        if (h && h.status === "ok") break;

        if (h && h.status === "no_model") {
            setStatus("down", "no model");
            composer.placeholder = "No model selected";
            const picked = await promptForModel();
            if (!picked) {
                // Declining the prompt is an answer, not a reason to re-ask
                // every four seconds forever. Leave the app usable — the model
                // button (which stays enabled) is the way back in.
                ready = false;
                setStatus("down", "no model selected");
                // the placeholder carries the ACTION; the status line beside
                // it already carries the state
                composer.placeholder = "Click the model button to pick one";
                setControls();
                return false;
            }
            setStatus("busy", "loading model…");
        }

        // A dead engine that is NOT coming back — planner refusal, OOM death,
        // watchdog stop, plain load death, or a crash loop that gave up — is a
        // terminal state. The old loop spun on /health forever, which is
        // exactly how the whole app sat greyed out after the 7B died. Confirm
        // it is really down (a crash auto-restart fires at 2s, so re-check
        // after 3s), then hand control back with the reason on screen.
        let st = null;
        try { st = await window.lcl.engineStatus(); } catch { /* engine ipc gone */ }
        if (st) paintLoad(st.load);
        if (st && st.load && st.load.phase && st.load.phase !== "ready") {
            // the status line says the PHASE, not the same word for two minutes
            setStatus("busy", st.load.label);
            composer.placeholder = `${st.load.label}…`;
        }
        if (st && !st.running
            && (st.guardStopped || st.oomDetected || st.lastRefusal || st.lastError)) {
            await new Promise(r => setTimeout(r, 3000));
            try { st = await window.lcl.engineStatus(); } catch { /* keep last */ }
            if (st && !st.running) {
                ready = false;
                setStatus("down", st.guardStopped ? "stopped to protect memory" : "model not loaded");
                composer.placeholder = "Click the model button to pick one";
                setControls();
                if (st.lastError) addError(st.lastError);
                return false;
            }
        }
        await new Promise(r => setTimeout(r, 1500));
    }

    ready = true;
    setModelStatus();
    composer.placeholder = "Message .lcl…   (Ctrl+Enter to send)";
    setControls();
    composer.focus();
    return true;
}

async function promptForModel() {
    const ok = await modal({
        title: "Select a model",
        message: ".lcl needs a local model file to run.",
        detail: "Choose a GGUF model file (for example Phi-3-mini-4k-instruct-q4.gguf).\n\n" +
                "It stays on this machine — nothing is uploaded.",
        confirmLabel: "Choose file…"
    });
    if (!ok) return false;
    const res = await window.lcl.chooseModel();
    // a planner refusal is an answer the user needs to read, not a silent retry
    if (res && res.error && !res.canceled) {
        await modal({
            title: "Model not loaded",
            message: res.error,
            confirmLabel: "Close", confirmOnly: true
        });
    }
    return !!(res && res.modelPath);
}


// =============================================================
// PER-SESSION KNOWLEDGE  (read-only twin of the workspace link)
// =============================================================
/**
 * "in sessions, each session is unique, knowledge should be enabled, per type.
 *  so there should be a button to link knowledge just like a workspace, but
 *  that is read only."
 *
 * Checkboxes over the registered libraries; the selection is stored ON the
 * session and the agent grounds only from what is ticked. A fresh session
 * grounds nothing — which also ends the "thinking says it referenced
 * knowledge in a brand-new session" mystery: it will never reference what it
 * was never given.
 */
async function openLinkKnowledge() {
    if (!active) return;
    let res = null;
    try { res = await window.lcl.listLibraries(); } catch { return; }
    const libs = (res && res.libraries) || [];

    const wrap = document.createElement("div");
    wrap.className = "pref-wrap";
    if (!libs.length) {
        const n = document.createElement("div");
        n.className = "pref-note";
        n.innerText = "No libraries yet — add one under Knowledge.";
        wrap.appendChild(n);
    }
    const current = new Set(active.knowledgeIds || []);
    const boxes = [];
    for (const lib of libs) {
        const row = document.createElement("label");
        row.className = "kn-link-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = current.has(lib.id);
        boxes.push([cb, lib.id]);
        const name = document.createElement("span");
        name.className = "kn-link-name";
        name.innerText = lib.name;
        const meta = document.createElement("span");
        meta.className = "kn-link-meta";
        meta.innerText = `${lib.files || 0} files · read-only`;
        row.appendChild(cb); row.appendChild(name); row.appendChild(meta);
        wrap.appendChild(row);
    }
    const note = document.createElement("div");
    note.className = "pref-note";
    note.innerText = "Read-only. Searched and cited in this session only.";
    wrap.appendChild(note);

    const ok = await modal({ title: "Link knowledge to this session",
        node: wrap, confirmLabel: "Save", cancelLabel: "Cancel" });
    if (!ok) return;
    const ids = boxes.filter(([cb]) => cb.checked).map(([, id]) => id);
    const r = await window.lcl.setSessionKnowledge(active.id, ids).catch(() => null);
    if (r && r.ok) { active.knowledgeIds = r.knowledgeIds; renderKnowledgeChip(); }
}
$("link-knowledge").addEventListener("click", openLinkKnowledge);
$("composer-knowledge").addEventListener("click", openLinkKnowledge);
$("session-cost").addEventListener("click", () => openSpend());

// =============================================================
// DICTATION  (local whisper — audio never leaves this machine)
// =============================================================
/**
 * Click to record, click to stop; the transcript lands in the composer for
 * editing rather than auto-sending, because dictation gets homophones wrong
 * and a wrong word in a sent message costs a whole turn to fix.
 *
 * Capture is Web Audio at the device rate, downsampled to the 16 kHz mono
 * whisper wants, packed into a wav here in the renderer. The buffer crosses
 * IPC once, is transcribed by the bundled whisper.cpp, and the temp file is
 * deleted — no API, no account, works the same in remote-model sessions.
 */
let micState = null;   // { ctx, stream, node, chunks, rate }

function wavFromPcm(chunks, inRate) {
    let len = 0;
    for (const c of chunks) len += c.length;
    const pcm = new Float32Array(len);
    let o = 0;
    for (const c of chunks) { pcm.set(c, o); o += c.length; }
    // linear-interpolation downsample to 16 kHz
    const OUT_RATE = 16000;
    const outLen = Math.floor(pcm.length * OUT_RATE / inRate);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const pos = i * inRate / OUT_RATE;
        const i0 = Math.floor(pos);
        const frac = pos - i0;
        const sample = pcm[i0] * (1 - frac) + (pcm[i0 + 1] || pcm[i0] || 0) * frac;
        out[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    }
    const buf = new ArrayBuffer(44 + out.length * 2);
    const v = new DataView(buf);
    const str = (off, txt) => { for (let i = 0; i < txt.length; i++) v.setUint8(off + i, txt.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + out.length * 2, true); str(8, "WAVE");
    str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, OUT_RATE, true);
    v.setUint32(28, OUT_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, out.length * 2, true);
    new Int16Array(buf, 44).set(out);
    return buf;
}

/**
 * LIVE DICTATION, WRITTEN INTO THE MESSAGE BOX AS YOU SPEAK.
 *
 * Asked for repeatedly: watching words appear, not staring at a pulsing button
 * for a minute and hoping. Whisper is not a streaming recogniser, so this
 * transcribes the audio SO FAR on a rolling timer and replaces its own
 * provisional text each pass. Two rules make that safe:
 *
 *  - it only ever owns the span it wrote. Anything typed before dictation
 *    started, or typed around it mid-sentence, is preserved exactly.
 *  - the pass that runs when you stop transcribes the WHOLE clip and replaces
 *    the provisional text with it, because whisper is far more accurate over a
 *    complete utterance than over the partial windows it heard on the way.
 */
function setDictated(st, text) {
    const cur = composer.value;
    const before = st.textBefore || "";
    const prev = st.dictated || "";
    // the tail the user may have typed AFTER the dictated span
    const expected = prev ? (before ? before.replace(/\s*$/, " ") + prev : prev) : before;
    const after = cur.startsWith(expected) ? cur.slice(expected.length) : "";
    const joined = text ? (before ? before.replace(/\s*$/, " ") + text : text) : before;
    composer.value = joined + after;
    st.dictated = text;
    autoGrow();
}

async function toggleMic() {
    const btn = $("mic-btn");
    // every step is recorded, so whatever appears on screen can be lined up
    // against how far the sequence actually got
    const trace = (step, detail) => {
        try { window.lcl.micTrace(step, detail); } catch { /* never block dictation */ }
    };
    trace("click", micState ? "stopping" : "starting");
    if (micState) {
        // ---- stop, transcribe the remainder, insert ----
        const st = micState;
        micState = null;
        if (st.liveTimer) clearInterval(st.liveTimer);
        btn.classList.remove("recording");
        btn.classList.add("busy");
        try { st.node.disconnect(); st.stream.getTracks().forEach(t => t.stop()); await st.ctx.close(); }
        catch { /* already down */ }
        try {
            // THE WHOLE RECORDING, ONCE, AT THE END.
            //
            // The live pass below writes provisional text as you speak; this
            // final pass replaces it with a transcription of the entire clip.
            // Whisper is markedly more accurate over a full utterance than
            // over the rolling windows — it can hear the end of a sentence
            // before deciding the start of it — so the last word is always the
            // complete one, not a stitched-together guess.
            const wav = wavFromPcm(st.chunks, st.rate);
            trace("sending-audio", `${wav.byteLength} bytes`);
            const r = await window.lcl.transcribeMic(wav);
            trace("transcribe-returned",
                r && r.ok ? `text: ${String(r.text || "").slice(0, 60)}`
                          : `error: ${(r && r.error) || "no result"}`);
            if (r && r.ok && r.text) {
                setDictated(st, r.text);
                autoGrow(); refreshCostMeter(); composer.focus();
            } else if (r && r.error) {
                setDictated(st, "");                 // drop the provisional text
                addNotice("Dictation: " + r.error);
            }
        } finally { btn.classList.remove("busy"); }
        return;
    }
    // ---- start ----
    try {
        trace("getUserMedia-requested");
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        trace("getUserMedia-granted",
            (stream.getAudioTracks()[0] || {}).label || "unnamed device");
        const ctx = new AudioContext();
        // OFF THE MAIN THREAD, AND NEVER INTO THE SPEAKERS.
        //
        // The old path used ScriptProcessorNode — deprecated, and its callback
        // runs on the page's own JS thread — and connected the microphone
        // straight to ctx.destination, which is a feedback loop into the
        // speakers. On the test machine that combination killed the
        // renderer process the instant recording began: black window, no
        // clicks, no keyboard, and no renderer among the app's children.
        await ctx.audioWorklet.addModule("mic-worklet.js");
        trace("worklet-loaded");
        const src = ctx.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(ctx, "mic-capture");
        const chunks = [];
        let frames = 0;
        node.port.onmessage = (e) => {
            chunks.push(e.data);
            frames += e.data.length;
            // 10 minute hard stop — a forgotten mic is not an unbounded buffer
            if (frames > ctx.sampleRate * 600) toggleMic();
        };
        // a silent sink: the graph needs a destination to pull frames, but the
        // microphone must never be routed back out of the speakers
        const mute = ctx.createGain();
        mute.gain.value = 0;
        src.connect(node); node.connect(mute); mute.connect(ctx.destination);
        micState = { ctx, stream, node, chunks, rate: ctx.sampleRate,
                     textBefore: composer.value, dictated: "", liveBusy: false };
        trace("recording-started", `${ctx.sampleRate} Hz`);

        // ROLLING TRANSCRIPTION while the microphone is open. Never overlaps
        // itself (liveBusy), never runs on a clip too short to say anything,
        // and every failure is silent — a provisional pass that misses is not
        // worth interrupting someone mid-sentence for.
        const st0 = micState;
        st0.liveTimer = setInterval(async () => {
            if (!micState || micState !== st0 || st0.liveBusy) return;
            if (!st0.chunks.length) return;
            let frames = 0;
            for (const c of st0.chunks) frames += c.length;
            // HALF A SECOND IS ENOUGH TO START. The 1.2s floor plus a 2.5s
            // timer meant the first words never appeared before ~3 seconds,
            // which reads as if it waits until the speaker is done. The first pass
            // now runs on ~0.5s of audio; accuracy of those first words is
            // provisional by design and the stop pass replaces everything.
            if (frames < st0.rate * 0.5) return;
            st0.liveBusy = true;
            try {
                /* EACH PASS HEARS ONLY WHAT IS NEW.
                 *
                 * This sent st0.chunks — the ENTIRE recording, from the first
                 * frame — on every pass. So pass N transcribed seconds 0..T
                 * rather than the new audio, and the cost of one update grew
                 * with how long you had been talking. Thirty seconds in, every
                 * update was re-recognising thirty seconds. That is the whole
                 * of the "insanely slow, have to stop talking" complaint, raised ten
                 * times, and it was never a whisper speed problem.
                 *
                 * Now the clip is split at a moving mark. Audio before the
                 * mark has already been recognised and its text is COMMITTED;
                 * each pass sends only the tail after it, so a pass costs the
                 * same at ten minutes as at ten seconds. When the tail grows
                 * past COMMIT_SECS its text is folded into the committed
                 * prefix and the mark moves up.
                 *
                 * Accuracy is untouched: the pass that runs when you stop
                 * still transcribes the whole clip and replaces all of this,
                 * because whisper is far better over a complete utterance.
                 */
                const COMMIT_SECS = 14;
                const mark = st0.liveMark || 0;             // frames already committed
                let seen = 0;
                const tail = [];
                for (const c of st0.chunks) {
                    const start = seen;
                    seen += c.length;
                    if (seen <= mark) continue;             // wholly before the mark
                    tail.push(start >= mark ? c : c.subarray(mark - start));
                }
                let tailFrames = 0;
                for (const c of tail) tailFrames += c.length;
                if (tailFrames >= st0.rate * 0.5) {
                    const wav = wavFromPcm(tail, st0.rate);
                    const r = await window.lcl.transcribeMic(wav);
                    // the user may have stopped while that was running
                    if (micState === st0 && r && r.ok && typeof r.text === "string") {
                        const piece = r.text.trim();
                        const whole = ((st0.liveCommitted || "") + " " + piece).trim();
                        setDictated(st0, whole);
                        trace("live-pass",
                            `${Math.round(tailFrames / st0.rate)}s window, ${piece.length} chars`);
                        // the window has grown long enough to be worth keeping:
                        // fold it into the prefix and start the next one fresh
                        if (tailFrames >= st0.rate * COMMIT_SECS && piece) {
                            st0.liveCommitted = whole;
                            st0.liveMark = seen;
                            trace("live-commit", `${whole.length} chars committed`);
                        }
                    }
                }
            } catch { /* provisional only */ }
            finally { st0.liveBusy = false; }
        }, 900);
        btn.classList.add("recording");
        btn.title = "Listening - words appear in the message box as you speak. " +
            "Click to stop and finish.";
    } catch (e) {
        trace("start-failed", String(e && e.name || "") + ": " + String(e && e.message || e));
        addNotice("Microphone unavailable: " + String(e && e.message || e));
    }
}
/* ---- attachments: the strip above the input, and its three doors ---- */
function renderAttachStrip() {
    const strip = $("attach-strip");
    const list = (active && Array.isArray(active.stagedAttachments))
        ? active.stagedAttachments : [];
    strip.classList.toggle("hidden", list.length === 0);
    strip.innerHTML = "";
    if (!list.length) return;
    const sid = active.id;
    for (const a of list) {
        const chip = document.createElement("span");
        chip.className = "attach-chip";
        chip.title = a.rel ? a.rel + " — in the linked folder"
                           : (a.path || a.name) + " — copied for this session";
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.innerText = a.name;
        const sz = document.createElement("span");
        sz.className = "sz";
        sz.innerText = wsFmtBytes(a.bytes);
        const x = document.createElement("button");
        x.className = "x";
        x.innerText = "×";
        x.title = "Remove — it will not be sent";
        x.addEventListener("click", async (e) => {
            e.stopPropagation();
            e.preventDefault();
            // REMOVE IT FROM THE UI IMMEDIATELY. The click must feel real even
            // if the IPC is slow or returns an unexpected shape — the chip used
            // to sit there because the repaint only ran on a truthy r.staged.
            if (active && active.id === sid) {
                active.stagedAttachments = (active.stagedAttachments || [])
                    .filter(z => z.id !== a.id);
                renderAttachStrip();
            }
            // then reconcile with the backend (which also deletes the disk copy)
            const r = await window.lcl.unstageAttachment(sid, a.id).catch(() => null);
            if (r && Array.isArray(r.staged) && active && active.id === sid) {
                active.stagedAttachments = r.staged;
                renderAttachStrip();
            }
        });
        chip.appendChild(nm); chip.appendChild(sz); chip.appendChild(x);
        strip.appendChild(chip);
    }
}
async function chooseAttachments() {
    if (!active) return;
    const r = await window.lcl.chooseAttachments(active.id);
    if (!r || r.canceled) return;
    if (r.error) { addError(r.error); return; }
    active.stagedAttachments = r.staged || [];
    renderAttachStrip();
    // per-file refusals (too big, not a file) arrive as honest notices
    for (const e of r.errors || []) addNotice(e);
}
async function stageWorkspaceFile(rel) {
    if (!active) return;
    const r = await window.lcl.stageAttachment(active.id, { rel });
    if (r && r.error) { addError(r.error); return; }
    active.stagedAttachments = (r && r.staged) || [];
    renderAttachStrip();
}
$("attach-btn").addEventListener("click", chooseAttachments);
$("mic-btn").addEventListener("click", toggleMic);

// ---- REASON UNTIL DONE — the brain toggle in the composer row -------------
// A per-session self-review mode. Lit = this conversation's finished work is
// attacked by four blind reviewers before you see it; dark = it is not. The
// state rides on the session record (selfReview perm), so it survives a
// reload and never leaks across conversations. A mode you put a conversation
// into for the work that earns it — repo reads, builds — not a habit.
// =============================================================
// REASONING EFFORT SLIDER + ANCIENT KNOWLEDGE BRAIN
// TWO INDEPENDENT CONTROLS:
//   1. Slider: controls reasoning_effort sent to the API. 5 Kardashev
//      levels. Always visible, left of brain. Wires reasoning_effort into
//      the request body via the session record.
//   2. Brain (Ancient Knowledge): ON/OFF toggle. When ON, lights up with
//      the color matching the current slider level. When ON, after each
//      model response, audits: did the model actually complete what was
//      asked? Sends (user input + model output) back to the model asking
//      it to verify completion.
// The brain color reflects the slider level, but ONLY when brain is ON.
// =============================================================
const EFFORT_LEVELS = [
    { id: "default", label: "Terrestrial",  kardashev: "Type 0",      desc: "Basic local calculations.", api: undefined, color: "#e0c98f" },
    { id: "low",     label: "Planetary",   kardashev: "Type I",      desc: "Harnesses your whole local file context.", api: "low", color: "#6fd98f" },
    { id: "medium",  label: "Stellar",     kardashev: "Type II",     desc: "Power of a Dyson sphere applied to your codebase.", api: "medium", color: "#6fc5e8" },
    { id: "high",    label: "Galactic",    kardashev: "Type III",    desc: "Orchestrates entire multi-repository clusters.", api: "high", color: "#b88fe0" },
    { id: "max",     label: "Multiversal",  kardashev: "Kardashev V", desc: "Pulls flawless code from an alternate reality where your project has zero legacy tech debt.", api: "max", color: "#5fe8e0" },
];

(function () {
    const brain = $("brain-btn");
    if (!brain) return;
    const slider = $("brain-slider");
    const label = $("brain-level-label");

    // sync the visual state from the session record
    const sync = () => {
        const s = active;
        // slider level
        const effortIdx = (s && typeof s.effortLevel === "number") ? s.effortLevel : 0;
        const lvl = EFFORT_LEVELS[effortIdx] || EFFORT_LEVELS[0];
        if (slider) slider.value = effortIdx;
        if (label) {
            label.innerText = lvl.label;
            label.title = `${lvl.kardashev} — ${lvl.desc}`;
            // the REASONING level carries its OWN colour, here on its label —
            // never on the brain. Coupling the brain's colour to the slider is
            // what re-lit it on a reasoning change and made toggling it glow the
            // max-effort teal, reading as "reasoning jumped to max".
            label.style.color = lvl.color;
        }
        slider.title = `Reasoning effort: ${lvl.label} (${lvl.kardashev})`;

        // brain on/off — FULLY independent of the reasoning level. The brain is
        // Ancient Knowledge, on or off, and nothing else.
        const ancientOn = !!(s && s.ancientKnowledge === true);
        brain.classList.remove("effort-0","effort-1","effort-2","effort-3","effort-4");
        brain.classList.toggle("on", ancientOn);

        // brain tooltip
        brain.title = ancientOn
            ? `Ancient Knowledge: ON — ${lvl.label}. Audits input against output, analyses gaps, and feeds repairs to the model.`
            : "Ancient Knowledge — click to enable. Audits input against output; an overseer that verifies the model completed what was asked.";
    };

    // SLIDER: changes reasoning_effort, does NOT toggle the brain
    if (slider) {
        // on input (during drag): update label only, do NOT call sync()
        // because sync() sets slider.value which fights the ongoing drag
        slider.addEventListener("input", () => {
            if (!active) return;
            const idx = parseInt(slider.value, 10);
            const lvl = EFFORT_LEVELS[idx];
            if (label) {
                label.innerText = lvl.label;
                label.title = `${lvl.kardashev} — ${lvl.desc}`;
                label.style.color = lvl.color;   // live during drag
            }
        });
        // on change (release): persist the level (brain is untouched by this)
        slider.addEventListener("change", async () => {
            if (!active) return;
            const idx = parseInt(slider.value, 10);
            const lvl = EFFORT_LEVELS[idx];
            active.effortLevel = idx;
            try {
                // THE LEVEL ITSELF GOES TO DISK. Without this the engine — which
                // loads the session fresh from disk every turn — never saw the
                // choice, so reasoning_effort, the local and node temperature
                // curves and the Ancient Knowledge round ceiling all ran at
                // their defaults no matter where this slider sat.
                await window.lcl.setSessionEffort(active.id, idx);
                // NEVER through answerLike. This used to write the slider's UI
                // joke ("Pulls flawless code from an alternate reality…") into
                // session.answerLike — clobbering whatever persona the operator
                // set, and feeding the model a gag as a standing ATTITUDE
                // instruction on every turn. Measured live: a session asked for
                // educational material while its prompt ordered cockiness. The
                // effort level itself (setSessionEffort above) is the whole
                // signal — the engine turns it into reasoning_effort and an
                // honest effort line of its own (agent.effortBlock).
            } catch {}
            sync();
        });
        slider.addEventListener("click", (e) => e.stopPropagation());
    }

    // BRAIN: ON/OFF toggle, does NOT change the slider
    brain.addEventListener("click", async () => {
        if (!active) return;
        const wasOn = active.ancientKnowledge === true;
        // TURNING IT ON MAY NEED THE FOLDER PICKER, AND linkRepo REFUSES WHILE
        // A TURN IS RUNNING — so without this the modal appeared, the operator
        // confirmed, no picker ever opened and the toggle silently did nothing.
        // Turning it OFF is always allowed: withdrawing an overseer must never
        // be the thing you have to wait for.
        if (!wasOn && pending && !active.repoPath) {
            addNotice("Ancient Knowledge needs a workspace folder, and one " +
                      "cannot be linked while this conversation is working. " +
                      "Try again when the turn finishes.");
            return;
        }
        // ANCIENT KNOWLEDGE NEEDS SOMEWHERE TO WRITE. When the brain is on,
        // every turn is interrogated and a living ancient_knowledge.md goes in
        // this conversation's workspace folder — an auditor with no ledger
        // is not an auditor. No folder linked? Ask for one FIRST, through
        // the same pick→confirm→grant flow linking always uses; and if none
        // is granted, the brain honestly stays off rather than pretending.
        if (!wasOn && !active.repoPath) {
            const link = await modal({
                title: "Ancient Knowledge needs a workspace",
                message: "With the brain on, every response is interrogated " +
                    "against your request until the gaps close, and a living " +
                    "session review is written to ancient_knowledge.md in this " +
                    "conversation's workspace folder.",
                detail: "Link a folder for this conversation to hold it?",
                confirmLabel: "Link a folder…"
            });
            if (link) await linkRepo();
            if (!active.repoPath) { sync(); return; }
        }
        // THE LAMP FOLLOWS THE DISK, NOT THE CLICK.
        //
        // This used to light the brain locally and THEN persist inside a
        // swallowed try/catch — so a save that failed left the icon on, the
        // session file saying false, and the engine (which reloads the
        // session from disk every turn) correctly not auditing. From the
        // operator's chair that is the exact symptom it was reported: the brain
        // is on and Ancient Knowledge never runs. A toggle that cannot prove
        // it took effect must not claim it did.
        try {
            await window.lcl.setSessionAncientKnowledge(active.id, !wasOn);
            await window.lcl.setSessionPerm(active.id, "selfReview", !wasOn);
            active.ancientKnowledge = !wasOn;
            if (!active.perms) active.perms = {};
            active.perms.selfReview = !wasOn;
        } catch (err) {
            addNotice("Ancient Knowledge could not be " +
                (wasOn ? "switched off" : "switched on") + " — the session " +
                "could not be saved" +
                (err && err.message ? ` (${String(err.message).slice(0, 80)})` : "") +
                ". It is still " + (wasOn ? "ON" : "OFF") + ".");
        }
        sync();
    });

    // RIGHT-CLICK THE BRAIN FOR ITS SETTINGS — which model does the auditing.
    // Left-click toggles; right-click configures. Also reachable from You ›
    // Ancient Knowledge.
    brain.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openAncientSettings();
    });

    document.addEventListener("lcl:activeSession", sync);
    sync();
})();

/**
 * ANCIENT KNOWLEDGE — the per-session audit AGENT and its settings.
 *
 * Two regions, and the wall between them is the point. THE KNOBS drive the
 * agent's mechanics (which model audits, how hard it presses). THE GROUND RULES
 * are the operator's free-text standing instructions — tone and context only,
 * guardrailed so they can never change a verdict or launder a blank audit. All
 * of it is SESSION-SCOPED: open it in another conversation and it reads that
 * conversation's own settings. The ground rules mirror to a workspace companion
 * file (…rules.md) the agent reads, beside the audit doc it writes.
 */
async function openAncientSettings() {
    if (!active || !active.id) { await dialogFailed("Ancient Knowledge",
        new Error("open a session first")); return; }

    // CAPTURE THE SESSION THIS DIALOG BELONGS TO. `active` can change under the
    // open modal — clicking a background session's notification calls
    // switchSession — and every autosave must write to the session the operator
    // opened, not whichever one is current when the save fires.
    const sessionId = active.id;

    const wrap = document.createElement("div");
    wrap.className = "pref-wrap";

    const [models, cfg] = await Promise.all([
        window.lcl.listModels().catch(() => ({ models: [] })),
        window.lcl.getSessionAkSettings(sessionId).catch(() => null)
    ]);
    const list = (models && models.models) || [];
    const cur = (cfg && cfg.auditor) || "";
    const curRounds = cfg && cfg.rounds != null ? String(cfg.rounds) : "";
    const curRules = (cfg && cfg.groundRules) || "";
    const hasWs = !!(cfg && cfg.hasWorkspace);

    const note = document.createElement("div");
    note.className = "pref-note pref-purpose";
    note.innerText = "This is THIS conversation's audit agent. When the brain is " +
        "lit, it checks each answer against what you asked, presses for the fix, " +
        "and keeps ancient_knowledge.md in your workspace. These settings belong " +
        "to this session — another conversation has its own.";
    wrap.appendChild(note);

    // ---------- REGION 1: the knobs that drive the agent ----------
    const kh = document.createElement("div");
    kh.className = "pref-head";
    kh.innerText = "The agent";
    wrap.appendChild(kh);

    // which model audits
    const mlabel = document.createElement("div");
    mlabel.className = "pref-note";
    mlabel.innerText = "Auditor model — by default the model that answered audits " +
        "itself; name a different one (e.g. a paid API answers, a free local node checks it).";
    wrap.appendChild(mlabel);

    const sel = document.createElement("select");
    sel.className = "cap-level auto pref-select";
    const same = document.createElement("option");
    same.value = "";
    same.innerText = "Same as this conversation's model (default)";
    if (!cur) same.selected = true;
    sel.appendChild(same);
    const localReady = list.filter(m => !m.remote && m.present);
    const remote = list.filter(m => m.remote && m.usable);
    const addGroup = (label, items, render) => {
        if (!items.length) return;
        const g = document.createElement("optgroup");
        g.label = label;
        for (const m of items) {
            const o = document.createElement("option");
            o.value = m.id;
            o.innerText = render(m);
            if (m.id === cur) o.selected = true;
            g.appendChild(o);
        }
        sel.appendChild(g);
    };
    addGroup("On this machine", localReady, m => `${m.family} ${m.params}`.trim());
    addGroup("Your nodes & APIs", remote,
        m => `${String(m.modelId).split("/").pop()} on ${m.endpointLabel}`);
    wrap.appendChild(sel);
    sel.addEventListener("change", () => saveAk({ auditor: sel.value || null }, sel));

    // how hard it presses — the round ceiling knob
    const rlabel = document.createElement("div");
    rlabel.className = "pref-note";
    rlabel.innerText = "How hard it presses — the maximum audit rounds before it " +
        "hands back to you. Auto follows the reasoning effort (2–6).";
    wrap.appendChild(rlabel);

    const rsel = document.createElement("select");
    rsel.className = "cap-level auto pref-select";
    const rauto = document.createElement("option");
    rauto.value = ""; rauto.innerText = "Auto — follows reasoning effort (default)";
    if (!curRounds) rauto.selected = true;
    rsel.appendChild(rauto);
    for (const n of [1, 2, 3, 4, 5, 6, 8]) {
        const o = document.createElement("option");
        o.value = String(n);
        o.innerText = `${n} round${n === 1 ? "" : "s"} max`;
        if (curRounds === String(n)) o.selected = true;
        rsel.appendChild(o);
    }
    wrap.appendChild(rsel);
    rsel.addEventListener("change", () => saveAk({ rounds: rsel.value || null }, rsel));

    // the spin-guard sensitivity — how many identical no-change tool calls a
    // grinding model gets before the loop ends and the auditor takes over
    const slabel = document.createElement("div");
    slabel.className = "pref-note";
    slabel.innerText = "Spin guard — how quickly a model grinding the same tool " +
        "call is stopped and handed to the audit.";
    wrap.appendChild(slabel);
    const ssel = document.createElement("select");
    ssel.className = "cap-level auto pref-select";
    for (const [v, l] of [["", "Default — stop on the 4th identical call"],
                          ["strict", "Strict — stop on the 3rd"],
                          ["lenient", "Lenient — allow two more before stopping"]]) {
        const o = document.createElement("option");
        o.value = v; o.innerText = l;
        if ((cfg && cfg.spin || "") === v) o.selected = true;
        ssel.appendChild(o);
    }
    wrap.appendChild(ssel);
    ssel.addEventListener("change", () => saveAk({ spin: ssel.value || null }, ssel));

    // ---------- REGION 2: the operator's ground rules ----------
    const gh = document.createElement("div");
    gh.className = "pref-head";
    gh.innerText = "Your ground rules";
    wrap.appendChild(gh);

    const gnote = document.createElement("div");
    gnote.className = "pref-note";
    gnote.innerText = "Standing instructions for the agent in this session — how to " +
        "read your intent, what to weigh, the context it should already know. These " +
        "TAILOR the audit; they never override its guardrails, so evidence still " +
        "decides every verdict. " + (hasWs
            ? "Saved to ancient_knowledge.rules.md in your workspace, beside the audit doc."
            : "Link a workspace to also save these as an editable file the agent reads.");
    wrap.appendChild(gnote);

    const ta = document.createElement("textarea");
    ta.className = "profile-field ak-rules";
    ta.rows = 7;
    ta.spellcheck = true;
    ta.placeholder = "e.g. I care most about wire-protocol correctness — never let a " +
        "protocol claim pass without a captured byte to back it. Treat unproven as " +
        "not done. Prefer measured over reasoned.";
    ta.value = curRules;
    wrap.appendChild(ta);
    // save on blur and debounced on input, so a long rule is not lost
    let gTimer = null;
    const saveRules = () => saveAk({ groundRules: ta.value }, ta);
    ta.addEventListener("blur", saveRules);
    ta.addEventListener("input", () => {
        if (gTimer) clearTimeout(gTimer);
        gTimer = setTimeout(saveRules, 800);
    });

    async function saveAk(patch, el) {
        // always the CAPTURED session, never the live `active`
        const r = await window.lcl.setSessionAkSettings(sessionId, patch).catch(() => null);
        if (el) {
            el.classList.add(r && r.ok ? "saved" : "save-failed");
            setTimeout(() => el.classList.remove("saved", "save-failed"), 900);
        }
    }

    await modal({ title: "Ancient Knowledge", node: wrap,
                  confirmLabel: "Done", confirmOnly: true, size: "wide" });
    // the dialog is gone: cancel any pending debounced save, then flush the
    // textarea's final value ONCE so a rule typed in the last 800ms is not lost
    // and no stray timer fires after teardown
    if (gTimer) { clearTimeout(gTimer); gTimer = null; }
    saveRules();
}

/* ANSWER LIKE — the per-session tone override, finally SURFACED (Open #20:
 * "backend wired, the input is not surfaced"). One sentence describing the
 * reference attitude — "answer like GLM-5.2: direct, no overpromising" — that
 * rides this conversation's own record and reaches every model that answers
 * it. Install-wide tone lives on the Characterization page; this overrides it
 * for THIS conversation only. */
async function openAnswerLike() {
    if (!active || !active.id) return;
    // the modal outlives session switches; the id it saves to must not follow
    const sessionId = active.id;
    const wrap = document.createElement("div");
    wrap.className = "pref-wrap";
    const note = document.createElement("div");
    note.className = "pref-note";
    note.innerText = "How this conversation's answers should sound — a reference " +
        "attitude any model that answers here will follow. Overrides the " +
        "install-wide tone for this conversation only. Clear it to fall back.";
    wrap.appendChild(note);
    const ta = document.createElement("textarea");
    ta.className = "profile-field";
    ta.maxLength = 400;
    ta.rows = 3;
    ta.placeholder = "answer like GLM-5.2: direct, no overpromising, explains as it goes";
    ta.value = (active && active.answerLike) || "";
    wrap.appendChild(ta);
    let timer = null;
    const save = async () => {
        const r = await window.lcl.setSessionAnswerLike(sessionId, ta.value)
            .catch(() => null);
        if (active && active.id === sessionId && r && r.ok !== false) {
            active.answerLike = r.answerLike;
        }
        ta.classList.add(r && r.ok !== false ? "saved" : "save-failed");
        setTimeout(() => ta.classList.remove("saved", "save-failed"), 900);
    };
    ta.addEventListener("blur", save);
    ta.addEventListener("input", () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(save, 800);
    });
    await modal({ title: "Answer like", node: wrap,
                  confirmLabel: "Done", confirmOnly: true });
    if (timer) { clearTimeout(timer); timer = null; }
    save();
}

// =============================================================
// CONNECTIONS  (Network menu — SSH keys, serial ports, rented GPU)
// =============================================================
/**
 * One place that answers "what is this machine attached to". SSH keys are
 * generated HERE, by the OS's own ssh-keygen, into app data; the private half
 * never crosses IPC and never leaves. A key can be assigned to the current
 * session the same way a workspace is linked — that assignment is what the
 * remote-machine work (SSH to other machines) will ride on.
 */
// =============================================================
// WHAT THIS CONVERSATION IS ALLOWED TO DO
// =============================================================
/**
 * WHO grants: the person reading this screen, per session, with a click.
 * WHAT: secrets and keys to the model, running scripts unattended, requiring a real
 * sandbox, and how file changes are confirmed.
 * WHERE it applies: this session only — the one named at the top.
 * WHEN it takes effect: the next tool call. No restart, no re-linking.
 * WHY it exists: so a user has no reason to edit the logic in .lcl just to
 * change some minor restricted behavior they want to enable.
 *
 * Every switch is drawn from the engine's own catalog, and the secrets
 * switch names the REAL destination the model answers from, because "send
 * secrets to the model" means something different when the model is on
 * this laptop, on a machine you own, or on somebody else's servers.
 */
/*
 * THE OFFER, ON SCREEN. A better-suited reachable model for the kind of
 * work just asked — shown once, dismissible, never forcing. "Assign" writes it
 * into this session's task map, and from then on such messages ROUTE to it.
 */
const offerDismissed = new Set();   // sessionId|cap — once waved off, stay quiet
function showModelOffer(offer, session) {
    if (!offer || !offer.suggested || !offer.cap) return;
    const dk = session.id + "|" + (offer.kind ? offer.kind + "|" : "") + offer.cap;
    if (offerDismissed.has(dk)) return;
    if (session.taskModels && session.taskModels[offer.cap]
        && session.taskModels[offer.cap].model) return;   // already assigned
    document.querySelectorAll(".model-offer").forEach(el => el.remove());

    const strip = document.createElement("div");
    strip.className = "model-offer";
    const txt = document.createElement("span");
    txt.className = "model-offer-text";
    txt.innerText = `${offer.suggested.label} suits this better — ${offer.reason}`;
    strip.appendChild(txt);

    const use = document.createElement("button");
    use.className = "primary small";
    use.innerText = "Assign for this kind of work";
    use.addEventListener("click", async () => {
        const map = { ...(session.taskModels || {}) };
        map[offer.cap] = { model: offer.suggested.id,
                           endpointId: offer.suggested.endpointId || undefined,
                           endpointLabel: offer.suggested.endpointLabel || undefined };
        const r = await window.lcl.setSessionTaskModels(session.id, map).catch(() => null);
        if (r && r.ok) session.taskModels = r.taskModels;
        strip.remove();
    });
    strip.appendChild(use);

    const no = document.createElement("button");
    no.className = "ghost small";
    no.innerText = "Dismiss";
    no.addEventListener("click", () => {
        offerDismissed.add(dk);
        strip.remove();
    });
    strip.appendChild(no);

    const chatEl = $("chat");
    if (chatEl) { chatEl.appendChild(strip); scrollToBottom(true); }
}

/* An assignment that exists but did not resolve — said out loud where the
 * operator is looking, instead of silently answering on the session's model. */
function showRouteBroken(broken, session) {
    if (!broken || !broken.cap) return;
    document.querySelectorAll(".model-offer.route-broken").forEach(el => el.remove());
    const strip = document.createElement("div");
    strip.className = "model-offer route-broken";
    const txt = document.createElement("span");
    txt.className = "model-offer-text";
    txt.innerText = `Your ${broken.cap} assignment (${String(broken.model).split("/").pop()}) ` +
        "is not reachable right now — this reply used the session's own model.";
    strip.appendChild(txt);
    const fix = document.createElement("button");
    fix.className = "primary small";
    fix.innerText = "Open Model Orchestration";
    fix.addEventListener("click", () => { strip.remove(); openEscalation(); });
    strip.appendChild(fix);
    const no = document.createElement("button");
    no.className = "ghost small";
    no.innerText = "Dismiss";
    no.addEventListener("click", () => strip.remove());
    strip.appendChild(no);
    const chatEl = $("chat");
    if (chatEl) { chatEl.appendChild(strip); scrollToBottom(true); }
}

/* THE PROVIDER'S OWN VERDICT ON THE MODEL THAT JUST ANSWERED. Shown once per
 * session+kind: a retired serving (the class that answers a clean 200 with
 * nothing in it) or one that publishes no tool calling, which cannot run the
 * agent loop at all. Both are facts the host publishes; neither was surfaced
 * anywhere before, so the operator met them as unexplained silence. */
const modelNoticeSeen = new Set();
function showModelNotice(notice, session) {
    if (!notice || !notice.kind) return;
    const key = (session && session.id) + "|" + notice.kind + "|" + notice.model;
    if (modelNoticeSeen.has(key)) return;
    modelNoticeSeen.add(key);
    const strip = document.createElement("div");
    strip.className = "model-offer route-broken";
    const txt = document.createElement("span");
    txt.className = "model-offer-text";
    txt.innerText = notice.text;
    strip.appendChild(txt);
    const pick = document.createElement("button");
    pick.className = "primary small";
    pick.innerText = notice.replacedBy ? "Choose another model" : "Choose a model";
    pick.addEventListener("click", () => { strip.remove(); openModelMenu(); });
    strip.appendChild(pick);
    const no = document.createElement("button");
    no.className = "ghost small";
    no.innerText = "Dismiss";
    no.addEventListener("click", () => strip.remove());
    strip.appendChild(no);
    const chatEl = $("chat");
    if (chatEl) { chatEl.appendChild(strip); scrollToBottom(true); }
}

async function openSessionPerms() {
    if (!active) return;
    // THE SHEET BELONGS TO THE SESSION IT OPENED FOR. `active` can change
    // under an open modal (Ctrl+N, a notification click) — every write below
    // uses this captured id, never the live global, or a flip lands on a
    // different conversation than the one whose state is on screen.
    const sid = active.id;
    const wrap = document.createElement("div");
    wrap.className = "pref-wrap";

    // OPEN FIRST, FILL IMMEDIATELY AFTER. The sheet used to be fully built —
    // including a capabilityMap call that stats every model on disk — before
    // the modal ever showed, which is the "takes too long to open" report.
    // The modal opens on this placeholder now; both fetches run in parallel
    // (and the tool list comes from the cheap lcl:toolGroups, not the map).
    wrap.appendChild(loadingNote("reading this conversation's permissions…"));
    const closed = modal({ title: "Permissions", node: wrap,
                           confirmLabel: "Close", confirmOnly: true, size: "wide" });

    const [state, tg] = await Promise.all([
        window.lcl.sessionPerms(sid).catch(() => null),
        window.lcl.toolGroups().catch(() => null)
    ]);
    wrap.innerHTML = "";
    if (!state || !state.ok) {
        const e = document.createElement("div");
        e.className = "pref-note";
        e.innerText = (state && state.error) || "could not read this session's permissions";
        wrap.appendChild(e);
        await closed;
        return;
    }

    const dest = state.destination;
    const iso = state.isolation || {};

    // WHERE THE WORDS GO — stated once, at the top, because it is the fact
    // that changes what every switch below actually means.
    const where = document.createElement("div");
    where.className = "perm-dest " + (dest ? (dest.owned ? "owned" : "third") : "owned");
    where.innerText = dest
        ? (dest.owned
            ? `This conversation is answered by ${dest.label}. Nothing leaves hardware you control.`
            : `This conversation is answered by ${dest.label} — a third party. ` +
              "Anything sent there is out of your hands once it arrives.")
        : "This conversation is answered by a model on this computer. Nothing leaves it.";
    wrap.appendChild(where);

    // THE PER-SESSION RISK SECTION — colour-coded, item by item, from the same
    // state. This is the dedicated section the operator asked for, living in the
    // permissions container; the always-visible surface is the shield colour on
    // the composer. paintRiskPanel finds this host by id and rebuilds it on every
    // risk change (a perm toggle, a model switch), so an open sheet never goes
    // stale.
    const riskHost = document.createElement("div");
    riskHost.id = "session-risk-panel";
    wrap.appendChild(riskHost);
    riskPanelHost = riskHost;                          // held by reference, not id
    riskPanelSid = sid;                                // pinned to this session
    try { paintRiskPanel(state.risk); } catch { /* best-effort section */ }

    // THE BOUNDARY, IN ONE LINE. This panel is the place you flip a
    // permission, and it was carrying a full essay about the sandbox — proof
    // narrative, writable-path caveats, a file inventory — permissions were
    // launching a whole page instead of a simple dropdown.
    // The essay now lives behind the line: click it and the whole story
    // arrives in a copyable dialog, instead of standing between you and the
    // switches every single time.
    {
        const bx = document.createElement("div");
        bx.className = "perm-boundary " + (iso.strong ? (iso.verified ? "proven" : "claimed") : "weak");
        bx.innerText = iso.strong
            ? (iso.verified ? "Scripts run behind a tested boundary — details"
                            : "Scripts run behind a boundary (not tested yet) — details")
            : "No real script boundary on this computer — details";
        // INLINE, not a second modal — modal() queues behind the open sheet,
        // so a dialog here never appeared until the sheet closed (the click
        // read as dead). The story expands right under the line instead.
        bx.title = "Click for the full story";
        const detail = document.createElement("div");
        detail.className = "perm-boundary-detail hidden";
        {
            const parts = [iso.detail || ""];
            if (iso.proof) parts.push("How it was tested: " + iso.proof);
            if (iso.offer) parts.push(iso.offer.why + " To get it: " + iso.offer.how);
            if (state.sandboxRoot) parts.push("Scratch folder: " +
                ((state.box && state.box.dir) || state.sandboxRoot));
            detail.innerText = parts.filter(Boolean).join("\n\n");
        }
        bx.addEventListener("click", () => detail.classList.toggle("hidden"));
        wrap.appendChild(bx);
        wrap.appendChild(detail);
    }

    const rowFor = (item) => {
        const row = document.createElement("div");
        row.className = "perm-row";

        const text = document.createElement("div");
        text.className = "perm-text";
        const t = document.createElement("div");
        t.className = "perm-title";
        // A destination-aware switch names WHERE the words go, using its OWN
        // title — the old code hardcoded "Send secrets and keys to {label}" for
        // EVERY destination-aware item, so the profile switch ("Send what it has
        // learned about you") also read "Send secrets and keys to spark": one
        // title on two switches, the duplicate the operator flagged. And .lcl is
        // DEVICE-AGNOSTIC: an owned destination reads "your local node" (with the
        // recognised name in parentheses), never a bare product name.
        if (item.destinationAware && dest) {
            const dphrase = dest.owned
                ? (dest.label ? `your local node (${dest.label})` : "your local node")
                : dest.label;
            t.innerText = item.title.replace(/\b(the model|a paid model)\b/, dphrase);
        } else {
            t.innerText = item.title;
        }
        text.appendChild(t);

        const sub = document.createElement("div");
        sub.className = "perm-sub";
        if (item.key === "writeMode") {
            sub.innerText = "The app default is currently " +
                (state.appWriteMode === "confirm"
                    ? "ask before every change." : "make the change, then tell you.");
        } else if (item.key === "selfReview") {
            sub.innerText = (item.note || "") + " The app default is currently " +
                (state.appSelfReview ? "on." : "off.");
        } else if (item.key === "requireIsolation") {
            sub.innerText = iso.strong
                ? `This computer can isolate scripts using ${iso.kind}.`
                : "This computer has no sandbox available, so turning this on " +
                  "stops scripts entirely" +
                  (iso.offer ? `. To get one: ${iso.offer.how}.` : ".");
        } else {
            sub.innerText = state.perms[item.key] ? item.on : item.off;
        }
        text.appendChild(sub);

        // THE EDGE OF THE GUARANTEE, where one exists. A switch that implies
        // more protection than it delivers is worse than no switch.
        if (item.limit) {
            const lim = document.createElement("div");
            lim.className = "perm-limit";
            lim.innerText = item.limit;
            text.appendChild(lim);
        }
        row.appendChild(text);

        if (item.choices) {
            const sel = document.createElement("select");
            sel.className = "cap-level auto";
            for (const c of item.choices) {
                const o = document.createElement("option");
                // a BOOLEAN choice needs a distinguishable value: `false` and
                // `null` both stringify to falsy, and "off for this
                // conversation" is not the same answer as "follow the default"
                o.value = c.value === null ? "" : String(c.value);
                o.innerText = c.label;
                const cur = state.perms[item.key];
                const curStr = cur === null || cur === undefined ? "" : String(cur);
                if (curStr === o.value) o.selected = true;
                sel.appendChild(o);
            }
            sel.addEventListener("change", async () => {
                const v = sel.value === "" ? null
                    : sel.value === "true" ? true
                    : sel.value === "false" ? false : sel.value;
                const r = await window.lcl.setSessionPerm(sid, item.key, v)
                    .catch(() => null);
                sel.classList.add(r && r.ok ? "saved" : "save-failed");
                setTimeout(() => sel.classList.remove("saved", "save-failed"), 900);
                if (r && r.ok) { state.perms = r.perms; paintPermChip(); }
            });
            row.appendChild(sel);
        } else {
            const lab = document.createElement("label");
            lab.className = "sec-toggle";
            const box = document.createElement("input");
            box.type = "checkbox";
            box.checked = !!state.perms[item.key];
            const slider = document.createElement("span");
            slider.className = "sec-slider";
            box.addEventListener("change", async () => {
                // TURNING MULTI-STEP OFF IS THE EXCEPTION, AND IT IS WARNED
                // — INLINE, on the row. modal() queues behind the open sheet, so
                // an awaited confirm here never appeared: the switch flipped off
                // on screen while nothing was written (the switch lying), and the
                // orphaned dialog popped after the sheet closed. Two-step instead:
                // the first flip warns in the sub-line and holds; a second flip
                // within 6 seconds proceeds.
                if (item.key === "agentMode" && !box.checked) {
                    if (!box._offArmed) {
                        box._offArmed = true;
                        box.checked = true;   // nothing changed yet — say so
                        sub.innerText = "Ancient Knowledge and higher reasoning rely " +
                            "on multi-step planning. Flip again to turn it off anyway.";
                        setTimeout(() => {
                            box._offArmed = false;
                            if (box.checked) sub.innerText =
                                state.perms[item.key] ? item.on : item.off;
                        }, 6000);
                        return;
                    }
                    box._offArmed = false;
                }
                const r = await window.lcl.setSessionPerm(sid, item.key, box.checked)
                    .catch(() => null);
                if (r && r.ok) {
                    state.perms = r.perms;
                    sub.innerText = r.perms[item.key] ? item.on : item.off;
                    paintPermChip();
                } else {
                    box.checked = !box.checked;      // the switch never lies
                }
            });
            lab.appendChild(box); lab.appendChild(slider);
            row.appendChild(lab);
        }
        return row;
    };

    const head = (t) => {
        const h = document.createElement("div");
        h.className = "pref-head"; h.innerText = t; wrap.appendChild(h);
    };

    head("This conversation");
    for (const item of state.catalog) wrap.appendChild(rowFor(item));

    const note = document.createElement("div");
    note.className = "pref-note";
    note.innerText = "These apply to this conversation only, and take effect on " +
        "the next thing the model does. Every change is written to the activity log.";
    wrap.appendChild(note);

    // ---- LEAVES THIS MACHINE — the consent gate's own controls (the design
    // moved gating out of here entirely: it all lives in
    // Session > Permissions). What this conversation trusts, the app-wide
    // gate, and the waiting-ask notification — the three things the popup's
    // pointer promises are here.
    {
        head("Leaves this machine");
        const trusted = Array.isArray(state.trustedEndpoints) ? state.trustedEndpoints : [];
        if (trusted.length) {
            for (const te of trusted) {
                const row = document.createElement("div");
                row.className = "perm-row";
                const text = document.createElement("div");
                text.className = "perm-text";
                const t = document.createElement("div");
                t.className = "perm-title";
                t.innerText = "Trusted for this conversation: " + te.label;
                text.appendChild(t);
                const sub = document.createElement("div");
                sub.className = "perm-sub";
                sub.innerText = "Calls to it send without asking. This grant belongs to " +
                    "this conversation and stays until you take it back here.";
                text.appendChild(sub);
                row.appendChild(text);
                const stop = document.createElement("button");
                stop.className = "ghost small";
                stop.innerText = "stop trusting";
                stop.addEventListener("click", async () => {
                    const r = await window.lcl.revokeTrustedEndpoint(sid, te.id)
                        .catch(() => null);
                    if (r && r.ok) {
                        sub.innerText = "Revoked — the next call to " + te.label +
                            " will ask again.";
                        stop.disabled = true;
                        // a trusted "sends to X" grant is a permission like any
                        // other — repaint the shield so it stops showing it
                        paintPermChip();
                    } else {
                        sub.innerText = "Could not revoke — try again.";
                    }
                });
                row.appendChild(stop);
                wrap.appendChild(row);
            }
        } else {
            const none = document.createElement("div");
            none.className = "perm-sub";
            none.innerText = "This conversation trusts no endpoint — every remote " +
                "call asks first.";
            wrap.appendChild(none);
        }

        // (THE ASK-FIRST SWITCH IS NOT HERE ANY MORE, because it is not a
        // switch about this panel — it is this conversation's own permission,
        // "Ask before this conversation sends anything out", and it renders
        // with the rest of them above. What used to sit here was the app-wide
        // cloudAutoApprove: one toggle reaching into every conversation on the
        // machine, including ones not created yet.)

        // the waiting-ask notification (the tray/OS toast), with its off-switch
        {
            const row = document.createElement("div");
            row.className = "perm-row";
            const text = document.createElement("div");
            text.className = "perm-text";
            const t = document.createElement("div");
            t.className = "perm-title";
            t.innerText = "Notify when an ask is waiting";
            text.appendChild(t);
            const sub = document.createElement("div");
            sub.className = "perm-sub";
            sub.innerText = state.consentNotify
                ? "A leave-machine ask raises a system notification when the " +
                  "window is not being watched. Clicking it opens the session."
                : "Off — a waiting ask stays silent until you look at the window.";
            text.appendChild(sub);
            row.appendChild(text);
            const lab = document.createElement("label");
            lab.className = "sec-toggle";
            const box = document.createElement("input");
            box.type = "checkbox";
            box.checked = !!state.consentNotify;
            const slider = document.createElement("span");
            slider.className = "sec-slider";
            box.addEventListener("change", async () => {
                const r = await window.lcl.setBehavior("consentNotify", box.checked)
                    .catch(() => null);
                if (r && r.ok) {
                    state.consentNotify = box.checked;
                    sub.innerText = box.checked
                        ? "A leave-machine ask raises a system notification when " +
                          "the window is not being watched."
                        : "Off — a waiting ask stays silent until you look at the window.";
                } else {
                    box.checked = !box.checked;
                }
            });
            lab.appendChild(box); lab.appendChild(slider);
            row.appendChild(lab);
            wrap.appendChild(row);
        }
    }

    // ---- TOOL GROUPS, one slider each ----
    // The requirement: with permissions grouped, one main group toggle for all
    // of them — fewer dropdown options, just allowed or not allowed, with a
    // slider toggle as the initiator. So: no master dial, no
    // per-tool dials, no 5-option dropdowns — one row per GROUP with a slider.
    // ON sets every tool in the group to allow (the kernel's fixed floors
    // still clamp — an EXECUTE tool keeps asking, which the sub-line says);
    // OFF denies the whole group for this conversation.
    head("Tools");
    {
        const snap = tg;   // prefetched in parallel with the session state
        const overrides = (state.toolPolicy && typeof state.toolPolicy === "object")
            ? state.toolPolicy : {};
        if (!snap || !snap.toolGroups) {
            const e = document.createElement("div");
            e.className = "pref-note";
            e.innerText = "could not read the tool catalog";
            wrap.appendChild(e);
        } else {
            const applyOne = (toolName, level) =>
                window.lcl.setSessionToolPolicy(sid, toolName, level)
                    .then(r => !!(r && r.ok)).catch(() => false);

            for (const g of snap.toolGroups) {
                const tools = g.tools;
                // effective level per tool: this session's override, else the
                // app default the catalog reports
                const effOf = (t) => overrides[t.name] || t.level;
                const deniedCount = tools.filter(t => effOf(t) === "deny").length;
                const allowed = deniedCount < tools.length; // any life = on
                const floored = tools.filter(t => t.floor === "confirm").length;

                const row = document.createElement("div");
                row.className = "perm-row";
                const text = document.createElement("div");
                text.className = "perm-text";
                // no count on the row — "(5)" implies five sub-settings to
                // adjust, and there is exactly one decision here: allowed or not
                const t = document.createElement("div");
                t.className = "perm-title";
                t.innerText = g.label;
                text.appendChild(t);
                const sub = document.createElement("div");
                sub.className = "perm-sub";
                const subText = (on, mixed) => on
                    ? (floored
                        ? `allowed — ${floored} of these always ask first, that floor is fixed`
                        : "allowed for this conversation")
                        + (mixed ? " · mixed levels right now; flipping the switch resets them" : "")
                    : "not allowed for this conversation";
                sub.innerText = subText(allowed, deniedCount > 0 && allowed);
                text.appendChild(sub);
                row.appendChild(text);

                const lab = document.createElement("label");
                lab.className = "sec-toggle";
                const box = document.createElement("input");
                box.type = "checkbox";
                box.checked = allowed;
                const slider = document.createElement("span");
                slider.className = "sec-slider";
                box.addEventListener("change", async () => {
                    box.disabled = true;
                    const level = box.checked ? "allow" : "deny";
                    let ok = true;
                    for (const tool of tools) ok = (await applyOne(tool.name, level)) && ok;
                    box.disabled = false;
                    if (!ok) {
                        // some writes may have landed before the failure — the
                        // switch position alone cannot tell that truth, so the
                        // sub-line does
                        box.checked = !box.checked;
                        sub.innerText = "partly applied — reopen this sheet to see the current state";
                        return;
                    }
                    sub.innerText = subText(box.checked, false);
                    sub.classList.add("saved");
                    setTimeout(() => sub.classList.remove("saved"), 900);
                });
                lab.appendChild(box); lab.appendChild(slider);
                row.appendChild(lab);
                wrap.appendChild(row);
            }
        }
    }

    await closed;   // the modal has been open since the first line
}

// THE RISK LADDER, mirrored in the renderer so the shield can colour itself.
// The authoritative computation is riskLevel.assess in the engine; this is only
// the ordering, for the "did the level rise?" comparison the warning uses.
const RISK_ORDER = ["green", "yellow", "orange", "red"];
const riskRank = (l) => Math.max(0, RISK_ORDER.indexOf(l));
// guards paintPermChip against out-of-order async resolution — a slow
// sessionPerms fetch must not paint a stale destination after a newer one
let permChipToken = 0;
// the last risk level seen for the active session, so a model change that
// raises exposure can be warned about at the MOMENT it changes (Part C)
let riskBaseline = { sessionId: null, level: null };
// the risk section's host element while the permissions sheet is open — a
// direct reference, not a $() lookup, because it is built on demand and does
// not exist in index.html. Cleared implicitly when the modal detaches it.
let riskPanelHost = null;
// the session the permissions sheet was opened FOR. If the active session flips
// under the open sheet (Ctrl+N, a notification jump), the sheet's banner and
// switch titles keep naming the ORIGINAL session, so the risk panel must too —
// otherwise the panel and the banner contradict each other. The composer shield
// still follows the live active session; only the sheet's panel is pinned.
let riskPanelSid = null;

function applyShieldRisk(btn, risk) {
    for (const l of RISK_ORDER) btn.classList.remove("risk-" + l);
    btn.classList.add("risk-" + ((risk && risk.level) || "green"));
}
function riskDestLine(risk) {
    const dest = risk && Array.isArray(risk.items) && risk.items.find(i => i.key === "destination");
    return dest ? dest.label : "";
}

/**
 * The chip on the composer row. Silent when this session runs on the strict
 * defaults; present, and counted, the moment it does not — a granted
 * permission you cannot see is one you forget you granted.
 *
 * It also carries the SESSION RISK COLOUR on the shield button, always — even
 * with nothing granted, because a third-party destination is exposure the
 * operator never "granted" but must still see. The colour comes from the same
 * lcl:sessionPerms call, which re-resolves the destination fresh every time, so
 * the shield can never be staler than the destination it was scored against.
 */

/**
 * FOLD PER-SESSION CAPABILITY GRANTS INTO THE RISK.
 *
 * The engine scores risk against the MODEL destination only (riskLevel.assess).
 * But a session can also leak through a per-session capability GRANT — "sends to
 * api.deepinfra.com" for a tool, an image route, or ancient-knowledge-as-an-API
 * — and those grants live only in renderer memory (sessionCapabilityGrants), so
 * main never sees them. Without this a session answered locally (green) that
 * granted a third-party route stayed green and the rise-warning could never
 * fire. Fold the grants in here, where the grant data lives, so the shield, the
 * panel and the warning all react to them. grant/revoke already call
 * paintPermChip, so the surface repaints when a grant changes.
 */
function augmentRiskWithGrants(risk, state, secretsOn) {
    if (!active) return risk;
    const hosts = [...capabilityGrantsFor(active.id)]
        .filter(k => k.startsWith("remote:")).map(k => k.slice(7)).filter(Boolean);
    if (!hosts.length) return risk;
    const destHost = state && state.destination && state.destination.host;
    const destOwned = !!(state && state.destination && state.destination.owned);
    // a grant to the user's own node / loopback is their hardware (green,
    // like the destination ladder); a third party is yellow, red when secrets are on
    const levelFor = (host) =>
        ((destOwned && destHost === host) || /^(localhost|127\.|\[?::1)/i.test(host))
            ? "green" : (secretsOn ? "red" : "yellow");
    let itemLevel = "green";
    for (const h of hosts) if (riskRank(levelFor(h)) > riskRank(itemLevel)) itemLevel = levelFor(h);
    const items = (risk && Array.isArray(risk.items)) ? risk.items.slice() : [];
    items.push({ key: "capabilityEgress", level: itemLevel,
        label: "A tool is allowed to send to " + hosts.join(", "),
        detail: secretsOn
            ? "This conversation granted a route to a third party, and secrets are on — a secret could leave that way."
            : "This conversation granted a tool or route that sends to a third party." });
    const base = (risk && risk.level) || "green";
    return { level: riskRank(itemLevel) > riskRank(base) ? itemLevel : base, items };
}

async function paintPermChip() {
    const el = $("composer-perms");
    const btn = $("session-perms-btn");
    if (!el || !btn) return;
    const clear = () => {
        el.innerText = "";
        btn.classList.remove("granted", "granted-wide");
        for (const l of RISK_ORDER) btn.classList.remove("risk-" + l);
        btn.title = "What this conversation is allowed to do";
    };
    if (!active) { riskBaseline = { sessionId: null, level: null }; return clear(); }
    const myToken = ++permChipToken;
    const on = [];

    // WHAT THE INLINE PROMPT GRANTED, on the same line as everything else this
    // conversation is allowed. A capability trusted by clicking "Allow for this
    // conversation" is a permission like any other, and the rule for all of
    // them is the same: a granted permission you cannot see is one you forget
    // you granted. Read first, so it still shows when the engine cannot answer
    // for the stored perms.
    for (const key of capabilityGrantsFor(active.id)) {
        on.push(key.startsWith("remote:") ? "sends to " + key.slice(7) : key);
    }

    const state = await window.lcl.sessionPerms(active.id).catch(() => null);
    // a newer paint started while this one awaited — drop this result, the
    // fresher one owns the surface now
    if (myToken !== permChipToken || !active) return;
    const p = (state && state.ok && state.perms) || {};
    // the engine scores the model destination; fold in this session's capability
    // egress grants (renderer-only) so the shield and warning see them too
    const risk = augmentRiskWithGrants((state && state.risk) || null, state, !!p.secrets);
    if (p.secrets) on.push("secrets");
    if (p.autoRun) on.push("runs scripts");
    if (p.writeMode === "confirm") on.push("asks before writes");
    if (p.requireIsolation) on.push("sandbox required");

    // the shield carries the risk colour whether or not anything is "granted"
    applyShieldRisk(btn, risk);
    // the dedicated per-session risk section, when the sheet is open
    try { paintRiskPanel(risk); } catch { /* the sheet may be closed */ }
    // warn at the moment exposure rises for THIS session (not on session switch)
    try { maybeWarnRiskRose(risk); } catch { /* a warning never breaks a paint */ }

    if (!on.length) {
        el.innerText = "";
        btn.classList.remove("granted", "granted-wide");
        btn.title = (risk && risk.level !== "green")
            ? "This conversation: " + riskDestLine(risk)
            : "What this conversation is allowed to do";
        return;
    }
    // the readout says WHAT, beside the workspace and knowledge readouts
    el.innerText = "allowed: " + on.join(" · ");
    // and the control itself shows it is holding something, the same way the
    // workspace button shows it is linked
    btn.classList.add("granted");
    btn.classList.toggle("granted-wide", p.secrets || p.autoRun);
    btn.title = ((risk && risk.level !== "green") ? riskDestLine(risk) + " · " : "")
        + "This conversation is allowed: " + on.join(", ");
}

/**
 * Warn the moment a session's exposure RISES — a model switch, a fallback, or
 * ancient knowledge becoming an API while secrets are on. Keyed on the active
 * session so switching sessions only resets the baseline, never warns; only a
 * genuine rise inside one conversation prompts, and only into red (a secret
 * that can now cross to a third party) is a hard, blocking acknowledgement.
 */
function maybeWarnRiskRose(risk) {
    if (!active || !risk || !risk.level) return;
    const same = riskBaseline.sessionId === active.id;
    const prev = same ? riskBaseline.level : null;
    riskBaseline = { sessionId: active.id, level: risk.level };
    if (!same || !prev) return;                       // just opened this session
    if (riskRank(risk.level) <= riskRank(prev)) return; // no rise
    const sec = Array.isArray(risk.items) && risk.items.find(i => i.key === "secrets");
    if (risk.level === "red" && sec) {
        // a secret can now leave to a third party — block until acknowledged
        modal({
            title: "This conversation now sends secrets off your machine",
            message: sec.detail || "A detected secret can now leave to a third party.",
            detail: "You switched to a destination that is not your own hardware, and " +
                "“Send secrets and keys” is on for this conversation. Turn it off to keep " +
                "secrets on this machine, or continue if you meant to.",
            confirmLabel: "Continue — I meant to",
            cancelLabel: "Turn secrets off"
        }).then((ok) => {
            if (!ok) window.lcl.setSessionPerm(active.id, "secrets", false)
                .then(() => paintPermChip()).catch(() => {});
        }).catch(() => {});
    } else if (riskRank(risk.level) >= riskRank("orange")) {
        addNotice(`This conversation is now ${risk.level}: ${riskDestLine(risk)}.`);
    }
}

/**
 * The per-session RISK SECTION inside the permissions sheet — each item a
 * colour-coded row in plain words. Painted only when the sheet is open; the
 * always-visible surface is the shield colour above. Rebuilt on every risk
 * change so an open sheet can never go stale.
 */
function paintRiskPanel(risk) {
    const host = riskPanelHost;
    if (!host || !host.isConnected) return;           // sheet not open
    // the sheet is pinned to the session it opened for; if the active session
    // flipped under it, do not overwrite the panel with a different session's
    // risk (the banner and titles above it still name the original)
    if (riskPanelSid && active && active.id !== riskPanelSid) return;
    host.innerHTML = "";
    if (!risk || !Array.isArray(risk.items)) return;
    const head = document.createElement("div");
    head.className = "risk-head risk-" + (risk.level || "green");
    head.innerText = "This conversation: " + (risk.level || "green");
    host.appendChild(head);
    for (const it of risk.items) {
        const row = document.createElement("div");
        row.className = "risk-row risk-" + (it.level || "green");
        const label = document.createElement("div");
        label.className = "risk-row-label";
        label.innerText = it.label || "";
        const detail = document.createElement("div");
        detail.className = "risk-row-detail";
        detail.innerText = it.detail || "";
        row.appendChild(label);
        row.appendChild(detail);
        host.appendChild(row);
    }
}

/**
 * The GitHub connected-account card. Sign-in runs through the OS credential
 * manager's browser OAuth (no password ever handled here); connecting is also
 * the consent that lets git operations run without a confirm every time.
 */
async function renderGithubAccount(card) {
    card.innerHTML = "";
    const busy = document.createElement("div");
    busy.className = "pref-note";
    busy.innerText = "Checking GitHub…";
    card.appendChild(busy);

    const st = await window.lcl.githubStatus().catch(() => null);
    card.innerHTML = "";

    const row = document.createElement("div");
    row.className = "conn-account-row";
    const id = document.createElement("div");
    id.className = "conn-account-id";
    const mark = document.createElement("span");
    mark.className = "conn-account-mark";
    mark.innerText = "GitHub";
    id.appendChild(mark);
    const state = document.createElement("span");
    state.className = "conn-account-state";
    id.appendChild(state);
    row.appendChild(id);
    card.appendChild(row);

    const note = document.createElement("div");
    note.className = "pref-note";
    card.appendChild(note);

    if (!st || !st.installed) {
        state.innerText = "unavailable";
        state.classList.add("off");
        note.innerText = (st && st.note)
            || "Git Credential Manager was not found. Install Git for Windows (it includes it), then reopen this page.";
        return;
    }

    const accounts = st.accounts || [];
    const signedIn = accounts.length > 0;
    state.innerText = signedIn ? "connected" : "not connected";
    state.classList.toggle("on", signedIn);
    state.classList.toggle("off", !signedIn);

    if (signedIn) {
        note.innerText = "Signed in as " + accounts.join(", ") +
            ". Cloning uses this account; each conversation still approves git " +
            "actions the first time (Session › Permissions).";
        const out = document.createElement("button");
        out.className = "ghost small";
        out.innerText = "Disconnect";
        out.addEventListener("click", async () => {
            out.disabled = true; out.innerText = "signing out…";
            await window.lcl.githubDisconnect().catch(() => {});
            renderGithubAccount(card);
        });
        row.appendChild(out);
    } else {
        note.innerText = "Connect your GitHub account to clone and push private repositories. " +
            "A secure browser sign-in opens — no password is entered here.";
        const go = document.createElement("button");
        go.className = "primary small";
        go.innerText = "Connect GitHub…";
        go.addEventListener("click", async () => {
            go.disabled = true; go.innerText = "opening sign-in…";
            note.innerText = "A GitHub sign-in window is opening — authorise there, then this updates.";
            const r = await window.lcl.githubConnect().catch(e => ({ ok: false, error: String(e) }));
            if (r && !r.ok && r.state !== "closed") {
                note.innerText = (r.note || r.error || "Sign-in did not complete.") ;
            }
            renderGithubAccount(card);
        });
        row.appendChild(go);
    }
}

async function openConnections() {
    const wrap = document.createElement("div");
    wrap.className = "pref-wrap";
    // every section is its own container on this page
    let cur = wrap;
    const head = (t) => { const sec = document.createElement("div");
        sec.className = "conn-mod";
        const h = document.createElement("div");
        h.className = "pref-head"; h.innerText = t;
        sec.appendChild(h); wrap.appendChild(sec); cur = sec; };
    const note = (t) => { const n = document.createElement("div");
        n.className = "pref-note"; n.innerText = t; cur.appendChild(n); };

    {
        const p = document.createElement("div");
        p.className = "pref-note pref-purpose";
        p.innerText = "This page is the wiring: link an endpoint, hold its key, " +
            "learn its models and rates, and arm the ask-before-every-remote-call " +
            "gate. Nothing here decides where a conversation's turns go. " +
            "Which model answers is the picker; whether a conversation may fall " +
            "back to a paid model is Session › Model Orchestration, per conversation.";
        wrap.appendChild(p);
    }

    // NETWORK ACCESS IS AUTOMATIC HERE — no toggle. Linking an API inherently
    // uses the network, so it turns on when you connect an endpoint (below);
    // this card just says so. Secrets from your files are blocked from leaving
    // either way. (Per the design, network access is automatic and surfaced
    // as a toast notification card rather than a toggle.)
    head("APIs");
    {
        const toast = document.createElement("div");
        toast.className = "orch-toast";
        toast.innerText = "Linking an API uses the network — it turns on automatically " +
            "when you connect one below. Your files' secrets are blocked from leaving " +
            "either way, and each conversation still decides for itself whether it may " +
            "call out (Session › Permissions).";
        cur.appendChild(toast);
    }
    await renderApiSection(cur, openConnections);

    // ---- Connected accounts: GitHub, signed in through the OS credential
    //      manager. "essentially a storage account." ----
    head("Connected accounts");
    {
        const card = document.createElement("div");
        card.className = "conn-account";
        cur.appendChild(card);
        renderGithubAccount(card);
    }


    // ---- Local nodes: the DGX Spark, driven from here ----
    head("Local machines");
    // THE WIZARD IS THE FRONT DOOR. Everything below it is the manual path,
    // which is what the operator had to use all day — finding a button,
    // guessing the order, discovering only afterwards that remote access can
    // only be installed while on the same network.
    {
        const go = document.createElement("button");
        go.className = "primary small";
        go.innerText = "Add Local Node\u2026";
        go.title = "Finds any machine on this network, whoever made it, and sets " +
            "it up end to end.";
        go.addEventListener("click", () => { closeModal(true); openNodeWizard(); });
        cur.appendChild(go);
    }
    const nodesEl = document.createElement("div");
    cur.appendChild(nodesEl);

    let nodeSig = null;
    const paintNodes = async (quiet = false) => {
        if (!quiet) {
            nodesEl.innerHTML = "";
            nodesEl.appendChild(loadingNote("checking your machines…"));
        }
        let res = null;
        // a person opening the dialog or pressing Refresh means "check NOW" —
        // that bypasses the probe governor's hold; the 5s background poll
        // stays quiet and cheap
        try { res = await window.lcl.nodes(!quiet); } catch { /* below */ }
        const nodes = (res && res.nodes) || [];
        // WHAT CHANGED, not how long since. Turning a VPN off does not
        // restore the tailnet instantly — measured on this machine at 35s
        // once and over 4 MINUTES another time — so the honest design is to
        // keep looking and repaint the moment the state actually moves.
        const sig = JSON.stringify(nodes.map(n => [n.id, n.ssh,
            (n.serving || []).map(x => [x.port, x.via || null]),
            n.hasDoor, n.doorOk, n.route || null]));
        if (quiet && sig === nodeSig) return;
        nodeSig = sig;
        nodesEl.innerHTML = "";
        // true (not a string) when a block is real but unattributable — the
        // messages read "Something on this machine" rather than inventing a
        // culprit or, worse, keeping the last one it ever saw
        const vpn = res && res.vpn && res.vpn.active ? (res.vpn.name || true) : null;
        if (!nodes.length) {
            const empty = document.createElement("div");
            empty.className = "eng-empty";
            // Just the fact. "pick one from the machines below" pointed at a
            // list whose own message, on a first run, is that it is empty —
            // the discovery list carries the instruction, once, where it
            // is true.
            empty.innerText = "No machines added yet.";
            nodesEl.appendChild(empty);
        }
        for (const n of nodes) {
            const row = document.createElement("div");
            row.className = "eng-item";
            const info = document.createElement("div");
            const nm = document.createElement("div");
            nm.className = "eng-host";
            nm.innerText = n.name;
            const meta = document.createElement("div");
            meta.className = "eng-meta";
            // THE META IS THE PAYLOAD, NOT THE NARRATION.
            //
            // "STOP DUPLICATING. One fact, one place." This line used to be a
            // second, hand-written copy of the state machine the badge below
            // it already renders — and the two disagreed (an unconfirmed
            // machine read "not reachable" here and "here and answering" two
            // lines down). Now it carries only what nodeState does not: the
            // served labels, ports and model counts, and the one door-specific
            // readout. The VPN story is told ONCE, by the banner over the pane.
            meta.innerText = n.serving && n.serving.length
                ? `serving ${n.serving.map(x => `${x.label} :${x.port}` +
                      (x.models ? ` (${x.models} models)` : "")).join(", ")}` +
                  (n.hasDoor ? " · remote access on" : "")
                : n.doorOk
                    // direct path dead, door answering: WORKING, not broken
                    ? "reachable through remote access"
                : n.hasDoor && n.ssh && n.ssh !== "ok"
                    ? "remote access is not answering either — is it powered on?"
                    : "";
            info.appendChild(nm); info.appendChild(meta);
            // WHERE THIS MACHINE STANDS, AND WHAT IS NEXT. Every row carries
            // it, so nothing about this list has to be interpreted.
            info.appendChild(nodeStateEl(n, { vpn }));
            const acts = document.createElement("div");
            acts.className = "kb-actions node-acts";
            // the icon buttons share their own line, under the primary action
            const iconRow = document.createElement("div");
            iconRow.className = "node-acts-icons";
            // NO "LINK MODELS" BUTTON. A machine that serves models has its
            // models — the refresh links them on sight and re-reads whenever
            // the node's own count changes. The only reason to press anything
            // here is impatience, and Refresh already covers that.
            if (n.serving && n.serving.length) {
                /* nothing to press */
            } else if (n.ssh === "ok") {
                const setup = document.createElement("button");
                setup.className = "primary small";
                setup.innerText = "Set up server";
                setup.title = "Installs Ollama on the node. A terminal opens for the node's password.";
                setup.addEventListener("click", async () => {
                    const r = await window.lcl.nodeSetup(n.id).catch(() => null);
                    meta.innerText = (r && (r.note || r.error)) || "launching…";
                });
                acts.appendChild(setup);
            }
            // THE DOOR CONTROL IS NEVER HIDDEN.
            //
            // It used to require ssh === "ok". When a node is SERVING, the ssh
            // result is not shown anywhere — so a failing probe removed the
            // button and printed no reason, and the button became unfindable
            // for reasons invisible to everyone including me. Four releases
            // were spent guessing at it. A control the user is looking for is
            // always drawn; if it cannot work yet it says why, in words that
            // can be copied.
            if (!n.hasDoor || n.doorStale) {
                // ONE BUTTON, ONE OUTCOME.
                //
                // This row used to offer "Install door" AND "Enable Funnel",
                // side by side. Reported: two buttons here are confusing — it is
                // not clear which one is needed. Correct — those are two internal steps of one
                // goal, and "door" is a word this product invented that nobody
                // should have to learn. The goal is remote access. It is one
                // button, and it carries out whichever steps remain, including
                // opening Tailscale's approval page itself.
                const door = document.createElement("button");
                door.className = "primary small";
                // THE LABEL CARRIES THE TIMING, because the timing is the only
                // part that cannot be recovered later. An ellipsis because it
                // opens the wizard, where what/why/when are stated together
                // rather than split between a button and a tooltip nobody hovers.
                // THE LABEL CARRIES THE REASON. "Set up while on this network"
                // stated the timing, which is meaningless until you know what
                // you get: right now this machine works only while you are on
                // its network. That is the why. The timing lives on the row.
                // AN UNFINISHED SETUP IS FINISHED, NOT RESTARTED. When the
                // door is already on the machine and only publishing is left,
                // "Set up to use from anywhere…" asks the operator to redo a
                // thing they did — and hides that the remaining step is one
                // click. Reported after exactly that happened.
                const halfDone = !!(n.relayPending || n.funnelEnableUrl);
                door.innerText = halfDone ? "Finish remote access"
                    // an existing door BEHIND this build needs updating, not
                    // setting up — saying "set up" over a thing already set up
                    // is how it stayed invisible
                    : n.hasDoor ? "Update remote access"
                    : "Set up to use from anywhere…";
                // No tooltip. The state block on this row already states what
                // this buys, when it can be done, and — when disabled — why.
                // A tooltip restating it was one of the "four separate places".
                //
                // "unconfirmed" must NOT disable this — confirming the machine is
                // literally the first thing the wizard does, so disabling the
                // button locks the user out of the fix.
                if (n.ssh && n.ssh !== "ok" && n.ssh !== "unconfirmed") {
                    door.disabled = true;
                }
                // ONE EXPLAINED PATH. This used to run the install straight from
                // the row, so the action happened without the reason or the
                // timing — both of which live in the wizard. A row button that
                // acts silently is how a whole day got lost to not knowing the
                // window existed. It opens the wizard instead.
                door.addEventListener("click", async () => {
                    // NOTHING LEFT TO EXPLAIN, SO NOTHING TO WALK THROUGH.
                    // When only publishing remains the wizard has no question
                    // to ask — and the machine may only be reachable for
                    // seconds. Press it and it is done, or recorded and done
                    // by itself later.
                    if (!halfDone) {
                        closeModal(true);
                        openNodeWizard({ address: n.host, name: n.name,
                                         user: n.user, node: n });
                        return;
                    }
                    door.disabled = true;
                    meta.innerHTML = "";
                    meta.appendChild(loadingNote("finishing remote access…"));
                    const r = await window.lcl.nodeArmFinish(n.id)
                        .catch(e => ({ error: String(e && e.message || e) }));
                    door.disabled = false;

                    // THE PASSWORD STEP, CARRIED THROUGH INSTEAD OF DROPPED.
                    //
                    // provisionDoor reports needsPassword when Tailscale
                    // refuses to publish for a non-root user, and this row
                    // threw that away — it only looked at `published`. So
                    // pressing Finish did the whole install, hit the operator
                    // wall, and reported "saved" with nothing left to press.
                    // Observed: clicking Finish for remote access loaded and
                    // then finished with no result to show for it.
                    // Pressing Finish IS the consent for this step, so
                    // the prompt opens straight away rather than adding a
                    // second button to hunt for.
                    if (r && r.needsPassword) {
                        const port = (n.serving && n.serving[0] && n.serving[0].port) || 11434;
                        const g = await window.lcl.nodeFunnelGrant(n.id, port)
                            .catch(e => ({ error: String(e && e.message || e) }));
                        meta.innerText = (g && g.ok)
                            ? "A window opened asking for this machine's password. " +
                              "Type it there — it goes straight to the machine and is " +
                              "never seen here. This is needed once, ever."
                            : ((g && g.error) || "could not open the password prompt");
                        return;
                    }

                    meta.innerText = (r && (r.note || r.error))
                        || (r && r.published ? "remote access is ready" : "saved");
                    if (r && r.published) await paintNodes();
                });
                acts.appendChild(door);

                // The amber note that used to sit here restated the state
                // block in a third wording — every clause of it now lives in
                // exactly one nodeState branch, on this same row.

                // and say, on the row, whether SSH can currently carry it —
                // this line did not exist for a serving node, which is why the
                // real failure was never visible
                if (n.ssh && n.ssh !== "ok") {
                    const why = document.createElement("div");
                    why.className = "eng-meta node-ssh-why";
                    // labelled as what it is, in words — "ssh:" was a bare
                    // acronym fronting raw protocol output. The verbatim
                    // error stays: it is the copyable, searchable evidence.
                    why.innerText = "the machine's exact answer: " + n.ssh;
                    info.appendChild(why);
                }
            }
            const refresh = document.createElement("button");
            refresh.className = "ghost small icon-only";
            refresh.title = "Check this machine again";
            refresh.setAttribute("aria-label", "Check this machine again");
            refresh.innerHTML =
                '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
                'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
                'stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/>' +
                '<path d="M21 3v6h-6"/></svg>';
            // Refresh means refresh EVERYTHING. The block warning lives in the
            // discovery section, so refreshing one node left a stale accusation
            // on screen after the VPN was switched off — "nothing ever updates
            // in the ui ... if i close the connections page and reopen, this
            // message goes away".
            refresh.addEventListener("click", () => { paintNodes(); paintFound(); });
            const del = document.createElement("button");
            del.className = "ghost small danger-text icon-only";
            del.title = "Remove this machine";
            del.setAttribute("aria-label", "Remove this machine");
            del.innerHTML =
                '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
                'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
                'stroke-linejoin="round"><path d="M3 6h18"/>' +
                '<path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>' +
                '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>' +
                '<path d="M10 11v6M14 11v6"/></svg>';
            del.addEventListener("click", async () => {
                await window.lcl.nodeRemove(n.id).catch(() => null);
                paintNodes();
                pollNodeBars();          // the sidebar gauge goes with it, now
            });
            // A SECOND, STATE-INDEPENDENT DOOR TO THE DASHBOARD.
            //
            // The full instrumentation was reachable from exactly one place:
            // the machine's sidebar gauge — which is REMOVED the moment the
            // machine stops answering, and gone entirely while the sidebar is
            // collapsed. So the readout you need when a machine goes wrong
            // disappeared precisely when it went wrong, and Connections, the
            // pane for managing machines, had no way in.
            const dash = document.createElement("button");
            dash.className = "ghost small icon-only";
            dash.title = "Open this machine's dashboard";
            dash.setAttribute("aria-label", "Open this machine's dashboard");
            // a HERO-CARD glyph — the little window panes of a dashboard
            // (one wide tile over two small ones), which is what the button
            // opens. "a hero card svg is an svg that has little cubes …
            // indicative of windows on a dashboard."
            dash.innerHTML =
                '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
                'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
                'stroke-linejoin="round">' +
                '<rect x="3" y="4" width="18" height="7" rx="1.5"/>' +
                '<rect x="3" y="14" width="8" height="6" rx="1.5"/>' +
                '<rect x="14" y="14" width="7" height="6" rx="1.5"/></svg>';
            dash.addEventListener("click", () => { closeModal(true); openNodeDash(n); });
            iconRow.appendChild(dash);
            // MODELS AND SOFTWARE FOR THIS MACHINE, from this machine's card.
            const manage = document.createElement("button");
            manage.className = "icon-btn";
            manage.title = "Models and software on " + (n.name || n.host);
            manage.setAttribute("aria-label", manage.title);
            // stacked weights: what this page is for
            manage.innerHTML =
                '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
                'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
                'stroke-linejoin="round">' +
                '<path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z"/>' +
                '<path d="M3 12.5 12 17l9-4.5"/>' +
                '<path d="M3 17.5 12 22l9-4.5"/></svg>';
            manage.addEventListener("click", () => {
                closeModal(true);
                openModelLibrary({ nodeId: n.id, nodeName: n.name || n.host });
            });
            iconRow.appendChild(manage);
            iconRow.appendChild(refresh); iconRow.appendChild(del);
            acts.appendChild(iconRow);
            const kinds = document.createElement("div");
            kinds.className = "eng-kinds";
            for (const k of [["text", "Language"], ["image", "Image"],
                             ["video", "Video"], ["audio", "Audio"],
                             ["software", "Software"]]) {
                const c = document.createElement("button");
                c.className = "eng-kind";
                c.innerText = k[1];
                c.title = k[1] + " on " + (n.name || n.host);
                c.addEventListener("click", () => {
                    closeModal(true);
                    openModelLibrary({ nodeId: n.id, nodeName: n.name || n.host,
                                       kind: k[0] });
                });
                kinds.appendChild(c);
            }
            info.appendChild(kinds);
            row.appendChild(info); row.appendChild(acts);
            nodesEl.appendChild(row);
        }
    };
    // NOT awaited: node probes cost seconds each and the dialog used to pay
    // all of them before appearing at all — "things that take like 15 seconds
    // to open". The dialog opens NOW; rows land when the probes answer.
    paintNodes();

    // A LIST TO CLICK, NOT AN ADDRESS TO PASTE.
    //
    // The first version asked for a hostname in a box hinted "spark-xxxx.local"
    // — and the correct answer turned out to be a Tailscale IP the user never
    // chose and had no reason to know. Two failures at once: the hint
    // contradicted the answer, and the answer was a number instead of the name
    // they gave the machine. Tailscale and NVIDIA Sync both already know the
    // name, the address and whether it is online. So the app asks THEM.
    const found = document.createElement("div");
    cur.appendChild(found);

    let foundSig = null;
    const paintFound = async (quiet = false) => {
        if (!quiet) {
            found.innerHTML = "";
            found.appendChild(loadingNote("looking for machines you can reach…"));
        }
        let res = null;
        try { res = await window.lcl.discoverNodes(); } catch { /* below */ }
        const cands = ((res && res.candidates) || []).filter(c => !c.added);
        const vpn = res && res.vpn && res.vpn.active ? (res.vpn.name || true) : null;
        // THE SECOND WARNING CLEARS ITSELF TOO. Only the node row was on the
        // live poll, so switching the VPN off resolved the row and left this
        // block still accusing it — a stale nuisance sitting under a row that
        // had already corrected itself.
        const sig = JSON.stringify([vpn, cands.map(c => [c.address, c.serving.length])]);
        if (quiet && sig === foundSig) return;
        foundSig = sig;
        found.innerHTML = "";
        // said ONCE, up front — a VPN that eats the probes makes every row
        // below read "no model server yet" for reasons that are not the row's
        if (vpn) {
            const w = document.createElement("div");
            w.className = "pref-note nd-vpn-note";
            w.innerText = (vpn === true ? "Something on this machine" : vpn) +
                " is refusing connections to the private network your " +
                "machines share — ordinary internet " +
                "still works, so this is a local filter (usually a VPN kill " +
                "switch), not your network. Machines with remote access set up " +
                "keep working through it. A machine without it can only be set " +
                // IT DOES NOT DO THIS BY ITSELF, so it must not say it will.
                // "it makes it sound like .lcl will do this automatically,
                //  without user directions, or engagement." Publishing needs
                // the machine reachable and, once, its password.
                "up from this row, the next time you are on its network.";
            // NO SECOND BUTTON. Refresh on the node row already repaints this
            // warning along with everything else, so a re-probe control beside
            // it duplicated a control that exists — the exact clutter this
            // pass is here to remove.
            found.appendChild(w);
        }
        if (!cands.length) {
            const n = document.createElement("div");
            n.className = "pref-note";
            n.innerText = "No machines found on this network. Power the machine on, plug it in here, and rescan.";
            found.appendChild(n);
            return;
        }
        const h = document.createElement("div");
        h.className = "pref-note";
        h.innerText = "Machines you can reach — click one to add it:";
        found.appendChild(h);
        for (const c of cands) {
            const b = document.createElement("button");
            b.className = "node-candidate";
            const nm = document.createElement("span");
            nm.className = "node-cand-name";
            nm.innerText = c.name;
            const meta = document.createElement("span");
            meta.className = "node-cand-meta";
            const alias = (c.alsoKnownAs || []).length
                ? ` · also ${c.alsoKnownAs.join(", ")}` : "";
            meta.innerText = (c.serving.length
                ? `serving ${c.serving.map(x => x.label).join(", ")} · ${c.address}`
                : `${c.os || "machine"} · ${c.address} · no model server yet`) + alias;
            const via = document.createElement("span");
            via.className = "node-cand-via";
            via.innerText = c.via === "tailscale" ? "tailscale" : "nvidia sync";
            b.appendChild(nm); b.appendChild(meta); b.appendChild(via);
            // no tooltip: the name and address are already on the row at full
            // size, and the header supplies the verb for the whole list
            b.addEventListener("click", async () => {
                b.disabled = true;
                // the NAME the user gave the device is what gets stored and shown;
                // the address is plumbing
                const r = await window.lcl.nodeAdd({ host: c.address, name: c.name })
                    .catch(() => null);
                // the sidebar gauge appears NOW, not on the next poll tick
                if (r && r.ok) { pollNodeBars(); await paintNodes(); await paintFound(); }
                else b.disabled = false;
            });
            found.appendChild(b);
        }
    };
    paintFound();                        // same: paint when discovery answers

    // Manual entry stays, for a machine neither system knows about.
    const manual = document.createElement("details");
    manual.className = "node-manual";
    const sum = document.createElement("summary");
    sum.innerText = "Add one by address instead";
    manual.appendChild(sum);
    const addRow = document.createElement("div");
    addRow.className = "cloud-paste-box";
    const hostIn = document.createElement("input");
    hostIn.className = "cloud-paste";
    hostIn.placeholder = "hostname or IP — e.g. my-box.local or 192.168.1.50";
    hostIn.spellcheck = false;
    const userIn = document.createElement("input");
    userIn.className = "cloud-paste node-user";
    userIn.placeholder = "ssh username (leave blank if NVIDIA Sync paired it)";
    userIn.spellcheck = false;
    const addBtn = document.createElement("button");
    addBtn.className = "primary";
    addBtn.innerText = "Add";
    addBtn.addEventListener("click", async () => {
        if (!hostIn.value.trim()) return;
        addBtn.disabled = true;
        const r = await window.lcl.nodeAdd({ host: hostIn.value, user: userIn.value })
            .catch(() => null);
        addBtn.disabled = false;
        if (r && r.ok) {
            hostIn.value = ""; userIn.value = "";
            pollNodeBars();              // sidebar gauge appears immediately
            paintNodes(); paintFound();
        }
    });
    addRow.appendChild(hostIn); addRow.appendChild(userIn); addRow.appendChild(addBtn);
    manual.appendChild(addRow);
    cur.appendChild(manual);
    // The value proposition only. What the Link button does is stated by the
    // row that carries the Link button ("A control does not need a note under
    // it explaining the control").
    note("Your machine, your network, zero per-token cost.");

    // ---- SSH keys ---- a GLOBAL key generator: make a keypair, hold the
    // private half in logic, hand back the public half to reuse. Assigning a
    // key to a conversation lives in the session, not here.
    head("SSH keys");
    {
        const t = document.createElement("div");
        t.className = "orch-toast";
        t.innerText = "Generate a keypair here and copy its public half to wherever " +
            "it is trusted. The private key never leaves this machine. Choosing which " +
            "key a conversation uses is a session setting.";
        cur.appendChild(t);
    }
    const keyList = document.createElement("div");
    cur.appendChild(keyList);
    const paintKeys = async () => {
        keyList.innerHTML = "";
        let res = null;
        try { res = await window.lcl.sshKeys(); } catch { /* handled below */ }
        const keys = (res && res.keys) || [];
        if (!keys.length) {
            const empty = document.createElement("div");
            empty.className = "eng-empty";
            // just the fact — the private-key guarantee lives in the section
            // note, where it stays visible once keys exist and start mattering
            empty.innerText = "No keys yet.";
            keyList.appendChild(empty);
        }
        for (const k of keys) {
            const row = document.createElement("div");
            row.className = "eng-item";
            const info = document.createElement("div");
            const nm = document.createElement("div");
            nm.className = "eng-host"; nm.innerText = k.id;
            const meta = document.createElement("div");
            meta.className = "eng-meta";
            meta.innerText = `${k.type} · ${k.publicKey.slice(0, 34)}…`;
            meta.title = k.publicKey;
            info.appendChild(nm); info.appendChild(meta);
            const acts = document.createElement("div");
            acts.className = "kb-actions";
            const copy = document.createElement("button");
            copy.className = "ghost small"; copy.innerText = "Copy public key";
            copy.addEventListener("click", () => copyToClipboard(k.publicKey, copy));
            // NO "use in this session" here. Assigning a key to a conversation
            // is a SESSION matter and belongs in the session, not on this
            // app-wide page — the button was the out-of-place element the
            // operator flagged. This page GENERATES and holds keys; a
            // session picks one when it needs to reach a machine.
            const del = document.createElement("button");
            del.className = "ghost small icon-act icon-only danger-text";
            del.appendChild(ICONS.trash());
            del.title = "Delete this key";
            del.setAttribute("aria-label", del.title);
            del.addEventListener("click", async () => {
                const sure = await modal({ title: "Delete " + k.id + "?",
                    message: "Anything trusting this public key stops accepting it.",
                    confirmLabel: "Delete", danger: true });
                if (!sure) return;
                await window.lcl.sshKeyDelete(k.id).catch(() => null);
                paintKeys();
            });
            acts.appendChild(copy); acts.appendChild(del);
            row.appendChild(info); row.appendChild(acts);
            keyList.appendChild(row);
        }
    };
    await paintKeys();

    const genRow = document.createElement("div");
    genRow.className = "cloud-paste-box";
    const genName = document.createElement("input");
    genName.className = "cloud-paste";
    // a NEUTRAL example. The old one named a machine from the user's own
    // other projects — product text must never carry anything from the
    // operator's life, codebases or infrastructure.
    genName.placeholder = "key name, e.g. field-laptop";
    genName.spellcheck = false;
    const genBtn = document.createElement("button");
    genBtn.className = "primary";
    genBtn.innerText = "Generate key";
    genBtn.addEventListener("click", async () => {
        genBtn.disabled = true;
        const r = await window.lcl.sshKeygen(genName.value).catch(e =>
            ({ error: String(e && e.message || e) }));
        genBtn.disabled = false;
        genName.value = "";
        if (r && r.ok) paintKeys();
        else note("Could not generate: " + ((r && r.error) || "unknown error"));
    });
    genRow.appendChild(genName); genRow.appendChild(genBtn);
    cur.appendChild(genRow);
    // The two facts no row carries: provenance, and the private-key
    // guarantee. The key type is on every row; what the buttons do is on
    // the buttons.
    note("Generated by Windows' own OpenSSH. Private keys never leave this machine.");

    // ---- serial ports ----
    // A whole titled section that printed "No serial ports detected" on every
    // open, plus a roadmap sentence. It now appears ONLY when a port exists,
    // and says only what is there.
    const portsEl = document.createElement("div");
    portsEl.className = "pref-note hidden";
    cur.appendChild(portsEl);
    window.lcl.listComPorts().catch(() => null).then(r => {
        const ports = (r && r.ports) || [];
        if (!ports.length) return;
        portsEl.classList.remove("hidden");
        portsEl.innerText = "Serial ports: " + ports.join(", ");
    });

    /* ---- attached hardware ------------------------------------------------
     * "plug it in, tell the app it is connected, and have it see the device
     *  and read the device logic, then give me a detailed response."
     *
     * The button IS "tell the app it is connected" — an explicit action, not a
     * poll, because scanning the device tree and listening on a port is not
     * something to do to someone's bench every five seconds while a board is
     * mid-flash. What comes back names silicon or says it cannot.
     */
    head("Attached hardware");
    const devBtn = document.createElement("button");
    devBtn.className = "ghost";
    devBtn.innerText = "Scan for devices";
    devBtn.title = "Read what is plugged in. Never writes to, resets or flashes anything.";
    cur.appendChild(devBtn);
    const devOut = document.createElement("div");
    devOut.className = "dev-list hidden";
    cur.appendChild(devOut);

    devBtn.addEventListener("click", async () => {
        devBtn.disabled = true;
        devBtn.innerText = "Scanning…";
        devOut.classList.remove("hidden");
        devOut.innerHTML = "";
        const res = await window.lcl.inspectDevices({ listenMs: 2000 })
            .catch(e => ({ error: String((e && e.message) || e) }));
        devBtn.disabled = false;
        devBtn.innerText = "Scan again";
        if (!res || res.error || !res.devices) {
            devOut.innerText = (res && res.error) || "could not read the device tree";
            return;
        }
        // A FAILED PROBE IS NOT AN EMPTY BENCH.
        //
        // deviceScan.inspect() returns `scanError` — a sentence — when the OS
        // probe itself did not run. Checked BEFORE the empty branch, because an
        // empty list from a probe that never happened used to render as the
        // clean green result "Nothing on USB.", which is a statement about the
        // hardware that nobody was in a position to make.
        if (res.scanError) {
            const bad = document.createElement("div");
            bad.className = "dev-row scan-failed";
            const bt = document.createElement("div");
            bt.className = "dev-title";
            bt.innerText = "The device scan did not run";
            const bm = document.createElement("div");
            bm.className = "dev-meta";
            bm.innerText = res.scanError;
            bad.appendChild(bt);
            bad.appendChild(bm);
            devOut.appendChild(bad);
        }

        const boards = res.devices.filter(d => d.likelyBoard);
        const rest = res.devices.filter(d => !d.likelyBoard);
        // whatever a partial probe DID see is still listed under the failure —
        // a partial reading is a reading, it just must not be labelled complete
        if (!res.devices.length) {
            if (!res.scanError) devOut.innerText = "Nothing on USB.";
            return;
        }

        const row = (d) => {
            const el = document.createElement("div");
            el.className = "dev-row" + (d.identified ? "" : " unknown");
            const t = document.createElement("div");
            t.className = "dev-title";
            t.innerText = (d.family || d.name || "Unidentified USB device")
                + (d.port ? "  ·  " + d.port : "");
            const m = document.createElement("div");
            m.className = "dev-meta";
            m.innerText = [
                `${d.vid}:${d.pid}`,
                d.vendor || null,
                d.serial ? "serial " + d.serial : null,
                d.identified ? null : "not in the identification table"
            ].filter(Boolean).join("  ·  ");
            el.appendChild(t); el.appendChild(m);
            if (d.serialRead && d.serialRead.text) {
                const pre = document.createElement("pre");
                pre.className = "dev-serial";
                pre.innerText = d.serialRead.text.slice(0, 1200);
                el.appendChild(pre);
            } else if (d.serialRead && (d.serialRead.note || d.serialRead.error)) {
                const n = document.createElement("div");
                n.className = "dev-meta";
                n.innerText = d.serialRead.error || d.serialRead.note;
                el.appendChild(n);
            }

            /* LISTEN TO ONE BOARD, NOT THE BENCH.
             *
             * A serial port is exclusive on Windows: for as long as this app
             * holds one, another program's attempt on it fails. A plain scan
             * opens every ported device in turn, so four boards at the ceiling
             * is roughly twenty-four seconds during which a serial monitor
             * reconnecting to ANY of them gets a sharing violation. The engine
             * and the IPC boundary both take a port now; this is the control
             * that lets the operator use it. */
            if (d.port) {
                const one = document.createElement("button");
                one.className = "ghost dev-listen";
                one.innerText = "Listen to " + d.port + " only";
                one.title = "Open just this port for a few seconds and read what " +
                            "it says. Every other port is left alone.";
                const said = document.createElement("div");
                said.className = "dev-heard hidden";
                one.addEventListener("click", async () => {
                    one.disabled = true;
                    one.innerText = "Listening on " + d.port + ".";
                    const r = await window.lcl.inspectDevices(
                        { listenMs: 4000, port: d.port })
                        .catch(e => ({ error: String((e && e.message) || e) }));
                    one.disabled = false;
                    one.innerText = "Listen to " + d.port + " again";
                    const fresh = r && r.devices
                        && r.devices.find(x => x.port === d.port);
                    const heard = fresh && fresh.serialRead;
                    said.innerHTML = "";
                    said.classList.remove("hidden");
                    if (heard && heard.text) {
                        const pre = document.createElement("pre");
                        pre.className = "dev-serial";
                        pre.innerText = heard.text.slice(0, 1200);
                        said.appendChild(pre);
                        if (heard.truncated) {
                            const cut = document.createElement("div");
                            cut.className = "dev-meta";
                            cut.innerText = "the capture was cut at " +
                                heard.chars + " of " + heard.charsReceived +
                                " characters";
                            said.appendChild(cut);
                        }
                    } else {
                        const n = document.createElement("div");
                        n.className = "dev-meta";
                        n.innerText = (r && r.error)
                            || (r && r.scanError)
                            || (heard && (heard.error || heard.note))
                            || "nothing came back from " + d.port;
                        said.appendChild(n);
                    }
                });
                el.appendChild(one);
                el.appendChild(said);
            }
            return el;
        };
        for (const d of boards) devOut.appendChild(row(d));
        // everything else is KEPT, behind one line, because a hub is still a
        // fact about the machine and deleting readouts is not done here
        if (rest.length) {
            const more = document.createElement("div");
            more.className = "pref-note dev-more";
            more.innerText = `and ${rest.length} other USB device` +
                `${rest.length === 1 ? "" : "s"} — hubs, cameras, controllers. Show`;
            more.addEventListener("click", () => {
                more.remove();
                for (const d of rest) devOut.appendChild(row(d));
            });
            devOut.appendChild(more);
        }
        // WHAT WAS NOT READ, next to what was
        const nr = document.createElement("div");
        nr.className = "pref-note";
        nr.innerText = res.notRead;
        devOut.appendChild(nr);
    });

    // THE PAGE WATCHES FOR ITSELF. With the connections page open, it should be
    // smart enough to update on its own. It is: every 5s it re-probes and
    // repaints only if something moved, so the window where the tailnet comes
    // back is caught without anyone sitting there clicking Refresh.
    // ONE TICK AT A TIME. Both painters are async and neither was awaited, so
    // a tick that took longer than the interval did not suppress the next one
    // — they STACKED. With a candidate whose name takes twenty seconds to fail
    // to resolve, a five-second timer queued work four times faster than it
    // drained, and the backlog grew for as long as this dialog stayed open.
    // That is the dialog the operator was on while pressing Refresh.
    let pollBusy = false;
    const livePoll = setInterval(async () => {
        if (pollBusy) return;
        pollBusy = true;
        try { await paintNodes(true); await paintFound(true); }
        catch { /* a failed repaint must not stop the next one */ }
        finally { pollBusy = false; }
    }, 5000);
    try {
        await modal({ title: "API's & Connections", node: wrap, confirmLabel: "Done",
                      confirmOnly: true, size: "wide" });
    } finally {
        clearInterval(livePoll);
    }
}


// =============================================================
// WHERE A MACHINE ACTUALLY STANDS
// =============================================================
/**
 * One function that answers, for any machine: what state is it in, what is
 * the next thing, and why does that thing exist.
 *
 * The wizard listed five steps and knew nothing about which of them applied
 * to the machine in front of it. Reported as: "it knew nothing about what was
 * going on, what i needed to do or what was remaining for me to do."
 *
 * The states are ordered. Each one names the single next action and the
 * reason for it, so no screen has to be interpreted.
 */
function nodeState(n, ctx) {
    const serving = !!(n && n.serving && n.serving.length);
    const linked = !!(n && n.linked);
    // REMOTE ACCESS CAN BE HALF DONE, AND THAT IS ITS OWN FACT.
    //
    // The door is installed on the machine (it has a token, and Tailscale
    // handed back an approval link) but its address was never published, so
    // there is no way in from anywhere. Saying "once remote access is set up"
    // to someone who set it up is how an afternoon gets lost: they go looking
    // for a step they already did instead of the one that is left.
    const halfDone = !!(n && !n.hasDoor && (n.relayPending || n.funnelEnableUrl));
    const finishIt = "Remote access is installed on it but its address was " +
        "never published, so there is no way in while this is blocked. Finish " +
        "it the next time you can reach the machine — turning the filter off " +
        "for a minute is enough — with the button on this row.";

    if (!n || n.ssh === "no answer on port 22" || n.ssh === "unreachable") {
        return {
            key: "offline", label: "Not answering",
            now: "Power it on and connect it to this network.",
            why: "Nothing can be set up until the machine answers.",
            done: 0, total: 4
        };
    }
    if (n.ssh === "unconfirmed") {
        return {
            key: "unconfirmed", label: "Needs confirming",
            now: "Confirm this is your machine — one screen, one click.",
            why: "Stops anything else on the network pretending to be it.",
            done: 0, total: 4
        };
    }
    // A failed probe is not one thing. "Permission denied" means the machine
    // answered and refused this computer; a timeout behind a VPN means the
    // packets never arrived and the machine did NOTHING wrong. The first
    // version blamed the machine for both — observed as
    // "refused this computer" on a node that was simply unreachable through
    // the VPN. The raw stderr stays on the row (.node-ssh-why); this only
    // names what it means, and only when it can.
    if (!serving && !n.doorOk && n.ssh && n.ssh !== "ok") {
        // "connect to host X port 22: ..." means ssh never reached sshd at
        // all — the socket failed. A VPN kill switch produces exactly that,
        // with the words "Permission denied" (Windows WSAEACCES), and reading
        // those two words as an auth verdict blamed the Spark for a filter on
        // this laptop. A REAL refusal comes from the far end and names the
        // methods: "Permission denied (publickey,password)".
        const reachedSshd = !/connect to host/i.test(n.ssh);
        if (reachedSshd &&
            /permission denied \(|authentication|publickey|host key/i.test(n.ssh)) {
            // PLAIN WORDS. "Fix sign-in — ssh's own words are on the row"
            // assumed the reader knows what ssh is, that it produces "words",
            // and which line was meant. Reported as not human readable —
            // correct. The sentence now says what happened and what to do;
            // the exact error stays underneath, labelled as what it is.
            return {
                key: "no-entry", label: "Cannot sign in",
                now: "Open Add Local Node and sign in to it again.",
                why: "The machine is on and answering, but it did not accept " +
                     "this computer's saved sign-in. Its exact answer is below.",
                done: 0, total: 4
            };
        }
        if (ctx && ctx.vpn) {
            return {
                key: "blocked", label: "Blocked from this computer",
                now: halfDone
                    ? "Nothing, from here. " + finishIt
                    : "Nothing, from here. It works again when the direct " +
                      "route is back — or from anywhere, once remote access " +
                      "is finished while it is reachable.",
                why: "The packets are stopped on this computer, not by the " +
                     "machine. The note above names the filter.",
                done: linked ? 3 : 1, total: 4
            };
        }
        return {
            key: "offline", label: "Not answering",
            now: "Power it on and connect it to this network.",
            why: "Nothing can be set up until the machine answers.",
            done: 0, total: 4
        };
    }
    if (!serving) {
        return {
            key: "no-server", label: "No model server",
            now: "Install the model server on it.",
            why: "This is what actually runs models. NVIDIA Sync does not install one.",
            done: 1, total: 4
        };
    }
    if (!linked) {
        return {
            key: "unlinked", label: "Reading its models",
            // not an instruction any more — linking happens on sight
            now: "Nothing — its models are being read now.",
            why: "They appear in the model picker as soon as that finishes.",
            done: 2, total: 4
        };
    }
    if (!n.hasDoor) {
        // half done and you are ON its network: this is the moment, and the
        // action is not "set up remote access" — it is finish the one that is
        // already there
        if (halfDone) {
            return {
                key: "local-only", label: "Working — remote access unfinished",
                // WHAT ALREADY WORKS COMES FIRST. This said "Finish remote
                // access now, while you are on its network" to someone whose
                // models were answering fine over the tailnet from another
                // city — so it read as a fault, and as an instruction to go
                // home, when neither was true.
                now: "Nothing — its models are ready to use. When you have a " +
                     "moment while it is reachable, finish remote access.",
                why: "Remote access is installed on it but its address was " +
                     "never published, so it will disappear the next time " +
                     "something blocks the direct route — a full-tunnel VPN, " +
                     "or a network that is not yours. Finishing it takes one " +
                     "click and only works while you can still reach it.",
                done: 3, total: 4
            };
        }
        return {
            key: "local-only", label: "Works on this network",
            now: "Optional: set up remote access, while you are still here.",
            why: "Only needed if you use it away from this network, or behind a " +
                 "VPN that blocks the direct route. It cannot be set up later " +
                 "from somewhere else.",
            done: 3, total: 4
        };
    }
    return {
        key: "ready", label: "Ready anywhere",
        now: "Its models are in the model picker, next to the message box.",
        why: "Reachable from any network, including behind a VPN.",
        done: 4, total: 4
    };
}

/** The state as a row: a badge, the next action, and the reason. */
function nodeStateEl(n, ctx) {
    const st = nodeState(n, ctx);
    const wrap = document.createElement("div");
    wrap.className = "node-state " + st.key;

    const head = document.createElement("div");
    head.className = "node-state-head";
    const lead = document.createElement("span");
    lead.className = "node-state-lead";
    const badge = document.createElement("span");
    badge.className = "node-state-badge";
    badge.innerText = st.label;
    lead.appendChild(badge);
    // WHICH ROAD IS CARRYING TRAFFIC, said once, here. "remote access on"
    // (the meta line) says a relay exists; this says whether the machine is
    // being reached directly or through it — the fact that was invisible
    // while the app retried a blocked direct road with a working relay beside
    // it. Drawn only when some road actually works.
    if (n && n.route) {
        const via = document.createElement("span");
        via.className = "node-route " + n.route;
        via.innerText = n.route === "relay" ? "via remote access" : "direct";
        lead.appendChild(via);
    }
    const prog = document.createElement("span");
    prog.className = "node-state-prog";
    prog.innerText = st.done + " of " + st.total + " done";
    head.appendChild(lead); head.appendChild(prog);

    const now = document.createElement("div");
    now.className = "node-state-now";
    now.innerText = st.key === "ready" ? st.now : "Next: " + st.now;

    const why = document.createElement("div");
    why.className = "node-state-why";
    why.innerText = st.why;

    wrap.appendChild(head); wrap.appendChild(now); wrap.appendChild(why);
    return wrap;
}

// =============================================================
// NODE SETUP WIZARD — plug it in, answer as little as possible
// =============================================================
/**
 * The requirement this exists for:
 *
 *   The product must detect a local node, whatever it is, no matter the
 *   manufacturer, and then offer a UI wizard that sets it up.
 *
 * and the reason it exists at all:
 *
 *   Someone should be able to plug in a new node and leave for the day, with
 *   setup handled for them.
 *
 * THE ONE FACT THIS SCREEN MUST NOT HIDE: remote access can only be installed
 * while the machine is REACHABLE. A full-tunnel VPN blocks the tailnet
 * outright, so from another network there is no path in and nothing can be
 * set up. That window is now stated in bold at the top of the wizard instead
 * of being discovered a day later. Not saying it cost a full day of the
 * operator's time.
 */
// =============================================================
// THE MODEL LIBRARY
// -------------------------------------------------------------
// "adding a model to the spark from this ui, being able to look it up, get a
//  download, then adding it to the spark. that makes me self sufficient, and
//  less reliant on AI in general."
//
// Search, size, licence, and a pull onto the node — in .lcl's own idiom
// (pref-wrap / pref-head / pref-select and the xwide sheet), because a panel
// that looks bolted on is one nobody trusts with a 40 GB download.
//
// The curated lists are a STARTING POINT, not the product. The operator asked
// for an assortment AND the ability to add anything; hand-picking a set would
// have made him self-sufficient until the first model I did not choose.
// =============================================================
const MODEL_KINDS = [
    { key: "image", label: "Image",
      note: "Diffusion checkpoints for ComfyUI. FLUX and SD 3.5 are the current open weights worth having.",
      picks: [
        { id: "black-forest-labs/FLUX.1-schnell", why: "fast, permissive (Apache-2.0)" },
        { id: "stabilityai/stable-diffusion-3.5-large", why: "highest quality open SD" },
        { id: "black-forest-labs/FLUX.1-dev", why: "best FLUX quality, non-commercial licence" }
      ] },
    { key: "video", label: "Video",
      note: "Video diffusion. These are the heavy ones — check the fit line before pulling.",
      picks: [
        { id: "Wan-AI/Wan2.1-T2V-1.3B", why: "small enough to be practical" },
        { id: "Wan-AI/Wan2.1-T2V-14B", why: "much better, much bigger" },
        { id: "tencent/HunyuanVideo", why: "strong open video model" }
      ] },
    { key: "audio", label: "Audio",
      note: "NVIDIA publishes no audio-GENERATION playbook for the Spark, so that half is self-serve and nothing on the node serves these downloads yet. Audio INPUT now has a supported path: the Nemotron Omni recipe takes speech in. Camera-to-text OCR is the Live VLM stack, not a download here.",
      picks: [
        { id: "openai/whisper-large-v3", why: "speech to text, the reliable one" },
        { id: "coqui/XTTS-v2", why: "voice cloning / TTS" },
        { id: "facebook/musicgen-medium", why: "music generation" }
      ] },
    { key: "text", label: "Language",
      note: "Served by vLLM or Ollama on the node. A 128 GB Spark holds a 70B comfortably at 4-bit.",
      picks: [
        { id: "Qwen/Qwen2.5-Coder-32B-Instruct", why: "strongest open coding model in this class" },
        { id: "meta-llama/Llama-3.3-70B-Instruct", why: "general work, fits at 4-bit" },
        { id: "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B", why: "reasoning, distilled" }
      ] }
];

async function openModelLibrary(forNode = null) {
    // remembered so the sheet can be titled after the machine it is about
    openModelLibrary._for = (forNode && forNode.nodeName) || null;
    const wrap = document.createElement("div");
    wrap.className = "pref-wrap";

    const head = (t) => {
        const h = document.createElement("div");
        h.className = "pref-head"; h.innerText = t; wrap.appendChild(h); return h;
    };
    const note = (t) => {
        const n = document.createElement("div");
        n.className = "pref-note"; n.innerText = t; wrap.appendChild(n); return n;
    };

    {
        const p = document.createElement("div");
        p.className = "pref-note pref-purpose";
        // NOT "the door", NOT "Funnel" — those are this app's own words for its
        // plumbing and mean nothing to the person reading. What matters to them
        // is WHICH connection carries it: the private one they own, not the one
        // that is published to the internet.
        p.innerText = "Find an open-weight model, see what it costs in disk and " +
            "memory, and put it on one of your nodes. Weights land where that " +
            "machine already keeps them — ComfyUI's models folder for image and " +
            "video — so nothing else has to be told where they are. Downloads " +
            "run on the machine itself, over your own private connection to it, " +
            "never over the link that is published to the internet.";
        wrap.appendChild(p);
    }

    /* ---- which node, and has it the room ---- */
    head("Install onto");
    const nodeSel = document.createElement("select");
    nodeSel.className = "cap-level auto pref-select";
    const nodeFit = document.createElement("div");
    nodeFit.className = "pref-note";
    nodeFit.innerText = "reading the node…";
    wrap.appendChild(nodeSel);
    wrap.appendChild(nodeFit);

    let nodes = [];
    let lateNodes = false;   // the probe had not answered when the page drew
    let nodeInfo = {};              // id -> {freeBytes, memBytes}
    try {
        const r = await Promise.race([
            window.lcl.nodes(false),
            new Promise(res => setTimeout(() => res(null), 500))
        ]);
        nodes = (r && r.nodes) || [];
        if (!r) lateNodes = true;
    } catch { nodes = []; }

    const fillNodeSel = () => {
        nodeSel.innerHTML = "";
        if (!nodes.length) {
            const o = document.createElement("option");
            o.value = "";
            o.innerText = lateNodes
                ? "reading your machines…"
                : "no node linked — add one first (Global › Add Local Node)";
            nodeSel.appendChild(o);
            nodeSel.disabled = true;
            nodeFit.innerText = "";
            return;
        }
        nodeSel.disabled = false;
        for (const n of nodes) {
            const o = document.createElement("option");
            o.value = n.id;
            o.innerText = `${n.name || n.host}${n.reachable === false ? "  (not answering)" : ""}`;
            nodeSel.appendChild(o);
        }
    };
    fillNodeSel();
    if (lateNodes) {
        window.lcl.nodes(false).then(late => {
            const got = (late && late.nodes) || [];
            if (!got.length || nodes.length) return;
            nodes = got;
            lateNodes = false;
            fillNodeSel();
            try { readNode(); readSudo(); } catch { }
        }).catch(() => { });
    }

    const readNode = async () => {
        const id = nodeSel.value;
        if (!id) return;
        nodeFit.innerText = "reading the node…";
        try {
            const d = await window.lcl.nodeDash(id);
            if (d && !d.error) {
                const free = Number(d.diskFreeBytes || (d.disk && d.disk.freeBytes)) || 0;
                const mem = Number(d.memTotalBytes || (d.mem && d.mem.totalBytes)) || 0;
                nodeInfo[id] = { freeBytes: free, memBytes: mem };
                nodeFit.innerText = (free ? `${fmtBytes(free)} free` : "free space unknown")
                    + (mem ? ` · ${fmtBytes(mem)} of memory` : "");
                return;
            }
        } catch { /* fall through */ }
        nodeInfo[id] = { freeBytes: 0, memBytes: 0 };
        nodeFit.innerText = "could not read this node — install will still be offered, " +
                            "but nothing can be checked for fit first";
    };
    nodeSel.addEventListener("change", readNode);
    if (nodes.length) readNode();

    /* ---- ASKED ONCE, OR ASKED EVERY TIME ----
     *
     * A long-standing early requirement: get the node to stop requiring sudo
     *  as the first setup step.
     *
     * On the user's own appliance this is the setting that makes every install after
     * it uneventful. It sits above the model search because it is the thing to
     * do before the first install, not a preference to find afterwards. */
    const sudoRow = document.createElement("div");
    sudoRow.className = "node-sudo";
    const sudoState = document.createElement("div");
    sudoState.className = "node-sudo-state";
    const sudoBtn = document.createElement("button");
    sudoBtn.className = "ghost small hidden";
    const sudoPw = document.createElement("input");
    sudoPw.type = "password";
    sudoPw.className = "pref-input node-sudo-pw hidden";
    sudoPw.placeholder = "your password on this node, once";
    sudoPw.autocomplete = "off";
    const sudoNote = document.createElement("div");
    sudoNote.className = "pref-note";
    sudoRow.append(sudoState, sudoPw, sudoBtn, sudoNote);
    wrap.appendChild(sudoRow);

    let sudoFree = null;
    const paintSudo = () => {
        if (sudoFree === null) { sudoState.innerText = "checking how this node handles sudo…"; return; }
        sudoState.innerText = sudoFree
            ? "This node installs software without asking for a password."
            : "This node asks for your password every time it installs something.";
        sudoBtn.classList.remove("hidden");
        sudoBtn.innerText = sudoFree ? "Start asking again" : "Stop asking me";
        sudoPw.classList.toggle("hidden", !!sudoFree);
        sudoNote.innerText = sudoFree
            ? "Undoing this removes /etc/sudoers.d/lcl-nopasswd and the password " +
              "box comes back."
            : "Writes one rule to /etc/sudoers.d on the node, checked with sudo's " +
              "own syntax checker before it is installed. Anything running as " +
              "you on that machine can then become root without a password — " +
              "which is the trade, and it is reversible from this same button.";
    };
    paintSudo();

    const readSudo = async () => {
        const id = nodeSel.value;
        if (!id) return;
        sudoFree = null; paintSudo();
        try {
            const nd = nodes.find(x => x.id === id) || {};
            const r = await window.lcl.nodeReadiness({ host: nd.host, user: nd.user });
            sudoFree = !!(r && r.passwordlessSudo);
        } catch { sudoFree = false; }
        paintSudo();
    };
    nodeSel.addEventListener("change", readSudo);
    if (nodes.length) readSudo();

    sudoBtn.addEventListener("click", async () => {
        const id = nodeSel.value;
        if (!id) return;
        const enable = !sudoFree;
        const pw = sudoPw.value || "";
        sudoPw.value = "";
        sudoBtn.disabled = true;
        sudoState.innerText = enable ? "writing the rule on the node…" : "removing the rule…";
        try {
            const r = await window.lcl.nodeSudoNoPassword(
                pw ? { nodeId: id, enable, password: pw } : { nodeId: id, enable });
            if (r && r.ok) {
                sudoFree = !!r.on;
                addNotice(sudoFree
                    ? `${nodeSel.options[nodeSel.selectedIndex].text} will not ask for a ` +
                      `password again. Installs run straight through.`
                    : `${nodeSel.options[nodeSel.selectedIndex].text} will ask for your ` +
                      `password again.`);
            } else {
                sudoState.innerText = (r && r.error) || "the node did not confirm the change";
                sudoBtn.disabled = false;
                if (r && r.badPassword) sudoPw.focus();
                return;
            }
        } catch (e) {
            sudoState.innerText = String((e && e.message) || e);
        }
        sudoBtn.disabled = false;
        paintSudo();
    });

    /* ---- what kind of model ---- */
    head("What are you looking for");
    const kindSel = document.createElement("select");
    kindSel.className = "cap-level auto pref-select";
    for (const k of MODEL_KINDS) {
        const o = document.createElement("option");
        o.value = k.key; o.innerText = k.label;
        kindSel.appendChild(o);
    }
    wrap.appendChild(kindSel);
    const kindNote = note("");

    /* ---- the search ---- */
    const searchRow = document.createElement("div");
    searchRow.className = "pref-role-grid";
    const q = document.createElement("input");
    q.type = "text";
    q.className = "profile-field";
    q.placeholder = "search Hugging Face, or leave empty for the most downloaded";
    const goBtn = document.createElement("button");
    goBtn.className = "primary";
    goBtn.innerText = "Search";
    searchRow.append(q, goBtn);
    wrap.appendChild(searchRow);

    const results = document.createElement("div");
    results.className = "pref-rates";
    wrap.appendChild(results);

    const progress = document.createElement("div");
    progress.className = "pref-note";
    wrap.appendChild(progress);

    /* ---- installing ---- */
    let installing = false;
    const setProgress = (t) => { progress.innerText = String(t || "").slice(0, 300); };

    /* WHERE AN INSTALL ASKS FOR ONE CLICK.
     *
     * setProgress OVERWRITES: every line from the node replaces the last, which
     * is right for a hundred lines of pip output and catastrophic for the one
     * line that matters. Tailscale prints a login URL exactly once, waits for
     * the operator to visit it, and that line would flash past between two
     * apt messages — the difference between one click and the day he actually
     * spent on it. A link that arrives here STAYS until the install ends. */
    const stackAsk = document.createElement("div");
    stackAsk.id = "stack-ask";
    stackAsk.className = "hidden";
    wrap.appendChild(stackAsk);
    const clearAsk = () => { stackAsk.innerHTML = ""; stackAsk.classList.add("hidden"); };
    // set while an install is running, so the shared progress handler can drive
    // the readout inside the row that started it
    const askToOpen = (url, label) => {
        stackAsk.innerHTML = "";
        stackAsk.classList.remove("hidden");
        const t = document.createElement("div");
        t.className = "stack-ask-title";
        t.innerText = label;
        const a = document.createElement("button");
        a.className = "stack-ask-link";
        a.innerText = url;
        a.title = "Open this in your browser";
        a.addEventListener("click", () => {
            try { window.lcl.openExternal(url); } catch { }
        });
        const note = document.createElement("div");
        note.className = "pref-note";
        note.innerText = "The node is waiting for you — it carries on by itself " +
            "the moment you have signed in.";
        stackAsk.append(t, a, note);
    };

    const install = async (repo, file, bytes, btn) => {
        const nodeId = nodeSel.value;
        if (!nodeId) { setProgress("Link a node first."); return; }
        if (installing) { setProgress("One install at a time."); return; }
        const info = nodeInfo[nodeId] || {};
        // SAY THE COST BEFORE IT STARTS. A 40 GB pull the operator did not
        // expect is the thing this confirmation exists to prevent.
        const ok = await modal({
            title: "Install onto the node?",
            message: `${repo}${file ? `\n${file}` : ""}`,
            detail: (bytes ? `${fmtBytes(bytes)} will be downloaded ` : "This will download ") +
                `on ${nodeSel.options[nodeSel.selectedIndex].text}, over your own SSH ` +
                `connection. It runs on the node, so you can close this window.`,
            confirmLabel: "Download it"
        });
        if (!ok) return;
        installing = true;
        btn.disabled = true;
        const wasLabel = btn.innerText;
        btn.innerText = "installing…";
        stopBtn.classList.remove("hidden");
        setProgress("starting…");
        try {
            const res = await window.lcl.modelInstall({
                nodeId, repo, file, kind: kindSel.value
            });
            if (res && res.ok) {
                setProgress("Done — it is on the node.");
                addNotice(`${repo} was installed on ${nodeSel.options[nodeSel.selectedIndex].text}.`);
            } else {
                setProgress("Did not finish: " + ((res && res.error) || "unknown"));
            }
        } catch (e) {
            setProgress("Did not finish: " + String((e && e.message) || e));
        } finally {
            installing = false;
            btn.disabled = false;
            btn.innerText = wasLabel;
            stopBtn.classList.add("hidden");
        }
    };

    const stopBtn = document.createElement("button");
    stopBtn.className = "ghost danger-text hidden";
    stopBtn.innerText = "Stop the download";
    stopBtn.addEventListener("click", async () => {
        try { await window.lcl.modelInstallCancel(nodeSel.value); } catch {}
        setProgress("stopping…");
    });
    wrap.appendChild(stopBtn);

    // live lines from the node while it pulls
    if (window.lcl.onModelInstallProgress && !openModelLibrary._wired) {
        openModelLibrary._wired = true;
        window.lcl.onModelInstallProgress((d) => {
            if (!d) return;
            if (d.phase === "line") {
                const line = String(d.line || "");
                // the node asking for a browser sign-in, pinned rather than scrolled
                const m = /LCL-TS-URL\s+(https:\/\/\S+)/.exec(line);
                if (m) { askToOpen(m[1], "Sign in to Tailscale to finish"); return; }
                // ...and the step announcements the script already emits
                const st = /^LCL-STEP\s+(.+)$/.exec(line.trim());
                if (st) { setProgress(st[1]); return; }
                setProgress(line);
            }
            else if (d.phase === "done") {
                clearAsk();
                const how = d.cancelled ? "stopped"
                    : (d.ok ? "finished — and it proved itself working"
                            : "did not finish");
                setProgress(d.cancelled ? "stopped" : (d.ok ? "done" : "failed"));
            }
        });
    }

    /* ---- rendering a result row ---- */
    const row = (m, { bytes = 0, file = null, why = null } = {}) => {
        const r = document.createElement("div");
        r.className = "model-row";
        const name = document.createElement("div");
        name.className = "model-row-name";
        name.innerText = m.id;
        const meta = document.createElement("div");
        meta.className = "model-row-meta";
        meta.innerText = [
            bytes ? fmtBytes(bytes) : null,
            m.license || (why ? null : "licence unknown"),
            why
        ].filter(Boolean).join(" · ");
        // GATED IS NOT A DETAIL — it is the difference between a download that
        // works and one that 401s after the operator has waited for it.
        if (m.gated) {
            const g = document.createElement("div");
            g.className = "gated";
            g.innerText = "gated — accept its licence on Hugging Face first";
            meta.appendChild(g);
        }
        const act = document.createElement("button");
        act.className = "ghost";
        act.innerText = bytes ? "Install" : "Details";
        act.addEventListener("click", async () => {
            if (!bytes) {
                act.disabled = true; act.innerText = "reading…";
                try {
                    const f = await window.lcl.modelFiles(m.id);
                    if (!f || f.error) { setProgress(f && f.error || "could not read that model"); return; }
                    // pick the file the way the engine would
                    const wanted = (f.files || []).filter(x =>
                        /\.(safetensors|gguf|ckpt|bin|pt)$/i.test(x.path));
                    const gguf = wanted.filter(x => /\.gguf$/i.test(x.path));
                    const pool = gguf.length ? gguf : wanted;
                    const pick = pool.slice().sort((a, b) => b.bytes - a.bytes)[0];
                    if (!pick) { setProgress("that repo has no weights file to install"); return; }
                    results.insertBefore(
                        row({ id: m.id, license: f.license, gated: f.gated },
                            { bytes: pick.bytes, file: pick.path }),
                        r.nextSibling);
                    act.innerText = "Details";
                } finally { act.disabled = false; }
                return;
            }
            // FIT IS CHECKED BEFORE THE PULL, not after: a model bigger than the
            // node's memory downloads perfectly and then never loads.
            const info = nodeInfo[nodeSel.value] || {};
            if (info.memBytes && bytes > info.memBytes * 0.9) {
                setProgress(`That is ${fmtBytes(bytes)} against ${fmtBytes(info.memBytes)} ` +
                            `of memory on that node — it would download and then not load.`);
                return;
            }
            if (info.freeBytes && bytes > info.freeBytes - 5e9) {
                setProgress(`That is ${fmtBytes(bytes)} and the node has ` +
                            `${fmtBytes(info.freeBytes)} free.`);
                return;
            }
            install(m.id, file, bytes, act);
        });
        r.append(name, meta, act);
        return r;
    };

    const showPicks = () => {
        const k = MODEL_KINDS.find(x => x.key === kindSel.value) || MODEL_KINDS[0];
        kindNote.innerText = k.note;
        results.innerHTML = "";
        const h = document.createElement("div");
        h.className = "pref-note";
        h.innerText = "Worth having, to start with:";
        results.appendChild(h);
        for (const p of k.picks) results.appendChild(row({ id: p.id }, { why: p.why }));
    };
    kindSel.addEventListener("change", showPicks);
    showPicks();

    /* OPENED FROM A DEVICE CARD, SO IT OPENS ON THAT DEVICE AND THAT TYPE.
     * Landing on a generic page and re-choosing the machine you just clicked is
     * the kind of step that makes a tool feel like plumbing. */
    if (forNode && forNode.nodeId) {
        const has = [...nodeSel.options].some(o => o.value === forNode.nodeId);
        if (has) { nodeSel.value = forNode.nodeId; readNode(); readSudo(); }
    }
    if (forNode && forNode.kind && forNode.kind !== "software") {
        const k = MODEL_KINDS.find(x => x.key === forNode.kind);
        if (k) { kindSel.value = k.key; showPicks(); }
    }

    /* ---- WHAT RUNS THE WEIGHTS. Models are useless without something to run
     * them, and that something is what NVIDIA's playbooks install. Shown after
     * the search so the panel reads in the order the work happens: get the
     * software, then get the models. ---- */
    head("What runs them");
    note("Weights need something to serve them. These are NVIDIA's own DGX " +
         "Spark playbooks — the ones .lcl can stand up for you are marked, and " +
         "you can read every command before it runs.");
    const stackWrap = document.createElement("div");
    stackWrap.className = "pref-rates";
    wrap.appendChild(stackWrap);

    (async () => {
        const r = await window.lcl.stacks().catch(() => null);
        const list = (r && r.stacks) || [];
        // WHAT IS ALREADY ANSWERING ON THIS MACHINE. A recipe whose port is
        // live is installed, whether or not it is a model source.
        // NOT AWAITED: nodes() probes the network and the rows do not need it
        const servingPorts = new Set();
        const markInstalled = [];
        window.lcl.nodes().then(nn => {
            const me = ((nn && nn.nodes) || []).find(x => x.id === nodeSel.value);
            for (const sv of (me && me.serving) || []) servingPorts.add(Number(sv.port));
            // repaint only the rows that turned out to be installed
            for (const f of markInstalled) { try { f(); } catch { } }
        }).catch(() => { /* the list stands; nothing is marked */ });
        for (const s of list) {
            const row = document.createElement("div");
            row.className = "model-row";
            const nm = document.createElement("div");
            nm.className = "model-row-name";
            nm.innerText = s.name;
            const meta = document.createElement("div");
            meta.className = "model-row-meta";
            /* WHAT ELSE IS HOLDING THIS MACHINE'S MEMORY, from the same ports.
             *
             * Installing more on a node risks a crash when it is already near
             *  full usage with vLLM running.
             *
             * A well-founded worry the app could answer all along: it already
             * knows which ports are serving, and the recipe table says which
             * recipes hold the GPU for their whole life. Said BEFORE the
             * several-GB download rather than after the ValueError. */
            const holdersHere = () => {
                const held = (list || []).filter(o => o.holds && o.key !== s.key
                    && (o.ports || []).some(p => servingPorts.has(Number(p))));
                // one NAME per port: 8000 is vLLM, spec-decode and NIM, and
                // listing all three would invent two engines that are not there
                const byPort = new Map();
                for (const o of held) {
                    for (const p of (o.ports || [])) {
                        if (servingPorts.has(Number(p)) && !byPort.has(p)) byPort.set(p, o);
                    }
                }
                return [...byPort.entries()].map(([p, o]) =>
                    String(o.name).split(" — ")[0].trim() + " on " + p);
            };
            const describe = () => {
                // ANY port this recipe leaves listening, not just an OpenAI one.
                // ComfyUI serves 8188 and has no endpoint, so it never once
                // showed as installed however long it had been running.
                const mine = (s.ports && s.ports.length ? s.ports
                    : (s.endpoint && s.endpoint.port ? [s.endpoint.port] : []))
                    .filter(p => servingPorts.has(Number(p)));
                const onNow = mine.length > 0;
                const rivals = onNow ? [] : (s.holds ? holdersHere() : []);
                meta.innerText = [
                    onNow ? "INSTALLED — answering on port " + mine.join(", ") : null,
                    rivals.length
                        ? "THIS MACHINE IS ALREADY SERVING " + rivals.join(" and ") +
                          " — each one holds its memory for as long as it runs, so " +
                          "there may be no room for another"
                        : null,
                    s.why, s.serves ? `serves ${s.serves}` : null, s.needs,
                    s.takes ? `takes ${s.takes}` : "no published time estimate"
                ].filter(Boolean).join(" · ");
                row.classList.toggle("stack-installed", !!onNow);
                row.classList.toggle("stack-contended", rivals.length > 0);
            };
            describe();
            markInstalled.push(describe);
            const act = document.createElement("button");
            act.className = s.installable ? "ghost" : "ghost";
            act.innerText = !s.installable ? "Read the playbook"
                // it checks and reports; calling that Install is the app taking
                // credit for work the playbook leaves to you
                : s.checksOnly ? "Check this machine is ready…"
                : "Install…";
            const was0 = act.innerText;
            act.addEventListener("click", async () => {
                if (!s.installable) {
                    // .lcl does not install this one, and says why rather than
                    // pretending the button is missing
                    await modal({
                        title: s.name,
                        message: s.manual || "",
                        detail: s.playbook,
                        confirmLabel: "Close", confirmOnly: true
                    });
                    return;
                }
                const nodeId = nodeSel.value;
                if (!nodeId) { setProgress("Link a node first."); return; }
                const pv = await window.lcl.stackPreview(s.key).catch(() => null);
                const steps = (pv && pv.steps) || [];
                /* A WIZARD, NOT A WALL OF SHELL.
                 *
                 * Instead of notes at the top and a run button at the bottom,
                 *  this should open as a wizard where each step is seen as it
                 *  goes — an interactive, insightful UI rather than a wall of
                 *  code.
                 *
                 * What was here printed every command in a <pre> stack and put
                 * Run underneath, so the operator read a script and then watched
                 * a log. The steps were always the interesting thing: the recipe
                 * already names each one in a plain sentence, and the node
                 * announces them as it reaches them. So the sentences ARE the
                 * interface — every one listed before anything runs, each
                 * lighting up as the node gets to it, with its own progress bar
                 * and its own clock.
                 *
                 * The commands do not go away. Hiding them behind a friendly
                 * button is how trust gets spent, and this is somebody else's
                 * machine. Each step keeps its exact command on one clipped
                 * line, opened in full with a click.
                 */
                const body = document.createElement("div");
                body.className = "stack-wiz";
                const intro = document.createElement("div");
                intro.className = "pref-note";
                intro.innerText = `${steps.length} steps on ` +
                    `${nodeSel.options[nodeSel.selectedIndex].text}, in order. It stops at ` +
                    `the first failure, and running it twice changes nothing the second time.` +
                    (s.takes ? `\nNVIDIA's playbook says ${s.takes}.`
                             : `\nNVIDIA's playbook publishes no time estimate for this one.`);
                body.appendChild(intro);

                // NOT `list`: that is the stacks array in this closure
                const stepList = document.createElement("ol");
                stepList.className = "stack-steps";
                // one row per step, built once and updated in place by the poll
                const rows = steps.map((st, i) => {
                    const li = document.createElement("li");
                    li.className = "stack-step waiting";
                    const num = document.createElement("span");
                    num.className = "stack-step-num";
                    num.innerText = String(i + 1);
                    const mid = document.createElement("div");
                    mid.className = "stack-step-mid";
                    // NOT `say`: that name is the tone lookup, and shadowing it
                    // hides every line in this scope from the wording check
                    const sayEl = document.createElement("div");
                    sayEl.className = "stack-step-say";
                    sayEl.innerText = st.say;
                    const cmd = document.createElement("code");
                    cmd.className = "stack-step-cmd";
                    cmd.innerText = st.run;
                    cmd.title = "Click to see all of it";
                    cmd.addEventListener("click", () => cmd.classList.toggle("open"));
                    // the live half, empty until the node reaches this step
                    const barWrap = document.createElement("div");
                    barWrap.className = "stack-step-bar hidden";
                    const bar = document.createElement("i");
                    barWrap.appendChild(bar);
                    const note = document.createElement("div");
                    note.className = "stack-step-note hidden";
                    const tail = document.createElement("div");
                    tail.className = "stack-step-tail hidden";
                    mid.append(sayEl, cmd, barWrap, note, tail);
                    const time = document.createElement("span");
                    time.className = "stack-step-time";
                    li.append(num, mid, time);
                    stepList.appendChild(li);
                    return { li, num, bar, barWrap, note, tail, time };
                });
                body.appendChild(stepList);

                const clash = (list || []).filter(o => o.key !== s.key
                    && o.installable && o.endpoint && s.endpoint
                    && o.endpoint.port === s.endpoint.port);
                if (clash.length) {
                    const w = document.createElement("div");
                    w.className = "pref-note stack-clash";
                    w.innerText = "Shares port " + s.endpoint.port + " with " +
                        clash.map(o => o.name.split(" — ")[0]).join(" and ") +
                        ". Only one of them can answer there at a time — if that one " +
                        "is running on this node, this will take the port from it.";
                    body.appendChild(w);
                }
                /* ...AND WHO IS ON IT RIGHT NOW. .lcl runs many sessions at
                 * once and they can be pointed at different services, so the
                 * cost of taking a port is measured in other people's work,
                 * not in the roster. */
                if (s.endpoint && s.endpoint.port) {
                    const nd = nodes.find(x => x.id === nodeId) || {};
                    window.lcl.sessionsOnPort({ host: nd.host, port: s.endpoint.port })
                        .then(r => {
                            const on = (r && r.sessions) || [];
                            if (!on.length || !body.isConnected) return;
                            const u = document.createElement("div");
                            u.className = "pref-note stack-clash";
                            u.innerText = on.length + " open session" +
                                (on.length === 1 ? " is" : "s are") +
                                " pointed at that address right now — " +
                                on.map(x => "\u201c" + x.title + "\u201d").join(", ") +
                                ". Taking the port cuts them off mid-turn.";
                            body.appendChild(u);
                        }).catch(() => {});
                }
                if (s.needs) {
                    const nd = document.createElement("div");
                    nd.className = "pref-note";
                    nd.innerText = "Needs: " + s.needs;
                    body.appendChild(nd);
                }
                if (s.rollback) {
                    const rb = document.createElement("div");
                    rb.className = "pref-note";
                    rb.innerText = "To undo: " + s.rollback;
                    body.appendChild(rb);
                }
                /* THE CONFIRM CANNOT BE A SECOND MODAL.
                 *
                 * "clicking install launches a container to install, while the
                 *  Manage this Machine ui is still present ... I clicked run it,
                 *  and i have no clue what is happening, the ui just closed."
                 *
                 * Both were the same defect. modal() serialises on one chain and
                 * reuses one #modal element, so opening the confirm REPLACED the
                 * page it was launched from — stacked while it waited, gone when
                 * it resolved. The install then ran with its progress lines
                 * writing into a panel that was no longer on screen, on somebody
                 * else's machine, for as long as pip takes.
                 *
                 * So the confirmation happens IN PLACE: the commands expand
                 * under the row, Run and Cancel sit beneath them, and the page
                 * never goes anywhere. Every line from the node lands where the
                 * operator is already looking. */
                if (row.querySelector(".stack-confirm")) {
                    row.querySelector(".stack-confirm").remove();
                    act.innerText = was0;
                    return;
                }
                const panel = document.createElement("div");
                panel.className = "stack-confirm";
                /* THE HEADLINE, not the log. Which step of how many, how long,
                 * and which road it took. The per-step detail lives in the rows
                 * above, where the step it belongs to is. */
                const live = document.createElement("div");
                live.className = "stack-live hidden";
                const liveStep = document.createElement("div");
                liveStep.className = "stack-live-step";
                const liveMeta = document.createElement("div");
                liveMeta.className = "stack-live-meta";
                const liveTail = document.createElement("pre");
                liveTail.className = "stack-live-tail hidden";
                live.append(liveStep, liveMeta, liveTail);
                panel.appendChild(live);

                panel.appendChild(body);
                /* ASK HIM FOR IT, RATHER THAN SENDING HIM ELSEWHERE.
                 *
                 * Entering a password to log in from .lcl should just work.
                 *
                 * Because nobody ever put a box here. The install hit sudo,
                 * sudo had no terminal to prompt on, and the app printed two
                 * commands to go and paste into a terminal somewhere else — on
                 * the machine the user owns, from the tool whose whole point is that
                 * they do not have to. sudo takes a password on stdin; the box
                 * is the missing half.
                 *
                 * Optional on purpose: a node with passwordless sudo, or a
                 * recipe that never needs root, should not be asked.
                 */
                const pwWrap = document.createElement("label");
                pwWrap.className = "stack-pw";
                const pwLab = document.createElement("span");
                pwLab.className = "stack-pw-label";
                pwLab.innerText = "Password on " +
                    nodeSel.options[nodeSel.selectedIndex].text +
                    " — only if this needs sudo there";
                const pwIn = document.createElement("input");
                pwIn.type = "password";
                // the house input look, plus a width cap of its own
                pwIn.className = "pref-input stack-pw-input";
                pwIn.autocomplete = "off";
                pwIn.spellcheck = false;
                pwIn.placeholder = "leave empty if sudo already works without one";
                const pwHint = document.createElement("div");
                pwHint.className = "stack-pw-hint";
                pwHint.innerText = "Used to unlock sudo for this run and then " +
                    "dropped. Never saved, never written to the log, never sent " +
                    "anywhere but your own node.";
                pwWrap.append(pwLab, pwIn, pwHint);
                // this machine already stopped asking; do not ask again
                if (sudoFree) pwWrap.classList.add("hidden");

                const bar = document.createElement("div");
                bar.className = "stack-confirm-bar";
                const run = document.createElement("button");
                run.className = "primary small";
                run.innerText = "Run it";
                const cancel = document.createElement("button");
                cancel.className = "ghost small";
                cancel.innerText = "Cancel";
                bar.append(run, cancel);
                /* THE BOX SITS WITH THE BUTTON, NOT BELOW THE COMMANDS.
                 *
                 * .stack-confirm is a 340px scroll area and the bar is sticky
                 * inside it, so anything appended in the flow lands at the
                 * bottom of a long command list — out of sight at the moment
                 * Run is pressed. The thing that decides whether the install
                 * can work cannot be the thing you have to go looking for. */
                const foot = document.createElement("div");
                foot.className = "stack-confirm-foot";
                foot.append(pwWrap, bar);
                panel.appendChild(foot);
                row.appendChild(panel);
                act.innerText = "Close";
                panel.scrollIntoView({ block: "nearest" });

                const dismiss = () => { panel.remove(); act.innerText = was0; };
                cancel.addEventListener("click", dismiss);
                const go = await new Promise((resolve) => {
                    run.addEventListener("click", () => resolve(true), { once: true });
                    cancel.addEventListener("click", () => resolve(false), { once: true });
                });
                if (!go) return;
                // the commands stay on screen while they run — that is the
                // record of what was agreed to
                foot.remove();
                if (installing) { setProgress("One install at a time."); return; }
                /* ASKED, NOT LISTENED FOR.
                 *
                 * The pushed progress channel was tried four ways in this
                 * renderer — inside the panel, at module scope, per run, and
                 * registered lazily — and every one measured ZERO lines arriving
                 * while the node was demonstrably sending them. So this stopped
                 * listening. The main process keeps a record of the run and this
                 * reads it: which step, of how many, how long, and the last
                 * lines the node actually printed.
                 *
                 * A poll cannot be missed by a listener that was never
                 * registered, cannot be lost to a closure from an earlier panel,
                 * and answers after the run has finished — so closing this page
                 * and coming back still shows how it went.
                 */
                live.classList.remove("hidden");
                liveStep.innerText = "connecting to the node…";
                const mmss = (ms) => {
                    const t = Math.max(0, Math.round(ms / 1000));
                    return t < 60 ? `${t}s`
                        : `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`;
                };
                const poll = setInterval(async () => {
                    let p = null;
                    try { p = await window.lcl.stackProgress(nodeId); } catch { return; }
                    const r = p && p.run;
                    if (!r) return;
                    liveStep.innerText = r.step || "working…";
                    liveMeta.innerText =
                        (r.stepNo ? `step ${r.stepNo} of ${r.totalSteps} · ` : "") +
                        mmss(r.elapsedMs) +
                        (r.done ? " total" : " elapsed · still running") +
                        (r.road === "door" ? " · through remote access" : "");
                    /* EACH STEP, WHERE IT IS. The rows were built from the same
                     * recipe the node is running, so this only paints state onto
                     * them — no rebuilding, so an open command stays open and the
                     * scroll position does not jump under the operator. */
                    for (let i = 0; i < rows.length; i++) {
                        const st = (r.steps || [])[i];
                        const row = rows[i];
                        if (!st) continue;
                        row.li.className = "stack-step " + st.state;
                        row.num.innerText = st.state === "done" ? "✓"
                            : st.state === "failed" ? "✕"
                            : st.state === "notneeded" ? "–"
                            : String(i + 1);
                        row.time.innerText = st.ms != null ? mmss(st.ms) : "";
                        const running = st.state === "running";
                        // a bar only where there is a real number behind it; a
                        // fake one that crawls is worse than none
                        if (running && st.pct != null) {
                            row.barWrap.classList.remove("hidden");
                            row.bar.style.width = st.pct + "%";
                            row.note.classList.remove("hidden");
                            row.note.innerText = st.pct + "%" + (st.note ? " · " + st.note : "");
                        } else {
                            row.barWrap.classList.add("hidden");
                            row.note.classList.add("hidden");
                        }
                        if (running && st.line) {
                            row.tail.classList.remove("hidden");
                            row.tail.innerText = st.line;
                        } else {
                            row.tail.classList.add("hidden");
                        }
                    }
                    if (r.done) clearInterval(poll);
                }, 700);
                installing = true;
                act.disabled = true;
                const was = was0;
                act.innerText = "installing…";
                stopBtn.classList.remove("hidden");
                setProgress("starting…");
                clearAsk();
                try {
                    // READ ONCE, CLEARED IMMEDIATELY. It lives in this closure
                    // for the length of one invoke; the field is empty and
                    // locked from the moment Run is pressed.
                    const pwNow = pwIn.value || "";
                    pwIn.value = "";
                    pwIn.disabled = true;
                    const res = await window.lcl.stackInstall(
                        pwNow ? { nodeId, key: s.key, password: pwNow }
                              : { nodeId, key: s.key });
                    // A REFUSED PASSWORD IS RETRYABLE, so the box comes back
                    // ready rather than making him reopen the panel.
                    if (res && res.badPassword) {
                        pwIn.disabled = false;
                        pwWrap.classList.add("bad");
                        pwLab.innerText = "That password was not accepted — try again";
                        try { pwIn.focus(); } catch { }
                    }
                    // THE POLL STOPS HERE, NOT IN `finally`. The result writes a
                    // fuller line than the poll can — it knows whether the
                    // endpoint got linked — and a tick landing a second later
                    // painted over it with the shorter one.
                    try { clearInterval(poll); } catch { }
                    /* DRIVEN BY THE RESULT, NOT BY THE STREAM.
                     *
                     * After clicking run, there is no clear signal whether a
                     *  command has finished.
                     *
                     * The live per-step stream is still owed — see the note on
                     * ensureStackListener; four attempts to receive it in the
                     * renderer all measured zero lines. But the ANSWER to "is it
                     * done" does not need the stream: stackInstall resolves with
                     * ok, the verify sentinel already checked, and the last lines
                     * the node printed. That is awaited here and cannot be missed.
                     */
                    if (res && res.ok) {
                        liveStep.innerText = s.checksOnly
                            ? "this machine is ready for it — nothing was installed"
                            : "finished — and it proved itself working";
                        // AND WHETHER IT IS REACHABLE, in the panel rather than
                        // only in a notice that renders behind this modal. A
                        // server that is running and one the chat box can reach
                        // are different facts, and the operator should not have
                        // to go and find out which one just happened.
                        if (res.wired && !res.wired.error) {
                            liveStep.innerText += " · linked as an endpoint (" +
                                res.wired.baseUrl +
                                (res.wired.models
                                    ? ", " + res.wired.models + " models)" : ")");
                        } else if (res.wired && res.wired.error) {
                            liveStep.innerText +=
                                " · but linking it failed: " + res.wired.error;
                        }
                        // the poll already painted the total from the main
                        // process's own clock, which is the run's real one —
                        // this used a `startedAt` that the poll swap removed
                        // and would have thrown at the moment it reported
                        // success
                        if (!/total/.test(liveMeta.innerText)) {
                            liveMeta.innerText = "done";
                        }
                        if (Array.isArray(res.tail) && res.tail.length) {
                            liveTail.classList.remove("hidden");
                            liveTail.innerText = res.tail.join("\n");
                        }
                        setProgress("Done — and it proved itself working.");
                        // THE JOIN, SAID OUT LOUD. A server that is running and a
                        // server the chat box can reach are different facts, and
                        // the operator should not have to go and check which one
                        // just happened.
                        const w = res.wired;
                        const wiredLine = !w ? ""
                            : w.error
                                ? ` It is running, but linking it as an endpoint failed: ${w.error}. ` +
                                  `Add ${w.baseUrl || "it"} by hand in Connections.`
                                : ` It is linked as an endpoint too — ${w.baseUrl}` +
                                  (w.models ? `, ${w.models} model${w.models === 1 ? "" : "s"} ` +
                                    `already in the picker.` : `.`);
                        addNotice(`${s.name} is up on ` +
                            `${nodeSel.options[nodeSel.selectedIndex].text}.` +
                            wiredLine +
                            (res.after ? ` ${res.after}` : ""));
                        // ...and the picker is refreshed so it is there NOW
                        try { refreshModelPick(); } catch { }
                    } else {
                        /* ...and a failure says so in the same place, with the
                         * lines that explain it rather than a one-line summary.
                         *
                         * "DID NOT FINISH" IS THE WRONG HEADLINE FOR A MACHINE
                         * THAT WAS NEVER REACHED — it says the install got
                         * somewhere and stopped, which is what sent two days
                         * into sudo when a VPN kill switch was refusing the
                         * socket. Nothing ran, and the first line says so. */
                        liveStep.innerText = (res && res.unreached)
                            ? (res.reason === "blocked"
                                ? "could not reach the node — nothing ran"
                                : "never reached the node — nothing ran")
                            : "did not finish";
                        liveMeta.innerText = (res && res.error)
                            ? String(res.error).slice(0, 200) : "unknown";
                        if (res && Array.isArray(res.tail) && res.tail.length) {
                            liveTail.classList.remove("hidden");
                            liveTail.innerText = res.tail.join("\n");
                        }
                        setProgress("Did not finish: " + ((res && res.error) || "unknown"));
                    }
                } catch (e) {
                    setProgress("Did not finish: " + String((e && e.message) || e));
                } finally {
                    try { clearInterval(poll); } catch { }
                    stackRun = null;
                    try { clearInterval(poll); } catch { }
                    installing = false; act.disabled = false; act.innerText = was;
                    stopBtn.classList.add("hidden");
                }
            });
            row.append(nm, meta, act);
            stackWrap.appendChild(row);
        }
        /* ---- TRAINING, beside the software it depends on. "from the manage
         * machine page ... that would be an ideal place to have the same
         * import training data, because it is dependent on the llama factory
         * install." One button: distill the imported training data, ship it
         * through the door, bake the LoRA on the box, stream every line. ---- */
        {
            const th = document.createElement("div");
            th.className = "pref-head";
            th.innerText = "Training";
            stackWrap.appendChild(th);
            const trow = document.createElement("div");
            trow.className = "model-row";
            const tnm = document.createElement("div");
            tnm.className = "model-row-name";
            tnm.innerText = "Train on this machine";
            const tmeta = document.createElement("div");
            tmeta.className = "model-row-meta";
            tmeta.innerText = "bakes the imported training data into a LoRA on the box " +
                "(LLaMA-Factory) - the fleet pauses while it runs, then restarts";
            const tlive = document.createElement("div");
            tlive.className = "model-meta train-live";
            const tbtn = document.createElement("button");
            tbtn.className = "primary small";
            tbtn.innerText = "Train";
            tbtn.addEventListener("click", async (e) => {
                e.stopPropagation();
                const nodeId = nodeSel.value;
                if (!nodeId) { tlive.innerText = "link a node first"; return; }
                tbtn.disabled = true;
                tlive.innerText = "starting\u2026";
                const off = window.lcl.onNodeTrainState
                    ? window.lcl.onNodeTrainState((d) => {
                        if (d && d.nodeId === nodeId && d.detail) tlive.innerText = d.detail;
                      })
                    : null;
                void off;
                const r = await window.lcl.nodeTrain(nodeId)
                    .catch(err => ({ error: String(err && err.message || err) }));
                tbtn.disabled = false;
                tlive.innerText = r && r.ok
                    ? ("adapter baked from " + r.pairs + " pairs in " + r.seconds + "s - " + r.adapter)
                    : ((r && r.error) || "training did not finish");
            });
            trow.append(tnm, tmeta, tbtn, tlive);
            stackWrap.appendChild(trow);
        }

    })();

    const doSearch = async () => {
        results.innerHTML = "";
        setProgress("");
        const h = document.createElement("div");
        h.className = "pref-note";
        h.innerText = "searching…";
        results.appendChild(h);
        const res = await window.lcl.modelSearch({
            query: q.value, kind: kindSel.value, limit: 25
        }).catch(() => null);
        results.innerHTML = "";
        if (!res || res.error) {
            const e = document.createElement("div");
            e.className = "pref-note";
            e.innerText = (res && res.error) || "the search did not work";
            results.appendChild(e);
            return;
        }
        if (!res.models.length) {
            const e = document.createElement("div");
            e.className = "pref-note";
            e.innerText = "nothing matched.";
            results.appendChild(e);
            return;
        }
        for (const m of res.models) results.appendChild(row(m));
    };
    goBtn.addEventListener("click", doSearch);
    q.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

    // NAMED AFTER THE MACHINE. The container should not just say "Model
    // Library" — and "Manage the machine" says nothing about WHICH one when
    // there is more than one.
    await modal({ title: openModelLibrary._for
                      ? "Models and software on " + openModelLibrary._for
                      : "Models and software on this machine",
                  node: wrap,
                  confirmLabel: "Done", confirmOnly: true, size: "xwide" });
}

async function openNodeWizard(preset = null) {
    const wrap = document.createElement("div");
    wrap.className = "pref-wrap wiz";

    const state = { host: preset ? preset.address : "",
                    // the name and user were passed and then ignored — the
                    // sign-in screen greeted the machine by raw address
                    user: (preset && preset.user) || "",
                    name: (preset && preset.name) || "",
                    // the caller's record, when it has one — the head draws
                    // the machine's state from the very first screen
                    node: (preset && preset.node) || null,
                    ready: null, step: 0 };

    const head = document.createElement("div");
    head.className = "wiz-head";
    wrap.appendChild(head);

    const body = document.createElement("div");
    wrap.appendChild(body);

    const foot = document.createElement("div");
    foot.className = "wiz-foot";
    wrap.appendChild(foot);

    // NO STEP PILLS.
    //
    // The wizard step pills ('Find it / Sign in / Check it / Remote access /
    //  Models') should be removed: a green check on 'Find it' reports something
    //  already visible, the state block below already says where the machine
    //  stands and what is next, and the step names add nothing.
    //
    // state.step survives only as the ordinal the screens set on themselves;
    // nothing draws it. The state block is the whole head.
    const paintHead = () => {
        head.innerHTML = "";
        if (state.node) head.appendChild(nodeStateEl(state.node));
    };

    // The standing banner that repeated the remote-access window on every
    // screen is gone. The window is stated by nodeState('local-only') on the
    // row that opens this wizard, and once more in the one sentence on the
    // remote-access step itself — where the decision to do it or skip it is
    // actually made.

    const setFoot = (buttons) => {
        foot.innerHTML = "";
        for (const b of buttons) foot.appendChild(b);
    };
    const btn = (label, cls, fn) => {
        const b = document.createElement("button");
        b.className = cls;
        b.innerText = label;
        b.addEventListener("click", fn);
        return b;
    };

    /* ---------------------------------------------------- 0. find it ---- */
    const stepFind = async () => {
        state.step = 0; paintHead();
        body.innerHTML = "";
        const list = document.createElement("div");
        list.appendChild(loadingNote("looking for machines on this network\u2026"));
        body.appendChild(list);
        setFoot([]);

        // MACHINES YOU ALREADY ADDED COME FIRST, AND ARE NOT PRESENTED AS NEW.
        //
        // A machine already added in connections should not be presented as new.
        // The bug: it was listing an already-added
        // machine under "machines you can set up" as though it were a stranger.
        // An added machine that still needs steps belongs at the top, labelled
        // as what it is: yours, part-way through setup.
        const [lan, disc, known] = await Promise.all([
            window.lcl.scanLan().catch(() => null),
            window.lcl.discoverNodes().catch(() => null),
            window.lcl.nodes().catch(() => null)
        ]);
        const already = ((known && known.nodes) || []).filter(n => !n.hasDoor);
        // remember the record so every step can show its state
        if (state.host) {
            state.node = ((known && known.nodes) || []).find(n => n.host === state.host) || null;
        }
        const seen = new Map();
        for (const c of ((disc && disc.candidates) || [])) seen.set(c.address, c);
        for (const c of ((lan && lan.candidates) || [])) {
            if (!seen.has(c.address)) seen.set(c.address, c);
        }
        const addedHosts = new Set(((known && known.nodes) || []).map(n => n.host));
        const cands = [...seen.values()]
            .filter(c => !c.added && !addedHosts.has(c.address));

        list.innerHTML = "";
        if (!cands.length) {
            const e = document.createElement("div");
            e.className = "eng-empty";
            // same words as the Connections pane's empty state — one fact,
            // one wording, even across surfaces
            e.innerText = "No machines found on this network. Power the " +
                "machine on, plug it in here, and rescan.";
            list.appendChild(e);
        }
        const rowFor = (c, unknown) => {
            const b = document.createElement("button");
            b.className = "node-candidate" + (unknown ? " unknown" : "");
            const named = !!(c.name && c.name !== c.address);
            const nm = document.createElement("span");
            nm.className = "node-cand-name";
            // a bare address is not a name \u2014 do not dress one up as a machine
            nm.innerText = named ? c.name : c.address;
            const meta = document.createElement("span");
            meta.className = "node-cand-meta";
            meta.innerText = ((c.serving && c.serving.length)
                ? "serving " + c.serving.map(x => x.label).join(", ")
                : "answering \u2014 no model server on it yet")
                + (named ? " \u00b7 " + c.address : "");
            const via = document.createElement("span");
            via.className = "node-cand-via";
            via.innerText = c.via === "tailscale" ? "tailscale"
                : c.via === "nvidia-sync" ? "nvidia sync" : "this network";
            b.appendChild(nm); b.appendChild(meta); b.appendChild(via);
            b.addEventListener("click", () => {
                state.host = c.address;
                state.name = named ? c.name : c.address;
                // a fresh machine has no stored record yet, but the head still
                // needs a state to draw — and "unconfirmed" is the truth for
                // anything never pinned: confirming it IS the next screen
                state.node = { ssh: "unconfirmed", serving: c.serving || [],
                               linked: false, hasDoor: false };
                stepSignIn();
            });
            return b;
        };

        // A MACHINE SERVING MODELS IS A NODE. Everything else with port 22
        // open is a router, a NAS, a printer \u2014 real, but not what is being
        // looked for. Listing them as equals produced confusion like "apparently
        // there are now 3 nodes?" on a home network. Serving machines lead; the rest sit
        // behind a count.
        const serving = cands.filter(c => (c.serving || []).length);
        const namedIdle = cands.filter(c => !(c.serving || []).length
            && c.name && c.name !== c.address);
        const anonymous = cands.filter(c => !(c.serving || []).length
            && !(c.name && c.name !== c.address));

        const group = (label, items, unknown) => {
            if (!items.length) return;
            const h = document.createElement("div");
            h.className = "wiz-group";
            h.innerText = label;
            list.appendChild(h);
            for (const c of items) list.appendChild(rowFor(c, unknown));
        };
        // yours first, and never filed under "machines you can set up"
        if (already.length) {
            const h = document.createElement("div");
            h.className = "wiz-group";
            h.innerText = "Already added — finish setting up";
            list.appendChild(h);
            for (const n of already) {
                const b = document.createElement("button");
                b.className = "node-candidate";
                const nm = document.createElement("span");
                nm.className = "node-cand-name";
                nm.innerText = n.name || n.host;
                const meta = document.createElement("span");
                meta.className = "node-cand-meta";
                // the one classifier, not a third hand-written copy of it
                meta.innerText = nodeState(n).label;
                const via = document.createElement("span");
                via.className = "node-cand-via";
                via.innerText = "yours";
                b.appendChild(nm); b.appendChild(meta); b.appendChild(via);
                b.addEventListener("click", () => {
                    state.host = n.host;
                    state.name = n.name || n.host;
                    state.user = n.user || "";
                    state.node = n;
                    stepSignIn();
                });
                list.appendChild(b);
            }
        }
        group("Serving models now", serving, false);
        group("Machines you can set up", namedIdle, false);

        if (anonymous.length) {
            const d = document.createElement("details");
            d.className = "wiz-other";
            const sum = document.createElement("summary");
            sum.innerText = anonymous.length === 1
                ? "1 other device answered on this network"
                : anonymous.length + " other devices answered on this network";
            d.appendChild(sum);
            for (const c of anonymous) d.appendChild(rowFor(c, true));
            list.appendChild(d);
        }

        const manual = document.createElement("details");
        manual.className = "node-manual";
        const sum = document.createElement("summary");
        sum.innerText = "Enter an address instead";
        manual.appendChild(sum);
        const box = document.createElement("div");
        box.className = "cloud-paste-box";
        const ip = document.createElement("input");
        ip.className = "cloud-paste";
        ip.placeholder = "hostname or IP";
        ip.spellcheck = false;
        const go = btn("Use this", "primary small", () => {
            if (!ip.value.trim()) return;
            state.host = ip.value.trim();
            state.name = state.host;
            stepSignIn();
        });
        box.appendChild(ip); box.appendChild(go);
        manual.appendChild(box);
        list.appendChild(manual);

        setFoot([btn("Rescan", "ghost small", stepFind)]);
    };

    /* --------------------------------------------------- 1. sign in ---- */
    const stepSignIn = async () => {
        state.step = 1; paintHead();
        body.innerHTML = "";
        const h = document.createElement("div");
        h.className = "pref-head";
        h.innerText = state.name || state.host;
        body.appendChild(h);

        // CONFIRM THE MACHINE BEFORE TYPING A PASSWORD INTO IT.
        //
        // A security review found this exact hole: the app trusted whatever
        // answered the address, then asked for the machine's account password.
        // Anyone able to answer for that address on this network \u2014 including
        // by taking the address of a machine that is switched off \u2014 collected
        // it, and on a Linux box that is usually the sudo password too.
        //
        // So the fingerprint is shown FIRST, with the command to check it
        // against the machine itself. Nothing else in the app will talk to an
        // unconfirmed machine.
        const key = await window.lcl.nodeHostKey(state.host).catch(() => null);
        if (key && key.ok && !key.pinned) {
            const box = document.createElement("div");
            box.className = "wiz-window";
            box.innerText = "Confirm this is your machine before going further. " +
                "Its fingerprint is below. On the machine itself, run:\n\n" +
                "    " + key.verifyOn + "\n\n" +
                "If the fingerprints match, it is your machine. If they do not, " +
                "something else is answering at this address \u2014 stop here.";
            body.appendChild(box);

            for (const p of key.prints) {
                const line = document.createElement("div");
                line.className = "eng-host wiz-fingerprint";
                line.innerText = p.fingerprint + "   (" + p.type + ", " + p.bits + " bit)";
                body.appendChild(line);
            }

            const said = document.createElement("div");
            said.className = "pref-note";
            body.appendChild(said);

            setFoot([
                btn("Back", "ghost small", stepFind),
                btn("It does not match", "ghost small danger-text", () => {
                    said.innerText = "Stopped. Nothing was sent to that address. " +
                        "Check what is answering at " + state.host + " before retrying.";
                    setFoot([btn("Back", "ghost small", stepFind)]);
                }),
                btn("Fingerprints match \u2014 continue", "primary small", async () => {
                    said.innerHTML = "";
                    said.appendChild(loadingNote("recording this machine's identity\u2026"));
                    // send back exactly what was on screen, so what gets
                    // recorded is what was confirmed
                    const r = await window.lcl.nodePinHostKey(
                        state.host, key.prints.map(p => p.fingerprint))
                        .catch(e => ({ error: String(e && e.message || e) }));
                    if (r && r.ok) stepSignIn();
                    else said.innerText = (r && r.error) || "could not record it";
                })
            ]);
            return;
        }
        if (key && key.error) {
            const e = document.createElement("div");
            e.className = "pref-note";
            e.innerText = "Could not read that machine's identity: " + key.error;
            body.appendChild(e);
            setFoot([btn("Back", "ghost small", stepFind),
                     btn("Retry", "primary small", stepSignIn)]);
            return;
        }

        const status = document.createElement("div");
        status.className = "pref-note";
        status.appendChild(loadingNote("checking whether this computer is already trusted\u2026"));
        body.appendChild(status);
        setFoot([]);

        const chk = await window.lcl.nodeAuthCheck({ host: state.host, user: state.user })
            .catch(() => null);
        status.innerHTML = "";
        if (chk && chk.ok) {
            status.innerText = "Already trusted \u2014 no password needed.";
            setFoot([btn("Back", "ghost small", stepFind),
                     btn("Continue", "primary small", stepCheck)]);
            return;
        }

        status.innerText = "This computer is not trusted by that machine yet. " +
            "Its username and password are needed once; the password goes " +
            "straight to that machine and is never seen here.";

        const box = document.createElement("div");
        box.className = "cloud-paste-box";
        const u = document.createElement("input");
        u.className = "cloud-paste";
        u.placeholder = "username on that machine";
        u.spellcheck = false;
        u.value = state.user;
        box.appendChild(u);
        body.appendChild(box);

        const outcome = document.createElement("div");
        outcome.className = "pref-note";
        body.appendChild(outcome);

        const authorize = btn("Authorise", "primary small", async () => {
            state.user = u.value.trim();
            if (!state.user) { outcome.innerText = "A username is required."; return; }
            const r = await window.lcl.nodeAuthorize({ host: state.host, user: state.user })
                .catch(e => ({ error: String(e && e.message || e) }));
            outcome.innerText = (r && (r.note || r.error)) || "no response";
            if (r && r.ok) setFoot([btn("Back", "ghost small", stepFind),
                                    btn("I typed it \u2014 check again", "primary small", stepSignIn)]);
        });
        setFoot([btn("Back", "ghost small", stepFind), authorize]);
    };

    /* ---------------------------------------------------- 2. check ---- */
    const stepCheck = async () => {
        state.step = 2; paintHead();
        body.innerHTML = "";
        body.appendChild(loadingNote("reading what that machine already has\u2026"));
        setFoot([]);

        const r = await window.lcl.nodeReadiness({ host: state.host, user: state.user })
            .catch(() => null);
        body.innerHTML = "";
        if (!r || !r.ok) {
            const e = document.createElement("div");
            e.className = "pref-note";
            e.innerText = "Could not read it: " + ((r && r.error) || "no answer");
            body.appendChild(e);
            setFoot([btn("Back", "ghost small", stepSignIn),
                     btn("Retry", "primary small", stepCheck)]);
            return;
        }
        state.ready = r;

        // A missing prerequisite says what to do ON ITS OWN ROW. The banner
        // that used to restate the table below it named both prerequisites
        // regardless of which was missing — so a machine with python3 present
        // was told to install python3.
        const need = " — needed for remote access; install it on that machine";
        const rows = [
            ["System", (r.os || "?") + " " + (r.arch || ""), true],
            ["python3", r.python3 ? "present" : "missing" + need, r.python3],
            ["Tailscale", r.tailscale ? (r.tailscaleUp ? "running" : "installed, not up")
                : "missing" + need, r.tailscale && r.tailscaleUp],
            ["Model server", r.servingOllama ? "serving on 11434"
                : r.ollama ? "installed, not serving" : "not installed", r.servingOllama],
            // installed is NOT the same as reachable from outside — the gap
            // between the two is exactly where a whole night was lost
            ["Remote access", r.doorStale
                ? `installed, but version ${r.doorVersion} — this build wants ` +
                  `${r.doorWanted}, and installs cannot come through an older one`
                : r.doorInstalled && r.doorPublished
                ? "ready to use from anywhere"
                : r.doorInstalled ? "installed, not published — one step left"
                : "not installed",
                r.doorInstalled && r.doorPublished && !r.doorStale]
        ];
        const t = document.createElement("div");
        t.className = "wiz-check";
        for (const [k, v, good] of rows) {
            const row = document.createElement("div");
            row.className = "wiz-check-row" + (good ? " good" : "");
            const a = document.createElement("span"); a.innerText = k;
            const b2 = document.createElement("span");
            b2.className = "wiz-check-val"; b2.innerText = v;
            row.appendChild(a); row.appendChild(b2);
            t.appendChild(row);
        }
        body.appendChild(t);

        // THE MISSING MODEL SERVER GETS A BUTTON, NOT JUST A VERDICT.
        //
        // This screen printed "Model server: not installed" and offered Back
        // and Continue — and Continue walked on to link models from a machine
        // that serves none, then reported the failure. The one control that
        // installs it lived only on the Connections row, and only appeared
        // there when the machine was already signed in and not yet serving.
        // The state block at the top of this very wizard says "Next: Install
        // the model server on it" with nothing under it to press.
        if (!r.servingOllama) {
            const out = document.createElement("div");
            out.className = "pref-note";
            body.appendChild(out);

            const install = btn("Install the model server", "primary small", async () => {
                out.innerHTML = "";
                out.appendChild(loadingNote("starting the installer on that machine…"));
                // the node has to be recorded before it can be driven
                let id = null;
                const known = await window.lcl.nodes().catch(() => null);
                const hit = ((known && known.nodes) || []).find(n => n.host === state.host);
                if (hit) id = hit.id;
                else {
                    await window.lcl.nodeAdd({ host: state.host, user: state.user,
                                               name: state.name }).catch(() => null);
                    const again = await window.lcl.nodes().catch(() => null);
                    const h2 = ((again && again.nodes) || []).find(n => n.host === state.host);
                    id = h2 ? h2.id : null;
                }
                if (!id) { out.innerText = "Could not record that machine."; return; }
                const res = await window.lcl.nodeSetup(id)
                    .catch(e => ({ error: String(e && e.message || e) }));
                out.innerText = (res && (res.note || res.error)) || "no response";
            });
            setFoot([btn("Back", "ghost small", stepSignIn), install,
                     btn("Check again", "ghost small", stepCheck),
                     btn("Skip for now", "ghost small", stepRemote)]);
            return;
        }

        setFoot([btn("Back", "ghost small", stepSignIn),
                 btn("Continue", "primary small", stepRemote)]);
    };

    /* --------------------------------------------- 3. remote access ---- */
    const stepRemote = async () => {
        state.step = 3; paintHead();
        body.innerHTML = "";

        const out = document.createElement("div");
        out.className = "pref-note";
        body.appendChild(out);

        const r0 = state.ready || {};
        // Skip ONLY when the whole job is done: door installed AND actually
        // published to the internet. Skipping on the token file alone jumped
        // the one screen that finishes the work, while the readiness table
        // called it "installed" — observed as remote access
        // that existed and worked from nowhere.
        // A STALE DOOR IS NOT A FINISHED ONE. Skipping setup whenever ANY door
        // was installed meant a node could never be updated from inside the
        // app — and v4 is the one that carries an install through a VPN kill
        // switch, which is the whole reason this screen matters now.
        if (r0.doorInstalled && r0.doorPublished && !r0.doorStale) return stepModels();

        // WHAT, then WHEN, in one sentence, once. The when — you are on its
        // network NOW, and from anywhere else there is no way in — is the one
        // fact that cannot be recovered later, and this screen is where the
        // do-it-or-skip-it decision is made.
        out.innerText = (r0.doorInstalled
            ? "Remote access is installed on that machine but not published " +
              "yet, so nothing outside its network can reach it. This " +
              "finishes the job."
            : "This installs a small authenticated service on that machine " +
              "so .lcl can reach it from any network — from work, on another " +
              "connection, behind a VPN.") +
            " It can only be done while the machine is still reachable — " +
            "so now, not after something starts blocking the way in. " +
            "No password is required.";

        const install = btn(r0.doorStale ? "Update remote access"
            : r0.doorInstalled ? "Finish remote access"
                                             : "Install remote access",
                            "primary small", async () => {
            out.innerHTML = "";
            out.appendChild(loadingNote("installing\u2026"));
            setFoot([]);
            // add the node first if it is not known yet — the door install
            // works from the stored record
            let id = null;
            const known = await window.lcl.nodes().catch(() => null);
            const hit = ((known && known.nodes) || []).find(n => n.host === state.host);
            if (hit) id = hit.id;
            else {
                const add = await window.lcl.nodeAdd({ host: state.host, user: state.user,
                                                      name: state.name }).catch(() => null);
                const again = await window.lcl.nodes().catch(() => null);
                const h2 = ((again && again.nodes) || []).find(n => n.host === state.host);
                id = h2 ? h2.id : null;
                if (!add || !add.ok || !id) {
                    out.innerText = "Could not record that machine.";
                    setFoot([btn("Back", "ghost small", stepCheck)]);
                    return;
                }
            }
            // WHATEVER THIS MACHINE ACTUALLY SERVES. Hardcoding 11434 here
            // silently dropped support for a llama.cpp, vLLM or TRT node,
            // which serve on their own ports — remote access would have
            // pointed at a closed socket. The probed port is the truth.
            const nowKnown = await window.lcl.nodes().catch(() => null);
            const rec = ((nowKnown && nowKnown.nodes) || []).find(n => n.host === state.host);
            const port = (rec && rec.serving && rec.serving[0] && rec.serving[0].port)
                || 11434;
            const res = await window.lcl.nodeDoorSetup(id, port)
                .catch(e => ({ error: String(e && e.message || e) }));

            // Tailscale's approval page is the tail of THIS step, not a
            // separate button the user has to interpret. Open it, say what it
            // is for, and carry on.
            if (res && res.funnelEnableUrl) {
                await window.lcl.openExternal(res.funnelEnableUrl).catch(() => null);
                out.innerText = "One approval left, and here is why: reaching a " +
                    "machine from outside its own network is a privileged change, " +
                    "so Tailscale asks the account owner to allow it on a page " +
                    "they are signed in to — no application can do that for you. " +
                    "A page just opened; approve it there. This is once per " +
                    "account, not once per machine: everything you add after " +
                    "this skips the step.";
                // THE LINK LIVES IN THE UI, not only in a browser that may or
                // may not have opened. The node's own approval address, drawn
                // where it can be read, clicked at and copied — reported from
                // the field when this URL existed only inside a terminal
                // scrollback and the approval silently never happened.
                const gate = document.createElement("div");
                gate.className = "eng-host wiz-fingerprint";
                gate.innerText = res.funnelEnableUrl;
                body.appendChild(gate);
                setFoot([btn("Back", "ghost small", stepCheck),
                         btn("I approved it — finish now", "primary small", stepRemote)]);
                return;
            }
            if (res && res.ok && res.published) {
                out.innerText = "Remote access is up — this machine is now " +
                    "reachable from any network, including behind a VPN.";
                setFoot([btn("Continue", "primary small", stepModels)]);
                return;
            }
            // ONE PASSWORD, ONCE, AND THE APP ASKS FOR IT.
            //
            // Tailscale refuses to publish for a non-root user until the owner
            // has run `tailscale set --operator` once. That is the wall every
            // previous attempt died against, silently, because nothing could
            // type a sudo password. The app opens the terminal itself — the
            // operator types the password into their own machine, and .lcl
            // never sees it.
            if (res && res.needsPassword) {
                out.innerText = "One step on that machine needs its password, once. " +
                    "This is the last thing standing between you and using it from " +
                    "anywhere — after it, .lcl can do the rest on its own, forever.";
                const said = document.createElement("div");
                said.className = "pref-note";
                body.appendChild(said);
                setFoot([
                    btn("Open the password prompt", "primary small", async () => {
                        const known = await window.lcl.nodes().catch(() => null);
                        const rec = ((known && known.nodes) || [])
                            .find(x => x.host === state.host);
                        const prt = (rec && rec.serving && rec.serving[0]
                                     && rec.serving[0].port) || 11434;
                        const g = await window.lcl.nodeFunnelGrant(rec && rec.id, prt)
                            .catch(e => ({ error: String(e && e.message || e) }));
                        said.innerText = (g && (g.note || g.error)) || "no response";
                    }),
                    btn("Check again", "ghost small", stepRemote)
                ]);
                return;
            }
            out.innerText = (res && (res.note || res.error)) || "no response";
            setFoot([btn("Back", "ghost small", stepCheck),
                     btn("Continue", "primary small", stepModels)]);
        });
        setFoot([btn("Back", "ghost small", stepCheck), install]);
    };

    /* --------------------------------------------------- 4. models ---- */
    const stepModels = async () => {
        state.step = 4; paintHead();
        body.innerHTML = "";
        const out = document.createElement("div");
        out.className = "pref-note";
        out.appendChild(loadingNote("linking its models\u2026"));
        body.appendChild(out);
        setFoot([]);

        const known = await window.lcl.nodes().catch(() => null);
        const hit = ((known && known.nodes) || []).find(n => n.host === state.host);
        if (!hit) {
            out.innerText = "That machine is not recorded yet \u2014 go back a step.";
            // back to the readiness screen: stepRemote self-skips when remote
            // access is already installed, so it cannot be a Back target
            setFoot([btn("Back", "ghost small", stepCheck)]);
            return;
        }
        const port = (hit.serving && hit.serving[0] && hit.serving[0].port) || 11434;
        const r = await window.lcl.nodeLink(hit.id, port)
            .catch(e => ({ error: String(e && e.message || e) }));
        out.innerText = (r && (r.summary || r.error)) || "no response";
        if (r && r.ok) await refreshModelPick();

        // On failure, `out` above already carries the machine's own error \u2014
        // an extra line guessing at the cause restated the failure, vaguer.
        // On success the summary is above too, so this line carries only the
        // one thing it doesn't: where the models now are.
        if (r && r.ok) {
            const done = document.createElement("div");
            done.className = "pref-note";
            done.innerText = "Its models are in the model button next to the composer.";
            body.appendChild(done);
        }
        setFoot([btn("Done", "primary small", () => closeModal(true))]);
    };

    paintHead();
    if (state.host) stepSignIn(); else stepFind();
    await modal({ title: "Set up a local machine", node: wrap,
                  confirmLabel: "Close", confirmOnly: true, size: "wide" });
}

// =============================================================
// SPEND — the ledger, drawn
// =============================================================
/**
 * The requirement: not a bare list — charts, graphs, and fully readable
 * transaction tables.
 *
 * Four views over the same rows: the headline totals, spend per day as bars,
 * per model, per session (deleted ones included and marked), and the raw
 * transaction table. Every number is the PROVIDER's own reported token count,
 * never the composer's pre-send estimate — those are different instruments and
 * conflating them is what made the old readout untrustworthy.
 */
const usdFmt = (n) => n === 0 ? "$0.00"
    : n < 0.01 ? "$" + n.toFixed(4)
    : "$" + n.toFixed(2);

async function openSpend() {
    let d = null;
    try { d = await window.lcl.costSummary(); }
    catch (e) { return dialogFailed("Spend", e); }
    const wrap = document.createElement("div");
    wrap.className = "pref-wrap spend-wrap";

    if (!d || !d.calls) {
        const n = document.createElement("div");
        n.className = "pref-note";
        n.innerText = "Nothing billed yet. Models on this computer and on your " +
            "own machines are free.";
        wrap.appendChild(n);
        await modal({ title: "Spend", node: wrap, confirmLabel: "Close", confirmOnly: true });
        return;
    }

    // ---- headline ----
    const tiles = document.createElement("div");
    tiles.className = "spend-tiles";
    const tile = (label, value, sub) => {
        const t = document.createElement("div");
        t.className = "spend-tile";
        const v = document.createElement("div");
        v.className = "spend-tile-val"; v.innerText = value;
        const l = document.createElement("div");
        l.className = "spend-tile-label"; l.innerText = label;
        t.appendChild(v); t.appendChild(l);
        if (sub) {
            const s2 = document.createElement("div");
            s2.className = "spend-tile-sub"; s2.innerText = sub;
            t.appendChild(s2);
        }
        tiles.appendChild(t);
    };
    tile("total spend", usdFmt(d.totalUsd), `${d.calls} calls`);
    tile("tokens in", d.totalIn.toLocaleString());
    tile("tokens out", d.totalOut.toLocaleString());
    tile("by local escalation", usdFmt(d.escalationUsd),
         "local models calling APIs");
    // WHAT THE HARDWARE EARNED BACK. Node rows carry real token counts and a
    // certain $0, so without a tile of their own they vanish into a total that
    // reads as "nothing happened" — the opposite of the truth for someone who
    // bought a machine precisely so this number would be zero.
    if (d.node && d.node.calls) {
        tile("on your own machine", "$0",
             `${d.node.calls} call${d.node.calls === 1 ? "" : "s"} · ` +
             `${(d.node.inputTokens + d.node.outputTokens).toLocaleString()} tokens, unbilled`);
    }
    wrap.appendChild(tiles);

    // ---- per day, as bars ----
    if (d.days.length) {
        const h = document.createElement("div");
        h.className = "pref-head"; h.innerText = "Per day";
        wrap.appendChild(h);
        const chart = document.createElement("div");
        chart.className = "spend-chart";
        const max = Math.max(...d.days.map(x => x.usd), 0.0001);
        for (const day of d.days.slice(-30)) {
            const col = document.createElement("div");
            col.className = "spend-bar-col";
            col.title = `${day.day} — ${usdFmt(day.usd)}`;
            const bar = document.createElement("div");
            bar.className = "spend-bar";
            bar.style.height = Math.max(2, Math.round((day.usd / max) * 180)) + "px";
            const lab = document.createElement("div");
            lab.className = "spend-bar-label";
            lab.innerText = day.day.slice(5);
            col.appendChild(bar); col.appendChild(lab);
            chart.appendChild(col);
        }
        wrap.appendChild(chart);
    }

    // ---- a table builder shared by the three breakdowns ----
    const table = (title, cols, rows, parent = wrap) => {
        const h = document.createElement("div");
        h.className = "pref-head"; h.innerText = title;
        parent.appendChild(h);
        const t = document.createElement("table");
        t.className = "spend-table";
        const thead = document.createElement("thead");
        const hr = document.createElement("tr");
        for (const c of cols) {
            const th = document.createElement("th");
            th.innerText = c;
            hr.appendChild(th);
        }
        thead.appendChild(hr); t.appendChild(thead);
        const tb = document.createElement("tbody");
        for (const r of rows) {
            const tr = document.createElement("tr");
            for (const cell of r) {
                const td = document.createElement("td");
                if (cell && cell.node) td.appendChild(cell.node);
                else td.innerText = String(cell);
                tr.appendChild(td);
            }
            tb.appendChild(tr);
        }
        t.appendChild(tb);
        parent.appendChild(t);
    };

    // Per model and Per session side by side — the dialog is now nearly the
    // window, and stacking two half-width tables in a full-width column was
    // the "tiny pop up" wasting the very space it asked for.
    const duo = document.createElement("div");
    duo.className = "spend-cols";
    const colModels = document.createElement("div");
    const colSessions = document.createElement("div");
    duo.appendChild(colModels);
    duo.appendChild(colSessions);

    table("Per model", ["model", "calls", "in", "out", "spend"],
        d.models.map(m => [
            m.model.split("/").pop(), m.calls,
            m.inputTokens.toLocaleString(), m.outputTokens.toLocaleString(),
            usdFmt(m.usd)
        ]), colModels);

    // WHERE THE INPUT TOKENS ACTUALLY GO.
    //
    // A single "hello" call was reported as costing 20k tokens.
    // True — 19,918 of them — and unexplainable without this. The message was
    // two tokens; the rest is the standing context re-sent on every turn,
    // because that is how a stateless API works. A cost readout that cannot
    // show this is one nobody can trust.
    if (d.composition) {
        const h = document.createElement("div");
        h.className = "pref-head";
        h.innerText = "Where input tokens go (average per call)";
        wrap.appendChild(h);
        const c = d.composition;
        const totalC = Math.max(1, c.systemTokens + c.historyTokens + c.messageTokens);
        const bar = document.createElement("div");
        bar.className = "comp-bar";
        for (const [label, val, cls] of [
            ["system prompt + tool definitions", c.systemTokens, "comp-sys"],
            ["conversation so far", c.historyTokens, "comp-hist"],
            ["your message", c.messageTokens, "comp-msg"]
        ]) {
            const seg = document.createElement("div");
            seg.className = "comp-seg " + cls;
            seg.style.width = ((val / totalC) * 100).toFixed(1) + "%";
            seg.title = `${label}: ~${val.toLocaleString()} tokens`;
            bar.appendChild(seg);
        }
        wrap.appendChild(bar);
        const legend = document.createElement("div");
        legend.className = "comp-legend";
        legend.innerHTML = "";
        for (const [label, val, cls] of [
            ["system + tools", c.systemTokens, "comp-sys"],
            ["history", c.historyTokens, "comp-hist"],
            ["your message", c.messageTokens, "comp-msg"]
        ]) {
            const item = document.createElement("span");
            const dot = document.createElement("i");
            dot.className = "comp-dot " + cls;
            item.appendChild(dot);
            item.appendChild(document.createTextNode(
                `${label} ~${val.toLocaleString()}`));
            legend.appendChild(item);
        }
        wrap.appendChild(legend);
        const n = document.createElement("div");
        n.className = "pref-note";
        n.innerText = "Every turn re-sends the whole context — that is how these APIs bill.";
        wrap.appendChild(n);
    }

    wrap.appendChild(duo);

    table("Per session", ["session", "calls", "models", "spend"],
        d.sessions.map(x => {
            const name = document.createElement("span");
            name.innerText = x.title || "(untitled)";
            if (x.deleted) {
                const tag = document.createElement("span");
                tag.className = "spend-deleted";
                tag.innerText = "deleted";
                name.appendChild(tag);
            }
            // CLICK A SESSION TO SEE ITS CALLS. Multilevel: totals -> session
            // -> every call in it, with that call's own composition.
            name.className = "spend-drill";
            name.title = "click to see every call in this session";
            name.addEventListener("click", () => {
                const open = wrap.querySelector(".spend-detail[data-s=\"" + x.sessionId + "\"]");
                if (open) { open.remove(); return; }
                const rows = d.recent.filter(r => r.sessionId === x.sessionId);
                const det = document.createElement("div");
                det.className = "spend-detail";
                det.dataset.s = x.sessionId;
                for (const r of rows) {
                    const line = document.createElement("div");
                    line.className = "spend-detail-row";
                    const when = new Date(r.at).toLocaleTimeString();
                    const comp = r.composition
                        ? ` — system ${(r.composition.estSystemTokens || 0).toLocaleString()}` +
                          ` · history ${(r.composition.estHistoryTokens || 0).toLocaleString()}` +
                          ` · message ${(r.composition.estMessageTokens || 0).toLocaleString()}`
                        : "";
                    line.innerText = `${when} · ${r.model.split("/").pop()} · ` +
                        `${r.inputTokens.toLocaleString()} in / ${r.outputTokens.toLocaleString()} out · ` +
                        `${usdFmt(r.usd)}${comp}`;
                    det.appendChild(line);
                }
                name.parentElement.parentElement.after(det);
            });
            return [{ node: name }, x.calls,
                    x.models.map(m => m.split("/").pop()).join(", "), usdFmt(x.usd)];
        }), colSessions);

    table("Transactions", ["when", "session", "model", "in", "out", "spend", "via"],
        d.recent.slice(0, 100).map(r => [
            new Date(r.at).toLocaleString(),
            (r.sessionTitle || "—").slice(0, 48),
            r.model.split("/").pop(),
            r.inputTokens.toLocaleString(),
            r.outputTokens.toLocaleString(),
            usdFmt(r.usd),
            // WHO SPENT THIS. "you" for everything was fine while every call
            // was the user's; the app now also spends on its own behalf when
            // it reviews and repairs its own work, and that has to be
            // distinguishable in the one place spend is accounted for.
            r.via === "local-escalation" ? "local→API"
                : r.via === "self-audit" ? "self-review"
                : r.via === "ancient-knowledge" ? "AK audit" : "you"
        ]));

    await modal({ title: "Spend", node: wrap, confirmLabel: "Close",
                  confirmOnly: true, size: "max" });
}

/**
 * EXPORT TRAINING DATA — consent first, then one local write.
 *
 * The dialog names BOTH sources with their real resolved paths and live
 * counts, each untickable, because per-machine memory can name other
 * projects and the session store differs between dev and packaged builds:
 * the operator ticks what actually ships. Both boxes off = Export disabled.
 */
async function openTrainingExport() {
    let probe = null;
    try { probe = await window.lcl.exportTrainingData({ sessions: true, memory: true, probe: true }); }
    catch (e) { return dialogFailed("Export training data", e); }
    if (!probe || probe.error || !probe.counts) {
        return dialogFailed("Export training data", (probe && probe.error) || "no answer");
    }

    const wrap = document.createElement("div");
    wrap.className = "pref-wrap";
    const note = document.createElement("div");
    note.className = "pref-note";
    note.innerText = "Written locally to data/training/. Secrets are redacted " +
        "before writing. Nothing is uploaded and no model is called.";
    wrap.appendChild(note);

    const boxes = [];
    const sourceRow = (label, dir) => {
        const row = document.createElement("label");
        row.className = "kn-link-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        // both sources off leaves nothing to export — the button says so
        cb.addEventListener("change", () => {
            $("modal-confirm").disabled = !boxes.some(b => b.checked);
        });
        boxes.push(cb);
        const name = document.createElement("span");
        name.className = "kn-link-name";
        name.innerText = label;
        const meta = document.createElement("span");
        meta.className = "kn-link-meta";
        meta.innerText = dir;
        row.appendChild(cb); row.appendChild(name); row.appendChild(meta);
        wrap.appendChild(row);
        return cb;
    };
    const sessBox = sourceRow(
        `${probe.counts.sessions} .lcl session transcript${probe.counts.sessions === 1 ? "" : "s"}`,
        probe.sessionsDir || "");
    const memBox = sourceRow(
        `${probe.counts.memoryFiles} Claude Code memory note${probe.counts.memoryFiles === 1 ? "" : "s"}`,
        probe.memoryRoot || "");

    const go = await modal({ title: "Export training data", node: wrap,
                             confirmLabel: "Export" });
    // this dialog is the only one that disables the shared confirm button —
    // hand the next modal a working one either way
    $("modal-confirm").disabled = false;
    if (!go) return;

    const res = await window.lcl.exportTrainingData({
        sessions: sessBox.checked, memory: memBox.checked }).catch(() => null);
    // `res.dir` only when the main process really returned one — "Exported
    // to undefined" is a sentence this app must never print
    if (res && res.ok) {
        addNotice(`Training data exported to ${res.dir} — ` +
            `${res.counts.records} records, ${res.redactions.count} secrets redacted.`);
    } else {
        addNotice("Training export failed" + (res && res.error ? `: ${res.error}` : "."));
    }
}

// =============================================================
// ESCALATION — may a local model spend money?
// =============================================================
/**
 * Two yeses required, by design: a global switch, and a per-session list of
 * which remote models this session's local model may call. Absent either, the
 * escalation tools are never offered to the model at all.
 */
async function openEscalation() {
    if (!active) return;
    const [g, models] = await Promise.all([
        window.lcl.escalation().catch(() => ({ enabled: false })),
        window.lcl.listModels().catch(() => ({ models: [] }))
    ]);
    const remote = ((models && models.models) || []).filter(m => m.remote && m.usable);

    const wrap = document.createElement("div");
    wrap.className = "pref-wrap";

    // ---- THE ASSIGNMENT MAP: which model does which kind of work ----
    // The intelligent half. The operator assigns a reachable model (any mode)
    // to a kind of task; the session follows it as a standing instruction and
    // Ancient Knowledge reads the same plan. Fallback below is this same idea
    // under duress — the chosen model could not answer.
    let readTaskMap = () => null;   // filled by the block, read on Save
    {
        const oh = document.createElement("div");
        oh.className = "pref-head";
        oh.innerText = "Use these models for these tasks";
        wrap.appendChild(oh);
        const on = document.createElement("div");
        on.className = "pref-note";
        on.innerText = "Assign any reachable model — local, node, API or rented — " +
            "to a kind of work. This conversation follows it, and Ancient " +
            "Knowledge judges each part against the model meant to do it. Leave " +
            "one on “no preference” and the session's own model handles it.";
        wrap.appendChild(on);

        const allModels = (models && models.models) || [];
        const cur = (active.taskModels && typeof active.taskModels === "object") ? active.taskModels : {};
        const curValue = (cap) => {
            const v = cur[cap];
            if (!v || !v.model) return "";
            return v.endpointId != null
                ? v.endpointId + "|" + v.model + "|" + (v.endpointLabel || "")
                : "local|" + v.model;
        };
        const CAPS = [
            ["drawing", "Images & drawing"],
            ["vision", "Reading images"],
            ["code", "Coding"],
            ["reasoning", "Hard reasoning"],
            ["agentic", "Multi-step / agent"]
        ];
        const pickers = {};
        for (const [cap, label] of CAPS) {
            const rowl = document.createElement("div");
            rowl.className = "orch-row";
            const nm = document.createElement("span");
            nm.className = "orch-cap";
            nm.innerText = label;
            // the rich grouped picker — modes always shown, GPU reserved even
            // when empty, styled like the chat selector
            const picker = mkModePicker(allModels, curValue(cap), () => {});
            pickers[cap] = picker;
            rowl.appendChild(nm);
            rowl.appendChild(picker.el);
            wrap.appendChild(rowl);
        }
        // committed on Save, not on change, so Cancel discards. Split on "|":
        // ids never contain it and the label is last so a "|" in it is safe.
        readTaskMap = () => {
            const map = {};
            for (const [cap] of CAPS) {
                const v = pickers[cap].value();
                if (!v) continue;
                if (v.startsWith("local|")) { map[cap] = { model: v.slice(6) }; continue; }
                const first = v.indexOf("|"), second = v.indexOf("|", first + 1);
                const endpointId = v.slice(0, first);
                const model = second < 0 ? v.slice(first + 1) : v.slice(first + 1, second);
                const endpointLabel = second < 0 ? "" : v.slice(second + 1);
                map[cap] = { model, endpointId: endpointId || undefined,
                             endpointLabel: endpointLabel || undefined };
            }
            return map;
        };
    }

    // ---- PAY FOR API ON BEHALF — one toggle, one toast, no checkbox list ----
    // The old "armed?" dropdown plus a per-model pay-list implied the operator
    // had to re-select, below, a model already chosen above. Gone. Models are
    // picked in the fields above; this single switch answers the only remaining
    // question — may a fallback SPEND. When it does, the ask-first card still
    // appears with the price, so "on" is not "spend silently".
    {
        const ph = document.createElement("div");
        ph.className = "pref-head";
        ph.innerText = "Fallback";
        wrap.appendChild(ph);

        const row = document.createElement("div");
        row.className = "orch-pay-row";
        const lab = document.createElement("span");
        lab.className = "orch-pay-label";
        lab.innerText = "Pay for API on behalf";
        const tgl = document.createElement("label");
        tgl.className = "sec-toggle";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        // PER SESSION, not global. Default from whether THIS conversation already
        // allows paying (its escalateTo has entries), never from the global
        // switch — reading g.enabled made the toggle show another session's state.
        cb.checked = !!(active.escalateTo && active.escalateTo.length);
        const sl = document.createElement("span");
        sl.className = "sec-slider";
        tgl.appendChild(cb); tgl.appendChild(sl);
        row.appendChild(lab); row.appendChild(tgl);
        wrap.appendChild(row);

        const toast = document.createElement("div");
        toast.className = "orch-toast";
        toast.innerText = "When the model you picked cannot answer — it will not load, " +
            "the machine is full, an endpoint dies mid-turn — the turn re-runs on a " +
            "model you assigned above. With this off, the failure is reported and " +
            "nothing is paid for. With it on, a paid fallback still asks you first, " +
            "every time, with the reason and the price on the card, and every one is " +
            "named on the reply and in Spend.\n\n" +
            "Saving assignments here is also what tells the app which reachable " +
            "model to hand work to — the handoff tools and the reasoner. It does " +
            "not change what a new conversation starts on: that is this machine " +
            "unless you pick otherwise in the model picker.";
        wrap.appendChild(toast);

        // remember for the save path
        wrap._payFor = cb;
    }

    const ok = await modal({ title: "Model Orchestration", node: wrap, size: "wide",
                             confirmLabel: "Save", cancelLabel: "Cancel" });
    if (!ok) return;   // Cancel discards BOTH halves — the task map and the toggle
    const payOn = !!(wrap._payFor && wrap._payFor.checked);
    // the assignment map commits on Save
    const map = readTaskMap();
    const rr = await window.lcl.setSessionTaskModels(active.id, map || {}).catch(() => null);
    if (rr && rr.ok) active.taskModels = rr.taskModels;

    // THE FALLBACK ALLOWLIST IS DERIVED, not re-selected — the models assigned
    // above are what a fallback may pay for. But only PAID endpoints count: a
    // free local node (remote:true, localNode:true) has an endpointId too, and
    // arming it as "paid" would let a free-only plan trip the paid-fallback
    // machinery. Build the paid-endpoint set from the model list and filter.
    const paidEps = new Set(((models && models.models) || [])
        .filter(m => m.remote && !m.localNode)   // API + rented GPU, never a node
        .map(m => m.endpointId));
    const payIds = payOn
        ? Object.values(map || {})
            .filter(v => v && v.model && v.endpointId && paidEps.has(v.endpointId))
            .map(v => v.model)
        : [];   // toggle off → this conversation pays for nothing
    // Arm the app-wide mechanism only when turning payment ON — each session
    // still gates on its own escalateTo, so this never makes another session pay;
    // turning it OFF just clears THIS session, it does not disable others.
    if (payOn) await window.lcl.setEscalation(true).catch(() => null);
    const r = await window.lcl.setSessionEscalation(active.id, [...new Set(payIds)]).catch(() => null);
    if (r && r.ok) active.escalateTo = r.escalateTo;

    // ---- AND THE APP-WIDE ROLES, WHICH THIS PANEL IS THE PLACE FOR ----
    //
    // The roles (driver / reasoner) are what escalation, ask_cloud_model and
    // the reasoner handoff resolve against — NOT what a new conversation
    // drives, which is the local engine unless the operator picks otherwise.
    // Linking an endpoint used to set them as a side effect, which is how a
    // paid model became every conversation's silent default; that was removed,
    // and with nothing left to set them the handoff tools went dead. An
    // ASSIGNMENT here is the explicit act that belongs to them.
    {
        const assigned = Object.entries(map || {})
            .filter(([, v]) => v && v.model && v.endpointId);
        const pick = (cap) => {
            const hit = assigned.find(([k]) => k === cap);
            return hit ? hit[1] : null;
        };
        const reasoner = pick("reasoning");
        const driver = reasoner || (assigned.length ? assigned[0][1] : null);
        if (driver) {
            await window.lcl.selectCloudModel({
                endpointId: driver.endpointId, model: driver.model, role: "driver"
            }).catch(() => null);
        }
        if (reasoner) {
            await window.lcl.selectCloudModel({
                endpointId: reasoner.endpointId, model: reasoner.model, role: "reasoner"
            }).catch(() => null);
        }
    }
}

// =============================================================
// BOOT
// =============================================================
(async () => {
    try { appInfo = (await window.lcl.appInfo()) || appInfo; } catch { /* defaults */ }

    // the operator's chosen tone, resolved once, before anything paints a
    // conversational string
    await refreshAppLines();

    try {
        const m = await window.lcl.renderMode();
        if (m) {
            motion.software = !!m.software;
            motion.battery = !!m.battery;
            motion.pref = m.motionPref || "auto";
            introMuted = m.introSound === false;
            applyMotion();
        }
    } catch { /* keep full motion */ }

    window.lcl.onWindowState(() => {});

    // the app built a node's door by itself — say so once, because the user
    // asked for this to happen without them and should still know it did
    if (window.lcl.onNodeDoorReady) {
        window.lcl.onNodeDoorReady(({ name, host }) => {
            // never render a bare field: an older sender passed only `host`
            // and the notice read "undefined is now reachable from any network"
            const who = name || host || "That machine";
            addNotice(`${who} is now reachable from any network, including ` +
                "ones where a VPN blocks the direct path. Nothing to turn on, " +
                "and nothing to do when that happens.");
            pollNodeBars();
        });
    }

    pollResources();
    setInterval(pollResources, 5000);
    // node gauges on their own, slower clock: each tick is an SSH round trip
    // to another machine, not a local API call
    pollNodeBars();
    setInterval(pollNodeBars, 8000);

    // the knowledge badge: shipped sources not yet on this machine, known at
    // boot without opening anything — the count is ~64 stats, not the inventory
    kbBadgeFromBoot();

    // A SPEND WINDOW ROLLS OVER ON A CLOCK, not on a user action. Left idle
    // across a five-hour boundary, the plan ring and GO strip kept showing the
    // previous window's spend and percentage until something else repainted.
    // A minute is plenty, and it is cheap: refreshPlanRing hides itself when no
    // windowed plan applies, and the GO strip only re-renders while its panel
    // is actually open.
    setInterval(() => {
        try { refreshPlanRing(); } catch { /* a readout never breaks the tick */ }
        try {
            if (CTX_SCRIM && !CTX_SCRIM.classList.contains("hidden")) renderGoStrip();
        } catch { /* panel not open, or not built yet */ }
    }, 60_000);

    // Engine lifecycle → UI, including every failure path. The freeze taught
    // the rule: there is no engine state the UI is allowed to not represent.
    window.lcl.onEngineState((s) => {
    // the load readout is driven by the engine's own phase events, so it moves
    // while a load is happening rather than only when something polls
    try { paintLoad(s && s.load); } catch { /* markup not up yet */ }
        // WHILE A REMOTE MODEL DRIVES, THE LOCAL ENGINE'S TROUBLES ARE NOISE.
        // The reported chain: chatting happily on an API, then two memory
        // errors and a locked composer — a guard stop and a failed local
        // reload that had NOTHING to answer, flipping ready=false on a session
        // the cloud was serving fine. Local engine events still repaint the
        // picker; they no longer touch readiness, status or the transcript.
        if (remoteActive()) {
            refreshModelPick();
            if (machineOpen()) refreshMachine();
            return;
        }
        if (s.reason === "idle-unload" || s.reason === "manual-unload") {
            setStatus("ok", "model unloaded");
        } else if (s.reason === "loading") {
            setStatus("busy", "loading model…");
        } else if (s.reason === "loading-progress") {
            // real load milestones from the engine's own log, not a spinner
            if (s.line) setStatus("busy", s.line.length > 46 ? s.line.slice(0, 46) + "…" : s.line);
            if (liveBubble) pushActivity(liveBubble, "note", `· ${s.line}`, true);
        } else if (s.reason === "ready") {
            // THE RECOVERY THE STALL NEEDED. If the renderer bailed early on a
            // slow load (or any earlier state said 'not loaded'), this event is
            // the engine saying it IS up — and it used to repaint the label
            // without restoring readiness, so the composer stayed dead while
            // Machine showed the model running. The engine's word is final.
            ready = true;
            setControls();
            composer.placeholder = "Message .lcl…   (Ctrl+Enter to send)";
            setModelStatus();
            refreshModelPick();
        } else if (s.reason === "fallback-load") {
            // the preferred model did not fit; a smaller one is loading — said
            // ONCE per run per substitution, with a button that tries the
            // preferred model rather than instructions to go do it by hand
            const wanted = s.wantedId || "your preferred model";
            const using = s.usingId || "a smaller model";
            const key = wanted + "→" + using;
            if (!fallbackNoticed.has(key)) {
                fallbackNoticed.add(key);
                addNotice(`${wanted} needs more free memory right now — running ` +
                    `${using} instead. Your preference is unchanged.`,
                    s.wantedId ? {
                        label: `Try ${wanted} now`,
                        onClick: () => switchModel(s.wantedId)
                    } : null);
            }
            refreshModelPick();
        } else if (s.reason === "guard-recovered") {
            // The guard killed the model to save the machine and then loaded one
            // that fits. Without this branch the UI stayed on "model not loaded"
            // forever while a model was in fact running — the state that made the
            // whole app unusable until it was restarted.
            ready = true;
            setControls();
            setModelStatus();
            composer.placeholder = "Message .lcl…   (Ctrl+Enter to send)";
            addNotice("Memory came back — a model that fits is loaded and you can " +
                      "carry on. Switch back from the model button when you have room.");
            refreshModelPick();
        } else if (s.reason === "load-refused" || s.reason === "load-failed"
                || s.reason === "guard-stop") {
            ready = false;
            setControls();
            setStatus("down", s.reason === "guard-stop"
                ? "stopped to protect memory — trying a smaller model"
                : "model not loaded");
            // ...but only tell them to pick a model if the session they are
            // looking at actually needs one. On an API session this sentence
            // is both wrong and alarming.
            if (!remoteActive()) {
                composer.placeholder = "Click the model button to pick one";
            }
            // switchModel (its modal) and sendMessage (the chat error) surface
            // their own failures; this covers deaths with no request in flight
            if (!pending && !switching && s.lastError) addError(s.lastError);
            refreshModelPick();
        }
        if (machineOpen()) refreshMachine();
    });

    // SESSIONS FIRST. THE MODEL IS NOT THE APP.
    //
    // This used to be `await waitForBackend()` before anything else, which
    // held the ENTIRE interface hostage to a model loading: on a machine where
    // the local model could not come up and nothing remote was linked, no
    // sessions appeared, nothing was clickable — "literally nothing works.
    // after install, no sessions or anything loads." Reading old conversations,
    // linking a folder, connecting an endpoint, opening panels: none of that
    // needs a model. The transcript list loads NOW; the backend wait happens
    // after, without blocking, and only gates the composer.
    await refreshModelPick();
    await refreshSessions();
    await loadSessionStatuses();
    renderSessionList();
    refreshNetPill();

    // Open the most recent conversation with NO intro. The intro is the new
    // session page: it belongs to "New session", or to a first run with nothing
    // saved — never to a launch that restores existing work.
    //
    // Suppressing it explicitly matters because the most recent session can
    // itself be empty (an unused "New session" from last time), which would
    // otherwise qualify for the landing and animate on every launch.
    if (sessions.length) {
        landingDismissed.add(sessions[0].id);
        await switchSession(sessions[0].id, { markRead: false });
    } else {
        // genuinely nothing saved — this is the one launch that does animate
        await createSession();
    }
    // bring back long-running work AFTER the active session exists, so the
    // per-session filter inside restoreTasks has a session to filter FOR —
    // hydrating before it meant `active` was null and the whole ledger painted
    // into whatever opened next
    await restoreTasks();

    // The backend wait runs AFTER the interface is alive, and does not block
    // it. Everything below is commentary on the outcome, delivered whenever it
    // arrives; the sessions and panels above are already usable.
    waitForBackend().then(async (backendUp) => {
        await refreshModelPick();

        // A boot-time load failure was explained by waitForBackend — but
        // opening the session re-rendered the transcript and wiped that
        // explanation. Restate it AFTER the render so the reason survives.
        if (backendUp === false) {
            try {
                const st = await window.lcl.engineStatus();
                if (st && !st.running && st.lastError) addError(st.lastError);
            } catch { /* status text already says the engine is down */ }
        }

        // A boot-time FALLBACK happened before this listener existed — the
        // event is gone, but the state is queryable. Say it plainly.
        //
        // NOT WHEN A REMOTE MODEL IS DRIVING. The live handler already bails
        // on remote, but this reconstruction did not — and waitForBackend()
        // returns early for remote, so it reached here on EVERY launch. That
        // is why the same warning about a local model came back each time
        // while the conversation was running on GLM-5.2 and did not care.
        try {
            if (remoteActive()) return;
            const st = await window.lcl.engineStatus();
            if (st && st.fallbackActive && st.modelInfo) {
                const wanted = (st.preferredInfo && st.preferredInfo.id) || "your preferred model";
                const key = wanted + "→" + st.modelInfo.id;
                if (!fallbackNoticed.has(key)) {
                    fallbackNoticed.add(key);
                    addNotice(`${wanted} needs more free memory right now — running ` +
                        `${st.modelInfo.id} instead. Your preference is unchanged.`,
                        st.preferredInfo && st.preferredInfo.id ? {
                            label: `Try ${wanted} now`,
                            onClick: () => switchModel(st.preferredInfo.id)
                        } : null);
                }
            }
        } catch { /* the engine label still shows what is running */ }
    }).catch(() => { /* waitForBackend reports its own failures */ });
})();


/*
 * APIs and rented GPU — cards, the always-visible add box, per-provider rate
 * popups. Lives on API's & Connections. History: see the design notes.
 */
async function renderApiSection(container, rerender) {
    let st = null;
    try { st = await window.lcl.cloudState(); }
    catch (e) { await dialogFailed("API's & Connections", e); return; }
    if (!st) return;
    let intel = null;
    try { intel = await window.lcl.modelIntel(); } catch { intel = null; }

    const again = async () => { closeModal(true); rerender(); await refreshModelPick(); };

    const rentedControls = () => {
        const wrap = document.createElement("label");
        wrap.className = "cloud-rented";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.className = "cloud-rented-box";
        const txt = document.createElement("span");
        txt.className = "cloud-rented-text";
        txt.innerText = "I am renting this by the hour";
        const prov = document.createElement("input");
        prov.className = "cloud-provider";
        prov.spellcheck = false;
        prov.autocomplete = "off";
        prov.placeholder = "who you rent it from";
        prov.disabled = true;
        prov.title = "Names the GPU group in the model picker";
        box.addEventListener("change", () => {
            prov.disabled = !box.checked;
            if (box.checked) prov.focus(); else prov.value = "";
        });
        wrap.appendChild(box);
        wrap.appendChild(txt);
        wrap.appendChild(prov);
        return { wrap, opts: () => ({ rented: !!box.checked, provider: prov.value.trim() }) };
    };

    // the add box renders in EVERY state — a mainstay, never behind a click
    const connectBox = () => {
        const wrap = document.createElement("div");
        wrap.className = "cloud-add";

        const title = document.createElement("div");
        title.className = "cloud-add-head";
        title.innerText = st.endpoints.length ? "Add another" : "Add an endpoint";
        wrap.appendChild(title);

        const presetRow = document.createElement("div");
        presetRow.className = "cloud-presets";
        let presetPlan = null;
        let presetFill = null;

        const input = document.createElement("input");
        input.className = "cloud-paste";
        input.spellcheck = false;
        input.autocomplete = "off";
        input.placeholder = "api.deepinfra.com sk-yourkey     or     192.168.1.20:11434";

        const epStatus = document.createElement("div");
        epStatus.className = "cloud-ep-status";
        // network turns on automatically when you connect — no toggle to
        // send the operator hunting for
        epStatus.innerText = st.networkEnabled
            ? "pick a provider, or paste any OpenAI-compatible address"
            : "pick a provider, or paste any address — the network turns on when you connect";

        const mkPreset = (label, fill, hint, plan) => {
            const b = document.createElement("button");
            b.className = "ghost small cloud-chip";
            b.innerText = label;
            b.addEventListener("click", (e) => {
                e.stopPropagation();
                presetPlan = plan || null;
                presetFill = fill;
                input.value = fill + " ";
                input.focus();
                epStatus.innerText = hint;
            });
            presetRow.appendChild(b);
            return b;
        };
        // a stale chip plan must not ride along once the address is edited away
        input.addEventListener("input", () => {
            if (presetPlan && !(presetFill && input.value.startsWith(presetFill))) {
                presetPlan = null;
                presetFill = null;
            }
        });

        // ZEN AND GO ARE TWO PROVIDERS, per the published docs (the operator's
        // own read, confirmed at opencode.ai/docs/go): GO has its OWN base URL
        // — opencode.ai/zen/go/v1 — and its own model catalog; Zen is the
        // pay-per-token gateway at opencode.ai/zen/v1. One console, one
        // account, two endpoints — so two chips that link two records, and
        // both can be linked at once.
        mkPreset("OpenCode GO", "https://opencode.ai/zen/go/v1",
            "the $10/mo GO subscription — its own endpoint and catalog. " +
            "Paste your key from the Zen console (opencode.ai/auth). " +
            "Metered in dollar windows: $12/5h · $30/wk · $60/mo.",
            "go-window");
        // plan "none" = the explicit CLEAR sentinel — re-linking with this chip
        // heals an old-style record that carried a GO plan on the Zen URL
        mkPreset("OpenCode Zen", "https://opencode.ai/zen/v1",
            "the pay-per-token gateway — ~60 curated models, billed from your " +
            "Zen credits like any other provider. No subscription, no window " +
            "meter.", "none");
        // the rest of the provider row comes from the shipped catalog — the
        // whole 2026 field, not two names somebody hardcoded
        const already = new Set(["zen"]);
        const catProviders = ((intel && intel.providers) || [])
            .filter(p => p.kind === "api" && !already.has(p.id));
        const lead = catProviders.slice(0, 3);
        const rest = catProviders.slice(3);
        // connectUrl is the OpenAI-compatible base the probe can actually list
        // — several hosts (Google, Groq, Fireworks) do not speak it at their
        // bare root, so filling p.baseUrl there would connect to a dead path
        for (const p of lead) {
            mkPreset(p.label, p.connectUrl || p.baseUrl,
                p.keyNeeded ? `paste your ${p.label} key after the address`
                            : "no key needed", null);
        }
        if (!catProviders.length) {
            mkPreset("DeepInfra", "api.deepinfra.com",
                "paste your DeepInfra key after the address", null);
        }
        if (rest.length) {
            const more = document.createElement("button");
            more.className = "ghost small cloud-chip";
            more.innerText = `More providers (${rest.length})…`;
            more.addEventListener("click", (e) => {
                e.stopPropagation();
                more.remove();
                for (const p of rest) {
                    // connectUrl here too — the expander filled the bare host,
                    // so Google/Groq/Fireworks chips pointed at paths the
                    // OpenAI probe cannot list
                    mkPreset(p.label, p.connectUrl || p.baseUrl,
                        p.keyNeeded ? `paste your ${p.label} key after the address`
                                    : "no key needed", null);
                }
            });
            presetRow.appendChild(more);
        }
        mkPreset("Your own server", "192.168.",
            "finish the address — an OpenAI-compatible server on your network " +
            "needs no key", null);

        const btn = document.createElement("button");
        btn.className = "primary small";
        btn.innerText = "Connect";

        const rented = rentedControls();

        const go = async () => {
            if (!input.value.trim()) return;
            btn.disabled = true;
            epStatus.classList.add("loading-note");
            epStatus.innerHTML = "";
            epStatus.appendChild(spinnerEl());
            epStatus.appendChild(document.createTextNode("connecting…"));
            // NETWORK IS AUTOMATIC — linking an endpoint inherently needs it, so
            // turn it on rather than making the operator find a separate switch
            if (!st.networkEnabled) {
                try { await window.lcl.setNetworkEnabled(true); paintNetPill(true);
                      const box = $("net-toggle"); if (box) box.checked = true; } catch { }
            }
            const r = await window.lcl.connectCloud(input.value,
                    { ...rented.opts(), plan: presetPlan })
                .catch(e => ({ error: String((e && e.message) || e) }));
            btn.disabled = false;
            presetPlan = null;
            presetFill = null;
            input.value = "";        // may contain a key — never leave it in the DOM
            epStatus.classList.remove("loading-note");
            // late completion after the operator closed this sheet: touch nothing
            if (!wrap.isConnected) return;
            if (r && r.ok) { await again(); return; }
            epStatus.innerText = (r && (r.error || r.detail)) || "could not connect";
            flash(input, false);
        };
        btn.addEventListener("click", go);
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });

        const box = document.createElement("div");
        box.className = "cloud-connect";
        box.appendChild(input);
        box.appendChild(btn);

        wrap.appendChild(presetRow);
        wrap.appendChild(box);
        wrap.appendChild(rented.wrap);
        wrap.appendChild(epStatus);
        return wrap;
    };

    const epCard = (ep) => {
        const card = document.createElement("div");
        card.className = "cloud-card";

        const head = document.createElement("div");
        head.className = "cloud-card-head";
        const name = document.createElement("span");
        name.className = "cloud-card-name";
        name.innerText = ep.label || ep.baseUrl;
        head.appendChild(name);
        const badge = (txt, cls) => {
            const b = document.createElement("span");
            b.className = "cloud-badge" + (cls ? " " + cls : "");
            b.innerText = txt;
            head.appendChild(b);
        };
        /* WHICH PRODUCT THIS ENDPOINT IS PART OF.
         *
         * Zen and GO are two endpoints of one account, and the picker nests
         * them under it. That nesting is driven by exactly this field, so
         * showing it here means "why are they not grouped" is answerable by
         * looking rather than by me guessing from a description.
         */
        if (ep.providerFamilyLabel) badge(ep.providerFamilyLabel, "cloud-badge-fam");
        if (ep.plan === "go-window") badge("GO · metered", "cloud-badge-go");
        if (ep.rented) badge("rented");
        if (ep.localNode) badge("your machine");
        if (st.config && st.config.enabled && st.config.endpointId === ep.id
            && st.config.model) badge("in use", "cloud-badge-live");
        card.appendChild(head);

        const url = document.createElement("div");
        url.className = "cloud-card-url";
        url.innerText = ep.baseUrl || "";
        card.appendChild(url);

        const key = document.createElement("div");
        key.className = "cloud-card-key";
        // hasKey is possession, not need — need is the host's call
        key.innerText = ep.hasKey
            ? (ep.keyEncrypted ? "key stored, encrypted" : "key held for this session")
            : "no key stored";
        card.appendChild(key);

        const status = document.createElement("div");
        status.className = "cloud-ep-status";

        const acts = document.createElement("div");
        acts.className = "cloud-card-acts";

        // View Rates is the PRIMARY action of a card — a different style from
        // the icon controls beside it
        const rates = document.createElement("button");
        rates.className = "primary small";
        rates.innerText = "View Rates";
        rates.addEventListener("click", () => openProviderRates(ep));
        acts.appendChild(rates);

        // Test RESOLVES VISIBLY — resting state shows a check glyph + "Test";
        // a click goes to "testing…", then green OK / red failed with the detail
        const test = document.createElement("button");
        test.className = "ghost small icon-act cloud-test";
        test.title = "Test the connection";
        test.appendChild(ICONS.test());
        const testLbl = document.createElement("span");
        testLbl.className = "cloud-test-label";
        testLbl.innerText = "Test";
        test.appendChild(testLbl);
        test.addEventListener("click", async () => {
            test.classList.remove("ok", "bad");
            testLbl.innerText = "testing…";
            const r = await window.lcl.testCloudEndpoint(ep.id).catch(() => null);
            const ok = !!(r && r.ok);
            test.classList.add(ok ? "ok" : "bad");
            testLbl.innerText = ok ? "OK" : "failed";
            if (r && r.detail) status.innerText = (ok ? "OK — " : "failed — ") + r.detail;
            setTimeout(() => { test.classList.remove("ok", "bad"); testLbl.innerText = "Test"; }, 3000);
        });
        acts.appendChild(test);

        // Refresh — the circular-arrow icon everyone reads as "reload"
        const refresh = document.createElement("button");
        refresh.className = "ghost small icon-act icon-only";
        refresh.title = "Refresh this endpoint's model list";
        refresh.appendChild(ICONS.refresh());
        refresh.addEventListener("click", async () => {
            status.innerText = "asking what it serves…";
            const r = await window.lcl.discoverCloudModels(ep.id)
                .catch(e => ({ ok: false, error: String((e && e.message) || e) }));
            if (!card.isConnected) return;
            if (r && r.ok) {
                // IT SAYS WHAT IT FOUND, AND THE PANEL STAYS PUT.
                //
                // This called again(), which closes the whole sheet and
                // re-opens it. Reading the provider's catalogue takes a few
                // seconds, so the card sat silent and then the panel blinked
                // away and came back with nothing said — indistinguishable
                // from a failure, and reported as one: "tried to refresh deep
                // infra in apis and connections, and it failed". The count is
                // stated here instead, in place.
                const n = (r.models || []).length;
                status.innerText = r.keyRejected
                    ? ep.label + " refused the stored key — its model list is public " +
                      "so the " + n + " models below are current, but nothing can be " +
                      "SENT until you paste a working key."
                    : n + " model" + (n === 1 ? "" : "s") + " — list is current.";
                // the picker reads the same records, so it must not lag behind
                await refreshModelPick().catch(() => {});
            } else {
                status.innerText = "failed — " + ((r && r.error) || "could not list models");
            }
        });
        acts.appendChild(refresh);

        // Disconnect — the trash-can icon
        const del = document.createElement("button");
        del.className = "ghost small icon-act icon-only danger-text";
        del.title = "Disconnect this endpoint";
        del.appendChild(ICONS.trash());
        del.addEventListener("click", async () => {
            await window.lcl.unlinkCloudEndpoint(ep.id).catch(() => null);
            if (!card.isConnected) { await refreshModelPick(); return; }
            await again();
        });
        acts.appendChild(del);

        card.appendChild(acts);
        card.appendChild(status);
        return card;
    };

    const apis = st.endpoints.filter(e => !e.localNode && !e.rented);
    const gpus = st.endpoints.filter(e => e.rented);

    if (apis.length) {
        const cards = document.createElement("div");
        cards.className = "cloud-cards";
        for (const ep of apis) cards.appendChild(epCard(ep));
        container.appendChild(cards);
    }
    container.appendChild(connectBox());

    if (gpus.length) {
        const gh = document.createElement("div");
        gh.className = "cloud-add-head";
        gh.innerText = "Rented GPU";
        gh.style.marginTop = "var(--sp-3)";
        container.appendChild(gh);
        const gcards = document.createElement("div");
        gcards.className = "cloud-cards";
        for (const ep of gpus) gcards.appendChild(epCard(ep));
        container.appendChild(gcards);
    }

    // THE SPEND GATE IS NOT A GLOBAL ANY MORE, so it is not on this page.
    // It was a dropdown here writing cloudAutoApprove for the whole machine,
    // which is precisely what the operator has ruled out: a permission belongs
    // to the conversation that granted it. "Ask before this conversation sends
    // anything out" lives in Session › Permissions with every other switch.
}

/*
 * One provider's rate table, as its own popup over whatever page is open —
 * rate tables are provider-specific, and inlining every one of them on one
 * page was the clusterfucked-UI complaint. Cost-healing logic is untouched:
 * this reads modelRates and writes setModelRate, same as the old table.
 */
async function openProviderRates(ep) {
    document.querySelectorAll(".rate-pop").forEach(el => el.remove());

    const [rates, st] = await Promise.all([
        window.lcl.modelRates().catch(() => null),
        window.lcl.cloudState().catch(() => null)
    ]);
    const rec = st && st.endpoints.find(e => e.id === ep.id);
    const models = (rec && (rec.models && rec.models.length ? rec.models
        : (rec.allModels || []).map(id => typeof id === "string" ? { id } : id))) || [];

    const pop = document.createElement("div");
    pop.className = "rate-pop";
    const sheet = document.createElement("div");
    sheet.className = "rate-pop-sheet";
    pop.appendChild(sheet);

    const head = document.createElement("div");
    head.className = "rate-pop-head";
    const ttl = document.createElement("span");
    ttl.innerText = (ep.label || ep.baseUrl) + " — rates";
    const x = document.createElement("button");
    x.className = "ghost small";
    x.innerText = "✕";
    x.setAttribute("aria-label", "Close rates");
    const closePop = () => { pop.remove(); document.removeEventListener("keydown", onKey); };
    x.addEventListener("click", closePop);
    head.appendChild(ttl);
    head.appendChild(x);
    sheet.appendChild(head);
    pop.addEventListener("click", (e) => { if (e.target === pop) closePop(); });
    // Escape closes THIS layer (the top one), not the modal behind it —
    // captured so it beats the global modal Escape handler
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); closePop(); } };
    document.addEventListener("keydown", onKey, true);

    const rnote = document.createElement("div");
    rnote.className = "pref-note";
    rnote.innerText = "Shipped rates were recorded on " +
        ((rates && rates.asOf) || "release") + " and providers change them. " +
        "Anything you type here wins, and the cost meter says which it used.";
    sheet.appendChild(rnote);

    const rateLock = document.createElement("button");
    rateLock.className = "ghost pref-rate-edit";
    rateLock.innerText = "Edit rates";
    let rateEditing = false;
    sheet.appendChild(rateLock);

    const table = document.createElement("div");
    table.className = "pref-rates";
    {
        const hd = document.createElement("div");
        hd.className = "pref-rate-row pref-rate-head";
        for (const [cls, txt] of [["pref-rate-name", "model"],
                                  ["pref-rate-col", "$ in / M"],
                                  ["pref-rate-col", "$ out / M"],
                                  ["pref-rate-col", "source"]]) {
            const c = document.createElement("div");
            c.className = cls;
            c.innerText = txt;
            hd.appendChild(c);
        }
        table.appendChild(hd);
    }
    const seen = new Set();
    for (const m of models) {
        const mid = m.id || m;
        if (!mid || seen.has(mid)) continue;
        seen.add(mid);
        const r = (rates && rates.rates && rates.rates[mid]) || m.rate || null;

        const row = document.createElement("div");
        row.className = "pref-rate-row";
        const label = document.createElement("div");
        label.className = "pref-rate-name";
        label.innerText = mid;
        row.appendChild(label);

        const mk = (which, val) => {
            const i = document.createElement("input");
            i.className = "pref-rate-in";
            i.type = "text";
            i.inputMode = "decimal";
            i.spellcheck = false;
            // AN EMPTY BOX WITH NO REASON IS THE COMPLAINT. "IF THERE IS NO
            // COST THEN HOW THE HELL AM I SUPPOSED TO KNOW" — so the box itself
            // says why it is empty, not just the column beside it.
            const known = !(val === undefined || val === null);
            // A RIGHT-ALIGNED 92px BOX CANNOT HOLD "not published". The marker
            // goes in the box, the words go in the source column beside it,
            // which wraps.
            i.placeholder = known ? which : "\u2014";
            i.value = known ? String(val) : "";
            i.title = known
                ? `USD per million ${which} tokens`
                : "This provider does not publish a price for this model. " +
                  "Unknown, not zero — nothing is counted against it. Type one " +
                  "here if you know it, or leave it: the first turn that " +
                  "reports what it charged will learn the rate by itself.";
            if (!known) i.classList.add("pref-rate-none");
            i.readOnly = true;
            return i;
        };
        const inIn = mk("in", r && r.in);
        const outIn = mk("out", r && r.out);
        row.appendChild(inIn);
        row.appendChild(outIn);

        const src = document.createElement("div");
        src.className = "pref-rate-src";
        /* "unset" WAS TRUE AND USELESS.
         *
         * Empty rates are unacceptable: if there is no cost shown, there is no
         * way to know why.
         *
         * A blank pair of boxes labelled "unset" says nothing about WHY. There
         * are two entirely different reasons and the operator can act on both:
         * either the provider publishes no price for this model — in which case
         * the honest move is to say so, and the first turn that reports a cost
         * will learn it — or nobody has entered one and they can.
         */
        src.innerText = r ? (r.source === "user" ? "yours"
                          : r.source === "endpoint" ? "from endpoint" : "shipped")
                          : "not published";
        if (!r) {
            src.classList.add("pref-rate-unpublished");
            src.title = "This provider does not publish a price for this model. " +
                "It is not free and it is not zero — it is unknown, so nothing " +
                "is counted against it. Type a rate here if you know it, or " +
                "leave it: the first turn that reports what it charged will " +
                "learn the rate by itself.";
        }
        row.appendChild(src);

        const save = async () => {
            const a = parseFloat(inIn.value), b = parseFloat(outIn.value);
            const clear = !inIn.value.trim() && !outIn.value.trim();
            const rr = await window.lcl.setModelRate(mid,
                clear ? null : { in: isFinite(a) ? a : 0, out: isFinite(b) ? b : 0 })
                .catch(() => null);
            src.innerText = clear ? "shipped" : "yours";
            for (const el of [inIn, outIn]) {
                el.classList.add(rr && rr.ok ? "saved" : "save-failed");
                setTimeout(() => el.classList.remove("saved", "save-failed"), 900);
            }
            refreshCostMeter();
        };
        inIn.addEventListener("change", save);
        outIn.addEventListener("change", save);
        table.appendChild(row);
    }
    if (seen.size === 0) {
        const empty = document.createElement("div");
        empty.className = "pref-note";
        empty.innerText = "No models listed yet — Refresh models on the card first.";
        sheet.appendChild(empty);
    }
    sheet.appendChild(table);

    rateLock.addEventListener("click", () => {
        rateEditing = !rateEditing;
        rateLock.innerText = rateEditing ? "Done" : "Edit rates";
        rateLock.classList.toggle("primary", rateEditing);
        rateLock.classList.toggle("ghost", !rateEditing);
        for (const inp of table.querySelectorAll(".pref-rate-in")) {
            inp.readOnly = !rateEditing;
        }
    });

    document.body.appendChild(pop);
}

// panel-level save flash, shared by the connection pages
function flash(el, ok) {
    el.classList.add(ok ? "saved" : "save-failed");
    setTimeout(() => el.classList.remove("saved", "save-failed"), 900);
}


async function openPreferredModel() {
    // ONE JOB: which model a new session starts on. The role assignments and
    // the rate table moved to Models & API, where the endpoints they describe
    // actually live.
    const models = await window.lcl.listModels().catch(() => null);
    const list = (models && models.models) || [];

    const wrap = document.createElement("div");
    wrap.className = "pref-wrap";

    // ---- which model a new session starts on
    const h1 = document.createElement("div");
    h1.className = "pref-head";
    h1.innerText = "New sessions start on";
    wrap.appendChild(h1);

    const sel = document.createElement("select");
    sel.className = "cap-level auto pref-select";
    const auto = document.createElement("option");
    auto.value = "";
    auto.innerText = "the best local model that fits (default)";
    sel.appendChild(auto);

    // GROUPED, AND THE ABSENT ONES CANNOT BE CHOSEN.
    //
    // The preferred-model page listed models that are not actually available
    //  because they are not installed.
    //
    // They were in one flat list with "(not installed)" tacked onto the label,
    // which is a footnote on a control that otherwise behaves as if every entry
    // is a working choice — pick one and the next session starts by failing to
    // load it. They stay listed, because knowing the ladder exists is useful,
    // but under their own heading and disabled, so the list cannot lie about
    // what is ready to run.
    const localReady = list.filter(m => !m.remote && m.present);
    const localAbsent = list.filter(m => !m.remote && !m.present);
    const remote = list.filter(m => m.remote);

    const addGroup = (label, items, render, disabled) => {
        if (!items.length) return;
        const g = document.createElement("optgroup");
        g.label = label;
        for (const m of items) {
            const o = document.createElement("option");
            o.value = m.id;
            o.innerText = render(m);
            o.disabled = !!disabled;
            if (m.preferred) o.selected = true;
            g.appendChild(o);
        }
        sel.appendChild(g);
    };

    addGroup(`Installed  (${localReady.length})`, localReady,
        m => `${m.family} ${m.params} ${m.quant || ""}`.trim());
    // A PAID MODEL IS NEVER A CONVERSATION'S SILENT DEFAULT, so it cannot be
    // offered here as one. A session with no choice of its own runs on THIS
    // machine — that is the routing rule, and a dropdown promising otherwise
    // was a control that could not do what it said.
    addGroup("Linked endpoints — pick these per conversation, not as a default",
        remote,
        m => `${m.modelId} on ${m.endpointLabel}`, true);
    addGroup(`Not installed  (${localAbsent.length}) — download these first`, localAbsent,
        m => `${m.family} ${m.params} ${m.quant || ""}`.trim(), true);
    sel.addEventListener("change", async () => {
        const r = await window.lcl.setPreferredModel(sel.value || null).catch(() => null);
        sel.classList.add(r && r.ok ? "saved" : "save-failed");
        setTimeout(() => sel.classList.remove("saved", "save-failed"), 900);
    });
    wrap.appendChild(sel);

    const note = document.createElement("div");
    note.className = "pref-note";
    note.innerText = "This is the local model a new conversation starts on. " +
        "A linked endpoint is chosen per conversation with the model button — " +
        "nothing paid is ever the silent default.";
    wrap.appendChild(note);


    await modal({
        title: "Preferred model",
        node: wrap,
        confirmLabel: "Done",
        confirmOnly: true, size: "wide"
    });
    await refreshModelPick();
    refreshCostMeter();
}

/**
 * The status line must name what is ACTUALLY answering. Four places set it, and
 * all four hardcoded "local · offline" — which would have gone on claiming the
 * app was offline while every token came from api.deepseek.com. That is the kind
 * of quiet lie that makes a security indicator worthless.
 */
/**
 * THE STATUS ROW IS ABOUT THE ENGINE ON THIS MACHINE. NOTHING ELSE.
 *
 * It sits directly above the memory bar because those two are one story: the
 * reason the model stopped is almost always the number underneath it. Then this
 * function started writing WHICH MODEL ANSWERS THIS CONVERSATION into the same
 * row, on every session paint — so it permanently read "node · spark", the
 * engine state it was placed there for was never visible, and the row became a
 * second copy of something the session already shows.
 *
 *     "the spark white dot is there, meaningless. what is the purpose, it looks
 *      like a session there. if it the model responding at the moment, why. we
 *      have it in each session already. that is redundant, or in the wrong
 *      location"
 *
 * All three true. Routing belongs to the conversation and stays there. This row
 * reports the local engine — including, and especially, when a model on the
 * network is answering: that is exactly when "no model loaded, memory free" is
 * worth knowing and nothing else on screen says it.
 */
async function paintEngineStatus() {
    let st = null;
    try { st = await window.lcl.engineStatus(); } catch { return; }
    if (!st) return;

    if (st.load && st.load.phase && st.load.phase !== "ready") {
        setStatus("busy", st.load.label);            // mid-load: say which step
        return;
    }
    if (st.running) {
        const id = (st.modelInfo && st.modelInfo.id)
            || (st.model ? String(st.model).replace(/\.gguf$/i, "").split(/[\\/]/).pop() : "");
        setStatus("ok", id ? "loaded · " + id : "loaded");
        return;
    }
    if (st.guardStopped) { setStatus("down", "stopped to protect memory"); return; }
    if (st.lastRefusal)  { setStatus("down", "would not fit in memory"); return; }
    if (st.lastError)    { setStatus("down", "engine stopped"); return; }
    // NOT AN ERROR, AND THE COMMON CASE while a model on the network answers:
    // nothing is loaded here, so the memory below this row is genuinely free.
    setStatus("ok", "no model loaded · memory free");
}

/**
 * Kept as the name every caller already uses. It no longer writes routing into
 * the engine row — it repaints the picker, which is where the conversation's
 * own model belongs — and then lets the engine speak for itself.
 */
async function setModelStatus() {
    await paintEngineStatus();
}

/**
 * ABOUT YOU — the four fields that stop the model starting every session blank.
 *
 * Reported: "THERE IS NO USER MENU, TO ADD A FIELD FOR ANY PERSONALIZATION, LIKE
 * A NICKNAME FOR ME FOR THE MOTHER FUCKER TO CALL ME."
 *
 * The name is the smallest part. What actually changes the answers is "about" —
 * telling it what you do changes what it assumes you already know, which is most
 * of the difference between a useful reply and one that explains Ohm's law to an
 * their occupation.
 *
 * Goes straight into the system prompt. Nothing here is visible to a model as
 * something it can rewrite: a preference the model can edit is not a preference.
 */
/**
 * WHAT IT HAS LEARNED, AND HOW IT SOUNDS.
 *
 * "What it learns is visible and editable. I can read it, change it, delete
 *  it. Nothing about me is stored anywhere I cannot see it."
 *
 * Every fact is a markdown file in the data folder; this panel is the same
 * content without making anyone open a text editor. Each row can be forgotten
 * on its own, and one button forgets everything.
 */
/* ---- Train > Import Training Data — its own page, its own name. ----
 * An assistant that already knows the operator keeps that knowledge on this
 * machine; discover it per provider, import it REDACTED as training sync.
 * Export is the OTHER page under Train — one importer, one exporter, no
 * buttons for one hidden inside the other. */
async function openTrainingImport() {
    const wrap = document.createElement("div");
    wrap.className = "pref-wrap";
    const ts = await window.lcl.trainingSources()
        .catch(e => ({ error: String((e && e.message) || e) }));
    if (!ts || !ts.ok) {
        const e = document.createElement("div");
        e.className = "pref-note";
        e.innerText = "could not look for training sources — " +
            String((ts && ts.error) || "no detail was reported");
        wrap.appendChild(e);
        await modal({ title: "Import Training Data", node: wrap,
                      confirmLabel: "Close", confirmOnly: true });
        return;
    }
    const note = document.createElement("div");
    note.className = "pref-note";
    note.innerText = "Assistant memory folders found on this machine. Importing " +
        "reads them REDACTED — names, addresses, keys and profanity are stripped " +
        "— into this install's training data for the trainer to eat.";
    wrap.appendChild(note);
    if (!ts.sources.length) {
        const none = document.createElement("div");
        none.className = "pref-note";
        none.innerText = "no assistant memory folders found on this machine";
        wrap.appendChild(none);
    }
    for (const src of ts.sources.slice(0, 6)) {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:6px;";
        const lab = document.createElement("span");
        const st = ts.synced && ts.synced[src.path];
        const stale = st && src.updatedAt && src.updatedAt > st.syncedAt;
        lab.innerText = src.label + " · " + src.files + " files"
            + (st ? (stale ? " · updates available" : " · synced") : "");
        lab.style.flex = "1";
        const btn = document.createElement("button");
        btn.className = "ghost";
        btn.innerText = st ? (stale ? "Re-sync" : "Fresh read") : "Import";
        btn.addEventListener("click", async () => {
            btn.disabled = true; btn.innerText = "syncing…";
            const r = await window.lcl.trainingSync(src.path).catch(e => ({ error: String(e) }));
            btn.innerText = r && r.ok ? ("synced " + r.files + " files (redacted)") : (r && r.error || "failed");
        });
        row.append(lab, btn);
        wrap.appendChild(row);
    }
    await modal({ title: "Import Training Data", node: wrap,
                  confirmLabel: "Close", confirmOnly: true });
}

/* ---- Train > What .lcl has learned — tone, and the notes it worked out. ----
 * Both are install-wide (global), deliberately: not user-profile settings and
 * not per-session state. The training import/export pages live beside this
 * one under Train, each under its own name. */
async function openLearned() {
    const wrap = document.createElement("div");
    wrap.className = "pref-wrap";
    const state = await window.lcl.learned()
        .catch(e => ({ error: String((e && e.message) || e) }));
    if (!state || !state.ok) {
        const e = document.createElement("div");
        e.className = "pref-note";
        // WHY it could not be read, not just that it could not. The reason was
        // being caught and thrown away, leaving one fixed sentence for an
        // unreadable folder, a failed handler and a missing IPC alike — three
        // different problems presented as the same non-answer.
        e.innerText = "could not read what this install has learned — " +
            String((state && state.error) || "no detail was reported");
        wrap.appendChild(e);
        await modal({ title: "Characterization", node: wrap,
                      confirmLabel: "Close", confirmOnly: true });
        return;
    }

    /* ---- tone: a setting, with honest options ---- */
    const th = document.createElement("div");
    th.className = "pref-head";
    th.innerText = "Tone";
    wrap.appendChild(th);
    const tnote = document.createElement("div");
    tnote.className = "pref-note";
    tnote.innerText = "How the model writes, and how this app words its own " +
        "conversational lines. It never changes an error message, a warning or " +
        "a diagnostic — those read the same in every tone.";
    wrap.appendChild(tnote);

    const tsel = document.createElement("select");
    // pref-select is what gives a sheet dropdown its full width; without it
    // this rendered as a ~210px stub with every tone's blurb ellipsised away,
    // so the one thing that helps you choose was the part you could not read.
    tsel.className = "cap-level auto pref-select";
    for (const t of state.tones) {
        const o = document.createElement("option");
        o.value = t.id;
        o.innerText = `${t.label} — ${t.blurb}`;
        if (t.id === state.tone) o.selected = true;
        tsel.appendChild(o);
    }
    tsel.addEventListener("change", async () => {
        const r = await window.lcl.setTone(tsel.value).catch(() => null);
        // the app's own words move with the setting, immediately
        if (r && r.ok && r.lines) appLines = r.lines;
        tsel.classList.add(r && r.ok ? "saved" : "save-failed");
        setTimeout(() => tsel.classList.remove("saved", "save-failed"), 900);
    });
    wrap.appendChild(tsel);

    /* ---- what .lcl has learned ---- */
    const lh = document.createElement("div");
    lh.className = "pref-head";
    lh.innerText = "What .lcl has learned";
    wrap.appendChild(lh);

    const where = document.createElement("div");
    where.className = "pref-note learned-where";
    where.innerText = state.facts.length
        ? `Worked out on this machine from how sessions actually went, without ` +
          `calling a model. Local models are given it; a paid model is given it ` +
          `only for a conversation where you have turned that on. The files are ` +
          `in ${state.dir}`
        : say("learned.none", "Nothing learned yet — it starts from what you tell it") +
          ". It picks the rest up as you work; a new install behaving well is the " +
          "normal case, not a gap.";
    wrap.appendChild(where);

    for (const f of state.facts) {
        const row = document.createElement("div");
        row.className = "learned-row";
        const text = document.createElement("div");
        text.className = "learned-text";
        const t = document.createElement("div");
        t.className = "learned-title";
        t.innerText = f.description || f.name;
        const sub = document.createElement("div");
        sub.className = "learned-sub";
        sub.innerText = `${f.what || ""} · seen ${f.observations} times · ${f.confidence} confidence`;
        text.appendChild(t); text.appendChild(sub);
        const drop = document.createElement("button");
        drop.className = "ghost small danger-text";
        drop.innerText = "Forget";
        drop.title = "Delete this one thing";
        drop.addEventListener("click", async () => {
            await window.lcl.forgetLearned(f.name).catch(() => null);
            closeModal(true);
            openLearned();
        });
        row.appendChild(text); row.appendChild(drop);
        wrap.appendChild(row);
    }

    if (state.facts.length) {
        const all = document.createElement("button");
        all.className = "ghost small danger-text learned-forget-all";
        all.innerText = "Forget everything it has learned";
        all.addEventListener("click", async () => {
            // CLOSE FIRST. The confirmation is a modal, and modals queue: asked
            // for while this panel still held the chain, it waited for a panel
            // that was waiting for it. The button looked dead — the single most
            // destructive action in the panel, appearing to do nothing.
            closeModal(true);
            const sure = await modal({
                title: "Forget everything?",
                message: "Every note this install worked out about how you work is deleted.",
                detail: "What you typed into About you is kept — this only clears what " +
                        "was learned from use. It will start noticing again from here.",
                confirmLabel: "Forget everything", danger: true
            });
            // either way the operator comes back to the panel they were in
            if (sure) await window.lcl.forgetLearned(null).catch(() => null);
            openLearned();
        });
        wrap.appendChild(all);
    }

    await modal({ title: "Characterization", node: wrap, size: "wide",
                  confirmLabel: "Close", confirmOnly: true });
}

async function openProfile() {
    let st = null;
    try { st = await window.lcl.profile(); }
    catch (e) { return dialogFailed("About you", e); }
    const p = (st && st.profile) || { name: "", about: "", style: "", notes: "" };

    const wrap = document.createElement("div");
    wrap.className = "pref-wrap";

    // PLACEHOLDERS, NOT A PROFILE.
    //
    // These shipped with a real person's name, job and workspace path in them:
    // These shipped with a real person's name, occupation and workspace path
    // baked in as the example text. A placeholder that reads like data is one
    // hurried Save away from becoming somebody's actual profile, and a stranger's
    // life has no business appearing in a fresh install.
    //
    // A placeholder's job is to show the SHAPE of a good answer. Naming an
    // occupation or a drive letter is not a shape, it is a stranger's life
    // showing up in a fresh install — and a placeholder that looks like data is
    // one hurried Save away from becoming the user's actual profile.
    const fields = [
        ["name", "What should it call you?", "your name or a nickname", 1,
         "Used naturally in conversation, not stamped on every message."],
        ["about", "Who are you, and what do you work on?",
         "your field, your tools, what you are building", 4,
         "The highest-value field. It changes what the model assumes you already know, so it stops explaining basics."],
        ["style", "How do you want to be answered?",
         "how long, how direct, what to skip", 3,
         "Tone, length, and what to skip."],
        ["notes", "Anything it should always remember?",
         "standing facts — paths, conventions, preferences", 4,
         "Standing facts carried into every session, in every model, local or remote."]
    ];

    const inputs = {};
    for (const [key, label, placeholder, rows, why] of fields) {
        const h = document.createElement("div");
        h.className = "pref-head";
        h.innerText = label;
        wrap.appendChild(h);

        const box = document.createElement("textarea");
        box.className = "profile-field";
        box.rows = rows;
        box.spellcheck = true;
        box.placeholder = placeholder;
        box.value = p[key] || "";
        box.maxLength = (st.caps && st.caps[key]) || 600;
        inputs[key] = box;
        wrap.appendChild(box);

        const n = document.createElement("div");
        n.className = "pref-note";
        n.innerText = why;
        wrap.appendChild(n);
    }

    const status = document.createElement("div");
    status.className = "pref-note";
    status.style.marginTop = "14px";
    status.innerText = st.summary || "";
    wrap.appendChild(status);

    const ok = await modal({
        title: "About you",
        node: wrap,
        confirmLabel: "Save",
        cancelLabel: "Cancel"
    });
    if (!ok) return;

    const next = {};
    for (const k of Object.keys(inputs)) next[k] = inputs[k].value;
    await window.lcl.setProfile(next).catch(() => null);
}

/**
 * THE SHELF IS GONE, AND THE READING IS NOT.
 *
 * openShelf() was the SECOND knowledge UI — the one under "Read the
 * knowledge…". It is not deleted so much as merged: every capability it had
 * (the shipped corpus, the added folders, a filter over both, a reading pane
 * that puts a PDF in Chromium own viewer) is in the one panel above, and the
 * one capability it had that the contract forbids — paging through
 * knowledge/text/*.txt as if extracted text were a document — is replaced by
 * the needs-fetch card, which names the source, says search still works, and
 * offers the download.
 *
 * Kept as a note rather than as dead code, because a second surface that
 * still exists is a second surface somebody will wire a button to again.
 */


/**
 * MODELS & API — one place for everything about which model answers you.
 *
 * Reported: linking an API landed on the knowledge panel; the network switch
 *           landed under Security; features ended up in places where someone
 *           would stumble onto them by accident.
 *
 * All three are the same defect: each feature got bolted onto whichever panel
 * happened to be open when it was written. Connecting an endpoint ended up under
 * "What .lcl can do", the network switch under Security, roles in a third
 * dialog. Nothing was where a person would look for it.
 *
 * This is the one place: connect an endpoint, choose which model drives, choose
 * which one handles hard problems, set rates, and turn the network on — because
 * a remote model is unreachable without it and hiding that switch two menus away
 * is how you get someone staring at a dead Connect button.
 */
async function openModels() {
    const wrap = document.createElement("div");
    wrap.className = "pref-wrap";
    const note = document.createElement("div");
    note.className = "pref-note";
    wrap.appendChild(note);
    const list = document.createElement("div");
    list.className = "pref-rates";
    wrap.appendChild(list);

    const fmt = (b2) => b2 >= 1e9 ? (b2 / 1e9).toFixed(1) + " GB"
        : b2 >= 1e6 ? Math.round(b2 / 1e6) + " MB" : b2 + " B";

    const paint = async () => {
        list.innerHTML = "";
        const r = await window.lcl.localModels().catch(() => null);
        if (!r || r.error) {
            note.innerText = (r && r.error) || "could not read this machine's model folder";
            return;
        }
        note.innerText = "Model files on this machine, in " + (r.dir || "the model folder") +
            ". These are the weights .lcl did not ship with — the engine loads " +
            "the one marked in use.";
        if (!r.models.length) {
            const e = document.createElement("div");
            e.className = "pref-note";
            e.innerText = "Nothing here yet. Put a .gguf in that folder, or " +
                "install one onto a machine from its card in APIs & Connections.";
            list.appendChild(e);
            return;
        }
        for (const m of r.models) {
            const row = document.createElement("div");
            row.className = "model-row";
            const nm = document.createElement("div");
            nm.className = "model-row-name";
            nm.innerText = m.file + (m.file === r.inUse ? "   · in use" : "");
            const meta = document.createElement("div");
            meta.className = "model-row-meta";
            meta.innerText = fmt(m.bytes);
            const del = document.createElement("button");
            del.className = "ghost small icon-act icon-only danger-text";
            del.appendChild(ICONS.trash());
            del.title = "Delete this model file from disk";
            del.setAttribute("aria-label", del.title);
            del.addEventListener("click", async () => {
                // A DELETE OF A 40 GB FILE IS NOT AN UNDOABLE CLICK.
                const sure = await modal({
                    title: "Remove this model?",
                    message: m.file,
                    detail: fmt(m.bytes) + " will be freed. The file is deleted from " +
                            r.dir + "; downloading it again is the only way back." +
                            (m.file === r.inUse
                                ? "\n\nThis is the model the engine is set to load." : ""),
                    confirmLabel: "Remove", danger: true });
                if (!sure) return;
                const res = await window.lcl.localModelRemove(m.file).catch(() => null);
                if (res && res.ok) { addNotice(m.file + " was removed."); paint(); }
                else { note.innerText = (res && res.error) || "could not remove it"; }
            });
            row.append(nm, meta, del);
            list.appendChild(row);
        }
    };
    await paint();

    await modal({ title: "Local Models", node: wrap,
                  confirmLabel: "Done", confirmOnly: true });
}

/*
 * MANAGE MODELS — informational. Every device that can answer, as its own
 * group, all of its models listed in full. Click Manage to go where that
 * device is actually administered.
 */
async function openManageModels() {
    const wrap = document.createElement("div");
    wrap.className = "pref-wrap";

    const [modelsRes, st, intel, rateRes] = await Promise.all([
        window.lcl.listModels().catch(() => null),
        window.lcl.cloudState().catch(() => null),
        window.lcl.modelIntel ? window.lcl.modelIntel().catch(() => null) : null,
        window.lcl.modelRates().catch(() => null)
    ]);
    const list = (modelsRes && modelsRes.models) || [];
    const eps = (st && st.endpoints) || [];
    // the user's own and endpoint-learned rates — the same source the Rates
    // popup and the cost meter read, so the three screens agree
    const userRates = (rateRes && rateRes.rates) || {};

    // EXACT id first, then tail — a bare tail match hands a hosted price to a
    // free local copy (glm-5.2 exists on OpenRouter AND Ollama)
    const intelOf = (id) => {
        if (!intel || !intel.models) return null;
        const bare = String(id).toLowerCase();
        const tail = bare.split("/").pop();
        return intel.models.find(m => m.id.toLowerCase() === bare)
            || intel.models.find(m => m.id.toLowerCase().split("/").pop() === tail)
            || null;
    };
    // billed=false for a local/node model: it costs nothing to run, so a
    // catalog per-token price must NOT be shown against it as if it were a bill
    const rateText = (id, rec, billed) => {
        const r = userRates[id]
            || (rec && rec.rate)
            || (billed ? (intelOf(id) || {}).rate : null)
            || null;
        if (!r || (r.in === undefined && r.out === undefined)) return "";
        const f = (v) => (v === undefined || v === null) ? "?" : v;
        return "$" + f(r.in) + " / $" + f(r.out) + " per M";
    };

    const group = (title, badges, onManage, manageLabel) => {
        const g = document.createElement("div");
        g.className = "mm-group";
        const h = document.createElement("div");
        h.className = "mm-head";
        const t = document.createElement("span");
        t.className = "mm-title";
        t.innerText = title;
        h.appendChild(t);
        for (const b of badges || []) {
            const s = document.createElement("span");
            s.className = "cloud-badge" + (b.cls ? " " + b.cls : "");
            s.innerText = b.txt;
            h.appendChild(s);
        }
        if (onManage) {
            const m = document.createElement("button");
            m.className = "ghost small mm-manage";
            m.innerText = manageLabel || "Manage…";
            m.addEventListener("click", () => { closeModal(true); onManage(); });
            h.appendChild(m);
        }
        g.appendChild(h);
        const rows = document.createElement("div");
        rows.className = "mm-rows";
        g.appendChild(rows);
        wrap.appendChild(g);
        return rows;
    };
    const row = (rows, id, sub, right) => {
        const r = document.createElement("div");
        r.className = "mm-row";
        const a = document.createElement("div");
        a.className = "mm-id";
        a.innerText = id;
        r.appendChild(a);
        const s = document.createElement("div");
        s.className = "mm-sub";
        s.innerText = sub || "";
        r.appendChild(s);
        const z = document.createElement("div");
        z.className = "mm-right";
        z.innerText = right || "";
        r.appendChild(z);
        rows.appendChild(r);
    };
    const blurbOf = (id) => {
        const info = intelOf(id);
        return (info && info.blurb) || "";
    };

    // this machine
    {
        const local = list.filter(m => !m.remote);
        const rows = group("This machine",
            // "it should be Local Models. that is what should be. only that"
            [{ txt: "local" }], openModelLibrary, "Local Models…");
        for (const m of local.filter(x => x.present)) {
            row(rows, (m.family + " " + m.params + " " + (m.quant || "")).trim(),
                blurbOf(m.family), "installed");
        }
        for (const m of local.filter(x => !x.present)) {
            row(rows, (m.family + " " + m.params + " " + (m.quant || "")).trim(),
                blurbOf(m.family), "not installed");
        }
        if (!local.length) row(rows, "nothing installed yet", "", "");
    }

    // each node, each API, each rented GPU — its full list, not a curation
    const fullList = (ep) => (ep.allModels && ep.allModels.length
        ? ep.allModels : (ep.models || []))
        .map(m => (typeof m === "string" ? { id: m } : m));
    const kinds = [
        { members: eps.filter(e => e.localNode), billed: false,
          badges: () => [{ txt: "your machine" }] },
        { members: eps.filter(e => !e.localNode && !e.rented), billed: true,
          badges: (ep) => {
              const b = [{ txt: "API" }];
              if (ep.plan === "go-window") b.push({ txt: "GO · metered", cls: "cloud-badge-go" });
              return b;
          } },
        { members: eps.filter(e => e.rented), billed: true,
          badges: () => [{ txt: "$ GPU" }] }
    ];
    for (const kind of kinds) {
        for (const ep of kind.members) {
            // EVERY endpoint here goes to Connections, node or not. A machine
            // is managed from its own card there — the second route through
            // this menu is the duplication that made one page feel like two
            // features, and this menu exists to pick a model.
            const rows = group(ep.label || ep.baseUrl, kind.badges(ep),
                openConnections, "Connections…");
            const models = fullList(ep);
            for (const m of models) {
                row(rows, m.id, blurbOf(m.id), rateText(m.id, m, kind.billed));
            }
            if (!models.length) row(rows, "no models listed yet — Refresh models on its card", "", "");
        }
    }

    await modal({ title: "Manage Models", node: wrap,
                  confirmLabel: "Done", confirmOnly: true, size: "xwide" });
    await refreshModelPick();
    refreshCostMeter();
}


// =============================================================
// THE TERMINAL  —  CONTRACT K5
// -------------------------------------------------------------
// "A TERMINAL. There is none. Add a panel from the BOTTOM of the window with a
//  `>_` SVG button in the header. It is a REAL shell he owns: no sandbox, no
//  approval. Say so in the panel, once, quietly. The model has no path to it."
//
// Everything here talks to main.js through the four bridge calls named in the
// contract and nothing else. There is no code path from the agent, from a tool
// result, or from a message into terminalWrite — the only caller is the keydown
// handler on the pane, which fires from a real key on a real keyboard.
// tests/preload-contract.js asserts that from the other side.
// =============================================================
const termEl = $("terminal");
const termView = $("terminal-view");
const termTabs = $("terminal-tabs");
const termStatus = $("terminal-status");

// id -> { id, out, echo, shell, exited }
const shells = new Map();
let termActive = null;
let termNotice = null;

const termOpen = () => !termEl.classList.contains("hidden");

/**
 * How many columns and rows the pane can actually show.
 *
 * Measured from a real glyph rather than assumed: the pane is --mono at
 * --fs-sm, and a wrong column count makes every program that draws a table
 * wrap in the wrong place. Falls back to 80x24 if the pane has no size yet,
 * which is the size every shell already expects.
 */
function termSize() {
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    probe.innerText = "0".repeat(100);
    termView.appendChild(probe);
    const r = probe.getBoundingClientRect();
    const line = probe.offsetHeight || 16;
    probe.remove();
    const box = termView.getBoundingClientRect();
    const chw = r.width ? r.width / 100 : 8;
    const cols = Math.max(20, Math.floor((box.width - 24) / chw) || 80);
    const rows = Math.max(6, Math.floor((box.height - 12) / line) || 24);
    return { cols, rows };
}

/** Paint the active shell. textContent everywhere — no shell output is HTML. */
function paintTerminal() {
    const s = termActive && shells.get(termActive);
    termView.innerHTML = "";
    if (!s) {
        termStatus.innerText = termNotice || "no shell";
        return;
    }
    // KEEP EVERYTHING, SHOW THE TAIL. A shell that has printed a megabyte must
    // not cost a megabyte of DOM on every keystroke; the buffer keeps the lot
    // and the pane renders the last 4000 lines of it.
    const lines = s.out.split("\n");
    const shown = lines.length > 4000 ? lines.slice(-4000).join("\n") : s.out;
    termView.appendChild(document.createTextNode(shown));
    if (s.echo) {
        const e = document.createElement("span");
        e.className = "term-echo";
        e.textContent = s.echo;
        termView.appendChild(e);
    }
    /* A CURSOR, so the pane looks like somewhere you can type.
     *
     * There was none — not hidden, not mis-styled: no caret element existed at
     * all. With an empty line and no block, the terminal reads as dead output
     * rather than a prompt waiting for you, which is "i still have no cursor in
     * the terminal". It sits after whatever has been typed, blinks while the
     * pane has focus, and goes solid-dim when focus is elsewhere so it is
     * honest about where the keys are going. A dead shell gets none. */
    if (!s.exited) {
        const caret = document.createElement("span");
        caret.className = "term-caret";
        caret.textContent = "█";          // full block, like a console caret
        termView.appendChild(caret);
    }
    termView.scrollTop = termView.scrollHeight;
    const size = termSize();
    termStatus.innerText = [
        s.shell || "shell",
        s.exited ? "exited" : "running",
        size.cols + "×" + size.rows,
        s.out.length.toLocaleString() + " bytes"
    ].join(" · ");
}

function paintTermTabs() {
    termTabs.innerHTML = "";
    // one shell needs no tab strip; the strip is how you tell four apart
    termTabs.classList.toggle("hidden", shells.size < 2);
    for (const s of shells.values()) {
        const b = document.createElement("button");
        b.className = "term-tab" + (s.id === termActive ? " on" : "");
        b.appendChild(document.createTextNode(s.shell || s.id));
        const kill = document.createElement("span");
        kill.className = "term-tab-kill";
        kill.textContent = "✕";
        kill.title = "End this shell";
        kill.addEventListener("click", async (e) => {
            e.stopPropagation();
            await window.lcl.terminalKill(s.id).catch(() => null);
            shells.delete(s.id);
            if (termActive === s.id) termActive = shells.keys().next().value || null;
            paintTermTabs(); paintTerminal();
        });
        b.appendChild(kill);
        b.addEventListener("click", () => {
            termActive = s.id; paintTermTabs(); paintTerminal(); termView.focus();
        });
        termTabs.appendChild(b);
    }
}

async function startShell() {
    const size = termSize();
    let r = null;
    try { r = await window.lcl.terminalStart(size.cols, size.rows); }
    catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (!r || !r.id) {
        // A SHELL THAT WOULD NOT START SAYS SO IN THE PANE. Silence here is
        // indistinguishable from a shell that started and printed nothing.
        termStatus.innerText = "could not start a shell — " +
            ((r && r.error) || "no reason given");
        return null;
    }
    // main returns the unsandboxed notice from terminalStart; the markup
    // carries the same sentence so the panel is never blank before it answers
    if (r.notice) {
        termNotice = r.notice;
        $("terminal-notice").innerText = r.notice +
            (/cannot|no path/i.test(r.notice) ? "" : " .lcl's model cannot type here.");
    }
    const s = { id: r.id, out: "", echo: "", shell: r.shell || "shell", exited: false };
    shells.set(s.id, s);
    termActive = s.id;
    paintTermTabs();
    paintTerminal();
    return s;
}

/** Output from main, for whichever shell produced it. */
if (window.lcl.onTerminalData) {
    window.lcl.onTerminalData((id, chunk) => {
        const s = shells.get(id);
        if (!s) return;
        s.out += String(chunk == null ? "" : chunk);
        if (id === termActive && termOpen()) paintTerminal();
    });
}
if (window.lcl.onTerminalExit) {
    window.lcl.onTerminalExit((id, code) => {
        const s = shells.get(id);
        if (!s) return;
        s.exited = true;
        // the exit code is a diagnostic and it stays in the buffer, not just in
        // a status line that the next shell overwrites
        s.out += "\n[shell exited with code " + code + "]\n";
        if (id === termActive && termOpen()) paintTerminal();
    });
}

async function toggleTerminal(force) {
    const open = force === undefined ? !termOpen() : force;
    termEl.classList.toggle("hidden", !open);
    const btn = $("terminal-toggle");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.title = open ? "Hide the terminal" : "Open a terminal — your own shell, unsandboxed";
    btn.setAttribute("aria-label", btn.title);
    $("terminal-close").setAttribute("aria-expanded", open ? "true" : "false");
    if (!open) return;
    if (!shells.size) await startShell();
    else paintTerminal();
    termView.focus();
}

$("terminal-toggle").addEventListener("click", () => toggleTerminal());
// HIDING IS NOT KILLING. A build running in there survives the drawer closing;
// ending a shell is the ✕ on its own tab, which is a different decision.
$("terminal-close").addEventListener("click", () => toggleTerminal(false));
$("terminal-new").addEventListener("click", async () => {
    if (shells.size >= 4) {           // main.js caps it at four; say so here too
        termStatus.innerText = "four shells is the limit — end one first";
        return;
    }
    await startShell();
    termView.focus();
});

/**
 * KEYS GO TO THE SHELL.
 *
 * The pane echoes the line being typed locally, because a shell reading from a
 * pipe does not echo it back — without this you type blind. The echo is only
 * ever what this keyboard produced; nothing else in the app can put a character
 * into it.
 */
termView.addEventListener("keydown", (e) => {
    const s = termActive && shells.get(termActive);
    if (!s) return;
    const send = (data) => { window.lcl.terminalWrite(s.id, data); };
    if (e.key === "Enter") {
        e.preventDefault();
        // DO NOT ECHO THE COMMAND OURSELVES. Measured against a real cmd.exe and
        // a real powershell: both echo stdin back, so adding s.echo to the
        // buffer here printed every command TWICE —
        //   C:\Users\me>echo hi   (our local copy)
        //   echo hi               (the shell's own echo)
        //   hi
        // which read as the terminal being broken. The shell owns the echo; we
        // only show the in-progress line while it is being typed, then hand it
        // over and clear ours.
        send(s.echo + "\r\n");
        s.echo = "";
        paintTerminal();
        return;
    }
    if (e.key === "Backspace") {
        e.preventDefault();
        s.echo = s.echo.slice(0, -1);
        paintTerminal();
        return;
    }
    if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
        // Ctrl+C with a selection is a copy; with none it is an interrupt, which
        // is what every terminal does and what a person's hands expect
        if (String(window.getSelection() || "")) return;
        e.preventDefault();
        send("\x03");
        s.echo = "";
        s.out += "^C\n";
        paintTerminal();
        return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;      // shortcuts stay shortcuts
    if (e.key.length !== 1) return;
    e.preventDefault();
    s.echo += e.key;
    paintTerminal();
});

// CLICKING THE PANE FOCUSES IT — always, and without losing a text selection
// the operator is trying to copy. A div with tabindex focuses on click in
// theory, but a keydown handler that never fires because focus quietly sat on
// the composer is exactly the "cannot type in it or do anything" case, so this
// makes it explicit rather than trusting the default.
termView.addEventListener("mousedown", () => {
    // defer, so a drag-select still completes; focus lands after the gesture
    setTimeout(() => { if (!String(window.getSelection() || "")) termView.focus(); }, 0);
});
termView.addEventListener("click", () => {
    if (!String(window.getSelection() || "")) termView.focus();
});

// pasting into a shell is normal and must not be re-typed by hand
termView.addEventListener("paste", (e) => {
    const s = termActive && shells.get(termActive);
    if (!s) return;
    e.preventDefault();
    const t = (e.clipboardData && e.clipboardData.getData("text")) || "";
    if (!t) return;
    s.echo += t.replace(/\r?\n/g, " ");
    paintTerminal();
});

/**
 * DRAG THE HEADER TO RESIZE, and tell the shell its new size.
 *
 * A shell that thinks it has 24 rows while the pane shows 60 draws its prompt
 * in the wrong place forever. terminalResize is in the contract for this reason.
 */
{
    const TERM_MIN = 120;
    let drag = null;
    $("terminal-head").addEventListener("pointerdown", (e) => {
        if (e.target.closest("button")) return;
        drag = { y: e.clientY, h: termEl.getBoundingClientRect().height };
        $("terminal-head").setPointerCapture(e.pointerId);
    });
    $("terminal-head").addEventListener("pointermove", (e) => {
        if (!drag) return;
        const h = Math.max(TERM_MIN,
            Math.min(window.innerHeight - 200, drag.h + (drag.y - e.clientY)));
        termEl.style.setProperty("--term-h", h + "px");
    });
    const endDrag = () => {
        if (!drag) return;
        drag = null;
        const size = termSize();
        for (const s of shells.values()) {
            window.lcl.terminalResize(s.id, size.cols, size.rows);
        }
        paintTerminal();
    };
    $("terminal-head").addEventListener("pointerup", endDrag);
    $("terminal-head").addEventListener("pointercancel", endDrag);
}

// =============================================================
// REMOTE APPROVAL  —  CONTRACT K3, ASKED IN PLACE
// -------------------------------------------------------------
// "Ask before every remote call" was decorative: cloudAutoApprove was written
// to settings and read back only to paint its own dropdown. main.js now HOLDS
// the turn and asks. This is the half that answers — and without it every
// remote turn waits out main's 120-second timeout and is then denied, so an
// unbuilt card is worse than no gate at all.
//
// It was a modal. It is now the same inline prompt every other permission
// question uses, in the transcript, because "ask in place" was the request and
// because a dialog you dismiss with Escape teaches dismissal. The three
// verdicts the contract defines are all still here, and a FOURTH answer that
// costs main nothing: "for this conversation" answers `once` and remembers the
// destination for this session, so the operator gets a session-scoped trust
// without a session-scoped verdict having to exist in the protocol.
//
// FAIL CLOSED IS STILL THE FLOOR. Nothing is sent until an answer is given;
// an unanswered card is denied by main's own timeout, and the card says so.
// =============================================================
// A remote approval raised for a session the operator is not looking at,
// held until they open it. Cleared when answered or when main withdraws it.
const remoteAwaiting = new Map();      // sessionId -> the unanswered request

async function presentRemoteApproval(req) {
    {
        const r = req || {};
        // THE CARD BELONGS TO THE SESSION THAT ASKED, NOT THE ONE ON SCREEN.
        //
        // This is a window-wide broadcast carrying a sessionId that nothing
        // read: a background session's remote send drew its card into
        // whatever transcript happened to be open, and — worse — the
        // already-trusted shortcut below asked `isCapabilityGranted(active.id)`,
        // so a grant belonging to the session you were LOOKING AT could
        // auto-approve a send from a completely different one.
        //
        // A request from elsewhere is left to that session: main has already
        // set its sidebar dot amber and raised the toast, and the card is
        // rebuilt when the operator opens it. Nothing is auto-answered here,
        // so the turn still fails closed on main's own timeout if ignored.
        const forId = r.sessionId ? String(r.sessionId) : null;
        if (forId && (!active || String(active.id) !== forId)) {
            remoteAwaiting.set(forId, r);
            return;
        }
        const dest = r.destination || {};
        const yours = dest.kind === "your-machine" || r.localNode === true;
        const where = String(dest.label || r.endpoint || "somewhere else");

        const send = async (verdict) => {
            try { await window.lcl.answerRemoteApproval(r.id, verdict); }
            catch { /* main times out and denies, which is the same outcome */ }
            if (verdict === "always") {
                // the dropdown that owns this setting must not go on claiming
                // the gate is armed after the operator has just disarmed it
                refreshModelPick();
            }
        };

        // (A conversation that already TRUSTS this endpoint never reaches
        // here: main skips the ask entirely and sends lcl:remoteSendAllowed
        // instead, which draws the quiet line — see presentTrustedSend. The
        // renderer-side capability map was never given "remote:" keys, so the
        // branch that used to live here was unreachable dead code.)

        // WHAT IT COSTS — never a number the app cannot stand behind.
        // tokenCost returns null for a model it has no rate for; flattening
        // that to 0 would print "$0" on a call that may cost real money.
        const usd = Number(r.estCostUsd);
        const costLine = (r.estCostKnown === false
            ? "cost unknown — no rate is set for this model"
            : (yours && !usd
                ? "free — your own hardware"
                : "about $" + (Number.isFinite(usd)
                    ? (usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)) : "?")))
            + (r.estInputTokens
                ? " · " + Number(r.estInputTokens).toLocaleString() + " tokens to send" : "");

        // A FALLBACK ASK IS ITS OWN QUESTION. The operator already answered
        // one card this turn — for the model THEY picked, usually at $0 — and
        // the destination has now CHANGED. Pretending this is the same
        // routine ask is exactly how eight approvals for "spark, $0" turned
        // into $0.38 of DeepInfra: the reroute must lead with what refused
        // and what it costs to continue elsewhere. "Always" is not offered
        // here — disarming the app-wide gate is too big a lever to hand to a
        // card about one substitution.
        const isFallback = r.fallback === true;
        const prompt = buildInlinePrompt({
            kind: "remote",
            // A CALL TO YOUR OWN SPARK IS NOT A PURCHASE. Same gate, different
            // sentence: main.js asks about both because a message leaving this
            // laptop is a privacy decision as well as a spend one, but
            // presenting them identically is how a person learns to click yes.
            title: isFallback
                ? (yours ? "Your first choice refused — run it on this machine of yours instead?"
                         : "Your first choice refused — pay " + where + " to answer instead?")
                : (yours ? "Send this to your machine?" : "Send this to a paid endpoint?"),
            subject: isFallback
                ? String(r.fellBackFrom || "the selected model") + "  ✗  →  " +
                  String(r.model || "a model") + " on " + where
                : String(r.model || "a model") + "  →  " + where,
            detail: costLine,
            notes: [
                isFallback && r.reason
                    ? "Why it refused: " + String(r.reason).slice(0, 220)
                    : null,
                r.costNote || null,
                yours
                    ? "This is hardware you control. The words still leave this computer."
                    : where + " is a third party. Anything sent there is out of your " +
                      "hands once it arrives.",
                isFallback
                    ? "Denying keeps the refusal as this turn's answer — nothing is re-run."
                    : "Nothing is sent until you answer. Leave this and it is denied."
            ],
            answers: [
                { id: "once", label: isFallback ? "Re-run it there once" : "Send it once",
                  cls: "primary", sub: "this message only" },
                { id: "trust", label: "Allow for this conversation", cls: "ghost",
                  sub: "this conversation stops asking, until you revoke it" },
                // NO APP-WIDE ANSWER. "Always, every session" wrote a global
                // switch — one click disarming the gate for conversations that
                // do not exist yet. The widest answer a card offers is the
                // conversation it was raised in.
                { id: "deny", label: "Deny", cls: "ghost danger-text",
                  sub: isFallback ? "keep the refusal, spend nothing" : "nothing is sent" }
            ],
            pointer: {
                // the gate's controls live with the rest of the permissions
                // now — the shield under the chat input opens the same panel
                where: "Session › Permissions — the “Leaves this machine” " +
                       "section shows what this conversation trusts, the " +
                       "app-wide gate, and the waiting-ask notification. The " +
                       "shield button under the chat input opens it too.",
                label: "Open Permissions",
                onOpen: () => openSessionPerms()
            },
            onAnswer: async (id, st) => {
                const finish = (receipt, allowed, verdict) => {
                    // the receipt belongs to the conversation that ASKED — the
                    // operator may well be looking at a different one by now
                    permReceipt(receipt, allowed, forId || (active && active.id));
                    setTimeout(() => permPopupDismiss(prompt), 1400);
                    return send(verdict);
                };
                if (id === "deny") {
                    st.innerText = "Denied — nothing was sent.";
                    return finish("denied — " + String(r.model || "the model") +
                                  " → " + where + ", nothing sent", false, "deny");
                }
                if (id === "trust") {
                    // SERVER-SIDE, NOT RENDERER-SIDE. The old "session" answer
                    // kept a renderer Map and sent "once" — so main asked again
                    // next turn, the renderer auto-answered, and a reload lost
                    // the grant. "trust" is a real verdict main persists on the
                    // session record (trustedEndpoints), so main skips the ask
                    // entirely next turn and it survives a restart.
                    st.innerText = "Allowed for this conversation. Calls to " + where +
                        " will not ask again in this conversation. It stays " +
                        "granted until you revoke it in Session › Permissions.";
                    return finish("allowed for this conversation — " + where,
                                  true, "trust");
                }
                st.innerText = "Sent once. Nothing was changed for next time.";
                return finish("sent once — " + String(r.model || "the model") +
                              " → " + where, true, "once");
            }
        });
        // COPYABLE, like every other message — the operator quoted this card
        // back by hand because it had no copy button
        try {
            const head = prompt.querySelector(".perm-prompt-head");
            if (head) head.appendChild(actionButton("copy", "Copy this ask", (b) => {
                copyText(prompt.innerText).then(ok => { if (ok) flashCheck(b); });
            }));
        } catch { /* the card still works without the button */ }
        // WHOSE QUESTION IS THIS. Carried on the card so a session switch can
        // put it back in the queue instead of floating it over a conversation
        // it has nothing to do with, and so main's withdraw can find it.
        prompt.dataset.sessionId = forId || (active ? String(active.id) : "");
        prompt.dataset.approvalId = String(r.id || "");
        permPopupShow(prompt);
    }
}
if (window.lcl.onRemoteApproval) window.lcl.onRemoteApproval(presentRemoteApproval);
if (window.lcl.onRemoteApprovalWithdrawn) {
    window.lcl.onRemoteApprovalWithdrawn((info) => {
        try { permPopupWithdraw(info && info.id, info && info.reason); } catch { }
    });
}

/* A.5 — THE SECRET IS ABOUT TO LEAVE. A shared session (send-secrets on) that
 * is sending a detected secret out is stopped here with a blocking card: send
 * it as-is, or redact it (the message still goes, the secret masked). Cancelling
 * the whole turn is the Stop button; not answering fails closed to redact in
 * main. Two buttons because the essential decision is send-or-mask. */
if (window.lcl.onSecretEgress) {
    window.lcl.onSecretEgress(async (req) => {
        const dest = (req && req.destination) || {};
        const where = dest.label || "a remote model";
        let send = false;
        try {
            send = await modal({
                title: "A secret is about to leave this machine",
                message: `This conversation is sending something shaped like a secret to ${where}` +
                    (dest.owned ? " — your own hardware." : " — a third party."),
                detail: "Send it as it is, or redact it (the message still goes, the secret masked). " +
                    "To stop the whole turn instead, use Stop.",
                confirmLabel: "Send the secret",
                cancelLabel: "Redact it",
                danger: true
            });
        } catch { send = false; }
        try { await window.lcl.answerSecretEgress(req.id, send ? "send" : "redact"); }
        catch { /* main fails closed on timeout */ }
    });
}

/* A TRUSTED SEND STILL SHOWS ITSELF. Once this conversation trusts an
 * endpoint main stops asking — rightly — and without this the messages left
 * the machine with nothing in the transcript to say so. One quiet line per
 * send, with the real revoke on it (the session record's trustedEndpoints,
 * not a renderer-side map that a reload forgets). */
function presentTrustedSend(info) {
    const i = info || {};
    if (!active || String(active.id) !== String(i.sessionId || "")) return;
    const dest = i.destination || {};
    const yours = dest.kind === "your-machine";
    const where = String(dest.label || i.endpoint || "somewhere else");
    const chip = document.createElement("div");
    chip.className = "perm-auto-chip";
    chip.dataset.answer = "session-auto";
    const txt = document.createElement("span");
    txt.className = "perm-auto-txt";
    txt.innerText = (yours ? "sent to your machine" : "sent to " + where)
        + " · allowed for this conversation";
    const undo = document.createElement("button");
    undo.className = "perm-auto-undo";
    undo.innerText = "stop allowing";
    undo.title = "The next call to " + where + " will ask again.";
    const sid = String(i.sessionId);
    undo.addEventListener("click", async () => {
        const res = await window.lcl.revokeTrustedEndpoint(sid, i.endpointId)
            .catch(() => null);
        if (res && res.ok) {
            undo.remove();
            txt.innerText = "stopped — the next call to " + where + " will ask";
            paintPermChip();          // the shield drops the "sends to X" grant
        } else {
            txt.innerText = "could not stop — open Session › Permissions";
        }
    });
    chip.append(txt, undo);
    chat.appendChild(chip);
    scrollToBottom(true);
}
if (window.lcl.onRemoteSendAllowed) window.lcl.onRemoteSendAllowed(presentTrustedSend);
