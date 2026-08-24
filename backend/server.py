import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional

from runtime.engine import engine
from runtime import sessions as session_store
from runtime import agent
from runtime import auth
from runtime import fs_tools

# NOTE: deliberately no CORS middleware. The UI reaches this API through
# the Electron main process (a server-to-server call), so browser CORS is
# never needed — and without permissive CORS headers, scripts running in
# any local web page cannot read responses from this API.
app = FastAPI()

# Reject any request whose Host header isn't loopback. This is what stops a
# DNS-rebinding page (Host: evil.example:8000) from reaching the API as if it
# were same-origin.
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["127.0.0.1", "localhost", "127.0.0.1:8000", "localhost:8000"],
)

# Endpoints reachable without the shared-secret token. /health and / leak no
# data and have no side effects, so the UI readiness poll can hit them before
# it has read the token file.
_PUBLIC_PATHS = {"/", "/health"}


@app.middleware("http")
async def require_token(request: Request, call_next):
    if request.url.path not in _PUBLIC_PATHS:
        if not auth.check(request.headers.get("x-lcl-token", "")):
            return JSONResponse(status_code=401, content={"error": "unauthorized"})
    return await call_next(request)


MAX_MESSAGE_CHARS = 32_000

# -------------------------------------------------------------
# REQUEST / RESPONSE MODELS
# -------------------------------------------------------------
class Message(BaseModel):
    role: str
    content: str

class ChatCompletionRequest(BaseModel):
    model: str
    messages: List[Message]

class ChatResponse(BaseModel):
    choices: List[Dict[str, Any]]

class CreateSessionRequest(BaseModel):
    title: str = ""

class RenameSessionRequest(BaseModel):
    title: str = Field(min_length=1, max_length=120)

class LinkRepoRequest(BaseModel):
    path: str = Field(min_length=1, max_length=1000)

class SessionChatRequest(BaseModel):
    content: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)


def _err(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})

# -------------------------------------------------------------
# ROOT / HEALTH
# -------------------------------------------------------------
@app.get("/")
def root():
    return {"status": "LCL backend running"}

@app.get("/health")
def health():
    """Reports ok only when the engine is reachable and its model is loaded."""
    return engine.health()

# -------------------------------------------------------------
# SESSIONS
# -------------------------------------------------------------
@app.get("/sessions")
def list_sessions():
    return {"sessions": session_store.list_all()}

@app.post("/sessions")
def create_session(req: CreateSessionRequest):
    return session_store.create(req.title)

@app.get("/sessions/{session_id}")
def get_session(session_id: str):
    session = session_store.load(session_id)
    if session is None:
        return _err(404, "session not found")
    return session

@app.patch("/sessions/{session_id}")
def rename_session(session_id: str, req: RenameSessionRequest):
    session = session_store.load(session_id)
    if session is None:
        return _err(404, "session not found")
    session["title"] = req.title.strip()[:120]
    session_store.save(session)
    return {"id": session["id"], "title": session["title"]}

@app.delete("/sessions/{session_id}")
def delete_session(session_id: str):
    if not session_store.delete(session_id):
        return _err(404, "session not found")
    return {"deleted": session_id}

@app.get("/sessions/{session_id}/files")
def session_files(session_id: str):
    """File listing for the workspace panel — sandboxed to the linked repo."""
    session = session_store.load(session_id)
    if session is None:
        return _err(404, "session not found")

    repo = session.get("repoPath")
    if not repo:
        return {"repoPath": None, "entries": [], "truncated": False}
    if not os.path.isdir(repo):
        return _err(400, f"linked folder no longer exists: {repo}")

    try:
        result = fs_tools.list_files(repo, ".")
    except fs_tools.ToolError as e:
        return _err(400, str(e))

    return {"repoPath": repo, **result}

@app.post("/sessions/{session_id}/repo")
def link_repo(session_id: str, req: LinkRepoRequest):
    session = session_store.load(session_id)
    if session is None:
        return _err(404, "session not found")

    path = os.path.realpath(req.path)
    if not os.path.isdir(path):
        return _err(400, f"not a directory: {req.path}")

    drive_root = os.path.splitdrive(path)[0] + os.sep
    if path == os.path.realpath(drive_root):
        return _err(400, "refusing to link a whole drive root — pick a project folder")

    # Defense in depth: never let the sandbox root be a home/system directory
    # whose whole subtree of secrets the agent could then read or write.
    sensitive = set()
    for env in ("USERPROFILE", "WINDIR", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "SystemRoot"):
        val = os.environ.get(env)
        if val:
            sensitive.add(os.path.realpath(val))
    users_dir = os.path.realpath(os.path.join(drive_root, "Users"))
    sensitive.add(users_dir)
    if path in sensitive:
        return _err(400, "refusing to link a home or system directory — pick a project folder")

    session["repoPath"] = path
    session_store.save(session)
    return {"id": session["id"], "repoPath": path}

@app.delete("/sessions/{session_id}/repo")
def unlink_repo(session_id: str):
    session = session_store.load(session_id)
    if session is None:
        return _err(404, "session not found")
    session["repoPath"] = None
    session_store.save(session)
    return {"id": session["id"], "repoPath": None}

# -------------------------------------------------------------
# SESSION CHAT (agent loop with repo tools when linked)
# -------------------------------------------------------------
@app.post("/sessions/{session_id}/chat")
def session_chat(session_id: str, req: SessionChatRequest):
    session = session_store.load(session_id)
    if session is None:
        return _err(404, "session not found")

    # a linked repo may have been moved or deleted since it was linked
    repo = session.get("repoPath")
    if repo and not os.path.isdir(repo):
        session["repoPath"] = None
        session_store.save(session)
        return _err(400, f"linked repo no longer exists, unlinked it: {repo}")

    result = agent.run_turn(session, req.content)

    if not result["ok"]:
        return _err(502, result["error"])

    if session["title"] in ("", "New session"):
        session["title"] = req.content.strip()[:48]

    session_store.save(session)
    return {
        "id": session["id"],
        "title": session["title"],
        "new_messages": result["new_messages"],
    }

# -------------------------------------------------------------
# OPENAI-COMPAT ENDPOINT (kept for external local API clients)
# -------------------------------------------------------------
@app.post("/v1/chat/completions")
def chat_completions(req: ChatCompletionRequest):
    messages = [{"role": m.role, "content": m.content} for m in req.messages]

    result = engine.generate(messages)

    if "error" in result:
        return _err(502, result["error"])

    try:
        return ChatResponse(**result)
    except Exception:
        return _err(502, "Invalid response from engine.")

# -------------------------------------------------------------
# RUNNING (only used when running directly)
# -------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    auth.issue_token()
    uvicorn.run(app, host="127.0.0.1", port=8000)
