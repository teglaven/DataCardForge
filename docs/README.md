# Data Workbench — Data Matrix Workbench

**[English](README.md) | [中文](README.zh-CN.md)**

A lightweight **data matrix batch-processing workbench** for industrial / scientific scenarios.

> ⚠️ **Early Experimental Project**: As of October 2026, this project is still in its **early experimental stage**. You can use it to try out features and test workflows, but it is **strongly not recommended** for production use or formal scientific research.

## Design Philosophy

- **Card model**: everything is a card — data card (file) → function card (transform) → output card (plot / export)
- **Strict separation**: data and behavior are separated; tables are never mutated; every transformation produces a new card
- **Connection subordination**: connections are only the visualization of data dependencies, normally kept low-key (background layer), and never interfere with card layout or interaction — cards are the protagonists, connections the supporting cast
- **Maximum headroom**: the core requirement is not "cheap implementation bought at the price of performance" but **the highest possible fallback capacity — operators never hit a wall, and any degradation / skip / "not possible" must be visible**. Compute tiers (TS → WASM → backend) are an automatic escalation path the operator never chooses; the deciding question is "will the operator hit a wall", not "where is the crossover". Full reasoning: [decision record](docs/decisions/2026-10-15-max-headroom-principle.md)
- **Column-oriented matrix**: rows = samples (`No.N`), columns = variables (`Pos.N`), contiguous storage, high performance
- **Extensible**: computation system + adapter interfaces — the community can contribute long-tail features

## Frontend: Web

> ✅ **Decision of 2026-10-14: the frontend is Web.** The main implementation lives in [`web/`](../web/README.md):
> **React 19 + Vite 8 + TypeScript 7 + ECharts 6 (SVG renderer)**.
> Full rationale, trade-offs and verification are in the [decision record](docs/decisions/2026-10-14-frontend-web-chosen.md).

**Why Web**: the August trade-off study weighted "large-table performance" heavily and treated "vector export" as a *possible* requirement. Re-evaluating flipped those weights — the end goal of scientific/industrial work is a figure that goes into a report, and **SVG vector export** is native on the web while the ImGui route would need a hand-built export pipeline; Chinese IME is the same story. The performance concern did not survive measurement: with virtual scrolling a 10 000-row table renders **23 row nodes**, and ECharts' LTTB downsampling handles 10⁵-point series.

> 🗑️ **The Qt implementation was removed on 2026-10-15.** `src/widgets/`, `ui/`, `i18n/`,
> `imguitest/`, `third_party/`, `CMakeLists.txt` and the whole C++ build tree are gone from the
> working tree; nothing here compiles as C++ any more. The behaviour they encoded — connection
> geometry, red/blue/grey colours, close-protection rules — is now specified by the TypeScript
> sources and their tests, not by a parallel implementation.
>
> The decision to delete (rather than keep as a reference) and the reasoning are recorded in
> [docs/decisions/2026-10-15-qt-implementation-removed.md](docs/decisions/2026-10-15-qt-implementation-removed.md).
> Full history of the C++ code remains recoverable from the pre-removal backup described there.

## Implemented Features (web)

### File Loading
- **File → Open Data Files**, **right-click the empty area**, or **drop files onto the canvas**
- Multiple files create only **one card**; a selector at the top of the card switches the displayed file
- Supports TXT / CSV / TSV / DAT / XLSX; CSV parsing handles quoted fields and sniffs the delimiter
- **Automatic header detection**: if the first row is not purely numeric it is treated as column titles (annotations) rather than data
- File-backed tables start **read-only**; the lock button in the card's file row unlocks editing. Unparseable cells show `—` instead of being silently turned into 0, and a value that is not a number is refused with an explanation rather than dropped
- Parsing runs in a **Web Worker**, so dropping a 10 000-row file no longer freezes the interface (falls back inline where workers are unavailable)
- Re-opening the same file reuses its parse only when the **bytes match** (`size` + `lastModified`); a different file that merely shares the name gets a fresh parse — never stale measurements under a current label

