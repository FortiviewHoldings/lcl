const crypto = require("crypto");
const securityTools = require("./securityTools");

/**
 * SECRET GUARD — read everything, leak nothing.
 *
 * The requirement, in the user's words: they hand over a repository so tooling
 * can be derived from it, and it contains secrets. The model SHOULD read it.
 * What must never happen is a secret reaching the network once they turn an
 * online service on.
 *
 * So the control point is EGRESS, not reading. An earlier version refused to
 * open credential files, which blocked the very thing that was asked for and
 * did nothing about the actual risk: a secret that reaches the model's context
 * by any route — a pasted config, a read file, a knowledge passage — and then
 * leaves in a URL, a search query or a request body.
 *
 * THE GUARD NEVER STORES A SECRET. It keeps SHA-256 hashes of the values it has
 * seen. Checking outbound text means tokenising it and hashing the candidates,
 * so the thing protecting the secrets is not itself a place secrets are kept.
 * A truncated fingerprint is retained purely so a report can say WHICH one
 * without saying what it is.
 */

const MIN_SECRET_LEN = 8;
const MAX_REMEMBERED = 5000;
// Tokens worth hashing on the outbound path. Real secrets are long and dense;
// scanning every three-letter word would cost more than it catches.
//
// The class SPANS the URL glue characters (=&?#/:,;) on purpose. It used to stop
// at them, which meant any secret containing one was split into pieces before
// the outbound check ever saw it — and real secrets are full of them:
//   /  and  =   base64 alphabet and padding — every AWS secret access key
//   :  and  ;   connection strings: user:pass@host, Server=x;Password=y
//   ?  and  &   signed URLs and SAS tokens, which ARE the credential
// Spanning them makes tokens longer and noisier, so candidateForms() below
// decomposes each one back into every substring a secret could actually be.
const CANDIDATE_RE = /[A-Za-z0-9_\-+/=.~&?#:,;]{8,}/g;

const seen = new Map();          // sha256 -> { source, fingerprint, at }

// VALUES THE OPERATOR MARKED PUBLIC. Same discipline as `seen`: hashes only,
// never the value. A value here is exempt from every egress and redaction
// path, because the operator looked at it and said "this is a publishable key,
// it is supposed to ship." This is the per-value override the session-wide
// switch could not give: send one mis-flagged Firebase key without dropping
// protection for every other secret in the session.
const publicValues = new Set();  // sha256 of values marked public by the operator

const hash = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
/** Enough to identify a secret in a report, nowhere near enough to use it. */
const fingerprint = (s) => `${String(s).slice(0, 2)}…${String(s).length} chars`;

/**
 * Exempt from the secret machinery: a value the operator marked public, or one
 * whose SHAPE proves it publishable (Stripe pk_, Mapbox pk.eyJ). Consulted
 * everywhere a value is about to be flagged, remembered, redacted or blocked,
 * so the exemption is consistent across every egress channel.
 */
function isExemptToken(tok) {
    const s = String(tok || "");
    return publicValues.has(hash(s)) || securityTools.isPublishableValue(s);
}

/* Fill-me-in files (.env.example, config.sample, *.template, *.dist) hold
 * placeholders, not credentials. Their values are never remembered, so a
 * public repo's example config does not become a wall of [redacted]. */
function isPlaceholderSource(source) {
    const s = String(source || "").toLowerCase();
    return /(^|[\\/.])(example|sample|template|dist)($|[.\\/])/.test(s)
        || /\.(example|sample|template|dist|tmpl)$/.test(s);
}

/**
 * Pull the literal secret VALUES out of text. securityTools reports that a
 * secret is present; to block egress we need the value itself so we can
 * recognise it going out.
 */
/* A NAME IMPLIES A SECRET ONLY AS A WHOLE WORD OF ITSELF.
 *
 * Measured corruption, from the user's own session: `renderer.toneMapping
 * = THREE.ACESFilmicToneMapping;` — "Mapping" CONTAINS "pin", so the substring
 * match `\w*pin\w*` decided toneMapping named a secret, remembered the
 * three.js constant, and redactKnown() then blanked it out of every request.
 * The model, unable to ever see the real value, wrote the literal "[redacted]"
 * INTO the user's file and looped on an edit it could never match. A secret
 * word has to be a whole camelCase/snake segment — apiKey, auth_token, PIN —
 * never a fragment of an innocent identifier (toneMapping, author, credits).
 */
const SECRET_NAME_WORDS = new Set([
    "key", "apikey", "secret", "token", "passwd", "password", "pass",
    "cred", "creds", "credential", "credentials", "auth", "pin"
]);
function nameImpliesSecret(name) {
    // split on separators first, THEN camelCase within each part — with acronym
    // awareness, or a naive (?=[A-Z]) lookahead shreds SECRET_KEY into single
    // letters and an all-caps secret name stops implying anything
    const segs = String(name || "")
        .split(/[_\-.]+/)
        .flatMap(p => p.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g) || [])
        .map(x => x.toLowerCase())
        .filter(Boolean);
    return segs.some(x => SECRET_NAME_WORDS.has(x));
}

