/**
 * Scan the user's games for mistakes and turn each one into a puzzle (port of puzzle_scan.py).
 *
 * The desktop drives a generator state machine from engine callbacks; here each game is an
 * async function that awaits batches of engine requests. Per game, the cost is kept low:
 *
 * 1. One evaluation per ply (the played move only). The score after the opponent's move is the
 *    position the user faced, so comparing it with the score after the user's move gives the
 *    winning chances that move gave up.
 * 2. Each candidate (a drop of at least ``INACCURACY``) gets every legal move evaluated, which
 *    confirms it at one consistent depth and gives the answers for the first step.
 * 3. A ladder of shallow two-move searches finds how far ahead the engine must look before the
 *    best move clearly beats the played one (``Puzzle.visiblePlies``, the lookahead filter).
 *    These go to a separate scheduler with ``fresh: true`` (hash cleared before every search):
 *    a hash warm from the deep searches makes shallow searches "see" far deeper than their depth.
 * 4. Later steps follow the engine line while the best move stays clearly better than the rest.
 */
import type { ChessComGame } from "../data/chesscom";
import { after, isLegal, legalUcis, sanOf } from "./chess";
import { INACCURACY, type MoveEval, classify, cpPov, winChance } from "./evaluation";
import { GameState } from "./gameState";
import {
  MAX_STEPS,
  type Puzzle,
  type PuzzleStep,
  type PuzzleStore,
  SEVERITY,
  puzzleId,
  scoresFor,
  shouldContinue,
} from "./puzzles";
import { type EvalRequest, type EvalResult, Kind } from "../engine/scheduler";

export const DEFAULT_SCAN_DEPTH = 12;
/** Search depths for the visibility ladder; a search at depth d after the move looks d + 1
 * plies ahead counting the move itself, so these give lookaheads of 2, 4, 6, … plies. */
export const LADDER_DEPTHS = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23] as const;
export const ENGINE_STOPPED_MESSAGE = "The chess engine stopped; the scan was interrupted.";

/** What the scanner needs from an engine scheduler (``EngineScheduler`` fits). */
export interface WorkerLike {
  submit(req: EvalRequest): number;
  cancel(id: number): void;
}

export interface PuzzleScannerOptions {
  worker: WorkerLike;
  store: PuzzleStore;
  ladderWorker?: WorkerLike; // cold, single-threaded; else ``worker``
  onProgress: (done: number, total: number, found: number) => void; // games done, games total, puzzles found
  onPuzzle: (p: Puzzle) => void;
  onFinished: (ok: boolean, error: string | null) => void; // completed, error message
  /** Called after each game is marked analysed (the desktop saves the store here). */
  onGameDone?: (game: ChessComGame) => void;
  kind?: Kind;
}

type Evals = Record<string, MoveEval>;
interface BatchItem {
  fen: string;
  moves: string[];
  depth: number;
  shallow: boolean; // a ladder search: cold hash, on the ladder worker
}

class Stopped extends Error {}
class EngineStopped extends Error {}

export class PuzzleScanner {
  private readonly worker: WorkerLike;
  private readonly ladderWorker: WorkerLike;
  private readonly store: PuzzleStore;
  private readonly opts: PuzzleScannerOptions;
  private readonly kind: Kind;
  private run = 0;
  private _running = false;
  private depth = DEFAULT_SCAN_DEPTH;
  private games: ChessComGame[] = [];
  private index = 0;
  private found = 0;
  /** Requests in flight: id, the worker it went to, and how to abandon its promise. */
  private pending: { id: number; worker: WorkerLike; reject: (e: Error) => void }[] = [];

  constructor(opts: PuzzleScannerOptions) {
    this.opts = opts;
    this.worker = opts.worker;
    this.ladderWorker = opts.ladderWorker ?? opts.worker;
    this.store = opts.store;
    this.kind = opts.kind ?? Kind.IDLE;
  }

  get running(): boolean {
    return this._running;
  }

