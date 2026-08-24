const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const paths = require("./paths");
const { ToolError, resolveInRoot, resolveForWrite } = require("./fsTools");

/**
 * SCHEMATICS — a real .kicad_sch from a parts-and-nets description.
 *
 * The output is a genuine KiCad schematic, not a picture of one: it opens in
 * KiCad, passes ERC, exports to SVG/PDF/netlist/BOM through kicad-cli, and
 * embeds every symbol it uses, so the file stands alone. The model describes
 * WHAT — components and connections — and this module owns WHERE: placement
 * and routing are deterministic code, because a 4B model asked to pick
 * coordinates on a 1.27 mm grid will get them wrong every time.
 *
 * Format facts, pinned from real files on this machine (KiCad's own demos and
 * a real board project, not from documentation):
 *  - millimetres, Y DOWN on the sheet; A4 landscape is 297 x 210
 *  - EVERYTHING electrical snaps to the 1.27 mm grid, or pins do not connect —
 *    connectivity is geometric: a wire endpoint must land exactly on a pin end
 *  - every element carries a v4 UUID; instances reference "/<root sheet uuid>"
 *  - lib_id is "Library:Symbol" and must match an entry embedded in
 *    (lib_symbols ...)
 *  - SYMBOL SPACE IS Y UP; sheet space is Y down. A pin at symbol-y +3.81 is
 *    BELOW the anchor on the sheet at rot 0... no: sheet_y = inst_y - sym_y.
 *    Getting this wrong flips every connection point, and ERC catches it —
 *    which is why ERC is wired in as the oracle rather than trusted eyeballs.
 *
 * The stock symbol library (222 .kicad_sym files ship with KiCad 10) is the
 * component vocabulary. Symbols that `extends` a parent are flattened at index
 * time — the parent's geometry under the child's name, inner unit names
 * rewritten to match, child property overrides applied. That rewrite is the
 * part that bites: unit sub-symbols are named "<name>_<unit>_<style>", and an
 * embedded symbol whose inner names still say the parent's renders empty.
 */

const GRID = 1.27;
const SHEET = { w: 297, h: 210 };            // A4 landscape
const SCH_VERSION = 20250114;                 // matches KiCad 9/10 output

/* ------------------------------------------------------- s-expressions --- */

/** Tokenise + parse a KiCad s-expression into nested arrays of strings. */
function parseSexpr(text) {
    const toks = [];
    const s = String(text);
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === "(" || c === ")") { toks.push(c); continue; }
        if (/\s/.test(c)) continue;
        if (c === '"') {
            let j = i + 1, out = "";
            while (j < s.length && s[j] !== '"') {
                if (s[j] === "\\" && j + 1 < s.length) { out += s[j + 1]; j += 2; }
                else { out += s[j]; j++; }
            }
            toks.push({ str: out });
            i = j;
            continue;
        }
        let j = i, out = "";
        while (j < s.length && !/[\s()]/.test(s[j])) { out += s[j]; j++; }
        toks.push(out);
        i = j - 1;
    }
    let k = 0;
    function walk() {
        const node = [];
        while (k < toks.length) {
            const t = toks[k++];
            if (t === "(") node.push(walk());
            else if (t === ")") return node;
            else node.push(t);
        }
        return node;
    }
    if (toks[0] !== "(") throw new ToolError("not an s-expression");
    k = 1;
    return walk();
}

const isNode = (x) => Array.isArray(x);
const head = (n) => (isNode(n) && typeof n[0] === "string") ? n[0] : null;
const atomText = (a) => (a && typeof a === "object" && "str" in a) ? a.str : String(a);
const children = (n, name) => isNode(n) ? n.filter(c => head(c) === name) : [];
const child = (n, name) => children(n, name)[0] || null;

/** Serialise back. Strings that were quoted stay quoted. */
function printSexpr(node, depth = 0) {
    const pad = "\t".repeat(depth);
    const parts = [];
    let inlineOk = true;
    for (const c of node) {
        if (isNode(c)) { inlineOk = false; break; }
    }
    if (inlineOk && node.length <= 6) {
        return pad + "(" + node.map(a =>
            (typeof a === "object" && "str" in a) ? JSON.stringify(a.str) : String(a)).join(" ") + ")";
    }
    for (const c of node) {
        if (isNode(c)) parts.push(printSexpr(c, depth + 1));
        else parts.push("\t".repeat(depth + 1) +
            ((typeof c === "object" && "str" in c) ? JSON.stringify(c.str) : String(c)));
    }
    // keep the head atom on the opening line
    const first = parts.shift().trim();
    return pad + "(" + first + (parts.length ? "\n" + parts.join("\n") : "") + "\n" + pad + ")";
}