/* A dotted identifier chain (THREE.ACESFilmicToneMapping, os.path.sep) is a
 * CODE REFERENCE, not a credential — never remember one as a secret value. */
const CODE_REF_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;

function extractSecrets(text, opts = {}) {
    // The outbound floor is 3.5 (aligned with scan_secrets and looksLikeSecret):
    // a front-end identifier named key/token/pin with a modestly random value is
    // not a credential, and remembering it blanks real code out of later prompts.
    // A caller that has its OWN name-vs-secret defence downstream — the training
    // export's prose-skip, which extracts broadly then keeps recurring names —
    // may ask for a lower floor.
    const minEntropy = typeof opts.minEntropy === "number" ? opts.minEntropy : 3.5;
    const s = String(text || "");
    const out = new Set();
    if (!s) return out;

    for (const p of securityTools.SECRET_PATTERNS) {
        // the patterns are authored unanchored; run them globally here
        const re = new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : p.re.flags + "g");
        let m;
        while ((m = re.exec(s))) {
            // prefer a captured group (the value) over the whole match (which
            // may include the key name and the equals sign)
            const v = (m[1] && m[1].length >= MIN_SECRET_LEN) ? m[1] : m[0];
            if (m.index === re.lastIndex) re.lastIndex++;
            if (!v || v.length < MIN_SECRET_LEN) continue;
            const tv = v.trim();
            // a publishable or operator-marked-public value is not a secret
            if (isExemptToken(tv)) continue;
            // a documentation placeholder assigned to a secret-shaped name is
            // not a credential — but ONLY on the generic assignment shape, never
            // on a strong named pattern (AWS's own EXAMPLE key must still block)
            if (p.name === "generic secret assignment" && securityTools.isPlaceholderValue(tv)) continue;
            out.add(tv);
        }
    }
    // key = value / key: value forms, where the NAME implies a secret
    const assign = /\b(\w*(?:key|secret|token|passwd|password|cred|auth|pin)\w*)\b\s*[=:]\s*["']?([^\s"'#;,]{8,})["']?/gi;
    let a;
    while ((a = assign.exec(s))) {
        // the regex is the cheap net; these checks are the truth of it
        if (!nameImpliesSecret(a[1])) continue;
        const v = a[2];
        if (!v || CODE_REF_RE.test(v)) continue;
        if (isExemptToken(v) || securityTools.isPlaceholderValue(v)) continue;
        // the floor: 3.5 by default (see the header), lower only when the caller
        // asked for it because it has its own downstream name-vs-secret defence
        if (securityTools.entropy(v) >= minEntropy) out.add(v.trim());
    }
    return out;
}

/**
 * Remember every secret in this text so it can never leave. Returns what was
 * found — count and fingerprints only, never values — so the user can be told
 * their folder contains secrets without the report itself leaking them.
 */
function remember(text, source = "unknown") {
    // a .env.example / *.sample file holds placeholders, not credentials
    if (isPlaceholderSource(source)) return { found: 0, added: 0, fingerprints: [] };
    const found = extractSecrets(text);
    const added = [];
    for (const v of found) {
        const h = hash(v);
        if (seen.has(h)) continue;
        if (seen.size >= MAX_REMEMBERED) break;
        const entry = { source, fingerprint: fingerprint(v), at: Date.now() };
        seen.set(h, entry);
        added.push(entry);
    }
    return { found: found.size, added: added.length, fingerprints: added.map(a => a.fingerprint) };
}

/** Remember a whole file's worth, given its text. */
function rememberFile(relPath, text) {
    return remember(text, relPath);
}

/**
 * Register content that IS a secret — a .key file, a .pem, a raw binary blob.
 * remember() scans for recognisable shapes, which is right for ordinary text
 * but useless for a bare 32-byte key: it has no shape at all. Here the whole
 * value and its plausible token forms are registered directly.
 */
function rememberValue(value, source = "unknown") {
    const s = String(value || "").trim();
    if (s.length < MIN_SECRET_LEN || seen.size >= MAX_REMEMBERED) return { added: 0 };
    let added = 0;
    const put = (v) => {
        if (!v || v.length < MIN_SECRET_LEN) return;
        const h = hash(v);
        if (!seen.has(h) && seen.size < MAX_REMEMBERED) {
            seen.set(h, { source, fingerprint: fingerprint(v), at: Date.now() });
            added++;
        }
    };
    put(s);
    // the forms a binary value takes when someone tries to move it as text —
    // also every whitespace-split token, so a multi-line PEM body is caught
    // line by line the way it would appear in a URL or query
    for (const t of s.split(/\s+/)) put(t);
    return { added };
}

