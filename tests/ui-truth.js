/**
 * THE READOUTS THAT KEPT SHIPPING WRONG.
 *
 * Every check here exists because something was reported as broken, fixed at a
 * layer nobody could see, declared done, and reported broken again:
 *
 *   "mistral shows cost still. and no ram utilization ... you are lying saying
 *    you fixed all these items and you did not fix one fucking thing"
 *
 * The cost arithmetic was right every one of those times. actualCost returned
 * $0, estimateCost returned $0, isNodeEndpoint returned true. What was wrong
 * was the SURFACE — a session-lifetime total sitting next to the composer, a
 * memory reading whose fallback could not fire, a permission card rebuilt after
 * it had been answered. So these checks are aimed at the surface: what the
 * operator can actually see, and the one decision behind it.
 */
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + String(detail).slice(0, 300) : ""); }
}

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "app.js"), "utf8");
const htmlSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "index.html"), "utf8");
const cssSrc = fs.readFileSync(path.join(ROOT, "app", "renderer", "styles.css"), "utf8");
const mainSrc = fs.readFileSync(path.join(ROOT, "app", "main.js"), "utf8");
const nodeMemory = require(path.join(ROOT, ".lcl.engine", "core", "nodeMemory.js"));

/* =====================================================================
 * 1. THE MEMORY GAUGE CAN BE READ WITHOUT A LOGIN
 *
 * The Spark answers on its serving port and nothing else: no ssh user, no
 * stats door. Both privileged reads fail, and for two builds that meant no
 * gauge at all — "i see no ram utilization for the spark in the sidebar."
 * =================================================================== */

const SPARK = { id: "n1", name: "spark", host: "100.64.0.1", port: 11434,
                memBytes: 130_663_002_112 };
const psOK = async () => ({ ok: true, models: [{ name: "gemma3:27b", size: 17_600_000_000 }] });

