/**
 * Lichess opening-explorer client (port of lichess_api.py): one place for the URL, auth,
 * errors and caching.
 *
 * The explorer (``explorer.lichess.ovh``) requires an API token and asks clients to wait a
 * minute after a 429. Castling comes back as king-takes-rook UCI (``e1h1``), so moves are
 * parsed from SAN. Positions are FEN strings; moves are UCI strings in chess.js's notation
 * (castling as king-two-squares, ``e1g1``).
 *
 * Browsers forbid setting User-Agent, so unlike the desktop client none is sent.
 */
import { board, epd, isLegal, moveToUci, playUci } from "../core/chess";

export const EXPLORER_URL = "https://explorer.lichess.ovh/lichess";
export const SPEEDS = ["ultraBullet", "bullet", "blitz", "rapid", "classical", "correspondence"] as const;
export type Speed = (typeof SPEEDS)[number];
export const SPEED_LABELS: Record<Speed, string> = {
  ultraBullet: "Ultra",
  bullet: "Bullet",
  blitz: "Blitz",
  rapid: "Rapid",
  classical: "Classical",
  correspondence: "Corr.",
};
export const RATING_BUCKETS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500] as const;
export const RATING_CHOICES = [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500] as const; // offered in the UI
export const DEFAULT_TIMEOUT = 15; // seconds
export const RATE_LIMIT_WAIT = 60; // seconds

// ── Errors ───────────────────────────────────────────────────────────────────

/** Base class; the message is suitable for showing to the user. */
export class LichessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 401/403: the token is missing, invalid or lacks permission. */
export class LichessAuthError extends LichessError {}

export class LichessRateLimited extends LichessError {
  readonly retryAfter: number; // seconds
  constructor(retryAfter: number = RATE_LIMIT_WAIT) {
    super(`Lichess is rate limiting us; wait ${Math.round(retryAfter)} s`);
    this.retryAfter = retryAfter;
  }
}

/** 5xx, network trouble or an unparsable response. */
export class LichessUnavailable extends LichessError {}

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExplorerQuery {
  readonly speeds: readonly string[];
  readonly ratings: readonly number[];
  readonly moves?: number; // how many moves the server should return (its default is 12)
}

export function queryParams(query: ExplorerQuery): [string, string][] {
  const params: [string, string][] = [
    ["variant", "standard"],
    ["topGames", "0"],
    ["recentGames", "0"],
    ["moves", String(query.moves ?? 12)],
  ];
  if (query.speeds.length) params.push(["speeds", query.speeds.join(",")]);
  if (query.ratings.length) params.push(["ratings", query.ratings.join(",")]);
  return params;
}

/** A stable cache key for a query (the Python used the frozen dataclass itself). */
export function queryKey(query: ExplorerQuery): string {
  return JSON.stringify([query.speeds, query.ratings, query.moves ?? 12]);
}

export interface MoveStats {
  readonly uci: string; // chess.js notation: castling is e1g1, not the API's e1h1
  readonly san: string;
  readonly white: number;
  readonly draws: number;
  readonly black: number;
  readonly averageRating: number | null;
  readonly total: number;
}

export interface ExplorerResult {
  readonly epd: string;
  readonly white: number;
  readonly draws: number;
  readonly black: number;
  readonly moves: readonly MoveStats[]; // as returned: most played first
  readonly openingEco: string;
  readonly openingName: string;
  readonly total: number;
  readonly opening: string; // "C50 · Italian Game", or whichever part is known
}

export function makeMoveStats(
  uci: string,
  san: string,
  white: number,
  draws: number,
  black: number,
  averageRating: number | null = null,
): MoveStats {
  return { uci, san, white, draws, black, averageRating, total: white + draws + black };
}

export function makeExplorerResult(
  epdKey: string,
  white: number,
  draws: number,
  black: number,
  moves: readonly MoveStats[],
  openingEco = "",
  openingName = "",
): ExplorerResult {
  const opening = openingEco && openingName ? `${openingEco} · ${openingName}` : openingName || openingEco;
  return {
    epd: epdKey,
    white,
    draws,
    black,
    moves,
    openingEco,
    openingName,
    total: white + draws + black,
    opening,
  };
}

// ── Parsing ──────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

