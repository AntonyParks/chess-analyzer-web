/**
 * The chess board: tap a piece then a square, or drag. Shows the last move, heatmap tints,
 * labels on target squares, arrows, flashes and a promotion picker. Pure view: the parent owns
 * the position and decides whether a move is accepted (``onMove`` returning false rejects it
 * with a red flash, which is how puzzles and training check answers).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FILES, legalUcis, squareIndex, squareName } from "../core/chess";
import type { Color } from "../core/evaluation";
import { PIECES } from "./pieces";

export interface Arrow {
  from: string;
  to: string;
  color: string;
}

export interface BoardProps {
  fen: string;
  orientation?: Color;
  lastMove?: string | null;
  /** Animate ``lastMove`` when the position changes (set for moves, not for navigation jumps). */
  animate?: boolean;
  movable?: Color | "both" | "none";
  onMove?: (uci: string) => boolean | void;
  onSelect?: (square: string | null) => void;
  /** square -> CSS colour behind the piece (the heatmap). */
  tints?: Record<string, string>;
  /** square -> small label (e.g. the eval of moving the selected piece there). */
  labels?: Record<string, { text: string; color: string }>;
  arrows?: Arrow[];
  /** Squares to flash; a new ``key`` restarts the flash. */
  flash?: { squares: string[]; kind: "good" | "bad"; key: number } | null;
}

interface DragState {
  from: number;
  id: number;
  x: number;
  y: number;
  moved: boolean;
}

