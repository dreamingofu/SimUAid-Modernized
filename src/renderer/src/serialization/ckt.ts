// Serialization for SimUaid circuit files (.ckt). Files are JSON wrapped in a
// small envelope ({ format, version, netlist }) so the format can be migrated in
// future versions without ambiguity.

import { ComponentType, LogicValue, type Netlist } from '../model/types'
import { maxBitsFor } from '../model/partDefinitions'

export const CKT_FORMAT = 'simuaid-ckt'
export const CKT_VERSION = 1
export const APP_VERSION = __APP_VERSION__
export const MAX_CKT_BYTES = 10 * 1024 * 1024

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
  if (text.length > MAX_CKT_BYTES || new TextEncoder().encode(text).length > MAX_CKT_BYTES) {
    throw new Error('Circuit file exceeds the 10 MiB size limit.')
  }
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
  validateNetlist(netlist)
  return netlist
}

function requireValue(condition: unknown, field: string): asserts condition {
  if (!condition) throw new Error(`Invalid circuit data: ${field}.`)
}

function record(value: unknown, field: string): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), field)
  return value as Record<string, unknown>
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function nonnegative(value: unknown): value is number {
  return finite(value) && value >= 0
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    !value.includes('#') && value !== 'prototype' && !Object.hasOwn(Object.prototype, value)
}

function stringMap(value: unknown, field: string): Record<string, unknown> {
  const map = record(value, field)
  requireValue(Object.entries(map).every(([key, entry]) =>
    key !== 'prototype' && !Object.hasOwn(Object.prototype, key) && typeof entry === 'string'), field)
  return map
}

/** Validate before any geometry, rendering, or simulation consumes file data. */
function validateNetlist(netlist: Netlist): void {
  // Bound work in consumers that resolve connectivity and draw every item.
  requireValue(netlist.components.length <= 5000, 'at most 5,000 components are supported')
  requireValue(netlist.wires.length <= 10000, 'at most 10,000 wires are supported')
  const componentTypes = new Set<string>(Object.values(ComponentType))
  const logicValues = new Set<string>(Object.values(LogicValue))
  const ids = new Set<string>()
  for (const [index, value] of netlist.components.entries()) {
    const field = `component ${index + 1}`
    const c = record(value, field)
    requireValue(identifier(c.id) && !ids.has(c.id), `${field} has an invalid or duplicate id`)
    ids.add(c.id)
    requireValue(typeof c.type === 'string' && componentTypes.has(c.type), `${field} has an unknown type`)
    requireValue(finite(c.x) && finite(c.y) && finite(c.rotation), `${field} has invalid coordinates`)
    requireValue(typeof c.label === 'string', `${field} label must be text`)
    stringMap(c.pinLabels, `${field} pin labels`)
    requireValue(nonnegative(c.delay), `${field} delay must be a finite nonnegative number`)
    if (c.bits !== undefined) {
      const min = c.type === ComponentType.BUS_TAP ? 1 : 2
      requireValue(finite(c.bits) && Number.isInteger(c.bits) && c.bits >= min &&
        c.bits <= maxBitsFor(c.type as ComponentType), `${field} has an invalid bit width`)
    }
    for (const key of ['smInputs', 'smOutputs']) {
      const count = c[key]
      requireValue(count === undefined || (finite(count) && Number.isInteger(count) && count >= 1 && count <= 8),
        `${field} ${key} must be an integer from 1 to 8`)
    }
    if (c.tapStart !== undefined) {
      requireValue(finite(c.tapStart) && Number.isInteger(c.tapStart) && c.tapStart >= 0 && c.tapStart < 32,
        `${field} has an invalid bus tap start`)
    }
    if (c.signal !== undefined) {
      requireValue(Array.isArray(c.signal), `${field} signal must be a list`)
      for (const value of c.signal) {
        const row = record(value, `${field} signal row`)
        requireValue(nonnegative(row.timeNs) && typeof row.value === 'string' &&
          (logicValues.has(row.value) || row.value === 'R'), `${field} has an invalid signal row`)
      }
    }
    if (c.smTable !== undefined) {
      requireValue(Array.isArray(c.smTable), `${field} state table must be a list`)
      for (const value of c.smTable) {
        const row = record(value, `${field} state table row`)
        requireValue(['present', 'input', 'output', 'next'].every((key) => typeof row[key] === 'string'),
          `${field} state table entries must be text`)
      }
    }
    if (c.chk !== undefined) {
      const chk = record(c.chk, `${field} checker sequences`)
      requireValue(typeof chk.input === 'string' && typeof chk.output === 'string' &&
        /^[01XR]+$/.test(chk.input) && /^[01X]+$/.test(chk.output) && chk.input.length === chk.output.length,
        `${field} has invalid checker sequences`)
    }
  }

  const wireIds = new Set<string>()
  let segmentCount = 0
  for (const [index, value] of netlist.wires.entries()) {
    const field = `wire ${index + 1}`
    const wire = record(value, field)
    requireValue(identifier(wire.id) && !wireIds.has(wire.id), `${field} has an invalid or duplicate id`)
    wireIds.add(wire.id)
    requireValue(typeof wire.netId === 'string', `${field} net id must be text`)
    requireValue(Array.isArray(wire.segments) && wire.segments.length > 0, `${field} must have segments`)
    segmentCount += wire.segments.length
    requireValue(segmentCount <= 50000, 'at most 50,000 wire segments are supported')
    for (const value of wire.segments) {
      const segment = record(value, `${field} segment`)
      requireValue(['x1', 'y1', 'x2', 'y2'].every((key) => finite(segment[key])), `${field} has invalid coordinates`)
    }
    for (const key of ['fromPinId', 'toPinId']) {
      const pin = wire[key]
      // Older app versions retain endpoint references after deleting a part.
      // Those are legitimate dangling wires; geometry already handles them.
      requireValue(pin === null || (typeof pin === 'string' && pin.indexOf('#') > 0 && !pin.endsWith('#')),
        `${field} has an invalid pin reference`)
    }
  }

  const metadata = record(netlist.metadata, 'metadata')
  for (const key of ['name', 'createdAt', 'modifiedAt', 'appVersion', 'comment']) {
    requireValue(typeof metadata[key] === 'string', `metadata ${key} must be text`)
  }
  requireValue(nonnegative(metadata.defaultDelay), 'default delay must be a finite nonnegative number')
  requireValue(finite(metadata.scalingFactor) && metadata.scalingFactor > 0, 'scaling factor must be a finite positive number')
  const simulation = record(metadata.simulation, 'simulation options')
  requireValue(nonnegative(simulation.simTimeNs), 'simulation time must be a finite nonnegative number')
  requireValue(finite(simulation.clockPeriodNs) && simulation.clockPeriodNs > 0, 'clock period must be a finite positive number')
  requireValue(simulation.clockInitialValue === LogicValue.ZERO || simulation.clockInitialValue === LogicValue.ONE,
    'initial clock value must be 0 or 1')
  if (metadata.switchValues !== undefined) {
    const switches = stringMap(metadata.switchValues, 'switch values')
    requireValue(Object.values(switches).every((value) => logicValues.has(value as string)), 'unknown switch value')
  }
}
