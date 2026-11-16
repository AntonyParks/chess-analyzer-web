/**
 * Your rating for the "at your level" features: taken automatically from your most recent
 * downloaded game (in the chosen time control), or the number typed in Settings.
 */
import { useMemo } from "react";
import { CHESSCOM_TO_LICHESS } from "../core/humanModel";
import { lichessKey } from "../data/lichessGames";
import { useData } from "./data";
import type { Settings } from "./settings";

export interface FoundRating {
  /** chess.com scale (Lichess ratings converted). */
  rating: number;
  timeClass: string;
  endTime: number; // Unix seconds
  site: "chess.com" | "Lichess";
}

function ratingIn(pgn: string, color: "w" | "b"): number | null {
  const m = new RegExp(`\\[${color === "w" ? "White" : "Black"}Elo "(\\d+)"\\]`).exec(pgn);
  return m ? Number(m[1]) : null;
}

/** Your most recent rating in ``timeClass`` ("latest" = whichever you played last). */
export function useFoundRating(settings: Settings): FoundRating | null {
  const data = useData();
  return useMemo(() => {
    const sources: { key: string; site: FoundRating["site"] }[] = [];
    if (settings.chesscomUsername.trim()) sources.push({ key: settings.chesscomUsername.trim(), site: "chess.com" });
    if (settings.lichessUsername.trim()) sources.push({ key: lichessKey(settings.lichessUsername), site: "Lichess" });
    let best: FoundRating | null = null;
    for (const { key, site } of sources) {
      if (!data.library.hasUser(key)) continue;
      for (const g of data.library.games(key)) {
        if (settings.humanRatingClass !== "latest" && g.timeClass !== settings.humanRatingClass) continue;
        if (best && g.endTime <= best.endTime) continue;
        const r = ratingIn(g.pgn, g.userColor);
        if (!r) continue;
        best = { rating: site === "Lichess" ? r - CHESSCOM_TO_LICHESS : r, timeClass: g.timeClass, endTime: g.endTime, site };
      }
    }
    return best;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.library, data.ready, data.version, settings.chesscomUsername, settings.lichessUsername, settings.humanRatingClass]);
}

/** The rating the features use (chess.com scale). */
export function useYourRating(settings: Settings): number {
  const found = useFoundRating(settings);
  return settings.humanRatingAuto && found ? found.rating : settings.humanRating;
}
