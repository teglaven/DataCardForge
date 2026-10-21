#!/usr/bin/env node
/**
 * TS ↔ C++ differential fuzzer (线二·语义一致).
 *
 * The fixed xlayer fixtures (web/tests/fixtures/xlayer/*.json) only cover hand-written
 * cases; random fuzzing is what keeps discovering NEW divergences between the two engines.
 * This entry point generates seeded random expressions + columns, evaluates them on both
 * sides, and compares:
 *   - numeric results, including NaN / ±Infinity semantics (JSON can't carry them, so the
 *     shared judge format uses the "NaN"|"Infinity"|"-Infinity" string sentinels), and
 *   - structured errors — `code` + `position`, and `params` where the TS side carries them
 *     (the historical defect class lives on error paths).
 *
 * Authority sides:
 *   TS  = web/src/core/expression.ts ITSELF (imported via --experimental-transform-types;
 *         strip-only mode cannot compile its constructor parameter properties). No bundle
 *         snapshot, no new dependencies.
 *   C++ = dc_diff_run over the same JSON case file (backend/tests/diff_run.cpp).
 *
 * Reproducibility: pass --seed (default 12345). A divergence prints the minimal repro
 * (expression + columns + both outcomes) and exits 1 — never widen the comparison to make
 * this green; a real semantic difference IS the finding.
 *
 * Gating convention (mirrors http_stress): without DC_RUN_FUZZ=1 this script exits 101 and
 * ctest records "Not Run", so CI stays fast and deterministic.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');

// ── args ───────────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const seed = Number(arg('seed', '12345'));
const iters = Number(arg('iters', '2000'));
const cppBin = arg('cpp-bin', '');
if (!cppBin) {
  console.error('usage: node diff_fuzz.mjs --cpp-bin <dc_diff_run> [--seed N] [--iters N]');
  process.exit(2);
}

// ── PRNG (mulberry32 — small, seeded, reproducible) ────────────────────
let state = seed >>> 0;
function rnd() {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;

// ── grammar surface ────────────────────────────────────────────────────
// Identifiers: Pos.N (and its bare-number alias), plain names, plus occasional unknowns
// so the error path gets exercised too. Functions: exactly the table BOTH engines share
// (LOG10 exists on both sides; matrix-mode ops are not part of the column engine).
const FUNCS = [
  'SUM', 'AVG', 'MEAN', 'MIN', 'MAX', 'MEDIAN', 'STD', 'ABS', 'SQRT', 'LOG', 'LN',
  'LOG10', 'EXP', 'POW', 'ROUND', 'FLOOR', 'CEIL', 'SIGN', 'MOV', 'EMA', 'IF',
];
const OPS = ['+', '-', '*', '/', '%', '^', '>', '<', '>=', '<=', '==', '!='];
const KNOWN_NAMES = ['A', 'B', 'temp', 'x'];
const UNKNOWN_NAMES = ['Z', 'Q', 'nosuch', 'tempC'];

// ── the one generator constraint (never a comparator exception) ────────
// `%` amplifies last-ULP differences into arbitrary ones: fmod(17.55^17.55, 2.09) is
// decided by bits ~1e21 below the leading digit, so two engines that agree to 1e-16 can
// still land 0.01 apart. That is numerical sensitivity, not a semantic divergence. `+ - *
// /` are IEEE-exact-rounded and therefore bit-identical on both sides; only the
// transcendentals (`^`, POW, EXP, LOG, LN, LOG10) are library-specific. So the LEFT
// operand of `%` is drawn from the transcendental-free sub-grammar below, and everything
// else stays fully random. The comparison itself is never widened to hide a difference.
const SAFE_OPS = ['+', '-', '*', '/', '%'];
const TRANSCENDENTAL = new Set(['POW', 'EXP', 'LOG', 'LN', 'LOG10']);

function genExpr(depth, ncols, bounded = false) {
  if (depth <= 0 || chance(0.25)) {
    const r = rnd();
    if (r < 0.55 && ncols > 0) {
      const col = 1 + Math.floor(rnd() * ncols);
      // Both spellings must resolve identically on both engines.
      return chance(0.5) ? `Pos.${col}` : pick(KNOWN_NAMES.slice(0, Math.min(2, ncols)));
    }
    if (r < 0.7) return String(Math.round(rnd() * 1000) / 100);
    if (r < 0.8) return String(Math.floor(rnd() * 10));
    return chance(0.85) ? pick(KNOWN_NAMES) : pick(UNKNOWN_NAMES);
  }
  const shape = rnd();
  if (shape < 0.45) {
    const op = pick(bounded ? SAFE_OPS : OPS);
    // `%`: keep the dividend transcendental-free (see note above); the divisor is free,
    // since fmod(small, huge) is exact and cannot amplify.
    const left = op === '%' ? genExpr(depth - 1, ncols, true) : genExpr(depth - 1, ncols, bounded);
    return `${left} ${op} ${genExpr(depth - 1, ncols, bounded)}`;
  }
  if (shape < 0.8) {
    const pool = bounded ? FUNCS.filter((f) => !TRANSCENDENTAL.has(f)) : FUNCS;
    const fn = pick(pool);
    const arity = fn === 'MIN' || fn === 'MAX' ? 1 + Math.floor(rnd() * 2)
      : fn === 'POW' || fn === 'MOV' || fn === 'EMA' ? 2
      : fn === 'IF' ? 3
      : fn === 'ROUND' ? 1 + Math.floor(rnd() * 2)
      : 1;
    const args = Array.from({ length: arity }, () => genExpr(depth - 1, ncols, bounded)).join(', ');
    return `${fn}(${args})`;
  }
  if (shape < 0.9) return `-${genExpr(depth - 1, ncols, bounded)}`;
  return `(${genExpr(depth - 1, ncols, bounded)})`;
}

// ── case generation (judge-format compatible) ──────────────────────────
function encodeValue(v) {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  return v;
}

const cases = [];
for (let i = 0; i < iters; ++i) {
  const ncols = 1 + Math.floor(rnd() * 3);
  const nrows = 1 + Math.floor(rnd() * 5);
  const columns = [];
  for (let c = 0; c < ncols; ++c) {
    const data = [];
    for (let r = 0; r < nrows; ++r) {
      let v = Math.round((rnd() * 40 - 20) * 100) / 100;
      if (chance(0.06)) v = Number.NaN;
      else if (chance(0.03)) v = chance(0.5) ? Infinity : -Infinity;
      else if (chance(0.05)) v = 0; // exercise division-by-zero / fmod(N,0)
      // MUST go through encodeValue: JSON.stringify turns NaN and ±Infinity into `null`,
      // which the C++ side reads as 0 — the first fuzz run reported exactly that as a
      // bogus "divergence" (ts=NaN cpp=0) before the inputs were sentinel-encoded.
      data.push(encodeValue(v));
    }
    columns.push({ name: KNOWN_NAMES[c % KNOWN_NAMES.length], data });
  }
  cases.push({ name: `fz-${seed}-${i}`, columns, expression: genExpr(1 + Math.floor(rnd() * 3), ncols) });
}

// ── C++ side ───────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'diffuzz-'));
const inFile = join(dir, 'cases.json');
writeFileSync(inFile, JSON.stringify({ cases }));
let cppOut;
try {
  const raw = execFileSync(cppBin, [inFile], { maxBuffer: 1 << 28 }).toString();
  cppOut = new Map(JSON.parse(raw).map((r) => [r.name, r]));
} catch (e) {
  console.error('dc_diff_run failed:', String(e.message).slice(0, 300));
  rmSync(dir, { recursive: true, force: true });
  process.exit(2);
}

// ── TS side + compare ─────────────────────────────────────────────────
const { compile, ExpressionError } = await import('../src/core/expression.ts');

function revive(v) {
  if (typeof v === 'number') return v;
  if (v === 'NaN') return NaN;
  if (v === 'Infinity') return Infinity;
  if (v === '-Infinity') return -Infinity;
  throw new Error(`bad sentinel ${JSON.stringify(v)}`);
}

function nearlyEqual(a, b) {
  if (Object.is(a, b)) return true; // covers NaN===NaN and +0/-0 being distinct…
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false; // infinities must match exactly
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

const diffs = [];
let compared = 0;
for (const c of cases) {
  const cpp = cppOut.get(c.name);
  if (!cpp) { diffs.push({ c, why: 'missing on C++ side' }); continue; }
  compared++;
  // The C++ side emits non-finite results as the very same string sentinels it accepts on
  // input (JSON cannot carry NaN/±Infinity). Revive before comparing, otherwise every
  // NaN/Infinity result is reported as a divergence against a value that is in fact
  // identical — the second false positive the first end-to-end run produced.
  const cppValues = cpp.ok ? cpp.values.map(revive) : null;
  const data = c.columns.map((col) => col.data.map(revive));
  const length = Math.max(1, ...c.columns.map((col) => col.data.length));
  let ts;
  try {
    const vals = compile(c.expression, c.columns.map((col) => col.name)).evaluate(data, length);
    ts = { ok: true, values: vals };
  } catch (e) {
    if (!(e instanceof ExpressionError)) { ts = { ok: false, code: `tsThrow:${e.message}` }; }
    else ts = { ok: false, code: e.code, position: e.position, params: e.params };
  }

  let why = null;
  if (ts.ok !== cpp.ok) {
    why = `ok mismatch: ts=${ts.ok}${ts.ok ? '' : ` (${ts.code}@${ts.position})`} cpp=${cpp.ok}${cpp.ok ? '' : ` (${cpp.code}@${cpp.position})`}`;
  } else if (!ts.ok) {
    if (ts.code !== cpp.code) why = `code: ts=${ts.code} cpp=${cpp.code}`;
    else if (ts.position !== undefined && cpp.position !== undefined && ts.position !== cpp.position)
      why = `position: ts=${ts.position} cpp=${cpp.position} (code ${ts.code})`;
    else if (cpp.params && ts.params) {
      for (const k of Object.keys(ts.params)) {
        if (cpp.params[k] !== undefined && String(cpp.params[k]) !== String(ts.params[k])) {
          why = `params.${k}: ts=${ts.params[k]} cpp=${cpp.params[k]}`;
          break;
        }
      }
    }
  } else if (ts.values.length !== cppValues.length) {
    why = `length: ts=${ts.values.length} cpp=${cppValues.length}`;
  } else {
    for (let i = 0; i < ts.values.length; ++i) {
      if (!nearlyEqual(ts.values[i], cppValues[i])) {
        why = `[${i}]: ts=${ts.values[i]} cpp=${cppValues[i]}`;
        break;
      }
    }
  }
  if (why) diffs.push({ c, ts, cpp, why });
}

rmSync(dir, { recursive: true, force: true });

console.log(`diff-fuzz seed=${seed} cases=${compared} diverged=${diffs.length}`);
for (const d of diffs.slice(0, 10)) {
  console.log('─'.repeat(72));
  console.log(`DIVERGENCE ${d.c.name}: ${d.why}`);
  console.log(`  expression: ${d.c.expression}`);
  console.log(`  columns:    ${JSON.stringify(d.c.columns)}`);
  console.log(`  ts:  ${JSON.stringify(d.ts?.ok ? { ok: true, values: d.ts.values } : d.ts)}`);
  console.log(`  cpp: ${JSON.stringify(d.cpp?.ok ? { ok: true, values: d.cpp.values } : d.cpp)}`);
}
process.exit(diffs.length === 0 ? 0 : 1);
