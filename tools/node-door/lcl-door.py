#!/usr/bin/env python3
"""
.lcl node door — the VPN-proof way into a node.

Full-tunnel VPNs (the VPN and friends) firewall every packet that does not
ride their tunnel, which kills Tailscale's direct paths from the laptop. What
they cannot kill is ordinary outbound HTTPS — so the node exposes ONE
authenticated HTTPS endpoint through Tailscale Funnel, whose TLS terminates on
this machine (the relay sees ciphertext), and the laptop walks in through the
front door like any web request.

Stdlib only, deliberately: this file is uploaded over SSH to a machine that
may have nothing but python3, and it must also run on the developer's Windows
box so the test suite can exercise the real code (the /proc reads degrade to
zeros there).

Routes (all require `Authorization: Bearer <token>`):
    GET  /lcl/ping   -> {"ok": true, "door": "<version>"}
    GET  /lcl/stats  -> everything the dashboard draws, one JSON object
    POST /lcl/run    -> {"key": "<recipe>", "password": "<optional>"}
                        runs ONE recipe from recipes.json and streams its
                        output. The key is looked up; nothing sent over the
                        wire is ever executed.
    *    /*          -> proxied verbatim to the local model server (Ollama)

The token is generated at install time, lives in one file readable only by
the service user, and never appears on a command line.
"""
import hmac
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DOOR_VERSION = "4"      # 4 adds /lcl/run — see _run_recipe
# 3 added /v1/images/generations — see ALLOWED_EXACT
LISTEN_PORT = int(os.environ.get("LCL_DOOR_PORT", "8347"))
BACKEND = os.environ.get("LCL_DOOR_BACKEND", "http://127.0.0.1:11434").rstrip("/")
# The driver's own /health endpoint, asked ON the box (see /lcl/driver-health).
# Defaults to BACKEND; overridable when the driver's health port differs. Without
# this definition the route raised NameError on every call and the app's fast
# readiness probe silently fell back to the slow one.
DRIVER_BACKEND = os.environ.get("LCL_DOOR_DRIVER_BACKEND", BACKEND).rstrip("/")
TOKEN_FILE = os.environ.get("LCL_DOOR_TOKEN_FILE",
                            os.path.expanduser("~/.config/lcl-door/token"))
RECIPE_FILE = os.environ.get("LCL_DOOR_RECIPE_FILE",
                             os.path.expanduser("~/.config/lcl-door/recipes.json"))
RUN_LOCK = threading.Lock()


class _ClientGone(Exception):
    """the laptop hung up mid-stream"""


def shell_path():
    """
    Which shell runs a recipe.

    /bin/sh on every node this will ever be installed on. The fallback is
    for a Windows dev host: the test suite runs this exact file on Windows
    so the route is exercised for real rather than mocked, and a hard-coded
    /bin/sh would make that suite test nothing.
    """
    override = os.environ.get("LCL_DOOR_SHELL")
    if override:
        return override
    if os.path.exists("/bin/sh"):
        return "/bin/sh"
    return shutil.which("sh") or shutil.which("bash")


def load_recipes():
    """
    The recipes this node will run, READ FRESH EVERY TIME.

    Written by .lcl over SSH when the door is installed or updated, mode 600,
    straight out of nodeStacks.js — the same literals the SSH path uses. Read
    on each request rather than cached at import so an updated table takes
    effect without restarting the door, and so a missing or corrupt file is a
    404 on one request instead of a door that will not start at all.
    """
    try:
        with open(RECIPE_FILE, "r", encoding="utf-8") as fh:
            got = json.load(fh)
        return got if isinstance(got, dict) else {}
    except Exception:
        return {}

with open(TOKEN_FILE, "r", encoding="utf-8") as f:
    TOKEN = f.read().strip()
if not TOKEN:
    print("empty token file — refusing to serve", file=sys.stderr)
    sys.exit(1)

