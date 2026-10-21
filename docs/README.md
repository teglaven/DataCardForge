# Data Workbench — Data Matrix Workbench

**[English](README.md) | [中文](README.zh-CN.md)**

A lightweight **data matrix batch-processing workbench** for industrial / scientific scenarios.

> ⚠️ **Early Experimental Project**: As of October 2026, this project is still in its **early experimental stage**. You can use it to try out features and test workflows, but it is **strongly not recommended** for production use or formal scientific research.

## Design Philosophy

- **Card model**: everything is a card — data card (file) → function card (transform) → output card (plot / export)
- **Strict separation**: data and behavior are separated; tables are never mutated; every transformation produces a new card
- **Connection subordination**: connections are only the visualization of data dependencies, normally kept low-key (background layer), and never interfere with card layout or interaction — cards are the protagonists, connections the supporting cast
- **Backend-owns-compute (B-plan)**: all numeric / statistical / matrix computation runs in the **C++/Eigen backend**; the browser is a **pure interaction surface** (rendering, input, layout). The backend being unreachable is a **visible state with a retry button**, never silent. This supersedes the earlier T1-browser-baseline tier table while preserving the three contracts of the [maximum-headroom principle](docs/decisions/2026-10-15-max-headroom-principle.md): visible degradation, cross-tier semantic consistency (differential fixtures), bounded worst-case. Full reasoning: [decision record](docs/decisions/2026-10-17-backend-owns-compute.md)
- **Column-oriented matrix**: rows = samples (`No.N`), columns = variables (`Pos.N`), contiguous storage, high performance
- **Extensible**: computation system + adapter interfaces — the community can contribute long-tail features

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Browser (Web)                     │
│  React 19 · ECharts 6 · zustand · VirtualTable      │
│  Card layout · Ports · Connections · Status lamps   │
│  Pure interaction — NO numeric computation          │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP + JSON + DCM1 binary
                       ▼
