const machine = require("./machine");
const { ToolError } = require("./fsTools");

/**
 * Small always-available capabilities that need no workspace and no engine:
 *   - calculate: a SAFE arithmetic evaluator (small models guess at math)
 *   - system_stats / process_list: the machine view the policy table already
 *     classified but nobody had built — so "why is my machine slow" gets real
 *     numbers instead of a guess
 *
 * None of these read or write the workspace, so they are granted at base
 * level (sys.read) and never touch the filesystem sandbox.
 */

/* ------------------------------------------------------------- calculator */

// A recursive-descent evaluator over a fixed grammar. NOT eval() — no
// identifiers, no calls, no property access reach any interpreter. Only
// numbers and the operators below exist, so nothing here can execute code.
//
// Object.create(null): a plain literal inherits Object.prototype, so
// FUNCS["constructor"] resolves to Object and FUNCS["__proto__"] to
// Object.prototype — both truthy, both slipping past a `!fn` guard. A null
// prototype makes the whitelist genuinely closed instead of relying on the
// input lowercasing to break camelCase names (review finding).
const CONSTS = Object.assign(Object.create(null), { pi: Math.PI, e: Math.E });
const FUNCS = Object.assign(Object.create(null), {
    sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor,
    ceil: Math.ceil, sin: Math.sin, cos: Math.cos, tan: Math.tan,
    log: Math.log, log10: Math.log10, log2: Math.log2, exp: Math.exp,
    min: Math.min, max: Math.max
});

