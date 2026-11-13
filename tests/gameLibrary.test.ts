import { describe, expect, it } from "vitest";
import { ChessComClient, type FetchFn, type RawGame } from "../src/data/chesscom";
import { GameLibrary, archiveMonth, fetchUpdates, isFinal } from "../src/data/gameLibrary";

const ROOT = "https://api.chess.com/pub/player/me/games";
const NOW = new Date(Date.UTC(2026, 10, 12)); // 2026-11-12
const PGN = "1. e4 e5 *";

function game(url: string, end: number, timeClass = "blitz", rules = "chess"): RawGame {
  return {
    url,
    pgn: PGN,
    end_time: end,
    time_class: timeClass,
    rules,
    uuid: "dropped",
    white: { username: "Me", rating: 1200, result: "win", "@id": "dropped" },
    black: { username: "opp", rating: 1180, result: "resigned" },
  };
}

class Server {
  seen: string[] = [];
  constructor(public months: Record<string, RawGame[]>) {}
  fetch: FetchFn = async (url) => {
    this.seen.push(url);
    const body = url.endsWith("/archives") ? { archives: Object.keys(this.months) } : { games: this.months[url] };
    return new Response(JSON.stringify(body));
  };
  client(): ChessComClient {
    return new ChessComClient({ fetchFn: this.fetch });
  }
}

/** Save and load again, as the IndexedDB layer would. */
const reload = (lib: GameLibrary) => GameLibrary.fromJSON(JSON.parse(JSON.stringify(lib.toJSON())));

describe("game library", () => {
  it("reads archive months and finality", () => {
    expect(archiveMonth(`${ROOT}/2026/09`)).toEqual([2026, 9]);
    expect(archiveMonth("bad")).toBeNull();
    expect(isFinal(`${ROOT}/2026/10`, NOW)).toBe(true);
    expect(isFinal(`${ROOT}/2026/11`, NOW)).toBe(false);
  });

  it("downloads once, then a refresh fetches only open and new months", async () => {
    const server = new Server({
      [`${ROOT}/2026/09`]: [game("a", 100)],
      [`${ROOT}/2026/10`]: [game("b", 200), game("v", 210, "blitz", "chess960")],
      [`${ROOT}/2026/11`]: [game("c", 300, "daily")],
    });
    const client = server.client();
    const library = new GameLibrary();
    expect(library.hasUser("me")).toBe(false);

    let update = await fetchUpdates(client, "Me", library.finalMonths("Me"));
    expect(library.apply(update, NOW)).toBe(4);
    expect(reload(library).games("ME").map((g) => g.url)).toEqual(["c", "b", "a"]);
    expect(library.games("me", ["blitz"]).map((g) => g.url)).toEqual(["b", "a"]);
    expect(library.lastRefresh("me")).toBe(Math.floor(NOW.getTime() / 1000));
    expect(library.hasUser("me")).toBe(true);

    // A new game this month and a new month: only the open month and the new one are fetched.
    server.months[`${ROOT}/2026/11`].push(game("d", 400));
    server.months[`${ROOT}/2026/12`] = [game("e", 500)];
    server.seen = [];
    update = await fetchUpdates(client, "me", library.finalMonths("me"));
    expect(server.seen).toEqual([`${ROOT}/archives`, `${ROOT}/2026/12`, `${ROOT}/2026/11`]);
    expect(library.apply(update, NOW)).toBe(2);
    expect(library.games("me").map((g) => g.url)).toEqual(["e", "d", "c", "b", "a"]);
  });

  it("stores slimmed games", async () => {
    const server = new Server({ [`${ROOT}/2026/10`]: [game("a", 1)] });
    const library = new GameLibrary();
    library.apply(await fetchUpdates(server.client(), "me", []), NOW);
    const text = JSON.stringify(library.toJSON());
    expect(text).not.toContain("dropped");
    expect(text).toContain("1180");
  });

  it("a stopped download keeps its months but not the refresh time", async () => {
    const server = new Server({ [`${ROOT}/2026/09`]: [game("a", 1)], [`${ROOT}/2026/10`]: [game("b", 2)] });
    let calls = 0;
    const update = await fetchUpdates(server.client(), "me", [], { shouldStop: () => ++calls > 1 });
    expect(update.complete).toBe(false);
    expect(Object.keys(update.months)).toEqual([`${ROOT}/2026/10`]);
    const library = new GameLibrary();
    library.apply(update, NOW);
    expect(library.games("me").map((g) => g.url)).toEqual(["b"]);
    expect(library.lastRefresh("me")).toBe(0);
  });

  it("reports progress", async () => {
    const server = new Server({ [`${ROOT}/2026/09`]: [], [`${ROOT}/2026/10`]: [] });
    const seen: [number, number][] = [];
    await fetchUpdates(server.client(), "me", [], { onProgress: (d, t) => seen.push([d, t]) });
    expect(seen[0]).toEqual([0, 2]);
    expect(seen[seen.length - 1]).toEqual([2, 2]);
  });

  it("round-trips the desktop chesscom_games.json shape", () => {
    const desktop = {
      version: 1,
      users: {
        me: {
          archives: {
            [`${ROOT}/2026/10`]: {
              final: true,
              games: [
                {
                  url: "a",
                  pgn: PGN,
                  end_time: 5,
                  time_class: "rapid",
                  rules: "chess",
                  white: { username: "opp", rating: 1100, result: "win" },
                  black: { username: "Me", rating: 1200, result: "resigned" },
                },
              ],
            },
          },
          refreshed: 1_700_000_000,
        },
      },
    };
    const lib = GameLibrary.fromJSON(JSON.stringify(desktop));
    expect(lib.toJSON()).toEqual(desktop);
    expect(lib.finalMonths("ME")).toEqual([`${ROOT}/2026/10`]);
    expect(lib.games("me")[0]).toMatchObject({ url: "a", userColor: "b", opponentRating: 1100 });
    expect(lib.lastRefresh("me")).toBe(1_700_000_000);
  });

  it("rejects a corrupt library", () => {
    expect(() => GameLibrary.fromJSON("[1, 2")).toThrow();
    expect(() => GameLibrary.fromJSON([1, 2])).toThrow();
    expect(() => GameLibrary.fromJSON({ version: 1 })).toThrow();
  });
});
