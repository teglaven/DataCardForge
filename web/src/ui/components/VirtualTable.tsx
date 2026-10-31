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
 * Connection lines are card-level (see ConnectionLayer), so the table no longer reports
 * column-header geometry; the header highlight only marks columns that feed a chart.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { MatrixData } from '../../core/MatrixData.ts';
import { formatCell, isNumeric, parseNumeric } from '../../core/numeric.ts';

const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 26;
const ROW_HEADER_WIDTH = 64;
const COLUMN_WIDTH = 118;
/** User-draggable bounds: below 48 a number is unreadable, above 600 it stops being a table. */
const MIN_COLUMN_WIDTH = 48;
const MAX_COLUMN_WIDTH = 600;
const OVERSCAN = 8;

export interface VirtualTableProps {
  matrix: MatrixData;
  readOnly: boolean;
  /** Row-number label builder, e.g. `No.12`. */
  rowLabel: (rowIndex1Based: number) => string;
  /**
   * Optional display override for a column header (the stored label stays authoritative).
   *
   * Used by cards whose header must say what the column *means* in context — the relation
   * card shows the statistic's readable name here (the pair it belongs to lives on the row
   * axis, see `columnTitle`).
   */
  columnLabel?: (columnIndex: number) => string | null;
  /** Tooltip for a column header (defaults to what the header prints). */
  columnTitle?: (columnIndex: number) => string | null;
  /** Width of the row-number column. Cards can widen it when the row axis carries a name. */
  rowHeaderWidth?: number;
  /** Right-click on a column header. */
  onHeaderContextMenu?: (event: React.MouseEvent, columnIndex: number) => void;
  /** Click on a column header (used to select / highlight a column). */
  onHeaderClick?: (columnIndex: number) => void;
  highlightColumn?: number | null;
  /** Columns of this table that feed the currently selected chart. */
  sourceColumns?: readonly number[];
  /** Change a cell value in editable mode. */
  onCellChange?: (row: number, col: number, value: number) => void;
  /** Called with the raw text when an edit cannot be read as a number. */
  onInvalidEdit?: (raw: string) => void;
}

