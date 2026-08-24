const engine = require("./engine");
const cloudModels = require("./cloudModels");
const tokenCost = require("./tokenCost");
const paths = require("./paths");

/**
 * WHERE THE TOKENS COME FROM — and nothing else.
 *
 * The agent loop is the product. It builds the system prompt, injects retrieved
 * knowledge, parses tool calls, rescues malformed ones, gates every call through
 * the policy kernel, dispatches, records changes, and decides whether to go
 * round again. None of that has anything to do with WHICH model produced the
 * text it is parsing.
 *
 * So this file is the one seam. It exposes exactly the signature the loop
 * already called — generate(messages, maxTokens, cancelToken, onToken) — and
 * routes to the local engine or the linked remote model. The loop does not
 * change and does not know.
 *
 * That is what makes a remote model useful rather than a novelty. R1 reasons;
 * .lcl reads the files, searches the workspace, runs ERC, OCRs the drawing,
 * checks the policy, and takes the approvals. The model never touches the disk.
 * It sees only what the engine decided to put in the prompt, and the engine
 * decides what happens with what comes back.
 *
 * -------------------------------------------------------------------------
 * ONE RULE THAT MATTERS MORE THAN THE ROUTING:
 *
 * A reasoning model's chain of thought is NOT its answer, and must never be
 * parsed for tool calls.
 *
 * R1 thinks out loud before answering. That thinking routinely contains phrases
 * like "I should call read_file on config.json" — the model talking to itself
 * about what it MIGHT do. If the loop parsed that, the model would trigger
 * actions merely by considering them, and a policy gate would be asked to
 * approve something nobody decided to do.
 *
 * So reasoning is captured, reported to the UI, and thrown away before parsing.
 * Only the answer is executable.
 * -------------------------------------------------------------------------
 */

/** Is a remote model currently driving?
 *
 *  With no argument this answers for the GLOBAL default, exactly as it always
 *  has. Handed a resolved per-session selection (an endpoint object, or null
 *  meaning "the local engine"), it answers for THAT session — the app-wide
 *  answer is meaningless once two sessions can drive two different models. */
function usingRemote(sel) {
    if (sel !== undefined) return !!sel;
    try { return cloudModels.available() && !!cloudModels.selected(); }
    catch { return false; }
}

/**
 * WHICH MODEL DRIVES THIS SESSION — the one resolution the whole turn shares.
 *
 * The session's stored choice (inherit-unless-set, see cloudModels.
 * resolveSelection) becomes a concrete routing decision here, ONCE, at the
 * top of a turn — and is then passed to generate/limits/activeModel rather
 * than each of them re-reading global state. Resolving per call was the bug
 * this replaces: the choice was stored and never read anywhere.
 */
function resolveSelection(session) {
    try {
        const r = cloudModels.resolveSelection(session);
        return { ...r, remote: !!r.sel,
                 // WHERE THIS TURN GOES IF THE ANSWERER FAILS. Resolved here,
                 // where the session record is in hand, so a caller can hand it
                 // straight back to generate() as opts.fallback and get the
                 // per-session allowlist honoured exactly.
                 fallback: resolveFallback({ escalateTo: session && session.escalateTo },
                                           r.sel) };
    } catch {
        return { sel: null, source: "default", remote: false, fallback: null };
    }
}

