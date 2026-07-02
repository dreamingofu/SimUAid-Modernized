// Structural VHDL export. Switches and Input Signals become input ports, Probes
// and 7-segment displays become output ports (probe order = placement order),
// and everything else becomes a component instantiation. Components are declared
// in two generated stub packages; "simulation" mode preserves propagation delays
// via a tpd generic.

import { ComponentType, makePinId, type Component, type Netlist, type PinId } from '../model/types'
import { defOf } from '../model/partDefinitions'
import { resolveNets } from '../netlist/nets'

export type VhdlMode = 'synth' | 'sim'

const PORT_INPUT_TYPES = new Set([ComponentType.SWITCH, ComponentType.INPUT_SIGNAL])
const PORT_OUTPUT_TYPES = new Set([ComponentType.PROBE, ComponentType.SEVEN_SEGMENT])
const SKIP_TYPES = new Set([ComponentType.CLOCK, ComponentType.CHECKER])

/** Valid identifier, or the manual's exception: one character plus a prime. */
function isAllowedLabel(label: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_]*$/.test(label) || /^[a-zA-Z]'$/.test(label)
}

function sanitize(label: string): string {
  return label.replace(/'/g, '_n')
}

export function validateForVhdl(netlist: Netlist): string[] {
  const errors: string[] = []
  const seen = new Map<string, string>()

  for (const c of netlist.components) {
    const isPort = PORT_INPUT_TYPES.has(c.type) || PORT_OUTPUT_TYPES.has(c.type)
    if (!isPort) {
      if (c.label && !isAllowedLabel(c.label)) {
        errors.push(`Device label "${c.label}" is not a valid VHDL identifier`)
      }
      continue
    }
    if (!c.label) {
      errors.push(`Every input/output device needs a label (unlabeled ${c.type})`)
      continue
    }
    if (!isAllowedLabel(c.label)) {
      errors.push(`Label "${c.label}" is not a valid VHDL identifier`)
      continue
    }
    const key = sanitize(c.label).toLowerCase()
    const prior = seen.get(key)
    if (prior) errors.push(`Label conflict: "${c.label}" is already used by ${prior}`)
    else seen.set(key, c.type)
  }

  for (const c of netlist.components) {
    for (const [pin, label] of Object.entries(c.pinLabels)) {
      if (label && !isAllowedLabel(label)) {
        errors.push(`Pin label "${label}" (${c.type}.${pin}) is not a valid VHDL identifier`)
      }
    }
  }
  return errors
}

interface PortDef {
  name: string
  dir: 'in' | 'out'
  width: number
}

export interface VhdlFiles {
  entity: string
  entityFileName: string
  packages: { name: string; contents: string }[]
}

export function generateVhdl(netlist: Netlist, entityName: string, mode: VhdlMode): VhdlFiles {
  const nets = resolveNets(netlist)
  const pinNet = new Map<PinId, string>()
  nets.forEach((net, i) => {
    for (const pinId of net.pinIds) pinNet.set(pinId, `n${i}`)
  })

  // Port nets take the port's name instead of a generated signal name.
  const ports: PortDef[] = []
  const netRename = new Map<string, string>()
  const inputs = netlist.components.filter((c) => PORT_INPUT_TYPES.has(c.type))
  const outputs = netlist.components.filter((c) => PORT_OUTPUT_TYPES.has(c.type))

  for (const c of inputs) {
    const name = sanitize(c.label)
    ports.push({ name, dir: 'in', width: 1 })
    const netName = pinNet.get(makePinId(c.id, 'out'))
    if (netName) netRename.set(netName, name)
  }
  for (const c of outputs) {
    if (c.type === ComponentType.SEVEN_SEGMENT) {
      for (let i = 1; i <= 7; i++) {
        const name = `${sanitize(c.label)}_${i}`
        ports.push({ name, dir: 'out', width: 1 })
        const netName = pinNet.get(makePinId(c.id, String(i)))
        if (netName) netRename.set(netName, name)
      }
    } else {
      const name = sanitize(c.label)
      ports.push({ name, dir: 'out', width: 1 })
      const netName = pinNet.get(makePinId(c.id, 'in'))
      if (netName) netRename.set(netName, name)
    }
  }

  const netName = (pinId: PinId): string => {
    const raw = pinNet.get(pinId)
    if (raw === undefined) return 'open'
    return netRename.get(raw) ?? raw
  }

  const instances = netlist.components.filter(
    (c) => !PORT_INPUT_TYPES.has(c.type) && !PORT_OUTPUT_TYPES.has(c.type) && !SKIP_TYPES.has(c.type)
  )

  const usedTypes = new Map<ComponentType, Component>()
  for (const c of instances) if (!usedTypes.has(c.type)) usedTypes.set(c.type, c)

  const internalSignals = new Set<string>()
  for (const c of instances) {
    for (const pin of defOf(c).pins) {
      const raw = pinNet.get(makePinId(c.id, pin.name))
      if (raw !== undefined && !netRename.has(raw)) internalSignals.add(raw)
    }
  }

  const packageName = mode === 'synth' ? 'SimUAid_Synthesis_Package' : 'SimUAid_Simulation_Package'
  const lines: string[] = []
  lines.push('library ieee;')
  lines.push('use ieee.std_logic_1164.all;')
  lines.push(`use work.${packageName}.all;`)
  lines.push('')
  lines.push(`entity ${entityName} is`)
  if (ports.length > 0) {
    lines.push('  port (')
    lines.push(ports.map((p) => `    ${p.name} : ${p.dir} std_logic`).join(';\n'))
    lines.push('  );')
  }
  lines.push(`end ${entityName};`)
  lines.push('')
  lines.push(`architecture structural of ${entityName} is`)
  for (const sig of [...internalSignals].sort()) {
    lines.push(`  signal ${sig} : std_logic;`)
  }
  lines.push('begin')
  instances.forEach((c, i) => {
    const def = defOf(c)
    const inst = c.label ? sanitize(c.label) : `u${i}`
    const generic = mode === 'sim' ? ` generic map (tpd => ${c.delay} ns)` : ''
    const mappings = def.pins.map((p) => `${sanitize(p.name)} => ${netName(makePinId(c.id, p.name))}`)
    lines.push(`  ${inst}: ${c.type.toLowerCase()}${generic} port map (${mappings.join(', ')});`)
  })
  lines.push(`end structural;`)

  const pkgLines: string[] = []
  pkgLines.push('library ieee;')
  pkgLines.push('use ieee.std_logic_1164.all;')
  pkgLines.push('')
  pkgLines.push(`package ${packageName} is`)
  for (const [type, sample] of usedTypes) {
    const def = defOf(sample)
    pkgLines.push(`  component ${type.toLowerCase()}`)
    if (mode === 'sim') pkgLines.push('    generic (tpd : time := 1 ns);')
    pkgLines.push('    port (')
    pkgLines.push(
      def.pins
        .map((p) => `      ${sanitize(p.name)} : ${p.role === 'output' ? 'out' : 'in'} std_logic`)
        .join(';\n')
    )
    pkgLines.push('    );')
    pkgLines.push('  end component;')
  }
  pkgLines.push(`end ${packageName};`)

  return {
    entity: lines.join('\n') + '\n',
    entityFileName: `${entityName}.vhd`,
    packages: [{ name: `${packageName}.vhd`, contents: pkgLines.join('\n') + '\n' }]
  }
}
