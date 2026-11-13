import { describe, expect, it } from "vitest";
import { legalUcis } from "../src/core/chess";
import { EngineScheduler, type EvalRequest, type EvalResult, Kind } from "../src/engine/scheduler";
import { parseInfo } from "../src/engine/uci";
import { FakeEngine } from "./fakeEngine";

// White to move; Black's queen on d5 hangs to the rook.
const FEN = "4k3/8/8/3q4/7r/8/3R4/3KB3 w - - 1 2";

function run(s: EngineScheduler, req: Omit<EvalRequest, "onDone">): Promise<EvalResult> {
  return new Promise((resolve) => s.submit({ ...req, onDone: resolve }));
}

describe("UCI parsing", () => {
  it("reads depth, multipv, score and pv", () => {
    expect(parseInfo("info depth 12 seldepth 18 multipv 2 score cp -35 nodes 1 pv e2e4 e7e5")).toEqual({
      depth: 12,
      multipv: 2,
      kind: "cp",
      value: -35,
      pv: ["e2e4", "e7e5"],
    });
    expect(parseInfo("info depth 3 score mate -2 pv a1a2")?.value).toBe(-2);
    expect(parseInfo("info depth 9 score cp 20 lowerbound pv e2e4")).toBeNull();
    expect(parseInfo("info string NNUE")).toBeNull();
  });
});

describe("EngineScheduler", () => {
  it("evaluates each move by searching the position after it", async () => {
    const s = new EngineScheduler(new FakeEngine());
    const r = await run(s, { kind: Kind.BATCH, fen: FEN, moves: ["d2d5", "d1c1"], depth: 5 });
    expect(r.complete).toBe(true);
    expect(r.evals.d2d5.cpWhite).toBeGreaterThan(r.evals.d1c1.cpWhite);
    expect(r.evals.d2d5.cpWhite).toBe(300); // R+B against R after Rxd5
  });

  it("scores every move with one MultiPV search", async () => {
    const engine = new FakeEngine();
    const s = new EngineScheduler(engine);
    const moves = legalUcis(FEN);
    const r = await run(s, { kind: Kind.HEATMAP, fen: FEN, moves, depth: 8, multipv: true });
    expect(Object.keys(r.evals).sort()).toEqual([...moves].sort());
    expect(engine.commands.filter((c) => c.startsWith("go ")).length).toBe(1);
    const best = Object.entries(r.evals).sort((a, b) => b[1].cpWhite - a[1].cpWhite)[0][0];
    expect(best).toBe("d2d5");
  });

  it("reports progressive depths for the heatmap", async () => {
    const s = new EngineScheduler(new FakeEngine());
    const depths: number[] = [];
    const r = await new Promise<EvalResult>((resolve) =>
      s.submit({
        kind: Kind.HEATMAP,
        fen: FEN,
        moves: legalUcis(FEN),
        depth: 16,
        fromDepth: 8,
        multipv: true,
        onProgress: (p) => depths.push(p.depth),
        onDone: resolve,
      }),
    );
    expect(depths).toEqual([8, 12]);
    expect(r.depth).toBe(16);
  });

  it("serves cached moves without searching again; fresh searches clear the hash", async () => {
    const engine = new FakeEngine();
    const s = new EngineScheduler(engine);
    await run(s, { kind: Kind.BATCH, fen: FEN, moves: ["d2d5"], depth: 5 });
    await run(s, { kind: Kind.BATCH, fen: FEN, moves: ["d2d5"], depth: 5 });
    expect(engine.commands.filter((c) => c.startsWith("go ")).length).toBe(1);
    await run(s, { kind: Kind.IDLE, fen: FEN, moves: ["d2d5", "d1c1"], depth: 3, fresh: true });
    expect(engine.commands.filter((c) => c === "ucinewgame").length).toBe(2);
  });

  it("a cancelled request never reports", async () => {
    const s = new EngineScheduler(new FakeEngine());
    let called = false;
    const id = s.submit({
      kind: Kind.IDLE,
      fen: FEN,
      moves: legalUcis(FEN),
      depth: 4,
      onDone: () => (called = true),
    });
    s.cancel(id);
    await run(s, { kind: Kind.BATCH, fen: FEN, moves: ["d2d5"], depth: 4 });
    await s.idle();
    expect(called).toBe(false);
  });

  it("a newer heatmap replaces the pending one", async () => {
    const s = new EngineScheduler(new FakeEngine());
    const seen: string[] = [];
    s.submit({ kind: Kind.HEATMAP, fen: FEN, moves: ["d2d5"], depth: 4, multipv: true, onDone: () => seen.push("old") });
    await run(s, { kind: Kind.HEATMAP, fen: FEN, moves: ["d1c1"], depth: 4, multipv: true });
    await s.idle();
    expect(seen).toEqual([]);
  });
});
