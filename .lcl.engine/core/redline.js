const fs = require("fs");
const path = require("path");
const engine = require("./engine");
const schematic = require("./schematic");
const visionTool = require("./visionTool");
const ocrTools = require("./ocrTools");
const pdfRaster = require("./pdfRaster");
const { ToolError, resolveInRoot } = require("./fsTools");

/**
 * Drawing capture and redlining — the paper-to-KiCad loop.
 *
 * The scenario this exists for: a PDF or scan of an electrical schematic is in
 * the workspace; the user wants it rebuilt as a REAL KiCad schematic and then
 * dictates changes — "change F2 to 10A", "add a jumper from TB1-4 to TB1-7",
 * "add a 9-pin relay" — with each revision tracked, ERC-checked, and shown.
 *
 * The honest contract: capture is a DRAFT for human verification, never
 * trusted blind. A vision model reading a drawing makes mistakes a human
 * would not, so every captured element carries the model's own confidence,
 * every value is cross-checked against OCR of the same page, and the summary
 * leads with what it is NOT sure about. The user verifies against the
 * original before dictating redlines — which is exactly how a human redline
 * workflow already works.
 *
 * Split of responsibilities:
 *   capture_drawing  image -> capture.json (components, nets, uncertainties)
 *                    -> rebuilt .kicad_sch -> ERC -> SVG shown in chat
 *   redline_drawing  edits against capture.json -> regenerate -> re-ERC ->
 *                    diff summary + revision table on the sheet
 *
 * The capture model is the source of truth for edits; the .kicad_sch is
 * always REGENERATED from it, never hand-patched, so ERC always judges the
 * whole sheet and the revision history never drifts from the drawing.
 */

const CAPTURE_SUFFIX = ".capture.json";
const MAX_EDITS_PER_CALL = 20;

/* ------------------------------------------------------------ vision ---- */

/** Ask the resident vision model one structured question about an image. */
async function visionAsk(dataUri, prompt, maxTokens, cancelToken) {
    // engine.generate, NOT router.generate, and deliberately: this is a VISION
    // call. It needs the resident multimodal model, a remote text endpoint
    // cannot answer it, and silently shipping the user's images to a third
    // party because they linked an API for CHAT is not a thing this should do
    // without being asked. Vision stays local.
    const res = await engine.generate([{
        role: "user",
        content: [
            { type: "image_url", image_url: { url: dataUri } },
            { type: "text", text: prompt }
        ]
    }], maxTokens, cancelToken);
    if (res.error) throw new ToolError(`vision failed: ${res.error}`);
    return String(res.content || "").trim();
}