### Plotting (ChartCard)
- Right-click a column header → **pick the chart type directly** (types that would run past the last column are disabled, with the reason in the tooltip)
- **9 scientific/statistical chart types**, all rendered as SVG and therefore **all exportable as true vector**:
  - Line, scatter, **regression** (OLS with slope, **R²** and n)
  - Bar (grouped/stacked), **histogram** (Sturges auto-binning or explicit)
  - **Box plot** (median/quartiles/whiskers + **Tukey outliers**)
  - **Violin plot** (KDE density outline + quartile rules — reveals **bimodality**)
  - **Mean ± error bars** (**SD / SE / 95% CI**, adjustable cap width)
  - **Correlation heatmap** (pairwise **Pearson** matrix, diverging palette)
- The type can be switched at any time inside the card; one chart can hold **several columns** (scatter/regression pair them as (X, Y))
- Log Y axis / second axis / fit line / X-axis source / reset-zoom appear only where the type supports them
- **Smoothing controls** at the bottom: moving average / exponential / median / Savitzky–Golay, redrawing live and keeping their settings when the data source changes
- **Export**: **SVG (true vector — the live DOM tree serialised, no embedded bitmap)** / PNG (1×/2×/4×) / PDF (raster wrapper, explicitly labelled as non-vector in the UI)
- All dependent charts update automatically when the file switches; old data is kept when a column no longer exists
- Zoom / pan (both axes, wheel or drag) with a **Reset zoom** control in the axes panel; legend keeps fit-line names out of it

> The statistics live in `core/stats.ts` as pure functions with 40 unit tests, matching
> NumPy/R conventions (linear-interpolation quantiles, Bessel-corrected variance, Silverman
> bandwidth, t-distribution confidence intervals, Tukey outliers).

### Connection Visualization (ConnectionLayer)
- Red = source table selected; blue = target chart selected; gray = neither selected
- Highlighted lines are thick and **on top** (above the cards); normal lines are thin and gray, below the cards (dual layers)
- Lines track in real time when cards move, resize **or when the table scrolls** (driven by a layout version counter, not a polling timer) — scrolling is what moves a column header, so it invalidates anchors just like a drag does
- When a column scrolls out of the viewport → the line snaps to the left / right edge
- When a column is visible → its header is framed with a semi-transparent box in the current color
- The layer is `pointer-events: none`, so it never steals input or affects layout (the **connection subordination** principle holds by construction)

### UI / Interaction
- Consistent theme with automatic light/dark adaptation
- Cards drag, resize and stack freely, plus **Tile / Cascade / Close All**
- A table that still feeds a chart **refuses to close**, and its connections blink to explain why
- Runtime **Chinese/English switching**, **workspace persistence** (layout + dependencies + data), and CSV export of the current table

## Scope & Limitations

- Internal data is stored as **IEEE 754 double** (~15–17 significant digits), consistent with Excel's native numeric model
- Suitable for batch processing and visualization of **floating-point numeric** data (sensors, measurements, experiments)
- > ⚠️ **Not suitable** for scenarios requiring exact decimal arithmetic (e.g., financial / accounting amounts) or arbitrary-precision computation — Excel and most similar tools cannot satisfy these either

## Tech Stack

| Component | Purpose | Notes |
|-----------|---------|-------|
| React 19 + Vite 8 | UI framework and build | TypeScript 7 `strict` |
| ECharts 6 | Line charts | **SVG renderer**, vector export |
| react-rnd | Card drag / resize | |
| zustand | State (card table + dependency graph) | |
| @e965/xlsx | Excel read | Loaded on demand |
| Hand-rolled virtual scrolling | Large-table rendering | No third-party dependency |
| Web Worker (`src/loaders/parse.worker.ts`) | Off-thread file parsing | Keeps the UI responsive on large files |
| *(not included)* | Eigen / linear algebra | **No longer a dependency** — removed with the C++ tree on 2026-10-15; re-scope only if demand is proven |

## Building

```bash
cd web
npm install
npm run dev        # dev server
npm run build      # type check + production build → web/dist/
npm test           # unit tests (vitest)
```

End-to-end smoke test (run `npm run preview` first):

```bash
node web/scripts/smoke.mjs http://127.0.0.1:4173
```

See [`web/README.md`](../web/README.md) for details.

> The old Qt/CMake build steps are gone with the code they built. If you need to rebuild them,
> recover the pre-removal tree as described in
> [docs/decisions/2026-10-15-qt-implementation-removed.md](docs/decisions/2026-10-15-qt-implementation-removed.md).

## Architecture Extension Points

All extension points are on the web side — there is no second implementation to keep in sync:

