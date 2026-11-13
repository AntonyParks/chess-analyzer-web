/**
 * Thin helpers over chess.js, so the rest of the code reads like the python-chess original.
 *
 * Positions are keyed by EPD: the first four FEN fields. chess.js (like python-chess) only
 * writes an en-passant square when the capture is legal, so EPDs written by the desktop app
 * match these.
 */
import { Chess, type Move, type Square } from "chess.js";
import type { Color } from "./evaluation";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
export const ROOT_EPD = epd(START_FEN);
export const FILES = "abcdefgh";

export function epd(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

/** A FEN for an EPD (move counters reset). */
export function fenFromEpd(e: string): string {
  return e.split(" ").length >= 6 ? e : `${e} 0 1`;
}

export function board(fen: string = START_FEN): Chess {
  return new Chess(fen);
}

export function turnOf(fen: string): Color {
  return fen.split(" ")[1] === "b" ? "b" : "w";
}

export function moveToUci(m: Pick<Move, "from" | "to" | "promotion">): string {
  return m.from + m.to + (m.promotion ?? "");
}

export function parseUci(uci: string): { from: Square; to: Square; promotion?: string } {
  return {
    from: uci.slice(0, 2) as Square,
    to: uci.slice(2, 4) as Square,
    promotion: uci.length > 4 ? uci[4] : undefined,
  };
}

/** Play a UCI move; returns the chess.js move or null if illegal. Mutates ``game``. */
export function playUci(game: Chess, uci: string): Move | null {
  try {
    return game.move(parseUci(uci));
  } catch {
    return null;
  }
}

export function legalUcis(fen: string): string[] {
  return board(fen)
    .moves({ verbose: true })
    .map((m) => moveToUci(m));
}

export function isLegal(fen: string, uci: string): boolean {
  return legalUcis(fen).includes(uci);
}

export function sanOf(fen: string, uci: string): string {
  const m = playUci(board(fen), uci);
  return m ? m.san : uci;
}

/** The FEN after a UCI move (null if illegal). */
export function after(fen: string, uci: string): string | null {
  const g = board(fen);
  return playUci(g, uci) ? g.fen() : null;
}

export function afterEpd(e: string, uci: string): string | null {
  const f = after(fenFromEpd(e), uci);
  return f === null ? null : epd(f);
}

/** "1. d4 d5 2. c4" for UCI moves played from ``fen``. Stops at the first illegal move. */
export function sanLine(ucis: readonly string[], fen: string = START_FEN): string {
  const g = board(fen);
  const parts: string[] = [];
  for (const uci of ucis) {
    const white = g.turn() === "w";
    const num = g.moveNumber();
    const m = playUci(g, uci);
    if (!m) break;
    if (white) parts.push(`${num}. ${m.san}`);
    else if (parts.length === 0) parts.push(`${num}... ${m.san}`);
    else parts.push(m.san);
  }
  return parts.join(" ");
}

/** SAN for each UCI move in sequence from ``fen`` (stops at the first illegal move). */
export function sans(ucis: readonly string[], fen: string = START_FEN): string[] {
  const g = board(fen);
  const out: string[] = [];
  for (const uci of ucis) {
    const m = playUci(g, uci);
    if (!m) break;
    out.push(m.san);
  }
  return out;
}

export function squareName(index: number): Square {
  return (FILES[index % 8] + (Math.floor(index / 8) + 1)) as Square;
}

export function squareIndex(sq: string): number {
  return FILES.indexOf(sq[0]) + 8 * (Number(sq[1]) - 1);
}

export const PIECE_NAMES: Record<string, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};
