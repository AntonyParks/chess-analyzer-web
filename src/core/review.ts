/**
 * Analyze Game: evaluate every ply of the loaded game in the background, then review it
 * (port of game_analysis.py).
 *
 * UI-independent: the runner only needs a way to reach the current ``GameState`` and the
 * engine scheduler; whichever UI is in use connects the callbacks.
 */
import { board, epd, legalUcis, playUci, turnOf } from "./chess";
import { bestUci, cpDrop, cpPov, rankMoves, winChance, winDrop } from "./evaluation";
import type { GameState } from "./gameState";
import { OPENING_PLIES } from "./humanModel";
import { explainMove } from "./moveExplain";
import { type EngineScheduler, type EvalResult, Kind } from "../engine/scheduler";

export const BETTER_MOVE_MIN_GAIN = 0.01; // winning-chance gain before an alternative is worth suggesting

export interface GameReviewRunnerOptions {
  scheduler: EngineScheduler;
  /**
   * Engine for the depth traces behind "expected play" (searches from a cleared hash, so a
   * second engine keeps the main one's hash warm). Without it, no traces are run.
   */
  traceScheduler?: () => EngineScheduler;
  stateProvider: () => GameState;
  depthProvider: () => number;
  onProgress: (done: number, total: number) => void;
  onFinished: (completed: boolean) => void;
}

/**
 * Evaluates every ply of the loaded game with BATCH requests; never moves the board.
 *
 * The user can keep browsing while it runs. Any change to the move list cancels the run.
 * Each ply is one MultiPV request scoring every legal move of that position, so
 * ``PlyAnalysis.evals`` holds a score for each legal move.
 */
export class GameReviewRunner {
  private readonly opts: GameReviewRunnerOptions;
  private _running = false;
  private version = -1;
  private depth = 0;
  private pending = new Map<number, number>(); // ply -> scheduler request id
  private pendingTraces = new Map<number, number>(); // ply -> trace request id
  private traceEngine: EngineScheduler | null = null;
  private total = 0;

  constructor(opts: GameReviewRunnerOptions) {
    this.opts = opts;
  }

  get running(): boolean {
    return this._running;
  }

  /** Start a run; false if one is already running or the game has no moves. */
  start(): boolean {
    const state = this.opts.stateProvider();
    if (this._running || !state.moves.length) return false;
    this.version = state.version;
    this.depth = this.opts.depthProvider();
    this.total = state.moves.length + 1;
    this.pending = new Map();
    for (let ply = 0; ply < this.total; ply++) {
      const analysis = state.analysis.get(ply);
      if (analysis && analysis.complete && analysis.depth === this.depth) continue;
      const fen = state.fenAt(ply);
      const legal = legalUcis(fen);
      if (!legal.length) {
        state.analysis.set(ply, {
          positionCp: state.terminalEval(ply),
          evals: {},
          rankMap: {},
          complete: true,
          depth: this.depth,
        });
        continue;
      }
      // Mark pending before submitting, in case a result ever arrives synchronously.
      this.pending.set(ply, -1);
      const id = this.opts.scheduler.submit({
        kind: Kind.BATCH,
        fen,
        moves: legal,
        depth: this.depth,
        // One MultiPV search per position (every legal move scored at once): a per-move
        // search of each position is too slow on single-threaded WASM Stockfish.
        multipv: true,
        tag: ply,
        onDone: (r) => this.onDone(r),
      });
      if (this.pending.has(ply)) this.pending.set(ply, id);
    }
    this.pendingTraces = new Map();
    this.traceEngine = this.opts.traceScheduler?.() ?? null;
    if (this.traceEngine) {
      for (let ply = OPENING_PLIES; ply < state.moves.length; ply++) {
        const done = state.traces.get(ply);
        if (done && done.depth === this.depth) continue;
        const fen = state.fenAt(ply);
        if (legalUcis(fen).length < 2) continue;
        this.pendingTraces.set(ply, -1);
        const id = this.traceEngine.submit({
          kind: Kind.BATCH,
          fen,
          moves: [],
          depth: this.depth,
          trace: true,
          tag: ply,
          onDone: (r) => this.onTrace(r),
        });
        if (this.pendingTraces.has(ply)) this.pendingTraces.set(ply, id);
      }
      this.total += this.pendingTraces.size;
    }
    this._running = this.pending.size + this.pendingTraces.size > 0;
    this.report();
    if (!this._running) this.opts.onFinished(true);
    return true;
  }

