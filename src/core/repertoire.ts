/**
 * Opening repertoire: the moves the user plays and the replies they prepare, and drills
 * (port of repertoire.py).
 *
 * A repertoire is a graph keyed by position (EPD, which ignores the move counters), so two
 * move orders that reach the same position share one node: transpositions need no special
 * handling. From the user's own positions it holds exactly one move; from the opponent's it
 * holds any number of prepared replies.
 *
 * Each of the user's positions is a review card on a simple spaced-repetition schedule
 * (SM-2-like). Training walks from the start position, choosing the opponent's replies at
 * random weighted by how often they are played (Lichess explorer counts stored per position),
 * and steers toward the positions that are due.
 *
 * Moves are UCI strings, boards are FEN strings, times are unix seconds.
 */
import { ROOT_EPD, START_FEN, afterEpd, board, epd as epdOf, fenFromEpd as fenOf, legalUcis, playUci } from "./chess";
import type { Color } from "./evaluation";

export { ROOT_EPD };
export const STORE_VERSION = 1;
export const DAY = 86_400.0;
export const START_EASE = 2.5;
export const MIN_EASE = 1.3;
export const DEFAULT_COVERAGE = 50; // flag replies reached in at least 1 game in this many

/** A source of uniform random numbers in [0, 1). */
export type Rng = () => number;

const nowSeconds = (): number => Date.now() / 1000;

/** Python's round(x, 2): correctly rounded, ties to even. */
function round2(x: number): number {
  const s = x * 100;
  // An exact tie (x = k + n/8 with n odd-ish, e.g. 0.125) has few fraction bits, so s is exact.
  if (Number.isInteger(x * 8) && s - Math.floor(s) === 0.5) {
    const f = Math.floor(s);
    return (f % 2 === 0 ? f : f + 1) / 100;
  }
  return Number(x.toFixed(2));
}

/** Lichess explorer counts for one position (kept so gaps and weights work offline). */
export class PositionStats {
  constructor(
    public total: number,
    public moves: Map<string, [san: string, games: number]> = new Map(),
  ) {}

  games(uci: string): number {
    const entry = this.moves.get(uci);
    return entry ? entry[1] : 0;
  }
}

/** Review state of one of the user's positions. */
export class Card {
  constructor(
    public interval = 0.0, // days
    public ease = START_EASE,
    public due = 0.0, // unix time; 0 = new
    public reps = 0,
    public lapses = 0,
    public learned = false, // false: shown once with the answer before it is asked
  ) {}

  isDue(now: number): boolean {
    return this.due <= now;
  }
}

/** A position the repertoire does not answer, ranked by how likely it is to come up. */
export interface Gap {
  readonly epd: string;
  readonly path: readonly string[]; // UCI moves from the start to ``epd``
  readonly uci: string | null; // the opponent's unprepared move; null: the user has no move here
  readonly san: string;
  readonly chance: number; // probability of reaching it, following the explorer counts
}

/** A different move at one of the user's positions that joins another of their lines. */
export interface MergeCandidate {
  readonly epd: string; // the user's position
  readonly path: readonly string[]; // UCI moves from the start to ``epd``
  readonly current: string; // the repertoire move there now (UCI)
  readonly currentSan: string;
  readonly uci: string; // the move that joins
  readonly san: string;
  readonly joins: readonly string[]; // the other line's path to the position it reaches
  readonly saved: number; // moves the swap removes from the repertoire
}

/** Where one game left the repertoire. */
export interface Deviation {
  readonly gameUrl: string;
  readonly ply: number;
  readonly epd: string;
  readonly path: readonly string[]; // UCI moves of the game up to the deviation
  readonly byUser: boolean;
  readonly playedSan: string;
  readonly expectedSan: string; // the repertoire move (user) or "" (opponent / unprepared)
}

export interface RepertoireJSON {
  nodes: Record<string, Record<string, string>>;
  stats: Record<string, [number, Record<string, [string, number]>]>;
  cards: Record<string, [number, number, number, number, number, boolean]>;
}

export interface StoreJSON {
  version: number;
  white: RepertoireJSON;
  black: RepertoireJSON;
}

/** SAN of ``uci`` at ``fen``; throws if the move is illegal (python-chess raises too). */
function sanAt(fen: string, uci: string): string {
  const m = playUci(board(fen), uci);
  if (!m) throw new Error(`Illegal move ${uci} in ${fen}`);
  return m.san;
}

