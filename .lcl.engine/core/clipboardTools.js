const { ToolError } = require("./fsTools");

/**
 * Clipboard bridge — the most-used path between .lcl and the rest of the
 * desktop ("summarise what I copied", "put that in my clipboard").
 *
 * The Electron clipboard module lives in the main process, which is where the
 * agent loop runs, so these load it lazily (require at call time keeps this
 * module usable from unit tests and from any non-Electron context).
 *
 * read is sys.read; write is sys.write (NOTIFY) — writing the clipboard is a
 * visible side effect the user can inspect and clear, but it leaves the app's
 * sandbox, so the policy kernel records it.
 */

const MAX_WRITE_CHARS = 100_000;
const MAX_READ_CHARS = 20_000;

function clip() {
    try { return require("electron").clipboard; }
    catch { throw new ToolError("clipboard is only available inside the app"); }
}

function readClipboard() {
    const text = clip().readText() || "";
    const shown = text.slice(0, MAX_READ_CHARS);
    // READ EVERYTHING, LEAK NOTHING — the same contract as fsTools.readFile.
    // The clipboard is the likeliest place on this machine for a live secret to
    // be sitting: people copy a password out of a manager, a token out of a
    // portal, a connection string out of a config. This was the ONLY automatic
    // ingestion path that never registered with the egress guard, so a copied
    // API key entered the transcript as ordinary text and the tripwire that
    // blocks secrets from leaving in a URL or request body had never seen it.
    // Register the FULL text, not the truncated view: a key past the cap is
    // still a key.
    let secrets = 0;
    try {
        const g = require("./secretGuard");
        secrets = g.remember(text, "clipboard").added;
        // a clipboard holding one bare high-entropy token has no recognisable
        // shape for remember() to match — register short single-token content
        // wholesale, the way a .key file is registered
        if (!secrets && text.trim() && !/\s/.test(text.trim()) && text.trim().length <= 200) {
            secrets = g.rememberValue(text, "clipboard").added;
        }
    } catch { /* the guard must never break a read */ }
    return {
        text: shown,
        chars: text.length,
        truncated: text.length > MAX_READ_CHARS,
        empty: text.length === 0,
        // surfaced so the transcript says so out loud when it happened
        secretsRegistered: secrets
    };
}

function writeClipboard(_root, { text } = {}) {
    if (typeof text !== "string") {
        throw new ToolError('write_clipboard needs {"text": "what to copy"}');
    }
    if (text.length > MAX_WRITE_CHARS) {
        throw new ToolError(`text exceeds the ${MAX_WRITE_CHARS}-character clipboard cap`);
    }
    clip().writeText(text);
    return { copied: true, chars: text.length };
}

const READ_ENTRY = {
    run: () => readClipboard(),
    help: 'read_clipboard {} — read the text currently on the system clipboard'
};
const WRITE_ENTRY = {
    run: writeClipboard,
    help: 'write_clipboard {"text": "..."} — put text on the system clipboard'
};

module.exports = { readClipboard, writeClipboard, READ_ENTRY, WRITE_ENTRY };
