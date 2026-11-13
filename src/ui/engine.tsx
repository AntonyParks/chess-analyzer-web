/**
 * The engines, shared by every page: a main Stockfish for the board, review and scans, and a
 * cold one (small hash, cleared before each search) for the puzzle lookahead ladder, started
 * only when a scan needs it.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { EngineScheduler } from "../engine/scheduler";
import { createStockfish } from "../engine/stockfish";

export interface Engines {
  main: EngineScheduler | null;
  ladder: () => EngineScheduler;
  error: string | null;
}

const EngineContext = createContext<Engines>({
  main: null,
  ladder: () => {
    throw new Error("no engine");
  },
  error: null,
});

export function EngineProvider({ children }: { children: ReactNode }) {
  const [main, setMain] = useState<EngineScheduler | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ladderRef] = useState<{ current: EngineScheduler | null }>({ current: null });

  useEffect(() => {
    let scheduler: EngineScheduler | null = null;
    try {
      scheduler = new EngineScheduler(createStockfish(), { hashMb: 64 });
      setMain(scheduler);
    } catch (err) {
      setError(`Stockfish could not start: ${String(err)}`);
    }
    return () => {
      scheduler?.shutdown();
      ladderRef.current?.shutdown();
      ladderRef.current = null;
    };
  }, [ladderRef]);

  const value = useMemo<Engines>(
    () => ({
      main,
      error,
      ladder: () => {
        if (!ladderRef.current) ladderRef.current = new EngineScheduler(createStockfish(), { hashMb: 16 });
        return ladderRef.current;
      },
    }),
    [main, error, ladderRef],
  );
  return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>;
}

export function useEngines(): Engines {
  return useContext(EngineContext);
}
