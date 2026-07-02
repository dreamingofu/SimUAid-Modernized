import { makePinId, parsePinId, type ComponentType, type Netlist, type PinId } from '../model/types'
import { DEFAULT_BITS, defOf, isBusType, isNBitType, type PinRole } from '../model/partDefinitions'
import { resolveNets } from '../netlist/nets'

const SINK_ROLES: ReadonlySet<PinRole> = new Set(['input', 'clock', 'preset', 'clear'])

export interface SimNet {
  id: string
  driverPinIds: PinId[]
  pinIds: PinId[]
  /** 1 for ordinary nets; >1 when any member pin is a bus pin. */
  width: number
}

export interface SimComponent {
  id: string
  type: ComponentType
  delay: number
  bits: number
  tapStart: number
  pinNet: Record<string, string>
  inputPinNames: string[]
  outputPinNames: string[]
}

export interface SimGraph {
  nets: Map<string, SimNet>
  components: Map<string, SimComponent>
  pinToNet: Map<PinId, string>
  /** netId -> ids of components that read the net (have a sink pin on it). */
  readers: Map<string, string[]>
}

export function buildSimGraph(netlist: Netlist): SimGraph {
  const byId = new Map(netlist.components.map((c) => [c.id, c]))

  const pinDefOf = (pinId: PinId) => {
    const { componentId, pinName } = parsePinId(pinId)
    const comp = byId.get(componentId)
    if (!comp) return null
    return defOf(comp).pins.find((p) => p.name === pinName) ?? null
  }

  const nets = new Map<string, SimNet>()
  const pinToNet = new Map<PinId, string>()

  for (const net of resolveNets(netlist)) {
    let width = 1
    const driverPinIds: PinId[] = []
    for (const pinId of net.pinIds) {
      const pin = pinDefOf(pinId)
      if (!pin) continue
      if (pin.role === 'output') driverPinIds.push(pinId)
      if (pin.width && pin.width > width) width = pin.width
    }
    nets.set(net.id, { id: net.id, driverPinIds, pinIds: net.pinIds, width })
    for (const pinId of net.pinIds) pinToNet.set(pinId, net.id)
  }

  const components = new Map<string, SimComponent>()
  const readers = new Map<string, Set<string>>()

  for (const comp of netlist.components) {
    const def = defOf(comp)
    const pinNet: Record<string, string> = {}
    const inputPinNames: string[] = []
    const outputPinNames: string[] = []

    for (const pin of def.pins) {
      const netId = pinToNet.get(makePinId(comp.id, pin.name))
      if (netId === undefined) continue
      pinNet[pin.name] = netId
      if (pin.role === 'output') {
        outputPinNames.push(pin.name)
      } else if (SINK_ROLES.has(pin.role)) {
        inputPinNames.push(pin.name)
        const set = readers.get(netId) ?? new Set<string>()
        set.add(comp.id)
        readers.set(netId, set)
      }
    }

    components.set(comp.id, {
      id: comp.id,
      type: comp.type,
      delay: comp.delay,
      bits: comp.bits ?? (isNBitType(comp.type) || isBusType(comp.type) ? DEFAULT_BITS : 0),
      tapStart: comp.tapStart ?? 0,
      pinNet,
      inputPinNames,
      outputPinNames
    })
  }

  return {
    nets,
    components,
    pinToNet,
    readers: new Map([...readers].map(([net, set]) => [net, [...set]]))
  }
}
