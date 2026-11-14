/**
 * Download a player's games from Lichess (``/api/games/user``, NDJSON) and store them in the game
 * library in the chess.com shape, so everything that reads the library (Review, puzzles, Check my
 * games) works for Lichess games too.
 */
import type { RawGame } from "./chesscom";

/** Library key for a Lichess player (chess.com players are stored under their bare name). */
export const LICHESS_PREFIX = "lichess:";
export const LICHESS_ARCHIVE = "lichess-games";

export function lichessKey(username: string): string {
  return LICHESS_PREFIX + username.trim().toLowerCase();
}

export function isLichessKey(key: string): boolean {
  return key.startsWith(LICHESS_PREFIX);
}

/** The player's name as it appears in the games (the key without its prefix). */
export function playerName(key: string): string {
  return isLichessKey(key) ? key.slice(LICHESS_PREFIX.length) : key;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

const LOSS: Record<string, string> = { mate: "checkmated", resign: "resigned", outoftime: "timeout", timeout: "abandoned" };
const DRAW: Record<string, string> = { stalemate: "stalemate", draw: "agreed" };

/** One Lichess API game as a chess.com-style raw game (null for variants and aborted games). */
export function lichessToRaw(g: Json): RawGame | null {
  if (!g.id || !g.pgn) return null;
  if (g.variant !== "standard" && g.variant !== "fromPosition") return null;
  const status = String(g.status ?? "");
  if (status === "aborted" || status === "noStart") return null;
  const players = obj(g.players);
  const side = (color: "white" | "black") => {
    const p = obj(players[color]);
    const user = obj(p.user);
    let result: string;
    if (g.winner === color) result = "win";
    else if (g.winner) result = LOSS[status] ?? "lose";
    else result = DRAW[status] ?? "agreed";
    return {
      username: String(user.name ?? (p.aiLevel ? `Stockfish level ${p.aiLevel}` : "Anonymous")),
      rating: typeof p.rating === "number" ? p.rating : undefined,
      result,
    };
  };
  const speed = String(g.speed ?? "");
  return {
    url: `https://lichess.org/${g.id}`,
    pgn: String(g.pgn),
    end_time: Math.floor(Number(g.lastMoveAt ?? g.createdAt ?? 0) / 1000),
    time_class: speed === "correspondence" ? "daily" : speed,
    rules: "chess",
    white: side("white"),
    black: side("black"),
  };
}

export interface LichessFetchOptions {
  /** Only games that ended after this (Unix seconds). */
  since?: number;
  token?: string;
  onCount?: (n: number) => void;
  shouldStop?: () => boolean;
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Every game of ``username`` since ``since``, newest first, read as the stream arrives. */
export async function fetchLichessGames(username: string, opts: LichessFetchOptions = {}): Promise<RawGame[]> {
  const params = new URLSearchParams({ pgnInJson: "true", clocks: "false", evals: "false", opening: "true" });
  if (opts.since) params.set("since", String(opts.since * 1000 + 1000));
  const headers: Record<string, string> = { Accept: "application/x-ndjson" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const doFetch = opts.fetchFn ?? ((i: string, init?: RequestInit) => fetch(i, init));
  const res = await doFetch(`https://lichess.org/api/games/user/${encodeURIComponent(username.trim())}?${params}`, { headers });
  if (res.status === 404) throw new Error(`No Lichess player called ${username}.`);
  if (res.status === 429) throw new Error("Lichess asks us to slow down; try again in a minute.");
  if (!res.ok) throw new Error(`Lichess answered ${res.status}.`);
  const out: RawGame[] = [];
  const take = (line: string) => {
    if (!line.trim()) return;
    try {
      const raw = lichessToRaw(JSON.parse(line) as Json);
      if (raw) out.push(raw);
    } catch {
      /* skip a broken line */
    }
  };
  if (!res.body) {
    (await res.text()).split("\n").forEach(take);
    opts.onCount?.(out.length);
    return out;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    if (opts.shouldStop?.()) {
      await reader.cancel();
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    lines.forEach(take);
    opts.onCount?.(out.length);
  }
  take(buffer);
  return out;
}
