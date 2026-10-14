/**
 * MatrixData behaviour — parity with `src/core/MatrixData.cpp`.
 */
import { describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';

function build(): MatrixData {
  const mat = new MatrixData();
  mat.appendColumn('Pos.1', [1, 2, 3]);
  mat.appendColumn('Pos.2', [4, 5]);
  return mat;
}

describe('MatrixData', () => {
  it('reports counts and the longest column as rowCount', () => {
    const mat = build();
    expect(mat.columnCount()).toBe(2);
    expect(mat.rowCount()).toBe(3);
  });

  it('returns NaN for out-of-range cells (matches the C++ original)', () => {
    const mat = build();
    expect(mat.cell(0, 0)).toBe(1);
    expect(mat.cell(2, 1)).toBeNaN();
    expect(mat.cell(-1, 0)).toBeNaN();
    expect(mat.cell(0, 5)).toBeNaN();
    expect(mat.cell(0, -1)).toBeNaN();
  });

  it('ignores out-of-range writes', () => {
    const mat = build();
    mat.setCell(0, 0, 42);
    expect(mat.cell(0, 0)).toBe(42);

    mat.setCell(99, 0, 7);
    mat.setCell(0, 99, 7);
    expect(mat.cell(99, 0)).toBeNaN();
  });

  it('sets and reads annotations, ignoring invalid indexes', () => {
    const mat = build();
    mat.setColumnAnnotation(1, '温度');
    expect(mat.column(1).annotation).toBe('温度');
    expect(mat.columnLabel(1)).toBe('温度');

    // No annotation -> the position name is the label, as in QTableView headers.
    expect(mat.columnLabel(0)).toBe('Pos.1');

    mat.setColumnAnnotation(9, 'nope');
    mat.setColumnAnnotation(-1, 'nope');
    expect(mat.column(1).annotation).toBe('温度');
  });

  it('clones deeply so mutations do not leak back', () => {
    const mat = build();
    mat.setColumnAnnotation(0, 'a');
    const copy = mat.clone();

    copy.setCell(0, 0, 999);
    copy.setColumnAnnotation(0, 'changed');

    expect(mat.cell(0, 0)).toBe(1);
    expect(mat.column(0).annotation).toBe('a');
    expect(copy.cell(0, 0)).toBe(999);
  });

  it('clears every column', () => {
    const mat = build();
    mat.clear();
    expect(mat.isEmpty()).toBe(true);
    expect(mat.rowCount()).toBe(0);
  });
});
