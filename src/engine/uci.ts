/** UCI plumbing: one engine, one search at a time, with abort and option handling. */

/** What the scheduler needs from an engine: a line-based UCI pipe. */
export interface UciEngine {
  send(command: string): void;
  onLine(listener: (line: string) => void): void;
  terminate(): void;
}

export interface PvInfo {
  multipv: number;
  depth: number;
  kind: "cp" | "mate";
  value: number; // relative to the side to move in the searched position
  pv: string[];
}

export interface SearchOutcome {
  lines: Map<number, PvInfo>; // multipv index -> deepest info seen
  /** The main line (multipv 1) at each finished depth, shallowest first. */
  byDepth: PvInfo[];
  bestmove: string | null;
  aborted: boolean;
}

export function parseInfo(line: string): PvInfo | null {
  if (!line.startsWith("info ") || !line.includes(" score ")) return null;
  const t = line.split(/\s+/);
  let depth = 0;
  let multipv = 1;
  let kind: "cp" | "mate" | null = null;
  let value = 0;
  let pv: string[] = [];
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case "depth":
        depth = Number(t[++i]);
        break;
      case "multipv":
        multipv = Number(t[++i]);
        break;
      case "score":
        kind = t[++i] as "cp" | "mate";
        value = Number(t[++i]);
        if (t[i + 1] === "lowerbound" || t[i + 1] === "upperbound") return null; // not exact
        break;
      case "pv":
        pv = t.slice(i + 1);
        i = t.length;
        break;
      default:
        break;
    }
  }
  if (kind === null) return null;
  return { multipv, depth, kind, value, pv };
}

/** Serialises searches on one UCI engine. */
export class UciSession {
  private listeners: ((line: string) => void)[] = [];
  private options = new Map<string, string>();
  private searching: {
    resolve: (o: SearchOutcome) => void;
    lines: Map<number, PvInfo>;
    byDepth: Map<number, PvInfo>;
    aborted: boolean;
  } | null = null;
  private readyWaiters: (() => void)[] = [];
  private ready: Promise<void>;
  name = "Stockfish";

  constructor(private readonly engine: UciEngine) {
    engine.onLine((line) => this.handle(line));
    this.ready = new Promise((resolve) => {
      const onUciOk = (line: string) => {
        if (line.startsWith("id name ")) this.name = line.slice(8).trim();
        if (line === "uciok") {
          this.listeners = this.listeners.filter((l) => l !== onUciOk);
          resolve();
        }
      };
      this.listeners.push(onUciOk);
    });
    engine.send("uci");
  }

  private handle(raw: string): void {
    const line = raw.trim();
    for (const l of [...this.listeners]) l(line);
    if (line === "readyok") {
      const waiters = this.readyWaiters.splice(0);
      waiters.forEach((w) => w());
      return;
    }
    const s = this.searching;
    if (!s) return;
    const info = parseInfo(line);
    if (info) {
      const prev = s.lines.get(info.multipv);
      if (!prev || info.depth >= prev.depth) s.lines.set(info.multipv, info);
      if (info.multipv === 1 && info.pv.length) s.byDepth.set(info.depth, info);
      return;
    }
    if (line.startsWith("bestmove")) {
      const best = line.split(/\s+/)[1] ?? null;
      this.searching = null;
      const byDepth = [...s.byDepth.values()].sort((a, b) => a.depth - b.depth);
      s.resolve({ lines: s.lines, byDepth, bestmove: best === "(none)" ? null : best, aborted: s.aborted });
    }
  }

  async isReady(): Promise<void> {
    await this.ready;
    await new Promise<void>((resolve) => {
      this.readyWaiters.push(resolve);
      this.engine.send("isready");
    });
  }

  async setOption(name: string, value: string | number): Promise<void> {
    const v = String(value);
    if (this.options.get(name) === v) return;
    this.options.set(name, v);
    await this.ready;
    this.engine.send(`setoption name ${name} value ${v}`);
  }

  async newGame(): Promise<void> {
    await this.ready;
    this.engine.send("ucinewgame");
    await this.isReady();
  }

  /** Search ``fen`` to ``depth``. ``searchmoves`` restricts the root moves. */
  async search(
    fen: string,
    depth: number,
    opts: { multipv?: number; searchmoves?: string[] } = {},
  ): Promise<SearchOutcome> {
    await this.setOption("MultiPV", opts.multipv ?? 1);
    await this.isReady();
    return new Promise((resolve) => {
      this.searching = { resolve, lines: new Map(), byDepth: new Map(), aborted: false };
      this.engine.send(`position fen ${fen}`);
      const sm = opts.searchmoves?.length ? ` searchmoves ${opts.searchmoves.join(" ")}` : "";
      this.engine.send(`go depth ${depth}${sm}`);
    });
  }

  /** Stop the running search; its promise resolves with ``aborted: true``. */
  stop(): void {
    if (this.searching) {
      this.searching.aborted = true;
      this.engine.send("stop");
    }
  }

  get busy(): boolean {
    return this.searching !== null;
  }

  terminate(): void {
    this.engine.terminate();
  }
}