┌─────────────────────────────────────────────────────┐
│              Compute Backend (C++17)                │
│  Eigen 3.4 · Expression engine · Dependency graph   │
│  Matrix store · Node scheduler · Event bus          │
│  All numeric / statistical / matrix computation     │
└─────────────────────────────────────────────────────┘
```

The frontend speaks [protocol v1](docs/architecture/backend-protocol-v1.md): JSON control messages over HTTP plus DCM1 binary frames for matrix windows. Long-poll event stream pushes node state changes (dirty → computing → done | error) to drive the four-state status lamps.

## Implemented Features

### File Loading
- **File → Open Data Files**, **right-click the empty area**, or **drop files onto the canvas**
- Multiple files create only **one card**; a selector at the top of the card switches the displayed file
- Supports TXT / CSV / TSV / DAT / XLSX; CSV parsing handles quoted fields and sniffs the delimiter
- **Automatic header detection**: if the first row is not purely numeric it is treated as column titles (annotations) rather than data
- File-backed tables start **read-only**; the lock button in the card's file row unlocks editing. Unparseable cells show `—` instead of being silently turned into 0, and a value that is not a number is refused with an explanation rather than dropped
- Parsing runs in a **Web Worker**, so dropping a 10 000-row file no longer freezes the interface (falls back inline where workers are unavailable)
- Re-opening the same file reuses its parse only when the **bytes match** (`size` + `lastModified`); a different file that merely shares the name gets a fresh parse — never stale measurements under a current label
- Loaded matrices are **automatically registered with the compute backend** (fire-and-forget; UI never blocks on network)

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

### Compute Backend (C++/Eigen)

The backend holds **authoritative copies** of all data, dependency graphs, and compute definitions. The browser keeps only revision-keyed read-only display caches.

- **Expression engine**: full semantic port of the TS reference (`expression.ts`) — 38 cross-tier differential fixtures guarantee identical results. Supports arithmetic, comparisons, aggregations (SUM/AVG/MIN/MAX/MEDIAN/STD with NaN skipping and Bessel-corrected STD), element-wise math (ABS/SQRT/LOG/LN/LOG10/EXP/POW/ROUND/FLOOR/CEIL/SIGN), moving window (MOV/EMA), conditionals (IF)
- **Matrix-mode evaluation**: when any input variable is declared matrix-mode, `*` becomes matrix multiplication; additional functions: `TRANSPOSE`, `DET`, `INV`, `SOLVE`, `MMUL` (explicit matmul), `EMUL` (explicit element-wise multiply). Shape mismatches produce structured `shapeMismatch` errors — never silent garbage
- **Dependency graph**: per-port edges, atomic cycle refusal (N edges either all register or none), result-matrix-aware cascade via `resultOwner_` map
- **Node state machine**: dirty → computing → done | error, pushed via monotonic-seq event stream
- **Protocol v1**: HTTP/1.1 + JSON control plane + DCM1 binary matrix frames + long-poll events. Version handshake on connect; mismatch → visible banner

> Cross-tier test fixtures (`web/tests/fixtures/xlayer/`) are the single judge format.
> Both the TS reference and C++ engine must pass the same JSON — CI enforces this.

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
- **Backend availability banner**: when the compute backend is unreachable or version-mismatched, a visible alert bar appears with a retry button — never a blank screen

## Scope & Limitations

- Internal data is stored as **IEEE 754 double** (~15–17 significant digits), consistent with Excel's native numeric model
- Suitable for batch processing and visualization of **floating-point numeric** data (sensors, measurements, experiments)
- > ⚠️ **Not suitable** for scenarios requiring exact decimal arithmetic (e.g., financial / accounting amounts) or arbitrary-precision computation — Excel and most similar tools cannot satisfy these either
- The compute backend is a **required dependency** — without it, file loading and chart rendering still work locally, but formula evaluation and matrix operations are unavailable (with a visible banner)

## Tech Stack

| Component | Purpose | Notes |
|-----------|---------|-------|
| React 19 + Vite 8 | UI framework and build | TypeScript 7 `strict` |
| ECharts 6 | Charts | **SVG renderer**, vector export |
| react-rnd | Card drag / resize | |
| zustand | State (card table + dependency graph) | |
| @e965/xlsx | Excel read | Loaded on demand |
| Hand-rolled virtual scrolling | Large-table rendering | No third-party dependency |
| Web Worker (`src/loaders/parse.worker.ts`) | Off-thread file parsing | Keeps the UI responsive on large files |
| **C++17 / g++ 15** | Compute backend language | CMake 4 + Ninja |
| **Eigen 3.4** | Linear algebra / matrix operations | Header-only, `/usr/include/eigen3` |
| POSIX sockets | Backend HTTP server | Zero third-party networking deps |

## Building & Running

### Prerequisites

**Frontend** (Node.js 22+):
```bash
cd web && npm install
```

**Backend** (Ubuntu / Debian):
```bash
sudo apt-get install build-essential cmake ninja-build libeigen3-dev
```

> On other platforms: any C++17 compiler + CMake 3.24+ + Eigen 3.4 headers will work.
> The toolchain is verified on Ubuntu 26.04 with g++ 15.2, cmake 4.2, ninja 1.13.

### One-command dev

```bash
./scripts/dev.sh          # builds backend + starts both servers
```

This runs `cmake --build backend/build`, starts `dc_backend` on port 37811, and launches `vite dev` with `/api` proxied to the backend. Ctrl-C kills both.

### Manual steps

```bash
# Backend
cmake -S backend -B backend/build -G Ninja
cmake --build backend/build
./backend/build/dc_backend --port 37811

# Frontend (in another terminal)
cd web
npm run dev               # dev server at http://localhost:5173
npm run build             # type check + production build → web/dist/
npm test                  # unit tests (vitest, includes cross-tier fixtures)
```

### Tests

```bash
# Frontend: typecheck + 269 unit tests (including 46 cross-tier differential fixtures)
cd web && npm run typecheck && npm test

# Backend: 5 ctest cases (46 expression + 14 matrix + node registry; two more are opt-in gates, Skipped by default)
cd backend && ctest --test-dir build --output-on-failure

# Opt-in gates: differential fuzz (random TS↔C++ cross-check) and HTTP malformed-request stress
DC_RUN_FUZZ=1 ctest --test-dir build -R diff_fuzz --output-on-failure
DC_RUN_STRESS=1 ctest --test-dir build -R http_stress --output-on-failure

