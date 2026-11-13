import { describe, expect, it } from "vitest";
import {
  ChessComClient,
  ChessComNotFound,
  ChessComRateLimited,
  ChessComUnavailable,
  type FetchFn,
  type RawGame,
  parseGame,
} from "../src/data/chesscom";

const PGN = '[Event "Live Chess"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0\n';
const ARCHIVES = [9, 10, 11].map((m) => `https://api.chess.com/pub/player/me/games/2026/${String(m).padStart(2, "0")}`);
const ARCHIVE_LIST = "https://api.chess.com/pub/player/me/games/archives";

function game(
  url: string,
  end: number,
  { timeClass = "blitz", white = "Me", black = "Opp", rules = "chess", rating = 1500 } = {},
): RawGame {
  return {
    url,
    pgn: PGN,
    end_time: end,
    time_class: timeClass,
    rules,
    white: { username: white, rating, result: "win" },
    black: { username: black, rating, result: "checkmated" },
  };
}

const MONTHS: Record<string, RawGame[]> = {
  [ARCHIVES[0]]: [game("g1", 100), game("g2", 200)],
  [ARCHIVES[1]]: [game("g3", 300, { timeClass: "rapid" }), game("g4", 400, { white: "Opp", black: "me" })],
  // Oldest first within the month, like the real API; one variant game, one bullet.
  [ARCHIVES[2]]: [
    game("g5", 500),
    game("g6", 600, { rules: "chess960" }),
    game("g7", 700, { timeClass: "bullet" }),
    game("g8", 800),
  ],
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function makeFetch(seen: string[], errors: Record<string, () => Response | Promise<never>> = {}): FetchFn {
  return async (url) => {
    seen.push(url);
    if (url in errors) return errors[url]();
    if (url.endsWith("/games/archives")) return json({ archives: ARCHIVES });
    return json({ games: MONTHS[url] });
  };
}

describe("ChessComClient", () => {
  it("returns recent games newest first, with filters", async () => {
    const seen: string[] = [];
    const client = new ChessComClient({ fetchFn: makeFetch(seen) });
    const games = await client.fetchRecentGames("Me", 3, ["blitz", "rapid"]);
    expect(games.map((g) => g.url)).toEqual(["g8", "g5", "g4"]);
    expect(games[0].userColor).toBe("w");
    expect(games[0].opponent).toBe("Opp");
    expect(games[2].userColor).toBe("b"); // case-insensitive username match
    expect(games[0].opponentRating).toBe(1500);
    expect(games[0].result).toBe("win");
    // Stops walking archives once it has enough games: the oldest month is never fetched.
    expect(seen).not.toContain(ARCHIVES[0]);
    expect(seen[0]).toBe(ARCHIVE_LIST);
  });

  it("takes everything when there are fewer games than asked for", async () => {
    const client = new ChessComClient({ fetchFn: makeFetch([]) });
    const games = await client.fetchRecentGames("me", 50);
    expect(games.map((g) => g.url)).toEqual(["g8", "g7", "g5", "g4", "g3", "g2", "g1"]);
  });

  it("sends no User-Agent header (browsers forbid it)", async () => {
    const inits: (RequestInit | undefined)[] = [];
    const client = new ChessComClient({
      fetchFn: async (_url, init) => {
        inits.push(init);
        return json({ archives: [] });
      },
    });
    await client.fetchRecentGames("me", 5);
    const headers = new Headers(inits[0]?.headers);
    expect(headers.has("User-Agent")).toBe(false);
  });

  it("never has two requests in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const client = new ChessComClient({
      fetchFn: async (url) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return url.endsWith("/archives") ? json({ archives: ARCHIVES }) : json({ games: MONTHS[url] });
      },
    });
    await Promise.all([
      client.archives("me"),
      client.month(ARCHIVES[0]),
      client.month(ARCHIVES[1]),
      client.fetchRecentGames("me", 50),
    ]);
    expect(maxInFlight).toBe(1);
  });

  it.each([
    ["404", () => json({}, 404), ChessComNotFound],
    ["429", () => json({}, 429, { "Retry-After": "7" }), ChessComRateLimited],
    ["503", () => json({}, 503), ChessComUnavailable],
    ["offline", () => Promise.reject(new TypeError("offline")), ChessComUnavailable],
    ["bad json", () => new Response("{not json", { status: 200 }), ChessComUnavailable],
  ] as const)("maps %s to the right error", async (_name, error, expected) => {
    const client = new ChessComClient({ fetchFn: makeFetch([], { [ARCHIVE_LIST]: error }) });
    const err = await client.fetchRecentGames("me", 5).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(expected);
    if (expected === ChessComRateLimited) expect((err as ChessComRateLimited).retryAfter).toBe(7);
  });

  it("a failed request does not block the next one", async () => {
    let first = true;
    const client = new ChessComClient({
      fetchFn: async () => {
        if (first) {
          first = false;
          return json({}, 503);
        }
        return json({ archives: ARCHIVES });
      },
    });
    await expect(client.archives("me")).rejects.toBeInstanceOf(ChessComUnavailable);
    await expect(client.archives("me")).resolves.toEqual(ARCHIVES);
  });

  it("rejects an empty username", async () => {
    await expect(new ChessComClient({ fetchFn: makeFetch([]) }).archives("  ")).rejects.toBeInstanceOf(
      ChessComNotFound,
    );
  });
});

describe("parseGame", () => {
  it("skips other players' games and variants", () => {
    expect(parseGame(game("x", 1, { white: "A", black: "B" }), "me")).toBeNull();
    expect(parseGame(game("x", 1, { rules: "crazyhouse" }), "me")).toBeNull();
    expect(parseGame(game("x", 1), "ME")?.userColor).toBe("w");
  });
});
