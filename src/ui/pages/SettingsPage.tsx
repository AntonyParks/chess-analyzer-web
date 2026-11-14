/** Settings: Lichess login, engine depth, backup and restore, clearing local data. */
import { useRef, useState } from "react";
import { logout, startLogin } from "../../data/lichessAuth";
import { useData } from "../data";
import type { Settings } from "../settings";
import { TIPS } from "../tips";

export function redirectUri(): string {
  return `${location.origin}${location.pathname}`;
}

export function SettingsPage({ settings, update }: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const data = useData();
  const fileRef = useRef<HTMLInputElement>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const login = async () => {
    try {
      location.href = await startLogin(redirectUri());
    } catch (err) {
      setMessage(`Could not start the Lichess login: ${(err as Error).message}`);
    }
  };

  return (
    <div className="col" style={{ maxWidth: 760 }}>
      <section className="panel">
        <h2>Lichess</h2>
        <p className="small muted" style={{ margin: 0 }}>
          The opening explorer (Explorer, Insights and repertoire game counts) works without logging in. Logging in makes
          downloading your Lichess games faster; it gives this page a token kept only in this browser and sent only to Lichess.
        </p>
        {settings.lichessToken ? (
          <div className="row">
            <span className="good">Logged in to Lichess.</span>
            <button
              className="btn"
              type="button"
              data-tip={TIPS.logout}
              onClick={async () => {
                await logout(settings.lichessToken).catch(() => false);
                update({ lichessToken: "" });
                setMessage("Logged out.");
              }}
            >
              Log out
            </button>
          </div>
        ) : (
          <>
            <div className="row">
              <button className="btn primary" type="button" onClick={login} data-tip={TIPS.login}>
                Log in with Lichess
              </button>
            </div>
            <div className="row">
              <input
                id="token"
                data-tip={TIPS.token}
                type="password"
                placeholder="…or paste a personal API token (lip_…)"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="grow"
              />
              <button
                className="btn"
                type="button"
                disabled={!token.trim()}
                onClick={() => {
                  update({ lichessToken: token.trim() });
                  setToken("");
                  setMessage("Token saved in this browser.");
                }}
              >
                Use token
              </button>
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Engine</h2>
        <div className="row">
          <label htmlFor="set-depth" data-tip={TIPS.depth}>Board analysis depth</label>
          <input
            id="set-depth"
            type="number"
            min={6}
            max={24}
            value={settings.depth}
            onChange={(e) => update({ depth: Math.max(6, Math.min(24, Number(e.target.value) || 14)) })}
            style={{ width: 70 }}
          />
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Stockfish 17.1 runs on your device on one thread. Deeper is stronger but slower, especially on phones.
        </p>
      </section>

      <section className="panel">
        <h2>Your data</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Games, puzzles and your repertoire live only in this browser. Clearing site data, or the browser itself under storage
          pressure, can remove them, so keep a backup. You can also import the files from the ChessAnalyzer desktop app
          (puzzles.json, repertoire.json, chesscom_games.json).
        </p>
        <p className="small" style={{ margin: 0 }}>{data.summary}</p>
        <div className="row">
          <button className="btn primary" type="button" onClick={() => data.exportBackup()} data-tip={TIPS.backup}>
            Download backup
          </button>
          <button className="btn" type="button" onClick={() => fileRef.current?.click()} data-tip={TIPS.import}>
            Import backup or desktop files
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            multiple
            hidden
            onChange={async (e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              const results: string[] = [];
              for (const f of files) results.push(await data.importFile(f));
              setMessage(results.join(" "));
            }}
          />
        </div>
        <div className="row">
          {!confirmClear ? (
            <button className="btn" type="button" onClick={() => setConfirmClear(true)} data-tip={TIPS.clear}>
              Clear my data…
            </button>
          ) : (
            <>
              <span className="bad small">This deletes your games, puzzles, results and repertoire from this browser.</span>
              <button
                className="btn"
                type="button"
                onClick={async () => {
                  await data.clearAll();
                  setConfirmClear(false);
                  setMessage("Your data was deleted from this browser.");
                }}
              >
                Delete everything
              </button>
              <button className="btn" type="button" onClick={() => setConfirmClear(false)}>
                Cancel
              </button>
            </>
          )}
        </div>
      </section>
      {message && <p className="small">{message}</p>}

      <section className="panel">
        <h2>About</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Runs entirely in your browser: Stockfish 17.1 (WebAssembly) analyses on your device, and your games, puzzles and
          repertoire are stored only in this browser. The only other sites contacted are chess.com (your public games) and
          Lichess (opening data and login).
        </p>
        <p className="small muted" style={{ margin: 0 }}>
          Stockfish is free software under the GPL-3 (
          <a href="https://github.com/official-stockfish/Stockfish" target="_blank" rel="noopener noreferrer">
            source
          </a>
          ). Pieces by Colin M.L. Burnett, CC BY-SA 3.0. This site's code:{" "}
          <a href="https://github.com/AntonyParks/chess-analyzer-web" target="_blank" rel="noopener noreferrer">
            AntonyParks/chess-analyzer-web
          </a>{" "}
          (MIT).
        </p>
      </section>
    </div>
  );
}
