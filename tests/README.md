# .lcl tests

## unit/ — no app required

```bash
node tests/unit/toolparse.test.js
```

Covers the tool-call parser, which is the most failure-prone part of driving a
small local model: literal newlines inside JSON strings, truncation at the token
cap, trailing commas, and the sidecar ` ```content ` fence that lets file bodies
skip escaping entirely.

## ui/ — drive the running app over the Chrome DevTools Protocol

These assert against the real window, not a mock. Start the app with a debug
port first:

```bash
cd ui/electron && npx electron . --remote-debugging-port=9222
```

then run a suite:

```bash
py -3 tests/ui/ui-core.test.py
```

| suite | asserts |
|---|---|
| `ui-core.test.py` | landing page, branded modal, agent file write, green change chip, revert, message actions |
| `video-backdrop.test.py` | CSP allows the video, decodes 1280x720, pauses when hidden |
| `intro-playback.test.py` | plays once per visit, never loops, silent inside a session, mute persists |
| `audio-fade.test.py` | samples `video.volume` across playback to prove the tail fade |
| `branding.test.py` | wordmark and icon wiring, asset presence |
| `anim-perf.test.py` | bounded stage, no permanent `will-change`, motion modes |
| `agent-write.test.py` | the readme.md regression: engine key, tool repair, progress events |

Two gotchas these encode, both learned the hard way:

- CDP needs `suppress_origin=True` — Electron rejects the WebSocket origin.
- The app **pauses the intro on blur by design**, so a test that measures
  playback must foreground the window first (see `helpers/foreground-capture.py`).
  A frozen `currentTime` usually means the window lost focus, not a bug.

## helpers/

`cdp-screenshot.py` captures from the compositor and is the reliable option.
`window-capture.py` uses PrintWindow, which is faster but returns **stale
frames** under software rendering — trust DOM assertions over any bitmap.
