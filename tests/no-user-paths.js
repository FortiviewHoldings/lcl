/**
 * NO MACHINE-SPECIFIC USER PATH IS COMMITTED.
 *
 * .lcl is meant to live in a PUBLIC repo, and a hardcoded `C:\Users\<name>\…`
 * both breaks for everyone whose account is not <name> AND leaks whoever built
 * it. The standing rule: never hardcode a `C:\Users\<name>` path —
 * resolve it from the environment. This guard makes that enforceable across the tree
 * (dev scripts and Python helpers included, which no-bleed does not scan).
 *
 * It does NOT hardcode any real username — that would put the very thing it
 * guards against into a public file. Instead it rejects ANY absolute Users path
 * whose account segment is not one of the deliberate PLACEHOLDERS, so it catches
 * this operator's name and any future contributor's name alike.
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + String(detail).slice(0, 300) : ""); }
}

// generic, non-identifying account segments a public example may legitimately use
const PLACEHOLDERS = new Set([
    "you", "me", "user", "username", "yourname", "youruser", "default",
    "public", "x", "test", "example", "someone", "operator", "all users"
]);

// directories that are not source (fetched, generated, private, or vendored)
const SKIP_DIRS = new Set([
    "node_modules", ".git", ".claude", "data", "dist", "build", "out", "python",
    "models", "runtimes", "tools", "knowledge", ".vscode", ".idea"
]);
const TEXT_EXT = new Set([
    ".js", ".mjs", ".cjs", ".ts", ".json", ".md", ".py", ".html", ".css",
    ".ps1", ".txt", ".yaml", ".yml", ".sh", ".nsh", ".nsi"
]);

function walk(dir, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name) || e.name.startsWith("dist-runtime")) continue;
            walk(path.join(dir, e.name), out);
        } else if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
            out.push(path.join(dir, e.name));
        }
    }
    return out;
}

// a WINDOWS FILESYSTEM path into a user's home: a drive letter, then Users,
// slash(es), the account segment, then a slash. The drive-letter requirement is
// deliberate — it excludes web URLs like `host.edu/users/faculty/…`, which are
// citations, not machine paths. (JS string literals double the backslashes;
// `[\\/]+` matches one-or-more of either so `C:\\Users\\name` matches too.)
const USERS_PATH = /[A-Za-z]:[\\/]+Users[\\/]+([A-Za-z0-9._ -]+?)[\\/]/gi;

// THE MANGLED FORM. An escape-eating layer (sqlite's dot-command parser, a
// careless string round-trip) can swallow the separators — and sometimes the
// account's own first letter, when it forms an escape like \b — leaving
// `C:Users<residue>AppData`: no slashes for the regex above to anchor on, yet
// most of the account name still sitting in the account position. Caught once
// in a committed comment AFTER it had shipped public. The drive-colon prefix
// keeps prose and identifiers out; the trailing well-known home dir bounds the
// residue segment.
const USERS_MANGLED =
    /[A-Za-z]:[\\/]*Users([A-Za-z0-9._ -]{1,32}?)(?:AppData|Documents|Desktop|Downloads|OneDrive)/gi;

// the detector must actually catch the shape that shipped (synthetic residue —
// the real fragment must never be written into this file)
{
    USERS_MANGLED.lastIndex = 0;
    const hit = USERS_MANGLED.exec("path silently became \"C:UserssomeoneelseAppData\"");
    check("the mangled-path detector catches a separator-free Users<residue>AppData",
        !!hit && hit[1] === "someoneelse", hit && hit[1]);
    USERS_MANGLED.lastIndex = 0;
    const ok = USERS_MANGLED.exec("\"C:UsersyouAppData\"");
    check("...while a placeholder residue is allowed through",
        !!ok && PLACEHOLDERS.has(ok[1].trim().toLowerCase()), ok && ok[1]);
    USERS_MANGLED.lastIndex = 0;
}

const files = walk(ROOT);
check("the guard actually scanned the tree (not zero files)", files.length > 50, files.length);

const violations = [];
for (const f of files) {
    if (path.resolve(f) === path.resolve(__filename)) continue;   // never scan self
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    let m;
    USERS_PATH.lastIndex = 0;
    while ((m = USERS_PATH.exec(text))) {
        const account = m[1].trim().toLowerCase();
        if (!PLACEHOLDERS.has(account)) {
            violations.push(`${path.relative(ROOT, f)}: Users/${m[1]}/`);
        }
    }
    USERS_MANGLED.lastIndex = 0;
    while ((m = USERS_MANGLED.exec(text))) {
        const residue = m[1].trim().toLowerCase();
        if (!PLACEHOLDERS.has(residue)) {
            violations.push(`${path.relative(ROOT, f)}: mangled Users${m[1]}… (separator-eaten path residue)`);
        }
    }
}

check("NO committed file hardcodes a machine-specific Users path — every " +
      "absolute Users path uses a generic placeholder, so nothing leaks a real " +
      "account name into the public repo",
    violations.length === 0, violations.slice(0, 12).join(" | "));

console.log(`\n${pass}/${pass + fail} no-user-path checks passed`);
process.exit(fail ? 1 : 0);
