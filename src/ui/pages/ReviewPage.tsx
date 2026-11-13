/** Review: analyse every move of the game, then list the inaccuracies, mistakes and blunders. */
import { useEffect, useMemo, useRef, useState } from "react";
import { GameReviewRunner, buildReview } from "../../core/review";
import { useEngines } from "../engine";
import { useGame } from "../game";
import { MoveList } from "./AnalysePage";

const MARKER_CLASS: Record<string, string> = { "??": "marker-bad", "?": "marker-bad", "?!": "marker-warn" };

export function ReviewPage() {
  const { main } = useEngines();
  const { game, goto, touch, tick } = useGame();
  const [depth, setDepth] = useState(12);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [finished, setFinished] = useState<boolean | null>(null);
  const runner = useRef<GameReviewRunner | null>(null);
  const gameRef = useRef(game);
  gameRef.current = game;

  useEffect(() => {
    if (!main) return;
    runner.current = new GameReviewRunner({
      scheduler: main,
      stateProvider: () => gameRef.current,
      depthProvider: () => depth,
      onProgress: (done, total) => {
        setProgress([done, total]);
        touch();
      },
      onFinished: (completed) => {
        setProgress(null);
        setFinished(completed);
        touch();
      },
    });
    return () => runner.current?.cancel();
  }, [main, depth, touch]);

  // Any change to the move list cancels a run (the runner checks the version).
  useEffect(() => {
    runner.current?.onStateChanged();
  }, [game.version]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const entries = useMemo(() => buildReview(game), [tick, game]);
  const counts = (white: boolean) => {
    const c: Record<string, number> = { "?!": 0, "?": 0, "??": 0 };
    for (const e of entries) if (e.isWhite === white && e.marker in c) c[e.marker] += 1;
    return c;
  };
  const running = progress !== null;
  const analysed = [...game.analysis.values()].filter((a) => a.complete).length;

  return (
    <div className="col">
      <section className="panel">
        <div className="row">
          <h2 className="grow">Game review</h2>
          <label className="small muted" htmlFor="review-depth">
            Depth
          </label>
          <input
            id="review-depth"
            type="number"
            min={6}
            max={20}
            value={depth}
            disabled={running}
            onChange={(e) => setDepth(Math.max(6, Math.min(20, Number(e.target.value) || 12)))}
            style={{ width: 64 }}
          />
          <button
            className="btn primary"
            type="button"
            disabled={!main || running || !game.moves.length}
            onClick={() => {
              setFinished(null);
              if (runner.current?.start()) setProgress([0, game.moves.length + 1]);
              else setFinished(true);
            }}
          >
            {running ? "Analysing…" : "Analyse game"}
          </button>
          {running && (
            <button className="btn" type="button" onClick={() => runner.current?.cancel()}>
              Stop
            </button>
          )}
        </div>
        {!game.moves.length && <p className="muted small">Load or play a game on the Analyse tab first.</p>}
        {running && progress && (
          <p className="small muted" style={{ margin: 0 }}>
            Analysing position {progress[0]} of {progress[1]}. You can keep browsing the game meanwhile.
          </p>
        )}
        {finished === false && <p className="small bad">The analysis stopped before the end.</p>}
        {game.moves.length > 0 && (
          <div className="row small">
            {(["White", "Black"] as const).map((side) => {
              const c = counts(side === "White");
              return (
                <span key={side} className="grow">
                  <b>{side}</b>: <span className="marker-warn">{c["?!"]} ?!</span> ·{" "}
                  <span className="marker-bad">{c["?"]} ?</span> · <span className="marker-bad">{c["??"]} ??</span>
                </span>
              );
            })}
          </div>
        )}
        {game.moves.length > 0 && analysed < game.moves.length + 1 && !running && (
          <p className="small muted" style={{ margin: 0 }}>
            {analysed} of {game.moves.length + 1} positions analysed. Press Analyse game for a full review.
          </p>
        )}
      </section>
      {entries.length > 0 && (
        <section className="panel">
          <h2>Flagged moves</h2>
          <div style={{ display: "grid", gap: 8 }}>
            {entries.map((e) => (
              <button
                key={e.ply}
                type="button"
                className="btn"
                style={{ textAlign: "left", fontWeight: 400, padding: "6px 10px", height: "auto" }}
                onClick={() => goto(e.ply - 1)}
              >
                <b className={MARKER_CLASS[e.marker] ?? ""}>{e.label}</b>
                {e.betterSan && (
                  <>
                    {" "}
                    · better was <b>{e.betterSan}</b>
                  </>
                )}
                <span className="muted small"> · {(e.winDrop * 50).toFixed(0)} points of win chance lost</span>
                {e.explanation && <div className="small muted">{e.explanation}</div>}
              </button>
            ))}
          </div>
        </section>
      )}
      <section className="panel">
        <h2>Moves</h2>
        <MoveList />
      </section>
    </div>
  );
}
