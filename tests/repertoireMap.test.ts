import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { START_FEN, epd, moveToUci } from "../src/core/chess";
import { Repertoire } from "../src/core/repertoire";
import { ancestryOf, buildMap, findNode, type MapNode } from "../src/core/repertoireMap";

function line(sans: string[]): string[] {
  const g = new Chess();
  return sans.map((san) => moveToUci(g.move(san)));
}
const epdAfter = (...sans: string[]) => {
  const g = new Chess();
  sans.forEach((s) => g.move(s));
  return epd(g.fen());
};
const kids = (n: MapNode) => n.children.map((k) => [k.kind, k.san, Number(k.share.toFixed(3))]);

describe("repertoire sunburst", () => {
  const withCounts = () => {
    const rep = new Repertoire("w");
    rep.addLine(START_FEN, line(["e4", "e5", "Nf3"]));
    const [e5, c5, nc6, a6] = line(["e4", "e5"]).slice(1).concat(["c7c5", "b8c6", "a7a6"]);
    rep.recordStats(epdAfter("e4"), 1000, [
      [e5, "e5", 500],
      [c5, "c5", 300],
      [nc6, "Nc6", 50],
      [a6, "a6", 5],
    ]);
    return rep;
  };

  it("sizes replies by how often they are played and sorts them into prepared, gaps and rare", () => {
    const { root, summary } = buildMap(withCounts(), 50);
    const e4 = root.children[0];
    expect(kids(root)).toEqual([["you", "e4", 1]]);
    expect(kids(e4)).toEqual([
      ["opp", "e5", 0.5],
      ["gap", "c5", 0.3],
      ["gap", "Nc6", 0.05],
      ["rare", "Rarer replies", 0.15], // a6 (0.5%) and the 14.5% Lichess did not list
    ]);
    expect(e4.children[0].children.map((k) => k.san)).toEqual(["Nf3"]);
    expect(summary.prepared).toBeCloseTo(0.5);
    expect(summary.gaps).toBeCloseTo(0.35);
    expect(summary.rare).toBeCloseTo(0.15);
    // Angles follow the shares.
    expect([e4.children[1].a0, e4.children[1].a1]).toEqual([0.5, 0.8]);
  });

  it("splits evenly while counts are missing, and marks replies you have not answered", () => {
    const rep = new Repertoire("w");
    rep.addLine(START_FEN, line(["d4", "d5", "c4"]));
    rep.addLine(START_FEN, line(["d4", "Nf6"]));
    const { root, summary } = buildMap(rep);
    const d4 = root.children[0];
    expect(kids(d4)).toEqual([
      ["opp", "d5", 0.5],
      ["opp", "Nf6", 0.5],
    ]);
    expect(d4.children.every((k) => k.estimated)).toBe(true);
    expect(d4.children[1].open).toBe(true);
    expect(summary.gaps).toBeCloseTo(0.5);
    expect(summary.prepared).toBeCloseTo(0.5);
  });

  it("draws a transposed position once and ends the other move order in a joins leaf", () => {
    const rep = new Repertoire("w");
    rep.addLine(START_FEN, line(["e4", "e5", "Nf3", "Nc6", "Bc4"]));
    rep.addLine(START_FEN, line(["e4", "Nc6", "Nf3", "e5", "Bc4"]));
    const { root } = buildMap(rep);
    const joined = findNode(root, line(["e4", "Nc6", "Nf3", "e5"]).join(" "))!;
    expect(joined.joins).toEqual(line(["e4", "e5", "Nf3", "Nc6"]));
    expect(joined.children).toEqual([]);
    expect(ancestryOf(root, joined.id)!.map((n) => n.san)).toEqual(["Start", "e4", "Nc6", "Nf3", "e5"]);
  });

  it("starts from the opponent's first moves in a Black repertoire", () => {
    const rep = new Repertoire("b");
    rep.addLine(START_FEN, line(["e4", "c5"]));
    rep.addLine(START_FEN, line(["d4", "Nf6"]));
    const { root } = buildMap(rep);
    expect(kids(root)).toEqual([
      ["opp", "e4", 0.5],
      ["opp", "d4", 0.5],
    ]);
    expect(root.children[0].children[0].kind).toBe("you");
  });

  it("ends a line at your last move, even where Lichess has counts for the replies", () => {
    const rep = withCounts();
    const [d6] = ["d7d6"];
    rep.recordStats(epdAfter("e4", "e5", "Nf3"), 100, [[d6, "d6", 60]]);
    const { root, summary } = buildMap(rep, 50);
    const nf3 = root.children[0].children[0].children[0];
    expect(nf3.children).toEqual([]);
    expect(summary.prepared).toBeCloseTo(0.5);
  });

  it("is empty for an empty repertoire", () => {
    const { root, summary } = buildMap(new Repertoire("w"));
    expect(root.children).toEqual([]);
    expect(summary.prepared + summary.gaps + summary.rare).toBe(0);
  });
});
