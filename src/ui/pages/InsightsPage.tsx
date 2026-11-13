/**
 * Insights: walk the Lichess tree from the shown position and list moves for one colour after
 * which opponents usually go wrong (the challenge), whatever the engine thinks of them.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { after, sanLine } from "../../core/chess";
import { InsightsWorker, type InsightsSummary, type NotableMove, playPct, positionMoves } from "../../core/insights";
import { useGame } from "../game";
import { SortTable, useLichess } from "../lichess";
import type { Settings } from "../settings";

export function InsightsPage({ settings }: { settings: Settings }) {
  const client = useLichess();
  const { game, load } = useGame();
  const worker = useMemo(() => new InsightsWorker(client), [client]);
  const [color, setColor] = useState<"w" | "b">("w");
  const [minGames, setMinGames] = useState(100);
  const [delta, setDelta] = useState(5);
  const [minPct, setMinPct] = useState(5);
  const [topN, setTopN] = useState(3);
  const [maxPositions, setMaxPositions] = useState(300);
  const [found, setFound] = useState<NotableMove[]>([]);
  const [progress, setProgress] = useState("");
  const [summary, setSummary] = useState<InsightsSummary | null>(null);
  const [running, setRunning] = useState(false);
  const runRef = useRef(0);

  useEffect(() => () => worker.stop(), [worker]);

  const start = () => {
    setFound([]);
    setSummary(null);
    setRunning(true);
    const moves = game.moves.slice(0, game.currentPly);
    runRef.current = worker.start(
      {
        color,
        minPct,
        minGames,
        topN,
        deltaPp: delta,
        query: { speeds: settings.explorerSpeeds, ratings: settings.explorerRatings, moves: 20 },
        maxPositions,
      },
      game.fen,
      game.startFen,
      moves,
      {
        onProgress: (id, message) => id === runRef.current && setProgress(message),
        onResult: (id, move) => id === runRef.current && setFound((f) => [...f, move]),
        onFinished: (s) => {
          if (s.runId !== runRef.current) return;
          setSummary(s);
          setRunning(false);
          setProgress("");
        },
      },
    );
  };

  const show = (m: NotableMove) => {
    const moves = positionMoves(m);
    const state = game.clone();
    state.loadGame(m.rootFen, [...moves, m.move]);
    load(state);
  };

  const num = (label: string, value: number, set: (v: number) => void, min: number, max: number, step = 1) => (
    <label className="small row" style={{ gap: 4 }}>
      {label}
      <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => set(Number(e.target.value) || 0)} style={{ width: 80 }} />
    </label>
  );

  if (!settings.lichessToken) {
    return (
      <section className="panel">
        <h2>Opening insights</h2>
        <p className="muted">Insights read the Lichess opening explorer, which needs a Lichess login. Log in on the Settings tab.</p>
      </section>
    );
  }

  return (
    <div className="col">
      <section className="panel">
        <h2>Opening insights</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Starting from the position on the board, find moves for one side after which opponents score well below what their best
          reply would give them. Uses the Explorer tab's speed and rating filters.
        </p>
        <div className="row">
          <select value={color} onChange={(e) => setColor(e.target.value as "w" | "b")} aria-label="Colour">
            <option value="w">Moves for White</option>
            <option value="b">Moves for Black</option>
          </select>
          {num("Min games", minGames, setMinGames, 1, 10_000_000, 100)}
          {num("Min challenge", delta, setDelta, 0, 50, 0.5)}
          {num("Min %", minPct, setMinPct, 0, 100)}
          {num("Replies", topN, setTopN, 0, 20)}
          {num("Positions", maxPositions, setMaxPositions, 10, 5000, 50)}
        </div>
        <div className="row">
          <button className="btn primary" type="button" onClick={start} disabled={running}>
            {running ? "Searching…" : "Find challenging moves"}
          </button>
          {running && (
            <button className="btn" type="button" onClick={() => worker.stop()}>
              Stop
            </button>
          )}
          <span className="small muted grow">
            {progress}
            {summary &&
              `${summary.found} found in ${summary.positions} positions${summary.limit ? ` (${summary.limit})` : ""}${summary.stopped ? " · stopped" : ""}${summary.error ? ` · ${summary.error}` : ""}`}
          </span>
        </div>
      </section>
      {found.length > 0 && (
        <section className="panel">
          <h2>Challenging moves</h2>
          <SortTable
            rows={found}
            rowKey={(m) => [...m.line, m.move].join(" ")}
            onPick={show}
            initialSort={1}
            columns={[
              { head: "Line", cell: (m) => sanLine([...m.line, m.move], fenBefore(m)), sort: (m) => m.line.length },
              { head: "Challenge", num: true, title: "How much worse opponents score than their best reply would give", cell: (m) => `${m.challengePp.toFixed(1)} pp`, sort: (m) => m.challengePp },
              { head: "Score", num: true, cell: (m) => `${m.scorePct.toFixed(1)}%`, sort: (m) => m.scorePct },
              { head: "Best reply", cell: (m) => `${m.bestReplySan} (${m.bestReplyShare.toFixed(0)}%, ${m.bestReplyPct.toFixed(1)}%)` },
              { head: "Played", num: true, cell: (m) => `${playPct(m).toFixed(1)}%`, sort: (m) => playPct(m) },
              { head: "Games", num: true, cell: (m) => m.games.toLocaleString(), sort: (m) => m.games },
            ]}
          />
          <p className="small muted" style={{ margin: 0 }}>Click a row to load the line on the board.</p>
        </section>
      )}
    </div>
  );
}

/** The FEN the line starts from: the run's root position after its prefix. */
function fenBefore(m: NotableMove): string {
  let f = m.rootFen;
  for (const u of m.prefixMoves) {
    const next = after(f, u);
    if (!next) break;
    f = next;
  }
  return f;
}
