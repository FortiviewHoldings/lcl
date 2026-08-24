/**
 * Tool-call parsing for small local models.
 *
 * Small models reliably fail at embedding a multi-line document inside a JSON
 * string — they emit real newlines, which is invalid JSON. Two defences:
 *
 *  1. A sidecar `content` fence, so file bodies never need escaping at all:
 *
 *       ```tool
 *       {"tool": "write_file", "args": {"path": "readme.md"}}
 *       ```
 *       ```content
 *       ## Anything, with real newlines and "quotes"
 *       ```
 *
 *  2. A repair pass for models that still hand us raw JSON: escape literal
 *     control characters inside strings, drop trailing commas, and close a
 *     string/braces left unterminated by hitting the token cap.
 */

// Models routinely label the block ```json rather than ```tool — the content is
// a correct call either way, so accept both. The tool NAME is still validated
// against knownTools, so a json block that is not a call cannot become one.
// The lang is CAPTURED because the two labels do not earn equal trust: bare
// args (no {"tool": ...} envelope) may be inferred only from a ```tool fence —
// review reproduced a ```json documentation example {"from": ..., "to": ...}
// being inferred into a real move_file execution.
const TOOL_BLOCK_RE = /```[ \t]*(tool|json)[ \t]*\r?\n([\s\S]*?)```/gi;
const CONTENT_BLOCK_RE = /```[ \t]*content[ \t]*\r?\n([\s\S]*?)```/i;
// an unterminated trailing fence (model ran out of tokens mid-block)
const OPEN_CONTENT_RE = /```[ \t]*content[ \t]*\r?\n([\s\S]*)$/i;

/**
 * Escape raw control characters that appear INSIDE JSON string literals.
 * Walks the text tracking whether we are inside a string, so structural
 * whitespace between tokens is left alone.
 */
function escapeControlCharsInStrings(src) {
    let out = "";
    let inString = false;
    let escaped = false;

    for (const ch of src) {
        if (escaped) {
            out += ch;
            escaped = false;
            continue;
        }
        if (ch === "\\") {
            out += ch;
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            out += ch;
            continue;
        }
        if (inString) {
            if (ch === "\n") { out += "\\n"; continue; }
            if (ch === "\r") { out += "\\r"; continue; }
            if (ch === "\t") { out += "\\t"; continue; }
            if (ch < " ") { continue; } // drop other control chars
        }
        out += ch;
    }

    return { text: out, unterminatedString: inString };
}

function stripTrailingCommas(src) {
    return src.replace(/,(\s*[}\]])/g, "$1");
}

/** Close a JSON value truncated by the token cap. */
function closeTruncated(src, unterminatedString) {
    let text = src;
    if (unterminatedString) text += '"';

    let depthCurly = 0;
    let depthSquare = 0;
    let inString = false;
    let escaped = false;

    for (const ch of text) {
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === "{") depthCurly++;
        else if (ch === "}") depthCurly--;
        else if (ch === "[") depthSquare++;
        else if (ch === "]") depthSquare--;
    }

    return text + "]".repeat(Math.max(0, depthSquare)) + "}".repeat(Math.max(0, depthCurly));
}

/**
 * Parse a tool block body, repairing common small-model mistakes.
 * Returns { value } or { error, repaired }.
 */
function parseToolJson(raw) {
    const body = raw.trim();

    // 1. strict
    try {
        return { value: JSON.parse(body), repaired: false };
    } catch { /* fall through to repair */ }

    // 2. escape literal control chars inside strings + drop trailing commas
    const escapedPass = escapeControlCharsInStrings(body);

    try {
        return {
            value: JSON.parse(stripTrailingCommas(escapedPass.text)),
            repaired: true,
            closedUnterminated: false
        };
    } catch { /* fall through */ }

    try {
        return {
            value: JSON.parse(stripTrailingCommas(
                closeTruncated(escapedPass.text, escapedPass.unterminatedString))),
            repaired: true,
            // Flag it: closing a string the model never closed means the block
            // was cut short, so whatever delimiter we trusted is unreliable.
            closedUnterminated: escapedPass.unterminatedString
        };
    } catch { /* fall through */ }

    // 3. last resort: pull the first {...} span and repair that
    const first = body.indexOf("{");
    if (first !== -1) {
        const slice = escapeControlCharsInStrings(body.slice(first));
        try {
            return {
                value: JSON.parse(stripTrailingCommas(closeTruncated(slice.text, slice.unterminatedString))),
                repaired: true
            };
        } catch { /* give up */ }
    }

    return { error: "tool block was not valid JSON, and repair failed" };
}

/**
 * Structural extraction — the last resort when JSON.parse and repair both fail.
 *
 * Real observed failures from Qwen2.5-Coder that strict JSON cannot survive:
 *   - the file content contains its own ``` fence, truncating the tool block
 *   - the content quotes the tool help verbatim, so it carries unescaped "
 *   - the content string is simply never closed
 *
 * All three are recoverable because the SHAPE is known: we want tool, path and
 * content, and content is always the final field. So pull the scalars by name
 * and treat everything from `"content":"` to the closing quote-brace as the
 * body, however ugly the middle is.
 */