/** Play the UCI moves from ``fen`` and return the FEN before each move plus the final one. */
function walk(fen: string, ucis: readonly string[]): { fens: string[]; sans: string[] } {
  const g = board(fen);
  const fens: string[] = [];
  const sans: string[] = [];
  for (const uci of ucis) {
    fens.push(g.fen());
    const m = playUci(g, uci);
    if (!m) throw new Error(`Illegal move ${uci} in ${g.fen()}`);
    sans.push(m.san);
  }
  fens.push(g.fen());
  return { fens, sans };
}

export class Repertoire {
  nodes = new Map<string, Map<string, string>>(); // epd -> uci -> san
  stats = new Map<string, PositionStats>();
  cards = new Map<string, Card>();
  private reach: Map<string, [string, string] | null> | null = null; // epd -> (parent, uci)

  constructor(readonly color: Color) {}

  // ── Positions ───────────────────────────────────────────────────────────────

  userToMove(epd: string): boolean {
    return (epd.split(" ")[1] === "w") === (this.color === "w");
  }

  movesAt(epd: string): Map<string, string> {
    return new Map(this.nodes.get(epd) ?? []);
  }

  /** The user's repertoire move (UCI) at one of their positions. */
  userMove(epd: string): string | null {
    const moves = this.nodes.get(epd);
    if (!moves || moves.size === 0 || !this.userToMove(epd)) return null;
    return moves.keys().next().value as string;
  }

  /** Every position reachable from the start through repertoire moves (BFS parents). */
  private reachable(): Map<string, [string, string] | null> {
    if (this.reach === null) {
      const parents = new Map<string, [string, string] | null>([[ROOT_EPD, null]]);
      const queue = [ROOT_EPD];
      for (let i = 0; i < queue.length; i++) {
        const epd = queue[i];
        const moves = this.nodes.get(epd);
        if (!moves || moves.size === 0) continue;
        for (const uci of moves.keys()) {
          const after = afterEpd(epd, uci);
          if (after !== null && !parents.has(after)) {
            parents.set(after, [epd, uci]);
            queue.push(after);
          }
        }
      }
      this.reach = parents;
    }
    return this.reach;
  }

  contains(epd: string): boolean {
    return this.reachable().has(epd);
  }

  /** The shortest UCI move list from the start to ``epd`` (null: not in the repertoire). */
  pathTo(epd: string): string[] | null {
    const parents = this.reachable();
    if (!parents.has(epd)) return null;
    const path: string[] = [];
    let cur = epd;
    let parent = parents.get(cur);
    while (parent) {
      path.push(parent[1]);
      cur = parent[0];
      parent = parents.get(cur);
    }
    return path.reverse();
  }

  /** If ``uci`` played at ``fen`` reaches a repertoire position by a path the repertoire
   * does not use here, the repertoire's own path to that position; else null. */
  transposition(fen: string, uci: string): string[] | null {
    if (this.nodes.size === 0 || this.nodes.get(epdOf(fen))?.has(uci)) return null;
    const target = afterEpd(epdOf(fen), uci);
    if (target === null) throw new Error(`Illegal move ${uci} in ${fen}`);
    if (target === ROOT_EPD) return null;
    return this.pathTo(target);
  }

  size(): number {
    const reach = this.reachable();
    let n = 0;
    for (const [e, m] of this.nodes) if (reach.has(e)) n += m.size;
    return n;
  }

  // ── Changes ─────────────────────────────────────────────────────────────────

  /** ``[existingSan, newSan]`` if the line plays a different move at one of the user's
   * positions than the repertoire does. */
  conflict(startFen: string, ucis: readonly string[]): [string, string] | null {
    const g = board(startFen);
    for (const uci of ucis) {
      const epd = epdOf(g.fen());
      const current = this.userMove(epd);
      if (current !== null && current !== uci) {
        return [this.nodes.get(epd)!.get(current)!, sanAt(g.fen(), uci)];
      }
      if (!playUci(g, uci)) throw new Error(`Illegal move ${uci} in ${g.fen()}`);
    }
    return null;
  }

