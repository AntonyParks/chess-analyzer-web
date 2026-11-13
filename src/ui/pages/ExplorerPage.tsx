/** Explorer: what Lichess players play from the shown position, with Stockfish's evals. */
import { RATING_CHOICES, SPEEDS, SPEED_LABELS, percentages } from "../../data/lichess";
import { useGame } from "../game";
import { SortTable, explorerColumns, useExplorer } from "../lichess";
import type { Settings } from "../settings";
import { TIPS } from "../tips";

export function ExplorerPage({ settings, update }: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  const { game, play } = useGame();
  const fen = game.fen;
  const query = { speeds: settings.explorerSpeeds, ratings: settings.explorerRatings, moves: 15 };
  const { result, status } = useExplorer(fen, query, true, !!settings.lichessToken);
  const analysis = game.analysis.get(game.currentPly);
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));

  return (
    <div className="col">
      <section className="panel">
        <h2>Opening explorer</h2>
        <div className="chips">
          {SPEEDS.map((s) => (
            <label key={s} className="chip" data-tip={TIPS.speed}>
              <input
                type="checkbox"
                checked={settings.explorerSpeeds.includes(s)}
                onChange={(e) => update({ explorerSpeeds: toggle(settings.explorerSpeeds, s, e.target.checked) })}
              />
              {SPEED_LABELS[s]}
            </label>
          ))}
        </div>
        <div className="chips">
          {RATING_CHOICES.map((r) => (
            <label key={r} className="chip" data-tip={TIPS.rating}>
              <input
                type="checkbox"
                checked={settings.explorerRatings.includes(r)}
                onChange={(e) => update({ explorerRatings: toggle(settings.explorerRatings, r, e.target.checked) })}
              />
              {r}
            </label>
          ))}
        </div>
        {result && result.total > 0 && (
          <p className="small" style={{ margin: 0 }}>
            {result.opening && <b>{result.opening} · </b>}
            {result.total.toLocaleString()} games · White {percentages(result.white, result.draws, result.black)[0]}% · Draw{" "}
            {percentages(result.white, result.draws, result.black)[1]}% · Black{" "}
            {percentages(result.white, result.draws, result.black)[2]}%
          </p>
        )}
        {result && result.total === 0 && <p className="small muted">No games for these filters.</p>}
        {status && <p className="small muted" style={{ margin: 0 }}>{status}</p>}
        {result && result.moves.length > 0 && (
          <SortTable
            rows={[...result.moves]}
            columns={explorerColumns(fen, analysis?.evals, analysis?.rankMap, result.total)}
            rowKey={(m) => m.uci}
            onPick={(m) => play(m.uci)}
            initialSort={2}
          />
        )}
        <p className="small muted" style={{ margin: 0 }}>Click a move to play it. The Eval column fills in as Stockfish analyses the position.</p>
      </section>
    </div>
  );
}
