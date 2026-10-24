/**
 * Pure integer dependency graph — TypeScript port of `src/core/DependencyGraph.cpp`.
 *
 * Direction: `dependent` depends on `dependsOn`. Internally the map is stored as
 * `dependsOn -> [dependents]`, which makes "who must be closed first?" and
 * "what must be refreshed when this changes?" both O(1) lookups.
 *
 * Two guarantees the C++ original did not provide, added because the roadmap now
 * includes FunctionCard (which introduces card -> card -> card chains):
 *   1. edges are deduplicated — registering the same relation twice does not make
 *      `getDependents` return the same id twice;
 *   2. the graph stays acyclic — an edge that would close a loop is refused rather
 *      than silently corrupting the close-protection rule.
 */

/** A cycle path, outermost node first: `a -> b -> a`. */
export type CyclePath = number[];

export class DependencyGraph {
  /** dependsOn -> set of dependents. A Set keeps the edge set free of duplicates. */
  private m_dependents = new Map<number, Set<number>>();

  /**
   * Register "`dependentId` depends on `dependsOnId`".
   *
   * Returns `null` when the edge was accepted (including when it already existed),
   * or the offending cycle path when adding it would create a loop — in that case
   * **nothing is mutated** and the caller can surface the refusal to the user.
   *
   * Self-dependency (`a -> a`) is just the shortest possible cycle.
   */
  addDependency(dependentId: number, dependsOnId: number): CyclePath | null {
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
      list = new Set<number>();
      this.m_dependents.set(dependsOnId, list);
    }
    list.add(dependentId);
    return null;
  }

  /**
   * Unregister "`dependentId` depends on `dependsOnId`" — the inverse of
   * `addDependency`.
   *
   * A no-op when the edge does not exist: nothing is mutated and nothing thrown. When
   * the last dependent of `dependsOnId` goes, the map key itself is dropped, so
   * `hasDependents` reports `false` again for a node nobody reads.
   */
  removeDependency(dependentId: number, dependsOnId: number): void {
    const deps = this.m_dependents.get(dependsOnId);
    if (!deps) return;
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
    return deps ? [...deps] : [];
  }

  hasDependents(cardId: number): boolean {
    const deps = this.m_dependents.get(cardId);
    return deps !== undefined && deps.size > 0;
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
  edges(): Array<{ dependsOn: number; dependent: number }> {
    const out: Array<{ dependsOn: number; dependent: number }> = [];
    for (const [dependsOn, deps] of this.m_dependents) {
      for (const dependent of deps) out.push({ dependsOn, dependent });
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
      for (const next of this.m_dependents.get(current) ?? []) {
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
      for (const next of this.m_dependents.get(node) ?? []) {
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
      for (const dependent of deps) all.add(dependent);
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
