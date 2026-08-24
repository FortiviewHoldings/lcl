const path = require("path");
const paths = require("./paths");
const { resolveInRoot } = require("./fsTools");
const engagements = require("./engagements");
const sessionPerms = require("./sessionPerms");
const { PolicyKernel, DECISION } = require("../policy/kernel");
const { WORKSPACE_GRANTS, BASE_GRANTS } = require("../policy/classify");
const { AuditLog } = require("../policy/audit");

/**
 * Binds the orchestrator's policy kernel to the app's sessions.
 *
 * One kernel per session, because grants are per-session by design: linking a
 * folder must not leak capability to any other conversation. Kernels are built
 * from persisted session state so they survive a restart without the grant
 * ever being inferred from something a model could write.
 */

const audit = new AuditLog(path.join(paths.dataDir(), "audit"));
const kernels = new Map();

// the virtual prefix runTool re-roots into the per-session staging area
// (dataDir/attachments/<id>) — read-only; agent.js holds the same pair
const ATT_PREFIX = "@attachments/";
// mirrors agent.js exactly — media_transform/transcribe_audio joined for the
// scanned-PDF case: converting a staged attachment IN ITS OWN staging dir is
// reading it, not writing the user's files (kernel scope carve-out at
// kernel.js applies only within the session's attachments dir)
const ATT_READ_TOOLS = new Set(["read_file", "read_image", "read_image_text", "read_pdf",
                                "extract_pdf", "media_transform", "transcribe_audio"]);

function settings() {
    const s = paths.readSettings();
    return {
        writeMode: s.writeMode === "confirm" ? "confirm" : "notify",
        toolPolicy: (s.toolPolicy && typeof s.toolPolicy === "object") ? s.toolPolicy : {}
    };
}

/**
 * The user changed a dial. Kernels are cached per session, so a policy change
 * must reach the LIVE kernels too, not only the next session's.
 */
function applyToolPolicy(toolPolicy) {
    for (const kernel of kernels.values()) {
        kernel.toolPolicy = (toolPolicy && typeof toolPolicy === "object") ? toolPolicy : {};
    }
}

/**
 * The same rule for the write dial, which did NOT have it.
 *
 * A kernel reads writeMode once, in its constructor, and kernels are cached
 * per session — so switching "ask before every change" to confirm wrote the
 * setting to disk and left every OPEN session running on the old, looser
 * value until the app restarted. A security control that appears to engage
 * and does not is worse than one that is plainly absent.
 */
function applyWriteMode(mode) {
    const decision = mode === "confirm" ? DECISION.CONFIRM : DECISION.NOTIFY;
    for (const kernel of kernels.values()) kernel.writeMode = decision;
    return mode === "confirm" ? "confirm" : "notify";
}

/**
 * "Do not ask me every time" for the linked remote model.
 *
 * This deliberately adds NO new mechanism. The kernel already has toolPolicy —
 * per-tool overrides set by the user, clamped by floorFor() so tightening is
 * always legal and loosening stops at the floor. floorFor(EGRESS) is ALLOW, so
 * dropping this one tool to NOTIFY is already within what the user is permitted
 * to decide; EXECUTE and OFFENSIVE remain welded at CONFIRM and no setting
 * anywhere can move them.
 *
 * A first attempt at this invented a second `overrides` map on the kernel, which
 * the kernel does not read — it would have silently done nothing while the UI
 * reported success. One mechanism, or none.
 *
 * What does NOT change when this is on:
 *   - the cost meter still states the input cost BEFORE the message is sent
 *   - every call is still written to the append-only audit log
 *   - secretGuard still inspects the whole request body and refuses to let a
 *     credential from the user's files leave, approved or not
 *   - the network switch still gates the capability entirely
 *
 * And it applies to ask_cloud_model ALONE. Every other EGRESS tool keeps its
 * confirmation, because the user opted into paying for one named endpoint, not
 * into unattended networking.
 */
function applyCloudAutoApprove(on) {
    const settings = paths.readSettings();
    const next = { ...(settings.toolPolicy || {}) };
    if (on) next.ask_cloud_model = "notify";
    else delete next.ask_cloud_model;
    paths.writeSettings({ toolPolicy: next });
    applyToolPolicy(next);
    return !!on;
}


/**
 * Two capabilities are DYNAMIC — they turn on and off during a session, so
 * they cannot be baked into the cached kernel at build time:
 *   - sec.offensive: granted only while at least one engagement is live. Scope
 *     is truthy ("engagement") so the kernel routes offensive actions to
 *     CONFIRM (human approval) instead of DENY; the tool itself still checks
 *     the specific target against a live engagement.
 *   - net.read: granted only when the user has turned networking on. The
 *     product is offline by default, so this stays off unless explicitly set.
 * Refreshed on every check so creating/revoking an engagement or toggling the
 * network takes effect immediately.
 */
