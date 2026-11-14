/**
 * The repertoire as a sunburst: a tree from the start position where each move's share of its
 * parent is how often that move is played there (Lichess counts at the opponent's positions;
 * your own move always takes the whole of its parent). Angles therefore show how often a line
 * comes up in real games.
 *
 * The repertoire is a graph (move orders that meet share a position), but a sunburst is a tree:
 * a position is expanded once, where it is reached by the shortest path, and every other way of
 * reaching it ends in a "joins" leaf.
 */
import { ROOT_EPD, afterEpd, fenFromEpd, sanOf } from "./chess";
import { DEFAULT_COVERAGE, type Repertoire } from "./repertoire";

export type MapKind =
  | "root" // the start position
  | "you" // your repertoire move
  | "opp" // an opponent reply you have prepared
  | "gap" // an opponent reply you have not prepared, common enough to matter
  | "rare"; // all the opponent's rarer unprepared replies, in one wedge

export interface MapNode {
  id: string; // the UCI path joined by spaces ("" for the root)
  kind: MapKind;
  path: string[]; // UCI moves from the start ([] for root and "rare")
  uci: string | null;
  san: string;
  epd: string; // the position after this move
  parentEpd: string; // the position the move is played from
  share: number; // of the parent, 0..1
  chance: number; // of all games, 0..1
  depth: number; // 0 for the root
  /** Reached here by another move order; its moves are drawn where it is reached first. */
  joins: string[] | null;
  /** A prepared reply with no answer of yours after it yet. */
  open: boolean;
  /** Shares here are a guess (no Lichess counts for the parent position yet). */
  estimated: boolean;
  /** Where this wedge sits on the circle (fractions of a turn), set by layout. */
  a0: number;
  a1: number;
  children: MapNode[];
}

export interface MapSummary {
  prepared: number; // chance of staying in your preparation to the end of a line
  gaps: number; // chance of reaching a common reply you have not prepared (or not answered)
  rare: number; // chance of a rarer reply you have chosen not to cover
  maxDepth: number;
}

const MAX_DEPTH = 40;

export function buildMap(rep: Repertoire, coverage: number = DEFAULT_COVERAGE): { root: MapNode; summary: MapSummary } {
  const threshold = 1 / Math.max(1, coverage);
  const root: MapNode = node("root", [], null, "Start", ROOT_EPD, 1, 1, 0);
  const expanded = new Set<string>([ROOT_EPD]);
  const summary: MapSummary = { prepared: 0, gaps: 0, rare: 0, maxDepth: 0 };
  // Breadth first, so each position is expanded at its shortest move order.
  const queue: MapNode[] = [root];
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i];
    summary.maxDepth = Math.max(summary.maxDepth, parent.depth);
    if (parent.kind === "gap" || parent.kind === "rare") continue;
    if (parent.joins || parent.depth >= MAX_DEPTH) {
      summary.prepared += parent.chance;
      continue;
    }
    const kids = childrenOf(rep, parent, threshold);
    if (!kids.length) {
      if (parent.kind === "root") continue; // an empty repertoire
      parent.open = parent.kind === "opp";
      if (parent.open) summary.gaps += parent.chance;
      else summary.prepared += parent.chance;
      continue;
    }
    for (const k of kids) {
      if (k.kind === "gap") summary.gaps += k.chance;
      else if (k.kind === "rare") summary.rare += k.chance;
      else if (expanded.has(k.epd)) k.joins = rep.pathTo(k.epd);
      else expanded.add(k.epd);
      queue.push(k);
    }
    parent.children = kids;
  }
  layout(root, 0, 1);
  return { root, summary };
}

function childrenOf(rep: Repertoire, parent: MapNode, threshold: number): MapNode[] {
  const e = parent.epd;
  const fen = fenFromEpd(e);
  const at = (uci: string, kind: MapKind, share: number): MapNode => {
    const after = afterEpd(e, uci) ?? e;
    const k = node(kind, [...parent.path, uci], uci, safeSan(fen, uci), after, share, parent.chance * share, parent.depth + 1);
    k.parentEpd = e;
    return k;
  };
  if (rep.userToMove(e)) {
    const mine = rep.userMove(e);
    return mine ? [at(mine, "you", 1)] : [];
  }
  const prepared = [...rep.movesAt(e).keys()];
  // No reply prepared here: your line ends with your move (as "Go to biggest gap" sees it).
  if (!prepared.length) return [];
  const stats = rep.stats.get(e);
  if (!stats || stats.total <= 0) {
    // No counts yet: split evenly between the prepared replies.
    const kids = prepared.map((u) => at(u, "opp", 1 / prepared.length));
    kids.forEach((k) => (k.estimated = true));
    return kids;
  }
  const out: MapNode[] = [];
  let listed = 0;
  let rare = 0;
  const ranked = [...stats.moves].sort((a, b) => b[1][1] - a[1][1]);
  for (const [uci, [, games]] of ranked) {
    const share = games / stats.total;
    listed += share;
    if (prepared.includes(uci)) out.push(at(uci, "opp", share));
    else if (parent.chance * share >= threshold) out.push(at(uci, "gap", share));
    else rare += share;
  }
  // Prepared replies Lichess has no games for still get a sliver, so every line shows.
  for (const uci of prepared) if (!stats.moves.has(uci)) out.push(at(uci, "opp", 0));
  rare += Math.max(0, 1 - listed);
  if (rare > 1e-6) {
    const r = node("rare", [...parent.path], null, "Rarer replies", e, rare, parent.chance * rare, parent.depth + 1);
    r.id = `${parent.id}|rare`;
    r.parentEpd = e;
    out.push(r);
  }
  return out;
}

/** Give each node its arc; the parent's arc is shared in proportion to the children's shares. */
function layout(n: MapNode, a0: number, a1: number): void {
  n.a0 = a0;
  n.a1 = a1;
  const total = n.children.reduce((s, k) => s + k.share, 0);
  if (total <= 0) {
    // Only zero-count replies: split the arc evenly.
    const step = (a1 - a0) / Math.max(1, n.children.length);
    n.children.forEach((k, i) => layout(k, a0 + i * step, a0 + (i + 1) * step));
    return;
  }
  const scale = (a1 - a0) / Math.max(1, total);
  let a = a0;
  for (const k of n.children) {
    const w = k.share * scale;
    layout(k, a, a + w);
    a += w;
  }
}

function node(kind: MapKind, path: string[], uci: string | null, san: string, epd: string, share: number, chance: number, depth: number): MapNode {
  return { id: path.join(" "), kind, path, uci, san, epd, parentEpd: "", share, chance, depth, joins: null, open: false, estimated: false, a0: 0, a1: 0, children: [] };
}

function safeSan(fen: string, uci: string): string {
  try {
    return sanOf(fen, uci);
  } catch {
    return uci;
  }
}

/** The node with this id (null when it has gone, e.g. after an edit). */
export function findNode(root: MapNode, id: string): MapNode | null {
  return ancestryOf(root, id)?.at(-1) ?? null;
}

/** The nodes from the root down to the one with this id (null if there is none). */
export function ancestryOf(root: MapNode, id: string): MapNode[] | null {
  const trail: MapNode[] = [];
  const walk = (cur: MapNode): boolean => {
    trail.push(cur);
    if (cur.id === id) return true;
    for (const k of cur.children) if (walk(k)) return true;
    trail.pop();
    return false;
  };
  return walk(root) ? trail : null;
}
