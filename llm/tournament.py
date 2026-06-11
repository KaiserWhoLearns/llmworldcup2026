"""Loads the tournament source data (single source of truth in data/tournament.json).

The prompt text that consumes this data lives in prompts.py.
"""

from __future__ import annotations

import json
from pathlib import Path

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "tournament.json"


def load() -> dict:
    return json.loads(DATA_PATH.read_text(encoding="utf-8"))