/* ===================================================================
 * THE API FALLBACK THAT DID NOT FALL BACK
 *
 *   "With Gemini Flash set as fallback, the failure went back to the local
 *    model instead, and answered with a memory complaint."
 *
 * Reproduced. There was no fallback ANYWHERE in the routing: generate() called
 * one backend, and whatever that backend said — including "I cannot fit this
 * model in memory" — was returned to the agent loop as the turn's outcome. The
 * "API fallback" panel wrote two settings (a global switch, a per-session list
 * of models this conversation may pay for) and nothing in the router, the
 * agent or cloudModels ever read either of them for routing. They gated a
 * TOOL the model could choose to call, which is a different feature that
 * happens to share a name.
 *
 * So this is the reader. Three gates, and all three have to agree:
 *
 *   1. THE USER SAID SO. settings.allowEscalation is the switch behind the
 *      panel's "on" option. Off means a failure is a failure, as before.
 *   2. THIS CONVERSATION SAID SO — ALWAYS, NOT "WHEN THE CALLER PASSES ITS
 *      LIST". The first version of this gate applied only when a list arrived,
 *      and treated an empty list as no opinion. Measured on the user's own
 *      machine: session 77341f22 had escalateTo: [] — the panel open, every
 *      box unticked, which IS the operator saying "this conversation pays for
 *      nothing" — and eight mistral turns he approved as $0 node calls were
 *      silently rerouted to a paid API anyway, $0.38 billed, each reply
 *      relabeled as the model he picked. "api fallback is not turned on."
 *      It was not. The reroute fired regardless.
 *
 *      So: no list, or an empty list, means NO FALLBACK. A target not on the
 *      list is never chosen. The visible panel is the switch, exactly as it
 *      claims to be — the global setting alone can arm nothing.
 *   3. IT IS NOT THE THING THAT JUST FAILED, and it is not a machine K4 has
 *      already recorded as unreachable.
 *
 * A fallback that fires is REPORTED, never silent: the result carries
 * fellBackFrom and fallbackReason, it carries the usage and cost of the model
 * that actually answered, and the ledger row the agent writes therefore names
 * the endpoint that was really billed. And when the caller passes approveRemote,
 * the destination is put to the operator BEFORE a token moves — a consent given
 * for "$0, your own Spark" is not a consent for anything else.
 * ================================================================= */

/** The global switch the "API fallback" panel writes. */
function fallbackAllowed() {
    try { return paths.readSettings().allowEscalation === true; }
    catch { return false; }
}

/** {endpointId, model} or a full selection, resolved to something callable. */
function normaliseTarget(t) {
    if (!t || typeof t !== "object") return null;
    if (t.baseUrl && t.model) return t;
    if (t.endpointId && t.model) {
        try {
            const ep = cloudModels.endpoints().find(e => e.id === t.endpointId);
            if (ep) return { ...ep, model: String(t.model), role: "driver" };
        } catch { /* unresolvable */ }
    }
    return null;
}

function sameTarget(a, b) {
    return !!(a && b && a.id === b.id && a.model === b.model);
}

/**
 * Where a failed turn goes next, or null for "nowhere, report the failure".
 *
 * @param opts.fallback     an explicit target — wins outright, and naming one
 *                          that cannot be resolved returns null rather than
 *                          quietly substituting something else
 * @param opts.escalateTo   this conversation's allowlist of model ids
 * @param opts.preferred    the session plan's pick for this kind of work
 *                          ({endpointId, model}) — tried before the global
 *                          roles, still gated by the allowlist
 * @param failed            the selection that just failed (null = the local
 *                          engine), never chosen as its own fallback
 */
function resolveFallback(opts = {}, failed = null) {
    const explicit = normaliseTarget(opts.fallback);
    if (explicit) return sameTarget(explicit, failed) ? null : explicit;
    if (opts.fallback) return null;          // named, and not resolvable
    if (!fallbackAllowed()) return null;

    // GATE 2, AND IT FAILS CLOSED. The ticked list in the API fallback panel
    // is the whole authority for this conversation: nothing ticked — or the
    // panel never opened — means no model may be paid for on this session's
    // behalf, full stop. `[]` used to read as "no allowlist" here, which
    // inverted the operator's explicit "none of them" into "any of them".
    const list = Array.isArray(opts.escalateTo) ? opts.escalateTo : [];
    const allow = new Set(list.map(String));
    // THE PLAN'S PICK LEADS (§5l): the model this conversation assigned to the
    // kind of work in flight is tried before the global roles. A FREE machine
    // the operator OWNS needs no payment consent — escalateTo is the PAID
    // allowlist, and deriving reachability from it silently excluded every
    // local node: "its supposed to be all the available models period, not
    // just api." Owned-and-free arms on its own; paid still requires the tick.
    const pref = normaliseTarget(opts.preferred);
    if (pref && !sameTarget(pref, failed) && !pref.offline) {
        const free = !!pref.localNode && !pref.rented;
        if (free || allow.has(String(pref.model))) return pref;
    }
    if (!list.length) return null;
    for (const role of ["driver", "reasoner"]) {
        let sel = null;
        try { sel = cloudModels.usableFor(role) ? cloudModels.selectedFor(role) : null; }
        catch { sel = null; }
        if (!sel || sameTarget(sel, failed)) continue;
        if (!allow.has(String(sel.model))) continue;
        // CONTRACT K4: never fall back onto a machine already known to be off.
        if (sel.offline) continue;
        return sel;
    }
    return null;
}

