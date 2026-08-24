"""Verify the new wordmark + icon v2 are wired everywhere and nothing is text anymore."""
import json, os, time, urllib.request
import websocket

with urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=8) as r:
    page = [t for t in json.load(r) if t.get("type") == "page"][0]
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60, suppress_origin=True)
n = [0]
def ev(e, timeout=200):
    n[0] += 1
    ws.send(json.dumps({"id": n[0], "method": "Runtime.evaluate",
                        "params": {"expression": e, "returnByValue": True, "awaitPromise": True}}))
    ws.settimeout(timeout)
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == n[0]:
            if m["result"].get("exceptionDetails"):
                return {"err": str(m["result"]["exceptionDetails"].get("text"))}
            return m["result"]["result"].get("value")

results = []
def check(name, ok, detail=""):
    results.append((name, ok))
    print(("PASS" if ok else "FAIL"), "|", name, ("- " + str(detail)) if detail else "")

for _ in range(120):
    if ev("typeof ready !== 'undefined' && ready") is True:
        break
    time.sleep(2)

ev("(async () => { await createSession(); return 'ok'; })()")
time.sleep(1.5)

tb = ev("""(() => {
  const name = document.getElementById('titlebar-name');
  const mark = document.getElementById('titlebar-mark');
  const r = name.getBoundingClientRect();
  return {
    nameTag: name.tagName,
    nameSrc: name.getAttribute('src'),
    nameLoaded: name.naturalWidth > 0,
    nameNatural: name.naturalWidth + 'x' + name.naturalHeight,
    nameRendered: Math.round(r.width) + 'x' + Math.round(r.height),
    markSrc: mark.getAttribute('src'),
    markLoaded: mark.naturalWidth > 0,
    markNatural: mark.naturalWidth + 'x' + mark.naturalHeight
  };
})()""")
print("titlebar:", json.dumps(tb, indent=1))
check("top bar title is the wordmark image (not text)",
      tb["nameTag"] == "IMG" and tb["nameSrc"].endswith("wordmark-trim.png") and tb["nameLoaded"],
      tb["nameSrc"])
check("wordmark renders at a sane titlebar size",
      tb["nameRendered"].endswith("x13") and int(tb["nameRendered"].split("x")[0]) > 15,
      tb["nameRendered"])
check("top bar badge is icon v2 (758x704 -> 64x59)",
      tb["markSrc"].endswith("mark-small.png") and tb["markNatural"] == "64x59", tb["markNatural"])

ld = ev("""(() => {
  const t = document.getElementById('landing-title');
  const r = t.getBoundingClientRect();
  return {tag: t.tagName, src: t.getAttribute('src'), loaded: t.naturalWidth > 0,
          natural: t.naturalWidth + 'x' + t.naturalHeight,
          rendered: Math.round(r.width) + 'x' + Math.round(r.height),
          alt: t.getAttribute('alt')};
})()""")
print("landing:", json.dumps(ld, indent=1))
check("landing title is the wordmark image over the video",
      ld["tag"] == "IMG" and ld["src"].endswith("wordmark-trim.png") and ld["loaded"], ld["src"])
check("landing wordmark keeps its 1.805 ratio",
      abs((int(ld["rendered"].split("x")[0]) / int(ld["rendered"].split("x")[1])) - 1.805) < 0.05,
      ld["rendered"])
check("wordmark has an accessible label", ld["alt"] == ".lcl", ld["alt"])

# no leftover literal ".lcl" text nodes pretending to be the logo
stray = ev("""(() => {
  const ids = ['titlebar-name','landing-title'];
  return ids.map(id => { const el = document.getElementById(id);
    return {id, text: (el.textContent || '').trim()}; });
})()""")
check("no text fallback left in those slots",
      all(s["text"] == "" for s in stray), json.dumps(stray))

# video still the backdrop and still one-shot
vid = ev("""({paused: document.getElementById('landing-video').paused,
              loop: document.getElementById('landing-video').loop,
              muted: document.getElementById('landing-video').muted})""")
check("intro still plays once with sound", vid["loop"] is False and vid["muted"] is False,
      json.dumps(vid))

# assets on disk
files = {
    "wordmark.png": 0, "wordmark-trim.png": 0, "mark.png": 0,
    "mark-small.png": 0, "icon.png": 0, "icon.ico": 0, "landing.mp4": 0
}
base = r"C:\.lcl\ui\electron\assets"
missing = [f for f in files if not os.path.isfile(os.path.join(base, f))]
check("all brand assets present in the repo", not missing, f"missing={missing}")

print()
passed = sum(1 for _, ok in results if ok)
print(f"{passed}/{len(results)} checks passed")
ws.close()
raise SystemExit(0 if passed == len(results) else 1)