  /**
   * Scan ``games`` (skipping ones already scanned at this depth or deeper). The promise
   * resolves when this scan ends for any reason; results come through the callbacks.
   */
  async scan(games: readonly ChessComGame[], depth: number): Promise<void> {
    this.stop(false);
    const run = ++this.run;
    this._running = true;
    this.depth = depth;
    this.games = games.filter((g) => !this.store.isAnalysed(g.url, depth));
    this.index = 0;
    this.found = 0;
    this.report();
    while (this.index < this.games.length) {
      const game = this.games[this.index];
      try {
        await this.gameJob(game, run);
      } catch (err) {
        if (err instanceof Stopped || run !== this.run) return;
        if (err instanceof EngineStopped) {
          this.stop(false);
          this.opts.onFinished(false, ENGINE_STOPPED_MESSAGE);
          return;
        }
        console.error(`Puzzle scan failed on ${game.url}`, err);
      }
      if (run !== this.run) return;
      this.gameDone(game);
    }
    this._running = false;
    this.opts.onFinished(true, null);
  }

  stop(notify = true): void {
    if (!this._running) return;
    this.run += 1;
    const pending = this.pending;
    this.pending = [];
    for (const { id, worker, reject } of pending) {
      worker.cancel(id);
      reject(new Stopped());
    }
    this._running = false;
    if (notify) this.opts.onFinished(false, null);
  }

  // ── Driver ────────────────────────────────────────────────────────────────

  private report(): void {
    this.opts.onProgress(this.index, this.games.length, this.found);
  }

  private gameDone(game: ChessComGame): void {
    this.store.markAnalysed(game.url, this.depth);
    try {
      this.opts.onGameDone?.(game);
    } catch (err) {
      console.warn("Could not save puzzles", err);
    }
    this.index += 1;
    this.report();
  }

  private foundPuzzle(p: Puzzle): void {
    this.store.add(p);
    this.found += 1;
    this.opts.onPuzzle(p);
    this.report();
  }

  /** Submit every item at once and wait for all of them (rejects with Stopped on stop). */
  private evaluate(items: BatchItem[], run: number): Promise<Evals[]> {
    if (run !== this.run) return Promise.reject(new Stopped());
    if (!items.length) return Promise.resolve([]);
    return new Promise<Evals[]>((resolve, reject) => {
      const results: (Evals | null)[] = items.map(() => null);
      let left = items.length;
      const mine: typeof this.pending = [];
      const fail = (e: Error) => {
        for (const entry of mine) {
          const i = this.pending.indexOf(entry);
          if (i >= 0) {
            this.pending.splice(i, 1);
            entry.worker.cancel(entry.id); // the rest of a batch that failed
          }
        }
        reject(e);
      };
      items.forEach((item, index) => {
        const worker = item.shallow ? this.ladderWorker : this.worker;
        const entry = { id: 0, worker, reject: fail };
        mine.push(entry);
        this.pending.push(entry);
        entry.id = worker.submit({
          kind: this.kind,
          fen: item.fen,
          moves: item.moves,
          depth: item.depth,
          fresh: item.shallow,
          tag: [run, index],
          onDone: (r: EvalResult) => {
            const i = this.pending.indexOf(entry);
            if (run !== this.run || i < 0) return; // stale: stopped or superseded
            if (!r.complete) {
              fail(new EngineStopped());
              return;
            }
            this.pending.splice(i, 1);
            results[index] = { ...r.evals };
            if (--left === 0) resolve(results.map((e) => e ?? {}));
          },
        });
      });
    });
  }

  // ── One game ──────────────────────────────────────────────────────────────

  private async gameJob(game: ChessComGame, run: number): Promise<void> {
    let parsed: GameState;
    try {
      parsed = GameState.fromPgn(game.pgn);
    } catch {
      return; // unreadable PGN: nothing to scan (the game still counts as scanned)
    }
    const moves = parsed.moves;
    if (!moves.length) return;
    const user = game.userColor;
    const depth = this.depth;
    const positions = moves.map((_, ply) => parsed.fenAt(ply));

    const played = await this.evaluate(
      positions.map((fen, ply) => ({ fen, moves: [moves[ply]], depth, shallow: false })),
      run,
    );

    /** Winning chances for the user once the move at ``ply`` has been played. */
    const afterPly = (ply: number): number => {
      const e = played[ply][moves[ply]];
      return e === undefined ? 0 : winChance(cpPov(e.cpWhite, user));
    };

    for (let ply = 0; ply < moves.length; ply++) {
      if (ply === 0 || turn(positions[ply]) !== user) continue;
      if (afterPly(ply - 1) - afterPly(ply) < INACCURACY) continue;
      const puzzle = await this.build(game, positions[ply], moves[ply], ply, run);
      if (run !== this.run) throw new Stopped();
      if (puzzle !== null) this.foundPuzzle(puzzle);
    }
  }

