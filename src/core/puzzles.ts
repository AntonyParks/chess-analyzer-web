/**
 * Puzzles made from the user's own mistakes: the model, the answer rules and the store
 * (port of puzzles.py).
 *
 * Every score here is a winning chance in [-1, 1] for the side to move (``winChance``), the
 * same scale the review's ``?!``/``?``/``??`` thresholds use.
 *
 * The objects use camelCase; ``PuzzleStore.toJSON``/``fromJSON`` read and write the desktop's
 * snake_case puzzles.json, so the desktop file can be imported and exported unchanged.
 */
import {
  BLUNDER,
  type Color,
  INACCURACY,
  MISTAKE,
  type MoveEval,
  cpPov,
  winChance,
} from "./evaluation";

export const STORE_VERSION = 1;
export const ACCEPT_MARGIN = 0.05; // a move this close to the best one's winning chances also solves a step
export const FORCING_GAP = 0.1; // a later step is only asked when the best move is this far ahead of the rest
export const MAX_STEPS = 4; // user moves per puzzle
export const MARKERS = ["??", "?", "?!"] as const;
export type Marker = (typeof MARKERS)[number];
export const MARKER_LABELS: Record<string, string> = {
  "??": "Blunders ??",
  "?": "Mistakes ?",
  "?!": "Inaccuracies ?!",
};
export const SEVERITY: Record<string, number> = { "??": BLUNDER, "?": MISTAKE, "?!": INACCURACY };
export const MODES = ["all", "unsolved", "failed"] as const;
export type Mode = (typeof MODES)[number];
export const ORDERS: Record<string, string> = {
  newest: "Newest games first",
  easiest: "Easiest first",
  hardest: "Hardest first",
};
export type Order = "newest" | "easiest" | "hardest";
export const MAX_LOOKAHEAD = 12; // moves; the slider's top value, "any depth", is MAX_LOOKAHEAD + 1

export interface PuzzleStep {
  fen: string; // the user to move
  bestUci: string;
  scores: Record<string, number>; // every legal move -> winning chance for the user after it
  replyUci: string | null; // the opponent's answer to the best move (next step follows)
}

export interface Puzzle {
  id: string;
  gameUrl: string;
  endTime: number;
  opponent: string;
  opponentRating: number | null;
  timeClass: string;
  userWhite: boolean;
  ply: number; // index of the user's move in the game (0 = the first move)
  moveNumber: number;
  playedUci: string;
  playedSan: string;
  bestSan: string;
  marker: string;
  winDrop: number; // winning chances lost against the best move, at the scan depth
  scanDepth: number;
  visiblePlies: number; // plies of lookahead after which the best move clearly beats the played one
  steps: PuzzleStep[];
  continuation: string[]; // engine line after the last step
  attempts: number;
  solved: number;
  failed: number;
  lastResult: "solved" | "failed" | null;
}

export function userColor(p: Puzzle): Color {
  return p.userWhite ? "w" : "b";
}

/** ``'12. Nxe5??'`` / ``'12... Nxe5??'`` */
export function puzzleLabel(p: Puzzle): string {
  return `${p.moveNumber}${p.userWhite ? "." : "..."} ${p.playedSan}${p.marker}`;
}

/** The steps that fit in ``lookahead`` moves (null = no limit); at least one. */
export function stepsWithin(p: Puzzle, lookahead: number | null = null): PuzzleStep[] {
  if (lookahead === null) return [...p.steps];
  return p.steps.slice(0, Math.max(1, lookahead));
}

export function visibleMoves(p: Puzzle): number {
  return p.visiblePlies / 2;
}

/** The move is the best one or within ``ACCEPT_MARGIN`` winning chances of it. */
export function isAcceptable(step: Pick<PuzzleStep, "scores">, uci: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(step.scores, uci)) return false;
  return step.scores[uci] >= Math.max(...Object.values(step.scores)) - ACCEPT_MARGIN;
}

