const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ToolError, resolveInRoot } = require("./fsTools");

/**
 * CAD — "build me a 3D model" produces a file, not a paragraph.
 *
 * FreeCAD 1.1 is installed on this machine with a headless interpreter
 * (freecadcmd.exe) and a full parametric kernel. Verified before building:
 * box-minus-cylinder recomputes to a valid solid, volume 43978.761 mm³, and
 * exports a real STEP file. So the tool's job is to turn a JSON description
 * into a generated Python script, run it out of process, and report back the
 * MEASURED result — volume, area, bounding box, centre of mass — because a
 * claim about geometry should come from the kernel, not the language model.
 *
 * The validation contract is lifted from the user's own build_crankshaft.py:
 * recompute clean, shape valid, not null, at least one solid, finite positive
 * volume — and only then save. A bad boolean must never silently ship a null
 * shape.
 *
 * The model supplies ONLY structured data — shapes, dimensions, operations.
 * It never writes Python. The script is assembled here from vetted numbers,
 * so there is no path from a prompt to arbitrary code in FreeCAD's
 * interpreter.
 */

const RUN_TIMEOUT_MS = 180_000;    // a cold FreeCAD start is slow; a hang is slower
const MAX_PARTS = 20;
const MAX_DIM_MM = 10_000;         // ten metres: generous, still sane
const FORMATS = { step: "step", stp: "step", stl: "stl", iges: "iges", igs: "iges", obj: "obj" };

function freecadCmd() {
    const candidates = [
        "C:/Program Files/FreeCAD 1.1/bin/freecadcmd.exe",
        "C:/Program Files/FreeCAD 1.0/bin/freecadcmd.exe",
        path.join(process.env.LOCALAPPDATA || "", "Programs", "FreeCAD 1.1", "bin", "freecadcmd.exe")
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return null;
}

function available() { return freecadCmd() !== null; }

/* ------------------------------------------------------------- validate --- */

const num = (v, what, { min = 0.01, max = MAX_DIM_MM } = {}) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) {
        throw new ToolError(`${what} must be a number between ${min} and ${max} (mm), got ${JSON.stringify(v)}`);
    }
    return n;
};

/** One primitive -> the FreeCAD lines that create it. Numbers only — every
 *  value passes through num() so nothing stringy reaches the script. */
function primitiveLines(p, name) {
    const at = Array.isArray(p.at) ? p.at : [0, 0, 0];
    const pos = [num(at[0] ?? 0, "at.x", { min: -MAX_DIM_MM }),
                 num(at[1] ?? 0, "at.y", { min: -MAX_DIM_MM }),
                 num(at[2] ?? 0, "at.z", { min: -MAX_DIM_MM })];
    const rot = p.rotate ? [num(p.rotate[0] ?? 0, "rotate.x", { min: -360, max: 360 }),
                           num(p.rotate[1] ?? 0, "rotate.y", { min: -360, max: 360 }),
                           num(p.rotate[2] ?? 0, "rotate.z", { min: -360, max: 360 })] : null;
    const place = rot
        ? `App.Placement(App.Vector(${pos.join(",")}), App.Rotation(${rot[2]},${rot[1]},${rot[0]}))`
        : `App.Placement(App.Vector(${pos.join(",")}), App.Rotation())`;

    const shape = String(p.shape || "").toLowerCase();
    switch (shape) {
        case "box": case "cube": {
            const L = num(p.length ?? p.size, "length"), W = num(p.width ?? p.size, "width"),
                  H = num(p.height ?? p.size, "height");
            return [`${name} = doc.addObject("Part::Box", ${JSON.stringify(name)})`,
                    `${name}.Length, ${name}.Width, ${name}.Height = ${L}, ${W}, ${H}`,
                    `${name}.Placement = ${place}`];
        }
        case "cylinder": {
            const R = p.d != null ? num(p.d, "d") / 2 : num(p.r ?? p.radius, "r");
            const H = num(p.h ?? p.height, "h");
            return [`${name} = doc.addObject("Part::Cylinder", ${JSON.stringify(name)})`,
                    `${name}.Radius, ${name}.Height = ${R}, ${H}`,
                    `${name}.Placement = ${place}`];
        }
        case "sphere": {
            const R = p.d != null ? num(p.d, "d") / 2 : num(p.r ?? p.radius, "r");
            return [`${name} = doc.addObject("Part::Sphere", ${JSON.stringify(name)})`,
                    `${name}.Radius = ${R}`,
                    `${name}.Placement = ${place}`];
        }
        case "cone": {
            const R1 = num(p.r1 ?? p.r ?? ((p.d1 ?? p.d ?? 0) / 2 || undefined), "r1");
            const R2 = num(p.r2 ?? 0, "r2", { min: 0 });
            const H = num(p.h ?? p.height, "h");
            return [`${name} = doc.addObject("Part::Cone", ${JSON.stringify(name)})`,
                    `${name}.Radius1, ${name}.Radius2, ${name}.Height = ${R1}, ${R2}, ${H}`,
                    `${name}.Placement = ${place}`];
        }
        case "torus": {
            const R1 = num(p.r1 ?? p.r, "r1"), R2 = num(p.r2, "r2");
            return [`${name} = doc.addObject("Part::Torus", ${JSON.stringify(name)})`,
                    `${name}.Radius1, ${name}.Radius2 = ${R1}, ${R2}`,
                    `${name}.Placement = ${place}`];
        }
        default:
            throw new ToolError(`unknown shape "${p.shape}" — box, cylinder, sphere, cone or torus`);
    }
}

