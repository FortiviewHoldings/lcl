"""
File-backed session store.

One JSON file per session in C:\\.lcl\\data\\sessions.
Sessions survive restarts; no database needed.
"""

import json
import os
import time
import uuid
from typing import Any, Dict, List, Optional

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "..", "data", "sessions")
DATA_DIR = os.path.realpath(DATA_DIR)

_ID_ALPHABET = set("0123456789abcdef-")


def _ensure_dir() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)


def _path_for(session_id: str) -> str:
    # ids are uuid4 strings we generated; validate anyway so a crafted id
    # can never become a path component that escapes the data dir
    if not isinstance(session_id, str) or not session_id or len(session_id) > 40:
        raise ValueError("invalid session id")
    if not set(session_id) <= _ID_ALPHABET:
        raise ValueError("invalid session id")
    return os.path.join(DATA_DIR, f"{session_id}.json")


def create(title: str = "") -> Dict[str, Any]:
    _ensure_dir()
    session = {
        "id": str(uuid.uuid4()),
        "title": (title or "New session")[:80],
        "createdAt": time.time(),
        "updatedAt": time.time(),
        "repoPath": None,
        "messages": [],
    }
    _save(session)
    return session


def _save(session: Dict[str, Any]) -> None:
    _ensure_dir()
    session["updatedAt"] = time.time()
    tmp = _path_for(session["id"]) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(session, f, ensure_ascii=False, indent=1)
    os.replace(tmp, _path_for(session["id"]))


def load(session_id: str) -> Optional[Dict[str, Any]]:
    try:
        with open(_path_for(session_id), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError, json.JSONDecodeError):
        return None


def save(session: Dict[str, Any]) -> None:
    _save(session)


def delete(session_id: str) -> bool:
    try:
        os.remove(_path_for(session_id))
        return True
    except (OSError, ValueError):
        return False


def list_all() -> List[Dict[str, Any]]:
    _ensure_dir()
    out = []
    for name in os.listdir(DATA_DIR):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(DATA_DIR, name), "r", encoding="utf-8") as f:
                s = json.load(f)
            out.append({
                "id": s["id"],
                "title": s.get("title", "Untitled"),
                "repoPath": s.get("repoPath"),
                "updatedAt": s.get("updatedAt", 0),
                "messageCount": len(s.get("messages", [])),
            })
        except (OSError, KeyError, json.JSONDecodeError):
            continue
    out.sort(key=lambda s: s["updatedAt"], reverse=True)
    return out
