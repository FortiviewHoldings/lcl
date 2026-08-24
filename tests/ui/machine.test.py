"""Verify commit-based stats, idle unload, and the machine view."""
import ctypes, json, subprocess, time, urllib.request
import websocket

u = ctypes.windll.user32
u.SetProcessDPIAware()
h = u.FindWindowW(None, ".lcl")
if h:
    u.ShowWindow(h, 9); u.SetForegroundWindow(h); time.sleep(1.5)

with urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=8) as r:
    page = [t for t in json.load(r) if t.get("type") == "page"][0]
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60, suppress_origin=True)
n = [0]
def ev(e, timeout=300):
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

# --- 1. commit-based stats ---
s = ev("window.lcl.systemStats()")
print("\n[stats]", json.dumps({k: (round(v/1073741824, 2) if isinstance(v, (int, float)) and abs(v) > 1e6 else v)
                               for k, v in s.items()}, indent=1))
check("reports commit, not just free RAM",
      s.get("commitUsedBytes", 0) > 0 and s.get("commitLimitBytes", 0) > 0, "")
check("commit exceeds physical (matches PowerShell reading)",
      s["commitUsedBytes"] > s["physTotalBytes"],
      f"{round(s['commitUsedBytes']/1073741824,2)} GB committed vs {round(s['physTotalBytes']/1073741824,2)} GB RAM")
check("pressure computed and classified critical",
      s["pressure"] > 1.0 and s["level"] == "critical", f"pressure={round(s['pressure'],2)} level={s['level']}")
check("overcommit quantified",
      s["overcommitBytes"] > 0, f"{round(s['overcommitBytes']/1073741824,2)} GB over")

# cross-check against Windows itself
ps = subprocess.run(["powershell","-NoProfile","-Command",
    "$o=Get-CimInstance Win32_OperatingSystem; "
    "[math]::Round(($o.TotalVirtualMemorySize-$o.FreeVirtualMemory)/1MB,2)"],
    capture_output=True, text=True)
win_commit = float(ps.stdout.strip())
app_commit = s["commitUsedBytes"] / 1073741824
check("agrees with Windows commit charge", abs(win_commit - app_commit) < 1.5,
      f"app={round(app_commit,2)} GB vs windows={win_commit} GB")

# --- 2. sidebar bar reflects commit ---
bar = ev("""(async () => { await pollResources(); return {
  text: document.getElementById('mem-text').innerText,
  width: document.getElementById('mem-fill').style.width,
  cls: document.getElementById('mem-fill').className,
  noBadge: !document.getElementById('mem-warn')
}; })()""")
print("[bar]", json.dumps(bar))
check("sidebar shows committed-of-physical", "committed of" in bar["text"], bar["text"])
check("low text badge removed", bar["noBadge"] is True)
check("bar colour carries the level", bar["cls"] in ("ok", "low", "critical"), bar["cls"])

# --- 3. machine view ---
mv = ev("""(async () => { await openMachine(); await new Promise(r=>setTimeout(r,3500)); return {
  open: !document.getElementById('machine-scrim').classList.contains('hidden'),
  physVal: document.getElementById('g-phys-val').innerText,
  commitVal: document.getElementById('g-commit-val').innerText,
  verdict: document.getElementById('machine-verdict').innerText.slice(0,90),
  verdictCls: document.getElementById('machine-verdict').className,
  procRows: document.querySelectorAll('#machine-procs .proc-row').length,
  mineRows: document.querySelectorAll('#machine-procs .proc-row.mine').length,
  topProc: document.querySelector('#machine-procs .proc-name') ?
           document.querySelector('#machine-procs .proc-name').innerText : null,
  engineState: document.getElementById('engine-state').innerText,
  readOnlyNote: document.getElementById('machine-note').innerText
}; })()""", timeout=120)
print("[machine view]", json.dumps(mv, indent=1))
check("machine view opens with both gauges",
      mv["open"] and "/" in mv["physVal"] and "of RAM" in mv["commitVal"], json.dumps(mv))
check("machine view lists real processes", mv["procRows"] >= 5, mv["procRows"])
check("our own processes are highlighted", mv["mineRows"] >= 1, mv["mineRows"])
check("verdict explains the paging link",
      "paging" in mv["verdict"].lower() or "over-committed" in mv["verdict"].lower(), mv["verdict"])
check("view states it is read-only",
      "does not stop" in mv["readOnlyNote"], mv["readOnlyNote"])

# --- 4. idle unload: manual unload frees the model ---
before = ev("window.lcl.systemStats()")
ev("window.lcl.unloadModel()")
time.sleep(4)
after = ev("window.lcl.systemStats()")
freed = (before["commitUsedBytes"] - after["commitUsedBytes"]) / 1073741824
print(f"\n[unload] engineLoaded {before['engineLoaded']} -> {after['engineLoaded']}, "
      f"commit freed {round(freed,2)} GB")
check("unload releases the model", after["engineLoaded"] is False, "")
check("unload actually returns memory", freed > 1.5, f"{round(freed,2)} GB freed")

eng = ev("window.lcl.engineStatus()")
check("engine reports idle-unload config",
      eng.get("idleUnloadMs", 0) > 0, f"idleUnloadMs={eng.get('idleUnloadMs')}")

# --- 5. next message transparently reloads ---
sid = ev("window.lcl.createSession('reload')")["id"]
t0 = time.time()
res = ev(f"window.lcl.chat({json.dumps(sid)}, 'say ok')", timeout=600)
took = round(time.time() - t0, 1)
reply = " ".join(m["content"] for m in (res.get("new_messages") or []) if m["role"] == "assistant")
print(f"[reload] replied in {took}s: {reply[:80]!r}  error={res.get('error')}")
check("message after unload transparently reloads and answers",
      not res.get("error") and bool(reply.strip()), res.get("error") or reply[:60])
after2 = ev("window.lcl.systemStats()")
check("model is loaded again", after2["engineLoaded"] is True, "")
ev(f"window.lcl.deleteSession({json.dumps(sid)})")
ev("closeMachine()")

print()
passed = sum(1 for _, ok in results if ok)
print(f"{passed}/{len(results)} checks passed")
ws.close()
raise SystemExit(0 if passed == len(results) else 1)