/* --------------------------------------------------------- symbol index --- */

function kicadShare() {
    const candidates = [
        path.join(process.env.LOCALAPPDATA || "", "Programs", "KiCad", "10.0", "share", "kicad"),
        path.join(process.env.LOCALAPPDATA || "", "Programs", "KiCad", "9.0", "share", "kicad"),
        "C:/Program Files/KiCad/10.0/share/kicad",
        "C:/Program Files/KiCad/9.0/share/kicad"
    ];
    for (const c of candidates) if (c && fs.existsSync(path.join(c, "symbols"))) return c;
    return null;
}

function kicadCli() {
    const share = kicadShare();
    if (!share) return null;
    const cli = path.join(share, "..", "..", "bin", "kicad-cli.exe");
    return fs.existsSync(cli) ? cli : null;
}

function available() { return kicadShare() !== null; }

/**
 * Pull ONE symbol out of a .kicad_sym library, flattened.
 *
 * Returns { name, lib, sexpr (node, renamed to "LIB:NAME"), pins:[{number,
 * name, x, y, angle, length}] } — pin x/y in SYMBOL space (Y up), at the
 * CONNECTION end.
 */
function extractSymbol(libFile, symName) {
    const lib = path.basename(libFile, ".kicad_sym");
    const doc = parseSexpr(fs.readFileSync(libFile, "utf8"));
    const all = children(doc, "symbol");
    const byName = new Map(all.map(s => [atomText(s[1]), s]));
    const target = byName.get(symName);
    if (!target) return null;

    // resolve extends: geometry comes from the parent, identity from the child
    const ext = child(target, "extends");
    let base = target;
    let overrides = null;
    if (ext) {
        const parent = byName.get(atomText(ext[1]));
        if (!parent) return null;
        base = parent;
        overrides = target;
    }

    // deep-copy the base node, then rewrite names
    const clone = JSON.parse(JSON.stringify(base));
    const baseName = atomText(base[1]);
    clone[1] = { str: `${lib}:${symName}` };
    // inner unit sub-symbols are "<basename>_<unit>_<style>" — rename to match
    for (const sub of children(clone, "symbol")) {
        const n = atomText(sub[1]);
        if (n.startsWith(baseName + "_")) sub[1] = { str: symName + n.slice(baseName.length) };
    }
    // drop a parent's extends if any survived the copy
    for (let i = clone.length - 1; i >= 0; i--) {
        if (head(clone[i]) === "extends") clone.splice(i, 1);
    }
    // apply the child's property overrides (Value, Reference prefix, etc.)
    if (overrides) {
        for (const p of children(overrides, "property")) {
            const key = atomText(p[1]);
            const existing = children(clone, "property").find(q => atomText(q[1]) === key);
            if (existing) {
                const idx = clone.indexOf(existing);
                clone[idx] = JSON.parse(JSON.stringify(p));
            } else {
                clone.push(JSON.parse(JSON.stringify(p)));
            }
        }
    }

    // pins live in the unit sub-symbols
    const pins = [];
    for (const sub of children(clone, "symbol")) {
        for (const p of children(sub, "pin")) {
            const at = child(p, "at") || [];
            const numNode = child(p, "number");
            const nameNode = child(p, "name");
            pins.push({
                number: numNode ? atomText(numNode[1]) : "",
                name: nameNode ? atomText(nameNode[1]) : "",
                x: parseFloat(atomText(at[1] ?? "0")),
                y: parseFloat(atomText(at[2] ?? "0")),
                angle: parseFloat(atomText(at[3] ?? "0")),
                length: parseFloat(atomText((child(p, "length") || [])[1] ?? "0"))
            });
        }
    }
    return { name: symName, lib, libId: `${lib}:${symName}`, sexpr: clone, pins };
}