  /** Add every move of the line (it must start from the initial position). Returns the
   * number of moves new to the repertoire. Without ``replace`` a different move at one of
   * the user's positions throws. */
  addLine(startFen: string, ucis: readonly string[], opts: { replace?: boolean } = {}): number {
    if (epdOf(startFen) !== ROOT_EPD) {
      throw new Error("A repertoire line must start from the initial position.");
    }
    const { fens, sans } = walk(startFen, ucis); // validates the whole line first
    if (!opts.replace && this.conflict(startFen, ucis) !== null) {
      throw new Error("The line plays a different move where you already have one.");
    }
    let added = 0;
    ucis.forEach((uci, i) => {
      const epd = epdOf(fens[i]);
      let node = this.nodes.get(epd);
      if (!node) {
        node = new Map();
        this.nodes.set(epd, node);
      }
      if (this.userToMove(epd) && !node.has(uci)) node.clear(); // one move per user position
      if (!node.has(uci)) {
        node.set(uci, sans[i]);
        added += 1;
      }
    });
    this.changed();
    return added;
  }

  /** Remove one move; positions no longer reachable go with it. */
  remove(epd: string, uci: string): void {
    const node = this.nodes.get(epd);
    if (!node || !node.has(uci)) return;
    node.delete(uci);
    if (node.size === 0) this.nodes.delete(epd);
    this.changed();
  }

  /** Store explorer counts for a position: ``[uci, san, games]`` per move. */
  recordStats(epd: string, total: number, moves: Iterable<readonly [string, string, number]>): void {
    const m = new Map<string, [string, number]>();
    for (const [u, s, g] of moves) m.set(u, [s, g]);
    this.stats.set(epd, new PositionStats(total, m));
  }

  private changed(): void {
    this.reach = null;
    let reach = this.reachable();
    for (const e of [...this.nodes.keys()]) if (!reach.has(e)) this.nodes.delete(e);
    this.reach = null;
    reach = this.reachable();
    const wanted = new Set([...this.nodes.keys()].filter((e) => this.userToMove(e) && reach.has(e)));
    for (const e of [...this.cards.keys()]) if (!wanted.has(e)) this.cards.delete(e);
    for (const e of wanted) if (!this.cards.has(e)) this.cards.set(e, new Card());
  }

  // ── Coverage ────────────────────────────────────────────────────────────────

  /** Unanswered positions reached in at least 1 game in ``coverage``, likeliest first.
   *
   * Chances follow the explorer counts at the opponent's positions (a prepared reply without
   * counts keeps the chance it was reached with). A position reached by several move orders
   * keeps its likeliest one. */
  gaps(coverage: number = DEFAULT_COVERAGE): Gap[] {
    if (this.nodes.size === 0) return [];
    const threshold = 1.0 / Math.max(1, coverage);
    const best = new Map<string, number>();
    const found = new Map<string, Gap>(); // key: epd + "|" + uci ("" for null)
    const stack: [string, number, string[]][] = [[ROOT_EPD, 1.0, []]];
    const push = (epd: string, uci: string, chance: number, path: string[]): void => {
      const after = afterEpd(epd, uci);
      if (after !== null) stack.push([after, chance, [...path, uci]]);
    };
    while (stack.length > 0) {
      const [epd, chance, path] = stack.pop()!;
      if (chance < threshold || (best.get(epd) ?? -1.0) >= chance) continue;
      best.set(epd, chance);
      const moves = this.nodes.get(epd) ?? new Map<string, string>();
      if (this.userToMove(epd)) {
        if (moves.size === 0) {
          if (path.length > 0) {
            // the line ends after an opponent move: no answer prepared
            found.set(`${epd}|`, { epd, path, uci: null, san: "", chance });
          }
          continue;
        }
        push(epd, moves.keys().next().value as string, chance, path);
        continue;
      }
      const stats = this.stats.get(epd);
      if (stats !== undefined && stats.total > 0) {
        for (const [uci, [san, games]] of stats.moves) {
          const share = (chance * games) / stats.total;
          if (moves.has(uci)) {
            push(epd, uci, share, path);
          } else if (share >= threshold) {
            const key = `${epd}|${uci}`;
            const prev = found.get(key);
            if (prev === undefined || prev.chance < share) {
              found.set(key, { epd, path, uci, san, chance: share });
            }
          }
        }
        for (const uci of moves.keys()) if (!stats.moves.has(uci)) push(epd, uci, 0.0, path);
      } else {
        for (const uci of moves.keys()) push(epd, uci, chance, path);
      }
    }
    return [...found.values()]
      .filter((g) => g.chance >= threshold)
      // Positions the walk later reached with a prepared answer are not gaps after all.
      .filter((g) => g.uci !== null || !(this.nodes.get(g.epd)?.size ?? 0))
      .sort((a, b) => b.chance - a.chance);
  }

