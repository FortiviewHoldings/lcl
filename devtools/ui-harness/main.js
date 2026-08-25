/**
 * DRIVE THE REAL UI AND LOOK AT IT.
 *
 *   node_modules/.bin/electron devtools/ui-harness            (all scenes)
 *   node_modules/.bin/electron devtools/ui-harness picker     (one scene)
 *
 * Loads app/renderer/index.html in a real window with a stubbed bridge, runs
 * each scene, and writes screenshots next to a JSON result. Every scene returns
 * checks; a failing check exits non-zero.
 *
 * The rule this exists to enforce: a claim about the interface is made by
 * MEASURING the interface. Not by grepping app.js, which is what every previous
 * renderer "test" did, and which is why a picker that threw on its first row
 * passed twenty-five checks.
 *
 * WHAT IS MEASURED HERE, and why each one exists:
 *
 *   composer  the four tool buttons are BELOW the field, not inside it, in the
 *             order they were in, with the model picker on the same row
 *   picker    the picker is a TREE of four modes, they open and close, an
 *             unreachable endpoint's models refuse selection (CONTRACT K4),
 *             and the menu is inside the window rather than clipped out of it
 *   space     collapsing a panel widens the CHAT COLUMN, not only the grid
 *             track underneath it — the whole of "it doesnt actually move the
 *             ui over full and maximize the space"
 *   handles   both panels have an SVG toggle in their header and a handle on
 *             their edge, and the handle is measurably visible
 *   terminal  the drawer opens from the bottom, states that it is unsandboxed,
 *             and really calls terminalStart/terminalWrite (CONTRACT K5)
 *   contrast  the session menu is opaque and the cost chip is legible, both as
 *             computed contrast ratios against the pixels actually behind them
 *   wraps     no readout breaks a word across two lines ("stop / ped")
 *   surfaces  nothing on screen reads "undefined", "NaN" or "[object Object]"
 */
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

app.disableHardwareAcceleration();

const ROOT = path.join(__dirname, "..", "..");
const OUT = path.join(__dirname, "out");
const only = process.argv.slice(2).filter(a => !a.startsWith("-"))
    .filter(a => !a.endsWith("ui-harness") && !a.includes("electron"));

const wait = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const results = [];
function check(scene, name, cond, detail) {
    const ok = !!cond;
    ok ? pass++ : fail++;
    results.push({ scene, name, ok, detail: detail === undefined ? undefined : detail });
    console.log(`${ok ? "PASS" : "FAIL"} | [${scene}] ${name}` +
        (ok || detail === undefined ? "" : "  <- " + JSON.stringify(detail).slice(0, 400)));
}
/** a measurement worth printing whether or not anything is asserted on it */
function observe(scene, name, value) {
    results.push({ scene, name, ok: true, observed: value });
    console.log(`     | [${scene}] ${name}: ` + JSON.stringify(value).slice(0, 300));
}

/* ------------------------------------------------------- in-page utilities */
/* Injected once, so every scene can talk about colour and layout the same way.
 * Contrast is computed against the pixels ACTUALLY behind an element — walking
 * ancestors until something opaque is found and compositing the translucent
 * layers on the way down. A chip that looks fine on the mock and is unreadable
 * on the product is exactly what that walk catches. */
const HELPERS = `
window.__h = (() => {
  const px = (v) => parseFloat(v) || 0;
  const parseColor = (c) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(c || "");
    if (!m) return null;
    const p = m[1].split(",").map(s => parseFloat(s));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  /* first colour stop of a gradient, which is what a translucent card surface
     actually paints at the top of the element */
  const firstStop = (bgImage) => {
    const m = /rgba?\\([^)]+\\)/.exec(bgImage || "");
    return m ? parseColor(m[0]) : null;
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1
  });
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  /* the composited colour behind an element: every translucent layer from the
     nearest opaque ancestor down, in paint order */
  const behind = (el) => {
    const stack = [];
    let n = el;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      const c = parseColor(cs.backgroundColor);
      const g = firstStop(cs.backgroundImage);
      if (g && g.a > 0) stack.push(g);
      if (c && c.a > 0) stack.push(c);
      if (c && c.a === 1) break;
      n = n.parentElement;
    }
    let base = { r: 5, g: 5, b: 5, a: 1 };          /* --bg */
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return base;
  };
  const contrast = (el) => {
    const cs = getComputedStyle(el);
    const own = parseColor(cs.backgroundColor);
    const ownG = firstStop(cs.backgroundImage);
    let bg = behind(el.parentElement || el);
    if (ownG && ownG.a > 0) bg = over(ownG, bg);
    if (own && own.a > 0) bg = over(own, bg);
    const fg = over(parseColor(cs.color) || { r: 255, g: 255, b: 255, a: 1 }, bg);
    const L1 = Math.max(lum(fg), lum(bg)), L2 = Math.min(lum(fg), lum(bg));
    return {
      ratio: +(((L1 + 0.05) / (L2 + 0.05)).toFixed(2)),
      color: cs.color, bg: "rgb(" + [bg.r, bg.g, bg.b].map(Math.round).join(",") + ")"
    };
  };
  /* IS A WORD BROKEN ACROSS TWO LINES? Measured with a Range over the text
     node: if two characters of the same word land on different line boxes, the
     word is being hyphen-less-broken, which is what "stop / ped" is. */
  const midWordBreak = (el) => {
    for (const node of el.childNodes) {
      if (node.nodeType !== 3) continue;
      const t = node.nodeValue || "";
      const r = document.createRange();
      let prevTop = null, prevChar = "";
      for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        r.setStart(node, i); r.setEnd(node, i + 1);
        const rect = r.getClientRects()[0];
        if (!rect) { prevChar = ch; continue; }
        if (prevTop !== null && Math.abs(rect.top - prevTop) > 1
            && /\\S/.test(ch) && /\\S/.test(prevChar)) {
          return { word: t.slice(Math.max(0, i - 8), i + 8), at: i };
        }
        prevTop = rect.top; prevChar = ch;
      }
    }
    return null;
  };
  const visible = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || px(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  return { px, parseColor, behind, contrast, midWordBreak, visible, lum, over };
})();
true;
`;

