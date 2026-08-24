"use strict";
/**
 * YOUR CODE AS CONTEXT — THE SHAPE OF IT, NOT THE CONTENT.
 *
 * "I have the repository to train from, but it cannot carry any of the words,
 *  naming or phrasing that is specific to my stuff. That would be a personal
 *  information leak."
 *
 * And the instruction that decided this design:
 *
 * "If you cannot make the identifying-content filter trustworthy, say so and
 *  propose a narrower version — structure and file shape without file contents,
 *  for instance. Do not ship a filter you would not stake my privacy on."
 *
 * I cannot make it trustworthy, so this is the narrower version.
 *
 * WHY THE WIDE FILTER CANNOT BE STAKED ON ANYTHING. A credential has a SHAPE —
 * a prefix, an entropy floor, a key=value frame — which is why secretGuard
 * catches one and can be proven to on the wire. Identifying content has no
 * shape at all. A customer's name is a name; a project codename is a word; a
 * distinctive phrasing is prose. Catching those means classifying arbitrary
 * language, and the failure is silent and permanent: what leaks is exactly what
 * the filter did not think of, and nobody finds out until it is quoted back.
 * A filter that is 95% right is not 95% safe — it is a leak with a good
 * reputation.
 *
 * WHAT THIS STORES INSTEAD, and it is a deliberately short list:
 *
 *   - the tree: directories and file names, every segment of every one of them
 *     built only out of words that appear in every repository on earth
 *   - per file: language, byte size, line count, export/definition COUNTS
 *   - imports of PROVABLY PUBLIC packages. "It is in the manifest" is not
 *     evidence of publicness — a private registry package and a workspace
 *     sibling sit in the same list as express. A name survives only when the
 *     manifest asks for it by a plain version range AND the lockfile shows that
 *     version was fetched from the public registry. Never a relative import,
 *     because "../lib/rinse-aid-billing" is a name.
 *
 * WHAT IT NEVER STORES: file contents, identifiers, comments, strings, commit
 * messages, author names, branch names, any path segment that failed the
 * public-name check, or any dependency name that could not be proved public
 * offline.
 *
 * COUNTS COMPUTED OFF REAL NAMES NEVER CARRY THE NAMES. Fan-out and the
 * test ratio are accumulated during the walk from the real directory names,
 * because every generalised directory is spelled "dir" and five of them would
 * otherwise merge into one bucket. Only the integers leave this file; no key of
 * those accumulators is ever placed on the returned object.
 *
 * That is enough to answer "how does this person build things" — the layering,
 * the module sizes, the libraries reached for, the test-to-source ratio — which
 * is what was actually asked for. It is not enough to leak a customer.
 */

const fs = require("fs");
const path = require("path");

/* Languages worth distinguishing; anything else is counted as "other". */
const LANGS = {
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".jsx": "javascript",
    ".py": "python", ".rs": "rust", ".go": "go", ".c": "c", ".h": "c",
    ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp", ".java": "java",
    ".rb": "ruby", ".php": "php", ".swift": "swift", ".kt": "kotlin",
    ".sh": "shell", ".ps1": "powershell", ".sql": "sql",
    ".css": "css", ".scss": "css", ".html": "html", ".md": "markdown",
    ".json": "json", ".yml": "yaml", ".yaml": "yaml", ".toml": "toml"
};

/**
 * ACTUALLY BINARY, as opposed to merely not-a-language.
 *
 * The withheld block is the operator's audit surface, so it has to be true:
 * calling notes.txt, data.csv and a stylesheet-adjacent .svg "binaries" tells
 * the operator a repository is full of blobs when it is full of prose. The
 * bucket is split rather than renamed — both counts are reported.
 */
const BINARY_EXT = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".icns",
    ".tif", ".tiff", ".psd", ".heic", ".avif",
    ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
    ".jar", ".war", ".exe", ".msi", ".dll", ".so", ".dylib", ".bin",
    ".obj", ".o", ".a", ".lib", ".class", ".wasm", ".pyc", ".pyd", ".node",
    ".mp3", ".mp4", ".wav", ".ogg", ".flac", ".webm", ".mov", ".avi", ".mkv",
    ".ttf", ".otf", ".woff", ".woff2", ".eot",
    ".db", ".sqlite", ".sqlite3", ".mdb", ".dat", ".pack", ".idx",
    ".gguf", ".safetensors", ".onnx", ".pt", ".pth", ".npy", ".npz"
]);

const SKIP_DIRS = new Set([
    ".git", "node_modules", "dist", "build", "out", "target", "vendor",
    "__pycache__", ".venv", "venv", ".next", ".nuxt", "coverage", ".cache"
]);

