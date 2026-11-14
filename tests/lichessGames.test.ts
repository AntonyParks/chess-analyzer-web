import { describe, expect, it } from "vitest";
import { GameLibrary } from "../src/data/gameLibrary";
import { LICHESS_ARCHIVE, fetchLichessGames, lichessKey, lichessToRaw } from "../src/data/lichessGames";

function api(id: string, opts: Record<string, unknown> = {}) {
  return {
    id,
    variant: "standard",
    speed: "blitz",
    status: "resign",
    winner: "white",
    lastMoveAt: 1_700_000_000_000,
    pgn: '[Opening "Italian Game"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 1-0',
    players: { white: { user: { name: "Me" }, rating: 1500 }, black: { user: { name: "Them" }, rating: 1480 } },
    ...opts,
  };
}

describe("Lichess games", () => {
  it("converts an API game to the library's shape", () => {
    const raw = lichessToRaw(api("abc"))!;
    expect(raw.url).toBe("https://lichess.org/abc");
    expect(raw.end_time).toBe(1_700_000_000);
    expect(raw.time_class).toBe("blitz");
    expect(raw.white).toEqual({ username: "Me", rating: 1500, result: "win" });
    expect(raw.black).toEqual({ username: "Them", rating: 1480, result: "resigned" });
  });

  it("marks draws and losses, and skips variants and aborted games", () => {
    const draw = lichessToRaw(api("d", { winner: undefined, status: "stalemate" }))!;
    expect((draw.white as { result: string }).result).toBe("stalemate");
    const mate = lichessToRaw(api("m", { winner: "black", status: "mate" }))!;
    expect((mate.white as { result: string }).result).toBe("checkmated");
    expect(lichessToRaw(api("v", { variant: "chess960" }))).toBeNull();
    expect(lichessToRaw(api("a", { status: "aborted" }))).toBeNull();
    expect(lichessToRaw(api("c", { speed: "correspondence" }))!.time_class).toBe("daily");
  });

  it("reads the NDJSON stream and asks only for newer games", async () => {
    let asked = "";
    const body = [api("one"), api("two", { variant: "atomic" }), api("three")].map((g) => JSON.stringify(g)).join("\n") + "\n";
    const games = await fetchLichessGames("Me", {
      since: 1_700_000_000,
      fetchFn: async (url) => {
        asked = url;
        return new Response(body, { status: 200 });
      },
    });
    expect(games.map((g) => g.url)).toEqual(["https://lichess.org/one", "https://lichess.org/three"]);
    expect(asked).toContain("/api/games/user/Me?");
    expect(asked).toContain("since=1700000001000");
  });

  it("stores games in the library under a Lichess key, merging by URL", () => {
    const lib = GameLibrary.fromJSON({ version: 1, users: {} });
    const key = lichessKey("Me");
    expect(lib.addGames(key, LICHESS_ARCHIVE, [lichessToRaw(api("one"))!])).toBe(1);
    expect(lib.addGames(key, LICHESS_ARCHIVE, [lichessToRaw(api("one"))!, lichessToRaw(api("two", { lastMoveAt: 1_800_000_000_000 }))!])).toBe(1);
    const games = lib.games(key);
    expect(games.map((g) => g.url)).toEqual(["https://lichess.org/two", "https://lichess.org/one"]);
    expect(games[0].userColor).toBe("w");
    expect(games[0].opponent).toBe("Them");
    expect(lib.newestEnd(key)).toBe(1_800_000_000);
    expect(lib.usernames()).toEqual([key]);
    expect(lib.hasUser("Me")).toBe(false); // a chess.com "Me" is someone else
  });
});
