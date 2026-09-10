// Structural VHDL templates for fixed-width parts. The package contains
// declarations, not component implementations; external models are required.

import { ComponentType, makePinId, type Component, type Netlist, type PinId } from '../model/types'
import { defOf, isBusType, isNBitType } from '../model/partDefinitions'
import { resolveNets } from '../netlist/nets'

export type VhdlMode = 'synth' | 'sim'

const PORT_INPUT_TYPES = new Set([ComponentType.SWITCH, ComponentType.INPUT_SIGNAL, ComponentType.CLOCK])
const PORT_OUTPUT_TYPES = new Set([ComponentType.PROBE, ComponentType.SEVEN_SEGMENT])
const CONSTANT_TYPES = new Set([ComponentType.VCC, ComponentType.GROUND])

// Includes VHDL-2008 keywords so exported names work with modern tools too.
const RESERVED = new Set(`abs access after alias all and architecture array assert assume assume_guarantee
  attribute begin block body buffer bus case component configuration constant context cover default
  disconnect downto else elsif end entity exit fairness file for force function generate generic group
  guarded if impure in inertial inout is label library linkage literal loop map mod nand new next nor
  not null of on open or others out package parameter port postponed procedure process property
  protected pure range record register reject release rem report restrict restrict_guarantee return
  rol ror select sequence severity shared signal sla sll sra srl strong subtype then to transport type
  unaffected units until use variable vmode vprop vunit wait when while with xnor xor`.split(/\s+/))

export function isVhdlIdentifier(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)*$/.test(name) && !RESERVED.has(name.toLowerCase())
}

/** Valid identifier, or the manual's exception: one character plus a prime. */
function isAllowedLabel(label: string): boolean {
  return isVhdlIdentifier(label) || /^[a-zA-Z]'$/.test(label)
}

