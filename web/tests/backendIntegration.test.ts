/**
 * Live integration: the REAL `BackendClient` against the REAL compute backend.
 *
 * Opt-in, like the backend's fuzz/stress gates: without `DC_RUN_INTEGRATION=1` the suite is
 * skipped so CI stays fast and hermetic. With it, this exercises the pieces the unit tests
 * deliberately stub out — DCM1 framing, HTTP status mapping, structured error bodies, and
 * the v2 signature round-trip (portId → K outputs → column contract).
 *
 * It binds to the dev instance on 37811. Every matrix/node it creates is scoped to itself
 * and deleted afterwards, so a developer's running workspace is not disturbed.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { BackendClient } from '../src/backend/client.ts';
import { migrateWorkspace } from '../src/ui/migrate.ts';

const enabled = process.env.DC_RUN_INTEGRATION === '1';
const BASE = process.env.DC_BACKEND_URL ?? 'http://127.0.0.1:37811/api';

const client = new BackendClient(BASE);
const createdNodes: number[] = [];
const createdMatrices: number[] = [];

afterAll(async () => {
  for (const nodeId of createdNodes) await client.deleteNode(nodeId);
  for (const matrixId of createdMatrices) await client.deleteMatrix(matrixId);
});

describe.skipIf(!enabled)('live backend integration', () => {
  it('handshakes with protocol 1', async () => {
    const hello = await client.hello();
    expect(hello.ok).toBe(true);
    expect(hello.protocol).toBe(1);
    expect(hello.maxWindowRows).toBeGreaterThan(0);
  });

  it('registers a table and reads it back through a DCM1 window', async () => {
    const registered = await client.registerMatrix('it-source', [
      { posName: 'Pos.1', annotation: 'A', data: [1, 2, 3] },
      { posName: 'Pos.2', annotation: 'B', data: [10, 20, 30] },
    ]);
    expect(registered.ok).toBe(true);
    createdMatrices.push(registered.matrixId!);

    const frame = await client.window(registered.matrixId!, 0, 10);
    expect(frame.ok).toBe(true);
    expect(frame.rows).toBe(3);
    expect(frame.columns).toBe(2);
    expect(frame.names).toEqual(['Pos.1 A', 'Pos.2 B']);
    expect(Array.from(frame.data![1])).toEqual([10, 20, 30]);
  });

  it('creates a signature node with ONE output holding a wide table', async () => {
    const registered = await client.registerMatrix('it-signature', [
      { posName: 'Pos.1', annotation: 'A', data: [1, 2, 3] },
      { posName: 'Pos.2', annotation: 'B', data: [10, 20, 30] },
    ]);
    createdMatrices.push(registered.matrixId!);

    const created = await client.createNode(
      [{ portId: 'src', varName: 'src', mode: 'matrix', sourceMatrixId: registered.matrixId! }],
      {
        signatureId: 'builtin:expression-columns',
        params: {
          formulas: [
            { name: 'double', expression: 'A * 2' },
            { name: 'sum', expression: 'A + B' },
          ],
        },
      },
    );
    expect(created.ok).toBe(true);
    createdNodes.push(created.nodeId!);
    expect(created.signatureId).toBe('builtin:expression-columns');
    expect(created.state).toBe('done');
    // K is fixed by the signature: one output, whatever its width.
    expect(created.resultMatrixIds).toHaveLength(1);

    const result = await client.nodeResult(created.resultMatrixIds![0]);
    expect(result.ok).toBe(true);
    expect(result.columns).toBe(2);
    expect(result.names).toEqual(['Pos.1 double', 'Pos.2 sum']);
    expect(Array.from(result.data![0])).toEqual([2, 4, 6]);
    expect(Array.from(result.data![1])).toEqual([11, 22, 33]);
  });

  it('round-trips params edits: one PATCH recomputes the whole card', async () => {
    const registered = await client.registerMatrix('it-params', [
      { posName: 'Pos.1', annotation: 'A', data: [2, 4] },
    ]);
    createdMatrices.push(registered.matrixId!);
    const created = await client.createNode(
      [{ portId: 'src', varName: 'src', mode: 'matrix', sourceMatrixId: registered.matrixId! }],
      {
        signatureId: 'builtin:expression-columns',
        params: { formulas: [{ name: 'a', expression: 'A' }] },
      },
    );
    createdNodes.push(created.nodeId!);
    createdMatrices.push(created.resultMatrixIds![0]);

    const patched = await client.patchNode(created.nodeId!, {
      params: { formulas: [{ name: 'square', expression: 'A * A' }] },
    });
    expect(patched.ok).toBe(true);
    const result = await client.nodeResult(created.resultMatrixIds![0]);
    expect(Array.from(result.data![0])).toEqual([4, 16]);
    expect(result.names).toEqual(['Pos.1 square']);
  });

  it('stops the flow with a structured error when the column contract is broken', async () => {
    const registered = await client.registerMatrix('it-contract', [
      { posName: 'Pos.1', annotation: 'A', data: [1, 2] },
    ]);
    createdMatrices.push(registered.matrixId!);
    const created = await client.createNode(
      [{ portId: 'src', varName: 'src', mode: 'matrix', sourceMatrixId: registered.matrixId! }],
      {
        signatureId: 'builtin:expression-columns',
        params: {
          formulas: [{ name: 'a', expression: 'A' }],
          columnContract: { outputId: 'result', columns: 1 },
        },
      },
    );
    createdNodes.push(created.nodeId!);
    createdMatrices.push(created.resultMatrixIds![0]);

    // One more expression than the contract promised ⇒ the node must refuse to publish.
    await client.patchNode(created.nodeId!, {
      params: {
        formulas: [
          { name: 'a', expression: 'A' },
          { name: 'b', expression: 'A * 2' },
        ],
        columnContract: { outputId: 'result', columns: 1 },
      },
    });
    const status = await client.getNode(created.nodeId!);
    expect(status?.state).toBe('error');
    expect(status?.code).toBe('columnContractViolation');
    expect(status?.params).toEqual({ expected: 1, actual: 2 });

    // …and the old numbers are gone, so nothing downstream can read stale values.
    const cleared = await client.nodeResult(created.resultMatrixIds![0]);
    expect(cleared.ok).toBe(true);
    expect(cleared.columns).toBe(0);
  });

  it('rejects an unknown signature with a structured refusal', async () => {
    const registered = await client.registerMatrix('it-unknown', [
      { posName: 'Pos.1', annotation: 'A', data: [1] },
    ]);
    createdMatrices.push(registered.matrixId!);
    const created = await client.createNode(
      [{ portId: 'src', varName: 'src', mode: 'matrix', sourceMatrixId: registered.matrixId! }],
      { signatureId: 'builtin:does-not-exist', params: {} },
    );
    expect(created.ok).toBe(false);
    expect(created.code).toBe('unknownSignature');
  });

  it('migrates a v1 snapshot that mentions a real matrix id', () => {
    const registered = migrateWorkspace({
      version: 1,
      savedAt: '2026-10-01T00:00:00.000Z',
      cards: [
        {
          kind: 'matrix',
          id: 1,
          title: '',
          x: 0,
          y: 0,
          width: 640,
          height: 420,
          z: 1,
          createdAt: 1,
          sources: [{ name: 'a.txt', matrixId: 10 }],
          activeSource: 0,
          readOnly: true,
        },
      ],
      matrices: [{ id: 10, name: 'a.txt', columns: [] }],
      nextCardId: 2,
      nextMatrixId: 11,
    });
    expect(registered.version).toBe(2);
    expect(registered.cards).toHaveLength(1);
    expect(registered.cards[0].inputs).toEqual([]);
  });
});
