/**
 * Plain-English notes about what a move does (pure chess logic, no UI; port of move_explain.py).
 *
 * Heuristics, not analysis: they describe the immediate, visible effect of a move — captures,
 * checks, forks, pins, skewers, development, outposts, files opened, passed pawns.
 *
 * Positions are FEN strings and moves UCI strings. Square geometry (attacks, pins, checkers)
 * is computed here on a 0..63 board (a1 = 0, h8 = 63), mirroring python-chess's semantics.
 */
import type { Chess } from "chess.js";
import { FILES, board as makeBoard, playUci, squareIndex, squareName } from "./chess";
import type { Color } from "./evaluation";

type PieceType = "p" | "n" | "b" | "r" | "q" | "k";
interface Piece {
  type: PieceType;
  color: Color;
}

export const VALUES: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
export const CENTER = new Set(["e4", "d4", "e5", "d5"].map(squareIndex));
export const SEPARATOR = "  ·  ";

type Dir = readonly [number, number];
const DIAGONALS: readonly Dir[] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const ORTHOGONALS: readonly Dir[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const RAYS: Partial<Record<PieceType, readonly Dir[]>> = {
  b: DIAGONALS,
  r: ORTHOGONALS,
  q: [...DIAGONALS, ...ORTHOGONALS],
};
const KNIGHT_STEPS: readonly Dir[] = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
];
const KING_STEPS: readonly Dir[] = [...DIAGONALS, ...ORTHOGONALS];

const NAMES: Record<PieceType, string> = {
  p: "Pawn",
  n: "Knight",
  b: "Bishop",
  r: "Rook",
  q: "Queen",
  k: "King",
};

/** "Knight", "Queen", ... for a chess.js piece letter. */
export function pieceName(pieceType: string): string {
  return NAMES[pieceType as PieceType] ?? pieceType;
}

/** Describe ``uci`` played from ``fen`` (an illegal move gives ""). */
export function explainMove(fen: string, uci: string): string {
  const game = makeBoard(fen);
  const before = Position.of(game);
  const from = squareIndex(uci.slice(0, 2));
  const to = squareIndex(uci.slice(2, 4));
  const mover = before.at(from);
  const legal = game.moves({ verbose: true }).find((m) => m.from + m.to + (m.promotion ?? "") === uci);
  if (mover === null || !legal) return "";
  const us = before.turn;
  const them: Color = us === "w" ? "b" : "w";
  const target = before.at(to); // null for en passant
  const afterGame = makeBoard(fen);
  playUci(afterGame, uci);
  const after = Position.of(afterGame);
  if (afterGame.isCheckmate()) return "Checkmate!";

  const flags = legal.flags;
  if (flags.includes("k") || flags.includes("q")) {
    const note = `Castles ${flags.includes("k") ? "kingside" : "queenside"}`;
    return afterGame.inCheck() ? `${note}${SEPARATOR}Gives check` : note;
  }

  const enPassant = flags.includes("e");
  const promotion = (legal.promotion as PieceType | undefined) ?? null;
  const mv: MoveInfo = { from, to, promotion, enPassant };
  const parts: string[] = [];
  if (enPassant) parts.push("En passant capture");
  if (promotion) parts.push(`Promotes to ${pieceName(promotion)}`);
  if (target !== null) parts.push(...captureNotes(before, after, mv, mover, target, us, them));
  parts.push(...checkNotes(after, mv));
  parts.push(...tacticNotes(before, after, mv, mover, them));
  parts.push(...positionalNotes(before, after, mv, mover, target, us, them));
  return parts.length ? parts.join(SEPARATOR) : "Improves position";
}

/** One line per move of a variation, stopping at the first illegal move. */
export function explainLine(fen: string, ucis: readonly string[], limit = 5): string {
  const lines: string[] = [];
  const g = makeBoard(fen);
  for (const [i, uci] of ucis.slice(0, limit).entries()) {
    const before = g.fen();
    const dots = g.turn() === "w" ? "." : "...";
    const num = g.moveNumber();
    const m = playUci(g, uci);
    if (!m) break;
    const prefix = i === 0 ? "▶ " : "  ";
    lines.push(`${prefix}${num}${dots} ${m.san}: ${explainMove(before, uci)}`);
  }
  return lines.join("\n");
}

// ── helpers ───────────────────────────────────────────────────────────────────

interface MoveInfo {
  from: number;
  to: number;
  promotion: PieceType | null;
  enPassant: boolean;
}

const fileOf = (sq: number) => sq % 8;
const rankOf = (sq: number) => Math.floor(sq / 8);
const sqOf = (file: number, rank: number) => file + 8 * rank;
const onBoard = (file: number, rank: number) => file >= 0 && file < 8 && rank >= 0 && rank < 8;

/** A snapshot of piece placement with python-chess-style attack queries. */
class Position {
  private constructor(
    private readonly squares: (Piece | null)[],
    readonly turn: Color,
  ) {}

  static of(game: Chess): Position {
    const squares: (Piece | null)[] = new Array(64).fill(null);
    for (let i = 0; i < 64; i++) {
      const p = game.get(squareName(i));
      if (p) squares[i] = { type: p.type as PieceType, color: p.color };
    }
    return new Position(squares, game.turn());
  }

