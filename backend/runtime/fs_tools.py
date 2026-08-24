"""
Sandboxed file tools for repo-linked agent sessions.

Every operation is confined to the linked repo root:
- paths are resolved with realpath and must stay inside the root
  (this also defeats symlink escapes)
- reads and search results are size-capped so a 4k-context model
  is never handed more than it can use
- writes are text-only and size-capped
"""

import os
from typing import Any, Dict, List

READ_CAP_BYTES = 16_000          # per read_file call
WRITE_CAP_BYTES = 200_000        # per write_file call
LIST_CAP_ENTRIES = 200
SEARCH_CAP_RESULTS = 40
SEARCH_FILE_CAP_BYTES = 512_000  # skip huge files while searching
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build"}
# Writing into any of these can hand the host code execution with no user
# action (git hooks fire on commit; editor task files on open). The agent is
# allowed to edit ordinary project files, but never these.
DENY_WRITE_DIRS = {".git", ".github", ".vscode", ".hg", ".svn", ".idea"}
BINARY_SNIFF_BYTES = 1024


class ToolError(Exception):
    """Raised for invalid tool input; message is safe to show the model."""


def _contained(root_real: str, full_path: str) -> bool:
    """
    True if full_path stays inside root_real after resolving links.

    realpath resolves Windows junctions (which os.path.islink does NOT report),
    so this is what stops a junction planted inside the repo from redirecting a
    recursive walk out to an arbitrary directory.
    """
    rp = os.path.realpath(full_path)
    return rp == root_real or rp.startswith(root_real + os.sep)


def _resolve(root: str, rel_path: str) -> str:
    """Resolve rel_path inside root; raise if it escapes."""
    if rel_path is None:
        rel_path = "."
    if not isinstance(rel_path, str):
        raise ToolError("path must be a string")
    if "\x00" in rel_path:
        raise ToolError("invalid path")

    root_real = os.path.realpath(root)
    candidate = os.path.realpath(os.path.join(root_real, rel_path))

    if candidate != root_real and not candidate.startswith(root_real + os.sep):
        raise ToolError(f"path escapes the linked repo: {rel_path}")

    return candidate


def _is_probably_binary(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            chunk = f.read(BINARY_SNIFF_BYTES)
        return b"\x00" in chunk
    except OSError:
        return True


def list_files(root: str, path: str = ".", max_entries: int = LIST_CAP_ENTRIES) -> Dict[str, Any]:
    base = _resolve(root, path)
    if not os.path.isdir(base):
        raise ToolError(f"not a directory: {path}")

    max_entries = min(int(max_entries or LIST_CAP_ENTRIES), LIST_CAP_ENTRIES)
    root_real = os.path.realpath(root)
    entries: List[str] = []
    truncated = False

    for dirpath, dirnames, filenames in os.walk(base):
        # prune skip-dirs AND any junction/symlink that would escape the root
        dirnames[:] = [d for d in dirnames
                       if d not in SKIP_DIRS and _contained(root_real, os.path.join(dirpath, d))]
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            if not _contained(root_real, full):
                continue
            rel = os.path.relpath(full, root_real).replace("\\", "/")
            try:
                size = os.path.getsize(full)
            except OSError:
                size = -1
            entries.append(f"{rel} ({size} bytes)")
            if len(entries) >= max_entries:
                truncated = True
                break
        if truncated:
            break

    return {"entries": entries, "truncated": truncated}


def read_file(root: str, path: str, offset: int = 0) -> Dict[str, Any]:
    full = _resolve(root, path)
    if not os.path.isfile(full):
        raise ToolError(f"not a file: {path}")
    if _is_probably_binary(full):
        raise ToolError(f"binary file, refusing to read as text: {path}")

    offset = max(int(offset or 0), 0)
    size = os.path.getsize(full)

    with open(full, "r", encoding="utf-8", errors="replace") as f:
        f.seek(offset)
        content = f.read(READ_CAP_BYTES)

    truncated = offset + len(content.encode("utf-8", "replace")) < size
    return {"content": content, "size": size, "offset": offset, "truncated": truncated}


def write_file(root: str, path: str, content: str) -> Dict[str, Any]:
    if not isinstance(content, str):
        raise ToolError("content must be a string")
    if len(content.encode("utf-8")) > WRITE_CAP_BYTES:
        raise ToolError(f"content exceeds the {WRITE_CAP_BYTES} byte write cap")

    full = _resolve(root, path)
    if os.path.isdir(full):
        raise ToolError(f"path is a directory: {path}")

    root_real = os.path.realpath(root)
    rel_parts = {p.lower() for p in os.path.relpath(full, root_real).replace("\\", "/").split("/")}
    blocked = rel_parts & DENY_WRITE_DIRS
    if blocked:
        raise ToolError(f"refusing to write inside a protected directory: {', '.join(sorted(blocked))}")

    parent = os.path.dirname(full)
    if parent:
        # parent is inside root because full is
        os.makedirs(parent, exist_ok=True)

    existed = os.path.exists(full)
    with open(full, "w", encoding="utf-8", newline="") as f:
        f.write(content)

    return {"written": path, "bytes": len(content.encode("utf-8")), "created": not existed}


def search_files(root: str, query: str, max_results: int = SEARCH_CAP_RESULTS) -> Dict[str, Any]:
    if not isinstance(query, str) or not query.strip():
        raise ToolError("query must be a non-empty string")

    max_results = min(int(max_results or SEARCH_CAP_RESULTS), SEARCH_CAP_RESULTS)
    root_real = os.path.realpath(root)
    needle = query.lower()
    results: List[str] = []
    truncated = False

    for dirpath, dirnames, filenames in os.walk(root_real):
        # prune skip-dirs AND any junction/symlink that would escape the root
        dirnames[:] = [d for d in dirnames
                       if d not in SKIP_DIRS and _contained(root_real, os.path.join(dirpath, d))]
        for name in filenames:
            full = os.path.join(dirpath, name)
            if not _contained(root_real, full):
                continue
            try:
                if os.path.getsize(full) > SEARCH_FILE_CAP_BYTES or _is_probably_binary(full):
                    continue
                with open(full, "r", encoding="utf-8", errors="replace") as f:
                    for lineno, line in enumerate(f, 1):
                        if needle in line.lower():
                            rel = os.path.relpath(full, root_real).replace("\\", "/")
                            results.append(f"{rel}:{lineno}: {line.strip()[:200]}")
                            if len(results) >= max_results:
                                truncated = True
                                break
            except OSError:
                continue
            if truncated:
                break
        if truncated:
            break

    return {"results": results, "truncated": truncated}


# Registry used by the agent loop. Each entry: name -> (callable, description)
TOOLS = {
    "list_files": (
        list_files,
        'list_files {"path": "."} — list files under a directory in the linked repo',
    ),
    "read_file": (
        read_file,
        'read_file {"path": "src/main.py", "offset": 0} — read a text file (16KB per call; use offset to continue)',
    ),
    "write_file": (
        write_file,
        'write_file {"path": "notes.md", "content": "..."} — create or overwrite a text file',
    ),
    "search_files": (
        search_files,
        'search_files {"query": "TODO"} — find lines containing text across the repo',
    ),
}
