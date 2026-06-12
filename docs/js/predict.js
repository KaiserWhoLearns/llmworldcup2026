import {
  loadTournament,
  resolveBracket,
  expandRecord,
  flattenTemplate,
  thirdCandidateGroups,
  isThirdSlot,
  ROUND_ORDER,
  el,
} from "./common.js";

const HUMAN_KEY = "wc2026.humanPredictions";
const DRAFT_KEY = "wc2026.draft";

// Set this to your GitHub repo to enable "Submit to leaderboard".
// Format: "owner/repo" (e.g. "kaisersun/worldcup").
const GITHUB_REPO = "KaiserWhoLearns/llmworldcup2026";

let tournament = null;
const state = { groupOrder: {}, thirds: {}, winners: {} };

async function init() {
  tournament = await loadTournament();
  // seed groupOrder with the listed order so the bracket is populated from the start
  for (const [g, teams] of Object.entries(tournament.groups)) {
    state.groupOrder[g] = [...teams];
  }
  restoreDraft();
  renderGroups();
  renderBracket();
  renderSaved();
  wireButtons();
}

/* ----------------------------- group stage ----------------------------- */
function renderGroups() {
  const wrap = document.getElementById("groups");
  wrap.innerHTML = "";
  for (const [g, teams] of Object.entries(tournament.groups)) {
    const card = el("div", "group-card");
    card.appendChild(el("div", "group-title", `Group ${g}`));
    for (let pos = 0; pos < 4; pos++) {
      const row = el("div", "rank-row");
      row.appendChild(el("span", "pos", `${pos + 1}${["st", "nd", "rd", "th"][pos]}`));
      const sel = el("select", "rank-select");
      teams.forEach((t) => sel.appendChild(new Option(t, t)));
      sel.value = state.groupOrder[g][pos];
      sel.dataset.group = g;
      sel.dataset.pos = pos;
      sel.onchange = onRankChange;
      row.appendChild(sel);
      card.appendChild(row);
    }
    wrap.appendChild(card);
  }
}

function onRankChange(e) {
  const g = e.target.dataset.group;
  const pos = +e.target.dataset.pos;
  const team = e.target.value;
  const arr = state.groupOrder[g];
  const old = arr[pos];
  const swapAt = arr.indexOf(team); // keep it a permutation by swapping
  if (swapAt !== -1) arr[swapAt] = old;
  arr[pos] = team;
  // Any third assignment that referenced a team no longer 3rd in its group is dropped below.
  pruneThirds();
  saveDraft();
  renderGroups();
  renderBracket();
}

/* ------------------------------ bracket -------------------------------- */
function eligibleThirds(candidateGroups) {
  // teams currently sitting 3rd in a candidate group
  return candidateGroups
    .map((g) => ({ group: g, team: state.groupOrder[g]?.[2] }))
    .filter((x) => x.team);
}

function pruneThirds() {
  const tmpl = flattenTemplate(tournament);
  for (const m of tmpl) {
    if (isThirdSlot(m.away)) {
      const elig = new Set(eligibleThirds(thirdCandidateGroups(m.away)).map((x) => x.team));
      if (state.thirds[m.match] && !elig.has(state.thirds[m.match])) {
        delete state.thirds[m.match];
      }
    }
  }
}

function renderBracket() {
  // prune winners that are no longer valid given current teams
  const resolved = resolveBracket(tournament, state);
  for (const m of resolved) {
    if (state.winners[m.match] && state.winners[m.match] !== m.home && state.winners[m.match] !== m.away) {
      delete state.winners[m.match];
    }
  }
  const fresh = resolveBracket(tournament, state);

  const wrap = document.getElementById("bracket");
  wrap.innerHTML = "";
  for (const round of ROUND_ORDER) {
    const col = el("div", "bracket-col");
    col.appendChild(el("div", "col-title", round));
    fresh
      .filter((m) => m.round === round)
      .sort((a, b) => a.match - b.match)
      .forEach((m) => col.appendChild(interactiveMatch(m)));
    wrap.appendChild(col);
  }
  const tp = fresh.find((m) => m.round === "Third Place");
  if (tp) {
    const col = wrap.querySelector(".bracket-col:last-child");
    col.appendChild(el("div", "col-title small", "Third place"));
    col.appendChild(interactiveMatch(tp));
  }
  renderSummary(fresh);
}

