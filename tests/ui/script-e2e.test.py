"""Full loop: model proposes a script -> card appears -> approval executes it."""
import ctypes, json, os, time, urllib.request
import websocket

MARKER = os.path.join(os.environ["TEMP"], "lcl_e2e_proof.txt")
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

if os.path.exists(MARKER):
    os.remove(MARKER)
audit_before = os.path.getsize(AUDIT) if os.path.exists(AUDIT) else 0

sid = ev("window.lcl.createSession('e2e')")["id"]
ev(f"(async () => {{ active=null; await switchSession({json.dumps(sid)}); return 1; }})()")

# Ask for a script. Several attempts because a 1.5B model is inconsistent about
# emitting tool calls - that limitation is documented, not hidden.
ask = ("Use the run_script tool to propose a PowerShell script that writes the word ready "
       f"into the file {MARKER}. Include a rollback that deletes it.")

proposed = False
for attempt in range(4):
    # drive the COMPOSER, not the IPC directly, so the renderer actually paints
    # the approval card the way a user would see it
    ev(f"""(async () => {{
      document.getElementById('composer-input').value = {json.dumps(ask)};
      await sendMessage();
      return 1;
    }})()""", t=900)
    time.sleep(1.0)
    state = ev("""(() => ({
      cards: document.querySelectorAll('.script-card').length,
      tools: [...document.querySelectorAll('.msg-tool summary')].map(s => s.innerText)
    }))()""")
    print(f"  attempt {attempt+1}: cards={state['cards']} tools={state['tools']}")
    if state["cards"] > 0:
        proposed = True
        break

check("model produced a script proposal", proposed, "no proposal after 4 attempts")
check("nothing executed at proposal time", not os.path.exists(MARKER))

if proposed:
    time.sleep(0.8)
    card = ev("""(() => {
      const c = document.querySelector('.script-card');
      if (!c) return null;
      return { id: c.dataset.proposalId,
               script: c.querySelector('.code-block code').innerText.slice(0, 200),
               note: c.querySelector('.script-note').innerText,
               buttons: [...c.querySelectorAll('.script-actions button')].map(b=>b.innerText) };
    })()""")
    print("  card:", json.dumps(card))
    check("card rendered for the real proposal", bool(card and card["id"]), json.dumps(card))
    check("card is awaiting a decision",
          card and "Nothing has run" in card["note"] and len(card["buttons"]) == 2)

    # approve it
    ev("""(() => { const c = document.querySelector('.script-card');
       c.querySelectorAll('.script-actions button')[1].click(); return 1; })()""")
    time.sleep(6)

    after = ev("""(() => { const c = document.querySelector('.script-card');
       return {cls: c.className, note: c.querySelector('.script-note').innerText,
               output: c.querySelector('.script-output').innerText.slice(0, 200)}; })()""")
    print("  after approve:", json.dumps(after))
    check("approval executed the script", os.path.exists(MARKER),
          "marker file was not created")
    check("card reports an outcome",
          any(c in after["cls"] for c in ("succeeded", "warned", "failed")), json.dumps(after))
    # a run that printed to stderr must NOT be reported as clean success
    stderr_shown = "error" in (after.get("output") or "").lower()
    check("stderr output is not reported as a clean success",
          not (stderr_shown and "succeeded" in after["cls"]),
          f'cls={after["cls"]} note={after.get("note")}')

    if os.path.exists(MARKER):
        body = open(MARKER, encoding="utf-8", errors="replace").read().strip()
        print("  marker contents:", repr(body))

# audit trail
time.sleep(1)
new_lines = []
if os.path.exists(AUDIT):
    with open(AUDIT, encoding="utf-8") as f:
        f.seek(audit_before)
        new_lines = [json.loads(l) for l in f if l.strip()]
kinds = [l.get("kind") for l in new_lines]
print("  new audit kinds:", kinds)
check("script approval is audited", "script-approved" in kinds, kinds)
check("script completion is audited", "script-finished" in kinds, kinds)

ev(f"window.lcl.deleteSession({json.dumps(sid)})")
if os.path.exists(MARKER):
    os.remove(MARKER)

print()
passed = sum(1 for _, ok in results if ok)
print(f"{passed}/{len(results)} checks passed")
ws.close()
raise SystemExit(0 if passed == len(results) else 1)
