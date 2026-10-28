/**
 * Pure integer dependency graph — TypeScript port of `src/core/DependencyGraph.cpp`.
 *
 * Direction: `dependent` depends on `dependsOn`. Internally the map is stored as
 * `dependsOn -> { dependent -> ports }`, which makes "who must be closed first?" and
 * "what must be refreshed when this changes?" both O(1) lookups.
 *
 * Three guarantees the C++ original did not provide, added because the roadmap now
 * includes FunctionCard (which introduces card -> card -> card chains):
 *   1. edges are deduplicated — registering the same relation twice does not make
 *      `getDependents` return the same id twice;
 *   2. the graph stays acyclic — an edge that would close a loop is refused rather
 *      than silently corrupting the close-protection rule;
 *   3. an edge remembers **which ports** carry it (2026-10-28). The pair
 *      (dependent, dependsOn) is still one edge — one line on the canvas — but the
 *      port ids on the dependent side are kept, because `portId` is the identity the
 *      port-semantics spec locks in and the connection layer anchors on it. The set
 *      is what keeps "a chart reading three columns of one table" from becoming
 *      three lines.
 */

/** A cycle path, outermost node first: `a -> b -> a`. */
export type CyclePath = number[];

/** One dependency edge: the card pair plus the port ids recorded on the dependent side. */
export interface DependencyEdge {
  dependsOn: number;
  dependent: number;
  /** Target-side port ids, sorted for determinism. Empty when the edge was unnamed. */
  ports: string[];
}

export class DependencyGraph {
  /** dependsOn -> (dependent -> set of port ids). A Set keeps the edge set free of duplicates. */
  private m_dependents = new Map<number, Map<number, Set<string>>>();

  /**
   * Register "`dependentId` depends on `dependsOnId`" through `portId` (optional).
   *
   * Returns `null` when the edge was accepted (including when it already existed),
   * or the offending cycle path when adding it would create a loop — in that case
   * **nothing is mutated** and the caller can surface the refusal to the user.
   *
   * Registering the same card pair again with a different `portId` adds a port to the
   * existing edge; it never creates a second one. Self-dependency (`a -> a`) is just the
   * shortest possible cycle.
   */
  addDependency(
    dependentId: number,
    dependsOnId: number,
    portId?: string | readonly string[],
  ): CyclePath | null {
    // Follow the *dependency* direction from `dependsOnId`: if it already sits on top
    // of `dependentId`, then making `dependentId` depend on it closes a loop.
    const downstream = this.findDownstreamPath(dependsOnId, dependentId);
    if (downstream) {
      // Report the loop as a ring that starts and ends at the same card, so callers can
      // show it directly: `1 -> 2 -> 3 -> 4 -> 1`.
      return [...downstream, dependsOnId];
    }

    let list = this.m_dependents.get(dependsOnId);
    if (!list) {
      list = new Map<number, Set<string>>();
      this.m_dependents.set(dependsOnId, list);
    }
    let ports = list.get(dependentId);
    if (!ports) {
      ports = new Set<string>();
      list.set(dependentId, ports);
    }
    if (portId !== undefined) {
      for (const id of typeof portId === 'string' ? [portId] : portId) ports.add(id);
    }
    return null;
  }

  /**
   * Unregister "`dependentId` depends on `dependsOnId`" — the inverse of
   * `addDependency`.
   *
   * With `portId`, only that port leaves the edge; the edge itself survives while other
   * ports still name it. Without `portId` (or with the last remaining port), the whole
   * edge goes. A no-op when the edge does not exist: nothing is mutated and nothing
   * thrown. When the last dependent of `dependsOnId` goes, the map key itself is dropped,
   * so `hasDependents` reports `false` again for a node nobody reads.
   */
  removeDependency(dependentId: number, dependsOnId: number, portId?: string): void {
    const deps = this.m_dependents.get(dependsOnId);
    if (!deps) return;
    const ports = deps.get(dependentId);
    if (ports && portId !== undefined) {
      ports.delete(portId);
      if (ports.size > 0) return;
    }
    deps.delete(dependentId);
    if (deps.size === 0) this.m_dependents.delete(dependsOnId);
  }

