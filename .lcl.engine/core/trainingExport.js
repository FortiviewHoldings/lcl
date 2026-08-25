const fs = require("fs");
const os = require("os");
const path = require("path");
const paths = require("./paths");
const secretGuard = require("./secretGuard");
const securityTools = require("./securityTools");

/**
 * TRAINING EXPORT — the user's own corpus, folded into one sharegpt
 * dataset a LLaMA-Factory node can train from. Two sources, both local:
 * .lcl session transcripts and Claude Code memory notes. Wholly offline —
 * this module never requires the router or netTools and makes zero model
 * calls; a test pins that on the source.
 *
 * The fold teaches the HOUSE DIALECT: a gpt turn carries the ```tool fence
 * exactly as toolParse.js reads it, and the following human turn carries
 * `name: output` — the byte shape agent.js pushes into the model's context.
 * Session files do not persist call args (measured: zero '"args"' across the
 * whole store), so calls are RECONSTRUCTED from what did persist — staged
 * tool proposals, run_script proposals, and mutation change records. When no
 * call can be reconstructed the result is DROPPED, never exported as a
 * result-after-prose pair: agent.js documents that exact history shape as
 * teaching a model that results arrive unbidden.
 */

const safeList = (dir) => {
    try { return fs.readdirSync(dir); } catch { return []; }
};

/* ---------------------------------------------------- call reconstruction */

function recoverArgs(m) {
    const p = m.proposal;
    // a staged tool approval pins the exact call: {tool, args, digest, ...}
    if (p && p.args) return { tool: p.tool || m.name, args: p.args };
    // run_script proposals persist {script, language, purpose, rollback} with
    // no args envelope — the only proposal class the real store contains, and
    // those four fields ARE the text-protocol call (agent.js stages from them)
    if (p && typeof p.script === "string") {
        const args = { script: p.script };
        if (p.language) args.language = p.language;
        if (p.purpose) args.purpose = p.purpose;
        if (p.rollback) args.rollback = p.rollback;
        return { tool: "run_script", args };
    }
    // a mutation's change record at least names the target
    if (m.change && m.change.path) return { tool: m.name, args: { path: m.change.path } };
    return null;                                 // never fabricate {"args": {}}
}

/* -------------------------------------------------------- session folding */

const isAudit = (m) => !!(m.meta && (m.meta.audit || m.meta.clarifyAnswer
    || m.meta.model === "ancient-knowledge"
    // the post-check note is runtime-authored — a node model trained on the
    // export must never learn to speak in the gate's voice
    || m.meta.model === "post-check" || m.meta.postCheck));
const isSynthetic = (m) => !!(m.meta && (m.meta.compaction || m.meta.compacted
    || m.meta.failed || m.meta.emptyReply || m.meta.fabricated
    || m.meta.stoppedAtLimit || m.meta.guard || m.meta.planConfirm
    || m.meta.cancelled));

/**
 * Sessions → sharegpt records. Pure; redaction happens in runExport, over the
 * exact strings this emits. Drops audit bubbles, guard/plan-confirm/compaction
 * synthetics, failed tools, and call-less tool results, each counted so the
 * README can state the loss instead of hiding it.
 */
