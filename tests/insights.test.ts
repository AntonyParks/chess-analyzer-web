import { describe, expect, it } from "vitest";
import { after, board, epd, moveToUci, START_FEN } from "../src/core/chess";
import {
  type ExplorerSource,
  type InsightsParams,
  type InsightsSummary,
  InsightsWorker,
  type NotableMove,
  judgeMove,
  playPct,
  positionMoves,
  wilsonBounds,
  wilsonLower,
} from "../src/core/insights";
import {
  type ExplorerQuery,
  type ExplorerResult,
  LichessAuthError,
  LichessRateLimited,
  LichessUnavailable,
  type MoveStats,
  makeExplorerResult,
  makeMoveStats,
} from "../src/data/lichess";

const QUERY: ExplorerQuery = { speeds: ["blitz"], ratings: [1600], moves: 20 };

function stats(fen: string, san: string, white: number, draws: number, black: number): MoveStats {
  const m = board(fen).move(san);
  return makeMoveStats(moveToUci(m), san, white, draws, black, 1800);
}

function position(fen: string, moves: MoveStats[], extra: [number, number, number] = [0, 0, 0]): ExplorerResult {
  const sum = (k: "white" | "draws" | "black") => moves.reduce((a, m) => a + m[k], 0);
  return makeExplorerResult(epd(fen), sum("white") + extra[0], sum("draws") + extra[1], sum("black") + extra[2], moves);
}

function params(overrides: Partial<InsightsParams> = {}): InsightsParams {
  return {
    color: "w",
    minPct: 0,
    minGames: 10,
    topN: 0,
    deltaPp: 5,
    query: QUERY,
    maxPositions: 50,
    maxDepth: 6,
    maxSeconds: 30,
    minInterval: 0,
    ...overrides,
  };
}

const play = (fen: string, ...sans: string[]): string => {
  const g = board(fen);
  for (const s of sans) g.move(s);
  return g.fen();
};
const AFTER_E4 = play(START_FEN, "e4");

// ── statistics ───────────────────────────────────────────────────────────────

describe("statistics", () => {
  it("wilson lower bound values", () => {
    expect(wilsonLower(10, 10)).toBeCloseTo(0.7225, 4);
    expect(wilsonLower(0, 10)).toBe(0);
    expect(wilsonLower(5, 0)).toBe(0);
    expect(wilsonLower(50, 100)).toBeLessThan(0.5);
    expect(wilsonLower(50, 100) + 0.11).toBeGreaterThan(0.5);
    expect(wilsonLower(500, 1000)).toBeGreaterThan(wilsonLower(50, 100));
  });

  it("wilson bounds upper end", () => {
    const [lower, upper] = wilsonBounds(0, 10);
    expect(lower).toBe(0);
    expect(upper).toBeCloseTo(0.2775, 4);
    const [l10, u10] = wilsonBounds(10, 10);
    expect(l10).toBeCloseTo(0.7225, 4);
    expect(u10).toBe(1);
    expect(wilsonBounds(5, 0)).toEqual([0, 1]);
    expect(wilsonBounds(50, 100)[1]).toBeLessThan(wilsonBounds(5, 10)[1]);
  });

  it("judgeMove measures how far opponents fall short of their best reply", () => {
    const nc6 = stats(AFTER_E4, "Nc6", 360, 60, 180);
    const nf6 = stats(AFTER_E4, "Nf6", 120, 60, 120);
    const a5 = stats(AFTER_E4, "a5", 2, 0, 8);
    const afterRes = position(AFTER_E4, [nc6, nf6, a5]);
    const verdict = judgeMove(afterRes, params({ minPct: 5, deltaPp: 0 }))!;
    expect(verdict).not.toBeNull();
    expect(verdict.score).toBeCloseTo(542 / 910, 10);
    expect(verdict.games).toBe(910);
    expect(verdict.bestReply.san).toBe("Nf6");
    expect(verdict.bestReplyScore).toBeCloseTo(0.5, 10);
    expect(verdict.challenge).toBeGreaterThan(0.02);
    expect(verdict.challenge).toBeLessThan(0.05);
    expect(judgeMove(afterRes, params({ minPct: 5, deltaPp: 5 }))).toBeNull();
    const loose = judgeMove(afterRes, params({ minPct: 0, deltaPp: 0 }))!;
    expect(loose.bestReply.san).toBe("a5");
    expect(loose.challenge).toBeGreaterThan(0.05);
    expect(loose.challenge).toBeLessThan(0.12);
  });

  it("judgeMove needs games and replies", () => {
    const afterRes = position(AFTER_E4, [stats(AFTER_E4, "Nc6", 360, 60, 180), stats(AFTER_E4, "Nf6", 120, 60, 120)]);
    expect(judgeMove(afterRes, params({ minGames: 1000, deltaPp: 0 }))).toBeNull();
    expect(judgeMove(position(AFTER_E4, []), params({ minGames: 1, deltaPp: 0 }))).toBeNull();
  });

  it("judgeMove for Black scores Black's wins", () => {
    const e4 = stats(START_FEN, "e4", 100, 100, 300);
    const d4 = stats(START_FEN, "d4", 200, 100, 200);
    const verdict = judgeMove(position(START_FEN, [e4, d4]), params({ color: "b", deltaPp: 0 }))!;
    expect(verdict.score).toBeCloseTo(0.6, 10);
    expect(verdict.bestReply.san).toBe("d4");
    expect(verdict.bestReplyScore).toBeCloseTo(0.5, 10);
    expect(verdict.challenge).toBeGreaterThan(0.03);
    expect(verdict.challenge).toBeLessThan(0.06);
  });

  it("a forced move is not challenging however bad the alternatives were", () => {
    const afterRes = position(AFTER_E4, [
      stats(AFTER_E4, "Nc6", 1612, 800, 1588),
      stats(AFTER_E4, "Nf6", 1290, 600, 1110),
      stats(AFTER_E4, "d5", 1288, 600, 1112),
    ]);
    expect(judgeMove(afterRes, params({ deltaPp: 1 }))).toBeNull();
  });
});

