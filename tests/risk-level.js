/**
 * SESSION RISK LADDER — green, yellow, orange, red.
 *
 * The colour on the shield must reflect REAL current exposure: what is enabled
 * times where content actually goes. These tests pin the combinations so the
 * shield can never lie about how exposed a session is.
 */
const risk = require(__dirname + "/../.lcl.engine/core/riskLevel.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 260) : ""); }
}

const LOCAL = { isLocalEngine: true, label: "on-disk local", owned: true };
const NODE = { isLocalEngine: false, owned: true, label: "spark — your machine", kind: "your-machine" };
const API = { isLocalEngine: false, owned: false, label: "a vendor", kind: "third-party" };

// ordering helpers
check("worst picks the higher rung", risk.worst("green", "red") === "red");
check("worstOf folds a list", risk.worstOf(["green", "yellow", "orange"]) === "orange");
check("worstOf of nothing is green", risk.worstOf([]) === "green");

// destination spine
check("local engine is green", risk.assess({ destination: LOCAL }).level === "green");
check("no destination at all is green", risk.assess({}).level === "green");
check("your own node with no secrets is GREEN (your hardware, nothing to alarm)",
    risk.assess({ destination: NODE }).level === "green");
check("a third party with no secrets is yellow (a vendor sees the conversation)",
    risk.assess({ destination: API }).level === "yellow");

// secrets tracks WHERE, not the toggle alone
check("secrets ON but answered locally stays green (nothing leaves)",
    risk.assess({ destination: LOCAL, secrets: true }).level === "green");
check("secrets ON to your own node is orange (on the wire)",
    risk.assess({ destination: NODE, secrets: true }).level === "orange");
check("secrets ON to a third party is RED",
    risk.assess({ destination: API, secrets: true }).level === "red");

// the red case names the destination in the item detail
const redItems = risk.assess({ destination: API, secrets: true }).items;
const sec = redItems.find(i => i.key === "secrets");
check("the secrets item is red and names the third party",
    sec && sec.level === "red" && /a vendor/.test(sec.detail), sec);

// scripts
check("autoRun on a local session is yellow",
    risk.assess({ destination: LOCAL, autoRun: true }).level === "yellow");
check("a linked workspace alone is green (each run approved, path shown)",
    risk.assess({ destination: LOCAL, workspaceLinked: true }).level === "green");
const wsItem = risk.assess({ destination: LOCAL, workspaceLinked: true }).items.find(i => i.key === "workspaceWrite");
check("the workspace item mentions the path is shown", wsItem && /path/i.test(wsItem.detail), wsItem);

// a destination item is always present
check("there is always a destination item",
    risk.assess({ destination: NODE }).items.some(i => i.key === "destination"));

// worst-case stack: third party + secrets + autoRun = red, and every item listed
const stacked = risk.assess({ destination: API, secrets: true, autoRun: true, workspaceLinked: true });
check("stacked exposure is red", stacked.level === "red");
check("stacked exposure lists every risk item",
    ["destination", "secrets", "autoRun", "workspaceWrite"].every(k => stacked.items.some(i => i.key === k)),
    stacked.items.map(i => i.key));

console.log(`\n${pass}/${pass + fail} risk-level checks passed`);
process.exit(fail ? 1 : 0);
