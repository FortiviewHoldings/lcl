"use strict";
/* The per-session task→model plan: an instruction the driver follows and
 * Ancient Knowledge reads. Exercised directly against agent.js, not grepped. */
const assert = require("assert");
const Module = require("module");

// agent.js pulls in paths→electron; stub `app` so the module loads headless,
// exactly as the other engine unit suites do.
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "electron") {
        return { app: { isPackaged: false, getPath: () => require("os").tmpdir(),
                        getName: () => "lcl", on: () => {} },
                 safeStorage: { isEncryptionAvailable: () => false } };
    }
    return origLoad.apply(this, arguments);
};

let agent, ak;
try {
    agent = require("../.lcl.engine/core/agent");
    ak = require("../.lcl.engine/core/ancientKnowledge");
} finally { Module._load = origLoad; }

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail !== undefined ? "- " + JSON.stringify(detail).slice(0, 200) : ""); }
}

/* ---- no plan, no block: an empty map costs nothing on a fresh session ---- */
check("no plan → no orchestration block", agent.orchestrationBlock({}) === "");
check("no plan → no digest", agent.orchestrationDigest({}) === "");
check("an empty map is still no block",
    agent.orchestrationBlock({ taskModels: {} }) === "");

/* ---- a plan becomes a standing instruction in the prompt ---- */
const session = { id: "s1", taskModels: {
    drawing: { model: "black-forest-labs/flux-2-pro", endpointLabel: "DeepInfra" },
    reasoning: { model: "claude-opus-5" }
} };
const block = agent.orchestrationBlock(session);
check("the plan names the ASSIGNED model for each kind of work",
    /flux-2-pro/.test(block) && /claude-opus-5/.test(block)
    && /image or drawing work/.test(block) && /hard reasoning/.test(block), block);
check("it is framed as the operator's standing instruction, not a hint",
    /standing instruction/.test(block) && /operator/.test(block));
check("it routes through the advisory tool, never a silent switch — and never " +
      "spends without the usual confirmation",
    /suggest_model/.test(block) && /confirmation/.test(block));
/* EVOLVED: the caps that HAVE an executor are named — reasoning →
 * ask_reasoner, agentic → ask_fleet — because "use whatever handoff tool
 * is available" left the model KNOWING its fleet and unable to reach it (it
 * would report knowing about the tool but being unable to access it). The
 * caveat survives as "where it is offered", and ask_cloud_model stays unnamed:
 * it targets the paid driver and is absent offline. */
check("it does NOT hardcode ask_cloud_model — but it DOES name the per-cap " +
      "executors, with the offered-caveat, because a tool only gestured at " +
      "is a tool never called",
    !/ask_cloud_model/.test(block) && /where it is offered/.test(block)
    && /ask_fleet/.test(block) && /ask_reasoner/.test(block));

/* ---- Ancient Knowledge reads the same plan ---- */
const digest = agent.orchestrationDigest(session);
check("the digest is compact and names each assignment",
    /drawing→black-forest-labs\/flux-2-pro/.test(digest) && /reasoning→claude-opus-5/.test(digest),
    digest);
check("AK's reviewDigest carries the plan so the audit judges each part against " +
      "the model meant to do it",
    (() => {
        const d = ak.reviewDigest(session, null);
        return /model plan for this conversation/.test(d)
            && /Judge each part against the model that was meant to do it/.test(d);
    })(), ak.reviewDigest(session, null));
check("with no plan, AK's digest does not invent one",
    !/model plan for this conversation/.test(ak.reviewDigest({ id: "x" }, null)));