export function VirtualTable({
  matrix,
  readOnly,
  rowLabel,
  columnLabel,
  columnTitle,
  rowHeaderWidth = ROW_HEADER_WIDTH,
  onHeaderContextMenu,
  onHeaderClick,
  highlightColumn = null,
  sourceColumns = [],
  onCellChange,
  onInvalidEdit,
}: VirtualTableProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(320);
  const [columnWidths, setColumnWidths] = useState<number[]>([]);
  /**
   * Manual widths (drag the right edge of a header). Distances only change through a drag,
   * so these are kept apart from the measured default: a table whose labels change (a
   * re-bound port, a new result) still keeps the width the user chose.
   */
  const [userWidths, setUserWidths] = useState<Record<number, number>>({});
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
  /** Set by Escape so the unmounting input's `blur` does not commit the abandoned text. */
  const abandonedRef = useRef(false);

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

  // A different table means different columns: widths measured for the old one would be a
  // lie about the new one.
  useEffect(() => {
    setUserWidths({});
  }, [matrix, columnCount]);

  /** Width actually used: the user's drag wins over the measured default. */
  const effectiveWidths = useMemo(
    () => columnWidths.map((width, c) => userWidths[c] ?? width),
    [columnWidths, userWidths],
  );

  const totalWidth = useMemo(
    () => effectiveWidths.reduce((sum, width) => sum + width, 0),
    [effectiveWidths],
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

  const handleScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    setScrollLeft(el.scrollLeft);
    setScrollTop(el.scrollTop);
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

  /**
   * Commit an edit.
   *
   * The parse is the same strict grammar the display side uses (`parseNumeric`), not
   * `Number()`: `Number('')` is 0, `Number('0x10')` is 16 and `Number('Infinity')` is
   * Infinity — so clearing a field used to write a real zero and typing a hex literal or
   * "Infinity" stored a value that silently poisoned every statistic downstream.
   * An empty field means "missing" (NaN); anything else that is not a number is reported
   * instead of being dropped without explanation.
   */
  const commit = (row: number, col: number, raw: string) => {
    const text = raw.trim();
    if (text === '') {
      onCellChange?.(row, col, NaN);
      return;
    }
    if (!isNumeric(text)) {
      onInvalidEdit?.(text);
      return;
    }
    onCellChange?.(row, col, parseNumeric(text));
  };

  const gridTemplate = `${rowHeaderWidth}px ${effectiveWidths
    .map((width) => `${width}px`)
    .join(' ')}`;
  const sourceSet = new Set(sourceColumns);
  /** Header text: an override (card-specific meaning) wins over the stored label. */
  const headerLabel = (c: number) =>
    columnLabel?.(c) ?? (matrix.columnLabel(c) || matrix.column(c).posName);
  /** Header tooltip: the override's full sentence when there is one, else the label. */
  const headerTitle = (c: number) => columnTitle?.(c) ?? headerLabel(c);

  /**
   * Drag the right edge of a header to resize that column.
   *
   * The width is a view preference, not data: it lives in this component and deliberately
   * does not touch the matrix or the store. Listeners are attached to the window so a fast
   * drag that leaves the 6 px handle still tracks the pointer.
   */
  const dragRef = useRef<{ column: number; startX: number; startWidth: number } | null>(null);
  const beginResize = (event: React.MouseEvent, column: number) => {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { column, startX: event.clientX, startWidth: effectiveWidths[column] };
    const onMove = (move: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const next = Math.max(
        MIN_COLUMN_WIDTH,
        Math.min(MAX_COLUMN_WIDTH, drag.startWidth + move.clientX - drag.startX),
      );
      setUserWidths((previous) => ({ ...previous, [drag.column]: next }));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="vtable">
      {/* Header row: pinned, scrolls horizontally with the body via scrollLeft. */}
      <div className="vtable__header" style={{ height: HEADER_HEIGHT }}>
        <div
          className="vtable__header-inner"
          style={{
            transform: `translateX(-${scrollLeft}px)`,
            gridTemplateColumns: gridTemplate,
            width: rowHeaderWidth + totalWidth,
          }}
        >
          <div className="vtable__corner" />
          {Array.from({ length: columnCount }, (_, c) => (
            <div
              key={c}
              className={`vtable__colhead${
                highlightColumn === c ? ' vtable__colhead--highlight' : ''
              }${sourceSet.has(c) ? ' vtable__colhead--source' : ''}`}
              title={headerTitle(c)}
              onClick={() => onHeaderClick?.(c)}
              onContextMenu={(event) => onHeaderContextMenu?.(event, c)}
            >
              {/* A real box: `text-overflow` cannot act on an anonymous flex item. */}
              <span className="vtable__colhead-label">{headerLabel(c)}</span>
              {/* Drag the right edge to widen/narrow the column. The handler stops
                  propagation so a resize never also selects the column. */}
              <span
                className="vtable__colresize"
                aria-hidden
                onMouseDown={(event) => beginResize(event, c)}
              />
            </div>
          ))}
        </div>
      </div>
      {/* Body: single scroll container; rows are absolutely positioned inside. */}
      <div className="vtable__viewport" ref={viewportRef} onScroll={handleScroll}>
        <div
          className="vtable__canvas"
          style={{ height: rowCount * ROW_HEIGHT, width: rowHeaderWidth + totalWidth }}
        >
          {/* Rows are NOT translated: `.vtable__viewport` scrolls natively, so the browser
              already moves this canvas by `scrollLeft`. Translating rows here as well moved
              the body twice as far as the header (which lives outside the scroller and needs
              its own translate) — the "header and cells drift apart when you scroll right"
              bug. The row-number column stays put via `position: sticky; left: 0`. */}
          {visibleRows.map((row) => (
            <div
              key={row}
              className={`vtable__row${row % 2 === 1 ? ' vtable__row--odd' : ''}`}
              style={{
                top: row * ROW_HEIGHT,
                height: ROW_HEIGHT,
                gridTemplateColumns: gridTemplate,
                width: rowHeaderWidth + totalWidth,
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
                        if (abandonedRef.current) {
                          abandonedRef.current = false;
                          setEditing(null);
                          return;
                        }
                        commit(row, c, event.target.value);
                        setEditing(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                        if (event.key === 'Escape') {
                          // Discard: the input unmounts, and whichever of blur/unmount
                          // fires must not commit the text the user just rejected.
                          abandonedRef.current = true;
                          setEditing(null);
                        }
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
