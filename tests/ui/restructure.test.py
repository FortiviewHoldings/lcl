"""Post-restructure: app runs from app/, engine resolves via manifest, policy gate is live."""
import ctypes, json, os, time, urllib.request
import websocket

TEST_REPO = r"C:\Users\you\AppData\Local\Temp\claude\C---lcl\bbb271c1-6e74-4b49-b762-e6cc4761e6f1\scratchpad\test-repo"
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
    if ev("typeof ready !== 'undefined' && ready") is True:
        break
    time.sleep(2)
check("app boots from app/", ev("ready") is True)

# --- engine resolved through the manifest, from the new location ---
st = ev("window.lcl.engineStatus()")
model = (st or {}).get("model") or ""
print("  engine model path:", model)
check("model loads from engine/models (not engine/llama.cpp/models)",
      "engine" in model and "models" in model and "llama.cpp" not in model, model)
check("engine is healthy after the move", (st or {}).get("running") is True, json.dumps(st)[:120])

# --- files really are where we said ---
for rel, must in [
    (r"C:\.lcl\app\main.js", True),
    (r"C:\.lcl\engine\models\Phi-3-mini-4k-instruct-q4.gguf", True),
    (r"C:\.lcl\engine\models\registry.json", True),
    (r"C:\.lcl\engine\runtimes\llama.cpp\engine.json", True),
    (r"C:\.lcl\engine\runtimes\llama.cpp\win-x64-cpu\llama-server.exe", True),
    (r"C:\.lcl\engine\orchestrator\policy\kernel.js", True),
    (r"C:\.lcl\ui", False),
    (r"C:\.lcl\engine\llama.cpp", False),
]:
    ok = os.path.exists(rel) == must
    check(("exists: " if must else "gone: ") + rel.replace("C:\\.lcl\\", ""), ok)

# --- policy gate is live on a real turn ---
s = ev("window.lcl.createSession('policy')")
sid = s["id"]
p = os.path.join(SESS_DIR, f"{sid}.json")
d = json.load(open(p)); d["repoPath"] = TEST_REPO; json.dump(d, open(p, "w"))

target = os.path.join(TEST_REPO, "gate.md")
if os.path.exists(target):
    os.remove(target)

res = ev(f"""window.lcl.chat({json.dumps(sid)},
  'Create gate.md in this folder containing the word allowed.')""")
tools = [m for m in (res.get("new_messages") or []) if m["role"] == "tool"]
print("  tool msgs:", [(m.get("name"), m.get("notified"), m["content"][:60]) for m in tools])
check("in-scope write executed through the gate", os.path.isfile(target),
      "created" if os.path.isfile(target) else "not created")
check("write was marked notify (not silently allowed)",
      any(m.get("notified") for m in tools), json.dumps([m.get("notified") for m in tools]))

# --- escape attempt is denied BY POLICY, and audited ---
esc = ev(f"""window.lcl.chat({json.dumps(sid)},
  'Use write_file with path ../../escaped.txt and content x')""")
esc_tools = [m for m in (esc.get("new_messages") or []) if m["role"] == "tool"]
outside = os.path.join(os.path.dirname(os.path.dirname(TEST_REPO)), "escaped.txt")
print("  escape result:", [m["content"][:90] for m in esc_tools])
check("escape attempt created nothing outside the folder", not os.path.exists(outside))

# --- audit log written ---
time.sleep(1)
audit_ok = os.path.isfile(AUDIT)
lines = []
if audit_ok:
    with open(AUDIT, encoding="utf-8") as f:
        lines = [json.loads(l) for l in f if l.strip()]
check("append-only audit log exists", audit_ok, AUDIT)
decisions = [l for l in lines if l.get("kind") == "tool-decision"]
check("audit recorded tool decisions", len(decisions) >= 1, f"{len(decisions)} decisions")
check("audit records the model that asked",
      any(l.get("modelId") for l in decisions),
      json.dumps(decisions[-1] if decisions else {})[:160])

ev(f"window.lcl.deleteSession({json.dumps(sid)})")
print()
passed = sum(1 for _, ok in results if ok)
print(f"{passed}/{len(results)} checks passed")
ws.close()
raise SystemExit(0 if passed == len(results) else 1)
