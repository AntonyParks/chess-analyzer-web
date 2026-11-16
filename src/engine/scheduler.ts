/**
 * One engine, four kinds of request (port of engine_worker.py).
 *
 * HOVER and HEATMAP are single slots (a new request replaces the pending one); BATCH (game
 * review) and IDLE (background work: insights, puzzle scans) are queues, IDLE running only when
 * nothing else waits. A higher-priority request stops the running search; the interrupted
 * request goes back to its slot and resumes from the evaluation cache.
 *
 * Two ways to evaluate a list of moves:
 * - ``multipv``: one search of the position with MultiPV = the number of moves (the heatmap; one
 *   WASM thread is too slow for one search per move).
 * - per move: a search of the position after each move (review and scans, as on desktop).
 */
import { after, board, epd, turnOf } from "../core/chess";
import { MATE_SCORE_CP, type MoveEval, uciScoreToWhite } from "../core/evaluation";
import type { UciEngine } from "./uci";
import { UciSession } from "./uci";

export enum Kind {
  HOVER = 0,
  HEATMAP = 1,
  BATCH = 2,
  IDLE = 3,
}

/** The engine's choice and score after one depth of a search from a cleared hash. */
export interface TracePoint {
  depth: number;
  best: string; // UCI
  cpWhite: number;
}

export interface EvalResult {
  id: number;
  kind: Kind;
  epd: string; // consumers compare this with the position they show
  evals: Record<string, MoveEval>;
  complete: boolean;
  depth: number;
  /** ``trace`` requests: the main line at each depth, shallowest first. */
  trace?: TracePoint[];
  tag?: unknown;
}

export interface EvalRequest {
  kind: Kind;
  fen: string;
  moves: string[]; // UCI moves to evaluate, in priority order
  depth: number;
  multipv?: boolean;
  /** MultiPV only: report each finished depth from this one up (progressive heatmap). */
  fromDepth?: number;
  fresh?: boolean; // clear the hash before each search (the puzzle lookahead ladder)
  /**
   * Search the position itself once from a cleared hash and report the main line at every depth
   * (``EvalResult.trace``; ``moves`` is ignored). Used for "how deep must you look" measures.
   */
  trace?: boolean;
  tag?: unknown;
  onDone: (r: EvalResult) => void;
  onProgress?: (r: EvalResult) => void;
}

interface Pending {
  id: number;
  req: EvalRequest;
  results: Record<string, MoveEval>;
  trace?: TracePoint[];
  interrupted: boolean;
}

const CACHE_SIZE = 20_000;

export class EngineScheduler {
  private session: UciSession;
  private nextId = 1;
  private slots = new Map<Kind, Pending>();
  private queues = new Map<Kind, Pending[]>([
    [Kind.BATCH, []],
    [Kind.IDLE, []],
  ]);
  private cancelled = new Set<number>();
  private running: Pending | null = null;
  private loop: Promise<void> | null = null;
  private cache = new Map<string, MoveEval>();
  private traces = new Map<string, TracePoint[]>();
  private dead = false;

  constructor(
    engine: UciEngine,
    options: { hashMb?: number; threads?: number } = {},
  ) {
    this.session = new UciSession(engine);
    void this.session.setOption("Hash", options.hashMb ?? 32);
    if (options.threads) void this.session.setOption("Threads", options.threads);
  }

  get name(): string {
    return this.session.name;
  }

  submit(req: EvalRequest): number {
    const p: Pending = { id: this.nextId++, req, results: {}, interrupted: false };
    if (req.kind === Kind.HOVER || req.kind === Kind.HEATMAP) {
      const old = this.slots.get(req.kind);
      if (old) this.cancelled.add(old.id);
      if (this.running && this.running.req.kind === req.kind) this.cancel(this.running.id);
      this.slots.set(req.kind, p);
    } else {
      this.queues.get(req.kind)!.push(p);
    }
    if (this.running && this.running.req.kind > req.kind) {
      this.running.interrupted = true;
      this.session.stop();
    }
    this.kick();
    return p.id;
  }

