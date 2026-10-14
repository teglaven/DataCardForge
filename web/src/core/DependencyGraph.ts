/**
 * Pure integer dependency graph — TypeScript port of `src/core/DependencyGraph.cpp`.
 *
 * Direction: `dependent` depends on `dependsOn`. Internally the map is stored as
 * `dependsOn -> [dependents]`, which makes "who must be closed first?" and
 * "what must be refreshed when this changes?" both O(1) lookups.
 */
export class DependencyGraph {
  private m_dependents = new Map<number, number[]>();

  addDependency(dependentId: number, dependsOnId: number): void {
    const list = this.m_dependents.get(dependsOnId);
    if (list) list.push(dependentId);
    else this.m_dependents.set(dependsOnId, [dependentId]);
  }

  removeAllDependencies(cardId: number): void {
    // cardId as the depended-on target
    this.m_dependents.delete(cardId);

    // cardId as the dependent (in someone else's list)
    for (const [key, deps] of this.m_dependents) {
      const filtered = deps.filter((id) => id !== cardId);
      if (filtered.length === 0) this.m_dependents.delete(key);
      else if (filtered.length !== deps.length) this.m_dependents.set(key, filtered);
    }
  }

  getDependents(cardId: number): number[] {
    return this.m_dependents.get(cardId)?.slice() ?? [];
  }

  hasDependents(cardId: number): boolean {
    const deps = this.m_dependents.get(cardId);
    return deps !== undefined && deps.length > 0;
  }

  clear(): void {
    this.m_dependents.clear();
  }

  /** Snapshot of every edge, for debugging and tests. */
  edges(): Array<{ dependsOn: number; dependent: number }> {
    const out: Array<{ dependsOn: number; dependent: number }> = [];
    for (const [dependsOn, deps] of this.m_dependents) {
      for (const dependent of deps) out.push({ dependsOn, dependent });
    }
    return out;
  }
}
