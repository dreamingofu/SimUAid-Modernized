// Serialization for SimUaid circuit files (.ckt). Files are JSON wrapped in a
// small envelope ({ format, version, netlist }) so the format can be migrated in
// future versions without ambiguity.

import { LogicValue, type Netlist } from '../model/types'

export const CKT_FORMAT = 'simuaid-ckt'
export const CKT_VERSION = 1
export const APP_VERSION = '0.1.0'

interface CktFile {
  format: string
  version: number
  netlist: Netlist
}

/** Creates a blank netlist with default metadata. */
export function createEmptyNetlist(name = 'Untitled'): Netlist {
  const now = new Date().toISOString()
  return {
    components: [],
    wires: [],
    metadata: {
      name,
      createdAt: now,
      modifiedAt: now,
      appVersion: APP_VERSION,
      comment: '',
      defaultDelay: 1,
      simulation: {
        simTimeNs: 100,
        clockPeriodNs: 20,
        clockInitialValue: LogicValue.ONE
      },
      scalingFactor: 1
    }
  }
}

/** Serializes a netlist to the on-disk JSON string. */
export function serializeNetlist(netlist: Netlist): string {
  const file: CktFile = { format: CKT_FORMAT, version: CKT_VERSION, netlist }
  return JSON.stringify(file, null, 2)
}

/**
 * Parses a .ckt file's text into a Netlist, throwing a clear, user-facing error
 * if the file is not valid so callers can surface it instead of crashing.
 */
export function deserializeNetlist(text: string): Netlist {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('File is not valid JSON.')
  }
  if (!data || typeof data !== 'object') {
    throw new Error('File is not a SimUaid circuit.')
  }
  const file = data as Partial<CktFile>
  if (file.format !== CKT_FORMAT) {
    throw new Error('Not a SimUaid circuit file (.ckt).')
  }
  if (file.version !== CKT_VERSION) {
    throw new Error(`Unsupported .ckt version: ${String(file.version)}.`)
  }
  const netlist = file.netlist
  if (
    !netlist ||
    !Array.isArray(netlist.components) ||
    !Array.isArray(netlist.wires) ||
    !netlist.metadata
  ) {
    throw new Error('Circuit file is missing required data.')
  }
  return netlist
}