const int = (v: unknown): number => {
  const n = Math.trunc(Number(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

/** Turn the explorer JSON for the position ``fen`` into typed stats (SAN-based moves). */
export function parseExplorer(fen: string, data: Json): ExplorerResult {
  const moves: MoveStats[] = [];
  const raws = Array.isArray(data.moves) ? (data.moves as unknown[]) : [];
  for (const item of raws) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Json;
    const parsed = parseMove(fen, raw);
    if (parsed === null) continue; // unparsable explorer move: skipped
    const avg = raw.averageRating;
    moves.push(
      makeMoveStats(
        parsed.uci,
        typeof raw.san === "string" && raw.san ? raw.san : parsed.san,
        int(raw.white),
        int(raw.draws),
        int(raw.black),
        typeof avg === "number" ? avg : null,
      ),
    );
  }
  const opening = (data.opening && typeof data.opening === "object" ? data.opening : {}) as Json;
  return makeExplorerResult(
    epd(fen),
    int(data.white),
    int(data.draws),
    int(data.black),
    moves,
    String(opening.eco || ""),
    String(opening.name || ""),
  );
}

function parseMove(fen: string, raw: Json): { uci: string; san: string } | null {
  const san = raw.san;
  if (typeof san === "string" && san) {
    try {
      const m = board(fen).move(san);
      if (m) return { uci: moveToUci(m), san: m.san };
    } catch {
      // fall through to UCI
    }
  }
  const uci = raw.uci;
  if (typeof uci === "string" && uci && isLegal(fen, uci)) {
    const m = playUci(board(fen), uci);
    return m ? { uci, san: m.san } : null;
  }
  return null;
}

// ── Client ───────────────────────────────────────────────────────────────────

export interface LichessClientOptions {
  timeout?: number; // seconds
  cacheSize?: number;
}

/** Explorer lookups with an LRU cache keyed by position (EPD) and query. */
export class LichessClient {
  private readonly tokenProvider: () => string;
  private readonly fetchFn: typeof fetch;
  private readonly timeout: number;
  private readonly cacheSize: number;
  private readonly cache = new Map<string, ExplorerResult>();

  constructor(
    tokenProvider: () => string,
    // Wrapped so a bare ``fetch`` is never called with the client as ``this`` (Illegal invocation).
    fetchFn: typeof fetch = (input, init) => fetch(input, init),
    options: LichessClientOptions = {},
  ) {
    this.tokenProvider = tokenProvider;
    this.fetchFn = fetchFn;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.cacheSize = options.cacheSize ?? 512;
  }

  private static key(fen: string, query: ExplorerQuery): string {
    return `${epd(fen)}|${queryKey(query)}`;
  }

  /** A cached result for this position and query, without touching the network. */
  cached(fen: string, query: ExplorerQuery): ExplorerResult | null {
    const key = LichessClient.key(fen, query);
    const result = this.cache.get(key);
    if (result === undefined) return null;
    this.cache.delete(key); // move to the most-recent end
    this.cache.set(key, result);
    return result;
  }

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Fetch (or return cached) explorer stats. Rejects with a ``LichessError`` subclass; an
   * aborted ``signal`` rejects with its reason (an AbortError), not a LichessError.
   */
  async explorer(fen: string, query: ExplorerQuery, signal?: AbortSignal): Promise<ExplorerResult> {
    const hit = this.cached(fen, query);
    if (hit !== null) return hit;
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = (this.tokenProvider() || "").trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const url = `${EXPLORER_URL}?${new URLSearchParams([["fen", fen], ...queryParams(query)])}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timed out")), this.timeout * 1000);
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    let data: unknown;
    try {
      let response: Response;
      try {
        response = await this.fetchFn(url, { headers, signal: controller.signal });
      } catch (exc) {
        if (signal?.aborted) throw exc;
        throw new LichessUnavailable(`Could not reach Lichess (${errorText(exc)})`);
      }
      if (response.status === 401 || response.status === 403) {
        throw new LichessAuthError("Lichess rejected the request: enter a valid API token.");
      }
      if (response.status === 429) throw new LichessRateLimited(retryAfter(response.headers));
      if (!response.ok) throw new LichessUnavailable(`Lichess returned HTTP ${response.status}`);
      let text: string;
      try {
        text = await response.text();
      } catch (exc) {
        if (signal?.aborted) throw exc;
        throw new LichessUnavailable(`Could not reach Lichess (${errorText(exc)})`);
      }
      try {
        data = JSON.parse(text);
      } catch {
        throw new LichessUnavailable("Lichess sent an unreadable response");
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new LichessUnavailable("Lichess sent an unexpected response");
    }
    const result = parseExplorer(fen, data as Json);
    this.cache.set(LichessClient.key(fen, query), result);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return result;
  }
}

function errorText(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** Retry-After in seconds (at least 1), or the default wait. Cross-origin, Lichess must expose
 * the header for the browser to see it; when it doesn't, the default applies. */
function retryAfter(headers: Headers | undefined): number {
  const header = headers?.get("Retry-After");
  if (!header) return RATE_LIMIT_WAIT;
  const value = Number(header);
  return Number.isFinite(value) ? Math.max(1, value) : RATE_LIMIT_WAIT;
}

/** Integer percentages that add up to 100 (largest remainder), or zeros. */
export function percentages(white: number, draws: number, black: number): [number, number, number] {
  const total = white + draws + black;
  if (total <= 0) return [0, 0, 0];
  const exact = [(white * 100) / total, (draws * 100) / total, (black * 100) / total];
  const floors = exact.map((v) => Math.floor(v));
  const remainder = 100 - floors.reduce((a, b) => a + b, 0);
  const order = [0, 1, 2].sort((i, j) => exact[j] - floors[j] - (exact[i] - floors[i])); // stable
  for (const i of order.slice(0, remainder)) floors[i] += 1;
  return [floors[0], floors[1], floors[2]];
}
