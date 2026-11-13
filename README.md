# ChessAnalyzer Web

ChessAnalyzer in the browser. Stockfish runs on your own device, so there's no server, account or install. It's a fork of the
[ChessAnalyzer desktop app](https://github.com/AntonyParks/chess-analyzer), with its analysis logic ported from Python to
TypeScript.

## What it does

- **Analyse:**
  - a board with a Stockfish 17.1 evaluation bar and graph, a move heatmap (red = worst, gold = best) and a best-move arrow;
  - the top engine lines, and the evaluation of every move of a tapped piece;
  - PGN/FEN paste, upload and download, and a link to share the position.
- **Explorer:** what Lichess players play from the position, at the speeds and ratings you choose (1000 and up), with
  Stockfish's evaluation beside each move.
- **Insights:** walks the Lichess tree and lists moves after which opponents usually go wrong, compared with their best
  reply.
- **Review:** analyses the whole game and lists inaccuracies (?!), mistakes (?) and blunders (??), each with a better move and
  a short explanation.
- **Puzzles from your games:**
  - Download your chess.com games once, and a refresh later fetches only new ones. The background scan finds your own
    mistakes.
  - Each mistake is replayed as a puzzle where you find the better move: multi-move lines, near-best answers accepted, hints,
    solutions, retry failed.
  - Filters for severity, a **Lookahead** difficulty dial (how far ahead the punishment shows) and easiest/hardest ordering.
- **Repertoire:**
  - Build a White and a Black repertoire with game counts and evaluations for every candidate. Transpositions are marked
    (↪ joins …), and so are gaps worth covering (⚠).
  - **Go to biggest gap** jumps to the likeliest position you haven't prepared.
  - Spaced-repetition training plays opponent replies in proportion to how often they're played.
  - **Check my games** shows where your games left your prep.

## Your data stays in your browser

- **Games, puzzles, results and your repertoire** are stored in this browser's IndexedDB and never uploaded anywhere.
  - The only network calls are to `api.chess.com` (your public games) and `explorer.lichess.ovh` / `lichess.org` (opening
    data and login).
  - Browsers can clear site data, so use **Settings → Download backup** now and then.
- **Moving from the desktop app:** you can import its `puzzles.json`, `repertoire.json` and `chesscom_games.json`.
- **The Lichess opening explorer requires a Lichess account.** **Log in with Lichess** uses OAuth with PKCE (no secret, no
  server). You can also paste a personal API token. Either way it's kept in this browser and only sent to Lichess.

## Engine

The site uses the lite single-threaded WebAssembly build of [Stockfish 17.1](https://github.com/nmrugg/stockfish.js), so it
works on any static host with no special headers.
- **Board heatmap and review:** one MultiPV search per position scores every legal move, deepening progressively on the
  board.
- **Puzzle scan:** searches the position after each move, the same way as the desktop app. A separate cold engine handles the
  lookahead ladder.
- **Speed:** on a desktop browser a scan takes about 2–3 s per game at depth 10. Phones are slower.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # Vitest: the ported logic, clients (fake fetch) and engine scheduler (fake UCI engine)
npm run build      # static site in dist/
npm run preview    # serve the built site
```

```
src/core/     pure logic ported from Python (evaluation, game state, review, insights, puzzles, scanner, repertoire)
src/engine/   UCI session and the priority scheduler (HOVER / HEATMAP / BATCH / IDLE)
src/data/     chess.com and Lichess clients, Lichess login, IndexedDB storage
src/ui/       React: board, analysis column and one page per tab
```

Pushing to `main` deploys to GitHub Pages (`.github/workflows/pages.yml`).

## Licences

- The site's code is MIT (see `LICENSE`).
- `public/stockfish/` holds Stockfish, which is GPL-3 (`public/stockfish/COPYING.txt`). Its source is at
  <https://github.com/official-stockfish/Stockfish> and the WebAssembly build is from
  <https://github.com/nmrugg/stockfish.js>. It runs as a separate program the page talks to over UCI.
- The chess pieces are by Colin M.L. Burnett, CC BY-SA 3.0.
