/**
 * GRANTS THAT ACTUALLY STICK. Reported: after allowing serve_folder, another
 * session still prompts, and "it feels like it is not setting the always allow."
 * Two fixes: serve_folder gets a notify sessionFloor so a per-conversation grant
 * is not silently clamped back to confirm; and the approval card gains a GLOBAL
 * "Always allow" that writes the app-wide tool policy so it stops asking in every
 * conversation. The kernel still clamps to each tool's floor.
 */
const fs = require("fs");
const path = require("path");
const R = path.join(__dirname, "..");
const classify = fs.readFileSync(path.join(R, ".lcl.engine", "policy", "classify.js"), "utf8");
const appjs = fs.readFileSync(path.join(R, "app", "renderer", "app.js"), "utf8");
const { PolicyKernel } = require(path.join(R, ".lcl.engine", "policy", "kernel.js"));

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + String(detail).slice(0, 160) : ""); }
}

/* ---- serve_folder now has a floor a grant can reach ---- */
check("serve_folder declares sessionFloor notify",
    /serve_folder:\s*\{[^}]*sessionFloor: "notify"/.test(classify));

const decide = (tool, policy) => {
    const k = new PolicyKernel({ audit: () => {} });
    k.grant({ capability: "sys.execute", scope: null, note: "base" });
    k.toolPolicy = { [tool]: policy };
    const v = k.check(tool, { path: "." }, { turnId: "t" });
    return v.decision;
};
check("granting serve_folder 'allow' actually runs it without a confirm (was clamped to confirm)",
    decide("serve_folder", "allow") === "notify");
check("granting serve_folder 'notify' sticks too",
    decide("serve_folder", "notify") === "notify");
check("run_script still ALWAYS confirms — no floor lowers it (safety intact)",
    decide("run_script", "notify") === "confirm" && decide("run_script", "allow") === "confirm");

/* ---- the card stays per-conversation; app-wide lives in the panel ---- */
check("per-conversation grant writes the per-session policy so it STICKS now",
    /grantCapabilityForSession/.test(appjs) && /setSessionToolPolicy\(sessionId, String\(key\), "allow"\)/.test(appjs));
check("NO card offers an app-wide 'always' — that boundary is deliberate (fallback-consent)",
    !/id: "always"/.test(appjs));
check("the per-session permissions panel's group toggles write PER-SESSION (not global)",
    /window\.lcl\.setSessionToolPolicy\(sid, toolName, level\)/.test(appjs));
check("the capabilities OVERVIEW panel's dials ALSO write per-session, never global",
    /window\.lcl\.setSessionToolPolicy\(active\.id, tool\.name, level\)/.test(appjs)
    && /window\.lcl\.setSessionToolPolicy\(active\.id, t\.name, level\)/.test(appjs));
check("NO global setToolPolicy write remains anywhere in the renderer",
    !/window\.lcl\.setToolPolicy\(/.test(appjs));

console.log(`\n${pass}/${pass + fail} permission-grant checks passed`);
process.exit(fail ? 1 : 0);