  // ── Merging lines ───────────────────────────────────────────────────────────

  /** Moves the user could play instead of their repertoire move that land straight on a
   * position another of their lines already reaches, so the two lines become one. Only the
   * user's own moves can be swapped (the opponent's are not ours to choose), and a swap is
   * offered only if it removes at least one move and leaves no loop. Most saved first. */
  mergeCandidates(): MergeCandidate[] {
    const reach = this.reachable();
    const before = this.size();
    const out: MergeCandidate[] = [];
    for (const position of reach.keys()) {
      const current = this.userMove(position);
      if (current === null) continue;
      const currentAfter = afterEpd(position, current);
      const fen = fenOf(position);
      for (const uci of legalUcis(fen)) {
        if (uci === current) continue;
        const target = afterEpd(position, uci);
        if (target === null || target === currentAfter || target === ROOT_EPD || !reach.has(target)) continue;
        const trial = this.clone();
        trial.swapUserMove(position, uci);
        if (!trial.contains(target) || trial.leadsTo(target, new Set([position]))) continue;
        const saved = before - trial.size();
        if (saved < 1) continue;
        out.push({
          epd: position,
          path: this.pathTo(position)!,
          current,
          currentSan: this.nodes.get(position)!.get(current)!,
          uci,
          san: sanAt(fen, uci),
          joins: trial.pathTo(target)!,
          saved,
        });
      }
    }
    return out.sort((a, b) => b.saved - a.saved || a.path.length - b.path.length);
  }

  /** Play ``uci`` instead of the current move at one of the user's positions. What only the
   * old move led to goes, and the position's review card starts again (its answer changed). */
  swapUserMove(position: string, uci: string): void {
    if (!this.userToMove(position)) throw new Error("Not one of your positions.");
    const san = sanAt(fenOf(position), uci);
    this.nodes.set(position, new Map([[uci, san]]));
    this.changed();
    if (this.cards.has(position)) this.cards.set(position, new Card());
  }

  private clone(): Repertoire {
    const copy = new Repertoire(this.color);
    for (const [e, m] of this.nodes) copy.nodes.set(e, new Map(m));
    return copy;
  }

  /** Reachable opponent positions with no explorer counts yet (nearest first). */
  missingStats(): string[] {
    return [...this.reachable().keys()].filter((e) => !this.userToMove(e) && !this.stats.has(e));
  }

  // ── Review cards ────────────────────────────────────────────────────────────

  due(now: number = nowSeconds()): string[] {
    return [...this.cards].filter(([, c]) => c.isDue(now)).map(([e]) => e);
  }

  grade(epd: string, correct: boolean, now: number = nowSeconds()): void {
    const card = this.cards.get(epd);
    if (!card) return;
    card.learned = true;
    if (correct) {
      if (card.interval < 1) card.interval = 1.0;
      else if (card.interval < 3) card.interval = 3.0;
      else card.interval = round2(card.interval * card.ease);
      card.reps += 1;
    } else {
      card.lapses += 1;
      card.ease = Math.max(MIN_EASE, round2(card.ease - 0.2));
      card.interval = 0.0;
    }
    card.due = now + card.interval * DAY;
  }

  markLearned(epd: string): void {
    const card = this.cards.get(epd);
    if (card) card.learned = true;
  }

  // ── Training ────────────────────────────────────────────────────────────────

  /** Does a target lie at or below ``epd`` (through repertoire moves)? */
  leadsTo(epd: string, targets: ReadonlySet<string>): boolean {
    if (targets.size === 0) return false;
    const seen = new Set<string>();
    const stack = [epd];
    while (stack.length > 0) {
      const e = stack.pop()!;
      if (seen.has(e)) continue;
      seen.add(e);
      if (targets.has(e)) return true;
      const moves = this.nodes.get(e);
      if (moves && moves.size > 0) {
        for (const uci of moves.keys()) {
          const after = afterEpd(e, uci);
          if (after !== null) stack.push(after);
        }
      }
    }
    return false;
  }

