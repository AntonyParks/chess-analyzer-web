import { describe, expect, it } from "vitest";
import { START_FEN } from "../src/core/chess";
import { uciScoreToWhite } from "../src/core/evaluation";
import {
  MAX_LOOKAHEAD,
  type Puzzle,
  PuzzleFilter,
  type PuzzleStep,
  PuzzleStore,
  type PuzzleStoreJSON,
  isAcceptable,
  lookaheadValue,
  puzzleLabel,
  scoresFor,
  shouldContinue,
  sortPuzzles,
  stepsWithin,
} from "../src/core/puzzles";

function step(scores: Record<string, number>, best?: string, reply: string | null = null): PuzzleStep {
  const top = best ?? Object.entries(scores).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  return { fen: START_FEN, bestUci: top, scores, replyUci: reply };
}

function makePuzzle({
  pid = "g#3",
  marker = "??",
  end = 100,
  visible = 4,
  timeClass = "blitz",
  steps,
}: { pid?: string; marker?: string; end?: number; visible?: number; timeClass?: string; steps?: PuzzleStep[] } = {}): Puzzle {
  const [url, ply] = pid.split("#");
  return {
    id: pid,
    gameUrl: url,
    endTime: end,
    opponent: "opp",
    opponentRating: 1500,
    timeClass,
    userWhite: true,
    ply: Number(ply),
    moveNumber: 2,
    playedUci: "d1h5",
    playedSan: "Qh5",
    bestSan: "Nf3",
    marker,
    winDrop: 0.4,
    scanDepth: 12,
    visiblePlies: visible,
    steps: steps ?? [step({ g1f3: 0.1, d1h5: -0.3 }), step({ a2a3: 0.2, b2b3: 0.0 })],
    continuation: [],
    attempts: 0,
    solved: 0,
    failed: 0,
    lastResult: null,
  };
}

const ids = (ps: Puzzle[]) => ps.map((p) => p.id);
const reload = (s: PuzzleStore) => PuzzleStore.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));

describe("answer rules", () => {
  it("accepts moves within the margin", () => {
    const s = step({ a: 0.5, b: 0.46, c: 0.44, d: -0.2 });
    expect(isAcceptable(s, "a")).toBe(true);
    expect(isAcceptable(s, "b")).toBe(true); // within 0.05
    expect(isAcceptable(s, "c")).toBe(false);
    expect(isAcceptable(s, "zz")).toBe(false);
  });

  it("continues only with a clearly best move", () => {
    expect(shouldContinue({ a: 0.5, b: 0.35 })).toBe(true);
    expect(shouldContinue({ a: 0.5, b: 0.45 })).toBe(false);
    expect(shouldContinue({ a: 0.5 })).toBe(false); // forced move
  });

  it("scores handle mate and point of view", () => {
    const evals = {
      a: { cpWhite: uciScoreToWhite("mate", -1, "b"), pv: [], depth: 1 }, // Black is getting mated
      b: { cpWhite: uciScoreToWhite("cp", -100, "b"), pv: [], depth: 1 }, // +1.00 for White
    };
    const scores = scoresFor(evals, "w");
    expect(scores.a).toBeGreaterThan(0.99);
    expect(scores.b).toBeGreaterThan(0.15);
    expect(scores.b).toBeLessThan(0.2);
  });

  it("cuts steps to the lookahead", () => {
    const p = makePuzzle();
    expect(stepsWithin(p, null).length).toBe(2);
    expect(stepsWithin(p, 1).length).toBe(1);
    expect(stepsWithin(p, 5).length).toBe(2);
    expect(stepsWithin(p, 0).length).toBe(1); // never empty
    expect(puzzleLabel(p)).toBe("2. Qh5??");
    expect(puzzleLabel({ ...p, userWhite: false })).toBe("2... Qh5??");
  });

  it("filters on marker, mode, time class and lookahead", () => {
    const p = makePuzzle({ visible: 6 });
    expect(new PuzzleFilter().matches(p)).toBe(true);
    expect(new PuzzleFilter({ markers: ["?!"] }).matches(p)).toBe(false);
    expect(new PuzzleFilter({ timeClasses: ["rapid"] }).matches(p)).toBe(false);
    expect(new PuzzleFilter({ lookahead: 3 }).matches(p)).toBe(true);
    expect(new PuzzleFilter({ lookahead: 2 }).matches(p)).toBe(false);
    expect(new PuzzleFilter({ mode: "unsolved" }).matches(p)).toBe(true);
    expect(new PuzzleFilter({ mode: "failed" }).matches(p)).toBe(false);
    p.lastResult = "failed";
    expect(new PuzzleFilter({ mode: "failed" }).matches(p)).toBe(true);
    p.lastResult = "solved";
    expect(new PuzzleFilter({ mode: "unsolved" }).matches(p)).toBe(false);
  });

  it("maps the lookahead slider", () => {
    expect(lookaheadValue(1)).toBe(1);
    expect(lookaheadValue(MAX_LOOKAHEAD)).toBe(MAX_LOOKAHEAD);
    expect(lookaheadValue(MAX_LOOKAHEAD + 1)).toBeNull();
  });
});