function looseExtract(text, knownTools) {
    const toolMatch = /"tool"\s*:\s*"([A-Za-z_][\w]*)"/.exec(text);
    if (!toolMatch) return null;

    const tool = toolMatch[1];
    if (knownTools.length && !knownTools.includes(tool)) return null;

    const args = {};

    const pathMatch = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    if (pathMatch) args.path = unescapeJsonish(pathMatch[1]);

    const queryMatch = /"query"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    if (queryMatch) args.query = unescapeJsonish(queryMatch[1]);

    const offsetMatch = /"offset"\s*:\s*(\d+)/.exec(text);
    if (offsetMatch) args.offset = Number(offsetMatch[1]);

    const contentKey = /"content"\s*:\s*"/.exec(text);
    if (contentKey) {
        const start = contentKey.index + contentKey[0].length;
        const rest = text.slice(start);

        // The body ends at the LAST quote followed only by structural leftovers
        // — closing braces/brackets, a stray paren the model added, fence
        // backticks, whitespace. Scanning from the end matters: content
        // legitimately contains quotes, so the first candidate is usually wrong.
        let end = -1;
        for (let i = rest.length - 1; i >= 0; i--) {
            if (rest[i] !== '"') continue;
            if (/^[\s}\])`]*$/.test(rest.slice(i + 1))) { end = i; break; }
        }
        if (end === -1) {
            // never closed: take everything, minus a dangling fence if present
            end = rest.length;
            const fence = rest.lastIndexOf("```");
            if (fence !== -1 && fence >= rest.length - 4) end = fence;
        }
        args.content = unescapeJsonish(rest.slice(0, end));
    }

    return { tool, args };
}

/**
 * Infer the tool when the model emitted the ARGS with no envelope — i.e.
 * `{"script": ..., "rollback": ...}` instead of `{"tool":"run_script","args":{...}}`.
 *
 * Observed repeatedly: tool help of the form `run_script {"purpose": ...}` reads
 * like the whole body, so the model copies that shape.
 *
 * Only fires when a key is UNIQUE to one tool. Tools sharing a key (read_file
 * and list_files both take `path`) are left ambiguous and rejected, because a
 * wrong guess would run the wrong operation.
 */
const UNIQUE_ARG_TO_TOOL = {
    script: "run_script",     // no other tool takes a script
    content: "write_file",    // only write_file writes a body
    // "query" was here until semantic_search arrived — with two query-taking
    // tools the inference would silently pick the wrong one, so bare {query}
    // is no longer inferred at all
    replace: "edit_file",     // only edit_file replaces text in place
    from: "move_file",        // only move_file takes from/to
    op: "media_transform"     // only media_transform names an operation
};

function inferToolFromArgs(obj, knownTools) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    if (typeof obj.tool === "string") return null;      // already has an envelope

    const hits = new Set();
    for (const [key, tool] of Object.entries(UNIQUE_ARG_TO_TOOL)) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) hits.add(tool);
    }
    if (hits.size !== 1) return null;                   // ambiguous or nothing

    const tool = [...hits][0];
    if (knownTools.length && !knownTools.includes(tool)) return null;

    const { tool: _drop, args: _drop2, ...rest } = obj;
    return { tool, args: rest };
}