// ── the crawl ────────────────────────────────────────────────────────────────

/** Serves a tiny opening tree; records requests; can raise on demand. */
class FakeClient implements ExplorerSource {
  requests: string[] = [];
  private cache = new Map<string, ExplorerResult>();
  constructor(
    private tree: Map<string, ExplorerResult>,
    private errors = new Map<string, Error>(),
  ) {}

  cached(fen: string): ExplorerResult | null {
    return this.cache.get(epd(fen)) ?? null;
  }

  async explorer(fen: string): Promise<ExplorerResult> {
    const key = epd(fen);
    this.requests.push(key);
    const exc = this.errors.get(key);
    if (exc) {
      this.errors.delete(key);
      throw exc;
    }
    const result = this.tree.get(key) ?? makeExplorerResult(key, 0, 0, 0, []);
    this.cache.set(key, result);
    return result;
  }
}

/** Only 1.e4 e5 2.Nf3 is challenging: Black's reliable Nf6 holds White to 40%, but three
 * quarters of opponents play Nc6 and score badly. */
function buildTree() {
  const tree = new Map<string, ExplorerResult>();
  const add = (fen: string, moves: MoveStats[]) => tree.set(epd(fen), position(fen, moves));
  add(START_FEN, [stats(START_FEN, "e4", 450, 200, 350), stats(START_FEN, "d4", 400, 200, 400)]);
  add(AFTER_E4, [stats(AFTER_E4, "e5", 300, 100, 200), stats(AFTER_E4, "c5", 150, 100, 150)]);
  const afterE4e5 = play(AFTER_E4, "e5");
  add(afterE4e5, [stats(afterE4e5, "Nf3", 1800, 700, 1500), stats(afterE4e5, "Bc4", 100, 100, 100)]);
  const afterNf3 = play(afterE4e5, "Nf3");
  add(afterNf3, [stats(afterNf3, "Nc6", 1500, 500, 1000), stats(afterNf3, "Nf6", 300, 200, 500)]);
  const afterBc4 = play(afterE4e5, "Bc4");
  add(afterBc4, [stats(afterBc4, "Nf6", 100, 100, 100)]);
  const afterD4 = play(START_FEN, "d4");
  add(afterD4, [stats(afterD4, "d5", 400, 200, 400)]);
  return { tree, afterE4: AFTER_E4, afterE4e5 };
}