# End-to-end smoke (run `npm run preview` first)
node web/scripts/smoke.mjs http://127.0.0.1:4173
```

### CI

GitHub Actions runs three jobs on every push/PR:
1. **typecheck-and-test**: `npm ci` → typecheck → vitest → production build
2. **backend-test**: `apt install toolchain` → cmake build → ctest (cross-tier fixtures + node registry)
3. **e2e-smoke**: Playwright Chromium against `vite preview`

## Architecture Extension Points

- `backend/src/expression.cpp` → expression engine (cell-mode + matrix-mode evaluators)
- `backend/src/matrix_value.h` → MatVal type wrapping Eigen::MatrixXd with shape enforcement
- `backend/src/nodes.cpp` → compute node registry, dependency graph, scheduler
- `backend/src/http_server.cpp` → protocol v1 HTTP endpoints
- `web/src/backend/client.ts` → frontend transport client (protocol v1)
- `web/src/loaders/` → adapters for new file formats (`FileLoader`)
- `web/src/core/MatrixData.ts` → client-side data model (display cache under B-plan)
- `web/src/ui/ConnectionLayer.tsx` → connection visualization
- `web/tests/fixtures/xlayer/` → cross-tier differential test fixtures (single judge format)

## Short-term Goals

- [x] **Frontend decision** → **Web chosen** (2026-10-14)
- [x] **Qt UI implementation removed** → repo is now web-first (2026-10-15)
- [x] **Dependency cycle detection** → `DependencyGraph` refuses loops and deduplicates edges (2026-10-15)
- [x] **Maximum-headroom principle adopted** → visible degradation contract (2026-10-15)
- [x] **B-plan decided** → backend owns compute, browser is pure interaction (2026-10-17)
- [x] **Cross-tier differential fixtures** → 46 expression cases, single JSON judge format (2026-10-17; extended 2026-10-21)
- [x] **Differential fuzz gate** → random TS↔C++ cross-check incl. error codes/positions, reproducible seeds (2026-10-21)
- [x] **C++/Eigen compute backend skeleton** → expression engine port, node registry, HTTP API, protocol v1 (2026-10-17)
- [x] **Frontend transport client** → backend handshake, matrix registration, event polling, visible offline banner (2026-10-17)
- [x] **One-command dev + CI gate** → `scripts/dev.sh`, vite proxy, GitHub Actions backend-test job (2026-10-17)
- [x] **Eigen matrix operators** → matmul, transpose, det, inv, solve + matrix-mode expression evaluator + 14 matrix fixtures (2026-10-17)
- [ ] **Function card UI**: three-pane layout (left: variable blocks + input ports + mode badges; top-right: formula editor; bottom-right: result grid + output port)
- [ ] **VirtualTable windowed data source**: large matrices fetched by visible-row window, not loaded whole
- [ ] **Port anchors**: per-port connection endpoints in `cardMetrics` + `ConnectionLayer`
- [ ] **Four-state status lamps**: driven by node state events (gray/yellow/green/red)
- [ ] Data **editing** capability (non-file-backed cards, double-click edit + formula evaluation)
- [ ] Connection arrows / red-blue bidirectional highlight
- [ ] **Card beautification**: unify card styling, spacing, colors, and layout

## Long-term Roadmap

> The items below are only directional ideas and may change at any time; if you have suggestions, feel free to open an [issue](https://github.com/teglaven/DataCardForge/issues).

- [ ] **Conditional filter card**: slice matrices by row/column predicates before feeding into function cards
- [ ] **ExtensionCard**: a **quick parameter-setting + live-preview** panel dedicated to a specific parent card; can only be created from the parent card and is treated as its child window, closing with it
- [ ] **Implicit equation solving**: extract B from A=B relations where B cannot be isolated analytically (recorded limitation of current single-formula-per-card design)
- [ ] More smoothing modes; consider supporting smoothing via formula / function cards
- [ ] **Parallel multi-function-card execution**: backend scheduler with job IDs, cancellation, out-of-order completion
- [ ] **WebSocket upgrade**: replace long-poll with persistent connection for lower-latency state push
- [x] **i18n**: Chinese / English UI switching (implemented in the web frontend)
- [x] **Persistence** of all cards in the main window (web: card layout + dependencies + data)

## Acknowledgements

This project is developed with the assistance of **AI coding agents** (DeepSeek Harness / Claude-class agent tooling, and earlier GitHub Copilot). All generated code has been **manually reviewed and tested**.

## License

Data Workbench is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License version 3 (GPL-3.0)**, as published by the Free Software Foundation.

The full license text is available in the [LICENSE](LICENSE) file.

### Third-party licenses

| Dependency | License | Notes |
|-----------|---------|-------|
| React / Vite / ECharts / zustand / react-rnd | MIT / Apache-2.0 | Web frontend dependencies |
| @e965/xlsx | Apache-2.0 | SheetJS community build |
| Eigen 3.4 | MPL-2.0 | Header-only linear algebra (backend) |

*(The Qt-era dependencies — Qt 6, QCustomPlot, OpenXLSX, fast_float — left the project with the
Qt UI tree on 2026-10-15 and are no longer shipped or linked. The C++ compute backend introduced
on 2026-10-17 uses only Eigen and the standard library.)*
