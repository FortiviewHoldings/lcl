"""
Per-launch shared-secret token for the local API.

The token defends the transport against DNS-rebinding: a malicious web page can
make the browser send requests to 127.0.0.1:8000, but it cannot read a file on
disk, so it cannot learn the token and every request it makes is rejected. The
Electron main process (same machine, same user) reads the token file and sends
it on every request.

The token is regenerated on every backend start and written to a file only the
current user can read.
"""

import os
import secrets

TOKEN_DIR = os.path.realpath(
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "..", "data", "runtime")
)
TOKEN_PATH = os.path.join(TOKEN_DIR, "token")

_token = None


def _restrict_permissions(path: str) -> None:
    """Best-effort: make the token file readable only by the current user."""
    try:
        if os.name == "nt":
            import subprocess
            user = os.environ.get("USERNAME", "")
            if user:
                # reset inheritance, grant only the current user read/write
                subprocess.run(["icacls", path, "/inheritance:r"],
                               capture_output=True, check=False)
                subprocess.run(["icacls", path, "/grant:r", f"{user}:F"],
                               capture_output=True, check=False)
        else:
            os.chmod(path, 0o600)
    except Exception:
        # if hardening the ACL fails, the token file still exists and works;
        # the web-page threat (can't read local files at all) is unaffected
        pass


def issue_token() -> str:
    """Generate a fresh token and persist it. Call once at startup."""
    global _token
    _token = secrets.token_urlsafe(32)
    os.makedirs(TOKEN_DIR, exist_ok=True)
    with open(TOKEN_PATH, "w", encoding="utf-8") as f:
        f.write(_token)
    _restrict_permissions(TOKEN_PATH)
    return _token


def current_token() -> str:
    return _token or ""


def check(header_value: str) -> bool:
    if not _token or not header_value:
        return False
    return secrets.compare_digest(header_value, _token)