  removeAllDependencies(cardId: number): void {
    // cardId as the depended-on target
    this.m_dependents.delete(cardId);

    // cardId as the dependent (in someone else's list)
    for (const [key, deps] of this.m_dependents) {
      deps.delete(cardId);
      if (deps.size === 0) this.m_dependents.delete(key);
    }
  }

  getDependents(cardId: number): number[] {
    const deps = this.m_dependents.get(cardId);
    return deps ? [...deps.keys()] : [];
  }

  hasDependents(cardId: number): boolean {
    const deps = this.m_dependents.get(cardId);
    return deps !== undefined && deps.size > 0;
  }

  /**
   * Port ids recorded for one edge, sorted. Empty when the edge exists unnamed — the
   * caller must then fall back to a card-level anchor instead of inventing a port.
   */
  getPorts(dependentId: number, dependsOnId: number): string[] {
    const ports = this.m_dependents.get(dependsOnId)?.get(dependentId);
    return ports ? [...ports].sort() : [];
  }

  /** Direct dependencies of `cardId` (the cards it itself depends on). */
  getDependencies(cardId: number): number[] {
    const out: number[] = [];
    for (const [dependsOn, deps] of this.m_dependents) {
      if (deps.has(cardId)) out.push(dependsOn);
    }
    return out;
  }

  clear(): void {
    this.m_dependents.clear();
  }

  /** Number of distinct edges currently registered. */
  edgeCount(): number {
    let total = 0;
    for (const deps of this.m_dependents.values()) total += deps.size;
    return total;
  }

  /** Snapshot of every edge, for debugging and tests. */
  edges(): DependencyEdge[] {
    const out: DependencyEdge[] = [];
    for (const [dependsOn, deps] of this.m_dependents) {
      for (const [dependent, ports] of deps) {
        out.push({ dependsOn, dependent, ports: [...ports].sort() });
      }
    }
    return out;
  }

  /**
   * Breadth-first search over the dependent direction from `from` to `to`.
   * Returns the path (inclusive of both ends) or `null` when unreachable.
   */
  findPath(from: number, to: number): CyclePath | null {
    if (from === to) return [from];
    const previous = new Map<number, number>();
    const queue: number[] = [from];
    const seen = new Set<number>([from]);

    while (queue.length > 0) {
      const current = queue.shift() as number;
      for (const next of this.m_dependents.get(current)?.keys() ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        previous.set(next, current);
        if (next === to) return reconstruct(previous, from, to);
        queue.push(next);
      }
    }
    return null;
  }

  /**
   * Breadth-first search over the *dependency* direction — "what does this node sit
   * on top of, transitively?". Used by `addDependency` to detect loops.
   */
  findDownstreamPath(from: number, to: number): CyclePath | null {
    if (from === to) return [from];
    const previous = new Map<number, number>();
    const queue: number[] = [from];
    const seen = new Set<number>([from]);

    while (queue.length > 0) {
      const current = queue.shift() as number;
      for (const next of this.getDependencies(current)) {
        if (seen.has(next)) continue;
        seen.add(next);
        previous.set(next, current);
        if (next === to) return reconstruct(previous, from, to);
        queue.push(next);
      }
    }
    return null;
  }

  /** True when the graph contains at least one cycle. Cannot happen via addDependency. */
  hasCycle(): boolean {
    const state = new Map<number, 0 | 1 | 2>(); // 0 visiting, 1 done
    const visit = (node: number): boolean => {
      const mark = state.get(node);
      if (mark === 0) return true;
      if (mark === 1) return false;
      state.set(node, 0);
      for (const next of this.m_dependents.get(node)?.keys() ?? []) {
        if (visit(next)) return true;
      }
      state.set(node, 1);
      return false;
    };
    for (const node of this.nodes()) {
      if (visit(node)) return true;
    }
    return false;
  }

  /** Every node mentioned anywhere in the graph. */
  nodes(): number[] {
    const all = new Set<number>();
    for (const [dependsOn, deps] of this.m_dependents) {
      all.add(dependsOn);
      for (const dependent of deps.keys()) all.add(dependent);
    }
    return [...all];
  }
}

function reconstruct(previous: Map<number, number>, from: number, to: number): number[] {
  const path: number[] = [to];
  let cursor = to;
  while (cursor !== from) {
    const parent = previous.get(cursor);
    if (parent === undefined) break;
    path.push(parent);
    cursor = parent;
  }
  return path.reverse();
}
