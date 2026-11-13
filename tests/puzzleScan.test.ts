/** PuzzleScanner driven by EngineScheduler over a one-ply material FakeEngine. */
import { Chess } from "chess.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PuzzleScanner, estimateSeconds, formatDuration } from "../src/core/puzzleScan";
import { type Puzzle, PuzzleStore, puzzleLabel } from "../src/core/puzzles";
import type { ChessComGame } from "../src/data/chesscom";
import { EngineScheduler, type EvalRequest } from "../src/engine/scheduler";
import { FakeEngine, material } from "./fakeEngine";

// Black hangs the queen on d5 (ply 0); the user (White) misses Rxd5 and plays Kc1?? (ply 1).
// After 2.Rxd5 Kf8 the black rook on h4 is loose: Bxh4 is a clear second step.
const FEN = "4k3/8/8/8/3q3r/8/3R4/3KB3 b - - 0 1";
const PGN = `[SetUp "1"]\n[FEN "${FEN}"]\n\n1... Qd5 2. Kc1 Qxd2+ *\n`;
const URL = "https://www.chess.com/game/live/1";

/** Best material outcome for the side to move after one of its moves (tests/fakes.py). */
function onePly(fen: string): number {
  const g = new Chess(fen);
  const side = g.turn();
  let best: number | null = null;
  for (const m of g.moves({ verbose: true })) {
    g.move(m);
    const value = material(g, side);
    g.undo();
    if (best === null || value > best) best = value;
  }
  return best ?? 0;
}

function materialEngine(): FakeEngine {
  const e = new FakeEngine();
  e.scoreFor = (fen) => onePly(fen);
  return e;
}

/** Sees nothing below depth 5, then the same as the material engine. */
function lateEngine(): FakeEngine {
  const e = new FakeEngine();
  e.scoreFor = (fen, depth) => (depth < 5 ? 0 : onePly(fen));
  return e;
}

/** An EngineScheduler that remembers what it was asked. */
function recording(engine: FakeEngine): { s: EngineScheduler; requests: EvalRequest[] } {
  const s = new EngineScheduler(engine);
  const requests: EvalRequest[] = [];
  const submit = s.submit.bind(s);
  s.submit = (req) => {
    requests.push(req);
    return submit(req);
  };
  return { s, requests };
}

function chesscomGame({ url = URL, pgn = PGN, color = "w" as "w" | "b" } = {}): ChessComGame {
  return {
    url,
    pgn,
    endTime: 1_700_000_000,
    timeClass: "blitz",
    userColor: color,
    opponent: "opp",
    opponentRating: 1400,
    result: "lose",
  };
}

function makeScanner(worker: EngineScheduler, ladderWorker?: EngineScheduler) {
  const rec = {
    progress: [] as [number, number, number][],
    puzzles: [] as Puzzle[],
    finished: [] as [boolean, string | null][],
    saves: 0,
  };
  const store = new PuzzleStore();
  const scanner = new PuzzleScanner({
    worker,
    ladderWorker,
    store,
    onProgress: (d, t, f) => rec.progress.push([d, t, f]),
    onPuzzle: (p) => rec.puzzles.push(p),
    onFinished: (ok, err) => rec.finished.push([ok, err]),
    onGameDone: () => rec.saves++,
  });
  return { scanner, store, rec };
}

afterEach(() => vi.restoreAllMocks());

