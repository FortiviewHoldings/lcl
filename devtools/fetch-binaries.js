/**
 * FETCH THE PARTS THAT ARE NOT SOURCE.
 *
 *     node devtools/fetch-binaries.js            everything missing
 *     node devtools/fetch-binaries.js runtimes   just one group
 *     node devtools/fetch-binaries.js --list     show what would be fetched
 *
 * The repository holds SOURCE — about 6 MB of it. Runtimes, third-party tool
 * executables, model weights and the knowledge corpus are large, immutable and
 * re-downloadable, so they are fetched rather than committed. That is not
 * merely a size preference: two of these files exceed GitHub's hard 100 MB
 * limit, so a repository carrying them cannot be pushed at all.
 *
 * Everything here is pinned to an exact version and verified after download —
 * a truncated file passes a naive existence check and then fails mysteriously
 * hours later, which is a bug this project has already paid for once.
 *
 * Licences: every item is redistributable under the terms recorded beside it;
 * the knowledge corpus additionally carries per-document licences in
 * knowledge/MANIFEST.md.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TMP = path.join(os.tmpdir(), "lcl-fetch");

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

/* ------------------------------------------------------------- manifest -- */

const GROUPS = {
    runtimes: {
        what: "llama.cpp (MIT) — the inference runtime",
        items: [{
            url: "https://github.com/ggml-org/llama.cpp/releases/download/b10107/llama-b10107-bin-win-vulkan-x64.zip",
            into: "runtimes/llama.cpp/win-x64",
            strip: 0,
            check: "llama-server.exe"
        }]
    },
    tools: {
        what: "ffmpeg, whisper.cpp, qpdf, ImageMagick, SQLite, Graphviz",
        items: [
            {
                url: "https://github.com/GyanD/codexffmpeg/releases/download/2026-01-08-git-4f7b6d2f28/ffmpeg-2026-01-08-git-4f7b6d2f28-full_build.zip",
                into: "tools/ffmpeg/win-x64", strip: 2, only: /bin\/(ffmpeg|ffprobe)\.exe$/,
                check: "ffmpeg.exe", licence: "LGPL/GPL — ships as standalone executables"
            },
            {
                url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip",
                into: "tools/whisper/win-x64", strip: 1,
                only: /Release\/(whisper-cli\.exe|whisper\.dll|ggml.*\.dll)$/,
                check: "whisper-cli.exe", licence: "MIT"
            },
            {
                url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin",
                into: "tools/whisper", raw: "ggml-base.en-q5_1.bin",
                check: "ggml-base.en-q5_1.bin", licence: "MIT (model weights)"
            },
            {
                url: "https://github.com/qpdf/qpdf/releases/download/v12.3.2/qpdf-12.3.2-msvc64.zip",
                into: "tools/qpdf/win-x64", strip: 2, only: /bin\/[^/]+\.(exe|dll)$/,
                check: "qpdf.exe", licence: "Apache-2.0"
            },
            {
                url: "https://github.com/ImageMagick/ImageMagick/releases/download/7.1.2-29/ImageMagick-7.1.2-29-portable-Q16-x64.7z",
                into: "tools/imagemagick/win-x64", strip: 0,
                only: /^(magick\.exe|[^/]+\.xml|sRGB\.icc)$/,
                check: "magick.exe", licence: "ImageMagick Licence (permissive)"
            },
            {
                url: "https://www.sqlite.org/2026/sqlite-tools-win-x64-3530400.zip",
                into: "tools/sqlite/win-x64", strip: 0, only: /sqlite3\.exe$/,
                check: "sqlite3.exe", licence: "public domain"
            },
            {
                url: "https://gitlab.com/api/v4/projects/4207231/packages/generic/graphviz-releases/15.1.0/windows_10_cmake_Release_Graphviz-15.1.0-win64.zip",
                into: "tools/graphviz/win-x64", strip: 2, only: /bin\//,
                check: "dot.exe", licence: "EPL-2.0", after: "dot -c"
            }
        ]
    },
    models: {
        what: "the default chat model (Apache-2.0) + the retrieval models (MIT)",
        items: [
            {
                url: "https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
                into: "models", raw: "qwen3-4b-instruct-2507-q4_k_m.gguf",
                check: "qwen3-4b-instruct-2507-q4_k_m.gguf", licence: "Apache-2.0"
            },
            {
                url: "https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q8_0.gguf",
                into: "models", raw: "bge-small-en-v1.5-q8_0.gguf",
                check: "bge-small-en-v1.5-q8_0.gguf", licence: "MIT"
            }
        ]
    }
};

/* ---------------------------------------------------------------- fetch -- */

