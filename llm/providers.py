"""Per-provider adapters + final-prediction extraction.

Each adapter sends the same system + user prompt and returns the model's FULL
text reply (free-form reasoning followed by a fenced ```json block). predict.py
then calls extract_prediction() to pull the JSON out and validate it.

Two modes:
  * cold (grounded=False) — the model answers from its own knowledge.
  * grounded (grounded=True) — the model gets each provider's official, hosted
    tools (web search, web fetch, code execution / interpreter) so it can look
    up current 2026 form/injuries/odds before predicting. This approximates the
    consumer chat apps (claude.ai, ChatGPT, Gemini) far more faithfully than the
    cold call, while staying fully scriptable. Together (open-source models) has
    no first-party tool platform, so grounded mode is unavailable there.

We never force the whole response to JSON, so the model can reason first.
"""

from __future__ import annotations

import json
import os
import re

MAX_TOKENS = 32000
_PAUSE_TURN_LIMIT = 8  # safety cap on server-tool-loop continuations

# A ```json ... ``` (or bare ``` ... ```) fenced block. Non-greedy on the body,
# anchored to the closing fence, so nested braces inside the JSON are fine.
_FENCE = re.compile(r"```(?:json|JSON)?\s*\n?(.*?)```", re.DOTALL)
_MARKER = re.compile(r"<PREDICTION>\s*(\{.*\})\s*</PREDICTION>", re.DOTALL)


def _find_json_block(text: str) -> tuple[str, int]:
    """Return (json_string, start_index) for the model's final prediction.

    Preference: last ```json fence -> <PREDICTION> markers -> last balanced {...}.
    """
    fences = list(_FENCE.finditer(text))
    if fences:
        m = fences[-1]
        return m.group(1).strip(), m.start()
    m = _MARKER.search(text)
    if m:
        return m.group(1).strip(), m.start()
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return text[start : end + 1], start
    raise ValueError("No JSON prediction block found in the model response.")


def extract_prediction(text: str) -> dict:
    block, _ = _find_json_block(text)
    return json.loads(block)


def extract_reasoning(text: str) -> str:
    """Everything the model wrote before the final JSON block, trimmed."""
    try:
        _, start = _find_json_block(text)
        return text[:start].strip()
    except ValueError:
        return text.strip()


# --------------------------------------------------------------------------- #
# Anthropic — Fable 5, Opus 4.8 (server-side web_search / web_fetch / code_exec)
# --------------------------------------------------------------------------- #
def call_anthropic(model: str, system: str, user: str, grounded: bool = False) -> str:
    import anthropic

    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    base = dict(
        model=model,
        max_tokens=MAX_TOKENS,
        system=system,
        output_config={"effort": "high"},
    )
    if "fable" not in model and "mythos" not in model:
        base["thinking"] = {"type": "adaptive"}  # Fable's thinking is always on
    if grounded:
        base["tools"] = [
            {"type": "web_search_20260209", "name": "web_search"},
            {"type": "web_fetch_20260209", "name": "web_fetch"},
            {"type": "code_execution_20260120", "name": "code_execution"},
        ]

    messages = [{"role": "user", "content": user}]
    texts: list[str] = []
    msg = None
    for _ in range(_PAUSE_TURN_LIMIT):
        with client.messages.stream(**base, messages=messages) as stream:
            msg = stream.get_final_message()
        if msg.stop_reason == "refusal":
            raise RuntimeError(f"Anthropic refused: {getattr(msg, 'stop_details', None)}")
        texts.append("".join(b.text for b in msg.content if b.type == "text"))
        if msg.stop_reason == "pause_turn":  # server tool loop hit its cap; resume
            messages.append({"role": "assistant", "content": msg.content})
            continue
        break
    return {"text": "\n".join(t for t in texts if t), "model": getattr(msg, "model", model)}


# --------------------------------------------------------------------------- #
# OpenAI — grounded uses the Responses API + hosted tools; cold uses chat
# --------------------------------------------------------------------------- #
def call_openai(model: str, system: str, user: str, grounded: bool = False) -> str:
    from openai import OpenAI

    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    if grounded:
        resp = client.responses.create(
            model=model,
            instructions=system,
            input=user,
            tools=[
                {"type": "web_search"},
                {"type": "code_interpreter", "container": {"type": "auto"}},
            ],
        )
        return {"text": resp.output_text or "", "model": getattr(resp, "model", model)}

    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    return {"text": resp.choices[0].message.content or "", "model": getattr(resp, "model", model)}


# --------------------------------------------------------------------------- #
# Together AI — OpenAI-compatible inference; no first-party hosted tools
# --------------------------------------------------------------------------- #
def call_together(model: str, system: str, user: str, grounded: bool = False) -> str:
    if grounded:
        raise RuntimeError("Together has no first-party hosted tools; grounded mode is unavailable.")
    from openai import OpenAI

    client = OpenAI(
        api_key=os.environ["TOGETHER_API_KEY"],
        base_url="https://api.together.xyz/v1",
    )
    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        max_tokens=MAX_TOKENS,
    )
    return {"text": resp.choices[0].message.content or "", "model": getattr(resp, "model", model)}


# --------------------------------------------------------------------------- #
# Google — Gemini (Google Search grounding + code execution)
# --------------------------------------------------------------------------- #
def call_google(model: str, system: str, user: str, grounded: bool = False) -> str:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=os.environ["GOOGLE_API_KEY"])
    cfg = dict(system_instruction=system, max_output_tokens=MAX_TOKENS)
    if grounded:
        cfg["tools"] = [
            types.Tool(google_search=types.GoogleSearch()),
            types.Tool(code_execution=types.ToolCodeExecution()),
        ]
    resp = client.models.generate_content(
        model=model,
        contents=user,
        config=types.GenerateContentConfig(**cfg),
    )
    return {"text": resp.text or "", "model": getattr(resp, "model_version", None) or model}


DISPATCH = {
    "anthropic": call_anthropic,
    "openai": call_openai,
    "together": call_together,
    "google": call_google,
}


def call(provider: str, model: str, system: str, user: str, grounded: bool = False) -> str:
    if provider not in DISPATCH:
        raise ValueError(f"Unknown provider: {provider}")
    return DISPATCH[provider](model, system, user, grounded)