/** Find "Device:R" across the stock libraries. Cached per libId. */
const symCache = new Map();
function getSymbol(libId) {
    if (symCache.has(libId)) return symCache.get(libId);
    const [lib, name] = String(libId).split(":");
    if (!lib || !name) throw new ToolError(`symbol id must be "Library:Name", got "${libId}"`);
    const share = kicadShare();
    if (!share) throw new ToolError("KiCad's symbol libraries were not found on this machine");
    const file = path.join(share, "symbols", `${lib}.kicad_sym`);
    if (!fs.existsSync(file)) {
        throw new ToolError(`no library "${lib}" — e.g. Device, Connector, power, Amplifier_Operational`);
    }
    const sym = extractSymbol(file, name);
    if (!sym) throw new ToolError(`"${name}" is not in ${lib}.kicad_sym`);
    symCache.set(libId, sym);
    return sym;
}

/** Search the stock libraries by name fragment — the model's discovery tool. */
function searchSymbols(query, limit = 20) {
    const share = kicadShare();
    if (!share) return [];
    const q = String(query || "").toLowerCase();
    if (!q) return [];
    const out = [];
    const dir = path.join(share, "symbols");
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".kicad_sym")) continue;
        const lib = path.basename(f, ".kicad_sym");
        // names are quoted atoms after (symbol — a text scan is 100x faster
        // than parsing 222 libraries
        const text = fs.readFileSync(path.join(dir, f), "utf8");
        const re = /\(symbol\s+"([^":]+)"/g;
        let m;
        while ((m = re.exec(text)) && out.length < limit) {
            if (m[1].toLowerCase().includes(q)) out.push(`${lib}:${m[1]}`);
        }
        if (out.length >= limit) break;
    }
    return out;
}

/* ----------------------------------------------------------- generation --- */

const uuid = () => crypto.randomUUID();
const snap = (v) => Math.round(v / GRID) * GRID;
const fix = (v) => +v.toFixed(4);

/** A pin's absolute sheet position for an instance at (ix, iy), rotation rot.
 *  Symbol space is Y UP; the sheet is Y DOWN. */
function pinAt(pin, ix, iy, rot = 0) {
    let { x, y } = pin;
    // rotate in symbol space (KiCad rotates counter-clockwise)
    const r = ((rot % 360) + 360) % 360;
    let rx = x, ry = y;
    if (r === 90) { rx = -y; ry = x; }
    else if (r === 180) { rx = -x; ry = -y; }
    else if (r === 270) { rx = y; ry = -x; }
    return { x: fix(ix + rx), y: fix(iy - ry) };
}

const q = (s) => ({ str: String(s) });

/**
 * Build a schematic.
 *
 * components: [{ref, symbol, value?, at?[x,y], rot?}]
 * nets:       [{name?, pins:["R1.1","C1.2", ...]}]
 *
 * Placement: explicit `at` wins; otherwise a left-to-right ladder on the grid.
 * Routing: 2-pin nets get an L (H-then-V); wider nets get a horizontal trunk
 * below the parts with a vertical drop per pin and junctions at 3+ meets.
 */
