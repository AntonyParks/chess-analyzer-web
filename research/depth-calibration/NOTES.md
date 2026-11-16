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

**Next idea:** use MultiPV to record the number of excellent moves and the gap to the second-best move. Then restrict to positions with exactly one excellent move, where find depth should discriminate.
