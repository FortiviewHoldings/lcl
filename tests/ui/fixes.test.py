"""Verify this round: filesystem answer, icons, syntax highlighting, live status, memory, sandbox."""
import ctypes, json, os, time, urllib.request
import websocket

TEST_REPO = r"C:\Users\you\AppData\Local\Temp\claude\C---lcl\bbb271c1-6e74-4b49-b762-e6cc4761e6f1\scratchpad\test-repo"
SESS_DIR = r"C:\.lcl\data\sessions"

u = ctypes.windll.user32
u.SetProcessDPIAware()
h = u.FindWindowW(None, ".lcl")
if h:
    u.ShowWindow(h, 9); u.SetForegroundWindow(h); time.sleep(1.5)

with urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=8) as r:
    page = [t for t in json.load(r) if t.get("type") == "page"][0]
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60, suppress_origin=True)
n = [0]
def ev(e, timeout=900):
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

def new_session(link=False):
    s = ev("window.lcl.createSession('t')")
    sid = s["id"]
    if link:
        p = os.path.join(SESS_DIR, f"{sid}.json")
        d = json.load(open(p)); d["repoPath"] = TEST_REPO; json.dump(d, open(p, "w"))
    return sid

# --- 1. no workspace: must NOT disclaim filesystem access ---
sid = new_session(False)
res = ev(f"window.lcl.chat({json.dumps(sid)}, 'can you create files?')")
reply = " ".join(m["content"] for m in (res.get("new_messages") or []) if m["role"] == "assistant")
print("\n[no workspace reply]", reply[:300], "\n")
bad = [p for p in ["don't have direct", "do not have direct", "cannot interact", "can't interact",
                   "don't have the ability", "no direct file", "File Explorer", "Finder"]
       if p.lower() in reply.lower()]
check("no-workspace reply does not disclaim file access", not bad, f"matched: {bad}")
check("no-workspace reply points at the folder button",
      any(k in reply.lower() for k in ["folder button", "link", "workspace", "folder"]), reply[:120])
ev(f"window.lcl.deleteSession({json.dumps(sid)})")

# --- 2. unfenced tool call now actually writes ---
sid = new_session(True)
target = os.path.join(TEST_REPO, "unfenced.txt")
if os.path.exists(target):
    os.remove(target)
res = ev(f"""window.lcl.chat({json.dumps(sid)},
  'Create unfenced.txt containing the word ping. Reply with only the tool call, no code fence.')""")
tools = [m for m in (res.get("new_messages") or []) if m["role"] == "tool"]
print("[tool calls]", [(m.get("name"), m["content"][:80]) for m in tools])
check("file written even when the model skips the fence", os.path.isfile(target),
      "created" if os.path.isfile(target) else "NOT created")

# --- 3. sandbox: cannot escape the folder ---
esc = ev(f"""window.lcl.chat({json.dumps(sid)},
  'Use write_file with path ../../escaped.txt and content x')""")
esc_msgs = [m for m in (esc.get("new_messages") or []) if m["role"] == "tool"]
outside = os.path.join(os.path.dirname(os.path.dirname(TEST_REPO)), "escaped.txt")
blocked = any("escapes the linked folder" in (m.get("content") or "") for m in esc_msgs)
check("path escape refused by the sandbox", not os.path.exists(outside),
      f"tool said: {esc_msgs[0]['content'][:90] if esc_msgs else 'no tool call attempted'}")

# --- 4. code fences render highlighted, with a copy button ---
ev("""(() => {
  const row = addMessageRow('assistant',
    'Here is the helper:\\n\\n```js\\nconst x = 42; // note\\nfunction hi(name) { return `yo ${name}`; }\\n```\\n\\nDone.', null);
  window.__codeRow = row;
  return 'ok';
})()""")
code = ev("""(() => {
  const r = window.__codeRow;
  const blocks = r.querySelectorAll('.code-block');
  const toks = r.querySelectorAll('.code-block .tok-kw, .code-block .tok-str, .code-block .tok-com, .code-block .tok-num');
  return {
    blocks: blocks.length,
    lang: r.querySelector('.code-lang') ? r.querySelector('.code-lang').innerText : null,
    tokenCount: toks.length,
    hasCopy: !!r.querySelector('.code-copy'),
    proseKept: r.innerText.includes('Here is the helper') && r.innerText.includes('Done.'),
    noRawFence: !r.innerText.includes('```')
  };
})()""")
print("[code render]", json.dumps(code))
# NB: .code-lang is text-transform:uppercase, so innerText reads "JS"
check("code fence becomes a highlighted block",
      code["blocks"] == 1 and (code["lang"] or "").lower() == "js" and code["tokenCount"] >= 4,
      json.dumps(code))