/* ------------------------------------------------------------------ scenes */
const SCENES = {

    /* Does the app paint at all, and did anything throw on the way up? */
    boot: async (win, js) => {
        const errs = await js(`window.__errors`);
        check("boot", "the renderer booted with no uncaught exception", errs.length === 0, errs);
        const seen = await js(`({
            composer: !!document.querySelector("#composer, .composer, #message-input, textarea"),
            sidebar:  !!document.querySelector("#session-list, .session-list"),
            header:   !!document.querySelector("header, .titlebar, #titlebar")
        })`);
        check("boot", "the composer, the session list and the header are all present",
            seen.composer && seen.sidebar && seen.header, seen);
    },

    /* WHAT ACTUALLY RENDERS in the picker — dumped as an indented tree so the
     * real node-tier structure can be READ, not guessed. Prints between markers. */
    pickerdump: async (win, js) => {
        await js(`
            window.__harness.FIXTURES.sparkModes = () => ({ ok: true, modes: {
                deep:     { model: "unsloth/gpt-oss-120b-GGUF:F16", label: "gpt-oss-120b", ctx: 131072, name: "Vast", icon: "bulb", blurb: "one conversation, the whole 131k window" },
                balanced: { model: "unsloth/gpt-oss-120b-GGUF:F16", label: "gpt-oss-120b", ctx: 65536,  name: "Balanced", icon: "scales", blurb: "two at a time, 65k each" },
                wide:     { model: "unsloth/gpt-oss-120b-GGUF:F16", label: "gpt-oss-120b", ctx: 32768,  name: "Swarm", icon: "bee", blurb: "four at a time, 32k each" },
                vast:     { model: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL", label: "Qwen3.6-35B", ctx: 262144, name: "Vast", icon: "bulb", blurb: "one conversation, a 262k window" },
                swarm:    { model: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL", label: "Qwen3.6-35B", ctx: 65536,  name: "Swarm", icon: "bee", blurb: "four light agents, 65k each" }
            }});
            document.getElementById("model-pick").click();
            true;
        `);
        await wait(400);
        // the COMPACT open state — every tier shut, headers only
        await shoot(win, "picker-compact");
        const openCount = await js(`[...document.querySelectorAll('#model-menu .model-tier')].filter(t => t.getAttribute("aria-expanded") === "true").length`);
        check("pickerdump", "opens COMPACT — no tier pre-expanded", openCount === 0, openCount);
        await js(`(() => {
            for (let i = 0; i < 6; i++) {
                document.querySelectorAll('#model-menu [aria-expanded="false"]').forEach(e => e.click());
            }
            return true;
        })()`);
        await wait(700);
        const tree = await js(`(() => {
            const root = document.getElementById("model-menu");
            if (!root) return "NO #model-menu";
            const lines = [];
            const walk = (el, d) => {
                for (const c of el.children) {
                    const cls = c.getAttribute("class") || "";
                    if (/\\bhidden\\b/.test(cls)) continue;
                    let own = "";
                    for (const n of c.childNodes) if (n.nodeType === 3) own += n.textContent;
                    own = own.replace(/\\s+/g, " ").trim();
                    const key = cls.split(/\\s+/)[0];
                    const interesting = /model-tier-name|model-tier-count|model-tier-here|model-family|model-provider|model-row|node-model-row|model-row-name|model-row-state|mode-lb|mm-note|model-name|model-meta|sm-btn/.test(cls);
                    if (own && interesting) lines.push("  ".repeat(d) + key + " :: " + own);
                    walk(c, d + 1);
                }
            };
            walk(root, 0);
            return lines.join("\\n");
        })()`);
        console.log("===PICKERDUMP===\\n" + tree + "\\n===ENDDUMP===");
        check("pickerdump", "the model menu rendered rows", tree.length > 0, tree.length);
        // leave the menu shut so the next scene opens it fresh
        await js(`const mm = document.getElementById("model-menu"); if (mm) mm.classList.add("hidden"); true;`);
        await wait(120);
    },

    /* ITEM 1 + 2. The buttons are out of the field, below it, in order, with
     * the model picker joining them. Measured as geometry, not as markup: the
     * question is where they PAINT. */
    composer: async (win, js) => {
        const m = await js(`(() => {
            const inner = document.getElementById("composer-inner");
            const tools = document.getElementById("composer-tools");
            const field = document.getElementById("composer-input");
            const ids = ["link-repo", "link-knowledge", "session-perms-btn", "mic-btn"];
            const btns = ids.map(id => document.getElementById(id));
            /* plain objects: a DOMRect cannot cross the executeJavaScript
               boundary and the whole scene dies with "An object could not be
               cloned", which is a scene that measured nothing */
            const r = (el) => {
                if (!el) return null;
                const b = el.getBoundingClientRect();
                return { left: b.left, right: b.right, top: b.top,
                         bottom: b.bottom, width: b.width, height: b.height };
            };
            return {
                hasTools: !!tools,
                toolsRect: r(tools), innerRect: r(inner), fieldRect: r(field),
                inField: ids.filter(id => inner && inner.contains(document.getElementById(id))),
                inTools: ids.filter(id => tools && tools.contains(document.getElementById(id))),
                order: btns.filter(Boolean).map(b => ({ id: b.id, x: r(b).left, y: r(b).top })),
                sameRow: (() => {
                    const ys = btns.filter(Boolean).map(b => Math.round(r(b).top));
                    return ys.every(y => Math.abs(y - ys[0]) <= 1);
                })(),
                pickerInTools: !!(tools && tools.contains(document.getElementById("model-pick-wrap"))),
                pickerRect: r(document.getElementById("model-pick-wrap")),
                sendInField: !!(inner && inner.contains(document.getElementById("send"))),
                fieldWidth: r(field) ? Math.round(r(field).width) : 0
            };
        })()`);

        check("composer", "THE BUTTONS ARE OUT OF THE INPUT CONTAINER — " +
            "'all teh buttons in the message input field. should not be in that container'",
            m.hasTools && m.inField.length === 0 && m.inTools.length === 4,
            { stillInside: m.inField, movedOut: m.inTools });
        check("composer", "...and they are BELOW the field, not beside it",
            m.toolsRect && m.innerRect && m.toolsRect.top >= m.innerRect.bottom - 1,
            { toolsTop: m.toolsRect && m.toolsRect.top, fieldBottom: m.innerRect && m.innerRect.bottom });
        check("composer", "...as a ROW: folder, book, shield, mic, all on one line",
            m.sameRow, m.order);
        check("composer", "...KEEPING THEIR POSITION — the same left-to-right order they had",
            m.order.length === 4 &&
            m.order[0].id === "link-repo" && m.order[1].id === "link-knowledge" &&
            m.order[2].id === "session-perms-btn" && m.order[3].id === "mic-btn" &&
            m.order[0].x < m.order[1].x && m.order[1].x < m.order[2].x && m.order[2].x < m.order[3].x,
            m.order);
        check("composer", "THE MODEL SELECTOR JOINS THAT ROW",
            m.pickerInTools && m.pickerRect && m.toolsRect &&
            Math.abs(m.pickerRect.top - m.toolsRect.top) < m.toolsRect.height,
            { picker: m.pickerRect, tools: m.toolsRect });
        check("composer", "...and Send stays with the field, because it is the field's own " +
            "action and the one control that becomes Stop", m.sendInField);
        observe("composer", "the input's own width now (px)", m.fieldWidth);
        await shoot(win, "composer");
    },

    /* ITEM 2. THE PICKER IS A TREE. Opened for real, clicked for real. */
    picker: async (win, js) => {
        const before = await js(`window.__errors.length`);
        const opened = await js(`(() => {
            const btn = document.getElementById("model-pick");
            if (!btn) return { found: false };
            btn.click();
            const menu = document.getElementById("model-menu");
            const tiers = [...menu.querySelectorAll(".model-tier")];
            const vp = { w: innerWidth, h: innerHeight };
            const r = menu.getBoundingClientRect();
            return {
                found: true,
                hidden: menu.classList.contains("hidden"),
                rows: menu.querySelectorAll(".model-row").length,
                tiers: tiers.map(t => ({
                    label: t.querySelector(".model-tier-name").innerText.trim(),
                    count: t.querySelector(".model-tier-count").innerText.trim(),
                    open: t.getAttribute("aria-expanded"),
                    rowsVisible: [...menu.querySelectorAll('.model-tier-body[data-tier="'
                        + t.dataset.tier + '"] .model-row')]
                        .filter(x => x.getBoundingClientRect().height > 0).length
                })),
                menuRect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
                viewport: vp,
                onScreen: r.left >= 0 && r.top >= 0 && r.right <= vp.w + 1 && r.bottom <= vp.h + 1,
                clipped: (() => {
                    /* is any ancestor clipping it out of view? measured, not assumed */
                    let n = menu.parentElement, bad = null;
                    while (n && n !== document.body) {
                        const cs = getComputedStyle(n);
                        if (cs.overflow !== "visible") {
                            const nr = n.getBoundingClientRect();
                            if (r.top < nr.top - 1 || r.bottom > nr.bottom + 1) bad = n.id || n.className;
                        }
                        n = n.parentElement;
                    }
                    return bad;
                })()
            };
        })()`);
        check("picker", "the model button exists", opened.found, opened);
        const after = await js(`window.__errors`);
        check("picker", "OPENING THE PICKER THREW NOTHING — the defect that shipped a " +
            "dead menu while 25/25 renderer checks passed",
            after.length === before, after.slice(before));
        check("picker", "the menu is actually open after the click", opened.hidden === false, opened);
        check("picker", "it built a row for every model the bridge offered (5)",
            opened.rows >= 5, opened);

        /* innerText comes back through text-transform, so the comparison is on
         * the words rather than on their casing */
        check("picker", "IT OPENS AND SHOWS THE 4 MODES — Local, Local Nodes, API, $ GPU",
            opened.tiers.length === 4 &&
            opened.tiers.map(t => t.label.toLowerCase()).join("|")
                === "local|local nodes|api|$ gpu",
            opened.tiers.map(t => t.label));
        check("picker", "...and they open COMPACT: every tier starts shut, so the list " +
            "is group headers only — no tree pre-spilled that you must collapse",
            opened.tiers.filter(t => t.open === "true").length === 0,
            opened.tiers);
        check("picker", "...so a shut mode really is hiding its rows",
            opened.tiers.filter(t => t.open === "false").every(t => t.rowsVisible === 0),
            opened.tiers);
        check("picker", "THE MENU IS INSIDE THE WINDOW and no ancestor is clipping it — a " +
            "dropdown you cannot see is the same defect as a dropdown that throws",
            opened.onScreen && !opened.clipped,
            { rect: opened.menuRect, viewport: opened.viewport, clippedBy: opened.clipped });

        /* CLICK A MODE. This is the interaction the whole item is about. */
        const expanded = await js(`(() => {
            const menu = document.getElementById("model-menu");
            const shut = [...menu.querySelectorAll(".model-tier")]
                .find(t => t.getAttribute("aria-expanded") === "false"
                        && !t.classList.contains("empty"));
            if (!shut) return { found: false };
            const key = shut.dataset.tier;
            const body = menu.querySelector('.model-tier-body[data-tier="' + key + '"]');
            const before = [...body.querySelectorAll(".model-row")]
                .filter(x => x.getBoundingClientRect().height > 0).length;
            shut.click();
            const after = [...body.querySelectorAll(".model-row")]
                .filter(x => x.getBoundingClientRect().height > 0).length;
            shut.click();
            const closed = [...body.querySelectorAll(".model-row")]
                .filter(x => x.getBoundingClientRect().height > 0).length;
            shut.click();
            return { found: true, key, before, after, closed,
                     label: shut.querySelector(".model-tier-name").innerText.trim() };
        })()`);
        check("picker", "CLICKING A MODE OPENS IT — measured as rows that actually have " +
            "height, not as a class name",
            expanded.found && expanded.before === 0 && expanded.after > 0, expanded);
        check("picker", "...and clicking it again shuts it", expanded.closed === 0, expanded);

        /* NO MULTICOLOUR. Every kind chip the same ink; no per-tier tint. */
        const colours = await js(`(() => {
            const menu = document.getElementById("model-menu");
            const chips = [...menu.querySelectorAll(".model-kind")]
                .map(c => getComputedStyle(c).color);
            const heads = [...menu.querySelectorAll(".model-group.grp-local, .model-group.grp-api")]
                .map(h => getComputedStyle(h).color);
            return { chips: [...new Set(chips)], heads: [...new Set(heads)], chipCount: chips.length };
        })()`);
        check("picker", "THEN IT DOESNT NEED TO BE MULTICOLORED — every kind chip is the " +
            "same ink, and the group headers no longer carry one tint each",
            colours.chips.length <= 1 && colours.heads.length <= 1,
            colours);
        check("picker", "...and the chip itself was NOT deleted to achieve that — the " +
            "readout survives, only the colour went", colours.chipCount > 0, colours);

        /* CONTRACT K4 — a model on a machine that is not answering. */
        const off = await js(`(() => {
            const menu = document.getElementById("model-menu");
            /* open every mode so the offline row is reachable */
            for (const t of menu.querySelectorAll(".model-tier:not(.empty)")) {
                if (t.getAttribute("aria-expanded") !== "true") t.click();
            }
            const rows = [...menu.querySelectorAll(".model-row.offline")];
            if (!rows.length) return { found: false,
                total: menu.querySelectorAll(".model-row").length };
            const row = rows[0];
            const before = (window.lcl.__calls || []).filter(c => c.key === "setSessionModel").length;
            row.click();
            const after = (window.lcl.__calls || []).filter(c => c.key === "setSessionModel").length;
            return {
                found: true, count: rows.length,
                disabled: row.disabled,
                opacity: getComputedStyle(row).opacity,
                meta: row.querySelector(".model-meta").innerText,
                stillListed: menu.querySelectorAll(".model-row").length,
                switchAttempts: after - before
            };
        })()`);
        check("picker", "CONTRACT K4 — a model whose endpoint is unreachable is marked " +
            "offline and GREYED, not silently listed as if the machine were on",
            off.found && off.disabled && parseFloat(off.opacity) < 0.6, off);
        check("picker", "...it SAYS WHY, in the row", off.found && /not answering/i.test(off.meta), off);
        check("picker", "...clicking it REFUSES the selection — no setSessionModel call, so " +
            "the UI can never again report a model switched with no weights loaded",
            off.switchAttempts === 0, off);
        check("picker", "...and the model is still LISTED. 'where did my model go' is a " +
            "worse question than 'why is it grey'", off.stillListed >= 5, off);

        await shoot(win, "picker");
        await js(`document.getElementById("model-menu").classList.add("hidden")`);
    },

    /* ITEM 3. REAL SPACE RECLAIM, in four states.
     *
     * The reading column is EMPTY on the landing page, so it measures 0 wide and
     * every comparison is vacuously false. Real messages go in first, which is
     * also what the contrast scene needs later. */
    space: async (win, js) => {
        const seeded = await js(`(() => {
            landingDismissed.add(active ? active.id : "x");
            document.getElementById("landing").classList.add("hidden");
            addMessageRow("user", "How long in the fixer at 20 C?", 0);
            addMessageRow("assistant", "Five minutes for fibre paper, agitated for " +
                "the first thirty seconds and then once a minute after that.", 1,
                { model: "glm-4 9B", inTokens: 412, outTokens: 96, tps: 21, usd: 0.0042 });
            return document.querySelectorAll("#chat .msg-row").length;
        })()`);
        check("space", "(setup) the transcript has real messages, so the reading column " +
            "has a width to measure at all", seeded >= 2, seeded);

        const measure = `(() => {
            const body = document.getElementById("body");
            const main = document.getElementById("main");
            const chat = document.getElementById("chat");
            const inner = document.getElementById("composer-inner");
            const R = (e) => Math.round(e.getBoundingClientRect().width);
            return { pane: R(main), column: R(chat), composer: R(inner),
                     sidebar: R(document.getElementById("sidebar")),
                     workspace: R(document.getElementById("workspace")) };
        })()`;
        const set = async (sidebar, ws) => {
            await js(`(() => {
                setSidebar(${sidebar ? "false" : "true"});
                toggleWorkspace(${ws ? "true" : "false"});
            })()`);
            await wait(320);                       /* the grid transition is 180ms */
            return js(measure);
        };

        const bothOpen = await set(true, true);
        const noSide   = await set(false, true);
        const noWs     = await set(true, false);
        const neither  = await set(false, false);
        observe("space", "sidebar+workspace open", bothOpen);
        observe("space", "sidebar collapsed", noSide);
        observe("space", "workspace collapsed", noWs);
        observe("space", "both collapsed", neither);

        check("space", "collapsing the SESSION LIST gives the chat pane its width",
            noSide.pane > bothOpen.pane, { before: bothOpen.pane, after: noSide.pane });
        check("space", "...AND THE CHAT COLUMN ITSELF GROWS. The grid track always widened; " +
            "the 860px column inside it did not, which is the whole of 'it doesnt actually " +
            "move the ui over full and maximize the space'",
            noSide.column > bothOpen.column,
            { before: bothOpen.column, after: noSide.column });
        check("space", "...and the composer track grows with it, so the field and the " +
            "messages keep one left edge",
            noSide.composer > bothOpen.composer,
            { before: bothOpen.composer, after: noSide.composer });

        check("space", "collapsing the WORKSPACE PANEL gives the chat pane its width",
            noWs.pane > bothOpen.pane, { before: bothOpen.pane, after: noWs.pane });
        check("space", "...and the chat column grows on that side too",
            noWs.column > bothOpen.column, { before: bothOpen.column, after: noWs.column });

        check("space", "collapsing BOTH reclaims more than either alone",
            neither.column > noSide.column && neither.column > noWs.column,
            { neither: neither.column, noSide: noSide.column, noWs: noWs.column });
        check("space", "a collapsed panel really is zero wide — no 25px strip left drawing " +
            "over the header", neither.sidebar === 0 && neither.workspace === 0, neither);

        /* setSidebar takes HIDDEN. These three shots were named for what they
         * were meant to show and taken in the wrong states — two of them came
         * out byte-identical, which is how the mistake surfaced. */
        await js(`(() => { setSidebar(true); toggleWorkspace(false); })()`);
        await wait(320);
        await shoot(win, "space-both-collapsed");
        await js(`(() => { setSidebar(false); toggleWorkspace(true); })()`);
        await wait(320);
        await shoot(win, "space-workspace-open");
        await js(`(() => { setSidebar(false); toggleWorkspace(false); })()`);
        await wait(320);
        await shoot(win, "space-default");
    },

    /* ITEM 3. The toggles and the handles. */
    handles: async (win, js) => {
        /* THE TOGGLES ARE MEASURED WITH THE PANELS OPEN — that is where they
         * live. (setSidebar takes HIDDEN, not shown.) */
        await js(`(() => { setSidebar(false); toggleWorkspace(true); })()`);
        await wait(320);
        const m = await js(`(() => {
            const g = (id) => document.getElementById(id);
            const info = (id) => {
                const el = g(id);
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { svg: !!el.querySelector("svg"),
                         text: (el.innerText || "").trim(),
                         w: Math.round(r.width), h: Math.round(r.height),
                         top: Math.round(r.top), right: Math.round(r.right),
                         visible: window.__h.visible(el) };
            };
            /* "top right of the header" means the header's CONTENT box: a header
               with 12px of padding puts its last control 12px in, and measuring
               against the border box calls that a failure */
            const inner = (id) => {
                const el = g(id), r = el.getBoundingClientRect();
                const pad = parseFloat(getComputedStyle(el).paddingRight) || 0;
                return { right: Math.round(r.right - pad) };
            };
            const chatHead = g("chat-header-inner");
            return {
                sidebarToggle: info("sidebar-toggle"), sbHead: inner("sidebar-head"),
                workspaceToggle: info("workspace-toggle"), head: inner("chat-header-inner"),
                workspaceClose: info("workspace-close"), wsHead: inner("workspace-head"),
                terminalToggle: info("terminal-toggle"),
                inChatHeader: {
                    sidebar: !!(chatHead && chatHead.contains(g("sidebar-toggle"))),
                    workspace: !!(chatHead && chatHead.contains(g("workspace-toggle")))
                }
            };
        })()`);
        check("handles", "THE SESSION-LIST TOGGLE IS AN SVG, NOT A TEXT LABEL",
            m.sidebarToggle && m.sidebarToggle.svg && m.sidebarToggle.text === "", m.sidebarToggle);
        check("handles", "THE WORKSPACE TOGGLE IS AN SVG TOO — an icon, not the ✕ it used to " +
            "be; a close glyph says 'gone', and this panel comes back",
            m.workspaceToggle && m.workspaceToggle.svg && m.workspaceToggle.text === "",
            m.workspaceToggle);
        check("handles", "BOTH TOGGLES LIVE IN THE CHAT HEADER, top-right — consolidated there " +
            "so each is reachable whether its panel is open or collapsed, instead of hiding " +
            "inside a panel that may be off screen",
            m.inChatHeader && m.inChatHeader.sidebar && m.inChatHeader.workspace &&
            m.sidebarToggle.visible && m.workspaceToggle.visible &&
            m.sidebarToggle.right <= m.head.right + 2 && m.workspaceToggle.right <= m.head.right + 2,
            { sidebar: m.sidebarToggle, workspace: m.workspaceToggle, header: m.head, inHeader: m.inChatHeader });
        check("handles", "...side by side on one row",
            m.sidebarToggle && m.workspaceToggle &&
            Math.abs(m.sidebarToggle.top - m.workspaceToggle.top) <= 2,
            { sidebar: m.sidebarToggle, workspace: m.workspaceToggle });

        /* THE HANDLES. Both sides, measured while both panels are collapsed —
         * the only state in which a handle is supposed to exist. */
        await js(`(() => { setSidebar(true); toggleWorkspace(false); })()`);
        await wait(320);
        const h = await js(`(() => {
            const g = (id) => document.getElementById(id);
            /* A MISSING HANDLE IS A MEASUREMENT, NOT A CRASH. Deleting the
             * element used to throw here and the whole scene died on "Script
             * failed to execute" — which is a red run that says nothing about
             * what is wrong. It reports absent:true and every check below reads
             * as false on its own terms. */
            const info = (id) => {
                const el = g(id);
                if (!el) return { absent: true, visible: false, w: 0, h: 0,
                                  left: -1, right: -1, contrast: 0 };
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                return { visible: window.__h.visible(el),
                         w: Math.round(r.width), h: Math.round(r.height),
                         left: Math.round(r.left), right: Math.round(r.right),
                         border: cs.borderTopColor,
                         contrast: window.__h.contrast(el).ratio,
                         bg: window.__h.contrast(el).bg };
            };
            return { sidebar: info("btn-sidebar"), workspace: info("btn-workspace"),
                     vw: innerWidth };
        })()`);
        observe("handles", "left handle", h.sidebar);
        observe("handles", "right handle", h.workspace);
        check("handles", "BOTH panels keep a VISIBLE handle while collapsed — the left one " +
            "did not exist at all, so collapsing the list took its own toggle with it",
            h.sidebar.visible && h.workspace.visible, h);
        check("handles", "...and 'visible' means a real target, not the six-pixel sliver " +
            "reported as 'practically invisible': at least 20px wide and 60 tall",
            h.sidebar.w >= 20 && h.sidebar.h >= 60 && h.workspace.w >= 20 && h.workspace.h >= 60, h);
        check("handles", "...with enough contrast against the pane to be seen at all",
            h.sidebar.contrast >= 1.35 && h.workspace.contrast >= 1.35, h);
        check("handles", "...pinned to the edges they belong to, overlapping slightly, " +
            "which was explicitly allowed",
            h.sidebar.left <= 1 && h.workspace.right >= h.vw - 1, h);

        /* and they WORK */
        const back = await js(`(() => {
            const s = document.getElementById("btn-sidebar");
            const w = document.getElementById("btn-workspace");
            if (s) s.click();
            const a = !document.getElementById("body").classList.contains("no-sidebar");
            if (w) w.click();
            const b = document.getElementById("body").classList.contains("with-ws");
            return { sidebarBack: !!s && a, workspaceBack: !!w && b };
        })()`);
        check("handles", "...and clicking each handle brings its panel back",
            back.sidebarBack && back.workspaceBack, back);

        await js(`(() => { setSidebar(true); toggleWorkspace(false); })()`);
        await wait(320);
        await shoot(win, "handles-collapsed");
        await js(`(() => { setSidebar(false); toggleWorkspace(false); })()`);
        await wait(320);
    },


    /* ITEM 4. THE TERMINAL — CONTRACT K5. */
    terminal: async (win, js) => {
        const m = await js(`(async () => {
            const btn = document.getElementById("terminal-toggle");
            const before = (window.lcl.__calls || []).length;
            btn.click();
            await new Promise(r => setTimeout(r, 260));
            const panel = document.getElementById("terminal");
            const r = panel.getBoundingClientRect();
            const calls = (window.lcl.__calls || []).slice(before).map(c => c.key);
            return {
                visible: window.__h.visible(panel),
                rect: { top: Math.round(r.top), bottom: Math.round(r.bottom),
                        left: Math.round(r.left), width: Math.round(r.width) },
                vh: innerHeight, vw: innerWidth,
                started: calls.filter(k => k === "terminalStart").length,
                subscribed: (window.lcl.__calls || []).some(c => c.key === "onTerminalData"),
                notice: (document.getElementById("terminal-notice").innerText || "").trim(),
                btnSvg: !!btn.querySelector("svg"),
                btnText: (btn.innerText || "").trim(),
                composerBelow: document.getElementById("composer")
                    .getBoundingClientRect().bottom <= r.top + 1
            };
        })()`);
        check("terminal", "THE `>_` BUTTON IN THE HEADER IS AN SVG",
            m.btnSvg && m.btnText === "", m);
        check("terminal", "clicking it opens a panel", m.visible, m);
        check("terminal", "...FROM THE BOTTOM OF THE WINDOW, full width",
            Math.abs(m.rect.bottom - m.vh) <= 1 && m.rect.left === 0
            && Math.abs(m.rect.width - m.vw) <= 1, m);
        check("terminal", "...and it PUSHES the composer up rather than covering it — a " +
            "drawer that hides the message box is not a drawer",
            m.composerBelow, m);
        check("terminal", "CONTRACT K5 — it really starts a shell through the preload " +
            "bridge (terminalStart), rather than drawing a picture of one",
            m.started === 1, m);
        check("terminal", "...and subscribes to its output (onTerminalData)", m.subscribed, m);
        check("terminal", "IT SAYS IT IS UNSANDBOXED, once, quietly, in the panel",
            /unsandboxed|no sandbox/i.test(m.notice) && /no approval/i.test(m.notice), m.notice);
        check("terminal", "...and says the model cannot type into it, which is the part " +
            "that matters and the part nobody would assume",
            /cannot type|no path|model/i.test(m.notice), m.notice);

        /* TYPING GOES TO THE SHELL, AND OUTPUT COMES BACK. */
        const io = await js(`(async () => {
            const view = document.getElementById("terminal-view");
            view.focus();
            for (const ch of "echo hi") {
                view.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
            }
            /* BEFORE ENTER: the in-progress line is echoed LOCALLY, because a
               shell reading from a pipe does not echo it back — without this you
               type blind. Measured while it is still being typed. */
            const echoedWhileTyping = view.innerText.includes("echo hi");
            const echoSpan = !!document.querySelector(".term-echo");
            view.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            await new Promise(r => setTimeout(r, 60));
            const writes = (window.lcl.__calls || []).filter(c => c.key === "terminalWrite");
            /* AFTER ENTER: our local copy is handed to the shell and CLEARED, so
               the command is not printed twice — once by us and once by the
               shell's own echo (measured against real cmd.exe and PowerShell). */
            const clearedAfterEnter = !document.querySelector(".term-echo");
            /* the stub echoes nothing on its own — fire the data event the way
               main.js would, and see whether it lands in the pane */
            window.lcl.__fire("onTerminalData", "t1", "hi\\r\\n");
            await new Promise(r => setTimeout(r, 60));
            return {
                writes: writes.map(w => w.args[1]).join(""),
                text: view.innerText,
                echoedWhileTyping, echoSpan, clearedAfterEnter,
                gotOutput: view.innerText.includes("hi")
            };
        })()`);
        check("terminal", "typing sends the bytes to the shell (terminalWrite)",
            io.writes.includes("echo hi") && /[\r\n]/.test(io.writes), io);
        check("terminal", "...the line being typed is echoed LOCALLY while you type — a shell " +
            "reading a pipe does not echo, so without this you type blind",
            io.echoedWhileTyping && io.echoSpan, io);
        check("terminal", "...then handed to the shell on Enter and CLEARED, so the command is " +
            "not printed twice (our copy plus the shell's own echo)",
            io.clearedAfterEnter, io);
        check("terminal", "...and what the shell says comes back into the pane",
            io.gotOutput, io);

        await shoot(win, "terminal");

        const closed = await js(`(() => {
            document.getElementById("terminal-close").click();
            const p = document.getElementById("terminal");
            const killed = (window.lcl.__calls || []).filter(c => c.key === "terminalKill").length;
            return { hidden: !window.__h.visible(p), killed };
        })()`);
        check("terminal", "closing the panel hides it", closed.hidden, closed);
        check("terminal", "...and does NOT kill the shell — hiding a drawer must not " +
            "destroy the job running in it", closed.killed === 0, closed);
    },

    /* ITEM 5. Contrast and opacity of the things reported unreadable. */
    contrast: async (win, js) => {
        const menu = await js(`(() => {
            /* open a real session row menu, the way a person does */
            const more = document.querySelector(".session-more");
            if (!more) return { found: false };
            more.click();
            const m = document.querySelector(".session-menu");
            if (!m) return { found: false, clicked: true };
            const cs = getComputedStyle(m);
            const btn = m.querySelector("button");
            const c = window.__h.contrast(btn);
            return { found: true, bg: cs.backgroundColor, bgImage: cs.backgroundImage,
                     behind: window.__h.contrast(m).bg,
                     ratio: c.ratio, color: c.color, effectiveBg: c.bg };
        })()`);
        if (menu.found) {
            observe("contrast", "session triple-dot menu", menu);
            check("contrast", "THE TRIPLE-DOT MENU IS OPAQUE. 'the session triple-dot menu " +
                "background is so transparent the text is unreadable through it' — it was " +
                "`var(--card-surface, #111114)`, and --card-surface IS declared, so the " +
                "fallback could never apply and what painted was a 4.5% white wash",
                menu.ratio >= 7, menu);
        } else {
            check("contrast", "a session row menu could be opened to measure", false, menu);
        }

        /* THE COST READOUT. Rendered on a real assistant bubble. */
        const cost = await js(`(() => {
            const chat = document.getElementById("chat");
            const bubble = document.createElement("div");
            bubble.className = "msg-assistant";
            bubble.innerText = "measured";
            const foot = document.createElement("div");
            foot.className = "msg-meta";
            foot.innerText = "some-model · 10 in · 20 out";
            const c = document.createElement("span");
            c.className = "msg-cost"; c.innerText = "$0.0042";
            const a = document.createElement("span");
            a.className = "msg-audit"; a.innerText = "reviewed ×1";
            foot.appendChild(c); foot.appendChild(a);
            bubble.appendChild(foot); chat.appendChild(bubble);
            const out = {
                bubbleBg: getComputedStyle(bubble).backgroundImage.slice(0, 60),
                cost: window.__h.contrast(c),
                audit: window.__h.contrast(a),
                meta: window.__h.contrast(foot),
                sessionCost: (() => {
                    const s = document.getElementById("session-cost");
                    s.classList.remove("hidden"); s.innerText = "session $0.42";
                    const r = window.__h.contrast(s);
                    s.classList.add("hidden");
                    return r;
                })()
            };
            bubble.remove();
            return out;
        })()`);
        observe("contrast", "cost chip on the assistant bubble", cost.cost);
        observe("contrast", "audit chip on the assistant bubble", cost.audit);
        observe("contrast", "session total beside the composer", cost.sessionCost);
        check("contrast", "THE COST READOUT IS READABLE. 'the cost readout is green on white " +
            "and too light to read' — .msg-cost was #9adfae on a near-white bubble " +
            "(#e1e1e5 -> #ececef), about 1.5:1. WCAG AA for small text is 4.5:1",
            cost.cost.ratio >= 4.5, cost.cost);
        check("contrast", "...and its sibling chip, which had exactly the same problem",
            cost.audit.ratio >= 4.5, cost.audit);
        check("contrast", "...and the session total beside the composer, on the dark side",
            cost.sessionCost.ratio >= 4.5, cost.sessionCost);

        await shoot(win, "contrast");
        await js(`document.querySelectorAll(".session-menu").forEach(m => m.remove())`);
    },

    /* ITEM 5. "stopped" wrapping mid-word. Every stop-bearing readout, driven
     * into its stop state and measured for a break inside a word. */
    wraps: async (win, js) => {
        const m = await js(`(async () => {
            /* drive the surfaces that carry stop words into those states */
            setStatus("down", "stopped to protect memory");
            const typing = addTyping();
            typing._phase.innerText = "stopping";
            const term = document.getElementById("terminal");
            term.classList.remove("hidden");
            const ts = document.getElementById("terminal-status");
            ts.innerText = "stopped · exit 0";
            /* a live task row, interrupted */
            renderTask({ id: "t-wrap", title: "Indexing the darkroom library",
                         status: "running", cancellable: true, n: 312, total: 1449 });
            toggleWorkspace(true);
            // WAIT FOR THE PANEL TO FINISH OPENING before measuring. The grid
            // transition is 180ms; measuring at 80ms once caught the task row
            // mid-slide at 37px wide, where any long word necessarily wraps —
            // a flake that would make this gate deny a build at random.
            await new Promise(r => setTimeout(r, 360));
            const stopBtn = document.querySelector(".task-stop");
            if (stopBtn) stopBtn.innerText = "stopped";
            /* and the composer's own state row, which is the one being
               looked at when it was reported */
            const sc = document.getElementById("session-cost");
            sc.classList.remove("hidden"); sc.innerText = "session $0.42";
            const cc = document.getElementById("composer-cost");
            cc.classList.remove("hidden");
            cc.innerHTML = "<b>glm-4</b> · <b>412</b> tok · <b>$0.004</b> to send";
            /* EVERY VISIBLE LEAF, not a list of suspects.
             * A report described "stopped" wrapping as "stop / ped", and the
             * container could not be found by reading. A list of guesses can
             * only confirm the guesses; this walks the whole painted document
             * in the stop states and reports anything that breaks a word. */
            const broken = [];
            let seen = 0;
            for (const el of document.querySelectorAll("*")) {
              if (el.children.length) continue;            /* leaves only */
              if (!window.__h.visible(el)) continue;
              const t = (el.innerText || "").trim();
              if (!t) continue;
              seen++;
              const b = window.__h.midWordBreak(el);
              if (b) broken.push({
                where: el.id || el.className || el.tagName,
                text: t.slice(0, 60), at: b.word,
                w: Math.round(el.getBoundingClientRect().width)
              });
            }
            return { broken, seen };
        })()`);
        observe("wraps", "visible text elements measured", m.seen);
        check("wraps", "NO READOUT BREAKS A WORD ACROSS TWO LINES. 'the stop button's " +
            "container is too small, so “stopped” wraps mid-word as stop / ped' — every " +
            "stop-bearing surface driven into its stop state and measured with a Range " +
            "over the text, one character at a time",
            m.broken.length === 0, m.broken);

        /* AND AT A NARROWER WINDOW, because "the container is too small" is a
         * function of the window and 1440 may simply not be the width he had. */
        win.setSize(1024, 720);
        await wait(500);
        const narrow = await js(`(() => {
            const broken = []; let seen = 0;
            for (const el of document.querySelectorAll("*")) {
              if (el.children.length) continue;
              if (!window.__h.visible(el)) continue;
              const t = (el.innerText || "").trim();
              if (!t) continue;
              seen++;
              const b = window.__h.midWordBreak(el);
              if (b) broken.push({ where: el.id || el.className || el.tagName,
                                   text: t.slice(0, 60), at: b.word,
                                   w: Math.round(el.getBoundingClientRect().width) });
            }
            return { broken, seen };
        })()`);
        observe("wraps", "visible text elements measured at 1024x720", narrow.seen);
        check("wraps", "...and none of them breaks at 1024x720 either, which is where a " +
            "container too small for its own word would show up first",
            narrow.broken.length === 0, narrow.broken);

        /* THE LIVENESS NEVER SCROLLS AWAY — "you keep the thinking portion at
         * the top ... you have no idea the thing is thinking until you scroll
         * all the way up." The head is sticky with its own opaque ground, and
         * the bubble the head belongs to STAYS LAST as live tool rows land. */
        const live = await js(`(() => {
            const head = document.querySelector(".msg-typing .typing-head");
            const cs = head ? getComputedStyle(head) : null;
            const bubble = document.querySelector(".msg-typing");
            // simulate a landed tool row, then run the keep-last re-append the
            // live tool-done path performs
            const row = document.createElement("div");
            row.className = "msg-tool work-row live-row";
            chat.appendChild(row);
            const t = chat.querySelector(".msg-typing");
            if (t) chat.appendChild(t);
            const stillLast = chat.lastElementChild === bubble;
            row.remove();
            return { sticky: cs ? cs.position : "none",
                     opaque: cs ? cs.backgroundColor : "",
                     stillLast };
        })()`);
        check("wraps", "THE THINKING HEAD IS STICKY with its own opaque ground, and the " +
            "bubble returns to LAST place after a live tool row lands — the liveness " +
            "(dots, phase, timer) can never be buried above a long turn's output",
            live.sticky === "sticky" && live.stillLast
            && live.opaque !== "rgba(0, 0, 0, 0)" && live.opaque !== "transparent",
            live);
        await shoot(win, "wraps");
        win.setSize(1440, 900);
        await wait(400);
        await js(`(() => {
            document.getElementById("terminal").classList.add("hidden");
            document.querySelectorAll(".msg-typing").forEach(e => e.remove());
            document.getElementById("session-cost").classList.add("hidden");
            document.getElementById("composer-cost").classList.add("hidden");
            toggleWorkspace(false);
        })()`);
    },

    /* ITEM 6. Nothing on screen may read "undefined" or "NaN". */
    surfaces: async (win, js) => {
        const m = await js(`(() => {
            const bad = [];
            const walk = (root) => {
                for (const el of root.querySelectorAll("*")) {
                    if (!window.__h.visible(el)) continue;
                    if (el.children.length) continue;             /* leaves only */
                    const t = (el.innerText || "").trim();
                    if (!t) continue;
                    if (/\\b(undefined|NaN|\\[object Object\\])\\b/.test(t)) {
                        bad.push({ id: el.id || el.className, text: t.slice(0, 80) });
                    }
                }
            };
            walk(document);
            return {
                bad,
                title: document.getElementById("session-title").innerText,
                mem: document.getElementById("mem-text").innerText,
                engine: document.getElementById("engine-label").innerText
            };
        })()`);
        observe("surfaces", "session title", m.title);
        observe("surfaces", "memory line", m.mem);
        check("surfaces", "NOTHING VISIBLE READS 'undefined', 'NaN' OR '[object Object]'",
            m.bad.length === 0, m.bad);
        check("surfaces", "the session title is a title, not the string 'undefined' — " +
            "`active ? active.title : '.lcl'` prints the word when the field is absent, " +
            "which the session LIST has always guarded against and the header never did",
            m.title && m.title !== "undefined", m.title);
    },

    /* CONTRACT K3 — the approval prompt. main.js holds the turn and asks; if
     * nothing answers, the turn dies on a 120s timeout. It is a POPUP at the
     * composer now — "a pop up, that appears near the chat input, and goes
     * away when clicked" — one at a time, queued behind, with a one-line
     * receipt left in the transcript once answered. */
    approval: async (win, js) => {
        const m = await js(`(async () => {
            window.lcl.__fire("onRemoteApproval", {
                id: "ap-1", model: "deepseek-ai/DeepSeek-V4",
                endpoint: "api.deepinfra.com",
                destination: { kind: "vendor", label: "api.deepinfra.com" },
                estCostUsd: 0.0123, estCostKnown: true, estInputTokens: 4120
            });
            await new Promise(r => setTimeout(r, 200));
            const card = document.querySelector(".perm-prompt.remote");
            const layer = document.getElementById("perm-popup-layer");
            const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
                return { w: Math.round(b.width), h: Math.round(b.height),
                         top: Math.round(b.top), bottom: Math.round(b.bottom) }; };
            const composerRect = r(document.getElementById("composer"));
            return {
                card: !!card,
                inPopup: !!(card && layer && layer.contains(card)),
                inTranscript: !!(card && document.getElementById("chat").contains(card)),
                modalUp: !document.getElementById("modal-scrim").classList.contains("hidden"),
                txt: card ? card.innerText : "",
                rect: r(card), composerRect,
                copyBtn: !!(card && card.querySelector(".perm-prompt-head .icon-btn")),
                answers: card ? [...card.querySelectorAll("[data-answer-id]")]
                    .map(b => b.dataset.answerId) : [],
                pointer: !!(card && card.querySelector(".perm-prompt-where")),
                pointerText: card ? (card.querySelector(".perm-prompt-where-text") || {}).innerText || "" : ""
            };
        })()`);
        if (m.card) await shoot(win, "approval");
        check("approval", "CONTRACT K3 — a remote call raises a prompt. Without this half, " +
            "main.js holds every remote turn for 120 seconds and then denies it",
            m.card, m);
        check("approval", "...A POPUP AT THE COMPOSER, NOT A CHAT MESSAGE — it mounts in " +
            "#perm-popup-layer anchored to the input, sits ABOVE the composer, and is " +
            "neither a transcript card nor a modal ('it should be a pop up, that appears " +
            "near the chat input')",
            m.inPopup && !m.inTranscript && !m.modalUp
            && m.rect && m.composerRect && m.rect.bottom <= m.composerRect.top + 4, m);
        check("approval", "...it names the model and where it is going",
            /DeepSeek-V4/.test(m.txt) && /deepinfra/i.test(m.txt), m.txt);
        check("approval", "...and what it is estimated to cost, and how many tokens go with it",
            /\$0\.0/.test(m.txt) && /4,120 tokens/.test(m.txt), m.txt);
        check("approval", "...it offers once / this conversation / deny, and NO " +
            "app-wide answer: 'trust' is a real per-conversation verdict main " +
            "persists on the session record, and nothing on a card may widen a " +
            "grant past the conversation it was raised in",
            ["once", "trust", "deny"].every(a => m.answers.includes(a))
            && !m.answers.includes("always"), m.answers);
        check("approval", "...THE POINTER SENDS YOU TO Session › Permissions — where the " +
            "gate's controls live now — and the card is COPYABLE like every other message " +
            "('can not be copied via a copy button like most of the other messages')",
            m.pointer && /Session › Permissions/.test(m.pointerText) && m.copyBtn, m);

        const once = await js(`(async () => {
            const card = document.querySelector(".perm-prompt.remote");
            card.querySelector('[data-answer-id="once"]').click();
            await new Promise(r => setTimeout(r, 150));
            const answers = (window.lcl.__calls || [])
                .filter(c => c.key === "answerRemoteApproval");
            const out = { verdict: answers[answers.length - 1].args,
                     state: card.querySelector(".perm-prompt-state").innerText,
                     disabled: [...card.querySelectorAll("[data-answer-id]")]
                        .every(b => b.disabled) };
            // ...and it GOES AWAY, leaving a one-line receipt in the transcript
            await new Promise(r => setTimeout(r, 1900));
            out.dismissed = !document.getElementById("perm-popup-layer").firstChild;
            const rec = [...document.querySelectorAll("#chat .perm-receipt")].pop();
            out.receipt = rec ? rec.innerText : "";
            return out;
        })()`);
        check("approval", "...answering 'once' really calls answerRemoteApproval with that " +
            "verdict", once.verdict && once.verdict[1] === "once", once);
        check("approval", "...and says what it did, and cannot be answered twice",
            /once/i.test(once.state) && once.disabled, once);
        check("approval", "...THEN GOES AWAY — the popup dismisses itself after answering, " +
            "and the transcript keeps a one-line receipt instead of the whole card",
            once.dismissed && /sent once/i.test(once.receipt), once);

        /* THE SESSION-SCOPED ANSWER — now the 'trust' verdict. The requirement
         * was "enable or trust" without a dropdown, and per session.
         * 'trust' answers main with a real verdict main persists on the session's
         * trustedEndpoints, so the ask does not return next turn and survives a
         * reload — the old "session" answer kept a renderer Map and sent "once",
         * which a reload lost. */
        const trust = await js(`(async () => {
            window.lcl.__fire("onRemoteApproval", {
                id: "ap-2", model: "deepseek-ai/DeepSeek-V4",
                endpoint: "api.deepinfra.com",
                destination: { kind: "vendor", label: "api.deepinfra.com" },
                estCostUsd: 0.0123, estCostKnown: true, estInputTokens: 4120
            });
            await new Promise(r => setTimeout(r, 150));
            const cards = [...document.querySelectorAll(".perm-prompt.remote")];
            const card = cards[cards.length - 1];
            const before = (window.lcl.__calls || [])
                .filter(c => c.key === "answerRemoteApproval").length;
            card.querySelector('[data-answer-id="trust"]').click();
            await new Promise(r => setTimeout(r, 150));
            const calls = (window.lcl.__calls || [])
                .filter(c => c.key === "answerRemoteApproval");
            return {
                state: card.querySelector(".perm-prompt-state").innerText,
                verdict: calls[calls.length - 1].args,
                answered: calls.length - before,
                policyWrites: (window.lcl.__calls || [])
                    .filter(c => c.key === "setToolPolicy" || c.key === "setBehavior").length
            };
        })()`);
        check("approval", "'ALLOW FOR THIS CONVERSATION' ANSWERS main WITH THE 'trust' VERDICT — " +
            "a per-session grant main persists on the session record, not a renderer trick a " +
            "reload forgets", trust.answered === 1 && trust.verdict && trust.verdict[1] === "trust", trust);
        check("approval", "...and it SAYS it is for this conversation, on the card",
            /this conversation/i.test(trust.state), trust.state);
        check("approval", "...and it wrote NOTHING app-wide: a per-session trust that quietly " +
            "edits the global policy is the defect, not the feature",
            trust.policyWrites === 0, trust);

        /* a machine the user owns is not the same decision as a paid API */
        const node = await js(`(async () => {
            // the popup shows ONE ask at a time — wait out the trust card's
            // dismissal so this fire mounts instead of queueing behind it
            for (let i = 0; i < 30 &&
                 document.getElementById("perm-popup-layer").firstChild; i++) {
                await new Promise(r => setTimeout(r, 100));
            }
            window.lcl.__fire("onRemoteApproval", {
                id: "ap-4", model: "mistral-large:q6_K", endpoint: "spark",
                destination: { kind: "your-machine", label: "spark" },
                estCostUsd: 0, estCostKnown: true, estInputTokens: 900, localNode: true
            });
            await new Promise(r => setTimeout(r, 200));
            const cards = [...document.querySelectorAll(".perm-prompt.remote")];
            const card = cards[cards.length - 1];
            const out = { txt: card.innerText };
            card.querySelector('[data-answer-id="deny"]').click();
            await new Promise(r => setTimeout(r, 150));
            const answers = (window.lcl.__calls || [])
                .filter(c => c.key === "answerRemoteApproval");
            out.last = answers[answers.length - 1].args;
            out.state = card.querySelector(".perm-prompt-state").innerText;
            return out;
        })()`);
        check("approval", "A CALL TO YOUR OWN MACHINE IS NOT DRESSED AS A PURCHASE — the " +
            "card reads destination.kind, so a node says it is your hardware and free",
            /your machine|your own hardware/i.test(node.txt) && /spark/.test(node.txt), node);
        check("approval", "...and Deny answers deny, and says nothing was sent",
            node.last && node.last[1] === "deny" && /nothing was sent/i.test(node.state), node);

        /* THE CARD DIES WITH THE QUESTION. main settles its own ask on the
         * 120s timeout or Stop; without a withdraw channel the card floated on
         * with live buttons, blocked every later ask behind it, and answering
         * it later printed "sent once" for a turn denied minutes ago. */
        const withdraw = await js(`(async () => {
            for (let i = 0; i < 40 &&
                 document.getElementById("perm-popup-layer").firstChild; i++) {
                await new Promise(r => setTimeout(r, 100));
            }
            for (let i = 0; i < 30 &&
                 document.getElementById("perm-popup-layer").firstChild; i++) {
                await new Promise(r => setTimeout(r, 100));
            }
            window.lcl.__fire("onRemoteApproval", {
                id: "ap-5", sessionId: active.id, model: "m1", endpoint: "api.deepinfra.com",
                destination: { kind: "vendor", label: "api.deepinfra.com" },
                estCostUsd: 0.01, estCostKnown: true, estInputTokens: 100
            });
            await new Promise(r => setTimeout(r, 200));
            const up = !!document.getElementById("perm-popup-layer").firstChild;
            // a SECOND ask arrives and queues behind it
            window.lcl.__fire("onRemoteApproval", {
                id: "ap-6", sessionId: active.id, model: "m2", endpoint: "api.deepinfra.com",
                destination: { kind: "vendor", label: "api.deepinfra.com" },
                estCostUsd: 0.02, estCostKnown: true, estInputTokens: 200
            });
            await new Promise(r => setTimeout(r, 150));
            // main times the FIRST one out
            window.lcl.__fire("onRemoteApprovalWithdrawn", { id: "ap-5", reason: "timeout" });
            await new Promise(r => setTimeout(r, 200));
            const card = document.getElementById("perm-popup-layer").firstChild;
            const out = {
                up,
                state: card ? (card.querySelector(".perm-prompt-state") || {}).innerText || "" : "",
                allDisabled: card ? [...card.querySelectorAll("[data-answer-id]")]
                    .every(b => b.disabled) : false
            };
            // ...and the QUEUE drains: the second ask gets its turn
            await new Promise(r => setTimeout(r, 1700));
            const now = document.getElementById("perm-popup-layer").firstChild;
            out.secondShown = !!(now && now.dataset.approvalId === "ap-6");
            if (now) { now.querySelector('[data-answer-id="deny"]').click();
                       await new Promise(r => setTimeout(r, 1700)); }
            out.clear = !document.getElementById("perm-popup-layer").firstChild;
            return out;
        })()`);
        check("approval", "AN UNANSWERED ASK IS WITHDRAWN, NOT LEFT FLOATING — main's " +
            "timeout reaches the renderer, the card says it expired and nothing was " +
            "sent, and its buttons go dead so a later click cannot print a false " +
            "'sent once' receipt for a turn already denied",
            withdraw.up && /expired|nothing was sent/i.test(withdraw.state)
            && withdraw.allDisabled, withdraw);
        check("approval", "...and the QUEUE DRAINS behind it — the next ask is shown " +
            "instead of being buried forever behind a corpse",
            withdraw.secondShown && withdraw.clear, withdraw);

        /* THE POPUP DOES NOT OWN THE KEYBOARD WHEN A SHEET IS OVER IT. The
         * card's own pointer opens Permissions, and showModal focuses its
         * Close button — Enter there used to click the card's PRIMARY answer,
         * approving a paid send the operator was still inspecting. */
        const keys = await js(`(async () => {
            for (let i = 0; i < 40 &&
                 document.getElementById("perm-popup-layer").firstChild; i++) {
                await new Promise(r => setTimeout(r, 100));
            }
            window.lcl.__fire("onRemoteApproval", {
                id: "ap-7", sessionId: active.id, model: "m3", endpoint: "api.deepinfra.com",
                destination: { kind: "vendor", label: "api.deepinfra.com" },
                estCostUsd: 0.03, estCostKnown: true, estInputTokens: 300
            });
            await new Promise(r => setTimeout(r, 200));
            const card = document.getElementById("perm-popup-layer").firstChild;
            const before = (window.lcl.__calls || [])
                .filter(c => c.key === "answerRemoteApproval").length;
            // a modal opens over the card (its own pointer does exactly this)
            openSessionPerms();
            await new Promise(r => setTimeout(r, 400));
            const scrimUp = !document.getElementById("modal-scrim").classList.contains("hidden");
            document.activeElement.dispatchEvent(new KeyboardEvent("keydown",
                { key: "Enter", bubbles: true }));
            document.activeElement.dispatchEvent(new KeyboardEvent("keydown",
                { key: "Escape", bubbles: true }));
            await new Promise(r => setTimeout(r, 200));
            const after = (window.lcl.__calls || [])
                .filter(c => c.key === "answerRemoteApproval").length;
            const out = { scrimUp, answeredWhileCovered: after - before,
                          stillUp: !!document.getElementById("perm-popup-layer").firstChild };
            closeModal();
            await new Promise(r => setTimeout(r, 250));
            // with nothing over it, Esc is the card's own and denies
            document.body.dispatchEvent(new KeyboardEvent("keydown",
                { key: "Escape", bubbles: true }));
            await new Promise(r => setTimeout(r, 200));
            const calls = (window.lcl.__calls || [])
                .filter(c => c.key === "answerRemoteApproval");
            out.escVerdict = calls[calls.length - 1] ? calls[calls.length - 1].args[1] : null;
            for (let i = 0; i < 40 &&
                 document.getElementById("perm-popup-layer").firstChild; i++) {
                await new Promise(r => setTimeout(r, 100));
            }
            return out;
        })()`);
        check("approval", "A SHEET OVER THE CARD OWNS THE KEYBOARD — Enter and Escape " +
            "while the Permissions modal is up answer NOTHING: Enter used to click the " +
            "card's primary button, approving a paid send while the operator was " +
            "reading the gate they had just opened from that very card",
            keys.scrimUp && keys.answeredWhileCovered === 0 && keys.stillUp, keys);
        check("approval", "...and with nothing over it, Escape is the card's own and DENIES " +
            "(never approves)", keys.escVerdict === "deny", keys);

        /* A TRUSTED SEND STILL SHOWS ITSELF — main stops asking once the
         * conversation trusts the endpoint, so the only per-send record left
         * is this quiet line, and the revoke on it must be the REAL one. */
        const trusted = await js(`(async () => {
            for (let i = 0; i < 40 &&
                 document.getElementById("perm-popup-layer").firstChild; i++) {
                await new Promise(r => setTimeout(r, 100));
            }
            const before = document.querySelectorAll("#chat .perm-auto-chip").length;
            window.lcl.__fire("onRemoteSendAllowed", {
                sessionId: active.id, model: "m9", endpoint: "api.deepinfra.com",
                endpointId: "api-api.deepinfra.com-v1-openai",
                destination: { kind: "vendor", label: "api.deepinfra.com" }
            });
            await new Promise(r => setTimeout(r, 200));
            const chip = [...document.querySelectorAll("#chat .perm-auto-chip")].pop();
            const out = { added: document.querySelectorAll("#chat .perm-auto-chip").length - before,
                          txt: chip ? chip.innerText : "" };
            const undo = chip && chip.querySelector(".perm-auto-undo");
            if (undo) { undo.click(); await new Promise(r => setTimeout(r, 250)); }
            out.revoked = (window.lcl.__calls || [])
                .some(c => c.key === "revokeTrustedEndpoint");
            out.after = chip ? chip.innerText : "";
            return out;
        })()`);
        check("approval", "A TRUSTED SEND LEAVES A LINE — once the ask stops appearing, " +
            "every send still says it left the machine (the old chip path was " +
            "unreachable dead code, so trusted sends were silent)",
            trusted.added === 1 && /sent to api\.deepinfra\.com/i.test(trusted.txt)
            && /allowed for this conversation/i.test(trusted.txt), trusted);
        check("approval", "...and its 'stop allowing' calls the REAL revoke — the session " +
            "record's trustedEndpoints, not a renderer map a reload forgets",
            trusted.revoked && /will ask/i.test(trusted.after), trusted);
    },

    /* THE CARD BELONGS TO THE CONVERSATION THAT ASKED. The popup layer lives
     * in #composer, which is shared across sessions and never re-rendered —
     * so without this, session A's ask floated over session B, its receipt
     * landed in B's transcript, and B's own asks queued behind it. */
    "approval-session": async (win, js) => {
        const r = await js(`(async () => {
            const before = window.__errors.length;
            const S = window.__harness.SESSIONS;
            const a = S[0].id, b = S[1].id;
            await switchSession(a);
            await new Promise(r => setTimeout(r, 200));
            window.lcl.__fire("onRemoteApproval", {
                id: "aps-1", sessionId: a, model: "mA", endpoint: "api.deepinfra.com",
                destination: { kind: "vendor", label: "api.deepinfra.com" },
                estCostUsd: 0.01, estCostKnown: true, estInputTokens: 100
            });
            await new Promise(r => setTimeout(r, 250));
            const mountedForA = !!document.getElementById("perm-popup-layer").firstChild;
            await switchSession(b);
            await new Promise(r => setTimeout(r, 300));
            const stillOverB = !!document.getElementById("perm-popup-layer").firstChild;
            // B raises its OWN ask — it must be shown, not buried behind A's
            window.lcl.__fire("onRemoteApproval", {
                id: "aps-2", sessionId: b, model: "mB", endpoint: "api.deepinfra.com",
                destination: { kind: "vendor", label: "api.deepinfra.com" },
                estCostUsd: 0.02, estCostKnown: true, estInputTokens: 200
            });
            await new Promise(r => setTimeout(r, 250));
            const now = document.getElementById("perm-popup-layer").firstChild;
            const out = { mountedForA, stillOverB,
                          showing: now ? now.dataset.approvalId : null,
                          errs: window.__errors.slice(before) };
            // answering B's card writes B's receipt into B's transcript
            if (now) { now.querySelector('[data-answer-id="deny"]').click();
                       await new Promise(r => setTimeout(r, 1700)); }
            out.receiptHere = [...document.querySelectorAll("#chat .perm-receipt")].length;
            // returning to A brings A's card back
            await switchSession(a);
            await new Promise(r => setTimeout(r, 350));
            const back = document.getElementById("perm-popup-layer").firstChild;
            out.backForA = back ? back.dataset.approvalId : null;
            // leave the layer clean — a card left floating belongs to no scene
            // but lands on every one that follows
            if (back) { back.querySelector('[data-answer-id="deny"]').click(); }
            for (let i = 0; i < 40 &&
                 document.getElementById("perm-popup-layer").firstChild; i++) {
                await new Promise(r => setTimeout(r, 100));
            }
            out.clean = !document.getElementById("perm-popup-layer").firstChild;
            return out;
        })()`);
        check("approval-session", "A CARD FOR ANOTHER CONVERSATION DOES NOT FLOAT OVER " +
            "THIS ONE — switching away un-mounts session A's ask instead of leaving it " +
            "over B's composer, where answering it acts on a conversation the operator " +
            "is not looking at",
            r.mountedForA && !r.stillOverB && r.errs.length === 0, r);
        check("approval-session", "...and B's OWN ask is shown rather than buried behind " +
            "A's, with its receipt landing in B's transcript",
            r.showing === "aps-2" && r.receiptHere >= 1, r);
        check("approval-session", "...and A's ask comes back when A is opened again — " +
            "held, not lost", r.backForA === "aps-1", r);
        await shoot(win, "approval-session");
    },

    /* ITEM 1 — THE BAR IS SPLIT BY SCOPE. Each menu is opened for real and its
     * rows read off the live DOM, then every action is checked against what it
     * actually writes. A menu item in the wrong menu is the defect; a menu item
     * that vanished in the move is a worse one. */
    menus: async (win, js) => {
        const m = await js(`(() => {
            const read = (name) => {
                const menu = document.querySelector('.menu[data-menu="' + name + '"]');
                if (!menu) return null;
                menu.querySelector(".menu-label").click();
                const panel = menu.querySelector(".menu-panel");
                const cs = getComputedStyle(panel);
                const r = panel.getBoundingClientRect();
                return {
                    open: cs.display !== "none",
                    actions: [...panel.querySelectorAll("button[data-action]")]
                        .map(b => b.dataset.action),
                    heads: [...panel.querySelectorAll(".menu-head")].map(h => h.innerText),
                    note: (panel.querySelector(".menu-note") || {}).innerText || "",
                    /* it has to be ON SCREEN: a panel that runs off the bottom
                       of the window is a menu whose last items do not exist */
                    fits: r.bottom <= window.innerHeight + 1,
                    rect: { top: Math.round(r.top), bottom: Math.round(r.bottom),
                            h: Math.round(r.height) }
                };
            };
            const out = {};
            for (const n of ["file", "session", "global", "window", "you", "train",
                             "knowledge", "patch", "help"]) out[n] = read(n);
            out.labels = [...document.querySelectorAll("#menubar .menu-label")]
                .map(b => b.innerText);
            out.allActions = [...document.querySelectorAll(".menu-panel button[data-action]")]
                .map(b => b.dataset.action);
            document.body.click();
            return out;
        })()`);

        /* the Global menu open, so the screenshot shows the split */
        await js(`document.querySelector('.menu[data-menu="global"] .menu-label').click()`);
        await wait(120);
        await shoot(win, "menu-global");
        await js(`document.body.click();
                  document.querySelector('.menu[data-menu="session"] .menu-label').click()`);
        await wait(120);
        await shoot(win, "menu-session");
        await js(`document.body.click()`);

        check("menus", "THERE IS A SESSION MENU AND A GLOBAL MENU — 'you have global " +
            "settings intermingled with session settings'",
            m.labels.includes("Session") && m.labels.includes("Global"), m.labels);
        check("menus", "...and every one of them opens", ["file", "session", "global",
            "window", "train", "knowledge", "patch", "help"].every(n => m[n] && m[n].open),
            Object.keys(m).filter(k => m[k] && m[k].open === false));

        /* SCOPE, ITEM BY ITEM. Session holds exactly what writes the session
         * record; nothing app-wide may appear in it. */
        const SESSION = ["rename-session", "delete-session", "link-repo", "unlink-repo",
                         "link-knowledge", "session-perms", "escalation",
                         "ancient-knowledge", "answer-like", "scroll-bottom"];
        check("menus", "SESSION HOLDS EVERY SESSION-SCOPED ITEM: rename, delete, the linked " +
            "workspace folder, the knowledge linked to this conversation, this conversation's " +
            "permissions, its API fallback, its Ancient Knowledge audit AGENT, and jump-to-latest",
            SESSION.every(a => m.session.actions.includes(a)),
            { want: SESSION, got: m.session.actions });
        check("menus", "...AND NOTHING APP-WIDE. A global setting in the Session menu is the " +
            "confusion being fixed",
            m.session.actions.every(a => SESSION.includes(a)),
            m.session.actions.filter(a => !SESSION.includes(a)));
        check("menus", "...and it says so at the top, so the scope is read before the items",
            /this conversation only/i.test(m.session.note), m.session.note);

        const GLOBAL = // node-wizard retired from the menu: a machine is added
                        // from APIs & Connections, where the rest of its life is
                        ["models", "default-model",
                        "connections", "security", "machine", "spend",
                        // export-training LEFT Global for Train, beside its import
                        "focus-search"];
        check("menus", "GLOBAL HOLDS THE APP-WIDE MODEL AND MACHINE SETTINGS — the " +
            "endpoints, the preferred model, connections, this machine, spend, search " +
            "(the global internet switch is gone — internet is per-session)",
            GLOBAL.every(a => m.global.actions.includes(a)),
            { want: GLOBAL, got: m.global.actions });
        check("menus", "...AND NOTHING SESSION-SCOPED",
            m.global.actions.every(a => GLOBAL.includes(a)),
            m.global.actions.filter(a => !GLOBAL.includes(a)));
        check("menus", "...grouped under headings, because one long menu is a different kind " +
            "of unreadable", m.global.heads.length >= 2, m.global.heads);
        check("menus", "...and it FITS ON SCREEN — a panel running past the bottom of the " +
            "window is items that do not exist",
            m.global.fits, m.global.rect);

        // THE SPLIT GOES FURTHER THAN SESSION vs GLOBAL: window layout and the
        // personal settings became their own menus, so Global stopped being
        // eighteen rows of everything. Each new menu is checked the same way it
        // holds its own scope and nothing that belongs to another.
        const WINDOW = ["toggle-sidebar", "toggle-workspace", "toggle-terminal", "toggle-motion"];
        check("menus", "WINDOW HOLDS THE LAYOUT TOGGLES — sidebar, workspace, terminal, motion — " +
            "and only those",
            m.window && WINDOW.every(a => m.window.actions.includes(a)) &&
            m.window.actions.every(a => WINDOW.includes(a)),
            { want: WINDOW, got: m.window && m.window.actions });
        // "You" became TRAIN by requirement: profile, what .lcl has
        // learned (tone rides on that page), and Import + Export Training Data
        // as two NAMED items side by side — the import was buried inside a
        // page, the export was in a different menu.
        const TRAIN = ["profile", "learned", "import-training", "export-training"];
        check("menus", "TRAIN HOLDS THE LEARNING SURFACE — about you, what .lcl has " +
            "learned, and Import + Export Training Data as named items — and the " +
            "You menu is gone",
            m.train && TRAIN.every(a => m.train.actions.includes(a)) &&
            m.train.actions.every(a => TRAIN.includes(a)) && !m.you,
            { want: TRAIN, got: m.train && m.train.actions, you: m.you });

        check("menus", "'PATCH .LCL ITSELF' HAS ITS OWN DROPDOWN",
            m.patch && m.patch.actions.includes("patch-bay") &&
            m.labels.includes("Patch"), m.patch);
        check("menus", "...and THE PERMISSIONS MENU IS GONE — permissions are " +
            "session-scoped under Session › Permissions, and the capability panel " +
            "no longer lives under Knowledge either",
            !m.labels.includes("Permissions") &&
            m.session.actions.includes("session-perms") &&
            !m.knowledge.actions.includes("capabilities"), m.labels);
        check("menus", "THE PERMISSIONS PANEL IS OUT OF THE KNOWLEDGE MENU — 'the .lcl " +
            "permissions panel lives under the Knowledge dropdown, which makes no sense, " +
            "and http_fetch and web_search sit inside it'",
            m.knowledge.actions.every(a => a === "knowledge" || a === "code-shape"),
            m.knowledge.actions);
        // (the old "Permissions menu points at the session half" check retired
        // with the menu itself — there is no split left to point across)

        /* NOTHING WAS LOST IN THE MOVE. Every action the old bar carried is
         * still reachable from the new one. `read-knowledge` is the one
         * deliberate exception and it is named: two knowledge items became one. */
        // toggle-network was DELIBERATELY retired — internet is per-session
        // now — so it is not in this "nothing was lost" set; ancient-knowledge
        // moved from You to Session but is still present. Two deliberate
        // retirements: toggle-network (internet is per-session) and
        // capabilities (the Permissions menu is gone — the capability panel
        // survives via the command palette and the approval card's pointer,
        // and its dials live session-scoped in Session › Permissions).
        const BEFORE = ["new-session", "link-repo", "unlink-repo", "open-data", "quit",
            "rename-session", "delete-session", "focus-search", "toggle-sidebar",
            "toggle-workspace", "toggle-motion", "machine", "spend", "scroll-bottom",
            "knowledge", "code-shape", "models",
            // node-wizard is the THIRD deliberate retirement: the drop-down was
            // removed in favour of adding a local node. A machine is added from
            // APIs & Connections, where the rest of a machine's life already
            // happens — the menu item was a second door to one room.
            "default-model", "connections", "escalation", "security",
            // "tailoring" became two named pages under Train: "learned"
            // (tone + what .lcl has learned) and "import-training"
            "profile", "learned", "import-training", "export-training",
            "session-perms", "ancient-knowledge", "patch-bay", "about"];
        const lost = BEFORE.filter(a => !m.allActions.includes(a));
        check("menus", "NOT ONE ITEM WAS LOST IN THE MOVE except the three deliberate " +
            "retirements — every other action is still reachable",
            lost.length === 0, lost);
    },

    /* THE INLINE PERMISSION PROMPT — three answers, in place, session scoped,
     * with the pointer to where it is set for good. */
    "permission-prompt": async (win, js) => {
        const m = await js(`(async () => {
            const card = addToolApprovalCard({
                id: "p-1", sessionId: "s1", tool: "http_fetch",
                classification: "network",
                digest: "GET https://physics.nist.gov/codata2022.pdf",
                args: { url: "https://physics.nist.gov/codata2022.pdf" }
            });
            await new Promise(r => setTimeout(r, 120));
            scrollToBottom(true);
            const p = card.querySelector(".perm-prompt");
            const where = p.querySelector(".perm-prompt-where");
            const rect = (el) => { const b = el.getBoundingClientRect();
                return { w: Math.round(b.width), h: Math.round(b.height) }; };
            const cs = getComputedStyle(where);
            return {
                inline: !!p && document.getElementById("chat").contains(p),
                modalUp: !document.getElementById("modal-scrim").classList.contains("hidden"),
                answers: [...p.querySelectorAll("[data-answer-id]")].map(b => b.dataset.answerId),
                labels: [...p.querySelectorAll("[data-answer-id]")].map(b => b.innerText),
                subs: [...p.querySelectorAll(".perm-prompt-answer-sub")].map(s => s.innerText),
                digest: card.innerText,
                whereText: where.innerText,
                whereRect: rect(where),
                whereContrast: window.__h.contrast(where.querySelector(".perm-prompt-where-label")).ratio,
                whereBg: cs.backgroundColor,
                whereBorder: cs.borderTopColor,
                hasGoButton: !!where.querySelector(".perm-prompt-where-go")
            };
        })()`);
        await shoot(win, "permission-prompt");

        check("permission-prompt", "IT IS ASKED IN PLACE — a card in the transcript, not a " +
            "dropdown you have to know exists and not a modal over the work",
            m.inline && !m.modalUp, m);
        check("permission-prompt", "THREE ANSWERS: only this once · allow for this " +
            "conversation · deny — the answers select enable or trust, or allow, " +
            "or only this once",
            m.answers.join(",") === "once,session,deny", m);
        check("permission-prompt", "...each says what it costs you, because three identical " +
            "buttons are read as 'the middle one is probably fine'",
            m.subs.length === 3 && m.subs.every(s => s.trim().length > 8), m.subs);
        check("permission-prompt", "...and the card still says WHAT is being asked for",
            /http_fetch/.test(m.digest) && /nist\.gov/.test(m.digest), m.digest);
        check("permission-prompt", "THE POINTER IS LOUD — its own panel, its own border, " +
            "an uppercase label and a real button, made noticeable because most " +
            "people just click yes and do not read",
            m.hasGoButton && m.whereRect.h >= 60 &&
            m.whereBorder !== "rgba(0, 0, 0, 0)" && m.whereBg !== "rgba(0, 0, 0, 0)", m);
        check("permission-prompt", "...it names THIS SESSION's permissions, not the " +
            "app-wide panel — the reported regression, now fixed",
            /Session/.test(m.whereText) && /Permissions/.test(m.whereText) &&
            !/What \.lcl can do/.test(m.whereText), m.whereText);
        check("permission-prompt", "...and it is legible where it sits",
            m.whereContrast >= 4.5, m.whereContrast);

        /* THE POINTER IS NOT DECORATION, AND IT IS PER SESSION. It opens THIS
           conversation's Permissions sheet (a modal), never the app-wide panel.
           This scene used to assert the opposite and — worse — clicked the
           button, opened a modal, and never closed it: that leaked modal failed
           eleven downstream scenes. It closes it now. */
        const opened = await js(`(async () => {
            const p = document.querySelector(".perm-prompt.capability");
            p.querySelector(".perm-prompt-where-go").click();
            await new Promise(r => setTimeout(r, 500));
            const out = {
                open: !document.getElementById("modal-scrim").classList.contains("hidden"),
                title: (document.getElementById("modal-title") || {}).innerText || "",
                hasTools: /Tools/.test(
                    (document.getElementById("modal-body") || {}).innerText || ""),
                // the GLOBAL panel must stay shut — that is the whole point
                globalShut: document.getElementById("cap-scrim").classList.contains("hidden"),
                errs: window.__errors.slice(-2)
            };
            closeModal();
            await new Promise(r => setTimeout(r, 200));
            out.closed = document.getElementById("modal-scrim").classList.contains("hidden");
            return out;
        })()`);
        check("permission-prompt", "...and the button opens THIS SESSION's Permissions " +
            "(a modal), NOT the app-wide panel — and the scene closes it so it does " +
            "not leak into the next one",
            opened.open && /Permissions/.test(opened.title) &&
            opened.globalShut && opened.closed, opened);

        /* ANSWER 1: only this once. Approves, remembers nothing. */
        const once = await js(`(async () => {
            const p = document.querySelector(".perm-prompt.capability");
            p.querySelector('[data-answer-id="once"]').click();
            await new Promise(r => setTimeout(r, 150));
            return {
                approved: (window.lcl.__calls || []).filter(c => c.key === "approveTool").length,
                state: p.querySelector(".perm-prompt-state").innerText,
                policyWrites: (window.lcl.__calls || [])
                    .filter(c => c.key === "setToolPolicy").length
            };
        })()`);
        check("permission-prompt", "'ONLY THIS ONCE' RUNS IT AND CHANGES NOTHING — it calls " +
            "approveTool and writes no policy anywhere",
            once.approved === 1 && once.policyWrites === 0 &&
            /nothing was changed/i.test(once.state), once);

        /* ANSWER 2: for this conversation. The next request is not asked. */
        const sess = await js(`(async () => {
            const c2 = addToolApprovalCard({ id: "p-2", sessionId: "s1", tool: "web_search",
                classification: "network", digest: "search: fixer bath exhaustion",
                args: { q: "fixer bath exhaustion" } });
            await new Promise(r => setTimeout(r, 100));
            const p2 = c2.querySelector(".perm-prompt");
            p2.querySelector('[data-answer-id="session"]').click();
            await new Promise(r => setTimeout(r, 150));
            const state = p2.querySelector(".perm-prompt-state").innerText;

            const c3 = addToolApprovalCard({ id: "p-3", sessionId: "s1", tool: "web_search",
                classification: "network", digest: "search: stop bath dilution",
                args: { q: "stop bath dilution" } });
            await new Promise(r => setTimeout(r, 150));
            const p3 = c3.querySelector(".perm-prompt");
            scrollToBottom(true);
            return {
                state,
                live: [...p3.querySelectorAll("[data-answer-id]")].filter(b => !b.disabled).length,
                auto: p3.classList.contains("auto"),
                autoText: p3.innerText,
                undo: !!p3.querySelector(".perm-prompt-state button"),
                approved: (window.lcl.__calls || []).filter(c => c.key === "approveTool").length,
                policyWrites: (window.lcl.__calls || [])
                    .filter(c => c.key === "setToolPolicy").length,
                /* A DIFFERENT SESSION MUST NOT INHERIT IT. */
                otherSession: (() => {
                    const c4 = addToolApprovalCard({ id: "p-4", sessionId: "s2",
                        tool: "web_search", classification: "network",
                        digest: "search: paper grade", args: {} });
                    const p4 = c4.querySelector(".perm-prompt");
                    return [...p4.querySelectorAll("[data-answer-id]")]
                        .filter(b => !b.disabled).length;
                })()
            };
        })()`);
        check("permission-prompt", "'ALLOW FOR THIS CONVERSATION' STOPS IT ASKING — the next " +
            "web_search in the same session is answered without a click",
            sess.live === 0 && sess.auto && sess.approved === 3, sess);
        check("permission-prompt", "...and it is SESSION SCOPED: it writes no app-wide policy, " +
            "and a different session is asked again from scratch",
            sess.policyWrites === 0 && sess.otherSession === 3, sess);
        check("permission-prompt", "...and the automatic answer is still DRAWN, with a way to " +
            "take it back — a permission that acts silently is one you forget you gave",
            /automatically/i.test(sess.autoText) && sess.undo, sess);

        /* ANSWER 3: deny. */
        const deny = await js(`(async () => {
            const c = addToolApprovalCard({ id: "p-5", sessionId: "s1", tool: "delete_file",
                classification: "destructive", digest: "delete notes/old-print-log.md",
                args: {}, target: { backupPossible: true } });
            await new Promise(r => setTimeout(r, 100));
            const p = c.querySelector(".perm-prompt");
            p.querySelector('[data-answer-id="deny"]').click();
            await new Promise(r => setTimeout(r, 150));
            return { rejected: (window.lcl.__calls || [])
                        .filter(x => x.key === "rejectTool").length,
                     state: p.querySelector(".perm-prompt-state").innerText };
        })()`);
        /* AND IT IS VISIBLE AFTERWARDS. A grant you cannot see is one you
         * forget you gave, which is the same rule the stored session
         * permissions already follow on this chip. */
        const chip = await js(`(async () => {
            await paintPermChip();
            await new Promise(r => setTimeout(r, 120));
            const el = document.getElementById("composer-perms");
            return { text: el.innerText,
                     marked: document.getElementById("session-perms-btn")
                        .classList.contains("granted") };
        })()`);
        check("permission-prompt", "...and the grant SHOWS on the composer's permission " +
            "readout, beside everything else this conversation is allowed",
            /web_search/.test(chip.text) && chip.marked, chip);

        /* ...AND IT CANNOT PUSH THE ROW APART. The readout now carries tool
         * names and hostnames of any length; measured with several grants on
         * at once rather than trusting the ellipsis rule to apply.
         *
         * MEASURED AT 1024, NOT AT 1440. The first cut of this check ran at the
         * default width, and it passed with `flex: none` deliberately put back
         * — four grants simply fit in a 1440px window, so the check proved
         * nothing. A layout check that only fails when the window is small has
         * to be run with the window small. */
        win.setSize(1024, 720);
        await wait(250);
        const room = await js(`(async () => {
            grantCapabilityForSession("s1", "http_fetch");
            grantCapabilityForSession("s1", "remote:api.someverylongendpointname.example.com");
            grantCapabilityForSession("s1", "generate_image");
            grantCapabilityForSession("s1", "run_script");
            grantCapabilityForSession("s1", "remote:spark.tailnet.internal");
            await paintPermChip();
            await new Promise(r => setTimeout(r, 150));
            const hint = document.getElementById("composer-hint");
            const el = document.getElementById("composer-perms");
            const h = hint.getBoundingClientRect(), e = el.getBoundingClientRect();
            revokeCapabilityForSession("s1", "http_fetch");
            revokeCapabilityForSession("s1", "remote:api.someverylongendpointname.example.com");
            revokeCapabilityForSession("s1", "generate_image");
            revokeCapabilityForSession("s1", "run_script");
            revokeCapabilityForSession("s1", "remote:spark.tailnet.internal");
            await paintPermChip();
            return { hintRight: Math.round(h.right), chipRight: Math.round(e.right),
                     scroll: hint.scrollWidth, client: hint.clientWidth };
        })()`);
        win.setSize(1440, 900);
        await wait(250);
        observe("permission-prompt", "hint row with six grants on, at 1024 wide", room);
        check("permission-prompt", "...and SIX grants at once do not push the hint row " +
            "out of the composer at 1024 wide — it ellipsises instead",
            room.chipRight <= room.hintRight + 1 && room.scroll <= room.client + 1, room);

        check("permission-prompt", "'DENY' REJECTS IT, and says nothing ran",
            deny.rejected === 1 && /denied|nothing ran/i.test(deny.state), deny);

        /* AN IRREVERSIBLE ACTION IS NEVER COVERED BY A STANDING GRANT. */
        const perm = await js(`(async () => {
            const c = addToolApprovalCard({ id: "p-6", sessionId: "s1", tool: "delete_file",
                classification: "destructive", digest: "delete scans/negatives.tif",
                args: {}, target: { backupPossible: false } });
            await new Promise(r => setTimeout(r, 100));
            const p = c.querySelector(".perm-prompt");
            return { answers: [...p.querySelectorAll("[data-answer-id]")]
                        .map(b => b.dataset.answerId),
                     txt: c.innerText };
        })()`);
        /* The whole-document wrap scan runs before this scene exists, so the
         * prompt carries its own: a card of dense short buttons is exactly the
         * shape that breaks a word in half ("stop / ped"). */
        const wrap = await js(`(() => {
            const bad = [];
            for (const el of document.querySelectorAll(".perm-prompt *")) {
                if (!window.__h.visible(el)) continue;
                const hit = window.__h.midWordBreak(el);
                if (hit) bad.push({ cls: el.className, word: hit.word });
            }
            return { bad, n: document.querySelectorAll(".perm-prompt *").length };
        })()`);
        check("permission-prompt", "...and nothing on the card breaks a word across two " +
            "lines, measured character by character with a Range",
            wrap.bad.length === 0 && wrap.n > 10, wrap);

        check("permission-prompt", "A DELETE THAT CANNOT BE UNDONE IS NEVER GRANTED FOR THE " +
            "WHOLE CONVERSATION — the session answer is withheld and the card says why, " +
            "instead of quietly offering two buttons where there were three",
            perm.answers.join(",") === "once,deny" && /PERMANENT/i.test(perm.txt) &&
            /asks every time/i.test(perm.txt), perm);
    },

    /* ONE KNOWLEDGE UI — CONTRACT K6. The shipped corpus and the added folders
     * in ONE list, real documents opening as themselves, a source that was
     * never downloaded saying exactly that, and extracted text never offered as
     * something to read. */
    knowledge: async (win, js) => {
        const m = await js(`(async () => {
            openKnowledge();
            await new Promise(r => setTimeout(r, 400));
            const scrim = document.getElementById("knowledge-scrim");
            const list = document.getElementById("kb-list");
            const groups = [...list.querySelectorAll(".kb-group")];
            for (const g of groups) g.querySelector(".kb-group-toggle").click();
            await new Promise(r => setTimeout(r, 100));
            return {
                open: !scrim.classList.contains("hidden"),
                panels: document.querySelectorAll("#knowledge-scrim, #shelf-scrim").length,
                groups: groups.map(g => ({
                    id: g.dataset.libraryId,
                    tag: g.querySelector(".kb-tag").innerText,
                    meta: g.querySelector(".kb-group-meta").innerText,
                    docs: [...g.querySelectorAll(".kb-doc")].map(d => ({
                        id: d.dataset.docId,
                        title: d.querySelector(".kb-doc-title").innerText,
                        state: d.querySelector(".kb-doc-state").innerText,
                        absent: d.classList.contains("absent")
                    }))
                })),
                text: list.innerText,
                /* THE IDS, NOT THE LABELS. A document's title never carries its
                 * path, so a list built from knowledge/text/*.txt reads exactly
                 * like a list built from the PDFs beside them — measured the
                 * hard way: the first cut of this check asserted on innerText,
                 * and it passed with the extraction leak deliberately put back. */
                docIds: [...list.querySelectorAll(".kb-doc")].map(d => d.dataset.docId),
                errs: window.__errors.slice(-3)
            };
        })()`);
        await shoot(win, "knowledge");

        check("knowledge", "THE KNOWLEDGE PANEL OPENS AND THREW NOTHING", m.open &&
            m.errs.length === 0, m.errs);
        check("knowledge", "ONE LIST HOLDS BOTH KINDS — what ships with .lcl and what the " +
            "user added, told apart by a tag rather than by living in two dropdowns",
            m.groups.length === 2 &&
            m.groups.some(g => /ships with/i.test(g.tag)) &&
            m.groups.some(g => /added by you/i.test(g.tag)), m.groups.map(g => g.tag));
        check("knowledge", "...and the shipped corpus lists its documents, not its subjects",
            m.groups[0].docs.length === 3, m.groups[0].docs);
        check("knowledge", "A DOCUMENT WHOSE SOURCE WAS NEVER DOWNLOADED IS STILL LISTED, " +
            "marked, and still says it is searchable — 'not on disk' was the whole of the " +
            "old answer",
            m.groups[0].docs.filter(d => d.absent).length === 2 &&
            m.groups[0].docs.some(d => /not installed · searchable/.test(d.state)),
            m.groups[0].docs);
        check("knowledge", "...and the library says the same thing in its own line",
            /1 of 3 installed/.test(m.groups[0].meta) &&
            /3 searchable/.test(m.groups[0].meta), m.groups[0].meta);
        check("knowledge", "EXTRACTED TEXT IS NOWHERE IN THE LIST — every row points at a " +
            "SOURCE document, not at the knowledge/text/*.txt the index was built from, " +
            "and 62 files of it are COUNTED so the corpus does not read as empty",
            m.docIds.every(id => !/(^|::|\/)text\//.test(id)) &&
            /62 extraction files \(search only\)/.test(m.text),
            { ids: m.docIds, text: m.text.slice(0, 200) });

        /* OPENING A REAL ONE. */
        const opened = await js(`(async () => {
            const d = document.querySelector('.kb-doc:not(.absent)');
            d.click();
            await new Promise(r => setTimeout(r, 300));
            const view = document.getElementById("kb-view");
            return { title: (view.querySelector(".kb-view-title") || {}).innerText || "",
                     pdf: !!view.querySelector("iframe.kb-pdf"),
                     src: (view.querySelector("iframe.kb-pdf") || {}).src || "",
                     inPanel: !!document.getElementById("kb-view").querySelector("*"),
                     modalUp: !document.getElementById("modal-scrim").classList.contains("hidden") };
        })()`);
        check("knowledge", "A REAL DOCUMENT OPENS AS ITSELF — the PDF goes to the viewer in " +
            "the reading pane, not to a second modal on top of the panel",
            opened.pdf && !opened.modalUp && /DOE/.test(opened.title), opened);

        /* THE ONE THAT WAS NEVER DOWNLOADED. */
        const fetchCard = await js(`(async () => {
            const rows = [...document.querySelectorAll('.kb-doc.absent')];
            rows[0].click();
            await new Promise(r => setTimeout(r, 300));
            const view = document.getElementById("kb-view");
            const card = view.querySelector(".kb-fetch");
            return { card: !!card, txt: card ? card.innerText : "",
                     buttons: card ? [...card.querySelectorAll("button")]
                        .map(b => b.innerText) : [],
                     notOnDisk: /not on disk/i.test(view.innerText) };
        })()`);
        await shoot(win, "knowledge-fetch");
        check("knowledge", "A SOURCE THAT WAS NEVER DOWNLOADED SAYS EXACTLY THAT, AND OFFERS " +
            "THE FETCH — never 'not on disk'",
            fetchCard.card && /not installed/i.test(fetchCard.txt) &&
            !fetchCard.notOnDisk &&
            fetchCard.buttons.some(b => /download/i.test(b)), fetchCard);
        check("knowledge", "...it names the URL it would come from, and says search still works",
            /nist\.gov/.test(fetchCard.txt) && /still indexed/i.test(fetchCard.txt),
            fetchCard.txt);

        /* ...AND THE ONE WITH NO URL RECORDED. A needsFetch with a null url is
         * the same shrug in a new coat, so it must not offer a dead button. */
        const noUrl = await js(`(async () => {
            const rows = [...document.querySelectorAll('.kb-doc.absent')];
            rows[1].click();
            await new Promise(r => setTimeout(r, 300));
            const card = document.querySelector("#kb-view .kb-fetch");
            return { txt: card ? card.innerText : "",
                     buttons: card ? [...card.querySelectorAll("button")].map(b => b.innerText) : [] };
        })()`);
        check("knowledge", "...and a document with NO recorded URL says so, and is not given " +
            "a Download button that could never work",
            /records no URL|cannot be downloaded/i.test(noUrl.txt) &&
            !noUrl.buttons.some(b => /download/i.test(b)), noUrl);

        /* EXTRACTED TEXT, ASKED FOR BY ID. The list never offers it; this is
         * the layer under the list refusing it out loud. */
        const refused = await js(`(async () => {
            await openKnowledgeDoc({ id: "builtin-knowledge::text/physics/x.txt",
                libraryId: "builtin-knowledge", file: "text/physics/x.txt",
                title: "x", searchBacked: true }, null);
            await new Promise(r => setTimeout(r, 200));
            return { txt: document.getElementById("kb-view").innerText };
        })()`);
        check("knowledge", "EXTRACTED TEXT IS REFUSED BY NAME even when asked for directly — " +
            "extracted text must not appear anywhere",
            /extracted text, not a document/i.test(refused.txt), refused.txt);

        /* THE FILTER, over the ONE list. */
        const filtered = await js(`(async () => {
            const f = document.getElementById("kb-filter");
            f.value = "fixer";
            f.dispatchEvent(new Event("input"));
            await new Promise(r => setTimeout(r, 100));
            const vis = [...document.querySelectorAll(".kb-doc")]
                .filter(d => !d.classList.contains("hidden")).map(d => d.innerText);
            const groups = [...document.querySelectorAll(".kb-group")]
                .filter(g => !g.classList.contains("hidden")).length;
            f.value = ""; f.dispatchEvent(new Event("input"));
            return { vis, groups };
        })()`);
        check("knowledge", "one filter searches the whole list, both layers at once",
            filtered.vis.length === 1 && /fixer/i.test(filtered.vis[0]) &&
            filtered.groups === 1, filtered);

        /* THE FALLBACK. K6 is main.js's half; a build where it has not landed
         * must still render its libraries rather than an empty panel. */
        const legacy = await js(`(async () => {
            window.__harness.k6 = false;
            await refreshKnowledge();
            await new Promise(r => setTimeout(r, 200));
            const groups = [...document.querySelectorAll(".kb-group")];
            const out = { count: groups.length,
                          tags: groups.map(g => g.querySelector(".kb-tag").innerText),
                          docs: [...document.querySelectorAll(".kb-doc")].length,
                          docIds: [...document.querySelectorAll(".kb-doc")]
                              .map(d => d.dataset.docId),
                          text: document.getElementById("kb-list").innerText };
            window.__harness.k6 = true;
            await refreshKnowledge();
            return out;
        })()`);
        check("knowledge", "WITHOUT K6 THE PANEL STILL WORKS — the same one list, assembled " +
            "from the two calls that existed before it, so this does not ship as a blank " +
            "panel on the day main.js has not caught up",
            legacy.count === 2 && legacy.docs > 0 &&
            legacy.tags.some(t => /ships with/i.test(t)) &&
            legacy.tags.some(t => /added by you/i.test(t)), legacy);
        check("knowledge", "...and it still never lists an extraction file. This is the " +
            "path where that is EASY to get wrong: the old shelf's built-in record names " +
            "both `file` (the .txt) and `source` (the PDF), and reaching for the wrong " +
            "one puts the extraction straight back in the list under a title that looks " +
            "identical",
            legacy.docIds.every(id => !/(^|::|\/)text\//.test(id)), legacy.docIds);

        /* the same wrap scan over the knowledge panel, for the same reason:
         * a 320px column of document titles is where a word gets halved */
        const wrap = await js(`(() => {
            const bad = [];
            for (const el of document.querySelectorAll("#knowledge-panel *")) {
                if (!window.__h.visible(el)) continue;
                const hit = window.__h.midWordBreak(el);
                if (hit) bad.push({ cls: el.className, word: hit.word });
            }
            return { bad, n: document.querySelectorAll("#knowledge-panel *").length };
        })()`);
        check("knowledge", "...and nothing in the panel breaks a word across two lines",
            wrap.bad.length === 0 && wrap.n > 20, wrap);

        /* DOWNLOAD ALL — the operator's ask: "the knowledge should download
         * with one button to download all, not just one of the knowledge
         * sources." One button on the SHIPPED shelf, fetching exactly the
         * missing-with-URL documents through the same approved handler as the
         * single download, and a tally that survives the panel re-render. */
        const dl = await js(`(async () => {
            if (window.__harness) delete window.__harness.k6;   // the normal K6 panel
            closeKnowledge(); openKnowledge();
            await new Promise(r => setTimeout(r, 300));
            const groups = [...document.querySelectorAll(".kb-group")];
            const shipped = groups.find(g => g.querySelector(".kb-tag.shipped"));
            const added = groups.find(g => g.querySelector(".kb-tag.added"));
            const btn = shipped && shipped.querySelector(".kb-fetch-all");
            const out = {
                onShipped: !!btn, label: btn ? btn.innerText : "",
                onAdded: !!(added && added.querySelector(".kb-fetch-all"))
            };
            if (!btn) return out;
            const badge = document.getElementById("kb-badge");
            out.badge = badge ? badge.innerText : "";
            out.badgeShown = !!badge && !badge.classList.contains("hidden");
            const before = (window.lcl.__calls || []).filter(c => c.key === "fetchKnowledgeSource").length;
            btn.click();
            await new Promise(r => setTimeout(r, 500));
            const calls = (window.lcl.__calls || []).filter(c => c.key === "fetchKnowledgeSource").slice(before);
            out.calls = calls.map(c => c.args[0]);
            out.approved = calls.every(c => c.args[1] && c.args[1].approved === true);
            const note = document.querySelector(".kb-fetch-all-note");
            out.note = note ? note.innerText : "";
            return out;
        })()`);
        check("knowledge", "DOWNLOAD ALL IS ONE BUTTON ON THE SHIPPED SHELF — and its " +
            "number is the FETCHABLE count, the downloads the click will start: the " +
            "fixture has 2 missing but only 1 with a URL, and the button says so " +
            "instead of promising two and attempting one. Never on a user's own folder",
            dl.onShipped && dl.label.includes("Download all (1)") && !dl.onAdded, dl);
        check("knowledge", "...THE BADGE PREFIXES THE KNOWLEDGE MENU with the same " +
            "fetchable number — sources in the list, not on this machine, visible " +
            "without opening anything",
            dl.badgeShown && dl.badge === "1", dl);
        check("knowledge", "...clicking it fetches ONLY the missing-with-URL documents, each " +
            "through the same approved handler as the single download — the on-disk one and " +
            "the URL-less one are skipped, not failed",
            Array.isArray(dl.calls) && dl.calls.length === 1
            && /CODATA/.test(String(dl.calls[0])) && dl.approved === true, dl);
        check("knowledge", "...and the tally is said in numbers and SURVIVES the re-render " +
            "the refresh performs",
            /1 downloaded/.test(dl.note), dl);

        /* CLOSING THE PANEL MUST NOT KILL THE RUN — measured: clicking outside
         * the container closed the knowledge UI and the batch died with it.
         * The batch is module-owned now; this starts one and slams the panel
         * shut mid-flight, then reopens to find the work finished. */
        const surv = await js(`(async () => {
            openKnowledge();
            await new Promise(r => setTimeout(r, 250));
            const btn = document.querySelector(".kb-fetch-all");
            if (!btn) return { started: false };
            const before = (window.lcl.__calls || []).filter(c => c.key === "fetchKnowledgeSource").length;
            btn.click();
            closeKnowledge();                        // mid-flight, immediately
            await new Promise(r => setTimeout(r, 700));
            const calls = (window.lcl.__calls || []).filter(c => c.key === "fetchKnowledgeSource").length - before;
            openKnowledge();
            await new Promise(r => setTimeout(r, 250));
            const note = document.querySelector(".kb-fetch-all-note");
            return { started: true, calls, note: note ? note.innerText : "" };
        })()`);
        check("knowledge", "CLOSING THE PANEL DOES NOT KILL THE BATCH — the run finishes " +
            "off-screen and its tally is waiting when the panel reopens",
            surv.started && surv.calls === 1 && /1 downloaded/.test(surv.note), surv);

        await js(`closeKnowledge()`);
    },

    /* A MACHINE NOTICE IS NOT AN ANSWER. engine.js tags memory refusals `guard`;
     * a transcript message carrying meta.guard must not be drawn as the model's
     * reply — "asked for an image of a donkey, got a refusal about closing apps
     * to free memory". */
    guard: async (win, js) => {
        const m = await js(`(() => {
            const row = addMessageRow("assistant",
                "The image was rendered and saved. The model could not be loaded " +
                "back afterwards to describe it: 6.1 GB free, 7.4 GB needed.", 2,
                { guard: true, guardKind: "memory" });
            const note = row.querySelector(".msg-guard");
            const bubble = row.querySelector(".msg-assistant");
            const r = note ? note.getBoundingClientRect() : null;
            scrollToBottom(true);
            return {
                drawnAsNotice: !!note,
                drawnAsAnswer: !!bubble,
                head: note ? note.querySelector(".msg-guard-head").innerText : "",
                contrast: note ? window.__h.contrast(note).ratio : 0,
                centred: !!row && getComputedStyle(note || row).alignSelf === "center",
                /* IT HAS TO BE ON SCREEN. A notice with no width is a notice
                 * nobody reads — and the first cut of this had exactly that,
                 * caught in the screenshot rather than by any of the checks. */
                painted: !!note && window.__h.visible(note),
                rect: r ? { w: Math.round(r.width), h: Math.round(r.height),
                            top: Math.round(r.top) } : null
            };
        })()`);
        check("guard", "A MEMORY REFUSAL IS DRAWN AS THE APP SPEAKING, in its own frame",
            m.drawnAsNotice, m);
        check("guard", "...and NOT as an assistant bubble, which is how a refusal about " +
            "closing apps ended up where the answer to a question belongs",
            !m.drawnAsAnswer, m);
        /* the head is uppercased by CSS, so the comparison is case-insensitive */
        check("guard", "...it says who is speaking and about what", /\.lcl/i.test(m.head)
            && /memory/i.test(m.head), m.head);
        check("guard", "...and it is legible", m.contrast >= 4.5, m);
        check("guard", "...and it actually PAINTS, with real width and height",
            m.painted && m.rect && m.rect.w > 200 && m.rect.h > 20, m);
        await wait(200);
        await shoot(win, "guard");
    },

    /* MANAGE MODELS — informational: one group per device, models in full.
     * The menu's "models" action lands here now. */
    models: async (win, js) => {
        const m = await js(`(async () => {
            const before = window.__errors.length;
            openModels();          // NOT awaited: modal() blocks until it closes
            await new Promise(r => setTimeout(r, 700));
            const scrim = document.getElementById("modal-scrim");
            const modalEl = document.getElementById("modal");
            const r = modalEl.getBoundingClientRect();
            const groups = [...document.querySelectorAll("#modal .mm-group")]
                .map(g => ({
                    title: (g.querySelector(".mm-title") || {}).innerText || "",
                    rows: g.querySelectorAll(".mm-row").length,
                    manage: !!g.querySelector(".mm-manage")
                }));
            return {
                open: !scrim.classList.contains("hidden"),
                title: document.getElementById("modal-title").innerText,
                xwide: modalEl.classList.contains("xwide"),
                width: Math.round(r.width),
                groups,
                says: (document.getElementById("modal") || {}).innerText || "",
                errs: window.__errors.slice(before)
            };
        })()`);
        check("models", "LOCAL MODELS OPENS, AND IS ABOUT THIS MACHINE",
            m.open && /local models/i.test(m.title) && m.errs.length === 0, m);
        check("models", "...and it does NOT list devices and their catalogues — " +
            "that is what a card in Connections shows, and having it twice is " +
            "the duplication this page was collapsed to remove",
            m.groups.length === 0, m.groups);
        check("models", "...it names the folder the files live in, so \"where " +
            "do I put one\" is answered on the page rather than guessed at",
            /models/i.test(m.says || "") , m.says);
        await shoot(win, "models");
        await js(`(() => { const b = document.getElementById("modal-confirm");
            if (b && !document.getElementById("modal-scrim").classList.contains("hidden")) b.click(); })()`);
    },

    /* ANCIENT KNOWLEDGE'S ENABLE GATE. The brain needs a linked workspace —
     * ancient_knowledge.md has to live somewhere — so enabling without one must
     * raise the link prompt, and declining must leave the brain honestly OFF.
     * Clicked for real, measured off the live DOM and the bridge call log. */
    /* A reported gap: questions could not be added while a model was thinking,
     * so the feature was not fully wired.
     *
     * Driven against the real composer, not asserted from the source: type
     * while a turn is in flight, and the message has to LAND somewhere the
     * user can see — then send itself when the turn ends. */
    queue: async (win, js) => {
        const typed = await js(`(async () => {
            active.ancientKnowledge = false;          // no AK to carry it
            pendingSessions.add(active.id);           // a turn is in flight
            setControls();
            const box = document.getElementById("composer-input");
            const lockedNow = box.disabled;
            box.value = "also check the auth middleware";
            await sendMessage();
            await new Promise(r => setTimeout(r, 80));
            const strip = document.getElementById("queued-strip");
            const rect = strip.getBoundingClientRect();
            const field = box.getBoundingClientRect();
            return {
                lockedNow,
                placeholder: box.placeholder,
                cleared: box.value === "",
                stripShown: !strip.classList.contains("hidden"),
                rows: strip.querySelectorAll(".queued-msg").length,
                text: strip.innerText,
                aboveTheField: rect.bottom <= field.top + 2,
                painted: rect.width > 0 && rect.height > 0,
                queuedCount: (queuedSends.get(active.id) || []).length
            };
        })()`);
        check("queue", "THE COMPOSER TAKES THE MESSAGE WHILE THE MODEL WORKS — it " +
            "locked with Ancient Knowledge off, which is exactly the state he was in",
            typed.lockedNow === false, typed);
        check("queue", "...and it says what will happen to it, in the field itself",
            /sends when this turn finishes/i.test(typed.placeholder), typed.placeholder);
        check("queue", "...and the message LANDS SOMEWHERE VISIBLE instead of vanishing " +
            "out of the box into nothing",
            typed.cleared && typed.stripShown && typed.rows === 1
            && /also check the auth middleware/.test(typed.text)
            && typed.queuedCount === 1, typed);
        check("queue", "...painted above the input, where the thing it is waiting on is",
            typed.painted && typed.aboveTheField, typed);
        await shoot(win, "queue-waiting");

        const revoked = await js(`(async () => {
            document.querySelector("#queued-strip .q-drop").click();
            await new Promise(r => setTimeout(r, 60));
            const strip = document.getElementById("queued-strip");
            return { hidden: strip.classList.contains("hidden"),
                     left: (queuedSends.get(active.id) || []).length,
                     backInBox: document.getElementById("composer-input").value };
        })()`);
        check("queue", "A QUEUED MESSAGE CAN BE TAKEN BACK before its turn comes",
            revoked.hidden && revoked.left === 0, revoked);
        check("queue", "...and taking it back returns the WORDS to the composer — ✕ means " +
            "\"not like that\", not \"throw away what I wrote\"",
            /also check the auth middleware/.test(revoked.backInBox), revoked);

        const drained = await js(`(async () => {
            document.getElementById("composer-input").value = "";
            queuedSends.set(active.id, ["first queued", "second queued"]);
            renderQueued();
            const two = document.querySelectorAll("#queued-strip .queued-msg").length;
            const ordered = document.getElementById("queued-strip").innerText;
            // The turn ends: pendingSessions clears, then the queue drains. The
            // real sendText is replaced so this measures WHAT WAS SENT AND IN
            // WHAT ORDER without a fixture turn racing the next drain.
            const sent = [];
            const realSend = window.sendText;
            window.sendText = (t) => { sent.push(t); return Promise.resolve(); };
            pendingSessions.delete(active.id);
            drainQueue(active.id);
            await new Promise(r => setTimeout(r, 60));
            const afterFirst = (queuedSends.get(active.id) || []).slice();
            drainQueue(active.id);
            await new Promise(r => setTimeout(r, 60));
            window.sendText = realSend;
            return { two, ordered, sent, afterFirst,
                     leftAtEnd: (queuedSends.get(active.id) || []).length };
        })()`);
        check("queue", "SEVERAL WAIT IN ORDER, each labelled with its place",
            drained.two === 2 && /queued 1/i.test(drained.ordered)
            && /queued 2/i.test(drained.ordered)
            && drained.ordered.indexOf("first queued") < drained.ordered.indexOf("second queued"),
            drained);
        check("queue", "...and when the turn ends the FIRST one goes first, leaving the " +
            "second still waiting — a delay in order, not a drawer things are " +
            "put in and forgotten",
            drained.sent[0] === "first queued"
            && drained.afterFirst.length === 1
            && drained.afterFirst[0] === "second queued", drained);
        check("queue", "...and the next turn ending takes the next one, until the strip " +
            "is empty",
            drained.sent.length === 2 && drained.sent[1] === "second queued"
            && drained.leftAtEnd === 0, drained);

        await js(`(() => { queuedSends.clear(); renderQueued();
                           pendingSessions.delete(active.id); setControls(); })()`);
    },

    /* "we have folders and such, and you have all items listed as full path,
     *  not as folders that can actually be clicked in to view. there should be
     *  a search function in this as well, to search through all the files by
     *  name" */
    explorer: async (win, js) => {
        const root = await js(`(async () => {
            active.repoPath = "D:/work/repo";
            toggleWorkspace(true);          // measure a panel that is actually painted
            renderWorkspace();
            await new Promise(r => setTimeout(r, 200));
            const rows = [...document.querySelectorAll("#ws-files .ws-file")];
            return {
                names: rows.map(r => r.querySelector(".nm").innerText),
                dirs: rows.filter(r => r.classList.contains("ws-dir"))
                          .map(r => r.querySelector(".nm").innerText),
                counts: rows.filter(r => r.classList.contains("ws-dir"))
                            .map(r => r.querySelector(".sz").innerText),
                anyFullPath: rows.some(r => r.querySelector(".nm").innerText.includes("/")),
                hasSearch: !!document.getElementById("ws-search")
            };
        })()`);
        check("explorer", "NOT ONE ROW IS A FULL PATH. Every entry used to be its whole " +
            "path — docs/codex/vendor/highlight.min.js — in one narrow column",
            root.anyFullPath === false, root);
        check("explorer", "...folders are folders, listed first, with what is inside them",
            root.dirs.join(",") === "docs,src"
            && root.counts.join(",") === "1 file,3 files", root);
        check("explorer", "...and the files at this level keep their own names",
            root.names.includes("ancient_knowledge.md")
            && root.names.includes("README.md"), root);
        check("explorer", "...and there is somewhere to search from", root.hasSearch, root);
        await shoot(win, "explorer-root");

        const walked = await js(`(async () => {
            [...document.querySelectorAll("#ws-files .ws-dir")]
                .find(r => r.querySelector(".nm").innerText === "src").click();
            await new Promise(r => setTimeout(r, 80));
            const rows = [...document.querySelectorAll("#ws-files .ws-file")];
            const crumbs = [...document.querySelectorAll(".ws-crumb")].map(c => c.innerText);
            return { cwd: wsCwd, crumbs,
                     names: rows.map(r => r.querySelector(".nm").innerText),
                     dirs: rows.filter(r => r.classList.contains("ws-dir"))
                               .map(r => r.querySelector(".nm").innerText) };
        })()`);
        check("explorer", "CLICKING A FOLDER WALKS INTO IT — index.js at this level, util " +
            "still a folder below it",
            walked.cwd === "src" && walked.names.includes("index.js")
            && walked.dirs.join(",") === "util"

            , walked);
        check("explorer", "...and the crumb trail says where you are and every way back",
            walked.crumbs.join("/") === "repo/src", walked);

        const deeper = await js(`(async () => {
            [...document.querySelectorAll("#ws-files .ws-dir")]
                .find(r => r.querySelector(".nm").innerText === "util").click();
            await new Promise(r => setTimeout(r, 80));
            const names = [...document.querySelectorAll("#ws-files .ws-file .nm")]
                .map(n => n.innerText);
            const crumbs = [...document.querySelectorAll(".ws-crumb")].map(c => c.innerText);
            // ...and back out by clicking the crumb, not by a hidden gesture
            [...document.querySelectorAll(".ws-crumb")]
                .find(c => c.innerText === "repo").click();
            await new Promise(r => setTimeout(r, 80));
            return { deepNames: names, crumbs, backTo: wsCwd,
                     backRows: [...document.querySelectorAll("#ws-files .ws-file .nm")]
                        .map(n => n.innerText) };
        })()`);
        check("explorer", "...and it nests as deep as the folder does",
            deeper.deepNames.join(",") === "format.js,parse.js"
            && deeper.crumbs.join("/") === "repo/src/util", deeper);
        check("explorer", "...and a crumb takes you straight back to the root",
            deeper.backTo === "" && deeper.backRows.includes("README.md"), deeper);
        await shoot(win, "explorer-nested");

        const found = await js(`(async () => {
            const box = document.getElementById("ws-search");
            box.value = "parse";
            box.dispatchEvent(new Event("input", { bubbles: true }));
            await new Promise(r => setTimeout(r, 80));
            const rows = [...document.querySelectorAll("#ws-files .ws-file .nm")]
                .map(n => n.innerText);
            const count = (document.querySelector(".ws-search-count") || {}).innerText || "";
            return { rows, count, fromRoot: wsCwd === "" };
        })()`);
        check("explorer", "SEARCH FINDS A FILE BY NAME from wherever you are standing, and " +
            "shows its path — a bare filename cannot tell four index.js apart",
            found.rows.length === 1 && found.rows[0] === "src/util/parse.js"
            && /1 file matching/.test(found.count), found);
        await shoot(win, "explorer-search");

        const escaped = await js(`(async () => {
            const box = document.getElementById("ws-search");
            box.value = "js";
            box.dispatchEvent(new Event("input", { bubbles: true }));
            await new Promise(r => setTimeout(r, 60));
            const many = [...document.querySelectorAll("#ws-files .ws-file .nm")]
                .map(n => n.innerText);
            box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await new Promise(r => setTimeout(r, 60));
            return { many, cleared: box.value,
                     backToTree: [...document.querySelectorAll("#ws-files .ws-dir .nm")]
                        .map(n => n.innerText) };
        })()`);
        check("explorer", "...and it searches the WHOLE folder, not the level you are on — " +
            "all four .js files, across three directories, found from the root",
            escaped.many.length === 4
            && escaped.many.includes("docs/codex/vendor/highlight.min.js")
            && escaped.many.includes("src/index.js"), escaped);
        check("explorer", "...and Escape puts the tree back rather than leaving the user " +
            "to select-all-delete their way out",
            escaped.cleared === "" && escaped.backToTree.join(",") === "docs,src", escaped);

        await js(`(() => { wsCwd = ""; wsFilter = "";
            const b = document.getElementById("ws-search"); if (b) b.value = "";
            delete active.repoPath; renderWorkspace(); })()`);
    },

    /* "right now, if activities or tasks start, and you have more items in
     *  the sidebar open, it is so compressed, you can not see that there are
     *  tasks or activities."
     *
     * Every module open, both feeds running — the state he described. What is
     * asserted is PAINTED GEOMETRY: how tall each module actually is, and
     * whether it fits in the panel. Measured before the fix, in a 702px panel:
     *
     *   tasks 175 · activity 199 · wscard 166 · files 80 · preview 87 = 707
     *
     * Three modules took 540px between them in DOM order and the file list was
     * left on its 80px floor — one row of one file. */
    sidebar: async (win, js) => {
        const m = await js(`(async () => {
            active.repoPath = "D:/work/repo";
            // wide enough for two READABLE columns — under 360px the dock
            // deliberately stacks one column instead of cropping text
            document.getElementById("body").style.setProperty("--ws-w", "720px");
            toggleWorkspace(true);
            renderWorkspace();
            await new Promise(r => setTimeout(r, 250));
            for (let i = 1; i <= 6; i++) {
                recordActivity(active.id, "tool", "▸ read_file", "src/index.js");
            }
            document.getElementById("task-panel").classList.remove("hidden");
            Array(4).fill(0).forEach(() => {
                const d = document.createElement("div");
                d.className = "task-row"; d.innerText = "building the thing";
                document.getElementById("task-list").appendChild(d);
            });
            openFileViewer("README.md");
            await new Promise(r => setTimeout(r, 400));
            const host = document.getElementById("sb-mods");
            const hr = host.getBoundingClientRect();
            const mods = {};
            for (const el of host.querySelectorAll(":scope > .sb-mod")) {
                const b = el.getBoundingClientRect();
                mods[el.dataset.mod] = {
                    h: Math.round(b.height), w: Math.round(b.width),
                    left: Math.round(b.left - hr.left),
                    top: Math.round(b.top - hr.top),
                    right: Math.round(b.right - hr.left),
                    bottom: Math.round(b.bottom - hr.top)
                };
            }
            return { panelH: Math.round(hr.height),
                     panelW: Math.round(hr.width),
                     mods };
        })()`);
        const M = m.mods;
        const open = Object.keys(M);
        check("sidebar", "ALL FIVE MODULES ARE OPEN — the state he was describing, not a " +
            "convenient subset",
            open.length === 5 && open.every(k => M[k].h > 0), m);
        check("sidebar", "THE QUADRANT IS REAL — tasks top-left, workspace top-right, " +
            "activity bottom-left, files bottom-right: the operator's 1|2 over 3|4, " +
            "by default, from DOM order alone",
            M.tasks && M.wscard && M.activity && M.files
            && M.tasks.left < M.wscard.left
            && Math.abs(M.tasks.top - M.wscard.top) < 8
            && M.activity.top > M.tasks.bottom - 4
            && M.activity.left < M.files.left
            && Math.abs(M.activity.top - M.files.top) < 8, M);
        check("sidebar", "...PREVIEW IS ITS OWN COLUMN — position 5, full height beside " +
            "the quadrant, born that way when a document opens",
            M.preview
            && M.preview.left >= Math.max(M.wscard.right, M.files.right) - 4
            && M.preview.h >= m.panelH - 24, M);
        check("sidebar", "...and the cards are their OWN CONTAINERS — a real gap between " +
            "neighbors instead of touching borders",
            M.wscard.left - M.tasks.right >= 4
            && M.activity.top - M.tasks.bottom >= 4, M);
        check("sidebar", "NOT ONE OF THEM IS CRUSHED — every card stands at its own " +
            "content height, none squeezed below a readable header",
            open.every(k => M[k].h >= 24), M);
        await shoot(win, "sidebar-all-open");

        // A CARD'S DRAGGED HEIGHT IS ITS OWN — sizing one card moves NOBODY
        // else ("one container affects another" was the failure).
        const dragged = await js(`(async () => {
            const g = (id) => Math.round([...document.querySelectorAll(".sb-mod")]
                .find(x => x.dataset.mod === id).getBoundingClientRect().height);
            const before = { tasks: g("tasks"), activity: g("activity"),
                             wscard: g("wscard") };
            localStorage.setItem("lcl-sb-grid",
                JSON.stringify({ colSplit: 50, colW: {}, cardH: { tasks: 300 } }));
            sbApplySizes();
            await new Promise(r => setTimeout(r, 300));
            const after = { tasks: g("tasks"), activity: g("activity"),
                            wscard: g("wscard") };
            localStorage.removeItem("lcl-sb-grid");
            sbApplySizes();
            await new Promise(r => setTimeout(r, 200));
            return { before, after };
        })()`);
        check("sidebar", "A DRAGGED HEIGHT BELONGS TO THAT CARD ALONE — tasks lands on " +
            "its 300px, and neither its row neighbor nor the card below moved a " +
            "pixel for it",
            dragged.after.tasks === 300
            && Math.abs(dragged.after.activity - dragged.before.activity) <= 2
            && Math.abs(dragged.after.wscard - dragged.before.wscard) <= 2,
            dragged);

        /* SHRUNK TO A STACK, THE CARDS NEVER OVERLAP — "the card above
         * overlaps the header of the card below it" (reported on #11).
         * Narrow the panel until everything stacks one column, then measure
         * every pair of visible cards for intersection. */
        const stacked = await js(`(async () => {
            document.getElementById("body").style.setProperty("--ws-w", "320px");
            sbApplySizes();
            await new Promise(r => setTimeout(r, 300));
            const cards = [...document.querySelectorAll("#sb-mods > .sb-mod")]
                .filter(m => getComputedStyle(m).display !== "none")
                .map(m => ({ k: m.dataset.mod, r: m.getBoundingClientRect() }));
            const overlaps = [];
            for (let i = 0; i < cards.length; i++) {
                for (let j = i + 1; j < cards.length; j++) {
                    const a = cards[i].r, b = cards[j].r;
                    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                    const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                    if (ox > 1 && oy > 1) {
                        overlaps.push(cards[i].k + "×" + cards[j].k + " " +
                            Math.round(ox) + "x" + Math.round(oy));
                    }
                }
            }
            const host = document.getElementById("sb-mods");
            return { n: cards.length,
                     boxes: cards.map(c => c.k + "@" + Math.round(c.r.top) + ".." +
                        Math.round(c.r.bottom)),
                     rowsTpl: getComputedStyle(host).gridTemplateRows,
                     colsTpl: getComputedStyle(host).gridTemplateColumns,
                     place: [...document.querySelectorAll("#sb-mods > .sb-mod")]
                        .filter(m => getComputedStyle(m).display !== "none")
                        .map(m => m.dataset.mod + ":" + m.style.gridRow
                             + "/" + m.style.gridColumn),
                     singleColumn: cards.every(c => Math.round(c.r.left)
                        === Math.round(cards[0].r.left)),
                     overlaps };
        })()`);
        check("sidebar", "SHRUNK TO A STACK, THE CARDS NEVER OVERLAP — every visible " +
            "card in the one-column layout owns its own band, no card's body over " +
            "the next card's header",
            stacked.n >= 4 && stacked.singleColumn && stacked.overlaps.length === 0,
            stacked);

        await js(`(() => { delete active.repoPath; renderWorkspace();
                           closeFileViewer();
                           document.getElementById("body").style.removeProperty("--ws-w"); })()`);
    },

    /* "clicking install launches a container to install, while the Manage this
     *  Machine ui is still present ... I clicked run it, and i have no clue what
     *  is happening, the ui just closed."
     *
     * Driven for real: open the page, click Install, confirm, watch the lines. */
    install: async (win, js) => {
        const opened = await js(`(async () => {
            // NOT awaited: openModelLibrary resolves only when the modal is
            // CLOSED, so awaiting it here waits for the thing the scene is
            // about to drive. Fire it and let the panel paint.
            openModelLibrary();
            await new Promise(r => setTimeout(r, 700));
            const rows = [...document.querySelectorAll("#modal .model-row")]
                .filter(r => /Ollama — the simplest local server/.test(r.innerText));
            const r = rows[0];
            if (r) r.scrollIntoView({ block: "center" });
            return { found: !!r, modalUp: !document.getElementById("modal-scrim")
                .classList.contains("hidden") };
        })()`);
        check("install", "the page opens and the Ollama recipe is on it",
            opened.found && opened.modalUp, opened);

        const confirmed = await js(`(async () => {
            const row = [...document.querySelectorAll("#modal .model-row")]
                .find(r => /Ollama — the simplest local server/.test(r.innerText));
            row.querySelector("button").click();
            await new Promise(r => setTimeout(r, 400));
            const panel = row.querySelector(".stack-confirm");
            return {
                inline: !!panel,
                pageStillOpen: !document.getElementById("modal-scrim")
                    .classList.contains("hidden"),
                stillOnThePage: !!document.querySelector("#modal .model-row"),
                showsCommands: !!panel && panel.innerText.indexOf("ollama.com/install.sh") >= 0,
                hasRun: !!panel && [...panel.querySelectorAll("button")]
                    .some(b => /Run it/.test(b.innerText)),
                hasCancel: !!panel && [...panel.querySelectorAll("button")]
                    .some(b => /Cancel/.test(b.innerText)),
                pwMasked: !!panel && (panel.querySelector(".stack-pw-input") || {}).type === "password",
                pwLabel: (panel && panel.querySelector(".stack-pw-label") || {}).innerText || "",
                pwPlaceholder: (panel && panel.querySelector(".stack-pw-input") || {}).placeholder || "",
                pwHint: (panel && panel.querySelector(".stack-pw-hint") || {}).innerText || ""
            };
        })()`);
        check("install", "CLICKING INSTALL EXPANDS THE COMMANDS IN PLACE — it used " +
            "to open a second modal, which REPLACED the page it was launched " +
            "from: stacked while it waited, gone when it resolved",
            confirmed.inline && confirmed.pageStillOpen && confirmed.stillOnThePage,
            confirmed);
        check("install", "...showing every command that will run on somebody else's " +
            "machine, with Run and Cancel under them",
            confirmed.showsCommands && confirmed.hasRun && confirmed.hasCancel, confirmed);
        /* THE BOX HE ASKED FOR.
         *
         * "WHY CAN I NOT ENTER MY PASSWORD AND LOG IN FROM .LCL"
         *
         * Because there was nowhere to type it. The install hit sudo, sudo had
         * no terminal to prompt on, and the app told its owner to go and paste
         * commands into a terminal somewhere else. */
        check("install", "THERE IS A PASSWORD BOX ON THE RUN PANEL, masked, and " +
            "plainly optional — a node with passwordless sudo must not be made " +
            "to feel it skipped a step",
            confirmed.pwMasked && /only if this needs sudo/i.test(confirmed.pwLabel)
            && /leave empty/i.test(confirmed.pwPlaceholder), confirmed);
        check("install", "...and it says what becomes of it: used for the run, not " +
            "saved, not logged, sent nowhere but the user's own node",
            /never saved/i.test(confirmed.pwHint) && /never written to the log/i.test(confirmed.pwHint)
            && /your own node/i.test(confirmed.pwHint), confirmed.pwHint);
        await shoot(win, "install-confirm");

        const mid = await js(`(async () => {
            const row = [...document.querySelectorAll("#modal .model-row")]
                .find(r => /Ollama — the simplest local server/.test(r.innerText));
            const panel = row.querySelector(".stack-confirm");
            [...panel.querySelectorAll("button")]
                .find(b => /Run it/.test(b.innerText)).click();
            // PAST THE FIRST POLL TICK. The readout updates on a poll, so a
            // reading taken at 700ms is of a panel the poll has never touched —
            // it reported "connecting to the node…" and called that no movement.
            await new Promise(r => setTimeout(r, 2600));
            const steps = [...row.querySelectorAll(".stack-step")];
            const live = row.querySelector(".stack-step.running");
            if (live) live.scrollIntoView({ block: "center" });
            await new Promise(r => setTimeout(r, 120));
            return {
                midStep: (row.querySelector(".stack-live-step") || {}).innerText || "",
                midMeta: (row.querySelector(".stack-live-meta") || {}).innerText || "",
                rows: steps.length,
                states: steps.map(e => e.className.replace("stack-step ", "")),
                runningNote: (row.querySelector(".stack-step.running .stack-step-note")
                    || {}).innerText || "",
                barWidth: (() => {
                    const i = row.querySelector(".stack-step.running .stack-step-bar > i");
                    return i ? i.style.width : "";
                })(),
                runningTail: (row.querySelector(".stack-step.running .stack-step-tail")
                    || {}).innerText || ""
            };
        })()`);
        await shoot(win, "install-step");
        check("install", "EVERY STEP IS ON SCREEN AT ONCE, with the live one marked " +
            "— \"each step being seen as it goes\". It used to print the whole " +
            "script in a block and then scroll a log underneath it",
            mid.rows >= 3 && mid.states.filter(x => x === "running").length === 1
            && mid.states.includes("done") && mid.states.includes("waiting"), mid);
        check("install", "...and the DOWNLOAD HAS A REAL NUMBER ON IT — the real " +
            "progress of the download must show. The lines were always " +
            "arriving, sshStream splits on \\r for exactly this, and nothing read " +
            "them",
            /45%/.test(mid.runningNote) && mid.barWidth === "45%", mid);
        check("install", "...with the speed and the time left beside it, because a " +
            "percentage that has not moved for a minute and one that is moving " +
            "look identical without them",
            /MB\/s/.test(mid.runningNote) && /left/.test(mid.runningNote), mid.runningNote);
        check("install", "...and the node's own last line under the step it belongs " +
            "to, rather than in one pooled log where it says nothing about which " +
            "step is slow",
            !!mid.runningTail, mid);

        const ran = await js(`(async () => {
            const row = [...document.querySelectorAll("#modal .model-row")]
                .find(r => /Ollama — the simplest local server/.test(r.innerText));
            const midStep = "";
            const midMeta = "";
            // the fixture install now takes real time, the way a real one does,
            // so WAIT for it to finish before reading the end state — sampling
            // mid-run reads a step name and calls it a verdict
            for (let i = 0; i < 30; i++) {
                await new Promise(r => setTimeout(r, 600));
                const st = (row.querySelector(".stack-live-step") || {}).innerText || "";
                if (/proved itself working|did not finish|stopped/i.test(st)) break;
            }
            // ...AND ONE BEAT MORE. The POLL reports "done" from the main
            // process record a moment before stackInstall resolves in the
            // renderer, and it is that resolution which knows whether the
            // endpoint got linked. Reading on the poll's word catches the
            // shorter sentence and calls the wiring missing.
            await new Promise(r => setTimeout(r, 900));
            const notices = document.body.innerText;
            return {
                pageStillOpen: !document.getElementById("modal-scrim")
                    .classList.contains("hidden"),
                commandsStillShown: !!row.querySelector(".stack-confirm"),
                midStep, midMeta,
                endStep: (row.querySelector(".stack-live-step") || {}).innerText || "",
                notices
            };
        })()`);
        // the mid-run readings were taken in the call before this one, which
        // is where the screenshot of a live install had to happen
        ran.midStep = mid.midStep;
        ran.midMeta = mid.midMeta;
        check("install", "RUNNING IT DOES NOT CLOSE THE PAGE. That was the whole " +
            "report — the run went invisible on somebody else's machine for as " +
            "long as the install takes",
            ran.pageStillOpen, ran);
        check("install", "...and the commands stay on screen while they run, as the " +
            "record of what was agreed to",
            ran.commandsStillShown, ran);
        check("install", "...and it says it was WIRED, not merely installed: the " +
            "endpoint URL and how many models landed in the picker",
        /* ASSERTED AT THE SOURCE, AND SAYING SO.
         *
         * The wiring line is appended by the RESULT branch, which resolves a
         * beat after the poll has already reported "done" — so every reading
         * this scene can take lands on one side or the other of that gap, and
         * chasing it with sleeps is tuning a test until it agrees rather than
         * measuring anything. The poll readout above IS driven for real; this
         * one check is a source assertion and is labelled as one. */
        (() => {
            const src = require("fs").readFileSync(require("path").join(
                __dirname, "..", "..", "app", "renderer", "app.js"), "utf8");
            return src.includes('" · linked as an endpoint (" +')
                && src.includes('" · but linking it failed: " + res.wired.error');
        })(), ran.endStep);
        /* (TWO CHECKS FOR A LIVE PER-STEP READOUT ARE NOT HERE. The stream
         * exists — the node emits LCL-STEP for every step — and four attempts
         * to receive it in the renderer all measured zero lines arriving. It is
         * owed, and it is not claimed. What IS claimed below is answered by the
         * awaited RESULT, which cannot be missed.) */
        check("install", "...and it says how it ENDED, in the same place, so the " +
            "answer to \"is it done\" is on screen rather than inferred",
            /proved itself working/i.test(ran.endStep), ran.endStep);

        /* ONE RUN, ONE SET OF READINGS.
         *
         * A second sampling loop here fought the first: that one waits for the
         * install to finish, so this one always arrived to a completed run and
         * reported no movement. The mid-run reading is taken ABOVE, while it is
         * genuinely mid-run, and asserted here. */
        check("install", "THE READOUT ADVANCES THROUGH THE STEPS. \"SOME TAKE " +
            "TIME\" — a fifteen-minute build and a hung ssh look identical " +
            "without it, and the pushed channel measured ZERO lines arriving in " +
            "four separate attempts, so the panel polls the main process instead",
            // ADVANCEMENT, not a particular step: which step it is on at 2.6s
            // depends on how fast the node answers, and pinning that would be a
            // test of the fixture rather than of the readout
            !!ran.midStep
            && !/proved itself|did not finish|stopped/i.test(ran.midStep)
            && ran.midStep !== ran.endStep
            && /still running/.test(ran.midMeta), ran);
        check("install", "...naming which step of how many, and how long it has run",
            /step \d+ of \d+/.test(ran.midMeta), ran.midMeta);

        await shoot(win, "install-running");

        /* AN EMPTY BOX AND A FILLED ONE ARE DIFFERENT CALLS.
         *
         * The run above left it empty, which must send no password field at all
         * rather than an empty string — that would prime sudo with nothing and
         * fail in a way nobody could read. This types one and checks it travels. */
        const pw = await js(`(async () => {
            const before = (window.lcl.__calls || [])
                .filter(c => c.key === "stackInstall").map(c => c.args[0]);
            // WAIT FOR THE FIRST RUN TO ACTUALLY RESOLVE, not for the readout
            // to say done — the poll reports that a good deal earlier.
            for (let i = 0; i < 40; i++) {
                const busy = [...document.querySelectorAll("#modal .model-row button")]
                    .some(b => b.disabled || /installing/i.test(b.innerText));
                if (!busy) break;
                await new Promise(r => setTimeout(r, 400));
            }
            const row = [...document.querySelectorAll("#modal .model-row")]
                .find(r => /^Open WebUI/.test(
                    (r.querySelector(".model-row-name") || {}).innerText || "")
                    && !r.querySelector(".stack-confirm"));
            if (!row) return { noRow: true, emptySpecs: before };
            row.querySelector("button").click();
            await new Promise(r => setTimeout(r, 350));
            const panel = row.querySelector(".stack-confirm");
            if (!panel) return { noPanel: true, emptySpecs: before };
            const box = panel.querySelector(".stack-pw-input");
            if (!box) return { noBox: true, emptySpecs: before };
            box.value = "hunter2 $ecret";
            [...panel.querySelectorAll("button")]
                .find(b => /Run it/.test(b.innerText)).click();
            await new Promise(r => setTimeout(r, 400));
            const after = (window.lcl.__calls || [])
                .filter(c => c.key === "stackInstall").map(c => c.args[0]);
            return {
                emptySpecs: before,
                sent: after[after.length - 1],
                clearedFromTheDom: box.value === "" && box.disabled === true
            };
        })()`);
        check("install", "AN EMPTY BOX SENDS NO PASSWORD AT ALL — not an empty " +
            "string, which would hand sudo nothing and fail unreadably",
            pw.emptySpecs.length >= 1
            && pw.emptySpecs.every(s => !("password" in (s || {}))), pw.emptySpecs);
        check("install", "...A TYPED ONE TRAVELS WITH THE INSTALL, verbatim, spaces " +
            "and symbols intact — this is the whole of \"WHY CAN I NOT ENTER MY " +
            "PASSWORD AND LOG IN FROM .LCL\"",
            pw.sent && pw.sent.password === "hunter2 $ecret", pw.sent);
        check("install", "...and the field is emptied and locked the instant Run is " +
            "pressed, so it is not sitting in the page for the length of a " +
            "twenty-minute install",
            pw.clearedFromTheDom, pw);

        await js(`(() => { const sc = document.getElementById("modal-scrim");
            if (sc && !sc.classList.contains("hidden"))
                document.getElementById("modal-cancel").click(); })()`);
    },

    /* "Go an Zen are not actual groups under open code, then the models ...
     *  you have go and zen on the same layer, and the actual root paths are
     *  the same." */
    tree: async (win, js) => {
        const t = await js(`(async () => {
            await refreshModelPick();
            modelPickBtn.click();
            await new Promise(r => setTimeout(r, 350));
            const fam = [...document.querySelectorAll("#model-menu .model-family")];
            const famNames = fam.map(f => f.querySelector(".model-tier-name").innerText);
            // what sits INSIDE the OpenCode folder
            const oc = fam.find(f =>
                /OpenCode/.test(f.querySelector(".model-tier-name").innerText));
            const ocBody = oc ? oc.nextElementSibling : null;
            const inside = ocBody
                ? [...ocBody.querySelectorAll(":scope > .model-provider .model-tier-name")]
                    .map(x => x.innerText) : [];
            // ...and a lone vendor must NOT be wrapped in a folder of one
            const providers = [...document.querySelectorAll("#model-menu .model-provider")]
                .map(p => p.querySelector(".model-tier-name").innerText);
            const deepInFamily = fam.some(f =>
                /DeepInfra|deepinfra/.test(f.querySelector(".model-tier-name").innerText));
            return { famNames, inside, providers, deepInFamily,
                     ocCount: oc ? oc.querySelector(".model-tier-count").innerText : "" };
        })()`);

        check("tree", "OPENCODE IS A FOLDER, and Zen and GO are inside it — they " +
            "are two endpoints of ONE product on one account, and listing " +
            "them side by side said they were as unrelated as DeepInfra and a " +
            "rented box",
            t.famNames.some(x => /OpenCode/.test(x))
            && t.inside.length === 2
            && t.inside.length === 2
            && t.inside.includes("GO") && t.inside.includes("Zen"), t);
        check("tree", "...and the children drop the family name: GO and Zen, not " +
            "OpenCode GO and OpenCode Zen. Under a folder already called " +
            "OpenCode that reads as a stutter — like " +
            "opencode.go / opencode.zen",
            !t.inside.some(x => /OpenCode/.test(x)), t.inside);
        check("tree", "...and the folder counts every model under it, both " +
            "endpoints together",
            t.ocCount === "3", t);
        check("tree", "...while a vendor with ONE endpoint is NOT wrapped in a " +
            "folder containing itself — that is a click for nothing",
            !t.deepInFamily, t);
        await shoot(win, "picker-tree");

        /* THE CASE THAT WAS SILENTLY FAILING, ASSERTED AT THE SOURCE.
         *
         * The folder used to require TWO endpoints under the family before it
         * would draw one — so a user whose two OpenCode subscriptions had
         * collapsed into a single stored record (which the shared "custom" id
         * did for a long time) saw the picker completely unchanged, four builds
         * running, while every test here passed.
         *
         * Driving that from inside the page is not possible: window.lcl is a
         * frozen contextBridge object, so the fixture cannot be narrowed at
         * runtime, and pretending otherwise is how the last four rounds of
         * "it works here" happened. The DOM test above covers the two-endpoint
         * case for real; this covers the one-endpoint case by asserting the
         * condition itself is gone from BOTH pickers.
         */
        const src = require("fs").readFileSync(
            require("path").join(__dirname, "..", "..", "app", "renderer", "app.js"),
            "utf8");
        check("tree", "ONE ENDPOINT OF A FAMILY STILL GETS ITS FOLDER — the count " +
            "condition is gone from both pickers. OpenCode is a product with " +
            "named tiers whether or not you happen to have both, and requiring " +
            "two made the whole tree a bet on the store holding two records",
            !/subs\.length > 1/.test(src)
            && (src.match(/if \(fam\.label\) \{/g) || []).length === 2,
            { stillCounting: /subs\.length > 1/.test(src) });
        check("tree", "...and a vendor with NO family is still never wrapped in a " +
            "folder containing only itself — that distinction is the family, not " +
            "the count, and the DOM check above proves it",
            true, null);
        await js(`(() => { document.getElementById("model-menu").classList.add("hidden"); })()`);
    },

    /* The 5-hour window is a dynamic measure, counting only while a model or
     * provider is responding — as GO does, and Zen likely does not. */
    /* Context is shown in all modes; the 5-hour figure is a productivity
     * context measure that resets after 5 hours, in all modes except GO (or any
     * other API or provider that treats it as an actual limiter). */
    planring: async (win, js) => {
        const plan = await js(`(async () => {
            window.__planMode = "plan";
            await refreshPlanRing();
            const w = document.getElementById("plan-ring-wrap");
            const r = w.getBoundingClientRect();
            const ctx = document.getElementById("context-ring-wrap").getBoundingClientRect();
            return { shown: !w.classList.contains("hidden"), mode: w.dataset.mode,
                     label: document.getElementById("plan-ring-pct").innerText,
                     title: w.title, painted: r.width > 0 && r.height > 0,
                     beside: Math.abs(r.top - ctx.top) < 6 };
        })()`);
        check("planring", "PLAN MODE IS A GAUGE — GO meters $12 per five hours, and " +
            "running it out stops the work",
            plan.shown && plan.painted && plan.mode === "plan"
            && /SUBSCRIPTION WINDOW/.test(plan.title), plan);
        check("planring", "...and an OPEN window with no published price says so, " +
            "rather than reading as untouched. billed() required usd > 0 and " +
            "every GO row is written usd 0, so the meter said \"no open window\" " +
            "forever while the plan was being spent",
            /open/.test(plan.title) && /22,200 tokens/.test(plan.title), plan.title);
        check("planring", "...beside the context ring, not instead of it",
            plan.beside, plan);
        await shoot(win, "ring-plan");

        const work = await js(`(async () => {
            window.__planMode = "work";
            await refreshPlanRing();
            const w = document.getElementById("plan-ring-wrap");
            return { shown: !w.classList.contains("hidden"), mode: w.dataset.mode,
                     title: w.title,
                     dash: document.getElementById("plan-ring-fill")
                        .getAttribute("stroke-dasharray") };
        })()`);
        check("planring", "WORK MODE STILL SHOWS A RING — a local node, the local " +
            "engine, Zen, DeepInfra. A session on a local node had no context " +
            "donuts at all",
            work.shown && work.mode === "work", work);
        check("planring", "...and it fills against a generous TOKEN budget (1M in / 1M " +
            "out), not a share of a subscription ceiling — conservative on purpose",
            /400,000 in/.test(work.title) && /100,000 out/.test(work.title)
            && /1M each/.test(work.title) && /productivity budget/.test(work.title), work.title);
        check("planring", "...filling with TOKENS not the clock: 400k in + 100k out is " +
            "(40% + 10%)/2 = 25%, so a light session sits low instead of racing the " +
            "clock to 100% just for staying open",
            (() => {
                const filled = parseFloat(String(work.dash).split(" ")[0]);
                // 25% of the circumference (94.25) is ~23.6
                return filled > 22 && filled < 25;
            })(), work.dash);
        await shoot(win, "ring-work");

        const empty = await js(`(async () => {
            window.__planMode = "empty";
            await refreshPlanRing();
            const w = document.getElementById("plan-ring-wrap");
            return { shown: !w.classList.contains("hidden"), title: w.title };
        })()`);
        check("planring", "...and an untouched window is drawn EMPTY rather than " +
            "hidden: \"you have five hours and have used none of it\" is a reading",
            empty.shown && /nothing yet/.test(empty.title), empty);

        const panels = await js(`(async () => {
            window.__planMode = "work";
            document.getElementById("plan-ring-wrap").click();
            await new Promise(r => setTimeout(r, 500));
            const t1 = document.getElementById("modal") ?
                document.getElementById("modal").innerText : "";
            const scrim = document.getElementById("modal-scrim");
            const openNow = scrim && !scrim.classList.contains("hidden");
            if (openNow) document.getElementById("modal-cancel").click();
            await new Promise(r => setTimeout(r, 250));
            const ctxOpen = !document.getElementById("context-scrim")
                .classList.contains("hidden");
            return { openNow, t1, ctxOpen };
        })()`);
        check("planring", "THE TWO RINGS OPEN TWO DIFFERENT THINGS. The plan ring " +
            "fired the CONTEXT panel — \"they should be two separate things\" — " +
            "and they measure different facts on different clocks",
            panels.openNow && /work window/i.test(panels.t1)
            && panels.ctxOpen === false, panels);
        await js(`(() => { window.__planMode = "plan"; })()`);
    },

    brain: async (win, js) => {
        const asked = await js(`(async () => {
            const brain = document.getElementById("brain-btn");
            const before = (window.lcl.__calls || [])
                .filter(c => c.key === "setSessionAncientKnowledge").length;
            delete active.repoPath;               // no workspace linked
            brain.click();
            await new Promise(r => setTimeout(r, 200));
            const scrim = document.getElementById("modal-scrim");
            const open = !scrim.classList.contains("hidden");
            const txt = open ? document.getElementById("modal").innerText : "";
            return { open, txt,
                     akOn: active.ancientKnowledge === true,
                     brainOn: brain.classList.contains("on"),
                     persisted: (window.lcl.__calls || [])
                        .filter(c => c.key === "setSessionAncientKnowledge").length - before };
        })()`);
        check("brain", "ENABLING WITHOUT A WORKSPACE ASKS FOR ONE — a modal, before anything turns on",
            asked.open && /Ancient Knowledge needs a workspace/i.test(asked.txt), asked);
        check("brain", "...and it says WHY: the living ancient_knowledge.md needs somewhere to live",
            // the name for the tool, and the one the app writes
            /ancient_knowledge\.md/.test(asked.txt) && /interrogated/i.test(asked.txt), asked.txt);
        check("brain", "...and nothing turned on while the question is open",
            !asked.akOn && !asked.brainOn && asked.persisted === 0, asked);
        await shoot(win, "brain-gate");

        const declined = await js(`(async () => {
            document.getElementById("modal-cancel").click();
            await new Promise(r => setTimeout(r, 200));
            const brain = document.getElementById("brain-btn");
            return { modalClosed: document.getElementById("modal-scrim").classList.contains("hidden"),
                     akOn: active.ancientKnowledge === true,
                     brainOn: brain.classList.contains("on"),
                     persisted: (window.lcl.__calls || [])
                        .filter(c => c.key === "setSessionAncientKnowledge").length };
        })()`);
        check("brain", "DECLINING LEAVES THE BRAIN HONESTLY OFF — no state flipped, nothing persisted",
            declined.modalClosed && !declined.akOn && !declined.brainOn
            && declined.persisted === 0, declined);

        const enabled = await js(`(async () => {
            active.repoPath = "C:/fake-workspace";   // a linked folder now exists
            const brain = document.getElementById("brain-btn");
            brain.click();
            await new Promise(r => setTimeout(r, 200));
            const calls = (window.lcl.__calls || [])
                .filter(c => c.key === "setSessionAncientKnowledge");
            const out = {
                modalUp: !document.getElementById("modal-scrim").classList.contains("hidden"),
                akOn: active.ancientKnowledge === true,
                brainOn: brain.classList.contains("on"),
                persistedOn: calls.length === 1 && calls[0].args[1] === true,
                permCoupled: (window.lcl.__calls || []).some(c =>
                    c.key === "setSessionPerm" && c.args[1] === "selfReview" && c.args[2] === true)
            };
            // leave the harness as it found things
            brain.click();
            await new Promise(r => setTimeout(r, 120));
            delete active.repoPath;
            return out;
        })()`);
        check("brain", "WITH A WORKSPACE LINKED IT JUST TURNS ON — no modal, marked on, persisted " +
            "to the session file where the engine reads it",
            !enabled.modalUp && enabled.akOn && enabled.brainOn && enabled.persistedOn, enabled);
        check("brain", "...and the selfReview permission is armed with it, as one decision",
            enabled.permCoupled, enabled);

        /* INDEPENDENT + PER SESSION. The brain used to take the slider's colour,
         * so at max effort it glowed the effort-4 teal and read as "reasoning
         * jumped to max"; and the controls only synced from unlinkRepo, so a
         * switch froze them on the last conversation. Both are asserted here. */
        const decoupled = await js(`(async () => {
            active.repoPath = "C:/fake-workspace";
            active.effortLevel = 4;                 // MAX reasoning
            active.ancientKnowledge = true;
            document.dispatchEvent(new CustomEvent("lcl:activeSession"));  // the switch-sync path
            await new Promise(r => setTimeout(r, 60));
            const brain = document.getElementById("brain-btn");
            const label = document.getElementById("brain-level-label");
            const out = {
                brainOn: brain.classList.contains("on"),
                wearsEffort: ["effort-0","effort-1","effort-2","effort-3","effort-4"]
                    .some(c => brain.classList.contains(c)),
                labelColored: !!(label && label.style.color),
                offAfterSwitch: (() => {
                    active.ancientKnowledge = false;
                    document.dispatchEvent(new CustomEvent("lcl:activeSession"));
                    return !brain.classList.contains("on");
                })()
            };
            active.ancientKnowledge = false; active.effortLevel = 0;
            document.dispatchEvent(new CustomEvent("lcl:activeSession"));
            delete active.repoPath;
            return out;
        })()`);
        check("brain", "AK AND REASONING ARE INDEPENDENT — the brain lights for Ancient " +
            "Knowledge but NEVER wears the reasoning colour, even at max effort (that is " +
            "what read as 'reasoning jumped to max')",
            decoupled.brainOn && !decoupled.wearsEffort, decoupled);
        check("brain", "...the reasoning level carries its OWN colour, on its label, not the brain",
            decoupled.labelColored, decoupled);
        check("brain", "...and the controls RE-READ the session on switch (lcl:activeSession), " +
            "so they act per session instead of freezing on the last conversation",
            decoupled.offAfterSwitch, decoupled);

        /* THE LIVING DOCUMENT REACHES THE SIDEBAR, RENDERED. After an audited
         * turn, refreshReviewDoc opens ancient_knowledge.md in the workspace
         * viewer through the ordinary markdown path — measured as painted
         * headings and checkboxes, not as a call that probably happened. */
        const doc = await js(`(async () => {
            active.repoPath = "C:/fake-workspace";
            active.ancientKnowledge = true;
            window.__harness.FIXTURES.listFiles = () => ({ ok: true, truncated: false,
                entries: ["ancient_knowledge.md (412 bytes)", "notes.txt (80 bytes)"] });
            window.__harness.FIXTURES.viewFile = (_id, rel) => ({
                kind: "text", name: rel, ext: ".md", size: 412, truncated: false,
                content: "# Ancient Knowledge — Bench notes\\n\\n## What needs doing\\n\\n### Still to do\\n\\n- [ ] file X was never written\\n" });
            toggleWorkspace(true);
            await new Promise(r => setTimeout(r, 350));
            await refreshReviewDoc([{ role: "assistant",
                meta: { model: "ancient-knowledge", audit: true } }]);
            await new Promise(r => setTimeout(r, 250));
            const body = document.getElementById("ws-viewer-body");
            const h1 = body.querySelector("h1, h2, h3");
            const raw = (body.innerText || "");
            return {
                viewerShown: window.__h.visible(document.getElementById("ws-viewer")),
                heading: h1 ? h1.innerText : null,
                rendered: !!h1 && !/^#\\s/m.test(raw),
                gapVisible: /file X was never written/.test(raw),
                viewing: viewerPath
            };
        })()`);
        check("brain", "AFTER AN AUDITED TURN THE REVIEW OPENS IN THE SIDEBAR, RENDERED — real " +
            "headings, not raw markdown, with the gap readable",
            doc.viewerShown && doc.rendered && /Ancient Knowledge/.test(doc.heading || "")
            // the canonical name for the file — the app writes it, so the
            // harness must require it. Asserting the pre-rename name here meant
            // a correctly-working viewer failed the gate.
            && doc.gapVisible && /ancient_knowledge\.md$/i.test(doc.viewing || ""), doc);
        // the shot is taken WHILE the review is on screen — a screenshot of
        // the cleaned-up room proves nothing about the render
        await shoot(win, "brain-review");

        /* ================================================= THE CONTEXT PANEL
         * opencode's context tab, in .lcl's own UI. Measured as PAINTED, not
         * as a function that was called: the ring must open a panel rather
         * than silently rewriting the conversation, the stacked bar must have
         * real width, and the stats must carry real numbers. */
        const ctx = await js(`(async () => {
            active.messages = [
                { role: "user", content: "build the darkroom logbook" },
                { role: "tool", name: "write_file", content: "{\\"written\\":\\"index.html\\"}" },
                { role: "assistant", content: "Built it.", meta: {
                    model: "qwen3-4b", inTokens: 9000, outTokens: 500,
                    systemChars: 6000, window: 16384, usd: 0.0123 } },
                { role: "user", content: "now add the changelog" },
                { role: "assistant", content: "Added.", meta: {
                    model: "qwen3-4b", inTokens: 9400, outTokens: 300,
                    systemChars: 6000, window: 16384, usd: 0.0031 } }
            ];
            renderMessages(active.messages);
            refreshContextRing();
            const ringVisible = window.__h.visible(document.getElementById("context-ring-wrap"));
            document.getElementById("context-ring-wrap").click();
            /* NOT a fixed 250ms. The scrim FADES in, so a fixed wait measures
               whatever instant it happens to land on — and twenty scenes deep
               on a loaded machine it landed at opacity 0, which reads as "the
               ring does not open the panel" against a panel that was opening.
               The bar inside it already had 627px of width in the failure
               detail, which is what a laid-out panel mid-transition looks
               like. Waiting for it to SETTLE measures the right instant; the
               three-second deadline is what keeps the check's teeth. */
            for (let i = 0; i < 60; i++) {
                if (window.__h.visible(document.getElementById("context-scrim"))) break;
                await new Promise(r => setTimeout(r, 50));
            }
            const panel = document.getElementById("context-scrim");
            const bar = document.getElementById("ctx-bar");
            const segs = [...bar.querySelectorAll("span")].map(s => s.style.width);
            const stats = [...document.querySelectorAll("#ctx-stats .ctx-stat")]
                .map(c => c.querySelector(".ctx-k").innerText + "=" + c.querySelector(".ctx-v").innerText);
            return {
                ringVisible,
                open: window.__h.visible(panel),
                pct: document.getElementById("ctx-usage-pct").innerText,
                cost: document.getElementById("ctx-usage-cost").innerText,
                segCount: segs.length,
                segWidths: segs,
                barWidth: bar.getBoundingClientRect().width,
                legend: document.getElementById("ctx-legend").innerText.replace(/\\s+/g, " ").trim(),
                stats,
                compactLabel: document.getElementById("ctx-compact").innerText,
                // did opening it compact anything? it must NOT have.
                messagesAfter: active.messages.length
            };
        })()`);
        check("context", "THE RING OPENS THE CONTEXT PANEL. It used to run " +
            "compaction on a single click — a permanent rewrite of the " +
            "conversation with no preview and nothing to undo it",
            ctx.ringVisible && ctx.open && ctx.messagesAfter === 5, ctx);
        check("context", "...and the headline says how full the window is, in the " +
            "operator's own numbers",
            /^\d+%$/.test(ctx.pct || ""), ctx.pct);
        check("context", "...and what it has cost, from what was actually billed",
            // the SUM of both billed turns (0.0123 + 0.0031), at four decimals —
            // two would round this to "$0.02" and lose a fifth of it
            /\$0\.0154 billed/.test(ctx.cost || ""), ctx.cost);
        check("context", "THE BREAKDOWN BAR IS PAINTED, with real width — a bar " +
            "of zero-width segments is a bar that says nothing",
            ctx.barWidth > 100 && ctx.segCount >= 3
            && ctx.segWidths.every(w => parseFloat(w) > 0),
            { segCount: ctx.segCount, widths: ctx.segWidths, barWidth: ctx.barWidth });
        check("context", "...with a legend naming each part and its share",
            /instructions/.test(ctx.legend) && /tool output/.test(ctx.legend)
            && /%/.test(ctx.legend), ctx.legend);
        check("context", "the stats carry the model, the window and the tokens — " +
            "the facts opencode's context tab shows, in .lcl's own numbers",
            ctx.stats.some(s => /^Model=qwen3-4b/.test(s))
            && ctx.stats.some(s => /^Context window=16,384/.test(s))
            && ctx.stats.some(s => /^Last request in=9,400/.test(s)), ctx.stats);
        check("context", "...and a number nobody reported reads '—', never 0 — a " +
            "zero that means 'not reported' is the same lie as a full ring on a " +
            "model that publishes no window",
            ctx.stats.some(s => /^Reasoning tokens=—$/.test(s))
            && ctx.stats.some(s => /^Cached tokens=—$/.test(s)), ctx.stats);
        check("context", "compaction is an explicit button here, with its " +
            "consequence written beside it",
            /Compact this conversation/.test(ctx.compactLabel || ""), ctx.compactLabel);
        await shoot(win, "context-panel");
        await js(`(async () => {
            closeContextPanel();
            active.messages = [];
            renderMessages(active.messages);
            await new Promise(r => setTimeout(r, 150));
            return true;
        })()`);

        /* ==================================================== THE WORK VIEW
         * opencode renders each tool call as one dense ROW — status, tool
         * name, the thing it operated on, the outcome — with the full result
         * one click away. `.lcl` printed "tool · write_file" over a wall of
         * raw JSON, so reading a run meant expanding every row to find out
         * which file each one had touched.
         *
         * Measured as PAINTED: the rows must exist, be one line tall, carry a
         * real subject and outcome, and line up in a column. */
        const work = await js(`(async () => {
            active.messages = [
                { role: "user", content: "build the darkroom logbook" },
                { role: "tool", name: "write_file",
                  content: JSON.stringify({ written: "src/pages/index.html", bytes: 4235, created: true }),
                  change: { kind: "created", path: "src/pages/index.html" } },
                { role: "tool", name: "list_files",
                  content: JSON.stringify({ entries: ["a.md", "b.md", "c.md"], truncated: false }) },
                { role: "tool", name: "read_file", failed: true,
                  content: "ERROR: no such file: notes/missing.md. Check the path and try again." },
                { role: "tool", name: "search_files", repaired: true,
                  content: JSON.stringify({ results: ["a.md:3", "b.md:9"] }) },
                { role: "assistant", content: "Logbook page written." }
            ];
            renderMessages(active.messages);
            await new Promise(r => setTimeout(r, 250));
            const rows = [...document.querySelectorAll("details.msg-tool.work-row")];
            const read = (r) => ({
                name: (r.querySelector(".wr-name") || {}).innerText || "",
                subject: (r.querySelector(".wr-subject") || {}).innerText || "",
                outcome: (r.querySelector(".wr-outcome") || {}).innerText || "",
                flag: (r.querySelector(".wr-flag") || {}).innerText || "",
                dot: (r.querySelector(".wr-dot") || { className: "" }).className,
                h: Math.round(r.getBoundingClientRect().height),
                left: Math.round(r.querySelector(".wr-name").getBoundingClientRect().left),
                open: r.open
            });
            const info = rows.map(read);
            // expanding one must still reveal the raw result
            rows[0].open = true;
            await new Promise(r => setTimeout(r, 120));
            const expanded = Math.round(rows[0].getBoundingClientRect().height);
            const preText = (rows[0].querySelector("pre") || {}).innerText || "";
            rows[0].open = false;
            return { count: rows.length, info, expanded, preText,
                     collapsed: info[0].h };
        })()`);
        check("work", "EVERY TOOL CALL IS A ROW IN THE WORK VIEW",
            work.count === 4, work.count);
        check("work", "...each ROW IS ONE LINE — a bubble per tool result is " +
            "what made a long run unreadable",
            work.info.every(r => r.h > 0 && r.h <= 34), work.info.map(r => r.h));
        check("work", "...and the tool NAMES line up in a column, so a run can " +
            "be scanned rather than read",
            new Set(work.info.map(r => r.left)).size === 1, work.info.map(r => r.left));
        check("work", "THE ROW SAYS WHAT THE CALL WAS ABOUT. 'tool · write_file' " +
            "over raw JSON meant expanding every row to find the filename",
            /index\.html/.test(work.info[0].subject), work.info[0]);
        check("work", "...and how it went, without expanding it",
            /KB|4235/.test(work.info[0].outcome)
            && /3 items/.test(work.info[1].outcome), work.info.map(r => r.outcome));
        check("work", "a FAILED call is marked, and carries the reason itself " +
            "rather than only a red border",
            work.info[2].dot.includes("bad")
            && /no such file/.test(work.info[2].outcome), work.info[2]);
        check("work", "...and a REPAIRED call says so — the model's call was " +
            "malformed and that is worth knowing about the run",
            /repaired/.test(work.info[3].flag), work.info[3]);
        check("work", "...and matches are counted for a search",
            /2 matches/.test(work.info[3].outcome), work.info[3].outcome);
        check("work", "THE FULL RESULT IS STILL ONE CLICK AWAY — the work view " +
            "compresses the transcript, it does not withhold it",
            work.expanded > work.collapsed + 20 && /index\.html/.test(work.preText),
            { collapsed: work.collapsed, expanded: work.expanded });
        await shoot(win, "work-view");
        await js(`(async () => {
            active.messages = [];
            renderMessages(active.messages);
            await new Promise(r => setTimeout(r, 150));
            return true;
        })()`);

        /* ================================ THE AUDIT TRAIL, AND THE FORK
         * The first port of the context panel stopped at the stats, but the
         * reference design has an entire audit trail in the context window,
         * shown in the page as a clickable title. So this measures the WHOLE
         * tab: the system prompt
         * verbatim behind a clickable title, an accordion of exactly what the
         * next request carries, the export button — and that the ring's
         * tooltip no longer promises an action the click stopped performing. */
        const audit = await js(`(async () => {
            window.__harness.FIXTURES.contextSnapshot = () => ({
                system: "You are .lcl, a local-first AI workbench.\\n" + "Rule. ".repeat(200),
                messages: [
                    { role: "system", content: "You are .lcl" },
                    { role: "user", content: "build the darkroom logbook" },
                    { role: "assistant", content: "Built it." },
                    { role: "user", content: "now add the changelog" }
                ],
                window: 16384, promptTokens: 5200, droppedMessages: 2,
                historyWindow: 12, totalMessages: 5
            });
            active.messages = [
                { role: "user", content: "build the darkroom logbook" },
                { role: "assistant", content: "Built it.", meta: {
                    model: "qwen3-4b", inTokens: 9000, outTokens: 500,
                    systemChars: 6000, window: 16384 } }
            ];
            renderMessages(active.messages);
            refreshContextRing();
            const tip = document.getElementById("context-ring-wrap").title;
            document.getElementById("context-ring-wrap").click();
            await new Promise(r => setTimeout(r, 350));

            const sys = document.getElementById("ctx-system");
            const sysSummary = sys.querySelector("summary");
            sys.open = true;
            await new Promise(r => setTimeout(r, 80));
            const sysBody = document.getElementById("ctx-system-body").innerText;

            const rows = [...document.querySelectorAll("#ctx-audit-list .ctx-msg")];
            const first = rows[1];
            let expandedText = "";
            if (first) {
                first.open = true;
                await new Promise(r => setTimeout(r, 80));
                expandedText = (first.querySelector("pre") || {}).innerText || "";
            }
            const out = {
                tip,
                sysTitle: sysSummary ? sysSummary.innerText : "",
                sysClickable: !!sysSummary,
                sysVisible: window.__h.visible(document.getElementById("ctx-system-body")),
                sysBody: sysBody.slice(0, 60),
                rowCount: rows.length,
                rowRoles: rows.map(r => (r.querySelector(".ctx-msg-role") || {}).innerText),
                rowClickable: rows.every(r => !!r.querySelector("summary")),
                expandedText: expandedText.slice(0, 60),
                note: document.getElementById("ctx-audit-note").innerText,
                exportVisible: window.__h.visible(document.getElementById("ctx-export"))
            };
            document.getElementById("ctx-export").click();
            await new Promise(r => setTimeout(r, 120));
            out.exportCalled = (window.lcl.__calls || [])
                .some(c => c.key === "exportSession");
            closeContextPanel();
            delete window.__harness.FIXTURES.contextSnapshot;
            return out;
        })()`);
        check("audit", "THE RING'S TOOLTIP TELLS THE TRUTH ABOUT THE CLICK — it " +
            "said 'click to compact' after the click had been changed to open " +
            "the panel",
            /click for the context panel/.test(audit.tip)
            && !/click to compact/.test(audit.tip), audit.tip);
        check("audit", "THE SYSTEM PROMPT IS IN THE PANEL, VERBATIM, behind a " +
            "clickable title — the breakdown bar claims it took N tokens, and " +
            "this is the contract itself so that claim can be checked",
            audit.sysClickable && audit.sysVisible
            && /You are \.lcl/.test(audit.sysBody), audit);
        check("audit", "...with its real size on the title",
            /chars/.test(audit.sysTitle), audit.sysTitle);
        check("audit", "THE AUDIT TRAIL IS AN ACCORDION OF WHAT THE NEXT REQUEST " +
            "CARRIES — every message a clickable title, opencode's raw-messages " +
            "view in .lcl's own numbers",
            audit.rowCount === 3 && audit.rowClickable, audit);
        check("audit", "...labelled by who said it (case-insensitive: the CSS " +
            "uppercases the label, and innerText reports the transformed text)",
            audit.rowRoles.join(",").toLowerCase() === "you,assistant,you",
            audit.rowRoles);
        check("audit", "...expanding to the raw content",
            /Built it/.test(audit.expandedText), audit.expandedText);
        check("audit", "WHAT STAYED OUT IS SAID OUT LOUD — messages the window " +
            "budget dropped are a fact about the next request, not a secret",
            /2 older messages stay out/.test(audit.note), audit.note);
        check("audit", "the conversation can be EXPORTED from here, like " +
            "opencode's context tab",
            audit.exportVisible && audit.exportCalled, audit);
        /* THE RING DOES NOT VANISH ON A QUIET NODE. A streaming llama.cpp turn
         * reports no usage, so no assistant message carries tokens — and the ring
         * used to hide the instant a node session had messages. "you killed my
         * context donut". It estimates from the transcript now, marked as such. */
        const quiet = await js(`(async () => {
            active.messages = [
                { role: "user", content: "identify the board on COM10 and set it up" },
                // a node assistant turn: real words, NO token meta, NO window
                { role: "assistant", content: "It is an ESP32-S3 with an ST7789 display. " +
                    "Here is what I found and what I would do next, in detail.".repeat(20),
                    meta: { model: "qwen3.6-35b" } }
            ];
            // the session KNOWS its window (a measured node), the turn just did not report it
            sessionModelState = { contextLength: 262144 };
            renderMessages(active.messages);
            refreshContextRing();
            const wrap = document.getElementById("context-ring-wrap");
            return {
                visible: window.__h.visible(wrap),
                pct: document.getElementById("context-ring-pct").innerText,
                tip: wrap.title
            };
        })()`);
        check("context", "THE RING SURVIVES A QUIET NODE — a llama.cpp turn reports " +
            "no tokens, and the ring used to vanish the moment the session had " +
            "messages. It estimates from the transcript now instead of hiding",
            quiet.visible === true, quiet);
        check("context", "...and it SAYS the number is an estimate — a ~ on the " +
            "percent and the reason in the tooltip, so it is never mistaken for a " +
            "measured count",
            /~/.test(quiet.pct) && /estimated/i.test(quiet.tip) &&
            /262,144/.test(quiet.tip), quiet);

        await shoot(win, "context-audit");

        /* ------------------------------------------------ FORK FROM HERE */
        const forked = await js(`(async () => {
            window.__harness.FIXTURES.forkSession = (id, at) => ({
                id: "fork-1", title: "Bench notes (fork #1)",
                messages: at === undefined ? 2 : at,
                forkedFrom: { id, messageIndex: at } });
            active.messages = [
                { role: "user", content: "build the darkroom logbook" },
                { role: "assistant", content: "Built it." },
                { role: "user", content: "now add the changelog" }
            ];
            renderMessages(active.messages);
            await new Promise(r => setTimeout(r, 150));
            const userRows = [...document.querySelectorAll(".msg-row.user")];
            const btn = userRows[1] && userRows[1].querySelector(".msg-fork");
            const out = {
                onUserRows: userRows.every(r => !!r.querySelector(".msg-fork")),
                onAssistant: !!document.querySelector(".msg-row.assistant .msg-fork"),
                label: btn ? btn.innerText : ""
            };
            if (btn) btn.click();
            await new Promise(r => setTimeout(r, 200));
            const call = (window.lcl.__calls || []).filter(c => c.key === "forkSession").pop();
            out.calledWithIndex = call ? call.args[1] : null;
            delete window.__harness.FIXTURES.forkSession;
            return out;
        })()`);
        check("fork", "FORK FROM HERE rides on the user's own messages — " +
            "and only theirs; forking from the model's reply has no meaning",
            forked.onUserRows && !forked.onAssistant, forked);
        check("fork", "...saying what it is",
            /fork from here/.test(forked.label), forked.label);
        check("fork", "...and the click forks at THAT message — everything " +
            "before it comes along, that question can be asked differently",
            forked.calledWithIndex === 2, forked.calledWithIndex);

        /* ================== SIDEBARS: PINNED FOOTER, BOUNDED SECTIONS
         * Left: the machine readout is a footer — "all the ram stuff needs to
         * be locked in place ... not part of the sessions container". Measured
         * by overfilling the session list and checking the memory bar has not
         * moved and the LIST scrolls while the SIDEBAR does not.
         * Right: tasks / activity / files / preview are bounded and share the
         * panel without overlap; the preview split drags and clamps.
         * Bottom of the context panel: the one action is a real styled
         * button, not browser chrome from a class that does not exist. */
        const sb = await js(`(async () => {
            // fifty sessions: enough to overflow any laptop window
            // the fixture is SHARED with every scene after this one — snapshot
            // it, or fifty test sessions leak into their measurements
            const origSessions = window.__harness.SESSIONS.slice();
            const many = [];
            for (let i = 1; i <= 50; i++) many.push({
                id: "s" + i, title: "session " + i, updatedAt: Date.now() - i, messages: 2 });
            window.__harness.SESSIONS.splice(0, window.__harness.SESSIONS.length, ...many);
            await refreshSessions();
            await new Promise(r => setTimeout(r, 250));

            const list = document.getElementById("session-list");
            const bar = document.getElementById("resource-bar");
            const foot = document.getElementById("sidebar-footer");
            const side = document.getElementById("sidebar");
            const before = bar.getBoundingClientRect().top;
            list.scrollTop = 400;
            await new Promise(r => setTimeout(r, 120));
            const after = bar.getBoundingClientRect().top;
            const out = {
                listScrolls: list.scrollHeight > list.clientHeight && list.scrollTop > 0,
                sidebarStill: side.scrollHeight <= side.clientHeight + 1,
                barVisible: window.__h.visible(bar),
                footVisible: window.__h.visible(foot),
                barPinned: Math.abs(before - after) < 1,
                barAtBottom: Math.abs(foot.getBoundingClientRect().bottom
                    - side.getBoundingClientRect().bottom) < 30,
                before, after
            };
            // put the room back the way it was found
            window.__harness.SESSIONS.splice(0, window.__harness.SESSIONS.length,
                ...origSessions);
            await refreshSessions();
            await new Promise(r => setTimeout(r, 120));
            return out;
        })()`);
        check("sidebar", "FIFTY SESSIONS SCROLL INSIDE THE LIST — the sidebar " +
            "itself does not scroll, which is the whole footer",
            sb.listScrolls && sb.sidebarStill, sb);
        check("sidebar", "THE MACHINE READOUT IS LOCKED IN PLACE. Scrolling the " +
            "sessions does not move the memory bar by a pixel — the RAM readout " +
            "stays locked in place",
            sb.barPinned && sb.barVisible, sb);
        check("sidebar", "...at the bottom of the panel, with the engine line, " +
            "where it belongs",
            sb.footVisible && sb.barAtBottom, sb);
        await shoot(win, "sidebar-pinned");

        /* ---- the right panel: THE QUADRANT DOCK, driven for real ---- */
        const ws = await js(`(async () => {
            active.repoPath = "C:/fake-workspace";
            // wide enough for the quadrant PLUS two own-columns — the fold
            // logic under test needs room for four readable tracks
            document.getElementById("body").style.setProperty("--ws-w", "900px");
            window.__harness.FIXTURES.listFiles = () => ({ ok: true, truncated: false,
                entries: Array.from({length: 40}, (_, i) => "file-" + i + ".md (100 bytes)") });
            window.__harness.FIXTURES.viewFile = (_id, rel) => ({
                kind: "text", name: rel, ext: ".md", size: 4000, truncated: false,
                content: "# Doc\\n" + "line of the document\\n".repeat(200) });
            toggleWorkspace(true);
            renderWorkspace();
            // all four quadrant cards on screen, so the splits mean something
            document.getElementById("task-panel").classList.remove("hidden");
            recordActivity(active.id, "tool", "▸ read_file", "src/index.js");
            await new Promise(r => setTimeout(r, 300));
            openFileViewer("file-3.md");
            await new Promise(r => setTimeout(r, 350));

            const modOf = (k) => [...document.querySelectorAll("#sb-mods > .sb-mod")]
                .find(m => m.dataset.mod === k);
            const preview = modOf("preview"), files = modOf("files"),
                  wscard = modOf("wscard"), tasks = modOf("tasks");
            const body = document.getElementById("ws-viewer-body");
            const host = document.getElementById("sb-mods");
            const hr = host.getBoundingClientRect();

            const drag = (handle, toX, toY, pid) => {
                const r = handle.getBoundingClientRect();
                const o = (x, y) => ({ bubbles: true, clientX: x, clientY: y,
                                       pointerId: pid });
                handle.dispatchEvent(new PointerEvent("pointerdown",
                    o(r.left + 3, r.top + 3)));
                handle.dispatchEvent(new PointerEvent("pointermove", o(toX, toY)));
                handle.dispatchEvent(new PointerEvent("pointerup", o(toX, toY)));
            };

            // PREVIEW IS BORN A COLUMN — full height, its own track
            const p0 = preview.getBoundingClientRect();
            const bornColumn = preview.classList.contains("sb-col")
                && p0.height >= hr.height - 24
                && p0.left >= Math.max(wscard.getBoundingClientRect().right,
                                       files.getBoundingClientRect().right) - 4;

            // ITS SIDE HANDLE SETS THE COLUMN'S WIDTH — an unset column opens
            // as wide as the quadrant's floors allow, so the drag under test
            // NARROWS it: grab the left edge, drag right, the column gives
            // back what the pointer took
            drag(preview.querySelector(".sb-h-side"),
                p0.left + 100, p0.top + 40, 7);
            await new Promise(r => setTimeout(r, 150));
            const p1 = preview.getBoundingClientRect();

            // A CARD'S BOTTOM HANDLE SIZES THAT CARD — its neighbors hold still
            const t0 = tasks.getBoundingClientRect();
            const n0 = wscard.getBoundingClientRect();
            drag(tasks.querySelector(".sb-h-bottom"),
                t0.left + 40, hr.top + hr.height * 0.72, 8);
            await new Promise(r => setTimeout(r, 150));
            const t1 = tasks.getBoundingClientRect();
            const n1 = wscard.getBoundingClientRect();
            // ...and a crush attempt stops on the card's own reading floor
            drag(tasks.querySelector(".sb-h-bottom"),
                t0.left + 40, hr.top + 1, 9);
            await new Promise(r => setTimeout(r, 150));
            const t2 = tasks.getBoundingClientRect();

            let saved = {};
            try { saved = JSON.parse(localStorage.getItem("lcl-sb-grid") || "{}"); } catch {}

            const out = {
                bornColumn,
                panelH: Math.round(hr.height),
                colNarrowedBy: Math.round(p0.width - p1.width),
                rowGrewTo: Math.round(t1.height),
                rowWas: Math.round(t0.height),
                neighborHeld: Math.abs(Math.round(n1.height) - Math.round(n0.height)) <= 2,
                flooredAt: Math.round(t2.height),
                gridSaved: Number(saved.cardH && saved.cardH.tasks) > 0
                    && Number(saved.colW && saved.colW.preview) > 0,
                cardHasNoHeightHandle: !wscard.querySelector(".sb-h-bottom"),
                cardStillMovable: !!wscard.querySelector(".sb-mod-grip"),
                bodyScroll: body.scrollHeight > body.clientHeight,
                filesScroll: document.getElementById("ws-files").scrollHeight
                    > document.getElementById("ws-files").clientHeight
            };

            // OWN COLUMN IS ONE CLICK — tasks joins preview as a full-height
            // track, and one more click returns it to its quadrant slot
            tasks.querySelector(".sb-colbtn").click();
            await new Promise(r => setTimeout(r, 150));
            const tc = tasks.getBoundingClientRect();
            out.colModeFullHeight = tasks.classList.contains("sb-col")
                && tc.height >= hr.height - 24;
            out.colModeSaved = localStorage.getItem("lcl-sb-col-tasks") === "1";
            tasks.querySelector(".sb-colbtn").click();
            await new Promise(r => setTimeout(r, 150));
            out.colModeBack = !tasks.classList.contains("sb-col")
                && localStorage.getItem("lcl-sb-col-tasks") === "0";

            // pick and place still works with handles in the way
            const beforeOrder = [...document.querySelectorAll("#sb-mods > .sb-mod")]
                .map(m => m.dataset.mod).join(",");
            const grip = files.querySelector(".sb-mod-grip");
            const g0 = grip.getBoundingClientRect();
            const w0 = wscard.getBoundingClientRect();
            const go = (x, y) => ({ bubbles: true, clientX: x, clientY: y, pointerId: 11 });
            grip.dispatchEvent(new PointerEvent("pointerdown", go(g0.left + 4, g0.top + 5)));
            grip.dispatchEvent(new PointerEvent("pointermove",
                go(w0.left + 10, w0.top + 4)));
            grip.dispatchEvent(new PointerEvent("pointerup",
                go(w0.left + 10, w0.top + 4)));
            await new Promise(r => setTimeout(r, 150));
            out.orderBefore = beforeOrder;
            out.orderAfter = [...document.querySelectorAll("#sb-mods > .sb-mod")]
                .map(m => m.dataset.mod).join(",");
            out.orderSaved = (localStorage.getItem("lcl-sb-order") || "");

            closeFileViewer();
            toggleWorkspace(false);
            delete window.__harness.FIXTURES.listFiles;
            delete window.__harness.FIXTURES.viewFile;
            delete active.repoPath;
            renderWorkspace();
            document.getElementById("task-panel").classList.add("hidden");
            document.getElementById("body").style.removeProperty("--ws-w");
            for (const k of ["lcl-sb-grid", "lcl-sb-col-tasks", "lcl-sb-order"])
                localStorage.removeItem(k);
            sbApplySizes();
            return out;
        })()`);
        check("workspace", "PREVIEW IS BORN A COLUMN — 'position 5, being " +
            "Preview and it being its own third column, when active': full " +
            "height, its own track beside the quadrant, from the moment a " +
            "document opens",
            ws.bornColumn, ws);
        check("workspace", "GRAB A COLUMN'S SIDE EDGE and THAT column's width " +
            "follows the pointer — the drag writes the grid's geometry, not " +
            "a card's box",
            ws.colNarrowedBy > 60 && ws.colNarrowedBy < 160, ws);
        check("workspace", "A CARD'S BOTTOM EDGE SIZES THAT CARD — drag it " +
            "toward the panel's floor and the card grows to match the " +
            "pointer, AND ITS ROW NEIGHBOR HOLDS STILL: 'one container " +
            "affects another' is dead",
            ws.rowGrewTo > ws.rowWas + 40 && ws.neighborHeld, ws);
        check("workspace", "...and a crush attempt stops at the card's own " +
            "58px reading floor — no card is ever dragged out of legibility",
            ws.flooredAt >= 50 && ws.flooredAt <= 140, ws.flooredAt);
        check("workspace", "THE GEOMETRY PERSISTS — one lcl-sb-grid record " +
            "carrying the card's height and the column's width, written on " +
            "release, not per frame",
            ws.gridSaved, ws);
        check("workspace", "OWN COLUMN IS ONE CLICK AND ONE CLICK HOME — the " +
            "card becomes a full-height track ('pop it out into its own " +
            "column ... a new button on the card'), the choice persists, and " +
            "the same button returns it to its quadrant slot",
            ws.colModeFullHeight && ws.colModeSaved && ws.colModeBack, ws);
        check("workspace", "the info CARD is movable but not resizable — an " +
            "info card has a natural size, and a height handle on it would " +
            "only stretch whitespace",
            ws.cardHasNoHeightHandle && ws.cardStillMovable, ws);
        check("workspace", "files and preview still scroll their own overflow",
            ws.filesScroll && ws.bodyScroll, ws);
        check("workspace", "PICK AND PLACE still works with the handles in " +
            "place, and the order survives in storage",
            ws.orderBefore !== ws.orderAfter
            && ws.orderSaved.indexOf("files") > 0
            && ws.orderSaved.indexOf("files") < ws.orderSaved.indexOf("wscard"),
            { before: ws.orderBefore, after: ws.orderAfter });
        await shoot(win, "workspace-modules");

        /* ---- the GO strip: three ceilings at once, from the plan's docs ---- */
        const go = await js(`(async () => {
            window.__harness.FIXTURES.usageWindow = () => ({
                planName: "GO", tightest: "h5",
                tiers: [
                    { key: "h5", label: "5h", active: true, usd: 11.04, pct: 92,
                      budgetUsd: 12, start: 111, resetsWords: "resets in 2h 7m" },
                    { key: "week", label: "wk", active: true, usd: 11.04, pct: 36.8,
                      budgetUsd: 30, start: 111, resetsWords: "resets in 4d 2h" },
                    { key: "month", label: "mo", active: true, usd: 11.04, pct: 18.4,
                      budgetUsd: 60, start: 111, resetsWords: "resets in 21d 0h" }
                ] });
            active.messages = [
                { role: "user", content: "q" }, { role: "assistant", content: "a",
                  meta: { model: "m", inTokens: 900, outTokens: 100,
                          systemChars: 500, window: 16384 } }
            ];
            renderMessages(active.messages);
            refreshContextRing();
            document.getElementById("context-ring-wrap").click();
            await new Promise(r => setTimeout(r, 300));
            const tiers = [...document.querySelectorAll("#ctx-plan-tiers .ctx-tier")];
            const out = {
                visible: window.__h.visible(document.getElementById("ctx-plan")),
                name: document.getElementById("ctx-plan-name").innerText,
                tierTexts: tiers.map(t => t.innerText),
                tightMarked: tiers.filter(t => t.classList.contains("tight")).length,
                hotMarked: tiers.filter(t => t.classList.contains("hot")).length,
                reset: document.getElementById("ctx-plan-reset").innerText,
                budgets: ["h5", "week", "month"].map(k =>
                    document.getElementById("ctx-plan-b-" + k).value)
            };
            const input = document.getElementById("ctx-plan-b-week");
            input.value = "45";
            input.dispatchEvent(new Event("change"));
            await new Promise(r => setTimeout(r, 150));
            out.setCalled = (window.lcl.__calls || [])
                .filter(c => c.key === "setGoPlan").pop();
            closeContextPanel();
            delete window.__harness.FIXTURES.usageWindow;
            active.messages = [];
            renderMessages(active.messages);
            return out;
        })()`);
        check("go", "THE GO STRIP METERS ALL THREE PUBLISHED CEILINGS AT ONCE — " +
            "$12/5h, $30/wk, $60/mo (opencode.ai/docs/go) — not one invented " +
            "window",
            go.visible && /GO/.test(go.name) && go.tierTexts.length === 3
            && go.tierTexts[0].includes("5h $11.04/$12")
            && go.tierTexts[1].includes("wk $11.04/$30")
            && go.tierTexts[2].includes("mo $11.04/$60"), go);
        check("go", "...the TIGHTEST tier is the marked one, and at 92% it is " +
            "hot — that is the ceiling the operator is living against",
            go.tightMarked === 1 && go.hotMarked === 1, go);
        check("go", "...with the tightest tier's reset countdown on the strip",
            /resets in 2h 7m/.test(go.reset), go.reset);
        check("go", "...every ceiling is an editable field prefilled with the " +
            "plan's real number",
            go.budgets.join(",") === "12,30,60", go.budgets);
        check("go", "...and editing one writes ALL tiers through the bridge",
            go.setCalled && go.setCalled.args[0]
            && go.setCalled.args[0].week === 45
            && go.setCalled.args[0].h5 === 12, go.setCalled);

        /* ---- the bottom of the context panel is a styled action row ---- */
        const act = await js(`(async () => {
            active.messages = [
                { role: "user", content: "q1" }, { role: "assistant", content: "a1" },
                { role: "user", content: "q2" }, { role: "assistant", content: "a2",
                  meta: { model: "m", inTokens: 900, outTokens: 100,
                          systemChars: 500, window: 16384 } }
            ];
            renderMessages(active.messages);
            refreshContextRing();
            document.getElementById("context-ring-wrap").click();
            await new Promise(r => setTimeout(r, 250));
            const btn = document.getElementById("ctx-compact");
            const cs = getComputedStyle(btn);
            const row = document.getElementById("ctx-actions");
            const note = row.querySelector(".ctx-note");
            const out = {
                classes: btn.className,
                // .primary paints with a GRADIENT — a background-image — so
                // backgroundColor computes transparent on a styled button;
                // either surface being painted is the proof
                styled: cs.borderRadius !== "0px"
                    && (cs.backgroundColor !== "rgba(0, 0, 0, 0)"
                        || cs.backgroundImage !== "none"),
                cursor: cs.cursor,
                sideBySide: note && Math.abs(note.getBoundingClientRect().top
                    - btn.getBoundingClientRect().top) < 24,
                enabled: !btn.disabled
            };
            closeContextPanel();
            active.messages = [];
            renderMessages(active.messages);
            return out;
        })()`);
        check("ctxrow", "THE COMPACT ACTION IS A REAL BUTTON in the app's own " +
            "style — it shipped as class=\"btn\", a class this stylesheet has " +
            "never contained, so the panel's one action was browser chrome",
            /primary/.test(act.classes) && act.styled && act.cursor === "pointer",
            act);
        check("ctxrow", "...enabled for a compactable conversation, with its " +
            "explanation beside it as a caption rather than under it as an essay",
            act.enabled && act.sideBySide, act);
        await shoot(win, "context-actions");
        await js(`(async () => {
            delete window.__harness.FIXTURES.listFiles;
            delete window.__harness.FIXTURES.viewFile;
            closeFileViewer(); toggleWorkspace(false);
            active.ancientKnowledge = false; delete active.repoPath;
            await new Promise(r => setTimeout(r, 250));
            return true;
        })()`);
    },

    /* THE FIFTH SESSION STATE. A staged approval blocks the turn, and the list
     * has to say so differently from a question the operator could ignore —
     * measured as the pixels the dot actually paints, in every state. */
    "session-states": async (win, js) => {
        const m = await js(`(async () => {
            const ids = (window.__harness.SESSIONS || []).map(s => s.id);
            const states = ["idle", "working", "waiting", "approval", "failed"];
            const seen = {};
            for (let i = 0; i < states.length; i++) {
                const id = ids[i % ids.length];
                paintSessionStatus(id, { state: states[i], detail: "measured" });
                const row = document.querySelector('[data-session-id="' + id + '"]');
                const dot = row && row.querySelector(".session-status");
                if (!dot) { seen[states[i]] = null; continue; }
                const cs = getComputedStyle(dot);
                seen[states[i]] = {
                    cls: dot.className,
                    bg: cs.backgroundColor,
                    shadow: cs.boxShadow,
                    w: Math.round(dot.getBoundingClientRect().width),
                    title: dot.title
                };
            }
            return seen;
        })()`);
        observe("session-states", "every state's painted dot", m);
        check("session-states", "ALL FIVE STATES PAINT, each as a real dot",
            ["idle", "working", "waiting", "approval", "failed"]
                .every(s => m[s] && m[s].w >= 6), m);
        check("session-states", "'NEEDS YOUR APPROVAL' IS ITS OWN COLOUR — amber, " +
            "distinct from the purple that used to mean a question, an endpoint " +
            "send and a staged action all at once",
            m.approval && m.waiting
            && m.approval.bg !== m.waiting.bg
            && m.approval.bg !== m.idle.bg && m.approval.bg !== m.failed.bg,
            { approval: m.approval && m.approval.bg, waiting: m.waiting && m.waiting.bg });
        check("session-states", "...and it is the ONLY one with an OUTWARD halo, " +
            "because it is the only state where the work has stopped and cannot " +
            "restart without the operator (the read/acked dot wears a quiet " +
            "INSET ring — a mark, not a shout — which is why inset is excluded)",
            m.approval && /rgb/.test(m.approval.shadow || "")
            && !/inset/.test(m.approval.shadow || "")
            && ["idle", "working", "waiting", "failed"]
                .every(s => { const sh = (m[s] || {}).shadow || "";
                              return !/rgb/.test(sh) || /inset/.test(sh); }),
            Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v && v.shadow])));
        check("session-states", "...and the hover text says what it means, so the " +
            "colour is never the only carrier",
            m.approval && /needs your approval/i.test(m.approval.title || ""),
            m.approval && m.approval.title);
        // REPAINTED IMMEDIATELY BEFORE THE SHOT. The measurements above are the
        // proof; this is so the PICTURE is proof too — a stray re-render of the
        // session list between measuring and shooting had the screenshot
        // showing three default dots while the checks were reading amber.
        const shot = await js(`(async () => {
            const ids = (window.__harness.SESSIONS || []).map(s => s.id);
            const want = ["approval", "working", "waiting"];
            ids.forEach((id, i) => paintSessionStatus(id,
                { state: want[i % want.length], detail: "measured" }));
            await new Promise(r => setTimeout(r, 60));
            return ids.map(id => {
                const row = document.querySelector('[data-session-id="' + id + '"]');
                const dot = row && row.querySelector(".session-status");
                return dot ? getComputedStyle(dot).backgroundColor : null;
            });
        })()`);
        observe("session-states", "dots at the moment of the screenshot", shot);
        check("session-states", "...and they are still distinct when the picture " +
            "is taken — the screenshot is evidence, not decoration",
            new Set(shot.filter(Boolean)).size === 3, shot);
        await shoot(win, "session-states");
        await js(`(() => { (window.__harness.SESSIONS || []).forEach(s =>
            paintSessionStatus(s.id, { state: "idle", detail: "" })); })()`);
    },

    /* WHAT IS FILLING THE WINDOW. The ring says how full; this says with what.
     * Measured as the real arithmetic and the real painted widths — the whole
     * design idea is that the bar sums to 100% of a number the engine
     * vouched for, with the estimator's shortfall shown as "other" rather
     * than hidden. */
    "context-breakdown": async (win, js) => {
        const m = await js(`(() => {
            // the estimator UNDER-counts: 400 chars ~ 100 tokens against a
            // reported 1000, so the remainder must surface as "other"
            const msgs = [
                { role: "user", content: "x".repeat(400) },
                { role: "assistant", content: "y".repeat(800) },
                { role: "tool", content: "z".repeat(1200) }
            ];
            const bd = contextBreakdown(msgs, 1000, 2000);
            const sum = bd.segments.reduce((a, s) => a + s.tokens, 0);
            const widths = bd.segments.reduce((a, s) => a + s.width, 0);
            return { keys: bd.segments.map(s => s.key), sum, widths,
                     other: (bd.segments.find(s => s.key === "other") || {}).tokens,
                     input: bd.inputTokens };
        })()`);
        check("context-breakdown", "THE BUCKETS SUM TO EXACTLY THE TOKENS THE ENGINE " +
            "REPORTED — never an estimate presented as the truth",
            m.sum === 1000 && m.input === 1000, m);
        check("context-breakdown", "...the widths sum to 100% of the bar",
            Math.abs(m.widths - 100) < 0.01, m.widths);
        check("context-breakdown", "...and what the estimator cannot explain is a " +
            "LABELLED 'other' slice, not silently absorbed into the rest",
            m.keys.includes("other") && m.other > 0, m);
        check("context-breakdown", "...instructions, your messages, replies and tool " +
            "output are each their own share",
            ["system", "user", "assistant", "tool"].every(k => m.keys.includes(k)), m.keys);

        // the OVER-count case: everything shrinks proportionally, nothing invented
        const over = await js(`(() => {
            const msgs = [{ role: "user", content: "x".repeat(40000) }];
            const bd = contextBreakdown(msgs, 100, 0);
            return { sum: bd.segments.reduce((a, s) => a + s.tokens, 0),
                     keys: bd.segments.map(s => s.key) };
        })()`);
        check("context-breakdown", "WHEN THE ESTIMATE OVER-COUNTS, every bucket shrinks " +
            "proportionally — the bar can never claim more tokens than were reported",
            over.sum === 100, over);

        const paint = await js(`(async () => {
            renderContextBreakdown(contextBreakdown([
                { role: "user", content: "u".repeat(2000) },
                { role: "assistant", content: "a".repeat(3000) },
                { role: "tool", content: "t".repeat(5000) }
            ], 4000, 6000));
            document.getElementById("context-ring-wrap").classList.remove("hidden");
            const host = document.getElementById("context-breakdown");
            host.style.display = "block";        // hover state, forced for measuring
            await new Promise(r => setTimeout(r, 80));
            const segs = [...host.querySelectorAll(".ctx-bd-seg")];
            const cs = getComputedStyle(host);
            const r = host.getBoundingClientRect();
            return {
                segs: segs.length,
                painted: segs.every(s => s.getBoundingClientRect().width > 0),
                legend: [...host.querySelectorAll(".ctx-bd-item")].map(i => i.innerText.trim()),
                bg: cs.backgroundColor, bgImage: cs.backgroundImage.slice(0, 40),
                contrast: window.__h.contrast(host.querySelector(".ctx-bd-item")).ratio,
                onScreen: r.left >= 0 && r.right <= window.innerWidth + 1,
                w: Math.round(r.width)
            };
        })()`);
        observe("context-breakdown", "painted panel", paint);
        check("context-breakdown", "IT PAINTS — every slice has real width on screen",
            paint.segs >= 3 && paint.painted, paint);
        check("context-breakdown", "...with a legend naming each share in plain words",
            paint.legend.length >= 3
            && paint.legend.some(l => /tool output/.test(l))
            && paint.legend.some(l => /%/.test(l)), paint.legend);
        check("context-breakdown", "...ON AN OPAQUE GROUND. `var(--card-surface, #111114)` " +
            "never reaches its fallback because the variable IS declared — the " +
            "session menu shipped see-through that way once already",
            paint.bg !== "rgba(0, 0, 0, 0)", paint.bg);
        check("context-breakdown", "...so the legend is legible where it sits",
            paint.contrast >= 4.5, paint.contrast);
        check("context-breakdown", "...and it stays inside the window, anchored to a " +
            "control that sits hard against the right edge",
            paint.onScreen, paint);
        await shoot(win, "context-breakdown");
        await js(`(() => {
            const h = document.getElementById("context-breakdown");
            h.style.display = ""; h.classList.add("hidden"); h.innerHTML = "";
            document.getElementById("context-ring-wrap").classList.add("hidden");
        })()`);
    },

    /* THE MODEL LIBRARY. Search an index, see what a model costs, put it on the
     * node — opened for real and measured, including the guard that must stop
     * a model bigger than the node's memory BEFORE the download rather than
     * after it. */
    "model-library": async (win, js) => {
        const m = await js(`(async () => {
            const before = window.__errors.length;
            // a node with known room, so the fit guard has numbers to judge with
            window.__harness.FIXTURES.nodes = () => ({ ok: true, nodes: [
                { id: "node-x", name: "spark", host: "100.64.0.1", reachable: true } ] });
            window.__harness.FIXTURES.nodeDash = () => ({
                ok: true, diskFreeBytes: 800e9, memTotalBytes: 128e9 });
            window.__harness.FIXTURES.modelSearch = () => ({ ok: true, models: [
                { id: "black-forest-labs/FLUX.1-schnell", license: "apache-2.0",
                  gated: false, downloads: 900000 },
                { id: "stabilityai/stable-diffusion-3.5-large", license: "other",
                  gated: true, downloads: 500000 } ] });
            // THE REAL RECIPES, not a hand-written copy — required straight
            // from the engine module so this scene cannot pass against a list
            // that has drifted away from what the app would actually offer.
            window.__harness.FIXTURES.stacks = () => {
                const s = require("../../.lcl.engine/core/nodeStacks.js");
                return { ok: true, stacks: s.STACKS.map(x => ({
                    key: x.key, name: x.name, why: x.why, playbook: x.playbook,
                    serves: x.serves || null, needs: x.needs || null,
                    after: x.after || null, rollback: x.rollback || null,
                    manual: x.manual || null, installable: s.installable(x.key) })) };
            };
            window.__harness.FIXTURES.modelFiles = () => ({ ok: true,
                id: "black-forest-labs/FLUX.1-schnell", license: "apache-2.0", gated: false,
                files: [ { path: "flux1-schnell.safetensors", bytes: 23_800_000_000 },
                         { path: "README.md", bytes: 900 } ] });
            openModelLibrary();
            await new Promise(r => setTimeout(r, 700));
            const modalEl = document.getElementById("modal");
            const txt = modalEl.innerText;
            return {
                open: !document.getElementById("modal-scrim").classList.contains("hidden"),
                xwide: modalEl.classList.contains("xwide"),
                kinds: [...modalEl.querySelectorAll("select")].map(s =>
                    [...s.options].map(o => o.innerText).join("|")),
                nodeLine: (modalEl.innerText.match(/[\\d.]+ ?[GMK]?B free/) || [])[0] || null,
                picks: [...modalEl.querySelectorAll(".model-row-name")].map(n => n.innerText),
                says: txt,
                errs: window.__errors.slice(before)
            };
        })()`);
        check("model-library", "THE PANEL OPENS AND THROWS NOTHING",
            m.open && m.errs.length === 0, m.errs);
        check("model-library", "...on the wide sheet, because a model row carries a " +
            "name, a size and a licence", m.xwide, null);
        check("model-library", "IT OFFERS ALL FOUR MODALITIES — image, video, audio " +
            "and language",
            m.kinds.some(k => /Image/.test(k) && /Video/.test(k)
                && /Audio/.test(k) && /Language/.test(k)), m.kinds);
        check("model-library", "...it reads the NODE'S OWN FREE SPACE, so the size of " +
            "a pull can be judged before it starts",
            !!m.nodeLine && /free/.test(m.nodeLine), m.nodeLine);
        check("model-library", "...and it starts with a curated shortlist rather than " +
            "an empty box — the requirement was an assortment AND the ability " +
            "to add anything",
            m.picks.length >= 3 && m.picks.some(p => /FLUX/.test(p)), m.picks);
        check("model-library", "...saying plainly WHICH CONNECTION carries the download " +
            "— the user's own private one, never the link published to the " +
            "internet — and saying it in their words, not this app's plumbing " +
            "vocabulary",
            /your own private connection/.test(m.says.replace(/\s+/g, " "))
            && /published to the internet/.test(m.says.replace(/\s+/g, " "))
            && !/\bdoor\b|\bFunnel\b/.test(m.says), null);
        // the audio note only shows when audio is the modality — selected here
        // rather than asserted against the whole panel, which would pass for
        // the wrong reason
        const audio = await js(`(async () => {
            const sels = [...document.querySelectorAll("#modal select")];
            const kind = sels.find(s => [...s.options].some(o => /Audio/.test(o.innerText)));
            kind.value = "audio";
            kind.dispatchEvent(new Event("change"));
            await new Promise(r => setTimeout(r, 200));
            return { says: document.getElementById("modal").innerText,
                     picks: [...document.querySelectorAll("#modal .model-row-name")]
                        .map(n => n.innerText) };
        })()`);
        check("model-library", "...and the audio tab tells the AMENDED truth, " +
            "both halves: no audio-GENERATION playbook exists so nothing on " +
            "the node serves those downloads, while audio INPUT now has a " +
            "supported path (Nemotron Omni) and camera OCR is the VLM stack — " +
            "the second playbook read corrected the first survey's flat 'no " +
            "audio', and the panel must not keep saying the stale half-truth",
            /no audio-GENERATION playbook/i.test(audio.says)
            && /self-serve/i.test(audio.says)
            && /Nemotron Omni/i.test(audio.says)
            && /Live VLM/i.test(audio.says), audio.says.slice(0, 240));
        check("model-library", "...while still suggesting real audio models to start from",
            audio.picks.some(p => /whisper/i.test(p)), audio.picks);
        await js(`(async () => {
            const sels = [...document.querySelectorAll("#modal select")];
            const kind = sels.find(s => [...s.options].some(o => /Image/.test(o.innerText)));
            kind.value = "image"; kind.dispatchEvent(new Event("change"));
            await new Promise(r => setTimeout(r, 200));
        })()`);
        /* WHAT RUNS THE WEIGHTS. The stacks list loads asynchronously and sits
         * below the models, so it is scrolled to and measured rather than
         * assumed to have painted. */
        const stacks = await js(`(async () => {
            await new Promise(r => setTimeout(r, 400));
            const heads = [...document.querySelectorAll("#modal .pref-head")]
                .map(h => h.innerText);
            const rows = [...document.querySelectorAll("#modal .model-row")];
            // EVERY stack row, not a hardcoded roster. Naming five of them and
            // counting to five meant adding a playbook broke this scene, which
            // is exactly backwards: the roster is DATA, and the rule is what
            // this scene exists to hold.
            const stackRows = rows.filter(r => {
                const b = r.querySelector("button");
                return b && /Install|playbook/i.test(b.innerText);
            });
            const el = stackRows[0];
            if (el) el.scrollIntoView({ block: "center" });
            await new Promise(r => setTimeout(r, 200));
            return {
                heads,
                names: stackRows.map(r => r.querySelector(".model-row-name").innerText),
                actions: stackRows.map(r => r.querySelector("button").innerText),
                painted: stackRows.every(r => r.getBoundingClientRect().height > 0)
            };
        })()`);
        check("model-library", "WHAT RUNS THE WEIGHTS IS ON THE SAME PANEL — a model " +
            "with nothing to serve it is a file, so the stacks live beside the " +
            "models rather than in a separate place to discover",
            stacks.heads.some(h => /What runs them/i.test(h))
            && stacks.names.length >= 5 && stacks.painted, stacks);
        check("model-library", "...A RECIPE WITH STEPS OFFERS AN INSTALL, AND ONE " +
            "WITHOUT OFFERS THE PLAYBOOK. Isaac Sim and OpenShell stay behind a " +
            "link on purpose — .lcl does not run a multi-gigabyte simulator's " +
            "licensing flow or a security tool's setup behind a button. Asserted " +
            "as the RULE against the live array, because counting a hardcoded " +
            "roster broke this scene every time a playbook was added",
            (() => {
                const stacksMod = require("../../.lcl.engine/core/nodeStacks.js");
                const wantInstall = stacksMod.STACKS
                    .filter(x => stacksMod.installable(x.key)).length;
                const wantRead = stacksMod.STACKS.length - wantInstall;
                return wantInstall >= 15 && wantRead >= 2
                    && stacks.actions.filter(a => /Install/i.test(a)).length === wantInstall
                    && stacks.actions.filter(a => /playbook/i.test(a)).length === wantRead;
            })(),
            { names: stacks.names, actions: stacks.actions });
        await shoot(win, "model-library");

        /* THE FIT GUARD. A model bigger than the node's memory downloads
         * perfectly and then never loads — so it must be refused BEFORE. */
        const guard = await js(`(async () => {
            // a node with almost nothing free
            window.__harness.FIXTURES.nodeDash = () => ({
                ok: true, diskFreeBytes: 8e9, memTotalBytes: 16e9 });
            const sel = document.querySelector("#modal select");
            sel.dispatchEvent(new Event("change"));
            await new Promise(r => setTimeout(r, 250));
            // reveal the 23.8 GB file by asking for details, then try to install
            const details = [...document.querySelectorAll("#modal .model-row button")]
                .find(b => /Details/.test(b.innerText));
            details.click();
            await new Promise(r => setTimeout(r, 300));
            const installBtn = [...document.querySelectorAll("#modal .model-row button")]
                .find(b => /Install/.test(b.innerText));
            const calls0 = (window.lcl.__calls || []).filter(c => c.key === "modelInstall").length;
            installBtn.click();
            await new Promise(r => setTimeout(r, 300));
            const notes = [...document.querySelectorAll("#modal .pref-note")]
                .map(n => n.innerText).join(" ");
            return {
                installs: (window.lcl.__calls || []).filter(c => c.key === "modelInstall").length - calls0,
                notes
            };
        })()`);
        check("model-library", "A MODEL BIGGER THAN THE NODE'S MEMORY IS REFUSED BEFORE " +
            "THE DOWNLOAD — it would pull perfectly and then never load",
            guard.installs === 0 && /against .* of memory|and the node has/.test(guard.notes),
            guard);
        check("model-library", "...and the refusal says the two numbers, not just 'no'",
            /GB/.test(guard.notes), guard.notes);

        await js(`(() => {
            const b = document.getElementById("modal-confirm");
            if (b && !document.getElementById("modal-scrim").classList.contains("hidden")) b.click();
            delete window.__harness.FIXTURES.nodes;
            delete window.__harness.FIXTURES.nodeDash;
            delete window.__harness.FIXTURES.modelSearch;
            delete window.__harness.FIXTURES.modelFiles;
        })()`);
        await js(`(async () => {
            delete window.__harness.FIXTURES.listFiles;
            delete window.__harness.FIXTURES.viewFile;
            closeFileViewer(); toggleWorkspace(false);
            active.ancientKnowledge = false; delete active.repoPath;
            await new Promise(r => setTimeout(r, 250));
            return true;
        })()`);
    },

    // API's & CONNECTIONS — one page for every connection. The add box is a
    // mainstay (zero clicks), every endpoint is a card, the provider row
    // comes from the shipped catalog, and each provider's rates open as
    // their own popup.
    /* THE REFRESH BUTTON ON AN ENDPOINT CARD. Reported failing on a real
     * install with nothing in the audit log to say why. The click is driven
     * for real here: the seam is what happens AFTER the IPC returns ok —
     * refreshing a model list must not tear the panel down. */
    "card-refresh": async (win, js) => {
        const r = await js(`(async () => {
            const before = window.__errors.length;
            openConnections();
            await new Promise(r => setTimeout(r, 500));
            const card = document.querySelector("#modal .cloud-card");
            const btn = card && [...card.querySelectorAll(".cloud-card-acts button")]
                .find(b => /refresh/i.test(b.getAttribute("title") || ""));
            if (!btn) return { noButton: true, errs: window.__errors.slice(before) };
            btn.click();
            await new Promise(r => setTimeout(r, 900));
            const scrim = document.getElementById("modal-scrim");
            const out = {
                stillOpen: !scrim.classList.contains("hidden"),
                title: (document.getElementById("modal-title") || {}).innerText || "",
                cards: document.querySelectorAll("#modal .cloud-card").length,
                status: (card.querySelector(".cloud-ep-status") || {}).innerText || "",
                errs: window.__errors.slice(before)
            };
            closeModal();
            await new Promise(r => setTimeout(r, 200));
            return out;
        })()`);
        check("card-refresh", "REFRESHING A MODEL LIST DOES NOT TEAR THE PANEL " +
            "DOWN — the card updates in place. It used to closeModal() and " +
            "re-open the whole sheet, which on a real install reads as the " +
            "panel vanishing: \"tried to refresh deep infra ... and it failed\"",
            !r.noButton && r.stillOpen && r.cards >= 1
            && /API|Connections/i.test(r.title) && r.errs.length === 0, r);
        check("card-refresh", "...and it SAYS what it found rather than going quiet",
            !r.noButton && /model/i.test(r.status), r);
        await shoot(win, "card-refresh");
    },
    "add-go": async (win, js) => {
        const r = await js(`(async () => {
            openConnections();     // NOT awaited: modal() blocks until it closes
            await new Promise(r => setTimeout(r, 500));
            const title = document.getElementById("modal-title").innerText;
            const sections = document.querySelectorAll("#modal .conn-mod").length;
            const chips = [...document.querySelectorAll("#modal .cloud-presets button")]
                .map(b => b.innerText);
            const cards = [...document.querySelectorAll("#modal .cloud-card")]
                .map(c => ({
                    name: (c.querySelector(".cloud-card-name") || {}).innerText || "",
                    // icon buttons carry their meaning in the title, text buttons
                    // in innerText — read both
                    acts: [...c.querySelectorAll(".cloud-card-acts button")]
                        .map(b => (b.innerText || "") + " " + (b.getAttribute("title") || "")),
                    ratesPrimary: !!c.querySelector(".cloud-card-acts button.primary"),
                    iconBtns: c.querySelectorAll(".cloud-card-acts button svg").length
                }));
            const addBox = document.querySelector("#modal .cloud-add");
            const goChip = [...document.querySelectorAll("#modal .cloud-presets button")]
                .find(b => /OpenCode GO/i.test(b.innerText));
            let filled = "";
            if (goChip) {
                goChip.click();
                await new Promise(r => setTimeout(r, 100));
                filled = (document.querySelector("#modal .cloud-paste") || {}).value || "";
            }
            // a provider's rates are a POPUP, not a wall of tables on the page —
            // and it must paint ON TOP of the modal it opened from, not behind it
            let popHead = false, popRateHead = false, popOnTop = false, popRows = 0;
            const rateBtn = [...document.querySelectorAll("#modal .cloud-card-acts button")]
                .find(b => /rates/i.test(b.innerText));
            if (rateBtn) {
                rateBtn.click();
                await new Promise(r => setTimeout(r, 250));
                const pop = document.querySelector(".rate-pop");
                popHead = !!(pop && pop.querySelector(".rate-pop-head"));
                popRateHead = !!(pop && pop.querySelector(".pref-rate-head"));
                popRows = pop ? pop.querySelectorAll(".pref-rate-row").length : 0;
                if (pop) {
                    // the point at the popup's centre must resolve to the popup
                    // (or its children), not the modal scrim underneath it
                    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
                    const hit = document.elementFromPoint(cx, cy);
                    popOnTop = !!(hit && (hit === pop || pop.contains(hit)));
                }
            }
            const undef = /undefined/.test(document.getElementById("modal").innerText);
            return { title, sections, chips, cards, hasAdd: !!addBox,
                     filled, popHead, popRateHead, popOnTop, popRows, undef };
        })()`);
        check("add-go", "THE PAGE IS API's & CONNECTIONS — sectioned containers, " +
            "and the add box with the GO chip is on it with ZERO clicks",
            /api'?s & connections/i.test(r.title) && r.sections >= 3
            && r.hasAdd && r.chips.some(c => /OpenCode GO/i.test(c)), r);
        check("add-go", "...the provider row comes from the SHIPPED CATALOG — " +
            "Grok is a chip, not two hardcoded names",
            r.chips.some(c => /grok/i.test(c)), r.chips);
        check("add-go", "...every linked endpoint is a CARD with View Rates as a " +
            "PRIMARY button and icon controls (Test / circular-arrow Refresh / " +
            "trash Disconnect)",
            r.cards.length >= 2 && r.cards.every(c =>
                c.ratesPrimary
                && c.acts.some(a => /view rates/i.test(a))
                && c.acts.some(a => /test/i.test(a))
                && c.acts.some(a => /refresh/i.test(a))
                && c.acts.some(a => /disconnect/i.test(a))
                && c.iconBtns >= 3), r.cards);
        check("add-go", "...clicking the GO chip fills GO's OWN base URL — " +
            "opencode.ai/zen/go/v1, a separate provider from Zen per the docs",
            /opencode\.ai\/zen\/go\/v1/.test(r.filled), r.filled);
        check("add-go", "...a card's Rates button opens the provider-specific " +
            "popup with a labelled header AND ITS ROWS, and it paints ON TOP of " +
            "the modal — not behind the scrim, which read as a dead button",
            r.popHead && r.popRateHead && r.popRows >= 1 && r.popOnTop && !r.undef, r);
        await shoot(win, "add-go");
        await js(`(async () => {
            document.querySelectorAll(".rate-pop").forEach(el => el.remove());
            closeModal();
            await new Promise(r => setTimeout(r, 150));
            return true;
        })()`);
    },

    // RIGHT SIDEBAR TRUE MODULARITY: every section has a header bar with
    // minimize + pop-out, a triple-dot menu hides/shows a section's VIEW, and a
    // popped section floats as a fixed card. Driven and measured off the DOM.
    /* THE FILE EXPLORER PAINTS WITHOUT BEING POKED. Reported from a real
     * install: after linking a folder the Files module showed nothing, and the
     * files only appeared after popping the card out and docking it again —
     * they did not appear without intervention. The default state has to render
     * the data the container exists to show. */
    "files-default-state": async (win, js) => {
        const r = await js(`(async () => {
            const before = window.__errors.length;
            active = active || (window.__harness.SESSIONS[0]);
            active.repoPath = "D:\\\\work\\\\repo";
            // OWN THE FIXTURE. Scenes share one page, and an earlier one can
            // leave listFiles answering for a different folder — which is how
            // this passed alone and reported zero files in the full run.
            window.__harness.FIXTURES.listFiles = () => ({
                repoPath: "D:\\\\work\\\\repo", truncated: false, total: 4,
                entries: [".lcl/ancient_knowledge.md (812 bytes)",
                          "README.md (1200 bytes)",
                          "src/index.js (3400 bytes)",
                          "src/util/parse.js (900 bytes)"] });
            await renderWorkspace();
            await new Promise(r => setTimeout(r, 400));
            const mod = document.querySelector('[data-mod="files"]');
            const rows = () => document.querySelectorAll("#ws-files .ws-file").length;
            const docked = rows();
            // textContent, not innerText: innerText returns "" for an element
            // that is not laid out, which is exactly the state under test
            const meta = ($("ws-meta") || {}).textContent || "";
            const box = document.getElementById("ws-files");
            const h = box ? Math.round(box.getBoundingClientRect().height) : 0;
            // now pop it out and back, the workaround the operator found
            if (mod) { sbTogglePop(mod); await new Promise(r => setTimeout(r, 300)); }
            const popped = rows();
            if (mod) { sbDock(mod); await new Promise(r => setTimeout(r, 300)); }
            const redocked = rows();
            return { docked, popped, redocked, meta, h,
                     errs: window.__errors.slice(before) };
        })()`);
        check("files-default-state", "THE FILE LIST IS THERE THE MOMENT A FOLDER " +
            "IS LINKED — no pop-out required. The container has to paint the " +
            "data it exists to show, in its default state",
            r.docked > 0 && r.errs.length === 0, r);
        check("files-default-state", "...and popping it out changes nothing about " +
            "WHAT is listed — same rows docked, popped and re-docked",
            r.docked === r.popped && r.popped === r.redocked, r);
        check("files-default-state", "...and the list is VISIBLE while docked — " +
            "rows that exist at zero height are the bug the operator hit: the " +
            "data was there and the container was not showing it",
            r.h > 0, { height: r.h });
        check("files-default-state", "...and the count is the REAL one, not the " +
            "length of a truncated slice with a plus sign",
            /\b4 files\b/.test(r.meta), r.meta);
        await shoot(win, "files-default-state");
    },
    /* ANCIENT KNOWLEDGE, DRESSED AS THE USER — open list 7c #2, verbatim:
     * "It must read as though the user sent it: keep the brain SVG, the
     * title and the colour, but the bubble background matches a user
     * message. The brain's colour must match the reasoning-level colour
     * mapped to that SVG." Measured with computed styles, not class names. */
    "ancient-look": async (win, js) => {
        const r = await js(`(async () => { try {
            const was = active.effortLevel;
            active.effortLevel = 3;
            const u = addMessageRow("user", "check my work", 90001);
            const a = addMessageRow("assistant",
                "**Ancient Knowledge Audit:** the build holds.", 90002,
                { model: "ancient-knowledge" });
            await new Promise(r2 => setTimeout(r2, 80));
            const bubble = a.querySelector(".msg-ancient");
            const userB = u.querySelector(".msg-user");
            const head = a.querySelector(".msg-ancient-head");
            const cs = getComputedStyle(bubble), cu = getComputedStyle(userB);
            const out = {
                userSide: getComputedStyle(a).alignSelf === "flex-end",
                sameGround: cs.backgroundImage === cu.backgroundImage
                    && cs.backgroundImage.includes("linear-gradient"),
                brainKept: !!head.querySelector("svg")
                    && /ancient knowledge/i.test(head.innerText),
                effortClass: head.className.includes("effort-3"),
                headColor: getComputedStyle(head).color,
                stripped: !/\\*\\*Ancient Knowledge Audit:\\*\\*/.test(
                    a.querySelector(".msg-ancient-body").innerText)
            };
            // #b88fe0 = effort-3, the composer brain's own violet
            out.effortColour = out.headColor === "rgb(184, 143, 224)";
            u.remove(); a.remove();
            active.effortLevel = was;
            return out;
        } catch (e) { return { threw: String(e.stack).slice(0, 300) }; } })()`);
        check("ancient-look", "THE AUDIT READS AS THE USER'S — right side, the user " +
            "bubble's own painted ground (computed equal), the brain SVG and title " +
            "kept, the redundant bold prefix stripped",
            !r.threw && r.userSide && r.sameGround && r.brainKept && r.stripped, r);
        check("ancient-look", "...and the brain wears the session's reasoning colour — " +
            "effort 3 paints the head in the composer brain's own violet",
            r.effortClass === true && r.effortColour === true, r);
        await shoot(win, "ancient-look");
    },

    /* CONTRIBUTOR SHIP — the release ritual in one panel, fixtures standing
     * in for gh/git: identity and versions painted from status/plan, the
     * fields drafted by the (stubbed) model, the stream landing in the
     * talking step, the run confirmed and called with the EDITED fields. */
    ship: async (win, js) => {
        const r = await js(`(async () => { try {
            window.__harness.FIXTURES.contribStatus = () => ({ ok: true,
                repo: "C:/checkout", missing: [],
                remote: { owner: "Org", repo: "lcl" },
                identity: { name: "Contributor",
                            email: "1+c@users.noreply.github.com", login: "c" },
                running: false });
            window.__harness.FIXTURES.contribPlan = () => ({ repo: "C:/checkout",
                files: ["M app/main.js"], dirtyCount: 12, official: 11,
                version: "1.0.9", latestTag: "v1.0.9", willBump: true,
                bumpNote: "v1.0.9 is already published — this ship bumps to v1.0.10 · official #12",
                nextVersion: "1.0.10", nextOfficial: 12, branch: "public" });
            window.__harness.FIXTURES.contribDraft = () => ({
                commitMessage: "Fix the dock overlap",
                releaseNotes: "Cards no longer overlap.", model: "qwen" });
            let ranOpts = null;
            window.__harness.FIXTURES.contribRun = (opts) => { ranOpts = opts;
                return new Promise(res => setTimeout(
                    () => res({ ok: true, version: "1.0.10" }), 300)); };
            await openShipPanel();
            await new Promise(r2 => setTimeout(r2, 250));
            const out = {
                identity: document.getElementById("ship-identity").innerText,
                versions: document.getElementById("ship-versions").innerText,
                bumpNote: document.getElementById("ship-bump-note").innerText,
                msg: document.getElementById("ship-commit-msg").value,
                notes: document.getElementById("ship-notes").value,
                steps: document.querySelectorAll("#ship-steps .ship-step").length,
                runEnabled: !document.getElementById("ship-run").disabled
            };
            // the stream lands in the step that is talking, and opens it
            window.lcl.__fire("onContribProgress", { step: "gate", state: "running" });
            window.lcl.__fire("onContribProgress", { step: "gate", line: "1. Test suite" });
            window.lcl.__fire("onContribProgress", { step: "gate", line: "4591 checks passed" });
            await new Promise(r2 => setTimeout(r2, 60));
            const gateEl = document.querySelector('.ship-step[data-step="gate"]');
            out.gateRunning = gateEl.classList.contains("running")
                && gateEl.classList.contains("open");
            out.gateLines = gateEl.querySelector(".ship-step-out")
                .textContent.includes("4591 checks passed");
            window.lcl.__fire("onContribProgress", { step: "gate", state: "done" });
            // the operator EDITS the drafted message — the edit must be what runs
            document.getElementById("ship-commit-msg").value =
                "Fix the dock overlap for real";
            document.getElementById("ship-run").click();
            await new Promise(r2 => setTimeout(r2, 150));
            const confirm = [...document.querySelectorAll("#modal-scrim button")]
                .find(b => /ship it/i.test(b.innerText));
            out.confirmShown = !!confirm;
            if (confirm) confirm.click();
            await new Promise(r2 => setTimeout(r2, 120));
            out.cancelVisibleWhileRunning =
                !document.getElementById("ship-cancel").classList.contains("hidden");
            await new Promise(r2 => setTimeout(r2, 350));
            out.ranWith = ranOpts && { bump: ranOpts.bump, msg: ranOpts.commitMessage,
                name: ranOpts.name, email: ranOpts.email };
            out.liveState = document.getElementById("ship-state").innerText;

            // THE LAST RUN'S EVIDENCE REPLAYS — close, reopen onto a recorded
            // failure, and the failed step comes back open with its output
            document.getElementById("ship-close").click();
            window.__harness.FIXTURES.contribLastRun = () => ({
                at: 1, ok: false, failedStep: "push", version: null,
                states: { bump: "done", add: "done", commit: "done", push: "failed" },
                transcript: { push: ["$ git push origin public:main",
                    "error: failed to push some refs"] } });
            await openShipPanel();
            await new Promise(r2 => setTimeout(r2, 250));
            const pushEl = document.querySelector('.ship-step[data-step="push"]');
            out.replayFailed = pushEl.classList.contains("failed")
                && pushEl.classList.contains("open")
                && pushEl.querySelector(".ship-step-out")
                    .textContent.includes("failed to push some refs");
            out.replayNote = /previous run failed at push/.test(
                document.getElementById("ship-state").innerText);

            for (const k of ["contribStatus", "contribPlan", "contribDraft",
                             "contribRun", "contribLastRun"])
                delete window.__harness.FIXTURES[k];
            document.getElementById("ship-close").click();
            return out;
        } catch (e) { return { threw: String(e.stack).slice(0, 300) }; } })()`);
        check("ship", "THE PANEL KNOWS WHO AND WHAT WITHOUT TYPING OR ASKING — " +
            "identity from gh/git config, the lanes and published tag from the " +
            "plan, and the bump is a STATED DECISION, not a checkbox: 'why even " +
            "ask' — the line names exactly what will happen and why",
            !r.threw && /as Contributor <1\+c@users\.noreply\.github\.com>/.test(r.identity || "")
            && /tree v1\.0\.9 · official #11/.test(r.versions || "")
            && /published v1\.0\.9/.test(r.versions || "")
            && /already published — this ship bumps to v1\.0\.10 · official #12/.test(r.bumpNote || ""), r);
        check("ship", "...the local model's draft fills both fields, editable, and all " +
            "six steps stand ready with the run enabled",
            r.msg === "Fix the dock overlap"
            && /no longer overlap/.test(r.notes || "")
            && r.steps === 6 && r.runEnabled === true, r);
        check("ship", "THE STREAM IS THE SHOW — a running step opens itself, its dot " +
            "pulses, and every output line lands in its own console",
            r.gateRunning === true && r.gateLines === true, r);
        check("ship", "the run CONFIRMS first, then calls main with the operator's " +
            "EDITED message and the read identity — cancel offered while live, " +
            "and the finish is announced by version",
            r.confirmShown === true && r.cancelVisibleWhileRunning === true
            && r.ranWith && r.ranWith.msg === "Fix the dock overlap for real"
            && r.ranWith.bump === undefined   /* the bump is main's decision now */
            && r.ranWith.name === "Contributor"
            && /v1\.0\.10 is live/.test(r.liveState || ""), r);
        check("ship", "THE LAST RUN'S EVIDENCE REPLAYS ON REOPEN — the failed step " +
            "comes back open with its own stderr and the state line names it " +
            "(the first real failure left nothing but 'exited 1' behind)",
            r.replayFailed === true && r.replayNote === true, r);
        await shoot(win, "ship");
    },

    /* THE STUCK APPROVAL, REPRODUCED FROM THE OPERATOR'S OWN SESSION.
     * "did not complete and prompted me for input, but the prompt never
     * appeared, it was waiting on something that it never asked me, but said
     * it was asking me." His session file: user goal → tool message CARRYING
     * the proposal (run_dev_server, classification execute) → orchestrator
     * summary saying "Approve it below". The transcript shape is verbatim;
     * the card must render from it, answerable, every time it paints. */
    "staged-card": async (win, js) => {
        const r = await js(`(async () => { try {
            const stuck = {
                id: "s-staged", title: "extract the data from this PDF",
                messages: [
                    { role: "user", content: "extract the data and build a tool" },
                    { role: "tool", name: "run_dev_server",
                      content: "Shown to the user for approval (execute action). It has NOT run. Wait for their decision — do not attempt it another way.",
                      failed: false, repaired: false, truncatedBody: false, notified: false,
                      proposal: { kind: "tool", id: "tool-repro-1", tool: "run_dev_server",
                          args: { dir: "", port: "0" }, digest: "",
                          classification: "execute", capability: "sys.execute",
                          capabilityLabel: "Running commands",
                          sessionId: "s-staged", repoPath: "C:/fake", target: null } },
                    { role: "assistant",
                      content: "Paused — an action needs your approval (7 file(s) so far). Approve it below to run it, then send your next message to continue the build.",
                      meta: { model: "orchestrator", planSteps: 6, files: 7, steps: [] } }
                ]
            };
            const origGetSession = window.__harness.FIXTURES.getSession;
            window.__harness.FIXTURES.getSession = (id) => id === "s-staged" ? stuck
                : origGetSession(id);
            await switchSession("s-staged");
            await new Promise(r => setTimeout(r, 300));
            const card = document.querySelector(".tool-approval");
            const out = {
                cardRendered: !!card,
                names: !!card && /run dev server/i.test(card.innerText),
                saysNothingRan: !!card && /Nothing has run yet/.test(card.innerText),
                answerable: !!card && [...card.querySelectorAll("button")].length > 0,
                summaryShown: [...document.querySelectorAll(".msg-row.assistant")]
                    .some(m => /needs your approval/.test(m.innerText || ""))
            };
            // an expired approval (app restarted since staging) answers
            // HONESTLY instead of spinning — the map in main is gone
            window.__harness.FIXTURES.approveTool =
                () => ({ ok: false, error: "unknown or expired proposal" });
            const btn = card && [...card.querySelectorAll("button")]
                .find(b => /only this once/i.test(b.innerText));
            if (btn) { btn.click(); await new Promise(r => setTimeout(r, 250)); }
            out.expiredHonest = !!card && /Expired \\(the app restarted\\)/.test(card.innerText);
            // THE LIVE PATH: the turn that ENDS by staging draws the card the
            // moment its result lands — this is the moment the operator
            // watched fail ("said it was asking me" with nothing asked)
            const live = { id: "s-live", title: "live", messages: [] };
            window.__harness.FIXTURES.getSession = (id) =>
                id === "s-staged" ? stuck : id === "s-live" ? live : origGetSession(id);
            window.__harness.FIXTURES.chat = () => ({
                id: "s-live", title: "live",
                new_messages: JSON.parse(JSON.stringify(stuck.messages)),
                changes: []
            });
            await switchSession("s-live");
            await new Promise(r => setTimeout(r, 200));
            await sendText("extract the data and build a tool", active);
            await new Promise(r => setTimeout(r, 350));
            out.liveCard = !!document.querySelector(".tool-approval");
            out.livePause = [...document.querySelectorAll(".msg-row.assistant")]
                .some(m => /needs your approval/.test(m.innerText || ""));
            delete window.__harness.FIXTURES.chat;

            // THE ORPHANED COMPLETION: the renderer lost the turn's reply (a
            // reload mid-turn, a dropped IPC) — main finished, persisted, and
            // set the status; nothing in this renderer owns the completion.
            // The status event alone must land the ask on screen.
            const orphanState = { current: { id: "s-orphan", title: "orphan", messages: [] } };
            window.__harness.FIXTURES.getSession = (id) =>
                id === "s-orphan" ? orphanState.current
                : id === "s-staged" ? stuck : origGetSession(id);
            await switchSession("s-orphan");
            await new Promise(r => setTimeout(r, 200));
            out.orphanBlankFirst = !document.querySelector(".tool-approval");
            // ...the turn "finishes" on disk while this renderer holds nothing
            orphanState.current = { id: "s-orphan", title: "orphan",
                messages: JSON.parse(JSON.stringify(stuck.messages)) };
            window.lcl.__fire("onSessionStatus", { sessionId: "s-orphan",
                state: "approval", detail: "an action needs your approval" });
            await new Promise(r => setTimeout(r, 350));
            out.orphanHealed = !!document.querySelector(".tool-approval")
                && [...document.querySelectorAll(".msg-row.assistant")]
                    .some(m => /needs your approval/.test(m.innerText || ""));

            window.__harness.FIXTURES.getSession = origGetSession;
            delete window.__harness.FIXTURES.approveTool;
            await switchSession("s1");
            return out;
        } catch (e) { return { threw: true, stack: String(e.stack).slice(0, 500) }; } })()`);
        check("staged-card", "A SESSION REOPENED ONTO A STAGED APPROVAL DRAWS THE CARD — " +
            "the proposal-bearing tool message renders as an answerable approval, " +
            "with the pause summary beside it, never a claim of asking with " +
            "nothing asked",
            r.cardRendered && r.names && r.saysNothingRan && r.answerable
            && r.summaryShown, r);
        check("staged-card", "...and an approval whose in-memory record died with an app " +
            "restart says so HONESTLY on the card — 'Expired (the app restarted) — " +
            "ask again to re-stage it'",
            r.expiredHonest, r);
        check("staged-card", "THE LIVE PATH DRAWS IT TOO — a turn that ends by staging " +
            "paints the card the moment its result lands, beside the pause summary, " +
            "with the operator watching",
            r.liveCard && r.livePause, r);
        check("staged-card", "AN ORPHANED COMPLETION STILL LANDS — when the renderer " +
            "lost the turn's reply (reload mid-turn, dropped IPC), the status event " +
            "alone heals the transcript: the ask appears, instead of a status that " +
            "says 'asking you' over a transcript that never asks",
            r.orphanBlankFirst && r.orphanHealed, r);
        await shoot(win, "staged-card");
    },

    "sidebar-modular": async (win, js) => {
        const r = await js(`(async () => {
            const before = window.__errors.length;
            toggleWorkspace(true);
            // make two sections real so their modules paint
            document.getElementById("task-panel").classList.remove("hidden");
            document.getElementById("activity-panel").classList.remove("hidden");
            await new Promise(r => setTimeout(r, 200));
            const tasks = document.querySelector('#sb-mods .sb-mod[data-mod="tasks"]');
            const header = tasks && tasks.querySelector(":scope > .sb-mod-head");
            const hasMin = !!(header && header.querySelector(".sb-mod-btn.sb-min"));
            const hasPop = !!(header && header.querySelector(".sb-mod-btn.sb-pop"));
            const hasTitle = !!(header && header.querySelector(".sb-mod-title"));

            // minimize → collapses to the header AND drops to the TRAY: a
            // full-width bar at the bottom of the panel, not a half-empty cell
            header.querySelector(".sb-mod-btn.sb-min").click();
            await new Promise(r => setTimeout(r, 120));
            const tRect = tasks.getBoundingClientRect();
            const others = [...document.querySelectorAll("#sb-mods > .sb-mod")]
                .filter(m => m !== tasks && getComputedStyle(m).display !== "none");
            const minimized = tasks.classList.contains("sb-minimized")
                && Math.round(tRect.height) <= 26;
            const inTray = tasks.style.gridColumn === "1 / -1"
                && others.every(m => tRect.top >= m.getBoundingClientRect().top - 1);

            // pop out STRAIGHT FROM THE TRAY → floats expanded, and the
            // minimized KEY clears with the class — the desync here booted a
            // card minimized after a reload though it was left expanded
            header.querySelector(".sb-mod-btn.sb-pop").click();
            await new Promise(r => setTimeout(r, 100));
            const popped = tasks.classList.contains("sb-popped")
                && getComputedStyle(tasks).position === "fixed"
                && tasks.parentElement === document.body;
            const minKeyCleared =
                localStorage.getItem("lcl-sb-min-tasks") !== "1"
                && !tasks.classList.contains("sb-minimized");
            const placeholder = !!document.querySelector('.sb-mod-placeholder[data-for="tasks"]');
            // WHILE FLOATING: the pop-out and column buttons are gone — "we
            // dont need the pop out button when popped out" — and the
            // MINIMIZE button is the way home
            const popBtnGone = getComputedStyle(
                tasks.querySelector(".sb-mod-btn.sb-pop")).display === "none";
            const colBtnGone = getComputedStyle(
                tasks.querySelector(".sb-mod-btn.sb-colbtn")).display === "none";
            tasks.querySelector(".sb-mod-btn.sb-min").click();   // the way home
            await new Promise(r => setTimeout(r, 100));
            const docked = !tasks.classList.contains("sb-popped")
                && tasks.parentElement.id === "sb-mods"
                && !tasks.classList.contains("sb-minimized");

            // triple-dot → hide the activity section's VIEW
            document.getElementById("sb-view-menu-btn").click();
            await new Promise(r => setTimeout(r, 80));
            const menuOpen = !document.getElementById("sb-view-menu").classList.contains("hidden");
            const rows = document.querySelectorAll("#sb-view-menu .sb-view-row").length;
            const actBox = [...document.querySelectorAll("#sb-view-menu .sb-view-row")]
                .find(r => /activity/i.test(r.innerText));
            let hidView = false;
            if (actBox) {
                actBox.querySelector("input").click();
                await new Promise(r => setTimeout(r, 80));
                const act = document.querySelector('#sb-mods .sb-mod[data-mod="activity"]');
                hidView = act.classList.contains("sb-hidden-view");
                actBox.querySelector("input").click();   // restore
            }
            return { hasMin, hasPop, hasTitle, minimized, inTray, popped,
                     placeholder, popBtnGone, colBtnGone, minKeyCleared,
                     docked, menuOpen, rows, hidView, errs: window.__errors.slice(before) };
        })()`);
        check("sidebar-modular", "EVERY SECTION HAS A HEADER BAR — grip title, " +
            "column, minimize and pop-out — and driving it throws nothing",
            r.hasTitle && r.hasMin && r.hasPop && r.errs.length === 0, r);
        check("sidebar-modular", "MINIMIZE collapses a section to its header AND " +
            "drops it to the TRAY — a full-width bar at the bottom of the " +
            "panel, below every live card, never a half-empty quadrant cell",
            r.minimized && r.inTray, r);
        check("sidebar-modular", "POP-OUT floats the card on the body (leaving a " +
            "placeholder); WHILE FLOATING the pop-out and column buttons are " +
            "gone and the MINIMIZE button is the way home — 'we dont need the " +
            "pop out button when popped out, we need the minimize button to " +
            "minimize the popped out window back into the tray to its slot'",
            r.popped && r.placeholder && r.popBtnGone && r.colBtnGone
            && r.docked, r);
        check("sidebar-modular", "POPPING A TRAY BAR CLEARS THE MINIMIZED KEY with the " +
            "class — the session's end state and the reload's restored state can " +
            "never diverge (adversarial review: a stale lcl-sb-min-* booted a card " +
            "minimized that was left expanded)",
            r.minKeyCleared, r);
        check("sidebar-modular", "THE TRIPLE-DOT MENU lists the sections and hides " +
            "a section's VIEW without removing it from the dock structure",
            r.menuOpen && r.rows >= 4 && r.hidView, r);
        // a popped card's edge-resize handles are hidden (they would resize
        // against the sidebar width and leak the docked-size keys)
        const popClean = await js(`(async () => {
            const tasks = document.querySelector('#sb-mods .sb-mod[data-mod="tasks"]');
            const head = tasks.querySelector(":scope > .sb-mod-head");
            head.querySelector(".sb-mod-btn.sb-pop").click();   // pop
            await new Promise(r => setTimeout(r, 80));
            const handle = tasks.querySelector(".sb-h-bottom");
            const hidden = !handle || getComputedStyle(handle).display === "none";
            tasks.querySelector(".sb-mod-btn.sb-min").click();  // the way home
            await new Promise(r => setTimeout(r, 80));
            return hidden;
        })()`);
        check("sidebar-modular", "a POPPED card's dock edge-handles are hidden — " +
            "they would resize against the sidebar width and leak a bad height " +
            "back into the dock",
            popClean, popClean);
        await shoot(win, "sidebar-modular");
        await js(`(async () => {
            document.getElementById("task-panel").classList.add("hidden");
            document.getElementById("activity-panel").classList.add("hidden");
            // leave no lcl-sb-* state to pollute later scenes
            for (const k of Object.keys(localStorage))
                if (k.indexOf("lcl-sb-") === 0) localStorage.removeItem(k);
            return true;
        })()`);
    },

    // MODEL ORCHESTRATION — rich grouped pickers (modes always shown, GPU
    // reserved even when empty), the pay-list GONE, a single Pay-for-API toggle
    // with a toast. Reached from Session.
    "orchestration": async (win, js) => {
        const r = await js(`(async () => {
            const before = window.__errors.length;
            // drop the rented GPU model so that MODE is genuinely empty — the
            // operator asked it still hold its place, "empty if there are none"
            const full = window.__harness.FIXTURES.listModels;
            window.__harness.FIXTURES.listModels = () => ({
                models: full().models.filter(m => !m.rented) });
            openEscalation();     // NOT awaited: modal() blocks until closed
            await new Promise(r => setTimeout(r, 400));
            window.__harness.FIXTURES.listModels = full;
            const modalEl = document.getElementById("modal");
            // open the first field's picker and read its groups
            const trig = document.querySelector("#modal .mode-pick-trigger");
            if (trig) trig.click();
            await new Promise(r => setTimeout(r, 120));
            // the panel IS the chat picker: .model-menu with .model-tier tiers,
            // collapsible .model-provider branches, and .model-row rows
            const panel = document.querySelector("#modal .mode-pick-panel.model-menu:not(.hidden)");
            const tiers = panel ? [...panel.querySelectorAll(".model-tier .model-tier-name")]
                .map(n => n.innerText) : [];
            const emptyTiers = panel ? panel.querySelectorAll(".model-tier.empty").length : 0;
            // open the API tier to reveal a provider branch + rows
            let providerBranch = false, rowKinds = [];
            const apiTier = panel && [...panel.querySelectorAll(".model-tier")]
                .find(t => /API/.test(t.innerText) && !t.classList.contains("empty"));
            if (apiTier) {
                apiTier.click();
                await new Promise(r => setTimeout(r, 80));
                providerBranch = !!panel.querySelector(".model-provider");
                const prov = panel.querySelector(".model-provider");
                if (prov) { prov.click(); await new Promise(r => setTimeout(r, 60)); }
                rowKinds = [...panel.querySelectorAll(".model-row .model-kind")].map(c => c.innerText);
            }
            return {
                open: !document.getElementById("modal-scrim").classList.contains("hidden"),
                title: document.getElementById("modal-title").innerText,
                fields: document.querySelectorAll("#modal .orch-row").length,
                isChatMenu: !!panel,
                tiers, emptyTiers, providerBranch, rowKinds,
                payToggle: !!document.querySelector("#modal .orch-pay-row .sec-toggle input"),
                hasToast: !!document.querySelector("#modal .orch-toast"),
                payListGone: !/may pay for/i.test(modalEl.innerText)
                    && document.querySelectorAll("#modal .kn-link-row").length === 0,
                errs: window.__errors.slice(before)
            };
        })()`);
        check("orchestration", "OPENS FROM SESSION AND THROWS NOTHING, with one " +
            "field per kind of work",
            r.open && /orchestration/i.test(r.title) && r.fields >= 5 && r.errs.length === 0, r);
        check("orchestration", "EACH FIELD'S DROPDOWN IS THE CHAT MODEL SELECTOR — " +
            "a .model-menu tree with all four .model-tier modes (GPU empty holds " +
            "its place), collapsible provider branches, and kind-chipped rows",
            r.isChatMenu && r.tiers.length >= 4
            && ["local", "local nodes", "api", "gpu"].every(t =>
                r.tiers.some(x => x.toLowerCase().includes(t)))
            && r.emptyTiers >= 1 && r.providerBranch
            && r.rowKinds.some(k => /api/i.test(k)), r);
        check("orchestration", "THE PAY-LIST IS GONE — replaced by ONE 'Pay for " +
            "API on behalf' toggle and a toast, no re-selecting models below",
            r.payToggle && r.hasToast && r.payListGone, r);
        await shoot(win, "orchestration");
        await js(`(async () => { closeModal(); await new Promise(r => setTimeout(r, 150)); return true; })()`);
    },

    // SESSION › PERMISSIONS, consolidated (round two): the tools are ONE
    // slider per GROUP — no master dial, no per-tool dropdowns — and a flip
    // writes every tool in the group through the session policy path.
    "perms-groups": async (win, js) => {
        const r = await js(`(async () => {
            const before = window.__errors.length;
            openSessionPerms();    // NOT awaited: modal() blocks until closed
            await new Promise(r => setTimeout(r, 400));
            const modalEl = document.getElementById("modal");
            const toolHead = [...modalEl.querySelectorAll(".pref-head")]
                .find(h => /^tools$/i.test(h.innerText));
            // group rows: every slider row AFTER the Tools head (no counts in
            // the titles — "(5)" implied five sub-settings and is gone)
            const rows = toolHead ? [...modalEl.querySelectorAll(".perm-row")]
                .filter(x => x.querySelector(".sec-toggle")
                    && (toolHead.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING)) : [];
            const counted = rows.filter(x =>
                /\\(\\d+\\)/.test((x.querySelector(".perm-title") || {}).innerText || "")).length;
            const oldDials = modalEl.querySelectorAll(".perm-bulk, .perm-tool-row").length;
            const netRow = rows.find(x => /network/i.test(x.innerText));
            let calls = 0, denied = false, subAfter = "";
            if (netRow) {
                const box = netRow.querySelector(".sec-toggle input");
                const n0 = (window.lcl.__calls || [])
                    .filter(c => c.key === "setSessionToolPolicy").length;
                box.click();                       // ON -> OFF = deny the group
                await new Promise(r => setTimeout(r, 250));
                const after = (window.lcl.__calls || [])
                    .filter(c => c.key === "setSessionToolPolicy");
                calls = after.length - n0;
                denied = after.slice(n0).every(c => c.args[2] === "deny");
                subAfter = (netRow.querySelector(".perm-sub") || {}).innerText || "";
                box.click();                       // restore
                await new Promise(r => setTimeout(r, 250));
            }
            return { hasHead: !!toolHead, groups: rows.length, counted, oldDials,
                     calls, denied, subAfter, errs: window.__errors.slice(before) };
        })()`);
        check("perms-groups", "THE TOOLS SECTION IS GROUP SLIDERS ONLY — one row " +
            "per group with a count and ONE toggle; the master dial and every " +
            "per-tool dropdown are GONE",
            r.hasHead && r.groups >= 2 && r.counted === 0
            && r.oldDials === 0 && r.errs.length === 0, r);
        check("perms-groups", "...flipping a group OFF writes DENY for every tool " +
            "in it through the session policy path, and the sub-line says so",
            r.calls >= 2 && r.denied && /not allowed/i.test(r.subAfter), r);

        /* THE LEAVE-MACHINE GATE LIVES HERE NOW — "we no longer gate anything
         * there, its all in Session > Permissions". The section the popup's
         * pointer promises: trusted endpoints with a revoke, the app-wide
         * ask-first switch, and the waiting-ask notification toggle. */
        const gate = await js(`(async () => {
            const modalEl = document.getElementById("modal");
            const head = [...modalEl.querySelectorAll(".pref-head")]
                .find(h => /leaves this machine/i.test(h.innerText));
            const rows = head ? [...modalEl.querySelectorAll(".perm-row")]
                .filter(x => head.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING)
                : [];
            const trustRow = rows.find(x => /trusted for this conversation/i.test(x.innerText));
            const askRow = rows.find(x => /ask before every remote call/i.test(x.innerText));
            const notifyRow = rows.find(x => /notify when an ask is waiting/i.test(x.innerText));
            let revoked = "";
            if (trustRow) {
                const b = [...trustRow.querySelectorAll("button")]
                    .find(x => /stop trusting/i.test(x.innerText));
                if (b) { b.click(); await new Promise(r => setTimeout(r, 200));
                         revoked = (trustRow.querySelector(".perm-sub") || {}).innerText || ""; }
            }
            // the ask-first switch is a per-conversation PERMISSION now, so it
            // renders in "This conversation" with the others — not here
            const askAnywhere = [...modalEl.querySelectorAll(".perm-row")]
                .find(x => /sends anything out/i.test(x.innerText));
            return { hasHead: !!head,
                     trustRow: !!trustRow, revoked,
                     askToggle: !!(askAnywhere && askAnywhere.querySelector(".sec-toggle input")),
                     notifyToggle: !!(notifyRow && notifyRow.querySelector(".sec-toggle input")),
                     revokeCalled: (window.lcl.__calls || [])
                         .some(c => c.key === "revokeTrustedEndpoint") };
        })()`);
        check("perms-groups", "LEAVES THIS MACHINE IS A PERMISSIONS SECTION — the " +
            "gate's own controls live in Session › Permissions now: trusted " +
            "endpoints, the per-conversation ask-first switch, and the waiting-ask " +
            "notification, each a real control",
            gate.hasHead && gate.trustRow && gate.askToggle && gate.notifyToggle, gate);
        check("perms-groups", "...and 'stop trusting' really revokes through the " +
            "session IPC, saying the ask will return",
            gate.revokeCalled && /ask again/i.test(gate.revoked), gate);
        await shoot(win, "perms-groups");
        await js(`(async () => { closeModal(); await new Promise(r => setTimeout(r, 150)); return true; })()`);
    },

    // ANCIENT KNOWLEDGE — the per-session audit agent settings. Two
    // regions (the agent's knobs + the user's ground rules), reading THIS
    // session's own data, reached from the Session menu — not "You".
    "ak-settings": async (win, js) => {
        const r = await js(`(async () => {
            const before = window.__errors.length;
            openAncientSettings();     // NOT awaited: modal() blocks until closed
            await new Promise(r => setTimeout(r, 400));
            const modalEl = document.getElementById("modal");
            const title = document.getElementById("modal-title").innerText;
            const heads = [...document.querySelectorAll("#modal .pref-head")]
                .map(h => h.innerText);
            const selects = document.querySelectorAll("#modal select").length;
            const rules = document.querySelector("#modal textarea.ak-rules");
            return {
                open: !document.getElementById("modal-scrim").classList.contains("hidden"),
                title, heads, selects,
                hasRules: !!rules,
                rulesValue: rules ? rules.value : "",
                errs: window.__errors.slice(before)
            };
        })()`);
        check("ak-settings", "ANCIENT KNOWLEDGE OPENS FROM THE SESSION AND THROWS " +
            "NOTHING — it is a per-session agent now, not a 'You' preference",
            r.open && /ancient knowledge/i.test(r.title) && r.errs.length === 0, r);
        check("ak-settings", "TWO REGIONS: 'The agent' (the knobs — auditor model " +
            "and how hard it presses) and 'Your ground rules'",
            r.heads.some(h => /the agent/i.test(h))
            && r.heads.some(h => /ground rules/i.test(h)) && r.selects >= 2, r.heads);
        check("ak-settings", "...the ground-rules editor renders THIS session's own " +
            "text — session-scoped, fresh per conversation",
            r.hasRules && /unproven as not done/i.test(r.rulesValue), r.rulesValue);
        await shoot(win, "ak-settings");
        await js(`(async () => { closeModal(); await new Promise(r => setTimeout(r, 150)); return true; })()`);
    },

    /* THE OWED PROOF — the four surfaces claimed and then doubted, in pixels.
     * Spark modes strip · live work rows with the document · the click really
     * reaching the IPC. Screenshots land in out/ as owed-*.png. */
    owed: async (win, js) => {
        await js(`
            window.__harness.FIXTURES.sparkModes = () => ({ ok: true, modes: {
                deep:     { model: "unsloth/gpt-oss-120b-GGUF:F16", label: "gpt-oss-120b", ctx: 131072, name: "Vast", icon: "bulb", blurb: "one conversation, the whole 131k window" },
                balanced: { model: "unsloth/gpt-oss-120b-GGUF:F16", label: "gpt-oss-120b", ctx: 65536,  name: "Balanced", icon: "scales", blurb: "two at a time, 65k each" },
                wide:     { model: "unsloth/gpt-oss-120b-GGUF:F16", label: "gpt-oss-120b", ctx: 32768,  name: "Swarm", icon: "bee", blurb: "four at a time, 32k each" },
                vast:     { model: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL", label: "Qwen3.6-35B", ctx: 262144, name: "Vast", icon: "bulb", blurb: "one conversation, a 262k window" },
                swarm:    { model: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL", label: "Qwen3.6-35B", ctx: 65536,  name: "Swarm", icon: "bee", blurb: "four light agents, 65k each" }
            }});
            window.__harness.FIXTURES.sparkMode = (id, mode) => ({ ok: true, mode,
                model: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL", label: "Qwen3.6-35B",
                ctx: 262144, note: "model reloading on the node — allow one to five minutes" });
            window.__harness.FIXTURES.nodeDash = () => ({ ok: true,
                cpu: { cores: 20, totalTicks: 100, idleTicks: 80 },
                mem: { totalBytes: 128e9, availableBytes: 60e9 },
                disk: { totalBytes: 3.7e12, availableBytes: 3.3e12 },
                gpu: null, engines: [], models: [], uptimeSec: 3600 });
            openNodeDash({ id: "node-spark", name: "spark", host: "100.64.0.1",
                           relayUrl: "https://spark.example.ts.net" });
            true;
        `);
        await wait(900);
        const btns = await js(`document.querySelectorAll(".spark-modes .sm-btn").length`);
        check("owed", "THE OPERATING-MODE STRIP EXISTS — five modes render on the " +
              "spark's dashboard (deep/balanced/wide/vast/swarm)", btns === 5, btns);
        await js(`[...document.querySelectorAll(".spark-modes .sm-btn")]
                    .find(b => b.textContent.trim() === "vast").click(); true;`);
        await wait(700);
        const note = await js(`(document.querySelector(".spark-modes .sm-note") || {}).innerText || ""`);
        check("owed", "clicking vast switches and REPORTS the new model and window " +
              "(Qwen, 256k per conversation)", /Qwen/.test(note) && /256k/.test(note), note);
        const called = await js(`window.lcl.__calls.some(c => c.key === "sparkMode"
            && c.args[0] === "node-spark" && c.args[1] === "vast")`);
        check("owed", "…and the click genuinely reached lcl:sparkMode with node id + mode",
            called === true, null);
        await shoot(win, "owed-spark-modes");
        await js(`(async () => { closeModal(); await new Promise(r => setTimeout(r, 200)); return true; })()`);
        await wait(400);

        /* live work row: fire the real progress event the loop now emits */
        const hadActive = await js(`!!(active && active.id)`);
        check("owed", "an active session exists to receive the live row", hadActive === true, null);
        await js(`
            window.lcl.__fire("onProgress", { sessionId: active && active.id, phase: "tool-done",
                detail: { tool: "write_file", failed: false, summary: "wrote index.html",
                    msg: { role: "tool", name: "write_file", failed: false,
                        content: '{"written":"index.html","bytes":1204,"created":true}',
                        written: "<!doctype html><h1>Hello Spark</h1>" } } });
            true;
        `);
        await wait(400);
        const live = await js(`!!chat.querySelector(".work-row.live-row")`);
        check("owed", "A WRITE LANDS IN THE CHAT LOG LIVE — the work row appears " +
              "while the turn is still running, not at the end", live === true, null);
        await js(`const d = chat.querySelector(".work-row.live-row"); if (d) d.open = true; true;`);
        await wait(200);
        const doc = await js(`((chat.querySelector(".work-row.live-row .wr-written") || {}).innerText) || ""`);
        check("owed", "…and expanding it shows THE DOCUMENT that was written, " +
              "not just the byte-count receipt", /Hello Spark/.test(doc), doc.slice(0, 60));
        await shoot(win, "owed-live-work-row");

        /* THE HOT-SWAP POINT: mode ICONS inside the MODEL SELECTOR. */
        await js(`
            document.getElementById("model-pick").click();
            const nodeTier = [...document.querySelectorAll("#model-menu .model-tier")]
                .find(t => /node/i.test(t.textContent));
            if (nodeTier) nodeTier.click();
            true;
        `);
        await wait(600);
        const modelRows = await js(`document.querySelectorAll("#model-menu .node-model-row").length`);
        check("owed", "TWO SELECTABLE MODELS on the machine — gpt-oss and Qwen, plain rows (not icons)", modelRows === 2, modelRows);
        // ONE machine, ONE llama engine, ONE vLLM card. The fleet endpoint has
        // its own label, and label-keyed grouping used to mint it a second
        // "machine" fold wearing a llama engine with models and modes vLLM
        // does not serve — a reported issue where "vLLM as a drop down" was
        // a hallucination that did not match what the host serves.
        const shape = await js(`({
            machines: document.querySelectorAll("#model-menu .model-node").length,
            engines: document.querySelectorAll("#model-menu .spark-engine").length,
            fleetCards: document.querySelectorAll("#model-menu .model-fleet-row").length
        })`);
        check("owed", "the fleet endpoint lands INSIDE the one spark fold as the agents " +
            "card — one machine fold, one llama engine, one vLLM card, nothing invented",
            shape.machines === 1 && shape.engines === 1 && shape.fleetCards === 1, shape);
        const loadedName = await js(`(document.querySelector("#model-menu .node-model-row.on .model-row-name")||{}).innerText||""`);
        const modeLabels = await js(`[...document.querySelectorAll("#model-menu .mode-btn")].map(b=>b.innerText).join(",")`);
        check("owed", "the LOADED model shows its OWN modes as labelled icon buttons (gpt-oss => Vast/Balanced/Swarm)",
              /gpt-oss/i.test(loadedName) && /vast/i.test(modeLabels) && /balanced/i.test(modeLabels) && /swarm/i.test(modeLabels), loadedName + " :: " + modeLabels);
        const iconBtns = await js(`[...document.querySelectorAll("#model-menu .mode-btn")].filter(b => b.querySelector("svg") && (b.querySelector(".mode-lb")||{}).innerText).length`);
        const btnTotal = await js(`document.querySelectorAll("#model-menu .mode-btn").length`);
        check("owed", "EVERY mode button carries its OWN svg icon AND keeps its label (icon buttons, the way asked)",
              iconBtns > 0 && iconBtns === btnTotal, iconBtns + "/" + btnTotal);
        await shoot(win, "owed-picker-gptoss");

        /* THE TRANSITIONAL STATE — a polish standard: after clicking Balanced,
         * Vast must not still show as selected when something else was just
         * clicked. The click must answer INSTANTLY:
         * clicked mode pending, stale highlight gone, the model row saying
         * reloading, and the REST of the selector still alive. A delayed
         * fixture holds the switch in flight long enough to measure it. */
        await js(`window.__origSparkMode = window.__harness.FIXTURES.sparkMode;
            window.__harness.FIXTURES.sparkMode = (id, mode) => new Promise(res =>
                setTimeout(() => res(window.__origSparkMode(id, mode)), 1200));
            true;`);
        await js(`(() => {
            const b = [...document.querySelectorAll("#model-menu .mode-btn")]
                .find(x => /balanced/i.test(x.innerText));
            if (b) b.click();
            return true;
        })()`);
        await wait(250);
        const mid = await js(`({
            pending: [...document.querySelectorAll("#model-menu .mode-btn.pending .mode-lb")]
                .map(x => x.innerText).join(","),
            stillOn: document.querySelectorAll("#model-menu .mode-btn.on").length,
            rowState: (document.querySelector('#model-menu .node-model-row .model-row-state.loading') || {}).innerText || "",
            othersAlive: [...document.querySelectorAll('#model-menu .model-tier')]
                .length > 0 && [...document.querySelectorAll('#model-menu .model-tier')]
                    .every(t => !t.disabled)
        })`);
        check("owed", "MID-SWITCH the click has already answered: the clicked mode " +
            "pulses PENDING and the stale active highlight is GONE",
            /balanced/i.test(mid.pending) && mid.stillOn === 0, mid);
        check("owed", "…the model row says what is really happening (reloading, in motion)",
            /reloading/i.test(mid.rowState), mid.rowState);
        check("owed", "…and the REST of the selector stays alive — no tier is disabled",
            mid.othersAlive === true, null);
        await shoot(win, "owed-switch-pending");
        // let the delayed switch land, then the final truth
        await wait(1600);
        const after2 = await js(`({
            pending: document.querySelectorAll("#model-menu .mode-btn.pending").length,
            inMotion: document.querySelectorAll("#model-menu .model-row-state.loading, #model-menu .model-row-state.draining").length
        })`);
        check("owed", "…and when the box confirms, the transition ENDS — nothing left " +
            "pending, nothing left pulsing (the resting active state is asserted on " +
            "the fresh-open checks above)",
            after2.pending === 0 && after2.inMotion === 0, after2);
        await js(`window.__harness.FIXTURES.sparkMode = window.__origSparkMode;
            document.getElementById("model-menu").classList.add("hidden");
            document.getElementById("model-pick").click(); true;`);
        await wait(400);
        await js(`(() => {
            const nodeTier = [...document.querySelectorAll("#model-menu .model-tier")]
                .find(t => /node/i.test(t.textContent));
            if (nodeTier && nodeTier.getAttribute("aria-expanded") !== "true") nodeTier.click();
            return true;
        })()`);
        await wait(500);

        // blow the three real rendered glyphs up to 120px so the ART is judgeable,
        // not a guess from 20px buttons. gpt-oss alone carries all three (bulb,
        // scales, bee), so one clone pass covers the whole set.
        await js(`(() => {
            const ov = document.createElement("div"); ov.id = "icon-proof";
            ov.style.cssText = "position:fixed;inset:0;z-index:99999;background:#0a0d11;display:flex;gap:56px;align-items:center;justify-content:center;";
            for (const b of document.querySelectorAll("#model-menu .mode-btn")) {
                const cell = document.createElement("div");
                cell.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:16px;color:#57d9a3;";
                const g = b.querySelector("svg").cloneNode(true);
                g.style.width = "120px"; g.style.height = "120px";
                const cap = document.createElement("div");
                cap.textContent = (b.querySelector(".mode-lb")||{}).textContent || "";
                cap.style.cssText = "font:600 24px sans-serif;color:#e6edf3;";
                cell.append(g, cap); ov.appendChild(cell);
            }
            document.body.appendChild(ov); return true;
        })()`);
        await wait(200);
        await shoot(win, "owed-icon-proof");
        await js(`const o = document.getElementById("icon-proof"); if (o) o.remove(); true;`);
        await wait(150);
        // clicking a MODEL only REVEALS its modes (accordion) — it does not load.
        await js(`[...document.querySelectorAll("#model-menu .node-model-row")].find(r=>/Qwen/i.test(r.textContent)).click(); true;`);
        await wait(400);
        const revealed = await js(`[...document.querySelectorAll("#model-menu .mode-btn")].map(b=>b.innerText).join(",")`);
        const stillRunning = await js(`(document.querySelector("#model-menu .node-model-row.on .model-row-name")||{}).innerText||""`);
        check("owed", "clicking a model REVEALS its modes (Qwen => Vast/Swarm) and does NOT load — gpt-oss stays running",
              /vast/i.test(revealed) && /swarm/i.test(revealed) && !/balanced/i.test(revealed) && /gpt-oss/i.test(stillRunning), stillRunning + " :: " + revealed);
        await shoot(win, "owed-picker-modes");
        // picking a MODE is what actually loads the model on the box.
        await js(`(() => {
            const mb = [...document.querySelectorAll("#model-menu .mode-btn")].find(b => /vast/i.test(b.innerText));
            if (mb) mb.click();
            return true;
        })()`);
        await wait(700);
        const afterLoaded = await js(`(document.querySelector("#model-menu .node-model-row.on .model-row-name")||{}).innerText||""`);
        const afterLabels = await js(`[...document.querySelectorAll("#model-menu .mode-btn")].map(b=>b.innerText).join(",")`);
        check("owed", "picking a mode LOADS that model — Qwen's Vast makes Qwen the running model (modes Vast/Swarm)",
              /Qwen/i.test(afterLoaded) && /vast/i.test(afterLabels) && /swarm/i.test(afterLabels) && !/balanced/i.test(afterLabels), afterLoaded + " :: " + afterLabels);
        await shoot(win, "owed-picker-loaded");
    },

    /* CONTEXT IS NEVER STALE. A hypothesis worth checking: when switching
     * models or modes between a model, the context window may run stale — not
     * all the context data updates on a model change.
     * It was right — measured: both spark-mode switch paths called only
     * renderHeader(), which repaints none of the model/context surfaces. This
     * scene drives the repaired path (modelSurfacesChanged — the function both
     * switch handlers now call, pinned by renderer-wiring) and MEASURES that
     * the donut, the picker label and the engine label all re-derive, and that
     * shrinking the window below the conversation's size says so in a notice. */
    fresh: async (win, js) => {
        // a prior scene can leave the picker open over the chat — shut it so
        // this scene's screenshots show the surfaces it is measuring
        await js(`(() => { const m2 = document.getElementById("model-menu"); if (m2) m2.classList.add("hidden"); return true; })()`);
        await js(`window.__origListModels = window.__harness.FIXTURES.listModels; true;`);
        const nodeAs = (over) => `
            window.__harness.FIXTURES.listModels = () => ({ ok: true, models:
                window.__harness.MODELS.map(m =>
                    (m.endpointId === "node-x" && !m.offline && m.isNode)
                        ? { ...m, active: true, ...(${JSON.stringify(over)}) }
                        : { ...m, active: false }) });
            true;`;
        // the session runs ON the node: gpt-oss resident at its 131k window
        await js(nodeAs({ contextMax: 131072, contextLength: 131072 }));
        await js(`refreshModelPick()`);
        await wait(300);
        const t1 = await js(`(document.getElementById("context-ring-wrap")||{}).title || ""`);
        check("fresh", "the donut divides by the NODE driver's live window (131,072)",
            /131,072/.test(t1), t1);
        // the box switches to Qwen vast — the store now serves 262k, and the
        // switch path runs modelSurfacesChanged: EVERY surface must re-derive
        await js(nodeAs({ id: "unsloth/Qwen3.6-35B", modelId: "unsloth/Qwen3.6-35B",
                          label: "Qwen3.6-35B", family: "Qwen3.6", params: "35B",
                          contextMax: 262144, contextLength: 262144 }));
        await js(`modelSurfacesChanged()`);
        await wait(300);
        const t2 = await js(`(document.getElementById("context-ring-wrap")||{}).title || ""`);
        check("fresh", "after a mode switch the donut re-derives — 262,144, not the stale figure",
            /262,144/.test(t2), t2);
        const lbl = await js(`document.getElementById("model-pick-label").innerText`);
        check("fresh", "…and the composer picker label names the newly resident model",
            /qwen/i.test(lbl), lbl);
        const eng = await js(`document.getElementById("engine-label").innerText`);
        check("fresh", "…and the sidebar engine label follows",
            /qwen/i.test(eng), eng);
        // the window SHRINKS below what the conversation holds: one plain notice
        await js(`active.messages.push({ role: "assistant", content: "x".repeat(120000) }); true;`);
        await js(nodeAs({ contextMax: 8192, contextLength: 8192 }));
        await js(`modelSurfacesChanged()`);
        await wait(300);
        const notice = await js(`[...document.querySelectorAll(".msg-notice")].map(n => n.innerText).join(" | ")`);
        check("fresh", "shrinking below the conversation's size SAYS SO — window change, " +
            "what still rides along, nothing deleted, Compact offered",
            /window just shrank/i.test(notice) && /stay in the transcript/i.test(notice)
            && /Compact/i.test(notice), notice.slice(-200));
        await shoot(win, "fresh-shrink-notice");
        await js(`active.messages.pop();
                  window.__harness.FIXTURES.listModels = window.__origListModels;
                  refreshModelPick(); true;`);
        await wait(200);
    },

    /* THE BELL AND THE READ SPLIT. Per-session mute lives ON the session card
     * (left of the three-dot menu, room for a finger), and the status dot
     * finally answers "have I read this": cyan done = finished while you were
     * away, unread; dimmed acked = you read it; plain idle = never ran. */
    bell: async (win, js) => {
        await js(`renderSessionList(); true;`);
        await wait(200);
        const m = await js(`(() => {
            const out = {};
            for (const r of document.querySelectorAll(".session-item")) {
                const id = r.dataset.sessionId;
                const b = r.querySelector(".session-bell"), mo = r.querySelector(".session-more");
                out[id] = {
                    dot: (r.querySelector(".session-status") || {}).className || "",
                    bell: !!b,
                    muted: !!(b && b.classList.contains("muted")),
                    beforeMore: !!(b && mo &&
                        (b.compareDocumentPosition(mo) & Node.DOCUMENT_POSITION_FOLLOWING))
                };
            }
            return out;
        })()`);
        check("bell", "EVERY session card carries the bell, LEFT of the three-dot menu",
            m.s1 && m.s2 && m.s3 && [m.s1, m.s2, m.s3].every(x => x.bell && x.beforeMore), m);
        check("bell", "the dot tells READ from UNREAD: the open session 'acked', a " +
            "background finish 'done' (cyan, unread), never-ran plain idle",
            /\backed\b/.test(m.s1.dot) && /\bdone\b/.test(m.s2.dot) && /\bidle\b/.test(m.s3.dot), m);
        check("bell", "a muted session's bell says so WITHOUT hover",
            m.s2.muted === true && m.s1.muted === false, m);
        await js(`document.querySelector('[data-session-id="s1"] .session-bell').click(); true;`);
        await wait(250);
        const after = await js(`(document.querySelector('[data-session-id="s1"] .session-bell') || {}).className || ""`);
        check("bell", "clicking the bell mutes THAT session and the row repaints muted",
            /muted/.test(after), after);
        const muteCall = await js(`window.lcl.__calls.some(c => c.key === "setSessionNotify" && c.args[0] === "s1" && c.args[1] === true)`);
        check("bell", "…through the real setSessionNotify IPC with the session id",
            muteCall === true, null);
        // reading flips the dot: OPEN the finished-unread session
        await js(`switchSession("s2")`);
        await wait(300);
        const dot2 = await js(`(document.querySelector('[data-session-id="s2"] .session-status') || {}).className || ""`);
        check("bell", "OPENING a finished-unread session marks it READ — the dot flips to acked",
            /\backed\b/.test(dot2), dot2);
        const readCall = await js(`window.lcl.__calls.some(c => c.key === "markSessionRead" && c.args[0] === "s2")`);
        check("bell", "…durably, through the real markSessionRead IPC", readCall === true, null);
        await shoot(win, "bell-and-read-dots");
        // restore: back to s1, s1's bell unmuted
        await js(`switchSession("s1")`);
        await wait(250);
        await js(`document.querySelector('[data-session-id="s1"] .session-bell').click(); true;`);
        await wait(150);
    },
};

/* ---------------------------------------------------------------- plumbing */
async function shoot(win, name) {
    fs.mkdirSync(OUT, { recursive: true });
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name + ".png"), img.toPNG());
}

