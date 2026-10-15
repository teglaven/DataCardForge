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

import { applySmoothing, MAX_SG_DEGREE, type SmoothingMode } from '../../core/Smoothing.ts';
import { formatBytes } from '../i18n.ts';
import { useTranslator, useWorkspace } from '../workspaceStore.ts';
import { isChartCard, isMatrixCard, type ChartCardModel } from '../types.ts';
import {
  CHART_TYPE_ORDER,
  EXPORT_FORMATS,
  chartTypeDef,
  minimumColumns,
} from '../../charts/chartTypes.ts';
import { buildOption, ZOOM_COMPONENT_IDS, type BuildContext } from '../../charts/chartOptions.ts';
import { exportChart, type ExportType } from '../../charts/export.ts';
import { CardShell } from './CardShell.tsx';
import { Popup } from './Popup.tsx';

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

type PanelKind = 'type' | 'options' | 'export';

/** An open toolbar dropdown, pinned to the button that opened it in viewport coordinates. */
interface OpenPanel {
  kind: PanelKind;
  x: number;
  y: number;
}

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
  const typeDef = useMemo(() => chartTypeDef(card.config.type), [card.config.type]);
  const tRef = useRef(t);
  tRef.current = t;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [chart, setChart] = useState<echartsNamespace.ECharts | null>(null);
  const [echarts, setEcharts] = useState<typeof echartsNamespace | null>(null);
  const [panel, setPanel] = useState<OpenPanel | null>(null);
  const [pixelRatio, setPixelRatio] = useState(2);

  // A `single`-arity type plots only the first column, so counting every attached column in
  // the badge made a histogram claim "2 × 10000 points" while drawing one series.
  const drawnSources =
    typeDef.columnArity === 'single' ? card.config.sources.slice(0, 1) : card.config.sources;
  const totalPoints = drawnSources.reduce(
    (max, source) => Math.max(max, source.raw.length),
    0,
  );
  const seriesCount =
    typeDef.columnArity === 'pairs'
      ? Math.floor(card.config.sources.length / 2) + (card.config.sources.length % 2)
      : drawnSources.length;
  const needed = minimumColumns(card.config.type);
  const drawable = card.config.sources.length >= needed;

  /**
   * Data facts the axes panel has to state, because the chart cannot:
   *  - a log axis silently discards every sample <= 0;
   *  - `yAxisIndexFor` puts every odd-indexed series on the right axis, and nothing in the
   *    chart shows which ones they are.
   */
  const nonPositiveCount = useMemo(() => {
    if (!card.config.logScale) return 0;
    let count = 0;
    for (const source of card.config.sources) {
      for (const value of source.raw) if (Number.isFinite(value) && value <= 0) count += 1;
    }
    return count;
  }, [card.config.logScale, card.config.sources]);

  const secondAxisLabels = useMemo(
    () =>
      card.config.secondAxis
        ? card.config.sources
            .filter((_, index) => index % 2 === 1)
            .map((source) => source.label)
        : [],
    [card.config.secondAxis, card.config.sources],
  );

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
    const instance = echarts.init(el, undefined, { renderer: 'svg', useDirtyRect: true });
    setChart(instance);
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      instance.dispose();
      setChart(null);
    };
  }, [echarts, drawable]);

  /** Localised strings handed to the (i18n-free) option builder. */
  const strings = useMemo<BuildContext['strings']>(
    () => ({
      rowIndex: t('chart.rowIndex'),
      value: t('chart.value'),
      count: t('chart.points', { n: '' }).trim(),
      density: t('chart.density'),
      binCentre: t('chart.binCentre'),
      correlation: t('chart.correlation'),
      quartiles: t('chart.quartiles'),
      // The legend entry states which spread measure is drawn.
      mean: `${t('chart.mean')} ± ${t(errorKey(card))}`,
      outliers: t('chart.outliers'),
      secondAxis: t('chart.secondAxis'),
    }),
    // The legend name embeds the selected error kind, so it must rebuild with it.
    // `t` is stable per locale (see `translatorFor`), so this only rebuilds when it must.
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
    if (!chart || !option) return;
    // `notMerge` because switching chart type changes the axis kinds entirely.
    // `chart` is in the deps on purpose: the instance is created asynchronously (after the
    // lazy ECharts import), and the option must be applied the moment it exists. A locale
    // change also lands here, because the option's labels come from `strings`.
    chart.setOption(option, { notMerge: true });
  }, [chart, option]);

  /**
   * Open/close a toolbar dropdown, pinned just below its button in **viewport**
   * coordinates. The popup is portalled to `document.body`: inside the card it would be
   * positioned against the card's `transform` (the card is a react-rnd window) and clipped
   * by `overflow: hidden`.
   */
  const togglePanel = useCallback(
    (kind: PanelKind, event: React.MouseEvent) => {
      // Read the geometry *before* scheduling the update: React nulls `currentTarget` once
      // the handler returns, and the updater below can run after that. Doing the read inside
      // the updater threw "Cannot read properties of null", which unmounted the whole app.
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      setPanel((current) =>
        current?.kind === kind ? null : { kind, x: rect.left, y: rect.bottom + 4 },
      );
    },
    [],
  );

  const dismissPanel = useCallback(() => setPanel(null), []);

  /** Return both value axes to their full data range. */
  const resetZoom = useCallback(() => {
    if (!chart) return;
    // `dataZoom` is always installed for the value-axis types, and a wheel over the plot
    // zooms instead of scrolling. Without this the user has no way back to the full range.
    for (const [dataZoomIndex] of ZOOM_COMPONENT_IDS.entries()) {
      chart.dispatchAction({ type: 'dataZoom', dataZoomIndex, start: 0, end: 100 });
    }
  }, [chart]);

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
          'info',
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

  const badge = `${seriesCount} × ${t('chart.points', { n: totalPoints })}`;
  const title = t('card.chart', {
    type: t(typeDef.labelKey),
    name: card.config.sources[0]?.label ?? t('card.unlabeled'),
  });

  /**
   * The X-axis dropdown's value, forced back to "row index" whenever the stored source is
   * not among the offered columns. Without this the `<select>` silently falls back to its
   * first option while the chart keeps using the stale column — the control and the drawn
   * axis would disagree.
   */
  const xAxisSelectValue = (() => {
    const source = card.config.xAxisSource;
    if (!source) return '';
    const value = `${source.matrixId}:${source.columnIndex}`;
    return availableColumns.some(
      (column) => column.matrixId === source.matrixId && column.columnIndex === source.columnIndex,
    )
      ? value
      : '';
  })();

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
              className={`chart-card__tbutton card__control${panel?.kind === 'type' ? ' is-open' : ''}`}
              title={t(typeDef.hintKey)}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => togglePanel('type', event)}
            >
              {t(typeDef.labelKey)} ▾
            </button>
            {panel?.kind === 'type' ? (
              <Popup
                x={panel.x}
                y={panel.y}
                className="chart-card__popup"
                onDismiss={dismissPanel}
              >
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
              </Popup>
            ) : null}
          </div>

          <div className="chart-card__tp">
            <button
              type="button"
              className={`chart-card__tbutton card__control${panel?.kind === 'options' ? ' is-open' : ''}`}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => togglePanel('options', event)}
            >
              {t('chart.axis')} ▾
            </button>
            {panel?.kind === 'options' ? (
              <Popup
                x={panel.x}
                y={panel.y}
                className="chart-card__popup chart-card__popup--wide"
                onDismiss={dismissPanel}
              >
                {/* Log axis is meaningless for bar (zero-height) and correlation types. */}
                {/* X-axis source selector — available for types that use row index by default. */}
                {typeDef.usesRowIndexAsX ? (
                  <label className="chart-card__field">
                    <span>{t('chart.xAxis')}</span>
                    <select
                      className="card__control"
                      value={xAxisSelectValue}
                      onChange={(event) => {
                        const val = event.target.value;
                        if (!val) {
                          setChartConfig(card.id, { xAxisSource: null });
                          return;
                        }
                        const [matrixId, columnIndex] = val.split(':').map(Number);
                        const matrix = matrices.get(matrixId);
                        if (!matrix || columnIndex >= matrix.columnCount()) return;
                        const col = matrix.column(columnIndex);
                        setChartConfig(card.id, {
                          xAxisSource: {
                            matrixId,
                            columnIndex,
                            label: col.annotation || col.posName,
                            raw: col.data.slice(),
                          },
                        });
                      }}
                    >
                      <option value="">{t('chart.xAxisDefault')}</option>
                      {availableColumns.map((col) => (
                        <option
                          key={`${col.matrixId}:${col.columnIndex}`}
                          value={`${col.matrixId}:${col.columnIndex}`}
                        >
                          {col.label} · {col.file}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
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
                      onChange={(event) => {
                        // The chart clamps to 1..200 anyway; storing the raw text meant the
                        // field showed a number (99999, -5) that had no effect on the render.
                        const raw = Number(event.target.value);
                        const clamped = Number.isFinite(raw)
                          ? Math.min(200, Math.max(0, Math.floor(raw)))
                          : 0;
                        setChartConfig(card.id, { binCount: clamped });
                      }}
                    />
                    <em>
                      {card.config.binCount === 0
                        ? t('chart.binsAuto')
                        : t('chart.binsUsed', { n: card.config.binCount })}
                    </em>
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
                {card.config.logScale && nonPositiveCount > 0 ? (
                  <p className="chart-card__warn">
                    {t('chart.logDropsNonPositive', { n: nonPositiveCount })}
                  </p>
                ) : null}
                {secondAxisLabels.length > 0 ? (
                  <p className="chart-card__note">
                    {t('chart.secondAxisOn', { names: secondAxisLabels.join(', ') })}
                  </p>
                ) : null}
                {/* A wheel over the plot zooms both axes; this is the way back. */}
                {typeDef.id !== 'heatmap' ? (
                  <button
                    type="button"
                    className="chart-card__popup-item"
                    onClick={resetZoom}
                  >
                    {t('chart.resetZoom')}
                  </button>
                ) : null}
              </Popup>
            ) : null}
          </div>

          <div className="chart-card__tp">
            <button
              type="button"
              className={`chart-card__tbutton card__control${
                panel?.kind === 'export' ? ' is-open' : ''
              }`}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => togglePanel('export', event)}
            >
              {t('chart.export')} ▾
            </button>
            {panel?.kind === 'export' ? (
              <Popup
                x={panel.x}
                y={panel.y}
                className="chart-card__popup chart-card__popup--export"
                onDismiss={dismissPanel}
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
                    <em className="chart-card__vec">
                      {format.vector ? t('chart.vector') : t('chart.raster')}
                    </em>
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
              </Popup>
            ) : null}
          </div>

          <span className="chart-card__spacer" />
          <span className="chart-card__hint">{t(typeDef.hintKey)}</span>
        </div>

        {/* Plot area.

            The two branches carry explicit `key`s so React cannot recycle one DOM node for
            the other. Without them the node was reused on the plot -> empty transition and
            the text React had just written was wiped by zrender's `SVGPainter.dispose()`
            (`root.innerHTML = ''`), leaving a blank "needs N columns" message. */}
        {drawable ? (
          <div key="plot" className="chart-card__plot" ref={containerRef} />
        ) : (
          <div key="empty" className="chart-card__empty">
            {t('chart.needMoreColumns', { type: t(typeDef.labelKey), n: needed })}
          </div>
        )}

        {/* Column chips + smoothing */}
        <div className="chart-card__footer">
          <div className="chart-card__columns">
            <span className="chart-card__label">{t('chart.columns')}</span>
            {typeDef.columnArity === 'single' && card.config.sources.length > 1 ? (
              <span className="chart-card__note">
                {t('chart.onlyFirstColumn', { name: drawnSources[0]?.label ?? '' })}
              </span>
            ) : null}
            {card.config.sources.map((source) => (
              <span
                key={`${source.matrixId}:${source.columnIndex}`}
                className="chart-card__chip"
                title={source.label}
              >
                {/* A span is required for the ellipsis: `text-overflow` has no effect on
                    an anonymous flex item, so a long label would be cut mid-glyph. */}
                <span className="chart-card__chip-label">{source.label}</span>
                {card.config.sources.length > minimumColumns(card.config.type) ? (
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
              aria-label={t('chart.addColumn')}
              title={t('chart.addColumn')}
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
                  onChange={(event) => {
                    // `min`/`max` on a number input only constrain the spinner, not typing:
                    // 60 used to reach `sgCoefficients` and blow the series up to ±90.
                    const raw = Number(event.target.value);
                    const degree = Number.isFinite(raw)
                      ? Math.min(MAX_SG_DEGREE, Math.max(1, Math.floor(raw)))
                      : 1;
                    setSmoothing(card.id, { ...card.smoothing, degree });
                  }}
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