/**
 * THE WORDS A PATH SEGMENT MAY BE MADE OF.
 *
 * An allowlist, and nothing but an allowlist — see safeSegment below for why
 * the shape test that used to sit beside it had to go. These are words that
 * appear in every repository on earth; a name that is not built from them is
 * replaced rather than risked.
 *
 * WHY THIS LIST GOT MUCH LONGER. The first cut held about seventy words, and
 * measured on the user's own tree it generalised 583 of 587 paths. Every
 * sample row read `file.md` or `tests/file.js`. That is the privacy half of the
 * job done and the OTHER half — telling the operator anything at all about how
 * they build — failed outright. A survey that says nothing is not safe, it is
 * useless, and useless is its own kind of wrong.
 *
 * THE RULE FOR ADDING A WORD, and it is the only rule: the word must be
 * vocabulary that engineering uses everywhere, so that seeing it in a path
 * tells a reader about the CRAFT and nothing about the author. `renderer`,
 * `scheduler`, `migration`, `checkpoint` — those are the trade. A product name,
 * a customer, a codename, a coined compound, a person, a place, a date, a hash:
 * none of those are the trade, and none of them are in here. Specifically kept
 * OUT even though they are frequent in the tree this was measured on: the
 * product's own short name, the coined name of its index directory, and the
 * names of third-party projects vendored into it. A proper noun is a name even
 * when it is a famous one.
 *
 * WHAT WAS CONSIDERED AND MEASURED AND NOT DONE: keeping a word because it
 * appears many times across the tree, on the reasoning that a word used by
 * forty files is structural vocabulary rather than a customer. Counted by
 * files, the top of that list on the user's own tree is the coined name of
 * a generated index directory — 329 files, and a name. Counting naming
 * DECISIONS instead of files fixes that case (a directory names itself once and
 * every file beneath it inherits the word for free), and at that point the rule
 * admits almost nothing the vocabulary above does not already admit, while
 * still admitting the product's own short name at eight decisions.
 *
 * And eight independent decisions is exactly what a per-customer module folder
 * looks like: `acme-adapter.js`, `acme-routes.js`, `acme-config.json`,
 * `acme.test.js`, across four directories. Frequency inside ONE tree cannot
 * tell "a word this author uses a lot" from "a word every author uses a lot",
 * because that difference lives in every OTHER repository — which is what the
 * allowlist is. So the mechanism is not here; the widened vocabulary is, and
 * tests/repo-shape.js pins the refusal with the per-customer fixture, so
 * anyone who adds a frequency gate later has to look at the leak first.
 */
