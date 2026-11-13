/**
 * Engine-score helpers shared by the board, panels and review (port of evaluation.py).
 *
 * Every score here is centipawns from White's point of view, with mates encoded on one
 * scale: mating in n = +(MATE_SCORE_CP - n), getting mated in n = -(MATE_SCORE_CP - n).
 */

export type Color = "w" | "b";

export const MATE_SCORE_CP = 100_000;
const MATE_ZONE = MATE_SCORE_CP - 1_000;

/** Win-probability drop thresholds (Lichess's judgement scale on winning chances in [-1, 1]). */
export const INACCURACY = 0.1;
export const MISTAKE = 0.2;
export const BLUNDER = 0.3;
const WIN_CHANCE_K = 0.00368208;

/** Engine evaluation of the position reached after a move. */
export interface MoveEval {
  cpWhite: number; // White's point of view, mate-encoded
  pv: string[]; // UCI moves: the engine's continuation after the move
  depth: number;
}

export const other = (c: Color): Color => (c === "w" ? "b" : "w");

export function cpPov(cpWhite: number, color: Color): number {
  return color === "w" ? cpWhite : -cpWhite;
}

/** A UCI score (relative to the side to move in the searched position) as White cp. */
export function uciScoreToWhite(kind: "cp" | "mate", value: number, sideToMove: Color): number {
  let pov: number;
  if (kind === "cp") pov = value;
  else if (value > 0) pov = MATE_SCORE_CP - value;
  else pov = -(MATE_SCORE_CP - Math.abs(value)); // mate 0 / negative: side to move is mated
  return cpPov(pov, sideToMove);
}

export const isMateCp = (cp: number): boolean => Math.abs(cp) >= MATE_ZONE;

export function mateDistance(cp: number): number | null {
  return isMateCp(cp) ? MATE_SCORE_CP - Math.abs(cp) : null;
}

/** "+0.4", "-12.0", "M3" (mating), "-M2" (getting mated), "#" / "-#". */
export function formatCp(cp: number): string {
  const n = mateDistance(cp);
  if (n === null) {
    const pawns = cp / 100;
    return (pawns >= 0 ? "+" : "-") + Math.abs(pawns).toFixed(1);
  }
  if (n === 0) return cp > 0 ? "#" : "-#";
  return cp > 0 ? `M${n}` : `-M${n}`;
}

/** Unsigned text for the vertical eval bar: "0.4", "12", "M3" or "#". */
export function formatBarText(cpWhite: number): string {
  const n = mateDistance(cpWhite);
  if (n !== null) return n === 0 ? "#" : `M${n}`;
  const pawns = Math.abs(cpWhite) / 100;
  return pawns >= 9.95 ? String(Math.round(pawns)) : pawns.toFixed(1);
}

/** Rank moves for the side to move: 1 = best, 0 = worst, spaced by distinct score. */
export function rankMoves(evals: Record<string, MoveEval>, turn: Color): Record<string, number> {
  const values: Record<string, number> = {};
  for (const [uci, e] of Object.entries(evals)) values[uci] = cpPov(e.cpWhite, turn);
  const distinct = [...new Set(Object.values(values))].sort((a, b) => a - b);
  const out: Record<string, number> = {};
  if (distinct.length <= 1) {
    for (const uci of Object.keys(values)) out[uci] = 0.5;
    return out;
  }
  const pos = new Map(distinct.map((v, i) => [v, i / (distinct.length - 1)]));
  for (const [uci, v] of Object.entries(values)) out[uci] = pos.get(v)!;
  return out;
}

export function bestUci(evals: Record<string, MoveEval>, turn: Color): string | null {
  let best: string | null = null;
  let bestCp = -Infinity;
  for (const [uci, e] of Object.entries(evals)) {
    const cp = cpPov(e.cpWhite, turn);
    if (cp > bestCp) {
      bestCp = cp;
      best = uci;
    }
  }
  return best;
}

/** Winning chances in [-1, 1] for the side the cp value is relative to. */
export function winChance(cp: number): number {
  const c = Math.max(-MATE_SCORE_CP, Math.min(MATE_SCORE_CP, cp));
  return 2 / (1 + Math.exp(-WIN_CHANCE_K * c)) - 1;
}

export function cpDrop(beforeWhite: number, afterWhite: number, mover: Color): number {
  return (mover === "w" ? 1 : -1) * (beforeWhite - afterWhite);
}

/** Winning chances the mover gave up, in [0, 2]. */
export function winDrop(beforeWhite: number, afterWhite: number, mover: Color): number {
  const sign = mover === "w" ? 1 : -1;
  return Math.max(0, winChance(sign * beforeWhite) - winChance(sign * afterWhite));
}

export function classify(drop: number): "??" | "?" | "?!" | "" {
  if (drop >= BLUNDER) return "??";
  if (drop >= MISTAKE) return "?";
  if (drop >= INACCURACY) return "?!";
  return "";
}

/** Colour for a move rank (0 worst … 1 best): the desktop app's red→green ramp, gold for best. */
export function rankColor(t: number): string {
  if (t >= 1) return "#FFD700";
  const c = Math.max(0, Math.min(1, t));
  const r = Math.trunc(210 * (1 - c) + 40 * c);
  const g = Math.trunc(40 * (1 - c) + 200 * c);
  const hex = (v: number) => v.toString(16).toUpperCase().padStart(2, "0");
  return `#${hex(r)}${hex(g)}28`;
}
