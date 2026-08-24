"""Verify the animation optimizations actually landed."""
import json, time, urllib.request
import websocket

with urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=8) as r:
    page = [t for t in json.load(r) if t.get("type") == "page"][0]
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60, suppress_origin=True)
n = [0]
def ev(e, timeout=180):
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
ev("(async () => { if (!active || active.messages.length) await createSession(); return 'ok'; })()")
time.sleep(2)

geo = ev("""(() => {
  const stage = document.querySelector('.anim-stage');
  const layers = [...document.querySelectorAll('.anim-layer')];
  const r = stage.getBoundingClientRect();
  const main = document.getElementById('main').getBoundingClientRect();
  const cs = getComputedStyle(layers[0]);
  return {
    dpr: window.devicePixelRatio,
    layerCount: layers.length,
    stageW: Math.round(r.width), stageH: Math.round(r.height),
    mainW: Math.round(main.width), mainH: Math.round(main.height),
    stageMpxAtDpr: +((r.width*window.devicePixelRatio*r.height*window.devicePixelRatio)/1e6).toFixed(2),
    oldFullBleedMpx: +((main.width*1.5*window.devicePixelRatio*main.height*1.5*window.devicePixelRatio)/1e6).toFixed(2),
    willChange: cs.willChange,
    timing: cs.animationTimingFunction,
    duration: cs.animationDuration,
    motionMode: document.documentElement.getAttribute('data-motion'),
    hasRotate: [...document.styleSheets].some(ss => { try {
        return [...ss.cssRules].some(r2 => r2.cssText && r2.cssText.includes('drift-c'));
      } catch { return false; } })
  };
})()""")
print(json.dumps(geo, indent=1))

check("layer count reduced to 2 (rotation layer removed)", geo["layerCount"] == 2, geo["layerCount"])
check("drift-c rotation keyframes gone", geo["hasRotate"] is False)
check("stage is bounded, not full-bleed",
      geo["stageW"] <= 640 and geo["stageMpxAtDpr"] < geo["oldFullBleedMpx"] / 3,
      f"{geo['stageMpxAtDpr']} Mpx vs old {geo['oldFullBleedMpx']} Mpx per layer")
check("permanent will-change removed", geo["willChange"] in ("auto", "none"), geo["willChange"])
check("steps() timing applied", "steps" in (geo["timing"] or ""), geo["timing"])
check("motion mode resolved", geo["motionMode"] in ("full", "lite", "off"), geo["motionMode"])

# motion toggle actually works now (used to be dead code)
before = ev("document.documentElement.getAttribute('data-motion')")
ev("menuActions['toggle-motion']()")
time.sleep(0.4)
label = ev("document.querySelector('.menu-panel button[data-action=\"toggle-motion\"]').textContent")
ev("menuActions['toggle-motion']()")
time.sleep(0.3)
off = ev("document.documentElement.getAttribute('data-motion')")
anim_off = ev("getComputedStyle(document.querySelector('.anim-layer.l1')).animationName")
ev("menuActions['toggle-motion']()")  # back to auto
check("motion toggle is wired (was dead code)", label.startswith("Background motion:"), label)
check("motion off actually stops animation", off == "off" and anim_off == "none", f"mode={off} anim={anim_off}")

# small mark used for the 17px icon
mark = ev("""({
  src: document.getElementById('titlebar-mark').getAttribute('src'),
  natural: document.getElementById('titlebar-mark').naturalWidth,
  logoUntouched: document.getElementById('brand-logo').getAttribute('src').endsWith('logo.png')
})""")
check("titlebar uses the small mark", mark["src"].endswith("mark-small.png") and mark["natural"] == 64,
      json.dumps(mark))
check("sidebar logo still frozen logo.png", mark["logoUntouched"] is True)

print()
passed = sum(1 for _, ok in results if ok)
print(f"{passed}/{len(results)} checks passed")
ws.close()
raise SystemExit(0 if passed == len(results) else 1)