describe("PuzzleStore", () => {
  it("round-trips and records results", () => {
    const store = new PuzzleStore();
    expect(store.size).toBe(0);
    store.add(makePuzzle({ pid: "old#3", end: 100 }));
    store.add(makePuzzle({ pid: "new#5", marker: "?!", end: 200 }));
    store.markAnalysed("old", 12);
    store.record("old#3", false);

    const again = reload(store);
    expect(ids(again.all())).toEqual(["new#5", "old#3"]); // newest game first
    const old = again.get("old#3")!;
    expect([old.failed, old.attempts, old.lastResult]).toEqual([1, 1, "failed"]);
    expect(old.steps[0].bestUci).toBe("g1f3");
    expect(again.isAnalysed("old", 12)).toBe(true);
    expect(again.isAnalysed("old", 14)).toBe(false);
    expect(again.isAnalysed("new", 1)).toBe(false);
    expect(again.counts(new PuzzleFilter())).toEqual({ "??": 1, "?": 0, "?!": 1 });
    expect(ids(again.query(new PuzzleFilter({ mode: "failed" })))).toEqual(["old#3"]);
  });

  it("a rescan keeps the history", () => {
    const store = new PuzzleStore();
    store.add(makePuzzle());
    store.record("g#3", true);
    store.add(makePuzzle());
    expect(store.get("g#3")!.solved).toBe(1);
  });

  it("rejects a corrupt file", () => {
    expect(() => PuzzleStore.fromJSON("{not json")).toThrow();
    expect(() => PuzzleStore.fromJSON([1])).toThrow();
  });

  it("a bad puzzle entry counts as corrupt", () => {
    expect(() => PuzzleStore.fromJSON({ puzzles: [{ id: "x" }] })).toThrow();
  });

  it("round-trips a desktop puzzles.json unchanged", () => {
    const desktop: PuzzleStoreJSON = {
      version: 1,
      analysed_games: { "https://www.chess.com/game/live/2": 12, "https://www.chess.com/game/live/1": 14 },
      puzzles: [
        {
          id: "https://www.chess.com/game/live/2#7",
          game_url: "https://www.chess.com/game/live/2",
          end_time: 1_700_000_500,
          opponent: "opp",
          opponent_rating: null,
          time_class: "rapid",
          user_white: false,
          ply: 7,
          move_number: 4,
          played_uci: "d8h4",
          played_san: "Qh4",
          best_san: "Nf6",
          marker: "?",
          win_drop: 0.2345,
          scan_depth: 12,
          visible_plies: 4,
          steps: [
            { fen: START_FEN, best_uci: "g8f6", scores: { g8f6: 0.1, d8h4: -0.13 }, reply_uci: "e2e4" },
            { fen: START_FEN, best_uci: "e7e5", scores: { e7e5: 0.3, a7a6: 0.0 }, reply_uci: null },
          ],
          continuation: [],
          attempts: 3,
          solved: 1,
          failed: 2,
          last_result: "failed",
        },
        {
          id: "https://www.chess.com/game/live/1#1",
          game_url: "https://www.chess.com/game/live/1",
          end_time: 1_700_000_000,
          opponent: "rival",
          opponent_rating: 1400,
          time_class: "blitz",
          user_white: true,
          ply: 1,
          move_number: 2,
          played_uci: "d1c1",
          played_san: "Kc1",
          best_san: "Rxd5",
          marker: "??",
          win_drop: 0.9,
          scan_depth: 14,
          visible_plies: 2,
          steps: [{ fen: START_FEN, best_uci: "d2d5", scores: { d2d5: 0.8, d1c1: -0.1 }, reply_uci: null }],
          continuation: ["e8f8", "e1h4"],
          attempts: 0,
          solved: 0,
          failed: 0,
          last_result: null,
        },
      ],
    };
    const store = PuzzleStore.fromJSON(JSON.stringify(desktop));
    expect(store.toJSON()).toEqual(desktop);
    const p = store.get("https://www.chess.com/game/live/2#7")!;
    expect(p.steps[0].replyUci).toBe("e2e4");
    expect(p.lastResult).toBe("failed");
  });
});

