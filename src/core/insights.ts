/**
 * Opening Insights (port of opening_insights.py): walk the Lichess opening tree and flag
 * *challenging* moves.
 *
 * A move for the chosen colour is *notable* when opponents, on average, do markedly worse
 * after it than their most reliable reply would achieve. The move is judged from the
 * position after it: each reply's score is compared with the position's overall score
 * (Wilson intervals on both sides, so neither a few lucky games nor a rarely tried reply can
 * decide it); the reply that reliably holds the chosen colour's score down most is the
 * *best reply*, and the average opponent's shortfall against it is the move's *challenge*.
 *
 * The desktop app crawls on a thread; here the crawl is an async loop that yields to the
 * event loop, with stop() cancelling waits and in-flight requests. No engine is used.
 */
import { after, epd, turnOf } from "./chess";
import type { Color } from "./evaluation";
import {
  type ExplorerQuery,
  type ExplorerResult,
  LichessAuthError,
  type LichessClient,
  LichessRateLimited,
  LichessUnavailable,
  type MoveStats,
} from "../data/lichess";

export const MAX_MOVES_PER_POSITION = 20; // asked of the server; its own cap may be lower

export interface InsightsParams {
  color: Color;
  minPct: number; // examine a move only if it has ≥ minPct % of its position's games
  minGames: number; // games a move needs before it is judged or its position explored
  topN: number; // opponent replies to explore per position (0 = all returned)
  deltaPp: number; // the smallest challenge (in points) a move needs to be listed
  query: ExplorerQuery;
  maxPositions?: number; // default 300
  maxDepth?: number; // default 24 plies
  maxSeconds?: number; // default 900
  minInterval?: number; // seconds between real requests (default 1; Lichess asks for courtesy)
}

const DEFAULTS = { maxPositions: 300, maxDepth: 24, maxSeconds: 900, minInterval: 1.0 };

export interface NotableMove {
  rootFen: string; // the loaded game's start position
  prefixMoves: readonly string[]; // UCI: the loaded game up to where the run started
  line: readonly string[]; // UCI: from there to the position before the move
  move: string; // UCI
  san: string;
  games: number; // games in which the move was played from its position
  positionGames: number; // all games played from that position, whatever the move
  scorePct: number; // the chosen colour's score rate (wins + ½ draws) after the move, in %
  scoreGames: number; // games that rate is taken over: those reaching the position after it
  bestReplySan: string; // the opponent's most reliable reply
  bestReplyShare: number; // how often it is played after the move, in %
  bestReplyPct: number; // the chosen colour's score rate after it, in %
  challengePp: number; // 95 % lower bound of (scorePct - bestReplyPct); see judgeMove
  popularityRank: number; // 1 = most played move in its position
}

/** Moves that replay the position in which the notable move is played. */
export function positionMoves(nm: NotableMove): string[] {
  return [...nm.prefixMoves, ...nm.line];
}

/** How often the move is chosen here: its share of the position's games, in %. */
export function playPct(nm: NotableMove): number {
  return nm.positionGames ? (100 * nm.games) / nm.positionGames : 0;
}

export interface InsightsSummary {
  runId: number;
  positions: number;
  found: number;
  stopped: boolean;
  error: string | null;
  depth: number; // deepest position fetched, in plies from the start position
  limit: "" | "position limit" | "time limit"; // which cap ended the run, if any
}

// ── Statistics ───────────────────────────────────────────────────────────────

/** The Wilson score interval for ``successes`` out of ``n`` trials; no trials gives [0, 1]. */
export function wilsonBounds(successes: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const p = Math.min(1, Math.max(0, successes / n));
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const scale = 1 + z2 / n;
  return [Math.max(0, (centre - margin) / scale), Math.min(1, (centre + margin) / scale)];
}

export function wilsonLower(successes: number, n: number, z = 1.96): number {
  return wilsonBounds(successes, n, z)[0];
}

/** Wins plus half the draws, for ``color``. */
export function scorePoints(white: number, draws: number, black: number, color: Color): number {
  return (color === "w" ? white : black) + 0.5 * draws;
}

/** How challenging a move is, judged from the position after it (fractions). */
export interface Verdict {
  score: number; // the chosen colour's score rate over the games reaching the position
  games: number;
  bestReply: MoveStats; // the opponent's most reliable reply
  bestReplyScore: number; // the chosen colour's score rate after it
  challenge: number; // 95 % lower bound of score - bestReplyScore
}

