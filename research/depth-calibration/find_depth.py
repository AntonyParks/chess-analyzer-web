"""
Find depth of real players' moves: for each position in a chess.com game library, the shallowest
Stockfish depth from which the engine's choice is always a best-or-excellent move, and whether the
player found such a move. ``fit.py`` turns the output into "chance a player of rating R finds the
move in a position whose find depth is d".

Definitions (all on Lichess's winning-chances scale in [-1, 1], as in src/core/evaluation.ts):
  * reference: a search to REF_DEPTH (default 18) with a cleared hash;
  * excellent: a move whose reference eval loses at most EXCELLENT (0.04, i.e. 0.02 expected
    points, chess.com's "excellent" bound) winning chances against the best move;
  * find depth: smallest d such that the engine's top move at every depth d..REF_DEPTH is excellent
    (REF_DEPTH + 1 when even the last depth's choice isn't, which can't happen by construction);
  * found: the move actually played is excellent.

Each position is searched once from a cleared hash (``ucinewgame``) so shallow depths aren't helped
by an earlier deeper search; the moves that were top at some depth, and the played move, are then
scored to REF_DEPTH with ``searchmoves``.

Output: one JSON line per position (resumable: positions already in the output are skipped).

Usage: python -I find_depth.py LIBRARY.json STOCKFISH.exe OUT.jsonl [--workers N] [--depth D]
"""
from __future__ import annotations

import argparse
import io
import json
import math
import multiprocessing as mp
import os
import sys
import time

import chess
import chess.engine
import chess.pgn

WIN_CHANCE_K = 0.00368208
MATE = 100_000
EXCELLENT = 0.04
MIN_PLY = 8  # skip the first moves: memorised opening theory, not calculation


def win_chance(cp: float) -> float:
    c = max(-MATE, min(MATE, cp))
    return 2 / (1 + math.exp(-WIN_CHANCE_K * c)) - 1


def cp_of(score: chess.engine.PovScore, turn: chess.Color) -> int:
    return score.pov(turn).score(mate_score=MATE)


def positions(library_path: str):
    """(id, fen, played uci, rating, time class, ply) for every rated player's move."""
    data = json.load(open(library_path, encoding="utf-8"))
    for info in data["users"].values():
        for archive in info.get("archives", {}).values():
            games = archive.get("games", []) if isinstance(archive, dict) else archive
            for g in games:
                if g.get("rules", "chess") != "chess" or not g.get("pgn"):
                    continue
                game = chess.pgn.read_game(io.StringIO(g["pgn"]))
                if game is None or game.headers.get("SetUp") == "1":
                    continue
                ratings = {chess.WHITE: g.get("white", {}).get("rating"), chess.BLACK: g.get("black", {}).get("rating")}
                board = game.board()
                for ply, move in enumerate(game.mainline_moves()):
                    if ply >= MIN_PLY and ratings[board.turn] and board.legal_moves.count() > 1:
                        yield {
                            "id": f"{g['url']}#{ply}",
                            "fen": board.fen(),
                            "played": move.uci(),
                            "rating": ratings[board.turn],
                            "time_class": g.get("time_class"),
                            "ply": ply,
                        }
                    board.push(move)


_engine: chess.engine.SimpleEngine | None = None
_depth = 18


def _init(exe: str, depth: int) -> None:
    global _engine, _depth
    if os.name == "nt":
        import ctypes

        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)  # below normal
    kwargs = {"creationflags": 0x08000000} if os.name == "nt" else {}  # CREATE_NO_WINDOW
    _engine = chess.engine.SimpleEngine.popen_uci(exe, **kwargs)
    _engine.configure({"Threads": 1, "Hash": 32})
    _depth = depth


def _analyse(pos: dict) -> dict:
    assert _engine is not None
    board = chess.Board(pos["fen"])
    turn = board.turn
    per_depth: dict[int, tuple[str, int]] = {}
    with _engine.analysis(board, chess.engine.Limit(depth=_depth), game=object()) as run:  # new game: cleared hash
        for info in run:
            if "pv" in info and "score" in info and "depth" in info and not info.get("lowerbound") and not info.get("upperbound"):
                if info.get("multipv", 1) == 1:
                    per_depth[info["depth"]] = (info["pv"][0].uci(), cp_of(info["score"], turn))
    depths = sorted(d for d in per_depth if d <= _depth)
    best_uci, best_cp = per_depth[depths[-1]]
    scores = {best_uci: best_cp}
    for uci in {per_depth[d][0] for d in depths} | {pos["played"]}:
        if uci in scores:
            continue
        info = _engine.analyse(board, chess.engine.Limit(depth=_depth), root_moves=[chess.Move.from_uci(uci)])
        scores[uci] = cp_of(info["score"], turn)
    top = max(scores.values())
    wc_top = win_chance(top)
    excellent = {u for u, c in scores.items() if wc_top - win_chance(c) <= EXCELLENT}
    find = _depth + 1
    for d in reversed(depths):
        if per_depth[d][0] in excellent:
            find = d
        else:
            break
    return {
        **pos,
        "ref_depth": _depth,
        "best": max(scores, key=scores.get),
        "best_cp": top,
        "played_cp": scores[pos["played"]],
        "loss": round(wc_top - win_chance(scores[pos["played"]]), 4),
        "found": pos["played"] in excellent,
        "find_depth": find,
        "by_depth": [[d, per_depth[d][0], per_depth[d][1]] for d in depths],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("library")
    ap.add_argument("engine")
    ap.add_argument("out")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    ap.add_argument("--depth", type=int, default=18)
    ap.add_argument("--limit", type=int, default=0, help="only this many new positions (for a trial)")
    args = ap.parse_args()

    done = set()
    if os.path.exists(args.out):
        with open(args.out, encoding="utf-8") as f:
            for line in f:
                try:
                    done.add(json.loads(line)["id"])
                except (ValueError, KeyError):
                    pass
    todo = [p for p in positions(args.library) if p["id"] not in done]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(done)} done, {len(todo)} to analyse with {args.workers} workers at depth {args.depth}", flush=True)
    start = time.time()
    with mp.Pool(args.workers, initializer=_init, initargs=(args.engine, args.depth)) as pool, open(args.out, "a", encoding="utf-8") as out:
        for i, row in enumerate(pool.imap_unordered(_analyse, todo, chunksize=4), 1):
            out.write(json.dumps(row) + "\n")
            if i % 200 == 0 or i == len(todo):
                out.flush()
                rate = i / (time.time() - start)
                print(f"{i}/{len(todo)}  {rate:.1f}/s  ~{(len(todo) - i) / rate / 60:.0f} min left", flush=True)


if __name__ == "__main__":
    main()
