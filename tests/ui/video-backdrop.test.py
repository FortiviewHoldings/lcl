"""Verify the MP4 backdrop: CSP allows it, it decodes, it's muted, and it stops when it should."""
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

# ensure a fresh session so the landing (and video) is on screen
ev("(async () => { if (!active || active.messages.length) await createSession(); return 'ok'; })()")
time.sleep(3)

meta = ev("""(() => {
  const v = document.getElementById('landing-video');
  if (!v) return {missing:true};
  return {
    readyState: v.readyState,          // 4 = HAVE_ENOUGH_DATA
    networkState: v.networkState,      // 1 = IDLE (loaded), 3 = NO_SOURCE
    videoW: v.videoWidth, videoH: v.videoHeight,
    duration: +v.duration.toFixed(2),
    muted: v.muted, loop: v.loop,
    paused: v.paused,
    error: v.error ? v.error.code + ':' + v.error.message : null,
    mode: document.documentElement.getAttribute('data-motion'),
    landingVisible: !document.getElementById('landing').classList.contains('hidden')
  };
})()""")
print(json.dumps(meta, indent=1))

check("CSP allows the video (no load error)", meta.get("error") is None and meta.get("networkState") != 3,
      meta.get("error") or f"networkState={meta.get('networkState')}")
check("video decoded at 1280x720", meta.get("videoW") == 1280 and meta.get("videoH") == 720,
      f'{meta.get("videoW")}x{meta.get("videoH")}')
check("duration ~5.16s", abs((meta.get("duration") or 0) - 5.16) < 0.2, meta.get("duration"))
check("muted and looping", meta.get("muted") is True and meta.get("loop") is True, meta)

# is it actually advancing?
t1 = ev("document.getElementById('landing-video').currentTime")
time.sleep(2.2)
t2 = ev("document.getElementById('landing-video').currentTime")
advancing = (t2 != t1)
check("clip is playing (currentTime advances)", advancing, f"{t1} -> {t2} mode={meta.get('mode')}")

# blur must stop DECODE, not just compositing
ev("setAnimPaused(true)")
time.sleep(0.5)
paused_state = ev("document.getElementById('landing-video').paused")
b1 = ev("document.getElementById('landing-video').currentTime")
time.sleep(1.5)
b2 = ev("document.getElementById('landing-video').currentTime")
check("blur/hidden pauses decode", paused_state is True and b1 == b2, f"paused={paused_state} {b1}=={b2}")
ev("setAnimPaused(false)")

# motion Off -> still frame, no decode
ev("motion.pref='off'; applyMotion();")
time.sleep(0.6)
off = ev("""({paused: document.getElementById('landing-video').paused,
              mode: document.documentElement.getAttribute('data-motion')})""")
check("motion Off gives a still frame", off["paused"] is True and off["mode"] == "still", json.dumps(off))

ev("motion.pref='auto'; applyMotion();")
time.sleep(1.0)

# leaving the landing must stop decode too
ev("dismissLanding()")
time.sleep(0.8)
after = ev("""({hidden: document.getElementById('landing').classList.contains('hidden'),
                paused: document.getElementById('landing-video').paused})""")
check("hiding the landing stops decode", after["hidden"] is True and after["paused"] is True, json.dumps(after))

# branding: new icon assets wired, logo still frozen
brand = ev("""({
  mark: document.getElementById('titlebar-mark').getAttribute('src'),
  markW: document.getElementById('titlebar-mark').naturalWidth,
  logo: document.getElementById('brand-logo').getAttribute('src'),
  logoW: document.getElementById('brand-logo').naturalWidth
})""")
check("titlebar uses small mark, sidebar logo untouched",
      brand["mark"].endswith("mark-small.png") and brand["markW"] == 64
      and brand["logo"].endswith("logo.png") and brand["logoW"] == 1672, json.dumps(brand))

# no CSP violations logged
errs = ev("""(window.__cspErrors || []).slice(0,5)""")
print("csp errors captured:", json.dumps(errs))

print()
passed = sum(1 for _, ok in results if ok)
print(f"{passed}/{len(results)} checks passed")
ws.close()
raise SystemExit(0 if passed == len(results) else 1)