  /** An opponent reply, weighted by explorer games (at least 1 each). With ``targets``, only
   * replies that lead toward one. Same draw as Python's ``rng.choices`` (bisect on cumulative
   * weights), so the same uniform sequence gives the same picks. */
  chooseReply(epd: string, rng: Rng, targets?: ReadonlySet<string>): string | null {
    let replies = [...(this.nodes.get(epd)?.keys() ?? [])];
    if (targets !== undefined) {
      replies = replies.filter((u) => this.leadsTo(afterEpd(epd, u) ?? "", targets));
    }
    if (replies.length === 0) return null;
    const stats = this.stats.get(epd);
    const cum: number[] = [];
    let total = 0;
    for (const u of replies) {
      total += Math.max(1, stats ? stats.games(u) : 0);
      cum.push(total);
    }
    const x = rng() * total;
    let i = 0;
    while (i < cum.length - 1 && cum[i] <= x) i++;
    return replies[i];
  }

  // ── Your games ──────────────────────────────────────────────────────────────

  /** The first move where a game left the repertoire, or null if it never did (or the
   * repertoire is empty). */
  checkGame(url: string, startFen: string, ucis: readonly string[]): Deviation | null {
    if (this.nodes.size === 0) return null;
    const g = board(startFen);
    const path: string[] = [];
    for (let ply = 0; ply < ucis.length; ply++) {
      const uci = ucis[ply];
      const fen = g.fen();
      const epd = epdOf(fen);
      const prepared = this.nodes.get(epd) ?? new Map<string, string>();
      if (this.userToMove(epd)) {
        const expected = this.userMove(epd);
        if (expected !== uci) {
          return {
            gameUrl: url,
            ply,
            epd,
            path: [...path],
            byUser: true,
            playedSan: sanAt(fen, uci),
            expectedSan: expected ? (prepared.get(expected) ?? "") : "",
          };
        }
      } else if (!prepared.has(uci)) {
        if (prepared.size === 0) return null; // the game ran past the end of the repertoire
        return {
          gameUrl: url,
          ply,
          epd,
          path: [...path],
          byUser: false,
          playedSan: sanAt(fen, uci),
          expectedSan: "",
        };
      }
      path.push(uci);
      if (!playUci(g, uci)) throw new Error(`Illegal move ${uci} in ${fen}`);
    }
    return null;
  }

  // ── Serialisation ───────────────────────────────────────────────────────────

  toJSON(): RepertoireJSON {
    const nodes: RepertoireJSON["nodes"] = {};
    for (const [e, m] of this.nodes) nodes[e] = Object.fromEntries(m);
    const stats: RepertoireJSON["stats"] = {};
    for (const [e, s] of this.stats) {
      const moves: Record<string, [string, number]> = {};
      for (const [u, [san, games]] of s.moves) moves[u] = [san, games];
      stats[e] = [s.total, moves];
    }
    const cards: RepertoireJSON["cards"] = {};
    for (const [e, c] of this.cards) {
      cards[e] = [c.interval, c.ease, c.due, c.reps, c.lapses, c.learned];
    }
    return { nodes, stats, cards };
  }