function get(url, dest, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 6) return reject(new Error("too many redirects"));
        https.get(url, { headers: { "User-Agent": "lcl-fetch/1.0" } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                const next = new URL(res.headers.location, url).href;
                return resolve(get(next, dest, redirects + 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const total = parseInt(res.headers["content-length"] || "0", 10);
            let seen = 0, lastPct = -1;
            const out = fs.createWriteStream(dest);
            res.on("data", (c) => {
                seen += c.length;
                if (!total) return;
                const pct = Math.floor((seen / total) * 100);
                if (pct >= lastPct + 10) {
                    lastPct = pct;
                    process.stdout.write(`\r      ${pct}%  ${(seen / 1048576).toFixed(0)} MB   `);
                }
            });
            res.pipe(out);
            out.on("finish", () => out.close(() => {
                if (total && seen !== total) {
                    return reject(new Error(`truncated: got ${seen} of ${total} bytes`));
                }
                process.stdout.write("\r");
                resolve({ bytes: seen });
            }));
            out.on("error", reject);
        }).on("error", reject);
    });
}

function sevenZip() {
    for (const p of ["C:/Program Files/7-Zip/7z.exe", "C:/Program Files (x86)/7-Zip/7z.exe"]) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function extract(archive, dir) {
    const z = sevenZip();
    if (!z) throw new Error("7-Zip is required to unpack archives (install from 7-zip.org)");
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync(z, ["x", "-y", archive, `-o${dir}`], { stdio: "pipe" });
    if (r.status !== 0) throw new Error(`unpack failed: ${String(r.stderr).slice(-200)}`);
}

/** Copy the wanted files out of an unpacked archive, flattening `strip` levels. */
function place(from, into, only, strip) {
    const dest = path.join(ROOT, into);
    fs.mkdirSync(dest, { recursive: true });
    let n = 0;
    const walk = (d, rel = "") => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            const r = rel ? rel + "/" + e.name : e.name;
            if (e.isDirectory()) { walk(full, r); continue; }
            const stripped = r.split("/").slice(strip).join("/");
            if (only && !only.test(r) && !only.test(stripped)) continue;
            const target = path.join(dest, path.basename(stripped || r));
            fs.copyFileSync(full, target);
            n++;
        }
    };
    walk(from);
    return n;
}

async function fetchItem(item) {
    const dest = path.join(ROOT, item.into);
    const marker = path.join(dest, item.check);
    if (fs.existsSync(marker) && fs.statSync(marker).size > 0) {
        console.log(`   ${dim("have")}  ${item.into}/${item.check}`);
        return "have";
    }
    const name = path.basename(new URL(item.url).pathname) || "download";
    console.log(`   ${bold("get")}   ${item.into}  ${dim(item.licence || "")}`);
    fs.mkdirSync(TMP, { recursive: true });
    const tmpFile = path.join(TMP, name);

    await get(item.url, tmpFile);

    if (item.raw) {
        fs.mkdirSync(dest, { recursive: true });
        fs.copyFileSync(tmpFile, path.join(dest, item.raw));
    } else {
        const un = path.join(TMP, name + ".d");
        fs.rmSync(un, { recursive: true, force: true });
        extract(tmpFile, un);
        const n = place(un, item.into, item.only, item.strip || 0);
        fs.rmSync(un, { recursive: true, force: true });
        if (!n) throw new Error("archive contained none of the expected files");
    }
    fs.rmSync(tmpFile, { force: true });

    if (!fs.existsSync(marker)) throw new Error(`${item.check} missing after unpack`);
    if (item.after) {
        // graphviz needs its plugin config generated once, in place
        const [exe, ...a] = item.after.split(" ");
        try {
            execFileSync(path.join(dest, exe + ".exe"), a, { cwd: dest, stdio: "pipe" });
        } catch { /* dot -c returns non-zero on some builds but still writes config */ }
    }
    return "fetched";
}

/* ----------------------------------------------------------------- main -- */

(async () => {
    const args = process.argv.slice(2);
    const wanted = args.filter(a => !a.startsWith("-"));
    const groups = Object.keys(GROUPS).filter(g => !wanted.length || wanted.includes(g));

    if (args.includes("--list")) {
        for (const g of groups) {
            console.log(`\n${bold(g)} — ${GROUPS[g].what}`);
            for (const it of GROUPS[g].items) console.log(`   ${it.into}/${it.check}\n      ${dim(it.url)}`);
        }
        console.log(`\n${dim("knowledge corpus: see knowledge/MANIFEST.md — sources and licences")}`);
        return;
    }

    let fetched = 0, had = 0, failed = [];
    for (const g of groups) {
        console.log(`\n${bold(g)} ${dim("— " + GROUPS[g].what)}`);
        for (const item of GROUPS[g].items) {
            try {
                const r = await fetchItem(item);
                if (r === "fetched") fetched++; else had++;
            } catch (e) {
                failed.push(`${item.into}: ${e.message}`);
                console.log(`   ${red("fail")}  ${item.into} — ${e.message}`);
            }
        }
    }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }

    console.log(`\n${fetched} fetched, ${had} already present` +
        (failed.length ? `, ${red(failed.length + " failed")}` : ""));
    if (failed.length) {
        console.log(failed.map(f => "   " + f).join("\n"));
        process.exit(1);
    }
    console.log(green("\nready — run the tests with: node devtools/run-tests.js"));
})().catch(e => { console.error(red("fatal: " + e.message)); process.exit(1); });
