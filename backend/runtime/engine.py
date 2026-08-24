import requests
from typing import List, Dict, Any

ENGINE_URL = "http://127.0.0.1:8081/v1/chat/completions"
ENGINE_HEALTH_URL = "http://127.0.0.1:8081/health"


class LocalEngine:
    """
    Thin wrapper around a local inference server that speaks
    OpenAI-style /v1/chat/completions.

    Response shape expected:

    {
        "choices": [
            {
                "message": {
                    "content": "..."
                }
            }
        ]
    }
    """

    def __init__(self, model_name: str = "local-model"):
        self.model_name = model_name

    def health(self) -> Dict[str, Any]:
        """
        Check whether the engine is up and the model is loaded.

        Returns { "status": "ok" } or { "status": "engine_unavailable", "detail": "..." }.
        """
        try:
            res = requests.get(ENGINE_HEALTH_URL, timeout=2)
            res.raise_for_status()
            return {"status": "ok"}
        except Exception as e:
            return {"status": "engine_unavailable", "detail": str(e)}

    def generate(self, messages: List[Dict[str, Any]], max_tokens: int = 1024) -> Dict[str, Any]:
        """
        Send a chat completion request to the local engine.

        messages: list of { "role": "...", "content": "..." }

        Returns a dict shaped like an OpenAI chat completion response,
        or { "error": "..." } on failure.
        """
        payload = {
            "model": self.model_name,
            "messages": messages,
            "max_tokens": max_tokens
        }

        try:
            res = requests.post(ENGINE_URL, json=payload, timeout=300)
            res.raise_for_status()
            return res.json()
        except requests.HTTPError as e:
            # Surface the engine's own message (e.g. context-size errors)
            detail = ""
            try:
                detail = e.response.text[:300]
            except Exception:
                pass
            return {"error": f"{e} {detail}".strip()}
        except Exception as e:
            return {"error": str(e)}


# Singleton-style instance used by the backend
engine = LocalEngine()
