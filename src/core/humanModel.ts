/**
 * How a player of a given rating sees positions, from the depth-calibration research
 * (research/depth-calibration): the chance of finding a best-or-excellent move falls with the
 * position's *find depth*, the shallowest Stockfish depth from which the engine's choice is always
 * excellent.
 *
 * Two uses:
 * - the **human eval**: the engine's scores at each depth, blended with the chance that the
 *   player's horizon is that depth (an eval "as seen at your level");
 * - **expected play**: for each move of a game, the chance a player of that rating finds a good
 *   move, summed over the game and compared with what they actually played.
 */
import type { TracePoint } from "../engine/scheduler";
import { type Color, type MoveEval, cpPov, winChance } from "./evaluation";
import { FIND_DEPTH_GROUPS, FOUND_RATE_BANDS } from "./humanModelData";

/** chess.com ratings run about this much lower than Lichess ratings at club level (an estimate). */
export const CHESSCOM_TO_LICHESS = 250;
/** A move is "excellent" if it loses at most this much winning chance ([-1, 1] scale; 0.02 expected points). */
export const EXCELLENT_LOSS = 0.04;
/** Positions where the best move keeps winning chances beyond this either way are decided, and not counted. */
export const DECIDED = 0.9;
/** Opening moves are left out of expected play: they are memorised, not found. */
export const OPENING_PLIES = 8;

const WIN_CHANCE_K = 0.00368208;

export type Site = "chess.com" | "lichess";

export function toLichess(rating: number, site: Site): number {
  return site === "chess.com" ? rating + CHESSCOM_TO_LICHESS : rating;
}

/** Found rate per depth group for a Lichess rating, interpolated between bands and made non-increasing. */
export function foundRates(lichessRating: number): number[] {
  const bands = FOUND_RATE_BANDS;
  let rates: number[];
  if (lichessRating <= bands[0].center) rates = [...bands[0].rates];
  else if (lichessRating >= bands[bands.length - 1].center) rates = [...bands[bands.length - 1].rates];
  else {
    const i = bands.findIndex((b) => b.center > lichessRating);
    const lo = bands[i - 1];
    const hi = bands[i];
    const t = (lichessRating - lo.center) / (hi.center - lo.center);
    rates = lo.rates.map((r, j) => r + t * (hi.rates[j] - r));
  }
  for (let j = 1; j < rates.length; j++) rates[j] = Math.min(rates[j], rates[j - 1]);
  return rates;
}

function groupOf(findDepth: number): number {
  const i = FIND_DEPTH_GROUPS.findIndex(([lo, hi]) => findDepth >= lo && findDepth <= hi);
  return i < 0 ? FIND_DEPTH_GROUPS.length - 1 : i;
}

/** Chance a player of this Lichess rating plays a good move where the find depth is ``findDepth``. */
export function findChance(lichessRating: number, findDepth: number): number {
  return foundRates(lichessRating)[groupOf(findDepth)];
}

/**
 * Weight of each depth 1..maxDepth (index 0 = depth 1), summing to 1: the chance the player's
 * horizon is that depth. A player who finds a move first visible at depth d with chance S(d)
 * "sees to depth d or further" with that chance, so depth d gets S(d) - S(d+1); depth 1 also
 * takes the share that sees even less, and the last depth everything beyond it.
 */
export function depthWeights(lichessRating: number, maxDepth: number): number[] {
  const rates = foundRates(lichessRating);
  const s = (d: number) => rates[groupOf(d)];
  const w: number[] = [];
  for (let d = 1; d <= maxDepth; d++) {
    if (d === maxDepth) w.push(s(d));
    else if (d === 1) w.push(1 - s(2));
    else w.push(s(d) - s(d + 1));
  }
  return w;
}

function cpFromWinChance(w: number): number {
  const c = Math.max(-0.9999, Math.min(0.9999, w));
  return Math.log((1 + c) / (1 - c)) / WIN_CHANCE_K;
}

/**
 * The eval as a player of this rating would see it: the per-depth scores blended with
 * ``depthWeights``, averaged as winning chances (so a mate score can't swamp the rest), as White cp.
 * Depths missing from the trace (Stockfish skips none in practice) lend their weight to the next.
 */
