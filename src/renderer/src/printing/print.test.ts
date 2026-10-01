import { afterEach, describe, expect, it, vi } from 'vitest'
import { LogicValue } from '../model/types'
import { recordingContext } from '../rendering/recordingContext'
import { renderTimingImage } from './print'

function stubCanvas(): { canvases: { width: number; height: number }[]; traceMaxX: () => number } {
  const canvases: { width: number; height: number }[] = []
  const { ctx, traceMaxX } = recordingContext()
  vi.stubGlobal('document', {
    createElement: () => {
      const canvas = { width: 0, height: 0, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,' }
      canvases.push(canvas)
      return canvas
    }
  })
  return { canvases, traceMaxX }
}

afterEach(() => vi.unstubAllGlobals())

const trace = (id: string) => ({
  label: id,
  trace: { probeId: id, bus: false, samples: [{ t: 0, v: LogicValue.ZERO }, { t: 100, v: LogicValue.ONE }] }
})

describe('timing print image', () => {
  it('renders at 2x for a normal lab run', () => {
    const { canvases } = stubCanvas()
    const image = renderTimingImage(['A', 'B', 'C', 'D', 'F'].map(trace), 1600)
    expect(image).toMatchObject({ endNs: 1600, divNs: 100 })
    expect(canvases[0]).toEqual(expect.objectContaining({ width: 1920, height: 344 }))
  })

  it('stays within canvas side and area limits for 5,000 probes', () => {
    const { canvases } = stubCanvas()
    renderTimingImage(Array.from({ length: 5000 }, (_, i) => trace(`P${i}`)), 1600)
    const { width, height } = canvases[0]
    expect(width).toBeLessThanOrEqual(32_000)
    expect(height).toBeLessThanOrEqual(32_000)
    expect(width * height).toBeLessThanOrEqual(16_000_000)
  })

  it('fits the print to the simulated end of a partial run', () => {
    const { traceMaxX } = stubCanvas()
    const image = renderTimingImage([trace('F')], 800)
    expect(image?.endNs).toBe(800)
    // 64 px label column + 856 px plot for the whole 0–800 ns.
    expect(traceMaxX()).toBeCloseTo(64 + 856, 5)
  })
})
