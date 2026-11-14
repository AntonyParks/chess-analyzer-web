/**
 * Lichess access for the whole app: one client (with its cache) using the visitor's token, a
 * hook that fetches explorer stats for a position, and the explorer moves table.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { epd, turnOf } from "../core/chess";
import { cpPov, formatCp, rankColor, type MoveEval } from "../core/evaluation";
import { TIPS } from "./tips";
import {
  type ExplorerQuery,
  type ExplorerResult,
  LichessAuthError,
  LichessClient,
  LichessRateLimited,
  type MoveStats,
  percentages,
} from "../data/lichess";

const ClientContext = createContext<LichessClient | null>(null);

export function LichessProvider({ token, children }: { token: string; children: ReactNode }) {
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const client = useMemo(() => new LichessClient(() => tokenRef.current), []);
  useEffect(() => client.clearCache(), [client, token]);
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

export function useLichess(): LichessClient {
  const c = useContext(ClientContext);
  if (!c) throw new Error("useLichess outside LichessProvider");
  return c;
}

export interface ExplorerState {
  result: ExplorerResult | null;
  status: string;
  loading: boolean;
  /** The position this state is about. While a new position loads it still names the old
   * one, so pages can keep showing the old moves instead of an empty table. */
  epd: string;
}

/** ``value`` while ``ready``; otherwise the last value that was ready (and true for "stale"). */
export function useSteady<T>(value: T, ready: boolean): [T, boolean] {
  const held = useRef<{ v: T } | null>(null);
  if (ready || held.current === null) {
    held.current = { v: value };
    return [value, false];
  }
  return [held.current.v, true];
}

/** Explorer stats for ``fen``, refetched when the position or query changes (debounced). */
export function useExplorer(fen: string, query: ExplorerQuery, enabled: boolean, hasToken: boolean): ExplorerState {
  const client = useLichess();
  const [state, setState] = useState<ExplorerState>({ result: null, status: "", loading: false, epd: "" });
  const here = epd(fen);
  const key = `${here}|${JSON.stringify(query)}`;
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    if (!hasToken) {
      setState({ result: null, status: "Log in with Lichess in Settings to see game counts.", loading: false, epd: here });
      return;
    }
    const cached = client.cached(fen, query);
    if (cached) {
      setState({ result: cached, status: "", loading: false, epd: here });
      return;
    }
    let live = true;
    // Keep what is shown (and the position it is for) until the new counts arrive.
    setState((s) => ({ ...s, status: "Loading…", loading: true }));
    const timer = setTimeout(async () => {
      try {
        const result = await client.explorer(fen, query);
        if (live) setState({ result, status: "", loading: false, epd: here });
      } catch (err) {
        if (!live) return;
        if (err instanceof LichessAuthError) {
          setState({ result: null, status: "Lichess rejected the login: log in again in Settings.", loading: false, epd: here });
        } else if (err instanceof LichessRateLimited) {
          setState({ result: null, status: `Lichess asked us to wait ${Math.round(err.retryAfter)} s; retrying then.`, loading: true, epd: here });
          setTimeout(() => live && setRetry((r) => r + 1), err.retryAfter * 1000);
        } else {
          setState({ result: null, status: `${(err as Error).message}.`, loading: false, epd: here });
        }
      }
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, hasToken, client, retry]);
  return state;
}

export interface Column<R> {
  head: string;
  title?: string;
  num?: boolean;
  cell: (row: R) => ReactNode;
  sort?: (row: R) => number | string;
  /** The cell covers this many columns (the next ones draw no cell of their own). */
  span?: number;
}

