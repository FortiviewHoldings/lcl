"""The user's exact failing request: ask the agent to write a readme about its capabilities."""
import json, os, socket, time, urllib.request
import websocket

TEST_REPO = r"C:\Users\you\AppData\Local\Temp\claude\C---lcl\bbb271c1-6e74-4b49-b762-e6cc4761e6f1\scratchpad\test-repo"
SESS_DIR = r"C:\.lcl\data\sessions"

with urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=5) as r:
    page = [t for t in json.load(r) if t.get("type") == "page"][0]
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=40, suppress_origin=True)
_id = 0
def ev(expr, timeout=900):
    global _id
    _id += 1
    ws.send(json.dumps({"id": _id, "method": "Runtime.evaluate",
                        "params": {"expression": expr, "returnByValue": True, "awaitPromise": True}}))
    ws.settimeout(timeout)
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == _id:
            if m["result"].get("exceptionDetails"):
                return {"__error": str(m["result"]["exceptionDetails"].get("text"))}
            return m["result"]["result"].get("value")

results = []
def check(name, ok, detail=""):
    results.append((name, ok))
    print(("PASS" if ok else "FAIL"), "|", name, ("- " + str(detail)) if detail else "")

# wait ready
for _ in range(120):
    st = ev("typeof ready !== 'undefined' && ready")
    if st is True:
        break
    time.sleep(2)
check("app ready", st is True)

# --- engine is now key-protected: unauthenticated request must be refused ---
try:
    req = urllib.request.Request("http://127.0.0.1:8081/v1/chat/completions",
                                data=json.dumps({"model": "local-model",
                                                 "messages": [{"role": "user", "content": "hi"}],
                                                 "max_tokens": 4}).encode(),
                                headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        code = r.status
except urllib.error.HTTPError as e:
    code = e.code
except Exception as e:
    code = str(e)
check("engine rejects unauthenticated local request", code == 401, f"status={code}")

eng = ev("window.lcl.engineStatus()")
key = eng.get("apiKey")
check("engine api key issued", bool(key) and len(key) >= 32, f"len={len(key or '')}")

# with the key it works
req = urllib.request.Request("http://127.0.0.1:8081/v1/chat/completions",
                            data=json.dumps({"model": "local-model",
                                             "messages": [{"role": "user", "content": "say hi"}],
                                             "max_tokens": 8}).encode(),
                            headers={"Content-Type": "application/json",
                                     "Authorization": f"Bearer {key}"})
with urllib.request.urlopen(req, timeout=120) as r:
    ok_keyed = r.status == 200
check("engine accepts keyed request", ok_keyed)

# --- the actual bug: write a readme about capabilities ---
s = ev("window.lcl.createSession('readme bug')")
sid = s["id"]
p = os.path.join(SESS_DIR, f"{sid}.json")
d = json.load(open(p)); d["repoPath"] = TEST_REPO; json.dump(d, open(p, "w"))

target = os.path.join(TEST_REPO, "readme.md")
if os.path.exists(target):
    os.remove(target)

# capture progress events the UI would show
ev("window.__prog = []; window.lcl.onProgress(i => window.__prog.push(i)); 'ok'")

res = ev(f"""window.lcl.chat({json.dumps(sid)},
  'Create a readme.md in this folder that documents your capabilities.')""")

print("\n--- agent messages ---")
for m in (res.get("new_messages") or []):
    tag = m["role"] + ("/" + m["name"] if m.get("name") else "")
    flags = []
    if m.get("failed"): flags.append("FAILED")
    if m.get("repaired"): flags.append("repaired")
    print(f"[{tag}{' ' + ','.join(flags) if flags else ''}] {m['content'][:220]}")
print("error:", res.get("error"))
print("changes:", json.dumps(res.get("changes")))

exists = os.path.isfile(target)
body = open(target, encoding="utf-8").read() if exists else ""
check("readme.md created (the original bug)", exists, f"{len(body)} bytes")
check("readme has real multi-line content", exists and "\n" in body and len(body) > 80,
      repr(body[:120]))

parse_errors = [m for m in (res.get("new_messages") or [])
                if m.get("role") == "tool" and m.get("failed")
                and "parse" in (m.get("content") or "").lower()]
check("no JSON parse failure", not parse_errors,
      parse_errors[0]["content"][:160] if parse_errors else "")

prog = ev("window.__prog")
phases = [p.get("phase") for p in (prog or [])]
check("progress events emitted for UI", len(phases) >= 2, f"phases={phases}")

ev(f"window.lcl.deleteSession({json.dumps(sid)})")

print()
passed = sum(1 for _, ok in results if ok)
print(f"{passed}/{len(results)} checks passed")
ws.close()
raise SystemExit(0 if passed == len(results) else 1)
