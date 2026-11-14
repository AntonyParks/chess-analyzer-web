/**
 * The user's chess.com games, downloaded once and kept (port of game_library.py).
 *
 * chess.com files finished games in monthly archives. A month that is over never changes, so it
 * is downloaded once and marked final; a refresh only asks for the archive list, the current
 * month and any month not seen yet. ``fetchUpdates`` never touches the library itself: the
 * caller applies its result with ``apply`` and stores ``toJSON()`` (IndexedDB, elsewhere).
 *
 * ``toJSON()`` has the same shape as the desktop's chesscom_games.json, so files move both ways.
 */
import { type ChessComClient, type ChessComGame, type RawGame, parseGame } from "./chesscom";
import { playerName } from "./lichessGames";

export const LIBRARY_VERSION = 1;
const KEEP_SIDE = ["username", "rating", "result"];
const KEEP_GAME = ["url", "pgn", "end_time", "time_class", "rules"];

/** ``[year, month]`` from an archive URL ending in ``/YYYY/MM``. */
export function archiveMonth(url: string): [number, number] | null {
  const parts = url.replace(/\/+$/, "").split("/");
  if (parts.length < 2) return null;
  const toInt = (s: string) => (/^\s*[+-]?\d+\s*$/.test(s) ? parseInt(s, 10) : null);
  const year = toInt(parts[parts.length - 2]);
  const month = toInt(parts[parts.length - 1]);
  return year === null || month === null ? null : [year, month];
}

/** A month before the current one (UTC) can no longer gain games. */
export function isFinal(url: string, now: Date = new Date()): boolean {
  const m = archiveMonth(url);
  if (m === null) return false;
  const [y, mo] = [now.getUTCFullYear(), now.getUTCMonth() + 1];
  return m[0] < y || (m[0] === y && m[1] < mo);
}

/** Only what ``parseGame`` needs, to keep the stored library small. */
export function slim(raw: RawGame): RawGame {
  const game: RawGame = {};
  for (const k of KEEP_GAME) if (k in raw) game[k] = raw[k];
  for (const side of ["white", "black"]) {
    const v = raw[side];
    const info = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    const kept: Record<string, unknown> = {};
    for (const k of KEEP_SIDE) if (k in info) kept[k] = info[k];
    game[side] = kept;
  }
  return game;
}

/** What a background download found: fresh months and the full archive list. */
export interface ArchiveUpdate {
  username: string;
  archives: string[];
  months: Record<string, RawGame[]>; // archive url -> slimmed games
  complete: boolean; // false: stopped early; the months fetched so far are still good
}

export interface FetchUpdatesOptions {
  shouldStop?: () => boolean;
  onProgress?: (done: number, total: number) => void;
}

/** Download every archive month not already stored as final, newest first. */
export async function fetchUpdates(
  client: Pick<ChessComClient, "archives" | "month">,
  username: string,
  finalMonths: Iterable<string>,
  { shouldStop = () => false, onProgress = () => {} }: FetchUpdatesOptions = {},
): Promise<ArchiveUpdate> {
  const archives = await client.archives(username);
  const known = new Set(finalMonths);
  const todo = [...archives].reverse().filter((url) => !known.has(url));
  const update: ArchiveUpdate = { username, archives, months: {}, complete: true };
  for (let done = 0; done < todo.length; done++) {
    if (shouldStop()) {
      update.complete = false;
      break;
    }
    onProgress(done, todo.length);
    const url = todo[done];
    update.months[url] = (await client.month(url)).map(slim);
  }
  onProgress(Object.keys(update.months).length, todo.length);
  return update;
}

interface ArchiveEntry {
  final: boolean;
  games: RawGame[];
}

interface UserEntry {
  archives: Record<string, ArchiveEntry>;
  refreshed?: number;
  [extra: string]: unknown;
}

export interface LibraryJSON {
  version: number;
  users: Record<string, UserEntry>;
}

/** Downloaded games per chess.com user. Storage is the caller's job (``toJSON``/``fromJSON``). */
export class GameLibrary {
  private users: Record<string, UserEntry> = {};

