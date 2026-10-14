/**
 * Virtualized column-oriented table.
 *
 * Reproduces the Qt `QTableView` behaviour that matters for this domain:
 *   - rows are `No.N`, columns are the matrix columns (`Pos.N` or a file header),
 *   - the header row stays put while the body scrolls vertically,
 *   - only visible rows are rendered, which is what keeps a 100 000-row measurement
 *     file usable in a browser (the Qt build simply used QTableView's own viewport),
 *   - cells display `—` for missing values and use `%.6g`-equivalent formatting.
 *
 * The component reports its viewport element and per-column offsets so the connection
 * layer can anchor a line to a column header without touching the DOM itself.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { MatrixData } from '../../core/MatrixData.ts';
import { formatCell } from '../../core/numeric.ts';
import { invalidateLayout } from '../cardMetrics.ts';

const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 26;
const ROW_HEADER_WIDTH = 64;
const COLUMN_WIDTH = 118;
const OVERSCAN = 8;

export interface TableMetrics {
  tableViewport: HTMLDivElement | null;
  columnOffsets: number[];
  columnWidths: number[];
  headerHeight: number;
}

export interface VirtualTableProps {
  matrix: MatrixData;
  readOnly: boolean;
  /** Row-number label builder, e.g. `No.12`. */
  rowLabel: (rowIndex1Based: number) => string;
  /** Right-click on a column header. */
  onHeaderContextMenu?: (event: React.MouseEvent, columnIndex: number) => void;
  /** Click on a column header (used to select / highlight a column). */
  onHeaderClick?: (columnIndex: number) => void;
  highlightColumn?: number | null;
  onMetrics?: (metrics: TableMetrics) => void;
  /** Change a cell value in editable mode. */
  onCellChange?: (row: number, col: number, value: number) => void;
}

export function VirtualTable({
  matrix,
  readOnly,
  rowLabel,
  onHeaderContextMenu,
  onHeaderClick,
  highlightColumn = null,
  onMetrics,
  onCellChange,
}: VirtualTableProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(320);
  const [columnWidths, setColumnWidths] = useState<number[]>([]);
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);

  const rowCount = matrix.rowCount();
  const columnCount = matrix.columnCount();

  // Column widths: sized to the widest header label so `Pos.1` and long sensor
  // names both stay readable.
  const measuredWidths = useMemo(() => {
    const widths: number[] = [];
    for (let c = 0; c < columnCount; ++c) {
      const label = matrix.columnLabel(c);
      const approx = 24 + label.length * 7;
      widths.push(Math.min(240, Math.max(COLUMN_WIDTH, approx)));
    }
    return widths;
  }, [matrix, columnCount]);

  useLayoutEffect(() => {
    setColumnWidths(measuredWidths);
  }, [measuredWidths]);

  const offsets = useMemo(() => {
    const out: number[] = [];
    let acc = 0;
    for (let c = 0; c < columnWidths.length; ++c) {
      out.push(acc);
      acc += columnWidths[c];
    }
    return out;
  }, [columnWidths]);

  const totalWidth = useMemo(
    () => columnWidths.reduce((sum, w) => sum + w, 0),
    [columnWidths],
  );

  // Track the viewport size so the virtual window adapts to card resizing.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setViewportHeight(el.clientHeight);
    });
    observer.observe(el);
    setViewportHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  // Publish measurements upward so connection anchors stay in sync.
  useEffect(() => {
    if (!onMetrics) return;
    onMetrics({
      tableViewport: viewportRef.current,
      columnOffsets: offsets,
      columnWidths,
      headerHeight: HEADER_HEIGHT,
    });
  }, [onMetrics, offsets, columnWidths]);

  const handleScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    setScrollLeft(el.scrollLeft);
    setScrollTop(el.scrollTop);
    // The connection layer reads `viewport.scrollLeft` live (see cardMetrics.headerAnchor),
    // so a scrolled column moves its anchor — and may cross into or out of the viewport,
    // which is exactly when the line must snap to an edge. Nothing else bumps the layout
    // version on scroll: setTableMetrics only runs when offsets/widths change, and rows are
    // absolutely positioned so no resize fires. Without this the line drifts off its header
    // and stays stale until the next drag or resize.
    invalidateLayout();
  }, []);

  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const lastRow = Math.min(
    rowCount,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  );

  const visibleRows = [];
  for (let row = firstRow; row < lastRow; ++row) {
    visibleRows.push(row);
  }

  const gridTemplate = `${ROW_HEADER_WIDTH}px ${columnWidths.map((w) => `${w}px`).join(' ')}`;

  return (
    <div className="vtable">
      {/* Header row: pinned, scrolls horizontally with the body via scrollLeft. */}
      <div className="vtable__header" style={{ height: HEADER_HEIGHT }}>
        <div
          className="vtable__header-inner"
          style={{ transform: `translateX(-${scrollLeft}px)`, gridTemplateColumns: gridTemplate }}
        >
          <div className="vtable__corner" />
          {Array.from({ length: columnCount }, (_, c) => (
            <div
              key={c}
              className={`vtable__colhead${
                highlightColumn === c ? ' vtable__colhead--highlight' : ''
              }`}
              title={matrix.columnLabel(c) || matrix.column(c).posName}
              onClick={() => onHeaderClick?.(c)}
              onContextMenu={(event) => onHeaderContextMenu?.(event, c)}
            >
              {matrix.columnLabel(c) || matrix.column(c).posName}
            </div>
          ))}
        </div>
      </div>

      {/* Body: single scroll container; rows are absolutely positioned inside. */}
      <div className="vtable__viewport" ref={viewportRef} onScroll={handleScroll}>
        <div
          className="vtable__canvas"
          style={{ height: rowCount * ROW_HEIGHT, width: ROW_HEADER_WIDTH + totalWidth }}
        >
          {visibleRows.map((row) => (
            <div
              key={row}
              className={`vtable__row${row % 2 === 1 ? ' vtable__row--odd' : ''}`}
              style={{
                top: row * ROW_HEIGHT,
                height: ROW_HEIGHT,
                gridTemplateColumns: gridTemplate,
                transform: `translateX(-${scrollLeft}px)`,
                width: ROW_HEADER_WIDTH + totalWidth,
              }}
            >
              <div className="vtable__rowhead">{rowLabel(row + 1)}</div>
              {Array.from({ length: columnCount }, (_, c) => {
                const value = matrix.cell(row, c);
                const isEditing = editing?.row === row && editing?.col === c;
                if (isEditing && !readOnly) {
                  return (
                    <input
                      key={c}
                      className="vtable__input"
                      defaultValue={Number.isNaN(value) ? '' : String(value)}
                      autoFocus
                      onBlur={(event) => {
                        const parsed = Number(event.target.value);
                        if (!Number.isNaN(parsed)) onCellChange?.(row, c, parsed);
                        setEditing(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                        if (event.key === 'Escape') setEditing(null);
                      }}
                    />
                  );
                }
                return (
                  <div
                    key={c}
                    className="vtable__cell"
                    onDoubleClick={() => {
                      if (!readOnly) setEditing({ row, col: c });
                    }}
                  >
                    {formatCell(value)}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export { HEADER_HEIGHT, ROW_HEIGHT, ROW_HEADER_WIDTH, COLUMN_WIDTH };