/** Is the best move clearly better than every alternative (worth asking as a step)? */
export function shouldContinue(scores: Record<string, number>): boolean {
  const values = Object.values(scores);
  if (values.length < 2) return false; // a forced move is not a question
  const [top, second] = [...values].sort((a, b) => b - a);
  return top - second >= FORCING_GAP;
}

/**
 * Sort key, easiest first. In order of weight:
 * 1. how far ahead you must look before the better move clearly wins (``visiblePlies``);
 * 2. how many moves you have to find (the line as cut by ``lookahead``);
 * 3. how many answers are accepted at the first step (more = easier);
 * 4. how much the mistake cost (a bigger blunder is easier to see).
 */
export function difficulty(p: Puzzle, lookahead: number | null = null): number[] {
  const first = p.steps[0];
  const answers = Object.keys(first.scores).filter((u) => isAcceptable(first, u)).length;
  return [p.visiblePlies, stepsWithin(p, lookahead).length, -answers, -p.winDrop];
}

function compareTuples(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

const newestKey = (p: Puzzle) => [-p.endTime, p.gameUrl, p.ply];

/** ``order``: ``"newest"`` (newest game first), ``"easiest"`` or ``"hardest"``. */
export function sortPuzzles(
  puzzles: Iterable<Puzzle>,
  order: string = "newest",
  lookahead: number | null = null,
): Puzzle[] {
  const newest = [...puzzles].sort((a, b) => compareTuples(newestKey(a), newestKey(b)));
  if (order !== "easiest" && order !== "hardest") return newest;
  // Array.sort is stable, so equally hard puzzles stay newest-first either way (a negated
  // comparator, not .reverse(), keeps ties in order like Python's sorted(reverse=True)).
  const sign = order === "hardest" ? -1 : 1;
  return newest.sort(
    (a, b) => sign * compareTuples(difficulty(a, lookahead), difficulty(b, lookahead)),
  );
}

/** Slider position (1 … MAX_LOOKAHEAD + 1) to a lookahead in moves (null = any depth). */
export function lookaheadValue(slider: number): number | null {
  return slider > MAX_LOOKAHEAD ? null : Math.max(1, slider);
}

export interface PuzzleFilterOptions {
  markers?: Iterable<string>;
  timeClasses?: Iterable<string> | null; // null = every time class
  mode?: string; // "all" | "unsolved" | "failed"
  lookahead?: number | null; // moves; null = any depth
}

export class PuzzleFilter {
  readonly markers: ReadonlySet<string>;
  readonly timeClasses: ReadonlySet<string> | null;
  readonly mode: string;
  readonly lookahead: number | null;

  constructor({ markers = MARKERS, timeClasses = null, mode = "all", lookahead = null }: PuzzleFilterOptions = {}) {
    this.markers = new Set(markers);
    this.timeClasses = timeClasses === null ? null : new Set(timeClasses);
    this.mode = mode;
    this.lookahead = lookahead;
  }

  matches(p: Puzzle, { ignoreMarker = false }: { ignoreMarker?: boolean } = {}): boolean {
    if (!ignoreMarker && !this.markers.has(p.marker)) return false;
    if (this.timeClasses !== null && !this.timeClasses.has(p.timeClass)) return false;
    if (this.mode === "unsolved" && p.lastResult === "solved") return false;
    if (this.mode === "failed" && p.lastResult !== "failed") return false;
    return this.lookahead === null || p.visiblePlies <= 2 * this.lookahead;
  }
}

export function filterMarkers(selected: Iterable<string>): Set<string> {
  return new Set([...selected].filter((m) => (MARKERS as readonly string[]).includes(m)));
}

// ── Desktop JSON (snake_case) ───────────────────────────────────────────────

export interface PuzzleStepJSON {
  fen: string;
  best_uci: string;
  scores: Record<string, number>;
  reply_uci: string | null;
}

export interface PuzzleJSON {
  id: string;
  game_url: string;
  end_time: number;
  opponent: string;
  opponent_rating: number | null;
  time_class: string;
  user_white: boolean;
  ply: number;
  move_number: number;
  played_uci: string;
  played_san: string;
  best_san: string;
  marker: string;
  win_drop: number;
  scan_depth: number;
  visible_plies: number;
  steps: PuzzleStepJSON[];
  continuation: string[];
  attempts: number;
  solved: number;
  failed: number;
  last_result: string | null;
}

export interface PuzzleStoreJSON {
  version: number;
  analysed_games: Record<string, number>;
  puzzles: PuzzleJSON[];
}

export function puzzleToJSON(p: Puzzle): PuzzleJSON {
  return {
    id: p.id,
    game_url: p.gameUrl,
    end_time: p.endTime,
    opponent: p.opponent,
    opponent_rating: p.opponentRating,
    time_class: p.timeClass,
    user_white: p.userWhite,
    ply: p.ply,
    move_number: p.moveNumber,
    played_uci: p.playedUci,
    played_san: p.playedSan,
    best_san: p.bestSan,
    marker: p.marker,
    win_drop: p.winDrop,
    scan_depth: p.scanDepth,
    visible_plies: p.visiblePlies,
    steps: p.steps.map((s) => ({
      fen: s.fen,
      best_uci: s.bestUci,
      scores: { ...s.scores },
      reply_uci: s.replyUci,
    })),
    continuation: [...p.continuation],
    attempts: p.attempts,
    solved: p.solved,
    failed: p.failed,
    last_result: p.lastResult,
  };
}

function need(raw: Record<string, unknown>, key: string, id: unknown): unknown {
  if (!(key in raw)) throw new Error(`puzzle ${JSON.stringify(id)} has no ${key}`);
  return raw[key];
}

/** A puzzle from desktop JSON; throws on a missing field or a puzzle with no steps. */
export function puzzleFromJSON(value: unknown): Puzzle {
  if (!value || typeof value !== "object") throw new Error("puzzle is not an object");
  const raw = value as Record<string, unknown>;
  const id = raw.id;
  const get = (k: string) => need(raw, k, id);
  const stepsRaw = raw.steps;
  const steps: PuzzleStep[] = (Array.isArray(stepsRaw) ? stepsRaw : []).map((s: unknown) => {
    if (!s || typeof s !== "object") throw new Error(`puzzle ${JSON.stringify(id)} has a bad step`);
    const st = s as Record<string, unknown>;
    const scores = need(st, "scores", id);
    if (!scores || typeof scores !== "object") throw new Error(`puzzle ${JSON.stringify(id)} has bad scores`);
    return {
      fen: String(need(st, "fen", id)),
      bestUci: String(need(st, "best_uci", id)),
      scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, Number(v)])),
      replyUci: st.reply_uci == null ? null : String(st.reply_uci),
    };
  });
  if (!steps.length) throw new Error(`puzzle ${JSON.stringify(id)} has no steps`);
  const rating = get("opponent_rating");
  const last = raw.last_result;
  return {
    id: String(get("id")),
    gameUrl: String(get("game_url")),
    endTime: Number(get("end_time")),
    opponent: String(get("opponent")),
    opponentRating: rating == null ? null : Number(rating),
    timeClass: String(get("time_class")),
    userWhite: Boolean(get("user_white")),
    ply: Number(get("ply")),
    moveNumber: Number(get("move_number")),
    playedUci: String(get("played_uci")),
    playedSan: String(get("played_san")),
    bestSan: String(get("best_san")),
    marker: String(get("marker")),
    winDrop: Number(get("win_drop")),
    scanDepth: Number(get("scan_depth")),
    visiblePlies: Number(get("visible_plies")),
    steps,
    continuation: Array.isArray(raw.continuation) ? raw.continuation.map(String) : [],
    attempts: Number(raw.attempts ?? 0),
    solved: Number(raw.solved ?? 0),
    failed: Number(raw.failed ?? 0),
    lastResult: last === "solved" || last === "failed" ? last : null,
  };
}

