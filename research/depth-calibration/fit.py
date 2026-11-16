"""
Fit "chance a player finds a best-or-excellent move" against the position's find depth and the
player's rating, from find_depth.py's output.

Model: P(found) = 1 / (1 + exp(-(a + b*ln(find_depth) + c*(rating - 1000)/100)))
ln(depth) because the step from depth 1 to 2 matters far more than from 15 to 16.

Positions already decided (the best move keeps winning chances above DECIDED either way) are left
out: there nearly every move is "excellent", which says nothing about seeing deeper.

Usage: python -I fit.py positions.jsonl [--time-class daily|live|all] [--json OUT]
"""
from __future__ import annotations

import argparse
import json
import math
import random
from collections import defaultdict

WIN_CHANCE_K = 0.00368208
DECIDED = 0.9


def win_chance(cp: float) -> float:
    return 2 / (1 + math.exp(-WIN_CHANCE_K * max(-100_000, min(100_000, cp)))) - 1


def features(r: dict) -> list[float]:
    return [1.0, math.log(r["find_depth"]), (r["rating"] - 1000) / 100]


def logistic_fit(rows: list[dict], iters: int = 50) -> list[float]:
    """Plain Newton-Raphson (IRLS) for a 3-parameter logistic regression."""
    w = [0.0, 0.0, 0.0]
    for _ in range(iters):
        grad = [0.0] * 3
        hess = [[0.0] * 3 for _ in range(3)]
        for r in rows:
            x = features(r)
            p = 1 / (1 + math.exp(-sum(wi * xi for wi, xi in zip(w, x))))
            y = 1.0 if r["found"] else 0.0
            for i in range(3):
                grad[i] += (y - p) * x[i]
                for j in range(3):
                    hess[i][j] += p * (1 - p) * x[i] * x[j]
        step = solve(hess, grad)
        w = [wi + si for wi, si in zip(w, step)]
        if max(abs(s) for s in step) < 1e-9:
            break
    return w


def solve(a: list[list[float]], b: list[float]) -> list[float]:
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        m[c], m[p] = m[p], m[c]
        for r in range(n):
            if r != c:
                f = m[r][c] / m[c][c]
                m[r] = [x - f * y for x, y in zip(m[r], m[c])]
    return [m[i][n] / m[i][i] for i in range(n)]


def depth_at_half(w: list[float], rating: float) -> float:
    """The find depth at which a player of this rating finds the move half the time."""
    a, b, c = w
    return math.exp(-(a + c * (rating - 1000) / 100) / b)


GROUPS = [(1, 1), (2, 2), (3, 4), (5, 6), (7, 8), (9, 10), (11, 12), (13, 14), (15, 16), (17, 18), (19, 99)]


def binned(rows: list[dict]) -> list[tuple[str, tuple[int, int]]]:
    out = []
    for lo, hi in GROUPS:
        sel = [r for r in rows if lo <= r["find_depth"] <= hi]
        if sel:
            name = f"{lo}" if lo == hi else "19+" if hi == 99 else f"{lo}-{hi}"
            out.append((name, (sum(r["found"] for r in sel), len(sel))))
    return out


def crossing(rows: list[dict]) -> float | None:
    """Find depth where the binned found rate first falls below 50%, interpolated between group
    midpoints; None if it never does."""
    prev = None
    for lo, hi in GROUPS[:-1]:
        sel = [r for r in rows if lo <= r["find_depth"] <= hi]
        if len(sel) < 20:
            continue
        mid, rate = (lo + hi) / 2, sum(r["found"] for r in sel) / len(sel)
        if rate < 0.5:
            if prev is None:
                return mid
            pm, pr = prev
            return pm + (pr - 0.5) / (pr - rate) * (mid - pm)
        prev = (mid, rate)
    return None


def describe_crossing(rows: list[dict], boots: int) -> str:
    point = crossing(rows)
    games: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        games[r["id"].rsplit("#", 1)[0]].append(r)
    keys = list(games)
    rng = random.Random(1)
    samples = []
    for _ in range(boots):
        pick = [r for _k in keys for r in games[rng.choice(keys)]]
        samples.append(crossing(pick))
    never = sum(s is None for s in samples)
    vals = sorted(s for s in samples if s is not None)
    if point is None:
        return f"never below 50% (bootstrap: never in {never}/{boots})"
    if not vals:
        return f"depth {point:.1f}"
    lo, hi = vals[int(0.05 * len(vals))], vals[int(0.95 * len(vals)) - 1]
    extra = f"; never below 50% in {never}/{boots} resamples" if never else ""
    return f"depth {point:.1f} (90% range {lo:.1f}-{hi:.1f}{extra})"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("positions")
    ap.add_argument("--time-class", default="all", choices=["all", "daily", "live"])
    ap.add_argument("--json")
    ap.add_argument("--bands", default="900,1100", help="rating band edges for the tables, e.g. 1000,1200,1400")
    ap.add_argument("--single", action="store_true", help="only positions with exactly one good move")
    ap.add_argument("--boot", type=int, default=300, help="bootstrap resamples (by game) for the 50%% depth")
    args = ap.parse_args()

    rows = [json.loads(line) for line in open(args.positions, encoding="utf-8")]
    total = len(rows)
    rows = [r for r in rows if abs(win_chance(r["best_cp"])) <= DECIDED]
    if args.time_class == "daily":
        rows = [r for r in rows if r["time_class"] == "daily"]
    elif args.time_class == "live":
        rows = [r for r in rows if r["time_class"] != "daily"]
    if args.single:
        rows = [r for r in rows if r.get("n_good") == 1]
    print(f"{len(rows)} positions used ({total} analysed; decided positions, other time classes"
          f"{', positions with several good moves' if args.single else ''} left out)")

    edges = [int(x) for x in args.bands.split(",")]
    for lo, hi in zip(edges, edges[1:]):
        sel = [r for r in rows if lo <= r["rating"] < hi]
        if not sel:
            continue
        print(f"\nPlayers rated {lo}-{hi - 1} ({len(sel)} positions):")
        for name, (f, n) in binned(sel):
            print(f"  depth {name:<6} {f / n:6.1%}  of {n}")
        print(f"  50% crossing: {describe_crossing(sel, args.boot)}")

    w = logistic_fit(rows)
    print(f"\nSmoothed fit (ln depth; it can miss the bins, see NOTES.md): a={w[0]:.3f}  b={w[1]:.3f}  c(per 100 rating)={w[2]:.3f}")
    if args.json:
        json.dump(
            {"a": w[0], "b": w[1], "c": w[2], "positions": len(rows), "time_class": args.time_class,
             "half_depth_1000": depth_at_half(w, 1000)},
            open(args.json, "w"), indent=2,
        )


if __name__ == "__main__":
    main()
