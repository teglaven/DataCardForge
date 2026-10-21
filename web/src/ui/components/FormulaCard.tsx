/**
 * Formula card — a pure view over backend compute nodes (B-plan).
 *
 * The user writes one or more expressions (e.g. `(A - AVG(A)) / STD(A)`) referencing
 * columns by name. Each expression is shipped as text to its own server-side compute node;
 * the browser never parses, compiles or evaluates it. Results arrive through the event
 * stream and are pulled into a read-only display cache, rendered below the editor.
 *
 * The four-state light and every error message come from the node's authoritative status:
 * `dirty | computing | done | error` → 灰/黄/绿/红, with an error rendered via the i18n key
 * `formula.error.<code>` (unknown codes fall back to a visible generic sentence + the raw
 * code — never silent). A formula column is *not* yet a chart source: charts are built from
 * a matrix card's columns (`addChartCard` requires a `MatrixCardModel`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MatrixData } from '../../core/MatrixData.ts';
import { setTableMetrics, invalidateLayout } from '../cardMetrics.ts';
import { useTranslator, useWorkspace } from '../workspaceStore.ts';
import type { FormulaCardModel, NodeStatus } from '../types.ts';
import type { MessageKey } from '../i18n.ts';
import { CardShell } from './CardShell.tsx';
import { VirtualTable, type TableMetrics } from './VirtualTable.tsx';

/** How long to wait after the last keystroke before re-sending each formula to the backend. */
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

  const metricsRef = useRef<TableMetrics | null>(null);

  /**
   * The editor keeps its own draft and only commits after a pause.
   *
   * Committing sends the formula text to the backend (PATCH/POST a node), which recomputes
   * asynchronously — so committing on each keystroke would spam the server and re-render on
   * every character.
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

  /**
   * Per-column error text, straight from the node's structured status.
   *
   * No local `compile()`: the backend's parse is the authority. Its error `code` maps to an
   * i18n key; an unknown code still shows something (generic sentence + raw code) rather than
   * silently swallowing the failure.
   */
  const errors = useMemo(() => {
    const map = new Map<number, string>();
    card.nodes.forEach((status: NodeStatus | null, index: number) => {
      if (!status || status.state !== 'error') return;
      const code = status.code ?? 'internalError';
      const params = normaliseErrorParams(status.params);
      const key = `formula.error.${code}` as MessageKey;
      const localised = t(key, params);
      // Unknown code ⇒ t() returns the key unchanged: show a fallback sentence + raw code.
      map.set(index, localised === key ? `${t('formula.error.unknown')} (${code})` : localised);
    });
    return map;
  }, [card.nodes, t]);

  const rows = resultMatrix?.rowCount() ?? 0;
  const cols = resultMatrix?.columnCount() ?? 0;
  // Was `F${card.id}` — the internal card counter leaking into the title.
  const title = t('card.formula', {
    name: draft[0]?.name || card.formulas[0]?.name || t('card.unlabeled'),
  });
  const badge = `${card.formulas.length} ${t('formula.columns')} · ${rows} ${t('formula.rows')}`;
  const overallState = aggregateNodeState(card.nodes);

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
            <span className={`node-light node-light--${overallState}`} aria-hidden />
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
              <span className={`node-light node-light--${card.nodes[index]?.state ?? 'dirty'}`} aria-hidden />
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

        {/* Result table — the read-only display cache fed by the backend. */}
        {resultMatrix && cols > 0 ? (
          <VirtualTable
            matrix={resultMatrix}
            readOnly
            rowLabel={(n) => t('table.rowHeader', { n })}
            onMetrics={handleMetrics}
          />
        ) : (
          <div className="formula-card__empty">
            {overallState === 'computing' || overallState === 'dirty'
              ? t('formula.pending')
              : t('formula.empty')}
          </div>
        )}
      </div>
    </CardShell>
  );
}

/** Collapse the exact-arity phrasing and pass through the backend's structured params. */
function normaliseErrorParams(params?: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = v;
  }
  // `badArgCount` renders "2–2 arguments" badly; collapse an exact arity to one number.
  if (out.min !== undefined && out.max !== undefined && out.min === out.max) {
    out.expected = String(out.min);
  }
  return out;
}

/** Worst-case state across a card's nodes, for the header light (red > yellow > green > grey). */
function aggregateNodeState(nodes: Array<NodeStatus | null>): NodeStatus['state'] | 'idle' {
  let sawDone = false;
  let sawComputing = false;
  for (const n of nodes) {
    if (!n) continue;
    if (n.state === 'error') return 'error';
    if (n.state === 'computing') sawComputing = true;
    if (n.state === 'done') sawDone = true;
  }
  if (sawComputing) return 'computing';
  if (sawDone) return 'done';
  return 'idle';
}