  private async build(
    game: ChessComGame,
    fen: string,
    played: string,
    ply: number,
    run: number,
  ): Promise<Puzzle | null> {
    const user = turn(fen);
    const depth = this.depth;
    const [evals] = await this.evaluate([{ fen, moves: legalUcis(fen), depth, shallow: false }], run);
    const scores = scoresFor(evals, user);
    if (!(played in scores)) return null;
    const bestUci = argmax(scores);
    const drop = scores[bestUci] - scores[played];
    const marker = classify(drop);
    if (!marker || bestUci === played) return null;

    let visiblePlies = depth + 1;
    for (const rung of LADDER_DEPTHS) {
      if (rung >= depth) break;
      const [shallow] = await this.evaluate([{ fen, moves: [bestUci, played], depth: rung, shallow: true }], run);
      const gap = scoresFor(shallow, user);
      if ((gap[bestUci] ?? -1) - (gap[played] ?? 1) >= SEVERITY[marker]) {
        visiblePlies = rung + 1;
        break;
      }
    }

    const steps: PuzzleStep[] = [];
    let continuation: string[] = [];
    let curFen = fen;
    let curEvals = evals;
    let curScores = scores;
    let curBest = bestUci;
    for (;;) {
      const step: PuzzleStep = { fen: curFen, bestUci: curBest, scores: curScores, replyUci: null };
      steps.push(step);
      const line = curEvals[curBest]?.pv ?? [];
      continuation = [...line];
      if (!line.length || steps.length >= MAX_STEPS) break;
      const reply = line[0];
      const mid = after(curFen, curBest);
      if (mid === null || !isLegal(mid, reply)) break;
      const nxt = after(mid, reply)!;
      const legal = legalUcis(nxt);
      if (!legal.length) break;
      const [nextEvals] = await this.evaluate([{ fen: nxt, moves: legal, depth, shallow: false }], run);
      const nextScores = scoresFor(nextEvals, user);
      if (!shouldContinue(nextScores)) break;
      step.replyUci = reply;
      continuation = [];
      curFen = nxt;
      curEvals = nextEvals;
      curScores = nextScores;
      curBest = argmax(nextScores);
    }

    return {
      id: puzzleId(game.url, ply),
      gameUrl: game.url,
      endTime: game.endTime,
      opponent: game.opponent,
      opponentRating: game.opponentRating,
      timeClass: game.timeClass,
      userWhite: user === "w",
      ply,
      moveNumber: Number(fen.split(" ")[5] ?? 1),
      playedUci: played,
      playedSan: sanOf(fen, played),
      bestSan: sanOf(fen, bestUci),
      marker,
      winDrop: Math.round(drop * 1e4) / 1e4,
      scanDepth: depth,
      visiblePlies,
      steps,
      continuation,
      attempts: 0,
      solved: 0,
      failed: 0,
      lastResult: null,
    };
  }
}

function turn(fen: string): "w" | "b" {
  return fen.split(" ")[1] === "b" ? "b" : "w";
}

/** The first key with the highest value (Python's ``max(d, key=d.get)``). */
function argmax(scores: Record<string, number>): string {
  let best = "";
  let bestValue = -Infinity;
  for (const [k, v] of Object.entries(scores)) {
    if (v > bestValue) {
      best = k;
      bestValue = v;
    }
  }
  return best;
}

/**
 * A rough [low, high] scan time in seconds. The desktop measured about 4-15 s a game at depth
 * 12 (multi-threaded native Stockfish, ~4.5 s typical); single-threaded WASM Stockfish in the
 * browser is assumed to be about 3x slower, so this uses 12-45 s a game at depth 12.
 */
export function estimateSeconds(games: number, depth: number): [number, number] {
  const WASM_SLOWDOWN = 3;
  const scale = 1.5 ** (depth - DEFAULT_SCAN_DEPTH);
  return [Math.trunc(games * 4 * WASM_SLOWDOWN * scale), Math.trunc(games * 15 * WASM_SLOWDOWN * scale)];
}

/** Python's round(): halves go to the even neighbour. */
function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export function formatDuration(seconds: number): string {
  if (seconds < 90) return `${seconds} s`;
  const minutes = roundHalfEven(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
}
