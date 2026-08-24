const path = require("path");
const { CLASSIFICATION, DECISION, TOOL_CLASS } = require("./classify");

/**
 * Policy kernel — the single gate every tool call passes through.
 *
 * WHY THIS EXISTS IN CODE AND NOT IN A PROMPT
 * -------------------------------------------
 * A 1.5B model will not reliably obey a security policy, and file content the
 * model reads is attacker-controllable — the security audit on this codebase
 * confirmed that injection channel is live. A rule that exists only as text in
 * a system prompt is a suggestion, not a control.
 *
 * So the kernel sits BELOW the engine abstraction. Engines never execute
 * tools; they only emit requests. The kernel decides. That is what makes the
 * rules congruent across every model and every engine — a new runtime cannot
 * bypass them, because executing is not something a runtime can do.
 *
 * DECISIONS
 *   allow    — run it, record it
 *   notify   — run it, record it, tell the user after the fact  (in-scope writes)
 *   confirm  — do not run; hand back to the UI for explicit approval
 *   deny     — refuse, record the attempt
 */

// DECISION now lives in classify.js — a tool spec names one as its default, and
// classify is the leaf of this pair. Re-exported below, so every importer that
// takes it from here is unaffected.

class PolicyError extends Error {
    constructor(message, code) {
        super(message);
        this.name = "PolicyError";
        this.code = code || "denied";
    }
}

/**
 * A capability grant. Created only by an explicit user action (linking a
 * folder, starting an engagement) — never by a model, never by config a model
 * can write to.
 */
class Grant {
    constructor({ capability, scope = null, expiresAt = null, note = "" }) {
        this.capability = capability;      // e.g. "fs.read", "fs.write", "net.scan"
        this.scope = scope;                // absolute path root, or target spec
        this.expiresAt = expiresAt;        // epoch ms, null = session lifetime
        this.note = note;
        this.grantedAt = Date.now();
    }

    get live() {
        return !this.expiresAt || Date.now() < this.expiresAt;
    }
}

class PolicyKernel {
    /**
     * @param {object} opts
     * @param {function} opts.audit   append-only sink: (record) => void
     * @param {object}   opts.settings user preferences (write mode etc.)
     */
    constructor({ audit, settings = {} } = {}) {
        this.grants = [];
        this.audit = typeof audit === "function" ? audit : () => {};
        // Product decision: in-scope writes NOTIFY rather than CONFIRM. Asking
        // permission per file makes the agent unusable for daily driving.
        this.writeMode = settings.writeMode === "confirm" ? DECISION.CONFIRM : DECISION.NOTIFY;
        // Per-tool overrides, set by the USER in the capability panel — never by
        // a model, never by anything a model can write to. Applied after the
        // classification default, bounded by floorFor(): tightening is always
        // legal, loosening stops at the floor.
        this.toolPolicy = (settings.toolPolicy && typeof settings.toolPolicy === "object")
            ? settings.toolPolicy : {};
        this.counters = new Map();
    }

    /**
     * The loosest decision a tool may EVER be set to. The user owns the dial,
     * but two stops are welded in place:
     *  - EXECUTE stays at confirm. The script runner is architecturally split
     *    so the agent can only stage; no preference can make code run without
     *    a human reading it, and the setting must not pretend otherwise.
     *  - OFFENSIVE stays at confirm, and only inside a live engagement. The
     *    engagement gate is what makes it authorised rather than rogue.
     * Everything else is genuinely the user's call: their machine, their dial.
     */
    static floorFor(classification) {
        switch (classification) {
            case CLASSIFICATION.EXECUTE:
            case CLASSIFICATION.OFFENSIVE:
                return DECISION.CONFIRM;
            default:
                return DECISION.ALLOW;
        }
    }

    /** Clamp a user override to the floor. Order, loosest to strictest:
     *  allow < notify < confirm < deny. */
    static clampToFloor(wanted, floor) {
        const rank = { allow: 0, notify: 1, confirm: 2, deny: 3 };
        if (!(wanted in rank)) return null;
        return rank[wanted] < rank[floor] ? floor : wanted;
    }