function buildSchematic({ components = [], nets = [], title = "", texts = [] } = {}) {
    if (!components.length) throw new ToolError("draw_schematic needs at least one component");
    if (components.length > 60) throw new ToolError("keep it under 60 components per sheet");
    if (!Array.isArray(texts)) throw new ToolError("texts must be an array of strings");
    if (texts.length > 30) throw new ToolError("keep it under 30 text notes per sheet");

    const rootUuid = uuid();
    const used = new Map();          // libId -> symbol
    const placed = new Map();        // ref -> {sym, x, y, rot}

    // ---- placement
    let cursor = 40;
    const ladderY = snap(SHEET.h / 2 - 20);
    for (const c of components) {
        const ref = String(c.ref || "").trim();
        if (!ref) throw new ToolError("every component needs a ref (R1, C2, U3…)");
        if (placed.has(ref)) throw new ToolError(`duplicate ref "${ref}"`);
        const sym = getSymbol(String(c.symbol));
        used.set(sym.libId, sym);
        let x, y;
        if (Array.isArray(c.at) && c.at.length === 2) {
            x = snap(+c.at[0]); y = snap(+c.at[1]);
        } else {
            x = snap(cursor); y = ladderY;
            cursor += 30;
        }
        if (x < 10 || x > SHEET.w - 10 || y < 10 || y > SHEET.h - 10) {
            throw new ToolError(`"${ref}" lands off the sheet at (${x}, ${y})`);
        }
        placed.set(ref, { c, sym, x, y, rot: (+c.rot || 0) % 360 });
    }

    // ---- resolve "REF.PIN" to a sheet position
    const pinPos = (spec) => {
        const m = /^([^.]+)\.(.+)$/.exec(String(spec).trim());
        if (!m) throw new ToolError(`net pins are "REF.PIN", got "${spec}"`);
        const inst = placed.get(m[1]);
        if (!inst) throw new ToolError(`net references unknown component "${m[1]}"`);
        const pin = inst.sym.pins.find(p => p.number === m[2] || p.name === m[2]);
        if (!pin) {
            const have = inst.sym.pins.map(p => p.number).join(", ");
            throw new ToolError(`"${m[1]}" has no pin "${m[2]}" (pins: ${have})`);
        }
        return pinAt(pin, inst.x, inst.y, inst.rot);
    };

    // ---- routing
    const wires = [];
    const junctions = [];
    const labels = [];
    const addWire = (a, b) => {
        if (a.x === b.x && a.y === b.y) return;
        wires.push([a, b]);
    };
    let trunkY = snap(ladderY + 30);
    for (const net of nets) {
        const pts = (net.pins || []).map(pinPos);
        if (pts.length < 2) throw new ToolError(`net "${net.name || "?"}" needs at least two pins`);
        if (pts.length === 2) {
            const [a, b] = pts;
            if (a.x === b.x || a.y === b.y) addWire(a, b);
            else {
                const corner = { x: b.x, y: a.y };
                addWire(a, corner); addWire(corner, b);
            }
            if (net.name) labels.push({ at: pts[0], name: net.name });
        } else {
            // trunk below the parts, one drop per pin
            const yT = trunkY; trunkY = snap(trunkY + 10);
            const xs = pts.map(p => p.x);
            const lo = { x: Math.min(...xs), y: yT }, hi = { x: Math.max(...xs), y: yT };
            addWire(lo, hi);
            for (const p of pts) {
                addWire(p, { x: p.x, y: yT });
                // a drop meeting the trunk mid-span is a 3-way join
                if (p.x > lo.x && p.x < hi.x) junctions.push({ x: p.x, y: yT });
            }
            if (net.name) labels.push({ at: { x: lo.x, y: yT }, name: net.name });
        }
    }

    // ---- serialise
    const doc = ["kicad_sch",
        ["version", String(SCH_VERSION)],
        ["generator", q("lcl")],
        ["generator_version", q("1.0")],
        ["uuid", q(rootUuid)],
        ["paper", q("A4")]
    ];
    if (title) {
        doc.push(["title_block", ["title", q(title)],
            ["comment", "1", q("generated by .lcl")]]);
    }
    const libs = ["lib_symbols"];
    for (const sym of used.values()) libs.push(sym.sexpr);
    doc.push(libs);

    for (const [a, b] of wires) {
        doc.push(["wire",
            ["pts", ["xy", String(a.x), String(a.y)], ["xy", String(b.x), String(b.y)]],
            ["stroke", ["width", "0"], ["type", "default"]],
            ["uuid", q(uuid())]]);
    }
    for (const j of junctions) {
        doc.push(["junction", ["at", String(j.x), String(j.y)],
            ["diameter", "0"], ["color", "0", "0", "0", "0"], ["uuid", q(uuid())]]);
    }
    for (const l of labels) {
        doc.push(["label", q(l.name),
            ["at", String(l.at.x), String(l.at.y), "0"],
            ["effects", ["font", ["size", "1.27", "1.27"]], ["justify", "left", "bottom"]],
            ["uuid", q(uuid())]]);
    }
    // free-text notes (the redline revision table): stacked bottom-left,
    // clear of the ladder and the net trunks
    let noteY = snap(SHEET.h - 12 - texts.length * 4);
    for (const t of texts) {
        doc.push(["text", q(String(t).slice(0, 200)),
            ["exclude_from_sim", "no"],
            ["at", "12", String(noteY), "0"],
            ["effects", ["font", ["size", "1.27", "1.27"]], ["justify", "left", "bottom"]],
            ["uuid", q(uuid())]]);
        noteY = snap(noteY + 4);
    }
    for (const [ref, inst] of placed) {
        const node = ["symbol",
            ["lib_id", q(inst.sym.libId)],
            ["at", String(inst.x), String(inst.y), String(inst.rot)],
            ["unit", "1"],
            ["exclude_from_sim", "no"], ["in_bom", "yes"], ["on_board", "yes"], ["dnp", "no"],
            ["uuid", q(uuid())],
            ["property", q("Reference"), q(ref),
                ["at", String(inst.x), String(fix(inst.y - 7)), "0"],
                ["effects", ["font", ["size", "1.27", "1.27"]]]],
            ["property", q("Value"), q(inst.c.value != null ? String(inst.c.value) : inst.sym.name),
                ["at", String(inst.x), String(fix(inst.y + 7)), "0"],
                ["effects", ["font", ["size", "1.27", "1.27"]]]]
        ];
        for (const p of inst.sym.pins) node.push(["pin", q(p.number), ["uuid", q(uuid())]]);
        node.push(["instances", ["project", q(""),
            ["path", q("/" + rootUuid), ["reference", q(ref)], ["unit", "1"]]]]);
        doc.push(node);
    }
    doc.push(["sheet_instances", ["path", q("/"), ["page", q("1")]]]);

    return "(" + printSexpr(doc, 0).slice(1);
}