// ── Store ───────────────────────────────────────────────────────────────────

/** Puzzles and the games already scanned. Storage is the caller's job (toJSON/fromJSON). */
export class PuzzleStore {
  analysedGames = new Map<string, number>(); // game url -> scan depth
  private puzzles = new Map<string, Puzzle>();

  /** From ``toJSON()`` output or a desktop puzzles.json (object or text); throws if corrupt. */
  static fromJSON(data: unknown): PuzzleStore {
    const raw = typeof data === "string" ? (JSON.parse(data) as unknown) : data;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("top-level JSON value is not an object");
    }
    const obj = raw as Record<string, unknown>;
    const games = (obj.analysed_games || {}) as Record<string, unknown>;
    if (typeof games !== "object") throw new Error("analysed_games is not an object");
    const analysed = new Map<string, number>();
    for (const [k, v] of Object.entries(games)) {
      const n = Math.trunc(Number(v));
      if (!Number.isFinite(n)) throw new Error(`bad scan depth for ${k}`);
      analysed.set(String(k), n);
    }
    const list = obj.puzzles || [];
    if (!Array.isArray(list)) throw new Error("puzzles is not a list");
    const store = new PuzzleStore();
    store.analysedGames = analysed;
    for (const p of list.map(puzzleFromJSON)) store.puzzles.set(p.id, p);
    return store;
  }

  toJSON(): PuzzleStoreJSON {
    return {
      version: STORE_VERSION,
      analysed_games: Object.fromEntries(this.analysedGames),
      puzzles: this.all().map(puzzleToJSON),
    };
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  get size(): number {
    return this.puzzles.size;
  }

  get(id: string): Puzzle | undefined {
    return this.puzzles.get(id);
  }

  /** Newest game first, then in move order. */
  all(): Puzzle[] {
    return sortPuzzles(this.puzzles.values(), "newest");
  }

  query(flt: PuzzleFilter, order: string = "newest"): Puzzle[] {
    return sortPuzzles(
      this.all().filter((p) => flt.matches(p)),
      order,
      flt.lookahead,
    );
  }

  /** Puzzles per marker matching everything in the filter except the marker choice. */
  counts(flt: PuzzleFilter): Record<string, number> {
    const counts: Record<string, number> = Object.fromEntries(MARKERS.map((m) => [m, 0]));
    for (const p of this.puzzles.values()) {
      if (p.marker in counts && flt.matches(p, { ignoreMarker: true })) counts[p.marker] += 1;
    }
    return counts;
  }

  isAnalysed(gameUrl: string, depth: number): boolean {
    return (this.analysedGames.get(gameUrl) ?? -1) >= depth;
  }

  // ── Changes ───────────────────────────────────────────────────────────────

  add(puzzle: Puzzle): void {
    const old = this.puzzles.get(puzzle.id);
    if (old) {
      // a rescan keeps the user's history
      puzzle.attempts = old.attempts;
      puzzle.solved = old.solved;
      puzzle.failed = old.failed;
      puzzle.lastResult = old.lastResult;
    }
    this.puzzles.set(puzzle.id, puzzle);
  }

  markAnalysed(gameUrl: string, depth: number): void {
    this.analysedGames.set(gameUrl, Math.max(depth, this.analysedGames.get(gameUrl) ?? 0));
  }

  record(id: string, solved: boolean): void {
    const p = this.puzzles.get(id);
    if (!p) return;
    p.attempts += 1;
    if (solved) p.solved += 1;
    else p.failed += 1;
    p.lastResult = solved ? "solved" : "failed";
  }
}

export function puzzleId(gameUrl: string, ply: number): string {
  return `${gameUrl}#${ply}`;
}

/** Engine evaluations (White-POV ``MoveEval``) to winning chances for ``mover``. */
export function scoresFor(moveEvals: Record<string, MoveEval>, mover: Color): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [uci, e] of Object.entries(moveEvals)) out[uci] = winChance(cpPov(e.cpWhite, mover));
  return out;
}