/** Pull the first JSON object/array out of model text, tolerating fences. */
function extractJson(text) {
    const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    const body = m ? m[1] : text;
    const start = body.search(/[[{]/);
    if (start < 0) return null;
    // walk to the matching close so trailing prose does not break parsing
    let depth = 0, end = -1;
    for (let i = start; i < body.length; i++) {
        const ch = body[i];
        if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") { depth--; if (!depth) { end = i; break; } }
    }
    if (end < 0) return null;
    try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

const INVENTORY_PROMPT =
    "This is an electrical schematic drawing. List EVERY component you can " +
    "identify. Reply with ONLY a JSON array, no prose:\n" +
    '[{"ref":"F1","type":"fuse","value":"5A","confidence":0.9}, ...]\n' +
    "- ref: the designator printed on the drawing (F1, K2, TB1, R3…). If none " +
    "is printed, invent a sequential one and set confidence low.\n" +
    "- type: one word — fuse, relay, resistor, capacitor, terminal, switch, " +
    "lamp, motor, transformer, diode, breaker, contactor, coil, ground, other.\n" +
    "- value: the printed rating or value, or null if unreadable.\n" +
    "- confidence: 0-1, how sure you are this component exists as read.";

const NETS_PROMPT =
    "Same schematic. Now list the WIRE CONNECTIONS. Reply with ONLY a JSON " +
    'array: [{"pins":["F1.2","K1.A1"],"name":"L1","confidence":0.8}, ...]\n' +
    "- pins: two or more \"REF.PIN\" endpoints that one wire or node joins. " +
    "Use pin numbers when printed, else 1/2 for two-terminal parts.\n" +
    "- name: the wire label or number if printed, else omit it.\n" +
    "- Only include connections you can actually trace. confidence: 0-1.\n" +
    "Components you reported: ";

/* ---------------------------------------------------- symbol mapping ---- */

/**
 * Map a captured component type to a KiCad symbol. Explicit lib:name ids,
 * each verified to resolve against the shipped libraries (tests/redline.js
 * pins every one) — a contains-search here would depend on library file
 * ordering, and "LED" famously matches Connector:8P8C_LED before Device:LED.
 */
const TYPE_SYMBOLS = {
    fuse: "Device:Fuse", relay: "Relay:Relay_DPDT", resistor: "Device:R",
    capacitor: "Device:C", terminal: "Connector:Screw_Terminal_01x02",
    switch: "Switch:SW_SPST", lamp: "Device:Lamp", motor: "Motor:Motor_AC",
    transformer: "Device:Transformer_1P_1S", diode: "Device:D",
    breaker: "Device:Fuse", contactor: "Relay:Relay_DPDT", coil: "Device:L",
    ground: "power:GND", inductor: "Device:L", led: "Device:LED",
    battery: "Device:Battery_Cell", other: "Device:R"
};

function symbolForType(type) {
    const key = String(type || "other").toLowerCase();
    const libId = TYPE_SYMBOLS[key] || TYPE_SYMBOLS.other;
    schematic.getSymbol(libId);          // throws precisely if the lib lacks it
    return libId;
}

/* -------------------------------------------------------- the capture ---- */

function capturePath(root, rel) {
    const base = rel.replace(/\.[^.]+$/, "");
    return resolveInRoot(root, base + CAPTURE_SUFFIX);
}

/**
 * Read a drawing image into a structured capture. Requires the ACTIVE model
 * to be vision-capable — the same rule as read_image, for the same reason.
 */
async function captureDrawing(root, args = {}, ctx = {}) {
    if (!root) throw new ToolError("link a workspace folder first");
    if (!schematic.available()) {
        throw new ToolError("KiCad's kicad-cli is required to rebuild drawings — install KiCad");
    }
    if (!visionTool.activeModelSees()) {
        throw new ToolError(
            "reading a drawing needs the vision model — switch to qwen3-vl " +
            "from the model button, then run capture_drawing again");
    }
    const rel = String(args.path || "").trim();
    const full = resolveInRoot(root, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        throw new ToolError(`no such file: ${rel}`);
    }
    const ext = path.extname(full).toLowerCase();
    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};

    // A PDF schematic is the NORMAL input for this workflow — rasterise the
    // requested page (default 1) and continue exactly as with an image. Only
    // when the window system is absent (headless) does the old advice apply.
    let imageFile = full;
    let rasterTemp = null;
    if (ext === ".pdf") {
        if (!pdfRaster.available()) {
            throw new ToolError(
                "reading a PDF drawing needs the app's window system — " +
                "export the page as PNG first, or run capture from the app");
        }
        const pageNum = Math.max(1, Math.floor(+args.page || 1));
        onNote(`rendering PDF page ${pageNum}`);
        const r = await pdfRaster.rasterizePageToFile(full, pageNum, 2.5);
        rasterTemp = r.file;
        imageFile = r.file;
        if (r.numPages > 1 && !args.page) {
            onNote(`this PDF has ${r.numPages} pages — captured page 1; ` +
                   'pass {"page": N} for another');
        }
    }

    const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                   ".bmp": "image/bmp", ".webp": "image/webp" };
    const imgExt = ext === ".pdf" ? ".png" : ext;
    if (!MIME[imgExt]) throw new ToolError(`not a supported drawing image (${Object.keys(MIME).join(" ")} or .pdf)`);
    if (fs.statSync(imageFile).size > 8_000_000) {
        if (rasterTemp) { try { fs.rmSync(rasterTemp, { force: true }); } catch { /* gone */ } }
        throw new ToolError("image is too large (8 MB cap)");
    }

    const dataUri = `data:${MIME[imgExt]};base64,${fs.readFileSync(imageFile).toString("base64")}`;

    // Pass 1: what is on the drawing
    onNote("reading the drawing: component inventory");
    const invText = await visionAsk(dataUri, INVENTORY_PROMPT, 1400, ctx.cancelToken);
    const inventory = extractJson(invText);
    if (!Array.isArray(inventory) || !inventory.length) {
        throw new ToolError("could not identify any components on this drawing — " +
            "if the scan is small or skewed, try a higher-resolution export");
    }

    // Pass 2: how it is wired
    onNote("reading the drawing: tracing connections");
    const refs = inventory.map(c => c.ref).join(", ");
    const netsText = await visionAsk(dataUri, NETS_PROMPT + refs, 1400, ctx.cancelToken);
    const netsRaw = extractJson(netsText);

    // OCR cross-check: a value string the OCR of the same page never saw is
    // marked uncertain — vision models hallucinate plausible ratings, and a
    // redline that starts from an invented fuse size is worse than a gap.
    let ocrWords = new Set();
    if (ocrTools.available()) {
        onNote("cross-checking printed values with OCR");
        try {
            const o = await ocrTools.recognize(imageFile, { minHeight: 1 });
            for (const w of String(o.text || "").split(/\s+/)) {
                if (w.length >= 2) ocrWords.add(w.toLowerCase().replace(/[^a-z0-9./-]/g, ""));
            }
        } catch { /* cross-check is best-effort */ }
    }

    const seen = new Set();
    const components = [];
    const uncertainties = [];
    for (const c of inventory.slice(0, 60)) {
        let ref = String(c.ref || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
        if (!ref) continue;
        while (seen.has(ref)) ref += "A";
        seen.add(ref);
        const type = String(c.type || "other").toLowerCase();
        const value = c.value == null ? null : String(c.value).trim();
        let confidence = Math.max(0, Math.min(1, +c.confidence || 0.5));
        if (value && ocrWords.size) {
            const norm = value.toLowerCase().replace(/[^a-z0-9./-]/g, "");
            if (norm && !ocrWords.has(norm)) {
                confidence = Math.min(confidence, 0.5);
                uncertainties.push(`${ref}: value "${value}" was not confirmed by OCR — verify against the original`);
            }
        }
        if (confidence < 0.6) {
            uncertainties.push(`${ref} (${type}${value ? " " + value : ""}): low confidence (${confidence.toFixed(2)})`);
        }
        components.push({ ref, type, value, confidence, symbol: symbolForType(type) });
    }

    const nets = [];
    for (const n of (Array.isArray(netsRaw) ? netsRaw : []).slice(0, 80)) {
        const pins = (n.pins || []).map(p => String(p).trim().toUpperCase()).filter(Boolean);
        if (pins.length < 2) continue;
        // drop endpoints that reference components we did not keep
        const valid = pins.filter(p => seen.has(p.split(".")[0]));
        if (valid.length < 2) continue;
        const conf = Math.max(0, Math.min(1, +n.confidence || 0.5));
        if (conf < 0.6) uncertainties.push(`net ${n.name || valid.join("–")}: low confidence (${conf.toFixed(2)})`);
        nets.push({ name: n.name ? String(n.name) : undefined, pins: valid, confidence: conf });
    }

    const capture = {
        version: 1,
        source: rel,
        title: String(args.title || path.basename(rel, ext)),
        capturedAt: new Date().toISOString(),
        components, nets,
        uncertainties,
        revisions: []
    };

    const capFile = capturePath(root, rel);
    fs.writeFileSync(capFile, JSON.stringify(capture, null, 2), "utf8");
    if (rasterTemp) { try { fs.rmSync(rasterTemp, { force: true }); } catch { /* gone */ } }

    onNote("rebuilding in KiCad");
    const built = await rebuild(root, capture, ctx);
    return {
        capture: path.relative(root, capFile).split(path.sep).join("/"),
        components: components.length,
        nets: nets.length,
        uncertainties,
        ...built,
        note: "This rebuild is a DRAFT read from the drawing — verify the " +
              "uncertain items against the original before redlining."
    };
}

/* -------------------------------------------------------- the rebuild ---- */

/** capture -> .kicad_sch on disk -> ERC -> SVG. Returns paths + ERC verdict. */
async function rebuild(root, capture, ctx = {}) {
    const base = capture.source.replace(/\.[^.]+$/, "");
    const schRel = base + ".kicad_sch";
    const schFull = resolveInRoot(root, schRel);

    const revNotes = capture.revisions.map((r, i) =>
        `REV ${i + 1} (${r.at.slice(0, 10)}): ${r.summary}`);

    const text = schematic.buildSchematic({
        title: capture.title,
        components: capture.components.map(c => ({
            ref: c.ref, symbol: c.symbol,
            value: c.value != null ? c.value : undefined
        })),
        nets: capture.nets.map(n => ({ name: n.name, pins: n.pins })),
        texts: revNotes
    });
    fs.writeFileSync(schFull, text, "utf8");

    const erc = await schematic.checkSchematic(schFull);

    // export an SVG and hand it back as a chat-displayable image
    let svgRel = null, dataUri = null;
    try {
        const outDir = path.dirname(schFull);
        const svg = await schematic.exportSchematic(schFull, "svg", outDir);
        if (svg.ok) {
            svgRel = path.relative(root, svg.file).split(path.sep).join("/");
            const raw = fs.readFileSync(svg.file);
            if (raw.length < 4_000_000) {
                dataUri = "data:image/svg+xml;base64," + raw.toString("base64");
            }
        }
    } catch { /* the schematic still exists; export is a nicety */ }

    return {
        schematic: schRel,
        svg: svgRel,
        kind: dataUri ? "image" : undefined,
        dataUri,
        erc: erc.ok
            ? `clean (${erc.warnings || 0} warning${erc.warnings === 1 ? "" : "s"})`
            : `${erc.errors} error${erc.errors === 1 ? "" : "s"}, ${erc.warnings} warning${erc.warnings === 1 ? "" : "s"}`,
        ercViolations: (erc.violations || []).slice(0, 10)
    };
}

/* -------------------------------------------------------- the redline ---- */

const EDIT_OPS = new Set(["set_value", "add", "remove", "connect", "disconnect", "retitle"]);

function describeEdit(e) {
    switch (e.op) {
        case "set_value": return `${e.ref}: value → ${e.value}`;
        case "add": return `added ${e.ref} (${e.type || e.symbol}${e.value ? " " + e.value : ""})`;
        case "remove": return `removed ${e.ref}`;
        case "connect": return `jumper ${(e.pins || []).join(" ↔ ")}${e.name ? ` (${e.name})` : ""}`;
        case "disconnect": return `disconnected ${e.pin}`;
        case "retitle": return `title → ${e.title}`;
        default: return e.op;
    }
}

/** Apply one edit to the capture IN PLACE. Throws with a precise reason. */
function applyEdit(capture, e) {
    const find = (ref) => {
        const c = capture.components.find(x => x.ref === String(ref).toUpperCase());
        if (!c) {
            const have = capture.components.map(x => x.ref).join(", ");
            throw new ToolError(`no component "${ref}" on this drawing (have: ${have})`);
        }
        return c;
    };
    switch (e.op) {
        case "set_value": {
            const c = find(e.ref);
            if (e.value == null || String(e.value).trim() === "") {
                throw new ToolError("set_value needs a value");
            }
            c.value = String(e.value).trim();
            c.confidence = 1;      // a dictated value is ground truth
            break;
        }
        case "add": {
            const ref = String(e.ref || "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
            if (!ref) throw new ToolError("add needs a ref (K2, F3, TB4…)");
            if (capture.components.some(c => c.ref === ref)) {
                throw new ToolError(`"${ref}" already exists — pick a new designator`);
            }
            const symbol = e.symbol ? String(e.symbol) : symbolForType(e.type);
            capture.components.push({
                ref, type: String(e.type || "other").toLowerCase(),
                value: e.value != null ? String(e.value) : null,
                confidence: 1, symbol
            });
            if (Array.isArray(e.connect) && e.connect.length >= 1) {
                // connect the new part into the circuit in the same edit
                for (const spec of e.connect) {
                    const pins = Array.isArray(spec) ? spec : [spec];
                    // shape: "TB1.4" means new part pin N joins that node —
                    // handled by an explicit connect op instead when ambiguous
                    if (pins.length >= 2) capture.nets.push({ pins: pins.map(String), confidence: 1 });
                }
            }
            break;
        }
        case "remove": {
            const c = find(e.ref);
            capture.components = capture.components.filter(x => x !== c);
            capture.nets = capture.nets
                .map(n => ({ ...n, pins: n.pins.filter(p => p.split(".")[0] !== c.ref) }))
                .filter(n => n.pins.length >= 2);
            break;
        }
        case "connect": {
            const pins = (e.pins || []).map(p => String(p).toUpperCase());
            if (pins.length < 2) throw new ToolError('connect needs pins: ["TB1.4","TB1.7"]');
            for (const p of pins) find(p.split(".")[0]);
            capture.nets.push({ name: e.name ? String(e.name) : undefined, pins, confidence: 1 });
            break;
        }
        case "disconnect": {
            const pin = String(e.pin || "").toUpperCase();
            if (!pin.includes(".")) throw new ToolError('disconnect needs a pin like "K1.A2"');
            const before = capture.nets.length;
            capture.nets = capture.nets
                .map(n => ({ ...n, pins: n.pins.filter(p => p !== pin) }))
                .filter(n => n.pins.length >= 2);
            if (capture.nets.length === before
                && !capture.nets.some(n => n.pins.includes(pin))) {
                throw new ToolError(`"${pin}" is not connected to anything`);
            }
            break;
        }
        case "retitle": {
            if (!e.title) throw new ToolError("retitle needs a title");
            capture.title = String(e.title);
            break;
        }
        default:
            throw new ToolError(`unknown edit op "${e.op}" (${[...EDIT_OPS].join(", ")})`);
    }
}

/**
 * Apply dictated redlines to a captured drawing and regenerate. Edits are
 * all-or-nothing: one bad edit rejects the batch with the reason, so the
 * capture on disk never holds a half-applied revision.
 */
async function redlineDrawing(root, args = {}, ctx = {}) {
    if (!root) throw new ToolError("link a workspace folder first");
    const rel = String(args.path || "").trim();
    const capFile = rel.endsWith(CAPTURE_SUFFIX)
        ? resolveInRoot(root, rel) : capturePath(root, rel);
    if (!fs.existsSync(capFile)) {
        throw new ToolError(`no capture for "${rel}" — run capture_drawing first`);
    }
    const edits = args.edits;
    if (!Array.isArray(edits) || !edits.length) {
        throw new ToolError('redline_drawing needs edits: [{"op":"set_value","ref":"F2","value":"10A"}, …]');
    }
    if (edits.length > MAX_EDITS_PER_CALL) {
        throw new ToolError(`too many edits in one call (max ${MAX_EDITS_PER_CALL})`);
    }

    const capture = JSON.parse(fs.readFileSync(capFile, "utf8"));
    // work on a deep copy so a failed edit leaves the file untouched
    const draft = JSON.parse(JSON.stringify(capture));
    const applied = [];
    for (const e of edits) {
        applyEdit(draft, e);
        applied.push(describeEdit(e));
    }
    draft.revisions.push({ at: new Date().toISOString(), summary: applied.join("; "), edits });

    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
    onNote("regenerating the schematic");
    const built = await rebuild(root, draft, ctx);

    fs.writeFileSync(capFile, JSON.stringify(draft, null, 2), "utf8");
    return {
        applied,
        revision: draft.revisions.length,
        ...built
    };
}

/* --------------------------------------------------------------- tools ---- */

function available() {
    return schematic.available();
}

const CAPTURE_ENTRY = {
    run: captureDrawing,
    help: 'capture_drawing {"path": "drawing.png", "title": "Pump panel"} — read a ' +
        "schematic drawing with the vision model and rebuild it as a real, " +
        "ERC-checked KiCad schematic for the user to verify"
};

const REDLINE_ENTRY = {
    run: redlineDrawing,
    help: 'redline_drawing {"path": "drawing.png", "edits": [{"op":"set_value",' +
        '"ref":"F2","value":"10A"}, {"op":"connect","pins":["TB1.4","TB1.7"]}, ' +
        '{"op":"add","ref":"K2","type":"relay"}, {"op":"remove","ref":"R9"}]} — ' +
        "apply dictated changes to a captured drawing, regenerate and re-check it"
};

module.exports = {
    available, captureDrawing, redlineDrawing, applyEdit, describeEdit,
    extractJson, symbolForType, rebuild,
    CAPTURE_ENTRY, REDLINE_ENTRY, CAPTURE_SUFFIX
};
