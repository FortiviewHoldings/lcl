/**
 * THE GO WINDOW: A SUBSCRIPTION'S FIVE-HOUR METER, FROM THE REAL LEDGER.
 *
 * The operator is moving to a GO subscription metered in five-hour windows:
 * the window OPENS at the first use, CLOSES five hours after it opened, and
 * the next opens at the first use after that. The meter reads the cost
 * ledger — the rows the app already writes — so it can never disagree with
 * Spend.
 *
 * The checks that matter most are the refusals: a $0 local row must never
 * open or extend a window (the plan is not paying for it), and without the
 * operator's own budget number there is NO percentage — a gauge against an
 * invented ceiling is a lie wearing a needle.
 */
const path = require("path");
const fs = require("fs");

const uw = require(path.join(__dirname, "..", ".lcl.engine", "core", "usageWindow.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name,
        detail !== undefined ? "- " + String(JSON.stringify(detail)).slice(0, 280) : ""); }
}

const H = 3_600_000;
const T0 = 1_700_000_000_000;
const row = (at, usd, tok = 100) =>
    ({ at, usd, inputTokens: tok, outputTokens: tok / 2, model: "m" });
/* A ROW FROM THE USER'S OWN MACHINE. The ledger stamps localNode on these
 * (ledger.js), and it is the only thing that truthfully separates "this cost
 * the plan nothing" from "nobody published a price for this". */
const localRow = (at, tok = 100) =>
    ({ at, usd: 0, inputTokens: tok, outputTokens: tok / 2, model: "m",
      localNode: true });

/* ------------------------------------------------------------- anchoring */
{
    const w = uw.windows([row(T0, 0.10), row(T0 + H, 0.20), row(T0 + 4 * H, 0.05)]);
    check("THE WINDOW OPENS AT THE FIRST BILLED USE, not on a clock boundary — " +
          "that is how a session-style plan actually behaves",
        w.length === 1 && w[0].start === T0 && w[0].end === T0 + 5 * H, w);
    check("...and everything inside the five hours lands in it",
        Math.abs(w[0].usd - 0.35) < 1e-9 && w[0].calls === 3, w[0]);
}
{
    const w = uw.windows([row(T0, 0.10), row(T0 + 6 * H, 0.20)]);
    check("A USE AFTER THE WINDOW CLOSED OPENS THE NEXT ONE, anchored at " +
          "ITSELF — not at the old window's edge",
        w.length === 2 && w[1].start === T0 + 6 * H
        && w[1].end === T0 + 11 * H, w.map(x => x.start));
}
{
    const w = uw.windows([row(T0, 0.10), row(T0 + 5 * H, 0.20)]);
    check("a use at exactly the closing instant belongs to the NEXT window — " +
          "the window is five hours, not five hours and a tick",
        w.length === 2 && w[1].start === T0 + 5 * H, w.map(x => x.start));
}

/* -------------------------------------------------------- the refusals */
{
    const w = uw.windows([localRow(T0), row(T0 + H, 0.10)]);
    check("A LOCAL ROW NEVER OPENS A WINDOW — the plan is not paying for " +
          "the user's own machine, and a meter that counts free work " +
          "reads high forever.\n" +
          "          Tested by the FACT (localNode) rather than by $0, which " +
          "was the old proxy and the reason the GO meter never worked: an " +
          "OpenCode row is written usd 0 because nobody publishes a price for " +
          "it, and it was being read as free local work",
        w.length === 1 && w[0].start === T0 + H, w);
    const d = uw.describe([row(T0, 0.10)], { now: T0 + H });
    check("WITHOUT THE OPERATOR'S BUDGET THERE IS NO PERCENTAGE — spend and " +
          "reset are facts, the gauge waits for the plan's real number",
        d.pct === null && d.usd === 0.10 && d.budgetUsd === null, d);
}

/* ------------------------------------------------------------- describe */
{
    const rows = [row(T0, 0.30), row(T0 + 2 * H, 0.30)];
    const d = uw.describe(rows, { budgetUsd: 3, now: T0 + 3 * H });
    check("the current window's readout: spent, reset countdown, share of " +
          "the ceiling",
        d.active && Math.abs(d.usd - 0.6) < 1e-9
        && d.resetsInMs === 2 * H && d.pct === 20, d);
    check("...and the countdown reads in words a person says",
        uw.resetsWords(d.resetsInMs) === "resets in 2h 0m"
        && uw.resetsWords(90_000) === "resets in 2m", null);

    const idle = uw.describe(rows, { budgetUsd: 3, now: T0 + 9 * H });
    check("BETWEEN WINDOWS THE METER SAYS SO — nothing is being consumed and " +
          "the next window opens on the next billed call; that is a fact " +
          "about the plan, not a zero to dress up",
        idle.active === false && idle.usd === 0 && idle.resetsInMs === null, idle);
}
{
    const d = uw.describe([row(T0, 5.0)], { budgetUsd: 4, now: T0 + H });
    check("past the ceiling the percentage keeps telling the truth (125%), " +
          "it does not pin at 100 and pretend",
        d.pct === 125, d.pct);
}
{
    check("garbage in, calm out: no rows, null rows, unsorted rows",
        uw.describe([], {}).active === false
        && uw.describe(null, {}).active === false
        && uw.windows([row(T0 + H, 0.1), row(T0, 0.1)])[0].start === T0, null);
}

