/**
 * The repertoire as a sunburst. The centre is the start position; each ring is one move further,
 * and each wedge's angle is how often that line comes up in real games. Rings keep one width, so
 * deep lines run past the edge of the box: drag to move around, and zoom with the mouse wheel,
 * a pinch, or the + / − buttons. Click (or tap) a wedge to show its position on the board.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { board, playUci, sanLine } from "../core/chess";
import type { Repertoire } from "../core/repertoire";
import { ancestryOf, buildMap, findNode, type MapNode } from "../core/repertoireMap";

const SIZE = 400;
const C = SIZE / 2;
const R_IN = 52; // the centre disc
const RING = 22; // every ring is this wide; the 7th ends near the box's edge at the start
const TAU = Math.PI * 2;
const MIN_SCALE = 0.35;
const MAX_SCALE = 10;
const DRAG_PX = 4; // a press that moves less than this is a click, not a drag

type View = { s: number; x: number; y: number };
const HOME: View = { s: 1, x: 0, y: 0 };

type Mode = "openings" | "training";

export function Sunburst({
  rep,
  coverage,
  version,
  current,
  onShow,
}: {
  rep: Repertoire;
  coverage: number;
  version: number;
  /** The position on the board (EPD): its wedge is outlined. */
  current: string;
  onShow: (path: string[]) => void;
}) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { root, summary } = useMemo(() => buildMap(rep, coverage), [rep, coverage, version]);
  const dark = useDarkMode();
  const [mode, setMode] = useState<Mode>("openings");
  const [hoverId, setHoverId] = useState<string | null>(null);
  // Moves with no alternative (1.e4 in a White repertoire) go into the centre rather than
  // spending a whole ring on one wedge.
  let centre = root;
  while (centre.children.length === 1 && centre.children[0].children.length) centre = centre.children[0];
  const view = centre;
  const { vt, svgRef, dragged, zoomBy, reset, onPointerDown } = usePanZoom();
  const hoverFound = hoverId !== null ? findNode(root, hoverId) : null;
  // Only a wedge on the rings highlights its line (not one folded into the centre).
  const hovered = hoverFound && hoverFound.depth > centre.depth ? hoverFound : null;

  const trail = useMemo(() => new Set((hovered ? ancestryOf(root, hovered.id) ?? [] : []).map((n) => n.id)), [root, hovered]);
  const now = Date.now() / 1000;

  const wedges: JSX.Element[] = [];
  const labels: JSX.Element[] = [];
  const marks: JSX.Element[] = [];
  let boardNode: MapNode | null = null; // the wedge for the board's position, drawn or not
  const span = Math.max(1e-9, view.a1 - view.a0);
  const radius = (d: number) => R_IN + RING * Math.max(0, d);
  const visit = (n: MapNode) => {
    const d = n.depth - view.depth;
    const t0 = clamp01((n.a0 - view.a0) / span);
    const t1 = clamp01((n.a1 - view.a0) / span);
    const isHere = n.epd === current && n.kind !== "rare" && n.kind !== "root";
    if (isHere && (!boardNode || n.depth < boardNode.depth)) boardNode = n;
    if (t1 - t0 < 0.0008) return;
    if (d >= 0.999) {
      const r0 = radius(d - 1);
      const r1 = radius(d) - 0.6;
      const fill = colourOf(n, mode, dark, rep, now, (t0 + t1) / 2);
      const dim = hovered && !trail.has(n.id);
      wedges.push(
        <path
          key={n.id || "root"}
          d={sector(t0, t1, r0, r1)}
          fill={fill.base}
          stroke="var(--surface)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          opacity={dim ? 0.32 : 1}
          style={{ transition: "opacity 160ms" }}
          onMouseEnter={() => setHoverId(n.id)}
          onMouseLeave={() => setHoverId((h) => (h === n.id ? null : h))}
          onClick={() => !dragged.current && onShow(n.path)}
        >
          <title>{describe(n)}</title>
        </path>,
      );
      if (fill.hatch) {
        wedges.push(
          <path key={`${n.id}#h`} d={sector(t0, t1, r0, r1)} fill={`url(#sb-hatch-${fill.hatch})`} opacity={dim ? 0.3 : 1} pointerEvents="none" />,
        );
      }
      if (isHere) {
        // The board's position: a crisp double outline, on top of everything.
        const shape = sector(t0, t1, r0, r1);
        marks.push(
          <g key={`${n.id}#here`} pointerEvents="none">
            <path d={shape} fill="none" stroke="var(--surface)" strokeWidth={6.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            <path d={shape} fill="none" stroke="var(--ink)" strokeWidth={3} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </g>,
        );
      }
      // A label when the wedge has room for it (measured on screen, so zooming in shows more):
      // along the arc on wide wedges, along the radius on narrow ones.
      const mid = (t0 + t1) / 2;
      const rMid = (r0 + r1) / 2;
      const text = n.kind === "rare" ? "…" : n.joins ? `${n.san} ↪` : n.san;
      const arc = (t1 - t0) * TAU * rMid * vt.s;
      const thick = (r1 - r0) * vt.s;
      const width = text.length * 6.4;
      const deg = mid * 360;
      let place: string | null = null;
      if (thick >= 12 && arc >= width + 8) {
        const flip = deg > 90 && deg < 270;
        place = `rotate(${deg} ${C} ${C}) translate(${C} ${C - rMid}) rotate(${flip ? 180 : 0})`;
      } else if (arc >= 12 && thick >= width + 6) {
        const flip = deg > 180;
        place = `rotate(${deg - 90} ${C} ${C}) translate(${C + rMid} ${C}) rotate(${flip ? 180 : 0})`;
      }
      if (place) {
        labels.push(
          <text
            key={`${n.id}#t`}
            transform={place}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={10.5 / vt.s}
            fontWeight={n.kind === "you" ? 700 : 500}
            fill={fill.ink}
            opacity={hovered && !trail.has(n.id) ? 0.35 : 1}
            pointerEvents="none"
          >
            {text}
          </text>,
        );
      }
    }
    n.children.forEach(visit);
  };
  visit(root);

  // The board is at the centre's position, or at a move folded into the centre.
  let centreHere = false;
  for (let n: MapNode | undefined = root; n; n = n === centre ? undefined : n.children[0]) if (n.epd === current) centreHere = true;
  const boardShown = boardNode as MapNode | null;
  const centreLine = hovered;
  const centreMoves = centre.path.length ? sanLine(centre.path.slice(-4), fenBefore(centre.path, 4)) : "";
  const empty = !root.children.length;

  return (
    <div className="sunburst">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <SummaryBar summary={summary} />
        <div className="seg" role="group" aria-label="Colour by">
          {(["openings", "training"] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={mode === m ? "on" : ""}
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              data-tip={m === "openings" ? "Colour each line by where it sits on the circle" : "Colour your moves by review state: new, due, learned, or often missed"}
            >
              {m === "openings" ? "Lines" : "Training"}
            </button>
          ))}
        </div>
      </div>
      <div className="sb-stage">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={`Repertoire sunburst: prepared for ${pct(summary.prepared)} of games, gaps ${pct(summary.gaps)}.`}
        onMouseLeave={() => setHoverId(null)}
        onPointerDown={onPointerDown}
      >
        <defs>
          <pattern id="sb-hatch-gap" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="none" />
            <line x1="0" y1="0" x2="0" y2="6" stroke={dark ? "rgba(0,0,0,0.35)" : "rgba(255,255,255,0.55)"} strokeWidth="2.2" />
          </pattern>
          <pattern id="sb-hatch-open" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
            <line x1="0" y1="0" x2="0" y2="5" stroke="var(--bad)" strokeOpacity="0.75" strokeWidth="1.4" />
          </pattern>
          <radialGradient id="sb-centre" cx="50%" cy="42%" r="65%">
            <stop offset="0%" stopColor="var(--surface)" />
            <stop offset="100%" stopColor="var(--surface-2)" />
          </radialGradient>
        </defs>
        <g transform={`translate(${vt.x} ${vt.y}) scale(${vt.s})`}>
        {wedges}
        {labels}
        {marks}
        <g onClick={() => !empty && !dragged.current && onShow(centre.path)}>
          <title>{empty ? "" : "Show this position on the board"}</title>
          <circle cx={C} cy={C} r={R_IN - 3} fill="url(#sb-centre)" stroke="var(--line)" vectorEffect="non-scaling-stroke" />
          {centreHere && <circle cx={C} cy={C} r={R_IN - 3} fill="none" stroke="var(--ink)" strokeWidth={2.2} vectorEffect="non-scaling-stroke" pointerEvents="none" />}
          {empty ? (
            <text x={C} y={C} textAnchor="middle" dominantBaseline="central" fontSize={11} fill="var(--muted)">
              No lines yet
            </text>
          ) : centreLine ? (
            <>
              <text x={C} y={C - 9} textAnchor="middle" fontSize={21} fontWeight={700} fill="var(--ink)">
                {pct(centreLine.chance)}
              </text>
              <text x={C} y={C + 9} textAnchor="middle" fontSize={9.5} fill="var(--muted)">
                {kindText(centreLine)}
              </text>
            </>
          ) : (
            <>
              <text x={C} y={C - 9} textAnchor="middle" fontSize={21} fontWeight={700} fill="var(--ink)">
                {pct(summary.prepared)}
              </text>
              <text x={C} y={C + 9} textAnchor="middle" fontSize={9.5} fill="var(--muted)">
                of games prepared
              </text>
              {centreMoves && (
                <text x={C} y={C + 23} textAnchor="middle" fontSize={9.5} fontWeight={600} fill="var(--ink)">
                  {centreMoves}
                </text>
              )}
            </>
          )}
        </g>
        </g>
      </svg>
      <div className="sb-zoom" role="group" aria-label="Zoom">
        <button type="button" onClick={() => zoomBy(1.35)} aria-label="Zoom in" data-tip="Zoom in (or scroll / pinch on the chart)">
          +
        </button>
        <button type="button" onClick={() => zoomBy(1 / 1.35)} aria-label="Zoom out" data-tip="Zoom out">
          −
        </button>
        <button type="button" onClick={reset} aria-label="Reset view" data-tip="Back to the starting view" disabled={vt.s === HOME.s && vt.x === HOME.x && vt.y === HOME.y}>
          ⟲
        </button>
      </div>
      </div>
      <p className="small sunburst-line" aria-live="polite">
        {hovered && hovered !== root ? (
          <>
            <b>{lineText(hovered)}</b> · {pct(hovered.chance)} of your games
            {hovered.estimated ? " (estimated: no Lichess counts here yet)" : ""}
          </>
        ) : boardShown ? (
          <>
            <span className="muted">On the board (outlined): </span>
            <b>{lineText(boardShown)}</b> · {pct(boardShown.chance)} of your games
          </>
        ) : (
          <span className="muted">
            Wedge size is how often a line comes up in games at your ratings. Point at a wedge to read its line; click it
            to show it on the board. Drag to move around; scroll or pinch to zoom.
          </span>
        )}
      </p>
      <Legend mode={mode} dark={dark} />
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function SummaryBar({ summary }: { summary: { prepared: number; gaps: number; rare: number } }) {
  const total = summary.prepared + summary.gaps + summary.rare || 1;
  const parts = [
    { v: summary.prepared, c: "var(--good)", t: "prepared" },
    { v: summary.gaps, c: "var(--bad)", t: "gaps" },
    { v: summary.rare, c: "var(--line)", t: "rarer replies" },
  ];
  return (
    <div className="sb-summary" data-tip="Share of your games that stay in your preparation to the end of a line, run into a common reply you have not prepared, or meet a rarer reply below your coverage setting.">
      <div className="sb-bar">
        {parts.map((p) => (p.v > 0 ? <span key={p.t} style={{ width: `${(100 * p.v) / total}%`, background: p.c }} /> : null))}
      </div>
      <span className="small muted">
        {parts.map((p, i) => (
          <span key={p.t}>
            {i ? " · " : ""}
            <b style={{ color: "var(--ink)" }}>{pct(p.v)}</b> {p.t}
          </span>
        ))}
      </span>
    </div>
  );
}

function Legend({ mode, dark }: { mode: Mode; dark: boolean }) {
  const items: [string, string, string?][] =
    mode === "openings"
      ? [
          [huePair(0.15, 1, dark, true).base, "Your move"],
          [huePair(0.15, 2, dark, false).base, "Prepared reply"],
          [GAP(dark), "Gap", "gap"],
          [huePair(0.15, 2, dark, false).base, "No answer yet", "open"],
          [RARE(dark), "Rarer replies"],
        ]
      : [
          [TRAIN(dark).fresh, "New"],
          [TRAIN(dark).due, "Due"],
          [TRAIN(dark).learned, "Learned"],
          [TRAIN(dark).lapsed, "Often missed"],
          [GAP(dark), "Gap", "gap"],
        ];
  return (
    <div className="sb-legend small">
      {items.map(([c, t, h]) => (
        <span key={t}>
          <svg width="12" height="12" aria-hidden="true">
            <rect width="12" height="12" rx="3" fill={c} />
            {h && <rect width="12" height="12" rx="3" fill={`url(#sb-hatch-${h})`} />}
          </svg>
          {t}
        </span>
      ))}
    </div>
  );
}

// ── Colour ───────────────────────────────────────────────────────────────────

const GAP = (dark: boolean) => (dark ? "oklch(0.62 0.17 28)" : "oklch(0.66 0.17 28)");
const RARE = (dark: boolean) => (dark ? "oklch(0.36 0.008 160)" : "oklch(0.9 0.006 160)");
const TRAIN = (dark: boolean) =>
  dark
    ? { fresh: "oklch(0.58 0.06 245)", due: "oklch(0.72 0.13 75)", learned: "oklch(0.66 0.12 155)", lapsed: "oklch(0.62 0.17 28)", opp: "oklch(0.34 0.01 160)" }
    : { fresh: "oklch(0.74 0.06 245)", due: "oklch(0.8 0.13 78)", learned: "oklch(0.7 0.12 155)", lapsed: "oklch(0.66 0.17 28)", opp: "oklch(0.92 0.008 160)" };

/** A colour for a place on the circle: hue follows the angle, so related lines share a family. */
function huePair(t: number, depth: number, dark: boolean, mine: boolean): { base: string; ink: string } {
  // A gentle sweep through teal, blue, violet, rose and amber, avoiding garish greens and reds.
  const hue = 165 + t * 180; // teal → blue → violet → pink
  const k = Math.min(1, (depth - 1) / 7);
  const l = dark ? 0.66 - 0.2 * k - (mine ? 0 : 0.05) : 0.6 + 0.24 * k + (mine ? 0 : 0.05);
  const c = (mine ? 0.13 : 0.085) * (1 - 0.35 * k);
  return { base: `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${hue.toFixed(1)})`, ink: l > 0.7 ? "#1d2422" : "#ffffff" };
}

function colourOf(n: MapNode, mode: Mode, dark: boolean, rep: Repertoire, now: number, t: number): { base: string; ink: string; hatch?: "gap" | "open" } {
  if (n.kind === "gap") return { base: GAP(dark), ink: "#ffffff", hatch: "gap" };
  if (n.kind === "rare") return { base: RARE(dark), ink: dark ? "#c9d1cd" : "#5d6763" };
  if (mode === "training") {
    const tr = TRAIN(dark);
    if (n.kind !== "you") return { base: tr.opp, ink: dark ? "#c9d1cd" : "#5d6763", hatch: n.open ? "open" : undefined };
    const card = rep.cards.get(n.parentEpd); // the card sits on the position you play the move from
    const base = !card || !card.learned ? tr.fresh : card.lapses >= 2 ? tr.lapsed : card.isDue(now) ? tr.due : tr.learned;
    return { base, ink: dark ? "#ffffff" : "#1d2422" };
  }
  const p = huePair(t, n.depth, dark, n.kind === "you");
  return { ...p, hatch: n.open ? "open" : undefined };
}

// ── Geometry, text, animation ────────────────────────────────────────────────

/** An annular sector from turn t0 to t1 (0 at the top, clockwise), radii r0..r1. */
function sector(t0: number, t1: number, r0: number, r1: number): string {
  if (t1 - t0 >= 0.9999) {
    // A full ring: two half arcs each way.
    return `M ${C} ${C - r1} A ${r1} ${r1} 0 1 1 ${C} ${C + r1} A ${r1} ${r1} 0 1 1 ${C} ${C - r1} Z M ${C} ${C - r0} A ${r0} ${r0} 0 1 0 ${C} ${C + r0} A ${r0} ${r0} 0 1 0 ${C} ${C - r0} Z`;
  }
  const p = (t: number, r: number) => {
    const a = t * TAU - Math.PI / 2;
    return `${(C + r * Math.cos(a)).toFixed(2)} ${(C + r * Math.sin(a)).toFixed(2)}`;
  };
  const large = t1 - t0 > 0.5 ? 1 : 0;
  return `M ${p(t0, r1)} A ${r1} ${r1} 0 ${large} 1 ${p(t1, r1)} L ${p(t1, r0)} A ${r0} ${r0} 0 ${large} 0 ${p(t0, r0)} Z`;
}

/** The FEN before the last ``n`` moves of ``path`` (so a short tail can be written in SAN). */
function fenBefore(path: readonly string[], n: number): string {
  const g = board();
  for (const u of path.slice(0, Math.max(0, path.length - n))) playUci(g, u);
  return g.fen();
}

function describe(n: MapNode): string {
  return `${lineText(n)}\n${kindText(n)} · ${pct(n.chance)} of games${n.estimated ? " (estimated)" : ""}`;
}

function lineText(n: MapNode): string {
  if (n.kind === "rare") return `${sanLine(n.path) || "Start"}: rarer replies`;
  return sanLine(n.path) || "Start";
}

function kindText(n: MapNode): string {
  if (n.joins) return `joins ${sanLine(n.joins)}`;
  switch (n.kind) {
    case "you":
      return "your move";
    case "opp":
      return n.open ? "prepared, no answer yet" : "prepared reply";
    case "gap":
      return "gap: not prepared";
    case "rare":
      return "rarer replies";
    default:
      return "of games prepared";
  }
}

const pct = (x: number) => (x >= 0.995 || x === 0 ? `${Math.round(x * 100)}%` : x < 0.01 ? `${(x * 100).toFixed(1)}%` : `${Math.round(x * 100)}%`);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Pan (drag) and zoom (wheel, pinch, buttons) for the chart, in viewBox units. */
function usePanZoom() {
  const [vt, setVt] = useState<View>(HOME);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragged = useRef(false); // the last press moved: its click is not a click
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const travel = useRef(0);

  /** Client pixels to viewBox units. */
  const toBox = useCallback((cx: number, cy: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: C, y: C };
    // The box may be wider than tall: the chart keeps its shape and the sides show more of it.
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: C, y: C };
    const p = new DOMPoint(cx, cy).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }, []);

  /** Zoom by ``factor`` keeping the point ``at`` (viewBox units) where it is. */
  const zoomAt = useCallback((at: { x: number; y: number }, factor: number) => {
    setVt((v) => {
      const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.s * factor));
      const k = s / v.s;
      return { s, x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k };
    });
  }, []);

  // The wheel needs a non-passive listener so the page does not scroll while zooming.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      zoomAt(toBox(e.clientX, e.clientY), Math.exp(-e.deltaY * unit * 0.0016));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [toBox, zoomAt]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const map = pointers.current;
      if (map.size === 0) {
        dragged.current = false;
        travel.current = 0;
      }
      map.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const move = (ev: PointerEvent) => {
        const prev = map.get(ev.pointerId);
        if (!prev) return;
        const svg = svgRef.current;
        const unit = 1 / (svg?.getScreenCTM()?.a || 1); // screen pixels to chart units
        if (map.size >= 2) {
          // Pinch: scale by the change in finger distance, pan by the midpoint's movement.
          const [a, b] = [...map.entries()];
          const other = a[0] === ev.pointerId ? b[1] : a[1];
          const before = Math.hypot(prev.x - other.x, prev.y - other.y);
          const after = Math.hypot(ev.clientX - other.x, ev.clientY - other.y);
          const mid = toBox((ev.clientX + other.x) / 2, (ev.clientY + other.y) / 2);
          map.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
          dragged.current = true;
          if (before > 0) zoomAt(mid, after / before);
          setVt((v) => ({ ...v, x: v.x + ((ev.clientX - prev.x) / 2) * unit, y: v.y + ((ev.clientY - prev.y) / 2) * unit }));
          return;
        }
        const dx = ev.clientX - prev.x;
        const dy = ev.clientY - prev.y;
        map.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        travel.current += Math.hypot(dx, dy);
        if (travel.current < DRAG_PX && !dragged.current) return;
        dragged.current = true;
        setVt((v) => ({ ...v, x: v.x + dx * unit, y: v.y + dy * unit }));
      };
      const up = (ev: PointerEvent) => {
        map.delete(ev.pointerId);
        if (map.size === 0) {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
        }
      };
      if (map.size === 1) {
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
      }
    },
    [toBox, zoomAt],
  );

  return {
    vt,
    svgRef,
    dragged,
    zoomBy: (factor: number) => zoomAt({ x: C, y: C }, factor),
    reset: () => setVt(HOME),
    onPointerDown,
  };
}

function useDarkMode(): boolean {
  const query = useMemo(() => (typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: dark)") : undefined), []);
  const [dark, setDark] = useState(!!query?.matches);
  useEffect(() => {
    if (!query) return;
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, [query]);
  return dark;
}