function convertSessions(list) {
    const records = [];
    const dropped = { failed: 0, audit: 0, synthetic: 0, noCall: 0, shortSession: 0 };
    for (const s of list || []) {
        const turns = [];
        const push = (from, value) => {
            const v = String(value == null ? "" : value);
            if (!v.trim()) return;
            const last = turns[turns.length - 1];
            if (last && last.from === from) last.value += "\n\n" + v;
            else turns.push({ from, value: v });
        };
        for (const m of (s.messages || [])) {
            if (!m || typeof m !== "object") continue;
            if (m.role === "user") {
                push("human", m.content);
            } else if (m.role === "assistant") {
                if (isAudit(m)) { dropped.audit++; continue; }
                if (isSynthetic(m)) { dropped.synthetic++; continue; }
                push("gpt", m.content);
            } else if (m.role === "tool") {
                if (m.failed) { dropped.failed++; continue; }
                if (m.meta && (m.meta.compacted || m.meta.compaction)) {
                    dropped.synthetic++; continue;
                }
                const call = recoverArgs(m);
                if (!call) { dropped.noCall++; continue; }
                push("gpt", "```tool\n"
                    + JSON.stringify({ tool: call.tool, args: call.args }) + "\n```");
                // the result, byte-shaped as the model sees it in-context
                push("human", `${m.name}: ${m.content}`);
            }
        }
        while (turns.length && turns[0].from !== "human") turns.shift();
        while (turns.length && turns[turns.length - 1].from !== "gpt") turns.pop();
        if (turns.length >= 2) {
            records.push({
                system: ".lcl session transcript",
                conversations: turns.map(t => ({ from: t.from, value: t.value }))
            });
        } else {
            dropped.shortSession++;
        }
    }
    return { records, dropped };
}

/* --------------------------------------------------------- memory folding */

/** The two-fence YAML head every real memory note carries. No YAML lib: the
 *  measured shape is flat `name:`/`description:` lines plus an indented
 *  `type:` under metadata, and that is all the export needs. */
function parseFrontmatter(text) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(String(text || ""));
    if (!m) return null;
    const head = m[1];
    const body = m[2].trim();
    const grab = (k) => {
        const r = new RegExp("^" + k + ":[ \\t]*(.*)$", "m").exec(head);
        return r ? r[1].trim() : "";
    };
    const unq = (v) => (v.startsWith("\"") && v.endsWith("\"") && v.length >= 2)
        ? v.slice(1, -1).split("\\\"").join("\"") : v;
    const type = (/^\s+type:[ \t]*(\w+)/m.exec(head) || [])[1] || "project";
    return { name: unq(grab("name")), description: unq(grab("description")), type, body };
}

function collectMemoryFiles(root) {
    const base = root || path.join(os.homedir(), ".claude", "projects");
    const out = [];
    for (const proj of safeList(base)) {
        const dir = path.join(base, proj, "memory");
        for (const f of safeList(dir)) {
            // MEMORY.md is the index, not a memory; a file with no frontmatter
            // is not a note either — excluded HERE so the consent dialog's
            // count is the count of what would actually export
            if (!f.endsWith(".md") || f === "MEMORY.md") continue;
            try {
                const text = fs.readFileSync(path.join(dir, f), "utf8");
                if (!parseFrontmatter(text)) continue;
                out.push({ path: path.join(dir, f), text });
            } catch { /* unreadable note: skipped, counted nowhere */ }
        }
    }
    return out;
}

function convertMemories(files) {
    const records = [];
    let skipped = 0;
    for (const f of files || []) {
        const fm = parseFrontmatter(f.text);
        if (!fm || !fm.body) { skipped++; continue; }
        records.push({
            system: `Operator memory: ${fm.name} [${fm.type}]`,
            conversations: [
                { from: "human",
                  value: `Operator memory (${fm.type}) — ${fm.description}\n\nState the full note.` },
                { from: "gpt", value: fm.body }
            ]
        });
    }
    return { records, skipped };
}

/* -------------------------------------------------------------- redaction */

/**
 * A LOCAL redactor — deliberately not secretGuard.remember()/redactKnown().
 * The remembered store is module state shared with the live agent in this
 * same process: feeding the whole historical corpus through remember() could
 * saturate MAX_REMEMBERED and silently disarm the egress gate for the rest
 * of the app run. The exporter holds the raw text, so it extracts values
 * locally, replaces them directly (every occurrence, longest first — stronger
 * than hash matching), then lets secretGuard.redact() catch shaped leftovers.
 * The count is replacements PERFORMED, never a scan for the placeholder,
 * which transcripts can already contain.
 */
