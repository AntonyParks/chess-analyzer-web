/**
 * Puzzles from your games: download your chess.com games once, scan them for your own
 * mistakes in the background, and replay each as a puzzle (port of ui/puzzles_panel.py).
 */
import { useCarryBoard } from "../game";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { PIECE_NAMES, after, sanLine, sanOf } from "../../core/chess";
import { explainMove } from "../../core/moveExplain";
import { PuzzleScanner, estimateSeconds, formatDuration } from "../../core/puzzleScan";
import {
  MARKERS,
  MARKER_LABELS,
  MAX_LOOKAHEAD,
  ORDERS,
  type Puzzle,
  PuzzleFilter,
  type PuzzleStep,
  isAcceptable,
  lookaheadValue,
  puzzleLabel,
  stepsWithin,
} from "../../core/puzzles";
import { ChessComClient, ChessComError, TIME_CLASSES, TIME_CLASS_LABELS } from "../../data/chesscom";
import { fetchUpdates } from "../../data/gameLibrary";
import { Board, numberedLine, type Arrow } from "../Board";
import { useData, type DataApi } from "../data";
import { useEngines, type Engines } from "../engine";
import type { Settings } from "../settings";
import { TIPS } from "../tips";

const MARKER_TIPS: Record<string, string> = { "??": TIPS.markerBlunders, "?": TIPS.markerMistakes, "?!": TIPS.markerInaccuracies };
const MODE_LABELS: Record<string, string> = { unsolved: "Unsolved", failed: "Retry failed", all: "All puzzles" };
const REPLY_DELAY = 600;

// ── The scan lives outside the page so it keeps running when you switch tabs ──

interface ScanState {
  running: boolean;
  text: string;
}
let scanState: ScanState = { running: false, text: "" };
const listeners = new Set<() => void>();
let scanner: PuzzleScanner | null = null;
let stopRequested = false;
function setScan(patch: Partial<ScanState>) {
  scanState = { ...scanState, ...patch };
  listeners.forEach((l) => l());
}
function useScanState(): ScanState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => scanState,
  );
}

