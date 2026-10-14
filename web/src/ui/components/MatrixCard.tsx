/**
 * Matrix card — the React equivalent of `src/widgets/MatrixCard.cpp` plus its
 * `MatrixTableModel`.
 *
 * Behaviour carried over from the Qt frontend:
 *   - one card can hold many files; a selector at the *top* switches between them,
 *   - file-backed tables are read-only,
 *   - right-clicking a column header offers "draw line chart for this column",
 *   - switching files notifies the workspace so dependent charts refresh.
 *
 * It also publishes its table geometry (`cardMetrics`) so connection lines can
 * anchor to column headers.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { MatrixData } from '../../core/MatrixData.ts';
import {
  CHART_TYPE_ORDER,
  chartTypeDef,
  minimumColumns,
  type ChartTypeId,
} from '../../charts/chartTypes.ts';
import { setTableMetrics, invalidateLayout } from '../cardMetrics.ts';
import { useTranslator, useWorkspace } from '../workspaceStore.ts';
import type { MatrixCardModel } from '../types.ts';
import { CardShell } from './CardShell.tsx';
import { VirtualTable, type TableMetrics } from './VirtualTable.tsx';

interface MatrixCardProps {
  card: MatrixCardModel;
  matrix: MatrixData | undefined;
  active: boolean;
  closeBlocked: boolean;
  onClose: () => void;
  onCloseBlocked: () => void;
  onOpenChart: (columnIndex: number, type: ChartTypeId) => void;
  onOpenFormula: () => void;
  onActivate: () => void;
}

export function MatrixCard({
  card,
  matrix,
  active,
  closeBlocked,
  onClose,
  onCloseBlocked,
  onOpenChart,
  onOpenFormula,
  onActivate,
}: MatrixCardProps) {
  const { t } = useTranslator();
  const setBounds = useWorkspace((s) => s.setBounds);
  const setActiveSource = useWorkspace((s) => s.setActiveSource);
  const editCell = useWorkspace((s) => s.editCell);
  const showToast = useWorkspace((s) => s.showToast);

  const [menu, setMenu] = useState<{ x: number; y: number; column: number } | null>(null);
  const [highlightColumn, setHighlightColumn] = useState<number | null>(null);

  // VirtualTable reports its geometry; keep the latest in a ref so the callback
  // identity can stay stable (an unstable callback would loop with its effect).
  const metricsRef = useRef<TableMetrics | null>(null);

  const handleMetrics = useCallback(
    (metrics: TableMetrics) => {
      metricsRef.current = metrics;
      setTableMetrics(card.id, metrics);
    },
    [card.id],
  );

  // Re-publish while the card is resized so anchors follow the header row.
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      invalidateLayout();
    });
    const node = metricsRef.current?.tableViewport;
    if (node) observer.observe(node);
    return () => observer.disconnect();
  }, [matrix]);

  // Clear published metrics when this card goes away.
  useEffect(() => {
    return () => {
      metricsRef.current = null;
    };
  }, []);

  const rows = matrix?.rowCount() ?? 0;
  const cols = matrix?.columnCount() ?? 0;
  const activeSourceName = card.sources[card.activeSource]?.name ?? '';

  const title = matrix
    ? t(card.sources.length > 1 ? 'card.matrixMulti' : 'card.matrix', {
        name: activeSourceName,
        count: card.sources.length - 1,
        rows,
        cols,
      })
    : activeSourceName;

  const badge = `${t('table.rows', { n: rows })} · ${t('table.cols', { n: cols })}${
    card.readOnly ? ` · ${t('table.readOnly')}` : ''
  }`;

  return (
    <CardShell
      card={card}
      variant="card--matrix"
      title={title}
      badge={badge}
      active={active}
      closeBlocked={closeBlocked}
      closeLabel={t('card.close')}
      onActivate={onActivate}
      onClose={onClose}
      onCloseBlocked={onCloseBlocked}
      onBounds={(bounds) => setBounds(card.id, bounds)}
    >
      <div className="matrix-card">
        {card.sources.length > 1 ? (
          <select
            className="matrix-card__selector card__control"
            value={card.activeSource}
            onChange={(event) => setActiveSource(card.id, Number(event.target.value))}
            title={activeSourceName}
          >
            {card.sources.map((source, index) => (
              <option key={source.name} value={index}>
                {source.name}
              </option>
            ))}
          </select>
        ) : (
          <div className="matrix-card__single-file" title={activeSourceName}>
            {activeSourceName}
          </div>
        )}

        {matrix && cols > 0 ? (
          <VirtualTable
            matrix={matrix}
            readOnly={card.readOnly}
            rowLabel={(n) => t('table.rowHeader', { n })}
            highlightColumn={highlightColumn}
            onMetrics={handleMetrics}
            onCellChange={(row, col, value) => editCell(card.id, row, col, value)}
            onHeaderClick={(column) =>
              setHighlightColumn((current) => (current === column ? null : column))
            }
            onHeaderContextMenu={(event, column) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, column });
            }}
          />
        ) : (
          <div className="matrix-card__empty">{t('empty.hint')}</div>
        )}
      </div>

      {menu ? (
        <ColumnContextMenu
          x={menu.x}
          y={menu.y}
          columnName={
            matrix ? matrix.columnLabel(menu.column) || matrix.column(menu.column).posName : ''
          }
          columnCount={cols}
          onDismiss={() => setMenu(null)}
          onSelect={(type) => {
            onOpenChart(menu.column, type);
            const columnName = matrix ? matrix.columnLabel(menu.column) : '';
            showToast('info', t('status.chartCreated', { name: columnName }));
            setMenu(null);
          }}
          onOpenFormula={() => {
            onOpenFormula();
            setMenu(null);
          }}
        />
      ) : null}
    </CardShell>
  );
}

interface ColumnContextMenuProps {
  x: number;
  y: number;
  columnName: string;
  /** Column count of the matrix currently displayed, used to disable impossible types. */
  columnCount: number;
  onSelect: (type: ChartTypeId) => void;
  onOpenFormula: () => void;
  onDismiss: () => void;
}

/**
 * Right-click menu on a column header: pick the chart type to create from this column.
 *
 * Types that need more columns than the matrix has are disabled with an explanation,
 * rather than creating a card that cannot draw anything.
 */
function ColumnContextMenu({
  x,
  y,
  columnName,
  columnCount,
  onSelect,
  onOpenFormula,
  onDismiss,
}: ColumnContextMenuProps) {
  const { t } = useTranslator();

  useEffect(() => {
    const close = () => onDismiss();
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', close);
    };
  }, [onDismiss]);

  return (
    <div
      className="context-menu context-menu--list"
      style={{ left: x, top: y }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="context-menu__title">
        {t('table.contextChartMenu')} · {columnName}
      </div>
      {CHART_TYPE_ORDER.map((id) => {
        const def = chartTypeDef(id);
        return (
          <button
            key={id}
            type="button"
            className="context-menu__item"
            title={t(def.hintKey)}
            disabled={minimumColumns(id) > columnCount}
            onClick={() => onSelect(id)}
          >
            {t(def.labelKey)}
          </button>
        );
      })}
      <div className="context-menu__separator" />
      <button
        type="button"
        className="context-menu__item"
        onClick={() => onOpenFormula()}
      >
        {t('menu.newFormula')}
      </button>
    </div>
  );
}