/**
 * HOW BIG A JOB THE MODEL DRIVING THIS TURN CAN ACTUALLY TAKE ON.
 *
 * The agent loop's four constants — steps per turn, output tokens, history
 * depth, tool-result size — were chosen for a 1.5B model on a 15.6 GB laptop,
 * where every one of them is a memory decision. Applied unchanged to a linked
 * frontier model they are not caution, they are a straitjacket: a model with a
 * 1M-token window and no local memory cost was being given 4 tool calls, 1536
 * output tokens and 12 messages of history. That is enough to read a file and
 * comment on it. It is not enough to do a piece of work.
 *
 * So the limits follow the model. Local keeps exactly the numbers it had — they
 * are still correct there, and this machine still has 15.6 GB. Remote is sized
 * from what the endpoint published about the model when it was linked
 * (context_length / max_tokens off /models), and falls back to conservative
 * remote defaults when a host publishes nothing.
 *
 * Nothing here is a policy boundary. Every tool call still goes through the
 * kernel one at a time; more steps means more chances to be asked, not fewer.
 */
const LOCAL_LIMITS = {
    maxSteps: 4,
    maxTokens: 1536,
    historyWindow: 12,
    toolResultCap: 4000
};

// Used when a remote endpoint publishes no metadata about the model.
// Used when a remote endpoint publishes no metadata about the model. 4096 was
// the number that silently truncated every file a frontier model wrote — a
// 14,000-character guillotine mid-JSON, three times in one session, with the
// model apologising for a failure the app caused. A floor is meant to be
// conservative about COST, not to make the product not work; 8k still writes a
// real file, and the cost meter is the honest guard.
const REMOTE_FLOOR = {
    maxSteps: 16,
    maxTokens: 8192,
    historyWindow: 30,
    toolResultCap: 12_000
};

/**
 * A LOCAL NODE IS NOT A PAID API, AND MUST NOT BE BUDGETED LIKE ONE.
 *
 * Every number in REMOTE_FLOOR and in the remote sizing below is ultimately a
 * statement about MONEY. 16 steps rather than 64, 16k output tokens rather than
 * 32k, a quarter of the window for one tool result and a hard 64k cap on top of
 * it — those exist because each extra token is billed to someone, and a runaway
 * loop against a metered endpoint is a bill nobody agreed to.
 *
 * None of that is true of a machine on your own desk. Somebody bought a 128 GB
 * DGX Spark specifically to run a 120B model, and what the app did with it was
 * hand that model the floor meant for a host it knows nothing about: 8k output,
 * 16 tool calls, 30 messages of history, 12,000 characters of tool result. That
 * is not caution, because there is nothing to be cautious ABOUT. Ollama
 * publishes no context metadata through /v1/models, so `ctx` came back 0 and a
 * 120B model with a six-figure window was sized like an unknown paid endpoint.
 *
 * On a node the only real constraint is the node's RAM, and RAM is spent on the
 * KV cache — which is a function of the CONTEXT WINDOW, not of how many tool
 * calls the loop is allowed or how long a reply may be. So the window is what
 * everything here scales from, and the ceilings exist only to stop arithmetic
 * on a nonsense number, never to ration anything.
 *
 * The ceilings that remain, and why each one is where it is:
 *
 *   maxSteps 64       Not a budget — a backstop against a model that has begun
 *                     looping. Every one of those calls still goes through the
 *                     policy kernel individually, so more steps is more chances
 *                     to be asked, not fewer.
 *   maxTokens         A quarter of the window, so output cannot crowd out the
 *                     transcript it has to be consistent with, capped at 32k
 *                     because no current model emits more in one response.
 *   historyWindow     Messages, scaled to the window. This is the number that
 *                     lets a node model actually iterate on a file it wrote
 *                     forty messages ago instead of rediscovering it.
 *   toolResultCap     A quarter of the window converted to CHARACTERS at the
 *                     same 3.6 chars/token the cost estimator uses. The remote
 *                     path caps at ctx/4 characters, which is a fourteenth of
 *                     the window — deliberately mean, because pasting a large
 *                     file into a metered prompt is how you spend money. Here
 *                     it is how you read a file.
 */
