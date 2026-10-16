import { moveSource, resolveMove } from '../../extension/src/move-plan.js';

// Plan the same message as the sidebar, using durable IDs for mixed pin slots.
export function pinMoveMessage(state, item, before = null) {
  const source = moveSource(
    state,
    item.kind === 'group' ? 'pin-group' : 'tab',
    item.kind === 'group' ? item.id : state.tabs.find((tab) => tab.treeId === item.id).id,
  );
  const destination = { kind: 'pins', before };
  return {
    source,
    destination,
    expected: resolveMove(state, source, destination).expected,
    operationId: crypto.randomUUID(),
  };
}
