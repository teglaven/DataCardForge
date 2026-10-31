# Contributing

**English** | [中文](CONTRIBUTING.zh-CN.md)

Thanks for looking. DataCardForge is an early
experimental project maintained by one person, so the fastest way to get a change merged is
to keep it small and to show the gate output.

## Ground rules

- **Licence**: GPL-3.0-only (see [LICENSE](LICENSE)). By submitting a change you agree it
  ships under that licence; you keep the copyright of your contribution.
- **DCO 1.1, no CLA.** Sign every commit with `git commit -s`, which appends
  `Signed-off-by: Your Name <you@example.com>`. That line is your statement that you wrote
  the change (or have the right to submit it) and agree to its distribution under GPL-3.0.
  Full text: <https://developercertificate.org>. Quotes and plain paragraphs live in
  [PROVENANCE.md](PROVENANCE.md) §4.
- **Be civil.** There is no code-of-conduct file yet; the rule is simply no personal
  attacks, no harassment. Disagreement about a design is welcome and expected.
- **Language**: issues and PRs are fine in English or Chinese. Documentation lives in both
  ([README.md](README.md) / [README.zh-CN.md](README.zh-CN.md)); new user-facing strings must
  ship in **both** languages.

## Good contributions / poor ones

Most welcome: bug reports with a reproduction, documentation fixes, a test that exposes a
real defect, a self-contained feature that respects the contracts below.

Poor use of both our time: drive-by reformatting of large files, "rewrite it in framework
X", dependency updates without a reason, or a PR that changes behaviour and adds no test.

## Before you open a PR

```bash
cd web && npm install                 # once
cd web && npx tsc --noEmit            # must be silent
cd web && npx vitest run              # must be all green
cmake -S backend -B backend/build -G Ninja && cmake --build backend/build
ctest --test-dir backend/build --output-on-failure   # must be all green (opt-in gates skip)
```

Paste the tail of `vitest` and `ctest` into the PR description. **Do not repeat the test
counts in prose** — this repository has been bitten twice by numbers copied from memory
instead of from the command output; the README quotes them only when freshly measured.

Optional, slower, and only relevant when you touch the HTTP surface:

```bash
cd web && npx playwright install chromium   # once
cd web && npm run build && npx vite preview --port 4173 &
node web/scripts/smoke.mjs http://127.0.0.1:4173   # end-to-end, needs the real backend on :37811
```

CI runs exactly the same gates (`.github/workflows/ci.yml`).

## Contracts you must not break

These are frozen; changing one needs a new decision record **first**, then the code.

1. **Backend owns the numbers** (the "B-plan"): every numeric / statistical / matrix
   result comes from the C++/Eigen backend. The browser renders and collects input; it does
   not add new arithmetic.
2. **A signature id is a published identity**: built-ins (`builtin:expression-columns`,
   `builtin:linear-regression`, `builtin:summary`) never change their id. Renaming is a
   `displayName`/i18n change only.
3. **Ports are identities, not positions**; a column is bound to a port, it is not a
   parameter of the card.
4. **The column-count contract** (`params.columnContract`): when upstream width drifts the
   flow is cut (backend `columnContractViolation`), never silently reinterpreted.
5. **Changing the wire protocol** (endpoints, fields, DCM2 framing) needs a decision record
   in [docs/decisions/](docs/decisions/) before the code, and an additive path for old
   clients.
6. **Architecture or cross-tier changes** need a record in [docs/decisions/](docs/decisions/)
   as well. Existing ones explain why the project is shaped this way; read the newest few
   before proposing a redesign.

## Where things live

| Path | What it is |
|---|---|
| `web/src/core/` | pure TypeScript reference implementation (loaders, expression engine, stats, chart options) |
| `web/src/ui/` | React 19 app: cards, canvas, store, i18n |
| `web/src/backend/` | HTTP client for the compute service (protocol v1) |
| `backend/src/` | C++/Eigen compute service: expression engine, node registry, summary, HTTP |
| `backend/tests/` | cross-tier fixtures, stress and fuzz gates |
| `docs/` | design records: decisions, architecture, logs, lessons (in Chinese) |
| `docs/architecture/` | the normative protocol/contract documents |

## Security

Please read [SECURITY.md](SECURITY.md) before reporting anything that looks like a
vulnerability — several surprising behaviours (no authentication, loopback binding) are
documented known limitations, not bugs.