class Harness {
  worker: InsightsWorker;
  progress: [number, string][] = [];
  results: [number, NotableMove][] = [];
  finished: InsightsSummary[] = [];

  constructor(client: ExplorerSource) {
    this.worker = new InsightsWorker(client);
  }

  start(p: InsightsParams, start = START_FEN, rootFen = START_FEN, prefix: string[] = []): number {
    return this.worker.start(p, start, rootFen, prefix, {
      onProgress: (rid, msg) => this.progress.push([rid, msg]),
      onResult: (rid, nm) => this.results.push([rid, nm]),
      onFinished: (s) => this.finished.push(s),
    });
  }

  async run(p: InsightsParams, start = START_FEN, rootFen = START_FEN, prefix: string[] = []): Promise<number> {
    const id = this.start(p, start, rootFen, prefix);
    await this.worker.wait();
    return id;
  }
}

describe("InsightsWorker", () => {
  it("judges only our moves, prunes and visits each position once", async () => {
    const { tree, afterE4, afterE4e5 } = buildTree();
    const client = new FakeClient(tree);
    const h = new Harness(client);
    const runId = await h.run(params({ minGames: 20, deltaPp: 5, topN: 1 }));
    const summary = h.finished[0];
    expect(summary.runId).toBe(runId);
    expect(summary.stopped).toBe(false);
    expect(summary.error).toBeNull();
    expect(h.results.map(([, nm]) => [nm.san, nm.line])).toEqual([["Nf3", ["e2e4", "e7e5"]]]);
    expect(summary.found).toBe(1);
    expect(summary.depth).toBe(4);
    expect(summary.limit).toBe("");
    expect(h.progress.at(-1)![1].endsWith("positions, 4 plies deep")).toBe(true);
    expect(client.requests).toContain(epd(afterE4));
    expect(client.requests).toContain(epd(afterE4e5));
    expect(client.requests).not.toContain(epd(play(afterE4, "c5")));
    expect(new Set(client.requests).size).toBe(client.requests.length);
    expect(h.results.every(([rid]) => rid === runId)).toBe(true);
    const nm = h.results[0][1];
    expect(positionMoves(nm)).toEqual(["e2e4", "e7e5"]);
    expect(nm.move).toBe("g1f3");
    expect(nm.games).toBe(4000);
    expect(nm.positionGames).toBe(4300);
    expect(nm.popularityRank).toBe(1);
    expect(playPct(nm)).toBeCloseTo((4000 / 4300) * 100, 10);
    expect(Math.abs(nm.scorePct - 53.75)).toBeLessThanOrEqual(0.06);
    expect(nm.scoreGames).toBe(4000);
    expect(nm.bestReplySan).toBe("Nf6");
    expect(nm.bestReplyShare).toBe(25);
    expect(nm.bestReplyPct).toBe(40);
    expect(Math.abs(nm.challengePp - 10.3)).toBeLessThanOrEqual(0.1);
  });

  it("carries prefix moves and starts from the given position", async () => {
    const { tree, afterE4 } = buildTree();
    const client = new FakeClient(tree);
    const h = new Harness(client);
    await h.run(params({ minGames: 20 }), afterE4, START_FEN, ["e2e4"]);
    expect(client.requests[0]).toBe(epd(afterE4));
    expect(h.results.map(([, nm]) => nm.san)).toEqual(["Nf3"]);
    for (const [, nm] of h.results) {
      expect(nm.prefixMoves).toEqual(["e2e4"]);
      expect(nm.rootFen).toBe(START_FEN);
    }
  });

  it("caps limit the crawl", async () => {
    const { tree } = buildTree();
    const h = new Harness(new FakeClient(tree));
    await h.run(params({ minGames: 1, maxPositions: 1 }));
    expect(h.finished[0]).toMatchObject({ positions: 1, limit: "position limit", depth: 0 });
    const h2 = new Harness(new FakeClient(tree));
    await h2.run(params({ minGames: 1, maxDepth: 0 }));
    expect(h2.finished[0]).toMatchObject({ positions: 1, limit: "", depth: 0 });
  });

  it("stop reports stopped and sends no late results", async () => {
    const { tree } = buildTree();
    const h = new Harness(new FakeClient(tree));
    const runId = h.start(params({ minGames: 1, minInterval: 0.2 }));
    await new Promise((r) => setTimeout(r, 50));
    h.worker.stop();
    const resultsAtStop = h.results.length;
    await h.worker.wait();
    expect(h.finished).toHaveLength(1);
    expect(h.finished[0].stopped).toBe(true);
    expect(h.finished[0].runId).toBe(runId);
    expect(h.finished[0].positions).toBeLessThanOrEqual(2);
    expect(h.results.length).toBe(resultsAtStop);
    expect(h.worker.running).toBe(false);
  });

  it("an auth error ends the run with a message", async () => {
    const { tree } = buildTree();
    const client = new FakeClient(tree, new Map([[epd(START_FEN), new LichessAuthError("bad token")]]));
    const h = new Harness(client);
    await h.run(params());
    expect(h.finished[0].error).toBe("bad token");
    expect(h.finished[0].positions).toBe(0);
  });

  it("rate limits wait then retry; unavailable positions are skipped", async () => {
    const { tree, afterE4 } = buildTree();
    const client = new FakeClient(
      tree,
      new Map<string, Error>([
        [epd(START_FEN), new LichessRateLimited(0.05)],
        [epd(afterE4), new LichessUnavailable("503")],
      ]),
    );
    const h = new Harness(client);
    await h.run(params({ minGames: 20 }));
    expect(h.progress.some(([, msg]) => msg.includes("Rate limited"))).toBe(true);
    expect(h.progress.some(([, msg]) => msg.includes("Skipped"))).toBe(true);
    expect(client.requests.filter((r) => r === epd(START_FEN))).toHaveLength(2);
    expect(h.finished[0].stopped).toBe(false);
    expect(h.finished[0].error).toBeNull();
  });

  it("a new start supersedes the previous run", async () => {
    const { tree } = buildTree();
    const h = new Harness(new FakeClient(tree));
    const first = h.start(params({ minGames: 1, minInterval: 0.3 }));
    const second = await h.run(params({ minGames: 1 }));
    await new Promise((r) => setTimeout(r, 20)); // let the first run's finish land
    expect(second).toBe(first + 1);
    const ids = new Set(h.finished.map((s) => s.runId));
    expect(ids.has(second)).toBe(true);
    expect(h.finished.filter((s) => s.runId === first).every((s) => s.stopped)).toBe(true);
  });

  it("a transposition is explored once", async () => {
    // 1.Nf3 Nf6 2.Nc3 and 1.Nc3 Nf6 2.Nf3 reach the same position.
    const tree = new Map<string, ExplorerResult>();
    const add = (fen: string, moves: MoveStats[]) => tree.set(epd(fen), position(fen, moves));
    add(START_FEN, [stats(START_FEN, "Nf3", 50, 0, 50), stats(START_FEN, "Nc3", 50, 0, 50)]);
    const a = play(START_FEN, "Nf3");
    const b = play(START_FEN, "Nc3");
    add(a, [stats(a, "Nf6", 50, 0, 50)]);
    add(b, [stats(b, "Nf6", 50, 0, 50)]);
    add(play(a, "Nf6"), [stats(play(a, "Nf6"), "Nc3", 50, 0, 50)]);
    add(play(b, "Nf6"), [stats(play(b, "Nf6"), "Nf3", 50, 0, 50)]);
    const client = new FakeClient(tree);
    const h = new Harness(client);
    await h.run(params({ minGames: 1, maxDepth: 3 }));
    const joined = epd(after(play(a, "Nf6"), "b1c3")!);
    expect(client.requests.filter((r) => r === joined)).toHaveLength(1);
  });
});
