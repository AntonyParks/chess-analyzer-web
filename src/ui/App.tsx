/** The app shell: tabs (routed by the URL hash), the shared engine and game. */
import { useEffect, useState } from "react";
import { board as makeBoard } from "../core/chess";
import { GameState } from "../core/gameState";
import { AnalysisBoard } from "./AnalysisBoard";
import { EngineProvider, useEngines } from "./engine";
import { GameProvider, useGame } from "./game";
import { AnalysePage } from "./pages/AnalysePage";
import { useSettings, type Settings } from "./settings";

export type TabId = "analyse" | "explorer" | "insights" | "review" | "puzzles" | "repertoire" | "settings";

export const TABS: { id: TabId; label: string }[] = [
  { id: "analyse", label: "Analyse" },
  { id: "explorer", label: "Explorer" },
  { id: "insights", label: "Insights" },
  { id: "review", label: "Review" },
  { id: "puzzles", label: "Puzzles" },
  { id: "repertoire", label: "Repertoire" },
  { id: "settings", label: "Settings" },
];

function tabFromHash(): TabId {
  const h = location.hash.replace("#", "");
  return (TABS.find((t) => t.id === h)?.id ?? "analyse") as TabId;
}

export function App() {
  const [settings, update] = useSettings();
  const [tab, setTab] = useState<TabId>(tabFromHash);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // Pages that run their own board (puzzles, repertoire training) pause the board analysis.
  const [boardBusy, setBoardBusy] = useState(false);

  return (
    <EngineProvider>
      <GameProvider depth={settings.depth} enabled={!boardBusy}>
        <div className="app">
          <header className="topbar">
            <span className="brand">ChessAnalyzer</span>
            <nav className="tabs" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  className="tab"
                  aria-selected={tab === t.id}
                  onClick={() => (location.hash = t.id)}
                >
                  {t.label}
                </button>
              ))}
            </nav>
            <EngineStatus />
          </header>
          <InitialPosition />
          <Page tab={tab} settings={settings} update={update} setBoardBusy={setBoardBusy} />
          <footer className="site">
            Runs entirely in your browser: Stockfish 17.1 (WebAssembly, GPL-3) analyses on your device, and your
            games, puzzles and repertoire are stored only in this browser. Pieces by Colin M.L. Burnett (CC BY-SA 3.0).
          </footer>
        </div>
      </GameProvider>
    </EngineProvider>
  );
}

function EngineStatus() {
  const { main, error } = useEngines();
  const { thinking } = useGame();
  return (
    <span className="engine-pill">
      {error ? <span className="bad">{error}</span> : main ? (thinking ? "Stockfish · thinking…" : "Stockfish ready") : "Starting Stockfish…"}
    </span>
  );
}

/** ?fen=… in the URL loads that position once. */
function InitialPosition() {
  const { load } = useGame();
  useEffect(() => {
    const fen = new URLSearchParams(location.search).get("fen");
    if (!fen) return;
    try {
      makeBoard(fen);
      load(new GameState(fen));
    } catch {
      /* ignore a broken link */
    }
  }, [load]);
  return null;
}

function Page({
  tab,
  settings,
  update,
}: {
  tab: TabId;
  settings: Settings;
  update: (p: Partial<Settings>) => void;
  setBoardBusy: (busy: boolean) => void;
}) {
  switch (tab) {
    default:
      return (
        <div className="layout">
          <AnalysisBoard settings={settings} />
          <AnalysePage settings={settings} update={update} />
        </div>
      );
  }
}