function pickWinner(matchNum, team) {
  if (!team) return;
  state.winners[matchNum] = team;
  saveDraft();
  renderBracket();
}

function interactiveMatch(m) {
  const card = el("div", "match");
  const usedThirds = new Set(Object.entries(state.thirds).filter(([k]) => +k !== m.match).map(([, v]) => v));

  for (const side of ["home", "away"]) {
    const label = m[`${side}Label`];

    if (side === "away" && isThirdSlot(label)) {
      // A third-place slot: dropdown to choose the team, then a clickable chip to advance it.
      const box = el("div", "match-team third-slot");
      const sel = el("select", "third-select");
      sel.appendChild(new Option("— pick a 3rd-placed team —", ""));
      for (const { team, group } of eligibleThirds(thirdCandidateGroups(label))) {
        if (usedThirds.has(team)) continue;
        sel.appendChild(new Option(`${team} (3rd, Grp ${group})`, team));
      }
      sel.value = state.thirds[m.match] || "";
      sel.onchange = () => {
        if (sel.value) state.thirds[m.match] = sel.value;
        else delete state.thirds[m.match];
        saveDraft();
        renderBracket();
      };
      box.appendChild(sel);

      if (m.away) {
        const chip = el("button", "advance-chip", `▶ advance ${m.away}`);
        if (m.winner === m.away) chip.classList.add("winner");
        chip.onclick = () => pickWinner(m.match, m.away);
        box.appendChild(chip);
      }
      card.appendChild(box);
    } else {
      const row = el("div", "match-team");
      if (m[side] && m.winner === m[side]) row.classList.add("winner");
      row.appendChild(el("span", "mt-name", m[side] || labelHint(label)));
      if (m[side]) {
        row.onclick = () => pickWinner(m.match, m[side]);
        row.classList.add("clickable");
      }
      card.appendChild(row);
    }
  }
  card.prepend(el("div", "match-num", `#${m.match}`));
  return card;
}

function labelHint(label) {
  if (!label) return "—";
  if (label.startsWith("W_")) return `Winner ${label.slice(2)}`;
  if (label.startsWith("RU_")) return `Runner-up ${label.slice(3)}`;
  if (/^W\d+$/.test(label)) return `Winner of #${label.slice(1)}`;
  if (/^L\d+$/.test(label)) return `Loser of #${label.slice(1)}`;
  return "—";
}

/* ------------------------------ summary -------------------------------- */
function renderSummary(resolved) {
  const byNum = Object.fromEntries(resolved.map((m) => [m.match, m]));
  const champ = byNum[104]?.winner;
  const runner = byNum[104] ? (champ === byNum[104].home ? byNum[104].away : byNum[104].home) : null;
  const third = byNum[103]?.winner;

  const picked = resolved.filter((m) => m.winner).length;
  const thirdsAssigned = Object.keys(state.thirds).length;

  document.getElementById("summary").innerHTML = `
    <span>🏆 <strong>${champ || "?"}</strong></span>
    <span>🥈 ${runner || "?"}</span>
    <span>🥉 ${third || "?"}</span>
    <span class="progress">${picked}/32 matches · ${thirdsAssigned}/8 thirds</span>`;
}

/* --------------------------- persistence ------------------------------- */
// Compact submission: only the minimal state plus meta. The full bracket is
// reconstructed deterministically from this via expandRecord, which keeps the
// issue URL short enough for GitHub (the full record is ~8x larger).
function buildCompact(name = "") {
  const resolved = resolveBracket(tournament, state);
  const byNum = Object.fromEntries(resolved.map((m) => [m.match, m]));
  const champ = byNum[104]?.winner || "";
  const runner = byNum[104] ? (champ === byNum[104].home ? byNum[104].away : byNum[104].home) : "";
  const third = byNum[103]?.winner || "";

  return {
    format: "compact",
    name,
    golden_boot: document.getElementById("goldenBoot").value.trim(),
    dark_horse: document.getElementById("darkHorse").value.trim(),
    rationale: document.getElementById("rationale").value.trim(),
    champion: champ,
    runner_up: runner,
    third_place: third,
    groupOrder: state.groupOrder,
    thirds: state.thirds,
    winners: state.winners,
  };
}

function buildRecord() {
  return expandRecord(buildCompact(), tournament);
}