  /** Rebuild from ``toJSON()`` output or a desktop chesscom_games.json (object or text). */
  static fromJSON(data: unknown): GameLibrary {
    const raw = typeof data === "string" ? (JSON.parse(data) as unknown) : data;
    const users = raw && typeof raw === "object" ? (raw as Record<string, unknown>).users : undefined;
    if (!users || typeof users !== "object" || Array.isArray(users)) {
      throw new Error("Game library is corrupt: no users object");
    }
    const lib = new GameLibrary();
    lib.users = structuredClone(users) as Record<string, UserEntry>;
    return lib;
  }

  toJSON(): LibraryJSON {
    return { version: LIBRARY_VERSION, users: structuredClone(this.users) };
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  finalMonths(username: string): string[] {
    const archives = this.user(username).archives ?? {};
    return Object.entries(archives)
      .filter(([, entry]) => entry?.final)
      .map(([url]) => url);
  }

  /** The user's standard games, newest first (optionally only some time controls). */
  games(username: string, timeClasses?: Iterable<string> | null): ChessComGame[] {
    const wanted = timeClasses != null ? new Set(timeClasses) : null;
    const found: ChessComGame[] = [];
    for (const entry of Object.values(this.user(username).archives ?? {})) {
      for (const raw of entry?.games ?? []) {
        const game = parseGame(raw, playerName(userKey(username)));
        if (game !== null && (wanted === null || wanted.has(game.timeClass))) found.push(game);
      }
    }
    found.sort((a, b) => b.endTime - a.endTime);
    return found;
  }

  /** Unix time of the last completed refresh (0 = never). */
  lastRefresh(username: string): number {
    return Math.trunc(Number(this.user(username).refreshed ?? 0)) || 0;
  }

  /** Every user with downloaded games, most games first. */
  usernames(): string[] {
    const count = (u: Partial<UserEntry>) => Object.values(u.archives ?? {}).reduce((n, e) => n + (e?.games?.length ?? 0), 0);
    return Object.keys(this.users)
      .filter((k) => this.hasUser(k))
      .sort((a, b) => count(this.users[b]) - count(this.users[a]));
  }

  /** End time (Unix seconds) of the user's newest stored game; 0 if none. */
  newestEnd(username: string): number {
    let best = 0;
    for (const entry of Object.values(this.user(username).archives ?? {}))
      for (const raw of entry?.games ?? []) best = Math.max(best, Math.trunc(Number(raw.end_time) || 0));
    return best;
  }

  hasUser(username: string): boolean {
    return Object.keys(this.user(username).archives ?? {}).length > 0;
  }

  // ── Changes ───────────────────────────────────────────────────────────────

  /** Store downloaded months; returns how many games are new to the library. */
  apply(update: ArchiveUpdate, now: Date = new Date()): number {
    const key = userKey(update.username);
    const user = (this.users[key] ??= { archives: {} });
    const archives = (user.archives ??= {});
    const urls = () =>
      new Set(Object.values(archives).flatMap((e) => (e?.games ?? []).map((g) => g.url)));
    const before = urls();
    for (const [url, games] of Object.entries(update.months)) {
      archives[url] = { final: isFinal(url, now), games };
    }
    const after = urls();
    if (update.complete) user.refreshed = Math.floor(now.getTime() / 1000);
    let fresh = 0;
    for (const u of after) if (!before.has(u)) fresh++;
    return fresh;
  }

  /**
   * Merge games into one archive of the user (by URL; Lichess downloads use this) and mark the
   * refresh. Returns how many games were new.
   */
  addGames(username: string, archive: string, games: RawGame[], now: Date = new Date()): number {
    const user = (this.users[userKey(username)] ??= { archives: {} });
    const archives = (user.archives ??= {});
    const entry = (archives[archive] ??= { final: false, games: [] });
    const known = new Set(entry.games.map((g) => g.url));
    let fresh = 0;
    for (const g of games) {
      if (known.has(g.url)) continue;
      known.add(g.url);
      entry.games.push(g);
      fresh++;
    }
    user.refreshed = Math.floor(now.getTime() / 1000);
    return fresh;
  }

  private user(username: string): Partial<UserEntry> {
    return Object.prototype.hasOwnProperty.call(this.users, userKey(username))
      ? this.users[userKey(username)]
      : {};
  }
}

function userKey(username: string): string {
  return username.trim().toLowerCase();
}