function buildRedactor(corpus) {
    const sites = new Map();                 // value -> strings it was extracted from
    for (const s of corpus) {
        // extract broadly here (the prose-skip below is this module's own
        // name-vs-secret defence, so it wants the low floor the egress path
        // deliberately does not use)
        for (const v of secretGuard.extractSecrets(s, { minEntropy: 2.5 })) {
            sites.set(v, (sites.get(v) || 0) + 1);
        }
    }
    // A credential lives where it was extracted. A short, wordlike value that
    // reads as a secret on ONE line but recurs across many strings of prose
    // is a NAME (measured on the real corpus: a product name beside a
    // "...Key =" identifier, then masked 158 times; a hyphenated English word
    // under a "KEY:" table header, masked 5 times) — the toneMapping
    // corruption at dataset scale. Names skip value replacement; their
    // secret-SHAPED sites still die in the redact() pass below. The length
    // and entropy gates mean a real key — long, dense, unwordlike — can NEVER
    // be waved through as prose, however often it was pasted.
    const prose = new Set();
    for (const [v, n] of sites) {
        if (v.length >= 20 || securityTools.entropy(v) >= 4) continue;
        let inStrings = 0;
        for (const s of corpus) if (s.includes(v)) inStrings++;
        if (inStrings >= 4 && inStrings > 3 * n) prose.add(v);
    }
    const ordered = [...sites.keys()].filter(v => !prose.has(v))
        .sort((a, b) => b.length - a.length);
    let performed = 0;
    const clean = (text) => {
        let s = String(text == null ? "" : text);
        for (const v of ordered) {
            if (!s.includes(v)) continue;
            const parts = s.split(v);
            performed += parts.length - 1;
            s = parts.join("[redacted]");
        }
        const before = s.split("[redacted]").length - 1;
        s = secretGuard.redact(s);
        performed += (s.split("[redacted]").length - 1) - before;
        return s;
    };
    return { clean, registered: ordered.length, proseSkipped: prose.size,
             count: () => performed };
}

/* ------------------------------------------------------------ the export */

function loadSessions(sessionsDir) {
    const out = [];
    for (const name of safeList(sessionsDir)) {
        if (!name.endsWith(".json")) continue;
        try {
            const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, name), "utf8"));
            if (s && Array.isArray(s.messages)) out.push(s);
        } catch { /* corrupt file: not a session */ }
    }
    out.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    return out;
}

function readme(info) {
    const d = info.dropped;
    const lines = [
        "# .lcl training export",
        "",
        `Written ${info.at} into ${info.dir}.`,
        "",
        "## Sources",
        info.wantSessions
            ? `- .lcl session transcripts: ${info.sessionsDir} (${info.sessions} sessions scanned, ${info.sessionRecords} exported)`
            : "- .lcl session transcripts: not selected",
        info.wantMemory
            ? `- Claude Code memory notes: ${info.memoryRoot} (${info.memoryRecords} notes exported, ${info.memorySkipped} skipped as index or frontmatter-less)`
            : "- Claude Code memory notes: not selected",
        "",
        "## Records",
        `- ${info.records} records in dataset.json (${info.sessionRecords} session conversations, ${info.memoryRecords} memory pairs)`,
        "- dataset name: lcl_operator (dataset_info.json, sharegpt formatting)",
        "",
        "## Dropped, by reason",
        `- failed tool results: ${d.failed}`,
        `- audit bubbles (Ancient Knowledge, clarify answers): ${d.audit}`,
        `- synthetic turns (compaction, guard, plan-confirm, empty or failed replies): ${d.synthetic}`,
        `- tool results with no reconstructable call: ${d.noCall} (a result the model never visibly asked for teaches that results arrive unbidden, so these never ship)`,
        `- sessions too short to make one pair: ${d.shortSession}`,
        "",
        "## Redaction",
        `- ${info.redactions.sessions} redactions performed in session records`,
        `- ${info.redactions.memory} redactions performed in memory records`,
        `- ${info.registered} secret values registered from the export corpus itself`,
        `- ${info.proseSkipped} secret-shaped values left alone as prose (they recur across the corpus like names, not credentials; their shaped sites are still masked)`,
        "",
        "Redaction is pattern and registry based, not proven complete. Review",
        "dataset.json yourself before this folder leaves the machine.",
        "",
        "## Network",
        "This export made zero network calls and zero model calls. Nothing left",
        "this machine.",
        ""
    ];
    return lines.join("\n");
}