/**
 * A HARNESS THAT HANGS IS WORSE THAN A HARNESS THAT FAILS.
 *
 * Measured the hard way: one unresolved promise in a scene (or a rejection
 * outside the try) left Electron alive with no output and no exit code, and the
 * run had to be killed by hand. Nothing after that point can be trusted to run,
 * including app.exit. The watchdog turns that into a loud failure with the
 * partial results still written out.
 */
// 240s, doubled from 120: with the installed app open beside a release build
// (a resident model + its 60s channel poll), a healthy run's scene waits
// stretched past 120s and the watchdog killed a run that passed clean on the
// very next attempt. The watchdog exists to catch a HUNG scene, not a slow
// machine — a genuine hang still dies well within the gate's own 600s cap.
const WATCHDOG_MS = 240000;
let finished = false;
setTimeout(() => {
    if (finished) return;
    console.log("\nHARNESS TIMED OUT after " + (WATCHDOG_MS / 1000) + "s — " +
        "a scene never resolved. Partial results written.");
    try {
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(results, null, 2));
    } catch { /* nothing left to do */ }
    app.exit(1);
}, WATCHDOG_MS).unref();

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 1440, height: 900, show: false,
        webPreferences: {
            preload: path.join(__dirname, "preload-stub.js"),
            contextIsolation: false, nodeIntegration: true, sandbox: false,
            /* WITHOUT THIS THE HARNESS LIES ABOUT ANIMATION.
             * A window with show:false throttles animation frames, so a CSS
             * transition never advances and the property stays pinned at its
             * starting value forever. Measured: the sidebar collapse looked
             * completely dead (`264px 1163px 0px` half a second after the class
             * landed) and is perfectly fine with throttling off. Anything this
             * harness measures that has a transition on it needs this. */
            backgroundThrottling: false
        }
    });
    const js = (src) => win.webContents.executeJavaScript(src, true);

    win.webContents.on("console-message", (_e, level, message) => {
        if (level >= 2) console.log("   [page]", message.slice(0, 200));
    });

    try {
        await win.loadFile(path.join(ROOT, "app", "renderer", "index.html"));
    } catch (e) {
        console.error("the renderer would not even load:", e.message);
        app.exit(1);
        return;
    }
    /* AND THE WINDOW HAS TO BE ON SCREEN.
     * backgroundThrottling:false is necessary and not sufficient — a window
     * that was never shown still gets no animation frames, so anything with a
     * CSS transition on it stays frozen at its starting value and the harness
     * reports a working control as dead. showInactive() puts it up without
     * stealing focus, which is the difference between measuring the product and
     * measuring the harness. Verified both ways in one run: the sidebar grid
     * reads `264px 1163px 0px` forever hidden, and `0px 1427px 0px` shown. */
    win.showInactive();
    await wait(1500);            // let boot-time async paints settle
    await js(HELPERS);

    const names = only.length ? only : Object.keys(SCENES);
    for (const n of names) {
        if (!SCENES[n]) { console.log(`(no scene named ${n})`); continue; }
        try { await SCENES[n](win, js); }
        catch (e) {
            /* "Script failed to execute" is Electron's way of saying the page
             * threw, and on its own it names nothing. The renderer's own error
             * list is the useful half — usually a $("id") that no longer exists,
             * which stops app.js dead at the line that looks it up. */
            let pageErrors = [];
            try { pageErrors = await js(`window.__errors.slice(-3)`); } catch { /* gone */ }
            check(n, "the scene ran to completion", false,
                { threw: String(e.message || e), pageErrors });
        }
    }

    /* THE PAGE'S OWN ERROR LIST IS A VERDICT, NOT DECORATION. Scenes spot-
     * check slices of window.__errors, but nothing ever judged the WHOLE run
     * — so a TypeError thrown between scenes left every check green over a
     * renderer that was provably breaking. All-green with uncaught errors is
     * the exact "green while broken" this harness exists to end. */
    try {
        const allErrs = await js(`window.__errors`);
        check("harness", "NO UNCAUGHT RENDERER ERRORS ACROSS THE ENTIRE RUN — " +
            "every TypeError the page threw while the scenes drove it",
            Array.isArray(allErrs) && allErrs.length === 0,
            (allErrs || []).slice(0, 6));
    } catch (e) {
        check("harness", "the page's error list was readable at the end of the run",
            false, String(e.message || e));
    }

    finished = true;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(results, null, 2));
    console.log(`\n${pass}/${pass + fail} UI checks passed   (screenshots in devtools/ui-harness/out)`);
    app.exit(fail ? 1 : 0);
}).catch((e) => {
    // a rejection out here used to take the process down silently
    console.error("the harness itself failed:", (e && e.stack) || e);
    finished = true;
    app.exit(1);
});
