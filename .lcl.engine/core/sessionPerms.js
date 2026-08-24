"use strict";
/**
 * WHAT THIS SESSION IS ALLOWED TO DO.
 *
 * WHO decides: the operator, per session, in the UI — never a model, never a
 * heuristic, never something inferred from what was typed.
 *
 * WHAT it covers: the three things that were previously either hard-wired off
 * or set once globally for every session at once —
 *   secrets   may credentials this session reads be SENT to the model
 *   autoRun   may an approved-shape script run without stopping for a click
 *   sandbox   must a real isolation boundary exist before scripts run at all
 * plus writeMode, which existed globally and now has a per-session override.
 *
 * WHEN it applies: read fresh on every check. Changing a control takes effect
 * on the next tool call, with no restart and no re-linking.
 *
 * WHERE it lives: on the session record itself (data/sessions/<id>.json), so
 * it survives a restart, travels with the session, and cannot leak into a
 * different one. `null` on any field means INHERIT THE GLOBAL SETTING — the
 * session only records deliberate departures, so changing a global default
 * still moves every session that never overrode it.
 *
 * WHY it exists: so a user has no reason to edit the logic in .lcl just to do
 * some minor thing the defaults restrict. A wall with no gate gets tunnelled
 * through; the gate IS the safety feature.
 *
 * The defaults are the strict end of every axis. A permission is only ever
 * held because somebody turned it on.
 */

const DEFAULTS = Object.freeze({
    secrets: false,
    autoRun: false,
    requireIsolation: false,
    // A profile of the operator is not something a third party gets by default.
    tailoring: false,
    writeMode: null,           // null = follow the global setting
    // SELF-REVIEW IS A CAPACITY, NOT A HABIT.
    //
    // The design goal is not always-on agents: local should have the CAPACITY
    // to run agents and audit its own work, as a function or mode of operation
    // that can be invoked when needed.
    //
    // So the review panel is a mode this conversation can be put into — for the
    // work where it earns its cost, like having a repo read and modified — and
    // it is off everywhere else. null follows the app setting, which is off
    // until it is turned on.
    selfReview: null,           // null = follow the app default; true/false = this session decides
    // AGENT MODE for an API driver — ON by default. Multi-step planning
    // with a critic per step is what Ancient Knowledge and raised reasoning
    // effort assume; turning it OFF is the exception the operator is warned
    // about, not the default. Local and node drivers always run the
    // orchestrator when the goal warrants it — this switch governs the API opt.
    agentMode: true,
    // NOTHING IS APP-WIDE. All permissions are session specific; nothing is
    // app wide. The leave-machine gate was the
    // last holdout: it read a global cloudAutoApprove, so the Permissions
    // sheet described a switch that reached into every other conversation.
    // It is this conversation's switch now. true = ask before this session
    // sends anything out.
    askRemote: true
});

/** Every switch, with the text the UI shows. One table, so no surface drifts. */
const CATALOG = Object.freeze([
    {
        key: "askRemote",
        title: "Ask before this conversation sends anything out",
        off: "This conversation sends to its endpoint without asking. Every " +
             "send still shows a line in the transcript with a way to stop it, " +
             "and every one is recorded in Spend and the activity log.",
        on: "Anything leaving this machine asks first, with the destination " +
            "and the price on the card.",
        limit: "This conversation only. No switch here reaches another one.",
        destinationAware: true
    },
    {
        key: "secrets",
        // NOT "credentials". The word "credentials" reads as username and
        // password, which is not what this sends and not the correct term for
        // it. The guard covers anything SHAPED like a secret, which is much
        // broader than a login.
        title: "Send secrets and keys to the model",
        off: "Anything that looks like a secret — an API key, an access token, " +
             "a password, a connection string — is replaced with a placeholder " +
             "before this session sends anything.",
        on: "Secrets and keys this session reads are sent in full, exactly as " +
            "they appear in your files.",
        // THE HONEST EDGE. Said out loud in the UI because the concern is
        // general privacy, not just secrets — and the answer today is that this
        // catches secret SHAPES and values read from files, not personal
        // information in general.
        limit: "This does not detect personal information — a name, an address, " +
               "a customer record. It catches things shaped like secrets, and " +
               "exact values it has already read from your files.",
        // filled in by the UI from cloudModels.destinationFor("driver"), because
        // the same switch means something different per destination
        destinationAware: true,
        risk: "high"
    },
    {
        key: "autoRun",
        title: "Run scripts without asking",
        off: "Every script stops and waits for you to read and approve it.",
        on: "A script that passes the safety inspection runs immediately. " +
            "Anything the inspection flags still stops and waits.",
        risk: "high"
    },
    {
        key: "requireIsolation",
        title: "Only run scripts inside a real sandbox",
        off: "Scripts may run directly on this computer when no sandbox exists.",
        on: "Scripts are refused unless Docker, WSL or another real boundary is " +
            "available. Safer, and does nothing on a machine that has none.",
        risk: "safer"
    },
    // ("Check its own work" is no longer exposed here — enabling Ancient
    //  Knowledge IS enabling the review; sessionPerms.selfReviewOn folds it in)
    {
        key: "tailoring",
        title: "Send what it has learned about you to a paid model",
        // WHY THIS SWITCH EXISTS. tailor.js works out how this person likes to
        // be answered — how short they write, whether they want the answer or
        // the working, how often they correct — and hands it to the model as
        // part of the system prompt. On a local model that never leaves the
        // machine. On a linked API it is in the request body like everything
        // else, and the module claimed otherwise until a review read the path
        // end to end. The claim is now true because this switch makes it true:
        // off, the learned block is simply absent from a remote turn.
        off: "What this install has learned about how you work is used by local " +
             "models only. A paid model is answering without it.",
        on: "The learned profile is included in the prompt sent to the paid " +
            "model, the same as everything else in the conversation.",
        limit: "This is about a profile of YOU, not about the words of your " +
               "conversation — those are sent either way, because they are the " +
               "question. Everything it has learned is readable and deletable " +
               "under Tailoring.",
        destinationAware: true,
        risk: "high"
    },
    {
        key: "writeMode",
        title: "File changes",
        choices: [
            { value: null, label: "follow the app default" },
            { value: "notify", label: "make the change, then tell me" },
            { value: "confirm", label: "ask me before every change" }
        ],
        risk: "medium"
    },
    {
        key: "agentMode",
        title: "Run multi-step agent plans on this API model",
        off: "This model answers in one turn. It can still call tools, but it " +
             "is not broken into a plan of focused sub-turns with a critic " +
             "checking each step.",
        on: "A multi-step goal is broken into a plan, each step run as a focused " +
            "sub-turn, and a critic verifies each before moving on. Costs more " +
            "API calls. Local and your own node do this automatically; this is " +
            "the opt-in for a paid API.",
        // only meaningful for an API driver — local and node always run the
        // orchestrator when the goal warrants it
        apiOnly: true,
        risk: "medium"
    }
]);

