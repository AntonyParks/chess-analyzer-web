/** The depth trace of the shown position, run on the second (cold) engine for the human eval. */
import { useEffect, useState } from "react";
import { epd } from "../core/chess";
import { Kind, type TracePoint } from "../engine/scheduler";
import { useEngines } from "./engine";

export function useDepthTrace(fen: string, depth: number, enabled = true): TracePoint[] | null {
  const { main, ladder } = useEngines();
  const [got, setGot] = useState<{ epd: string; depth: number; trace: TracePoint[] } | null>(null);
  useEffect(() => {
    if (!enabled || !main) return;
    const engine = ladder();
    const id = engine.submit({
      kind: Kind.HEATMAP,
      fen,
      moves: [],
      depth,
      trace: true,
      onDone: (r) => {
        if (r.complete && r.trace) setGot({ epd: r.epd, depth, trace: r.trace });
      },
    });
    return () => engine.cancel(id);
  }, [fen, depth, enabled, main, ladder]);
  return got && got.epd === epd(fen) && got.depth === depth ? got.trace : null;
}
