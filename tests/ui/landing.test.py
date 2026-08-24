"""Verify: New session button works, composer reachable on landing, all 3 paths wired."""
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
def ev(e, t=600):
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

for _ in range(90):
    if ev("typeof ready !== 'undefined' && ready") is True:
        break
    time.sleep(2)

# --- 1. New session BUTTON (real click, not a direct call) ---
before = ev("({n: sessions.length, id: active ? active.id : null})")
ev("""(() => { const b=document.getElementById('new-session');
  const r=b.getBoundingClientRect();
  b.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));
  return 1; })()""")
time.sleep(3)
after = ev("({n: sessions.length, id: active ? active.id : null})")
print(f"  sessions {before['n']} -> {after['n']}, active {str(before['id'])[:8]} -> {str(after['id'])[:8]}")
check("New session BUTTON creates and switches",
      after["id"] != before["id"] and after["n"] > before["n"], "")

# --- 2. landing visible, composer reachable underneath it ---
geo = ev("""(() => {
  const l = document.getElementById('landing');
  const c = document.getElementById('composer-input');
  const cr = c.getBoundingClientRect();
  const lr = l.getBoundingClientRect();
  const hit = document.elementFromPoint(cr.left + cr.width/2, cr.top + cr.height/2);
  return {
    landingVisible: !l.classList.contains('hidden'),
    chatScrollHidden: document.getElementById('chat-scroll').classList.contains('hidden'),
    landingBottom: Math.round(lr.bottom),
    composerTop: Math.round(cr.top),
    overlapsComposer: lr.bottom > cr.top + 2,
    topElementAtComposer: hit ? (hit.id || hit.className) : null,
    composerDisabled: c.disabled
  };
})()""")
print("  " + json.dumps(geo))
check("landing is showing for the new session", geo["landingVisible"] is True)
check("landing no longer covers the composer", geo["overlapsComposer"] is False,
      f"landing bottom {geo['landingBottom']} vs composer top {geo['composerTop']}")
check("composer is the top element and enabled",
      geo["topElementAtComposer"] == "composer-input" and geo["composerDisabled"] is False,
      geo["topElementAtComposer"])

# --- 3. copy matches the real affordances ---
copy = ev("""({
  hint: document.getElementById('landing-hint').innerText.replace(/\\s+/g,' ').trim(),
  buttons: [...document.querySelectorAll('#landing-actions button')].map(b=>b.innerText)
})""")
print("  " + json.dumps(copy))
check("copy mentions linking a folder", "link a folder" in copy["hint"].lower(), copy["hint"][:70])
check("copy mentions typing below", "typing below" in copy["hint"].lower(), copy["hint"][:70])

# --- 4. path A: type directly, no button click ---
sid = ev("active.id")
ev("""(async () => {
  document.getElementById('composer-input').value = 'say READY and nothing else';
  await sendMessage(); return 1;
})()""", t=900)
after_send = ev("""({
  landingHidden: document.getElementById('landing').classList.contains('hidden'),
  chatVisible: !document.getElementById('chat-scroll').classList.contains('hidden'),
  msgs: active.messages.length,
  inSidebar: sessions.some(s => s.id === active.id && s.messageCount > 0)
})""")
print("  " + json.dumps(after_send))
check("typing directly works without clicking a button", after_send["msgs"] >= 2, after_send["msgs"])
check("landing gives way to the transcript",
      after_send["landingHidden"] and after_send["chatVisible"], "")
check("session moved to the sidebar as the copy promises", after_send["inSidebar"] is True)
ev(f"window.lcl.deleteSession({json.dumps(sid)})")

# --- 5. path B: Just chat button dismisses landing and focuses composer ---
ev("(async () => { await createSession(); return 1; })()")
time.sleep(1)
ev("document.getElementById('landing-skip').click()")
time.sleep(0.5)
skip = ev("""({
  landingHidden: document.getElementById('landing').classList.contains('hidden'),
  chatVisible: !document.getElementById('chat-scroll').classList.contains('hidden'),
  focused: document.activeElement && document.activeElement.id
})""")
print("  " + json.dumps(skip))
check("Just chat dismisses the landing and focuses the composer",
      skip["landingHidden"] and skip["chatVisible"] and skip["focused"] == "composer-input",
      json.dumps(skip))
ev("window.lcl.deleteSession(active.id)")

print()
passed = sum(1 for _, ok in results if ok)
print(f"{passed}/{len(results)} checks passed")
ws.close()
raise SystemExit(0 if passed == len(results) else 1)
