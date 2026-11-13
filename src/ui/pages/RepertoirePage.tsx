/**
 * Repertoire: build a White and a Black repertoire on the analysis board, with Lichess game
 * counts and Stockfish evals for every candidate, then drill it with spaced repetition.
 * Port of the desktop Repertoire tab (ui/repertoire_panel.py).
 */
import { Chess } from "chess.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { ROOT_EPD, START_FEN, epd, isLegal, moveToUci, playUci, sanLine, sanOf } from "../../core/chess";
import { GameState } from "../../core/gameState";
import { type Deviation, type Repertoire, TrainSession, type TrainStep } from "../../core/repertoire";
import { LichessRateLimited, RATING_CHOICES, type MoveStats, makeMoveStats } from "../../data/lichess";
import { Board, type Arrow } from "../Board";
import { useData } from "../data";
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
  const color = settings.repertoireColor === "black" ? "b" : "w";
  const rep = data.repertoire.get(color);

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
      settings={settings}
      update={update}
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
  rep,
  summary,
  onTrain,
}: {
  settings: Settings;
  update: (p: Partial<Settings>) => void;
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
  const [statsRun, setStatsRun] = useState(0);
  useEffect(() => {
    if (!settings.lichessToken) return;
    const todo = rep.missingStats().slice(0, STATS_BATCH);
    if (!todo.length) return;
    let live = true;
    (async () => {
      let fetched = 0;
      for (const e of todo) {
        if (!live) return;
        try {
          const r = await client.explorer(`${e} 0 1`, query);
          rep.recordStats(e, r.total, r.moves.map((m) => [m.uci, m.san, m.total] as [string, string, number]));
          fetched++;
          data.save("repertoire");
        } catch (err) {
          if (err instanceof LichessRateLimited) break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (live && fetched && rep.missingStats().length) setTimeout(() => live && setStatsRun((n) => n + 1), 1000);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rep, settings.lichessToken, query, statsRun, data.version === 0]);

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
    const name = color(rep) === "w" ? "White" : "Black";
    const head = `${name}: ${size} move${size === 1 ? "" : "s"}`;
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
    const size = rep.size();
    rep.remove(epd(before.fen()), last);
    data.save("repertoire");
    const removed = size - rep.size();
    setMessage(`Removed ${removed} move${removed === 1 ? "" : "s"}.`);
  };

  const goToGap = () => {
    const all = rep.gaps(settings.repertoireCoverage);
    if (!all.length) {
      const missing = rep.missingStats().length;
      return setMessage(`No gaps at this coverage.${missing ? ` Still fetching counts for ${missing} positions.` : ""}`);
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
          <select
            value={settings.repertoireColor}
            onChange={(e) => update({ repertoireColor: e.target.value as "white" | "black" })}
            aria-label="Repertoire colour"
            data-tip={TIPS.repColour}
          >
            <option value="white">White repertoire</option>
            <option value="black">Black repertoire</option>
          </select>
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
        <SortTable rows={rows} columns={columns} rowKey={(m) => m.uci} onPick={(m) => (setSelected(m.uci), play(m.uci))} selected={selected} initialSort={2} />
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
        <RepTree rep={rep} onPick={(path) => {
          const s = new GameState();
          s.loadGame(START_FEN, path);
          load(s);
        }} />
      </section>
    </div>
  );
}

function color(rep: Repertoire): "w" | "b" {
  return rep.userToMove(ROOT_EPD) ? "w" : "b";
}

function RepTree({ rep, onPick }: { rep: Repertoire; onPick: (path: string[]) => void }) {
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
              {depth < 40 && render(g.fen(), [...path, uci], depth + 1)}
            </li>
          );
        })}
      </ul>
    );
  };
  const tree = render(START_FEN, [], 0);
  return tree ? <div className="tree" data-tip={TIPS.repTree}>{tree}</div> : <p className="small muted">Your lines appear here.</p>;
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