function refreshDynamicGrants(kernel) {
    // only touch a grant when its desired state actually CHANGED — this runs on
    // every policy check, and an unconditional revoke wrote a no-op "revoke"
    // audit record each time, burying real grant/revoke events (review finding).
    const wantOffensive = engagements.anyActive();
    const hasOffensive = !!kernel.findGrant("sec.offensive");
    if (wantOffensive && !hasOffensive) {
        kernel.grant({ capability: "sec.offensive", scope: "engagement", note: "live engagement active" });
    } else if (!wantOffensive && hasOffensive) {
        kernel.revoke("sec.offensive");
    }

    const wantNet = paths.readSettings().networkEnabled === true;
    const hasNet = !!kernel.findGrant("net.read");
    if (wantNet && !hasNet) {
        kernel.grant({ capability: "net.read", scope: null, note: "networking enabled in settings" });
    } else if (!wantNet && hasNet) {
        kernel.revoke("net.read");
    }
}

/**
 * Kernel for a session, rebuilt from its stored grants.
 * A workspace path in the session is the ONLY thing that mints fs grants.
 */
function forSession(session) {
    // THE SESSION'S OWN WRITE MODE, WHEN IT HAS ONE.
    //
    // The cache key has to include it: without that, changing the control
    // would hand back the kernel built under the old setting and the change
    // would appear to do nothing until a restart. null means follow the
    // global default, so a session that never overrode still moves when the
    // app-wide setting does.
    const wantWrite = sessionPerms.forSession(session).writeMode;
    const existing = kernels.get(session.id);
    if (existing && existing.repoPath === session.repoPath
        && existing.writeMode === wantWrite) return existing.kernel;

    const base = settings();
    const kernel = new PolicyKernel({
        audit: r => audit.write(r),
        settings: wantWrite ? { ...base, writeMode: wantWrite } : base
    });

    if (session.repoPath) {
        for (const capability of WORKSPACE_GRANTS) {
            kernel.grant({
                capability,
                scope: session.repoPath,
                note: `workspace linked to session ${session.id}`
            });
        }
    }

    // Always available. sys.read is a read-only machine view with no
    // process-control tool behind it; sys.execute only permits PROPOSING a
    // script, which the user must then read and approve separately.
    for (const capability of BASE_GRANTS) {
        kernel.grant({ capability, scope: null, note: "base session capability" });
    }

    /* ATTACHMENTS ARE READABLE WITHOUT A FOLDER.
     *
     * The live failure this closes: "can you extract the text from this pdf",
     * attached to a session with no linked folder — answered with "I don't
     * have a PDF reader in this session". read_pdf was fine; these grants did
     * not exist, so the kernel had no fs.read to honour and the offer-side
     * sweep (agent.js) had already hidden the tool to match.
     *
     * The scope is the session's OWN staging dir (dataDir/attachments/<id>):
     * app-owned, reached only through the @attachments/ prefix, holding
     * exactly the files the operator handed this conversation. A grant scoped
     * there opens nothing else — the linked folder stays the only door to the
     * rest of the disk. fs.write/media.* are included because converting an
     * attachment in place (OCR a scan, transcribe a voice note, transcode a
     * clip) writes its output BESIDE the attachment, inside the same dir; the
     * bridge only ever sets attachScope for the read-only tool set, and a
     * plain-path write in a no-folder session resolves outside this scope and
     * is refused. Granted AFTER the workspace loop so a linked session's
     * first-found grant is still the workspace one, exactly as before. */
    {
        const attachRoot = path.join(paths.dataDir(), "attachments", String(session.id));
        for (const capability of ["fs.read", "fs.write", "media.read", "media.write"]) {
            kernel.grant({ capability, scope: attachRoot,
                           note: "session attachment staging" });
        }
    }

    kernels.set(session.id, { kernel, repoPath: session.repoPath, writeMode: wantWrite });
    return kernel;
}

function drop(sessionId) {
    kernels.delete(sessionId);
}

/**
 * Gate a tool call. Resolves the target path first so the kernel can enforce
 * scope against the REAL location, defeating junction/symlink redirection.
 */
