import { describe, expect, it } from "vitest";
import { epd } from "../src/core/chess";
import {
  type ExplorerQuery,
  LichessAuthError,
  LichessClient,
  LichessRateLimited,
  LichessUnavailable,
  RATE_LIMIT_WAIT,
  RATING_CHOICES,
  parseExplorer,
  percentages,
} from "../src/data/lichess";

const SAMPLE = {
  white: 1000,
  draws: 200,
  black: 800,
  moves: [
    { uci: "e1h1", san: "O-O", white: 500, draws: 100, black: 300, averageRating: 2000 },
    { uci: "d2d4", san: "d4", white: 400, draws: 80, black: 400, averageRating: 1900 },
    { uci: "zz", san: "Qxh9", white: 1, draws: 0, black: 0 },
  ],
  opening: { eco: "C50", name: "Italian Game" },
};
// Kingside castling is legal here; so is d4.
const FEN = "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
const EMPTY: ExplorerQuery = { speeds: [], ratings: [] };

interface Seen {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(
  respond: () => Response | Promise<Response>,
  seen: Seen[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } });
    return respond();
  }) as typeof fetch;
}

const json = (payload: unknown) => () => new Response(JSON.stringify(payload), { status: 200 });
const status = (code: number, headers: Record<string, string> = {}) => () =>
  new Response("", { status: code, headers });

describe("parseExplorer", () => {
  it("uses SAN and skips garbage", () => {
    const result = parseExplorer(FEN, SAMPLE);
    expect(result.epd).toBe(epd(FEN));
    expect(result.total).toBe(2000);
    expect(result.opening).toBe("C50 · Italian Game");
    expect(result.moves.map((m) => m.san)).toEqual(["O-O", "d4"]);
    expect(result.moves[0].uci).toBe("e1g1"); // not the API's e1h1
    expect(result.moves[0].total).toBe(900);
    expect(result.moves[0].averageRating).toBe(2000);
    expect(result.moves[1].averageRating).toBe(1900);
  });

  it("falls back to a legal UCI when SAN is missing", () => {
    const result = parseExplorer(FEN, { moves: [{ uci: "d2d4", white: 1, draws: 0, black: 0 }] });
    expect(result.moves[0]).toMatchObject({ uci: "d2d4", san: "d4", averageRating: null });
    expect(result.opening).toBe("");
  });
});

describe("LichessClient", () => {
  it("sends the request shape and a bearer header, but no User-Agent", async () => {
    const seen: Seen[] = [];
    const client = new LichessClient(() => " tok ", fakeFetch(json(SAMPLE), seen));
    await client.explorer(FEN, { speeds: ["blitz", "rapid"], ratings: [1600, 2000], moves: 20 });
    const { url, headers } = seen[0];
    expect(headers.Authorization).toBe("Bearer tok");
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("user-agent");
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://explorer.lichess.org/lichess");
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      fen: FEN,
      variant: "standard",
      topGames: "0",
      recentGames: "0",
      moves: "20",
      speeds: "blitz,rapid",
      ratings: "1600,2000",
    });
  });

  it("sends no Authorization header without a token", async () => {
    const seen: Seen[] = [];
    const client = new LichessClient(() => "", fakeFetch(json(SAMPLE), seen));
    await client.explorer(FEN, EMPTY);
    expect(seen[0].headers.Authorization).toBeUndefined();
    expect(new URL(seen[0].url).searchParams.get("moves")).toBe("12");
  });

  it("caches by position and query", async () => {
    const seen: Seen[] = [];
    const client = new LichessClient(() => "t", fakeFetch(json(SAMPLE), seen));
    const q1: ExplorerQuery = { speeds: ["blitz"], ratings: [1600] };
    await client.explorer(FEN, q1);
    expect(client.cached(FEN, q1)).not.toBeNull();
    // Same EPD with different move counters, and an equal but distinct query object.
    await client.explorer(FEN.replace(/ 4 4$/, " 0 9"), { speeds: ["blitz"], ratings: [1600] });
    expect(seen).toHaveLength(1);
    await client.explorer(FEN, { speeds: ["blitz"], ratings: [2000] });
    expect(seen).toHaveLength(2);
    client.clearCache();
    expect(client.cached(FEN, q1)).toBeNull();
  });

  it("evicts the least recently used entry", async () => {
    const seen: Seen[] = [];
    const client = new LichessClient(() => "t", fakeFetch(json(SAMPLE), seen), { cacheSize: 2 });
    const q = (r: number): ExplorerQuery => ({ speeds: [], ratings: [r] });
    await client.explorer(FEN, q(1));
    await client.explorer(FEN, q(2));
    client.cached(FEN, q(1)); // touch 1: 2 is now the oldest
    await client.explorer(FEN, q(3));
    expect(client.cached(FEN, q(1))).not.toBeNull();
    expect(client.cached(FEN, q(2))).toBeNull();
  });

  it.each([
    ["401", status(401), LichessAuthError],
    ["403", status(403), LichessAuthError],
    ["429", status(429), LichessRateLimited],
    ["503", status(503), LichessUnavailable],
    [
      "network",
      () => {
        throw new TypeError("Failed to fetch");
      },
      LichessUnavailable,
    ],
  ])("maps %s to a typed error", async (_name, respond, expected) => {
    const client = new LichessClient(() => "t", fakeFetch(respond));
    await expect(client.explorer(FEN, EMPTY)).rejects.toBeInstanceOf(expected);
  });

  it("honours Retry-After, defaulting to a minute", async () => {
    let client = new LichessClient(() => "t", fakeFetch(status(429, { "Retry-After": "7" })));
    await expect(client.explorer(FEN, EMPTY)).rejects.toMatchObject({ retryAfter: 7 });
    client = new LichessClient(() => "t", fakeFetch(status(429)));
    await expect(client.explorer(FEN, EMPTY)).rejects.toMatchObject({ retryAfter: RATE_LIMIT_WAIT });
    expect(RATE_LIMIT_WAIT).toBe(60);
  });

  it("treats bad JSON as unavailable", async () => {
    const client = new LichessClient(() => "t", fakeFetch(() => new Response("<html>nope</html>")));
    await expect(client.explorer(FEN, EMPTY)).rejects.toBeInstanceOf(LichessUnavailable);
  });

  it("times out as unavailable", async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const client = new LichessClient(() => "t", hang, { timeout: 0.01 });
    await expect(client.explorer(FEN, EMPTY)).rejects.toBeInstanceOf(LichessUnavailable);
  });
});

describe("percentages", () => {
  it("adds up to 100", () => {
    expect(percentages(1, 1, 1)).toEqual([34, 33, 33]);
    expect(percentages(0, 0, 0)).toEqual([0, 0, 0]);
    expect(percentages(333, 333, 334).reduce((a, b) => a + b)).toBe(100);
    expect(percentages(10, 0, 0)).toEqual([100, 0, 0]);
  });

  it("keeps the UI's rating choices", () => {
    expect([...RATING_CHOICES]).toEqual([1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500]);
  });
});