/** Apply JSON string escapes without requiring the whole document to be valid. */
function unescapeJsonish(s) {
    return String(s).replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, esc) => {
        switch (esc[0]) {
            case "n": return "\n";
            case "t": return "\t";
            case "r": return "\r";
            case "b": return "\b";
            case "f": return "\f";
            case '"': return '"';
            case "\\": return "\\";
            case "/": return "/";
            case "u": return String.fromCharCode(parseInt(esc.slice(1), 16));
            default: return esc;
        }
    });
}

/**
 * Extract a tool call from model output.
 * Returns { cleaned, call } where call is null when no tool was requested.
 * call = { tool, args, repaired, truncated } or { parseError }.
 */
/**
 * Small models frequently emit the tool JSON with no ```tool fence at all.
 * Recover those: scan for a balanced {...} span that parses (after repair) and
 * names a KNOWN tool. Requiring a known tool name is what keeps this from
 * hijacking ordinary JSON the user happened to ask about.
 */
function extractBareToolCall(text, knownTools) {
    const starts = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "{") starts.push(i);
    }

    // prefer the LAST candidate: models tend to trail the call after prose
    for (let s = starts.length - 1; s >= 0; s--) {
        const start = starts[s];
        let depth = 0, inString = false, escaped = false, end = -1;

        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (escaped) { escaped = false; continue; }
            if (ch === "\\") { escaped = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === "{") depth++;
            else if (ch === "}") {
                depth--;
                if (depth === 0) { end = i + 1; break; }
            }
        }
        if (end === -1) continue;

        const span = text.slice(start, end);
        if (!/"tool"\s*:/.test(span)) continue;

        const parsed = parseToolJson(span);
        if (parsed.error || !parsed.value || typeof parsed.value !== "object") continue;
        if (!knownTools.includes(parsed.value.tool)) continue;

        return {
            value: parsed.value,
            repaired: !!parsed.repaired,
            start,
            end
        };
    }
    return null;
}

/**
 * Rescue the "name-prefixed" shape a small model emits under low temperature:
 *     edit_file {"path": "notes.md", "find": "a", "replace": "b"}
 * — the right call, correct args, no fence and no {"tool": ...} envelope.
 * Observed live; without this pass a perfect edit was displayed as prose.
 */
