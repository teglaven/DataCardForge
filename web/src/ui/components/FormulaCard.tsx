/**
 * Formula card — computes derived columns from expressions over a source matrix card.
 *
 * The user writes one or more expressions (e.g. `(A - AVG(A)) / STD(A)`) referencing
 * columns by name. Each expression produces a column in the result matrix, which is
 * displayed in a read-only virtual table below the formula editor.
 *
 * The result matrix lives in the store's `matrices` map and is recomputed whenever the
 * source card's active file changes or the source file's cells are edited (see
 * `refreshDependentCharts`).
 *
 * A formula column is *not* yet a chart source: charts are built from a matrix card's
 * columns (`addChartCard` requires a `MatrixCardModel`). This used to be described as if it
 * already worked.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { MatrixData } from '../../core/MatrixData.ts';
import { compile, ExpressionError } from '../../core/expression.ts';
import { setTableMetrics, invalidateLayout } from '../cardMetrics.ts';
import { useTranslator, useWorkspace } from '../workspaceStore.ts';
import type { FormulaCardModel } from '../types.ts';
import type { MessageKey } from '../i18n.ts';
import { CardShell } from './CardShell.tsx';
import { VirtualTable, type TableMetrics } from './VirtualTable.tsx';

/** How long to wait after the last keystroke before re-evaluating every formula. */
const FORMULA_DEBOUNCE_MS = 250;

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

  /**
   * The editor keeps its own draft and only commits after a pause.
   *
   * `setFormula` re-evaluates the whole expression over every row and installs a fresh
   * result matrix, so committing on each keystroke ran 10 000-row evaluations once per
   * character — and re-rendered every card in the workspace each time.
   */
  const [draft, setDraft] = useState(() => card.formulas.map((formula) => ({ ...formula })));
  const identityRef = useRef({ id: card.id, count: card.formulas.length });

  // Re-sync only when the card itself or the number of formulas changes; re-syncing on
  // every store update would fight the user's typing.
  useEffect(() => {
    const previous = identityRef.current;
    if (previous.id === card.id && previous.count === card.formulas.length) return;
    identityRef.current = { id: card.id, count: card.formulas.length };
    setDraft(card.formulas.map((formula) => ({ ...formula })));
  }, [card.id, card.formulas]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      draft.forEach((formula, index) => {
        const current = card.formulas[index];
        if (!current) return;
        if (current.name === formula.name && current.expression === formula.expression) return;
        setFormula(card.id, index, formula.name, formula.expression);
      });
    }, FORMULA_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, card.formulas, card.id, setFormula]);

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

  // Validate the draft, so an error appears as soon as the expression is wrong.
  useEffect(() => {
    const newErrors = new Map<number, string>();
    for (let i = 0; i < draft.length; i++) {
      try {
        compile(draft[i].expression, sourceColumnNames);
      } catch (e) {
        if (e instanceof ExpressionError) {
          // Render a localised sentence from the structured code; the raw English parser
          // message stays available on the error object for logs and tests.
          const key = `formula.error.${e.code}` as MessageKey;
          // "2–2 arguments" reads badly; collapse an exact arity to a single number.
          const params =
            e.code === 'badArgCount'
              ? {
                  ...e.params,
                  expected:
                    e.params.min === e.params.max
                      ? String(e.params.min)
                      : `${e.params.min}–${e.params.max}`,
                }
              : e.params;
          const localised = t(key, params);
          newErrors.set(i, localised === key ? e.message : localised);
        }
      }
    }
    setErrors(newErrors);
  }, [draft, sourceColumnNames, t]);

  const rows = resultMatrix?.rowCount() ?? 0;
  const cols = resultMatrix?.columnCount() ?? 0;
  // Was `F${card.id}` — the internal card counter leaking into the title.
  const title = t('card.formula', {
    name: draft[0]?.name || card.formulas[0]?.name || t('card.unlabeled'),
  });
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
          {draft.map((formula, index) => (
            <div key={index} className={`formula-card__row${errors.has(index) ? ' formula-card__row--error' : ''}`}>
              <input
                type="text"
                className="formula-card__name card__control"
                value={formula.name}
                placeholder={t('formula.namePlaceholder')}
                onChange={(e) =>
                  setDraft((rows) =>
                    rows.map((row, i) => (i === index ? { ...row, name: e.target.value } : row)),
                  )
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
                  setDraft((rows) =>
                    rows.map((row, i) =>
                      i === index ? { ...row, expression: e.target.value } : row,
                    ),
                  )
                }
              />
              {draft.length > 1 ? (
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
            onClick={() => {
              const name = `Col${draft.length + 1}`;
              setDraft((rows) => [...rows, { name, expression: 'A' }]);
              setFormula(card.id, draft.length, name, 'A');
            }}
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