/**
 * Judge the move that led to ``afterResult`` (the opponent to move); null unless notable.
 *
 * For each reply, the gap between the position's overall score and the score after that
 * reply gets Newcombe's hybrid score interval; the reply with the largest lower bound is the
 * best reply and that bound is the challenge. Replies below ``minPct`` of the games are not
 * considered unless none qualifies. Notable when the challenge reaches ``deltaPp``.
 */
export function judgeMove(afterResult: ExplorerResult, params: InsightsParams): Verdict | null {
  const n = afterResult.total;
  if (n <= 0 || n < params.minGames) return null;
  const played = afterResult.moves.filter((r) => r.total > 0);
  if (!played.length) return null;
  const threshold = (params.minPct / 100) * n;
  let replies = played.filter((r) => r.total >= threshold);
  if (!replies.length) replies = [played.reduce((a, b) => (b.total > a.total ? b : a))];
  const points = scorePoints(afterResult.white, afterResult.draws, afterResult.black, params.color);
  const score = points / n;
  const [lower] = wilsonBounds(points, n);
  let best: { bound: number; reply: MoveStats; rScore: number } | null = null;
  for (const reply of replies) {
    const rPoints = scorePoints(reply.white, reply.draws, reply.black, params.color);
    const rScore = rPoints / reply.total;
    const [, rUpper] = wilsonBounds(rPoints, reply.total);
    const bound = score - rScore - Math.sqrt((score - lower) ** 2 + (rUpper - rScore) ** 2);
    if (best === null || bound > best.bound) best = { bound, reply, rScore };
  }
  if (best === null || best.bound * 100 < params.deltaPp) return null;
  return { score, games: n, bestReply: best.reply, bestReplyScore: best.rScore, challenge: best.bound };
}

/** Python-style ``round(x, 1)`` closely enough for display (half away from zero). */
const round1 = (x: number): number => Math.round(x * 10) / 10;

// ── The crawl ────────────────────────────────────────────────────────────────

/** What the crawl needs from a client (LichessClient, or a fake in tests). */
export type ExplorerSource = Pick<LichessClient, "cached" | "explorer">;

export interface InsightsCallbacks {
  onProgress?: (runId: number, message: string) => void;
  onResult?: (runId: number, move: NotableMove) => void;
  onFinished?: (summary: InsightsSummary) => void;
}

/** A position to fetch: the line to it and, when the chosen colour's move led here, that
 * move's statistics in its parent position, so it can be judged once this one is known. */
interface Entry {
  fen: string;
  line: string[];
  depth: number;
  via: MoveStats | null;
  parentTotal: number; // games played from the parent position
  parentRank: number; // the move's popularity rank there (1 = most played)
}

class RunControl {
  stopped = false;
  readonly abort = new AbortController();
  private wakers = new Set<() => void>();

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    for (const wake of this.wakers) wake();
    this.wakers.clear();
  }

  /** Sleep ``seconds``; resolves true if stopped meanwhile (like threading.Event.wait). */
  wait(seconds: number): Promise<boolean> {
    if (this.stopped) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve(this.stopped);
      };
      const timer = setTimeout(done, Math.max(0, seconds * 1000));
      this.wakers.add(done);
    });
  }
}

const nowSeconds = (): number => performance.now() / 1000;
const YIELD_EVERY = 25; // cached positions processed between yields to the event loop

/** Breadth-first crawl run asynchronously; results arrive through the callbacks. */
export class InsightsWorker {
  private readonly client: ExplorerSource;
  private control: RunControl | null = null;
  private current: Promise<void> | null = null;
  private runId = 0;
  private active = 0;

  constructor(client: ExplorerSource) {
    this.client = client;
  }

  get running(): boolean {
    return this.active > 0;
  }

  /** Start a run (stopping any previous one). Returns the run id used in callbacks. */
  start(
    params: InsightsParams,
    startFen: string,
    rootFen: string,
    prefixMoves: readonly string[],
    callbacks: InsightsCallbacks = {},
  ): number {
    this.stop();
    const control = new RunControl();
    this.control = control;
    const runId = ++this.runId;
    this.active++;
    this.current = this.run(runId, control, params, startFen, rootFen, [...prefixMoves], callbacks).finally(
      () => {
        this.active--;
      },
    );
    return runId;
  }

  stop(): void {
    this.control?.stop();
  }

  /** Resolves when the latest run has finished (after its onFinished). */
  async wait(): Promise<void> {
    await this.current;
  }