/* -------------------------------------------- the three GO tiers at once */
{
    check("THE DEFAULTS ARE GO'S PUBLISHED LIMITS, VERBATIM — $12 per 5-hour " +
          "window, $30 weekly, $60 monthly (opencode.ai/docs/go). Not a guess",
        uw.GO_TIERS.length === 3
        && uw.GO_TIERS[0].hours === 5 && uw.GO_TIERS[0].budgetUsd === 12
        && uw.GO_TIERS[1].hours === 168 && uw.GO_TIERS[1].budgetUsd === 30
        && uw.GO_TIERS[2].hours === 720 && uw.GO_TIERS[2].budgetUsd === 60,
        uw.GO_TIERS);
    // $11 in the first hour: 92% of the 5h ceiling, 37% of weekly, 18% of
    // monthly — the 5h tier is what the operator is living against right now
    const rows = [row(T0, 11.0)];
    const d = uw.describeAll(rows, { now: T0 + H });
    check("all three tiers are metered from the same ledger at once",
        d.tiers.length === 3 && d.tiers.every(t => t.active && t.usd === 11),
        d.tiers.map(t => [t.label, t.usd, t.pct]));
    check("...and the TIGHTEST tier — the highest share of its ceiling — is " +
          "named, because that is the number that matters right now",
        d.tightest === "h5"
        && d.tiers.find(t => t.key === "h5").pct > 90, d.tightest);
    // ten days of light spend: the 5h window is long closed, the monthly one
    // is still open and counting
    const spread = [row(T0, 3), row(T0 + 9 * 24 * H, 3)];
    const d2 = uw.describeAll(spread, { now: T0 + 9 * 24 * H + 1 });
    const mo = d2.tiers.find(t => t.key === "month");
    const h5 = d2.tiers.find(t => t.key === "h5");
    check("tiers age independently: the monthly window still holds both " +
          "spends while the 5h window has moved on",
        mo.usd === 6 && h5.usd === 3,
        { mo: mo.usd, h5: h5.usd });
}

/* -------------------------------------------------------- the wiring */
{
    const mainSrc = fs.readFileSync(path.join(__dirname, "..", "app", "main.js"), "utf8");
    check("the meter is reachable over IPC and reads the REAL ledger — a " +
          "meter fed anything else can disagree with Spend",
        mainSrc.includes('ipcMain.handle("lcl:usageWindow"')
        && mainSrc.includes("usageWindow.describeAll(rows"), null);
    check("THE METER FOLLOWS THE DRIVER: it resolves THIS session's endpoint, " +
          "meters only rows billed to it, and answers planless for a " +
          "per-token vendor — 'the GO stuff should only be visible when a GO " +
          "model is selected'",
        /* THE PLAN GAUGE IS STILL GO-ONLY. What changed is that "planless" no
         * longer means "nothing to report": every other mode now gets a
         * five-hour WORK window, because "the 5 hour being a productivity
         * context measure, just one that resets after 5 hours ... in all modes
         * except for Go, or any other api or provider that does this as an
         * actual limiter." A ceiling gauge for a mode with no ceiling would be
         * a lie; a tally of what got done is not. */
        mainSrc.includes('if (!ep || ep.plan !== "go-window") {')
        && mainSrc.includes("return { planless: true, work: { calls: 0")
        && mainSrc.includes("ledger.readAll().filter"), null);
    check("...and a mode with NO ceiling reports what was DONE, anchored at the " +
          "oldest turn still inside five hours — the same rule the plan windows " +
          "use, because a window opens at first use rather than on a clock " +
          "boundary",
        mainSrc.includes("const start = Math.min(...rows.map(r => Number(r.at)));")
        && mainSrc.includes("const resetsInMs = Math.max(0, start + H5 - now);")
        && /calls: rows\.length/.test(mainSrc), null);
    check("...and the local engine counts in that tally. It costs no money and " +
          "it is still work, and 'what have I got done since lunch' is the " +
          "question this answers",
        /if \(!ep\) return true;/.test(mainSrc), null);
    check("...and it names the provider's own console, because GO publishes " +
          "no usage API and the console is the authoritative view",
        mainSrc.includes("opencode.ai/auth"), null);
    check("...and the tier budgets DEFAULT to GO's published numbers with the " +
          "operator's overrides winning — plans change and their console is " +
          "the truth",
        mainSrc.includes('ipcMain.handle("lcl:setGoPlan"')
        && mainSrc.includes("usageWindow.GO_TIERS.map")
        && mainSrc.includes("cfg.goBudgets"), null);
    const appSrc = fs.readFileSync(
        path.join(__dirname, "..", "app", "renderer", "app.js"), "utf8");
    check("the strip renders ALL THREE ceilings, gauges the warning on the " +
          "TIGHTEST one, and never re-nags the same window",
        appSrc.includes("renderGoStrip")
        && appSrc.includes("goWarnedWindow !== tight.start")
        && appSrc.includes("u.tightest"), null);
    check("...and every tier's budget is an editable field wired through the " +
          "bridge",
        appSrc.includes("saveGoBudgets")
        && appSrc.includes('$("ctx-plan-b-" + k).addEventListener("change"'), null);
}