// The glue characters that join a value into a URL, a query, or an assignment.
const GLUE_RE = /[=&?#/:,;]+/g;
// Bounds. Substring generation is O(starts × ends), so both are capped: a
// 100 KB base64 blob must not turn one outbound check into a million hashes.
const MAX_BOUNDARIES = 64;
const MAX_CANDIDATES_PER_TOKEN = 4096;

/**
 * Every substring of `token` that a secret could be, given that secrets arrive
 * glued to other text: `?k=SECRET`, `key=SECRET&next=1`, `/SECRET/`, `"SECRET"`.
 *
 * THE BUG THIS REPLACES: the old code stripped glue by SPLITTING on it —
 * `t.split(/[=&?#/:,;]+/)`. That removes a `k=` prefix, but it also shreds any
 * secret that CONTAINS a glue character. An AWS secret access key is 40 base64
 * characters and base64's alphabet includes `/`, so roughly half of all real AWS
 * keys were fragmented into pieces, none of which hashed to the registered
 * value — the seen-secret check simply could not see them. Same for every PEM
 * body line and every connection string. The suite's own base64 test passed only
 * because the random key it generated happened to contain no slash.
 *
 * Splitting cannot fix this, because the same character is both "glue to strip"
 * and "part of the secret" depending on which side of the boundary you are on.
 * So take every glue-delimited substring instead: the correct value is always
 * one of them, whichever role the character was playing.
 */
function candidateForms(token, out) {
    out.add(token);
    if (token.length < MIN_SECRET_LEN) return out;

    // boundary offsets: start-of-token, end-of-token, and both edges of each
    // run of glue characters
    const starts = [0], ends = [token.length];
    GLUE_RE.lastIndex = 0;
    let m;
    while ((m = GLUE_RE.exec(token)) && starts.length < MAX_BOUNDARIES) {
        ends.push(m.index);                        // a candidate may end here
        starts.push(m.index + m[0].length);        // or begin after the glue
    }

    // Longest first, so if the budget runs out on a pathological token it is the
    // least plausible candidates that get dropped — a secret is long, and the
    // short fragments are the ones that were never going to match.
    const pairs = [];
    for (const a of starts) {
        for (const b of ends) {
            if (b - a >= MIN_SECRET_LEN) pairs.push([a, b]);
        }
    }
    pairs.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]));
    for (const [a, b] of pairs.slice(0, MAX_CANDIDATES_PER_TOKEN)) {
        out.add(token.slice(a, b));
    }
    return out;
}

/**
 * Would sending this text leak something? Checks two ways, because either alone
 * has a hole:
 *   - a value we have SEEN before (the strong check; catches anything at all,
 *     including a raw binary key with no recognisable shape)
 *   - anything that LOOKS like a secret even if never seen (catches a secret
 *     the model produced or read from somewhere we never indexed)
 */
function inspect(outbound) {
    const s = String(outbound || "");
    if (!s) return { blocked: false, reasons: [] };
    const reasons = [];

    if (seen.size) {
        // A secret rarely travels as a clean token: it arrives as ?v=SECRET,
        // key=SECRET, /SECRET/, "SECRET". So every raw token also contributes
        // its sub-tokens split on the characters that glue values into URLs
        // and assignments. Hash lookups are cheap; missing one is not.
        const raw = s.match(CANDIDATE_RE) || [];
        const candidates = new Set();
        for (const t of raw) candidateForms(t, candidates);
        for (const t of candidates) {
            // a value the operator marked public rides freely, by design
            if (publicValues.has(hash(t))) continue;
            const hit = seen.get(hash(t));
            if (hit) {
                reasons.push(`a known secret from ${hit.source} (${hit.fingerprint})`);
                if (reasons.length >= 3) break;
            }
        }
    }
    if (reasons.length < 3) {
        // the shape check honours the same exemption, so a publishable key or a
        // marked-public value never registers as a shaped leak
        const shaped = securityTools.looksLikeSecret(s, { isExempt: isExemptToken });
        if (shaped.found) reasons.push(`text that looks like ${shaped.kinds[0]}`);
    }
    return { blocked: reasons.length > 0, reasons };
}

/**
 * The egress gate. Throws rather than returns, so a caller cannot forget to
 * check the result — a network tool that silently proceeded on a truthy value
 * would be exactly the bug this exists to prevent.
 */
