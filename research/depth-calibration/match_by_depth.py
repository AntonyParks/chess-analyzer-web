"""
How often a player's move equals Stockfish's top move at each depth, by rating band (Maia-style
move matching). Also: among positions where the shallow and deep top moves differ, which one the
player chose.

Usage: python -I match_by_depth.py positions.jsonl [--time-class daily|live|all]
"""
from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict

DECIDED = 0.9


def win_chance(cp: float) -> float:
    return 2 / (1 + math.exp(-0.00368208 * max(-100_000, min(100_000, cp)))) - 1


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("positions")
    ap.add_argument("--time-class", default="all", choices=["all", "daily", "live"])
    args = ap.parse_args()
    rows = [json.loads(l) for l in open(args.positions, encoding="utf-8")]
    rows = [r for r in rows if abs(win_chance(r["best_cp"])) <= DECIDED]
    if args.time_class != "all":
        rows = [r for r in rows if (r["time_class"] == "daily") == (args.time_class == "daily")]

    bands = [(500, 800), (800, 900), (900, 1100), (1100, 1300)]
    print("Share of moves equal to Stockfish's top move at depth d:")
    print("  band        n     " + " ".join(f"d{d:<4}" for d in (1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 18)))
    for lo, hi in bands:
        sel = [r for r in rows if lo <= r["rating"] < hi]
        if not sel:
            continue
        hits = defaultdict(int)
        for r in sel:
            for d, uci, _cp in r["by_depth"]:
                hits[d] += uci == r["played"]
        cells = " ".join(f"{hits[d] / len(sel):5.1%}" for d in (1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 18))
        print(f"  {lo}-{hi - 1:<5} {len(sel):>6}  {cells}")

    print("\nWhere depth-2 and depth-18 top moves differ, players rated 900-1099 played:")
    sel = [r for r in rows if 900 <= r["rating"] < 1100]
    shallow = deep = other = 0
    for r in sel:
        by = {d: u for d, u, _ in r["by_depth"]}
        if 2 in by and 18 in by and by[2] != by[18]:
            if r["played"] == by[2]:
                shallow += 1
            elif r["played"] == by[18]:
                deep += 1
            else:
                other += 1
    n = shallow + deep + other
    if n:
        print(f"  the shallow move {shallow / n:.1%}, the deep move {deep / n:.1%}, something else {other / n:.1%}  (n={n})")


if __name__ == "__main__":
    main()