/** Character spans covered by ``` fences — content there is DISPLAY, not calls. */
function fencedSpans(text) {
    const spans = [];
    const re = /```/g;
    let open = -1;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (open === -1) open = m.index;
        else { spans.push([open, m.index + 3]); open = -1; }
    }
    if (open !== -1) spans.push([open, text.length]);   // unclosed fence
    return spans;
}

function extractNamePrefixedCall(text, knownTools) {
    if (!knownTools.length) return null;
    // Anything inside a code fence is the model SHOWING something — review
    // reproduced a fenced move_file documentation example being executed.
    const fences = fencedSpans(text);
    const inFence = (pos) => fences.some(([a, b]) => pos >= a && pos < b);
    const nameRe = new RegExp(
        "(?:^|\\n)\\s*(" + knownTools.filter(t => /^[\w-]+$/.test(t)).join("|") + ")\\s*:?\\s*(\\{)", "g");
    let m;
    let best = null;
    while ((m = nameRe.exec(text)) !== null) {
        if (inFence(m.index + m[0].length - 1)) continue;
        const braceStart = m.index + m[0].length - 1;
        // walk the braces to find the object's end (strings respected loosely)
        let depth = 0, inStr = false, esc = false, end = -1;
        for (let i = braceStart; i < text.length; i++) {
            const c = text[i];
            if (esc) { esc = false; continue; }
            if (c === "\\") { esc = true; continue; }
            if (c === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (c === "{") depth++;
            else if (c === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        if (end === -1) continue;
        const parsed = parseToolJson(text.slice(braceStart, end));
        if (parsed && parsed.value && typeof parsed.value === "object"
            // an envelope inside ({"tool": ...}) belongs to the bare-call path
            && typeof parsed.value.tool !== "string") {
            best = {
                tool: m[1],
                args: parsed.value,
                start: m.index,
                end,
                repaired: !!parsed.repaired
            };
        }
        // always continue AFTER the object — re-scanning inside it could match
        // tool-like keys within nested structures
        nameRe.lastIndex = end;
    }
    return best;      // last one wins, same convention as the fenced path
}

function extractToolCall(text, knownTools = []) {
    const matches = [...text.matchAll(TOOL_BLOCK_RE)];

    if (!matches.length) {
        // no fence — try to rescue an unfenced call before giving up
        let bare = knownTools.length ? extractBareToolCall(text, knownTools) : null;
        if (!bare) {
            const prefixed = extractNamePrefixedCall(text, knownTools);
            if (prefixed) {
                bare = {
                    value: { tool: prefixed.tool, args: prefixed.args },
                    start: prefixed.start,
                    end: prefixed.end,
                    repaired: prefixed.repaired
                };
            }
        }
        if (!bare) return { cleaned: text.trim(), call: null };

        const rest = text.slice(0, bare.start) + text.slice(bare.end);
        const sidecarMatch = CONTENT_BLOCK_RE.exec(rest);
        const args = (bare.value.args && typeof bare.value.args === "object"
            && !Array.isArray(bare.value.args)) ? { ...bare.value.args } : {};

        let cleaned = rest;
        if (sidecarMatch) {
            args.content = sidecarMatch[1].replace(/\r?\n$/, "");
            cleaned = rest.slice(0, sidecarMatch.index) +
                      rest.slice(sidecarMatch.index + sidecarMatch[0].length);
        }

        return {
            cleaned: cleaned.trim(),
            call: {
                tool: bare.value.tool,
                args,
                repaired: bare.repaired,
                unfenced: true,
                truncated: false
            }
        };
    }

    const m = matches[matches.length - 1];
    // everything after the tool block may hold a sidecar content fence
    const tail = text.slice(m.index + m[0].length);
    const head = text.slice(0, m.index);

    let sidecar = null;
    let truncated = false;
    const closed = CONTENT_BLOCK_RE.exec(tail);
    if (closed) {
        sidecar = closed[1];
    } else {
        const open = OPEN_CONTENT_RE.exec(tail);
        if (open) {
            sidecar = open[1];
            truncated = true; // fence never closed: model hit the token cap
        }
    }

    // strip the content fence out of the visible reply
    let cleanedTail = tail;
    if (closed) cleanedTail = tail.slice(0, closed.index) + tail.slice(closed.index + closed[0].length);
    else if (truncated) cleanedTail = tail.slice(0, OPEN_CONTENT_RE.exec(tail).index);

    const cleaned = (head + cleanedTail).trim();

    const fenceLang = (m[1] || "tool").toLowerCase();
    const parsed = parseToolJson(m[2]);
    if (parsed.error) {
        // The fence may have been cut short by a ``` inside the file content,
        // so retry structurally from the fence to the END of the reply rather
        // than trusting the fence to mark the boundary.
        const wide = text.slice(m.index);
        const loose = looseExtract(wide, knownTools);
        if (loose) {
            return {
                cleaned: head.trim(),
                call: {
                    tool: loose.tool,
                    args: loose.args,
                    repaired: true,
                    recovered: true,
                    truncated: false
                }
            };
        }
        return { cleaned, call: { parseError: parsed.error, raw: m[2].trim().slice(0, 300) } };
    }

    let value = parsed.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { cleaned, call: { parseError: "tool block was not a JSON object" } };
    }

    // Bare args (no envelope) are only ever INFERRED from an explicit ```tool
    // fence. A ```json fence is how the model shows the user JSON — inferring
    // from it turned a documentation example {"from": ...} into a real move.
    const inferred = fenceLang === "tool" ? inferToolFromArgs(value, knownTools) : null;
    if (inferred) value = inferred;

    // Now that ```json blocks are accepted, a block naming something that is not
    // a real tool is far more likely to be the model SHOWING the user some JSON
    // than asking for a call. Treat it as prose rather than a failed tool call.
    if (knownTools.length && !knownTools.includes(value.tool)) {
        return { cleaned: text.trim(), call: null };
    }

    // A closing fence INSIDE the file content truncates the tool block, and the
    // repair pass then happily closes the severed string — producing valid JSON
    // holding a partial file. When that happened, re-extract across the whole
    // reply and keep whichever body is longer.
    let recovered = false;
    if (parsed.closedUnterminated) {
        const loose = looseExtract(text.slice(m.index), knownTools);
        const looseLen = loose?.args?.content ? loose.args.content.length : 0;
        const strictLen = typeof value?.args?.content === "string" ? value.args.content.length : 0;
        if (loose && looseLen > strictLen) {
            value = { tool: loose.tool, args: loose.args };
            recovered = true;
        }
    }

    const args = (value.args && typeof value.args === "object" && !Array.isArray(value.args))
        ? { ...value.args }
        : {};

    // sidecar wins: it is the escaping-free path and cannot be corrupted
    if (sidecar !== null) {
        args.content = sidecar.replace(/\r?\n$/, "");
    }

    return {
        cleaned,
        call: {
            tool: value.tool,
            args,
            repaired: !!parsed.repaired,
            recovered,
            truncated
        }
    };
}

