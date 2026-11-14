/**
 * Your games from chess.com and Lichess, downloaded into the game library: download or refresh
 * them here, filter the list, and click a game to load it on the board for review.
 */
import { useMemo, useState } from "react";
import { GameState } from "../../core/gameState";
import { ChessComClient, ChessComError, TIME_CLASS_LABELS, type ChessComGame } from "../../data/chesscom";
import { fetchUpdates } from "../../data/gameLibrary";
import { LICHESS_ARCHIVE, fetchLichessGames, isLichessKey, lichessKey } from "../../data/lichessGames";
import { useData } from "../data";
import { useGame } from "../game";
import { SortTable, type Column } from "../lichess";
import type { Settings } from "../settings";
import { TIPS } from "../tips";

type Site = "chess.com" | "Lichess";
type Outcome = "Won" | "Drew" | "Lost";
interface Row {
  game: ChessComGame;
  site: Site;
  outcome: Outcome;
  opening: string;
}

const DRAWS = new Set(["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"]);
const PAGE = 100;

function outcomeOf(result: string): Outcome {
  if (result === "win") return "Won";
  return DRAWS.has(result) ? "Drew" : "Lost";
}

/** The opening named in the PGN headers (Lichess "Opening", chess.com "ECOUrl"). */
function openingOf(pgn: string): string {
  const named = /\[Opening "([^"]*)"\]/.exec(pgn)?.[1];
  if (named && named !== "?") return named;
  const url = /\[ECOUrl "[^"]*\/openings\/([^"]*)"\]/.exec(pgn)?.[1];
  if (!url) return "";
  return decodeURIComponent(url)
    .replace(/-(\d+)\.\.\..*$|-\d+\..*$/, "")
    .replace(/-/g, " ");
}

