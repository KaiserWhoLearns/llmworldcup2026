// Shared helpers: load tournament data and resolve the deterministic bracket.

export async function loadTournament() {
  const res = await fetch("data/tournament.json");
  if (!res.ok) throw new Error("Could not load data/tournament.json");
  return res.json();
}

export async function loadIndex() {
  try {
    const res = await fetch("data/index.json", { cache: "no-store" });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export async function loadPrediction(id) {
  const res = await fetch(`data/predictions/${id}.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not load prediction ${id}`);
  return res.json();
}

// Flatten the knockout template into one ordered list of {match, round, home, away}.
export function flattenTemplate(t) {
  const ko = t.knockout;
  const out = [];
  const push = (arr, round) => arr.forEach((m) => out.push({ ...m, round }));
  push(ko.roundOf32, "Round of 32");
  push(ko.roundOf16, "Round of 16");
  push(ko.quarterfinals, "Quarterfinal");
  push(ko.semifinals, "Semifinal");
  out.push({ ...ko.thirdPlace, round: "Third Place" });
  out.push({ ...ko.final, round: "Final" });
  return out;
}

// Candidate groups for a 3RD_ slot, e.g. "3RD_A/B/C/D/F" -> ["A","B","C","D","F"].
export function thirdCandidateGroups(label) {
  return label.startsWith("3RD_") ? label.slice(4).split("/") : [];
}

export function isThirdSlot(label) {
  return typeof label === "string" && label.startsWith("3RD_");
}

/**
 * Resolve every knockout match's concrete teams from a state object, processing
 * matches in number order so feeder results are known before dependents.
 *
 * state = {
 *   groupOrder: { A: [first, second, third, fourth], ... },
 *   thirds:     { 74: "Team", 77: "Team", ... },  // keyed by match number (the away slot)
 *   winners:    { 73: "Team", ... },              // user/model picked winner per match
 * }
 * Returns array of { match, round, home, away, winner, homeLabel, awayLabel }.
 */
export function resolveBracket(template, state) {
  const tmpl = flattenTemplate(template);
  const teams = {}; // matchNum -> {home, away}
  const result = [];

  const groupOrder = state.groupOrder || {};
  const thirds = state.thirds || {};
  const winners = state.winners || {};

  const resolve = (label, matchNum) => {
    if (label == null) return null;
    if (label.startsWith("W_")) return groupOrder[label.slice(2)]?.[0] ?? null;
    if (label.startsWith("RU_")) return groupOrder[label.slice(3)]?.[1] ?? null;
    if (isThirdSlot(label)) return thirds[matchNum] ?? null;
    if (/^W\d+$/.test(label)) return winners[+label.slice(1)] ?? null;
    if (/^L\d+$/.test(label)) {
      const n = +label.slice(1);
      const t = teams[n];
      const w = winners[n];
      if (!t || !w) return null;
      return w === t.home ? t.away : w === t.away ? t.home : null;
    }
    return label; // already a concrete team name
  };

  for (const m of tmpl) {
    const home = resolve(m.home, m.match);
    const away = resolve(m.away, m.match);
    teams[m.match] = { home, away };
    const w = winners[m.match];
    const winner = w === home || w === away ? w : null;
    result.push({
      match: m.match,
      round: m.round,
      home,
      away,
      winner,
      homeLabel: m.home,
      awayLabel: m.away,
    });
  }
  return result;
}

/**
 * Expand a compact human submission (just groupOrder / thirds / winners plus the
 * meta fields) into the full prediction record shape the board renders for models.
 * Keeps a single source of truth with predict.js's buildRecord.
 */
export function expandRecord(compact, tournament) {
  const state = {
    groupOrder: compact.groupOrder || {},
    thirds: compact.thirds || {},
    winners: compact.winners || {},
  };
  const resolved = resolveBracket(tournament, state);
  const byNum = Object.fromEntries(resolved.map((m) => [m.match, m]));
  const champ = byNum[104]?.winner || "";
  const runner = byNum[104] ? (champ === byNum[104].home ? byNum[104].away : byNum[104].home) : "";
  const third = byNum[103]?.winner || "";
  return {
    prediction: {
      champion: champ,
      runner_up: runner,
      third_place: third,
      golden_boot: compact.golden_boot || "",
      dark_horse: compact.dark_horse || "",
      rationale: compact.rationale || "",
      groups: Object.entries(state.groupOrder).map(([g, standings]) => ({ group: g, standings })),
      best_third_qualifiers: [...new Set(Object.values(state.thirds))],
      knockout: resolved.map((m) => ({ match: m.match, round: m.round, home: m.home, away: m.away, winner: m.winner })),
    },
    warnings: [],
    error: null,
  };
}

export const ROUND_ORDER = [
  "Round of 32",
  "Round of 16",
  "Quarterfinal",
  "Semifinal",
  "Final",
];

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