/* ------------------------- the row the old test could not tell apart ----- */
{
    // exactly the operator's case: real GO turns, real tokens, unknown dollars
    const unpriced = [
        { at: T0, usd: 0, inputTokens: 12000, outputTokens: 800, model: "gpt-5" },
        { at: T0 + H, usd: 0, inputTokens: 9000, outputTokens: 400, model: "gpt-5" }
    ];
    const w = uw.windows(unpriced);
    check("AN UNPRICED REMOTE ROW DOES OPEN A WINDOW. This is the whole defect: " +
          "billed() required usd > 0, every OpenCode row is written usd 0 " +
          "because no per-token price is published for it, and so the meter " +
          "reported \"no open window\" forever while the subscription was " +
          "being spent",
        w.length === 1 && w[0].start === T0, w);

    // ACTIVE is relative to NOW, and T0 above is a fixed 2023 anchor whose
    // windows closed years ago — so "is it open" has to be asked of recent
    // rows. Same shape, same absent price.
    const now = Date.now();
    const d2 = uw.describeAll([
        { at: now - 2 * H, usd: 0, inputTokens: 12000, outputTokens: 800, model: "gpt-5" },
        { at: now - 10 * 60_000, usd: 0, inputTokens: 9000, outputTokens: 400, model: "gpt-5" }
    ], { tiers: uw.GO_TIERS });
    check("...and all three tiers read as ACTIVE, with the real token counts, " +
          "so an open window that cannot yet be priced still says it is open",
        d2.tiers.every(t => t.active === true)
        && d2.tiers[0].inputTokens === 21000
        && d2.tiers[0].outputTokens === 1200, d2.tiers.map(t => t.active));

    check("...and a mixture is separated correctly: the local row is ignored, " +
          "the unpriced remote row counts",
        (() => {
            const mixed = uw.windows([localRow(T0), unpriced[0]]);
            return mixed.length === 1 && mixed[0].calls === 1;
        })());
}

/* ================= THE WORK RING: TOKENS, NOT THE CLOCK ================= */
/* Conservative on purpose: a 1M input and 1M output budget, averaged. The old
 * ring filled with time and hit 100% just for staying open — this must not. */
{
    const P = (i, o) => uw.workWindowPct({ inputTokens: i, outputTokens: o }).pct;
    check("a full 1M in + 1M out reads 100%", P(1e6, 1e6) === 100);
    check("100k in + 100k out reads a calm 10% (was time-to-100%)", P(1e5, 1e5) === 10);
    check("a TYPICAL session (50k in, 20k out) sits near 3.5% — the conservative reading asked for",
        Math.abs(P(5e4, 2e4) - 3.5) < 1e-9);
    check("nothing done reads 0%", P(0, 0) === 0);
    check("each ceiling is capped before averaging: 2M in (over) + 0 out = 50%",
        P(2e6, 0) === 50);
    check("it is TOKENS not turns: many tiny turns of a few tokens stay near 0%",
        P(10000, 5000) < 1.5);
    check("the budgets are a million each, exported so the gauge and the test cannot drift",
        uw.WORK_INPUT_BUDGET === 1e6 && uw.WORK_OUTPUT_BUDGET === 1e6);
    const r = uw.workWindowPct({ inputTokens: 4e5, outputTokens: 1e5 });
    check("input and output are separate shares, then averaged: 40% & 10% -> 25%",
        r.inPct === 40 && r.outPct === 10 && r.pct === 25);
}
console.log(`\n${pass}/${pass + fail} usage-window checks passed`);
process.exit(fail ? 1 : 0);
