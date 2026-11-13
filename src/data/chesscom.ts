/**
 * chess.com published-data client: a player's recent games, as PGN (port of chesscom_api.py).
 *
 * The PubAPI (``api.chess.com/pub``) needs no token and sends ``Access-Control-Allow-Origin: *``.
 * Games live in monthly archives; the archive list is oldest first and each month lists its
 * games oldest first. chess.com answers parallel requests with 429, so a client only ever has
 * one request in flight (later calls wait for earlier ones). No User-Agent header: browsers
 * don't let pages set it.
 */
import type { Color } from "../core/evaluation";

export const API_ROOT = "https://api.chess.com/pub/player";
export const TIME_CLASSES = ["bullet", "blitz", "rapid", "daily"] as const;
export const TIME_CLASS_LABELS: Record<string, string> = {
  bullet: "Bullet",
  blitz: "Blitz",
  rapid: "Rapid",
  daily: "Daily",
};
export const DEFAULT_TIMEOUT = 20.0; // seconds
export const RATE_LIMIT_WAIT = 60.0; // seconds

/** Base class; the message is suitable for showing to the user. */
export class ChessComError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 404: no such player (or no archive for that month). */
export class ChessComNotFound extends ChessComError {}

export class ChessComRateLimited extends ChessComError {
  readonly retryAfter: number;
  constructor(retryAfter: number = RATE_LIMIT_WAIT) {
    super(`chess.com is rate limiting us; wait ${Math.round(retryAfter)} s`);
    this.retryAfter = retryAfter;
  }
}

/** 5xx, network trouble or an unparsable response. */
export class ChessComUnavailable extends ChessComError {}

export interface ChessComGame {
  url: string;
  pgn: string;
  endTime: number; // Unix seconds
  timeClass: string;
  userColor: Color;
  opponent: string;
  opponentRating: number | null;
  result: string; // the user's result code from chess.com: "win", "checkmated", "resigned", …
}

/** A raw game object from the API (snake_case, as chess.com sends it). */
export type RawGame = Record<string, unknown>;

type Side = Record<string, unknown>;

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** A ``ChessComGame`` for a standard-chess game the user played, else null. */
export function parseGame(raw: RawGame, username: string): ChessComGame | null {
  if (raw.rules !== "chess" || !raw.pgn || !raw.url) return null;
  const white: Side = asObject(raw.white);
  const black: Side = asObject(raw.black);
  const name = username.trim().toLowerCase();
  let userColor: Color;
  let me: Side;
  let them: Side;
  if (String(white.username ?? "").toLowerCase() === name) {
    [userColor, me, them] = ["w", white, black];
  } else if (String(black.username ?? "").toLowerCase() === name) {
    [userColor, me, them] = ["b", black, white];
  } else {
    return null;
  }
  const rating = them.rating;
  const end = Math.trunc(Number(raw.end_time || 0));
  return {
    url: String(raw.url),
    pgn: String(raw.pgn),
    endTime: Number.isFinite(end) ? end : 0,
    timeClass: String(raw.time_class || ""),
    userColor,
    opponent: String(them.username || "?"),
    opponentRating: typeof rating === "number" && Number.isInteger(rating) ? rating : null,
    result: String(me.result || ""),
  };
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ChessComClientOptions {
  fetchFn?: FetchFn;
  timeout?: number; // seconds
}

/** Sequential PubAPI calls: one request in flight at a time, per client. */
export class ChessComClient {
  private readonly fetchFn: FetchFn;
  private readonly timeout: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ChessComClientOptions = {}) {
    // Wrapped, not stored bare: calling a detached ``fetch`` throws "Illegal invocation".
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
  }

  /** Monthly archive URLs, oldest first. */
  async archives(username: string): Promise<string[]> {
    const user = encodeURIComponent(username.trim().toLowerCase());
    if (!user) throw new ChessComNotFound("Enter a chess.com username.");
    const data = await this.getJson(`${API_ROOT}/${user}/games/archives`, `player '${username}'`);
    const archives = data.archives;
    if (!Array.isArray(archives)) throw new ChessComUnavailable("chess.com sent an unexpected response");
    return archives.map((a) => String(a));
  }

  async month(archiveUrl: string): Promise<RawGame[]> {
    const data = await this.getJson(archiveUrl, "that month's games");
    const games = data.games;
    return Array.isArray(games)
      ? games.filter((g): g is RawGame => !!g && typeof g === "object" && !Array.isArray(g))
      : [];
  }

  /** The user's most recent standard games in ``timeClasses``, newest first. */
  async fetchRecentGames(
    username: string,
    maxGames: number,
    timeClasses: Iterable<string> = TIME_CLASSES,
    shouldStop: () => boolean = () => false,
  ): Promise<ChessComGame[]> {
    const wanted = new Set(timeClasses);
    const found: ChessComGame[] = [];
    const archives = await this.archives(username);
    for (const archive of [...archives].reverse()) {
      if (found.length >= maxGames || shouldStop()) break;
      const month = (await this.month(archive)).map((raw) => parseGame(raw, username));
      const games = month.filter((g): g is ChessComGame => g !== null && wanted.has(g.timeClass));
      games.sort((a, b) => b.endTime - a.endTime);
      found.push(...games.slice(0, maxGames - found.length));
    }
    return found;
  }

  private getJson(url: string, what: string): Promise<Record<string, unknown>> {
    const next = this.queue.then(
      () => this.request(url, what),
      () => this.request(url, what),
    );
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async request(url: string, what: string): Promise<Record<string, unknown>> {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeout * 1000) : null;
    let response: Response;
    let text: string;
    try {
      try {
        response = await this.fetchFn(url, controller ? { signal: controller.signal } : undefined);
      } catch (err) {
        throw new ChessComUnavailable(`Could not reach chess.com (${reason(err)})`);
      }
      if (response.status === 404 || response.status === 410) {
        throw new ChessComNotFound(`chess.com has no ${what}`);
      }
      if (response.status === 429) throw new ChessComRateLimited(retryAfter(response));
      if (!response.ok) throw new ChessComUnavailable(`chess.com returned HTTP ${response.status}`);
      try {
        text = await response.text();
      } catch (err) {
        throw new ChessComUnavailable(`Could not reach chess.com (${reason(err)})`);
      }
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ChessComUnavailable("chess.com sent an unreadable response");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new ChessComUnavailable("chess.com sent an unexpected response");
    }
    return data as Record<string, unknown>;
  }
}

function reason(err: unknown): string {
  if (err instanceof Error) return err.name === "AbortError" ? "timed out" : err.message;
  return String(err);
}

function retryAfter(response: Response): number {
  // Note: Retry-After is not a CORS-safelisted header, so browsers usually hide it from
  // cross-origin pages and this falls back to RATE_LIMIT_WAIT.
  const header = response.headers?.get("Retry-After");
  if (!header) return RATE_LIMIT_WAIT;
  const value = Number(header);
  return Number.isFinite(value) && header.trim() !== "" ? Math.max(1, value) : RATE_LIMIT_WAIT;
}