  cancel(id: number): void {
    this.cancelled.add(id);
    if (this.running?.id === id) this.session.stop();
    for (const [kind, p] of this.slots) if (p.id === id) this.slots.delete(kind);
    for (const q of this.queues.values()) {
      const i = q.findIndex((p) => p.id === id);
      if (i >= 0) q.splice(i, 1);
    }
  }

  cancelKind(kind: Kind): void {
    const ids: number[] = [];
    const slot = this.slots.get(kind);
    if (slot) ids.push(slot.id);
    for (const p of this.queues.get(kind) ?? []) ids.push(p.id);
    if (this.running?.req.kind === kind) ids.push(this.running.id);
    ids.forEach((id) => this.cancel(id));
  }

  /** Resolves when nothing is queued or running (tests). */
  async idle(): Promise<void> {
    while (this.loop) await this.loop;
  }

  shutdown(): void {
    this.dead = true;
    this.session.stop();
    this.session.terminate();
  }

  private kick(): void {
    if (!this.loop && !this.dead) {
      this.loop = this.run().finally(() => {
        this.loop = null;
        if (this.hasWork()) this.kick();
      });
    }
  }

  private hasWork(): boolean {
    return this.slots.size > 0 || [...this.queues.values()].some((q) => q.length > 0);
  }

  private take(): Pending | null {
    for (const kind of [Kind.HOVER, Kind.HEATMAP]) {
      const p = this.slots.get(kind);
      if (p) {
        this.slots.delete(kind);
        return p;
      }
    }
    for (const kind of [Kind.BATCH, Kind.IDLE]) {
      const q = this.queues.get(kind)!;
      if (q.length) return q.shift()!;
    }
    return null;
  }

  private requeue(p: Pending): void {
    p.interrupted = false;
    if (p.req.kind === Kind.HOVER || p.req.kind === Kind.HEATMAP) {
      if (!this.slots.has(p.req.kind)) this.slots.set(p.req.kind, p);
    } else {
      this.queues.get(p.req.kind)!.unshift(p);
    }
  }

  private async run(): Promise<void> {
    for (;;) {
      if (this.dead) return;
      const p = this.take();
      if (!p) return;
      if (this.cancelled.has(p.id)) continue;
      this.running = p;
      try {
        const finished = p.req.trace
          ? await this.runTrace(p)
          : p.req.multipv
            ? await this.runMultiPv(p)
            : await this.runPerMove(p);
        if (finished && !this.cancelled.has(p.id)) this.finish(p, true);
        else if (!finished && !this.cancelled.has(p.id)) this.requeue(p);
      } catch (err) {
        console.error("Engine error", err);
        if (!this.cancelled.has(p.id)) this.finish(p, false);
      } finally {
        this.running = null;
      }
    }
  }

  private result(p: Pending, complete: boolean, depth: number): EvalResult {
    return {
      id: p.id,
      kind: p.req.kind,
      epd: epd(p.req.fen),
      evals: { ...p.results },
      complete,
      depth,
      ...(p.trace ? { trace: p.trace } : {}),
      tag: p.req.tag,
    };
  }

  private finish(p: Pending, complete: boolean): void {
    p.req.onDone(this.result(p, complete, p.req.depth));
  }

