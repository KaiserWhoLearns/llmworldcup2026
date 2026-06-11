# LLM World Cup Predictions

LLMs are asked to predict the 2026 World Cup — all 12 group standings and
the full knockout bracket through the Final. The site displays each model's picks side
by side. You can also fill out your own bracket and compare it against them.

**Live site:** https://kaiserwholearns.github.io/llmworldcup2026/

---

## View the board & make your prediction

The site is fully static — open the live link above, or run it locally:

```bash
cd docs
python3 -m http.server 8000
# open http://localhost:8000
```

- **Board** (`index.html`) — one card per model showing its champion and runner-up.
  Click a card to expand the full bracket, group standings, and the model's reasoning.
  Entries marked 🔎 **(web)** were given the provider's hosted tools (web search, web
  fetch, code execution) to look up current information before predicting; entries
  without the badge rely only on the model's parametric knowledge — no tools, no internet.
- **Make your prediction** (`predict.html`) — rank each group, pick which third-placed
  teams advance, then click your way up the bracket to a champion.

### Creating a prediction submission

1. Open **Make your prediction** (the link in the top nav, or `predict.html`).
2. Enter your name, order each group, choose the third-place qualifiers, and pick the
   winner of every knockout match up to the Final.
3. Click **Save** — your prediction is stored in your browser and appears in the board's
   selector so you can compare it against the models.
4. Click **Download** to export it as a JSON file (e.g. to share or back up).

> Submissions live in your browser only (`localStorage`); they aren't uploaded anywhere.

---

## Adding more model predictions

Model predictions are generated offline by the Python pipeline in [`llm/`](llm/), which
writes one JSON file per model into `docs/data/predictions/`. The website just renders
those files — it never calls an LLM itself.

**Setup:**

```bash
cd llm
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # paste in your API keys
```

Supported providers: Anthropic, OpenAI, Google, Together (fill in only the keys you need).

**Add a model:** edit [`llm/models.json`](llm/models.json) and add an entry:

```json
{ "id": "openai-gpt", "label": "GPT-5.4", "provider": "openai",
  "model": "gpt-5.4", "grounded": false, "enabled": true }
```

- `id` — the slug used for the output filename and on the board (keep it stable).
- `label` — the display name shown on the card.
- `provider` — one of `anthropic`, `openai`, `google`, `together`.
- `model` — the exact model string your account can serve.
- `grounded` — `true` gives the model its provider's hosted tools so it can look up
  current information before predicting (shown as a `(web)` entry with a 🔎 badge);
  `false` relies only on the model's parametric knowledge. Tools by provider: Anthropic —
  web search + web fetch + code execution; OpenAI — web search + code interpreter;
  Google — Google Search + code execution; Together has no hosted tools (cold only).
- `enabled` — set `false` to skip an entry without deleting it.

**Generate predictions:**

```bash
python predict.py                                  # every enabled model
python predict.py --only openai-gpt,anthropic-opus-4-8
python predict.py --provider anthropic
python predict.py --dry-run                        # print the prompt, call nothing
```

Each run validates the output and writes `docs/data/predictions/<id>.json` plus updates
`docs/data/index.json`. **Commit the updated `docs/data/` and push** to refresh the live
board.

---

## Reusing the prediction prompts

Every model receives the **same prompt** for a fair comparison. It lives in one place:
[`llm/prompts.py`](llm/prompts.py).

- `SYSTEM_PROMPT` — the instructions (reason first, then emit the prediction as a single
  fenced JSON block).
- `build_user_prompt(data)` — renders the real 2026 groups and bracket from
  [`data/tournament.json`](data/tournament.json) into the question.

To reuse the prompt elsewhere (your own script, a notebook, a different harness):

```python
from llm.prompts import SYSTEM_PROMPT, build_user_prompt
from llm.tournament import load_tournament

user_prompt = build_user_prompt(load_tournament())
# send SYSTEM_PROMPT + user_prompt to any model you like
```

Edit the wording in `prompts.py` to change what every model is asked.

---

## Layout

```
data/tournament.json   Source of truth: real 2026 groups, schedule, bracket
llm/                   Python pipeline that generates model predictions
  predict.py             Runner: prompt → models → validated JSON
  prompts.py             The shared prompt (edit wording here)
  models.json            The model roster
docs/                  The static website (served by GitHub Pages)
  index.html             The board
  predict.html           Make-your-own bracket
  data/                  tournament.json + predictions the board reads
```
