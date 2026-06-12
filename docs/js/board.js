import {
  loadTournament,
  loadIndex,
  loadPrediction,
  expandRecord,
  ROUND_ORDER,
  el,
} from "./common.js";

let tournament = null;
let entries = []; // {id, label, kind, grounded, summary:{champion,runnerUp,hasError}, record}
let activeId = null;
let filter = "llm"; // "llm" (default) | "human" | "all"

async function init() {
  tournament = await loadTournament();
  renderMeta();

  // Every entry — model and merged human alike — comes from data/index.json.
  // Human submissions are ingested into data/predictions/ and tagged kind:"human".
  const index = await loadIndex();
  entries = index.map((m) => ({
    id: m.id,
    label: m.label,
    kind: m.kind || "llm",
    grounded: m.grounded,
    summary: { champion: m.champion, runnerUp: m.runnerUp, hasError: m.hasError, model: m.resolvedModel || m.model },
    record: null,
  }));

  document.getElementById("closeDetail").onclick = closeDetail;
  wireFilter();
  renderGrid();
}

function wireFilter() {
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.onclick = () => {
      filter = btn.dataset.filter;
      document.querySelectorAll(".filter-btn").forEach((b) => b.classList.toggle("active", b === btn));
      renderGrid();
    };
  });
}

function visibleEntries() {
  if (filter === "all") return entries;
  return entries.filter((e) => e.kind === filter);
}

function renderMeta() {
  const t = tournament;
  document.getElementById("meta").innerHTML = `
    <span><strong>${t.hosts.join(" · ")}</strong></span>
    <span>${t.schedule.groupStage} group stage</span>
    <span>Final: ${t.schedule.final} · ${t.finalMatch.venue}</span>`;
}

function renderGrid() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  const shown = visibleEntries();
  if (!shown.length) {
    const msg =
      filter === "human"
        ? "No human predictions in this browser yet. Make one on the “Make your prediction” page, then refresh."
        : filter === "llm"
        ? "No model predictions yet. Run the predictor (see README) to generate them, then refresh."
        : "No predictions yet. Run the predictor (see README) or add your own on the “Make your prediction” page, then refresh.";
    grid.appendChild(el("p", "empty", msg));
    return;
  }
  for (const e of shown) {
    const card = el("button", "pred-card");
    card.dataset.id = e.id;
    if (e.id === activeId) card.classList.add("active");

    const top = el("div", "pc-top");
    top.appendChild(el("span", "pc-kind", e.kind === "human" ? "🧑" : "🤖"));
    top.appendChild(el("span", "pc-label", e.label));
    if (e.grounded) top.appendChild(el("span", "pc-badge", "🔎 web"));
    card.appendChild(top);

    if (e.kind === "llm" && e.summary.model) {
      card.appendChild(el("div", "pc-model", e.summary.model));
    }

    if (e.summary.hasError) {
      card.appendChild(el("div", "pc-champ err", "⚠ error"));
    } else {
      const champ = el("div", "pc-champ");
      champ.appendChild(el("span", "pc-trophy", "🏆"));
      champ.appendChild(el("span", null, e.summary.champion || "—"));
      card.appendChild(champ);
      card.appendChild(el("div", "pc-runner", `runner-up: ${e.summary.runnerUp || "—"}`));
    }
    card.onclick = () => select(e.id);
    grid.appendChild(card);
  }
}

async function select(id) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  activeId = id;
  // reflect active state on cards
  document.querySelectorAll(".pred-card").forEach((c) => c.classList.toggle("active", c.dataset.id === id));

  let record = entry.record;
  if (!record) {
    try {
      record = await loadPrediction(entry.id);
      // Human submissions are stored compact; rebuild the full bracket for display.
      if (record && record.format === "compact") record = expandRecord(record, tournament);
      entry.record = record;
    } catch (err) {
      showError(`Failed to load ${entry.label}: ${err.message}`);
      return;
    }
  }
  renderDetail(entry, record);
}

