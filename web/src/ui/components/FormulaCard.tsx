/**
 * Formula card — computes derived columns from expressions over a source matrix card.
 *
 * The user writes one or more expressions (e.g. `(A - AVG(A)) / STD(A)`) referencing
 * columns by name. Each expression produces a column in the result matrix, which is
 * displayed in a read-only virtual table below the formula editor.
 *
 * The result matrix lives in the store's `matrices` map and can be charted like any
 * other matrix — charts created from it automatically follow when the source file
 * switches or the formula changes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { MatrixData } from '../../core/MatrixData.ts';
import { compile, ExpressionError } from '../../core/expression.ts';
import { setTableMetrics, invalidateLayout } from '../cardMetrics.ts';
import { useTranslator, useWorkspace } from '../workspaceStore.ts';
import type { FormulaCardModel } from '../types.ts';
import { CardShell } from './CardShell.tsx';
import { VirtualTable, type TableMetrics } from './VirtualTable.tsx';

interface FormulaCardProps {
  card: FormulaCardModel;
  resultMatrix: MatrixData | undefined;
  sourceColumnNames: string[];
  active: boolean;
  closeBlocked: boolean;
  onClose: () => void;
  onCloseBlocked: () => void;
  onActivate: () => void;
}

export function FormulaCard({
  card,
  resultMatrix,
  sourceColumnNames,
  active,
  closeBlocked,
  onClose,
  onCloseBlocked,
  onActivate,
}: FormulaCardProps) {
  const { t } = useTranslator();
  const setBounds = useWorkspace((s) => s.setBounds);
  const setFormula = useWorkspace((s) => s.setFormula);
  const removeFormula = useWorkspace((s) => s.removeFormula);

  const [errors, setErrors] = useState<Map<number, string>>(new Map());
  const metricsRef = useRef<TableMetrics | null>(null);

  const handleMetrics = useCallback(
    (metrics: TableMetrics) => {
      metricsRef.current = metrics;
      setTableMetrics(card.id, metrics);
    },
    [card.id],
  );

  useEffect(() => {
    const observer = new ResizeObserver(() => invalidateLayout());
    const node = metricsRef.current?.tableViewport;
    if (node) observer.observe(node);
    return () => observer.disconnect();
  }, [resultMatrix]);

  // Validate expressions and collect errors.
  useEffect(() => {
    const newErrors = new Map<number, string>();
    for (let i = 0; i < card.formulas.length; i++) {
      try {
        compile(card.formulas[i].expression, sourceColumnNames);
      } catch (e) {
        if (e instanceof ExpressionError) {
          newErrors.set(i, e.message);
        }
      }
    }
    setErrors(newErrors);
  }, [card.formulas, sourceColumnNames]);

  const rows = resultMatrix?.rowCount() ?? 0;
  const cols = resultMatrix?.columnCount() ?? 0;
  const title = t('card.formula', { name: `F${card.id}` });
  const badge = `${card.formulas.length} ${t('formula.columns')} · ${rows} ${t('formula.rows')}`;

  return (
    <CardShell
      card={card}
      variant="card--formula"
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
      <div className="formula-card">
        {/* Formula editor */}
        <div className="formula-card__editor">
          <div className="formula-card__hint">
            {t('formula.hint')}
            <span className="formula-card__cols">
              {sourceColumnNames.slice(0, 8).join(', ')}
              {sourceColumnNames.length > 8 ? `, … (+${sourceColumnNames.length - 8})` : ''}
            </span>
          </div>
          {card.formulas.map((formula, index) => (
            <div key={index} className={`formula-card__row${errors.has(index) ? ' formula-card__row--error' : ''}`}>
              <input
                type="text"
                className="formula-card__name card__control"
                value={formula.name}
                placeholder={t('formula.namePlaceholder')}
                onChange={(e) =>
                  setFormula(card.id, index, e.target.value, formula.expression)
                }
              />
              <span className="formula-card__eq">=</span>
              <input
                type="text"
                className="formula-card__expr card__control"
                value={formula.expression}
                placeholder={t('formula.exprPlaceholder')}
                spellCheck={false}
                onChange={(e) =>
                  setFormula(card.id, index, formula.name, e.target.value)
                }
              />
              {card.formulas.length > 1 ? (
                <button
                  type="button"
                  className="formula-card__remove card__control"
                  title={t('formula.remove')}
                  onClick={() => removeFormula(card.id, index)}
                >
                  ×
                </button>
              ) : null}
              {errors.has(index) ? (
                <span className="formula-card__error">{errors.get(index)}</span>
              ) : null}
            </div>
          ))}
          <button
            type="button"
            className="formula-card__add card__control"
            onClick={() =>
              setFormula(card.id, card.formulas.length, `Col${card.formulas.length + 1}`, 'A')
            }
          >
            + {t('formula.addColumn')}
          </button>
        </div>

        {/* Result table */}
        {resultMatrix && cols > 0 ? (
          <VirtualTable
            matrix={resultMatrix}
            readOnly
            rowLabel={(n) => t('table.rowHeader', { n })}
            onMetrics={handleMetrics}
          />
        ) : (
          <div className="formula-card__empty">{t('formula.empty')}</div>
        )}
      </div>
    </CardShell>
  );
}
