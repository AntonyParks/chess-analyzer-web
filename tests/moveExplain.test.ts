import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { START_FEN, legalUcis, moveToUci } from "../src/core/chess";
import { explainLine, explainMove } from "../src/core/moveExplain";

/** FEN after playing ``sans`` from ``fen``. */
function play(sans: string[], fen: string = START_FEN): string {
  const g = new Chess(fen);
  for (const san of sans) g.move(san);
  return g.fen();
}

function explain(fen: string, san: string): string {
  const m = new Chess(fen).move(san);
  return explainMove(fen, moveToUci(m));
}

describe("explainMove", () => {
  it("castling mentions side and check", () => {
    const fen = play(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]);
    expect(explain(fen, "O-O")).toBe("Castles kingside");
    // The rook lands on f1 and checks a king on f8.
    expect(explain("5k2/8/8/8/8/8/8/4K2R w K - 0 1", "O-O")).toBe("Castles kingside  ·  Gives check");
  });

  it("minor takes defended rook wins the exchange", () => {
    expect(explain("4k3/8/4p3/3r4/8/4N3/8/4K3 w - - 0 1", "Nxd5")).toContain("Wins the exchange");
  });

  it("rook takes defended minor is not a win", () => {
    const note = explain("4k3/8/4p3/3n4/8/8/8/3RK3 w - - 0 1", "Rxd5");
    expect(note.startsWith("Captures Knight")).toBe(true);
    expect(note).not.toContain("Wins");
  });

  it("free piece and equal trade", () => {
    expect(explain("4k3/8/8/3n4/4P3/8/8/4K3 w - - 0 1", "exd5").startsWith("Takes free Knight")).toBe(true);
    expect(explain("6k1/1p6/2n5/1B6/3r4/8/8/3R2K1 w - - 0 1", "Bxc6")).toContain("Trades Knight");
  });

  it("removing the defender is about the opponent's piece", () => {
    // Bxc6 removes the knight that defended the rook on d4, which Rd1 attacks.
    expect(explain("6k1/1p6/2n5/1B6/3r4/8/8/3R2K1 w - - 0 1", "Bxc6")).toContain("Removes the defender of Rook");
  });

  it("royal fork is reported even though it gives check", () => {
    const note = explain("q3k3/8/8/1N6/8/8/8/4K3 w - - 0 1", "Nc7+");
    expect(note).toContain("Gives check");
    expect(note).toContain("Forks King and Queen");
  });

  it("fork ignores defended pieces of equal value", () => {
    // A knight hitting two defended bishops is not a fork worth the name.
    expect(explain("4k3/2p1p3/1b3b2/8/2N5/8/8/4K3 w - - 0 1", "Nd6+")).not.toContain("Forks");
  });

  it("skewer walks the whole ray", () => {
    expect(explain("4k2b/8/8/8/8/8/8/R3K3 w - - 0 1", "Ra8+")).toContain("Skewers King to win Bishop");
  });

  it("outpost requires pawn support and no challenging pawn", () => {
    expect(explain("4k3/p6p/8/8/4P3/2N5/8/4K3 w - - 0 1", "Nd5")).toContain("Establishes outpost");
    // A black pawn on c7 can come to c6 and kick the knight: no outpost.
    expect(explain("4k3/p1p4p/8/8/4P3/2N5/8/4K3 w - - 0 1", "Nd5")).not.toContain("Establishes outpost");
    // No supporting pawn: no outpost.
    expect(explain("4k3/p6p/8/8/8/2N5/8/4K3 w - - 0 1", "Nd5")).not.toContain("Establishes outpost");
  });

  it("promotion is not a new passed pawn", () => {
    const note = explain("4k3/P7/8/8/8/8/8/4K3 w - - 0 1", "a8=Q+");
    expect(note).toContain("Promotes to Queen");
    expect(note).not.toContain("passed pawn");
  });

  it("passed pawn only when newly passed", () => {
    expect(explain("4k3/8/8/8/1p6/8/P7/4K3 w - - 0 1", "a4")).toContain("Creates passed pawn");
    expect(explain("4k3/8/8/P7/8/8/8/4K3 w - - 0 1", "a6")).not.toContain("Creates passed pawn");
  });

  it("pawn capture opens the file it left", () => {
    expect(explain("4k3/8/8/3n4/4P3/8/8/4K3 w - - 0 1", "exd5")).toContain("Opens the e-file");
  });

  it("capturing a pawn can open its file", () => {
    expect(explain("4k3/8/8/3p4/8/8/8/3RK3 w - - 0 1", "Rxd5")).toContain("Opens the d-file");
  });

  it("development and center", () => {
    expect(explain(START_FEN, "e4")).toContain("Controls center");
    expect(explain(play(["e4", "e5"]), "Nf3")).toContain("Develops Knight");
  });

  it("checkmate and discovered check", () => {
    expect(explain("r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4", "Qxf7#")).toBe(
      "Checkmate!",
    );
    // Moving the bishop off the e-file uncovers the rook's check (Bb5 would be a double check).
    expect(explain("4k3/8/8/8/8/8/4B3/4RK2 w - - 0 1", "Bd3+")).toContain("Discovered check");
    expect(explain("4k3/8/8/8/8/8/4B3/4RK2 w - - 0 1", "Bb5+")).toContain("Double check!");
  });

  it("illegal move is empty", () => {
    expect(explainMove(START_FEN, "e2e5")).toBe("");
  });

  it.each([START_FEN, "4k3/8/8/8/8/8/8/4K3 w - - 0 1"])("every legal move has a note (%s)", (fen) => {
    for (const uci of legalUcis(fen)) expect(explainMove(fen, uci)).toBeTruthy();
  });
});

describe("explainLine", () => {
  it("stops at the illegal move", () => {
    const lines = explainLine(START_FEN, ["e2e4", "e7e5", "e2e4"]).split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0].startsWith("▶ 1. e4:")).toBe(true);
    expect(lines[1].startsWith("  1... e5:")).toBe(true);
  });
});
