import ctypes, json, time, urllib.request
from ctypes import wintypes
import websocket

user32 = ctypes.windll.user32
user32.SetProcessDPIAware()
hwnd = user32.FindWindowW(None, ".lcl")
assert hwnd, ".lcl window not found"

# bring it forward so the compositor produces frames
user32.ShowWindow(hwnd, 9)          # SW_RESTORE
user32.SetForegroundWindow(hwnd)
time.sleep(2.5)

# make sure a blank session is showing so the landing/wordmark is on screen
with urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=6) as r:
    page = [t for t in json.load(r) if t.get("type") == "page"][0]
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60, suppress_origin=True)
ws.settimeout(120)
ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {
    "expression": "(async () => { if (!active || active.messages.length) await createSession(); return 'ok'; })()",
    "awaitPromise": True, "returnByValue": True}}))
while True:
    if json.loads(ws.recv()).get("id") == 1:
        break
ws.close()
time.sleep(2)

import subprocess
subprocess.run(["py", "-3",
                r"C:\Users\you\AppData\Local\Temp\claude\C---lcl\bbb271c1-6e74-4b49-b762-e6cc4761e6f1\scratchpad\win_capture.py"],
               check=False)
