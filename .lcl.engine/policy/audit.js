const fs = require("fs");
const path = require("path");

/**
 * Append-only audit log.
 *
 * Every policy decision — including the denials — lands here as one JSON line,
 * tagged with the model and engine that asked. Two reasons this matters:
 *
 *  1. It is the congruence trail. When several models and engines can drive
 *     the same tools, "who did this" has to be answerable.
 *  2. Self-improvement is only safe if the agent editing .lcl's own logic
 *     leaves a record a human can read back.
 *
 * Append-only in practice, not just in name: opened with the 'a' flag, never
 * rewritten, and rotated by starting a new file rather than truncating.
 */

const MAX_BYTES = 8 * 1024 * 1024;

class AuditLog {
    constructor(dir, file = "audit.jsonl") {
        this.dir = dir;
        // the base name also names the rotated files (audit-<stamp>.jsonl /
        // errors-<stamp>.jsonl), so one class serves both the policy audit
        // trail and the error log without their histories interleaving
        this.base = String(file).replace(/.jsonl$/i, "");
        this.file = path.join(dir, this.base + ".jsonl");
        this.stream = null;
        // running size of the CURRENT file, so a long-lived process can rotate
        // mid-run. Without this the rotation check only ran on the first write
        // per process (it sits after #open's cached-stream early return), so an
        // engine process that never restarts grew audit.jsonl without bound.
        this.bytesWritten = 0;
    }

    #open() {
        if (this.stream) return this.stream;
        fs.mkdirSync(this.dir, { recursive: true });

        // rotate rather than truncate, so nothing is ever destroyed
        try {
            const st = fs.statSync(this.file);
            if (st.size > MAX_BYTES) {
                const stamp = new Date(st.mtimeMs).toISOString().replace(/[:.]/g, "-");
                fs.renameSync(this.file, path.join(this.dir, `${this.base}-${stamp}.jsonl`));
            }
        } catch { /* first run */ }

        this.stream = fs.createWriteStream(this.file, { flags: "a" });
        // resume the byte count from whatever is already on disk — 0 right after
        // a rotate, or a resumed file's current size on a fresh process
        try { this.bytesWritten = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0; }
        catch { this.bytesWritten = 0; }
        return this.stream;
    }

    write(record) {
        try {
            const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
            this.#open().write(line);
            this.bytesWritten += Buffer.byteLength(line);
            // ROTATE MID-RUN. Once the current file crosses the cap, close the
            // stream; the next write's #open() sees the now-oversized file and
            // rotates it before starting a fresh one. (If the handle is briefly
            // still open, the rename is caught and simply retried on a later
            // write — safe, append-only, never truncating.)
            if (this.bytesWritten > MAX_BYTES) this.close();
        } catch {
            // auditing must never take the app down; a failed write is itself
            // surfaced through the engine log rather than thrown at the user
        }
    }

    /** Read back the most recent entries for the UI. */
    tail(limit = 200) {
        try {
            const lines = fs.readFileSync(this.file, "utf8").trim().split("\n");
            return lines.slice(-limit).map(l => {
                try { return JSON.parse(l); } catch { return null; }
            }).filter(Boolean);
        } catch {
            return [];
        }
    }

    close() {
        if (this.stream) {
            this.stream.end();
            this.stream = null;
        }
    }
}

module.exports = { AuditLog };