function check(session, tool, args, ctx = {}) {
    const kernel = forSession(session);
    refreshDynamicGrants(kernel);

    // THE SESSION'S OWN per-tool grants must reach the kernel on EVERY call.
    // "allow flash_device for this conversation" is stored on session.toolPolicy,
    // but forSession builds the kernel from GLOBAL settings.toolPolicy and caches
    // it, so without this a granted tool kept drawing its approval card every turn
    // while the grant sat unread. Rebuilt fresh each call (global base + session
    // override) so a grant OR a takeback both land immediately, cache or no cache.
    {
        const globalTP = (paths.readSettings().toolPolicy) || {};
        const sessTP = (session && session.toolPolicy && typeof session.toolPolicy === "object")
            ? session.toolPolicy : {};
        kernel.toolPolicy = { ...globalTP, ...sessTP };
    }

    // EVERY path-shaped argument goes through scope resolution — move_file
    // carries from/to instead of path, and review confirmed both ends were
    // sailing past the kernel unchecked (and unaudited). An escaping path is
    // resolved raw so the kernel's scope test can deny it.
    let resolvedPath = null;
    let attachScope = null;
    if (session.repoPath && args) {
        // input/output cover the media tools — the move_file from/to gap,
        // reintroduced under new names, caught by the same review pattern.
        // out/database/csv/inputs are the SAME gap opened a third time by the
        // tools added since (edit_pdf, edit_image, draw_diagram, query_data):
        // each names its target with a different key, and a key the kernel does
        // not know about is a path it never scope-checks and never audits.
        const PATH_KEYS = ["path", "from", "to", "input", "output",
                           "out", "database", "csv", "inputs"];
        for (const key of PATH_KEYS) {
            // csv/inputs are arrays of paths; check every element
            if (Array.isArray(args[key])) {
                for (const item of args[key]) {
                    const p = typeof item === "string" ? item
                        : (item && typeof item.path === "string" ? item.path : null);
                    if (!p) continue;
                    let cand;
                    try { cand = resolveInRoot(session.repoPath, p); }
                    catch { cand = path.resolve(session.repoPath, p); }
                    if (!resolvedPath) resolvedPath = cand;
                    const r = path.resolve(session.repoPath);
                    if (cand !== r && !cand.startsWith(r + path.sep)) { resolvedPath = cand; break; }
                }
                continue;
            }
            if (typeof args[key] !== "string") continue;
            let candidate;
            if (args[key].startsWith(ATT_PREFIX)) {
                // resolve where the read actually lands — the staging dir — so
                // the audit row never records a fictional <repo>/@attachments/…
                // Only the read-only tools get the scope carve-out below;
                // anything else lands outside the workspace grant and is denied.
                const attachRoot = path.join(paths.dataDir(), "attachments", String(session.id));
                const rest = args[key].slice(ATT_PREFIX.length);
                try { candidate = resolveInRoot(attachRoot, rest); }
                catch { candidate = path.resolve(attachRoot, rest); }
                if (ATT_READ_TOOLS.has(tool)) attachScope = attachRoot;
            } else {
                try {
                    candidate = resolveInRoot(session.repoPath, args[key]);
                } catch {
                    candidate = path.resolve(session.repoPath, args[key]);
                }
            }
            // the first ESCAPING path wins the slot: the kernel must see the
            // violation, not a compliant sibling argument
            if (!resolvedPath) resolvedPath = candidate;
            const root = path.resolve(session.repoPath);
            if (candidate !== root && !candidate.startsWith(root + path.sep)) {
                resolvedPath = candidate;
                break;
            }
        }
    } else if (args) {
        // NO WORKSPACE, BUT ATTACHMENTS STILL RESOLVE. This whole block used to
        // be gated on repoPath, so a no-folder session's @attachments read was
        // never given its attach scope and the kernel refused the one thing the
        // operator had just handed over. An @attachments arg resolves into the
        // session's staging dir (attach scope for the read-only set, same rule
        // as above); any OTHER path-shaped arg has no root to live in and is
        // resolved raw, so the scope test refuses it honestly instead of the
        // check being silently skipped.
        for (const key of ["path", "from", "to", "input", "output",
                           "out", "database", "csv", "inputs"]) {
            if (typeof args[key] !== "string") continue;
            if (args[key].startsWith(ATT_PREFIX)) {
                const attachRoot = path.join(paths.dataDir(), "attachments", String(session.id));
                const rest = args[key].slice(ATT_PREFIX.length);
                try { resolvedPath = resolveInRoot(attachRoot, rest); }
                catch { resolvedPath = path.resolve(attachRoot, rest); }
                if (ATT_READ_TOOLS.has(tool)) attachScope = attachRoot;
            } else {
                resolvedPath = path.resolve(String(args[key]));
            }
            break;   // the first path-shaped argument decides the slot
        }
    }

    return kernel.check(tool, args, {
        sessionId: session.id,
        resolvedPath,
        attachScope,
        ...ctx
    });
}

/** Capabilities live for this session — decides what the model is even told about. */
function capabilities(session) {
    const kernel = forSession(session);
    refreshDynamicGrants(kernel);
    return kernel.liveCapabilities();
}

function resetTurn(session) {
    forSession(session).resetCounters();
}

function tail(limit) {
    return audit.tail(limit);
}

module.exports = {
    applyCloudAutoApprove, forSession, drop, check, capabilities, resetTurn, tail, applyToolPolicy, applyWriteMode, DECISION };
