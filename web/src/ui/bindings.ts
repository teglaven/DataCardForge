/**
 * Card → protocol port bindings.
 *
 * This is the *only* place that turns a card's `inputs[]` into the bindings the compute
 * backend sees. Extracted from the store for two reasons:
 *
 *   1. it is the seam the card-layer fixtures referee (web/tests/fixtures/cards/): the same
 *      JSON must produce the same port list on both sides of the wire;
 *   2. `portId` is the identity the port-semantics spec locks in — spelling that rule once,
 *      in one function, is what keeps a second (positional) convention from reappearing.
 */
import type { PortBindingDto } from '../backend/client.ts';
import type { FunctionCardModel } from './types.ts';

/** Port id a function card uses for its matrix input (matches the signature declaration). */
export const SOURCE_PORT = 'src';

/**
 * Bindings for one function card, in the order the signature declares its ports.
 *
 * A card whose input matrix has no server id yet (offline, or not registered) yields
 * `null` — there is nothing authoritative to bind to, and inventing an id would bind the
 * node to a matrix the server does not have.
 */
export function portBindingsFor(
  card: FunctionCardModel,
  backendMatrixId: (localMatrixId: number) => number | null,
): PortBindingDto[] | null {
  const bindings: PortBindingDto[] = [];
  for (const input of card.inputs) {
    if (input.target.type !== 'matrix') continue;
    const serverId = backendMatrixId(input.target.matrixId);
    if (serverId === null) return null;
    bindings.push({
      portId: input.portId,
      varName: input.portId,
      mode: 'matrix',
      sourceMatrixId: serverId,
    });
  }
  return bindings;
}
