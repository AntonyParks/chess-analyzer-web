"""
Pick a rating-stratified sample of rated rapid and blitz games from a (possibly truncated) Lichess
database dump (.pgn.zst) and write it in the game-library shape find_depth.py reads.

Games are kept when both players have a rating, the game ended normally or on time, and it lasted
at least 20 plies. Each game goes in the band of its players' average rating; each band takes up
to --per-band games, first come first served (the dump is in time order, so that's arbitrary
enough).

Usage: python -I lichess_sample.py DUMP.pgn.zst OUT.json [--per-band 1200] [--bands 1000,1200,...]
"""
from __future__ import annotations

import argparse
import io
import json
import re

import zstandard

HEADER = re.compile(r'^\[(\w+) "(.*)"\]$')


def games(path: str):
    """(headers, movetext) per game; stops quietly at a truncated end."""
    with open(path, "rb") as fh:
        reader = io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(fh), encoding="utf-8", errors="replace")
        headers: dict[str, str] = {}
        moves: list[str] = []
        try:
            for line in reader:
                line = line.rstrip("\n")
                m = HEADER.match(line)
                if m:
                    if moves:
                        yield headers, " ".join(moves)
                        headers, moves = {}, []
                    headers[m.group(1)] = m.group(2)
                elif line.strip():
                    moves.append(line.strip())
        except zstandard.ZstdError:
            pass  # the dump was cut off mid-frame


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dump")
    ap.add_argument("out")
    ap.add_argument("--per-band", type=int, default=1200)
    ap.add_argument("--bands", default="1000,1200,1400,1600,1800")
    args = ap.parse_args()
    edges = [int(x) for x in args.bands.split(",")]
    kept: dict[int, list[dict]] = {lo: [] for lo in edges[:-1]}
    seen = 0
    for h, movetext in games(args.dump):
        seen += 1
        event = h.get("Event", "")
        tc = "rapid" if event.startswith("Rated Rapid") else "blitz" if event.startswith("Rated Blitz") else None
        if not tc or h.get("Variant", "Standard") != "Standard":
            continue
        if h.get("Termination") not in ("Normal", "Time forfeit"):
            continue
        try:
            wr, br = int(h["WhiteElo"]), int(h["BlackElo"])
        except (KeyError, ValueError):
            continue
        if movetext.count(".") < 10 or "%clk" not in movetext:
            continue
        avg = (wr + br) / 2
        band = next((lo for lo, hi in zip(edges, edges[1:]) if lo <= avg < hi), None)
        if band is None or len(kept[band]) >= args.per_band:
            continue
        pgn = "".join(f'[{k} "{v}"]\n' for k, v in h.items()) + "\n" + movetext + "\n"
        kept[band].append({
            "url": h.get("Site", f"lichess-{seen}"),
            "pgn": pgn,
            "time_class": tc,
            "rules": "chess",
            "white": {"rating": wr},
            "black": {"rating": br},
        })
        if all(len(v) >= args.per_band for v in kept.values()):
            break
    print(f"read {seen} games; kept " + ", ".join(f"{lo}: {len(v)}" for lo, v in kept.items()))
    library = {"version": 1, "users": {"lichess-sample": {"archives": {
        str(lo): {"games": v} for lo, v in kept.items()}}}}
    json.dump(library, open(args.out, "w", encoding="utf-8"))


if __name__ == "__main__":
    main()
