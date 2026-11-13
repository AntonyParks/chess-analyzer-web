import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { START_FEN, epd, moveToUci } from "../src/core/chess";
import * as rp from "../src/core/repertoire";

/** UCI moves for SAN moves played from ``start``. */
function line(sans: string[], start: string = START_FEN): string[] {
  const g = new Chess(start);
  return sans.map((san) => moveToUci(g.move(san)));
}

function fenAfter(...sans: string[]): string {
  const g = new Chess();
  for (const san of sans) g.move(san);
  return g.fen();
}

const epdAfter = (...sans: string[]): string => epd(fenAfter(...sans));

function whiteRep(): rp.Repertoire {
  const rep = new rp.Repertoire("w");
  rep.addLine(START_FEN, line(["d4", "d5", "c4", "e6", "Nc3"]));
  rep.addLine(START_FEN, line(["d4", "Nf6", "c4"]));
  return rep;
}

/** Seeded PRNG in [0, 1). */
function mulberry32(seed: number): rp.Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Play a UCI move on a FEN. */
function push(fen: string, uci: string): string {
  const g = new Chess(fen);
  g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return g.fen();
}

describe("Repertoire", () => {
  it("adds lines with one move per user position", () => {
    const rep = whiteRep();
    expect(rep.userMove(rp.ROOT_EPD)).toBe("d2d4");
    expect(new Set(rep.movesAt(epdAfter("d4")).keys())).toEqual(new Set(["d7d5", "g8f6"]));
    expect(rep.size()).toBe(7);
    expect(rep.conflict(START_FEN, line(["e4"]))).toEqual(["d4", "e4"]);
    expect(() => rep.addLine(START_FEN, line(["e4", "e5"]))).toThrow();
    rep.addLine(START_FEN, line(["e4", "e5"]), { replace: true });
    expect(rep.userMove(rp.ROOT_EPD)).toBe("e2e4");
    expect(rep.nodes.has(epdAfter("d4"))).toBe(false); // the old subtree is pruned
    expect(new Set(rep.cards.keys())).toEqual(new Set([rp.ROOT_EPD])); // cards only where you move
  });

  it("requires a line to start from the initial position", () => {
    const start = fenAfter("e4");
    expect(() => new rp.Repertoire("w").addLine(start, line(["e5"], start))).toThrow();
  });

  it("shares a node between transpositions and reports them", () => {
    const rep = new rp.Repertoire("b");
    rep.addLine(START_FEN, line(["d4", "d5", "c4", "e6"]));
    const fen = fenAfter("c4", "e6", "d4");
    // 1.c4 e6 2.d4 d5 reaches 1.d4 d5 2.c4 e6: d5 joins the line.
    expect(rep.transposition(fen, "d7d5")).toEqual(["d2d4", "d7d5", "c2c4", "e7e6"]);
    expect(rep.transposition(START_FEN, "d2d4")).toBeNull(); // prepared
    rep.addLine(START_FEN, line(["c4", "e6", "d4", "d5"]));
    expect(rep.contains(epdAfter("d4", "d5", "c4", "e6"))).toBe(true);
    expect(rep.pathTo(epdAfter("c4", "e6", "d4", "d5"))).toEqual(["d2d4", "d7d5", "c2c4", "e7e6"]);
  });

  it("prunes unreachable positions and cards on remove", () => {
    const rep = whiteRep();
    rep.remove(epdAfter("d4"), "d7d5");
    expect(rep.nodes.has(epdAfter("d4", "d5"))).toBe(false);
    expect(rep.cards.has(epdAfter("d4", "d5", "c4", "e6"))).toBe(false);
    expect(rep.pathTo(epdAfter("d4", "Nf6"))).toEqual(["d2d4", "g8f6"]);
    expect(rep.pathTo(epdAfter("d4", "d5"))).toBeNull();
  });

  it("finds gaps following explorer shares", () => {
    const rep = whiteRep();
    rep.recordStats(epdAfter("d4"), 1000, [
      ["g8f6", "Nf6", 500],
      ["d7d5", "d5", 300],
      ["e7e6", "e6", 150],
      ["c7c5", "c5", 5],
    ]);
    rep.recordStats(epdAfter("d4", "Nf6", "c4"), 100, [
      ["e7e6", "e6", 60],
      ["g7g6", "g6", 40],
    ]);
    const gaps = rep.gaps(50);
    const found = new Set(gaps.map((g) => `${g.san}:${Math.round(g.chance * 1000) / 1000}`));
    expect(found.has("e6:0.15")).toBe(true);
    expect(found.has("e6:0.3") && found.has("g6:0.2")).toBe(true); // after 1.d4 Nf6 2.c4
    expect(gaps.every((g) => g.san !== "c5")).toBe(true); // 0.5 %: under 1 in 50
    expect(gaps[0].chance).toBe(Math.max(...gaps.map((g) => g.chance)));
    expect(gaps[0].path).toEqual(["d2d4", "g8f6", "c2c4"]);
    expect(rep.missingStats()).toContain(epdAfter("d4", "d5", "c4"));
  });

  it("treats a line ending after an opponent move as a gap", () => {
    const rep = new rp.Repertoire("b");
    rep.addLine(START_FEN, line(["e4", "c5", "Nf3"]));
    const gaps = rep.gaps();
    expect(gaps.some((g) => g.uci === null && g.epd === epdAfter("e4", "c5", "Nf3"))).toBe(true);
  });

  it("schedules cards", () => {
    const rep = whiteRep();
    const e = rp.ROOT_EPD;
    const card = rep.cards.get(e)!;
    expect(!card.learned && rep.due(0).includes(e)).toBe(true);
    rep.grade(e, true, 0);
    expect(card.interval).toBe(1);
    expect(card.due).toBe(rp.DAY);
    rep.grade(e, true, 0);
    expect(card.interval).toBe(3);
    rep.grade(e, true, 0);
    expect(card.interval).toBe(7.5);
    rep.grade(e, false, 100);
    expect([card.interval, card.due, card.ease, card.lapses]).toEqual([0, 100, 2.3, 1]);
  });

  it("chooses replies weighted by games, and toward targets", () => {
    const rep = whiteRep();
    rep.recordStats(epdAfter("d4"), 1000, [
      ["g8f6", "Nf6", 900],
      ["d7d5", "d5", 100],
    ]);
    const rng = mulberry32(1);
    const picks = Array.from({ length: 500 }, () => rep.chooseReply(epdAfter("d4"), rng));
    const share = picks.filter((p) => p === "g8f6").length / 500;
    expect(share).toBeGreaterThan(0.8);
    expect(share).toBeLessThan(0.97);
    const target = new Set([epdAfter("d4", "d5", "c4", "e6")]);
    const chosen = new Set(Array.from({ length: 20 }, () => rep.chooseReply(epdAfter("d4"), rng, target)));
    expect(chosen).toEqual(new Set(["d7d5"]));
  });

  it("walks a training session to due cards and retries misses", () => {
    const rep = whiteRep();
    for (const e of rep.cards.keys()) rep.markLearned(e);
    const session = new rp.TrainSession(rep, { rng: mulberry32(0), now: 0 });
    const seen: [string, boolean][] = [];
    let missedOnce = false;
    let fen = session.startLine();
    let guard = 0;
    while (fen !== null && guard++ < 1000) {
      const step = session.step(fen);
      if (step.kind === "opponent") {
        fen = push(fen, step.uci!);
      } else if (step.kind === "user") {
        const e = epd(fen);
        const correct: boolean = e !== rp.ROOT_EPD || missedOnce;
        missedOnce = missedOnce || !correct;
        seen.push([e, correct]);
        session.answer(e, correct);
        fen = push(fen, step.uci!);
      } else {
        fen = session.startLine();
      }
    }
    expect(fen).toBeNull();
    expect(session.missed).toBe(1);
    expect(seen).toContainEqual([rp.ROOT_EPD, false]);
    expect(seen).toContainEqual([rp.ROOT_EPD, true]);
    expect(new Set(seen.map(([e]) => e))).toEqual(new Set(rep.cards.keys()));
    expect(rep.cards.get(rp.ROOT_EPD)!.lapses).toBe(1);
  });

  it("shows new cards before asking them", () => {
    const rep = new rp.Repertoire("w");
    rep.addLine(START_FEN, line(["e4"]));
    const session = new rp.TrainSession(rep, { now: 0 });
    let fen = session.startLine()!;
    const step = session.step(fen);
    expect(step.kind === "user" && step.learn).toBe(true);
    session.answer(epd(fen), true, { learnedNow: true });
    fen = session.startLine()!; // the retry pass asks it without the answer
    expect(fen).not.toBeNull();
    expect(session.step(fen).learn).toBe(false);
  });

  it("finds the first deviation of a game", () => {
    const rep = whiteRep();
    const ok = rep.checkGame("g1", START_FEN, line(["d4", "d5", "c4", "e6", "Nc3", "Nf6"]));
    expect(ok).toBeNull(); // the game ran past the end of the repertoire
    const opp = rep.checkGame("g2", START_FEN, line(["d4", "f5", "c4"]));
    expect(opp).not.toBeNull();
    expect([opp!.byUser, opp!.playedSan, opp!.ply]).toEqual([false, "f5", 1]);
    const me = rep.checkGame("g3", START_FEN, line(["d4", "d5", "Nf3"]))!;
    expect([me.byUser, me.playedSan, me.expectedSan]).toEqual([true, "Nf3", "c4"]);
  });
});

