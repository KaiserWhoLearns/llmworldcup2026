# 2026 World Cup — LLM Prediction Board

A two-part project for the 2026 FIFA World Cup (hosted by the USA, Canada & Mexico,
11 June – 19 July 2026):

1. **`llm/`** — a Python pipeline that asks a roster of LLMs to predict the *entire*
   tournament (all 12 group standings + the full knockout bracket through the Final)
   and writes the results as JSON.
2. **`web/`** — a static site that visualises those predictions side-by-side and lets
   humans fill out their own bracket.

It's a **preview board**, not yet a leaderboard — the tournament hasn't finished, so
there are no scores yet (scoring is on the backlog; see below).

> Scope: **LLM setting only.** The "agents" setting (LLMs in a harness — Claude Code,
> Codex, etc.) is intentionally deferred to the backlog.

---

## How it fits together

```
data/tournament.json   ← single source of truth: real 2026 groups, schedule, bracket
        │
        ├── llm/predict.py  ── calls each model once ──▶  web/data/predictions/<id>.json
        │                                                 web/data/index.json
        │                                                 web/data/tournament.json (copied)
        │
        └── web/ (static)   ── fetches the JSON above ──▶  board + human-entry UI
```

The website **never calls an LLM API**. `predict.py` runs offline, produces JSON, and
the site just renders it. That makes the whole `web/` folder safe to drop onto GitHub
Pages.

The 2026 data (groups A–L, the deterministic Round-of-32 → Final bracket, schedule,
top seeds) was sourced from the official final draw (Washington D.C., 5 Dec 2025) and
Wikipedia's knockout-stage bracket, and is baked into both the prompt and the UI.

---

## 1. Generate model predictions (`llm/`)

### Setup

```bash
cd llm
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt        # installs all provider SDKs
cp .env.example .env                    # then paste in your API keys
```

`.env` keys (fill in only the providers you want to run):
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `TOGETHER_API_KEY`.

### ⚠️ Verify model IDs first

`llm/models.json` lists the roster. **Anthropic** IDs (`claude-fable-5`,
`claude-opus-4-8`) are current. **Google / OpenAI / Together** IDs are sensible
defaults that you should confirm against each provider's live catalogue before a real
run — exact model strings drift over time. Edit the `model` field (and toggle
`enabled`) for each entry.

| id | provider | default model | notes |
|----|----------|---------------|-------|
| `anthropic-fable-5` | anthropic | `claude-fable-5` | thinking always on |
| `anthropic-opus-4-8` | anthropic | `claude-opus-4-8` | adaptive thinking + high effort |
| `google-gemini-pro` / `-flash` | google | `gemini-2.5-pro` / `-flash` | **verify** |
| `openai-gpt` / `-gpt-mini` | openai | `gpt-5` / `gpt-5-mini` | **verify** |
| `together-qwen` / `-deepseek` | together | Qwen / DeepSeek-V4-Pro | **verify** |

### Run

```bash
python predict.py                 # every enabled model
python predict.py --only anthropic-opus-4-8,openai-gpt
python predict.py --provider anthropic
python predict.py --dry-run       # print the exact prompt, call nothing
```

Each model gets the **same prompt** (fair comparison). It's asked to **reason first,
then emit its final prediction as a single fenced `json` block** — so you can see the
model's thinking, not just its answer. `predict.py` then regex-extracts that JSON block
(`providers.extract_prediction`), validates it with Pydantic, and runs consistency
checks.