function getSaved() {
  try {
    return JSON.parse(localStorage.getItem(HUMAN_KEY) || "[]");
  } catch {
    return [];
  }
}

function setSaved(list) {
  localStorage.setItem(HUMAN_KEY, JSON.stringify(list));
}

function saveDraft() {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(state));
}

function restoreDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    if (d && d.groupOrder) Object.assign(state, d);
  } catch {
    /* ignore */
  }
}

function renderSaved() {
  const wrap = document.getElementById("saved");
  const list = getSaved();
  wrap.innerHTML = "";
  if (!list.length) {
    wrap.appendChild(el("p", "empty", "No saved entries yet."));
    return;
  }
  for (const h of list) {
    const row = el("div", "saved-row");
    row.appendChild(el("span", "saved-name", `${h.name} — 🏆 ${h.record.prediction.champion || "?"}`));
    const dl = el("button", "btn small", "Export JSON");
    dl.onclick = () => downloadJSON(h);
    const del = el("button", "btn small danger", "Delete");
    del.onclick = () => {
      setSaved(getSaved().filter((x) => x.id !== h.id));
      renderSaved();
    };
    row.appendChild(dl);
    row.appendChild(del);
    wrap.appendChild(row);
  }
}

/* ----------------------- submit to leaderboard ------------------------ */
function submitToLeaderboard() {
  if (GITHUB_REPO === "OWNER/REPO") {
    alert("Leaderboard submission isn't configured yet — set GITHUB_REPO in predict.js to your repo.");
    return;
  }
  const name = document.getElementById("entryName").value.trim();
  if (!name) {
    alert("Give your prediction a name first.");
    return;
  }
  const resolved = resolveBracket(tournament, state);
  const incomplete = resolved.filter((m) => !m.winner).length;
  if (incomplete && !confirm(`${incomplete} match(es) have no winner yet. Submit anyway?`)) return;

  const compact = buildCompact(name);
  const body = [
    `**Name / handle:** ${name}`,
    "",
    `- 🏆 **Champion:** ${compact.champion || "—"}`,
    `- 🥈 **Runner-up:** ${compact.runner_up || "—"}`,
    `- 🥉 **Third place:** ${compact.third_place || "—"}`,
    `- 👟 **Golden Boot:** ${compact.golden_boot || "—"}`,
    `- 🐴 **Dark horse:** ${compact.dark_horse || "—"}`,
    compact.rationale ? `\n> ${compact.rationale}` : "",
    "",
    "<!-- prediction data — do not edit below this line -->",
    "```json",
    JSON.stringify(compact),
    "```",
  ].join("\n");

  const params = new URLSearchParams({ title: `Prediction: ${name}`, body, labels: "prediction" });
  window.open(`https://github.com/${GITHUB_REPO}/issues/new?${params.toString()}`, "_blank", "noopener");
}

function downloadJSON(entry) {
  const blob = new Blob([JSON.stringify(entry, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), {
    href: url,
    download: `prediction-${(entry.name || "entry").replace(/\s+/g, "_")}.json`,
  });
  a.click();
  URL.revokeObjectURL(url);
}

function wireButtons() {
  document.getElementById("saveBtn").onclick = () => {
    const name = document.getElementById("entryName").value.trim();
    if (!name) {
      alert("Give your prediction a name first.");
      return;
    }
    const resolved = resolveBracket(tournament, state);
    const incomplete = resolved.filter((m) => !m.winner).length;
    if (incomplete && !confirm(`${incomplete} match(es) have no winner yet. Save anyway?`)) return;

    const record = buildRecord();
    const list = getSaved();
    const id = Date.now().toString(36);
    list.push({ id, name, savedAt: new Date().toISOString(), record });
    setSaved(list);
    renderSaved();
    alert(`Saved "${name}" in this browser. To get it on the public board, click "Submit to leaderboard".`);
  };

  document.getElementById("submitBtn").onclick = submitToLeaderboard;

  document.getElementById("resetBtn").onclick = () => {
    if (!confirm("Clear your current picks?")) return;
    state.thirds = {};
    state.winners = {};
    for (const [g, teams] of Object.entries(tournament.groups)) state.groupOrder[g] = [...teams];
    localStorage.removeItem(DRAFT_KEY);
    renderGroups();
    renderBracket();
  };
}

init().catch((e) => {
  document.getElementById("bracket").innerHTML = `<div class="banner error">${e.message}</div>`;
});