  private report(): void {
    this.opts.onProgress(this.total - this.pending.size - this.pendingTraces.size, this.total);
  }

  private maybeFinish(): void {
    this.report();
    if (!this.pending.size && !this.pendingTraces.size) {
      this._running = false;
      this.opts.onFinished(true);
    }
  }

  private onTrace(result: EvalResult): void {
    const ply = result.tag as number;
    if (!this._running || !this.pendingTraces.has(ply)) return;
    const state = this.opts.stateProvider();
    if (state.version !== this.version) {
      this.cancel();
      return;
    }
    if (result.epd !== epd(state.fenAt(ply))) return;
    if (result.complete && result.trace) state.traces.set(ply, { depth: this.depth, trace: result.trace });
    this.pendingTraces.delete(ply);
    this.maybeFinish();
  }

  cancel(): void {
    if (!this._running) return;
    for (const id of this.pending.values()) if (id >= 0) this.opts.scheduler.cancel(id);
    for (const id of this.pendingTraces.values()) if (id >= 0) this.traceEngine?.cancel(id);
    this.pending.clear();
    this.pendingTraces.clear();
    this._running = false;
    this.opts.onFinished(false);
  }

  /** Call whenever the game may have changed; cancels a run that no longer applies. */
  onStateChanged(): void {
    if (this._running && this.opts.stateProvider().version !== this.version) this.cancel();
  }

  private onDone(result: EvalResult): void {
    const ply = result.tag as number;
    if (!this._running || !this.pending.has(ply)) return;
    const state = this.opts.stateProvider();
    if (state.version !== this.version) {
      this.cancel();
      return;
    }
    const fen = state.fenAt(ply);
    if (result.epd !== epd(fen)) return;
    const evals = { ...result.evals };
    const turn = turnOf(fen);
    const best = bestUci(evals, turn);
    state.analysis.set(ply, {
      positionCp: best ? evals[best].cpWhite : null,
      evals,
      rankMap: rankMoves(evals, turn),
      complete: result.complete,
      depth: this.depth,
    });
    this.pending.delete(ply);
    this.maybeFinish();
  }
}

export interface ReviewEntry {
  ply: number; // 1-indexed: the position after the move
  moveNumber: number;
  isWhite: boolean;
  san: string;
  marker: string;
  winDrop: number;
  cpDrop: number;
  betterSan: string | null;
  explanation: string;
  /** ``'12. Nf3?!'`` / ``'12... Nc6??'`` */
  label: string;
}

/** Flagged moves (inaccuracies and worse) with a better alternative where one exists. */
export function buildReview(state: GameState): ReviewEntry[] {
  const evals = state.positionEvals();
  const g = board(state.startFen);
  const entries: ReviewEntry[] = [];
  for (const [ply0, uci] of state.moves.entries()) {
    const ply = ply0 + 1;
    const fen = g.fen();
    const moveNumber = g.moveNumber();
    const mover = g.turn();
    const marker = state.markerAt(ply, evals);
    const played = playUci(g, uci);
    if (!played) break; // an illegal move ends the game record
    if (!marker) continue;
    const scores = state.analysis.get(ply0)?.evals ?? {};
    let betterSan: string | null = null;
    const best = bestUci(scores, mover);
    const playedEval = scores[uci];
    if (best && best !== uci && playedEval !== undefined) {
      const gain = winChance(cpPov(scores[best].cpWhite, mover)) - winChance(cpPov(playedEval.cpWhite, mover));
      if (gain >= BETTER_MOVE_MIN_GAIN) {
        const m = playUci(board(fen), best);
        betterSan = m ? m.san : null;
      }
    }
    const isWhite = mover === "w";
    entries.push({
      ply,
      moveNumber,
      isWhite,
      san: played.san,
      marker,
      winDrop: winDrop(evals.get(ply0)!, evals.get(ply)!, mover),
      cpDrop: cpDrop(evals.get(ply0)!, evals.get(ply)!, mover),
      betterSan,
      explanation: explainMove(fen, uci),
      label: `${moveNumber}${isWhite ? "." : "..."} ${played.san}${marker}`,
    });
  }
  return entries;
}
