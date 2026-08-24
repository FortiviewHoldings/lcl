import base64, json, time, urllib.request
import websocket

OUT = r"C:\Users\you\AppData\Local\Temp\claude\C---lcl\bbb271c1-6e74-4b49-b762-e6cc4761e6f1\scratchpad\landing.png"

with urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=6) as r:
    page = [t for t in json.load(r) if t.get("type") == "page"][0]
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60, suppress_origin=True)
ws.settimeout(60)
n = [0]

def call(method, params=None):
    n[0] += 1
    ws.send(json.dumps({"id": n[0], "method": method, "params": params or {}}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == n[0]:
            return m

call("Page.enable")
call("Runtime.enable")
# make sure a fresh empty session is active so the landing is on screen
call("Runtime.evaluate", {"expression": "(async () => { if (!active || active.messages.length) await createSession(); return 'ok'; })()",
                          "awaitPromise": True, "returnByValue": True})
time.sleep(2)

res = call("Page.captureScreenshot", {"format": "png", "fromSurface": True, "captureBeyondViewport": False})
data = res.get("result", {}).get("data")
if not data:
    raise SystemExit(f"no screenshot data: {json.dumps(res)[:400]}")

with open(OUT, "wb") as f:
    f.write(base64.b64decode(data))
print("saved", OUT)
ws.close()
