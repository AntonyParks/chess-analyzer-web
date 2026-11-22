/**
 * Auto-save to a file the visitor picks (File System Access API: Chrome and Edge on desktop).
 *
 * Browser storage can be wiped (by "Clear my data", or by the browser when it frees space), so the
 * site can keep a copy of everything in a real file on the visitor's computer, rewritten after
 * every change. If browser storage is lost, opening that file brings it all back.
 *
 * The file handle is kept in IndexedDB (handles survive reloads); after a reload the browser may
 * ask once more for permission to write, which needs a click.
 */
import { loadAny, saveAny } from "./storage";

// Minimal types: the File System Access API is not in TypeScript's DOM library.
interface Writable {
  write(data: Blob | string): Promise<void>;
  close(): Promise<void>;
}
interface PermissionOpts {
  mode: "read" | "readwrite";
}
export interface FileHandle {
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<Writable>;
  queryPermission?(o: PermissionOpts): Promise<PermissionState>;
  requestPermission?(o: PermissionOpts): Promise<PermissionState>;
}
interface PickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
type PickerWindow = Window & {
  showSaveFilePicker?: (o?: PickerOptions) => Promise<FileHandle>;
  showOpenFilePicker?: (o?: PickerOptions & { multiple?: boolean }) => Promise<FileHandle[]>;
};

const HANDLE_KEY = "backupHandle";
const TYPES = [{ description: "ChessAnalyzer backup", accept: { "application/json": [".json"] } }];

export function backupFileSupported(): boolean {
  const w = window as PickerWindow;
  return typeof w.showSaveFilePicker === "function" && typeof w.showOpenFilePicker === "function";
}

/** Ask for a new file to save to (must be called from a click). */
export async function pickNewFile(): Promise<FileHandle> {
  return (window as PickerWindow).showSaveFilePicker!({ suggestedName: "chess-analyzer-autosave.json", types: TYPES });
}

/** Ask for an existing backup file (must be called from a click). */
export async function pickExistingFile(): Promise<FileHandle> {
  const [h] = await (window as PickerWindow).showOpenFilePicker!({ types: TYPES, multiple: false });
  return h;
}

export async function rememberHandle(h: FileHandle | null): Promise<void> {
  await saveAny(HANDLE_KEY, h ?? undefined);
}

export async function rememberedHandle(): Promise<FileHandle | null> {
  try {
    return ((await loadAny(HANDLE_KEY)) as FileHandle | undefined) ?? null;
  } catch {
    return null;
  }
}

/** "granted", or "prompt" when a click is needed to allow writing again. */
export async function writePermission(h: FileHandle, ask: boolean): Promise<PermissionState> {
  const opts: PermissionOpts = { mode: "readwrite" };
  try {
    const state = (await h.queryPermission?.(opts)) ?? "granted";
    if (state === "granted" || !ask) return state;
    return (await h.requestPermission?.(opts)) ?? "denied";
  } catch {
    return "denied";
  }
}

export async function writeFile(h: FileHandle, text: string): Promise<void> {
  const w = await h.createWritable();
  await w.write(new Blob([text], { type: "application/json" }));
  await w.close();
}

export async function readFile(h: FileHandle): Promise<string> {
  return (await h.getFile()).text();
}
