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
 * Columns that feed a chart are marked on their headers; the connection lines
 * themselves are card-level (see ConnectionLayer).
 */
import { useState } from 'react';

import { MatrixData } from '../../core/MatrixData.ts';
import {
  CHART_TYPE_ORDER,
  chartTypeDef,
  minimumColumns,
  type ChartTypeId,
} from '../../charts/chartTypes.ts';
import { useTranslator, useWorkspace } from '../workspaceStore.ts';
import type { MatrixCardModel } from '../types.ts';
import { CardShell } from './CardShell.tsx';
import { Popup } from './Popup.tsx';
import { SummaryPanel } from './SummaryPanel.tsx';
import { VirtualTable } from './VirtualTable.tsx';

interface MatrixCardProps {
  card: MatrixCardModel;
  matrix: MatrixData | undefined;
  active: boolean;
  closeBlocked: boolean;
  onClose: () => void;
  onCloseBlocked: () => void;
  onOpenChart: (columnIndex: number, type: ChartTypeId) => number | null;
  /** New function card reading this table, created from the clicked column. */
  onOpenFormula: (column: number) => void;
  /** Relation-enumeration card from this column and its neighbour (two cell ports). */
  onOpenRelationEnum: (column: number) => void;
  onActivate: () => void;
  /** True while a file is being dragged over this card (it would replace its data). */
  dropTarget?: boolean;
  /**
   * Ask the app to pick ONE file and replace the active one — the control the card was
   * missing: before it existed, a data card's file could never change, which is why a
   * saved workspace could not be reused as a template for a new day's data.
   */
  onReplaceFile: () => void;
  /** Columns of the displayed matrix that feed the currently selected chart. */
  sourceColumns?: readonly number[];
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
  onOpenRelationEnum,
  onActivate,
  dropTarget = false,
  onReplaceFile,
  sourceColumns = [],
}: MatrixCardProps) {
  const { t } = useTranslator();
  const setBounds = useWorkspace((s) => s.setBounds);
  const setActiveSource = useWorkspace((s) => s.setActiveSource);
  const editCell = useWorkspace((s) => s.editCell);
  const setEditable = useWorkspace((s) => s.setEditable);
  const showToast = useWorkspace((s) => s.showToast);

  const [menu, setMenu] = useState<{ x: number; y: number; column: number } | null>(null);
  const [highlightColumn, setHighlightColumn] = useState<number | null>(null);

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
      dropTarget={dropTarget}
      closeBlocked={closeBlocked}
      closeLabel={t('card.close')}
      onActivate={onActivate}
      onClose={onClose}
      onCloseBlocked={onCloseBlocked}
      onBounds={(bounds) => setBounds(card.id, bounds)}
    >
      <div className="matrix-card">
        {/* File row: which file is shown, the one control that changes it, and the lock.
            Before the replace control existed the file was frozen for the card's lifetime. */}
        <div className="matrix-card__bar">
          {card.sources.length > 1 ? (
            <select
              className="matrix-card__selector card__control"
              value={card.activeSource}
              onChange={(event) => setActiveSource(card.id, Number(event.target.value))}
              title={activeSourceName}
              aria-label={activeSourceName}
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

          <button
            type="button"
            className="matrix-card__replace card__control"
            title={t('matrix.replaceFile')}
            aria-label={t('matrix.replaceFile')}
            onClick={() => onReplaceFile()}
          >
            {/* Inline SVG, not an emoji: a font without the glyph would render a blank box. */}
            <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3.2 6.6a5 5 0 0 1 8.7-2.1M12.8 9.4a5 5 0 0 1-8.7 2.1"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <path
                d="M12.6 1.6v3h-3M3.4 14.4v-3h3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {/* Lock / unlock. Without this the whole cell-editing path was unreachable: every
              matrix card was created read-only and nothing in the UI could change that. */}
          <button
            type="button"
            className={`matrix-card__lock card__control${
              card.readOnly ? '' : ' matrix-card__lock--open'
            }`}
            title={card.readOnly ? t('table.editable') : t('table.readOnly')}
            aria-label={card.readOnly ? t('table.editable') : t('table.readOnly')}
            aria-pressed={!card.readOnly}
            onClick={() => setEditable(card.id, card.readOnly)}
          >
            {/* Inline SVG, not an emoji: a font without the glyph would render a blank box. */}
            {card.readOnly ? (
              <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M4.5 7V5a3.5 3.5 0 1 1 7 0v2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M11.5 1.9l2.6 2.6L5.6 13H3v-2.6z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        </div>

        {matrix && cols > 0 ? (
          <VirtualTable
            matrix={matrix}
            readOnly={card.readOnly}
            rowLabel={(n) => t('table.rowHeader', { n })}
            highlightColumn={highlightColumn}
            sourceColumns={sourceColumns}
            onCellChange={(row, col, value) => editCell(card.id, row, col, value)}
            onInvalidEdit={(raw) => showToast('error', t('table.invalidNumber', { value: raw }))}
            onHeaderClick={(column) =>
              setHighlightColumn((current) => (current === column ? null : column))
            }
            onHeaderContextMenu={(event, column) => {
              event.preventDefault();
              // The card owns its own menu: without this the event also reaches the canvas,
              // whose right-click gesture belongs to a different surface.
              event.stopPropagation();
              setMenu({ x: event.clientX, y: event.clientY, column });
            }}
          />
        ) : (
          <div className="matrix-card__empty">{t('empty.hint')}</div>
        )}
        {/* 摘要: the card's own table summarised by the backend. Its state, its node and its
            open flag live in the store (session-only), so the card model is untouched —
            and it never computes by itself; the panel asks first. */}
        <SummaryPanel card={card} />
      </div>

      {menu ? (
        <Popup
          x={menu.x}
          y={menu.y}
          className="context-menu context-menu--list"
          onDismiss={() => setMenu(null)}
        >
          <div className="context-menu__title">
            {t('table.contextChartMenu')} ·{' '}
            {matrix ? matrix.columnLabel(menu.column) || matrix.column(menu.column).posName : ''}
          </div>
          {CHART_TYPE_ORDER.map((id) => {
            const def = chartTypeDef(id);
            // A chart is built from this column *and the ones after it*, so the test is
            // against the remaining columns — not the matrix's total. Testing the total
            // let the last column offer "scatter", which then created nothing at all.
            const remaining = cols - menu.column;
            const enough = minimumColumns(id) <= remaining;
            return (
              <button
                key={id}
                type="button"
                className="context-menu__item"
                title={enough ? t(def.hintKey) : t('status.needTrailingColumns', {
                  type: t(def.labelKey),
                  n: minimumColumns(id),
                  have: remaining,
                })}
                disabled={!enough}
                onClick={() => {
                  const created = onOpenChart(menu.column, id);
                  if (created === null) {
                    showToast('error', t('status.needTrailingColumns', {
                      type: t(def.labelKey),
                      n: minimumColumns(id),
                      have: remaining,
                    }));
                  } else {
                    showToast('info', t('status.chartCreated', {
                      name: matrix ? matrix.columnLabel(menu.column) : '',
                    }));
                  }
                  setMenu(null);
                }}
              >
                {t(def.labelKey)}
              </button>
            );
          })}
          <div className="context-menu__separator" />
          <button
            type="button"
            className="context-menu__item"
            onClick={() => {
              onOpenFormula(menu.column);
              setMenu(null);
            }}
          >
            {t('menu.newFormula')}
          </button>
          <button
            type="button"
            className="context-menu__item"
            title={
              cols >= 2
                ? t('menu.newRelationEnum')
                : t('status.needTwoColumns', {
                    type: t('menu.newRelationEnum'),
                    have: cols,
                  })
            }
            disabled={cols < 2}
            onClick={() => {
              onOpenRelationEnum(menu.column);
              setMenu(null);
            }}
          >
            {t('menu.newRelationEnum')}
          </button>
        </Popup>
      ) : null}
    </CardShell>
  );
}
