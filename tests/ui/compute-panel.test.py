"""Compute panel + memory optimiser: measured facts, honest about unusable devices."""
import ctypes, json, time, urllib.request
import websocket

u = ctypes.windll.user32; u.SetProcessDPIAware()
h = u.FindWindowW(None, ".lcl")
if h:
    u.ShowWindow(h, 9); u.SetForegroundWindow(h); time.sleep(1.5)

with urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=8) as r:
    page = [t for t in json.load(r) if t.get("type") == "page"][0]
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60, suppress_origin=True)
n = [0]
def ev(e, t=900):
    n[0] += 1
    ws.send(json.dumps({"id": n[0], "method": "Runtime.evaluate",
                        "params": {"expression": e, "returnByValue": True, "awaitPromise": True}}))
    ws.settimeout(t)
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
    if ev("typeof ready !== 'undefined' && ready") is True: break
    time.sleep(2)

# --- inventory is measured, not assumed ---
inv = ev("window.lcl.machineInventory()", t=120)
print("  cpu   :", json.dumps(inv["cpu"]))
print("  gpu   :", json.dumps(inv["gpu"])[:220])
print("  npu   :", json.dumps(inv["npu"]))
print("  mem   : avail %.2f GB, commit %.2f/%.2f GB, pagefile %.2f GB" % (
    inv["memory"]["availableBytes"]/2**30, inv["memory"]["commitUsedBytes"]/2**30,
    inv["memory"]["commitLimitBytes"]/2**30, inv["memory"]["pagefileBytes"]/2**30))

check("cpu threads reported", inv["cpu"]["threads"] >= 8, inv["cpu"]["threads"])
check("gpu probed from the engine binary", inv["gpu"]["probed"] is True, json.dumps(inv["gpu"])[:120])
check("gpu VRAM is the runtime figure, not the 2 GB Windows reports",
      len(inv["gpu"]["devices"]) > 0 and inv["gpu"]["devices"][0]["totalBytes"] > 4e9,
      f'{inv["gpu"]["devices"][0]["totalBytes"]/2**30:.1f} GB' if inv["gpu"]["devices"] else "no device")
check("npu presence detected", inv["npu"]["present"] is True, json.dumps(inv["npu"]))
check("npu correctly reported as unusable without a runtime",
      inv["npu"]["usable"] is False and "OpenVINO" in (inv["npu"]["reason"] or ""),
      inv["npu"]["reason"])
check("pagefile is separated from physical RAM",
      inv["memory"]["pagefileBytes"] > 1e9
      and abs((inv["memory"]["physTotalBytes"] + inv["memory"]["pagefileBytes"])
              - inv["memory"]["commitLimitBytes"]) < 1e8,
      f'{inv["memory"]["pagefileBytes"]/2**30:.2f} GB pagefile')

# --- panel renders those facts ---
ev("(async () => { await openMachine(); await new Promise(r=>setTimeout(r,4000)); return 1; })()", t=180)
panel = ev("""(() => {
  const rows = [...document.querySelectorAll('#compute-panel .compute-row')];
  return rows.map(r => ({
    name: r.querySelector('.compute-name').innerText,
    value: r.querySelector('.compute-value').innerText,
    detail: r.querySelector('.compute-detail').innerText,
    state: r.className.replace('compute-row','').trim()
  }));
})()""")
print("  panel :", json.dumps(panel, indent=1))
check("compute panel shows CPU, GPU and NPU",
      len(panel) >= 3 and {p["name"] for p in panel} >= {"CPU", "GPU", "NPU"},
      json.dumps([p["name"] for p in panel]))
npu_row = next((p for p in panel if p["name"] == "NPU"), None)
check("NPU row says present but unusable, not 'available'",
      npu_row and "unusable" in npu_row["value"], json.dumps(npu_row))
gpu_row = next((p for p in panel if p["name"] == "GPU"), None)
check("GPU row shows it is in use via vulkan",
      gpu_row and "vulkan" in gpu_row["detail"] and gpu_row["state"] == "active",
      json.dumps(gpu_row))

# --- optimiser analyses and proposes through the approval card ---
ev("document.getElementById('optimize-scan').click()")
time.sleep(8)
opt = ev("""(() => {
  const items = [...document.querySelectorAll('.optimize-item')].map(i => ({
    text: i.querySelector('.optimize-text').innerText,
    size: i.querySelector('.optimize-size').innerText
  }));
  return { summary: (document.querySelector('.optimize-summary')||{}).innerText || '',
           items, hasPropose: !!document.querySelector('.optimize-propose') };
})()""")
print("  optimiser:", json.dumps(opt, indent=1)[:700])
check("analysis produced findings", len(opt["items"]) > 0, json.dumps(opt)[:200])
check("nothing protected was suggested",
      not any(w in json.dumps(opt["items"]).lower()
              for w in ["defender", "dwm", "explorer", "audio", "logi", "lsass"]),
      json.dumps(opt["items"])[:200])
check("offers to build a reviewable script", opt["hasPropose"] is True)

# clicking it must produce an approval card, NOT run anything
# clear stale cards from earlier sessions so we inspect the one just created
ev("chat.innerHTML = ''")
ev("document.querySelector('.optimize-propose').click()")
time.sleep(2)
card = ev("""(() => {
  const cards = document.querySelectorAll('.script-card');
  const c = cards[cards.length - 1];          // the one just added
  if (!c) return null;
  return { count: cards.length,
           note: c.querySelector('.script-note').innerText,
           purpose: (c.querySelector('.script-purpose')||{}).innerText || '',
           hasRollback: !!c.querySelector('.script-rollback'),
           script: c.querySelector('.code-block code').innerText };
})()""")
if card:
    preview = dict(card); preview["script"] = preview["script"][:200] + "…"
    print("  card:", json.dumps(preview, indent=1)[:700])
check("optimiser routes through the same approval card", bool(card), "no card")
check("card is awaiting approval, nothing ran",
      card and "Nothing has run" in card["note"], card and card["note"])
check("card includes a rollback explanation", card and card["hasRollback"] is True)
# it must be the OPTIMISER's script, not a leftover from another test
check("card holds the memory script, not a stale one",
      card and "Stop-Process" in card["script"] and "Available MBytes" in card["script"],
      (card or {}).get("script", "")[:120])
check("script targets only the selected apps",
      card and "$targets" in card["script"] and "MsMpEng" not in card["script"],
      (card or {}).get("script", "")[:120])

ev("""(() => { const cards=document.querySelectorAll('.script-card');
   const c=cards[cards.length-1];
   c.querySelectorAll('.script-actions button')[0].click(); return 1; })()""")
time.sleep(1)
check("rejecting leaves the machine untouched",
      "rejected" in ev("""(() => { const cards=document.querySelectorAll('.script-card');
         return cards[cards.length-1].className; })()"""))

print()
passed = sum(1 for _, ok in results if ok)
print(f"{passed}/{len(results)} checks passed")
ws.close()
raise SystemExit(0 if passed == len(results) else 1)
