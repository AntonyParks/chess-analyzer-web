/**
 * The visitor's own data: downloaded games, puzzles (with results) and the repertoire, loaded
 * from IndexedDB at start and saved after every change. Backup and restore use the desktop
 * app's JSON shapes, so desktop files import directly.
 *
 * Browser storage can be wiped (by "Clear my data", or by the browser freeing space), so:
 * - a stored record that can't be read is copied aside before anything can save over it;
 * - nothing is saved before the stored data has loaded;
 * - pending writes go out at once when the page is hidden or closed;
 * - an optional auto-save file on the visitor's computer gets a full copy after every change.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PuzzleStore } from "../core/puzzles";
import { RepertoireStore } from "../core/repertoire";
import {
  type FileHandle,
  backupFileSupported,
  pickExistingFile,
  pickNewFile,
  readFile,
  rememberHandle,
  rememberedHandle,
  writeFile,
  writePermission,
} from "../data/backupFile";
import { GameLibrary } from "../data/gameLibrary";
import { deleteAll, isPersisted, loadAny, loadRecord, requestPersistence, saveAny, saveRecord, type StoreKey } from "../data/storage";

/** The auto-save file: off, saving, or paused until a click allows writing again. */
export interface BackupFileState {
  status: "unsupported" | "off" | "on" | "paused" | "held" | "error";
  name: string | null;
  savedAt: Date | null;
  /** Error text ("error"), or why saving is held back ("held"). */
  error: string | null;
}

/** How much a backup holds, to notice a store that suddenly shrank. */
interface Sizes {
  moves: number;
  puzzles: number;
  games: number;
}

function sizesOf(library: unknown, puzzles: PuzzleStore, repertoire: RepertoireStore): Sizes {
  let games = 0;
  const users = (library as { users?: Record<string, { archives?: Record<string, unknown> }> })?.users ?? {};
  for (const u of Object.values(users)) {
    for (const a of Object.values(u?.archives ?? {})) {
      const list = Array.isArray(a) ? a : (a as { games?: unknown[] })?.games;
      games += Array.isArray(list) ? list.length : 0;
    }
  }
  return { moves: repertoire.entries.reduce((n, e) => n + e.rep.size(), 0), puzzles: puzzles.size, games };
}

/** The first store that lost more than half of what the file holds, if any. */
function shrunk(now: Sizes, file: Sizes): string | null {
  const names: Record<keyof Sizes, string> = { moves: "repertoire moves", puzzles: "puzzles", games: "games" };
  for (const k of ["moves", "puzzles", "games"] as const) {
    if (file[k] > 0 && now[k] < file[k] / 2) return `${names[k]}: ${now[k]} here, ${file[k]} in the file`;
  }
  return null;
}

type DataKey = Exclude<StoreKey, "scan">;

export interface DataApi {
  ready: boolean;
  library: GameLibrary;
  puzzles: PuzzleStore;
  repertoire: RepertoireStore;
  /** Bumps after any change (effect dependency). */
  version: number;
  /** Save one store after changing it, and re-render. */
  save: (key: DataKey) => void;
  summary: string;
  exportBackup: () => void;
  importFile: (file: File) => Promise<string>;
  clearAll: () => Promise<void>;
  /** Whether the browser promised not to clear this site's storage (null: unknown). */
  persisted: boolean | null;
  backupFile: BackupFileState;
  /** Pick a new file and start saving to it (from a click). */
  startBackupFile: () => Promise<string>;
  /** Open an existing backup file, restore it, and keep saving to it (from a click). */
  openBackupFile: () => Promise<string>;
  /** Allow writing again after a reload (from a click). */
  resumeBackupFile: () => Promise<void>;
  /** Write the file even though saving was held back. */
  saveBackupFileAnyway: () => Promise<void>;
  stopBackupFile: () => Promise<void>;
}

const FILE_DELAY = 2000;