  /** Read the desktop's per-colour shape; throws on malformed input. */
  static fromJSON(color: Color, raw: unknown): Repertoire {
    const obj = raw ?? {};
    if (!isRecord(obj)) throw new Error("repertoire is not an object");
    const rep = new Repertoire(color);
    for (const [e, m] of Object.entries(asRecord(obj.nodes, "nodes"))) {
      const node = new Map<string, string>();
      for (const [u, s] of Object.entries(asRecord(m, "node"))) node.set(u, asString(s, "san"));
      rep.nodes.set(e, node);
    }
    for (const [e, v] of Object.entries(asRecord(obj.stats, "stats"))) {
      if (!Array.isArray(v) || v.length !== 2) throw new Error("stats entry is not [total, moves]");
      const moves = new Map<string, [string, number]>();
      for (const [u, mv] of Object.entries(asRecord(v[1], "stats moves"))) {
        if (!Array.isArray(mv) || mv.length < 2) throw new Error("stats move is not [san, games]");
        moves.set(u, [asString(mv[0], "san"), asInt(mv[1], "games")]);
      }
      rep.stats.set(e, new PositionStats(asInt(v[0], "total"), moves));
    }
    for (const [e, c] of Object.entries(asRecord(obj.cards, "cards"))) {
      if (!Array.isArray(c) || c.length < 6) throw new Error("card is not a 6-element array");
      rep.cards.set(
        e,
        new Card(
          asNumber(c[0], "interval"),
          asNumber(c[1], "ease"),
          asNumber(c[2], "due"),
          asInt(c[3], "reps"),
          asInt(c[4], "lapses"),
          Boolean(c[5]),
        ),
      );
    }
    rep.changed();
    return rep;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Missing / null counts as empty (Python's ``raw.get(key) or {}``). */
function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (!isRecord(v)) throw new Error(`${what} is not an object`);
  return v;
}

function asString(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Error(`${what} is not a string`);
  return v;
}

function asNumber(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what} is not a number`);
  return v;
}

function asInt(v: unknown, what: string): number {
  return Math.trunc(asNumber(v, what));
}

// ── Training session ──────────────────────────────────────────────────────────

/** What the trainer wants next. */
export interface TrainStep {
  kind: "opponent" | "user" | "done" | "end"; // opponent: play ``uci``; user: ask for a move
  uci: string | null;
  learn: boolean; // a new card: show the answer first
}

const trainStep = (kind: TrainStep["kind"], uci: string | null = null, learn = false): TrainStep => ({
  kind,
  uci,
  learn,
});

/** Walks lines toward due cards. The UI keeps the board; this keeps the plan.
 *
 * Usage: ``startLine()`` returns the start FEN, then loop over ``step(fen)``: play
 * ``opponent`` replies, ask the user at ``user`` steps and report with ``answer``. */
export class TrainSession {
  readonly practiseAll: boolean;
  readonly rng: Rng;
  readonly now: number;
  targets: Set<string>;
  retry = new Set<string>();
  asked = 0;
  correct = 0;
  missed = 0;
  lines = 0;
  private retried = false;

  constructor(
    readonly rep: Repertoire,
    opts: { practiseAll?: boolean; rng?: Rng; now?: number } = {},
  ) {
    this.practiseAll = opts.practiseAll ?? false;
    this.rng = opts.rng ?? Math.random;
    this.now = opts.now ?? nowSeconds();
    this.targets = new Set(this.practiseAll ? rep.cards.keys() : rep.due(this.now));
  }

  get remaining(): number {
    return this.targets.size + (this.retried ? 0 : this.retry.size);
  }

  /** A new line from the start (its FEN), or null when nothing is left. */
  startLine(): string | null {
    if (this.targets.size === 0 && this.retry.size > 0 && !this.retried) {
      this.targets = new Set(this.retry);
      this.retry = new Set();
      this.retried = true;
    }
    if (this.targets.size === 0 || !this.rep.leadsTo(ROOT_EPD, this.targets)) return null;
    this.lines += 1;
    return START_FEN;
  }

  step(fen: string): TrainStep {
    const epd = epdOf(fen);
    if (!this.rep.leadsTo(epd, this.targets)) return trainStep("done");
    if (this.rep.userToMove(epd)) {
      const uci = this.rep.userMove(epd);
      if (uci === null) return trainStep("done");
      const card = this.rep.cards.get(epd);
      return trainStep("user", uci, card !== undefined && !card.learned);
    }
    const reply = this.rep.chooseReply(epd, this.rng, this.targets);
    return reply ? trainStep("opponent", reply) : trainStep("done");
  }

  /** Grade the user's answer at ``epd``. Positions that are not targets only count a miss.
   * ``learnedNow``: a new move was shown and played; it is asked at the end. Grades use the
   * current time (as the Python does), not the session's ``now``. */
  answer(epd: string, correct: boolean, opts: { learnedNow?: boolean } = {}): void {
    if (opts.learnedNow) {
      this.rep.markLearned(epd);
      this.targets.delete(epd);
      this.retry.add(epd);
      return;
    }
    this.asked += 1;
    if (correct) this.correct += 1;
    else this.missed += 1;
    if (this.targets.has(epd)) {
      this.targets.delete(epd);
      this.rep.grade(epd, correct, nowSeconds());
    } else if (!correct) {
      this.rep.grade(epd, false, nowSeconds());
    }
    if (!correct) this.retry.add(epd);
  }
}

// ── Store ─────────────────────────────────────────────────────────────────────

/** One named repertoire: its colour, name and moves (with their review cards and counts). */
export interface RepertoireEntry {
  id: string;
  name: string;
  color: Color;
  rep: Repertoire;
}

/** Version 2 file: any number of named repertoires per colour. */
export interface StoreJSONv2 {
  version: 2;
  repertoires: (RepertoireJSON & { id: string; name: string; color: "white" | "black" })[];
}

export const DEFAULT_NAMES: Record<Color, string> = { w: "White repertoire", b: "Black repertoire" };

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Every repertoire the user has, in the order they were made. Reads both the desktop app's
 * single White + Black file (version 1) and the multi-repertoire version 2 written here.
 */
export class RepertoireStore {
  entries: RepertoireEntry[];

  constructor(entries?: RepertoireEntry[]) {
    this.entries = entries ?? [
      { id: newId(), name: DEFAULT_NAMES.w, color: "w", rep: new Repertoire("w") },
      { id: newId(), name: DEFAULT_NAMES.b, color: "b", rep: new Repertoire("b") },
    ];
  }

  find(id: string | null | undefined): RepertoireEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  byColor(color: Color): RepertoireEntry[] {
    return this.entries.filter((e) => e.color === color);
  }

  /** The first repertoire of a colour (created if there is none). */
  get(color: Color): Repertoire {
    return (this.byColor(color)[0] ?? this.create(DEFAULT_NAMES[color], color)).rep;
  }

  create(name: string, color: Color): RepertoireEntry {
    const entry: RepertoireEntry = { id: newId(), name: cleanName(name, color), color, rep: new Repertoire(color) };
    this.entries.push(entry);
    return entry;
  }

  rename(id: string, name: string): void {
    const e = this.find(id);
    if (e) e.name = cleanName(name, e.color);
  }

  /** A copy with its own moves, cards and counts. */
  duplicate(id: string, name?: string): RepertoireEntry | undefined {
    const e = this.find(id);
    if (!e) return undefined;
    const copy: RepertoireEntry = {
      id: newId(),
      name: cleanName(name ?? `${e.name} (copy)`, e.color),
      color: e.color,
      rep: Repertoire.fromJSON(e.color, JSON.parse(JSON.stringify(e.rep.toJSON()))),
    };
    this.entries.splice(this.entries.indexOf(e) + 1, 0, copy);
    return copy;
  }

  remove(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
  }

  /** Put a repertoire's moves back to an earlier state (undo). */
  restore(id: string, json: RepertoireJSON): void {
    const e = this.find(id);
    if (e) e.rep = Repertoire.fromJSON(e.color, json);
  }

  toJSON(): StoreJSONv2 {
    return {
      version: 2,
      repertoires: this.entries.map((e) => ({
        id: e.id,
        name: e.name,
        color: e.color === "w" ? "white" : "black",
        ...e.rep.toJSON(),
      })),
    };
  }

  /** Accepts the parsed object or the JSON text, version 1 or 2. Throws on malformed input. */
  static fromJSON(raw: unknown): RepertoireStore {
    const data = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    if (!isRecord(data)) throw new Error("top-level JSON value is not an object");
    if (Array.isArray(data.repertoires)) {
      const entries = data.repertoires.map((r: unknown): RepertoireEntry => {
        if (!isRecord(r)) throw new Error("repertoire entry is not an object");
        if (r.color !== "white" && r.color !== "black") throw new Error("repertoire colour must be white or black");
        const color: Color = r.color === "white" ? "w" : "b";
        return {
          id: typeof r.id === "string" && r.id ? r.id : newId(),
          name: cleanName(typeof r.name === "string" ? r.name : "", color),
          color,
          rep: Repertoire.fromJSON(color, { nodes: r.nodes, stats: r.stats, cards: r.cards }),
        };
      });
      return new RepertoireStore(entries);
    }
    // Version 1 (the desktop app): one White and one Black repertoire.
    return new RepertoireStore([
      { id: newId(), name: DEFAULT_NAMES.w, color: "w", rep: Repertoire.fromJSON("w", data.white ?? {}) },
      { id: newId(), name: DEFAULT_NAMES.b, color: "b", rep: Repertoire.fromJSON("b", data.black ?? {}) },
    ]);
  }
}

function cleanName(name: string, color: Color): string {
  const t = name.trim().replace(/\s+/g, " ").slice(0, 80);
  return t || DEFAULT_NAMES[color];
}
