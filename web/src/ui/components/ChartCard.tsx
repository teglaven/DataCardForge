/**
 * Chart card — multi-type scientific plotting on ECharts (SVG renderer).
 *
 * History: the Qt version was a single-type line chart (QCustomPlot). The card now owns
 * a `ChartConfig` (type + attached columns + presentation options) and rebuilds the
 * ECharts option whenever that config, the data, or the smoothing changes.
 *
 * Vector export is the reason this project chose the web stack, so exporting is a
 * first-class control rather than a hidden toolbox item:
 *   - **SVG** — the live chart is already a real `<svg>`; the file is that DOM tree,
 *     serialised with computed styles folded in. Fully vector.
 *   - **PNG** — rasterised at 2×/4× for slides or print.
 *   - **PDF** — one page wrapping a high-resolution raster (see `charts/pdf.ts`). The UI
 *     marks it as non-vector so nobody submits it as a vector figure by mistake.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// Type-only import: ECharts is ~1 MB, so it is loaded lazily and must not be pulled into
// the initial bundle just for its types.
import type * as echartsNamespace from 'echarts';

import { applySmoothing, type SmoothingMode } from '../../core/Smoothing.ts';
import { formatBytes } from '../i18n.ts';
import { useTranslator, useWorkspace } from '../workspaceStore.ts';
import { isChartCard, isMatrixCard, type ChartCardModel } from '../types.ts';
import {
  CHART_TYPE_ORDER,
  EXPORT_FORMATS,
  chartTypeDef,
  minimumColumns,
} from '../../charts/chartTypes.ts';
import { buildOption, type BuildContext } from '../../charts/chartOptions.ts';
import { exportChart, type ExportType } from '../../charts/export.ts';
import { CardShell } from './CardShell.tsx';

interface ChartCardProps {
  card: ChartCardModel;
  active: boolean;
  closeBlocked: boolean;
  onClose: () => void;
  onCloseBlocked: () => void;
  onActivate: () => void;
}

const SMOOTHING_MODES: SmoothingMode[] = [
  'none',
  'movingAverage',
  'exponential',
  'median',
  'savitzkyGolay',
];

type Panel = 'type' | 'options' | 'export' | null;

export function ChartCard({
  card,
  active,
  closeBlocked,
  onClose,
  onCloseBlocked,
  onActivate,
}: ChartCardProps) {
  const { t } = useTranslator();
  const setBounds = useWorkspace((s) => s.setBounds);
  const setSmoothing = useWorkspace((s) => s.setSmoothing);
  const setChartType = useWorkspace((s) => s.setChartType);
  const setChartConfig = useWorkspace((s) => s.setChartConfig);
  const addChartSource = useWorkspace((s) => s.addChartSource);
  const removeChartSource = useWorkspace((s) => s.removeChartSource);
  const matrices = useWorkspace((s) => s.matrices);
  const cards = useWorkspace((s) => s.cards);
  const showToast = useWorkspace((s) => s.showToast);
  const locale = useWorkspace((s) => s.locale);
  const typeDef = useMemo(() => chartTypeDef(card.config.type), [card.config.type]);
  const tRef = useRef(t);
  tRef.current = t;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echartsNamespace.ECharts | null>(null);
  const [echarts, setEcharts] = useState<typeof echartsNamespace | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [pixelRatio, setPixelRatio] = useState(2);

  const totalPoints = card.config.sources.reduce(
    (max, source) => Math.max(max, source.raw.length),
    0,
  );
  const needed = minimumColumns(card.config.type);
  const drawable = card.config.sources.length >= needed;

  // ── ECharts lifecycle ──────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    void import('echarts').then((module) => {
      if (cancelled) return;
      // Exposed for the headless smoke test, which reads the plotted series back out of
      // the live instance to verify data updates rather than pixels.
      (window as unknown as { echarts?: typeof module }).echarts = module;
      setEcharts(module);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !echarts || !drawable) return;
    // The SVG renderer is what makes `chartToSvgString` produce real vector output.
    const chart = echarts.init(el, undefined, { renderer: 'svg', useDirtyRect: true });
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [echarts, drawable]);

  /** Localised strings handed to the (i18n-free) option builder. */
  const strings = useMemo<BuildContext['strings']>(
    () => ({
      rowIndex: 'No.',
      value: t('chart.value'),
      count: t('chart.points', { n: '' }).trim(),
      density: 'Density',
      correlation: 'r',
      quartiles: 'IQR',
      // The legend entry states which spread measure is drawn.
      mean: `${t('chart.mean')} ± ${t(errorKey(card))}`,
      outliers: 'outliers',
      secondAxis: t('chart.secondAxis'),
    }),
    // The legend name embeds the selected error kind, so it must rebuild with it.
    [t, card.config.errorKind],
  );

  const option = useMemo(
    () =>
      drawable
        ? buildOption({ config: card.config, smoothing: card.smoothing, strings })
        : null,
    [card.config, card.smoothing, strings, drawable],
  );

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !option) return;
    // `notMerge` because switching chart type changes the axis kinds entirely.
    chart.setOption(option, { notMerge: true });
  }, [option]);

  // Redraw axis labels/tooltips when the language changes (option strings are locale-bound).
  useEffect(() => {
    const chart = chartRef.current;
    if (chart && option) chart.setOption(option, { notMerge: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  useEffect(() => {
    if (!panel) return;
    const close = () => setPanel(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPanel(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [panel]);

  // ── export ─────────────────────────────────────────────────────────────

  const handleExport = useCallback(
    async (type: ExportType) => {
      const container = containerRef.current;
      if (!container) return;
      setPanel(null);
      try {
        const result = await exportChart(container, type, {
          name: exportBaseName(card),
          pixelRatio,
          background: '#ffffff',
        });
        showToast(
          result.vector ? 'info' : 'info',
          t('status.exported', { name: result.fileName, size: formatBytes(result.bytes) }),
        );
        if (!result.vector && type === 'pdf') {
          // Be explicit: a raster-in-PDF is not a vector figure.
          window.setTimeout(() => {
            showToast('info', t('status.notVector', { format: type.toUpperCase() }));
          }, 100);
        }
      } catch (error) {
        showToast('error', t('status.exportFailed', {
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [card, pixelRatio, showToast, t],
  );

  // ── source columns ─────────────────────────────────────────────────────

  /**
   * Matrices this chart is allowed to read: those owned by a matrix card that already
   * feeds it. Keeping this restriction means "chart follows its table's file switch"
   * stays true, which the dependency graph relies on.
   */
  const availableColumns = useMemo(() => {
    const ownerIds = new Set(card.config.sources.map((source) => source.matrixId));
    const options: Array<{ matrixId: number; columnIndex: number; label: string; file: string }> =
      [];
    for (const entry of cards) {
      if (!isMatrixCard(entry)) continue;
      for (const fileSource of entry.sources) {
        if (!ownerIds.has(fileSource.matrixId)) continue;
        const matrix = matrices.get(fileSource.matrixId);
        if (!matrix) continue;
        for (let index = 0; index < matrix.columnCount(); ++index) {
          const column = matrix.column(index);
          options.push({
            matrixId: fileSource.matrixId,
            columnIndex: index,
            label: column.annotation !== '' ? column.annotation : column.posName,
            file: fileSource.name,
          });
        }
      }
    }
    return options;
  }, [cards, matrices, card.config.sources]);

  const badge = `${card.config.sources.length} × ${t('chart.points', { n: totalPoints })}`;
  const title = t('card.chart', {
    type: t(typeDef.labelKey),
    name: card.config.sources[0]?.label ?? t('card.unlabeled'),
  });

  return (
    <CardShell
      card={card}
      variant="card--chart"
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
      <div className="chart-card">
        {/* Toolbar: chart type, options, export. */}
        <div className="chart-card__toolbar">
          <div className="chart-card__tp">
            <button
              type="button"
              className={`chart-card__tbutton card__control${panel === 'type' ? ' is-open' : ''}`}
              title={t(typeDef.hintKey)}
              onClick={(event) => {
                event.stopPropagation();
                setPanel(panel === 'type' ? null : 'type');
              }}
            >
              {t(typeDef.labelKey)} ▾
            </button>
            {panel === 'type' ? (
              <div className="chart-card__popup" onClick={(event) => event.stopPropagation()}>
                {CHART_TYPE_ORDER.map((id) => {
                  const def = chartTypeDef(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`chart-card__popup-item${
                        card.config.type === id ? ' is-active' : ''
                      }`}
                      title={t(def.hintKey)}
                      onClick={() => {
                        setChartType(card.id, id);
                        setPanel(null);
                      }}
                    >
                      {t(def.labelKey)}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div className="chart-card__tp">
            <button
              type="button"
              className={`chart-card__tbutton card__control${panel === 'options' ? ' is-open' : ''}`}
              onClick={(event) => {
                event.stopPropagation();
                setPanel(panel === 'options' ? null : 'options');
              }}
            >
              {t('chart.axis')} ▾
            </button>
            {panel === 'options' ? (
              <div
                className="chart-card__popup chart-card__popup--wide"
                onClick={(event) => event.stopPropagation()}
              >
                {/* Log axis is meaningless for bar (zero-height) and correlation types. */}
                {typeDef.supportsLogScale ? (
                  <label className="chart-card__field">
                    <input
                      type="checkbox"
                      checked={card.config.logScale}
                      onChange={(event) =>
                        setChartConfig(card.id, { logScale: event.target.checked })
                      }
                    />
                    <span>{t('chart.logScale')}</span>
                  </label>
                ) : null}
                {typeDef.supportsSecondAxis ? (
                  <label className="chart-card__field">
                    <input
                      type="checkbox"
                      checked={card.config.secondAxis}
                      onChange={(event) =>
                        setChartConfig(card.id, { secondAxis: event.target.checked })
                      }
                    />
                    <span>{t('chart.secondAxis')}</span>
                  </label>
                ) : null}
                {card.config.type === 'scatter' || card.config.type === 'regression' ? (
                  <label className="chart-card__field">
                    <input
                      type="checkbox"
                      checked={card.config.showFitLine}
                      onChange={(event) =>
                        setChartConfig(card.id, { showFitLine: event.target.checked })
                      }
                    />
                    <span>{t('chart.fitLine')}</span>
                  </label>
                ) : null}
                {card.config.type === 'bar' ? (
                  <label className="chart-card__field">
                    <span>{t('chart.layout')}</span>
                    <select
                      className="card__control"
                      value={card.config.layout}
                      onChange={(event) =>
                        setChartConfig(card.id, {
                          layout: event.target.value as 'grouped' | 'stacked',
                        })
                      }
                    >
                      <option value="grouped">{t('chart.layout.grouped')}</option>
                      <option value="stacked">{t('chart.layout.stacked')}</option>
                    </select>
                  </label>
                ) : null}
                {card.config.type === 'histogram' ? (
                  <label className="chart-card__field">
                    <span>{t('chart.bins')}</span>
                    <input
                      type="number"
                      min={0}
                      max={200}
                      className="card__control chart-card__number"
                      value={card.config.binCount}
                      onChange={(event) =>
                        setChartConfig(card.id, { binCount: Number(event.target.value) })
                      }
                    />
                    <em>{card.config.binCount === 0 ? t('chart.binsAuto') : ''}</em>
                  </label>
                ) : null}
                {card.config.type === 'errorBar' ? (
                  <>
                    <label className="chart-card__field">
                      <span>{t('chart.errorKind')}</span>
                      <select
                        className="card__control"
                        value={card.config.errorKind}
                        onChange={(event) =>
                          setChartConfig(card.id, {
                            errorKind: event.target.value as 'sd' | 'se' | 'ci95',
                          })
                        }
                      >
                        <option value="sd">{t('chart.error.sd')}</option>
                        <option value="se">{t('chart.error.se')}</option>
                        <option value="ci95">{t('chart.error.ci95')}</option>
                      </select>
                    </label>
                    <label className="chart-card__field">
                      <span>{t('chart.capWidth')}</span>
                      <input
                        type="range"
                        min={0.05}
                        max={1}
                        step={0.05}
                        value={card.config.capWidth}
                        onChange={(event) =>
                          setChartConfig(card.id, { capWidth: Number(event.target.value) })
                        }
                      />
                    </label>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="chart-card__tp">
            <button
              type="button"
              className={`chart-card__tbutton card__control${
                panel === 'export' ? ' is-open' : ''
              }`}
              onClick={(event) => {
                event.stopPropagation();
                setPanel(panel === 'export' ? null : 'export');
              }}
            >
              {t('chart.export')} ▾
            </button>
            {panel === 'export' ? (
              <div
                className="chart-card__popup chart-card__popup--export"
                onClick={(event) => event.stopPropagation()}
              >
                {EXPORT_FORMATS.map((format) => (
                  <button
                    key={format.id}
                    type="button"
                    className="chart-card__popup-item"
                    onClick={() =>
                      void handleExport(
                        format.id === 'png' ? 'png' : (format.id as ExportType),
                      )
                    }
                  >
                    {format.id === 'png'
                      ? t('chart.exportPng', { ratio: pixelRatio })
                      : t(format.labelKey)}
                    {format.vector ? <em className="chart-card__vec">vector</em> : null}
                  </button>
                ))}
                <label className="chart-card__field chart-card__field--tight">
                  <span>{t('chart.pixelRatio')}</span>
                  <select
                    className="card__control"
                    value={pixelRatio}
                    onChange={(event) => setPixelRatio(Number(event.target.value))}
                  >
                    <option value={1}>1×</option>
                    <option value={2}>2×</option>
                    <option value={4}>4×</option>
                  </select>
                </label>
              </div>
            ) : null}
          </div>

          <span className="chart-card__spacer" />
          <span className="chart-card__hint">{t(typeDef.hintKey)}</span>
        </div>

        {/* Plot area */}
        {drawable ? (
          <div className="chart-card__plot" ref={containerRef} />
        ) : (
          <div className="chart-card__empty">
            {t('chart.needMoreColumns', { type: t(typeDef.labelKey), n: needed })}
          </div>
        )}

        {/* Column chips + smoothing */}
        <div className="chart-card__footer">
          <div className="chart-card__columns">
            <span className="chart-card__label">{t('chart.columns')}</span>
            {card.config.sources.map((source) => (
              <span
                key={`${source.matrixId}:${source.columnIndex}`}
                className="chart-card__chip"
                title={source.label}
              >
                {source.label}
                {card.config.sources.length > 1 ? (
                  <button
                    type="button"
                    className="chart-card__chip-x card__control"
                    title={t('chart.removeColumn')}
                    onClick={() => removeChartSource(card.id, source.matrixId, source.columnIndex)}
                  >
                    ×
                  </button>
                ) : null}
              </span>
            ))}
            <select
              className="chart-card__add card__control"
              value=""
              onChange={(event) => {
                const value = event.target.value;
                if (!value) return;
                const [matrixId, columnIndex] = value.split(':').map(Number);
                addChartSource(card.id, matrixId, columnIndex);
              }}
            >
              <option value="">+ {t('chart.addColumn')}</option>
              {availableColumns
                .filter(
                  (column) =>
                    !card.config.sources.some(
                      (source) =>
                        source.matrixId === column.matrixId &&
                        source.columnIndex === column.columnIndex,
                    ),
                )
                .map((column) => (
                  <option
                    key={`${column.matrixId}:${column.columnIndex}`}
                    value={`${column.matrixId}:${column.columnIndex}`}
                  >
                    {column.label} · {column.file}
                  </option>
                ))}
            </select>
          </div>

          <div className="chart-card__controls">
            <label className="chart-card__control">
              <span>{t('chart.smoothing')}</span>
              <select
                className="card__control"
                value={card.smoothing.mode}
                onChange={(event) =>
                  setSmoothing(card.id, {
                    ...card.smoothing,
                    mode: event.target.value as SmoothingMode,
                  })
                }
              >
                {SMOOTHING_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`chart.mode.${mode}` as 'chart.mode.none')}
                  </option>
                ))}
              </select>
            </label>

            {card.smoothing.mode === 'exponential' ? (
              <label className="chart-card__control">
                <span>{t('chart.alpha')}</span>
                <input
                  type="range"
                  min={0.01}
                  max={1}
                  step={0.01}
                  value={card.smoothing.alpha}
                  onChange={(event) =>
                    setSmoothing(card.id, { ...card.smoothing, alpha: Number(event.target.value) })
                  }
                />
                <em>{card.smoothing.alpha.toFixed(2)}</em>
              </label>
            ) : (
              <label className="chart-card__control">
                <span>{t('chart.window')}</span>
                <input
                  type="range"
                  min={1}
                  max={101}
                  step={2}
                  value={card.smoothing.window}
                  disabled={card.smoothing.mode === 'none'}
                  onChange={(event) =>
                    setSmoothing(card.id, { ...card.smoothing, window: Number(event.target.value) })
                  }
                />
                <em>{card.smoothing.window}</em>
              </label>
            )}

            {card.smoothing.mode === 'savitzkyGolay' ? (
              <label className="chart-card__control">
                <span>{t('chart.degree')}</span>
                <input
                  type="number"
                  className="card__control chart-card__number"
                  min={1}
                  max={5}
                  value={card.smoothing.degree}
                  onChange={(event) =>
                    setSmoothing(card.id, { ...card.smoothing, degree: Number(event.target.value) })
                  }
                />
              </label>
            ) : null}
          </div>
        </div>
      </div>
    </CardShell>
  );
}

/** i18n key for the card's selected error kind (used in the legend name). */
function errorKey(card: ChartCardModel): 'chart.error.sd' | 'chart.error.se' | 'chart.error.ci95' {
  switch (card.config.errorKind) {
    case 'se':
      return 'chart.error.se';
    case 'ci95':
      return 'chart.error.ci95';
    default:
      return 'chart.error.sd';
  }
}

/** File-name stem for exports: chart type plus the first column label. */
function exportBaseName(card: ChartCardModel): string {
  const type = card.config.type;
  const label = card.config.sources[0]?.label ?? 'chart';
  const safe = `${type}-${label}`
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return `data-workbench-${safe || 'chart'}`;
}

/** Re-exported so tests and the matrix card can share one definition of "drawable". */
export function chartIsDrawable(card: ChartCardModel): boolean {
  return isChartCard(card) && card.config.sources.length >= minimumColumns(card.config.type);
}

/** Unused import guard: `applySmoothing` is re-exported for tests that exercise it here. */
export { applySmoothing };