/**
 * Remove tool-call ECHOES from a reply that is about to be DISPLAYED.
 *
 * After a tool runs, models often repeat the call in their recap — sometimes in
 * a malformed fence (```\ntool\n{...}), sometimes as bare JSON mid-sentence.
 * extractToolCall rightly declines to EXECUTE those, but they then leak into
 * the transcript as raw JSON next to the green action card that already shows
 * what ran. This strips them from the visible copy only; the model-facing
 * transcript keeps the raw text.
 *
 * Whole lines are dropped: a lead-in on the same line ("run this: {...}") is
 * dangling once the JSON goes, so it goes too.
 */
const ECHO_LABEL_RE = /^\s*(?:`{3,}\s*(?:tool|json)|tool|json)\s*$/i;
const BARE_FENCE_RE = /^\s*`{3,}\s*$/;
// The model quoting its own call as a STRING: {\"tool\": ...}. It never parses
// as JSON, so span detection cannot see it — and it is exactly what leaked
// into the transcript as \" soup. Built per-call so it only ever matches KNOWN
// tool names, and applied fence-aware — review showed the bare version eating
// lines of the user's own code (e.g. asking about JSON-escaping examples).
function escapedEchoRe(knownTools) {
    const names = knownTools.filter(t => /^[\w-]+$/.test(t)).join("|");
    if (!names) return null;
    return new RegExp('\\{\\s*\\\\"tool\\\\"\\s*:\\s*\\\\"(?:' + names + ')\\\\"');
}

/** Fence parity per line: 0 = prose level, 1 = inside a fenced code block. */
function fenceParity(lines) {
    const par = [];
    let count = 0;
    for (const l of lines) {
        par.push(count % 2);
        if (/^\s*`{3,}/.test(l)) count++;
    }
    return par;
}

// Documentation-speak around an echo: "For creating the file, issue the
// following command:" above, "This will generate the file…" below. Deliberately
// narrow openers so real prose is never eaten.
const NARRATION_RE = /^\s*(?:this (?:will|command)|this generates?|for creating|to (?:create|generate|write) (?:the|this|it)|issue the following|run the following|use the following|the following (?:command|json|block)|executing this)/i;
// A trailing narration line must ALSO name an artifact to be dropped —
// "This will generate the readme.md file" goes; "This will make deploys
// faster" (a real conclusion) stays.
const NARRATION_ARTIFACT_RE = /file|command|json|tool|director(?:y|ies)|folder|script|`/i;

/**
 * Drop a trailing narration caption ("This will generate the file…").
 * Bounded on purpose: at most 3 narration lines, each must reference an
 * artifact, and the reply is never reduced to nothing — review showed the
 * unbounded version deleting legitimate closing sentences and, in the
 * degenerate case, entire replies.
 */
function stripTrailingNarration(text) {
    const lines = text.split("\n");
    let end = lines.length;
    let dropped = 0;
    while (end > 0 && dropped < 3) {
        const l = lines[end - 1];
        if (!l.trim()) { end--; continue; }
        if (NARRATION_RE.test(l) && NARRATION_ARTIFACT_RE.test(l)) { end--; dropped++; continue; }
        break;
    }
    if (!dropped || end === lines.length) return text;
    const out = lines.slice(0, end).join("\n").trimEnd();
    return out || text;
}

/** Remove UNFENCED name-prefixed echoes (edit_file {...}) from display copy. */
function scrubNamePrefixed(text, knownTools) {
    let out = text;
    for (let guard = 0; guard < 8; guard++) {
        const hit = extractNamePrefixedCall(out, knownTools);
        if (!hit) break;
        out = (out.slice(0, hit.start) + "\n" + out.slice(hit.end))
            .replace(/\n{3,}/g, "\n\n");
    }
    return out.trim();
}

function scrubToolEchoes(text, knownTools = [], opts = {}) {
    if (!text || !knownTools.length) return text;
    // \"tool\": (escaped echo) must pass this gate too — the escaped form was
    // invisible to the old '"tool":' test and leaked to the user verbatim.
    // Name-prefixed echoes (edit_file {...}) have no "tool" key at all, so
    // they get their own pass before the gate can early-return.
    text = scrubNamePrefixed(text, knownTools);
    if (!/\\?"tool\\?"\s*:/.test(text)) {
        return opts.afterTool ? stripTrailingNarration(text) : text;
    }

    // Collect every bare {"tool": ...} span. extractBareToolCall returns the
    // last one, so blank each find and go again.
    let probe = text;
    const spans = [];
    for (;;) {
        const bare = extractBareToolCall(probe, knownTools);
        if (!bare) break;
        spans.push([bare.start, bare.end]);
        probe = probe.slice(0, bare.start)
            + " ".repeat(bare.end - bare.start)
            + probe.slice(bare.end);
    }
    if (!spans.length) {
        // no parseable echo, but escaped echoes and narration may remain
        let out = text;
        const esc = escapedEchoRe(knownTools);
        if (esc && esc.test(out)) {
            const ls = out.split("\n");
            const par = fenceParity(ls);
            // fence-aware: an escaped echo inside a code block is content the
            // user is looking at, not a leak
            out = ls.filter((l, i) => !(par[i] === 0 && esc.test(l))).join("\n")
                .replace(/\n{3,}/g, "\n\n").trim();
        }
        return opts.afterTool ? stripTrailingNarration(out) : out;
    }

    const lineStart = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n") lineStart.push(i + 1);
    }
    const lineOf = (pos) => {
        let lo = 0, hi = lineStart.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStart[mid] <= pos) lo = mid; else hi = mid - 1;
        }
        return lo;
    };

    const lines = text.split("\n");
    // Fence parity decides whether a lone ``` next to an echo belongs to the
    // echo or to a legitimate code block beside it: an even count of fence
    // lines above means it OPENS a block (the echo's own fence — safe to eat);
    // odd means it CLOSES an earlier real block and must stay.
    const fenceLine = (l) => /^\s*`{3,}/.test(l);
    const fencesAbove = [];
    let count = 0;
    for (const l of lines) {
        fencesAbove.push(count);
        if (fenceLine(l)) count++;
    }
    // An odd TOTAL means one fence in the reply is unmatched. When that
    // orphan sits right next to an echo it is the echo's mangled half-fence
    // (the observed failure: a bare "tool" label above, a lone ``` below).
    const hasOrphanFence = count % 2 === 1;

    const drop = new Array(lines.length).fill(false);
    for (const [s, e] of spans) {
        const a = lineOf(s), b = lineOf(Math.max(s, e - 1));
        for (let i = a; i <= b; i++) drop[i] = true;
        for (let i = a - 1; i >= 0; i--) {
            if (ECHO_LABEL_RE.test(lines[i])) { drop[i] = true; continue; }
            // "For creating the file, issue the following command:" directly
            // above an echo is the echo's lead-in, not content
            if (NARRATION_RE.test(lines[i])) { drop[i] = true; continue; }
            if (BARE_FENCE_RE.test(lines[i]) && fencesAbove[i] % 2 === 0) { drop[i] = true; continue; }
            break;
        }
        for (let i = b + 1; i < lines.length; i++) {
            if (ECHO_LABEL_RE.test(lines[i])) { drop[i] = true; continue; }
            // "This will generate the file…" directly below is its caption
            if (NARRATION_RE.test(lines[i])) { drop[i] = true; continue; }
            if (BARE_FENCE_RE.test(lines[i])
                && (fencesAbove[i] % 2 === 1 || hasOrphanFence)) { drop[i] = true; continue; }
            break;
        }
    }

    const esc = escapedEchoRe(knownTools);
    let out = lines.filter((l, i) =>
        !drop[i] && !(esc && fencesAbove[i] % 2 === 0 && esc.test(l)))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n").trim();
    if (opts.afterTool) out = stripTrailingNarration(out);
    return out;
}

module.exports = {
    extractToolCall, parseToolJson, escapeControlCharsInStrings,
    extractBareToolCall, looseExtract, inferToolFromArgs, scrubToolEchoes
};