- `web/src/loaders/` → adapters for new file formats (`FileLoader`)
- `web/src/core/MatrixData.ts` → internal data model (column-oriented storage)
- `web/src/core/DependencyGraph.ts` + `workspaceStore` → dependency graph, cycle detection, red-blue highlight
- `web/src/ui/ConnectionLayer.tsx` → connection visualization
- `web/src/ui/components/MatrixCard.tsx` / `ChartCard.tsx` → individual cards

## Short-term Goals

> **Current priority: element-wise formula computation + the headroom principle.** The frontend is
> settled and the Qt/Eigen backend is gone, so the next step is decided on the web side alone.
> **The maximum-headroom principle was adopted on 2026-10-15** ([decision record](docs/decisions/2026-10-15-max-headroom-principle.md)):
> the selection question is "will the operator hit a wall", not "where is the crossover" — the tiers
> (TS → WASM → backend) are an automatic escalation path, the backend exists to **remove ceilings**,
> not to be faster, and every degradation must be visible.
> See [docs/log/2026-10-15.md](docs/log/2026-10-15.md).

- [x] **Frontend decision** → **Web chosen** (2026-10-14)
- [x] **Qt implementation removed** → repo is now a single web-first monorepo (2026-10-15)
- [x] **Dependency cycle detection** → `DependencyGraph` refuses loops and deduplicates edges (2026-10-15)
- [ ] **Element-wise formula computation**: evaluate formulas on every matrix element (SUM / AVG / MIN / MAX / IF); more complex logic goes to the **FunctionCard**
- [ ] Compute **fallback tier** (native backend, or WASM): promoted from "unresolved" to **required** by the [maximum-headroom principle](docs/decisions/2026-10-15-max-headroom-principle.md) — it exists to **remove ceilings** (algorithm coverage, memory limits, worst-case compute), not to be faster; the **cross-tier test fixtures must land first** (differential tests before the engine)
- [ ] Data **editing** capability (non-file-backed cards, double-click edit + formula evaluation). Note: `VirtualTable` has the inline-edit branch but `MatrixCard` does not yet pass `onCellChange`, and nothing calls `setCell()` — the path is *not* wired, contrary to earlier notes here
- [ ] Connection arrows / red-blue bidirectional highlight
- [ ] **Selectable X axis**: charts can pick a column as the X-axis source (default remains the row number `No.N`)
- [ ] Batch export (CSV / images / Excel tables) — CSV and single-chart SVG already work
- [x] Scatter, bar and multi-axis charts (delivered with the 9 statistical types, 2026-10-14)
- [ ] **Card beautification**: unify card styling, spacing, colors, and layout
- [ ] CI: typecheck + unit tests + end-to-end smoke (today these run only from one hand-built local environment)

## Long-term Roadmap

> The items below are only directional ideas and may change at any time; if you have suggestions, feel free to open an [issue](https://github.com/teglaven/DataCardForge/issues).

- [ ] **FunctionCard**: feed matrix data into functions written in Python / C++, producing new cards (changes the data flow and determines the persistence format)
- [ ] **ExtensionCard**: a **quick parameter-setting + live-preview** panel dedicated to a specific parent card; can only be created from the parent card and is treated as its child window, closing with it. Solves the "more cards ⇒ more scattered settings" bottleneck (supports wheel-driven fast parameter tweaking + live preview, e.g. segmented-fitting term count, smoothing window, etc.)
- [ ] More smoothing modes; consider supporting smoothing via formula / function cards
- [x] **i18n**: Chinese / English UI switching (implemented in the web frontend)
- [x] **Persistence** of all cards in the main window (web: card layout + dependencies + data)

## Acknowledgements

This project is developed with the assistance of **GitHub Copilot** (an LLM-assisted programming tool). All generated code has been **manually reviewed and tested**.

## License

Data Workbench is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License version 3 (GPL-3.0)**, as published by the Free Software Foundation.

The full license text is available in the [LICENSE](LICENSE) file.

### Third-party licenses

| Dependency | License | Notes |
|-----------|---------|-------|
| React / Vite / ECharts / zustand / react-rnd | MIT / Apache-2.0 | Web frontend dependencies |
| @e965/xlsx | Apache-2.0 | SheetJS community build |
*(The Qt-era dependencies — Qt 6, QCustomPlot, OpenXLSX, fast_float — left the project with the
C++ tree on 2026-10-15 and are no longer shipped or linked.)*
