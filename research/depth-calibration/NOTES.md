# Depth calibration: first run (2026-11-15)

**Data:** 32,478 positions from the 580-game chess.com library, Stockfish 18 deep reference, cleared hash per position. 27,236 positions remained after leaving out decided positions.

**Do not use `half_depth_1000` from `fit-*.json` as a constant.** The ln(depth) logistic disagrees with the binned data.

For daily games at 900–1099:

| Find depth | Model | Observed |
|---|---|---|
| 1 | 76% | 75% |
| 2 | 68% | 52% |
| 3–10 | | flat at about 44–50% |
| 11–19 | | flat at about 36–49% |

There is no well-defined 50% crossing.

**Why it's flat:**
- Find depth, as defined, mostly tracks how many acceptable moves a position has, not how hard the best one is to see.
- The 19+ bin, with 48.5% found, is an artifact: a `root_moves` rescore can outscore the main search's depth-18 move.

**Move matching by depth is nearly flat too:** for daily 900–1099, 35.5% of moves match Stockfish's top move at depth 1 and 36.1% at depth 18. This agrees with Maia's finding that depth-limited Stockfish doesn't imitate weaker players.

**Sample limits:**
- Live 900–1099 has only 157 moves.
- Daily 900–1099 is mostly one player.
- Rating effects are weak (0.05–0.10 logit per 100 points), and there are about 40 player-sides at 1200+.

## Lichess sample (2026-11-16)

**Data:**
- 4,800 rated rapid and blitz games, about 80% blitz, from the first 150 MB of the October 2026 dump. 1,200 games in each average-rating band: 1000, 1200, 1400 and 1600.
- 10 random moves per game. Moves that left under 30 s on the clock were skipped.
- 47,168 positions analysed; 42,681 used.
- Commands: `fit.py data/lichess_positions.jsonl --bands 1000,1200,1300,1400,1600,1800 [--single]`

**50% crossing** (find depth where the found rate first drops below 50%; the range is a 90% interval from bootstrapping whole games):

| Band | All positions | One good move only |
|---|---|---|
| 1000–1199 | 1.8 (1.7–2.1) | 1.6 (1.4–1.8) |
| 1200–1299 | 3.8 (1.8–4.5) | 1.6 (1.5–1.9) |
| 1300–1399 | 4.1 (1.9–5.8) | 2.6 (2.0–3.1) |
| 1400–1599 | 5.5 (3.5–6.8) | 2.0 (1.7–3.0) |
| 1600–1799 | 5.2 (3.5–7.9) | 2.5 (1.9–3.2) |

A chess.com 1000 is about Lichess 1250. Its crossing is about depth 2–4 over all positions, and about depth 2 where only one move works.

**The curve's shape:**
- At depth 1 the found rate is about 70% (65–77% depending on band).
- It drops sharply to 45–57% at depth 2.
- It then declines slowly, to about 30% at depths 15–18 and 20–30% at 19+.

Unlike the library sample, the decline holds steadily past depth 2. A higher rating lifts the whole curve by only about 5–10 points between 1000 and 1700.

**For "expected vs actual" play:** use the per-band, per-depth-group found rates as a lookup table, not the ln(depth) logistic.

**Next idea (done above):** use MultiPV to record the number of excellent moves and the gap to the second-best move. Then restrict to positions with exactly one excellent move, where find depth should discriminate.
