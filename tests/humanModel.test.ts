import { describe, expect, it } from "vitest";
import { START_FEN, after, legalUcis } from "../src/core/chess";
import type { MoveEval } from "../src/core/evaluation";
import {
  CHESSCOM_TO_LICHESS,
  type PlyData,
  depthWeights,
  expectedPlay,
  findChance,
  findDepth,
  foundRates,
  gameRatings,
  goodMoves,
  humanEval,
} from "../src/core/humanModel";
import { FOUND_RATE_BANDS } from "../src/core/humanModelData";
import { EngineScheduler, Kind } from "../src/engine/scheduler";
import type { TracePoint } from "../src/engine/scheduler";
import { FakeEngine } from "./fakeEngine";

const ev = (cpWhite: number): MoveEval => ({ cpWhite, pv: [], depth: 12 });
const trace = (pairs: [string, number][]): TracePoint[] => pairs.map(([best, cpWhite], i) => ({ depth: i + 1, best, cpWhite }));

describe("human model", () => {
  it("interpolates between bands and never rises with depth", () => {
    const lo = FOUND_RATE_BANDS[0];
    expect(foundRates(lo.center - 300)[0]).toBe(lo.rates[0]);
    const mid = foundRates((FOUND_RATE_BANDS[0].center + FOUND_RATE_BANDS[1].center) / 2);
    expect(mid[0]).toBeCloseTo((FOUND_RATE_BANDS[0].rates[0] + FOUND_RATE_BANDS[1].rates[0]) / 2, 6);
    for (const r of [900, 1250, 1500, 2000]) {
      const rates = foundRates(r);
      for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeLessThanOrEqual(rates[i - 1]);
    }
    expect(findChance(1250, 1)).toBeGreaterThan(findChance(1250, 12));
    expect(findChance(1250, Number.POSITIVE_INFINITY)).toBe(foundRates(1250).at(-1));
  });

  it("weights depths so they sum to one, most on depth 1 and the deepest", () => {
    const w = depthWeights(1250, 14);
    expect(w).toHaveLength(14);
    expect(w.reduce((a, b) => a + b)).toBeCloseTo(1, 9);
    w.forEach((x) => expect(x).toBeGreaterThanOrEqual(0));
  });

  it("blends per-depth scores; a steady score stays put", () => {
    expect(humanEval(trace(Array.from({ length: 12 }, () => ["e2e4", 150])), 1250)).toBe(150);
    // A move that only shows at depth 10: the human eval sits well below the engine's.
    const late = trace(Array.from({ length: 12 }, (_, i) => ["e2e4", i < 9 ? -100 : 300]));
    const h = humanEval(late, 1250)!;
    expect(h).toBeGreaterThan(-100);
    expect(h).toBeLessThan(150);
    expect(humanEval([], 1250)).toBeNull();
  });

  it("finds the depth from which the engine's choice stays good", () => {
    const good = goodMoves({ a: ev(100), b: ev(95), c: ev(-200) }, "w");
    expect([...good].sort()).toEqual(["a", "b"]);
    expect(findDepth(trace([["c", 0], ["a", 0], ["b", 0], ["a", 0]]), good)).toBe(2);
    expect(findDepth(trace([["a", 0], ["c", 0], ["a", 0]]), good)).toBe(3);
    expect(findDepth(trace([["a", 0], ["c", 0]]), good)).toBe(Number.POSITIVE_INFINITY);
  });

  it("reads ratings from the headers, converting chess.com", () => {
    expect(gameRatings({ Site: "Chess.com", WhiteElo: "1000", BlackElo: "?" }, 800)).toEqual({
      w: 1000 + CHESSCOM_TO_LICHESS,
      b: 800 + CHESSCOM_TO_LICHESS,
    });
    expect(gameRatings({ Site: "https://lichess.org/abc", WhiteElo: "1500", BlackElo: "1400" }, 800)).toEqual({ w: 1500, b: 1400 });
  });

  it("counts good moves played against the expectation", () => {
    const fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
    const legal = legalUcis(fen);
    const evals = Object.fromEntries(legal.map((u) => [u, ev(u === "f1b5" ? 40 : -150)]));
    const ply = (played: string): PlyData => ({ fen, played, legalCount: legal.length, evals, trace: trace([["f1b5", 40], ["f1b5", 40]]) });
    const plies: PlyData[] = Array.from({ length: 8 }, () => ({ fen: START_FEN, played: "e2e4", legalCount: 20, evals: undefined, trace: undefined }));
    plies.push(ply("f1b5"), ply("d2d4"));
    const play = expectedPlay(plies, { w: 1250, b: 1250 });
    expect(play.w.moves).toBe(2);
    expect(play.w.found).toBe(1);
    expect(play.w.expected).toBeCloseTo(2 * findChance(1250, 1), 9);
    expect(play.moves.get(8)).toMatchObject({ findDepth: 1, found: true });
    expect(play.b.moves).toBe(0);
  });
});

describe("depth traces", () => {
  it("report the main line at each depth from a cleared hash, and are cached", async () => {
    const engine = new FakeEngine();
    const fen = after(START_FEN, "e2e4")!;
    engine.bestAt = (_f, d) => (d < 3 ? "e7e5" : "c7c5");
    const s = new EngineScheduler(engine);
    const r = await new Promise<import("../src/engine/scheduler").EvalResult>((resolve) =>
      s.submit({ kind: Kind.BATCH, fen, moves: [], depth: 4, trace: true, onDone: resolve }),
    );
    expect(r.trace!.map((t) => [t.depth, t.best])).toEqual([[1, "e7e5"], [2, "e7e5"], [3, "c7c5"], [4, "c7c5"]]);
    expect(engine.commands).toContain("ucinewgame");
    const before = engine.commands.length;
    await new Promise((resolve) => s.submit({ kind: Kind.BATCH, fen, moves: [], depth: 4, trace: true, onDone: resolve }));
    expect(engine.commands.length).toBe(before);
  });
});
