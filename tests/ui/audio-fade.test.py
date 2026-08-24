"""Sample video.volume across the whole intro to prove the tail actually fades."""
import ctypes, json, time, urllib.request
import websocket

# The app pauses the clip on blur (deliberately). Foreground the window or the
# test measures a paused video.
user32 = ctypes.windll.user32
user32.SetProcessDPIAware()
_hwnd = user32.FindWindowW(None, ".lcl")
if _hwnd:
    user32.ShowWindow(_hwnd, 9)          # SW_RESTORE
    user32.SetForegroundWindow(_hwnd)
    time.sleep(2)

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

print(f"fade window: {ev('INTRO_FADE_SEC')}s of a {ev('document.getElementById(\"landing-video\").duration')}s clip\n")

# record (currentTime, volume) pairs in-page for the whole playthrough
ev("""(async () => {
  window.__samples = [];
  if (!active || active.messages.length) await createSession();
  else { landingDismissed.delete(active.id); introPlayedFor = null; updateLanding(); }
  const v = document.getElementById('landing-video');
  const rec = setInterval(() => {
    window.__samples.push([+v.currentTime.toFixed(2), +v.volume.toFixed(3), v.paused, v.ended]);
  }, 100);
  setTimeout(() => clearInterval(rec), 8000);
  return 'recording';
})()""")

time.sleep(9)
samples = ev("window.__samples") or []
print(f"{len(samples)} samples")
for t, vol, paused, ended in samples[::3]:
    bar = "#" * int(round(vol * 34))
    flag = " PAUSED" if paused else (" ENDED" if ended else "")
    print(f"  t={t:>5.2f}  vol={vol:>5.3f} {bar}{flag}")

vols = [(t, v) for t, v, p, e in samples]
check("samples were captured", len(samples) > 20, len(samples))

early = [v for t, v in vols if t < 3.0]
check("full volume before the fade window",
      bool(early) and min(early) > 0.98, f"min early vol {min(early) if early else 'n/a'}")

tail = [v for t, v in vols if t >= 5.16 - 1.6 and t <= 5.16]
check("volume decreasing across the tail",
      bool(tail) and min(tail) < 0.5, f"min tail vol {min(tail) if tail else 'n/a'}")

final = [v for t, v, p, e in samples if e]
check("lands on silence at the end", bool(final) and max(final) == 0.0,
      f"volume once ended: {set(final) if final else 'never ended'}")

# monotonic (non-increasing) through the fade
tail_sorted = sorted([(t, v) for t, v in vols if t >= 3.6], key=lambda x: x[0])
mono = all(tail_sorted[i][1] <= tail_sorted[i - 1][1] + 0.02 for i in range(1, len(tail_sorted)))
check("fade is monotonic (no pumping)", mono,
      f"{len(tail_sorted)} tail samples")

print()
passed = sum(1 for _, ok in results if ok)
print(f"{passed}/{len(results)} checks passed")
ws.close()
raise SystemExit(0 if passed == len(results) else 1)
