/** The app shell: tabs (routed by the URL hash), the shared engine and game. */
import { useEffect, useState } from "react";
import { board as makeBoard } from "../core/chess";
import { GameState } from "../core/gameState";
import { AnalysisBoard } from "./AnalysisBoard";
import { EngineProvider, useEngines } from "./engine";
import { GameProvider, useGame } from "./game";
import { finishLogin, isLoginRedirect } from "../data/lichessAuth";
import { DataProvider } from "./data";
import { LichessProvider } from "./lichess";
import { AnalysePage } from "./pages/AnalysePage";
import { ExplorerPage } from "./pages/ExplorerPage";
import { InsightsPage } from "./pages/InsightsPage";
import { PuzzlesPage } from "./pages/PuzzlesPage";
import { RepertoirePage } from "./pages/RepertoirePage";
import { ReviewPage } from "./pages/ReviewPage";
import { SettingsPage, redirectUri } from "./pages/SettingsPage";
import { useSettings, type Settings } from "./settings";
import { TIPS } from "./tips";
import { Tooltip } from "./Tooltip";

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
  const [loginMessage, setLoginMessage] = useState("");

  // Coming back from the Lichess login page: swap the code for a token, then tidy the URL.
  useEffect(() => {
    if (!isLoginRedirect(location.href)) return;
    const url = location.href;
    history.replaceState(null, "", `${location.pathname}#settings`);
    setTab("settings");
    finishLogin(url, redirectUri())
      .then((token) => {
        update({ lichessToken: token });
        setLoginMessage("Logged in to Lichess.");
      })
      .catch((err: Error) => setLoginMessage(`Lichess login failed: ${err.message}`));
  }, [update]);

  return (
    <EngineProvider>
      <DataProvider>
      <LichessProvider token={settings.lichessToken}>
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
                  data-tip={TIPS[`tab_${t.id}` as keyof typeof TIPS]}
                  onClick={() => (location.hash = t.id)}
                >
                  {t.label}
                </button>
              ))}
            </nav>
            <EngineStatus />
          </header>
          <InitialPosition />
          {loginMessage && <p className="small">{loginMessage}</p>}
          <Tooltip />
          <main className="page">
            <Page tab={tab} settings={settings} update={update} setBoardBusy={setBoardBusy} />
          </main>
        </div>
      </GameProvider>
      </LichessProvider>
      </DataProvider>
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
  setBoardBusy,
}: {
  tab: TabId;
  settings: Settings;
  update: (p: Partial<Settings>) => void;
  setBoardBusy: (busy: boolean) => void;
}) {
  const withBoard = (panel: React.ReactNode) => (
    <div className="layout">
      <AnalysisBoard settings={settings} />
      {panel}
    </div>
  );
  switch (tab) {
    case "explorer":
      return withBoard(<ExplorerPage settings={settings} update={update} />);
    case "insights":
      return withBoard(<InsightsPage settings={settings} />);
    case "review":
      return withBoard(<ReviewPage />);
    case "puzzles":
      return <PuzzlesPage settings={settings} update={update} setBoardBusy={setBoardBusy} />;
    case "repertoire":
      return <RepertoirePage settings={settings} update={update} setBoardBusy={setBoardBusy} withBoard={withBoard} />;
    case "settings":
      return <SettingsPage settings={settings} update={update} />;
    default:
      return (
        <div className="layout">
          <AnalysisBoard settings={settings} />
          <AnalysePage settings={settings} update={update} />
        </div>
      );
  }
}