export function GameList({ settings, update }: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  const data = useData();
  const { load } = useGame();
  const [chesscom, setChesscom] = useState(settings.chesscomUsername);
  const [lichess, setLichess] = useState(settings.lichessUsername);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [version, setVersion] = useState(0);
  const [site, setSite] = useState<"all" | Site>("all");
  const [colour, setColour] = useState<"any" | "w" | "b">("any");
  const [result, setResult] = useState<"any" | Outcome>("any");
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [picked, setPicked] = useState<string | null>(null);
  const [sortSpec, setSortSpec] = useState<string[]>(["Date", "desc"]);

  const all = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const key of data.library.usernames()) {
      const s: Site = isLichessKey(key) ? "Lichess" : "chess.com";
      for (const game of data.library.games(key)) out.push({ game, site: s, outcome: outcomeOf(game.result), opening: openingOf(game.pgn) });
    }
    return out.sort((a, b) => b.game.endTime - a.game.endTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.library, data.ready, version]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter(
      (r) =>
        (site === "all" || r.site === site) &&
        (colour === "any" || r.game.userColor === colour) &&
        (result === "any" || r.outcome === result) &&
        (!q || r.game.opponent.toLowerCase().includes(q) || r.opening.toLowerCase().includes(q)),
    );
  }, [all, site, colour, result, search]);

  const download = async (which: Site) => {
    const name = (which === "chess.com" ? chesscom : lichess).trim();
    if (!name) return setNote({ text: `Enter your ${which} username first.`, bad: true });
    update(which === "chess.com" ? { chesscomUsername: name } : { lichessUsername: name });
    setBusy(true);
    try {
      let added: number;
      if (which === "chess.com") {
        setNote({ text: `Checking chess.com for ${name}'s games…`, bad: false });
        const upd = await fetchUpdates(new ChessComClient(), name, data.library.finalMonths(name), {
          onProgress: (done, total) => setNote({ text: `chess.com: month ${Math.min(done + 1, total)} of ${total}…`, bad: false }),
        });
        added = data.library.apply(upd);
      } else {
        const key = lichessKey(name);
        setNote({ text: `Asking Lichess for ${name}'s games…`, bad: false });
        const games = await fetchLichessGames(name, {
          since: data.library.newestEnd(key),
          token: settings.lichessToken || undefined,
          onCount: (n) => setNote({ text: `Lichess: ${n} games received…`, bad: false }),
        });
        added = data.library.addGames(key, LICHESS_ARCHIVE, games);
      }
      data.save("library");
      setVersion((v) => v + 1);
      setNote({ text: added ? `${added} new ${which} game${added === 1 ? "" : "s"} downloaded.` : `Up to date: no new ${which} games.`, bad: false });
    } catch (err) {
      const msg = err instanceof ChessComError ? err.message : (err as Error).message;
      setNote({ text: `Could not download from ${which}: ${msg}`, bad: true });
    } finally {
      setBusy(false);
    }
  };

  const open = (r: Row) => {
    try {
      load(GameState.fromPgn(r.game.pgn));
      setPicked(r.game.url);
      update({ flip: r.game.userColor === "b" });
    } catch (err) {
      setNote({ text: `Could not read that game: ${(err as Error).message}`, bad: true });
    }
  };

  const columns: Column<Row>[] = [
    {
      head: "Date",
      cell: (r) => (r.game.endTime ? new Date(r.game.endTime * 1000).toLocaleDateString() : "?"),
      sort: (r) => r.game.endTime,
    },
    { head: "Site", cell: (r) => r.site, sort: (r) => r.site },
    { head: "You", title: "The colour you played", cell: (r) => (r.game.userColor === "w" ? "White" : "Black"), sort: (r) => r.game.userColor },
    {
      head: "Opponent",
      cell: (r) => (
        <>
          {r.game.opponent}
          {r.game.opponentRating ? <span className="muted"> ({r.game.opponentRating})</span> : null}
        </>
      ),
      sort: (r) => r.game.opponent.toLowerCase(),
    },
    {
      head: "Result",
      cell: (r) => <span className={r.outcome === "Won" ? "good" : r.outcome === "Lost" ? "bad" : "muted"}>{r.outcome}</span>,
      sort: (r) => (r.outcome === "Won" ? 2 : r.outcome === "Drew" ? 1 : 0),
    },
    { head: "Time", cell: (r) => TIME_CLASS_LABELS[r.game.timeClass] ?? r.game.timeClass, sort: (r) => r.game.timeClass },
    { head: "Opening", cell: (r) => <span className="small">{r.opening}</span>, sort: (r) => r.opening },
  ];

  // Sort the whole filtered list here, so paging shows the right games (the table only re-sorts a page).
  const sorted = useMemo(() => {
    const col = columns.find((c) => c.head === sortSpec[0]);
    if (!col?.sort) return rows;
    const key = col.sort;
    const sign = sortSpec[1] === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = key(a);
      const y = key(b);
      return sign * (x < y ? -1 : x > y ? 1 : 0);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sortSpec]);

  const sites = new Set(all.map((r) => r.site));
  return (
    <section className="panel">
      <h2>Your games</h2>
      <div className="row">
        <input
          aria-label="chess.com username"
          placeholder="chess.com username"
          value={chesscom}
          onChange={(e) => setChesscom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && void download("chess.com")}
          style={{ width: 170 }}
        />
        <button className="btn" type="button" disabled={busy} onClick={() => void download("chess.com")} data-tip={TIPS.gamesChesscom}>
          {data.library.hasUser(chesscom.trim()) ? "Refresh chess.com" : "Download chess.com"}
        </button>
      </div>
      <div className="row">
        <input
          aria-label="Lichess username"
          placeholder="Lichess username"
          value={lichess}
          onChange={(e) => setLichess(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && void download("Lichess")}
          style={{ width: 170 }}
        />
        <button className="btn" type="button" disabled={busy} onClick={() => void download("Lichess")} data-tip={TIPS.gamesLichess}>
          {lichess.trim() && data.library.hasUser(lichessKey(lichess)) ? "Refresh Lichess" : "Download Lichess"}
        </button>
      </div>
      {note && (
        <p className={`small ${note.bad ? "warn" : "muted"}`} role="status" style={{ margin: 0 }}>
          {note.text}
        </p>
      )}
      {all.length > 0 ? (
        <>
          <div className="row small">
            {sites.size > 1 && (
              <select aria-label="Site" value={site} onChange={(e) => setSite(e.target.value as typeof site)}>
                <option value="all">Both sites</option>
                <option value="chess.com">chess.com</option>
                <option value="Lichess">Lichess</option>
              </select>
            )}
            <select aria-label="Colour" value={colour} onChange={(e) => setColour(e.target.value as typeof colour)}>
              <option value="any">Either colour</option>
              <option value="w">As White</option>
              <option value="b">As Black</option>
            </select>
            <select aria-label="Result" value={result} onChange={(e) => setResult(e.target.value as typeof result)}>
              <option value="any">Any result</option>
              <option value="Won">Won</option>
              <option value="Drew">Drew</option>
              <option value="Lost">Lost</option>
            </select>
            <input
              className="grow"
              type="search"
              placeholder="Opponent or opening"
              aria-label="Search by opponent or opening"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setShown(PAGE);
              }}
            />
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            {rows.length === all.length ? `${all.length} games` : `${rows.length} of ${all.length} games`}. Click one to load it, then
            press Analyse game.
          </p>
          <SortTable
            rows={sorted.slice(0, shown)}
            columns={columns}
            rowKey={(r) => r.game.url}
            onPick={open}
            selected={picked}
            sortSpec={sortSpec}
            onSortChange={setSortSpec}
          />
          {rows.length > shown && (
            <button className="btn" type="button" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, rows.length - shown)} more
            </button>
          )}
        </>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          No games yet. Enter your username and download your games; they stay in this browser.
        </p>
      )}
    </section>
  );
}