(async () => {
    const noPriv = await nodeMemory.readNodeMemory(SPARK, {
        ssh: async () => ({ ok: false, err: "Permission denied (publickey)" }),
        door: async () => null,
        ollamaPs: psOK
    });
    check("A NODE WITH NO SSH AND NO DOOR STILL HAS A GAUGE — the serving port " +
          "plus the size already on record is a real reading",
        noPriv.ok === true && noPriv.physTotalBytes === SPARK.memBytes, JSON.stringify(noPriv));

    check("...and the arithmetic is total minus what the server holds resident",
        noPriv.availableBytes === SPARK.memBytes - 17_600_000_000, noPriv.availableBytes);

    check("...and it SAYS which route it came from, because a serving-port " +
          "reading cannot see memory used by anything but the model server",
        noPriv.via === "serving port" && noPriv.floor === true);

    /* THE HOLE THAT HID THE ROW SILENTLY. sshBatch answering ok:true with output
     * that has no MemTotal in it parsed to a total of 0, and zero total is what
     * the sidebar treats as "no gauge" — so a half-working ssh login beat the
     * fallback that would have worked. */
    const junk = await nodeMemory.readNodeMemory(SPARK, {
        ssh: async () => ({ ok: true, out: "bash: grep: command not found" }),
        door: async () => null,
        ollamaPs: psOK
    });
    check("AN SSH THAT SUCCEEDS AND SAYS NOTHING IS NOT A READING. It falls " +
          "through to the next route instead of reporting a total of zero",
        junk.ok === true && junk.physTotalBytes > 0 && junk.via === "serving port",
        JSON.stringify(junk));

    check("...and a real /proc/meminfo still wins over both fallbacks",
        (await nodeMemory.readNodeMemory(SPARK, {
            ssh: async () => ({ ok: true,
                out: "MemTotal:       127600000 kB\nMemAvailable:    98000000 kB\n---\n{}" }),
            door: async () => null, ollamaPs: psOK
        })).via === "ssh");

    check("...and when nothing at all answers it says so rather than inventing " +
          "a number", (await nodeMemory.readNodeMemory(SPARK, {})).ok === false);

    /* A FLOOR MUST NOT BECOME THE NUMBER THE CRASH GUARD TRUSTS. The load guard
     * refuses a model that will not fit; feeding it an optimistic figure from a
     * route that cannot see other processes is how it lets a fatal load through. */
    check("a serving-port reading is never written back as this machine's " +
          "measured size — only a measured route updates the load guard's record",
        /if \(!res\.floor\) rememberNodeMem/.test(mainSrc));

    check("main.js reads the gauge through the tested module rather than " +
          "inline, which is why the two rounds before this could not be checked",
        /nodeMemory\.readNodeMemory\(/.test(mainSrc) &&
        /require\("\.\.\/\.lcl\.engine\/core\/nodeMemory"\)/.test(mainSrc));

    /* =====================================================================
     * 2. A SESSION TOTAL IS NOT A PRICE TAG ON THE CURRENT MODEL
     *
     * Measured in the user's own ledger: session 234e02d2 is pointed at
     * mistral-large on his Spark and carries $0.02 of real DeepInfra spend from
     * earlier turns. The badge showed that money beside the composer while he
     * was typing to a model that charges nothing. "mistral shows cost still."
     * =================================================================== */

    check("THE BADGE KNOWS WHETHER THE MODEL IN THE BOX IS FREE — one flag, set " +
          "where it is already known, not re-derived",
        /let activeModelFree/.test(appSrc) &&
        /activeModelFree = !r \|\| !r\.remote \|\| !!r\.localNode/.test(appSrc));

    check("...a model that is not remote at all counts as free too, so the " +
          "built-in engine does not read as spending money",
        /!r\.remote \|\| !!r\.localNode/.test(appSrc));

    check("...and when it is free the total is labelled as history, not as the " +
          "cost of the next message",
        /"session " \+ money \+ \(activeModelFree \? " earlier" : ""\)/.test(appSrc));

    check("...with the tooltip naming what it actually is",
        /All of it from earlier turns in this session on a paid endpoint/.test(appSrc));

    check("THE REAL NUMBER IS STILL SHOWN. Deleting a true figure to stop it " +
          "being misread would be deleting a readout, which is not allowed",
        /el\.classList\.remove\("hidden"\)/.test(appSrc) &&
        !/if \(activeModelFree\) \{[\s\S]{0,80}classList\.add\("hidden"\)/.test(appSrc));

    check("...and the badge is refreshed when free-ness changes, or the wording " +
          "would lag a model switch by one message",
        (appSrc.match(/refreshSessionCost\(\);\s*\/\/ (the badge's wording|free-ness)/g) || []).length >= 2);

    check("...styled through the token system, muted rather than hidden",
        /#session-cost\.historical/.test(cssSrc) && /var\(--text-dim\)/.test(cssSrc));

    /* =====================================================================
     * 3. A QUESTION ALREADY ANSWERED IS NOT ASKED AGAIN
     *
     * "after i have said yes, you are persisting in the message on each
     * message ... i dont want to see the whole thing anymore."
     * =================================================================== */

    // THE GRANT LIVES ON THE SESSION RECORD NOW, so main SKIPS the ask entirely
    // for a trusted endpoint and tells the renderer separately. The old branch
    // inside presentRemoteApproval keyed on a renderer capability map that has
    // never been given a "remote:" key, so it was unreachable dead code — and a
    // trusted send left NO transcript record at all. presentTrustedSend is the
    // reachable half, and it carries the REAL revoke.
    const granted = (() => {
        const at = appSrc.indexOf("function presentTrustedSend");
        return at < 0 ? "" : appSrc.slice(at, at + 2200);
    })();
    check("ONCE THE GRANT EXISTS THE FULL CARD IS NOT REBUILT — no heading, no " +
          "cost line, no settings pointer, on every single turn",
        granted.length > 0 && !/buildInlinePrompt\(/.test(granted), granted.slice(0, 120));

    check("...it becomes one quiet line instead",
        /className = "perm-auto-chip"/.test(granted));

    check("...the record that a message left the machine is NOT deleted — that " +
          "is the whole point of having asked. Main says when it SKIPS the ask, " +
          "so the line still appears once trust is granted",
        /allowed for this conversation/.test(granted)
        && /chat\.appendChild\(chip\)/.test(granted)
        && /onRemoteSendAllowed/.test(appSrc));

    check("...and taking the grant back is still on it — through the REAL revoke " +
          "(the session record's trustedEndpoints), not a renderer map a reload " +
          "forgets",
        /revokeTrustedEndpoint\(sid, i\.endpointId\)/.test(granted));

    check("...styled in the token system, sized like meta rather than like a card",
        /\.perm-auto-chip/.test(cssSrc) && /\.perm-auto-undo/.test(cssSrc) &&
        /var\(--fs-tiny\)/.test(cssSrc));

    /* =====================================================================
     * 4. THE HEADER, IN THE ORDER IT WAS ASKED FOR
     *
     * "i literally said the header button order was supposed to be TERMINAL
     *  LEFT SIDEBAR RIGHT SIDEBAR"
     * =================================================================== */

    // Measured by POSITION of the three unique ids, all inside the header
    // actions region. The old non-greedy `<div ...?</div>` match truncated at
    // the context ring's own closing tag — a nested div made the check read
    // an empty order out of markup whose real order was correct.
    const headStart = htmlSrc.indexOf('id="chat-header-actions"');
    const pos = (id) => htmlSrc.indexOf(`id="${id}"`);
    check("TERMINAL, LEFT SIDEBAR, RIGHT SIDEBAR — in that order, in the header",
        headStart >= 0 && pos("terminal-toggle") > headStart
        && pos("terminal-toggle") < pos("sidebar-toggle")
        && pos("sidebar-toggle") < pos("workspace-toggle"),
        [pos("terminal-toggle"), pos("sidebar-toggle"), pos("workspace-toggle")].join(","));

    check("...and the toggles do not also live inside the panels they toggle",
        !/id="sidebar-head"[\s\S]{0,400}id="sidebar-toggle"/.test(htmlSrc));

    /* =====================================================================
     * 5. A TERMINAL YOU CAN SEE THE CURSOR IN
     *
     * "i still have no cursor in the terminal"
     * =================================================================== */

    check("THE CARET EXISTS as a real element, not an assumption that the shell " +
          "will draw one",
        /class(Name)? = "term-caret"/.test(appSrc) && /\.term-caret/.test(cssSrc));

    check("...it is not drawn on a shell that has exited, because a blinking " +
          "cursor on a dead shell invites typing into nothing",
        /if \(!s\.exited\)[\s\S]{0,200}term-caret/.test(appSrc));

    check("...and it blinks only when the terminal has focus, which is what " +
          "tells you whether typing will land there",
        /#terminal-view:focus \.term-caret/.test(cssSrc));

    console.log(`\n${pass}/${pass + fail} ui-truth checks passed`);
    process.exit(fail ? 1 : 0);
})();
