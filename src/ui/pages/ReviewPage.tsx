/** Review: analyse every move of the game, then list the inaccuracies, mistakes and blunders. */
import { useEffect, useMemo, useRef, useState } from "react";
import { legalUcis } from "../../core/chess";
import { CHESSCOM_TO_LICHESS, type ExpectedPlay, type PlyData, expectedPlay, gameRatings } from "../../core/humanModel";
import type { GameState } from "../../core/gameState";
import { GameReviewRunner, buildReview } from "../../core/review";
import { useEngines } from "../engine";
import { useGame } from "../game";
import type { Settings } from "../settings";
import { MoveList } from "./AnalysePage";
import { GameList } from "./GameList";
import { TIPS } from "../tips";
import { useYourRating } from "../yourRating";

const MARKER_CLASS: Record<string, string> = { "??": "marker-bad", "?": "marker-bad", "?!": "marker-warn" };

export function ReviewPage({ settings, update }: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  const { main, ladder } = useEngines();
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
      traceScheduler: ladder,
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
  }, [main, ladder, depth, touch]);

  // Any change to the move list cancels a run (the runner checks the version).
  useEffect(() => {
    runner.current?.onStateChanged();
  }, [game.version]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const entries = useMemo(() => buildReview(game), [tick, game]);
  const you = userSide(game.headers, [settings.chesscomUsername, settings.lichessUsername]);
  const [showBoth, setShowBoth] = useState(false);
  const shownEntries = you && !showBoth ? entries.filter((e) => e.isWhite === (you.color === "w")) : entries;
  const yourRating = useYourRating(settings);
  const ratings = useMemo(() => gameRatings(game.headers, yourRating), [game, yourRating]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const play = useMemo(() => expectedPlay(plyData(game), ratings), [tick, game, ratings]);
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
          <label className="small muted" htmlFor="review-depth" data-tip={TIPS.reviewDepth}>
            Depth
          </label>
          <input
            id="review-depth"
            data-tip={TIPS.reviewDepth}
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
            data-tip={TIPS.reviewRun}
            onClick={() => {
              setFinished(null);
              if (runner.current?.start()) setProgress([0, game.moves.length + 1]);
              else setFinished(true);
            }}
          >
            {running ? "Analysing…" : "Analyse game"}
          </button>
          {running && (
            <button className="btn" type="button" onClick={() => runner.current?.cancel()} data-tip={TIPS.reviewStop}>
              Stop
            </button>
          )}
        </div>
        {!game.moves.length && <p className="muted small">Pick one of your games below, or load or play a game on the Analyse tab.</p>}
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
        {play.w.moves + play.b.moves > 0 && <ExpectedPlayRow play={play} ratings={ratings} headers={game.headers} />}
        {game.moves.length > 0 && analysed < game.moves.length + 1 && !running && (
          <p className="small muted" style={{ margin: 0 }}>
            {analysed} of {game.moves.length + 1} positions analysed. Press Analyse game for a full review.
          </p>
        )}
      </section>
      {entries.length > 0 && (
        <section className="panel">
          <div className="row">
            <h2 className="grow">Flagged moves</h2>
            {you && (
              <label className="chip" data-tip={TIPS.reviewBothSides}>
                <input type="checkbox" checked={showBoth} onChange={(e) => setShowBoth(e.target.checked)} />
                Opponent too
              </label>
            )}
          </div>
          {you && !showBoth && (
            <p className="small muted" style={{ margin: 0 }}>
              {you.name}'s moves ({you.color === "w" ? "White" : "Black"}){shownEntries.length ? "" : ": none flagged."}
            </p>
          )}
          <div style={{ display: "grid", gap: 8 }}>
            {shownEntries.map((e) => (
              <button
                key={e.ply}
                type="button"
                className="btn"
                style={{ textAlign: "left", fontWeight: 400, padding: "6px 10px", height: "auto" }}
                onClick={() => goto(e.ply - 1)}
                data-tip={TIPS.reviewEntry}
              >
                <b className={MARKER_CLASS[e.marker] ?? ""}>{e.label}</b>
                {e.betterSan && (
                  <>
                    {" "}
                    · better was <b>{e.betterSan}</b>
                  </>
                )}
                <span className="muted small"> · {(e.winDrop * 50).toFixed(0)} points of win chance lost</span>
                {play.moves.has(e.ply - 1) && (
                  <span className="muted small">
                    {" "}
                    · a good move here is found by about {Math.round(play.moves.get(e.ply - 1)!.chance * 100)}% of players at
                    this level
                  </span>
                )}
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
      <GameList settings={settings} update={update} />
    </div>
  );
}

function plyData(game: GameState): PlyData[] {
  return game.moves.map((played, ply) => {
    const fen = game.fenAt(ply);
    const a = game.analysis.get(ply);
    return {
      fen,
      played,
      legalCount: legalUcis(fen).length,
      evals: a?.complete ? a.evals : undefined,
      trace: game.traces.get(ply)?.trace,
    };
  });
}

function ExpectedPlayRow({ play, ratings, headers }: { play: ExpectedPlay; ratings: Record<"w" | "b", number>; headers: Record<string, string> }) {
  const lichessSite = /lichess/i.test(headers.Site ?? "");
  const shown = (c: "w" | "b") => {
    const raw = Number(c === "w" ? headers.WhiteElo : headers.BlackElo);
    return Number.isFinite(raw) && raw > 0 ? `${raw}${lichessSite ? " Lichess" : ""}` : `${ratings[c] - CHESSCOM_TO_LICHESS} (your setting)`;
  };
  return (
    <div className="row small" data-tip={TIPS.expectedPlay}>
      {(["w", "b"] as const).map((c) => {
        const s = play[c];
        if (!s.moves) return <span key={c} className="grow" />;
        const diff = s.found - s.expected;
        return (
          <span key={c} className="grow">
            <b>{c === "w" ? "White" : "Black"}</b> ({shown(c)}): {s.found} good moves of {s.moves}, expected{" "}
            {s.expected.toFixed(1)}{" "}
            <span className={diff >= 0 ? "good" : "bad"}>
              ({diff >= 0 ? "+" : ""}
              {diff.toFixed(1)})
            </span>
          </span>
        );
      })}
    </div>
  );
}

/** The side whose PGN name matches one of your usernames (case-insensitive), if exactly one does. */
function userSide(headers: Record<string, string>, names: string[]): { color: "w" | "b"; name: string } | null {
  const mine = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const w = mine.has((headers.White ?? "").toLowerCase());
  const b = mine.has((headers.Black ?? "").toLowerCase());
  if (w === b) return null;
  return w ? { color: "w", name: headers.White } : { color: "b", name: headers.Black };
}