Output per model lands in `web/data/predictions/<id>.json` with the validated
`prediction`, the free-form `reasoning` (shown collapsibly on the board), and any
`warnings` (e.g. a knockout winner that isn't one of the two listed teams). Errors —
including "couldn't find/parse the JSON block" — are captured per-model so one failing
provider doesn't sink the run. The full raw replies are kept in
`llm/predictions_raw/<id>.txt` for debugging.

### Cold vs grounded (web tools)

Each big-three model runs in two flavours, shown as **separate board entries**:

- **cold** (`grounded: false`) — answers from its own knowledge.
- **grounded / `… (web)`** (`grounded: true`) — gets the provider's **official hosted
  tools** (web search, web fetch, code execution/interpreter) so it can look up current
  2026 form, injuries, and odds before predicting. This approximates the consumer chat
  apps (claude.ai, ChatGPT, Gemini) while staying scriptable and reproducible-ish.
  - Anthropic: `web_search` + `web_fetch` + `code_execution` (server-side; the adapter
    handles the `pause_turn` tool loop).
  - OpenAI: Responses API with `web_search` + `code_interpreter`.
  - Google: Gemini with Google Search grounding + code execution.
  - Together (open-source models) has no first-party tool platform → **cold only**.

Grounded results vary over time (the web changes), so the `generatedAt` stamp matters.
The hosted-tool identifiers, like the model IDs, should be **verified** against each
provider's current docs before a real run.

### Rough cost per full run

One prediction call per model. Order-of-magnitude only — assumes ~1.7K prompt tokens,
and for grounded runs ~15–25K extra input tokens from injected search results plus
~5–10K output/thinking tokens and a few web-search queries. Token prices for the
non-Anthropic models and per-search surcharges **change often — confirm them**.

| Entry | ~Cost (cold) | ~Cost (grounded) |
|-------|-------------|------------------|
| Claude Fable 5 | ~$0.15 | ~$0.70–1.00 |
| Claude Opus 4.8 | ~$0.08 | ~$0.30–0.45 |
| Gemini 2.5 Pro | ~$0.03 | ~$0.10–0.20 |
| Gemini 2.5 Flash | ~$0.01 | ~$0.03 |
| GPT-5 | ~$0.05 | ~$0.10–0.20 |
| GPT-5 mini | ~$0.01 | ~$0.03 |
| Qwen / DeepSeek (Together) | ~$0.01 each | n/a |

**A full run of all 14 entries lands roughly in the $2–4 range** — dominated by the
grounded Fable 5 call. To trim cost: `python predict.py --only anthropic-opus-4-8,anthropic-opus-4-8-web`,
or set `enabled: false` on the entries you don't need in `models.json`.

---

## 2. View the board / enter your own (`web/`)

It's a static site — just serve the folder (don't open via `file://`, the `fetch`
calls need HTTP):

```bash
cd web
python3 -m http.server 8000
# open http://localhost:8000
```

- **Board (`index.html`)** — a grid of cards, one per entry, each showing the headline
  call (champion + runner-up, the exact served model version, plus a 🔎 badge for
  web-grounded runs). Click any card to expand the full detail below:
  champion/golden-boot/dark-horse, all 12 group standings, the full bracket with winners
  highlighted, and the model's reasoning (collapsible). The board is built from whatever
  prediction files exist in `web/data/predictions/`; if none exist yet it shows an empty
  state until you run `predict.py`.
- **Make your prediction (`predict.html`)** — rank each group, choose which 3rd-placed
  teams qualify into the eight third-place slots, then click your way up the bracket
  to a champion. Saved predictions live in your browser (`localStorage`), show up in
  the board's selector, and can be exported as JSON.

### Deploying to GitHub Pages

The `web/` folder is fully self-contained. Either set Pages to serve from `/web`, or
copy `web/`'s contents to the repo root / a `docs/` folder. All paths are relative, so
no build step is required. Re-run `predict.py` and commit the updated `web/data/` to
refresh the board.

---

## Backlog / next steps

- **Scoring & a real leaderboard** — once matches are played, score each prediction
  (e.g. points for correct group order, correct qualifiers, correct knockout winners,
  bonus for the champion) and rank models + humans. The prediction schema
  (`llm/schema.py`) is already shaped for this.
- **Agent setting** — re-run the same prediction task through harnessed agents
  (Claude Code, Codex) and add them as a second track on the board.
- A few of the open-source / Gemini / OpenAI model IDs need verifying against live
  catalogues (see above).

## Layout

```
data/tournament.json        Source of truth (groups, schedule, bracket template)
llm/
  predict.py                Runner: prompt → models → validated JSON
  providers.py              Per-provider adapters + final-JSON extraction (regex)
  prompts.py                The shared system + user prompt (edit wording here)
  tournament.py             Loads data/tournament.json
  schema.py                 Pydantic schema used to validate the extracted prediction
  models.json               Editable model roster
  requirements.txt, .env.example
web/
  index.html, predict.html  Board + human entry
  js/common.js              Data loading + deterministic bracket resolver
  js/board.js, js/predict.js
  css/styles.css
  data/                     tournament.json, index.json, predictions/*.json (served)
```