export function Board(props: BoardProps) {
  const { fen, orientation = "w", lastMove, animate, movable = "both", onMove, onSelect } = props;
  const flipped = orientation === "b";
  const position = useMemo(() => parseBoard(fen), [fen]);
  const legal = useMemo(() => legalUcis(fen), [fen]);
  const turn = fen.split(" ")[1] as Color;
  const [selected, setSelected] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ squares: number[]; kind: "good" | "bad" } | null>(null);
  const [promo, setPromo] = useState<string[] | null>(null);
  const [drag, setDrag] = useState<{ from: number; x: number; y: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const [animFrom, setAnimFrom] = useState<Map<number, number> | null>(null);
  const prevFen = useRef(fen);

  // Animate the last move: start the moved pieces on their origin squares, then let CSS move them.
  useLayoutEffect(() => {
    if (prevFen.current === fen) return;
    prevFen.current = fen;
    setSelected(null);
    setPromo(null);
    if (!animate || !lastMove) {
      setAnimFrom(null);
      return;
    }
    const from = squareIndex(lastMove.slice(0, 2));
    const to = squareIndex(lastMove.slice(2, 4));
    const map = new Map<number, number>([[to, from]]);
    const piece = position[to];
    if (piece && piece.toLowerCase() === "k" && Math.abs((to % 8) - (from % 8)) === 2) {
      const base = Math.floor(from / 8) * 8;
      if (to % 8 === 6) map.set(base + 5, base + 7);
      else map.set(base + 3, base);
    }
    setAnimFrom(map);
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setAnimFrom(null)));
    return () => cancelAnimationFrame(raf);
  }, [fen, animate, lastMove, position]);

  useEffect(() => {
    if (!props.flash) return;
    setFlash({ squares: props.flash.squares.map(squareIndex), kind: props.flash.kind });
    const t = setTimeout(() => setFlash(null), props.flash.kind === "good" ? 1200 : 650);
    return () => clearTimeout(t);
  }, [props.flash]);

  const canMove = (sq: number): boolean => {
    const piece = position[sq];
    if (!piece || movable === "none" || !onMove) return false;
    const color: Color = piece === piece.toUpperCase() ? "w" : "b";
    if (color !== turn) return false;
    return movable === "both" || movable === color;
  };
  const targetsOf = (sq: number): number[] => {
    const name = squareName(sq);
    return [...new Set(legal.filter((u) => u.startsWith(name)).map((u) => squareIndex(u.slice(2, 4))))];
  };
  const targets = selected === null ? [] : targetsOf(selected);

  const select = (sq: number | null) => {
    setSelected(sq);
    onSelect?.(sq === null ? null : squareName(sq));
  };

  const attempt = (from: number, to: number): boolean => {
    const prefix = squareName(from) + squareName(to);
    const options = legal.filter((u) => u.slice(0, 4) === prefix);
    if (!options.length) return false;
    if (options.length > 1) {
      setPromo(options);
      return true;
    }
    submit(options[0]);
    return true;
  };

  const submit = (uci: string) => {
    setPromo(null);
    select(null);
    const ok = onMove?.(uci);
    if (ok === false) {
      setFlash({ squares: [squareIndex(uci.slice(0, 2)), squareIndex(uci.slice(2, 4))], kind: "bad" });
      setTimeout(() => setFlash(null), 650);
    }
  };

  const squareAt = (clientX: number, clientY: number): number | null => {
    const r = boardRef.current!.getBoundingClientRect();
    const c = Math.floor(((clientX - r.left) / r.width) * 8);
    const row = Math.floor(((clientY - r.top) / r.height) * 8);
    if (c < 0 || c > 7 || row < 0 || row > 7) return null;
    const file = flipped ? 7 - c : c;
    const rank = flipped ? row : 7 - row;
    return rank * 8 + file;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (promo) return;
    const sq = squareAt(e.clientX, e.clientY);
    if (sq === null) return;
    if (selected !== null && targets.includes(sq)) {
      attempt(selected, sq);
      return;
    }
    if (canMove(sq) && targetsOf(sq).length) {
      select(sq);
      dragRef.current = { from: sq, id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      boardRef.current!.setPointerCapture(e.pointerId);
    } else {
      select(null);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
    d.moved = true;
    const r = boardRef.current!.getBoundingClientRect();
    setDrag({ from: d.from, x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const endDrag = (e: React.PointerEvent, cancelled: boolean) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    if (!d.moved || cancelled) return;
    const to = squareAt(e.clientX, e.clientY);
    if (to !== null && to !== d.from && targetsOf(d.from).includes(to)) attempt(d.from, to);
  };

  const xy = (sq: number): [number, number] => {
    const f = sq % 8;
    const r = Math.floor(sq / 8);
    return flipped ? [7 - f, r] : [f, 7 - r];
  };
  const lastSquares = lastMove ? [squareIndex(lastMove.slice(0, 2)), squareIndex(lastMove.slice(2, 4))] : [];

  const cells = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const file = flipped ? 7 - col : col;
      const rank = flipped ? row : 7 - row;
      const sq = rank * 8 + file;
      const name = squareName(sq);
      const cls = ["sq", (file + rank) % 2 ? "l" : "d"];
      if (lastSquares.includes(sq)) cls.push("last");
      if (selected === sq) cls.push("sel");
      if (flash?.squares.includes(sq)) cls.push(flash.kind === "bad" ? "fb" : "fg");
      if (targets.includes(sq)) cls.push(position[sq] ? "cap" : "dot");
      const tint = props.tints?.[name];
      const label = props.labels?.[name];
      cells.push(
        <div key={sq} className={cls.join(" ")}>
          {tint && <div className="tint" style={{ background: tint }} />}
          <div className="mark" />
          {col === 0 && <span className="coord r">{rank + 1}</span>}
          {row === 7 && <span className="coord f">{FILES[file]}</span>}
          {label && (
            <span className="label" style={{ color: label.color }}>
              {label.text}
            </span>
          )}
        </div>,
      );
    }
  }

  const pieces = [];
  for (let sq = 0; sq < 64; sq++) {
    const p = position[sq];
    if (!p) continue;
    const key = (p === p.toUpperCase() ? "w" : "b") + p.toUpperCase();
    let transform: string;
    let cls = "pc";
    if (drag && drag.from === sq) {
      const size = boardRef.current!.getBoundingClientRect().width / 8;
      transform = `translate(${drag.x - size / 2}px, ${drag.y - size / 2}px)`;
      cls += " dragging";
    } else {
      const start = animFrom?.get(sq);
      const [c, r] = xy(start ?? sq);
      transform = `translate(${c * 100}%, ${r * 100}%)`;
      if (animate && animFrom === null) cls += " moving";
    }
    pieces.push(<div key={sq} className={cls} style={{ backgroundImage: `url("${PIECES[key]}")`, transform }} />);
  }

  return (
    <div className="board-frame">
      <div
        className="board"
        ref={boardRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endDrag(e, false)}
        onPointerCancel={(e) => endDrag(e, true)}
      >
        <div className="squares">{cells}</div>
        <div className="pieces">{pieces}</div>
        {props.arrows && props.arrows.length > 0 && <Arrows arrows={props.arrows} flipped={flipped} />}
      </div>
      {promo && (
        <div className="promo" onClick={(e) => e.target === e.currentTarget && (setPromo(null), select(null))}>
          {["q", "r", "b", "n"].map((k) => {
            const uci = promo.find((u) => u[4] === k);
            if (!uci) return null;
            const key = turn + k.toUpperCase();
            return (
              <button
                key={k}
                type="button"
                aria-label={`Promote to ${k}`}
                style={{ backgroundImage: `url("${PIECES[key]}")` }}
                onClick={() => submit(uci)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function Arrows({ arrows, flipped }: { arrows: Arrow[]; flipped: boolean }) {
  const centre = (sq: string): [number, number] => {
    const i = squareIndex(sq);
    const f = i % 8;
    const r = Math.floor(i / 8);
    const [c, row] = flipped ? [7 - f, r] : [f, 7 - r];
    return [c * 12.5 + 6.25, row * 12.5 + 6.25];
  };
  return (
    <svg className="arrows" viewBox="0 0 100 100" preserveAspectRatio="none">
      {arrows.map((a, i) => {
        const [x1, y1] = centre(a.from);
        const [x2, y2] = centre(a.to);
        const len = Math.hypot(x2 - x1, y2 - y1) || 1;
        const ux = (x2 - x1) / len;
        const uy = (y2 - y1) / len;
        const head = 3.6;
        const bx = x2 - ux * head;
        const by = y2 - uy * head;
        const px = -uy * 2.2;
        const py = ux * 2.2;
        return (
          <g key={i} opacity={0.82}>
            <line x1={x1} y1={y1} x2={bx} y2={by} stroke={a.color} strokeWidth={1.8} strokeLinecap="round" />
            <polygon points={`${x2},${y2} ${bx + px},${by + py} ${bx - px},${by - py}`} fill={a.color} />
          </g>
        );
      })}
    </svg>
  );
}

/** 64 squares (a1 = 0) of piece letters, from a FEN. */
export function parseBoard(fen: string): (string | null)[] {
  const b: (string | null)[] = new Array(64).fill(null);
  const placement = fen.split(" ")[0];
  let r = 7;
  let f = 0;
  for (const ch of placement) {
    if (ch === "/") {
      r--;
      f = 0;
    } else if (/\d/.test(ch)) f += Number(ch);
    else {
      b[r * 8 + f] = ch;
      f++;
    }
  }
  return b;
}

