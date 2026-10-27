/**
 * Card-layer differential fixtures — TypeScript side.
 *
 * `web/tests/fixtures/cards/*.json` is the shared judge for schema-v2 function cards, the
 * same way `xlayer/*.json` judges the expression engine: the C++ runner
 * (`backend/tests/card_fixture_run.cpp`) creates the very same card through `NodeRegistry`
 * and compares the matrices it produces against the same `expect` block.
 *
 * The TS side does NOT compute anything (B-plan). What it referees is the part only the
 * frontend can get wrong — how a card description turns into port bindings, and whether the
 * fixture itself is coherent (a case whose column count disagrees with its formulas would
 * be a broken judge for both sides).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { portBindingsFor, SOURCE_PORT } from '../src/ui/bindings.ts';
import { migrateWorkspace } from '../src/ui/migrate.ts';
import type { FunctionCardModel } from '../src/ui/types.ts';

interface FixtureColumn {
  name: string;
  data: Array<number | 'NaN' | 'Infinity' | '-Infinity'>;
}

interface FixtureCard {
  kind: 'formula';
  inputs: Array<{ portId: string; target: { type: 'matrix'; cardId: number; matrixId: number } }>;
  signatureId: string;
  params: Record<string, unknown>;
}

interface FixtureCase {
  name: string;
  matrices: Array<{
    id: number;
    columns: Array<{ posName: string; annotation: string; data: Array<number | string> }>;
  }>;
  card: FixtureCard;
  expect?: { outputs: Array<{ outputId: string; columns: FixtureColumn[] }> };
  expectError?: { code: string; params?: Record<string, unknown> };
}

const here = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cards');

/**
 * The signatures the fixtures are allowed to describe, and the port list each one declares.
 *
 * This table is the TS half of the port contract: the backend validates the same thing at
 * creation time (`unknownPort` / `unboundPort`), so a fixture that disagrees with its
 * signature fails on both sides instead of documenting a card nobody can build.
 */
const DECLARED_PORTS: Record<string, string[]> = {
  'builtin:expression-columns': ['src'],
  'builtin:linear-regression': ['x', 'y'],
};

/** Output column names each signature promises (order matters; names are its contract). */
const DECLARED_OUTPUT_COLUMNS: Record<string, string[]> = {
  'builtin:linear-regression': ['slope', 'intercept', 'r', 'r2', 'n'],
};

function loadCases(file: string): FixtureCase[] {
  return (JSON.parse(readFileSync(join(here, file), 'utf8')) as { cases: FixtureCase[] }).cases;
}

/** The card exactly as the store would hold it after migration/creation. */
function cardFromFixture(c: FixtureCase): FunctionCardModel {
  const formulas = (c.card.params.formulas ?? []) as Array<{ name: string; expression: string }>;
  return {
    kind: 'formula',
    id: 100,
    title: '',
    x: 0,
    y: 0,
    width: 520,
    height: 380,
    z: 1,
    createdAt: 0,
    inputs: c.card.inputs,
    signatureId: c.card.signatureId,
    params: c.card.params as unknown as FunctionCardModel['params'],
    outputs: [{ outputId: 'result', resultMatrixId: 200 }],
    node: null,
    displayMatrixId: 300,
    ...(formulas.length === 0 ? {} : {}),
  };
}

for (const file of ['function-card.v2.json']) {
  describe(`card fixtures (${file})`, () => {
    for (const c of loadCases(file)) {
      describe(c.name, () => {
        it('derives the port bindings the backend will see', () => {
          // A fixture matrix id IS the server id here: the fixtures describe the wire
          // level, so the identity map is the identity function.
          const bindings = portBindingsFor(cardFromFixture(c), (local) => local);
          expect(bindings).not.toBeNull();
          expect(bindings).toHaveLength(c.card.inputs.length);
          c.card.inputs.forEach((input, index) => {
            expect(bindings![index]).toEqual({
              portId: input.portId,
              varName: input.portId,
              mode: 'matrix',
              sourceMatrixId: input.target.matrixId,
            });
          });
          // The signature declares these ports; the card must use those ids, not positions.
          const declared = DECLARED_PORTS[c.card.signatureId];
          expect(declared).toBeDefined();
          expect(c.card.inputs.map((input) => input.portId)).toEqual(declared);
          // …and no port may be bound twice.
          const ids = c.card.inputs.map((input) => input.portId);
          expect(new Set(ids).size).toBe(ids.length);
          if (c.card.signatureId === 'builtin:expression-columns') {
            expect(ids).toContain(SOURCE_PORT);
          }
        });

        it('is internally coherent (a broken judge would convict both sides)', () => {
          const formulas = (c.card.params.formulas ?? []) as unknown[];
          if (c.expectError) {
            expect(c.expect).toBeUndefined();
            expect(c.expectError.code).toMatch(/^[a-z][A-Za-z]+$/);
            return;
          }
          expect(c.expect).toBeDefined();
          const outputs = c.expect!.outputs;
          expect(outputs).toHaveLength(1);
          const columns = outputs[0].columns;
          const sourceRows = c.matrices[0]?.columns[0]?.data.length ?? 0;
          if (c.card.signatureId === 'builtin:expression-columns') {
            // One expression ⇒ one column, in declaration order, as tall as the input.
            expect(columns).toHaveLength(formulas.length);
            for (const column of columns) expect(column.data).toHaveLength(sourceRows);
          } else {
            // A non-expression signature fixes its own shape: the fixture must say so
            // (this is the "output shape follows the signature, not the data" rule).
            const expectedNames = DECLARED_OUTPUT_COLUMNS[c.card.signatureId];
            expect(expectedNames).toBeDefined();
            expect(columns.map((column) => column.name)).toEqual(expectedNames);
            for (const column of columns) expect(column.data).toHaveLength(1);
            const nColumn = columns[expectedNames!.indexOf('n')];
            const n = Number(nColumn.data[0]);
            expect(Number.isFinite(n)).toBe(true);
            expect(n).toBeLessThanOrEqual(sourceRows);
          }
          // Names are unique (the rename surface distinguishes columns by name).
          const names = columns.map((column) => column.name);
          expect(new Set(names).size).toBe(names.length);
          // A contract case must disagree with the produced width, or it is not a case.
          const contract = (c.card.params as { columnContract?: { columns: number } })
            .columnContract;
          if (contract) expect(contract.columns).not.toBe(columns.length);
        });

        it('survives a workspace round-trip (persisted cards keep their bindings)', () => {
          const snapshot = migrateWorkspace({
            version: 2,
            savedAt: '2026-01-01T00:00:00.000Z',
            cards: [cardFromFixture(c)],
            matrices: c.matrices.map((matrix) => ({
              id: matrix.id,
              name: `m${matrix.id}`,
              columns: matrix.columns.map((column) => ({
                posName: column.posName,
                annotation: column.annotation,
                data: column.data.map((value) =>
                  typeof value === 'number' ? value : Number.NaN,
                ),
              })),
            })),
            nextCardId: 101,
            nextMatrixId: 301,
          });
          const restored = snapshot.cards[0] as FunctionCardModel;
          expect(restored.inputs).toEqual(c.card.inputs);
          expect(restored.signatureId).toBe(c.card.signatureId);
          expect(restored.params).toEqual(c.card.params);
        });
      });
    }
  });
}
