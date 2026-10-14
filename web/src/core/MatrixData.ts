/**
 * Column-oriented matrix data model — TypeScript port of `src/core/MatrixData.h`.
 *
 * Each column is a named vector of doubles. Column names are `Pos.1, Pos.2, ...`
 * (1-based, for display); an optional `annotation` is a human-readable note such as
 * a header captured from the source file.
 *
 * The class is deliberately framework-free: it knows nothing about React, the DOM,
 * or the card layer. Every frontend (and every importer/exporter) works against this
 * type, mirroring the role `core/` plays in the C++ tree.
 */

export interface MatrixColumn {
  /** Display name, e.g. `Pos.1`. */
  posName: string;
  /** Human-readable note, e.g. `temp sensor A`. May be empty. */
  annotation: string;
  /** Column values, top to bottom. */
  data: number[];
}

export class MatrixData {
  private m_columns: MatrixColumn[] = [];

  // ── Column operations ────────────────────────────────────────────────

  columnCount(): number {
    return this.m_columns.length;
  }

  /** Row count = length of the longest column (columns may be ragged). */
  rowCount(): number {
    let maxRows = 0;
    for (const col of this.m_columns) {
      if (col.data.length > maxRows) maxRows = col.data.length;
    }
    return maxRows;
  }

  column(index: number): MatrixColumn {
    return this.m_columns[index];
  }

  columns(): readonly MatrixColumn[] {
    return this.m_columns;
  }

  appendColumn(posName: string, data: number[]): void {
    this.m_columns.push({ posName, annotation: '', data });
  }

  setColumnAnnotation(index: number, anno: string): void {
    if (index >= 0 && index < this.m_columns.length) {
      this.m_columns[index].annotation = anno;
    }
  }

  // ── Data access ──────────────────────────────────────────────────────

  /** Cell value; `NaN` when out of range (matches the C++ original). */
  cell(row: number, col: number): number {
    if (col < 0 || col >= this.m_columns.length) return NaN;
    const d = this.m_columns[col].data;
    if (row < 0 || row >= d.length) return NaN;
    return d[row];
  }

  setCell(row: number, col: number, value: number): void {
    if (col < 0 || col >= this.m_columns.length) return;
    const d = this.m_columns[col].data;
    if (row < 0 || row >= d.length) return;
    d[row] = value;
  }

  /** The label shown in headers and chart titles: annotation wins, else `posName`. */
  columnLabel(index: number): string {
    const col = this.m_columns[index];
    if (!col) return '';
    return col.annotation !== '' ? col.annotation : col.posName;
  }

  // ── Bulk setup ───────────────────────────────────────────────────────

  clear(): void {
    this.m_columns = [];
  }

  isEmpty(): boolean {
    return this.m_columns.length === 0;
  }

  /** Deep copy — used when a card caches a parsed matrix per file. */
  clone(): MatrixData {
    const copy = new MatrixData();
    for (const col of this.m_columns) {
      copy.appendColumn(col.posName, col.data.slice());
      copy.setColumnAnnotation(copy.columnCount() - 1, col.annotation);
    }
    return copy;
  }
}