# WHAT MAY COME THROUGH THE DOOR.
#
# The door is published to the public internet by Tailscale Funnel, and a
# Funnel hostname appears in certificate-transparency logs — so it WILL be
# found and probed. One static token is the only wall, which makes an
# unrestricted proxy to Ollama's control surface (/api/pull, /api/push,
# /api/create, /api/delete: arbitrary downloads, model exfiltration,
# destruction) an unacceptable thing to put behind it.
#
# Inference and read-only introspection are all .lcl ever asks for, so that
# is all the door forwards. Everything else is refused whether or not the
# token is right.
ALLOWED_EXACT = {
    "/v1/chat/completions", "/v1/completions", "/v1/models", "/v1/embeddings",
    "/api/chat", "/api/generate", "/api/ps", "/api/tags", "/api/embeddings",
    "/api/version", "/api/show",
    # IMAGES, ON THE NODE'S OWN HARDWARE.
    #
    # The node has the unified memory to run an open-weight image model, and
    # the tool-fallback chain (.lcl.engine/core/toolFallback.js) already knows
    # how to prefer it over a paid endpoint. This is the one route that makes
    # that leg reachable, and it is added on the SAME terms as the rest of this
    # list: it generates, and it is the only image verb forwarded. Nothing that
    # pulls, creates, deletes or otherwise changes what is installed on the box
    # goes through this door, whether or not the token is right.
    "/v1/images/generations",
}
ALLOWED_PREFIX = ("/v1/models/",)

# an unbounded read on a public endpoint is a memory exhaustion primitive
MAX_BODY = 32 * 1024 * 1024


def path_allowed(p):
    base = p.split("?", 1)[0].split("#", 1)[0]
    if ".." in base:
        return False
    return base in ALLOWED_EXACT or base.startswith(ALLOWED_PREFIX)


