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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("positions")
    ap.add_argument("--time-class", default="all", choices=["all", "daily", "live"])
    ap.add_argument("--json")
    args = ap.parse_args()

    rows = [json.loads(line) for line in open(args.positions, encoding="utf-8")]
    total = len(rows)
    rows = [r for r in rows if abs(win_chance(r["best_cp"])) <= DECIDED]
    if args.time_class == "daily":
        rows = [r for r in rows if r["time_class"] == "daily"]
    elif args.time_class == "live":
        rows = [r for r in rows if r["time_class"] != "daily"]
    print(f"{len(rows)} positions used ({total} analysed; decided positions and other time classes left out)")

    print("\nFound rate by find depth, players rated 900-1099:")
    bins: dict[int, list[int]] = defaultdict(lambda: [0, 0])
    for r in rows:
        if 900 <= r["rating"] < 1100:
            b = bins[min(r["find_depth"], 19)]
            b[0] += r["found"]
            b[1] += 1
    for d in sorted(bins):
        f, n = bins[d]
        print(f"  depth {d:>2}{'+' if d == 19 else ' '}  {f / n:6.1%}  of {n}")

    w = logistic_fit(rows)
    print(f"\nFit: a={w[0]:.3f}  b(ln depth)={w[1]:.3f}  c(per 100 rating)={w[2]:.3f}")
    for rating in (600, 800, 1000, 1200, 1400):
        print(f"  rating {rating}: 50% at find depth {depth_at_half(w, rating):.1f}")
    if args.json:
        json.dump(
            {"a": w[0], "b": w[1], "c": w[2], "positions": len(rows), "time_class": args.time_class,
             "half_depth_1000": depth_at_half(w, 1000)},
            open(args.json, "w"), indent=2,
        )


if __name__ == "__main__":
    main()