function sanitize(label: string): string {
  return label.replace(/'/g, '_n')
}

function exportedNames(c: Component): string[] {
  const name = sanitize(c.label)
  return c.type === ComponentType.SEVEN_SEGMENT
    ? Array.from({ length: 7 }, (_, i) => `${name}_${i + 1}`)
    : [name]
}

export function validateForVhdl(netlist: Netlist, entityName?: string): string[] {
  const errors: string[] = []
  const seen = new Map([
    ['std_logic', 'VHDL signal type'],
    ['time', 'VHDL delay type'],
    ['simuaid_synthesis_package', 'generated component package'],
    ['simuaid_simulation_package', 'generated component package']
  ])
  if (entityName !== undefined) {
    if (!isVhdlIdentifier(entityName)) errors.push(`"${entityName}" is not a valid VHDL entity name`)
    if (seen.has(entityName.toLowerCase())) errors.push(`Entity name "${entityName}" conflicts with ${seen.get(entityName.toLowerCase())}`)
    seen.set(entityName.toLowerCase(), 'entity name')
  }

  for (const c of netlist.components) {
    if (isNBitType(c.type) || isBusType(c.type) || c.type === ComponentType.STATE_MACHINE || c.type === ComponentType.CHECKER) {
      errors.push(`${c.type} is not supported by the structural VHDL template exporter`)
      continue
    }
    const isPort = PORT_INPUT_TYPES.has(c.type) || PORT_OUTPUT_TYPES.has(c.type)
    if (!c.label) {
      if (isPort) errors.push(`Every input/output device needs a label (unlabeled ${c.type})`)
      continue
    }
    if (!isAllowedLabel(c.label)) {
      errors.push(`Label "${c.label}" is not a valid VHDL identifier`)
      continue
    }
    for (const name of exportedNames(c)) {
      const key = name.toLowerCase()
      const prior = seen.get(key)
      if (prior) errors.push(`Label conflict: "${name}" is already used by ${prior}`)
      else seen.set(key, c.type)
    }
  }

  // Pin labels establish virtual connections, but are never emitted as VHDL
  // identifiers. Their spelling therefore need not follow VHDL naming rules.
  return errors
}

interface PortDef {
  name: string
  dir: 'in' | 'out'
  pinId: PinId
}

export interface VhdlFiles {
  entity: string
  entityFileName: string
  packages: { name: string; contents: string }[]
}

export function generateVhdl(netlist: Netlist, entityName: string, mode: VhdlMode): VhdlFiles {
  const errors = validateForVhdl(netlist, entityName)
  if (errors.length > 0) throw new Error(errors.join('\n'))

  const ports: PortDef[] = []
  for (const c of netlist.components) {
    if (PORT_INPUT_TYPES.has(c.type)) {
      ports.push({ name: sanitize(c.label), dir: 'in', pinId: makePinId(c.id, 'out') })
    } else if (PORT_OUTPUT_TYPES.has(c.type)) {
      exportedNames(c).forEach((name, i) => {
        ports.push({ name, dir: 'out', pinId: makePinId(c.id, c.type === ComponentType.SEVEN_SEGMENT ? String(i + 1) : 'in') })
      })
    }
  }

  const instances = netlist.components.filter(
    (c) => !PORT_INPUT_TYPES.has(c.type) && !PORT_OUTPUT_TYPES.has(c.type) && !CONSTANT_TYPES.has(c.type)
  )
  const usedTypes = new Map<ComponentType, Component>()
  for (const c of instances) if (!usedTypes.has(c.type)) usedTypes.set(c.type, c)

  const usedNames = new Set([entityName.toLowerCase(), ...ports.map((p) => p.name.toLowerCase()),
    ...instances.filter((c) => c.label).map((c) => sanitize(c.label).toLowerCase())])
  const unique = (base: string): string => {
    let name = base
    for (let suffix = 1; usedNames.has(name.toLowerCase()); suffix++) name = `${base}_${suffix}`
    usedNames.add(name.toLowerCase())
    return name
  }
  // Component declarations share scope with ports/signals/instance labels.
  const typeNames = new Map([...usedTypes.keys()].map((type) => [type, unique(`part_${type.toLowerCase()}`)]))
  const pinName = (name: string): string => `pin_${sanitize(name)}`
  const pinNet = new Map<PinId, string>()
  const nets = resolveNets(netlist).filter((net) => net.pinIds.length > 0)
  const internalSignals = nets.map((net, i) => {
    const name = unique(`net_${i}`)
    for (const pinId of net.pinIds) pinNet.set(pinId, name)
    return name
  })
  const netName = (pinId: PinId): string => pinNet.get(pinId) ?? 'open'

  const packageName = mode === 'synth' ? 'SimUAid_Synthesis_Package' : 'SimUAid_Simulation_Package'
  const lines: string[] = [
    '-- Structural template. External component implementations are required for gates and other parts.',
    '-- The companion package provides declarations only; this is not a standalone executable model.',
    '-- Clock and input-signal waveforms must be driven by the importing design or testbench.',
    'library ieee;',
    'use ieee.std_logic_1164.all;',
    `use work.${packageName}.all;`,
    '',
    `entity ${entityName} is`
  ]
  if (ports.length > 0) {
    lines.push('  port (')
    lines.push(ports.map((p) => `    ${p.name} : ${p.dir} std_logic`).join(';\n'))
    lines.push('  );')
  }
  lines.push(`end ${entityName};`, '', `architecture structural of ${entityName} is`)
  for (const sig of internalSignals) lines.push(`  signal ${sig} : std_logic;`)
  lines.push('begin')
  // Retain one signal per electrical net. Renaming a net to a port loses
  // pass-through assignments, multiple probes, and multiple input drivers.
  for (const port of ports) {
    const signal = netName(port.pinId)
    lines.push(port.dir === 'in' ? `  ${signal} <= ${port.name};` : `  ${port.name} <= ${signal};`)
  }
  for (const c of netlist.components) {
    if (CONSTANT_TYPES.has(c.type)) lines.push(`  ${netName(makePinId(c.id, 'out'))} <= '${c.type === ComponentType.VCC ? '1' : '0'}';`)
  }
  instances.forEach((c, i) => {
    const inst = c.label ? sanitize(c.label) : unique(`u${i}`)
    const generic = mode === 'sim' ? ` generic map (tpd => ${c.delay} ns)` : ''
    const mappings = defOf(c).pins.map((p) => `${pinName(p.name)} => ${netName(makePinId(c.id, p.name))}`)
    lines.push(`  ${inst}: ${typeNames.get(c.type)}${generic} port map (${mappings.join(', ')});`)
  })
  lines.push('end structural;')

  const pkgLines = [
    '-- Component declarations only. Supply matching entities/architectures before elaboration or synthesis.',
    'library ieee;', 'use ieee.std_logic_1164.all;', '', `package ${packageName} is`
  ]
  for (const [type, sample] of usedTypes) {
    pkgLines.push(`  component ${typeNames.get(type)}`)
    if (mode === 'sim') pkgLines.push('    generic (tpd : time := 1 ns);')
    pkgLines.push('    port (')
    pkgLines.push(defOf(sample).pins.map((p) => `      ${pinName(p.name)} : ${p.role === 'output' ? 'out' : 'in'} std_logic`).join(';\n'))
    pkgLines.push('    );', '  end component;')
  }
  pkgLines.push(`end ${packageName};`)

  return {
    entity: lines.join('\n') + '\n',
    entityFileName: `${entityName}.vhd`,
    packages: [{ name: `${packageName}.vhd`, contents: pkgLines.join('\n') + '\n' }]
  }
}
