/**
 * Repertoire: build a White and a Black repertoire on the analysis board, with Lichess game
 * counts and Stockfish evals for every candidate, then drill it with spaced repetition.
 * Port of the desktop Repertoire tab (ui/repertoire_panel.py).
 */
import { Chess } from "chess.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { ROOT_EPD, START_FEN, epd, fenFromEpd, isLegal, moveToUci, playUci, sanLine, sanOf, turnOf } from "../../core/chess";
import { GameState } from "../../core/gameState";
import {
  type Deviation,
  type MergeCandidate,
  type Repertoire,
  type RepertoireEntry,
  type RepertoireJSON,
  type RepertoireStore,
  TrainSession,
  type TrainStep,
} from "../../core/repertoire";
import { LichessRateLimited, RATING_CHOICES, type MoveStats, makeMoveStats } from "../../data/lichess";
import { Board, type Arrow } from "../Board";
import { INACCURACY, formatCp, winDrop } from "../../core/evaluation";
import { Kind } from "../../engine/scheduler";
import { useData } from "../data";
import { useEngines } from "../engine";
import { useGame } from "../game";
import { SortTable, explorerColumns, useExplorer, useLichess, type Column } from "../lichess";
import type { Settings } from "../settings";
import { TIPS } from "../tips";

const ENGINE_EXTRA = 3;
const STATS_BATCH = 40;
const REPLY_DELAY = 600;

type Mark = { text: string; tip: string; cls: string };

export function RepertoirePage({
  settings,
  update,
  setBoardBusy,
  withBoard,
}: {
  settings: Settings;
  update: (p: Partial<Settings>) => void;
  setBoardBusy: (busy: boolean) => void;
  withBoard: (panel: React.ReactNode) => React.ReactNode;
}) {
  const data = useData();
  const [training, setTraining] = useState<TrainSession | null>(null);
  const [summary, setSummary] = useState("");
  const entry = currentEntry(data.repertoire, settings);
  const rep = entry.rep;

  useEffect(() => {
    setBoardBusy(training !== null);
    return () => setBoardBusy(false);
  }, [training, setBoardBusy]);

  if (training) {
    return (
      <Trainer
        session={training}
        rep={rep}
        onStop={() => {
          setSummary(`Session: ${training.correct} right, ${training.missed} missed in ${training.lines} line${training.lines === 1 ? "" : "s"}.`);
          setTraining(null);
          data.save("repertoire");
        }}
        onChange={() => data.save("repertoire")}
      />
    );
  }
  return withBoard(
    <Builder
      key={entry.id}
      settings={settings}
      update={update}
      entry={entry}
      rep={rep}
      summary={summary}
      onTrain={(practiseAll) => {
        const s = new TrainSession(rep, { practiseAll });
        if (!s.targets.size) {
          setSummary("Nothing is due. Practise all runs through every move.");
          return;
        }
        setSummary("");
        setTraining(s);
      }}
    />
  );
}

// ── Building ─────────────────────────────────────────────────────────────────