/* --------------------------------------------------------------- script --- */

function buildScript(spec, outFile, fmt) {
    const parts = Array.isArray(spec.parts) && spec.parts.length ? spec.parts
        : [{ ...spec, op: undefined }];          // single-shape shorthand
    if (parts.length > MAX_PARTS) throw new ToolError(`keep it under ${MAX_PARTS} parts`);

    const lines = [
        "import json, os, sys",
        "import FreeCAD as App",
        "import Part, Import, Mesh",
        'doc = App.newDocument("m")'
    ];
    const names = [];
    parts.forEach((p, i) => {
        const name = `p${i}`;
        lines.push(...primitiveLines(p, name));
        names.push({ name, op: String(p.op || (i === 0 ? "base" : "fuse")).toLowerCase() });
    });

    // fold the parts together: base, then fuse/cut/common in order
    let current = names[0].name;
    names.slice(1).forEach((n, i) => {
        const opName = { fuse: "Part::MultiFuse", cut: "Part::Cut", common: "Part::Common" }[n.op];
        if (!opName) throw new ToolError(`part op must be fuse, cut or common — got "${n.op}"`);
        const bool = `b${i}`;
        if (opName === "Part::MultiFuse") {
            lines.push(`${bool} = doc.addObject("Part::MultiFuse", ${JSON.stringify(bool)})`,
                       `${bool}.Shapes = [${current}, ${n.name}]`);
        } else {
            lines.push(`${bool} = doc.addObject(${JSON.stringify(opName)}, ${JSON.stringify(bool)})`,
                       `${bool}.Base, ${bool}.Tool = ${current}, ${n.name}`);
        }
        current = bool;
    });

    // optional edge treatment on the final solid
    if (spec.fillet != null) {
        const r = num(spec.fillet, "fillet", { min: 0.01, max: 1000 });
        lines.push(`f = doc.addObject("Part::Fillet", "f")`,
                   `f.Base = ${current}`,
                   `doc.recompute()`,
                   `edges = [(i+1, ${r}, ${r}) for i in range(len(${current}.Shape.Edges))]`,
                   `f.Edges = edges`);
        current = "f";
    }

    // THE VALIDATION CONTRACT (from the user's build_crankshaft.py): nothing
    // ships unless the kernel says the shape is real
    lines.push(
        "doc.recompute()",
        "errs = [o.Name for o in doc.Objects if o.State and ('Invalid' in str(o.State) or 'Error' in str(o.State))]",
        `shape = ${current}.Shape`,
        "solid = shape.Solids[0] if shape.Solids else None",
        "ok = (not errs) and solid is not None and shape.isValid() and (not shape.isNull()) and solid.Volume > 0",
        "result = {}",
        "if ok:",
        "    bb = solid.BoundBox",
        "    com = solid.CenterOfMass",
        `    Import.export([${current}], ${JSON.stringify(outFile)})` ,
        "    result = {'ok': True, 'volume_mm3': round(solid.Volume, 3),",
        "              'area_mm2': round(solid.Area, 3),",
        "              'bbox_mm': [round(bb.XLength,3), round(bb.YLength,3), round(bb.ZLength,3)],",
        "              'center_of_mass': [round(com.x,3), round(com.y,3), round(com.z,3)],",
        "              'solids': len(shape.Solids),",
        "              'file_bytes': os.path.getsize(" + JSON.stringify(outFile) + ")}",
        "else:",
        "    result = {'ok': False, 'errors': errs,",
        "              'valid': shape.isValid() if shape else False,",
        "              'solids': len(shape.Solids) if shape else 0}",
        "print('LCL_JSON_START'); print(json.dumps(result)); print('LCL_JSON_END')"
    );

    if (fmt === "stl" || fmt === "obj") {
        // mesh formats go through Mesh.export instead of Import.export
        const i = lines.indexOf(`    Import.export([${current}], ${JSON.stringify(outFile)})`);
        lines[i] = `    Mesh.export([${current}], ${JSON.stringify(outFile)})`;
    }
    return lines.join("\n") + "\n";
}