function tokenize(src) {
    const tokens = [];
    const re = /\s*([0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?|[a-z_][a-z0-9_]*|[()+\-*/%^,])/y;
    let i = 0;
    while (i < src.length) {
        re.lastIndex = i;
        const m = re.exec(src);
        if (!m) throw new ToolError(`cannot parse near "${src.slice(i, i + 12)}"`);
        tokens.push(m[1]);
        i = re.lastIndex;
    }
    return tokens;
}

function evaluate(expression) {
    // trim so trailing/leading whitespace does not leave the tokenizer's sticky
    // regex with a required token group and nothing to match ("cannot parse near")
    const src = String(expression || "").toLowerCase().trim();
    if (!src) throw new ToolError('calculate needs {"expression": "2 + 2"}');
    if (src.length > 500) throw new ToolError("expression too long");
    const t = tokenize(src);
    let pos = 0;
    const peek = () => t[pos];
    const eat = (x) => { if (t[pos] !== x) throw new ToolError(`expected '${x}'`); pos++; };

    function parseExpr() { return parseAdd(); }
    function parseAdd() {
        let v = parseMul();
        while (peek() === "+" || peek() === "-") {
            const op = t[pos++]; const r = parseMul();
            v = op === "+" ? v + r : v - r;
        }
        return v;
    }
    function parseMul() {
        let v = parseUnary();
        while (peek() === "*" || peek() === "/" || peek() === "%") {
            const op = t[pos++]; const r = parseUnary();
            if ((op === "/" || op === "%") && r === 0) throw new ToolError("division by zero");
            v = op === "*" ? v * r : op === "/" ? v / r : v % r;
        }
        return v;
    }
    function parseUnary() {
        if (peek() === "-") { pos++; return -parseUnary(); }
        if (peek() === "+") { pos++; return parseUnary(); }
        return parsePow();
    }
    function parsePow() {
        const base = parseAtom();
        if (peek() === "^") { pos++; return Math.pow(base, parseUnary()); }
        return base;
    }
    function parseAtom() {
        const tok = peek();
        if (tok === "(") { eat("("); const v = parseExpr(); eat(")"); return v; }
        // match the tokenizer, which accepts a leading-dot decimal like ".5":
        // guarding on [0-9] only rejected it and threw "unexpected end of expression"
        if (/^[0-9.]/.test(tok || "")) { pos++; return Number(tok); }
        if (/^[a-z_]/.test(tok || "")) {
            pos++;
            if (peek() === "(") {
                const fn = FUNCS[tok];
                // typeof guard belt-and-braces even with the null prototype
                if (typeof fn !== "function") throw new ToolError(`unknown function '${tok}'`);
                eat("(");
                const args = [parseExpr()];
                while (peek() === ",") { pos++; args.push(parseExpr()); }
                eat(")");
                return fn(...args);
            }
            if (tok in CONSTS) return CONSTS[tok];
            throw new ToolError(`unknown name '${tok}'`);
        }
        throw new ToolError("unexpected end of expression");
    }

    const result = parseExpr();
    if (pos !== t.length) throw new ToolError(`unexpected '${t[pos]}'`);
    if (!Number.isFinite(result)) throw new ToolError("result is not a finite number");
    return result;
}

function calculate(_root, { expression } = {}) {
    const value = evaluate(expression);
    // integers exact; otherwise trim floating noise without lying about it
    const rounded = Math.abs(value - Math.round(value)) < 1e-10 ? Math.round(value) : value;
    return { expression: String(expression), result: rounded };
}

/* ------------------------------------------------------------- machine view */

function fmtGB(b) { return (b / 1e9).toFixed(1) + " GB"; }

// async because a truthful CPU reading needs two samples over a real window.
// It used to call machine.cpu() once, which reported the machine's average
// utilisation SINCE BOOT — so the model asking "is this machine busy?" before
// planning a heavy job got a number that had almost nothing to do with now.
async function systemStats() {
    const mem = machine.memory();
    const cpu = await machine.cpuSampled();
    return {
        memory: {
            available: fmtGB(mem.availableBytes),
            total: fmtGB(mem.physTotalBytes),
            usedPercent: Math.round((1 - mem.availRatio) * 100),
            pressure: mem.level                     // ok | low | critical
        },
        cpu: {
            model: cpu.model, cores: cpu.threads,
            busyPercent: Math.round(cpu.busyRatio * 100),
            // the old number, correctly labelled, so both readings are available
            // and neither can be mistaken for the other
            busyPercentSinceBoot: Math.round(cpu.busyRatioSinceBoot * 100)
        },
        note: mem.level === "ok"
            ? "memory is healthy"
            : `memory is ${mem.level}: ${fmtGB(mem.availableBytes)} available of ${fmtGB(mem.physTotalBytes)}`
    };
}

/** Heaviest processes by memory. Spawns PowerShell, so a low per-turn cap. */
function processList() {
    const { spawnSync } = require("child_process");
    if (process.platform !== "win32") {
        return { processes: [], note: "process list is only implemented on Windows so far" };
    }
    const script =
        "Get-Process | Group-Object ProcessName | ForEach-Object { " +
        "[pscustomobject]@{ name=$_.Name; count=$_.Count; " +
        "mb=[math]::Round((($_.Group|Measure-Object WorkingSet64 -Sum).Sum)/1MB) } } | " +
        "Sort-Object mb -Descending | Select-Object -First 12 | ConvertTo-Json -Compress";
    const r = spawnSync("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", timeout: 12000, windowsHide: true });
    if (r.status !== 0) return { processes: [], note: "could not read the process list" };
    let rows = [];
    try { rows = JSON.parse(r.stdout); if (!Array.isArray(rows)) rows = [rows]; } catch { /* empty */ }
    return {
        processes: rows.map(p => ({ name: p.name, instances: p.count, memoryMB: p.mb })),
        note: "top memory users right now; close the big ones you are not using"
    };
}

const CALC_ENTRY = {
    run: calculate,
    help: 'calculate {"expression": "(1920/1080) * 100"} — evaluate arithmetic exactly ' +
        '(+ - * / % ^, sqrt, round, sin, log, min, max, pi, e)'
};
const STATS_ENTRY = {
    run: () => systemStats(),
    help: 'system_stats {} — this machine\'s current memory pressure and CPU load'
};
const PROC_ENTRY = {
    run: () => processList(),
    help: 'process_list {} — the heaviest running processes by memory (to find what to close)'
};

module.exports = { evaluate, calculate, systemStats, processList,
                   CALC_ENTRY, STATS_ENTRY, PROC_ENTRY };
