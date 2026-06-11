"""The prompts handed to every model.

Kept separate from data loading (tournament.py) so the wording is easy to read
and tweak. The same SYSTEM_PROMPT + build_user_prompt() output is sent to every
model, so the board is a fair comparison.
"""

from __future__ import annotations


SYSTEM_PROMPT = (
    "You are a world-class football (soccer) analyst predicting the complete results of "
    "the 2026 FIFA World Cup — every group's final standings and the entire knockout "
    "bracket through the Final. Reason from real-world knowledge of the teams, their "
    "form, squads, and FIFA rankings as of mid-2026. First think through your reasoning "
    "(concisely), then commit to a single concrete prediction for every match. Do not "
    "hedge or refuse: a full bracket is required."
)

# The model writes its reasoning, then emits exactly this fenced block as the LAST
# thing in its reply. predict.py extracts it with a regex and validates it.
_JSON_SKELETON = """\
```json
{
  "champion": "TeamName",
  "runner_up": "TeamName",
  "third_place": "TeamName",
  "golden_boot": "Player Name",
  "dark_horse": "TeamName",
  "groups": [
    {"group": "A", "standings": ["1st", "2nd", "3rd", "4th"]}
    // ... one entry for every group A through L ...
  ],
  "best_third_qualifiers": ["Team1", "Team2", "...", "Team8"],
  "knockout": [
    {"match": 73, "round": "Round of 32", "home": "TeamX", "away": "TeamY", "winner": "TeamX"}
    // ... one entry for every match 73 through 104 ...
  ],
  "rationale": "2-4 sentence summary of the headline calls"
}
```"""


def _decode_slot(label: str) -> str:
    """Turn a bracket template slot label into plain English."""
    if label.startswith("W_"):
        return f"Winner of Group {label[2:]}"
    if label.startswith("RU_"):
        return f"Runner-up of Group {label[3:]}"
    if label.startswith("3RD_"):
        groups = label[4:].replace("/", ", ")
        return f"Best third-placed team from Groups {groups}"
    if label.startswith("W") and label[1:].isdigit():
        return f"Winner of Match {label[1:]}"
    if label.startswith("L") and label[1:].isdigit():
        return f"Loser of Match {label[1:]}"
    return label


def _render_groups(data: dict) -> str:
    lines = []
    for letter, teams in data["groups"].items():
        lines.append(f"  Group {letter}: {', '.join(teams)}")
    return "\n".join(lines)


def _render_bracket(data: dict) -> str:
    ko = data["knockout"]
    out = []

    def line(m: dict) -> str:
        return f"  Match {m['match']}: {_decode_slot(m['home'])}  vs  {_decode_slot(m['away'])}"

    out.append("ROUND OF 32 (matches 73-88):")
    out += [line(m) for m in ko["roundOf32"]]
    out.append("\nROUND OF 16 (matches 89-96):")
    out += [line(m) for m in ko["roundOf16"]]
    out.append("\nQUARTERFINALS (matches 97-100):")
    out += [line(m) for m in ko["quarterfinals"]]
    out.append("\nSEMIFINALS (matches 101-102):")
    out += [line(m) for m in ko["semifinals"]]
    out.append("\nTHIRD-PLACE PLAY-OFF (match 103):")
    out.append(line(ko["thirdPlace"]))
    out.append("\nFINAL (match 104):")
    out.append(line(ko["final"]))
    return "\n".join(out)


def build_user_prompt(data: dict) -> str:
    seeds = data["topSeeds"]
    skeleton = _JSON_SKELETON
    return f"""\
TOURNAMENT: {data['name']}
HOSTS: {', '.join(data['hosts'])}
FORMAT: {data['format']}
TOP SEEDS (by FIFA ranking at the draw): 1) {seeds['1']}  2) {seeds['2']}  3) {seeds['3']}  4) {seeds['4']}
OPENING MATCH: {data['openingMatch']['home']} vs {data['openingMatch']['away']} — {data['openingMatch']['date']}
FINAL: {data['finalMatch']['date']}, {data['finalMatch']['venue']}

THE 12 GROUPS:
{_render_groups(data)}

HOW QUALIFICATION WORKS:
- Each team plays the other three in its group once.
- The top 2 of every group advance, plus the 8 best third-placed teams (out of 12).
- Those 32 teams enter the deterministic bracket below.

THE KNOCKOUT BRACKET (slots are filled by group finishing positions you predict):
{_render_bracket(data)}

YOUR TASK — produce a complete, internally consistent prediction:
1. groups: for each of the 12 groups (A-L), order all four teams from 1st to 4th.
2. best_third_qualifiers: choose the 8 third-placed teams (from your 12 group 3rd-place
   finishers) that you predict will advance to the Round of 32.
3. knockout: fill in ALL 32 knockout matches (numbers 73-104). For each match give the
   concrete `home` team, `away` team, and `winner`.
   - Use the bracket template above to place teams: e.g. Match 73 is your Group A
     runner-up vs your Group B runner-up; Match 74 is your Group E winner vs one of your
     qualifying best-third teams; Match 89's home side is the winner you picked for
     Match 74, and so on up the tree.
   - `winner` MUST be exactly the `home` or `away` string you gave for that match.
   - Match 103 is the third-place play-off (the two losing semifinalists); Match 104 is the Final.
4. champion / runner_up / third_place: the Final winner, Final loser, and Match 103 winner.
5. golden_boot: your predicted tournament top scorer (a player's name).
6. dark_horse: a lower-seeded team you expect to overperform.
7. rationale: 2-4 sentences on your headline calls.

Team names must match the spellings used in the groups above exactly.

HOW TO RESPOND:
First, reason through your picks concisely — the group stages and the key knockout
ties. Then, as the LAST thing in your reply, output your final prediction as a single
JSON object inside one ```json code fence, in exactly this shape:

{skeleton}

Output the fenced JSON block exactly once. Everything before it is free-form reasoning."""