def read_file(p):
    try:
        with open(p, "r", encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return ""


def stats():
    """The same numbers lcl:nodeDash gathers over SSH, as one JSON object."""
    out = {"ok": True, "door": DOOR_VERSION, "at": int(time.time() * 1000)}

    cpu = read_file("/proc/stat").splitlines()
    if cpu and cpu[0].startswith("cpu "):
        t = [int(x) for x in cpu[0].split()[1:]]
        out["cpu"] = {"idleTicks": (t[3] if len(t) > 3 else 0) + (t[4] if len(t) > 4 else 0),
                      "totalTicks": sum(t),
                      "cores": os.cpu_count()}
    else:
        out["cpu"] = {"idleTicks": 0, "totalTicks": 0, "cores": os.cpu_count()}

    mem = {}
    for line in read_file("/proc/meminfo").splitlines():
        parts = line.replace(":", "").split()
        if len(parts) >= 2 and parts[0] in ("MemTotal", "MemAvailable", "SwapTotal", "SwapFree"):
            mem[parts[0]] = int(parts[1]) * 1024
    out["mem"] = {"totalBytes": mem.get("MemTotal", 0),
                  "availableBytes": mem.get("MemAvailable", 0),
                  "swapTotalBytes": mem.get("SwapTotal", 0),
                  "swapFreeBytes": mem.get("SwapFree", 0)}

    load = read_file("/proc/loadavg").split()
    out["load"] = [float(x) for x in load[:3]] if len(load) >= 3 else [0, 0, 0]
    up = read_file("/proc/uptime").split()
    out["uptimeSec"] = float(up[0]) if up else 0

    out["gpu"] = None
    try:
        q = subprocess.run(
            ["nvidia-smi", "--query-gpu=utilization.gpu,temperature.gpu,power.draw",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5)
        vals = q.stdout.strip().split(",")
        fin = []
        for v in vals:
            try:
                fin.append(float(v))
            except ValueError:
                fin.append(None)
        if any(x is not None for x in fin):
            out["gpu"] = {"util": fin[0] if len(fin) > 0 else None,
                          "tempC": fin[1] if len(fin) > 1 else None,
                          "powerW": fin[2] if len(fin) > 2 else None}
    except (OSError, subprocess.TimeoutExpired):
        pass

    out["disk"] = None
    if hasattr(os, "statvfs"):          # unix only — the door's home
        try:
            st = os.statvfs("/")
            out["disk"] = {"totalBytes": st.f_blocks * st.f_frsize,
                           "usedBytes": (st.f_blocks - st.f_bfree) * st.f_frsize}
        except OSError:
            pass

    rx = tx = 0
    for line in read_file("/proc/net/dev").splitlines():
        if ":" not in line:
            continue
        name, rest = line.split(":", 1)
        if name.strip() == "lo":
            continue
        f2 = rest.split()
        if len(f2) >= 9:
            rx += int(f2[0])
            tx += int(f2[8])
    out["net"] = {"rxBytes": rx, "txBytes": tx}

    out["models"] = []
    try:
        with urllib.request.urlopen(BACKEND + "/api/ps", timeout=3) as r:
            j = json.loads(r.read().decode("utf-8"))
            out["models"] = [{"name": m.get("name"), "sizeBytes": m.get("size", 0),
                              "until": m.get("expires_at")}
                             for m in j.get("models", [])]
    except Exception:
        pass
    return out


class Door(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _authed(self):
        h = self.headers.get("Authorization", "")
        # constant time: the door is on the public internet and a static
        # token compared with == leaks its prefix to a patient prober.
        #
        # compare_digest raises TypeError on a str containing non-ASCII, so a
        # single header byte above 0x7f killed the handler thread — an
        # unauthenticated denial of service from one request. Encode both
        # sides to bytes, which compares any input without raising.
        try:
            return hmac.compare_digest(h.encode("utf-8", "surrogateescape"),
                                       ("Bearer " + TOKEN).encode("utf-8"))
        except Exception:
            return False

    def _deny(self, why="unauthorized", code=401):
        # a refused attempt LEAVES A TRACE. Silence on the node means
        # credential stuffing against a public endpoint is invisible.
        sys.stderr.write("lcl-door: %s from %s for %s\n"
                         % (why, self.client_address[0], self.path.split("?")[0]))
        sys.stderr.flush()
        body = json.dumps({"error": why}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # END THE CONNECTION. A refusal never reads the request body, so on a
        # keep-alive connection those unread bytes are parsed as the NEXT
        # request — a response desync an attacker controls by declaring a
        # Content-Length and sending a crafted body. Draining is not a fix
        # because the declared length is the attacker's number; closing is.
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def _json(self, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # same reason as _deny: ping and stats do not read a request body
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def _run_recipe(self):
        """
        RUN ONE NAMED RECIPE. THE WIRE CARRIES A KEY, NEVER SHELL TEXT.

        A full-tunnel VPN refuses every socket to the tailnet, so ssh to this
        node is dead from such a machine while ordinary HTTPS is untouched —
        which is the whole reason this door exists. Inference already came
        through it. Installing anything did not: that went straight to ssh and
        died, and the app could only suggest turning the VPN off. This is the
        missing half.

        The security stance does not move. `ALLOWED_EXACT` above refuses an
        unrestricted proxy to Ollama's control surface because this endpoint is
        public and one static token is the only wall; the same reasoning applies
        here, so this route accepts a KEY and looks the commands up in a table
        written to disk at install time. Nothing a caller sends is ever
        executed. The worst a stolen token buys is one of the recipes .lcl
        already offers, on the machine it was stolen for.
        """
        if RUN_LOCK.locked():
            return self._deny("another recipe is already running", 409)
        if self.headers.get("Transfer-Encoding"):
            return self._deny("chunked request bodies are not accepted", 400)
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            return self._deny("bad Content-Length", 400)
        if length < 0 or length > 64 * 1024:
            return self._deny("request body too large", 413)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._deny("body must be JSON", 400)

        key = body.get("key")
        recipes = load_recipes()
        # keys beginning "__" are the table's own data (the sudo prime), never
        # something a caller may ask to run
        if not isinstance(key, str) or key.startswith("__") or key not in recipes:
            # the list is NOT echoed back: an unauthenticated prober should not
            # learn the shape of what is installable here
            return self._deny("no such recipe on this node", 404)
        script = recipes[key].get("script")
        if not isinstance(script, str) or not script:
            return self._deny("that recipe has no steps", 500)

        pw = body.get("password")
        if pw is not None and not isinstance(pw, str):
            return self._deny("password must be a string", 400)
        # THE SUDO PRIME IS DATA, NOT SOMETHING THIS FILE KNOWS HOW TO WRITE.
        # It arrives in the same table, from the same constant the SSH path
        # uses, so the two roads to this node cannot drift apart — and the one
        # that only runs with a VPN up is the copy nobody would notice going
        # stale. Prepended ONLY when a password was given: a node with
        # passwordless sudo must not be made to answer a read that never comes.
        if pw:
            prime = recipes.get("__prime")
            if not isinstance(prime, str) or not prime:
                return self._deny("this door has no sudo prime — update the door", 500)
            script = prime + script

        sh = shell_path()
        if not sh:
            return self._deny("no shell on this node to run a recipe with", 500)

        with RUN_LOCK:
            self.send_response(200)
            # LINES AS THEY HAPPEN. A recipe can build for twenty minutes; a
            # buffered response is indistinguishable from a hang.
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True

            def emit(line):
                data = (line.rstrip("\n") + "\n").encode("utf-8", "replace")
                try:
                    self.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
                    self.wfile.flush()
                except Exception:
                    raise _ClientGone()

            # sudo reads the password on stdin, exactly as it does over ssh:
            # never on a command line, where `ps` on this machine would show it
            proc = subprocess.Popen(
                [sh, "-c", script],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, close_fds=True)
            try:
                if pw:
                    proc.stdin.write((pw + "\n").encode("utf-8"))
                proc.stdin.close()
            except Exception:
                pass
            try:
                for raw in iter(proc.stdout.readline, b""):
                    emit(raw.decode("utf-8", "replace"))
            except _ClientGone:
                # the laptop went away mid-install. The recipe keeps running —
                # killing a half-finished apt is worse than finishing it.
                proc.stdout.close()
                return
            code = proc.wait()
            try:
                emit("LCL-DOOR-EXIT %d" % code)
            except _ClientGone:
                return
            try:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except Exception:
                pass

    def _proxy(self):
        # A chunked request body cannot be read by http.server, so int() below
        # would compute 0, forward nothing, and leave the body on the socket to
        # be parsed as the next request. Refuse it outright.
        if self.headers.get("Transfer-Encoding"):
            return self._deny("chunked request bodies are not accepted", 400)
        raw = self.headers.get("Content-Length")
        try:
            length = int(raw) if raw else 0
        except (TypeError, ValueError):
            return self._deny("bad Content-Length", 400)
        if length < 0 or length > MAX_BODY:
            return self._deny("request body too large", 413)
        data = self.rfile.read(length) if length else None
        req = urllib.request.Request(BACKEND + self.path, data=data,
                                     method=self.command)
        for k, v in self.headers.items():
            if k.lower() in ("host", "authorization", "content-length",
                             "connection", "accept-encoding"):
                continue
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                self.send_response(r.status)
                ctype = r.headers.get("Content-Type", "application/octet-stream")
                self.send_header("Content-Type", ctype)
                # stream: model replies arrive token by token and must not be
                # buffered into one blob at the door
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                while True:
                    # read1: hand back whatever has ARRIVED. read() blocks
                    # until the full buffer fills or the body ends, which
                    # turns a token-by-token SSE stream into one blob at the
                    # end — the reply would appear to hang, then land whole.
                    chunk = r.read1(16384) if hasattr(r, "read1") else r.read(1)
                    if not chunk:
                        break
                    self.wfile.write(b"%x\r\n" % len(chunk))
                    self.wfile.write(chunk)
                    self.wfile.write(b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
        except urllib.error.HTTPError as e:
            body = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type",
                             e.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            body = json.dumps({"error": "backend unreachable: " + str(e)}).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def _route(self):
        if not self._authed():
            return self._deny()
        if self.path == "/lcl/ping":
            return self._json({"ok": True, "door": DOOR_VERSION, "backend": BACKEND})
        if self.path == "/lcl/stats":
            return self._json(stats())
        if self.path == "/lcl/driver-health":
            # the DRIVER's own /health, asked ON the box: llama.cpp answers it
            # instantly regardless of how busy the single slot is (503 while
            # loading, 200 when serving) — the readiness probe that neither
            # queues behind work nor lies from CLI args
            try:
                req = urllib.request.Request(DRIVER_BACKEND + "/health")
                with urllib.request.urlopen(req, timeout=3) as r:
                    return self._json({"ok": True, "status": r.status})
            except urllib.error.HTTPError as e:
                return self._json({"ok": True, "status": e.code})
            except Exception as e:
                return self._json({"ok": False, "status": None, "why": str(e)[:80]})
        if self.path == "/lcl/run":
            if self.command != "POST":
                return self._deny("POST only", 405)
            return self._run_recipe()
        if not path_allowed(self.path):
            return self._deny("route not permitted through this door", 403)
        return self._proxy()

    def do_GET(self):
        self._route()

    def do_POST(self):
        self._route()

    def do_DELETE(self):
        self._route()

    def log_message(self, fmt, *args):
        # no request logging: paths are harmless but silence is the habit
        pass


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", LISTEN_PORT), Door)
    print(f"lcl-door v{DOOR_VERSION} on 127.0.0.1:{LISTEN_PORT} -> {BACKEND}")
    srv.serve_forever()