/* ---------------------------------------------------------- kicad-cli ---- */

function runCli(args, timeoutMs = 60_000) {
    const cli = kicadCli();
    if (!cli) throw new ToolError("kicad-cli was not found — KiCad 9/10 is required");
    return new Promise((resolve) => {
        execFile(cli, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
            (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) }));
    });
}

/** ERC — the oracle. Structured violations, mm coordinates, severities. */
async function checkSchematic(schPath) {
    const outFile = path.join(os.tmpdir(), `lcl-erc-${Date.now()}.json`);
    const r = await runCli(["sch", "erc", "--format", "json", "--severity-all",
        "-o", outFile, schPath]);
    let report = null;
    try { report = JSON.parse(fs.readFileSync(outFile, "utf8")); } catch { /* below */ }
    try { fs.rmSync(outFile, { force: true }); } catch { /* temp */ }
    if (!report) {
        return { ok: false, error: "ERC produced no report",
                 detail: (r.stderr || r.stdout).slice(-400) };
    }
    const sheets = report.sheets || [];
    const violations = sheets.flatMap(s => (s.violations || []).map(v => ({
        severity: v.severity, type: v.type,
        description: v.description,
        at: v.items && v.items[0] && v.items[0].pos
            ? { x: v.items[0].pos.x, y: v.items[0].pos.y } : null
    })));
    const errors = violations.filter(v => v.severity === "error");
    return {
        ok: errors.length === 0,
        errors: errors.length,
        warnings: violations.filter(v => v.severity === "warning").length,
        violations: violations.slice(0, 30)
    };
}

const EXPORTS = new Set(["svg", "pdf", "dxf", "netlist", "bom"]);

async function exportSchematic(schPath, format, outPath) {
    const f = String(format || "svg").toLowerCase();
    if (!EXPORTS.has(f)) throw new ToolError(`format must be one of ${[...EXPORTS].join(", ")}`);
    const args = ["sch", "export", f, "-o", outPath, schPath];
    const r = await runCli(args);
    // svg export writes into a DIRECTORY; normalise to the produced file.
    // kicad-cli names each sheet's SVG after the sheet, so a single-sheet export
    // is "<schematic base>.svg". Picking the FIRST .svg in readdir order handed
    // back an arbitrary (often wrong) file when the directory held more than one;
    // prefer the exact base-name match, then fall back to the most recently
    // written .svg — which, since the export just ran, is the one produced.
    let produced = outPath;
    if (f === "svg" && fs.existsSync(outPath) && fs.statSync(outPath).isDirectory()) {
        const svgs = fs.readdirSync(outPath).filter(x => x.toLowerCase().endsWith(".svg"));
        const want = path.basename(schPath).replace(/\.kicad_sch$/i, "") + ".svg";
        let pick = svgs.find(x => x === want)
            || svgs.find(x => x.toLowerCase() === want.toLowerCase());
        if (!pick && svgs.length) {
            pick = svgs
                .map(x => ({ x, m: fs.statSync(path.join(outPath, x)).mtimeMs }))
                .sort((a, b) => b.m - a.m)[0].x;
        }
        if (pick) produced = path.join(outPath, pick);
    }
    if (!fs.existsSync(produced)) {
        return { ok: false, error: "export produced no file",
                 detail: (r.stderr || r.stdout).slice(-400) };
    }
    return { ok: true, file: produced, bytes: fs.statSync(produced).size, format: f };
}

