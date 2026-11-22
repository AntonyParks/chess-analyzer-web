/** Settings: Lichess login, engine depth, backup and restore, clearing local data. */
import { useRef, useState } from "react";
import { logout, startLogin } from "../../data/lichessAuth";
import { useData } from "../data";
import { CHESSCOM_TO_LICHESS } from "../../core/humanModel";
import { TIME_CLASS_LABELS } from "../../data/chesscom";
import type { Settings } from "../settings";
import { useFoundRating } from "../yourRating";
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
  const found = useFoundRating(settings);
  const auto = settings.humanRatingAuto && found !== null;

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
        <h2>You</h2>
        <div className="row">
          <label htmlFor="set-chesscom" style={{ width: 150 }}>chess.com username</label>
          <input
            id="set-chesscom"
            key={`c-${settings.chesscomUsername}`}
            defaultValue={settings.chesscomUsername}
            onBlur={(e) => update({ chesscomUsername: e.target.value.trim() })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            style={{ width: 170 }}
          />
        </div>
        <div className="row">
          <label htmlFor="set-lichess" style={{ width: 150 }}>Lichess username</label>
          <input
            id="set-lichess"
            key={`l-${settings.lichessUsername}`}
            defaultValue={settings.lichessUsername}
            onBlur={(e) => update({ lichessUsername: e.target.value.trim() })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            style={{ width: 170 }}
          />
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Game review lists flagged moves only for the side you played, found by these names. The game downloads on the Review
          tab use them too.
        </p>
      </section>
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
        <div className="row">
          <label htmlFor="set-rating" data-tip={TIPS.humanRating}>Your rating (chess.com)</label>
          {auto ? (
            <b id="set-rating">{found!.rating}</b>
          ) : (
            <input
              id="set-rating"
              type="number"
              min={400}
              max={2500}
              step={50}
              key={settings.humanRating}
              defaultValue={settings.humanRating}
              onBlur={(e) => update({ humanRating: clampRating(Number(e.target.value)) })}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              style={{ width: 80 }}
            />
          )}
          <label className="chip" data-tip={TIPS.humanRatingAuto}>
            <input type="checkbox" checked={settings.humanRatingAuto} onChange={(e) => update({ humanRatingAuto: e.target.checked })} />
            From my games
          </label>
          {settings.humanRatingAuto && (
            <select
              aria-label="Time control for your rating"
              value={settings.humanRatingClass}
              onChange={(e) => update({ humanRatingClass: e.target.value })}
            >
              <option value="latest">Latest game</option>
              {Object.entries(TIME_CLASS_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {auto
            ? `Your ${TIME_CLASS_LABELS[found!.timeClass]?.toLowerCase() ?? found!.timeClass} rating from your ${found!.site} game on ${new Date(found!.endTime * 1000).toLocaleDateString()}${found!.site === "Lichess" ? `, converted to chess.com's scale (minus ${CHESSCOM_TO_LICHESS})` : ""}; it updates as you download new games. `
            : settings.humanRatingAuto
              ? "No downloaded game of yours in that time control yet, so the number above is used. Add your username above and download your games on the Review tab. "
              : ""}
          Used for the "at your level" score on the Analyse tab, and for games without ratings in Review's expected play.
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
        {data.persisted !== null && (
          <p className={`small ${data.persisted ? "muted" : "warn"}`} style={{ margin: 0 }}>
            {data.persisted
              ? "Your browser has agreed to keep this site's data (it won't clear it on its own)."
              : "Your browser hasn't agreed to keep this site's data: it may clear it on its own to free space. Use the auto-save file below."}
          </p>
        )}
        <BackupFilePanel onMessage={setMessage} />
        <div className="row">
          <button className="btn" type="button" onClick={() => data.exportBackup()} data-tip={TIPS.backup}>
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
              <span className="bad small">
                This deletes your repertoire, games, puzzles and results from this browser for good
                {data.backupFile.name ? ` (your auto-save file ${data.backupFile.name} is kept, and no longer written to)` : ""}.
              </span>
              <button className="btn" type="button" onClick={() => data.exportBackup()}>
                Download a backup first
              </button>
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

function clampRating(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.round(Math.max(400, Math.min(2500, n))) : 1000;
}

/** The auto-save file: start, restore from, resume after a reload, or stop. */
function BackupFilePanel({ onMessage }: { onMessage: (m: string) => void }) {
  const data = useData();
  const f = data.backupFile;
  if (f.status === "unsupported") {
    return (
      <p className="small muted" style={{ margin: 0 }}>
        Auto-saving to a file needs Chrome or Edge on a computer. Here, download a backup now and then.
      </p>
    );
  }
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row">
        <b className="small">Auto-save file:</b>
        {f.status === "off" && <span className="small muted">off</span>}
        {f.status === "on" && (
          <span className="small good">
            {f.name}
            {f.savedAt ? `, saved ${f.savedAt.toLocaleTimeString()}` : ""}
          </span>
        )}
        {f.status === "paused" && <span className="small warn">{f.name}, paused until you allow it again</span>}
        {f.status === "error" && <span className="small bad">{f.name}: {f.error}</span>}
      </div>
      <div className="row">
        {f.status === "paused" && (
          <button className="btn primary" type="button" onClick={() => void data.resumeBackupFile()}>
            Resume auto-save
          </button>
        )}
        {(f.status === "off" || f.status === "error") && (
          <button
            className="btn primary"
            type="button"
            data-tip={TIPS.backupFileStart}
            onClick={async () => onMessage(await data.startBackupFile())}
          >
            Auto-save to a file…
          </button>
        )}
        <button className="btn" type="button" data-tip={TIPS.backupFileOpen} onClick={async () => onMessage(await data.openBackupFile())}>
          Restore from auto-save file…
        </button>
        {f.status !== "off" && (
          <button className="btn" type="button" onClick={() => void data.stopBackupFile()}>
            Stop auto-saving
          </button>
        )}
      </div>
    </div>
  );
}