/** A sortable table; clicking a row calls ``onPick``. */
export function SortTable<R>({
  rows,
  columns,
  rowKey,
  onPick,
  selected,
  initialSort = 0,
  sortSpec,
  onSortChange,
}: {
  rows: R[];
  columns: Column<R>[];
  rowKey: (r: R) => string;
  onPick?: (r: R) => void;
  selected?: string | null;
  initialSort?: number;
  /** A remembered sort ([column name, "asc" | "desc"]); with it the parent owns the sort. */
  sortSpec?: string[];
  onSortChange?: (spec: string[]) => void;
}) {
  const [own, setOwn] = useState<{ col: number; desc: boolean }>({ col: initialSort, desc: true });
  const fromSpec = sortSpec ? columns.findIndex((c) => c.head === sortSpec[0]) : -1;
  const sort = fromSpec >= 0 ? { col: fromSpec, desc: sortSpec![1] !== "asc" } : own;
  const setSort = (next: { col: number; desc: boolean }) => {
    if (onSortChange) onSortChange([columns[next.col].head, next.desc ? "desc" : "asc"]);
    else setOwn(next);
  };
  const sorted = useMemo(() => {
    const c = columns[sort.col];
    if (!c?.sort) return rows;
    const key = c.sort;
    return [...rows].sort((a, b) => {
      const x = key(a);
      const y = key(b);
      const d = x < y ? -1 : x > y ? 1 : 0;
      return sort.desc ? -d : d;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, columns, sort.col, sort.desc]);
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th
                key={c.head}
                className={c.num ? "num" : ""}
                data-tip={c.title}
                onClick={() => c.sort && setSort({ col: i, desc: sort.col === i ? !sort.desc : true })}
              >
                {c.head}
                {sort.col === i ? (sort.desc ? " ▾" : " ▴") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={rowKey(r)} className={selected === rowKey(r) ? "selected" : ""} onClick={() => onPick?.(r)}>
              {columns.map((c, i) =>
                coveredBySpan(columns, i) ? null : (
                  <td key={c.head} className={c.num ? "num" : ""} colSpan={c.span}>
                    {c.cell(r)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Is column i drawn by an earlier column's spanning cell? */
function coveredBySpan<R>(columns: Column<R>[], i: number): boolean {
  for (let j = 0; j < i; j++) if ((columns[j].span ?? 1) > i - j) return true;
  return false;
}

/** Columns shared by the Explorer and Repertoire tables. */
export function explorerColumns(
  fen: string,
  evals: Record<string, MoveEval> | undefined,
  ranks: Record<string, number> | undefined,
  total: number,
): Column<MoveStats>[] {
  const turn = turnOf(fen);
  const evalOf = (m: MoveStats) => (evals?.[m.uci] ? cpPov(evals[m.uci].cpWhite, turn) : -1e9);
  return [
    { head: "Move", title: TIPS.colMove, cell: (m) => <b>{m.san}</b>, sort: (m) => m.san },
    {
      head: "Eval",
      num: true,
      title: TIPS.colEval,
      cell: (m) =>
        evals?.[m.uci] ? (
          <span style={{ color: rankColor(ranks?.[m.uci] ?? 0.5), fontWeight: 700 }}>{formatCp(evals[m.uci].cpWhite)}</span>
        ) : (
          ""
        ),
      sort: evalOf,
    },
    { head: "Games", num: true, title: TIPS.colGames, cell: (m) => (m.total ? m.total.toLocaleString() : "–"), sort: (m) => m.total },
    {
      head: "Played",
      num: true,
      title: TIPS.colPlayed,
      cell: (m) => (total && m.total ? `${Math.round((100 * m.total) / total)}%` : "–"),
      sort: (m) => m.total,
    },
    ...(["White", "Draw", "Black"] as const).map(
      (side, k): Column<MoveStats> => ({
        head: side,
        num: true,
        title: TIPS[`col${side}` as "colWhite" | "colDraw" | "colBlack"],
        // One combined bar spans the three result columns; each heading still sorts on its own.
        span: k === 0 ? 3 : undefined,
        cell: (m) => (m.total ? <WdlBar m={m} /> : "–"),
        sort: (m) => (m.total ? [m.white, m.draws, m.black][k] / m.total : -1),
      }),
    ),
    { head: "Avg", num: true, title: TIPS.colAvg, cell: (m) => m.averageRating ?? "–", sort: (m) => m.averageRating ?? 0 },
  ];
}

/** White / draw / Black shares as one bar across the three result columns. */
function WdlBar({ m }: { m: MoveStats }) {
  const [w, d, b] = percentages(m.white, m.draws, m.black);
  const seg = (pct: number, bg: string, fg: string) =>
    pct > 0 ? (
      <span
        style={{
          width: `${pct}%`,
          background: bg,
          color: fg,
          textAlign: "center",
          fontSize: 11,
          lineHeight: "18px",
          overflow: "hidden",
          whiteSpace: "nowrap",
        }}
      >
        {pct >= 10 ? `${pct}%` : ""}
      </span>
    ) : null;
  return (
    <span
      style={{ display: "flex", width: "100%", minWidth: 160, borderRadius: 3, overflow: "hidden", border: "1px solid var(--line)" }}
      aria-label={`White ${w}%, draw ${d}%, Black ${b}%`}
    >
      {seg(w, "#f4f4f2", "#333")}
      {seg(d, "#9a9a9a", "#111")}
      {seg(b, "#2b2b2b", "#eee")}
    </span>
  );
}