function assertNoLeak(outbound, what = "this request") {
    const r = inspect(outbound);
    if (r.blocked) {
        const err = new Error(
            `refusing to send ${what}: it contains ${r.reasons[0]}. ` +
            "Secrets from your files are blocked from leaving this machine.");
        err.code = "SECRET_EGRESS_BLOCKED";
        err.reasons = r.reasons;
        throw err;
    }
    return true;
}

/** Redact known and shaped secrets from text about to be STORED or shown. */
function redact(text) {
    let s = String(text || "");
    for (const p of securityTools.SECRET_PATTERNS) {
        const re = new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : p.re.flags + "g");
        // a publishable or marked-public value is left in place — it is meant
        // to be readable; masking it would break the front-end config it lives in
        s = s.replace(re, (m) => isExemptToken(m) ? m : "[redacted]");
    }
    s = s.replace(/\b(\w*(?:key|secret|token|passwd|password|cred|auth|pin)\w*)\b(\s*[=:]\s*)(["']?)([^\s"'#;,]{8,})(["']?)/gi,
        (whole, name, glue, q1, val, q2) =>
            (nameImpliesSecret(name) && !CODE_REF_RE.test(val)
                && !isExemptToken(val) && !securityTools.isPlaceholderValue(val))
                ? `${name}${glue}${q1}[redacted]${q2}` : whole);
    return s;
}

/**
 * Redact REMEMBERED secrets — the values learned from files the model read.
 *
 * redact() alone was not enough for outbound traffic: it only knows secrets by
 * SHAPE (sk-..., key=value), and a bare credential quoted in the middle of a
 * prompt has no shape. The remembered store knows it exactly — but stores only
 * hashes, never values, so it cannot be searched with replace(). This walks
 * the text the same way inspect() does — candidate tokens, glue-split forms —
 * and rewrites any token whose hash is in the store. What leaves carries a
 * placeholder; the value never existed in this function's output.
 */
function redactKnown(text) {
    let s = String(text || "");
    if (!seen.size) return s;
    const raw = s.match(CANDIDATE_RE) || [];
    const dead = new Set();
    for (const t of raw) {
        const forms = new Set();
        candidateForms(t, forms);
        for (const f of forms) {
            // a marked-public value is remembered (so its OTHER forms stay
            // protected) but must not itself be masked out of the prompt
            if (seen.has(hash(f)) && !publicValues.has(hash(f))) { dead.add(f); }
        }
    }
    for (const value of [...dead].sort((a, b) => b.length - a.length)) {
        s = s.split(value).join("[redacted]");
    }
    return s;
}

/** What has been seen — counts and sources only. For the UI. */
function summary() {
    const bySource = new Map();
    for (const e of seen.values()) {
        bySource.set(e.source, (bySource.get(e.source) || 0) + 1);
    }
    return {
        total: seen.size,
        sources: [...bySource.entries()].map(([source, count]) => ({ source, count }))
            .sort((a, b) => b.count - a.count).slice(0, 20)
    };
}

/**
 * MARK A VALUE PUBLIC — the per-value override.
 *
 * The operator looked at a flagged value and said "this is a publishable key,
 * it ships in the client, stop protecting it." Every form the value could
 * travel as is registered (mirroring rememberValue), so it is recognised
 * whether it leaves bare, quoted, or glued into a URL. Only its hashes are
 * kept, never the value. Consulted by isExemptToken across every egress path.
 */
function markPublic(value) {
    const s = String(value || "").trim();
    if (s.length < MIN_SECRET_LEN) return { added: 0 };
    let added = 0;
    const put = (v) => {
        if (!v || v.length < MIN_SECRET_LEN) return;
        const h = hash(v);
        if (!publicValues.has(h)) { publicValues.add(h); added++; }
    };
    put(s);
    const forms = new Set();
    candidateForms(s, forms);
    for (const f of forms) put(f);
    for (const t of s.split(/\s+/)) put(t);
    return { added };
}

function isMarkedPublic(value) { return publicValues.has(hash(String(value || "").trim())); }

/** Stop treating a value as public (undo a mark). Best-effort by exact value. */
function unmarkPublic(value) {
    const s = String(value || "").trim();
    const forms = new Set([s]);
    candidateForms(s, forms);
    for (const t of s.split(/\s+/)) forms.add(t);
    let removed = 0;
    for (const f of forms) { if (publicValues.delete(hash(f))) removed++; }
    return { removed };
}

function publicSummary() { return { total: publicValues.size }; }

function reset() { seen.clear(); publicValues.clear(); }

module.exports = {
    remember, rememberFile, rememberValue, inspect, assertNoLeak, redact, redactKnown,
    markPublic, unmarkPublic, isMarkedPublic, publicSummary, isExemptToken,
    summary, reset, extractSecrets, _hash: hash
};
