const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
    ToolError, resolveInRoot, realpathOrNull, walk, isProbablyBinary
} = require("./fsTools");

/**
 * Defensive security tools — fully local, read-only, workspace-scoped.
 *
 * These are the "safe to grant on a linked folder" tier (sec.defensive in the
 * policy table). Every one only READS files inside the workspace, using the
 * same junction-safe containment as the file tools, and reports findings. None
 * modifies anything or reaches the network.
 */

const MAX_SCAN_BYTES = 512_000;      // skip files bigger than this per-file
const MAX_FILES = 2000;
const MAX_FINDINGS = 200;

/* --------------------------------------------------------------- helpers */

function readText(full) {
    try {
        if (fs.statSync(full).size > MAX_SCAN_BYTES) return null;
        if (isProbablyBinary(full)) return null;
        return fs.readFileSync(full, "utf8");
    } catch {
        return null;
    }
}

function rel(rootReal, full) {
    return path.relative(rootReal, full).split(path.sep).join("/");
}

/** Shannon entropy per char — high-entropy strings are candidate secrets. */
function entropy(s) {
    const freq = Object.create(null);
    for (const c of s) freq[c] = (freq[c] || 0) + 1;
    let h = 0;
    for (const c in freq) {
        const p = freq[c] / s.length;
        h -= p * Math.log2(p);
    }
    return h;
}

/* ----------------------------------------------------------- scan_secrets */