  /** False when interrupted (to be resumed). */
  private async runPerMove(p: Pending): Promise<boolean> {
    const { req } = p;
    for (const uci of req.moves) {
      if (uci in p.results) continue;
      if (this.cancelled.has(p.id)) return true;
      const key = `${epd(req.fen)}|${uci}|${req.depth}|${req.fresh ? 1 : 0}`;
      const cached = this.cache.get(key);
      if (cached) {
        p.results[uci] = cached;
        continue;
      }
      const fenAfter = after(req.fen, uci);
      if (fenAfter === null) continue;
      const terminal = terminalEval(fenAfter);
      let ev: MoveEval;
      if (terminal) {
        ev = terminal;
      } else {
        if (req.fresh) await this.session.newGame();
        const out = await this.session.search(fenAfter, req.depth);
        if (out.aborted || p.interrupted) return this.cancelled.has(p.id);
        const info = out.lines.get(1);
        if (!info) continue;
        ev = {
          cpWhite: uciScoreToWhite(info.kind, info.value, turnOf(fenAfter)),
          pv: info.pv,
          depth: info.depth,
        };
      }
      this.remember(key, ev);
      p.results[uci] = ev;
      req.onProgress?.(this.result(p, false, req.depth));
    }
    return true;
  }

  private async runTrace(p: Pending): Promise<boolean> {
    const { req } = p;
    const key = `${epd(req.fen)}|${req.depth}`;
    const cached = this.traces.get(key);
    if (cached) {
      p.trace = cached;
      return true;
    }
    if (terminalEval(req.fen)) {
      p.trace = [];
      return true;
    }
    await this.session.newGame();
    const out = await this.session.search(req.fen, req.depth);
    if (out.aborted || p.interrupted) return this.cancelled.has(p.id);
    const mover = turnOf(req.fen);
    p.trace = out.byDepth.map((i) => ({ depth: i.depth, best: i.pv[0], cpWhite: uciScoreToWhite(i.kind, i.value, mover) }));
    this.traces.set(key, p.trace);
    if (this.traces.size > 2_000) this.traces.delete(this.traces.keys().next().value!);
    return true;
  }

  private async runMultiPv(p: Pending): Promise<boolean> {
    const { req } = p;
    const mover = turnOf(req.fen);
    const moves = req.moves;
    if (!moves.length) return true;
    const depths: number[] = [];
    for (let d = req.fromDepth ?? req.depth; d < req.depth; d += 4) depths.push(d);
    depths.push(req.depth);
    for (const depth of depths) {
      const key = `${epd(req.fen)}|*|${depth}`;
      const cachedAll = moves.every((m) => this.cache.has(`${key}|${m}`));
      if (cachedAll) {
        for (const m of moves) p.results[m] = this.cache.get(`${key}|${m}`)!;
      } else {
        const out = await this.session.search(req.fen, depth, {
          multipv: moves.length,
          searchmoves: moves,
        });
        if (out.aborted || p.interrupted) return this.cancelled.has(p.id);
        const fresh: Record<string, MoveEval> = {};
        for (const info of out.lines.values()) {
          const [first, ...rest] = info.pv;
          if (!first) continue;
          // The root score is from the mover's side; MoveEval is about the position after.
          fresh[first] = {
            cpWhite: uciScoreToWhite(info.kind, info.value, mover),
            pv: rest,
            depth: info.depth,
          };
        }
        for (const m of moves) {
          const fenAfter = after(req.fen, m);
          const t = fenAfter ? terminalEval(fenAfter) : null;
          if (t) fresh[m] = t;
        }
        for (const [m, ev] of Object.entries(fresh)) {
          this.remember(`${key}|${m}`, ev);
          p.results[m] = ev;
        }
      }
      if (depth < req.depth) req.onProgress?.(this.result(p, false, depth));
    }
    return true;
  }

  private remember(key: string, ev: MoveEval): void {
    this.cache.set(key, ev);
    if (this.cache.size > CACHE_SIZE) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
  }

}

/** Score for a position with no legal moves (checkmate or stalemate), else null. */
export function terminalEval(fen: string): MoveEval | null {
  const g = board(fen);
  if (g.isCheckmate()) {
    const mated = turnOf(fen);
    return { cpWhite: mated === "w" ? -MATE_SCORE_CP : MATE_SCORE_CP, pv: [], depth: 0 };
  }
  if (g.isGameOver()) return { cpWhite: 0, pv: [], depth: 0 };
  return null;
}

