const { ToolError } = require("./fsTools");

/**
 * FREE API CATALOG — keyless public services the agent can actually reach.
 *
 * A local model does not carry the fact that a compound's molecular weight
 * lives at pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/<x>/property/... —
 * it will invent a plausible URL instead. So the engine carries it: find_api
 * searches this catalog and hands back a REAL example URL, which http_fetch
 * then calls.
 *
 * Every entry was resolved and terms-checked: no key, no account, no fee, and
 * terms that permit programmatic use from a commercial desktop app. Services
 * that had quietly started requiring a key (exchangerate.host) or shut down
 * (worldtimeapi.org) were rejected; Open-Meteo was left out because its
 * commercial terms could not be confirmed.
 *
 * DATA lives in apiCatalog.data.json (regenerated from research runs); the
 * LOGIC lives here. They are separate files because a regeneration once
 * silently reverted hand-tuned ranking fixes that were sitting in the same
 * generated file.
 *
 * The catalog is DATA, not permission: http_fetch still enforces the network
 * switch, the public-host guard and the loopback block. Naming an API here
 * never bypasses any of that.
 */

const CATALOG = require("./apiCatalog.data.json");

// Short filler words matched as SUBSTRINGS and wrecked the ranking: "convert
// psi to kPa" scored OpenTopoData top, because "opentopodata" contains "to".
// Terms must be meaningful, and matched on word boundaries first.
const STOPWORDS = new Set(["the", "a", "an", "to", "of", "for", "in", "on", "and",
    "or", "is", "at", "by", "from", "with", "what", "how", "get", "me", "my"]);

/** Search by topic or free text. Returns the best matches, best first. */
function findApi(query, limit = 6) {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return CATALOG.slice(0, limit);
    const terms = q.split(/[^a-z0-9]+/)
        .filter(t => t.length >= 3 && !STOPWORDS.has(t));
    if (!terms.length) return CATALOG.slice(0, limit);

    const scored = CATALOG.map(e => {
        const name = e.name.toLowerCase();
        // the example URL is real signal: PubChem's carries "MolecularWeight",
        // which is exactly what someone asking for one would type
        const hay = (name + " " + e.topic + " " + e.what + " " + e.example).toLowerCase();
        let score = 0;
        for (const t of terms) {
            const word = new RegExp("\\b" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
            if (e.topic === t) score += 5;
            else if (word.test(name)) score += 3;
            else if (word.test(hay)) score += 2;
            // substring is the weakest signal: it is what makes a plural or a
            // stem match, and also what makes false hits, so it scores least
            else if (hay.includes(t)) score += 1;
        }
        return { e, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(x => x.e);
}

function topics() {
    return [...new Set(CATALOG.map(e => e.topic))].sort();
}

const FIND_ENTRY = {
    run: async (_root, args = {}) => {
        const hits = findApi(args.query || args.topic, args.limit);
        if (!hits.length) {
            throw new ToolError(`no catalogued API matches "${args.query || ""}" ` +
                `(topics: ${topics().join(", ")})`);
        }
        return {
            apis: hits.map(e => ({ name: e.name, topic: e.topic, what: e.what,
                                   example: e.example, terms: e.terms })),
            note: "Call one with http_fetch, editing the example URL for your query."
        };
    },
    help: 'find_api {"query": "molecular weight"} — find a free, keyless public API ' +
        "for a topic and get a working example URL to fetch (topics: " +
        topics().join(", ") + ")"
};

module.exports = { CATALOG, findApi, topics, FIND_ENTRY };