/* ---- THE MAP ROUTES (§5l wired) — pinned against main.js ---- */
{
    const fs = require("fs");
    const path = require("path");
    const mainSrc = fs.readFileSync(
        path.join(__dirname, "..", "app", "main.js"), "utf8");
    check("resolveTaskRoute exists and classifies the MESSAGE with the same " +
          "intent reader the offer layer uses",
        /function resolveTaskRoute\(s, text\)/.test(mainSrc)
        && /modelOffer"\)\.intentOf\(String\(text \|\| ""\)\)/.test(mainSrc));
    check("THE TURN'S DRIVE COMES FROM THE ROUTE FIRST — an assigned model " +
          "actually drives the turn, it is not a prompt hint",
        /const taskRoute = resolveTaskRoute\(s, text\);/.test(mainSrc)
        && /const orchRoute = taskRoute\.route;/.test(mainSrc)
        && /const drive = orchRoute \|\| cloudModels\.resolveSelection\(s\);/.test(mainSrc));
    check("a BROKEN assignment routes NOWHERE — only a selection that resolved " +
          "as the assignment itself (source 'session') is honoured, never a " +
          "quiet substitute",
        /r\.source === "session"/.test(mainSrc)
        && /unresolvable = broken, below/.test(mainSrc));
    check("every route taken — and every BROKEN assignment — is written to the " +
          "audit log",
        /kind: "orchestration-route",/.test(mainSrc)
        && /kind: "orchestration-route-broken",/.test(mainSrc));
    check("the K3 spend gate reads the ROUTED selection — a paid assignment " +
          "still asks before the call leaves the machine",
        mainSrc.indexOf("const orchRoute = resolveTaskRoute")
            < mainSrc.indexOf("drive.sel && !trustedHere"));
}

/* ---- ROUND TWO of the wiring — reasoner, fallback order, refit, the offer ---- */
{
    const fs = require("fs");
    const path = require("path");
    const R = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
    const cloudSrc = R(".lcl.engine", "core", "cloudModels.js");
    const agentSrc = R(".lcl.engine", "core", "agent.js");
    const mainSrc = R("app", "main.js");
    const appSrc = R("app", "renderer", "app.js");

    check("ask_reasoner honours the SESSION's Hard-reasoning assignment first — " +
          "resolved (source 'session') and passed as the streamChat selection; " +
          "the global role is only the fallback",
        /taskModels\.reasoning/.test(cloudSrc)
        && /selection: planSel \|\| undefined/.test(cloudSrc)
        && /rr\.source === "session"/.test(cloudSrc));
    check("...and the tool is OFFERED when the session's plan names a reasoner, " +
          "not only when the global role is set",
        /planReasoner \|\| cloudModels\.hasReasoner\(\)/.test(agentSrc));
    const routerSrc = R(".lcl.engine", "core", "router.js");
    check("FALLBACK PREFERS THE PLAN through the router's own seam — " +
          "resolveFallback tries opts.preferred before the global roles, still " +
          "gated by the allowlist (the escalateTo reorder was provably inert: " +
          "every consumer reads the list as a set)",
        /const pref = normaliseTarget\(opts\.preferred\);/.test(routerSrc)
        && /allow\.has\(String\(pref\.model\)\)/.test(routerSrc)
        && !/s\.escalateTo = \[a\.model/.test(mainSrc)
        && /preferredFallback: planFallback/.test(mainSrc)
        && /preferred: opts\.preferredFallback/.test(agentSrc));
    check("THE ROUTED DRIVE REACHES THE MODEL — both runners receive the " +
          "resolved selection explicitly, so a route can never be silently " +
          "dropped at the last hop by an internal re-resolve",
        (mainSrc.match(/selection: drive\.sel,\s*\n\s*preferredFallback: planFallback/g) || [])
            .length >= 2);
    check("a BROKEN assignment is SAID, not silent — audit row " +
          "orchestration-route-broken plus a routeBroken strip on the reply",
        /orchestration-route-broken/.test(mainSrc)
        && /routeBroken: taskRoute\.broken/.test(mainSrc)
        && /function showRouteBroken/.test(appSrc));
    check("a LOCAL assignment never hijacks the drive — routing sel:null would " +
          "run whatever is resident, not the assigned model",
        /never hijacks the drive/.test(mainSrc)
        && !/mode: "local"/.test(mainSrc));
    check("the fallback REFIT carries the orchestration plan — the under-duress " +
          "answerer reads the same standing instruction (now with the effort " +
          "line between persona and plan, same order as the primary assembly)",
        /answerLikeBlock\(session\)\s*\+\s*effortBlock\(session\)\s*\+\s*orchestrationBlock\(session\);/.test(agentSrc));
    check("THE OFFER REACHES THE OPERATOR — a turn with no route computes it and " +
          "the reply carries it; the strip's Assign writes the task map so such " +
          "messages ROUTE from then on",
        /modelOffer: modelOfferOut/.test(mainSrc)
        && /if \(!orchRoute && !taskRoute\.broken\)/.test(mainSrc)
        && /function showModelOffer/.test(appSrc)
        && /setSessionTaskModels\(session\.id, map\)/.test(appSrc));
    check("...the offer is advisory and quiet: dismiss is remembered per " +
          "session+kind+cap (the fleet strip's dismiss no longer mutes real " +
          "agentic offers), and an existing assignment silences it",
        /offerDismissed\.add\(dk\)/.test(appSrc)
        && /offer\.kind \? offer\.kind \+ "\|" : ""/.test(appSrc)
        && /already assigned/.test(appSrc));
    check("...and ONCE, NOT EVERY TURN: the same cap+model suggestion is made " +
          "once per session (s.offerLog), re-offered only if the suggestion " +
          "changes, and never for a cap the session already assigned",
        /seen !== o\.suggested\.id/.test(mainSrc)
        && /s\.offerLog = \{ \.\.\.\(s\.offerLog \|\| \{\}\), \[o\.cap\]: o\.suggested\.id \}/.test(mainSrc));
    check("OWNED BEATS RENTED AT EQUAL SKILL: a paid API candidate must clear " +
          "the best owned (local/node) candidate by PAID_EDGE before it is " +
          "offered over hardware the operator already runs",
        (() => { const mo = R(".lcl.engine", "core", "modelOffer.js");
            return /const PAID_EDGE = 2/.test(mo)
                && /bestPaid\.score - bestOwned\.score >= PAID_EDGE \? bestPaid : bestOwned/.test(mo)
                && /That assignment stands/.test(mo); })());
    check("THE SAME-MODEL GUARD SEES THROUGH OLLAMA TAGS — the tail compare " +
          "strips ':tag' on both sides (main.js and modelIntel), so the free " +
          "node model is never offered its own paid twin every turn",
        /\.split\("\/"\)\.pop\(\)\s*\n?\s*\.split\(":"\)\[0\]/.test(mainSrc)
        && (() => {
            const intelSrc = R(".lcl.engine", "core", "modelIntel.js");
            return /const detag = \(x\) => x\.split\(":"\)\[0\]/.test(intelSrc)
                && /detag\(String\(m\.id\)\.toLowerCase\(\)\.split\("\/"\)\.pop\(\)\)/.test(intelSrc);
        })());
    check("LINKING IS NOT CHOOSING, AT EVERY DOOR — connect() never writes the " +
          "global driver (the background node-refresh loop reaches connect() " +
          "too, so the auto-select could rewrite the app default with no " +
          "operator anywhere near it), and lcl:setModel's remote branch " +
          "honours session scope instead of leaking a per-conversation pick " +
          "into the app-wide role",
        /LINKING IS NOT CHOOSING/.test(cloudSrc)
        && !/if \(model\) selectModel\(\{ endpointId: ep\.id, model \}\);/.test(cloudSrc)
        && /if \(scope !== "session"\) \{\s*\n\s*cloudModels\.selectModel\(\{ endpointId, model, enabled: true \}\);/.test(mainSrc));
    check("NO CHOICE MEANS THIS MACHINE — resolveSelection's default and " +
          "fallback paths both resolve to the LOCAL engine (sel null), never " +
          "to the global roles.driver, so a paid API model cannot be any " +
          "conversation's silent default",
        /return \{ sel: null, source: "fallback",/.test(cloudSrc)
        && /return \{ sel: null, source: "default" \};/.test(cloudSrc)
        && !/const d = available\(\) \? selected\(\) : null;/.test(cloudSrc));
    check("REACHABLE MEANS ANSWERABLE — the offer's candidate sweep skips " +
          "offline endpoints and defers the key judgement to cloudModels' own " +
          "usableSelection (a LAN server needs no key; a keyless paid host " +
          "is never offered)",
        (() => {
            const offSrc = R(".lcl.engine", "core", "modelOffer.js");
            return /if \(ep\.offline\) continue;/.test(offSrc)
                && /cloud\.usableSelection\(ep\)/.test(offSrc);
        })());
}

console.log(`\n${pass}/${pass + fail} model-orchestration checks passed`);
process.exit(fail ? 1 : 0);