describe("PuzzleScanner", { timeout: 20_000 }, () => {
  it("finds the blunder and builds a two-step line", async () => {
    const { s } = recording(materialEngine());
    const { scanner, store, rec } = makeScanner(s);
    await scanner.scan([chesscomGame()], 12);

    expect(rec.finished).toEqual([[true, null]]);
    expect(rec.puzzles.length).toBe(1);
    const p = rec.puzzles[0];
    expect(p.ply).toBe(1);
    expect(p.userWhite).toBe(true);
    expect([p.playedSan, p.bestSan, p.marker]).toEqual(["Kc1", "Rxd5", "??"]);
    expect(puzzleLabel(p)).toBe("2. Kc1??");
    expect(p.steps.map((st) => st.bestUci)).toEqual(["d2d5", "e1h4"]);
    expect(p.steps[0].replyUci).toBe("e8f8");
    expect(p.steps[1].replyUci).toBeNull();
    expect(p.visiblePlies).toBe(2); // the one-ply engine sees it at the first rung
    expect(store.isAnalysed(p.gameUrl, 12)).toBe(true);
    expect(rec.saves).toBe(1);
    expect(rec.progress[rec.progress.length - 1]).toEqual([1, 1, 1]);
    expect(scanner.running).toBe(false);
  });

  it("sends the ladder searches to the cold worker", async () => {
    const main = recording(materialEngine());
    const ladder = recording(materialEngine());
    const { scanner, rec } = makeScanner(main.s, ladder.s);
    await scanner.scan([chesscomGame()], 12);
    expect(rec.finished).toEqual([[true, null]]);
    expect(rec.puzzles.length).toBe(1);
    expect(ladder.requests.length).toBeGreaterThan(0);
    expect(ladder.requests.every((r) => r.fresh && r.depth < 12)).toBe(true);
    expect(main.requests.every((r) => !r.fresh && r.depth === 12 && !r.multipv)).toBe(true);
  });

  it("takes the visible depth from the first rung that sees it", async () => {
    const { scanner, rec } = makeScanner(new EngineScheduler(lateEngine()));
    await scanner.scan([chesscomGame()], 12);
    expect(rec.puzzles[0].visiblePlies).toBe(6); // rungs 1 and 3 see nothing; rung 5 does
  });

  it("only turns the user's moves into puzzles", async () => {
    const { scanner, rec } = makeScanner(new EngineScheduler(materialEngine()));
    await scanner.scan([chesscomGame({ color: "b" })], 12);
    // As Black: 1...Qd5 hangs the queen but has no earlier eval to compare with (ply 0 is
    // skipped); 2...Qxd2+ loses the queen to Kxd2. White's 2.Kc1?? is not the user's move.
    expect(rec.puzzles.map((p) => [p.ply, p.playedSan, p.userWhite])).toEqual([[2, "Qxd2+", false]]);
    expect(rec.finished).toEqual([[true, null]]);
  });

  it("skips games already scanned", async () => {
    const { s, requests } = recording(materialEngine());
    const { scanner, store, rec } = makeScanner(s);
    store.markAnalysed(URL, 14);
    await scanner.scan([chesscomGame()], 12);
    expect(requests).toEqual([]);
    expect(rec.finished).toEqual([[true, null]]);
    expect(rec.progress).toEqual([[0, 0, 0]]);
  });

  it("stop cancels pending requests", async () => {
    const { s, requests } = recording(materialEngine());
    const { scanner, store, rec } = makeScanner(s);
    const done = scanner.scan([chesscomGame()], 12);
    expect(requests.length).toBeGreaterThan(0);
    scanner.stop();
    expect(scanner.running).toBe(false);
    await done;
    await s.idle();
    expect(rec.finished).toEqual([[false, null]]);
    expect(rec.puzzles).toEqual([]);
    expect(store.isAnalysed(URL, 12)).toBe(false);
  });

  it("a new scan supersedes the running one", async () => {
    const { s } = recording(materialEngine());
    const { scanner, rec } = makeScanner(s);
    const first = scanner.scan([chesscomGame()], 12);
    const second = scanner.scan([chesscomGame()], 12);
    await Promise.all([first, second]);
    expect(rec.finished).toEqual([[true, null]]);
    expect(rec.puzzles.length).toBe(1);
  });

  it("an engine failure ends the scan", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    class BrokenEngine extends FakeEngine {
      send(command: string): void {
        if (command.startsWith("go ")) throw new Error("engine crashed");
        super.send(command);
      }
    }
    const { scanner, store, rec } = makeScanner(new EngineScheduler(new BrokenEngine()));
    await scanner.scan([chesscomGame()], 12);
    expect(scanner.running).toBe(false);
    expect(rec.finished.length).toBe(1);
    expect(rec.finished[0][0]).toBe(false);
    expect(rec.finished[0][1]).toContain("engine");
    expect(store.isAnalysed(URL, 12)).toBe(false);
  });

  it("skips a bad PGN", async () => {
    const { scanner, store, rec } = makeScanner(new EngineScheduler(materialEngine()));
    await scanner.scan([chesscomGame({ url: "u", pgn: "" }), chesscomGame({ url: "v", pgn: "1. e4 Ke7 Kxe8 *" })], 12);
    expect(rec.finished).toEqual([[true, null]]);
    expect(store.isAnalysed("u", 12)).toBe(true);
    expect(store.isAnalysed("v", 12)).toBe(true);
  });
});

describe("estimates", () => {
  it("scales the desktop's numbers by 3 for WASM and formats durations", () => {
    expect(estimateSeconds(10, 12)).toEqual([30, 90]);
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(150)).toBe("2 min"); // Python rounds half to even
    expect(formatDuration(7200)).toBe("2.0 h");
  });
});
