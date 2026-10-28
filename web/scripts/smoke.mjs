/**
 * End-to-end smoke test for the production build.
 *
 * Boots the built bundle in headless Chromium and exercises the primary user journey
 * the Qt frontend supported:
 *   1. empty workspace renders the entry point, and its「打开数据文件…」button really opens
 *      the file picker and loads the chosen file
 *   2. loading a 10 000-row measurement file creates a table card
 *   3. the virtualized table renders only a window of rows
 *   4. right-clicking a column header offers "draw line chart"
 *   5. the chart card renders an SVG (the vector-export capability)
 *   6. one card-level connection line appears between the table and the chart, colours
 *      the active card (red = source table, blue = target chart), ignores table scrolling,
 *      and the chart's left column dock adds/removes plotted columns
 *   7. closing a depended-on table is refused, then allowed after the chart closes
 *   8. a multi-file card exposes a selector and switching updates dependents
 *   9. the UI switches language at runtime
 *  10. every scientific chart type renders vector geometry
 *  11. SVG / PNG / PDF exports download real, valid files
 *  12. no uncaught runtime errors
 *
 * The bulk of the journey delivers files through the real drag-and-drop path
 * (`CardCanvas` onDrop → `ingestFiles`). The empty-state button is exercised once through
 * `page.waitForEvent('filechooser')`, which intercepts the dialog before Chromium would
 * auto-cancel it — that press used to be swallowed by the canvas pan and shipped a dead
 * button, so it needs its own end-to-end check.
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

  // ── 1b. the empty-state button opens the picker and loads the file ──
  // This is the only path through a native dialog, and it went untested until now: the
  // canvas used to capture the pointer on that press, which retargeted the button's click
  // to the canvas, so the picker never opened. `waitForEvent('filechooser')` also stops
  // Chromium from auto-cancelling the dialog, so the click itself is safe to make.
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 20_000 }).catch(() => null);
  await page.locator('.empty-state__button').click();
  const chooser = await chooserPromise;
  check('empty-state button opens a file chooser', chooser !== null);
  if (chooser) {
    await chooser.setFiles(sampleA);
    await page.waitForSelector('.card--matrix', { timeout: 25_000 });
    check(
      'the picker path loads a table card',
      (await page.locator('.card--matrix').count()) === 1,
    );
    // Tear it down again: step 2 drops the same file and asserts exactly one card.
    await page.locator('.card--matrix .card__close').first().click();
    await page.waitForSelector('.empty-state__button', { timeout: 15_000 });
    check('the picker card closes again', (await page.locator('.card--matrix').count()) === 0);
  }

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

  // ── 6. card-level connection line + active-card colouring ─────────
  await page.waitForSelector('.connection-layer .connection', { timeout: 10_000 });
  const lineCount = await page.locator('.connection-layer .connection').count();
  check(
    'one card-level line links the table card to the chart card',
    lineCount === 1,
    `${lineCount} lines`,
  );

  // Every line is a wire plus exactly one arrowhead on its target anchor (2026-10-28).
  const wireCount = await page.locator('.connection-layer .connection__wire').count();
  const arrowCount = await page.locator('.connection-layer .connection__arrow').count();
  check(
    'each connection carries one wire and one arrowhead',
    wireCount === lineCount && arrowCount === lineCount,
    `${wireCount} wires / ${arrowCount} arrows / ${lineCount} lines`,
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

  // ── 6b. the line is card-level: table scrolling must NOT move it ──
  // The line anchors at the card's top centre. It used to be glued to a column header,
  // so scrolling the table moved it — that coupling is exactly what this guards against.
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
    'horizontal table scroll leaves the card-level line untouched',
    typeof lineStartBefore === 'string' &&
      typeof lineStartAfter === 'string' &&
      lineStartBefore === lineStartAfter,
    `path unchanged: ${lineStartBefore === lineStartAfter}`,
  );

  // A column scrolled fully out of view must not change anything either.
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
  const scrolledLineCount = await page.locator('.connection-layer .connection').count();
  check(
    'off-screen columns keep exactly one card-level line',
    snappedPath === lineStartBefore && scrolledLineCount === 1,
    `unchanged: ${snappedPath === lineStartBefore}, ${scrolledLineCount} lines`,
  );

  await page
    .locator('.vtable__viewport')
    .first()
    .evaluate((el) => {
      el.scrollLeft = 0;
    });
  await page.waitForTimeout(200);

  // ── 6c. the collapsible column dock picks columns to plot ─────────────
  const chipsBefore = await page.locator('.chart-card__chip').count();
  await page.locator('.chart-card__dock-toggle').click();
  await page.waitForSelector('.chart-card__dock--open', { timeout: 5_000 });
  check('column dock opens from the chart card rail', true);

  await page.locator('.chart-card__dock-item input[type="checkbox"]').nth(1).check();
  await page.waitForTimeout(300);
  const chipsAfterCheck = await page.locator('.chart-card__chip').count();
  check(
    'checking a dock column adds it to the chart',
    chipsAfterCheck === chipsBefore + 1,
    `${chipsBefore} -> ${chipsAfterCheck} chips`,
  );
  const dockLineCount = await page.locator('.connection-layer .connection').count();
  check('a second column of the same table adds no extra line', dockLineCount === 1, `${dockLineCount} lines`);

  await page.locator('.chart-card__dock-item input[type="checkbox"]').nth(1).uncheck();
  await page.waitForTimeout(300);
  const chipsAfterUncheck = await page.locator('.chart-card__chip').count();
  check(
    'unchecking the dock column removes it again',
    chipsAfterUncheck === chipsBefore,
    `${chipsAfterUncheck} chips`,
  );

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

  // ── 11b. a formula card on a real table ─────────────────────────────
  // Both defects this covers were invisible to the rest of the suite: an annotated table
  // had no column name that resolved at all (the formula card was a dead end on any file
  // with a header), and once it did compute, the result grid's flex basis squeezed the
  // formula zone to ~11 px so the expression row vanished exactly when there was a number
  // to look at. No other check creates a formula card.
  await page.locator('.vtable__colhead').first().click({ button: 'right' });
  await page.waitForSelector('.context-menu', { timeout: 5_000 });
  await page
    .locator('.context-menu__item')
    .filter({ hasText: /New Formula Card|新建公式卡/ })
    .first()
    .click();
  await page.waitForSelector('.card--formula', { timeout: 15_000 });
  const exprInput = page.locator('.formula-card__expr').first();
  await exprInput.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1_500);
  const exprBox = await exprInput.boundingBox();
  check(
    'formula zone keeps its expression row visible beside the result grid',
    Boolean(exprBox && exprBox.height >= 12 && exprBox.width > 40),
    JSON.stringify(exprBox),
  );
  const formulaErrors = await page.locator('.formula-card__error').allInnerTexts();
  check(
    'formula card computes without a definition error',
    formulaErrors.length === 0,
    formulaErrors.join(' | '),
  );
  const formulaBadge = (await page.locator('.card--formula .card__badge').first().innerText()).trim();
  check(
    'formula card produced a result column',
    /\d+\s*columns?/i.test(formulaBadge) && !/\b0\s*columns?/i.test(formulaBadge),
    formulaBadge,
  );
  // `Pos.N` is the documented spelling when a column name cannot be typed (it contains
  // "/" or spaces), so it has to compute end to end.
  await exprInput.click();
  await exprInput.fill('Pos.1 * 2');
  await page.waitForTimeout(1_500);
  const posErrors = await page.locator('.formula-card__error').allInnerTexts();
  check('a Pos.N reference computes', posErrors.length === 0, posErrors.join(' | '));

  // ── 11c. the pending re-point offer must be impossible to miss ──────
  // v2 never re-points a function card silently, so a file switch leaves a decision the
  // user has to make. It used to be a pale accent-coloured box, and users walked past it —
  // the report was literally "I switched the file and the function card did not follow".
  // Its look is therefore a contract: yellow gradient + flashing, asserted as two separate
  // halves (a gradient without motion, or motion over the wrong colour, each fails).
  const fileSelector = page.locator('.matrix-card__selector').first();
  const activeFileIndex = await page.evaluate(() => {
    const select = document.querySelector('.matrix-card__selector');
    return select ? select.selectedIndex : -1;
  });
  const otherFileIndex = activeFileIndex === 0 ? 1 : 0;
  await fileSelector.selectOption({ index: otherFileIndex });
  await page.waitForTimeout(600);
  check(
    'switching the file offers a re-point on the dependent formula card',
    await page
      .locator('.card--formula .formula-card__repoint')
      .isVisible()
      .catch(() => false),
  );

  const offerLook = await page.evaluate(() => {
    const box = document.querySelector('.card--formula .formula-card__repoint');
    if (!box) return null;
    const style = getComputedStyle(box);
    // "Yellow" as a measurement, not an opinion: every gradient stop's hue must sit in the
    // amber band (35°–70°) with real saturation. The stops are resolved rgb() after var()
    // substitution, so this reads the theme that is actually in force.
    const stops = [...style.backgroundImage.matchAll(/rgba?\(([^)]+)\)/g)].map((match) => {
      const [r, g, b] = match[1]
        .split(',')
        .slice(0, 3)
        .map(Number)
        .map((value) => value / 255);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      if (delta === 0) return { hue: 0, sat: 0 };
      const raw =
        max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
      return { hue: (raw * 60 + 360) % 360, sat: max === 0 ? 0 : delta / max };
    });
    return {
      gradient: /linear-gradient/.test(style.backgroundImage),
      stops,
      animation: style.animationName,
      duration: parseFloat(style.animationDuration),
    };
  });
  check(
    'the offer sits on a yellow gradient',
    Boolean(offerLook?.gradient) &&
      offerLook.stops.length >= 2 &&
      offerLook.stops.every((stop) => stop.hue >= 35 && stop.hue <= 70 && stop.sat >= 0.25),
    JSON.stringify(offerLook?.stops),
  );
  check(
    'the offer flashes',
    offerLook?.animation === 'repoint-flash' && offerLook.duration > 0,
    JSON.stringify({ animation: offerLook?.animation, duration: offerLook?.duration }),
  );

  // The flash must not be the only thing carrying the box: under reduced motion the yellow
  // and a static ring stay, and only the animation goes — otherwise the accessibility
  // setting would erase the one affordance asking for a decision.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(250);
  const reducedOffer = await page.evaluate(() => {
    const box = document.querySelector('.card--formula .formula-card__repoint');
    if (!box) return null;
    const style = getComputedStyle(box);
    return {
      animation: style.animationName,
      gradient: /linear-gradient/.test(style.backgroundImage),
      ring: style.boxShadow,
    };
  });
  await page.emulateMedia({ reducedMotion: null });
  check(
    'reduced motion keeps the yellow offer and only stops the flashing',
    reducedOffer !== null &&
      reducedOffer.animation === 'none' &&
      reducedOffer.gradient &&
      reducedOffer.ring !== 'none',
    JSON.stringify(reducedOffer),
  );

  // …and the decision really is pending, not sticky: pointing the card at the file the
  // table already shows retires the offer.
  await fileSelector.selectOption({ index: activeFileIndex });
  await page.waitForTimeout(400);
  check(
    'the offer retires once the card already reads the active file',
    (await page.locator('.formula-card__repoint').count()) === 0,
  );

  // The reported failure: after 视图 → 平铺 the card becomes viewport-sized, and the result
  // grid (whose flex basis is its own content height) used to squeeze the formula zone to
  // ~11 px — the editor was gone exactly when the card was big enough to be useful.
  await page.locator('.menubar__trigger').nth(1).click();
  await page.waitForSelector('.menubar__item', { timeout: 5_000 });
  await page
    .locator('.menubar__item')
    .filter({ hasText: /Tile|平铺/ })
    .first()
    .click();
  await page.waitForTimeout(800);
  const zones = await page.evaluate(() => {
    const formulas = document.querySelector('.formula-card__formulas');
    const outputs = document.querySelector('.formula-card__outputs');
    const expr = document.querySelector('.formula-card__expr');
    const f = formulas.getBoundingClientRect();
    const o = outputs.getBoundingClientRect();
    return {
      formulasH: Math.round(f.height),
      overlap: Math.round(f.bottom - o.top),
      exprH: expr ? Math.round(expr.getBoundingClientRect().height) : -1,
    };
  });
  check(
    'a tiled (viewport-sized) card keeps the formula zone above the result grid',
    zones.formulasH >= 40 && zones.overlap <= 1 && zones.exprH >= 12,
    JSON.stringify(zones),
  );

  await page.locator('.card--formula .card__close').first().click();
  await page.waitForTimeout(400);

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
