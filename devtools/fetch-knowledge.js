/**
 * FETCH THE SHIPPED KNOWLEDGE CORPUS.
 *
 *     node devtools/fetch-knowledge.js           download what is missing
 *     node devtools/fetch-knowledge.js --list    show sources and licences
 *
 * 63 documents, every one redistributable — public domain, CC BY, CC BY-SA
 * or DSL. knowledge/MANIFEST.md carries the per-document attribution; this
 * file carries where each one came from, so the corpus can be rebuilt from
 * nothing. The PDFs are not committed: they are ~870 MB of immutable,
 * re-downloadable content, and two of them alone would blow past GitHub's
 * file-size limit.
 *
 * After fetching, rebuild the index the product actually ships:
 *     app> ./node_modules/.bin/electron ../devtools/build-knowledge-index.js
 *     node devtools/pack-knowledge-index.js
 *
 * Verification is by PDF structure, not by existence: a truncated download
 * keeps its %PDF header and loses its %%EOF trailer, and that exact failure
 * silently cost two volumes of the corpus once already.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const DOCS = [
    {
        "into": "knowledge/physics",
        "file": "Electromagnetics-I-Steven-W.-Ellingson-Virginia-Tech.pdf",
        "url": "https://vtechworks.lib.vt.edu/bitstreams/9c823491-b65b-4884-a6cb-8221febf270f/download",
        "licence": "CC BY-SA 4.0"
    },
    {
        "into": "knowledge/electrical",
        "file": "DOE-HDBK-1011-Electrical-Science-Vol1.pdf",
        "url": "https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1011-92_VOL1.pdf",
        "licence": "public domain"
    },
    {
        "into": "knowledge/electrical",
        "file": "DOE-HDBK-1011-Electrical-Science-Vol2.pdf",
        "url": "https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1011-92_VOL2.pdf",
        "licence": "public domain"
    },
    {
        "into": "knowledge/electrical",
        "file": "DOE-HDBK-1011-Electrical-Science-Vol3.pdf",
        "url": "https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1011-92_VOL3.pdf",
        "licence": "public domain"
    },
    {
        "into": "knowledge/electrical",
        "file": "DOE-HDBK-1011-Electrical-Science-Vol4.pdf",
        "url": "https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1011-92_VOL4.pdf",
        "licence": "public domain"
    },
    {
        "into": "knowledge/electrical",
        "file": "DOE-HDBK-1013-Instrumentation-Control-Vol1.pdf",
        "url": "https://www.osti.gov/servlets/purl/7295868",
        "licence": "public domain"
    },
    {
        "into": "knowledge/electrical",
        "file": "DOE-HDBK-1016-Engineering-Symbology-Vol1.pdf",
        "url": "https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1016-93_VOL1.pdf",
        "licence": "public domain (US Gov)"
    },
    {
        "into": "knowledge/electrical",
        "file": "DOE-HDBK-1016-Engineering-Symbology-Vol2.pdf",
        "url": "https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1016-93_VOL2.pdf",
        "licence": "public domain (US Gov)"
    },
    {
        "into": "knowledge/electrical",
        "file": "Kuphaldt-Lessons-In-Industrial-Instrumentation.pdf",
        "url": "https://www.ibiblio.org/kuphaldt/socratic/sinst/book/liii.pdf",
        "licence": "CC BY 4.0"
    },
    {
        "into": "knowledge/electrical",
        "file": "Kuphaldt-LIEC-Vol1-DC.pdf",
        "url": "https://www.ibiblio.org/kuphaldt/electricCircuits/DC/DC.pdf",
        "licence": "CC BY"
    },
    {
        "into": "knowledge/electrical",
        "file": "Kuphaldt-LIEC-Vol2-AC.pdf",
        "url": "https://www.ibiblio.org/kuphaldt/electricCircuits/AC/AC.pdf",
        "licence": "CC BY"
    },
    {
        "into": "knowledge/electrical",
        "file": "Kuphaldt-LIEC-Vol3-Semiconductors.pdf",
        "url": "https://www.ibiblio.org/kuphaldt/electricCircuits/Semi/SEMI.pdf",
        "licence": "CC BY"
    },
    {
        "into": "knowledge/electrical",
        "file": "Kuphaldt-LIEC-Vol4-Digital.pdf",
        "url": "https://www.ibiblio.org/kuphaldt/electricCircuits/Digital/DIGI.pdf",
        "licence": "CC BY"
    },
    {
        "into": "knowledge/electrical",
        "file": "Kuphaldt-LIEC-Vol5-Reference.pdf",
        "url": "https://www.ibiblio.org/kuphaldt/electricCircuits/Ref/REF.pdf",
        "licence": "CC BY"
    },
    {
        "into": "knowledge/electrical",
        "file": "Kuphaldt-LIEC-Vol6-Experiments.pdf",
        "url": "https://www.ibiblio.org/kuphaldt/electricCircuits/Exper/EXP.pdf",
        "licence": "CC BY"
    },
    {
        "into": "knowledge/electrical",
        "file": "NASA-EEE-INST-002-derating.pdf",
        "url": "https://nepp.nasa.gov/docuploads/FFB52B88-36AE-4378-A05B2C084B5EE2CC/EEE-INST-002_add1.pdf",
        "licence": "public domain"
    },
    {
        "into": "knowledge/electrical",
        "file": "NBS-Handbook-100-Copper-Wire-Tables.pdf",
        "url": "https://archive.org/download/copperwiretables100unit/copperwiretables100unit.pdf",
        "licence": "public domain"
    },
    {
        "into": "knowledge/electrical",
        "file": "NIST-Monograph-175-thermocouple-reference.pdf",
        "url": "https://nvlpubs.nist.gov/nistpubs/Legacy/MONO/nistmonograph175.pdf",
        "licence": "public domain"
    },
    {
        "into": "knowledge/logic",
        "file": "forall-x-Calgary---An-Introduction-to-Formal-Logic.pdf",
        "url": "https://forallx.openlogicproject.org/forallxyyc.pdf",
        "licence": "CC BY 4.0"
    },
    {
        "into": "knowledge/logic",
        "file": "The-Open-Logic-Text-Complete-Build.pdf",
        "url": "https://builds.openlogicproject.org/open-logic-complete.pdf",
        "licence": "CC BY 4.0"
    },
    {
        "into": "knowledge/mathematics",
        "file": "Abstract-Algebra-Theory-and-Applications-Judson-2025-annual-edition.pdf",
        "url": "https://judsonbooks.org/aata-files/aata-20250801.pdf",
        "licence": "GFDL 1.2+ (copyleft; commercial redistribution permitted but license text must accompany copies; not CC)"
    },
    {
        "into": "knowledge/mathematics",
        "file": "Basic-Analysis-I-Introduction-to-Real-Analysis-Vol.-1-Jiri-Lebl-v6.3.pdf",
        "url": "https://www.jirka.org/ra/realanal.pdf",
        "licence": "Dual: CC BY-SA 4.0 or CC BY-NC-SA 4.0 (shippable under the BY-SA option)"
    },
    {
        "into": "knowledge/mathematics",
        "file": "Basic-Analysis-II-Introduction-to-Real-Analysis-Vol.-2-Jiri-Lebl-v6.3.pdf",
        "url": "https://www.jirka.org/ra/realanal2.pdf",
        "licence": "Dual: CC BY-SA 4.0 or CC BY-NC-SA 4.0 (shippable under the BY-SA option)"
    },
    {
        "into": "knowledge/mathematics",
        "file": "DOE-HDBK-1014-Mathematics-Vol1.pdf",
        "url": "https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1014-92_VOL1.pdf",
        "licence": "public domain (US Gov)"
    },
    {
        "into": "knowledge/mathematics",
        "file": "DOE-HDBK-1014-Mathematics-Vol2.pdf",
        "url": "https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1014-92_VOL2.pdf",
        "licence": "public domain (US Gov)"
    },
    {
        "into": "knowledge/mathematics",
        "file": "Fundamentals-of-Calculus-Benjamin-Crowell---math-support-for-physics.pdf",
        "url": "https://archive.org/download/fund_20220102/fund.pdf",
        "licence": "CC BY-SA 4.0"
    },
    {
        "into": "knowledge/mathematics",
        "file": "Homotopy-Type-Theory-Univalent-Foundations-of-Mathematics-HoTT-Book.pdf",
        "url": "https://hott.github.io/book/hott-online-82-g578b85c.pdf",
        "licence": "CC BY-SA 3.0 Unported"
    },
    {
        "into": "knowledge/mathematics",
        "file": "Linear-Algebra-Jim-Hefferon-4th-ed..pdf",
        "url": "https://jheffero.w3.uvm.edu/linearalgebra/book.pdf",
        "licence": "Dual: GFDL or CC BY-SA (author's choice clause)"
    },
    {
        "into": "knowledge/mathematics",
        "file": "Mathematics-for-Computer-Science-LehmanLeightonMeyer-June-2018-revision.pdf",
        "url": "https://courses.csail.mit.edu/6.042/spring18/mcs.pdf",
        "licence": "CC BY-SA 3.0 (stated on the book's own copyright page; the OCW course wrapper is NC but the book is not)"
    },
    {
        "into": "knowledge/mechanical",
        "file": "DOE-HDBK-1017-Material-Science-Vol1.pdf",
        "url": "https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1017-93_VOL1.pdf",
        "licence": "public domain (US Gov)"
    },
    {
        "into": "knowledge/mechanical",
        "file": "DOE-HDBK-1017-Material-Science-Vol2.pdf",
        "url": "https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1017-93_VOL2.pdf",
        "licence": "public domain (US Gov)"
    },
    {
        "into": "knowledge/mechanical",
        "file": "DOE-HDBK-1018-Mechanical-Science-Vol1.pdf",
        "url": "https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1018-93_VOL1.pdf",
        "licence": "public domain (US Gov)"
    },
    {
        "into": "knowledge/mechanical",
        "file": "DOE-HDBK-1018-Mechanical-Science-Vol2.pdf",
        "url": "https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1018-93_VOL2.pdf",
        "licence": "public domain (US Gov)"
    },
    {
        "into": "knowledge/mechanical",
        "file": "FED-STD-H28-21B-metric-threads.pdf",
        "url": "https://everyspec.com/FED-STD/download.php?spec=FED-STD-H28_21B.040274.pdf",
        "licence": "public domain"
    },
    {
        "into": "knowledge/mechanical",
        "file": "FED-STD-H28A-screw-thread-standards.pdf",
        "url": "https://everyspec.com/FED-STD/download.php?spec=FED-STD-H28A.022694.pdf",
        "licence": "public domain"
    },
    {
        "into": "knowledge/mechanical",
        "file": "MIL-HDBK-5J-metallic-materials.pdf",
        "url": "https://everyspec.com/MIL-HDBK/MIL-HDBK-0001-0099/download.php?spec=MIL_HDBK_5J.139.pdf",
        "licence": "public domain"
    },
    {
        "into": "knowledge/mechanical",
        "file": "NASA-RP-1228-Fastener-Design-Manual.pdf",
        "url": "https://archive.org/download/NASA_NTRS_Archive_19900009424/NASA_NTRS_Archive_19900009424.pdf",
        "licence": "public domain"
    },
    {
        "into": "knowledge/mechanical",
        "file": "TC-9-524-Fundamentals-of-Machine-Tools.pdf",
        "url": "https://armypubs.army.mil/epubs/DR_pubs/DR_a/pdf/web/tc9_524.pdf",
        "licence": "public domain"
    },
    {
        "into": "knowledge/metrology",
        "file": "BIPM-SI-Brochure-9.pdf",
        "url": "https://www.bipm.org/documents/20126/41483022/SI-Brochure-9.pdf",
        "licence": "CC BY 4.0"
    },
    {
        "into": "knowledge/metrology",
        "file": "NIST-SP-330-2019-SI.pdf",
        "url": "https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.330-2019.pdf",
        "licence": "public domain"
    },
    {
        "into": "knowledge/metrology",
        "file": "NIST-SP-811-2008-SI-guide.pdf",
        "url": "https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication811e2008.pdf",
        "licence": "public domain"
    },
    {
        "into": "knowledge/metrology",
        "file": "NIST-TN-1297-uncertainty.pdf",
        "url": "https://nvlpubs.nist.gov/nistpubs/Legacy/TN/nbstechnicalnote1297.pdf",
        "licence": "public domain"
    },
    {
        "into": "knowledge/physics",
        "file": "CODATA-2022-paper-RevModPhys.pdf",
        "url": "https://arxiv.org/pdf/2409.03787",
        "licence": "CC BY 4.0"
    },
    {
        "into": "knowledge/physics",
        "file": "Conceptual-Physics-Benjamin-Crowell.pdf",
        "url": "https://archive.org/download/cp_20220102/cp.pdf",
        "licence": "CC BY-SA 4.0"
    },
    {
        "into": "knowledge/physics",
        "file": "DOE-HDBK-1010-Classical-Physics.pdf",
        "url": "https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1010-92.pdf",
        "licence": "public domain (US Gov)"
    },
    {
        "into": "knowledge/physics",
        "file": "DOE-HDBK-1012-Thermo-HeatTransfer-FluidFlow-Vol1.pdf",
        "url": "https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1012-92_VOL1.pdf",
        "licence": "public domain (US Gov)"
    },
    {
        "into": "knowledge/physics",
        "file": "DOE-HDBK-1012-Thermo-HeatTransfer-FluidFlow-Vol2.pdf",
        "url": "https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1012-92_VOL2.pdf",
        "licence": "public domain (US Gov)"
    },
    {
        "into": "knowledge/physics",
        "file": "DOE-HDBK-1012-Thermo-HeatTransfer-FluidFlow-Vol3.pdf",
        "url": "https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1012-92_VOL3.pdf",
        "licence": "public domain (US Gov)"
    },
    {
        "into": "knowledge/physics",
        "file": "DOE-HDBK-1015-Chemistry-Vol1.pdf",
        "url": "https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1015-93_VOL1.pdf",
        "licence": "public domain (US Gov)"
    },
    {
        "into": "knowledge/physics",
        "file": "DOE-HDBK-1015-Chemistry-Vol2.pdf",
        "url": "https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1015-93_VOL2.pdf",
        "licence": "public domain (US Gov)"
    },
    {
        "into": "knowledge/physics",
        "file": "DOE-HDBK-1019-Nuclear-Physics-Reactor-Theory-Vol1.pdf",
        "url": "https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1019-93_VOL1.pdf",
        "licence": "public domain (US Gov)"
    },
    {
        "into": "knowledge/physics",
        "file": "DOE-HDBK-1019-Nuclear-Physics-Reactor-Theory-Vol2.pdf",
        "url": "https://www.energy.gov/sites/default/files/2026-04/DOE-HDBK-1019-93_VOL2.pdf",
        "licence": "public domain (US Gov)"
    },
    {
        "into": "knowledge/physics",
        "file": "Fields-and-Circuits-Benjamin-Crowell---EM-Simple-Nature-successor-vol.-2.pdf",
        "url": "https://archive.org/download/fac_20220102/fac.pdf",
        "licence": "CC BY-SA 4.0"
    },
    {
        "into": "knowledge/physics",
        "file": "General-Relativity-Benjamin-Crowell.pdf",
        "url": "https://archive.org/download/genrel/genrel.pdf",
        "licence": "CC BY-SA 4.0"
    },
    {
        "into": "knowledge/physics",
        "file": "Light-and-Matter-Benjamin-Crowell---algebra-based-intro-physics.pdf",
        "url": "https://archive.org/download/lm_20220102/lm.pdf",
        "licence": "CC BY-SA 4.0"
    },
    {
        "into": "knowledge/physics",
        "file": "Maxwell---A-Treatise-on-Electricity-and-Magnetism-Vol.-1-1873.pdf",
        "url": "https://archive.org/download/electricandmagne01maxwrich/electricandmagne01maxwrich.pdf",
        "licence": "Public domain (published 1873)"
    },
    {
        "into": "knowledge/physics",
        "file": "Maxwell---A-Treatise-on-Electricity-and-Magnetism-Vol.-2-1873.pdf",
        "url": "https://archive.org/download/electricandmagne02maxwrich/electricandmagne02maxwrich.pdf",
        "licence": "Public domain (published 1873)"
    },
    {
        "into": "knowledge/physics",
        "file": "Mechanics-Benjamin-Crowell---calculus-based-Simple-Nature-successor-vol.-1.pdf",
        "url": "https://archive.org/download/me_20220102/me.pdf",
        "licence": "CC BY-SA 4.0"
    },
    {
        "into": "knowledge/physics",
        "file": "Modern-Physics-Benjamin-Crowell---relativity-and-quantum-Simple-Nature-successor.pdf",
        "url": "https://archive.org/download/mod_20220102/mod.pdf",
        "licence": "CC BY-SA 4.0"
    },
    {
        "into": "knowledge/physics",
        "file": "Planck---Treatise-on-Thermodynamics-1903-English-translation.pdf",
        "url": "https://archive.org/download/treatiseonthermo00planuoft/treatiseonthermo00planuoft.pdf",
        "licence": "Public domain (pre-1930 publication)"
    },
    {
        "into": "knowledge/physics",
        "file": "Problems-in-Introductory-Physics-Crowell-Shotwell.pdf",
        "url": "https://www.lightandmatter.com/problems/problems.pdf",
        "licence": "CC BY-SA 4.0"
    },
    {
        "into": "knowledge/physics",
        "file": "Relativity-for-Poets-Benjamin-Crowell---nonmathematical-relativity.pdf",
        "url": "https://dn720001.ca.archive.org/0/items/poets_202201/poets.pdf",
        "licence": "CC BY-SA 4.0"
    },
    {
        "into": "knowledge/physics",
        "file": "Special-Relativity-Benjamin-Crowell.pdf",
        "url": "https://archive.org/download/sr_20220102/sr.pdf",
        "licence": "CC BY-SA 4.0"
    },
    {
        "into": "knowledge/physics",
        "file": "US-Standard-Atmosphere-1976.pdf",
        "url": "https://www.ngdc.noaa.gov/stp/space-weather/online-publications/miscellaneous/us-standard-atmosphere-1976/us-standard-atmosphere_st76-1562_noaa.pdf",
        "licence": "public domain"
    }
];

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function get(url, dest, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 6) return reject(new Error("too many redirects"));
        https.get(url, { headers: { "User-Agent": "lcl-knowledge-fetch/1.0" } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(get(new URL(res.headers.location, url).href, dest, redirects + 1));
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
            const out = fs.createWriteStream(dest);
            res.pipe(out);
            out.on("finish", () => out.close(() => resolve()));
            out.on("error", reject);
        }).on("error", reject);
    });
}

/** A PDF that lost its tail still has its head — check both ends. */
function looksComplete(file) {
    const buf = fs.readFileSync(file);
    if (buf.length < 1024) return false;
    if (buf.slice(0, 4).toString() !== "%PDF") return /\.txt$/i.test(file);
    return buf.slice(-2048).toString("latin1").includes("%%EOF");
}

