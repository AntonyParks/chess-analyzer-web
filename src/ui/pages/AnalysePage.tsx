/** Analyse: move list, engine lines, loading and saving games, board options. */
import { useRef, useState } from "react";
import { START_FEN, board as makeBoard, sanLine, turnOf } from "../../core/chess";
import { cpPov, formatCp } from "../../core/evaluation";
import { GameState } from "../../core/gameState";
import { useGame } from "../game";
import type { Settings } from "../settings";

export function MoveList() {
  const { game, goto } = useGame();
  const labels = game.sanLabels();
  const evals = game.positionEvals();
  const rows: { num: number; white?: number; black?: number }[] = [];
  labels.forEach((l, i) => {
    const ply = i + 1;
    if (l.white || rows.length === 0) rows.push({ num: l.num });
    const row = rows[rows.length - 1];
    if (l.white) row.white = ply;
    else row.black = ply;
  });
  const cell = (ply?: number) => {
    if (!ply) return <span />;
    const marker = game.markerAt(ply, evals);
    const cls = marker === "??" || marker === "?" ? "marker-bad" : marker === "?!" ? "marker-warn" : "";
    return (
      <button type="button" className={ply === game.currentPly ? "cur" : ""} onClick={() => goto(ply)}>
        {labels[ply - 1].san}
        {marker && <span className={cls}>{marker}</span>}
      </button>
    );
  };
  if (!labels.length) return <p className="muted small">Play moves on the board, or paste a PGN below.</p>;
  return (
    <div className="moves">
      {rows.map((r) => (
        <div key={`${r.num}-${r.white ?? r.black}`} style={{ display: "contents" }}>
          <span className="n">{r.num}.</span>
          {r.white ? cell(r.white) : <span className="muted">…</span>}
          {cell(r.black)}
        </div>
      ))}
    </div>
  );
}

export function EngineLines({ count = 3 }: { count?: number }) {
  const { game, play } = useGame();
  const analysis = game.analysis.get(game.currentPly);
  const fen = game.fen;
  const turn = turnOf(fen);
  if (!analysis || !Object.keys(analysis.evals).length) return <p className="muted small">Waiting for the engine…</p>;
  const top = Object.entries(analysis.evals)
    .sort((a, b) => cpPov(b[1].cpWhite, turn) - cpPov(a[1].cpWhite, turn))
    .slice(0, count);
  return (
    <div className="lines">
      {top.map(([uci, ev]) => (
        <div key={uci} className="row" style={{ flexWrap: "nowrap" }}>
          <button type="button" className="btn" style={{ minHeight: 26, minWidth: 64 }} onClick={() => play(uci)}>
            {formatCp(ev.cpWhite)}
          </button>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{sanLine([uci, ...ev.pv.slice(0, 8)], fen)}</span>
        </div>
      ))}
    </div>
  );
}

export function AnalysePage({ settings, update }: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  const { game, load } = useGame();
  const [text, setText] = useState("");
  const [message, setMessage] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const loadText = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    try {
      if (/^([rnbqkpRNBQKP1-8]+\/){7}[rnbqkpRNBQKP1-8]+\s+[wb]/.test(t)) {
        makeBoard(t); // validates
        const s = new GameState(t);
        load(s);
        setMessage("Position loaded.");
      } else {
        load(GameState.fromPgn(t));
        setMessage("Game loaded.");
      }
    } catch (err) {
      setMessage(`Could not read that: ${(err as Error).message}`);
    }
  };

  const download = () => {
    const blob = new Blob([game.toPgn()], { type: "application/x-chess-pgn" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "game.pgn";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const share = async () => {
    const url = new URL(location.href);
    url.search = "";
    url.searchParams.set("fen", game.fen);
    url.hash = "analyse";
    try {
      await navigator.clipboard.writeText(url.toString());
      setMessage("Link to this position copied.");
    } catch {
      setMessage(url.toString());
    }
  };

  return (
    <div className="col">
      <section className="panel">
        <div className="row">
          <h2 className="grow">Moves</h2>
          <label className="chip">
            <input type="checkbox" checked={settings.heatmap} onChange={(e) => update({ heatmap: e.target.checked })} />
            Heatmap
          </label>
          <label className="chip">
            <input type="checkbox" checked={settings.arrow} onChange={(e) => update({ arrow: e.target.checked })} />
            Best move
          </label>
          <label className="chip">
            <input type="checkbox" checked={settings.flip} onChange={(e) => update({ flip: e.target.checked })} />
            Flip
          </label>
        </div>
        <MoveList />
      </section>
      <section className="panel">
        <div className="row">
          <h2 className="grow">Engine</h2>
          <label className="small muted" htmlFor="depth">
            Depth
          </label>
          <input
            id="depth"
            type="number"
            min={6}
            max={24}
            value={settings.depth}
            onChange={(e) => update({ depth: Math.max(6, Math.min(24, Number(e.target.value) || 14)) })}
            style={{ width: 64 }}
          />
        </div>
        <EngineLines />
        <p className="small muted" style={{ margin: 0 }}>
          Tap a piece to see the evaluation of each of its moves. Heatmap colours run from red (worst) to gold (best).
        </p>
      </section>
      <section className="panel">
        <h2>Load or save</h2>
        <textarea
          id="pgn-input"
          rows={4}
          placeholder="Paste a PGN or a FEN"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="row">
          <button className="btn primary" type="button" onClick={() => loadText(text)}>
            Load
          </button>
          <button className="btn" type="button" onClick={() => fileRef.current?.click()}>
            Open PGN file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".pgn,text/plain"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) loadText(await f.text());
              e.target.value = "";
            }}
          />
          <button className="btn" type="button" onClick={download} disabled={!game.moves.length}>
            Download PGN
          </button>
          <button className="btn" type="button" onClick={share}>
            Share position
          </button>
          <button className="btn" type="button" onClick={() => load(new GameState(START_FEN))}>
            New game
          </button>
        </div>
        {message && <p className="small muted" style={{ margin: 0, overflowWrap: "anywhere" }}>{message}</p>}
      </section>
    </div>
  );
}
