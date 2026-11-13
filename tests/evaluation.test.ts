import { describe, expect, it } from "vitest";
import * as ev from "../src/core/evaluation";

const M = ev.MATE_SCORE_CP;
const e = (cpWhite: number): ev.MoveEval => ({ cpWhite, pv: [], depth: 1 });

describe("evaluation (mirrors tests/test_evaluation.py)", () => {
  it.each([
    [40, "+0.4"],
    [-40, "-0.4"],
    [-1200, "-12.0"],
    [0, "+0.0"],
    [M - 3, "M3"],
    [-(M - 3), "-M3"],
    [M, "#"],
    [-M, "-#"],
  ])("formatCp(%i) = %s", (cp, text) => expect(ev.formatCp(cp)).toBe(text));

  it("converts UCI scores to White's view", () => {
    expect(ev.uciScoreToWhite("cp", 40, "b")).toBe(-40);
    expect(ev.uciScoreToWhite("mate", 3, "w")).toBe(M - 3);
    expect(ev.uciScoreToWhite("mate", -2, "b")).toBe(M - 2); // Black is mated: good for White
    expect(ev.uciScoreToWhite("mate", 0, "w")).toBe(-M);
  });

  it.each([
    [40, "0.4"],
    [-40, "0.4"],
    [1234, "12"],
    [-999, "10"],
    [949, "9.5"],
    [M - 3, "M3"],
    [-(M - 3), "M3"],
    [M, "#"],
  ])("formatBarText(%i) = %s", (cp, text) => expect(ev.formatBarText(cp)).toBe(text));

  it("only mate-zone values are mates", () => {
    expect(ev.mateDistance(31_000)).toBeNull();
    expect(ev.mateDistance(M - 7)).toBe(7);
    expect(ev.mateDistance(-(M - 1))).toBe(1);
  });

  it("ranks moves for the side to move", () => {
    const evals = { a: e(100), b: e(-50), c: e(0) };
    expect(ev.rankMoves(evals, "w")).toEqual({ a: 1, c: 0.5, b: 0 });
    expect(ev.rankMoves(evals, "b")).toEqual({ a: 0, c: 0.5, b: 1 });
    expect(ev.rankMoves({ a: e(10), b: e(10), c: e(-10) }, "w")).toEqual({ a: 1, b: 1, c: 0 });
    expect(ev.rankMoves({ only: e(300) }, "w")).toEqual({ only: 0.5 });
    expect(ev.rankMoves({}, "w")).toEqual({});
  });

  it("picks the best move for the side to move", () => {
    expect(ev.bestUci({ a: e(100), b: e(-50) }, "w")).toBe("a");
    expect(ev.bestUci({ a: e(100), b: e(-50) }, "b")).toBe("b");
    expect(ev.bestUci({}, "w")).toBeNull();
  });

  it("win chances and drops", () => {
    expect(ev.winChance(0)).toBe(0);
    expect(ev.winChance(100)).toBeCloseTo(-ev.winChance(-100));
    expect(ev.winChance(M)).toBeCloseTo(1);
    expect(ev.winDrop(300, -300, "w")).toBeGreaterThan(ev.BLUNDER);
    expect(ev.winDrop(300, -300, "b")).toBe(0);
    expect(ev.winDrop(-300, 300, "b")).toBeGreaterThan(ev.BLUNDER);
    expect(ev.winDrop(900, 700, "w")).toBeLessThan(ev.INACCURACY);
    expect(ev.cpDrop(100, -50, "w")).toBe(150);
    expect(ev.cpDrop(100, -50, "b")).toBe(-150);
  });

  it.each([
    [0, ""],
    [0.09, ""],
    [0.1, "?!"],
    [0.19, "?!"],
    [0.2, "?"],
    [0.3, "??"],
    [1.5, "??"],
  ])("classify(%f) = %s", (drop, symbol) => expect(ev.classify(drop)).toBe(symbol));

  it("rank colours match the desktop ramp", () => {
    expect(ev.rankColor(1)).toBe("#28C828");
    expect(ev.rankColor(0)).toBe("#D22828");
  });
});