/** The effective permissions for a session: its overrides over the defaults. */
function forSession(session) {
    const p = (session && session.perms) || {};
    return {
        secrets: p.secrets === true,
        autoRun: p.autoRun === true,
        requireIsolation: p.requireIsolation === true,
        tailoring: p.tailoring === true,
        writeMode: p.writeMode === "notify" || p.writeMode === "confirm"
            ? p.writeMode : null,
        // tri-state on purpose: null is "follow the app default", and is a
        // different answer from an explicit false
        selfReview: p.selfReview === true ? true : p.selfReview === false ? false : null,
        // ON BY DEFAULT: an UNSET session inherits DEFAULTS.agentMode; only
        // an explicit stored false turns it off. Hard-coding `=== true` made the
        // default flip inert — every session read false regardless of DEFAULTS.
        agentMode: p.agentMode === undefined ? DEFAULTS.agentMode : p.agentMode === true,
        // ON BY DEFAULT, same inherit rule: a conversation asks before it sends
        // anything out unless THIS conversation was told otherwise. There is no
        // app-wide counterpart to fall back to any more.
        askRemote: p.askRemote === undefined ? DEFAULTS.askRemote : p.askRemote === true
    };
}

/**
 * IS THE REVIEW PANEL ON FOR THIS TURN?
 *
 * Inherit-unless-set, resolved in one place so no caller has to remember the
 * precedence: the session decides if it said anything, otherwise the app
 * setting, which is off until somebody turns it on.
 */
function selfReviewOn(session, appDefault) {
    // CHECKING ITS WORK IS PART OF ANCIENT KNOWLEDGE, not a separate dial.
    // Checking its own work should just be part of Ancient Knowledge when that
    // is enabled — not even a separately exposed setting. The stored perm still
    // works for sessions that set it before the fold; AK simply wins.
    if (session && session.ancientKnowledge === true) return true;
    const p = forSession(session);
    if (p.selfReview === true) return true;
    if (p.selfReview === false) return false;
    return appDefault === true;
}

/**
 * Apply one change, validated. Returns the new perms object to store.
 * Anything not in the catalog is dropped rather than persisted — a typo must
 * not become a permission nobody can find later.
 */
function set(session, key, value) {
    const cur = forSession(session);
    if (key === "writeMode") {
        cur.writeMode = value === "notify" || value === "confirm" ? value : null;
    } else if (key === "selfReview") {
        cur.selfReview = value === true ? true : value === false ? false : null;
    } else if (key === "secrets" || key === "autoRun" || key === "requireIsolation"
               || key === "tailoring" || key === "agentMode" || key === "askRemote") {
        cur[key] = value === true;
    } else {
        return { error: `unknown permission: ${String(key).slice(0, 40)}` };
    }
    return { ok: true, perms: cur };
}

/** True when this session departs from the strict defaults in any way. */
function anyGranted(session) {
    const p = forSession(session);
    return p.secrets || p.autoRun || p.tailoring;
}

module.exports = { DEFAULTS, CATALOG, forSession, set, anyGranted, selfReviewOn };