describe("RepertoireStore", () => {
  it("round-trips through JSON and rejects corrupt input", () => {
    const store = new rp.RepertoireStore();
    store.white.addLine(START_FEN, line(["e4", "e5", "Nf3"]));
    store.white.recordStats(epdAfter("e4"), 10, [["e7e5", "e5", 7]]);
    store.white.grade(rp.ROOT_EPD, true, 0);
    store.black.addLine(START_FEN, line(["e4", "c5"]));
    const again = rp.RepertoireStore.fromJSON(JSON.stringify(store));
    expect(again.white.userMove(rp.ROOT_EPD)).toBe("e2e4");
    expect(again.white.cards.get(rp.ROOT_EPD)!.interval).toBe(1);
    expect(again.white.stats.get(epdAfter("e4"))!.games("e7e5")).toBe(7);
    expect(again.black.userMove(epdAfter("e4"))).toBe("c7c5");
    expect(again.get("w")).toBe(again.white);
    expect(() => rp.RepertoireStore.fromJSON("{oops")).toThrow();
    expect(() => rp.RepertoireStore.fromJSON([])).toThrow();
    expect(() => rp.RepertoireStore.fromJSON({ white: { nodes: [] } })).toThrow();
    expect(() => rp.RepertoireStore.fromJSON({ white: { cards: { x: [1, 2] } } })).toThrow();
    expect(() => rp.RepertoireStore.fromJSON({ white: { stats: { x: [1] } } })).toThrow();
    expect(() => rp.RepertoireStore.fromJSON({ black: { nodes: { x: { a: 1 } } } })).toThrow();
  });

  it("imports a desktop repertoire.json unchanged", () => {
    // Written by the desktop app's RepertoireStore.save().
    const desktop =
      '{"version":1,"white":{"nodes":{"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -":{"e2e4":"e4"},"rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -":{"e7e5":"e5","c7c5":"c5"},"rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -":{"g1f3":"Nf3"},"rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -":{"b8c6":"Nc6"},"r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -":{"f1b5":"Bb5"},"rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -":{"g1f3":"Nf3"},"rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -":{"d7d6":"d6"},"rnbqkbnr/pp2pppp/3p4/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -":{"d2d4":"d4"},"rnbqkbnr/pp2pppp/3p4/2p5/3PP3/5N2/PPP2PPP/RNBQKB1R b KQkq -":{"c5d4":"cxd4"},"rnbqkbnr/pp2pppp/3p4/8/3pP3/5N2/PPP2PPP/RNBQKB1R w KQkq -":{"f3d4":"Nxd4"},"rnbqkbnr/pp2pppp/3p4/8/3NP3/8/PPP2PPP/RNBQKB1R b KQkq -":{"g8f6":"Nf6"},"rnbqkb1r/pp2pppp/3p1n2/8/3NP3/8/PPP2PPP/RNBQKB1R w KQkq -":{"b1c3":"Nc3"}},"stats":{"rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -":[1000,{"e7e5":["e5",450],"c7c5":["c5",400]}]},"cards":{"r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -":[0.0,2.5,0.0,0,0,false],"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -":[0.0,2.3,1700300000.0,3,1,true],"rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -":[0.0,2.5,0.0,0,0,false],"rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -":[0.0,2.5,0.0,0,0,false],"rnbqkb1r/pp2pppp/3p1n2/8/3NP3/8/PPP2PPP/RNBQKB1R w KQkq -":[0.0,2.5,0.0,0,0,false],"rnbqkbnr/pp2pppp/3p4/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -":[0.0,2.5,0.0,0,0,false],"rnbqkbnr/pp2pppp/3p4/8/3pP3/5N2/PPP2PPP/RNBQKB1R w KQkq -":[0.0,2.5,0.0,0,0,false]}},"black":{"nodes":{"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -":{"d2d4":"d4","e2e4":"e4"},"rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq -":{"g8f6":"Nf6"},"rnbqkb1r/pppppppp/5n2/8/3P4/8/PPP1PPPP/RNBQKBNR w KQkq -":{"c2c4":"c4"},"rnbqkb1r/pppppppp/5n2/8/2PP4/8/PP2PPPP/RNBQKBNR b KQkq -":{"e7e6":"e6"},"rnbqkb1r/pppp1ppp/4pn2/8/2PP4/8/PP2PPPP/RNBQKBNR w KQkq -":{"b1c3":"Nc3"},"rnbqkb1r/pppp1ppp/4pn2/8/2PP4/2N5/PP2PPPP/R1BQKBNR b KQkq -":{"f8b4":"Bb4"},"rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -":{"e7e5":"e5"},"rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -":{"g1f3":"Nf3"},"rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -":{"b8c6":"Nc6"}},"stats":{},"cards":{"rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq -":[0.0,2.5,0.0,0,0,false],"rnbqkb1r/pppp1ppp/4pn2/8/2PP4/2N5/PP2PPPP/R1BQKBNR b KQkq -":[0.0,2.5,0.0,0,0,false],"rnbqkb1r/pppppppp/5n2/8/2PP4/8/PP2PPPP/RNBQKBNR b KQkq -":[0.0,2.5,0.0,0,0,false],"rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -":[0.0,2.5,0.0,0,0,false],"rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -":[0.0,2.5,0.0,0,0,false]}}}';
    const store = rp.RepertoireStore.fromJSON(JSON.parse(desktop));
    const out = JSON.parse(JSON.stringify(store.toJSON()));
    expect(out).toEqual(JSON.parse(desktop));
    // Key order is kept too (the user's move per position is the first key).
    expect(JSON.stringify(out.white.nodes)).toBe(JSON.stringify(JSON.parse(desktop).white.nodes));
    expect(store.white.userMove(rp.ROOT_EPD)).toBe("e2e4");
    expect(store.white.cards.get(rp.ROOT_EPD)!.lapses).toBe(1);
    // Every EPD the desktop wrote is one this port computes for the same position.
    expect(store.white.size()).toBe(13);
    expect(store.black.contains(epdAfter("d4", "Nf6", "c4", "e6", "Nc3", "Bb4"))).toBe(true);
  });
});
