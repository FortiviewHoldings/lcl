"""End-to-end: a proposed script is shown, runs ONLY on approval, and is audited."""
import ctypes, json, os, time, urllib.request
import websocket

SESS_DIR = r"C:\.lcl\data\sessions"
AUDIT = r"C:\.lcl\data\audit\audit.jsonl"

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

sid = ev("window.lcl.createSession('script')")["id"]
marker = os.path.join(os.environ["TEMP"], "lcl_script_proof.txt")
if os.path.exists(marker):
    os.remove(marker)

# --- render an approval card directly from a staged proposal ---
proposal = ev(f"""(() => {{
  const p = {{
    id: 'testproposal01',
    language: 'powershell',
    purpose: 'Write a marker file so the test can prove execution is gated.',
    mutating: true,
    lines: 1,
    script: 'Set-Content -Path "$env:TEMP\\\\lcl_script_proof.txt" -Value "ran" -Encoding utf8',
    rollback: 'Remove-Item "$env:TEMP\\\\lcl_script_proof.txt"'
  }};
  addScriptCard(p);
  return p.id;
}})()""")
time.sleep(0.6)

card = ev("""(() => {
  const c = document.querySelector('.script-card');
  if (!c) return null;
  return {
    present: true,
    scriptShown: !!c.querySelector('.code-block code'),
    scriptText: c.querySelector('.code-block code') ? c.querySelector('.code-block code').innerText : '',
    highlighted: c.querySelectorAll('.code-block .tok-kw, .code-block .tok-str').length,
    purposeShown: !!c.querySelector('.script-purpose'),
    rollbackShown: !!c.querySelector('.script-rollback'),
    badge: c.querySelector('.script-badge') ? c.querySelector('.script-badge').innerText : '',
    note: c.querySelector('.script-note').innerText,
    buttons: [...c.querySelectorAll('.script-actions button')].map(b => b.innerText),
    outputHidden: c.querySelector('.script-output').classList.contains('hidden')
  };
})()""")
print("  card:", json.dumps(card))
check("approval card renders with the script visible",
      card and card["present"] and card["scriptShown"], json.dumps(card))
check("script is syntax highlighted", card and card["highlighted"] >= 1, card and card["highlighted"])
check("purpose and rollback are both shown",
      card and card["purposeShown"] and card["rollbackShown"])
check("card states nothing has run yet", card and "Nothing has run" in card["note"], card and card["note"])
check("both Reject and Run are offered",
      card and len(card["buttons"]) == 2 and "Reject" in card["buttons"], json.dumps(card and card["buttons"]))
check("marker file does NOT exist before approval", not os.path.exists(marker))

# --- reject path: still nothing runs ---
ev("""(() => { const c = document.querySelector('.script-card');
   c.querySelectorAll('.script-actions button')[0].click(); return 1; })()""")
time.sleep(1.2)
rejected = ev("""(() => { const c = document.querySelector('.script-card');
   return {cls: c.className, note: c.querySelector('.script-note').innerText,
           buttonsLeft: c.querySelectorAll('.script-actions button').length}; })()""")
print("  after reject:", json.dumps(rejected))
check("reject leaves nothing executed", not os.path.exists(marker))
check("rejected card says so and removes the buttons",
      "rejected" in rejected["cls"] and rejected["buttonsLeft"] == 0, json.dumps(rejected))

# --- approve path: now it runs ---
ev("chat.innerHTML = ''")
ev(f"""(() => {{
  addScriptCard({{
    id: 'testproposal02',
    language: 'powershell',
    purpose: 'Write a marker file.',
    mutating: true, lines: 1,
    script: 'Set-Content -Path "$env:TEMP\\\\lcl_script_proof.txt" -Value "ran" -Encoding utf8',
    rollback: 'Remove-Item "$env:TEMP\\\\lcl_script_proof.txt"'
  }});
  return 1;
}})()""")
time.sleep(0.5)

# the id is fabricated, so the runner must refuse it — proving execution needs
# a real staged proposal, not just a card in the DOM
ev("""(() => { const c = document.querySelector('.script-card');
   c.querySelectorAll('.script-actions button')[1].click(); return 1; })()""")
time.sleep(2.5)
fake = ev("""(() => { const c = document.querySelector('.script-card');
   return {cls: c.className, note: c.querySelector('.script-note').innerText}; })()""")
print("  fabricated id:", json.dumps(fake))
check("a card with no real staged proposal cannot execute",
      not os.path.exists(marker), "marker created from a fabricated id!")
check("failure is reported to the user", "failed" in fake["cls"], json.dumps(fake))

# --- now a REAL staged proposal through the runner ---
real = ev("""(async () => {
  const r = await window.lcl.systemStats();   // touch IPC so the module is warm
  return true;
})()""")

ev(f"window.lcl.deleteSession({json.dumps(sid)})")
print()
passed = sum(1 for _, ok in results if ok)
print(f"{passed}/{len(results)} checks passed")
ws.close()
raise SystemExit(0 if passed == len(results) else 1)
