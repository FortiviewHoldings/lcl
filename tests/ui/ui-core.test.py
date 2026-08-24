"""v5: landing animation, progress, message actions, red/green changes, branded modal."""
import json, os, time, urllib.request
import websocket

TEST_REPO = r"C:\Users\you\AppData\Local\Temp\claude\C---lcl\bbb271c1-6e74-4b49-b762-e6cc4761e6f1\scratchpad\test-repo"
SESS_DIR = r"C:\.lcl\data\sessions"

with urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=6) as r:
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

for _ in range(120):
    if ev("typeof ready !== 'undefined' && ready") is True:
        break
    time.sleep(2)
check("app ready", ev("ready") is True)

# --- branding: top bar uses the new mark, sidebar logo unchanged ---
brand = ev("""({
  mark: document.getElementById('titlebar-mark').getAttribute('src'),
  markLoaded: document.getElementById('titlebar-mark').naturalWidth > 0,
  markRatio: +(document.getElementById('titlebar-mark').naturalWidth /
               document.getElementById('titlebar-mark').naturalHeight).toFixed(3),
  logo: document.getElementById('brand-logo').getAttribute('src'),
  logoRatio: +(document.getElementById('brand-logo').naturalWidth /
               document.getElementById('brand-logo').naturalHeight).toFixed(3)
})""")
check("top bar uses new mark.png", brand["mark"].endswith("mark.png") and brand["markLoaded"]
      and abs(brand["markRatio"] - 0.881) < 0.01, json.dumps(brand))
check("sidebar logo still the frozen wordmark",
      brand["logo"].endswith("logo.png") and abs(brand["logoRatio"] - 1.777) < 0.01, json.dumps(brand))

# --- landing page with animation on a fresh session ---
s = ev("window.lcl.createSession('')")
sid = s["id"]
ev(f"(async () => {{ active=null; await switchSession({json.dumps(sid)}); return 'ok'; }})()")
time.sleep(1)
land = ev("""(() => {
  const l = document.getElementById('landing');
  const layer = document.querySelector('.anim-layer.l1');
  const cs = getComputedStyle(layer);
  return {
    visible: !l.classList.contains('hidden'),
    layers: document.querySelectorAll('.anim-layer').length,
    animName: cs.animationName,
    animDur: cs.animationDuration,
    bg: cs.backgroundImage.includes('anim.png'),
    // only transform/opacity should animate (compositor-only)
    props: [...document.querySelectorAll('.anim-layer')].map(el => getComputedStyle(el).willChange)
  };
})()""")
check("landing shows animated backdrop",
      land["visible"] and land["layers"] == 3 and land["bg"] and land["animName"] != "none",
      json.dumps(land))
check("animation is compositor-only (transform/opacity)",
      all("transform" in p and "opacity" in p for p in land["props"]), json.dumps(land["props"]))

# pause when hidden
ev("setAnimPaused(true)")
paused = ev("getComputedStyle(document.querySelector('.anim-layer.l1')).animationPlayState")
ev("setAnimPaused(false)")
check("animation pauses when not visible", paused == "paused", f"state={paused}")

# --- branded modal replaces the OS dialog ---
ev("window.__m = modal({title:'Grant workspace access', message:'Give .lcl access?', path:'C:\\\\demo', scope:true, confirmLabel:'Grant access'}); 'ok'")
time.sleep(0.4)
mod = ev("""({
  open: !document.getElementById('modal-scrim').classList.contains('hidden'),
  title: document.getElementById('modal-title').innerText,
  path: document.getElementById('modal-path').innerText,
  scopeShown: !document.getElementById('modal-scope').classList.contains('hidden'),
  scopeItems: [...document.querySelectorAll('#modal-scope li')].map(l=>l.innerText).length,
  branded: document.getElementById('modal-mark').getAttribute('src').endsWith('mark.png'),
  confirmLabel: document.getElementById('modal-confirm').innerText
})""")
check("branded permission modal renders",
      mod["open"] and mod["branded"] and mod["scopeShown"] and mod["scopeItems"] == 3
      and mod["confirmLabel"] == "Grant access" and "demo" in mod["path"], json.dumps(mod))
ev("closeModal(false)")
check("modal closes and resolves", ev("document.getElementById('modal-scrim').classList.contains('hidden')") is True)

# --- link the repo, then run a real write turn ---
p = os.path.join(SESS_DIR, f"{sid}.json")
d = json.load(open(p)); d["repoPath"] = TEST_REPO; json.dump(d, open(p, "w"))
ev(f"(async () => {{ active=null; await switchSession({json.dumps(sid)}); toggleWorkspace(true); return 'ok'; }})()")
time.sleep(2)

target = os.path.join(TEST_REPO, "v5.md")
if os.path.exists(target):
    os.remove(target)

ev("""(async () => {
  const c = document.getElementById('composer-input');
  c.value = 'Create a file v5.md in this folder describing what you can do.';
  await sendMessage();
  return 'ok';
})()""", timeout=900)

created = os.path.isfile(target)
check("agent created the file", created, f"{os.path.getsize(target) if created else 0} bytes")

# --- green change chip + revert button ---
chip = ev("""(() => {
  const c = document.querySelector('.change-chip');
  if (!c) return null;
  const cs = getComputedStyle(c);
  return {cls: c.className, text: c.innerText, color: cs.color,
          hasRevert: !!c.querySelector('button')};
})()""")
check("green change chip with revert action",
      bool(chip) and ("created" in chip["cls"] or "modified" in chip["cls"]) and chip["hasRevert"],
      json.dumps(chip))

# workspace list marks the new file green
wsflag = ev("""(() => {
  const rows = [...document.querySelectorAll('#ws-files .ws-file')];
  const hit = rows.find(r => r.innerText.includes('v5.md'));
  return hit ? {cls: hit.className, color: getComputedStyle(hit.querySelector('.nm')).color} : null;
})()""")
check("workspace list colours the created file",
      bool(wsflag) and ("created" in wsflag["cls"] or "modified" in wsflag["cls"]), json.dumps(wsflag))

# --- message actions present ---
acts = ev("""(() => {
  const rows = [...document.querySelectorAll('.msg-row')];
  const user = rows.find(r => r.classList.contains('user'));
  const asst = rows.find(r => r.classList.contains('assistant'));
  return {
    userActions: user ? [...user.querySelectorAll('.msg-actions button')].map(b=>b.innerText) : [],
    asstActions: asst ? [...asst.querySelectorAll('.msg-actions button')].map(b=>b.innerText) : []
  };
})()""")
check("copy/resend/delete on requests", "copy" in acts["userActions"] and "delete" in acts["userActions"]
      and "resend" in acts["userActions"], json.dumps(acts))
check("copy/delete on responses", "copy" in acts["asstActions"] and "delete" in acts["asstActions"],
      json.dumps(acts))

# --- revert actually restores/deletes ---
ev("""(async () => {
  const btn = document.querySelector('.change-chip button');
  btn.click();
  return 'ok';
})()""")
time.sleep(0.5)
ev("document.getElementById('modal-confirm').click()")
time.sleep(1.5)
check("revert deleted the created file", not os.path.isfile(target),
      "still present" if os.path.isfile(target) else "gone")

reverted = ev("!!document.querySelector('.change-chip.reverted')")
check("chip shows reverted (red)", reverted is True)

ev(f"window.lcl.deleteSession({json.dumps(sid)})")

print()
passed = sum(1 for _, ok in results if ok)
print(f"{passed}/{len(results)} checks passed")
ws.close()
raise SystemExit(0 if passed == len(results) else 1)