const COMMON = new Set([
    /* Layout and structure. */
    "src", "source", "sources", "lib", "libs", "library", "libraries",
    "app", "apps", "core", "base", "root", "main", "index", "common",
    "shared", "global", "globals", "internal", "external", "public",
    "private", "static", "assets", "asset", "resource", "resources",
    "pkg", "package", "packages", "module", "modules", "component",
    "components", "widget", "widgets", "plugin", "plugins", "extension",
    "extensions", "addon", "addons", "middleware", "layer", "layers",
    "level", "levels", "tier", "tiers", "stack", "frame", "frames",
    "group", "groups", "section", "sections", "part", "parts", "unit",
    "units", "item", "items", "entry", "entries", "element", "elements",
    "block", "blocks", "chunk", "chunks", "segment", "segments", "slot",
    "slots", "node", "nodes", "leaf", "tree", "trees", "graph", "graphs",
    "path", "paths", "dir", "directory", "directories", "folder", "folders",
    "file", "files", "misc", "scratch", "temp", "tmp", "draft", "drafts",

    /* Build, packaging and tooling. */
    "bin", "cmd", "cli", "tool", "tools", "toolkit", "devtools", "script",
    "scripts", "build", "builds", "builder", "make", "makefile", "task",
    "tasks", "job", "jobs", "pipeline", "pipelines", "workflow", "workflows",
    "release", "releases", "version", "versions", "changelog", "license",
    "readme", "contributing", "install", "installer", "uninstall", "upgrade",
    "update", "migrate", "migration", "migrations", "bundle", "bundler",
    "compile", "compiler", "transpile", "lint", "linter", "format",
    "formatter", "generate", "generator", "generators", "codegen",
    "template", "templates", "scaffold", "boilerplate", "setup", "init",
    "config", "configs", "configure", "settings", "options", "preferences",
    "prefs", "defaults", "params", "args", "argv", "flags", "flag", "opts",
    "env", "environment", "bootstrap", "lock", "lockfile", "manifest",

    /* Tests and quality. */
    "test", "tests", "testing", "spec", "specs", "fixture", "fixtures",
    "mock", "mocks", "stub", "stubs", "fake", "fakes", "sample", "samples",
    "example", "examples", "demo", "demos", "playground", "sandbox",
    "harness", "suite", "suites", "integration", "smoke", "regression",
    "benchmark", "benchmarks", "bench", "perf", "performance", "profile",
    "profiler", "profiling", "coverage", "assert", "assertion", "assertions",
    "expect", "matcher", "matchers", "runner", "runners", "e2e",

    /* Documentation. */
    "docs", "doc", "documentation", "guide", "guides", "manual", "manuals",
    "tutorial", "tutorials", "reference", "references", "note", "notes",
    "overview", "summary", "faq", "glossary",

    /* Interface, presentation and media. */
    "ui", "gui", "view", "views", "page", "pages", "screen", "screens",
    "layout", "layouts", "panel", "panels", "pane", "panes", "dialog",
    "dialogs", "modal", "modals", "popup", "popover", "tooltip", "menu",
    "menus", "toolbar", "navbar", "sidebar", "header", "headers", "footer",
    "footers", "nav", "navigation", "breadcrumb", "tab", "tabs", "card",
    "cards", "list", "lists", "table", "tables", "grid", "grids", "row",
    "rows", "column", "columns", "cell", "cells", "form", "forms", "field",
    "fields", "input", "inputs", "output", "outputs", "button", "buttons",
    "checkbox", "radio", "dropdown", "slider", "toggle", "spinner",
    "progress", "badge", "avatar", "icon", "icons", "image", "images", "img",
    "picture", "photo", "photos", "video", "audio", "sound", "media", "mic",
    "font", "fonts", "style", "styles", "stylesheet", "css", "scss", "sass",
    "theme", "themes", "color", "colors", "palette", "canvas", "chart",
    "charts", "plot", "plots", "diagram", "diagrams", "animation",
    "animations", "transition", "transitions", "render", "renderer",
    "renderers", "paint", "draw", "dom", "html", "markup", "viewer",
    "viewers", "preview", "worklet", "worklets", "frontend",

    /* Events and interaction. */
    "event", "events", "emitter", "listener", "listeners", "handler",
    "handlers", "hook", "hooks", "callback", "callbacks", "signal",
    "signals", "dispatch", "dispatcher", "subscribe", "subscriber",
    "publish", "publisher", "observer", "observable", "stream", "streams",
    "channel", "channels", "pipe", "pipes", "queue", "queues", "topic",
    "topics", "bus", "cursor", "pointer", "mouse", "keyboard", "keymap",
    "shortcut", "shortcuts", "touch", "gesture", "scroll", "drag", "drop",
    "focus", "hover", "click", "press", "dictation", "speech", "voice",

    /* State, data and types. */
    "state", "store", "stores", "reducer", "reducers", "action", "actions",
    "selector", "selectors", "context", "contexts", "provider", "providers",
    "model", "models", "entity", "entities", "record", "records", "schema",
    "schemas", "type", "types", "interface", "interfaces", "enum", "enums",
    "constant", "constants", "value", "values", "key", "keys", "data",
    "dataset", "datasets", "db", "database", "databases", "sql", "query",
    "queries", "index", "indexes", "indices", "cache", "caches", "memo",
    "buffer", "buffers", "pool", "pools", "registry", "catalog", "map",
    "maps", "dict", "set", "sets", "array", "arrays", "collection",
    "collections", "struct", "object", "objects", "json", "yaml", "toml",
    "xml", "csv", "blob", "binary", "bytes", "string", "strings", "number",
    "numbers", "int", "integer", "float", "double", "bool", "boolean",
    "date", "dates", "datetime", "timestamp", "timezone", "duration",
    "interval", "locale", "i18n", "l10n", "encoding", "charset", "utf8",
    "serialize", "serializer", "deserialize", "encode", "encoder", "decode",
    "decoder", "parse", "parser", "parsers", "lexer", "token", "tokens",
    "tokenizer", "ast", "syntax", "grammar", "ledger", "journal", "history",

    /* Network, transport and services. */
    "net", "network", "networks", "http", "https", "socket", "sockets",
    "websocket", "tcp", "udp", "ip", "dns", "url", "urls", "uri", "endpoint",
    "endpoints", "route", "routes", "router", "routers", "routing",
    "request", "requests", "response", "responses", "req", "res", "client",
    "clients", "server", "servers", "service", "services", "api", "rest",
    "graphql", "rpc", "grpc", "proxy", "gateway", "bridge", "adapter",
    "adapters", "connector", "connectors", "transport", "protocol",
    "protocols", "packet", "packets", "payload", "body", "message",
    "messages", "msg", "mail", "email", "fetch", "download", "upload",
    "sync", "async", "poll", "polling", "push", "pull", "send", "receive",
    "connect", "connection", "connections", "disconnect", "session",
    "sessions", "cookie", "cookies", "host", "hosts", "port", "ports",
    "peer", "peers", "cluster", "shard", "shards", "replica", "replicas",
    "broker", "worker", "workers", "daemon", "agent", "agents", "webhook",
    "webhooks", "relay", "tunnel", "discovery",

    /* Identity, authorisation and safety. */
    "auth", "authentication", "authorization", "login", "logout", "signin",
    "signup", "user", "users", "account", "accounts", "profiles", "identity",
    "credential", "credentials", "password", "passwords", "secret",
    "secrets", "keystore", "cert", "certs", "certificate", "certificates",
    "tls", "ssl", "ssh", "crypto", "cryptography", "hash", "hashes",
    "digest", "sign", "signature", "signatures", "verify", "encrypt",
    "decrypt", "cipher", "nonce", "salt", "permission", "permissions",
    "policy", "policies", "role", "roles", "rule", "rules", "access",
    "grant", "grants", "deny", "allow", "allowlist", "blocklist", "guard",
    "guards", "gate", "gates", "firewall", "isolation", "trust", "security",
    "secure", "audit", "compliance", "consent", "approval", "approvals",
    "review", "reviews", "capability", "capabilities", "redact", "redaction",

    /* Operations, runtime and platform. */
    "log", "logs", "logger", "logging", "trace", "traces", "tracing",
    "debug", "debugger", "dbg", "diagnostic", "diagnostics", "monitor",
    "monitoring", "metric", "metrics", "stats", "statistics", "telemetry",
    "health", "status", "report", "reports", "dashboard", "alert", "alerts",
    "notification", "notifications", "error", "errors", "exception",
    "exceptions", "fault", "failure", "retry", "retries", "backoff",
    "timeout", "timeouts", "fallback", "recovery", "restore", "backup",
    "backups", "archive", "archives", "snapshot", "snapshots", "checkpoint",
    "dev", "development", "prod", "production", "staging", "local", "remote",
    "cloud", "edge", "deploy", "deployment", "deployments", "provision",
    "provisioning", "orchestrator", "orchestration", "scheduler", "schedule",
    "cron", "supervisor", "manager", "managers", "controller", "controllers",
    "operator", "runtime", "runtimes", "engine", "engines", "platform",
    "platforms", "system", "systems", "os", "kernel", "process", "processes",
    "thread", "threads", "memory", "heap", "disk", "storage", "volume",
    "volumes", "mount", "filesystem", "fs", "io", "device", "devices",
    "driver", "drivers", "firmware", "hardware", "machine", "machines",
    "container", "containers", "docker", "compose", "ci", "cd", "infra",
    "infrastructure", "backend", "preload", "launch", "launcher", "probe",
    "probes", "watchdog", "heartbeat", "gauge", "quota", "budget", "cost",
    "costs", "usage", "spend", "capture", "replay", "record", "knowledge",

    /* Computation, transformation and measurement. */
    "math", "calc", "compute", "computation", "util", "utils", "utility",
    "utilities", "helper", "helpers", "text", "str", "convert", "converter",
    "transform", "transformer", "mapper", "filter", "filters", "sort",
    "sorter", "search", "find", "match", "replace", "split", "join", "merge",
    "diff", "patch", "compare", "comparator", "validate", "validator",
    "validators", "sanitize", "normalize", "normalizer", "escape", "random",
    "uuid", "guid", "id", "ids", "seq", "sequence", "counter", "count",
    "sum", "avg", "mean", "median", "min", "max", "total", "range", "ranges",
    "limit", "limits", "offset", "size", "sizes", "length", "width",
    "height", "depth", "weight", "score", "scores", "rank", "ranking",
    "threshold", "factor", "ratio", "percent", "rate", "rates", "delta",

    /* Time. */
    "time", "times", "timer", "timers", "clock", "calendar", "delay",
    "debounce", "throttle", "epoch",

    /* Verbs a repository names things after. */
    "get", "add", "remove", "delete", "create", "new", "edit", "read",
    "write", "load", "loader", "save", "open", "close", "start", "stop",
    "run", "exec", "execute", "spawn", "kill", "abort", "cancel", "pause",
    "resume", "reset", "clear", "clean", "cleanup", "flush", "drain",
    "refresh", "reload", "restart", "shutdown", "register", "unregister",
    "resolve", "resolver", "apply", "bind", "unmount", "attach", "detach",
    "enable", "disable", "show", "hide", "select", "choose", "pick", "copy",
    "move", "rename", "import", "export", "exports", "include", "exclude",
    "skip", "ignore", "scan", "scanner", "walk", "walker", "visit",
    "visitor", "watch", "watcher", "watchers", "listen", "handle",
    "processor", "forward", "redirect", "wrap", "wrapper", "unwrap", "chain",
    "batch", "batches", "bulk", "print", "printer", "self", "shape",

    /* Machine learning, now ordinary engineering vocabulary. */
    "ai", "ml", "nlp", "llm", "prompt", "prompts", "chat", "completion",
    "completions", "embedding", "embeddings", "vector", "vectors",
    "inference", "training", "train", "eval", "evaluation", "temperature",

    /* Language and platform tokens that appear in build artefact names. */
    "python", "py", "java", "go", "rust", "ruby", "php", "swift", "kotlin",
    "shell", "bash", "powershell", "windows", "linux", "mac", "macos",
    "darwin", "arm", "arm64", "amd64", "x64", "x86", "universal", "portable",

    /* Words the first widening still generalised on a real tree, every one of
     * them ordinary trade vocabulary rather than anything anyone owns. Public
     * STANDARDS and FORMATS are in (ocr, ipc, gpu, mp4, spice, vulkan, cad);
     * the names of third-party PROJECTS are not, because "widely used enough to
     * be generic" is a judgement with no edge, and judgements with no edge are
     * how this filter would leak. */
    "activity", "activities", "case", "cases", "concurrency", "recognition",
    "lifecycle", "ipc", "reader", "readers", "notice", "notices", "picker",
    "governor", "ocr", "critic", "critics", "trigger", "triggers", "wave",
    "waves", "packaging", "safety", "contract", "contracts", "integrity",
    "wiring", "gpu", "cpu", "research", "boundary", "boundaries", "schematic",
    "schematics", "wire", "wires", "semantic", "semantics", "serve", "stress",
    "tone", "anim", "fade", "intro", "playback", "landing", "restructure",
    "backdrop", "vision", "parity", "web", "art", "brand", "branding",
    "binaries", "pack", "repair", "resize", "mark", "marks", "clarify",
    "screenshot", "screenshots", "foreground", "background", "window",
    "eta", "ext", "perms", "creds", "refusal", "refusals", "viewing", "box",
    "bleed", "redline", "bay", "ladder", "spice", "cad", "vulkan", "mp4",
    "cdp", "stable", "diffusion", "critique", "governance",
    "document", "documents", "fix", "fixes", "repo", "repos", "repository",
    "repositories", "survey", "surveys", "oss", "defect", "defects"
]);

