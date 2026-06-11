"""Pydantic schema for a full-bracket 2026 World Cup prediction.

The same shape is used for (a) Anthropic structured output via `messages.parse`,
(b) a JSON Schema handed to OpenAI / Gemini / Together, and (c) validation of
whatever any model returns. Kept deliberately flat and free of numeric/length
constraints so it survives every provider's structured-output limitations; the
finer checks (right number of teams, winner is one of the two sides, etc.) are
done in `validate.py`.
"""

from __future__ import annotations

from typing import List
from pydantic import BaseModel, Field


class GroupStanding(BaseModel):
    group: str = Field(description="Group letter, A through L.")
    standings: List[str] = Field(
        description="The four teams of this group ordered by predicted final "
        "position: index 0 = 1st (winner), 1 = 2nd (runner-up), 2 = 3rd, 3 = 4th."
    )


class KnockoutMatch(BaseModel):
    match: int = Field(description="Official match number, 73-104.")
    round: str = Field(description="One of: Round of 32, Round of 16, Quarterfinal, Semifinal, Third Place, Final.")
    home: str = Field(description="Predicted team in the 'home' slot of this match.")
    away: str = Field(description="Predicted team in the 'away' slot of this match.")
    winner: str = Field(description="Predicted winner — must be exactly the home or away team.")


class WorldCupPrediction(BaseModel):
    champion: str
    runner_up: str
    third_place: str
    golden_boot: str = Field(description="Predicted top scorer of the tournament (player name).")
    dark_horse: str = Field(description="A lower-seeded team predicted to overperform.")
    groups: List[GroupStanding] = Field(description="All 12 groups, A through L.")
    best_third_qualifiers: List[str] = Field(
        description="The 8 third-placed teams predicted to advance to the Round of 32."
    )
    knockout: List[KnockoutMatch] = Field(
        description="All 32 knockout matches (numbers 73-104) with predicted teams and winners."
    )
    rationale: str = Field(description="2-4 sentences explaining the headline calls.")


# JSON Schema for providers that take a raw schema (OpenAI / Gemini / Together).
# Derived from the Pydantic model; `additionalProperties: false` everywhere as
# required by strict structured-output modes.
def json_schema() -> dict:
    schema = WorldCupPrediction.model_json_schema()

    def strip(node: dict) -> None:
        if not isinstance(node, dict):
            return
        node.pop("title", None)
        node.pop("default", None)
        if node.get("type") == "object":
            node["additionalProperties"] = False
            node.setdefault("required", list(node.get("properties", {}).keys()))
        for child in list(node.get("properties", {}).values()):
            strip(child)
        if "items" in node:
            strip(node["items"])
        for key in ("$defs", "definitions"):
            for child in node.get(key, {}).values():
                strip(child)

    strip(schema)
    return schema