check("code block has a copy button", code["hasCopy"] is True)
check("prose preserved and fence markers removed",
      code["proseKept"] and code["noRawFence"], json.dumps(code))

# --- 5. message actions are icons, not text ---
acts = ev("""(() => {
  const r = window.__codeRow;
  const btns = [...r.querySelectorAll('.msg-actions button')];
  return {
    count: btns.length,
    allIconOnly: btns.every(b => b.textContent.trim() === '' && b.querySelector('svg')),
    labels: btns.map(b => b.getAttribute('aria-label')),
    classes: btns.map(b => b.className)
  };
})()""")
print("[actions]", json.dumps(acts))
check("message actions are SVG icons with no text",
      acts["allIconOnly"] is True and acts["count"] >= 1, json.dumps(acts))
check("actions are labelled for accessibility",
      all(bool(l) for l in acts["labels"]), json.dumps(acts["labels"]))

# --- 6. live status bubble: dots + phase + elapsed + stop ---
bub = ev("""(() => {
  const b = addTyping();
  const out = {
    dots: b.querySelectorAll('.typing-dots i').length,
    hasPhase: !!b.querySelector('.typing-phase'),
    phase: b.querySelector('.typing-phase').innerText,
    hasElapsed: !!b.querySelector('.typing-elapsed'),
    hasStop: !!b.querySelector('.typing-stop'),
    animated: getComputedStyle(b.querySelector('.typing-dots i')).animationName
  };
  b.remove();
  return out;
})()""")
print("[status bubble]", json.dumps(bub))
check("waiting bubble keeps the 3 animated dots",
      bub["dots"] == 3 and bub["animated"] == "bounce", json.dumps(bub))
check("waiting bubble also shows phase, elapsed and Stop",
      bub["hasPhase"] and bub["hasElapsed"] and bub["hasStop"], json.dumps(bub))

# --- 7. memory readout populated ---
mem = ev("""(async () => {
  await pollResources();
  const s = await window.lcl.systemStats();
  return {
    text: document.getElementById('mem-text').innerText,
    fillWidth: document.getElementById('mem-fill').style.width,
    level: s.level, freeGB: +(s.freeBytes/1073741824).toFixed(1),
    totalGB: +(s.totalBytes/1073741824).toFixed(1),
    headroom: s.headroomForAnotherModel
  };
})()""")
print("[memory]", json.dumps(mem))
check("memory readout shows real numbers",
      "free of" in mem["text"] and mem["totalGB"] > 8, json.dumps(mem))
check("capacity level classified", mem["level"] in ("ok", "low", "critical"), mem["level"])

# --- 8. folder button reachable in a just-chat session ---
sid2 = new_session(False)
ev(f"(async () => {{ active=null; await switchSession({json.dumps(sid2)}); dismissLanding(); return 'ok'; }})()")
time.sleep(0.8)
fb = ev("""({
  exists: !!document.getElementById('link-repo'),
  disabled: document.getElementById('link-repo').disabled,
  linkedClass: document.getElementById('link-repo').classList.contains('linked'),
  title: document.getElementById('link-repo').title
})""")
check("folder button is enabled in a just-chat session",
      fb["exists"] and fb["disabled"] is False and fb["linkedClass"] is False, json.dumps(fb))
ev(f"window.lcl.deleteSession({json.dumps(sid2)})")
ev(f"window.lcl.deleteSession({json.dumps(sid)})")

print()
passed = sum(1 for _, ok in results if ok)
print(f"{passed}/{len(results)} checks passed")
ws.close()
raise SystemExit(0 if passed == len(results) else 1)
