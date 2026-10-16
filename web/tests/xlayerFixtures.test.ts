/**
 * Cross-tier fixture runner — TypeScript reference side.
 *
 * The fixtures in `fixtures/xlayer/*.json` are the single judge for every compute
 * engine (docs/architecture/backend-protocol-v1.md). This file pins the behaviour of
 * the TS reference implementation (`core/expression.ts`, frozen as a differential
 * oracle by the B-plan decision, docs/decisions/2026-10-17-backend-owns-compute.md);
 * the C++ backend runs the same JSON through its own engine and CI requires both green.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { compile, ExpressionError } from '../src/core/expression.ts';

interface FixtureColumn {
  name: string;
  data: Array<number | 'NaN' | 'Infinity' | '-Infinity'>;
}

interface FixtureCase {
  name: string;
  columns: FixtureColumn[];
  expression: string;
  expect?: Array<number | 'NaN' | 'Infinity' | '-Infinity'>;
  tol?: number;
  error?: { code: string; position?: number };
}

const here = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'xlayer');

function loadCases(file: string): FixtureCase[] {
  const raw = readFileSync(join(here, file), 'utf8');
  // The fixtures encode non-finite values as strings; revive them here, once.
  return (JSON.parse(raw) as { cases: FixtureCase[] }).cases;
}

function revive(v: number | string): number {
  if (typeof v === 'number') return v;
  if (v === 'NaN') return Number.NaN;
  if (v === 'Infinity') return Number.POSITIVE_INFINITY;
  if (v === '-Infinity') return Number.NEGATIVE_INFINITY;
  throw new Error(`bad sentinel ${JSON.stringify(v)}`);
}

function sameNumber(a: number, b: number, tol: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  return Math.abs(a - b) <= tol;
}

for (const file of ['expression.v1.json']) {
  describe(`xlayer fixtures (${file}) vs TS reference`, () => {
    for (const c of loadCases(file)) {
      it(c.name, () => {
        const names = c.columns.map((col) => col.name);
        if (c.error) {
          let thrown: unknown = null;
          try {
            const compiled = compile(c.expression, names);
            compiled.evaluate(
              c.columns.map((col) => col.data.map(revive)),
              c.columns[0]?.data.length ?? 1,
            );
          } catch (e) {
            thrown = e;
          }
          expect(thrown, `expected ${c.error.code}`).toBeInstanceOf(ExpressionError);
          expect((thrown as ExpressionError).code).toBe(c.error.code);
          if (c.error.position !== undefined) {
            expect((thrown as ExpressionError).position).toBe(c.error.position);
          }
          return;
        }

        const length = c.columns.reduce((max, col) => Math.max(max, col.data.length), 0) || 1;
        const compiled = compile(c.expression, names);
        const got = compiled.evaluate(
          c.columns.map((col) => col.data.map(revive)),
          length,
        );
        const want = c.expect!.map(revive);
        expect(got.length, 'result length').toBe(want.length);
        const tol = c.tol ?? 0;
        for (let i = 0; i < want.length; i++) {
          expect(sameNumber(got[i], want[i], tol), `[${i}] got ${got[i]} want ${want[i]}`).toBe(true);
        }
      });
    }
  });
}