// Named credential shapes. Ordered specific-first so a match reports the
// tightest label. Each is a genuine leaked-secret pattern, not a guess.
const SECRET_PATTERNS = [
    { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: "AWS secret access key", re: /\baws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+]{40}["']?/i },
    { name: "GitHub token", re: /\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
    { name: "Google API key", re: /\bAIza[0-9A-Za-z_\-]{35}\b/ },
    { name: "Slack token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
    { name: "Stripe secret key", re: /\bsk_live_[0-9A-Za-z]{24,}\b/ },
    { name: "OpenAI / Anthropic key", re: /\b(?:sk|sk-ant)-[A-Za-z0-9-]{20,}\b/ },
    { name: "private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
    // A JWT preceded by "pk." is a Mapbox PUBLIC token — issued for the browser,
    // public by design. The negative lookbehind lets those through while still
    // catching a bare eyJ.<b64>.<b64> session token, which is the one that leaks.
    { name: "JSON Web Token", re: /(?<!pk\.)\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
    { name: "generic secret assignment",
      re: /\b(?:api[_-]?key|secret|passwd|password|token|access[_-]?key)\b\s*[=:]\s*["'][^"'\s]{12,}["']/i }
];

// A high-entropy string assigned to a suspicious key — catches secrets no
// named pattern covers, while the entropy bar avoids flagging prose. Both a
// QUOTED and an UNQUOTED form: .env files (KEY=rawvalue, no quotes) were
// missed by the quoted-only version (review finding).
const ASSIGN_RE = /\b(\w*(?:key|secret|token|passwd|password|cred|auth)\w*)\b\s*[=:]\s*["']([^"'\s]{16,})["']/i;
const ASSIGN_UNQUOTED_RE = /\b(\w*(?:key|secret|token|passwd|password|cred|auth)\w*)\b\s*[=:]\s*([^\s"'#;,]{16,})\s*$/i;

/**
 * PUBLISHABLE keys are MEANT to ship in client code.
 *
 * A publishable Stripe key (pk_live_/pk_test_) and a Mapbox public token
 * (pk.eyJ...) are public BY DEFINITION — the vendor issues them for the
 * browser. Blocking them breaks exactly the public front-end work .lcl exists
 * to help with, so these shapes are exempt from the secret machinery.
 *
 * The line is drawn only where the SHAPE proves publishable. A bare Google
 * `AIza...` key has the same shape whether it is a browser key or a server
 * key, so it is NOT auto-exempted — the operator marks that one public per
 * value (secretGuard.markPublic), because the shape cannot decide it.
 */
const PUBLISHABLE_PATTERNS = [
    { name: "Stripe publishable key", re: /\bpk_(?:live|test)_[0-9A-Za-z]{10,}\b/ },
    { name: "Mapbox public token", re: /\bpk\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{5,})?\b/ }
];
function isPublishableValue(v) {
    const s = String(v || "");
    return PUBLISHABLE_PATTERNS.some(p => p.re.test(s));
}

/**
 * PLACEHOLDER values are the .env.example convention: a secret-shaped NAME
 * assigned a fill-me-in string. "your-key-here", "<token>", "changeme",
 * "xxxxxxxx" are documentation, not credentials, and flagging them redacts the
 * very example files a public repo is supposed to ship.
 *
 * Deliberately does NOT include the word "example" as a marker, because AWS's
 * own documentation key is `AKIAIOSFODNN7EXAMPLE` — a real-shaped secret the
 * guard must keep blocking. Placeholder detection is applied only to generic
 * name=value assignments, never to a strong named shape.
 */
const PLACEHOLDER_RE = /change[\s_-]?me|placeholder|dummy|goes[\s_-]?here|your[\s_-]|[\s_-]here$|^<.+>$|x{6,}|0{6,}/i;
function isPlaceholderValue(v) {
    return PLACEHOLDER_RE.test(String(v || ""));
}

function redact(s) {
    if (s.length <= 8) return "****";
    return s.slice(0, 3) + "…" + s.slice(-2) + ` (${s.length} chars)`;
}

function scanSecrets(root, _args = {}, ctx = {}) {
    const rootReal = realpathOrNull(root);
    if (!rootReal) throw new ToolError("linked folder is unavailable");
    resolveInRoot(root, ".");
    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};

    const findings = [];
    let scanned = 0;
    let truncated = false;

    outer:
    for (const full of walk(rootReal, rootReal)) {
        if (scanned >= MAX_FILES) { truncated = true; break; }
        const text = readText(full);
        if (text === null) continue;
        scanned++;

        const r = rel(rootReal, full);
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.length > 4000) continue;

            let matched = false;
            for (const p of SECRET_PATTERNS) {
                const m = p.re.exec(line);
                if (m) {
                    findings.push({ file: r, line: i + 1, kind: p.name,
                                    match: redact(m[0]) });
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                const a = ASSIGN_RE.exec(line) || ASSIGN_UNQUOTED_RE.exec(line);
                if (a && entropy(a[2]) >= 3.5) {
                    findings.push({ file: r, line: i + 1,
                                    kind: `high-entropy value for '${a[1]}'`,
                                    match: redact(a[2]) });
                }
            }
            if (findings.length >= MAX_FINDINGS) { truncated = true; break outer; }
        }
        if (scanned % 100 === 0) onNote(`scanned ${scanned} files`);
    }

    return {
        findings,
        filesScanned: scanned,
        truncated,
        summary: findings.length
            ? `${findings.length} potential secret${findings.length === 1 ? "" : "s"} found — review each and rotate anything real`
            : "no obvious secrets found in the scanned files"
    };
}

/* ---------------------------------------------------------- review_config */

// Insecure-setting checks by file kind. Each rule is a real misconfiguration,
// not a style nit, with a short why so the finding is actionable.
const CONFIG_RULES = [
    { re: /\bDEBUG\s*[=:]\s*(?:true|1|on)\b/i, why: "debug mode enabled — leaks stack traces and internals", sev: "high" },
    { re: /\b(?:ALLOWED_HOSTS|cors|Access-Control-Allow-Origin)\b.*\*/i, why: "wildcard host/origin — any site can call this", sev: "high" },
    { re: /\bssl[_-]?verify\s*[=:]\s*(?:false|0|no|off)\b/i, why: "TLS verification disabled — vulnerable to MITM", sev: "high" },
    { re: /\b(?:permit_root_login|PermitRootLogin)\s+yes\b/i, why: "root SSH login permitted", sev: "high" },
    { re: /\b0\.0\.0\.0\b/, why: "binds to all interfaces — exposed beyond localhost", sev: "medium" },
    { re: /\bchmod\s+777\b|"mode"\s*:\s*"?0?777/i, why: "world-writable permissions", sev: "medium" },
    { re: /\b(?:secret|password|passwd|api[_-]?key)\s*[=:]\s*["']?\w+/i, why: "credential in a config file — move to a secret store or env", sev: "high" },
    { re: /\bStrictHostKeyChecking\s+no\b/i, why: "SSH host-key checking off — accepts any host", sev: "medium" },
    { re: /\beval\s*\(|\bunserialize\s*\(/i, why: "dynamic eval/deserialization — code-execution risk if fed untrusted input", sev: "medium" }
];

const CONFIG_HINT = /\.(env|ya?ml|toml|ini|conf|cfg|json|properties|config)$|(?:^|\/)(?:dockerfile|docker-compose\.ya?ml|\.htaccess|nginx\.conf|sshd_config|web\.config)$/i;

function reviewConfig(root, { path: relPath } = {}, ctx = {}) {
    const rootReal = realpathOrNull(root);
    if (!rootReal) throw new ToolError("linked folder is unavailable");
    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};

    // one file if named, else every config-looking file in the workspace
    let targets = [];
    if (relPath) {
        targets = [resolveInRoot(root, relPath)];
    } else {
        resolveInRoot(root, ".");
        for (const full of walk(rootReal, rootReal)) {
            if (CONFIG_HINT.test(rel(rootReal, full)) || CONFIG_HINT.test(path.basename(full))) {
                targets.push(full);
                if (targets.length >= 200) break;
            }
        }
    }

    const findings = [];
    let reviewed = 0;
    for (const full of targets) {
        const text = readText(full);
        if (text === null) continue;
        reviewed++;
        const r = rel(rootReal, full);
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim().startsWith("#") || lines[i].trim().startsWith("//")) continue;
            for (const rule of CONFIG_RULES) {
                if (rule.re.test(lines[i])) {
                    findings.push({ file: r, line: i + 1, severity: rule.sev, issue: rule.why });
                    break;
                }
            }
            if (findings.length >= MAX_FINDINGS) break;
        }
        onNote(`reviewed ${r}`);
    }

    return {
        findings,
        filesReviewed: reviewed,
        summary: findings.length
            ? `${findings.length} configuration concern${findings.length === 1 ? "" : "s"} — highest first`
            : "no obvious misconfigurations in the reviewed files"
    };
}

/* ------------------------------------------------------ audit_dependencies */

// Offline, so this cannot query a live CVE feed. It parses manifests, reports
// the dependency inventory, and flags the patterns that are risky WITHOUT a
// network: unpinned versions, git/url/local installs (supply-chain surface),
// and a small set of packages with well-known historical advisories.
const MANIFESTS = {
    "package.json": parseNpm,
    "requirements.txt": parsePip,
    "Pipfile": parsePipfile,
    "go.mod": parseGoMod,
    "Cargo.toml": parseCargo
};

function parseNpm(text) {
    const out = [];
    let j; try { j = JSON.parse(text); } catch { return out; }
    // JSON.parse("null") / "42" / "[]" returns a non-object without throwing;
    // Object.entries(nonObject["deps"]) would then throw (review finding)
    if (!j || typeof j !== "object" || Array.isArray(j)) return out;
    for (const field of ["dependencies", "devDependencies"]) {
        for (const [name, ver] of Object.entries(j[field] || {})) {
            out.push({ name, version: String(ver), dev: field === "devDependencies" });
        }
    }
    return out;
}
function parsePip(text) {
    return text.split(/\r?\n/).map(l => l.trim())
        .filter(l => l && !l.startsWith("#") && !l.startsWith("-"))
        .map(l => {
            const m = /^([A-Za-z0-9._-]+)\s*(==|>=|<=|~=|>|<)?\s*(.*)$/.exec(l);
            return m ? { name: m[1], version: m[2] ? m[2] + m[3] : "" } : { name: l, version: "" };
        });
}
function parsePipfile(text) {
    const out = [];
    const re = /^([A-Za-z0-9._-]+)\s*=\s*(.+)$/gm;
    let m; while ((m = re.exec(text))) out.push({ name: m[1], version: m[2].replace(/["']/g, "").trim() });
    return out;
}
function parseGoMod(text) {
    const out = [];
    const re = /^\s*([\w.\-/]+)\s+v([\w.\-+]+)/gm;
    let m; while ((m = re.exec(text))) out.push({ name: m[1], version: "v" + m[2] });
    return out;
}
function parseCargo(text) {
    const out = [];
    const dep = text.split(/\[dependencies\]/)[1];
    if (!dep) return out;
    const re = /^([A-Za-z0-9._-]+)\s*=\s*(.+)$/gm;
    let m; while ((m = re.exec(dep.split(/\n\[/)[0]))) out.push({ name: m[1], version: m[2].replace(/["']/g, "").trim() });
    return out;
}

const UNPINNED_RE = /^[\^~*]|^>=|latest|\*$|^$/;
const SUPPLY_CHAIN_RE = /git\+|github:|file:|link:|https?:|\.\.\//i;

function auditDependencies(root, { path: relPath } = {}, ctx = {}) {
    const rootReal = realpathOrNull(root);
    if (!rootReal) throw new ToolError("linked folder is unavailable");
    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};

    // find manifests (or the one named)
    const manifests = [];
    if (relPath) {
        const full = resolveInRoot(root, relPath);
        const base = path.basename(full);
        if (MANIFESTS[base]) manifests.push([base, full]);
        else throw new ToolError(`not a recognised manifest: ${relPath}`);
    } else {
        resolveInRoot(root, ".");
        for (const full of walk(rootReal, rootReal)) {
            const base = path.basename(full);
            if (MANIFESTS[base]) { manifests.push([base, full]); if (manifests.length >= 20) break; }
        }
    }
    if (!manifests.length) {
        return { dependencies: 0, findings: [], summary: "no dependency manifests found in this folder" };
    }

    const findings = [];
    let total = 0;
    const ecosystems = [];
    for (const [base, full] of manifests) {
        const text = readText(full);
        if (text === null) continue;
        const deps = MANIFESTS[base](text);
        total += deps.length;
        ecosystems.push(`${base} (${deps.length})`);
        const r = rel(rootReal, full);
        onNote(`parsed ${r}`);

        for (const d of deps) {
            if (SUPPLY_CHAIN_RE.test(d.version)) {
                findings.push({ manifest: r, package: d.name, version: d.version,
                    severity: "medium",
                    issue: "installed from a URL/git/local source — supply-chain surface not pinned to a registry release" });
            } else if (UNPINNED_RE.test(d.version.trim())) {
                findings.push({ manifest: r, package: d.name, version: d.version || "(any)",
                    severity: "low",
                    issue: "unpinned version — a bad release can land silently; pin to an exact version and use a lockfile" });
            }
            if (findings.length >= MAX_FINDINGS) break;
        }
    }

    return {
        dependencies: total,
        ecosystems,
        findings,
        note: "offline audit: this reports the inventory and risky install patterns, " +
              "not live CVE matches (no network). Run your ecosystem's audit " +
              "(npm audit / pip-audit / cargo audit) online for advisory data.",
        summary: `${total} dependencies across ${manifests.length} manifest(s); ` +
                 `${findings.length} flagged for review`
    };
}

/* ------------------------------------------------- crypto_auth_review ----
 *
 * BAKING THE SECURITY BAR INTO THE TOOLKIT. The operator's point: .lcl has to
 * be smart enough to build auth to the caliber they build by hand (a real
 * salt-and-pepper Argon2), across every mode — not just when a strong model
 * happens to be loaded. So the JUDGMENT lives here as a rule table any model
 * can lean on: it flags home-rolled and broken crypto, and it CONFIRMS the
 * strong thing is present, so "did I do the password hashing right?" has a
 * checkable answer rather than a hopeful one.
 */
const CRYPTO_EXT = new Set([
    ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rb", ".php",
    ".java", ".cs", ".kt", ".swift", ".c", ".cpp", ".h", ".hpp", ".rs", ".sh"
]);
function isCodeFile(full) { return CRYPTO_EXT.has(path.extname(full).toLowerCase()); }

/* The files a code scan covers: one file or sub-folder when the caller names a
 * path, the whole workspace otherwise. Containment is enforced by resolveInRoot
 * and walk's own realpath check. */
function codeTargets(root, rootReal, args) {
    if (args && args.path) {
        const p = realpathOrNull(resolveInRoot(root, String(args.path)));
        if (!p || !fs.existsSync(p)) throw new ToolError(`not found in the workspace: ${args.path}`);
        return fs.statSync(p).isFile() ? [p] : walk(p, rootReal);
    }
    return walk(rootReal, rootReal);
}

const CRYPTO_RULES = [
    { re: /\bMD5\b|createHash\(\s*['"]md5['"]|hashlib\.md5|\bmd5\s*\(/i,
      why: "MD5 is broken — never for passwords, tokens or signatures; use Argon2id for passwords, SHA-256+ for integrity", sev: "high" },
    { re: /\bSHA-?1\b|createHash\(\s*['"]sha1['"]|hashlib\.sha1/i,
      why: "SHA-1 is broken for security use — use SHA-256 or better", sev: "medium" },
    { re: /\balg(?:orithm)?['"]?\s*[=:]\s*['"]none['"]/i,
      why: "JWT alg:none disables signature verification — tokens can be forged", sev: "high" },
    { re: /\bRC4\b|\bECB\b|createCipher\s*\(|\bDES\b|\b3DES\b/i,
      why: "weak cipher or mode (DES/3DES/RC4/ECB, or Node's keyless createCipher) — use AES-256-GCM or ChaCha20-Poly1305", sev: "high" },
    { re: /\b(?:iv|salt)\b\s*[=:]\s*['"][^'"\s]{4,}['"]/i,
      why: "a hardcoded IV or salt defeats its purpose — generate a fresh random one per operation", sev: "medium" }
];
const CRYPTO_RANDOM_RE = /Math\.random\s*\(|(?<![A-Za-z_])random\.random\s*\(/;
const SEC_CONTEXT_RE = /token|secret|\bkey\b|nonce|salt|\biv\b|password|passwd|otp|session|csrf|uuid|apikey/i;
const STRONG_HASH_RE = /argon2|bcrypt|scrypt|pbkdf2/i;

function cryptoAuthReview(root, args = {}, ctx = {}) {
    const rootReal = realpathOrNull(root);
    if (!rootReal) throw new ToolError("linked folder is unavailable");
    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
    const findings = [];
    let scanned = 0, truncated = false, strong = false;
    outer:
    for (const full of codeTargets(root, rootReal, args)) {
        if (scanned >= MAX_FILES) { truncated = true; break; }
        if (!isCodeFile(full)) continue;
        const text = readText(full);
        if (text === null) continue;
        scanned++;
        if (STRONG_HASH_RE.test(text)) strong = true;
        const r = rel(rootReal, full);
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.length > 4000) continue;
            for (const rule of CRYPTO_RULES) {
                if (rule.re.test(line)) {
                    findings.push({ file: r, line: i + 1, why: rule.why, sev: rule.sev });
                    break;
                }
            }
            // Math.random only counts as a finding in a security context — a
            // game or an animation using it is not a defect
            if (CRYPTO_RANDOM_RE.test(line) && SEC_CONTEXT_RE.test(line)) {
                findings.push({ file: r, line: i + 1, sev: "high",
                    why: "Math.random is not cryptographically secure — use crypto.randomBytes / getRandomValues for tokens, keys, nonces and salts" });
            }
            if (findings.length >= MAX_FINDINGS) { truncated = true; break outer; }
        }
        if (scanned % 100 === 0) onNote(`reviewed ${scanned} files`);
    }
    return {
        findings, filesScanned: scanned, truncated,
        strongPasswordHashing: strong,
        summary: (findings.length
            ? `${findings.length} crypto/auth concern(s) across ${scanned} files`
            : `no weak crypto found in ${scanned} files`) +
            (strong ? " · strong password hashing (Argon2/bcrypt/scrypt) is present"
                    : " · no strong password-hashing library detected")
    };
}

/* ------------------------------------------------------- audit_code ------
 *
 * SAST-lite: the common web/backend bug classes a public front end + API
 * actually ships. Same proven shape as review_config — a rule table with a
 * short WHY per hit, so a finding is actionable, not a mystery. False positives
 * are acceptable here: it is a review, and every hit tells the operator what to
 * look at and why.
 */
const SAST_RULES = [
    { re: /(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^;'"\n]{0,120}?(?:['"]\s*\+|\+\s*['"]|\$\{|%\s*\(|f['"])/i,
      why: "SQL built by string concatenation/interpolation — use parameterized queries / bound parameters", sev: "high" },
    { re: /(?:child_process|execSync|\bexec\s*\(|\bspawn\s*\(|os\.system|subprocess\.)[^\n]*(?:\$\{|['"]\s*\+|\+\s*['"]|shell\s*=\s*True)/i,
      why: "shell command built from input — avoid shell=True and string interpolation; pass arguments as an array", sev: "high" },
    { re: /\b(?:innerHTML|outerHTML|dangerouslySetInnerHTML)\b\s*[=:]|document\.write\s*\(/i,
      why: "unescaped HTML sink — sanitize the value, or set textContent instead (XSS)", sev: "high" },
    { re: /\beval\s*\(|new\s+Function\s*\(|pickle\.loads\s*\(|\byaml\.load\s*\((?![^)]*Loader)|Marshal\.load/i,
      why: "dynamic code execution or unsafe deserialization — avoid eval/new Function; use safe_load / JSON.parse", sev: "high" },
    { re: /(?:readFile|readFileSync|sendFile|createReadStream|\bopen\s*\()[^\n]*(?:req\.|request\.|params|query|body)/i,
      why: "file path built from user input — resolve against a fixed base directory and reject '..' (path traversal)", sev: "medium" },
    { re: /(?:fetch\s*\(|axios|requests\.(?:get|post)|http\.get|urllib\.request)[^\n]*(?:req\.|request\.|params|query|body)/i,
      why: "outbound request to a user-controlled URL — allowlist destinations (SSRF)", sev: "medium" }
];

function auditCode(root, args = {}, ctx = {}) {
    const rootReal = realpathOrNull(root);
    if (!rootReal) throw new ToolError("linked folder is unavailable");
    const onNote = typeof ctx.onNote === "function" ? ctx.onNote : () => {};
    const findings = [];
    let scanned = 0, truncated = false;
    outer:
    for (const full of codeTargets(root, rootReal, args)) {
        if (scanned >= MAX_FILES) { truncated = true; break; }
        if (!isCodeFile(full)) continue;
        const text = readText(full);
        if (text === null) continue;
        scanned++;
        const r = rel(rootReal, full);
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.length > 4000) continue;
            for (const rule of SAST_RULES) {
                if (rule.re.test(line)) {
                    findings.push({ file: r, line: i + 1, why: rule.why, sev: rule.sev });
                    break;
                }
            }
            if (findings.length >= MAX_FINDINGS) { truncated = true; break outer; }
        }
        if (scanned % 100 === 0) onNote(`scanned ${scanned} files`);
    }
    return {
        findings, filesScanned: scanned, truncated,
        summary: findings.length
            ? `${findings.length} potential issue(s) across ${scanned} files — review each`
            : `no common injection/XSS/SSRF sinks found in ${scanned} files`
    };
}

/* -------------------------------------------------- scan_secret_history --
 *
 * The classic public-repo leak: a key committed, "removed" in a later commit,
 * and still sitting in history (and the pushed remote). The working-tree scan
 * cannot see it. This runs the SAME secret patterns over `git log -p`, so a
 * rotated-and-forgotten key does not read as clean. Local git only, read-only,
 * bounded — no network.
 */
function scanSecretHistory(root, args = {}, ctx = {}) {
    const rootReal = realpathOrNull(root);
    if (!rootReal) throw new ToolError("linked folder is unavailable");
    // a named path is confined to the workspace before it reaches git's -- arg
    const scope = args && args.path
        ? path.relative(rootReal, realpathOrNull(resolveInRoot(root, String(args.path))) || rootReal) || "."
        : ".";
    const git = (aa) => spawnSync("git", ["-C", rootReal, ...aa],
        { encoding: "utf8", windowsHide: true, maxBuffer: 48 * 1024 * 1024 });
    const inside = git(["rev-parse", "--is-inside-work-tree"]);
    if (inside.status !== 0 || !/true/.test(inside.stdout || "")) {
        return { findings: [], commitsScanned: 0, isRepo: false,
                 summary: "not a git repository — no history to scan" };
    }
    const MAX_COMMITS = 500;
    const log = git(["log", "-p", "--no-color", "--max-count=" + MAX_COMMITS, "-M", "--", scope]);
    const text = log.stdout || "";
    const findings = [];
    let commit = null, file = null, commits = 0;
    for (const raw of text.split(/\r?\n/)) {
        if (raw.startsWith("commit ")) { commit = raw.slice(7, 14); commits++; continue; }
        if (raw.startsWith("+++ b/")) { file = raw.slice(6); continue; }
        // only ADDED lines carry a secret INTO history; +++ header excluded
        if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
        const line = raw.slice(1);
        if (line.length > 4000) continue;
        for (const p of SECRET_PATTERNS) {
            const m = p.re.exec(line);
            if (m && !isPublishableValue(m[0])) {
                findings.push({ commit, file, kind: p.name, match: redact(m[0]) });
                break;
            }
        }
        if (findings.length >= MAX_FINDINGS) break;
    }
    return {
        findings, commitsScanned: commits, isRepo: true,
        truncated: commits >= MAX_COMMITS,
        summary: findings.length
            ? `${findings.length} secret(s) found in git history across ${commits} commit(s) — ` +
              "these were committed and may still be in the remote; ROTATE them"
            : `no secrets found across ${commits} commit(s) of history`
    };
}

/* ------------------------------------------------------------- registry */

const SCAN_SECRETS_ENTRY = {
    run: scanSecrets,
    help: 'scan_secrets {} — scan the linked folder for leaked API keys, tokens and private keys (values are redacted in the report)'
};
const REVIEW_CONFIG_ENTRY = {
    run: reviewConfig,
    help: 'review_config {"path": "optional single file"} — flag insecure settings in config files (debug on, wildcard CORS, TLS off, secrets in config, …)'
};
const AUDIT_DEPS_ENTRY = {
    run: auditDependencies,
    help: 'audit_dependencies {} — inventory dependencies (npm/pip/go/cargo) and flag unpinned or non-registry installs'
};
const CRYPTO_REVIEW_ENTRY = {
    run: cryptoAuthReview,
    help: 'crypto_auth_review {} — review code for weak or home-rolled crypto and auth (MD5/SHA1, Math.random for tokens, JWT alg:none, hardcoded IV/salt, weak ciphers) and confirm strong password hashing (Argon2id/bcrypt/scrypt) is present'
};
const AUDIT_CODE_ENTRY = {
    run: auditCode,
    help: 'audit_code {} — scan source for common web/backend bug classes: SQL and command injection, XSS sinks, eval/unsafe deserialization, path traversal, SSRF'
};
const SCAN_HISTORY_ENTRY = {
    run: scanSecretHistory,
    help: 'scan_secret_history {} — scan git history for secrets that were committed and later removed (the working-tree scan cannot see these)'
};

/**
 * Does this text contain something that looks like a credential?
 *
 * Same patterns scan_secrets reports on, exposed for callers that must make a
 * KEEP-OR-DROP decision rather than produce a report — chiefly the knowledge
 * indexer, which stores plaintext excerpts of everything it reads. A repo with
 * a live key in a .env would otherwise have that key copied into the index and
 * fed to the model as "reference material".
 *
 * Returns { found, kinds } — the names of what matched, never the values. It
 * is a filter, so it stops at the first two hits rather than scanning on.
 */
function looksLikeSecret(text, opts = {}) {
    const isExempt = typeof opts.isExempt === "function" ? opts.isExempt : () => false;
    const s = String(text || "");
    if (s.length < 16) return { found: false, kinds: [] };
    const kinds = [];
    // A match is exempt when the value it caught is publishable by shape, a
    // documentation placeholder, or a value the operator marked public. The
    // check looks at the whole match AND the inner value an assignment carries,
    // because the whole match includes the name and the equals sign.
    const exemptMatch = (m) => {
        const whole = m[0];
        if (isPublishableValue(whole) || isExempt(whole)) return true;
        const inner = (whole.match(/["']([^"']{8,})["']/) || [])[1]
            || (whole.match(/[=:]\s*([^\s"'#;,]{8,})/) || [])[1];
        return !!inner && (isPublishableValue(inner) || isPlaceholderValue(inner) || isExempt(inner));
    };
    for (const p of SECRET_PATTERNS) {
        const m = p.re.exec(s);
        if (m && !exemptMatch(m)) { kinds.push(p.name); if (kinds.length >= 2) break; }
    }
    if (kinds.length < 2) {
        // a high-entropy value assigned to a suspicious name, in either form
        for (const re of [ASSIGN_RE, ASSIGN_UNQUOTED_RE]) {
            const m = s.match(re);
            if (m && entropy(m[2]) >= 3.5
                && !isPublishableValue(m[2]) && !isPlaceholderValue(m[2]) && !isExempt(m[2])) {
                kinds.push(`high-entropy value assigned to "${m[1]}"`);
                break;
            }
        }
    }
    return { found: kinds.length > 0, kinds };
}

module.exports = {
    scanSecrets, reviewConfig, auditDependencies, entropy, looksLikeSecret,
    cryptoAuthReview, auditCode, scanSecretHistory,
    SECRET_PATTERNS, PUBLISHABLE_PATTERNS, isPublishableValue, isPlaceholderValue,
    SCAN_SECRETS_ENTRY, REVIEW_CONFIG_ENTRY, AUDIT_DEPS_ENTRY,
    CRYPTO_REVIEW_ENTRY, AUDIT_CODE_ENTRY, SCAN_HISTORY_ENTRY
};
