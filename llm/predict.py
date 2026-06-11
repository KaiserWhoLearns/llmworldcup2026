#!/usr/bin/env python3
"""Generate 2026 World Cup predictions from a roster of LLMs.

Runs each enabled model in models.json against one shared prompt, validates the
structured output, and writes per-model JSON into web/data/predictions/ (plus an
index.json) so the static web app can render it. The LLM code runs ONCE to
produce these files — the website never calls an API.

Usage:
  python predict.py                      # run every enabled model
  python predict.py --only anthropic-opus-4-8,openai-gpt
  python predict.py --provider anthropic
  python predict.py --dry-run            # print the prompt and exit, call nothing
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from pydantic import ValidationError

import prompts
import providers
import tournament
from schema import WorldCupPrediction

ROOT = Path(__file__).resolve().parent.parent
WEB_DATA = ROOT / "web" / "data"
PRED_DIR = WEB_DATA / "predictions"
RAW_DIR = ROOT / "llm" / "predictions_raw"


def _norm(s: str) -> str:
    """Accent- and case-insensitive key for matching team names."""
    stripped = "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))
    return stripped.strip().lower()


def canonicalize(pred: dict, data: dict) -> dict:
    """Snap model-written team names back to the canonical spellings in the data
    (e.g. 'Curacao' -> 'Curaçao'), so accents/case don't cause false mismatches.
    Player names (golden_boot) and free text are left untouched."""
    canon = {_norm(t): t for teams in data["groups"].values() for t in teams}

    def c(v):
        return canon.get(_norm(v), v) if isinstance(v, str) else v

    for key in ("champion", "runner_up", "third_place", "dark_horse"):
        if key in pred:
            pred[key] = c(pred[key])
    for g in pred.get("groups", []):
        g["standings"] = [c(x) for x in g.get("standings", [])]
    pred["best_third_qualifiers"] = [c(x) for x in pred.get("best_third_qualifiers", [])]
    for m in pred.get("knockout", []):
        for k in ("home", "away", "winner"):
            if k in m:
                m[k] = c(m[k])
    return pred


def validate(pred: dict, data: dict) -> tuple[dict, list[str]]:
    """Pydantic-validate, then run soft consistency checks. Returns (clean, warnings)."""
    model = WorldCupPrediction.model_validate(pred)
    clean = model.model_dump()
    warnings: list[str] = []

    valid_teams = {t for teams in data["groups"].values() for t in teams}

    # Group standings must each be a permutation of that group's four teams.
    seen_groups = set()
    for g in clean["groups"]:
        seen_groups.add(g["group"])
        expected = set(data["groups"].get(g["group"], []))
        got = set(g["standings"])
        if expected and got != expected:
            warnings.append(f"Group {g['group']} standings {sorted(got)} != group teams {sorted(expected)}.")
        if len(g["standings"]) != 4:
            warnings.append(f"Group {g['group']} has {len(g['standings'])} teams, expected 4.")
    missing = set(data["groups"]) - seen_groups
    if missing:
        warnings.append(f"Missing groups: {sorted(missing)}.")

    if len(clean["best_third_qualifiers"]) != 8:
        warnings.append(f"best_third_qualifiers has {len(clean['best_third_qualifiers'])}, expected 8.")

    # Knockout: numbers present, winner is one of the two sides, teams are real.
    by_num = {m["match"]: m for m in clean["knockout"]}
    expected_nums = set(range(73, 105))
    if set(by_num) != expected_nums:
        warnings.append(f"Knockout match numbers {sorted(set(by_num) ^ expected_nums)} are off.")
    for m in clean["knockout"]:
        if m["winner"] not in (m["home"], m["away"]):
            warnings.append(f"Match {m['match']}: winner '{m['winner']}' is neither side.")
        for slot in ("home", "away"):
            if m[slot] not in valid_teams:
                warnings.append(f"Match {m['match']}: {slot} '{m[slot]}' is not a known team.")

    final = by_num.get(104)
    third = by_num.get(103)
    if final and clean["champion"] != final.get("winner"):
        warnings.append("champion does not match the Final (match 104) winner.")
    if third and clean["third_place"] != third.get("winner"):
        warnings.append("third_place does not match the play-off (match 103) winner.")

    return clean, warnings


def run_model(spec: dict, system: str, user: str, data: dict) -> dict:
    grounded = spec.get("grounded", False)
    record = {
        "id": spec["id"],
        "label": spec["label"],
        "provider": spec["provider"],
        "model": spec["model"],            # the id we requested
        "resolvedModel": spec["model"],    # the exact id the API reports serving (set below)
        "grounded": grounded,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "prediction": None,
        "reasoning": None,
        "warnings": [],
        "error": None,
    }
    raw_path = RAW_DIR / f"{spec['id']}.txt"
    try:
        result = providers.call(spec["provider"], spec["model"], system, user, grounded)
        text = result["text"]
        record["resolvedModel"] = result.get("model") or spec["model"]
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        raw_path.write_text(text, encoding="utf-8")  # full reply, for debugging

        record["reasoning"] = providers.extract_reasoning(text)
        pred = providers.extract_prediction(text)  # regex-extracts the fenced JSON
        pred = canonicalize(pred, data)             # snap team names to canonical spellings
        clean, warnings = validate(pred, data)
        record["prediction"] = clean
        record["warnings"] = warnings
    except ValidationError as e:
        record["error"] = f"Schema validation failed: {e.error_count()} error(s). See {raw_path}."
    except (ValueError, json.JSONDecodeError) as e:
        record["error"] = f"Could not extract prediction JSON: {e}. See {raw_path}."
    except Exception as e:  # noqa: BLE001 — surface any provider/SDK error per-model
        record["error"] = f"{type(e).__name__}: {e}"
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", help="Comma-separated model ids to run.")
    parser.add_argument("--provider", help="Run only models from this provider.")
    parser.add_argument("--models-file", default=str(Path(__file__).parent / "models.json"))
    parser.add_argument("--dry-run", action="store_true", help="Print the prompt and exit.")
    args = parser.parse_args()

    load_dotenv(Path(__file__).parent / ".env")           # llm/.env
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")  # project root .env
    data = tournament.load()
    system = prompts.SYSTEM_PROMPT
    user = prompts.build_user_prompt(data)

    if args.dry_run:
        print("=== SYSTEM ===\n" + system + "\n\n=== USER ===\n" + user)
        return 0

    roster = json.loads(Path(args.models_file).read_text())["models"]
    roster = [m for m in roster if m.get("enabled", True)]
    if args.only:
        wanted = {s.strip() for s in args.only.split(",")}
        roster = [m for m in roster if m["id"] in wanted]
    if args.provider:
        roster = [m for m in roster if m["provider"] == args.provider]

    if not roster:
        print("No models selected. Check models.json / --only / --provider.", file=sys.stderr)
        return 1

    PRED_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy(tournament.DATA_PATH, WEB_DATA / "tournament.json")

    ran = 0
    for spec in roster:
        print(f"→ {spec['label']} ({spec['provider']}:{spec['model']}) ...", flush=True)
        record = run_model(spec, system, user, data)
        (PRED_DIR / f"{spec['id']}.json").write_text(
            json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        ran += 1
        if record["error"]:
            print(f"   ✗ {record['error']}")
        else:
            champ = record["prediction"]["champion"]
            warn = f" ({len(record['warnings'])} warning(s))" if record["warnings"] else ""
            print(f"   ✓ champion: {champ}{warn}")

    rebuild_index()
    print(f"\nRan {ran} model(s). Index rebuilt from {PRED_DIR}")
    return 0


def rebuild_index() -> None:
    """Rebuild index.json from every prediction file on disk, so incremental
    runs (--only / --provider) accumulate rather than clobber the board."""
    entries = []
    for path in sorted(PRED_DIR.glob("*.json")):
        rec = json.loads(path.read_text(encoding="utf-8"))
        pred = rec.get("prediction")
        entries.append({
            "id": rec["id"],
            "label": rec["label"],
            "provider": rec["provider"],
            "model": rec["model"],
            "resolvedModel": rec.get("resolvedModel", rec["model"]),
            "grounded": rec.get("grounded", False),
            "generatedAt": rec.get("generatedAt"),
            "hasError": rec.get("error") is not None,
            "champion": pred["champion"] if pred else None,
            "runnerUp": pred["runner_up"] if pred else None,
        })
    (WEB_DATA / "index.json").write_text(json.dumps(entries, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