const NODE_LIMITS = {
    maxSteps: 64,
    maxTokens: 32_768,
    historyWindow: 200,
    toolResultCap: 400_000
};

// Characters per token, matching tokenCost's estimator. Only used to turn a
// window measured in tokens into a tool-result cap measured in characters.
const CHARS_PER_TOKEN = 3.6;

/**
 * The budget for a model running on the user's own node.
 *
 * @param ctx     the window, published or assumed by cloudModels at link time
 * @param maxOut  what the host said it will emit in one response, if anything
 */
function nodeLimits(ctx, maxOut, sel) {
    // cloudModels credits a local endpoint with an assumed window when the host
    // publishes none, so 0 here means something went wrong upstream rather than
    // "small" — take the SAME assumption it uses rather than falling to a
    // paid-API floor, and read it from there so the two cannot drift apart.
    const window = ctx || cloudModels.LOCAL_ASSUMED_CONTEXT || 32_768;
    // a quarter of the window for the reply, leaving the rest for the prompt it
    // has to stay consistent with
    const outBudget = maxOut || Math.floor(window / 4);
    return {
        kind: "remote",              // the tokens still arrive over the wire
        // WHAT THIS ACTUALLY IS, for anything that has to explain the number.
        // Kept separate from `kind` so every existing "is this remote" branch —
        // the machine-state block, the step-limit notice, the model label —
        // keeps working untouched.
        node: true,
        free: true,                  // no per-token cost; see tokenCost.FREE_RATE
        endpoint: (sel && sel.label) || null,
        contextLength: window,
        basis: `${Math.round(window / 1000)}k context on ${(sel && sel.label) || "your node"}`
             + " — your own hardware, so the only budget is its memory",
        maxSteps: NODE_LIMITS.maxSteps,
        maxTokens: Math.max(4096, Math.min(NODE_LIMITS.maxTokens, outBudget)),
        historyWindow: window >= 200_000 ? NODE_LIMITS.historyWindow
                     : window >= 100_000 ? 120
                     : window >= 60_000 ? 80
                     : 60,
        toolResultCap: Math.max(24_000, Math.min(NODE_LIMITS.toolResultCap,
            Math.floor((window / 4) * CHARS_PER_TOKEN)))
    };
}

// `sessionSel` follows the usingRemote convention: undefined = the global
// default (unchanged behavior), null = the local engine, object = that
// endpoint — so the limits a turn runs under come from the model that will
// actually answer it, not from whatever the app-wide setting happens to be.
// A REASONING MODEL THAT SPENT THE WHOLE BUDGET THINKING is not an absent
// auditor. Measured: AK said "the auditor did not answer" and the panel "3 of
// 4 reviewers could not be reached" while node-calls.jsonl logged ok/chars:0 —
// the model thought its whole small reply budget away and sent no content.
const THINK_FLOOR = 4096;          // room to finish the think AND answer
const thinkBurners = new Set();    // models measured burning a small budget on reasoning

function limits(sessionSel) {
    if (!usingRemote(sessionSel)) return { ...LOCAL_LIMITS, kind: "local" };

    let ctx = 0, maxOut = 0, sel = null, node = false;
    try {
        sel = sessionSel !== undefined ? sessionSel : cloudModels.selected();
        node = cloudModels.isNodeEndpoint(sel);
        const entry = sel && (sel.models || []).find(m => m && m.id === sel.model);
        ctx = (entry && Number(entry.contextLength)) || 0;
        maxOut = (entry && Number(entry.maxTokens)) || 0;
    } catch { /* fall through to the floor */ }

    // Asked BEFORE the no-published-context branch, because a node is exactly
    // the case that publishes nothing and exactly the case the floor is wrong
    // for. Getting this order backwards is the whole bug.
    if (node) return nodeLimits(ctx, maxOut, sel);

    if (!ctx) return { ...REMOTE_FLOOR, kind: "remote", basis: "no published context" };

    // History and tool output are charged against the CONTEXT window; output
    // tokens against whatever the host will emit in one response. A quarter of
    // the window for one tool result leaves room for the transcript, the system
    // prompt and the reply — and is capped, because pasting 200k characters of
    // file into a prompt is a way to spend money, not a way to be useful.
    return {
        kind: "remote",
        basis: `${Math.round(ctx / 1000)}k context published by the endpoint`,
        contextLength: ctx,
        maxSteps: ctx >= 200_000 ? 32 : ctx >= 100_000 ? 24 : 16,
        // OUTPUT headroom must cover the model's THINKING as well — the API
        // bills and caps them together. 8k was exactly the budget GLM-5.2
        // burned entirely inside its chain of thought on a schematic request,
        // delivering an empty answer three times. 16k covers a long think plus
        // a real deliverable; the runaway-bill backstop is the cap itself plus
        // the per-turn cost meter, not a starvation budget.
        maxTokens: Math.max(1536, Math.min(16384, maxOut || 16384)),
        historyWindow: ctx >= 200_000 ? 60 : ctx >= 100_000 ? 40 : 24,
        toolResultCap: Math.max(4000, Math.min(64_000, Math.floor(ctx / 4)))
    };
}