  private async run(
    runId: number,
    control: RunControl,
    p: InsightsParams,
    startFen: string,
    rootFen: string,
    prefixMoves: string[],
    cb: InsightsCallbacks,
  ): Promise<void> {
    const params = { ...DEFAULTS, ...p };
    // No late progress or results once stopped; onFinished always arrives.
    const progress = (msg: string) => {
      if (!control.stopped) cb.onProgress?.(runId, msg);
    };
    const queue: Entry[] = [{ fen: startFen, line: [], depth: 0, via: null, parentTotal: 0, parentRank: 0 }];
    let head = 0;
    const visited = new Set([epd(startFen)]);
    let positions = 0;
    let found = 0;
    let deepest = 0;
    let limit: InsightsSummary["limit"] = "";
    let error: string | null = null;
    const started = nowSeconds();
    let lastRequest = -Infinity;
    let sinceYield = 0;

    while (head < queue.length && !control.stopped) {
      if (positions >= params.maxPositions) {
        limit = "position limit";
        break;
      }
      if (nowSeconds() - started > params.maxSeconds) {
        limit = "time limit";
        break;
      }
      const entry = queue[head++];

      let fetched = this.client.cached(entry.fen, params.query);
      if (fetched === null) {
        sinceYield = 0;
        const wait = params.minInterval - (nowSeconds() - lastRequest);
        if (wait > 0 && (await control.wait(wait))) break;
        try {
          fetched = await this.client.explorer(entry.fen, params.query, control.abort.signal);
        } catch (exc) {
          if (control.stopped) break;
          if (exc instanceof LichessAuthError) {
            error = exc.message;
            break;
          }
          if (exc instanceof LichessRateLimited) {
            progress(`Rate limited; waiting ${Math.round(exc.retryAfter)} s…`);
            if (await control.wait(exc.retryAfter)) break;
            queue[--head] = entry; // retry this position next
            continue;
          }
          if (exc instanceof LichessUnavailable) {
            progress(`Skipped a position: ${exc.message}`);
            continue;
          }
          error = exc instanceof Error ? exc.message : String(exc);
          break;
        } finally {
          lastRequest = nowSeconds();
        }
        if (control.stopped) break;
      } else if (++sinceYield >= YIELD_EVERY) {
        sinceYield = 0;
        if (await control.wait(0)) break; // let the UI breathe (and stop() arrive)
      }

      const result: ExplorerResult = fetched;
      positions++;
      deepest = Math.max(deepest, entry.depth);
      progress(`Analysing… ${positions} positions, ${deepest} plies deep`);

      const via = entry.via;
      if (via !== null) {
        // our move led here: judge it by what opponents do next
        const verdict = judgeMove(result, params);
        if (verdict !== null) {
          found++;
          const nm: NotableMove = {
            rootFen,
            prefixMoves,
            line: entry.line.slice(0, -1),
            move: via.uci,
            san: via.san,
            games: via.total,
            positionGames: entry.parentTotal,
            scorePct: round1(100 * verdict.score),
            scoreGames: verdict.games,
            bestReplySan: verdict.bestReply.san,
            bestReplyShare: round1((100 * verdict.bestReply.total) / verdict.games),
            bestReplyPct: round1(100 * verdict.bestReplyScore),
            challengePp: round1(100 * verdict.challenge),
            popularityRank: entry.parentRank,
          };
          if (!control.stopped) cb.onResult?.(runId, nm);
        }
      }

      if (!result.moves.length || entry.depth >= params.maxDepth) continue;
      const byGames = [...result.moves].sort((a, b) => b.total - a.total); // stable
      const ours = turnOf(entry.fen) === params.color;
      const candidates = !ours && params.topN > 0 ? byGames.slice(0, params.topN) : byGames;
      const threshold = Math.max(params.minGames, (params.minPct / 100) * result.total);
      candidates.forEach((stats, i) => {
        if (stats.total < threshold) return;
        const child = after(entry.fen, stats.uci);
        if (child === null) return;
        const key = epd(child);
        if (visited.has(key)) return; // a transposition: judged on the path that got there first
        visited.add(key);
        queue.push({
          fen: child,
          line: [...entry.line, stats.uci],
          depth: entry.depth + 1,
          via: ours ? stats : null,
          parentTotal: result.total,
          parentRank: i + 1,
        });
      });
    }

    cb.onFinished?.({
      runId,
      positions,
      found,
      stopped: control.stopped,
      error,
      depth: deepest,
      limit,
    });
  }
}