export function humanEval(trace: readonly TracePoint[], lichessRating: number): number | null {
  if (!trace.length) return null;
  const maxDepth = trace[trace.length - 1].depth;
  const weights = depthWeights(lichessRating, maxDepth);
  const byDepth = new Map(trace.map((t) => [t.depth, t.cpWhite]));
  let sum = 0;
  let carry = 0;
  for (let d = 1; d <= maxDepth; d++) {
    const cp = byDepth.get(d);
    if (cp === undefined) {
      carry += weights[d - 1];
      continue;
    }
    sum += (weights[d - 1] + carry) * winChance(cp);
    carry = 0;
  }
  return Math.round(cpFromWinChance(sum));
}

/** Moves within ``EXCELLENT_LOSS`` winning chances of the best, by the given (deep) evals. */
export function goodMoves(evals: Record<string, MoveEval>, turn: Color): Set<string> {
  const entries = Object.entries(evals);
  if (!entries.length) return new Set();
  const wc = (ev: MoveEval) => winChance(cpPov(ev.cpWhite, turn));
  const top = Math.max(...entries.map(([, ev]) => wc(ev)));
  return new Set(entries.filter(([, ev]) => top - wc(ev) <= EXCELLENT_LOSS).map(([u]) => u));
}

/**
 * Shallowest depth from which the trace's choice is a good move at every depth after it;
 * the trace's last depth + 1 when even that choice isn't one (it can differ from ``evals``' best).
 */
export function findDepth(trace: readonly TracePoint[], good: Set<string>): number | null {
  if (!trace.length || !good.size) return null;
  let find = trace[trace.length - 1].depth + 1;
  for (let i = trace.length - 1; i >= 0; i--) {
    if (!good.has(trace[i].best)) break;
    find = trace[i].depth;
  }
  // A depth below the reference is all the research measured; "never" maps to its last group.
  return find > trace[trace.length - 1].depth ? Number.POSITIVE_INFINITY : find;
}

/** Whether a position counts toward expected play (the research's filters). */
export function counts(ply: number, legalCount: number, evals: Record<string, MoveEval>, turn: Color): boolean {
  if (ply < OPENING_PLIES || legalCount < 2) return false;
  const good = goodMoves(evals, turn);
  const [best] = good;
  if (!best) return false;
  return Math.abs(winChance(cpPov(evals[best].cpWhite, turn))) <= DECIDED;
}

export interface SidePlay {
  /** Positions counted. */
  moves: number;
  /** Good moves actually played. */
  found: number;
  /** Good moves a player of this rating would be expected to play. */
  expected: number;
}

export interface MoveChance {
  /** Chance a player of the mover's rating plays a good move here. */
  chance: number;
  findDepth: number;
  found: boolean;
}

export interface ExpectedPlay {
  w: SidePlay;
  b: SidePlay;
  /** By ply of the position before the move (0 = before the first move). */
  moves: Map<number, MoveChance>;
}

/** Each side's Lichess-scale rating from the PGN headers, else ``fallback`` (chess.com scale). */
export function gameRatings(headers: Record<string, string>, fallback: number): Record<Color, number> {
  const site: Site = /lichess/i.test(headers.Site ?? "") ? "lichess" : "chess.com";
  const one = (raw: string | undefined) => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? toLichess(n, site) : toLichess(fallback, "chess.com");
  };
  return { w: one(headers.WhiteElo), b: one(headers.BlackElo) };
}

export interface PlyData {
  fen: string;
  played: string; // UCI
  legalCount: number;
  evals: Record<string, MoveEval> | undefined; // every legal move scored (review analysis)
  trace: readonly TracePoint[] | undefined;
}

/** Good moves played vs expected for each side, over the plies that have both evals and a trace. */
export function expectedPlay(plies: readonly PlyData[], ratings: Record<Color, number>): ExpectedPlay {
  const out: ExpectedPlay = { w: { moves: 0, found: 0, expected: 0 }, b: { moves: 0, found: 0, expected: 0 }, moves: new Map() };
  plies.forEach((p, ply) => {
    if (!p.evals || !p.trace) return;
    const turn: Color = p.fen.split(" ")[1] === "b" ? "b" : "w";
    if (!counts(ply, p.legalCount, p.evals, turn)) return;
    const good = goodMoves(p.evals, turn);
    const fd = findDepth(p.trace, good);
    if (fd === null) return;
    const chance = findChance(ratings[turn], fd);
    const found = good.has(p.played);
    const side = out[turn];
    side.moves += 1;
    side.found += found ? 1 : 0;
    side.expected += chance;
    out.moves.set(ply, { chance, findDepth: fd, found });
  });
  return out;
}