    grant(spec) {
        const g = new Grant(spec);
        this.grants.push(g);
        this.audit({
            kind: "grant",
            capability: g.capability,
            scope: g.scope,
            at: g.grantedAt,
            note: g.note
        });
        return g;
    }

    revoke(capability, scope = null) {
        const before = this.grants.length;
        this.grants = this.grants.filter(g =>
            !(g.capability === capability && (scope === null || g.scope === scope)));
        this.audit({ kind: "revoke", capability, scope, at: Date.now() });
        return before - this.grants.length;
    }

    /** Capabilities currently live. Drives what the model is even TOLD about. */
    liveCapabilities() {
        return [...new Set(this.grants.filter(g => g.live).map(g => g.capability))];
    }

    findGrant(capability) {
        return this.grants.find(g => g.capability === capability && g.live) || null;
    }

    /**
     * Is `target` inside `root`? Uses resolved paths so a junction or symlink
     * cannot redirect out — the same escape the audit caught in search_files.
     */
    static withinScope(root, target) {
        if (!root || !target) return false;
        const r = path.resolve(root);
        const t = path.resolve(target);
        return t === r || t.startsWith(r + path.sep);
    }

    bump(key, limit) {
        const n = (this.counters.get(key) || 0) + 1;
        this.counters.set(key, n);
        return n <= limit;
    }

    resetCounters() {
        this.counters.clear();
    }

