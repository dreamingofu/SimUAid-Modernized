import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComponentType } from '../model/types'
import { defOf } from '../model/partDefinitions'
import { useCircuitStore } from '../store/circuitStore'
import { useCanvasInteraction } from './useCanvasInteraction'

// Exercise the real registered pointer handler and store, without browser layout.
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: (effect: () => void) => effect()
}))

let handlers: Record<string, EventListener>
beforeEach(() => {
  handlers = {}
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  useCircuitStore.getState().newCircuit()
  useCircuitStore.getState().setViewport({ scale: 1, offsetX: 0, offsetY: 0 })
  const canvas = {
    addEventListener: (name: string, handler: EventListener) => { handlers[name] = handler },
    removeEventListener: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0 })
  }
  useCanvasInteraction({ current: canvas as unknown as HTMLCanvasElement })
})
afterEach(() => vi.unstubAllGlobals())

function click(): void {
  handlers.pointerdown({ button: 0, clientX: 400, clientY: 300 } as PointerEvent)
}

describe('configured part placement', () => {
  it('preserves imported checker sequences when placed with the mouse', () => {
    useCircuitStore.getState().setActiveTool({
      kind: 'place', componentType: ComponentType.CHECKER,
      extra: { chk: { input: '01XR', output: '10XX' } }
    })
    click()
    expect(useCircuitStore.getState().netlist.components[0]).toMatchObject({
      type: ComponentType.CHECKER, chk: { input: '01XR', output: '10XX' }
    })
  })

  it('preserves state-machine pin counts and centers its actual geometry', () => {
    useCircuitStore.getState().setActiveTool({
      kind: 'place', componentType: ComponentType.STATE_MACHINE,
      extra: { smInputs: 8, smOutputs: 1 }
    })
    click()
    const placed = useCircuitStore.getState().netlist.components[0]
    expect(placed).toMatchObject({ type: ComponentType.STATE_MACHINE, smInputs: 8, smOutputs: 1 })
    const def = defOf(placed)
    expect(Math.abs(placed.x + def.width / 2 - 400)).toBeLessThanOrEqual(5)
    expect(Math.abs(placed.y + def.height / 2 - 300)).toBeLessThanOrEqual(5)
  })
})