/* --------------------------------------------------------------- tools --- */

const DRAW_ENTRY = {
    run: async (root, args = {}, ctx = {}) => {
        if (!root) throw new ToolError("link a workspace folder first — the schematic is written there");
        const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
        const rel = String(args.path || "schematic.kicad_sch");
        if (!rel.endsWith(".kicad_sch")) throw new ToolError("path must end in .kicad_sch");
        const full = resolveInRoot(root, rel);

        onNote("placing and routing");
        const text = buildSchematic(args);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, text, "utf8");

        // ERC immediately: the file is only DONE if the rules checker agrees
        onNote("running ERC");
        let erc = { ok: null };
        try { erc = await checkSchematic(full); } catch (e) { erc = { ok: null, error: e.message }; }
        return {
            file: rel, bytes: Buffer.byteLength(text),
            components: args.components.length, nets: (args.nets || []).length,
            erc: erc.ok === null ? "unavailable"
                : erc.ok ? "clean"
                : `${erc.errors} error(s)`,
            ercDetail: (erc.violations || []).filter(v => v.severity === "error").slice(0, 5)
        };
    },
    help: 'draw_schematic {"path": "loop.kicad_sch", "title": "…", "components": ' +
        '[{"ref":"R1","symbol":"Device:R","value":"1k"}], "nets": [{"name":"OUT",' +
        '"pins":["R1.2","R2.1"]}]} — generate a real KiCad schematic and ERC-check it'
};

const CHECK_ENTRY = {
    run: async (root, args = {}, ctx = {}) => {
        if (!root) throw new ToolError("link a workspace folder first");
        const full = resolveInRoot(root, String(args.path || ""));
        if (!fs.existsSync(full)) throw new ToolError(`no such file: ${args.path}`);
        (ctx.onNote || (() => {}))("running ERC");
        return checkSchematic(full);
    },
    help: 'check_schematic {"path": "loop.kicad_sch"} — run KiCad\'s electrical rules ' +
        'check and return the violations'
};

const EXPORT_ENTRY = {
    run: async (root, args = {}, ctx = {}) => {
        if (!root) throw new ToolError("link a workspace folder first");
        const full = resolveInRoot(root, String(args.path || ""));
        if (!fs.existsSync(full)) throw new ToolError(`no such file: ${args.path}`);
        const f = String(args.format || "svg").toLowerCase();
        const outRel = String(args.out || args.path.replace(/\.kicad_sch$/, "")) +
            (f === "netlist" ? ".net" : f === "bom" ? ".csv" : "." + f);
        const outFull = resolveForWrite(root, outRel, "write");
        (ctx.onNote || (() => {}))(`exporting ${f}`);
        const r = await exportSchematic(full, f, f === "svg" ? path.dirname(outFull) : outFull);
        if (r.ok) r.file = path.relative(root, r.file).split(path.sep).join("/");
        return r;
    },
    help: 'export_schematic {"path": "loop.kicad_sch", "format": "svg"} — render a ' +
        'schematic to svg, pdf, dxf, netlist or bom'
};

const SEARCH_ENTRY = {
    run: async (_root, args = {}) => {
        const hits = searchSymbols(args.query, Math.min(+args.limit || 20, 40));
        return { symbols: hits, note: hits.length ? undefined :
            "nothing matched — try a part class like resistor, capacitor, opamp, terminal" };
    },
    help: 'find_symbol {"query": "opamp"} — search KiCad\'s stock component symbols; ' +
        'returns Library:Name ids for draw_schematic'
};

module.exports = {
    available, buildSchematic, checkSchematic, exportSchematic,
    getSymbol, searchSymbols, parseSexpr, printSexpr, pinAt, kicadCli,
    DRAW_ENTRY, CHECK_ENTRY, EXPORT_ENTRY, SEARCH_ENTRY
};
