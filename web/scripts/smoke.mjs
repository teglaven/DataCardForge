/**
 * End-to-end smoke test for the production build.
 *
 * Boots the built bundle in headless Chromium and exercises the primary user journey
 * the Qt frontend supported:
 *   1. empty workspace renders the entry point
 *   2. loading a 10 000-row measurement file creates a table card
 *   3. the virtualized table renders only a window of rows
 *   4. right-clicking a column header offers "draw line chart"
 *   5. the chart card renders an SVG (the vector-export capability)
 *   6. a connection line appears between the table column and the chart and follows
 *      the active card (red = source table, blue = target chart)
 *   7. closing a depended-on table is refused, then allowed after the chart closes
 *   8. a multi-file card exposes a selector and switching updates dependents
 *   9. the UI switches language at runtime
 *  10. every scientific chart type renders vector geometry
 *  11. SVG / PNG / PDF exports download real, valid files
 *  12. no uncaught runtime errors
 *
 * Files are delivered through the real drag-and-drop path rather than the file picker:
 * a headless browser auto-cancels the native open dialog, and a synthetic drop also
 * exercises a genuine code path (`CardCanvas` onDrop → `ingestFiles`).
 *
 * Usage: node scripts/smoke.mjs [baseUrl]
 * Env: LD_LIBRARY_PATH / FONTCONFIG_PATH / PLAYWRIGHT_BROWSERS_PATH as needed.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const baseUrl = process.argv[2] ?? process.env.BASE_URL ?? 'http://127.0.0.1:5199';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const sampleA = path.join(repoRoot, 'docs', 'sampleData', '1.txt');
const sampleB = path.join(repoRoot, 'docs', 'sampleData', '2.txt');

const results = [];
let failures = 0;

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Read sample files into the page and dispatch a real drop event on the canvas. */
async function dropFilesOnCanvas(page, absolutePaths) {
  const payload = absolutePaths.map((filePath) => ({
    name: path.basename(filePath),
    base64: fs.readFileSync(filePath).toString('base64'),
  }));

  await page.evaluate((files) => {
    const canvas = document.querySelector('.canvas');
    if (!canvas) throw new Error('canvas not found');

    const dataTransfer = new DataTransfer();
    for (const file of files) {
      const binary = atob(file.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      dataTransfer.items.add(new File([bytes], file.name, { type: 'text/plain' }));
    }

    const rect = canvas.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      dataTransfer,
    };

    canvas.dispatchEvent(new DragEvent('dragenter', base));
    canvas.dispatchEvent(new DragEvent('dragover', base));
    canvas.dispatchEvent(new DragEvent('drop', base));
  }, payload);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
const workerUrls = [];
page.on('worker', (worker) => workerUrls.push(worker.url()));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

try {
  // ── 1. boot ─────────────────────────────────────────────────────────
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('.app', { timeout: 15_000 });
  check('app shell mounts', (await page.locator('.app').count()) === 1);
  check('empty state is offered', await page.locator('.empty-state').isVisible());

  const title = await page.title();
  check('document title is localised', title.includes('Data Workbench'), title);
  check('menus are rendered', (await page.locator('.menubar__trigger').count()) >= 3);

  // ── 2. load a real 10 000 × 10 measurement file ──────────────────────
  await dropFilesOnCanvas(page, [sampleA]);
  await page.waitForSelector('.card--matrix', { timeout: 25_000 });
  check('matrix card appears after a file drop', (await page.locator('.card--matrix').count()) === 1);

  const badge = await page.locator('.card--matrix .card__badge').first().innerText();
  check(
    'card reports 10000 rows and 10 cols',
    /10000/.test(badge) && /\b10\b/.test(badge),
    badge,
  );

  // Parsing runs in a dedicated worker since 2026-10-15 (fix F). If it silently fell
  // back to the main thread the app would still work — but freeze on big files — so
  // assert the off-thread path is really taken.
  check(
    'file parsing happened in a worker, not on the main thread',
    workerUrls.some((url) => /parse\.worker/.test(url)),
    workerUrls.map((u) => u.split('/').pop()).join(', ') || 'no worker spawned',
  );

  await page.waitForSelector('.vtable__colhead', { timeout: 10_000 });
  const headerCount = await page.locator('.vtable__colhead').count();
  check('ten column headers are rendered', headerCount === 10, `${headerCount} headers`);

  const headerText = (await page.locator('.vtable__colhead').first().innerText()).trim();
  check('column header uses Pos.N naming', headerText === 'Pos.1', headerText);

  // ── 3. virtualization keeps the DOM small ───────────────────────────
  const renderedRows = await page.locator('.vtable__row').count();
  check(
    'virtualized table renders a window, not 10 000 rows',
    renderedRows > 0 && renderedRows < 200,
    `${renderedRows} rows in DOM`,
  );

  const firstCell = (await page.locator('.vtable__row .vtable__cell').first().innerText()).trim();
  check('numeric cell is formatted with finite digits', /^-?\d/.test(firstCell), firstCell);

  // Scrolling the body must reveal later rows (proves the virtual window moves).
  const rowHeaderBefore = (await page.locator('.vtable__rowhead').first().innerText()).trim();
  await page.locator('.vtable__viewport').first().evaluate((el) => {
    el.scrollTop = 5000;
  });
  await page.waitForTimeout(300);
  const rowHeaderAfter = (await page.locator('.vtable__rowhead').first().innerText()).trim();
  check(
    'scrolling advances the virtual window',
    rowHeaderBefore !== rowHeaderAfter,
    `${rowHeaderBefore} -> ${rowHeaderAfter}`,
  );

  // ── 4. right-click a column header -> chart ─────────────────────────
  await page.locator('.vtable__colhead').nth(2).click({ button: 'right' });
  await page.waitForSelector('.context-menu', { timeout: 5_000 });
  const menuText = await page.locator('.context-menu').innerText();
  check('context menu offers a line chart for that column', /Pos\.3/.test(menuText), menuText);

  await page.locator('.context-menu').click();
  await page.waitForSelector('.card--chart', { timeout: 15_000 });
  check('chart card is created', (await page.locator('.card--chart').count()) === 1);

  // ── 5. ECharts renders vector output ────────────────────────────────
  await page.waitForSelector('.card--chart svg', { timeout: 25_000 });
  const svgPaths = await page.locator('.card--chart svg path').count();
  check('chart renders SVG geometry (vector renderer)', svgPaths > 0, `${svgPaths} paths`);

  const seriesPaths = await page.locator('.card--chart svg path[stroke]').count();
  check('chart strokes the data series', seriesPaths > 0, `${seriesPaths} stroked paths`);

  const chartBadge = await page.locator('.card--chart .card__badge').first().innerText();
  check('chart reports its point count', /10000/.test(chartBadge), chartBadge);

  // ── 6. connection line + active-card colouring ──────────────────────
  await page.waitForSelector('.connection-layer .connection', { timeout: 10_000 });
  check(
    'a connection line links the table column to the chart',
    (await page.locator('.connection-layer .connection').count()) >= 1,
  );

  const blueStroke = await page
    .locator('.connection-layer .connection--fg path')
    .first()
    .getAttribute('stroke');
  // Right after creation the chart is the active card -> blue (target selected).
  check('active chart highlights its line in blue', blueStroke === 'rgb(40, 120, 220)', String(blueStroke));

  await page.locator('.card--matrix .card__titlebar').first().click();
  await page.waitForTimeout(250);
  const redStroke = await page
    .locator('.connection-layer .connection--fg path')
    .first()
    .getAttribute('stroke');
  check('active table highlights the line in red', redStroke === 'rgb(200, 50, 50)', String(redStroke));

  // ── 6b. scrolling a table must move its connection anchors (fix A) ───
  // The line is anchored to a *column header* inside a scrollable viewport. Reading the
  // anchor happens against live DOM, so scrolling has to bump the layout version or the
  // path keeps pointing at where the header used to be.
  const lineStartBefore = await page
    .locator('.connection-layer .connection--fg path')
    .first()
    .getAttribute('d');
  await page
    .locator('.vtable__viewport')
    .first()
    .evaluate((el) => {
      el.scrollLeft = 260;
    });
  await page.waitForTimeout(350);
  const lineStartAfter = await page
    .locator('.connection-layer .connection--fg path')
    .first()
    .getAttribute('d');
  check(
    'horizontal table scroll moves the connection anchor',
    typeof lineStartBefore === 'string' &&
      typeof lineStartAfter === 'string' &&
      lineStartBefore !== lineStartAfter,
    `path changed: ${lineStartBefore !== lineStartAfter}`,
  );

  // Scrolling a column fully out of view must snap the line to an edge, not lose it.
  await page
    .locator('.vtable__viewport')
    .first()
    .evaluate((el) => {
      el.scrollLeft = 4000;
    });
  await page.waitForTimeout(350);
  const snappedPath = await page
    .locator('.connection-layer .connection--fg path')
    .first()
    .getAttribute('d');
  check(
    'off-screen column keeps its line pinned instead of dropping it',
    typeof snappedPath === 'string' && snappedPath.length > 0,
    `${String(snappedPath).slice(0, 28)}…`,
  );

  await page
    .locator('.vtable__viewport')
    .first()
    .evaluate((el) => {
      el.scrollLeft = 0;
    });
  await page.waitForTimeout(200);

  // Deselecting both must drop the line back to the grey background layer.
  await page.locator('.menubar__brand').click();
  await page.locator('.canvas').click({ position: { x: 8, y: 8 } });
  await page.waitForTimeout(250);
  const greyCount = await page.locator('.connection-layer .connection--bg path').count();
  check('unselected cards fall back to the grey background layer', greyCount >= 1, `${greyCount}`);

  // ── 7. close rules ──────────────────────────────────────────────────
  await page.locator('.card--matrix .card__close').first().click();
  await page.waitForTimeout(400);
  check(
    'table cannot be closed while a chart depends on it',
    (await page.locator('.card--matrix').count()) === 1,
  );
  const status = await page.locator('.statusbar__message').innerText();
  check('status bar explains the refusal', /依赖|depend/i.test(status), status);

  await page.locator('.card--chart .card__close').first().click();
  await page.waitForTimeout(400);
  check('chart card closes', (await page.locator('.card--chart').count()) === 0);

  await page.locator('.card--matrix .card__close').first().click();
  await page.waitForTimeout(400);
  check('table closes once nothing depends on it', (await page.locator('.card--matrix').count()) === 0);
  check('empty state returns', await page.locator('.empty-state').isVisible());

  // ── 8. multi-file card + file switching ─────────────────────────────
  await dropFilesOnCanvas(page, [sampleA, sampleB]);
  await page.waitForSelector('.card--matrix', { timeout: 25_000 });
  await page.waitForTimeout(800);

  const selectors = await page.locator('.matrix-card__selector').count();
  check('multi-file card shows a file selector', selectors === 1, `${selectors} selectors`);

  const options = await page
    .locator('.matrix-card__selector option')
    .allInnerTexts();
  check('both file names are listed', options.length === 2, options.join(', '));

  // Chart column 0 of file 1, then switch to file 2 and confirm the line follows.
  await page.locator('.vtable__colhead').first().click({ button: 'right' });
  await page.waitForSelector('.context-menu', { timeout: 5_000 });
  await page.locator('.context-menu').click();
  await page.waitForSelector('.card--chart svg', { timeout: 25_000 });

  const firstY = await readFirstSeriesPoint(page);
  await page.locator('.matrix-card__selector').selectOption({ index: 1 });
  await page.waitForTimeout(700);
  const secondY = await readFirstSeriesPoint(page);
  check(
    'switching the active file updates the dependent chart',
    firstY !== null && secondY !== null && firstY !== secondY,
    `${String(firstY)} -> ${String(secondY)}`,
  );

  // ── 9. i18n switch ──────────────────────────────────────────────────
  // The browser reports en-US, so the app starts in English; switch to Chinese and
  // confirm the menus re-render, then switch back.
  const beforeSwitch = await page.locator('.menubar__trigger').first().innerText();
  await page.locator('.menubar__trigger').nth(2).click();
  await page.locator('.menubar__item', { hasText: '中文' }).click();
  await page.waitForTimeout(300);
  const chinese = await page.locator('.menubar__trigger').first().innerText();
  check(
    'language switch renders the Chinese UI',
    chinese === '文件',
    `${beforeSwitch} -> ${chinese}`,
  );

  await page.locator('.menubar__trigger').nth(2).click();
  await page.locator('.menubar__item', { hasText: 'English' }).click();
  await page.waitForTimeout(300);
  const english = await page.locator('.menubar__trigger').first().innerText();
  check('language switch renders the English UI', english === 'File', chinese + ' -> ' + english);

  // ── 10. every scientific chart type renders ─────────────────────────
  // The toolbar selector is the user-facing path; each type is switched in turn and its
  // real SVG output is inspected, so a type that silently draws nothing is caught.
  await page.locator('.chart-card__tbutton').first().click();
  const typeButtons = page.locator('.chart-card__popup-item');
  const typeCount = await typeButtons.count();
  check('chart type selector lists every type', typeCount >= 9, `${typeCount} types`);

  // Close the popup again; each iteration re-opens it.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  const typeReports = [];
  for (let index = 0; index < typeCount; index += 1) {
    await page.locator('.chart-card__tbutton').first().click();
    await page.waitForSelector('.chart-card__popup-item', { timeout: 5000 });
    const label = (await page.locator('.chart-card__popup-item').nth(index).innerText()).trim();
    await page.locator('.chart-card__popup-item').nth(index).click();
    await page.waitForTimeout(700);

    const report = await page.evaluate(() => {
      const container = document.querySelector('.chart-card__plot');
      if (!container) return { ok: false, reason: 'no plot container' };
      const svg = container.querySelector('svg');
      if (!svg) return { ok: false, reason: 'no svg (canvas renderer?)' };
      const echarts = window.echarts;
      const instance = echarts ? echarts.getInstanceByDom(container) : null;
      const option = instance ? instance.getOption() : null;
      return {
        ok: true,
        width: svg.clientWidth,
        height: svg.clientHeight,
        paths: svg.querySelectorAll('path').length,
        texts: svg.querySelectorAll('text').length,
        rects: svg.querySelectorAll('rect').length,
        circles: svg.querySelectorAll('circle').length,
        polygons: svg.querySelectorAll('polygon').length,
        lines: svg.querySelectorAll('line').length,
        seriesTypes: option ? option.series.map((s) => s.type) : [],
        seriesCount: option ? option.series.length : 0,
      };
    });

    if (!report.ok) {
      check(`type ${index + 1} (${label}) renders an SVG`, false, report.reason);
      typeReports.push(`${label}: FAIL(${report.reason})`);
      continue;
    }

    check(
      `type ${index + 1} (${label}) renders vector geometry`,
      report.paths > 0 && report.width > 50 && report.height > 50,
      `${report.paths} paths, ${report.texts} texts, ${report.polygons}p/${report.lines}l/${report.rects}r, series=[${report.seriesTypes}]`,
    );
    typeReports.push(`${label}: ${report.seriesTypes.join('+') || '—'}`);
  }

  // The hand-rendered types must actually emit their primitives. Counting SVG tags is
  // unreliable (ECharts emits a `<path>` for polygons, lines and rects alike), so this
  // inspects ZRender's display list, which knows each element's real shape.
  const violinReport = await switchToType(page, 'Violin');
  check(
    'violin draws a density polygon and three quartile rules',
    violinReport.shapes.polygon >= 1 && violinReport.shapes.line >= 3,
    JSON.stringify(violinReport.shapes),
  );

  const errorReport = await switchToType(page, 'Mean');
  check(
    'error bars draw stems, caps and markers',
    errorReport.shapes.line >= 3 && errorReport.shapes.circle >= 1,
    JSON.stringify(errorReport.shapes),
  );

  const heatmapReport = await switchToType(page, 'Correlation');
  check(
    'correlation heatmap draws a grid of cells',
    heatmapReport.shapes.rect >= 4,
    JSON.stringify(heatmapReport.shapes),
  );

  const boxReport = await switchToType(page, 'Box');
  check(
    'box plot draws boxes and a median line',
    boxReport.shapes.boxLike >= 1 && boxReport.shapes.line >= 1,
    JSON.stringify(boxReport.shapes),
  );

  const regressionReport = await switchToType(page, 'Regression');
  const regressionSeries = regressionReport.seriesTypes.join(',');
  check(
    'regression draws scatter plus a fit line',
    regressionSeries.includes('scatter') && regressionSeries.includes('line'),
    regressionSeries,
  );

  const histogramReport = await switchToType(page, 'Histogram');
  check(
    'histogram draws binned bars',
    histogramReport.seriesTypes.includes('bar') && histogramReport.shapes.rect >= 1,
    `${histogramReport.seriesTypes.join(',')} / ${JSON.stringify(histogramReport.shapes)}`,
  );

  // A log axis must actually reach the ECharts model, not just the checkbox.
  await switchToType(page, 'Line');
  await page.locator('.chart-card__tbutton').nth(1).click();
  await page.waitForSelector('.chart-card__popup--wide', { timeout: 5000 });
  await page.locator('.chart-card__popup--wide input[type="checkbox"]').first().check();
  await page.waitForTimeout(400);
  const axisTypes = await page.evaluate(() => {
    const container = document.querySelector('.chart-card__plot');
    const instance = container && window.echarts ? window.echarts.getInstanceByDom(container) : null;
    const option = instance ? instance.getOption() : null;
    const y = option ? option.yAxis : [];
    return y.map((axis) => axis.type);
  });
  check('log Y axis reaches the chart model', axisTypes.includes('log'), axisTypes.join(','));
  await page.keyboard.press('Escape');

  // Leave the card showing a line chart for the export checks below.
  await switchToType(page, 'Line');

  // ── 11. vector / raster export produces real files ──────────────────
  const exportDir = path.join(here, '..', '.smoke-downloads');
  fs.rmSync(exportDir, { recursive: true, force: true });
  fs.mkdirSync(exportDir, { recursive: true });

  const svgPath = await exportViaMenu(page, 0, exportDir, 'Chart.svg');
  check('SVG export downloads a file', svgPath !== null, String(svgPath));
  if (svgPath) {
    const svgText = fs.readFileSync(svgPath, 'utf8');
    check('exported SVG is a valid vector document', svgText.startsWith('<?xml') && svgText.includes('<svg'), `${svgText.length} bytes`);
    check(
      'exported SVG keeps vector geometry (paths/text)',
      /<path|<polygon|<rect|<line/.test(svgText) && /<text/.test(svgText),
      `${(svgText.match(/<path/g) || []).length} <path>`,
    );
    check('exported SVG embeds no raster image', !/<image[^>]+base64/.test(svgText));
  }

  const pdfPath = await exportViaMenu(page, 1, exportDir, 'Chart.pdf');
  check('PDF export downloads a file', pdfPath !== null, String(pdfPath));
  if (pdfPath) {
    const pdf = fs.readFileSync(pdfPath);
    check(
      'exported PDF has a valid header and trailer',
      pdf.subarray(0, 5).toString('latin1') === '%PDF-' &&
        pdf.subarray(-1024).toString('latin1').includes('%%EOF'),
      `${pdf.length} bytes`,
    );
    const pdfText = pdf.toString('latin1');
    check(
      'exported PDF contains a page and an image object',
      /\/Type \/Page[^s]/.test(pdfText) && /\/Subtype \/Image/.test(pdfText),
      pdfText.includes('/SMask') ? 'with alpha' : 'opaque',
    );
  }

  const pngPath = await exportViaMenu(page, 2, exportDir, 'Chart.png');
  check('PNG export downloads a file', pngPath !== null, String(pngPath));
  if (pngPath) {
    const png = fs.readFileSync(pngPath);
    const signature = png.subarray(0, 8).toString('hex');
    check(
      'exported PNG has a valid signature and IHDR',
      signature === '89504e470d0a1a0a' && png.subarray(12, 16).toString('latin1') === 'IHDR',
      `${png.length} bytes`,
    );
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    check(
      'exported PNG is rendered at the selected pixel ratio',
      width > 800 && height > 400,
      `${width}×${height}`,
    );
  }

  // ── 12. no runtime errors ───────────────────────────────────────────
  const realErrors = consoleErrors.filter(
    (text) => !/favicon|ResizeObserver loop/i.test(text),
  );
  check('no uncaught runtime errors', realErrors.length === 0, realErrors.slice(0, 4).join(' | '));

  await page.screenshot({ path: path.join(here, '..', 'smoke-screenshot.png') });
} catch (error) {
  failures += 1;
  results.push(`FAIL  harness threw — ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await browser.close();
}

/**
 * First y value of the plotted series, read back from the live ECharts instance so the
 * test compares real data rather than pixels. The chart component exposes the
 * lazily-imported module on `window.echarts` for exactly this kind of check.
 */
async function readFirstSeriesPoint(page) {
  return page.evaluate(() => {
    const container = document.querySelector('.chart-card__plot');
    const echarts = window.echarts;
    if (!container || !echarts) return null;
    const instance = echarts.getInstanceByDom(container);
    if (!instance) return null;
    const first = instance.getOption()?.series?.[0]?.data?.[0];
    if (Array.isArray(first)) return first[1];
    if (first && typeof first === 'object' && 'value' in first) {
      const value = first.value;
      return Array.isArray(value) ? value[1] : null;
    }
    return typeof first === 'number' ? first : null;
  });
}

/**
 * Switch the active chart card to the type whose label contains `labelPart`,
 * then report the SVG primitives it produced.
 */
async function switchToType(page, labelPart) {
  await page.locator('.chart-card__tbutton').first().click();
  await page.waitForSelector('.chart-card__popup-item', { timeout: 5000 });
  const items = page.locator('.chart-card__popup-item');
  const count = await items.count();
  for (let i = 0; i < count; i += 1) {
    const text = await items.nth(i).innerText();
    if (text.toLowerCase().includes(labelPart.toLowerCase())) {
      await items.nth(i).click();
      break;
    }
  }
  await page.waitForTimeout(700);
  return page.evaluate(() => {
    const container = document.querySelector('.chart-card__plot');
    const svg = container ? container.querySelector('svg') : null;
    const echarts = window.echarts;
    const instance = echarts && container ? echarts.getInstanceByDom(container) : null;
    const option = instance ? instance.getOption() : null;

    // ZRender's display list exposes each drawn element and its true shape, which is
    // what we want: ECharts serialises polygons/lines/rects all as `<path>`.
    const shapes = { polygon: 0, line: 0, rect: 0, boxLike: 0, circle: 0, other: 0 };
    const display = instance ? instance.getZr().storage.getDisplayList(true) : [];
    for (const element of display) {
      const type = element.type;
      const shape = element.shape || {};
      if (type === 'polygon') shapes.polygon += 1;
      else if (type === 'line') shapes.line += 1;
      else if (type === 'circle') shapes.circle += 1;
      else if (type === 'rect' || (typeof shape.width === 'number' && typeof shape.height === 'number')) {
        shapes.rect += 1;
      } else if (typeof shape.width === 'number' && Array.isArray(shape.points) === false && 'height' in shape) {
        shapes.boxLike += 1;
      } else {
        // Boxplot bodies and heatmap cells both arrive as path-shaped rectangles.
        if (typeof shape.width === 'number' || Array.isArray(shape.points)) shapes.boxLike += 1;
        else shapes.other += 1;
      }
    }

    return {
      shapes,
      paths: svg ? svg.querySelectorAll('path').length : 0,
      texts: svg ? svg.querySelectorAll('text').length : 0,
      seriesTypes: option ? option.series.map((s) => s.type) : [],
    };
  });
}

/**
 * Open the export menu, choose the item at `itemIndex`, and capture the downloaded file.
 * Returns the saved path, or null when no download happened.
 */
async function exportViaMenu(page, itemIndex, dir, fallbackName) {
  await page.locator('.chart-card__tbutton').nth(2).click();
  await page.waitForSelector('.chart-card__popup--export', { timeout: 5000 });
  const items = page.locator('.chart-card__popup--export .chart-card__popup-item');
  const count = await items.count();
  if (itemIndex >= count) return null;

  const downloadPromise = page.waitForEvent('download', { timeout: 20_000 }).catch(() => null);
  await items.nth(itemIndex).click();
  const download = await downloadPromise;
  if (!download) return null;

  const suggested = download.suggestedFilename() || fallbackName;
  const target = path.join(dir, suggested);
  await download.saveAs(target);
  return fs.existsSync(target) ? target : null;
}

const report = results.join('\n');
fs.writeFileSync(path.join(here, '..', 'smoke-report.txt'), report + '\n');
console.log(report);
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