/**
 * PLURALS ARE THE SAME WORD. `sessions` is `session`; `runtimes` is `runtime`.
 * Listing both forms of four hundred words is a maintenance trap and the
 * omissions are silent, so the rule is written once. The stem must itself be
 * allowlisted, which is the whole of the trust: this rule cannot admit a word
 * the list does not already admit.
 */
function commonWord(word) {
    const w = String(word || "");
    if (!w) return false;
    if (COMMON.has(w)) return true;
    if (Object.prototype.hasOwnProperty.call(LANGS, "." + w)) return true;
    if (w.length > 3 && w.endsWith("s") && COMMON.has(w.slice(0, -1))) return true;
    if (w.length > 4 && w.endsWith("es") && COMMON.has(w.slice(0, -2))) return true;
    return false;
}

/**
 * A CONCATENATION OF TWO ALLOWLISTED WORDS IS TWO ALLOWLISTED WORDS.
 *
 * `api-client` is already kept because the dash splits it into two words the
 * list holds. `devtools`, `filesystem`, `toolparse` and `datastore` are the
 * same two-word decision with the separator left out, and there is no privacy
 * argument that keeps one and drops the other. So the split is tried without a
 * separator too.
 *
 * The trust basis does not change: BOTH halves must be allowlisted, so this can
 * only ever emit combinations of words already judged generic. Each half must
 * be at least four characters, which keeps three-letter fragments from acting
 * as universal glue — that is what stops `semindex` (`sem` + `index`),
 * `wintermute` (`winter` and `mute` are not trade words) and `acmecorp`
 * (`acme` and `corp` are not trade words) from decomposing.
 */
