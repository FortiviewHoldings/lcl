"""Verify: sidebar logo gone, intro plays ONCE per visit with sound, silent in-session."""
import json, time, urllib.request
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

# --- 1. sidebar logo removed ---
side = ev("""({
  brandEl: !!document.getElementById('brand'),
  logoEl: !!document.getElementById('brand-logo'),
  anyLogoImg: [...document.querySelectorAll('#sidebar img')].length,
  firstChild: document.getElementById('sidebar').firstElementChild.id
})""")
check("sidebar logo removed", side["brandEl"] is False and side["logoEl"] is False
      and side["anyLogoImg"] == 0, json.dumps(side))
check("sidebar now starts with New session", side["firstChild"] == "new-session", side["firstChild"])

# --- 2. fresh session -> intro plays once, from the start, unmuted ---
ev("(async () => { await createSession(); return 'ok'; })()")
time.sleep(1.2)
start = ev("""({
  loop: document.getElementById('landing-video').loop,
  paused: document.getElementById('landing-video').paused,
  muted: document.getElementById('landing-video').muted,
  t: +document.getElementById('landing-video').currentTime.toFixed(2),
  autoplayAttr: document.getElementById('landing-video').hasAttribute('autoplay'),
  mode: document.documentElement.getAttribute('data-motion')
})""")
print("at start:", json.dumps(start))
check("loop disabled", start["loop"] is False)
check("no autoplay attribute (JS drives it)", start["autoplayAttr"] is False)
check("intro started playing", start["paused"] is False, json.dumps(start))
check("intro has sound (not muted)", start["muted"] is False,
      "muted=True — autoplay policy may have blocked audio")

# --- 3. it ENDS and does not restart (one shot) ---
print("waiting for the 5.16s clip to finish...")
time.sleep(6.5)
done = ev("""({
  ended: document.getElementById('landing-video').ended,
  paused: document.getElementById('landing-video').paused,
  t: +document.getElementById('landing-video').currentTime.toFixed(2)
})""")
print("after end:", json.dumps(done))
check("played once then stopped (no loop)", done["ended"] is True and done["t"] > 5.0,
      json.dumps(done))

# --- 4. entering a session stops it; it must not play in-session ---
ev("dismissLanding()")
time.sleep(0.8)
insession = ev("""({
  landingHidden: document.getElementById('landing').classList.contains('hidden'),
  paused: document.getElementById('landing-video').paused
})""")
check("silent + stopped inside a session",
      insession["landingHidden"] is True and insession["paused"] is True, json.dumps(insession))

# --- 5. revisiting the page replays the intro from 0 ---
ev("(async () => { await createSession(); return 'ok'; })()")
time.sleep(1.5)
again = ev("""({
  paused: document.getElementById('landing-video').paused,
  ended: document.getElementById('landing-video').ended,
  t: +document.getElementById('landing-video').currentTime.toFixed(2)
})""")
print("on revisit:", json.dumps(again))
check("intro replays from the start on a new visit",
      again["paused"] is False and again["ended"] is False and again["t"] < 3.0, json.dumps(again))

# --- 6. incidental re-renders must NOT restart it ---
t_before = ev("document.getElementById('landing-video').currentTime")
ev("updateLanding(); updateLanding(); renderSessionList(); 'ok'")
time.sleep(0.7)
t_after = ev("document.getElementById('landing-video').currentTime")
check("re-render does not restart the intro", t_after >= t_before,
      f"{t_before} -> {t_after}")

# --- 7. mute toggle works and persists ---
ev("document.getElementById('intro-sound').click()")
time.sleep(0.4)
muted = ev("""({muted: document.getElementById('landing-video').muted,
                cls: document.getElementById('intro-sound').className,
                icon: document.getElementById('intro-sound-icon').innerText})""")
check("mute button mutes the intro", muted["muted"] is True and "muted" in muted["cls"],
      json.dumps(muted))
persisted = ev("window.lcl.renderMode()")
check("mute preference persisted", persisted.get("introSound") is False,
      f'introSound={persisted.get("introSound")}')
ev("document.getElementById('intro-sound').click()")   # restore sound on

print()
passed = sum(1 for _, ok in results if ok)
print(f"{passed}/{len(results)} checks passed")
ws.close()
raise SystemExit(0 if passed == len(results) else 1)