function Builder({
  settings,
  update,
  entry,
  rep,
  summary,
  onTrain,
}: {
  settings: Settings;
  update: (p: Partial<Settings>) => void;
  entry: RepertoireEntry;
  rep: Repertoire;
  summary: string;
  onTrain: (practiseAll: boolean) => void;
}) {
  const data = useData();
  const client = useLichess();
  const { game, play, load } = useGame();
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [pendingReplace, setPendingReplace] = useState<{ existing: string; next: string } | null>(null);
  const [undo, setUndo] = useState<{ json: RepertoireJSON; text: string } | null>(null);
  const [merging, setMerging] = useState(false);

  /** Remove one move (and what only it led to), with an Undo. */
  const removeMove = (positionEpd: string, uci: string) => {
    const snapshot = rep.toJSON();
    const san = rep.movesAt(positionEpd).get(uci) ?? uci;
    const size = rep.size();
    rep.remove(positionEpd, uci);
    data.save("repertoire");
    const removed = size - rep.size();
    setMessage("");
    setUndo({ json: snapshot, text: `Removed ${san}${removed > 1 ? ` and ${removed - 1} move${removed === 2 ? "" : "s"} after it` : ""}.` });
  };
  const [deviations, setDeviations] = useState<{ dev: Deviation; count: number; path: string[] }[] | null>(null);
  const fen = game.fen;
  const here = epd(fen);
  const query = useMemo(
    () => ({ speeds: settings.explorerSpeeds, ratings: settings.repertoireRatings, moves: 20 }),
    [settings.explorerSpeeds, settings.repertoireRatings],
  );
  const { result, status } = useExplorer(fen, query, true, !!settings.lichessToken);
  const analysis = game.analysis.get(game.currentPly);
  const line = game.moves.slice(0, game.currentPly);
  const fromStart = epd(game.startFen) === ROOT_EPD;

  // Keep explorer counts for the repertoire's opponent positions (coverage and weighting).
  useEffect(() => {
    if (result && rep.contains(result.epd) && !rep.userToMove(result.epd)) {
      rep.recordStats(result.epd, result.total, result.moves.map((m) => [m.uci, m.san, m.total] as [string, string, number]));
      data.save("repertoire");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, rep]);

  // Fetch counts for the repertoire's positions that have none yet, in the background.
  // One runner at a time; it re-checks after every repertoire change (new lines included).
  const stats = useRef({ running: false, alive: true, failed: new Set<string>(), query, rep });
  stats.current.query = query;
  stats.current.rep = rep;
  const [statsNote, setStatsNote] = useState("");
  useEffect(() => {
    stats.current.alive = true;
    return () => {
      stats.current.alive = false;
    };
  }, []);
  useEffect(() => {
    stats.current.failed.clear(); // new filters or login: try everything again
  }, [query, settings.lichessToken]);
  useEffect(() => {
    const s = stats.current;
    if (!settings.lichessToken || s.running) return;
    const todo = () => s.rep.missingStats().filter((e) => !s.failed.has(e));
    if (!todo().length) return;
    s.running = true;
    (async () => {
      try {
        for (let n = 0; n < STATS_BATCH * 10 && s.alive; n++) {
          const e = todo()[0];
          if (!e) break;
          const target = s.rep;
          try {
            const r = await client.explorer(`${e} 0 1`, s.query);
            target.recordStats(e, r.total, r.moves.map((m) => [m.uci, m.san, m.total] as [string, string, number]));
            if (s.alive) data.save("repertoire");
          } catch (err) {
            if (err instanceof LichessRateLimited) {
              if (s.alive) setStatsNote(`Lichess asked us to wait ${Math.round(err.retryAfter)} s before fetching more counts.`);
              await new Promise((r) => setTimeout(r, err.retryAfter * 1000));
              if (s.alive) setStatsNote("");
              continue;
            }
            s.failed.add(e);
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      } finally {
        s.running = false;
      }
      if (s.alive && todo().length) data.save("repertoire"); // wakes this effect for the rest
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rep, settings.lichessToken, query, data.version]);

  // Auto-play: at the end of the line, on the opponent's turn, play their likeliest reply
  // that the repertoire does not answer yet (once per position reached).
  const autoplayed = useRef("");
  const atEnd = game.currentPly === game.moves.length;
  useEffect(() => {
    if (!settings.repertoireAutoplay || !fromStart || !atEnd || turnOf(fen) === color(rep)) return;
    const spot = `${game.moves.length}|${here}`;
    if (autoplayed.current === spot || !result || result.epd !== here) return;
    autoplayed.current = spot;
    const threshold = result.total / Math.max(1, settings.repertoireCoverage);
    const prepared = rep.movesAt(here);
    const pick = [...result.moves]
      .sort((a, b) => b.total - a.total)
      .find((m) => m.total >= threshold && isLegal(fen, m.uci) && !prepared.has(m.uci) && !rep.transposition(fen, m.uci));
    if (!pick) {
      setMessage(`Every reply here played in at least 1 of ${settings.repertoireCoverage} games is prepared.`);
      return;
    }
    let fired = false;
    const timer = setTimeout(() => {
      fired = true;
      play(pick.uci);
      setMessage(`Opponent played ${pick.san} (${Math.round((100 * pick.total) / Math.max(1, result.total))}% of games), your next unprepared reply.`);
    }, REPLY_DELAY);
    return () => {
      clearTimeout(timer);
      if (!fired && autoplayed.current === spot) autoplayed.current = ""; // try again
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.repertoireAutoplay, fen, atEnd, result, data.version, settings.repertoireCoverage]);

  const gaps = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of rep.gaps(settings.repertoireCoverage)) map.set(`${g.epd}|${g.uci ?? ""}`, g.chance);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rep, settings.repertoireCoverage, data.version]);

  const rows: MoveStats[] = useMemo(() => {
    const out = result && result.epd === here ? [...result.moves] : [];
    const listed = new Set(out.map((m) => m.uci));
    const extra: string[] = [];
    if (analysis) {
      const ranked = Object.keys(analysis.rankMap).sort((a, b) => analysis.rankMap[b] - analysis.rankMap[a]);
      for (const u of ranked) if (!listed.has(u) && extra.length < ENGINE_EXTRA) extra.push(u);
    }
    for (const u of rep.movesAt(here).keys()) if (!listed.has(u) && !extra.includes(u)) extra.push(u);
    for (const u of extra) if (isLegal(fen, u)) out.push(makeMoveStats(u, sanOf(fen, u), 0, 0, 0, null));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, here, analysis, rep, data.version, fen]);

  const markOf = (m: MoveStats): Mark => {
    if (rep.movesAt(here).has(m.uci)) {
      return rep.userToMove(here)
        ? { text: "★ your move", tip: "Your repertoire move here", cls: "warn" }
        : { text: "✓ prepared", tip: "You have prepared this reply", cls: "good" };
    }
    const path = rep.transposition(fen, m.uci);
    if (path) {
      const l = sanLine(path);
      return { text: `↪ joins ${l}`, tip: `This move reaches your line ${l} by another move order`, cls: "" };
    }
    if (!rep.userToMove(here) && rep.contains(here)) {
      const chance = gaps.get(`${here}|${m.uci}`);
      if (chance !== undefined) return { text: `⚠ gap (${(chance * 100).toFixed(1)}%)`, tip: "Not prepared; comes up in about this share of your games", cls: "bad" };
    }
    return { text: "", tip: "", cls: "" };
  };

  const columns: Column<MoveStats>[] = [
    ...explorerColumns(fen, analysis?.evals, analysis?.rankMap, result?.total ?? 0),
    {
      head: "Repertoire",
      title: TIPS.repMark,
      cell: (m) => {
        const k = markOf(m);
        return (
          <span className={k.cls} data-tip={k.tip || undefined}>
            {k.text}
          </span>
        );
      },
      sort: (m) => markOf(m).text,
    },
  ];

  const status_ = (() => {
    if (!fromStart) return "The board does not start from the initial position.";
    const size = rep.size();
    const side = color(rep) === "w" ? "White" : "Black";
    const head = `${entry.name} (${side}): ${size} move${size === 1 ? "" : "s"}`;
    if (size === 0) return `${head} · play a line on the board and press Add line to here.`;
    let g = new Chess(START_FEN);
    let leftAt: string | null = null;
    for (const u of line) {
      if (!rep.movesAt(epd(g.fen())).has(u)) {
        leftAt = sanLine([u], g.fen());
        break;
      }
      playUci(g, u);
    }
    g = g as Chess;
    if (leftAt === null) {
      if (rep.userToMove(here) && rep.userMove(here) === null) return `${head} · in your repertoire, but you have no move here yet.`;
      return `${head} · in your repertoire.`;
    }
    const path = rep.pathTo(here);
    return `${head} · left your repertoire at ${leftAt}${path ? ` (it rejoins your line ${sanLine(path)})` : ""}.`;
  })();

  const addLine = (replace: boolean) => {
    if (!fromStart) return setMessage("Lines must start from the initial position.");
    if (!line.length) return setMessage("Play the line on the board first.");
    const clash = rep.conflict(START_FEN, line);
    if (clash && !replace) {
      setPendingReplace({ existing: clash[0], next: clash[1] });
      return;
    }
    setPendingReplace(null);
    const added = rep.addLine(START_FEN, line, { replace });
    data.save("repertoire");
    setMessage(`Added ${added} move${added === 1 ? "" : "s"}.`);
  };

  const removeLast = () => {
    if (!line.length) return;
    const before = new Chess(game.startFen);
    for (const u of line.slice(0, -1)) playUci(before, u);
    const last = line[line.length - 1];
    if (!rep.movesAt(epd(before.fen())).has(last)) return setMessage("That move is not in your repertoire.");
    removeMove(epd(before.fen()), last);
  };

  const goToGap = () => {
    const all = rep.gaps(settings.repertoireCoverage);
    if (!all.length) {
      const missing = rep.missingStats();
      const failed = missing.filter((e) => stats.current.failed.has(e)).length;
      const waiting = missing.length - failed;
      const s = (n: number) => `${n} position${n === 1 ? "" : "s"}`;
      let note = "";
      if (missing.length && !settings.lichessToken) note = ` Log in with Lichess in Settings to get game counts for ${s(missing.length)}.`;
      else {
        if (waiting) note += ` Still fetching game counts for ${s(waiting)}; try again in a moment.`;
        if (failed) note += ` Lichess gave no counts for ${s(failed)}.`;
      }
      return setMessage(`No gaps at this coverage.${note}${statsNote ? ` ${statsNote}` : ""}`);
    }
    const g = all[0];
    const s = new GameState();
    s.loadGame(START_FEN, g.uci ? [...g.path, g.uci] : [...g.path]);
    load(s);
    setMessage(`Biggest gap: ${g.uci ? `${g.san} is not prepared` : "you have no move here"} (about ${(g.chance * 100).toFixed(1)}% of your games).`);
  };

  const checkGames = () => {
    const user = settings.chesscomUsername.trim();
    if (!user || !data.library.hasUser(user)) return setMessage("Download your chess.com games on the Puzzles tab first.");
    if (!rep.nodes.size) return setMessage("Add some lines first.");
    const counts = new Map<string, { dev: Deviation; count: number; path: string[] }>();
    let checked = 0;
    for (const g of data.library.games(user)) {
      if (g.userColor !== color(rep)) continue;
      const c = new Chess();
      try {
        c.loadPgn(g.pgn);
      } catch {
        continue;
      }
      const hist = c.history({ verbose: true });
      if (!hist.length || epd(hist[0].before) !== ROOT_EPD) continue;
      checked++;
      const ucis = hist.map(moveToUci);
      const dev = rep.checkGame(g.url, START_FEN, ucis);
      if (!dev) continue;
      const key = `${dev.epd}|${dev.byUser}|${dev.playedSan}|${dev.expectedSan}`;
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { dev, count: 1, path: [...dev.path, ucis[dev.ply]] });
    }
    const list = [...counts.values()].sort((a, b) => b.count - a.count);
    setDeviations(list);
    setMessage(`Checked ${checked} games as ${color(rep) === "w" ? "White" : "Black"}: ${list.reduce((n, d) => n + d.count, 0)} left the repertoire.`);
  };

  const due = rep.due().length;
  const toggle = (list: number[], v: number, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));

  return (
    <div className="col">
      <section className="panel">
        <div className="row">
          <RepertoirePicker update={update} entry={entry} />
        </div>
        <div className="row">
          <label className="small row" style={{ gap: 4 }} data-tip={TIPS.repCoverage}>
            Cover replies played in 1 of
            <input
              type="number"
              min={5}
              max={1000}
              value={settings.repertoireCoverage}
              onChange={(e) => update({ repertoireCoverage: Math.max(5, Math.min(1000, Number(e.target.value) || 50)) })}
              style={{ width: 72 }}
            />
            games
          </label>
        </div>
        <div className="chips">
          <span className="small muted">Lichess ratings:</span>
          {RATING_CHOICES.filter((r) => r <= 2000).map((r) => (
            <label key={r} className="chip" data-tip={TIPS.repRating}>
              <input
                type="checkbox"
                checked={settings.repertoireRatings.includes(r)}
                onChange={(e) => {
                  rep.stats.clear(); // counts at other ratings no longer apply
                  update({ repertoireRatings: toggle(settings.repertoireRatings, r, e.target.checked) });
                }}
              />
              {r}
            </label>
          ))}
        </div>
        <p style={{ margin: 0 }}>{status_}</p>
        {(status || result?.opening) && (
          <p className="small muted" style={{ margin: 0 }}>
            {status || `${result?.opening} · ${result?.total.toLocaleString()} Lichess games at these ratings`}
          </p>
        )}
        <SortTable rows={rows} columns={columns} rowKey={(m) => m.uci} onPick={(m) => (setSelected(m.uci), play(m.uci))}
          selected={selected}
          sortSpec={turnOf(fen) === "w" ? settings.sortWhite : settings.sortBlack}
          onSortChange={(spec) => update(turnOf(fen) === "w" ? { sortWhite: spec } : { sortBlack: spec })}
        />
        <div className="row">
          <button className="btn primary" type="button" onClick={() => addLine(false)} data-tip={TIPS.repAdd}>
            Add line to here
          </button>
          <button className="btn" type="button" onClick={removeLast} data-tip={TIPS.repRemove}>
            Remove last move
          </button>
          <button className="btn" type="button" onClick={goToGap} data-tip={TIPS.repGap}>
            Go to biggest gap
          </button>
          <label className="chip" data-tip={TIPS.repAutoplay}>
            <input
              type="checkbox"
              checked={settings.repertoireAutoplay}
              onChange={(e) => update({ repertoireAutoplay: e.target.checked })}
            />
            Auto-play opponent
          </label>
          <button className="btn" type="button" onClick={() => setMerging((m) => !m)} aria-pressed={merging} data-tip={TIPS.repMerge}>
            Merge my lines
          </button>
        </div>
        {pendingReplace && (
          <div className="row warn small">
            Your repertoire plays {pendingReplace.existing} here. Replace it with {pendingReplace.next}? Lines that only{" "}
            {pendingReplace.existing} led to are removed.
            <button className="btn" type="button" onClick={() => addLine(true)}>
              Replace
            </button>
            <button className="btn" type="button" onClick={() => setPendingReplace(null)}>
              Keep
            </button>
          </div>
        )}
        {(message || summary) && <p className="small" style={{ margin: 0 }}>{message || summary}</p>}
        {undo && (
          <div className="row small">
            <span>{undo.text}</span>
            <button
              className="btn"
              type="button"
              data-tip={TIPS.repUndo}
              onClick={() => {
                data.repertoire.restore(entry.id, undo.json);
                data.save("repertoire");
                setUndo(null);
                setMessage("Restored.");
              }}
            >
              Undo
            </button>
          </div>
        )}
        {merging && (
          <MergePanel
            rep={rep}
            depth={settings.depth}
            version={data.version}
            onShow={(path) => {
              const s = new GameState();
              s.loadGame(START_FEN, [...path]);
              load(s);
            }}
            onMerge={(picks) => {
              const snapshot = rep.toJSON();
              const sizeBefore = rep.size();
              let merged = 0;
              for (const p of picks) {
                // An earlier merge can remove this one's position or target: re-check it.
                const still = rep.mergeCandidates().find((c) => c.epd === p.epd && c.current === p.current && c.uci === p.uci);
                if (!still) continue;
                rep.swapUserMove(p.epd, p.uci);
                merged++;
              }
              if (!merged) return setMessage("Nothing left to merge: your lines changed.");
              data.save("repertoire");
              const removed = sizeBefore - rep.size();
              setMessage("");
              setUndo({
                json: snapshot,
                text: `Merged ${merged} line${merged === 1 ? "" : "s"}; ${removed} move${removed === 1 ? "" : "s"} fewer to learn.`,
              });
            }}
          />
        )}
        <p className="small muted" style={{ margin: 0 }}>Click a move in the table to play it on the board.</p>
      </section>

      <section className="panel">
        <div className="row">
          <h2 className="grow">Train</h2>
          <button className="btn primary" type="button" disabled={!due} onClick={() => onTrain(false)} data-tip={TIPS.repTrain}>
            Train due ({due})
          </button>
          <button className="btn" type="button" disabled={!rep.cards.size} onClick={() => onTrain(true)} data-tip={TIPS.repPractise}>
            Practise all
          </button>
          <button className="btn" type="button" onClick={checkGames} data-tip={TIPS.repCheck}>
            Check my games
          </button>
        </div>
        {deviations && deviations.length > 0 && (
          <SortTable
            rows={deviations}
            rowKey={(d) => `${d.dev.epd}|${d.dev.byUser}|${d.dev.playedSan}`}
            onPick={(d) => {
              const s = new GameState();
              s.loadGame(START_FEN, d.path);
              load(s);
            }}
            initialSort={0}
            columns={[
              { head: "Games", num: true, cell: (d) => d.count, sort: (d) => d.count },
              { head: "Who left", cell: (d) => (d.dev.byUser ? <span className="warn">You</span> : "Opponent"), sort: (d) => String(d.dev.byUser) },
              { head: "After", cell: (d) => sanLine(d.dev.path) || "start" },
              { head: "Played", cell: (d) => d.dev.playedSan },
              { head: "Your move", cell: (d) => d.dev.expectedSan || (d.dev.byUser ? "—" : "") },
            ]}
          />
        )}
        <RepTree rep={rep} onRemove={removeMove} onPick={(path) => {
          const s = new GameState();
          s.loadGame(START_FEN, path);
          load(s);
        }} />
      </section>
    </div>
  );
}

/** The repertoire chosen in the settings, falling back to the first of the remembered colour. */
function currentEntry(store: RepertoireStore, settings: Settings): RepertoireEntry {
  const chosen = store.find(settings.repertoireId);
  if (chosen) return chosen;
  const c = settings.repertoireColor === "black" ? "b" : "w";
  store.get(c); // creates one if the colour has none
  return store.byColor(c)[0];
}

/** Choose, create, rename, duplicate and delete repertoires. */
function RepertoirePicker({
  update,
  entry,
}: {
  update: (p: Partial<Settings>) => void;
  entry: RepertoireEntry;
}) {
  const data = useData();
  const store = data.repertoire;
  const [mode, setMode] = useState<null | "new" | "rename" | "delete">(null);
  const [name, setName] = useState("");
  const [newColor, setNewColor] = useState<"w" | "b">(entry.color);
  const choose = (e: RepertoireEntry) => update({ repertoireId: e.id, repertoireColor: e.color === "w" ? "white" : "black" });
  const groups: ["w" | "b", string][] = [
    ["w", "White"],
    ["b", "Black"],
  ];

  return (
    <div style={{ display: "grid", gap: 6, flex: 1, minWidth: 0 }}>
      <div className="row">
        <select
          value={entry.id}
          onChange={(e) => {
            const next = store.find(e.target.value);
            if (next) choose(next);
            setMode(null);
          }}
          aria-label="Repertoire"
          data-tip={TIPS.repColour}
          style={{ flex: "1 1 180px" }}
        >
          {groups.map(([c, label]) => (
            <optgroup key={c} label={label}>
              {store.byColor(c).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} · {e.rep.size()} moves
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button className="btn" type="button" data-tip={TIPS.repNew} onClick={() => { setMode("new"); setName(""); setNewColor(entry.color); }}>
          New
        </button>
        <button className="btn" type="button" data-tip={TIPS.repRename} onClick={() => { setMode("rename"); setName(entry.name); }}>
          Rename
        </button>
        <button
          className="btn"
          type="button"
          data-tip={TIPS.repDuplicate}
          onClick={() => {
            const copy = store.duplicate(entry.id);
            if (copy) {
              data.save("repertoire");
              choose(copy);
            }
            setMode(null);
          }}
        >
          Duplicate
        </button>
        <button className="btn" type="button" data-tip={TIPS.repDelete} onClick={() => setMode("delete")}>
          Delete
        </button>
      </div>
      {mode === "new" && (
        <form
          className="row"
          onSubmit={(ev) => {
            ev.preventDefault();
            const created = store.create(name, newColor);
            data.save("repertoire");
            choose(created);
            setMode(null);
          }}
        >
          <input id="rep-new-name" type="text" autoFocus placeholder="Name, e.g. Sharp 1.e4" value={name} onChange={(e) => setName(e.target.value)} className="grow" />
          <select value={newColor} onChange={(e) => setNewColor(e.target.value as "w" | "b")} aria-label="Colour">
            <option value="w">White</option>
            <option value="b">Black</option>
          </select>
          <button className="btn primary" type="submit">Create</button>
          <button className="btn" type="button" onClick={() => setMode(null)}>Cancel</button>
        </form>
      )}
      {mode === "rename" && (
        <form
          className="row"
          onSubmit={(ev) => {
            ev.preventDefault();
            store.rename(entry.id, name);
            data.save("repertoire");
            setMode(null);
          }}
        >
          <input id="rep-rename" type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} className="grow" />
          <button className="btn primary" type="submit">Save</button>
          <button className="btn" type="button" onClick={() => setMode(null)}>Cancel</button>
        </form>
      )}
      {mode === "delete" && (
        <div className="row small">
          <span className="bad">
            Delete “{entry.name}” and its {entry.rep.size()} moves? This can't be undone.
          </span>
          <button
            className="btn"
            type="button"
            onClick={() => {
              store.remove(entry.id);
              const fallback = store.byColor(entry.color)[0] ?? store.entries[0] ?? store.create("", entry.color);
              data.save("repertoire");
              choose(fallback);
              setMode(null);
            }}
          >
            Delete
          </button>
          <button className="btn" type="button" onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

function color(rep: Repertoire): "w" | "b" {
  return rep.userToMove(ROOT_EPD) ? "w" : "b";
}

function RepTree({
  rep,
  onPick,
  onRemove,
}: {
  rep: Repertoire;
  onPick: (path: string[]) => void;
  onRemove: (positionEpd: string, uci: string) => void;
}) {
  const now = Date.now() / 1000;
  const shown = new Set<string>();
  const render = (fen: string, path: string[], depth: number): JSX.Element | null => {
    const e = epd(fen);
    if (shown.has(e)) return null;
    shown.add(e);
    const moves = [...rep.movesAt(e).keys()];
    if (!moves.length) return null;
    return (
      <ul>
        {moves.map((uci) => {
          const g = new Chess(fen);
          playUci(g, uci);
          const label = sanLine([uci], fen);
          const card = rep.userToMove(e) ? rep.cards.get(e) : undefined;
          const tag = card && card.isDue(now) ? (card.learned ? " · due" : " · new") : "";
          const afterE = epd(g.fen());
          const joined = shown.has(afterE) ? rep.pathTo(afterE) : null;
          return (
            <li key={uci}>
              <button type="button" onClick={() => onPick([...path, uci])}>
                {label}
                <span className="muted small">{tag}</span>
                {joined && <span className="muted small"> ↪ continues at {sanLine(joined)}</span>}
              </button>
              <button type="button" className="tree-x" aria-label={`Remove ${label}`} data-tip={TIPS.repRemoveMove} onClick={() => onRemove(e, uci)}>
                ✕
              </button>
              {depth < 40 && render(g.fen(), [...path, uci], depth + 1)}
            </li>
          );
        })}
      </ul>
    );
  };
  const tree = render(START_FEN, [], 0);
  return tree ? <div className="tree">{tree}</div> : <p className="small muted">Your lines appear here.</p>;
}

// ── Training ─────────────────────────────────────────────────────────────────

function Trainer({
  session,
  rep,
  onStop,
  onChange,
}: {
  session: TrainSession;
  rep: Repertoire;
  onStop: () => void;
  onChange: () => void;
}) {
  const [fen, setFen] = useState<string>(START_FEN);
  const [lastMove, setLastMove] = useState<string | null>(null);
  const [expected, setExpected] = useState<TrainStep | null>(null);
  const [prompt, setPrompt] = useState("");
  const [feedback, setFeedback] = useState<{ text: string; cls: string }>({ text: "", cls: "" });
  const [arrows, setArrows] = useState<Arrow[]>([]);
  const [flash, setFlash] = useState<{ squares: string[]; kind: "good" | "bad"; key: number } | null>(null);
  const [done, setDone] = useState(false);
  const missedHere = useRef(false);
  const tries = useRef(0);
  const token = useRef(0);
  const fenRef = useRef(fen);
  fenRef.current = fen;

  const advance = (tok: number, at: string) => {
    if (tok !== token.current) return;
    const step = session.step(at);
    if (step.kind === "opponent" && step.uci) {
      setPrompt("Opponent to move…");
      const uci = step.uci;
      setTimeout(() => {
        if (tok !== token.current) return;
        const g = new Chess(at);
        playUci(g, uci);
        setFen(g.fen());
        setLastMove(uci);
        setTimeout(() => advance(tok, g.fen()), 260);
      }, REPLY_DELAY);
      return;
    }
    if (step.kind === "user" && step.uci) {
      setExpected(step);
      missedHere.current = false;
      tries.current = 0;
      if (step.learn) {
        setArrows([{ from: step.uci.slice(0, 2), to: step.uci.slice(2, 4), color: "#2e9d5a" }]);
        setPrompt(`New move: play ${sanOf(at, step.uci)}.`);
      } else {
        setArrows([]);
        setPrompt("Your move: play your repertoire move.");
      }
      return;
    }
    setPrompt("End of this line.");
    setTimeout(() => tok === token.current && nextLine(), REPLY_DELAY + 300);
  };

  const nextLine = () => {
    token.current += 1;
    setExpected(null);
    setArrows([]);
    const start = session.startLine();
    if (!start) {
      setDone(true);
      setPrompt(`Done: ${session.correct} right, ${session.missed} missed.`);
      setFeedback({ text: "", cls: "" });
      return;
    }
    setFen(start);
    setLastMove(null);
    setFeedback({ text: "", cls: "" });
    const tok = token.current;
    setTimeout(() => advance(tok, start), 50);
  };

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // React's development double-run must not start two lines
    started.current = true;
    nextLine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const miss = (at: string) => {
    if (!missedHere.current) {
      missedHere.current = true;
      session.answer(epd(at), false);
      onChange();
    }
  };

  const onMove = (uci: string): boolean => {
    const step = expected;
    const at = fenRef.current;
    if (!step || !step.uci) return false;
    const e = epd(at);
    if (uci === step.uci) {
      setExpected(null);
      if (step.learn) {
        session.answer(e, true, { learnedNow: true });
        setFeedback({ text: "Learned. It comes back without the arrow later.", cls: "good" });
      } else if (!missedHere.current) {
        session.answer(e, true);
        setFeedback({ text: "Correct.", cls: "good" });
      } else {
        setFeedback({ text: "That's it.", cls: "warn" });
      }
      onChange();
      setArrows([]);
      const g = new Chess(at);
      playUci(g, uci);
      setFen(g.fen());
      setLastMove(uci);
      setFlash({ squares: [uci.slice(2, 4)], kind: "good", key: Date.now() });
      const tok = token.current;
      setTimeout(() => advance(tok, g.fen()), 260);
      return true;
    }
    if (step.learn) {
      setFeedback({ text: "Play the move shown by the arrow.", cls: "bad" });
      return false;
    }
    const joins = rep.transposition(at, uci);
    if (joins) {
      setFeedback({ text: `That reaches your line ${sanLine(joins)} by another move order, but your move here is a different one. Try again.`, cls: "warn" });
      return false;
    }
    miss(at);
    tries.current += 1;
    if (tries.current >= 2) {
      setArrows([{ from: step.uci.slice(0, 2), to: step.uci.slice(2, 4), color: "#2e9d5a" }]);
      setFeedback({ text: "Not your repertoire move. Play the move shown by the arrow.", cls: "bad" });
    } else {
      setFeedback({ text: "Not your repertoire move. Try again.", cls: "bad" });
    }
    return false;
  };

  const hint = () => {
    if (!expected?.uci) return;
    miss(fenRef.current);
    setFlash({ squares: [expected.uci.slice(0, 2)], kind: "good", key: Date.now() });
    setFeedback({ text: `Hint: move the piece on ${expected.uci.slice(0, 2)}.`, cls: "warn" });
  };
  const showMove = () => {
    if (!expected?.uci) return;
    miss(fenRef.current);
    setArrows([{ from: expected.uci.slice(0, 2), to: expected.uci.slice(2, 4), color: "#2e9d5a" }]);
    setFeedback({ text: "Play the move shown by the arrow.", cls: "warn" });
  };

  const orientation = rep.userToMove(ROOT_EPD) ? "w" : "b";
  return (
    <div className="layout">
      <div className="col board-col" style={{ "--extras": "0px" } as React.CSSProperties}>
        <Board
          fen={fen}
          orientation={orientation}
          lastMove={lastMove}
          animate
          movable={expected ? orientation : "none"}
          onMove={onMove}
          arrows={arrows}
          flash={flash}
        />
      </div>
      <div className="col">
        <section className="panel">
          <h2>Training</h2>
          <p className="small muted" style={{ margin: 0 }}>
            Line {session.lines} · {session.remaining} to go · {session.correct} right, {session.missed} missed
          </p>
          <p style={{ margin: 0 }}>{prompt}</p>
          <p className={`feedback ${feedback.cls}`} style={{ margin: 0 }}>
            {feedback.text}
          </p>
          <div className="row">
            <button className="btn" type="button" onClick={hint} disabled={done || !expected} data-tip={TIPS.trainHint}>
              Hint
            </button>
            <button className="btn" type="button" onClick={showMove} disabled={done || !expected} data-tip={TIPS.trainShow}>
              Show move
            </button>
            <button className="btn" type="button" onClick={nextLine} disabled={done} data-tip={TIPS.trainSkip}>
              Skip line
            </button>
            <button className="btn primary" type="button" onClick={onStop} data-tip={TIPS.trainStop}>
              {done ? "Back to building" : "Stop"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

// ── Merging lines ────────────────────────────────────────────────────────────

type MergeCheck = { current: number; alt: number; drop: number } | "pending";

/** Moves that would turn one of your lines into another, each checked by the engine. */
function MergePanel({
  rep,
  depth,
  version,
  onShow,
  onMerge,
}: {
  rep: Repertoire;
  depth: number;
  version: number;
  onShow: (path: readonly string[]) => void;
  onMerge: (picks: MergeCandidate[]) => void;
}) {
  const { main } = useEngines();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const found = useMemo(() => rep.mergeCandidates(), [rep, version]);
  const [checks, setChecks] = useState<Record<string, MergeCheck>>({});
  const keyOf = (c: MergeCandidate) => `${c.epd}|${c.current}|${c.uci}|${depth}`;
  const side = rep.color;

  useEffect(() => {
    if (!main) return;
    const ids: number[] = [];
    const asked: Record<string, MergeCheck> = {};
    for (const c of found) {
      const key = keyOf(c);
      if (checks[key]) continue;
      asked[key] = "pending";
      ids.push(
        main.submit({
          kind: Kind.BATCH,
          fen: fenFromEpd(c.epd),
          moves: [c.current, c.uci],
          depth,
          onDone: (r) => {
            const a = r.evals[c.current];
            const b = r.evals[c.uci];
            if (!a || !b) return;
            setChecks((m) => ({ ...m, [key]: { current: a.cpWhite, alt: b.cpWhite, drop: winDrop(a.cpWhite, b.cpWhite, side) } }));
          },
        }),
      );
    }
    if (ids.length) setChecks((m) => ({ ...m, ...asked }));
    return () => {
      ids.forEach((id) => main.cancel(id));
      // Unfinished checks are asked again next time.
      setChecks((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== "pending")));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found, main, depth]);

  const checked = (c: MergeCandidate) => {
    const k = checks[keyOf(c)];
    return k && k !== "pending" ? k : null;
  };
  const pending = found.filter((c) => !checked(c)).length;
  const good = found.filter((c) => (checked(c)?.drop ?? 1) < INACCURACY);

  if (!found.length) {
    return (
      <p className="small" style={{ margin: 0 }}>
        No merges found: none of your own moves can be swapped for one that lands straight in another of your lines.
        Move orders that already reach the same position are joined automatically.
      </p>
    );
  }
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row small">
        <span className="grow">
          {found.length} possible merge{found.length === 1 ? "" : "s"}
          {pending ? ` · engine checking ${pending}…` : ""}. A merge swaps one of your moves for one that joins another of
          your lines, so you have fewer moves to learn.
        </span>
        <button
          className="btn primary"
          type="button"
          disabled={!good.length || pending > 0}
          onClick={() => onMerge(good)}
          data-tip={TIPS.repMergeAll}
        >
          Merge all sound ({good.length})
        </button>
      </div>
      <SortTable
        rows={found}
        rowKey={keyOf}
        onPick={(c) => onShow(c.path)}
        initialSort={2}
        columns={[
          {
            head: "Where",
            title: "Your position where the move would change. Click a row to show it on the board.",
            cell: (c) => sanLine(c.path) || "start",
            sort: (c) => c.path.length,
          },
          {
            head: "Swap",
            title: "Your move now, then the move that joins the other line.",
            cell: (c) => (
              <span>
                {c.currentSan} → <b>{c.san}</b>
              </span>
            ),
          },
          { head: "Saves", num: true, title: "Moves that leave your repertoire with the old move.", cell: (c) => c.saved, sort: (c) => c.saved },
          { head: "Joins", title: "The line the new move transposes into.", cell: (c) => sanLine(c.joins) },
          {
            head: "Engine",
            num: true,
            title: "Evaluation after your move now and after the joining move. Green: sound, it gives up less than an inaccuracy's worth.",
            cell: (c) => {
              const k = checked(c);
              if (!k) return <span className="muted">…</span>;
              const sound = k.drop < INACCURACY;
              return (
                <span className={sound ? "good" : "bad"} data-tip={sound ? "Sound swap" : "The joining move is clearly worse"}>
                  {formatCp(k.current)} → {formatCp(k.alt)}
                </span>
              );
            },
            sort: (c) => -(checked(c)?.drop ?? 9),
          },
          {
            head: "Merge",
            title: "Apply this one swap.",
            cell: (c) => (
              <button
                className="btn"
                type="button"
                data-tip={TIPS.repMergeOne}
                onClick={(e) => {
                  e.stopPropagation();
                  onMerge([c]);
                }}
              >
                Merge
              </button>
            ),
          },
        ]}
      />
    </div>
  );
}
