# Tesseract OCR data

Offline OCR for scanned pages. The WASM engine ships in `node_modules`
(`tesseract.js` + `tesseract.js-core`); only the **language data** lives here,
and it is gitignored — 23 MB of re-downloadable binary does not belong in the
repo, same rule as the `.gguf` weights.

`eng.traineddata` must be present or OCR reports itself unavailable and the
`read_image_text` tool is simply not offered. Nothing else degrades.

## Fetching it

```bash
curl -sSL -o eng.traineddata.gz \
  https://github.com/naptha/tessdata/raw/gh-pages/4.0.0/eng.traineddata.gz
gzip -d eng.traineddata.gz
```

Expected: `eng.traineddata`, 23,466,654 bytes. Apache-2.0 (Google / tessdata_fast).

Once present, recognition is fully local: `ocrTools.js` pins `langPath` and
`cachePath` here with `gzip:false`, so tesseract.js never fetches language data
at runtime — which it would otherwise do on first use, breaking the offline
guarantee.

## Why there is a quality gate

Measured on a large scanned document set (1551 page captures):

| source resolution | pages | confidence | real-word ratio | text/page |
|---|---|---|---|---|
| 2048x1152 | 658 | 59 | 0.174 | 2493 chars |
| 1280x720  | 893 | 44 | 0.072 | 106 chars |

A letter-size page captured at 720px tall renders body text at ~6-8 pixels —
below what any OCR engine can resolve, and upscaling cannot invent detail that
was never captured. Indexing that output would fill search results with noise,
so `ocrTools.recognize` rejects it (on dimensions first, before paying ~2s of
recognition) and says why. The pages that *are* readable index cleanly.