  at(sq: number): Piece | null {
    return this.squares[sq];
  }

  /** Squares attacked by the piece on ``sq`` (sliders stop at the first piece, which counts). */
  attacks(sq: number): number[] {
    const p = this.at(sq);
    if (!p) return [];
    const f = fileOf(sq);
    const r = rankOf(sq);
    const out: number[] = [];
    const steps = (dirs: readonly Dir[]) => {
      for (const [df, dr] of dirs) if (onBoard(f + df, r + dr)) out.push(sqOf(f + df, r + dr));
    };
    switch (p.type) {
      case "p": {
        const dr = p.color === "w" ? 1 : -1;
        steps([
          [1, dr],
          [-1, dr],
        ]);
        break;
      }
      case "n":
        steps(KNIGHT_STEPS);
        break;
      case "k":
        steps(KING_STEPS);
        break;
      default:
        for (const [df, dr] of RAYS[p.type]!) {
          let ff = f + df;
          let rr = r + dr;
          while (onBoard(ff, rr)) {
            out.push(sqOf(ff, rr));
            if (this.at(sqOf(ff, rr))) break;
            ff += df;
            rr += dr;
          }
        }
    }
    return out;
  }

  /** Squares of ``color``'s pieces attacking ``sq`` (pins ignored, like python-chess). */
  attackers(color: Color, sq: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < 64; i++) {
      const p = this.at(i);
      if (p && p.color === color && this.attacks(i).includes(sq)) out.push(i);
    }
    return out;
  }

  isAttackedBy(color: Color, sq: number): boolean {
    return this.attackers(color, sq).length > 0;
  }

  king(color: Color): number | null {
    const i = this.squares.findIndex((p) => p !== null && p.type === "k" && p.color === color);
    return i >= 0 ? i : null;
  }

  /** Enemy pieces giving check to the side to move. */
  checkers(): number[] {
    const k = this.king(this.turn);
    return k === null ? [] : this.attackers(this.turn === "w" ? "b" : "w", k);
  }

  /** Is the piece on ``sq`` absolutely pinned to ``color``'s king? */
  isPinned(color: Color, sq: number): boolean {
    const k = this.king(color);
    if (k === null || k === sq) return false;
    const df = Math.sign(fileOf(sq) - fileOf(k));
    const dr = Math.sign(rankOf(sq) - rankOf(k));
    const diagonal = df !== 0 && dr !== 0;
    if (diagonal && Math.abs(fileOf(sq) - fileOf(k)) !== Math.abs(rankOf(sq) - rankOf(k))) return false;
    let f = fileOf(k) + df;
    let r = rankOf(k) + dr;
    let passed = false;
    while (onBoard(f, r)) {
      const s = sqOf(f, r);
      const p = this.at(s);
      if (s === sq) passed = true;
      else if (p) {
        if (!passed || p.color === color) return false;
        return p.type === "q" || p.type === (diagonal ? "b" : "r");
      }
      f += df;
      r += dr;
    }
    return false;
  }
}

function captureNotes(
  board: Position,
  after: Position,
  move: MoveInfo,
  mover: Piece,
  target: Piece,
  us: Color,
  them: Color,
): string[] {
  const parts: string[] = [];
  const attackerVal = VALUES[mover.type];
  const targetVal = VALUES[target.type];
  const name = pieceName(target.type);
  if (!board.isAttackedBy(them, move.to)) parts.push(`Takes free ${name}`);
  else if (targetVal > attackerVal) {
    if (attackerVal === 3 && targetVal === 5) parts.push("Wins the exchange");
    else parts.push(`Wins material (${name} for ${pieceName(mover.type)})`);
  } else if (targetVal === attackerVal) parts.push(`Trades ${name}`);
  else parts.push(`Captures ${name}`);

  // Did the captured piece guard something that is now attacked and undefended?
  for (const sq of board.attacks(move.to)) {
    const guarded = board.at(sq);
    if (guarded === null || guarded.color !== them) continue;
    if (after.isAttackedBy(us, sq) && !after.isAttackedBy(them, sq)) {
      parts.push(`Removes the defender of ${pieceName(guarded.type)}`);
      break;
    }
  }
  return parts;
}

function checkNotes(after: Position, move: MoveInfo): string[] {
  const checkers = after.checkers();
  if (!checkers.length) return [];
  if (checkers.length >= 2) return ["Double check!"];
  if (!checkers.includes(move.to)) return ["Discovered check"];
  return ["Gives check"];
}