/** What is answering right now, for status lines and audit records.
 *  Same convention: no argument = the global default; a resolved selection =
 *  that session's answerer. */
function activeModel(sessionSel) {
    if (usingRemote(sessionSel)) {
        const s = sessionSel !== undefined ? sessionSel : cloudModels.selected();
        const node = cloudModels.isNodeEndpoint(s);
        return { kind: "remote", id: s.model, label: `${s.model} on ${s.label}`,
                 // "remote" is true of a node and says the wrong thing about it:
                 // the model is on a machine in the room, not at a vendor.
                 node, free: node,
                 endpoint: s.label };
    }
    // engine.status() reports `modelInfo` (the registry entry) and `model`
    // (the path on disk). It has never had modelId/modelName, so this used to
    // fall through to the bare words "local model" for every local model —
    // while the picker two inches away named the exact one. Same source now.
    const st = engine.status();
    const info = st && st.modelInfo;
    const name = info ? `${info.family} ${info.params}`.trim() : null;
    return { kind: "local",
             id: (info && info.id) || null,
             label: name || "local model" };
}

/**
 * Generate. Identical contract to engine.generate, whichever side answers.
 *
 * @param messages     [{role, content}] — already built by the agent
 * @param maxTokens
 * @param cancelToken  {cancelled:boolean}
 * @param onToken      ({tokens, elapsedMs, text}) — streaming progress
 * @param opts.onReasoning  (text) — chain of thought, for display ONLY
 * @returns {{content, error?, usage?, cost?, reasoning?, remote?}}
 */