function openDetailSection(titleText) {
  document.getElementById("detailTitle").textContent = titleText;
  const sec = document.getElementById("detailSection");
  sec.classList.remove("hidden");
  sec.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeDetail() {
  activeId = null;
  document.getElementById("detailSection").classList.add("hidden");
  document.querySelectorAll(".pred-card").forEach((c) => c.classList.remove("active"));
}

function showError(msg) {
  openDetailSection("Error");
  document.getElementById("detail").innerHTML = `<div class="banner error">${msg}</div>`;
}

function renderDetail(entry, record) {
  openDetailSection(`${entry.kind === "human" ? "🧑" : "🤖"} ${entry.label}`);
  const detail = document.getElementById("detail");
  detail.innerHTML = "";

  if (record.error) {
    detail.appendChild(
      Object.assign(el("div", "banner error"), {
        textContent: `This model returned an error: ${record.error}`,
      })
    );
    return;
  }
  const p = record.prediction;

  const head = el("div", "headline");
  const cards = [
    ["Champion", p.champion, "gold"],
    ["Runner-up", p.runner_up, ""],
    ["Third place", p.third_place, ""],
    ["Golden Boot", p.golden_boot, ""],
    ["Dark horse", p.dark_horse, ""],
  ];
  for (const [k, v, cls] of cards) {
    const c = el("div", `hcard ${cls}`);
    c.appendChild(el("div", "hcard-k", k));
    c.appendChild(el("div", "hcard-v", v || "—"));
    head.appendChild(c);
  }
  detail.appendChild(head);

  if (p.rationale) detail.appendChild(el("p", "rationale", p.rationale));

  if (record.reasoning) {
    const d = el("details", "reasoning-box");
    d.appendChild(Object.assign(el("summary"), { textContent: "Show full model reasoning" }));
    d.appendChild(el("pre", "reasoning-text", record.reasoning));
    detail.appendChild(d);
  }

  if (record.warnings && record.warnings.length) {
    const w = el("details", "banner warn");
    w.appendChild(Object.assign(el("summary"), { textContent: `${record.warnings.length} consistency warning(s)` }));
    const ul = el("ul");
    record.warnings.forEach((x) => ul.appendChild(el("li", null, x)));
    w.appendChild(ul);
    detail.appendChild(w);
  }

  detail.appendChild(el("h3", "section-title", "Group stage"));
  detail.appendChild(renderGroups(p));

  detail.appendChild(el("h3", "section-title", "Knockout bracket"));
  detail.appendChild(renderBracket(p.knockout));

  if (entry.kind === "llm") {
    const tools = record.grounded ? " · 🔎 web-grounded (search · fetch · code)" : " · cold knowledge";
    const served = record.resolvedModel || record.model;
    detail.appendChild(
      el("p", "stamp", `Generated ${new Date(record.generatedAt).toLocaleString()} · ${record.provider}:${served}${tools}`)
    );
  }
}

function renderGroups(p) {
  const wrap = el("div", "groups-grid");
  const thirds = new Set(p.best_third_qualifiers || []);
  const ordered = [...p.groups].sort((a, b) => a.group.localeCompare(b.group));
  for (const g of ordered) {
    const card = el("div", "group-card");
    card.appendChild(el("div", "group-title", `Group ${g.group}`));
    g.standings.forEach((team, i) => {
      let cls = "";
      if (i < 2) cls = "adv";
      else if (i === 2 && thirds.has(team)) cls = "adv-third";
      const row = el("div", `team-row ${cls}`);
      row.appendChild(el("span", "pos", String(i + 1)));
      row.appendChild(el("span", "team", team));
      card.appendChild(row);
    });
    wrap.appendChild(card);
  }
  return wrap;
}

function renderBracket(knockout) {
  const wrap = el("div", "bracket");
  for (const round of ROUND_ORDER) {
    const col = el("div", "bracket-col");
    col.appendChild(el("div", "col-title", round));
    knockout
      .filter((m) => m.round === round)
      .sort((a, b) => a.match - b.match)
      .forEach((m) => col.appendChild(matchCard(m)));
    wrap.appendChild(col);
  }
  const tp = knockout.find((m) => m.round === "Third Place");
  if (tp) {
    const col = wrap.querySelector(".bracket-col:last-child");
    col.appendChild(el("div", "col-title small", "Third place"));
    col.appendChild(matchCard(tp));
  }
  return wrap;
}

function matchCard(m) {
  const card = el("div", "match");
  for (const side of ["home", "away"]) {
    const row = el("div", "match-team");
    if (m[side] && m.winner === m[side]) row.classList.add("winner");
    row.appendChild(el("span", "mt-name", m[side] || "—"));
    card.appendChild(row);
  }
  return card;
}

init().catch((e) => showError(e.message));