const COMPOUND_MIN_PART = 4;
function compoundWord(word) {
    const w = String(word || "");
    if (w.length < COMPOUND_MIN_PART * 2) return false;
    for (let i = COMPOUND_MIN_PART; i <= w.length - COMPOUND_MIN_PART; i++) {
        if (commonWord(w.slice(0, i)) && commonWord(w.slice(i))) return true;
    }
    return false;
}

/**
 * EVERY WORD IN THE NAME MUST BE A COMMON WORD. INCLUDING THE ONES AFTER A DOT.
 *
 * The first cut of this paired the allowlist with a SHAPE test — lowercase,
 * dashes, sensible length — and that shape test was the whole hole. A project
 * codename looks exactly like a generic dashed name: `stop-bath-billing` passes
 * any shape rule you would write, and so did the codename this suite planted.
 * The test caught it in the bytes, which is the only reason it is not in the
 * output right now.
 *
 * The second cut had a quieter hole: it sliced the extension off, checked the
 * STEM against the allowlist, and then returned the ORIGINAL segment with the
 * suffix glued back on. Nothing ever tested the suffix, and a directory suffix
 * is free text off the filesystem — so `core.acmecorp/` and `services.bluefin/`
 * walked out verbatim while `package.json` was being carefully redacted.
 *
 * So there is no shape test and no extension exemption. Split on dashes, dots
 * and underscores; every word must be an allowlisted word, the plural of one,
 * a concatenation of two of them, or a known source extension. A codename does
 * not decompose into those; that is what makes it a codename.
 */
function safeSegment(seg) {
    const base = String(seg || "").toLowerCase();
    if (!base) return null;
    const words = base.split(/[-._]+/).filter(Boolean);
    if (!words.length) return null;
    const ok = (w) => commonWord(w) || compoundWord(w);
    return words.every(ok) ? base : null;
}

/** A path is kept only if EVERY segment is safe; otherwise it is generalised. */
function safePath(rel) {
    const parts = String(rel).split("/").filter(Boolean);
    const out = [];
    for (let i = 0; i < parts.length; i++) {
        const s = safeSegment(parts[i]);
        if (s === null) {
            if (i === parts.length - 1) {
                // The language suffix may be kept because it is drawn from a
                // fixed table; an unrecognised suffix is free text and goes.
                const ext = path.extname(parts[i]).toLowerCase();
                out.push(Object.prototype.hasOwnProperty.call(LANGS, ext) ? "file" + ext : "file");
            } else out.push("dir");
        } else out.push(s);
    }
    return out.join("/");
}

/**
 * PROVABLY PUBLIC, OFFLINE, OR NOT AT ALL.
 *
 * Two gates, and a name must clear both:
 *
 *   (a) the manifest asks for it by a plain version range. Anything that points
 *       at a PLACE — file:, link:, workspace:, portal:, npm: aliases, git, ssh
 *       or http specifiers, a bare user/repo shorthand — is not a registry
 *       package, and the name in front of it is somebody's own name.
 *   (b) the lockfile shows that version was fetched from the public registry.
 *       Without that, a private-registry package and express are the same two
 *       words in the same file.
 *
 * A repository with no lockfile therefore publishes NO dependency names. That
 * is the intended answer: nothing was proved, so nothing is claimed. The count
 * of everything dropped is reported in withheld.dependencies so the operator
 * sees that the exclusion happened rather than wondering where the list went.
 */
const PUBLIC_REGISTRY = /^https?:\/\/(?:registry\.npmjs\.org|registry\.yarnpkg\.com|files\.pythonhosted\.org|pypi\.org)\//i;