async function generate(messages, maxTokens = 1536, cancelToken, onToken, opts = {}) {
    // opts.selection carries the SESSION's resolved choice: null routes to the
    // local engine even when a remote default exists; an endpoint object
    // routes to exactly that endpoint. Absent keeps the global behavior, so
    // every caller that never learned about sessions still works.
    const sessionSel = opts.selection;
    const onNote = typeof opts.onNote === "function" ? opts.onNote : () => {};
    const stopped = () => !!(cancelToken && cancelToken.cancelled);

    /** Hand a failed turn to the configured fallback, or report the failure. */
    const fallBack = async (failedSel, failure) => {
        // A turn the OPERATOR stopped is not a turn that failed. Escalating it
        // would spend money on an answer nobody is waiting for.
        if (stopped() || failure.error === "cancelled") return failure;
        const to = resolveFallback(opts, failedSel);
        if (!to) {
            // LAST RESORT: THE FREE LOCAL ENGINE. A remote answerer that failed
            // with no paid fallback left must not drop the turn when THIS
            // machine can answer for nothing — "its supposed to be all the
            // available models period", and the most-available model of all is
            // the one already on the disk. Only from a REMOTE failure (a local
            // failure has nowhere lower to go) and only when a local model
            // exists; local is owned and free, so no approval ceremony, exactly
            // like an owned-node fallback.
            let localModel = null;
            try { localModel = paths.findModel(); } catch { localModel = null; }
            if (!failedSel || !localModel) return failure;
            onNote(`${failedSel.model} on ${failedSel.label} could not answer ` +
                   `(${String(failure.error).slice(0, 120)}) — falling back to this machine`);
            let lmsgs = messages, lreply = maxTokens;
            if (typeof opts.refitFor === "function") {
                // null target = the local window; if it throws, the local
                // engine's own contextFit trims the remote-fitted messages
                try {
                    const r = await opts.refitFor(null);
                    if (r && Array.isArray(r.messages) && r.messages.length) {
                        lmsgs = r.messages; lreply = Number(r.replyTokens) || maxTokens;
                    }
                } catch { /* remote-fitted messages still answer, trimmed by engine */ }
            }
            let lr;
            try { lr = await engine.generate(lmsgs, lreply, cancelToken, onToken); }
            catch (e) { lr = { error: cloudModels.scrub(String((e && e.message) || e)) }; }
            if (!lr || lr.error) {
                return { ...failure, fallbackTried: "this machine",
                         fallbackError: (lr && lr.error) || "the local engine did not answer" };
            }
            return { ...lr, remote: false,
                     fellBackFrom: `${failedSel.model} on ${failedSel.label}`,
                     fallbackReason: String(failure.error).slice(0, 200) };
        }
        // THE DESTINATION IS NAMED BEFORE IT IS USED. A fallback moves the
        // conversation onto a machine the user did not pick for this turn, and
        // usually onto somebody else's — which is the one thing this product
        // exists to make explicit. A caller that passes approveRemote is asked,
        // every time, and the DESTINATION goes with the question so the caller
        // can decide for itself that its own hardware needs no ceremony. A
        // caller that passes nothing gets the global switch as the consent it
        // already is. This is where CONTRACT K3's prompt meets the one routing
        // path that can spend money without anybody clicking anything.
        let dest = null;
        try { dest = cloudModels.destinationOf(to); } catch { /* named below */ }
        if (typeof opts.approveRemote === "function") {
            let ok = false;
            try {
                ok = await opts.approveRemote({ model: to.model, endpoint: to.label,
                                                destination: dest, reason: failure.error,
                                                // the caller's cost estimate needs the real
                                                // endpoint record, not just its name
                                                selection: to,
                                                fellBackFrom: failedSel
                                                    ? `${failedSel.model} on ${failedSel.label}`
                                                    : "the local engine" });
            } catch { ok = false; }
            if (!ok) return { ...failure, fallbackDeclined: true };
        } else if (!dest || dest.owned !== true) {
            // NO HOOK IS A NO, not a yes. "A caller that passes nothing gets
            // the global switch as the consent it already is" was the sentence
            // that authorized eight paid reroutes against approvals that said
            // "$0, your own Spark". A destination the operator does not own is
            // never dialled on an absent hook; only a machine of their own may
            // proceed without the ceremony, because it costs them nothing and
            // holds nothing they have not already trusted it with.
            return { ...failure, fallbackDeclined: true,
                     fallbackNotAsked: `${to.model} on ${to.label}` };
        }
        onNote(`${failedSel ? `${failedSel.model} on ${failedSel.label}` : "the local engine"}` +
               ` could not answer (${String(failure.error).slice(0, 120)}) — ` +
               `falling back to ${to.model} on ${to.label}`);
        // THE SUBSTITUTE GETS ITS OWN PROMPT. Re-sending messages built for the
        // failed model hands the substitute a system prompt claiming it IS that
        // model, fitted to that model's window. The caller rebuilds both for
        // the real target; without the callback, the old messages are still
        // sent, but everything downstream now names the true answerer anyway.
        let msgs2 = messages, reply2 = maxTokens;
        if (typeof opts.refitFor === "function") {
            try {
                const r = await opts.refitFor(to);
                if (r && Array.isArray(r.messages) && r.messages.length) {
                    msgs2 = r.messages;
                    reply2 = Number(r.replyTokens) || maxTokens;
                }
            } catch { /* the old messages still answer */ }
        }
        const second = await runRemote(to, msgs2, reply2, cancelToken, onToken, opts);
        if (second.error) {
            // BOTH ROADS FAILED, AND BOTH REASONS ARE KEPT. Reporting only the
            // second one would hide the reason the turn moved at all.
            return { ...failure, fallbackTried: `${to.model} on ${to.label}`,
                     fallbackError: second.error };
        }
        return { ...second,
                 fellBackFrom: failedSel ? `${failedSel.model} on ${failedSel.label}`
                                         : "the local engine",
                 fallbackReason: String(failure.error).slice(0, 200) };
    };

    if (!usingRemote(sessionSel)) {
        // REASONING EFFORT FOR LOCAL — map the effort level to temperature.
        // Lower effort = higher temp (quick, creative); higher effort = lower
        // temp (focused, reasoning). Works for llama.cpp.
        const EFFORT_TEMP = [0.3, 0.5, 0.3, 0.15, 0.05];
        const effortIdx = (opts.session && typeof opts.session.effortLevel === "number")
            ? opts.session.effortLevel : undefined;
        const effortTemp = effortIdx !== undefined ? EFFORT_TEMP[effortIdx] : undefined;
        let r;
        try {
            // the temperature rides WITH the call now. The old path set a
            // module-level variable (engine.setEffortTemp) and cleared it
            // here — but engine.generate QUEUES work, so the variable was
            // read at dequeue time and two concurrent sessions at different
            // effort levels clobbered each other's temperature, or one
            // cleared it out from under the other's still-queued turn.
            r = await engine.generate(messages, maxTokens, cancelToken, onToken,
                effortTemp !== undefined ? { temperature: effortTemp } : undefined);
        }
        catch (e) {
            r = { error: cloudModels.scrub(String((e && e.message) || e)) };
        }
        if (!r || !r.error) return r;
        return fallBack(null, r);
    }

    const sel = sessionSel !== undefined ? sessionSel : cloudModels.selected();
    const burnKey = sel ? `${sel.id}::${sel.model}` : "";
    const roof = Math.max(Number((limits(sel) || {}).maxTokens) || 0, maxTokens);
    let ask = thinkBurners.has(burnKey)
        ? Math.min(Math.max(maxTokens, THINK_FLOOR), roof)
        : maxTokens;
    let first = await runRemote(sel, messages, ask, cancelToken, onToken, opts);
    // content empty, reasoning full, stream truncated, no tool call assembled:
    // the budget died inside the think. Retry ONCE with room, and pre-floor
    // every later small ask to this model so the waste is paid once.
    const thoughtItAllAway = !first.error && !String(first.content || "").trim()
        && first.reasoning && first.truncated
        && !(first.toolCalls || []).length;
    if (thoughtItAllAway && !stopped()) {
        thinkBurners.add(burnKey);
        const bigger = Math.min(Math.max(ask * 4, THINK_FLOOR), roof);
        if (bigger > ask) {
            onNote(`${sel.model} spent all ${ask} reply tokens on reasoning — retrying once with ${bigger}`);
            const second = await runRemote(sel, messages, bigger, cancelToken, onToken, opts);
            if (!second.error) first = second;
        }
    }
    if (!first.error) return first;
    return fallBack(sel, first);
}

