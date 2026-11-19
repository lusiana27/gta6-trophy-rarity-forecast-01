// GTA VI trophy rarity forecaster for make.fun's gta6-trophy-rarity-forecast-01.
//
// The forecast: for every trophy, five quantiles of its earn rate on Exophase at
// the case's target, in percent. The program reads one case file per run from
// /input (or $MAKEFUN_INPUT_DIR) and writes /output/<id>.out (or
// $MAKEFUN_OUTPUT_DIR). Node 22, standard library only, no network, no clock:
// the same case file always produces the same bytes.
//
// The method, in short. Exophase does not refresh continuously: it publishes a
// game's counts in batches, hours apart, and each batch adds newly tracked
// players who have played far less than the players already tracked, so every
// trophy's rate falls at a refresh. Two forces then move a rate between the
// case's last read and its target:
//
//   dilution   — the tracked player base grows, and the newcomers bring far
//                fewer trophies each, so rates fall. In the hazard picture a
//                trophy's rate is r = 1 - (1 - q)^h for a playtime h, and a
//                newcomer cohort plays a fraction rho of the incumbents'
//                hours, so its rate on a trophy is 1 - (1 - r)^rho. Mixing
//                the cohorts gives the rate at any larger player count.
//   progression — the incumbents keep playing, so their own rates creep up:
//                their playtime grows by a factor (1 + g) over the horizon.
//
// The program estimates both forces from the case's own history: it collapses
// the reads into the distinct states each refresh produced, fits how fast the
// player count grows, and fits rho and the progression rate to the logit
// shifts the refreshes actually caused (a pooled fit across all trophies and
// refreshes, shrunk toward the launch-night prior when the history is too
// thin to identify them). When the history is flat — no refresh yet seen —
// it falls back to the launch prior: newcomers play about 7% of the
// incumbents' hours, and the player count roughly triples over a 90-minute
// horizon at launch surge.
//
// The spreads are deliberately asymmetric. The player count can only grow,
// never shrink, so the downside (rates fall further than the median) is far
// wider than the upside (rates fall less, or creep up on progression). The
// low quantiles therefore carry the full player-growth uncertainty and the
// high quantiles half of it; both are floored so the forecast never claims
// more precision than a random walk's, and capped so one wild fit cannot
// blow the band out. A trophy already at 100% stays there: everyone earns
// the first trophy, newcomers included.
//
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

/** Prior for the newcomers' playtime fraction (launch refresh: ~0.07). */
const RHO_PRIOR = 0.07;
/** Prior for the incumbents' progression rate per log hour. */
const GAMMA_PRIOR = 0.15;
/** Prior median player-count multiplier over a 90-minute horizon at launch. */
const GROWTH_PRIOR_BASE = 2.5;
/** Log-uncertainty of the player count when the history shows no growth. */
const LOGP_SIGMA_FLAT = 0.7;
/** Log-uncertainty of the player count when the history fits a growth law. */
const LOGP_SIGMA_FIT = 0.45;

interface Trophy {
  id: number;
}

interface Read {
  slot: string;
  players_tracked: number;
  rates: Array<number | null>;
}

interface CaseFile {
  id: string;
  levels: number[];
  horizon_minutes: number;
  target: string;
  trophies: Trophy[];
  history: Read[];
}

/** One distinct refresh state: consecutive identical reads collapsed. */
interface State {
  hours: number;
  players: number;
  rates: Array<number | null>;
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const toLogit = (pct: number): number => {
  const c = clampPct(pct);
  return Math.log(c / (100 - c));
};
const fromLogit = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
/** Hours since the Unix epoch, from an ISO timestamp. */
const hoursOf = (iso: string): number => Date.parse(iso) / 3_600_000;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
}

function leastSquares(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let den = 0;
  let num = 0;
  for (let i = 0; i < n; i++) {
    den += (xs[i] as number - mx) ** 2;
    num += (xs[i] as number - mx) * (ys[i] as number - my);
  }
  const slope = den > 1e-12 ? num / den : 0;
  return { slope, intercept: my - slope * mx };
}

/** Collapse consecutive identical reads into the states each refresh produced. */
function distinctStates(c: CaseFile): State[] {
  const t0 = hoursOf((c.history[0] as Read).slot);
  const states: State[] = [];
  const keys: string[] = [];
  for (const h of c.history) {
    const key = `${h.players_tracked}|${h.rates.join(',')}`;
    if (keys.length > 0 && keys[keys.length - 1] === key) continue;
    keys.push(key);
    states.push({ hours: hoursOf(h.slot) - t0, players: h.players_tracked, rates: h.rates });
  }
  return states;
}

/** Forecast the tracked player count at the target, with its log-uncertainty. */
function forecastPlayers(states: State[], tTarget: number, horizonHours: number): { value: number; logSigma: number } {
  const last = states[states.length - 1] as State;
  if (states.length < 2) {
    const mult = Math.min(8, 1 + GROWTH_PRIOR_BASE * Math.sqrt(horizonHours / 1.5));
    return { value: last.players * mult, logSigma: LOGP_SIGMA_FLAT };
  }
  const xsLog = states.map((s) => Math.log(1 + s.hours));
  const xsLin = states.map((s) => s.hours);
  const ys = states.map((s) => Math.log(s.players));
  const pow = leastSquares(xsLog, ys);
  const lin = leastSquares(xsLin, ys);
  const pPow = Math.exp(pow.intercept + pow.slope * Math.log(1 + tTarget));
  const pLin = Math.exp(lin.intercept + lin.slope * tTarget);
  const value = Math.sqrt(Math.max(pPow, last.players) * Math.max(pLin, last.players));
  return { value: Math.min(value, last.players * 30), logSigma: LOGP_SIGMA_FIT };
}

