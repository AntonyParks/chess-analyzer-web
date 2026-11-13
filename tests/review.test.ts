import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { START_FEN, moveToUci } from "../src/core/chess";
import { MATE_SCORE_CP, type MoveEval } from "../src/core/evaluation";
import { GameState } from "../src/core/gameState";
import { GameReviewRunner, buildReview } from "../src/core/review";
import { EngineScheduler } from "../src/engine/scheduler";
import { FakeEngine } from "./fakeEngine";

/** A game with position evals (White's POV) per ply and optional move evals per ply. */
function analysedGame(
  startFen: string,
  sanMoves: string[],
  cps: number[],
  alternatives: Record<number, Record<string, number>> = {},
): GameState {
  const g = new Chess(startFen);
  const moves = sanMoves.map((san) => moveToUci(g.move(san)));
  const state = new GameState();
  state.loadGame(startFen, moves);
  cps.forEach((cp, ply) => {
    const evals: Record<string, MoveEval> = {};
    for (const [uci, cpWhite] of Object.entries(alternatives[ply] ?? {})) evals[uci] = { cpWhite, pv: [], depth: 10 };
    state.analysis.set(ply, { positionCp: cp, evals, rankMap: {}, complete: true, depth: 10 });
  });
  return state;
}

describe("buildReview", () => {
  it("numbers moves from a Black-to-move start", () => {
    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    // Black blunders on move 1..., White plays fine.
    const entries = buildReview(analysedGame(fen, ["f6", "Nf3"], [30, 400, 420]));
    expect(entries.map((e) => e.san)).toEqual(["f6"]);
    const entry = entries[0];
    expect(entry.moveNumber).toBe(1);
    expect(entry.isWhite).toBe(false);
    expect(entry.ply).toBe(1);
    expect(entry.marker).toBe("??");
    expect(entry.cpDrop).toBe(370);
    expect(entry.winDrop).toBeGreaterThan(0.3);
    expect(entry.label).toBe("1... f6??");
  });

  it("no better move when the played move was the engine's choice", () => {
    const sans = ["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7#"];
    // Black's 3...Nf6?? allows mate: evals before/after.
    const cps = [30, 30, 30, 50, 50, 50, 99999, 100000];
    const entries = buildReview(analysedGame(START_FEN, sans, cps, { 5: { g8f6: 99999, g7g6: 60 } }));
    expect(entries.map((e) => e.san)).toEqual(["Nf6"]);
    expect(entries[0].betterSan).toBe("g6");
    // Now pretend Nf6 was the best move available: no suggestion.
    const state2 = analysedGame(START_FEN, sans, cps, { 5: { g8f6: 99999 } });
    expect(buildReview(state2)[0].betterSan).toBeNull();
  });

  it("small losses are not flagged and markers follow win drop", () => {
    expect(buildReview(analysedGame(START_FEN, ["e4", "e5", "Nf3", "Nc6"], [30, 25, 35, 20, 30]))).toEqual([]);
    const state = analysedGame(START_FEN, ["e4", "e5", "Nf3"], [0, -150, -140, -400]);
    const markers = Object.fromEntries(buildReview(state).map((e) => [e.san, e.marker]));
    expect(
      (markers.e4 === "?" && markers.Nf3 === "?" && Object.keys(markers).length === 2) ||
        ["?", "?!"].includes(markers.e4),
    ).toBe(true);
    expect(markers).not.toHaveProperty("e5"); // Black gained
  });
});

describe("GameReviewRunner", () => {
  function setup(sanMoves: string[]) {
    const g = new Chess();
    const state = new GameState();
    state.loadGame(
      START_FEN,
      sanMoves.map((san) => moveToUci(g.move(san))),
    );
    const scheduler = new EngineScheduler(new FakeEngine());
    const progress: [number, number][] = [];
    let resolve!: (completed: boolean) => void;
    const finished = new Promise<boolean>((r) => (resolve = r));
    const runner = new GameReviewRunner({
      scheduler,
      stateProvider: () => state,
      depthProvider: () => 4,
      onProgress: (done, total) => progress.push([done, total]),
      onFinished: (completed) => resolve(completed),
    });
    return { state, scheduler, runner, progress, finished };
  }

  it("evaluates every legal move of every ply; mate plies use the terminal eval", async () => {
    const { state, runner, progress, finished } = setup(["f3", "e5", "g4", "Qh4#"]);
    expect(runner.start()).toBe(true);
    expect(runner.running).toBe(true);
    expect(await finished).toBe(true);
    expect(runner.running).toBe(false);
    expect(progress[0]).toEqual([1, 5]); // the mated final position needs no search
    expect(progress.at(-1)).toEqual([5, 5]);
    for (let ply = 0; ply < 4; ply++) {
      const a = state.analysis.get(ply)!;
      const legal = new Chess(state.fenAt(ply)).moves().length;
      expect(Object.keys(a.evals).length).toBe(legal);
      expect(a.complete).toBe(true);
      expect(a.depth).toBe(4);
      const values = Object.values(a.evals).map((e) => e.cpWhite);
      const best = state.moverAt(ply) === "w" ? Math.max(...values) : Math.min(...values);
      expect(a.positionCp).toBe(best);
      expect(Object.keys(a.rankMap).sort()).toEqual(Object.keys(a.evals).sort());
    }
    // Before 2...Qh4#, Black's best move is the mate.
    expect(state.analysis.get(3)!.positionCp).toBe(-MATE_SCORE_CP);
    expect(state.analysis.get(4)).toEqual({
      positionCp: -MATE_SCORE_CP,
      evals: {},
      rankMap: {},
      complete: true,
      depth: 4,
    });
  });

  it("skips plies already analysed at this depth and refuses an empty game", async () => {
    const { scheduler, runner, progress, finished } = setup(["e4"]);
    runner.start();
    expect(await finished).toBe(true);
    await scheduler.idle();
    expect(runner.start()).toBe(true);
    expect(runner.running).toBe(false);
    expect(progress.at(-1)).toEqual([2, 2]);
    const again = setup([]);
    expect(again.runner.start()).toBe(false);
  });

  it("a change to the move list cancels the run", async () => {
    const { state, scheduler, runner, finished } = setup(["e4", "e5", "Nf3", "Nc6"]);
    runner.start();
    state.push("f1c4"); // currentPly is at the end: a new move bumps the version
    runner.onStateChanged();
    expect(await finished).toBe(false);
    expect(runner.running).toBe(false);
    await scheduler.idle();
    expect(state.analysis.size).toBe(0);
  });
});