/** One attempt against one remote selection. Same contract as generate(). */
async function runRemote(sel, messages, maxTokens, cancelToken, onToken, opts = {}) {
    const onReasoning = typeof opts.onReasoning === "function" ? opts.onReasoning : () => {};
    const startedAt = Date.now();
    let answer = "";
    let reasoning = "";
    let tokens = 0;

    try {
        const r = await cloudModels.streamChat(messages, {
            maxTokens,
            // THE WINDOW WE PLANNED AGAINST, HANDED TO THE SERVING. Ollama
            // picks its own num_ctx (4,096 by default) unless told, so every
            // prompt sized to a 163k model window was being cut to a fraction
            // of itself on arrival, silently.
            numCtx: (limits(sel) || {}).contextLength || 0,
            // THE TOOLS, IN THE PROTOCOL THE MODEL WAS TRAINED ON. Passed
            // straight through; cloudModels decides whether this serving takes
            // them and falls back to the text protocol if it refuses.
            tools: opts.tools || undefined,
            // the session's endpoint, not the global one — see above
            selection: sel,
            // the session record, so streamChatOnce can read effortLevel
            // and send reasoning_effort in the request body
            session: opts.session,
            // the SESSION's decision about credentials, carried verbatim.
            // Absent means off: a permission is never inferred.
            allowSecrets: opts.allowSecrets === true,
            cancelToken: cancelToken || { cancelled: false },
            // REASONING EFFORT FOR NODES. An Ollama-style node rejects the
            // reasoning_effort field (cloudModels skips it), so on a node the
            // slider maps to sampling temperature — the same curve the local
            // engine uses. Before this, the comment in cloudModels CLAIMED
            // that mapping existed and nothing implemented it: the slider was
            // a silent no-op on every node turn. API/rented endpoints keep
            // reasoning_effort and the 0.2 default here.
            temperature: (() => {
                if (opts.temperature !== undefined) return opts.temperature;
                if (cloudModels.isNodeEndpoint(sel)
                    && opts.session && typeof opts.session.effortLevel === "number") {
                    const NODE_EFFORT_TEMP = [0.2, 0.5, 0.3, 0.15, 0.05];
                    const t = NODE_EFFORT_TEMP[opts.session.effortLevel];
                    if (t !== undefined) return t;
                }
                return 0.2;
            })(),
            // THE WAIT IS PART OF THE ANSWER. nodePreflight can spend a minute
            // watching a resident model leave memory before it lets the next
            // one load, and a minute of nothing is exactly what the operator
            // reported as "it just sat there". This carries the running
            // commentary out to whoever is watching the turn.
            onNote: typeof opts.onNote === "function" ? opts.onNote : undefined,
            // The ANSWER stream — this is what gets parsed for tool calls.
            onOutput: (t) => {
                answer += t;
                tokens += Math.max(1, Math.round(t.length / 3.6));
                if (onToken) {
                    onToken({ tokens, elapsedMs: Date.now() - startedAt, text: answer });
                }
            },
            // The THINKING stream — shown, never parsed. See the note above.
            onReasoning: (t) => { reasoning += t; onReasoning(t); },
            // A stream that began mid-thought: text already handed over as
            // answer turns out to have been reasoning. Take it back out before
            // the loop can parse it as a tool call.
            onReclassify: (t) => {
                if (answer.endsWith(t)) answer = answer.slice(0, answer.length - t.length);
                reasoning = t + reasoning;
                onReasoning(t);
            }
        });

        if (r.stopped) return { error: "cancelled" };
        return {
            redacted: !!r.redacted,
            content: r.output,
            // NATIVE TOOL CALLS, when the serving speaks them — the loop
            // prefers these over parsing prose, because a structured call
            // cannot be confused with a model narrating its intentions.
            toolCalls: Array.isArray(r.toolCalls) && r.toolCalls.length
                ? r.toolCalls : null,
            reasoning: r.reasoning || reasoning,
            usage: r.usage || null,
            cost: r.cost || null,
            // THE ANSWER WAS CUT, AND THE TURN HAS TO KNOW. The local engine
            // has always reported this; the hosted path did not, so a reply
            // stopped at the token cap arrived looking finished — and the
            // agent's "(response was cut off at the length limit)" note, which
            // exists for exactly this, could never fire on an API model.
            truncated: !!r.truncated,
            finishReason: r.finishReason || null,
            remote: true,
            // remote, but on the user's own machine — carried so the ledger row
            // can say why its $0 is a certainty rather than a missing rate
            localNode: !!r.localNode,
            model: sel.model,
            endpoint: sel.label
        };
    } catch (err) {
        // A mid-stream failure that produced usable text is not a dead turn:
        // hand back what arrived so the loop can act on it, the same way
        // askCloudModel resumes rather than discarding.
        if (err.midStream && err.partial) {
            return { content: err.partial, reasoning, remote: true,
                     partial: true, model: sel.model, endpoint: sel.label };
        }
        return { error: cloudModels.scrub(String(err.message || err)) };
    }
}

/**
 * What a turn is about to cost, before it runs. Null for a local model, which
 * costs nothing per token — and a priced $0 for a node, which also costs nothing
 * per token but is a REMOTE model doing it, so the token counts are still worth
 * showing. "Free" and "not applicable" are different answers.
 */
function estimateTurnCost(messages, sessionSel) {
    if (!usingRemote(sessionSel)) return null;
    const sel = sessionSel !== undefined ? sessionSel : cloudModels.selected();
    const chars = messages.reduce((n, m) => n + String((m && m.content) || "").length, 0);
    return tokenCost.estimateCost("", sel.model, {
        contextTokens: tokenCost.estimateTokens("x".repeat(chars), sel.model),
        localNode: cloudModels.isNodeEndpoint(sel)
    });
}

module.exports = { generate, usingRemote, activeModel, estimateTurnCost,
                   resolveSelection,
                   // exported so a caller holding the session record can resolve
                   // the exact per-session target and hand it back as
                   // opts.fallback — and so a suite can read the decision
                   // instead of inferring it from an answer
                   resolveFallback, fallbackAllowed,
                   limits, LOCAL_LIMITS, REMOTE_FLOOR, NODE_LIMITS };
