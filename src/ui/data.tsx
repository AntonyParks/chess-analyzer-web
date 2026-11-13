/**
 * The visitor's own data: downloaded games, puzzles (with results) and the repertoire, loaded
 * from IndexedDB at start and saved after every change. Backup and restore use the desktop
 * app's JSON shapes, so desktop files import directly.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PuzzleStore } from "../core/puzzles";
import { RepertoireStore } from "../core/repertoire";
import { GameLibrary } from "../data/gameLibrary";
import { deleteAll, loadRecord, requestPersistence, saveRecord, type StoreKey } from "../data/storage";

export interface DataApi {
  ready: boolean;
  library: GameLibrary;
  puzzles: PuzzleStore;
  repertoire: RepertoireStore;
  /** Bumps after any change (effect dependency). */
  version: number;
  /** Save one store after changing it, and re-render. */
  save: (key: Exclude<StoreKey, "scan">) => void;
  summary: string;
  exportBackup: () => void;
  importFile: (file: File) => Promise<string>;
  clearAll: () => Promise<void>;
}

const DataContext = createContext<DataApi | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState(0);
  const stores = useRef({
    library: GameLibrary.fromJSON({ version: 1, users: {} }),
    puzzles: new PuzzleStore(),
    repertoire: new RepertoireStore(),
  });
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    (async () => {
      const [lib, puz, rep] = await Promise.all([
        loadRecord("library").catch(() => undefined),
        loadRecord("puzzles").catch(() => undefined),
        loadRecord("repertoire").catch(() => undefined),
      ]);
      const s = stores.current;
      try {
        if (lib) s.library = GameLibrary.fromJSON(lib);
      } catch (err) {
        console.warn("Stored game library unreadable", err);
      }
      try {
        if (puz) s.puzzles = PuzzleStore.fromJSON(puz);
      } catch (err) {
        console.warn("Stored puzzles unreadable", err);
      }
      try {
        if (rep) s.repertoire = RepertoireStore.fromJSON(rep);
      } catch (err) {
        console.warn("Stored repertoire unreadable", err);
      }
      setReady(true);
      setVersion((v) => v + 1);
    })();
  }, []);

  const save = useCallback((key: Exclude<StoreKey, "scan">) => {
    setVersion((v) => v + 1);
    void requestPersistence();
    clearTimeout(timers.current[key]);
    // Coalesce bursts (a scan finds many puzzles): one write per half second per store.
    timers.current[key] = setTimeout(() => {
      const value = stores.current[key].toJSON();
      saveRecord(key, value).catch((err) => console.error(`Could not save ${key}`, err));
    }, 500);
  }, []);

  const exportBackup = useCallback(() => {
    const s = stores.current;
    const backup = {
      app: "chess-analyzer-web",
      version: 1,
      exported: new Date().toISOString(),
      library: s.library.toJSON(),
      puzzles: s.puzzles.toJSON(),
      repertoire: s.repertoire.toJSON(),
    };
    const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `chess-analyzer-backup-${backup.exported.slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, []);

  const importFile = useCallback(
    async (file: File): Promise<string> => {
      let raw: unknown;
      try {
        raw = JSON.parse(await file.text());
      } catch {
        return `${file.name}: not a JSON file.`;
      }
      const s = stores.current;
      const obj = raw as Record<string, unknown>;
      try {
        if (obj && obj.app === "chess-analyzer-web") {
          s.library = GameLibrary.fromJSON(obj.library);
          s.puzzles = PuzzleStore.fromJSON(obj.puzzles);
          s.repertoire = RepertoireStore.fromJSON(obj.repertoire);
          (["library", "puzzles", "repertoire"] as const).forEach((k) => save(k));
          return `${file.name}: backup restored.`;
        }
        if (obj && "puzzles" in obj && "analysed_games" in obj) {
          const incoming = PuzzleStore.fromJSON(obj);
          for (const p of incoming.all()) s.puzzles.add(p);
          for (const [url, depth] of incoming.analysedGames) s.puzzles.markAnalysed(url, depth);
          save("puzzles");
          return `${file.name}: ${incoming.size} puzzles imported.`;
        }
        if (obj && "white" in obj && "black" in obj) {
          s.repertoire = RepertoireStore.fromJSON(obj);
          save("repertoire");
          return `${file.name}: repertoire imported.`;
        }
        if (obj && "users" in obj) {
          s.library = GameLibrary.fromJSON(obj);
          save("library");
          return `${file.name}: game library imported.`;
        }
      } catch (err) {
        return `${file.name}: could not import (${(err as Error).message}).`;
      }
      return `${file.name}: not a ChessAnalyzer file.`;
    },
    [save],
  );

  const clearAll = useCallback(async () => {
    await deleteAll();
    stores.current = {
      library: GameLibrary.fromJSON({ version: 1, users: {} }),
      puzzles: new PuzzleStore(),
      repertoire: new RepertoireStore(),
    };
    setVersion((v) => v + 1);
  }, []);

  const s = stores.current;
  const summary = ready
    ? `${s.puzzles.size} puzzles · ${s.repertoire.entries.length} repertoire${s.repertoire.entries.length === 1 ? "" : "s"} (${s.repertoire.entries.map((e) => `${e.name}: ${e.rep.size()} moves`).join(", ")})`
    : "Loading your data…";

  const value = useMemo<DataApi>(
    () => ({
      ready,
      library: s.library,
      puzzles: s.puzzles,
      repertoire: s.repertoire,
      version,
      save,
      summary,
      exportBackup,
      importFile,
      clearAll,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, version, summary],
  );
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataApi {
  const d = useContext(DataContext);
  if (!d) throw new Error("useData outside DataProvider");
  return d;
}
