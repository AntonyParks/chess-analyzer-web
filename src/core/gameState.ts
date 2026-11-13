/**
 * The loaded game: a start position, a move list, the shown ply and engine results per ply
 * (port of game_state.py). Plain data plus helpers; the UI wraps it in React state.
 */
import { Chess } from "chess.js";
import { START_FEN, board, playUci, turnOf } from "./chess";
import { type Color, MATE_SCORE_CP, type MoveEval, classify, other, winDrop } from "./evaluation";

/** Engine results for the position reached after ``ply`` moves. */
export interface PlyAnalysis {
  positionCp: number | null; // White's view: the score after the best move
  evals: Record<string, MoveEval>; // uci -> evaluation
  rankMap: Record<string, number>; // uci -> 0..1 (1 = best)
  complete: boolean;
  depth: number;
}

export class GameState {
  startFen: string;
  moves: string[] = []; // UCI
  currentPly = 0;
  headers: Record<string, string> = {};
  analysis = new Map<number, PlyAnalysis>();
  version = 0; // bumps whenever the move list changes
  private fenCache = new Map<number, string>();

  constructor(startFen: string = START_FEN) {
    this.startFen = startFen;
  }

  clone(): GameState {
    const s = new GameState(this.startFen);
    s.moves = [...this.moves];
    s.currentPly = this.currentPly;
    s.headers = { ...this.headers };
    s.analysis = new Map(this.analysis);
    s.version = this.version;
    s.fenCache = this.fenCache;
    return s;
  }

  /** FEN after ``ply`` moves. */
  fenAt(ply: number): string {
    const p = Math.max(0, Math.min(ply, this.moves.length));
    const cached = this.fenCache.get(p);
    if (cached) return cached;
    const g = board(this.startFen);
    for (const uci of this.moves.slice(0, p)) playUci(g, uci);
    const fen = g.fen();
    this.fenCache.set(p, fen);
    return fen;
  }

  get fen(): string {
    return this.fenAt(this.currentPly);
  }

  moverAt(ply: number): Color {
    const first = turnOf(this.startFen);
    return ply % 2 === 0 ? first : other(first);
  }

  get lastMove(): string | null {
    return this.currentPly > 0 ? this.moves[this.currentPly - 1] : null;
  }

  get atEnd(): boolean {
    return this.currentPly === this.moves.length;
  }

  goto(ply: number): number {
    this.currentPly = Math.max(0, Math.min(ply, this.moves.length));
    return this.currentPly;
  }

  /** Play ``uci`` from the current ply, discarding later moves and their analysis. */
  push(uci: string): void {
    this.moves.splice(this.currentPly);
    for (const p of [...this.analysis.keys()]) if (p > this.currentPly) this.analysis.delete(p);
    this.moves.push(uci);
    this.currentPly += 1;
    this.changed();
  }

  loadFen(fen: string): void {
    this.reset(fen, [], {});
    this.currentPly = 0;
  }

  loadGame(startFen: string, moves: string[], headers: Record<string, string> = {}): void {
    this.reset(startFen, moves, headers);
    this.currentPly = moves.length;
  }

  private reset(startFen: string, moves: string[], headers: Record<string, string>): void {
    this.startFen = startFen;
    this.moves = [...moves];
    this.headers = { ...headers };
    this.analysis = new Map();
    this.changed();
  }

  private changed(): void {
    this.version += 1;
    this.fenCache = new Map();
  }

  /** Parse a PGN (first game); throws Error with a readable message on failure. */
  static fromPgn(pgn: string): GameState {
    const g = new Chess();
    g.loadPgn(pgn);
    const headers = g.getHeaders() as Record<string, string>;
    const history = g.history({ verbose: true });
    const startFen = history.length ? history[0].before : g.fen();
    const s = new GameState(headers.FEN && headers.SetUp === "1" ? headers.FEN : startFen);
    s.moves = history.map((m) => m.from + m.to + (m.promotion ?? ""));
    s.headers = headers;
    s.currentPly = s.moves.length;
    return s;
  }

  toPgn(): string {
    const g = board(this.startFen);
    if (this.startFen !== START_FEN) {
      g.setHeader("SetUp", "1");
      g.setHeader("FEN", this.startFen);
    }
    for (const [k, v] of Object.entries(this.headers)) if (k !== "SetUp" && k !== "FEN") g.setHeader(k, v);
    for (const uci of this.moves) playUci(g, uci);
    return g.pgn();
  }

  /** (fullmove number, white to move, SAN) for every move. */
  sanLabels(): { num: number; white: boolean; san: string }[] {
    const g = board(this.startFen);
    const out: { num: number; white: boolean; san: string }[] = [];
    for (const uci of this.moves) {
      const num = g.moveNumber();
      const white = g.turn() === "w";
      const m = playUci(g, uci);
      if (!m) break;
      out.push({ num, white, san: m.san });
    }
    return out;
  }

  positionEvals(): Map<number, number> {
    const out = new Map<number, number>();
    for (const [p, a] of this.analysis) if (a.positionCp !== null) out.set(p, a.positionCp);
    return out;
  }

  /** "?!", "?", "??" or "" for the move that led to ``ply``. */
  markerAt(ply: number, evals: Map<number, number> = this.positionEvals()): string {
    if (ply < 1 || !evals.has(ply) || !evals.has(ply - 1)) return "";
    return classify(winDrop(evals.get(ply - 1)!, evals.get(ply)!, this.moverAt(ply - 1)));
  }

  /** ±MATE for checkmate, 0 for a finished draw, null for a live position. */
  terminalEval(ply: number): number | null {
    const g = board(this.fenAt(ply));
    if (g.isCheckmate()) return g.turn() === "w" ? -MATE_SCORE_CP : MATE_SCORE_CP;
    if (g.isGameOver()) return 0;
    return null;
  }
}