/* ------------------------------------------------------------------ run --- */

async function buildModel(root, spec = {}, ctx = {}) {
    const cmd = freecadCmd();
    if (!cmd) throw new ToolError("FreeCAD 1.x with freecadcmd.exe is required and was not found");
    if (!root) throw new ToolError("link a workspace folder first — the model file is written there");
    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};

    const fmt = FORMATS[String(spec.format || "step").toLowerCase()];
    if (!fmt) throw new ToolError(`format must be one of ${[...new Set(Object.values(FORMATS))].join(", ")}`);
    const rel = String(spec.path || `model.${fmt}`);
    const full = resolveInRoot(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });

    const script = buildScript(spec, full.replace(/\\/g, "/"), fmt);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lcl-cad-"));
    const scriptFile = path.join(dir, "build.py");
    fs.writeFileSync(scriptFile, script, "utf8");

    onNote("building in FreeCAD");
    const out = await new Promise((resolve) => {
        execFile(cmd, [scriptFile],
            { timeout: RUN_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
            (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) }));
    });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }

    if (out.err && out.err.killed) {
        return { ok: false, error: `FreeCAD did not finish within ${RUN_TIMEOUT_MS / 1000}s` };
    }
    const m = out.stdout.match(/LCL_JSON_START\s*([\s\S]*?)\s*LCL_JSON_END/);
    if (!m) {
        return { ok: false, error: "FreeCAD produced no result",
                 detail: (out.stderr || out.stdout).slice(-400) };
    }
    let r;
    try { r = JSON.parse(m[1]); } catch { return { ok: false, error: "unreadable FreeCAD output" }; }
    if (!r.ok) {
        return { ok: false,
                 error: "the geometry did not survive validation — " +
                        (r.errors && r.errors.length ? `objects in error: ${r.errors.join(", ")}`
                            : r.solids === 0 ? "the result contains no solid (a cut can consume everything)"
                            : "the shape is invalid"),
                 detail: r };
    }
    return { ok: true, file: rel, format: fmt, ...r };
}

const TOOL_ENTRY = {
    run: (root, args, ctx) => buildModel(root, args, ctx),
    help: 'build_model {"shape": "cylinder", "d": 50, "h": 120, "format": "step"} or ' +
        '{"parts": [{"shape":"box","length":60,"width":40,"height":20}, ' +
        '{"op":"cut","shape":"cylinder","d":16,"h":50,"at":[30,20,-5]}]} — build a real ' +
        '3D solid in FreeCAD, validate it, export STEP/STL, and report measured volume'
};

module.exports = { available, buildModel, buildScript, freecadCmd, TOOL_ENTRY };
