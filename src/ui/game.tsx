/**
 * The game on the analysis board, shared by Analyse, Review, Explorer, Insights and Repertoire
 * building, plus the live analysis of the shown position (the heatmap).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { board, epd, legalUcis, playUci, turnOf } from "../core/chess";
import { bestUci, rankMoves } from "../core/evaluation";
import { GameState, type PlyAnalysis } from "../core/gameState";
import { Kind } from "../engine/scheduler";
import type { Arrow } from "./Board";
import { useEngines } from "./engine";

export interface GameApi {
  game: GameState;
  /** Re-render after mutating ``game``. */
  touch: () => void;
  /** Bumps on every change (use in effect dependencies). */
  tick: number;
  thinking: boolean;
  play: (uci: string) => void;
  goto: (ply: number) => void;
  load: (state: GameState) => void;
  /** Moves were just played (animate) rather than jumped to. */
  animate: boolean;
  /** A position shown on the board without playing it (hovering a move in an engine line). */
  preview: Preview | null;
  setPreview: (p: Preview | null) => void;
  /** The position left on a page's own board (puzzles, training), for the analysis board to pick up. */
  carry: Carry;
}

export interface Carry {
  /** The board's starting position and the moves played on it since. */
  set: (start: string, moves: readonly string[]) => void;
  /** The carried position as a game, once; null if none. */
  take: () => GameState | null;
}

export interface Preview {
  fen: string;
  lastMove: string | null;
  arrows?: Arrow[];
}

const GameContext = createContext<GameApi | null>(null);

export function GameProvider({ children, depth, enabled }: { children: ReactNode; depth: number; enabled: boolean }) {
  const ref = useRef(new GameState());
  const [tick, setTick] = useState(0);
  const [animate, setAnimate] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const carried = useRef<{ start: string; moves: string[] } | null>(null);
  const carry = useMemo<Carry>(
    () => ({
      set: (start, moves) => void (carried.current = { start, moves: [...moves] }),
      take: () => {
        const c = carried.current;
        carried.current = null;
        if (!c) return null;
        const s = new GameState(c.start);
        const g = board(c.start);
        for (const uci of c.moves) {
          if (!playUci(g, uci)) break;
          s.push(uci);
        }
        return s;
      },
    }),
    [],
  );
  const touch = useCallback(() => setTick((t) => t + 1), []);
  const { main } = useEngines();

  const play = useCallback((uci: string) => {
    ref.current.push(uci);
    setAnimate(true);
    setTick((t) => t + 1);
  }, []);
  const goto = useCallback((ply: number) => {
    const g = ref.current;
    const target = Math.max(0, Math.min(ply, g.moves.length));
    setAnimate(target === g.currentPly + 1);
    g.goto(target);
    setTick((t) => t + 1);
  }, []);
  const load = useCallback((state: GameState) => {
    ref.current = state;
    setAnimate(false);
    setTick((t) => t + 1);
  }, []);

  // Analyse the shown position: one MultiPV search over every legal move, deepening.
  const game = ref.current;
  const fen = game.fen;
  const ply = game.currentPly;
  const version = game.version;
  // A preview belongs to the position it was taken from.
  useEffect(() => setPreview(null), [fen, version]);
  useEffect(() => {
    if (!main || !enabled) return;
    const existing = game.analysis.get(ply);
    if (existing?.complete && existing.depth >= depth) return;
    const moves = legalUcis(fen);
    if (!moves.length) {
      game.analysis.set(ply, { positionCp: game.terminalEval(ply), evals: {}, rankMap: {}, complete: true, depth });
      touch();
      return;
    }
    const key = epd(fen);
    const apply = (evals: PlyAnalysis["evals"], complete: boolean, d: number) => {
      const g = ref.current;
      if (epd(g.fenAt(ply)) !== key) return;
      const turn = turnOf(fen);
      const best = bestUci(evals, turn);
      g.analysis.set(ply, {
        positionCp: best ? evals[best].cpWhite : null,
        evals,
        rankMap: rankMoves(evals, turn),
        complete,
        depth: d,
      });
      setTick((t) => t + 1);
    };
    setThinking(true);
    const id = main.submit({
      kind: Kind.HEATMAP,
      fen,
      moves,
      depth,
      fromDepth: Math.min(8, depth),
      multipv: true,
      onProgress: (r) => apply(r.evals, false, r.depth),
      onDone: (r) => {
        apply(r.evals, r.complete, r.depth);
        setThinking(false);
      },
    });
    return () => {
      main.cancel(id);
      setThinking(false);
    };
  }, [main, enabled, fen, ply, version, depth, game, touch]);

  const value = useMemo<GameApi>(
    () => ({ game: ref.current, touch, tick, thinking, play, goto, load, animate, preview, setPreview, carry }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick, thinking, animate, preview],
  );
  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGame(): GameApi {
  const api = useContext(GameContext);
  if (!api) throw new Error("useGame outside GameProvider");
  return api;
}

/**
 * Records a page's own board (a puzzle, repertoire training) so the analysis board carries on
 * from it after a tab switch: the position the board started from and the moves played since.
 */
export function useCarryBoard(fen: string, lastMove: string | null) {
  const { carry } = useGame();
  const line = useRef<{ start: string; moves: string[]; fen: string } | null>(null);
  useEffect(() => {
    const l = line.current;
    let follows = false;
    if (l && lastMove) {
      const g = board(l.fen);
      follows = !!playUci(g, lastMove) && epd(g.fen()) === epd(fen);
    }
    if (l && follows) {
      l.moves.push(lastMove!);
      l.fen = fen;
    } else {
      line.current = { start: fen, moves: [], fen }; // a new line, or a jump
    }
    carry.set(line.current!.start, line.current!.moves);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, carry]);
}