function tacticNotes(board: Position, after: Position, move: MoveInfo, mover: Piece, them: Color): string[] {
  const parts: string[] = [];
  const pieceType = move.promotion ?? mover.type;
  const attackerVal = VALUES[pieceType];

  // Forks / attacks: enemy pieces the moved piece now threatens for real — the king,
  // anything worth more than the attacker, or anything left undefended.
  const threatened: Piece[] = [];
  for (const sq of after.attacks(move.to)) {
    const p = after.at(sq);
    if (p === null || p.color !== them || VALUES[p.type] < 3) continue;
    if (p.type === "k" || VALUES[p.type] > attackerVal || !after.isAttackedBy(them, sq)) threatened.push(p);
  }
  threatened.sort((a, b) => VALUES[b.type] - VALUES[a.type]); // stable, like Python's sort
  if (threatened.length >= 2) {
    const names = threatened
      .slice(0, 2)
      .map((p) => pieceName(p.type))
      .join(" and ");
    parts.push(`Forks ${names}`);
  } else if (threatened.length === 1 && threatened[0].type !== "k") {
    parts.push(`Attacks ${pieceName(threatened[0].type)}`);
  }

  // New absolute pin against the enemy king.
  for (let sq = 0; sq < 64; sq++) {
    const p = after.at(sq);
    if (p === null || p.color !== them || p.type === "k") continue;
    if (after.isPinned(them, sq) && !board.isPinned(them, sq)) {
      parts.push(`Pins ${pieceName(p.type)} to the King`);
      break;
    }
  }

  const skewer = skewerNote(after, move.to, pieceType, them);
  if (skewer) parts.push(skewer);
  return parts;
}

/** A valuable enemy piece on a ray with a cheaper enemy piece behind it. */
function skewerNote(after: Position, square: number, pieceType: PieceType, them: Color): string | null {
  const rays = RAYS[pieceType];
  if (!rays) return null;
  for (const [df, dr] of rays) {
    let f = fileOf(square) + df;
    let r = rankOf(square) + dr;
    let front: Piece | null = null;
    while (onBoard(f, r)) {
      const p = after.at(sqOf(f, r));
      if (p !== null) {
        if (front === null) {
          if (p.color !== them || VALUES[p.type] < 5) break;
          front = p;
        } else {
          if (p.color === them && p.type !== "k" && VALUES[p.type] >= 3 && VALUES[p.type] < VALUES[front.type]) {
            return `Skewers ${pieceName(front.type)} to win ${pieceName(p.type)}`;
          }
          break;
        }
      }
      f += df;
      r += dr;
    }
  }
  return null;
}

function positionalNotes(
  board: Position,
  after: Position,
  move: MoveInfo,
  mover: Piece,
  target: Piece | null,
  us: Color,
  them: Color,
): string[] {
  const parts: string[] = [];
  const backRank = us === "w" ? 0 : 7;
  const toRank = rankOf(move.to);

  if ((mover.type === "n" || mover.type === "b") && rankOf(move.from) === backRank) {
    parts.push(`Develops ${pieceName(mover.type)}`);
  }

  const inTheirHalf = us === "w" ? toRank >= 4 : toRank <= 3;
  if (
    mover.type === "n" &&
    inTheirHalf &&
    supportedByPawn(after, move.to, us) &&
    !enemyPawnAhead(after, move.to, us, them, true)
  ) {
    parts.push("Establishes outpost");
  }

  if (CENTER.has(move.to) && target === null && mover.type !== "k") parts.push("Controls center");

  const opened: number[] = [];
  const captured = target !== null || move.enPassant;
  if (mover.type === "p" && captured) opened.push(fileOf(move.from));
  if (target !== null && target.type === "p") opened.push(fileOf(move.to));
  for (const file of new Set(opened)) {
    let pawnOnFile = false;
    for (let r = 0; r < 8; r++) if (isPawn(after, file, r)) pawnOnFile = true;
    if (!pawnOnFile) parts.push(`Opens the ${FILES[file]}-file`);
  }

  if (
    mover.type === "p" &&
    !move.promotion &&
    isPassed(after, move.to, us, them) &&
    !isPassed(board, move.from, us, them)
  ) {
    parts.push("Creates passed pawn");
  }
  return parts;
}

function isPawn(board: Position, file: number, rank: number): boolean {
  const p = board.at(sqOf(file, rank));
  return p !== null && p.type === "p";
}

function supportedByPawn(board: Position, square: number, us: Color): boolean {
  return board.attackers(us, square).some((sq) => board.at(sq)?.type === "p");
}

/**
 * Is there an enemy pawn on a rank ahead of ``square`` (on adjacent files, or any of the
 * three files around it)?
 */
function enemyPawnAhead(board: Position, square: number, us: Color, them: Color, adjacentOnly: boolean): boolean {
  const f = fileOf(square);
  const r = rankOf(square);
  const ranks: number[] = [];
  if (us === "w") for (let rr = r + 1; rr < 8; rr++) ranks.push(rr);
  else for (let rr = 0; rr < r; rr++) ranks.push(rr);
  const files = adjacentOnly ? [f - 1, f + 1] : [f - 1, f, f + 1];
  for (const ff of files) {
    if (ff < 0 || ff >= 8) continue;
    for (const rr of ranks) {
      const p = board.at(sqOf(ff, rr));
      if (p !== null && p.color === them && p.type === "p") return true;
    }
  }
  return false;
}

function isPassed(board: Position, square: number, us: Color, them: Color): boolean {
  return !enemyPawnAhead(board, square, us, them, false);
}