/**
 * The one entry point. PLAIN SYNCHRONOUS on purpose: main.js wraps it in
 * guard(), whose try/catch only holds for a function that throws rather than
 * rejects. probe:true answers the consent dialog — counts and paths, nothing
 * converted, nothing written. opts.memoryRoot exists so a test can aim the
 * memory scan at a fixture tree instead of the developer's real notes.
 */
function runExport(opts = {}) {
    const wantSessions = !!opts.sessions;
    const wantMemory = !!opts.memory;
    const memoryRoot = opts.memoryRoot || path.join(os.homedir(), ".claude", "projects");
    const sessionsDir = paths.sessionsDir();

    if (opts.probe) {
        return {
            ok: true, probe: true,
            counts: {
                sessions: safeList(sessionsDir).filter(n => n.endsWith(".json")).length,
                memoryFiles: collectMemoryFiles(memoryRoot).length
            },
            sessionsDir, memoryRoot
        };
    }

    const loaded = wantSessions ? loadSessions(sessionsDir) : [];
    const memFiles = wantMemory ? collectMemoryFiles(memoryRoot) : [];
    const sess = convertSessions(loaded);
    const mem = convertMemories(memFiles);

    // extract from the exact strings that will be emitted — post-fold, so a
    // secret inside a reconstructed fence is seen in its serialized form too
    const corpus = [];
    for (const r of [...sess.records, ...mem.records]) {
        corpus.push(r.system);
        for (const t of r.conversations) corpus.push(t.value);
    }
    const redactor = buildRedactor(corpus);
    const scrub = (recs) => recs.map(r => ({
        system: redactor.clean(r.system),
        conversations: r.conversations.map(t => ({ from: t.from, value: redactor.clean(t.value) }))
    }));
    const sessionRecords = scrub(sess.records);
    const afterSessions = redactor.count();
    const memoryRecords = scrub(mem.records);
    const all = [...sessionRecords, ...memoryRecords];

    const redactions = {
        sessions: afterSessions,
        memory: redactor.count() - afterSessions,
        total: redactor.count()
    };
    const counts = {
        sessions: loaded.length,
        memoryFiles: memFiles.length,
        sessionRecords: sessionRecords.length,
        memoryRecords: memoryRecords.length,
        records: all.length,
        memorySkipped: mem.skipped,
        dropped: sess.dropped,
        redactions
    };

    // a fresh dir every run — second-resolution stamps collide when two runs
    // land inside one second, so collisions get a numeric suffix, no clobber
    const base = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    let dir = path.join(paths.dataDir(), "training", base);
    for (let n = 2; fs.existsSync(dir); n++) {
        dir = path.join(paths.dataDir(), "training", `${base}-${n}`);
    }
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(path.join(dir, "dataset.json"),
        JSON.stringify(all, null, 1), "utf8");
    fs.writeFileSync(path.join(dir, "dataset_info.json"), JSON.stringify({
        lcl_operator: {
            file_name: "dataset.json",
            formatting: "sharegpt",
            columns: { messages: "conversations", system: "system" },
            tags: { role_tag: "from", content_tag: "value",
                    user_tag: "human", assistant_tag: "gpt" }
        }
    }, null, 2), "utf8");
    fs.writeFileSync(path.join(dir, "README.md"), readme({
        at: new Date().toISOString(), dir, sessionsDir, memoryRoot,
        wantSessions, wantMemory,
        sessions: counts.sessions, sessionRecords: counts.sessionRecords,
        memoryRecords: counts.memoryRecords, memorySkipped: counts.memorySkipped,
        records: counts.records, dropped: counts.dropped,
        redactions, registered: redactor.registered,
        proseSkipped: redactor.proseSkipped
    }), "utf8");

    return { ok: true, dir, counts, redactions: { count: redactions.total } };
}

module.exports = {
    convertSessions, convertMemories, collectMemoryFiles, parseFrontmatter,
    recoverArgs, runExport
};
