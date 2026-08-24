import json, urllib.request, time
import websocket

with urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=6) as r:
    page = [t for t in json.load(r) if t.get("type") == "page"][0]
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=40, suppress_origin=True)
n = [0]

def ev(e, timeout=120):
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

print("sessions:", json.dumps(ev("sessions.map(s=>({id:s.id.slice(0,8),title:s.title,n:s.messageCount}))")))
print("active:", json.dumps(ev("active ? {id:active.id.slice(0,8),title:active.title,msgs:active.messages.length} : null")))
print("landing hidden:", ev("document.getElementById('landing').classList.contains('hidden')"))
print("dismissed:", json.dumps(ev("[...landingDismissed].map(s=>s.slice(0,8))")))
print("pending:", ev("pending"))

# force a clean empty session and show the landing
print("--- creating fresh session ---")
print(ev("(async () => { await createSession(); return active.id.slice(0,8); })()"))
time.sleep(1.5)
print("active now:", json.dumps(ev("({id:active.id.slice(0,8),title:active.title,msgs:active.messages.length})")))
print("landing hidden now:", ev("document.getElementById('landing').classList.contains('hidden')"))
ws.close()