async function downloadAndScan(data: DataApi, engines: Engines, settings: Settings): Promise<void> {
  const username = settings.chesscomUsername.trim();
  if (!username) return setScan({ text: "Enter your chess.com username first." });
  if (!settings.puzzleTimeClasses.length) return setScan({ text: "Tick at least one time control." });
  if (!engines.main) return setScan({ text: "Waiting for the chess engine…" });
  stopRequested = false;
  setScan({ running: true, text: `Checking chess.com for ${username}'s games…` });
  try {
    const update = await fetchUpdates(new ChessComClient(), username, data.library.finalMonths(username), {
      shouldStop: () => stopRequested,
      onProgress: (done, total) => setScan({ text: `Downloading month ${Math.min(done + 1, total)} of ${total}…` }),
    });
    const added = data.library.apply(update);
    data.save("library");
    if (added) setScan({ text: `${added} new games downloaded.` });
  } catch (err) {
    const msg = err instanceof ChessComError ? err.message : `Could not reach chess.com (${(err as Error).message})`;
    if (!data.library.hasUser(username)) return setScan({ running: false, text: msg });
    setScan({ text: `${msg} Scanning the games already downloaded.` });
  }
  if (stopRequested) return setScan({ running: false, text: "Stopped; the months downloaded so far are kept." });
  const depth = settings.puzzleDepth;
  const games = data.library
    .games(username, settings.puzzleTimeClasses)
    .filter((g) => !data.puzzles.isAnalysed(g.url, depth));
  if (!games.length) return setScan({ running: false, text: "Up to date: everything is scanned." });
  const [lo, hi] = estimateSeconds(games.length, depth);
  setScan({ text: `Scanning ${games.length} games (about ${formatDuration(lo)}–${formatDuration(hi)})…` });
  await new Promise<void>((resolve) => {
    scanner = new PuzzleScanner({
      worker: engines.main!,
      ladderWorker: engines.ladder(),
      store: data.puzzles,
      onProgress: (done, total, found) =>
        setScan({ text: `Game ${Math.min(done + 1, total)} of ${total} · ${found} puzzle${found === 1 ? "" : "s"} found` }),
      onPuzzle: () => data.save("puzzles"),
      onGameDone: () => data.save("puzzles"),
      onFinished: (ok, error) => {
        data.save("puzzles");
        setScan({
          running: false,
          text: error ?? (ok ? "Done: press Start to practise." : "Stopped; the puzzles found so far are kept."),
        });
        resolve();
      },
    });
    void scanner.scan(games, depth);
  });
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function PuzzlesPage({
  settings,
  update,
  setBoardBusy,
}: {
  settings: Settings;
  update: (p: Partial<Settings>) => void;
  setBoardBusy: (busy: boolean) => void;
}) {
  const data = useData();
  const engines = useEngines();
  const scan = useScanState();
  const [username, setUsername] = useState(settings.chesscomUsername);
  const [queue, setQueue] = useState<Puzzle[]>([]);
  const [pos, setPos] = useState(-1);
  const [current, setCurrent] = useState<{ puzzle: Puzzle; record: boolean; key: number } | null>(null);
  const [stale, setStale] = useState(false);
  const [infoEl, setInfoEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    setBoardBusy(true); // the analysis board is not shown here: no engine work for it
    return () => setBoardBusy(false);
  }, [setBoardBusy]);

  const look = lookaheadValue(settings.puzzleLookahead);
  const filter = useMemo(
    () => new PuzzleFilter({ markers: settings.puzzleMarkers, mode: settings.puzzleMode, lookahead: look }),
    [settings.puzzleMarkers, settings.puzzleMode, look],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const counts = useMemo(() => data.puzzles.counts(filter), [filter, data.version]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const matching = useMemo(() => data.puzzles.query(filter, settings.puzzleOrder), [filter, settings.puzzleOrder, data.version]);

  useEffect(() => setStale(true), [filter, settings.puzzleOrder]);

  const open = (p: Puzzle, record = true) => setCurrent({ puzzle: p, record, key: Date.now() });
  const start = () => {
    const q = data.puzzles.query(filter, settings.puzzleOrder);
    setQueue(q);
    setStale(false);
    if (q.length) {
      setPos(0);
      open(q[0]);
    } else {
      setCurrent(null);
    }
  };
  const next = () => {
    let q = queue;
    let p = pos;
    if (stale || !q.length || p + 1 >= q.length) {
      const fresh = data.puzzles.query(filter, settings.puzzleOrder);
      const others = fresh.filter((x) => x.id !== current?.puzzle.id);
      q = others.length ? others : fresh;
      p = -1;
      setQueue(q);
      setStale(false);
    }
    if (!q.length) {
      setCurrent(null);
      return;
    }
    setPos(p + 1);
    open(q[p + 1]);
  };

  const library = data.library;
  const user = settings.chesscomUsername.trim();
  const hasUser = !!user && library.hasUser(user);
  const total = hasUser ? library.games(user).length : 0;
  const toggle = (list: string[], v: string, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));

  return (
    <div className="layout">
      <div className="col board-col" style={{ "--extras": "128px" } as React.CSSProperties}>
        {current ? (
          <PuzzlePlayer
            key={current.key}
            infoTarget={infoEl}
            puzzle={current.puzzle}
            record={current.record}
            lookahead={look}
            position={queue.length ? `${pos + 1} of ${queue.length}` : ""}
            onRecord={(solved) => {
              data.puzzles.record(current.puzzle.id, solved);
              data.save("puzzles");
            }}
            onNext={next}
            onRetry={() => open(current.puzzle, false)}
          />
        ) : (
          <section className="panel">
            <h2>Puzzles from your games</h2>
            <p className="muted" style={{ margin: 0 }}>
              Enter your chess.com username, download and scan your games, then press Start. Each puzzle is a position from one of
              your games where your move lost winning chances: find a better one. Already have puzzles from the ChessAnalyzer desktop
              app? Import its puzzles.json on the Settings tab.
            </p>
          </section>
        )}
      </div>
      <div className="col">
        <div ref={setInfoEl} style={{ display: "contents" }} />
        <section className="panel">
          <h2>Your games</h2>
          <div className="row">
            <input
              id="cc-user"
              data-tip={TIPS.ccUser}
              type="text"
              placeholder="chess.com username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onBlur={() => update({ chesscomUsername: username.trim() })}
              className="grow"
            />
            <label className="small row" style={{ gap: 4 }} data-tip={TIPS.scanDepth}>
              Depth
              <input
                type="number"
                min={6}
                max={18}
                value={settings.puzzleDepth}
                onChange={(e) => update({ puzzleDepth: Math.max(6, Math.min(18, Number(e.target.value) || 10)) })}
                style={{ width: 60 }}
              />
            </label>
          </div>
          <div className="chips">
            {TIME_CLASSES.map((tc) => (
              <label key={tc} className="chip" data-tip={TIPS.timeClass}>
                <input
                  type="checkbox"
                  checked={settings.puzzleTimeClasses.includes(tc)}
                  onChange={(e) => update({ puzzleTimeClasses: toggle(settings.puzzleTimeClasses, tc, e.target.checked) })}
                />
                {TIME_CLASS_LABELS[tc]}
              </label>
            ))}
          </div>
          <div className="row">
            <button
              className="btn primary"
              type="button"
              disabled={scan.running}
              data-tip={TIPS.scan}
              onClick={() => {
                update({ chesscomUsername: username.trim() });
                void downloadAndScan(data, engines, { ...settings, chesscomUsername: username.trim() });
              }}
            >
              {hasUser ? "Refresh and scan" : "Download & scan my games"}
            </button>
            {scan.running && (
              <button
                className="btn"
                type="button"
                data-tip={TIPS.scanStop}
                onClick={() => {
                  stopRequested = true;
                  scanner?.stop();
                }}
              >
                Stop
              </button>
            )}
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            {hasUser
              ? `${total} games downloaded${library.lastRefresh(user) ? ` · last refreshed ${new Date(library.lastRefresh(user) * 1000).toLocaleDateString()}` : ""}.`
              : "Your whole history is downloaded once; later refreshes fetch only new games."}{" "}
            Scanning runs Stockfish on this device: a few seconds per game on a computer, slower on a phone. You can keep using the other tabs.
          </p>
          {scan.text && <p className="small" style={{ margin: 0 }}>{scan.text}</p>}
        </section>

        <section className="panel">
          <h2>Practice</h2>
          <div className="chips">
            {MARKERS.map((m) => (
              <label key={m} className="chip" data-tip={MARKER_TIPS[m]}>
                <input
                  type="checkbox"
                  checked={settings.puzzleMarkers.includes(m)}
                  onChange={(e) => update({ puzzleMarkers: toggle(settings.puzzleMarkers, m, e.target.checked) })}
                />
                {MARKER_LABELS[m]} <span className="muted">{counts[m] ?? 0}</span>
              </label>
            ))}
          </div>
          <label className="small" htmlFor="lookahead" data-tip={TIPS.lookahead}>
            Lookahead:{" "}
            <b>{look === null ? "any depth" : `${look} move${look === 1 ? "" : "s"} (≈${2 * look} plies)`}</b>
          </label>
          <input
            id="lookahead"
            data-tip={TIPS.lookahead}
            type="range"
            min={1}
            max={MAX_LOOKAHEAD + 1}
            value={settings.puzzleLookahead}
            onChange={(e) => update({ puzzleLookahead: Number(e.target.value) })}
          />
          <p className="small muted" style={{ margin: 0 }}>
            Only puzzles whose punishment shows within this many moves. Stockfish depth is approximate, so treat this as a difficulty
            dial.
          </p>
          <div className="row">
            <select value={settings.puzzleMode} onChange={(e) => update({ puzzleMode: e.target.value })} aria-label="Which puzzles" data-tip={TIPS.mode}>
              {Object.entries(MODE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <select value={settings.puzzleOrder} onChange={(e) => update({ puzzleOrder: e.target.value })} aria-label="Order" data-tip={TIPS.order}>
              {Object.entries(ORDERS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <span className="small muted grow">
              {matching.length} puzzle{matching.length === 1 ? "" : "s"}
            </span>
            <button className="btn primary" type="button" disabled={!matching.length} onClick={start} data-tip={TIPS.start}>
              Start
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

// ── One puzzle ───────────────────────────────────────────────────────────────

function PuzzlePlayer({
  infoTarget,
  puzzle,
  record,
  lookahead,
  position,
  onRecord,
  onNext,
  onRetry,
}: {
  /** Where the puzzle's text goes (the right column), so the board can fill the left one. */
  infoTarget: HTMLElement | null;
  puzzle: Puzzle;
  record: boolean;
  lookahead: number | null;
  position: string;
  onRecord: (solved: boolean) => void;
  onNext: () => void;
  onRetry: () => void;
}) {
  const steps = useMemo(() => stepsWithin(puzzle, lookahead), [puzzle, lookahead]);
  const [step, setStep] = useState(0);
  const [fen, setFen] = useState(steps[0].fen);
  const [lastMove, setLastMove] = useState<string | null>(null);
  useCarryBoard(fen, lastMove);
  const [feedback, setFeedback] = useState<{ text: string; cls: string }>({
    text: "Your move. Tap a piece, then where it goes, or drag it.",
    cls: "muted",
  });
  const [explain, setExplain] = useState("");
  const [line, setLine] = useState<string>("");
  const [arrows, setArrows] = useState<Arrow[]>([]);
  const [flash, setFlash] = useState<{ squares: string[]; kind: "good" | "bad"; key: number } | null>(null);
  const [finished, setFinished] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const failed = useRef(false);
  const recorded = useRef(!record);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const doRecord = (solved: boolean) => {
    if (recorded.current) return;
    recorded.current = true;
    onRecord(solved);
  };
  const miss = () => {
    if (!failed.current) {
      failed.current = true;
      doRecord(false);
    }
  };

  /** The engine's line after the best move of step ``index`` (all steps, not just the shown ones). */
  const lineAfter = (index: number): string[] => {
    const all = puzzle.steps;
    const out: string[] = [];
    for (let j = index; j < all.length; j++) {
      if (j > index) out.push(all[j].bestUci);
      if (all[j].replyUci === null) {
        out.push(...puzzle.continuation);
        break;
      }
      out.push(all[j].replyUci!);
    }
    return out;
  };
  const showLine = (afterFen: string, ucis: string[]) => {
    if (!ucis.length) return;
    const shown = Math.min(4, ucis.length);
    setLine(
      `Engine line: ${sanLine(ucis, afterFen)}. Arrows ${shown > 1 ? `1–${shown}` : "1"} show its first moves in order (green yours, red theirs).`,
    );
    setArrows(numberedLine(afterFen, ucis, puzzle.userWhite ? "w" : "b"));
  };

  const onMove = (uci: string): boolean => {
    if (finished || awaiting) return false;
    const s: PuzzleStep = steps[step];
    if (!isAcceptable(s, uci)) {
      miss();
      setFeedback({ text: "Not quite. Try again.", cls: "bad" });
      return false;
    }
    const afterFen = after(fen, uci)!;
    setFen(afterFen);
    setLastMove(uci);
    setArrows([]);
    const last = step + 1 >= steps.length || s.replyUci === null;
    if (uci === s.bestUci && !last) {
      setAwaiting(true);
      setFeedback({ text: "Good. Keep going.", cls: "good" });
      const reply = s.replyUci!;
      setTimeout(() => {
        if (!alive.current) return;
        const replySan = sanOf(afterFen, reply);
        const next = after(afterFen, reply)!;
        setFen(next);
        setLastMove(reply);
        setStep((x) => x + 1);
        setAwaiting(false);
        setFeedback({ text: `They reply ${replySan}. Your move.`, cls: "muted" });
      }, REPLY_DELAY);
      return true;
    }
    setFinished(true);
    doRecord(!failed.current);
    if (uci === s.bestUci) {
      setFeedback({ text: failed.current ? "Correct." : `Correct! (You played ${puzzle.playedSan} in the game.)`, cls: "good" });
      setTimeout(() => alive.current && showLine(afterFen, lineAfter(step)), 350);
    } else {
      setFeedback({ text: `Good move! The engine preferred ${sanOf(s.fen, s.bestUci)}.`, cls: "good" });
    }
    setExplain(explainBest(s));
    return true;
  };

  const hint = () => {
    if (finished || awaiting) return;
    miss();
    const best = steps[step].bestUci;
    const piece = pieceOn(fen, best.slice(0, 2));
    setFlash({ squares: [best.slice(0, 2)], kind: "good", key: Date.now() });
    setFeedback({ text: `Hint: move your ${PIECE_NAMES[piece] ?? "piece"} on ${best.slice(0, 2)}.`, cls: "warn" });
  };

  const showSolution = () => {
    if (finished || awaiting) return;
    miss();
    setFinished(true);
    const moves: string[] = [];
    for (let j = step; j < steps.length; j++) {
      moves.push(steps[j].bestUci);
      const r = steps[j].replyUci;
      if (r !== null && j + 1 < steps.length) moves.push(r);
    }
    setFeedback({ text: `Solution: ${sanLine(moves, fen)}`, cls: "warn" });
    setExplain(explainBest(steps[step]));
    let f = fen;
    moves.forEach((u, i) => {
      setTimeout(() => {
        if (!alive.current) return;
        const n = after(f, u)!;
        f = n;
        setFen(n);
        setLastMove(u);
        if (i === moves.length - 1) setTimeout(() => alive.current && showLine(n, lineAfter(steps.length - 1)), 350);
      }, REPLY_DELAY * (i + 1));
    });
  };

  const date = puzzle.endTime ? new Date(puzzle.endTime * 1000).toISOString().slice(0, 10) : "";
  const side = puzzle.userWhite ? "White" : "Black";
  const visible = puzzle.visiblePlies / 2;
  const userColor = puzzle.userWhite ? "w" : "b";

  return (
    <>
      <div className="small muted row" style={{ gap: "4px 10px" }}>
        <span className={puzzle.marker === "?!" ? "marker-warn" : "marker-bad"}>{puzzle.marker}</span>
        {position && <span>Puzzle {position}</span>}
        <span>
          vs {puzzle.opponent}
          {puzzle.opponentRating ? ` (${puzzle.opponentRating})` : ""}
        </span>
        <span>{TIME_CLASS_LABELS[puzzle.timeClass] ?? puzzle.timeClass}</span>
        {date && <span>{date}</span>}
        <a href={puzzle.gameUrl} target="_blank" rel="noopener noreferrer" data-tip={TIPS.openGame}>
          Open the game
        </a>
      </div>
      <Board
        fen={fen}
        orientation={userColor}
        lastMove={lastMove}
        animate
        movable={finished || awaiting ? "none" : userColor}
        onMove={onMove}
        arrows={arrows}
        flash={flash}
      />
      <p className={`feedback ${feedback.cls}`} style={{ margin: 0 }}>
        {feedback.text}
      </p>
      <div className="row">
        <button className="btn" type="button" onClick={hint} disabled={finished || awaiting} data-tip={TIPS.hint}>
          Hint
        </button>
        <button className="btn" type="button" onClick={showSolution} disabled={finished || awaiting} data-tip={TIPS.solution}>
          Show solution
        </button>
        <button className="btn" type="button" onClick={onRetry} data-tip={TIPS.retry}>
          Retry
        </button>
        <button className="btn primary" type="button" onClick={onNext} data-tip={TIPS.nextPuzzle}>
          Next
        </button>
      </div>
      {infoTarget && createPortal(
      <section className="panel">
        <p style={{ margin: 0 }}>
          You played <b>{puzzleLabel(puzzle)}</b> here. Find a better move ({side} to move).
          {steps.length > 1 ? ` The line is ${steps.length} moves long.` : ""}
        </p>
        <p className="small muted" style={{ margin: 0 }}>
          Punishment visible about {visible} move{visible === 1 ? "" : "s"} ahead · history: {puzzle.solved} solved, {puzzle.failed}{" "}
          missed{record ? "" : " · practice run, not recorded"}
        </p>
        {explain && <p className="small" style={{ margin: 0 }}>{explain}</p>}
        {line && <p className="small" style={{ margin: 0, fontFamily: "var(--mono)" }}>{line}</p>}
      </section>,
      infoTarget,
      )}
    </>
  );
}

function pieceOn(fen: string, square: string): string {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const rows = fen.split(" ")[0].split("/");
  const row = rows[7 - rank];
  let f = 0;
  for (const ch of row) {
    if (/\d/.test(ch)) f += Number(ch);
    else {
      if (f === file) return ch.toLowerCase();
      f++;
    }
  }
  return "";
}

function explainBest(s: PuzzleStep): string {
  try {
    return explainMove(s.fen, s.bestUci);
  } catch {
    return "";
  }
}

