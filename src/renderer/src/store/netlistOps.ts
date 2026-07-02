// Pure document helpers used by the store's actions.

import { ComponentType, type LogicValue, type Netlist, type SmRow } from '../model/types'
import { findNetContaining, resolveNets } from '../netlist/nets'

/** Stamps metadata.modifiedAt. */
export function touch(netlist: Netlist): Netlist {
  return {
    ...netlist,
    metadata: { ...netlist.metadata, modifiedAt: new Date().toISOString() }
  }
}

/** Recomputes and stamps each wire's netId from the resolved nets. */
export function stampNetIds(netlist: Netlist): Netlist {
  const nets = resolveNets(netlist)
  const wires = netlist.wires.map((w) => {
    const net = findNetContaining(nets, { wireId: w.id })
    return net && net.id !== w.netId ? { ...w, netId: net.id } : w
  })
  return { ...netlist, wires }
}

/** Folds runtime switch positions into the netlist for persistence. */
export function netlistForSave(
  netlist: Netlist,
  switchValues: Record<string, LogicValue>
): Netlist {
  return { ...netlist, metadata: { ...netlist.metadata, switchValues } }
}

export function hasTimedSource(netlist: Netlist): boolean {
  return netlist.components.some(
    (c) =>
      c.type === ComponentType.CLOCK ||
      c.type === ComponentType.INPUT_SIGNAL ||
      c.type === ComponentType.CHECKER
  )
}

// A deleted state machine's table survives in memory so the next placement can
// restore it (the manual's workflow for adjusting pin counts without retyping).
let rememberedSmTable: SmRow[] | null = null

export function rememberSmTables(netlist: Netlist, removedIds: ReadonlySet<string>): void {
  for (const c of netlist.components) {
    if (c.type === ComponentType.STATE_MACHINE && removedIds.has(c.id) && c.smTable?.length) {
      rememberedSmTable = c.smTable
    }
  }
}

export function recallSmTable(): SmRow[] | null {
  return rememberedSmTable
}

/**
 * Native 3-way prompt before discarding unsaved changes. Returns true when it is
 * safe to proceed (saved or discarded), false when the user cancelled.
 */
export async function confirmDiscardIfDirty(
  get: () => { dirty: boolean; save: () => Promise<boolean> }
): Promise<boolean> {
  if (!get().dirty) return true
  const choice = await window.api.confirm({
    type: 'warning',
    message: 'Save changes to the current circuit?',
    detail: 'Your changes will be lost if you don’t save them.',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2
  })
  if (choice === 2) return false
  if (choice === 0) return get().save()
  return true
}