/* WHERE EACH DOCUMENT CAME FROM, READABLE BY SOMETHING OTHER THAN THIS SCRIPT.
 *
 * knowledge/MANIFEST.md says "the source files are re-fetchable from the URLs
 * recorded here" and records not one URL — they have only ever existed in the
 * DOCS array above, in a devtool that a packaged build does not ship. That is
 * why an installed copy could say nothing better than "not on disk" about a
 * document it knows the title, page count and full text of.
 *
 * So DOCS is exported, and devtools/build-knowledge-sources.js writes it out as
 * knowledge/sources.json, which DOES ship. One source of truth, still this file.
 *
 * The download itself stays behind `require.main === module`: exporting a
 * fetcher that starts fetching the moment anything reads it would be a network
 * call nobody asked for. */
module.exports = { DOCS };
if (require.main !== module) return;

(async () => {
    if (process.argv.includes("--list")) {
        for (const d of DOCS) console.log(`${d.into}/${d.file}\n   ${dim(d.licence + " — " + d.url)}`);
        return;
    }
    let got = 0, had = 0;
    const failed = [];
    for (const d of DOCS) {
        const dir = path.join(ROOT, d.into);
        const dest = path.join(dir, d.file);
        if (fs.existsSync(dest) && looksComplete(dest)) { had++; continue; }
        fs.mkdirSync(dir, { recursive: true });
        process.stdout.write(`   ${bold("get")} ${d.into}/${d.file} `);
        try {
            await get(d.url, dest);
            if (!looksComplete(dest)) throw new Error("incomplete download");
            console.log(green("ok"));
            got++;
        } catch (e) {
            try { fs.rmSync(dest, { force: true }); } catch { /* nothing written */ }
            console.log(red("fail — " + e.message));
            failed.push(d.into + "/" + d.file);
        }
    }
    console.log(`\n${got} fetched, ${had} already present` +
        (failed.length ? `, ${red(failed.length + " failed")}` : ""));
    if (failed.length) {
        console.log(failed.map(f => "   " + f).join("\n"));
        console.log(dim("\nA failed host is usually temporary — re-run to retry just those."));
        process.exit(1);
    }
})().catch(e => { console.error(red("fatal: " + e.message)); process.exit(1); });
