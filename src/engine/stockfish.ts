/** The Stockfish WASM build (lite, single-threaded: no special server headers needed). */
import type { UciEngine } from "./uci";

export const STOCKFISH_URL = `${import.meta.env.BASE_URL}stockfish/stockfish-17.1-lite-single-03e3232.js`;

export function createStockfish(): UciEngine {
  const worker = new Worker(STOCKFISH_URL);
  const listeners: ((line: string) => void)[] = [];
  worker.onmessage = (e: MessageEvent) => {
    const text = typeof e.data === "string" ? e.data : String(e.data);
    for (const line of text.split("\n")) if (line) listeners.forEach((l) => l(line));
  };
  return {
    send: (cmd) => worker.postMessage(cmd),
    onLine: (l) => listeners.push(l),
    terminate: () => worker.terminate(),
  };
}
