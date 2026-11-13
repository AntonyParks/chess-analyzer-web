/**
 * The analysis board column: board with heatmap and best-move arrow, the eval bar, the eval
 * graph and navigation. Used by every page that works on the shared game.
 */
import { useEffect, useMemo, useState } from "react";
import { legalUcis, turnOf } from "../core/chess";
import { bestUci, formatBarText, formatCp, rankColor, winChance } from "../core/evaluation";
import { Board, type Arrow } from "./Board";
import { useGame } from "./game";
import type { Settings } from "./settings";

export function AnalysisBoard({ settings, extraArrows }: { settings: Settings; extraArrows?: Arrow[] }) {
  const { game, play, goto, animate, thinking } = useGame();
  const [selected, setSelected] = useState<string | null>(null);
  const fen = game.fen;
  const ply = game.currentPly;
  const analysis = game.analysis.get(ply);
  const turn = turnOf(fen);

  useEffect(() => setSelected(null), [fen]);

  // Keyboard navigation, like the desktop app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      if (e.key === "ArrowLeft") goto(game.currentPly - 1);
      else if (e.key === "ArrowRight") goto(game.currentPly + 1);
      else if (e.key === "Home") goto(0);
      else if (e.key === "End") goto(game.moves.length);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [game, goto]);

  // The desktop heatmap: each piece's square split into bands, one per legal move of that
  // piece (in move-generation order), each coloured by that move's rank (red worst, gold best).
  const bands = useMemo(() => {
    if (!settings.heatmap || !analysis) return undefined;
    const out: Record<string, string[]> = {};
    for (const uci of legalUcis(fen)) {
      const rank = analysis.rankMap[uci];
      if (rank === undefined) continue;
      (out[uci.slice(0, 2)] ??= []).push(rankColor(rank));
    }
    return out;
  }, [settings.heatmap, analysis, fen]);

  const dotColors = useMemo(() => {
    if (!selected || !analysis) return undefined;
    const out: Record<string, string> = {};
    for (const [uci, rank] of Object.entries(analysis.rankMap)) {
      if (uci.startsWith(selected)) out[uci.slice(2, 4)] = rankColor(rank);
    }
    return out;
  }, [selected, analysis]);

  const labels = useMemo(() => {
    if (!selected || !analysis) return undefined;
    const out: Record<string, { text: string; color: string }> = {};
    for (const [uci, ev] of Object.entries(analysis.evals)) {
      if (!uci.startsWith(selected)) continue;
      const to = uci.slice(2, 4);
      const pov = turn === "w" ? ev.cpWhite : -ev.cpWhite;
      out[to] = { text: formatCp(pov).replace("+", ""), color: rankColor(analysis.rankMap[uci] ?? 0.5) };
    }
    return out;
  }, [selected, analysis, turn]);

  const arrows: Arrow[] = [...(extraArrows ?? [])];
  if (settings.arrow && analysis) {
    const best = bestUci(analysis.evals, turn);
    if (best) arrows.push({ from: best.slice(0, 2), to: best.slice(2, 4), color: "#2e9d5a" });
  }

  const cp = analysis?.positionCp ?? null;
  const orientation = settings.flip ? "b" : "w";

  return (
    <div className="col">
      <div className="board-row">
        <EvalBar cp={cp} flipped={orientation === "b"} />
        <Board
          fen={fen}
          orientation={orientation}
          lastMove={game.lastMove}
          animate={animate}
          onMove={(uci) => play(uci)}
          onSelect={setSelected}
          bands={bands}
          dotColors={dotColors}
          labels={labels}
          arrows={arrows}
        />
      </div>
      <div className="row">
        <button className="btn" type="button" onClick={() => goto(0)} aria-label="First move">⏮</button>
        <button className="btn" type="button" onClick={() => goto(ply - 1)} aria-label="Previous move">◀</button>
        <button className="btn" type="button" onClick={() => goto(ply + 1)} aria-label="Next move">▶</button>
        <button className="btn" type="button" onClick={() => goto(game.moves.length)} aria-label="Last move">⏭</button>
        <span className="grow" />
        <span className="small muted">
          {cp === null ? "" : `${formatCp(cp)} · depth ${analysis?.depth ?? 0}`}
          {thinking ? " · thinking…" : ""}
        </span>
      </div>
      <EvalGraph />
    </div>
  );
}


export function EvalBar({ cp, flipped }: { cp: number | null; flipped: boolean }) {
  const share = cp === null ? 0.5 : (winChance(cp) + 1) / 2; // White's share of the bar
  const text = cp === null ? "" : formatBarText(cp);
  const whiteAhead = cp === null || cp >= 0;
  // White's part sits at White's end of the board: the bottom unless the board is flipped.
  const whiteStyle: React.CSSProperties = flipped
    ? { top: 0, bottom: "auto", height: `${share * 100}%` }
    : { height: `${share * 100}%` };
  const textAtWhiteEnd = whiteAhead;
  const textStyle: React.CSSProperties = {
    [textAtWhiteEnd !== flipped ? "bottom" : "top"]: 0,
    color: whiteAhead ? "#333" : "#eee",
  };
  return (
    <div className="evalbar" aria-label={cp === null ? "No evaluation yet" : `Evaluation ${formatCp(cp)}`}>
      <div className="white" style={whiteStyle} />
      <div className="txt" style={textStyle}>
        {text}
      </div>
    </div>
  );
}

/** Winning chances over the game; click to jump to a move. */
export function EvalGraph() {
  const { game, goto } = useGame();
  const n = game.moves.length;
  const evals = game.positionEvals();
  if (n === 0) return null;
  const w = 600;
  const h = 72;
  const x = (p: number) => (p / Math.max(1, n)) * w;
  const y = (cp: number) => h / 2 - (winChance(cp) * h) / 2;
  let path = "";
  const points: [number, number][] = [];
  for (let p = 0; p <= n; p++) {
    const cp = evals.get(p);
    if (cp === undefined) continue;
    points.push([x(p), y(cp)]);
  }
  if (points.length > 1) {
    path = `M ${points[0][0]} ${h / 2} ` + points.map(([px, py]) => `L ${px} ${py}`).join(" ") + ` L ${points[points.length - 1][0]} ${h / 2} Z`;
  }
  const markers: { p: number; m: string }[] = [];
  for (let p = 1; p <= n; p++) {
    const m = game.markerAt(p, evals);
    if (m === "??" || m === "?") markers.push({ p, m });
  }
  return (
    <svg
      className="evalgraph"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      onClick={(e) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        goto(Math.round(((e.clientX - r.left) / r.width) * n));
      }}
    >
      <rect x={0} y={0} width={w} height={h / 2} fill="var(--bar-black)" opacity={0.18} />
      {path && <path d={path} fill="var(--bar-white)" opacity={0.85} stroke="var(--muted)" strokeWidth={0.6} />}
      <line x1={0} x2={w} y1={h / 2} y2={h / 2} stroke="var(--muted)" strokeWidth={0.5} opacity={0.6} />
      {markers.map(({ p, m }) => (
        <circle key={p} cx={x(p)} cy={evals.has(p) ? y(evals.get(p)!) : h / 2} r={2.4} fill={m === "??" ? "#c0392b" : "#d2802a"} />
      ))}
      <line x1={x(game.currentPly)} x2={x(game.currentPly)} y1={0} y2={h} stroke="var(--accent)" strokeWidth={1.2} />
    </svg>
  );
}

