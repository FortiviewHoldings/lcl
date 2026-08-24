const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const paths = require("./paths");
const { resolveInRoot } = require("./fsTools");

/**
 * Snapshot files before the agent overwrites them, so a write can be reverted.
 *
 * Backups live outside the workspace (under the app's data dir) so reverting
 * never depends on files inside a folder the agent can also modify.
 */

const MAX_BACKUP_BYTES = 2_000_000;

function backupDir(sessionId) {
    const dir = path.join(paths.dataDir(), "backups", String(sessionId).replace(/[^0-9a-f-]/gi, ""));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Copy the current contents of relPath aside. Returns a backup id, or null if
 * the file does not exist yet (nothing to restore) or is too large.
 */
function snapshot(sessionId, root, relPath) {
    let full;
    try {
        full = resolveInRoot(root, relPath);
    } catch {
        return null;
    }

    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    if (fs.statSync(full).size > MAX_BACKUP_BYTES) return null;

    const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    try {
        fs.copyFileSync(full, path.join(backupDir(sessionId), id));
        return id;
    } catch {
        return null;
    }
}

/**
 * Undo a recorded change.
 *  - created  → delete the file the agent made
 *  - modified → restore the snapshot taken before the overwrite
 *  - deleted  → restore the snapshot taken before the delete (falls through
 *               to the snapshot branch below)
 *  - moved    → move the file back where it was
 */
function revert(sessionId, root, change) {
    if (!change || !change.path) return { ok: false, error: "nothing to revert" };

    let full;
    try {
        full = resolveInRoot(root, change.path);
    } catch (err) {
        return { ok: false, error: String(err.message || err) };
    }

    if (change.kind === "moved") {
        let back;
        try {
            back = resolveInRoot(root, change.from);
        } catch (err) {
            return { ok: false, error: String(err.message || err) };
        }
        if (fs.existsSync(back)) return { ok: false, error: `something now exists at ${change.from}` };
        try {
            fs.mkdirSync(path.dirname(back), { recursive: true });
            if (fs.existsSync(full)) {
                fs.renameSync(full, back);
                return { ok: true, action: "moved back", path: change.from };
            }
            // the moved file is gone — fall back to the pre-move snapshot, the
            // reason the move path takes one at all
            if (change.backupId) {
                const snap = path.join(backupDir(sessionId), change.backupId);
                if (fs.existsSync(snap)) {
                    fs.copyFileSync(snap, back);
                    return { ok: true, action: "restored from backup", path: change.from };
                }
            }
            return { ok: false, error: "the moved file is no longer there and no snapshot survives" };
        } catch (err) {
            return { ok: false, error: String(err.message || err) };
        }
    }

    if (change.kind === "created") {
        if (!fs.existsSync(full)) return { ok: false, error: "file is already gone" };
        try {
            fs.unlinkSync(full);
            return { ok: true, action: "deleted", path: change.path };
        } catch (err) {
            return { ok: false, error: String(err.message || err) };
        }
    }

    if (!change.backupId) {
        return { ok: false, error: "no snapshot was taken for this change" };
    }

    const backup = path.join(backupDir(sessionId), change.backupId);
    if (!fs.existsSync(backup)) return { ok: false, error: "snapshot is no longer available" };

    try {
        fs.copyFileSync(backup, full);
        return { ok: true, action: "restored", path: change.path };
    } catch (err) {
        return { ok: false, error: String(err.message || err) };
    }
}

function purge(sessionId) {
    try {
        fs.rmSync(backupDir(sessionId), { recursive: true, force: true });
    } catch { /* nothing to clean */ }
}

module.exports = { snapshot, revert, purge };
