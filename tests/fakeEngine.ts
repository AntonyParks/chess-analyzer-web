/**
 * A UCI engine that answers at once with a one-ply material count (like tests/fakes.py).
 * Scores are from the side to move; MultiPV searches score each root move.
 */
import { Chess } from "chess.js";
import { moveToUci, parseUci } from "../src/core/chess";
import type { UciEngine } from "../src/engine/uci";

const VALUES: Record<string, number> = { p: 100, n: 300, b: 300, r: 500, q: 900, k: 0 };

export function material(game: Chess, side: "w" | "b"): number {
  let total = 0;
  for (const row of game.board()) {
    for (const sq of row) if (sq) total += (sq.color === side ? 1 : -1) * VALUES[sq.type];
  }
  return total;
}

export class FakeEngine implements UciEngine {
  commands: string[] = [];
  private listeners: ((line: string) => void)[] = [];
  private fen = "";
  private multipv = 1;
  /** Score (side to move) for a FEN searched to ``depth``; override in tests. */
  scoreFor: (fen: string, depth: number) => number = (fen) => {
    const g = new Chess(fen);
    return material(g, g.turn());
  };

  send(command: string): void {
    this.commands.push(command);
    const emit = (line: string) => setTimeout(() => this.listeners.forEach((l) => l(line)), 0);
    if (command === "uci") {
      emit("id name FakeFish");
      emit("uciok");
    } else if (command === "isready") {
      emit("readyok");
    } else if (command.startsWith("setoption name MultiPV value ")) {
      this.multipv = Number(command.split(" ").pop());
    } else if (command.startsWith("position fen ")) {
      this.fen = command.slice(13);
    } else if (command.startsWith("go depth ")) {
      const parts = command.split(" ");
      const depth = Number(parts[2]);
      const sm = parts.indexOf("searchmoves");
      const only = sm >= 0 ? parts.slice(sm + 1) : null;
      const game = new Chess(this.fen);
      const moves = game
        .moves({ verbose: true })
        .map(moveToUci)
        .filter((u) => !only || only.includes(u));
      if (this.multipv > 1 || only) {
        const scored = moves.map((u) => {
          const g = new Chess(this.fen);
          g.move(parseUci(u));
          return { u, s: -this.scoreFor(g.fen(), depth - 1) };
        });
        scored.sort((a, b) => b.s - a.s);
        scored
          .slice(0, this.multipv)
          .forEach((m, i) => emit(`info depth ${depth} multipv ${i + 1} score cp ${m.s} nodes 10 pv ${m.u}`));
        emit(`bestmove ${scored[0]?.u ?? "(none)"}`);
      } else {
        const best = moves[0];
        const score = this.scoreFor(this.fen, depth);
        emit(`info depth ${depth} score cp ${score} pv ${best ?? ""}`.trim());
        emit(`bestmove ${best ?? "(none)"}`);
      }
    }
  }

  onLine(listener: (line: string) => void): void {
    this.listeners.push(listener);
  }

  terminate(): void {}
}