interface DilutionFit {
  rho: number;
  gamma: number;
  resid: number;
}

/** Fit the newcomers' playtime fraction and the progression rate to the
 *  refreshes the history shows, shrunk toward the launch prior. */
function fitDilution(states: State[]): DilutionFit {
  if (states.length < 3) return { rho: RHO_PRIOR, gamma: GAMMA_PRIOR, resid: 0.35 };
  const events: Array<{ pa: number; pb: number; shift: number; ta: number; tb: number }> = [];
  for (let j = 1; j < states.length; j++) {
    const a = states[j - 1] as State;
    const b = states[j] as State;
    const shifts: number[] = [];
    for (let i = 0; i < a.rates.length; i++) {
      const ra = a.rates[i];
      const rb = b.rates[i];
      if (ra === null || rb === null || ra >= 99 || rb >= 99 || ra <= 0.02 || rb <= 0.02) continue;
      shifts.push(toLogit(rb) - toLogit(ra));
    }
    if (shifts.length === 0) continue;
    events.push({ pa: a.players, pb: b.players, shift: median(shifts), ta: a.hours, tb: b.hours });
  }
  if (events.length < 2) return { rho: RHO_PRIOR, gamma: GAMMA_PRIOR, resid: 0.35 };
  let best = { sse: Infinity, rho: RHO_PRIOR, gamma: GAMMA_PRIOR };
  for (let ri = 0; ri <= 50; ri++) {
    for (let gi = 0; gi <= 50; gi++) {
      const rho = ri * 0.01;
      const gamma = gi * 0.01;
      let sse = 0;
      for (const e of events) {
        const pred =
          Math.log((e.pa + rho * (e.pb - e.pa)) / e.pb) + gamma * Math.log((e.tb + 1) / (e.ta + 1));
        sse += (e.shift - pred) ** 2;
      }
      sse += 0.5 * ((rho - RHO_PRIOR) / 0.1) ** 2 + 0.5 * ((gamma - GAMMA_PRIOR) / 0.15) ** 2;
      if (sse < best.sse) best = { sse, rho, gamma };
    }
  }
  let residSq = 0;
  for (const e of events) {
    const pred =
      Math.log((e.pa + best.rho * (e.pb - e.pa)) / e.pb) +
      best.gamma * Math.log((e.tb + 1) / (e.ta + 1));
    residSq += (e.shift - pred) ** 2;
  }
  return { rho: best.rho, gamma: best.gamma, resid: Math.max(0.1, Math.sqrt(residSq / events.length)) };
}

/** Five quantiles for one trophy, in percent. */
function forecastTrophy(
  rate: number | null,
  playersLast: number,
  playersTarget: number,
  logSigmaP: number,
  fit: DilutionFit,
  growth: number,
  horizonDays: number,
): number[] {
  const r = rate === null ? 0 : rate;
  if (r >= 99) {
    // Saturated: everyone earns the first trophy, newcomers included. The
    // median stays at the clamp (99.99 scores the same as 100) so the row
    // stays non-decreasing, which the format requires.
    const l = toLogit(99.99);
    const q = Z.map((z) => round4(fromLogit(l + z * 0.12)));
    for (let i = 1; i < q.length; i++) q[i] = Math.max(q[i] as number, q[i - 1] as number);
    return q;
  }
  const rProg = 1 - (1 - r / 100) ** (1 + growth);
  const pNew = 1 - (1 - r / 100) ** fit.rho;
  const at = (pt: number): number => {
    const d = pt - playersLast;
    return toLogit(((rProg * playersLast + pNew * d) / pt) * 100);
  };
  const lMed = at(playersTarget);
  const sens = Math.abs(at(playersTarget * 1.01) - at(playersTarget * 0.99)) / 0.02;
  const base = 0.25 * Math.sqrt(horizonDays);
  const sDown = Math.min(2, Math.max(0.3, Math.sqrt((sens * logSigmaP) ** 2 + fit.resid ** 2 + 0.25 ** 2 + base ** 2)));
  const sUp = Math.min(2, Math.max(0.3, Math.sqrt((0.5 * sens * logSigmaP) ** 2 + fit.resid ** 2 + 0.25 ** 2 + base ** 2)));
  const q = Z.map((z) => {
    const s = z < 0 ? sDown : z > 0 ? sUp : 0;
    return round4(fromLogit(lMed + z * s));
  });
  for (let i = 1; i < q.length; i++) q[i] = Math.max(q[i] as number, q[i - 1] as number);
  return q;
}

function forecastCase(c: CaseFile): { id: string; trophies: Array<{ id: number; q: number[] }> } {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${c.id} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (c.history.length === 0) throw new Error(`${c.id} has no history`);
  const states = distinctStates(c);
  const last = states[states.length - 1] as State;
  const tTarget = hoursOf(c.target) - hoursOf((c.history[0] as Read).slot);
  const horizonHours = c.horizon_minutes / 60;
  const horizonDays = c.horizon_minutes / 1440;
  const players = forecastPlayers(states, tTarget, horizonHours);
  const fit = fitDilution(states);
  const growth = fit.gamma * Math.log((tTarget + 1) / (last.hours + 1));
  const trophies = c.trophies.map((t, i) => {
    // The last read that actually lists this trophy.
    let rate: number | null = null;
    for (let j = states.length - 1; j >= 0; j--) {
      const v = (states[j] as State).rates[i];
      if (v !== null && v !== undefined) {
        rate = v;
        break;
      }
    }
    return {
      id: t.id,
      q: forecastTrophy(rate, last.players, players.value, players.logSigma, fit, growth, horizonDays),
    };
  });
  return { id: c.id, trophies };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  const out = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(out)}\n`);
}
