/** Per-browser settings (small, so localStorage; guarded because storage can be blocked). */
import { useCallback, useState } from "react";

export interface Settings {
  depth: number; // board analysis depth
  heatmap: boolean;
  arrow: boolean;
  flip: boolean;
  lichessToken: string;
  explorerSpeeds: string[];
  explorerRatings: number[];
  chesscomUsername: string;
  puzzleTimeClasses: string[];
  puzzleDepth: number;
  puzzleMarkers: string[];
  puzzleLookahead: number;
  puzzleMode: string;
  puzzleOrder: string;
  repertoireColor: "white" | "black";
  repertoireRatings: number[];
  repertoireCoverage: number;
}

export const DEFAULTS: Settings = {
  depth: 14,
  heatmap: true,
  arrow: false,
  flip: false,
  lichessToken: "",
  explorerSpeeds: ["bullet", "blitz", "rapid"],
  explorerRatings: [1200, 1400, 1600, 1800],
  chesscomUsername: "",
  puzzleTimeClasses: ["bullet", "blitz", "rapid", "daily"],
  puzzleDepth: 10,
  puzzleMarkers: ["??", "?", "?!"],
  puzzleLookahead: 5,
  puzzleMode: "unsolved",
  puzzleOrder: "easiest",
  repertoireColor: "white",
  repertoireRatings: [1200, 1400, 1600],
  repertoireCoverage: 50,
};

const KEY = "chess-analyzer-settings-v1";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const out: Settings = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      if (parsed[k] !== undefined && typeof parsed[k] === typeof DEFAULTS[k]) {
        (out as unknown as Record<string, unknown>)[k] = parsed[k];
      }
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: settings last for this visit only */
  }
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);
  return [settings, update];
}