/* Name as it appears inside a public-registry tarball URL: host/<name>/-/file */
const NPM_TARBALL = /https?:\/\/(?:registry\.npmjs\.org|registry\.yarnpkg\.com)\/((?:@[^/\s"',]+\/)?[^/\s"',]+)\/-\//gi;

/* A wheel or sdist served by the public Python index. */
const PY_ARTIFACT = /https?:\/\/files\.pythonhosted\.org\/[^\s"',]*?\/([^/\s"',]+?\.(?:whl|tar\.gz|tar\.bz2|zip))/gi;

const normPy = (s) => String(s || "").toLowerCase().replace(/[-_.]+/g, "-");

/** Distribution name out of a wheel/sdist filename: name-version-... */
function pypiNameFromArtifact(file) {
    const stem = String(file).replace(/\.(?:whl|zip)$/i, "").replace(/\.tar\.(?:gz|bz2|xz)$/i, "");
    const parts = stem.split("-");
    let cut = parts.length;
    for (let i = 1; i < parts.length; i++) if (/^\d/.test(parts[i])) { cut = i; break; }
    return normPy(parts.slice(0, cut).join("-"));
}

/**
 * WHERE THE MANIFESTS ACTUALLY LIVE.
 *
 * Discovery used to read the root directory and nothing else, so a repository
 * whose application is one level down — `app/package.json` beside
 * `app/package-lock.json`, which is the shape of the tree this was measured on
 * — reported "public packages kept: none, no manifest" while holding a hundred
 * and fifty kilobytes of lockfile. The operator read that line as the survey
 * saying his project has no dependencies.
 *
 * So the search descends a sensible distance instead. Build output is skipped
 * exactly as the file walk skips it, which is what keeps `node_modules` — where
 * every dependency has a manifest of its own — out of the answer. Only COUNTS
 * of what was found ever leave this module; a manifest's directory is a real
 * path name and never appears in the output.
 */
const MANIFEST_NAMES = ["package.json", "requirements.txt", "Pipfile"];
const LOCK_NAMES = [
    "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
    "poetry.lock", "Pipfile.lock", "requirements.lock"
];

function findManifestDirs(root, { maxDepth = 3, maxDirs = 2000 } = {}) {
    const manifests = [], locks = [];
    const stack = [{ rel: "", depth: 0 }];
    let visited = 0;
    while (stack.length && visited < maxDirs) {
        const { rel, depth } = stack.pop();
        visited++;
        let entries = [];
        try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); }
        catch { continue; }
        let hasManifest = false, hasLock = false;
        for (const e of entries) {
            if (e.isDirectory()) {
                if (depth >= maxDepth) continue;
                if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
                stack.push({ rel: rel ? rel + "/" + e.name : e.name, depth: depth + 1 });
                continue;
            }
            if (MANIFEST_NAMES.includes(e.name)) hasManifest = true;
            if (LOCK_NAMES.includes(e.name)) hasLock = true;
        }
        if (hasManifest) manifests.push(rel);
        if (hasLock) locks.push(rel);
    }
    return { manifests, locks };
}

/** Every name the lockfiles prove was fetched from a public registry. */
function lockResolvedIn(dir) {
    const out = new Set();
    const addNpm = (name, url) => {
        if (name && PUBLIC_REGISTRY.test(String(url || ""))) out.add(String(name).toLowerCase());
    };
    for (const f of ["package-lock.json", "npm-shrinkwrap.json"]) {
        let j = null;
        try { j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
        /* lockfileVersion 2 and 3: packages keyed "node_modules/<name>" */
        for (const [k, v] of Object.entries((j && j.packages) || {})) {
            const at = k.lastIndexOf("node_modules/");
            if (at < 0) continue;
            addNpm(k.slice(at + "node_modules/".length), v && v.resolved);
        }
        /* lockfileVersion 1: nested "dependencies" keyed by name */
        (function walk(d) {
            for (const [name, v] of Object.entries(d || {})) {
                addNpm(name, v && v.resolved);
                if (v && v.dependencies) walk(v.dependencies);
            }
        })(j && j.dependencies);
    }
    for (const f of ["yarn.lock", "pnpm-lock.yaml", "poetry.lock", "Pipfile.lock", "requirements.lock"]) {
        let text = "";
        try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
        let m;
        NPM_TARBALL.lastIndex = 0;
        while ((m = NPM_TARBALL.exec(text))) out.add(m[1].toLowerCase());
        PY_ARTIFACT.lastIndex = 0;
        while ((m = PY_ARTIFACT.exec(text))) out.add(pypiNameFromArtifact(m[1]));
    }
    return out;
}

/**
 * Every publicly-resolved name proved by ANY lockfile in the tree. The proof is
 * "this tree fetched that name from the public registry", which does not get
 * weaker because the lockfile sits a directory below the one being surveyed.
 */
function lockResolved(root, opts) {
    const out = new Set();
    const dirs = (opts && opts.locks) || findManifestDirs(root, opts).locks;
    for (const rel of dirs) for (const n of lockResolvedIn(path.join(root, rel))) out.add(n);
    return out;
}

/**
 * A version RANGE, not a location. "^4", "~1.2.3", ">=1 <2", "1.x", "*" pass;
 * anything carrying a scheme, a slash or a backslash is pointing somewhere.
 */
function isPlainRange(value) {
    const v = String(value == null ? "" : value).trim();
    if (!v) return false;
    if (/[:/\\]/.test(v)) return false;
    if (/^(?:git|ssh|https?|file|link|workspace|portal|npm|github|gitlab|bitbucket)\b/i.test(v)) return false;
    return /^[\^~=<>v\s]*(?:\d|\*|x\b)/i.test(v) || /^(?:\*|latest)$/i.test(v);
}

/**
 * Public dependencies, PROVED rather than guessed. Returns the surviving names
 * and a count of everything the two gates dropped.
 */
function publicDepsAudit(root, opts) {
    const names = new Set();
    const found = (opts && opts.manifestDirs) || findManifestDirs(root, opts);
    const resolved = lockResolved(root, { ...(opts || {}), locks: found.locks });
    let declared = 0, withheld = 0;

    const consider = (name, spec, isPython) => {
        declared++;
        const key = isPython ? normPy(name) : String(name).toLowerCase();
        if (isPlainRange(spec) && resolved.has(key)) names.add(isPython ? key : name);
        else withheld++;
    };

    for (const rel of found.manifests) {
        const dir = path.join(root, rel);
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
            for (const block of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
                for (const [k, v] of Object.entries(block || {})) consider(k, v, false);
            }
        } catch { /* not a node project, or no manifest in this directory */ }

        for (const f of ["requirements.txt", "Pipfile"]) {
            let text = "";
            try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
            for (const raw of text.split(/\r?\n/)) {
                const line = raw.trim();
                if (!line || line.startsWith("#") || line.startsWith("-") || line.startsWith("[")) continue;
                // A requirement that names a place (git+ssh, a direct URL, an
                // editable local path) is a name, and it never reaches the gates.
                if (/:\/\/|^git\+|\bfile:/i.test(line)) continue;
                const m = /^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(line);
                if (!m) continue;
                const spec = m[2].replace(/[#;].*$/, "").trim();
                // An unpinned requirement still has to clear the lockfile gate.
                consider(m[1], spec || "*", true);
            }
        }
    }
    return {
        names, withheld, declared,
        // Counts only. A manifest's directory is a real path name.
        manifests: found.manifests.length, lockfiles: found.locks.length
    };
}

/** Backwards-compatible view: just the surviving names. */
function publicDeps(root) { return publicDepsAudit(root).names; }

/* Specifier-bearing forms, safe on any language: the capture is the SPECIFIER. */
const IMPORT_RE = [
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bfrom\s+["']([^"']+)["']/g
];

/**
 * PYTHON ONLY, and the reason is the whole of finding 22.
 *
 * `import <ident>` captures a MODULE name in Python and a LOCAL BINDING NAME in
 * JavaScript. Run against ESM, `import express from "../adapter/index.js"`
 * yields "express" — the identifier the file chose — which then sails through
 * the manifest check while the relative specifier it actually imports is never
 * looked at. The pattern is correct for .py and only for .py.
 */
const IMPORT_RE_PY = [
    /^\s*import\s+([A-Za-z0-9_.]+)/gm,
    /^\s*from\s+([A-Za-z0-9_.]+)\s+import\b/gm
];

/**
 * Read ONE file and return only counts. The content is read into memory and
 * discarded; nothing from it is returned except numbers and public package
 * names.
 */
/**
 * HOW MANY LINES A FILE HAS, which is not how many pieces splitting it makes.
 *
 * `"a\nb\n".split(/\r?\n/)` is three elements, and the third is the empty
 * string after the final newline. Every properly terminated file was therefore
 * reported one line longer than it is, and `totalLines` was inflated by one per
 * file across the whole survey. An empty file was reported as one line rather
 * than none.
 */
function countLines(text) {
    if (!text.length) return 0;
    let n = 1;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    if (text.charCodeAt(text.length - 1) === 10) n--;
    return n;
}

function shapeOf(full, deps) {
    let text = "";
    try { text = fs.readFileSync(full, "utf8"); } catch { return null; }
    const lineCount = countLines(text);
    const imports = new Set();
    const isPython = path.extname(String(full)).toLowerCase() === ".py";
    const patterns = IMPORT_RE.map(re => ({ re, py: false }));
    if (isPython) for (const re of IMPORT_RE_PY) patterns.push({ re, py: true });
    for (const { re, py } of patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text))) {
            const spec = String(m[1] || "");
            // A RELATIVE IMPORT IS A NAME. "../lib/rinse-aid-billing" identifies
            // the project as surely as a customer record does, so only bare
            // specifiers proved public by the manifest and lockfile survive.
            if (spec.startsWith(".") || spec.startsWith("/")) continue;
            // A dotted Python module path is package.submodule; a dotted npm
            // specifier is the package name itself ("socket.io"), so the split
            // is per-language rather than shared.
            const root0 = py ? spec.split(".")[0]
                : spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/")
                                       : spec.split("/")[0];
            if (deps.has(root0) || deps.has(root0.toLowerCase())) imports.add(root0);
        }
    }
    return {
        lines: lineCount,
        // counts only — never the names
        functions: (text.match(/\bfunction\s+[A-Za-z_$]/g) || []).length +
                   (text.match(/=>\s*\{/g) || []).length,
        classes: (text.match(/\bclass\s+[A-Za-z_$]/g) || []).length,
        exports: (text.match(/\bmodule\.exports\b|\bexport\s+(default|const|function|class)\b/g) || []).length,
        imports: [...imports].sort()
    };
}

/**
 * A FILE A MACHINE WROTE IS NOT A FILE ABOUT HOW SOMEBODY WRITES CODE.
 *
 * The survey reported "median file 1 lines" for a tree averaging ninety-six
 * lines a file, and the median was arithmetically correct: 338 of 587 surveyed
 * files really did hold one line, because 329 of them were shards of a
 * generated index, each about 24 kB of JSON on a single line. The statistic is
 * a claim about how this person builds, and it was being answered by a program.
 *
 * The test is language-neutral and measured rather than assumed: average bytes
 * per line. Hand-written source in the tree this was calibrated on tops out
 * under two hundred bytes a line; the generated shards sit at twenty-four
 * thousand. Between 300 and 1000 the population flagged does not move at all —
 * 330 files, every one of them JSON — so 400 sits on a plateau rather than on a
 * cliff edge.
 *
 * Nothing is dropped. The files stay in the walk, in fileCount, in byLanguage,
 * in totalBytes and in totalLines; they are marked, counted, and kept out of
 * one statistic they were making meaningless.
 */
const GENERATED_BYTES_PER_LINE = 400;
function looksGenerated(bytes, lines) {
    const n = Number(lines) || 0;
    return n > 0 && Number(bytes) / n >= GENERATED_BYTES_PER_LINE;
}

/* A path is a test path if any word of any segment is a test word. */
const TEST_WORDS = new Set(["test", "tests", "spec", "specs"]);
function isTestPath(rel) {
    for (const seg of String(rel).toLowerCase().split("/")) {
        for (const word of seg.split(/[-._]+/)) if (TEST_WORDS.has(word)) return true;
    }
    return false;
}

/**
 * Walk a repository and produce its SHAPE.
 *
 * Returns what will be stored and what was withheld, so the operator can see
 * the second list before agreeing to the first.
 */
function survey(root, { maxFiles = 4000 } = {}) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        return { ok: false, error: "not a directory" };
    }
    const audit = publicDepsAudit(root);
    const deps = audit.names;
    const files = [];
    const withheld = {
        paths: 0, skippedDirs: 0, binaries: 0, nonSourceText: 0, oversized: 0,
        dependencies: audit.withheld, truncated: 0, unwalkedDirs: 0
    };
    const byLang = {};
    // COUNTS ONLY, FROM THE REAL PATH. Fan-out and the test ratio cannot be
    // taken off the generalised paths: every filtered directory is spelled
    // "dir", so five real directories collapse into one bucket and the widest/
    // mean figures describe a tree that does not exist. These accumulate during
    // the walk from real names, and only the integers derived from them are
    // placed on the result — no key of realDirs is ever emitted.
    const realDirs = new Map();
    let realTestFiles = 0;
    const stack = [""];
    let seen = 0;

    while (stack.length && seen < maxFiles) {
        const rel = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); }
        catch { continue; }
        for (let ei = 0; ei < entries.length; ei++) {
            const e = entries[ei];
            if (seen >= maxFiles) {
                // TRUNCATION IS NEVER SILENT. The cap stopped the walk part way
                // through this directory; count everything still visible here so
                // the operator knows the summary is over a prefix.
                for (let j = ei; j < entries.length; j++) {
                    if (entries[j].isDirectory()) withheld.unwalkedDirs++;
                    else withheld.truncated++;
                }
                break;
            }
            const childRel = rel ? rel + "/" + e.name : e.name;
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) { withheld.skippedDirs++; continue; }
                stack.push(childRel);
                continue;
            }
            const ext = path.extname(e.name).toLowerCase();
            const lang = LANGS[ext] || "other";
            let size = 0;
            try { size = fs.statSync(path.join(root, childRel)).size; } catch { continue; }
            if (size > 2_000_000) { withheld.oversized++; continue; }
            if (lang === "other") {
                if (BINARY_EXT.has(ext)) withheld.binaries++;
                else withheld.nonSourceText++;
                continue;
            }
            seen++;
            const safe = safePath(childRel);
            if (safe !== childRel.toLowerCase()) withheld.paths++;
            const sh = shapeOf(path.join(root, childRel), deps) || {};
            byLang[lang] = (byLang[lang] || 0) + 1;
            const realDir = rel || ".";
            realDirs.set(realDir, (realDirs.get(realDir) || 0) + 1);
            if (isTestPath(childRel)) realTestFiles++;
            files.push({ path: safe, lang, bytes: size, ...sh,
                         generated: looksGenerated(size, sh.lines) });
        }
    }
    // Directories the cap left on the stack were never opened at all.
    withheld.unwalkedDirs += stack.length;

    const allImports = {};
    for (const f of files) for (const i of f.imports || []) allImports[i] = (allImports[i] || 0) + 1;

    return {
        ok: true,
        files,
        summary: {
            fileCount: files.length,
            byLanguage: byLang,
            totalBytes: files.reduce((n, f) => n + f.bytes, 0),
            totalLines: files.reduce((n, f) => n + (f.lines || 0), 0),
            publicDependencies: Object.entries(allImports)
                .sort((a, b) => b[1] - a[1]).map(([name, uses]) => ({ name, uses })),
            // STRUCTURE WITHOUT NAMES. Measured on this app's own engine, the
            // name filter generalises nearly every path — correct, and it
            // leaves a tree of "dir/file.js" that says nothing about layering.
            // Depth and fan-out are the layering, and they are pure numbers:
            // "68 files across 3 levels, widest directory 60" describes how
            // somebody builds without naming a single thing they built. Depth
            // is safe to take off the stored path because generalising a
            // segment does not change how many segments there are; fan-out is
            // not, which is why it comes from the walk instead.
            depth: (() => {
                const d = files.map(f => f.path.split("/").length - 1);
                return { max: d.length ? Math.max(...d) : 0,
                         mean: d.length ? +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(2) : 0 };
            })(),
            fanOut: (() => {
                const counts = [...realDirs.values()];
                return { directories: counts.length,
                         widest: counts.length ? Math.max(...counts) : 0,
                         mean: counts.length ? +(files.length / counts.length).toFixed(2) : 0 };
            })(),
            // MEASURED OVER WHAT A PERSON WROTE. Generated files stay in every
            // other figure; they are counted here so the operator can see the
            // size of the population this one statistic set aside, and why the
            // median moved.
            sizeSpread: (() => {
                const authored = files.filter(f => !f.generated);
                const l = authored.map(f => f.lines || 0).sort((a, b) => a - b);
                const at = (q) => l.length ? l[Math.min(l.length - 1, Math.floor(l.length * q))] : 0;
                return { medianLines: at(0.5), p90Lines: at(0.9), maxLines: at(1),
                         authoredFiles: l.length,
                         generatedFiles: files.length - l.length };
            })(),
            // COUNTS ONLY — a manifest's directory is a real path name and none
            // of them reach this object.
            manifests: { found: audit.manifests, lockfiles: audit.lockfiles },
            testRatio: files.length ? +(realTestFiles / files.length).toFixed(3) : 0
        },
        withheld,
        // SAID OUT LOUD, EVERY TIME, because the operator has to be able to
        // check the claim rather than trust it.
        stores: "file tree, language, byte size, line count, definition counts, " +
                "and imports of packages your own manifest and lockfile prove " +
                "were fetched from the public registry",
        neverStores: "file contents, identifiers, comments, strings, commit " +
                     "messages, author or branch names, any path segment " +
                     "that is not provably generic, and any dependency name " +
                     "that is not provably public"
    };
}

module.exports = {
    survey, safePath, safeSegment, shapeOf, publicDeps, publicDepsAudit,
    isPlainRange, lockResolved, isTestPath, countLines, looksGenerated,
    commonWord, compoundWord, findManifestDirs,
    COMMON, LANGS, BINARY_EXT, GENERATED_BYTES_PER_LINE, COMPOUND_MIN_PART
};