    /**
     * The gate. Returns { decision, reason, capability, classification }.
     * Callers MUST honour it — nothing else is permitted to execute a tool.
     *
     * @param {string} tool        tool name the model asked for
     * @param {object} args        its arguments
     * @param {object} ctx         { sessionId, modelId, engineId, resolvedPath }
     */
    check(tool, args = {}, ctx = {}) {
        const spec = TOOL_CLASS[tool];

        // Deny by default: an unknown tool has no policy, so it has no path to
        // execution. New tools must be classified before they can ever run.
        if (!spec) {
            return this.#record(DECISION.DENY, {
                tool, args, ctx,
                reason: `unknown tool '${tool}' — not in the policy table`,
                classification: CLASSIFICATION.UNKNOWN
            });
        }

        const grant = this.findGrant(spec.capability);
        if (!grant) {
            return this.#record(DECISION.DENY, {
                tool, args, ctx,
                capability: spec.capability,
                classification: spec.classification,
                reason: `capability '${spec.capability}' is not granted for this session`
            });
        }

        // Scoped capabilities must stay inside the grant. One carve-out: a
        // target the app itself resolved into its per-session attachment
        // staging area (ctx.attachScope — derived from dataDir + session id
        // by the policy bridge, never from anything a model writes) is in
        // scope there. The bridge sets it for the four read-only tools
        // alone, so a write aimed at the staging dir still lands here.
        if (grant.scope && ctx.resolvedPath &&
            !PolicyKernel.withinScope(grant.scope, ctx.resolvedPath) &&
            !(ctx.attachScope && PolicyKernel.withinScope(ctx.attachScope, ctx.resolvedPath))) {
            return this.#record(DECISION.DENY, {
                tool, args, ctx,
                capability: spec.capability,
                classification: spec.classification,
                reason: `path leaves the granted scope (${grant.scope})`
            });
        }

        // Blast radius: a runaway loop should hit a wall, not the disk.
        if (spec.limitPerTurn && !this.bump(`${ctx.turnId || "turn"}:${tool}`, spec.limitPerTurn)) {
            return this.#record(DECISION.DENY, {
                tool, args, ctx,
                capability: spec.capability,
                classification: spec.classification,
                reason: `exceeded ${spec.limitPerTurn} ${tool} calls in one turn`
            });
        }

        let decision;
        switch (spec.classification) {
            case CLASSIFICATION.READ:
                decision = DECISION.ALLOW;
                break;
            case CLASSIFICATION.MUTATE:
                decision = this.writeMode;            // notify by default
                break;
            case CLASSIFICATION.DESTRUCTIVE:
                decision = DECISION.CONFIRM;          // always ask
                break;
            case CLASSIFICATION.OFFENSIVE:
                // Only inside a live, scoped engagement. No engagement, no path.
                decision = grant.scope ? DECISION.CONFIRM : DECISION.DENY;
                break;
            case CLASSIFICATION.EXECUTE:
                // Unconditional. There is no setting, grant or trust level that
                // makes a shell script run without the human reading it first.
                decision = DECISION.CONFIRM;
                break;
            case CLASSIFICATION.EGRESS:
                // Leaving the machine always shows the destination first.
                decision = DECISION.CONFIRM;
                break;
            default:
                decision = DECISION.DENY;
        }

        // A TOOL MAY STATE A CONSIDERED DEFAULT WITHIN ITS CLASSIFICATION.
        //
        // Clamped by the same floor a user override is clamped by, and applied
        // only where the classification did not already produce DENY — so this
        // can move a default around inside what the classification permits and
        // can never escape it. An EXECUTE tool declaring itself "allow" still
        // comes out CONFIRM; an OFFENSIVE tool with no engagement stays DENY.
        //
        // The one tool that uses it is web_search: the query is the smallest
        // egress this app performs, its destination is fixed rather than
        // model-chosen, and turning networking on was already an explicit
        // confirmed act. Gating every search behind a second approval made the
        // product's headline feature read as broken. See classify.js.
        if (spec.defaultDecision && decision !== DECISION.DENY) {
            const clamped = PolicyKernel.clampToFloor(
                String(spec.defaultDecision), PolicyKernel.floorFor(spec.classification));
            if (clamped) decision = clamped;
        }

        // USER OVERRIDE, clamped to the classification's floor. An override
        // never bypasses the grant checks above — a tool without its capability
        // was already denied before this line. And OFFENSIVE keeps its
        // engagement requirement: no engagement was DENY above, and stays DENY.
        const wanted = this.toolPolicy[tool];
        if (wanted && decision !== DECISION.DENY) {
            // a tool may declare a lower floor for a PER-SESSION grant than its
            // classification's default — see sessionFloor in classify.js. This is
            // how a trusted device tool stops re-asking while run_script cannot.
            const floor = spec.sessionFloor || PolicyKernel.floorFor(spec.classification);
            const clamped = PolicyKernel.clampToFloor(String(wanted), floor);
            // record the override even when the OUTCOME matches the default:
            // "you asked for allow, the confirm floor held" is exactly the
            // line an auditor — or the user, wondering why it still asks —
            // needs to find in the log
            if (clamped && (clamped !== decision || clamped !== wanted)) {
                return this.#record(clamped, {
                    tool, args, ctx,
                    capability: spec.capability,
                    classification: spec.classification,
                    reason: clamped === wanted
                        ? `user preference (${wanted})`
                        : `user preference ${wanted}, held at the ${floor} floor for ${spec.classification}`
                });
            }
        }

        return this.#record(decision, {
            tool, args, ctx,
            capability: spec.capability,
            classification: spec.classification,
            reason: decision === DECISION.ALLOW ? "permitted" : `${spec.classification} action`
        });
    }

    /** Every decision is audited, including the denials. */
    #record(decision, info) {
        const record = {
            kind: "tool-decision",
            at: Date.now(),
            decision,
            tool: info.tool,
            capability: info.capability || null,
            classification: info.classification,
            reason: info.reason,
            sessionId: info.ctx?.sessionId || null,
            // which model and engine asked for this — the congruence trail
            modelId: info.ctx?.modelId || null,
            engineId: info.ctx?.engineId || null,
            path: info.ctx?.resolvedPath || info.args?.path || null
        };
        this.audit(record);
        return {
            decision,
            reason: info.reason,
            capability: info.capability || null,
            classification: info.classification,
            record
        };
    }
}

module.exports = { PolicyKernel, Grant, PolicyError, DECISION };