const DataContext = createContext<DataApi | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState(0);
  const stores = useRef({
    library: GameLibrary.fromJSON({ version: 1, users: {} }),
    puzzles: new PuzzleStore(),
    repertoire: new RepertoireStore(),
  });
  const timers = useRef<Partial<Record<DataKey, ReturnType<typeof setTimeout>>>>({});
  const readyRef = useRef(false);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [backupFile, setBackupFile] = useState<BackupFileState>({ status: "off", name: null, savedAt: null, error: null });
  const handle = useRef<FileHandle | null>(null);
  const fileOn = useRef(false);
  const fileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** What the file held when last read or written (null: not known yet this session). */
  const fileSizes = useRef<Sizes | null>(null);
  /** Stores that couldn't be read this session: the file must not be overwritten. */
  const keptAside = useRef<string[]>([]);

  const setFile = useCallback((next: BackupFileState | ((b: BackupFileState) => BackupFileState)) => {
    setBackupFile((b) => {
      const v = typeof next === "function" ? next(b) : next;
      fileOn.current = v.status === "on";
      return v;
    });
  }, []);

  useEffect(() => {
    (async () => {
      const [lib, puz, rep] = await Promise.all([
        loadRecord("library").catch(() => undefined),
        loadRecord("puzzles").catch(() => undefined),
        loadRecord("repertoire").catch(() => undefined),
      ]);
      const s = stores.current;
      // A record that can't be read is copied aside before anything can save over it.
      // One copy per store: the first one found is the original data, so later loads keep it.
      const keepAside = async (key: DataKey, raw: unknown, err: unknown) => {
        const aside = `${key}-unreadable`;
        console.warn(`Stored ${key} unreadable; a copy is kept as ${aside}`, err);
        if (!keptAside.current.includes(key)) keptAside.current.push(key);
        if ((await loadAny(aside).catch(() => undefined)) === undefined) await saveAny(aside, raw).catch(() => undefined);
      };
      // The readers are lenient: data they don't understand comes back empty rather than as an
      // error. So a stored record that reads back much smaller than it is is kept aside too.
      const lost = (raw: unknown, parsed: { toJSON(): unknown }) => {
        const before = JSON.stringify(raw).length;
        return before > 2_000 && JSON.stringify(parsed.toJSON()).length < before / 2;
      };
      try {
        if (lib) {
          s.library = GameLibrary.fromJSON(lib);
          if (lost(lib, s.library)) await keepAside("library", lib, "read back much smaller");
        }
      } catch (err) {
        await keepAside("library", lib, err);
      }
      try {
        if (puz) {
          s.puzzles = PuzzleStore.fromJSON(puz);
          if (lost(puz, s.puzzles)) await keepAside("puzzles", puz, "read back much smaller");
        }
      } catch (err) {
        await keepAside("puzzles", puz, err);
      }
      try {
        if (rep) {
          s.repertoire = RepertoireStore.fromJSON(rep);
          if (lost(rep, s.repertoire)) await keepAside("repertoire", rep, "read back much smaller");
        }
      } catch (err) {
        await keepAside("repertoire", rep, err);
      }
      readyRef.current = true;
      setReady(true);
      setVersion((v) => v + 1);
      void requestPersistence().then(() => isPersisted().then(setPersisted));
      if (!backupFileSupported()) {
        setFile((b) => ({ ...b, status: "unsupported" }));
        return;
      }
      const h = await rememberedHandle();
      if (h) {
        handle.current = h;
        const perm = await writePermission(h, false);
        if (keptAside.current.length) {
          setFile({ status: "held", name: h.name, savedAt: null, error: heldForAside(keptAside.current) });
        } else {
          setFile({ status: perm === "granted" ? "on" : "paused", name: h.name, savedAt: null, error: null });
        }
      }
    })();
  }, [setFile]);

  const backupObject = useCallback(() => {
    const s = stores.current;
    return {
      app: "chess-analyzer-web",
      version: 1,
      exported: new Date().toISOString(),
      library: s.library.toJSON(),
      puzzles: s.puzzles.toJSON(),
      repertoire: s.repertoire.toJSON(),
    };
  }, []);

  /** Write the file; ``force`` skips the shrink check (the visitor said so). */
  const writeBackupFile = useCallback(
    async (force = false) => {
      fileTimer.current = null;
      const h = handle.current;
      if (!h || !fileOn.current) return;
      const s = stores.current;
      const backup = backupObject();
      const now = sizesOf(backup.library, s.puzzles, s.repertoire);
      if (!now.moves && !now.puzzles && !now.games) return; // never overwrite a backup with nothing
      try {
        if (!force) {
          if (fileSizes.current === null) fileSizes.current = await sizesInFile(h);
          const lost = fileSizes.current && shrunk(now, fileSizes.current);
          if (lost) {
            const why = `Less here than in the file (${lost}), so the file isn't overwritten.`;
            setFile((b) => ({ ...b, status: "held", error: why }));
            return;
          }
        }
        await writeFile(h, JSON.stringify(backup));
        fileSizes.current = now;
        setFile((b) => ({ ...b, status: "on", savedAt: new Date(), error: null }));
      } catch (err) {
        const e = err as Error;
        const paused = e.name === "NotAllowedError" || e.name === "SecurityError";
        setFile((b) => ({ ...b, status: paused ? "paused" : "error", error: paused ? null : e.message }));
      }
    },
    [backupObject, setFile],
  );

  const scheduleFile = useCallback(() => {
    if (!handle.current) return;
    if (fileTimer.current) clearTimeout(fileTimer.current);
    fileTimer.current = setTimeout(() => void writeBackupFile(), FILE_DELAY);
  }, [writeBackupFile]);

  const writeNow = useCallback((key: DataKey) => {
    delete timers.current[key];
    const value = stores.current[key].toJSON();
    saveRecord(key, value).catch((err) => console.error(`Could not save ${key}`, err));
  }, []);

  const save = useCallback(
    (key: DataKey) => {
      setVersion((v) => v + 1);
      if (!readyRef.current) return; // nothing is saved over stored data before it has loaded
      clearTimeout(timers.current[key]);
      // Coalesce bursts (a scan finds many puzzles): one write per half second per store.
      timers.current[key] = setTimeout(() => writeNow(key), 500);
      scheduleFile();
    },
    [writeNow, scheduleFile],
  );

  // Hiding or closing the page writes pending changes at once (a closed tab would lose them).
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState !== "hidden") return;
      for (const key of Object.keys(timers.current) as DataKey[]) {
        clearTimeout(timers.current[key]);
        writeNow(key);
      }
      if (fileTimer.current) {
        clearTimeout(fileTimer.current);
        void writeBackupFile();
      }
    };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, [writeNow, writeBackupFile]);

  const exportBackup = useCallback(() => {
    const backup = backupObject();
    const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `chess-analyzer-backup-${backup.exported.slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [backupObject]);

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
    // The auto-save file is left as it is (it is the way back) and no longer written to.
    handle.current = null;
    if (fileTimer.current) clearTimeout(fileTimer.current);
    for (const key of Object.keys(timers.current) as DataKey[]) clearTimeout(timers.current[key]);
    timers.current = {};
    setFile((b) => ({ status: b.status === "unsupported" ? "unsupported" : "off", name: null, savedAt: null, error: null }));
    await deleteAll();
    stores.current = {
      library: GameLibrary.fromJSON({ version: 1, users: {} }),
      puzzles: new PuzzleStore(),
      repertoire: new RepertoireStore(),
    };
    setVersion((v) => v + 1);
  }, [setFile]);

  const startBackupFile = useCallback(async (): Promise<string> => {
    let h: FileHandle;
    try {
      h = await pickNewFile();
    } catch {
      return "No file chosen.";
    }
    handle.current = h;
    await rememberHandle(h);
    fileSizes.current = null; // a chosen file may already hold a backup: compare first
    fileOn.current = true; // before the write below (the state update may not have run yet)
    setFile({ status: "on", name: h.name, savedAt: null, error: null });
    await writeBackupFile();
    return `Saving everything to ${h.name} after every change.`;
  }, [setFile, writeBackupFile]);

  const openBackupFile = useCallback(async (): Promise<string> => {
    let h: FileHandle;
    try {
      h = await pickExistingFile();
    } catch {
      return "No file chosen.";
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(await readFile(h)) as Record<string, unknown>;
    } catch {
      return `${h.name}: not a JSON file.`;
    }
    if (obj?.app !== "chess-analyzer-web") return `${h.name}: not a ChessAnalyzer backup.`;
    const s = stores.current;
    try {
      const library = GameLibrary.fromJSON(obj.library);
      const puzzles = PuzzleStore.fromJSON(obj.puzzles);
      const repertoire = RepertoireStore.fromJSON(obj.repertoire);
      s.library = library;
      s.puzzles = puzzles;
      s.repertoire = repertoire;
    } catch (err) {
      return `${h.name}: could not read it (${(err as Error).message}).`;
    }
    (["library", "puzzles", "repertoire"] as const).forEach(writeNow);
    setVersion((v) => v + 1);
    handle.current = h;
    await rememberHandle(h);
    keptAside.current = [];
    fileSizes.current = sizesOf(obj.library, s.puzzles, s.repertoire);
    const perm = await writePermission(h, true);
    fileOn.current = perm === "granted";
    setFile({ status: perm === "granted" ? "on" : "paused", name: h.name, savedAt: null, error: null });
    return `${h.name}: restored${perm === "granted" ? ", and saving to it from now on" : ""}.`;
  }, [writeNow, setFile]);

  const resumeBackupFile = useCallback(async () => {
    const h = handle.current;
    if (!h) return;
    const perm = await writePermission(h, true);
    if (perm !== "granted") return setFile((b) => ({ ...b, status: "paused" }));
    if (keptAside.current.length) {
      return setFile((b) => ({ ...b, status: "held", error: heldForAside(keptAside.current) }));
    }
    fileOn.current = true; // before the write below (the state update may not have run yet)
    setFile((b) => ({ ...b, status: "on" }));
    await writeBackupFile();
  }, [setFile, writeBackupFile]);

  const saveBackupFileAnyway = useCallback(async () => {
    const h = handle.current;
    if (!h) return;
    if ((await writePermission(h, true)) !== "granted") return setFile((b) => ({ ...b, status: "paused" }));
    keptAside.current = [];
    fileOn.current = true;
    setFile((b) => ({ ...b, status: "on", error: null }));
    await writeBackupFile(true);
  }, [setFile, writeBackupFile]);

  const stopBackupFile = useCallback(async () => {
    handle.current = null;
    if (fileTimer.current) clearTimeout(fileTimer.current);
    await rememberHandle(null);
    setFile({ status: "off", name: null, savedAt: null, error: null });
  }, [setFile]);

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
      persisted,
      backupFile,
      startBackupFile,
      openBackupFile,
      resumeBackupFile,
      saveBackupFileAnyway,
      stopBackupFile,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, version, summary, persisted, backupFile],
  );
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataApi {
  const d = useContext(DataContext);
  if (!d) throw new Error("useData outside DataProvider");
  return d;
}

function heldForAside(keys: string[]): string {
  return `Some of your stored ${keys.join(" and ")} couldn't be read (a copy is kept in this browser), so the file isn't overwritten. Restore from the file, or save anyway.`;
}

/** What the file holds now (null if it is empty, unreadable or not a backup). */
async function sizesInFile(h: FileHandle): Promise<Sizes | null> {
  try {
    const text = await readFile(h);
    if (!text.trim()) return null;
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (obj?.app !== "chess-analyzer-web") return null;
    return sizesOf(obj.library, PuzzleStore.fromJSON(obj.puzzles), RepertoireStore.fromJSON(obj.repertoire));
  } catch {
    return null;
  }
}