describe("sorting", () => {
  it("sorts easiest and hardest", () => {
    const deep = makePuzzle({ pid: "a#1", end: 300, visible: 8 });
    const shallowLong = makePuzzle({ pid: "b#1", end: 200, visible: 2 }); // two steps
    const shallowShort = makePuzzle({ pid: "c#1", end: 100, visible: 2, steps: [step({ x: 0.5, y: 0.0 })] });
    const shallowManyAnswers = makePuzzle({
      pid: "d#1",
      end: 50,
      visible: 2,
      steps: [step({ x: 0.5, y: 0.48, z: 0.0 })],
    });
    const puzzles = [deep, shallowLong, shallowShort, shallowManyAnswers];
    expect(ids(sortPuzzles(puzzles))).toEqual(["a#1", "b#1", "c#1", "d#1"]); // newest first
    // Shallow first; then one step before two; then two accepted answers before one.
    expect(ids(sortPuzzles(puzzles, "easiest"))).toEqual(["d#1", "c#1", "b#1", "a#1"]);
    expect(ids(sortPuzzles(puzzles, "hardest"))).toEqual(["a#1", "b#1", "c#1", "d#1"]);
    // With a one-move lookahead the two-step line is cut to one step: ties fall to the
    // remaining keys, and equal puzzles stay newest first.
    expect(ids(sortPuzzles(puzzles, "easiest", 1)).slice(0, 3)).toEqual(["d#1", "b#1", "c#1"]);
  });

  it("a bigger blunder is easier when otherwise equal", () => {
    const small = makePuzzle({ pid: "s#1", end: 2, visible: 2, steps: [step({ x: 0.5, y: 0.0 })] });
    const big = makePuzzle({ pid: "b#1", end: 1, visible: 2, steps: [step({ x: 0.5, y: 0.0 })] });
    small.winDrop = 0.12;
    big.winDrop = 0.9;
    expect(ids(sortPuzzles([small, big], "easiest"))).toEqual(["b#1", "s#1"]);
  });

  it("the store query uses the order", () => {
    const store = new PuzzleStore();
    store.add(makePuzzle({ pid: "deep#1", end: 200, visible: 10 }));
    store.add(makePuzzle({ pid: "easy#1", end: 100, visible: 2 }));
    expect(ids(store.query(new PuzzleFilter()))).toEqual(["deep#1", "easy#1"]);
    expect(ids(store.query(new PuzzleFilter(), "easiest"))).toEqual(["easy#1", "deep#1"]);
  });
});
