/**
 * Column dock — the collapsible column picker on the left edge of a chart card.
 *
 * A chart depends on the whole matrix *card*, so which columns it draws is purely a
 * presentation choice. This dock is the one place that choice is made (it replaced the
 * footer's "+ Add column…" select). Collapsed it costs a thin rail; expanded it lists
 * every column of each matrix card's active file, grouped by file name.
 *
 * It deliberately imports nothing from ChartCard or the ECharts stack, so it stays
 * inexpensive and testable on its own.
 */
import { useMemo } from 'react';

import { chartTypeDef, minimumColumns } from '../../charts/chartTypes.ts';
import { useTranslator, useWorkspace } from '../workspaceStore.ts';
import { isMatrixCard, type ChartCardModel } from '../types.ts';

interface ColumnDockProps {
  card: ChartCardModel;
  /** Controls visibility of the whole chart's header, mirroring the footer. */
  open: boolean;
  onToggle: (open: boolean) => void;
}

interface DockColumn {
  matrixId: number;
  columnIndex: number;
  label: string;
}

interface DockGroup {
  name: string;
  columns: DockColumn[];
}

export function ColumnDock({ card, open, onToggle }: ColumnDockProps) {
  const { t } = useTranslator();
  const cards = useWorkspace((s) => s.cards);
  const matrices = useWorkspace((s) => s.matrices);
  const addChartSource = useWorkspace((s) => s.addChartSource);
  const removeChartSource = useWorkspace((s) => s.removeChartSource);

  const typeDef = chartTypeDef(card.config.type);
  // A chart must always keep at least one column, and a paired type needs two.
  const floor = Math.max(1, minimumColumns(card.config.type));

  const groups = useMemo<DockGroup[]>(() => {
    const out: DockGroup[] = [];
    for (const entry of cards) {
      if (!isMatrixCard(entry)) continue;
      const file = entry.sources[entry.activeSource];
      if (!file) continue;
      const matrix = matrices.get(file.matrixId);
      if (!matrix) continue;
      const columns: DockColumn[] = [];
      for (let index = 0; index < matrix.columnCount(); ++index) {
        const column = matrix.column(index);
        columns.push({
          matrixId: file.matrixId,
          columnIndex: index,
          label:
            column.annotation !== ''
              ? `${column.posName} ${column.annotation}`
              : column.posName,
        });
      }
      out.push({ name: file.name, columns });
    }
    return out;
  }, [cards, matrices]);

  const isChecked = (matrixId: number, columnIndex: number): boolean =>
    card.config.sources.some(
      (source) => source.matrixId === matrixId && source.columnIndex === columnIndex,
    );

  const orderOf = (matrixId: number, columnIndex: number): number =>
    card.config.sources.findIndex(
      (source) => source.matrixId === matrixId && source.columnIndex === columnIndex,
    ) + 1;

  const isXAxis = (matrixId: number, columnIndex: number): boolean =>
    card.config.xAxisSource !== null &&
    card.config.xAxisSource.matrixId === matrixId &&
    card.config.xAxisSource.columnIndex === columnIndex;

  if (!open) {
    return (
      <div className="chart-card__dock">
        <button
          type="button"
          className="chart-card__dock-toggle"
          aria-expanded={false}
          aria-controls={`chart-dock-${card.id}`}
          title={t('chart.columnDock')}
          onClick={() => onToggle(true)}
        >
          {t('chart.columnDockToggle')}
        </button>
      </div>
    );
  }

  const empty = groups.every((group) => group.columns.length === 0);

  return (
    <div className="chart-card__dock chart-card__dock--open" id={`chart-dock-${card.id}`}>
      <div className="chart-card__dock-head">
        <span className="chart-card__dock-title">{t('chart.columnDock')}</span>
        <button
          type="button"
          className="chart-card__dock-collapse card__control"
          aria-label={t('chart.columnDockCollapse')}
          title={t('chart.columnDockCollapse')}
          onClick={() => onToggle(false)}
        >
          ‹
        </button>
      </div>
      {empty ? (
        <div className="chart-card__dock-empty">{t('chart.columnDockEmpty')}</div>
      ) : (
        <div className="chart-card__dock-list">
          {groups.map((group) => (
            <div key={group.name} className="chart-card__dock-group">
              <div className="chart-card__dock-group-title" title={group.name}>
                {group.name}
              </div>
              {group.columns.map((column) => {
                const checked = isChecked(column.matrixId, column.columnIndex);
                const atFloor = card.config.sources.length <= floor;
                return (
                  <label
                    key={`${column.matrixId}:${column.columnIndex}`}
                    className="chart-card__dock-item"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={checked && atFloor}
                      title={
                        checked && atFloor
                          ? t('chart.columnDockRequired', { type: t(typeDef.labelKey), n: floor })
                          : column.label
                      }
                      onChange={(event) => {
                        if (event.target.checked) {
                          addChartSource(card.id, column.matrixId, column.columnIndex);
                        } else {
                          removeChartSource(card.id, column.matrixId, column.columnIndex);
                        }
                      }}
                    />
                    <span className="chart-card__dock-item-label">{column.label}</span>
                    {checked ? (
                      <span className="chart-card__dock-badge">
                        {orderOf(column.matrixId, column.columnIndex)}
                      </span>
                    ) : null}
                    {isXAxis(column.matrixId, column.columnIndex) ? (
                      <span className="chart-card__dock-badge">X</span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {typeDef.columnArity === 'pairs' ? (
        <p className="chart-card__dock-order">{t('chart.columnDockOrder')}</p>
      ) : null}
    </div>
  );
}
