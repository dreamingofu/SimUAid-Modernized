import { describe, expect, it } from 'vitest'
import { LogicValue } from '../model/types'
import type { WaveformTrace } from '../sim/engine'
import {
  boundedCanvasSize,
  drawTimingDiagram,
  MAX_TIMING_WIDTH,
  scaleFits,
  TIMING_SCALES,
  timingExtent,
  timingHeight,
  timingLayout
} from './timing'
import { recordingContext } from './recordingContext'

describe('timing layout', () => {
  it('offers 100 ns/div for a 1600 ns lab run', () => {
    const layout = timingLayout(100, 1600, 400)
    expect(layout).toMatchObject({ divNs: 100, axisMaxNs: 1600, pxPerNs: 0.5, limited: false })
    expect(layout.width).toBe(840)
    expect(TIMING_SCALES).toEqual(expect.arrayContaining([100, 200, 500]))
  })

  it('fits the whole run into the visible panel with readable divisions', () => {
    for (const width of [300, 460, 680]) {
      const layout = timingLayout('fit', 1600, width)
      expect(layout.width).toBeLessThanOrEqual(width)
      expect(layout.axisMaxNs).toBe(1600)
      expect(layout.divNs * layout.pxPerNs).toBeGreaterThanOrEqual(40)
      expect([100, 200, 500]).toContain(layout.divNs)
    }
  })

  it('never allocates wider than the canvas bound', () => {
    expect(scaleFits(1, 1600)).toBe(false)
    const fine = timingLayout(1, 1600, 400)
    expect(fine.limited).toBe(true)
    expect(fine.width).toBeLessThanOrEqual(MAX_TIMING_WIDTH)
    expect(fine.divNs).toBe(10)
    const huge = timingLayout(1, 1e9, 400)
    expect(huge.width).toBeLessThanOrEqual(MAX_TIMING_WIDTH)
    expect(huge.axisMaxNs / huge.divNs).toBeLessThanOrEqual(MAX_TIMING_WIDTH / 50)
    expect(timingLayout(5, 100, 400)).toMatchObject({ divNs: 5, limited: false })
  })

  it.each([
    ['normal panel', 840, 172, 2],
    ['widest panel', MAX_TIMING_WIDTH, 172, 3],
    ['5,000 probes (tallest legal circuit)', 840, timingHeight(5000), 2],
    ['5,000 probes at full width', MAX_TIMING_WIDTH, timingHeight(5000), 2],
    ['5,000 probes printed', 960, timingHeight(5000), 2]
  ])('bounds the backing store: %s', (_name, w, h, dpr) => {
    const size = boundedCanvasSize(w, h, dpr)
    expect(size.width).toBeLessThanOrEqual(32_000)
    expect(size.height).toBeLessThanOrEqual(32_000)
    expect(size.width * size.height).toBeLessThanOrEqual(16_000_000)
    expect(size.width).toBeGreaterThanOrEqual(1)
    expect(size.height).toBeGreaterThanOrEqual(1)
    expect(size.ratio).toBeLessThanOrEqual(dpr)
  })

  it('keeps the requested ratio when it already fits', () => {
    expect(boundedCanvasSize(840, 172, 2)).toEqual({ ratio: 2, width: 1680, height: 344 })
    expect(timingHeight(5000)).toBe(150_022)
  })
})

describe('partial runs', () => {
  const trace = (times: number[]): WaveformTrace => ({
    probeId: 'p',
    bus: false,
    samples: times.map((t, i) => ({ t, v: i % 2 ? LogicValue.ONE : LogicValue.ZERO }))
  })

  it('keeps the configured horizon for the axis but ends at the simulated time', () => {
    expect(timingExtent(1600, 800, [trace([0, 400])])).toEqual({ horizonNs: 1600, simulatedNs: 800 })
    expect(timingExtent(1600, 1600, [trace([0, 1500])])).toEqual({ horizonNs: 1600, simulatedNs: 1600 })
    expect(timingExtent(1600, 3200, [trace([0, 3100])])).toEqual({ horizonNs: 3200, simulatedNs: 3200 })
    expect(timingExtent(1600, 0, [trace([0])])).toEqual({ horizonNs: 1600, simulatedNs: 0 })
  })

  it.each([[800, 400], [1600, 800]])('draws traces only to the simulated end (%i ns)', (simTimeNs, expectedX) => {
    const traces = [trace([0, 100, 400])]
    const { horizonNs, simulatedNs } = timingExtent(1600, simTimeNs, traces)
    const layout = timingLayout(100, horizonNs, 400)
    expect(layout.axisMaxNs).toBe(1600)
    const { ctx, traceMaxX } = recordingContext()
    drawTimingDiagram({
      ctx, traces: traces.map((t) => ({ label: 'F', trace: t })), layout,
      labelWidth: 0, endNs: simulatedNs, cursorNs: null, unitLabels: true
    })
    expect(traceMaxX()).toBe(expectedX)
  })
})

describe('end-of-run label', () => {
  const trace: WaveformTrace = { probeId: 'p', bus: false, samples: [{ t: 0, v: LogicValue.ZERO }] }

  function endLabel(endNs: number, labelWidth: number, plotWidth: number) {
    const layout = timingLayout('fit', 1600, plotWidth)
    const { ctx, texts } = recordingContext()
    drawTimingDiagram({
      ctx, traces: [{ label: 'F', trace }], layout, labelWidth, endNs, cursorNs: null, unitLabels: true
    })
    const label = texts.find((t) => t.text === `end ${endNs} ns`)!
    return { label, marker: labelWidth + endNs * layout.pxPerNs, right: labelWidth + layout.width }
  }

  it.each([
    ['panel, partial Step run', 100, 0, 460],
    ['panel, very early end', 1, 0, 460],
    ['print, partial run', 100, 64, 896]
  ])('stays inside the plot for an early end (%s)', (_name, endNs, labelWidth, plotWidth) => {
    const { label, marker, right } = endLabel(endNs, labelWidth, plotWidth)
    expect(label.left).toBeGreaterThanOrEqual(labelWidth)
    expect(label.right).toBeLessThanOrEqual(right)
    expect(label.left).toBeGreaterThan(marker)
  })

  it.each([[0, 460], [64, 896]])('keeps the full-run label left of the 1600 ns marker (label column %i)', (labelWidth, plotWidth) => {
    const { label, marker, right } = endLabel(1600, labelWidth, plotWidth)
    expect(label.right).toBeLessThanOrEqual(marker)
    expect(label.left).toBeGreaterThanOrEqual(labelWidth)
    expect(label.right).toBeLessThanOrEqual(right)
  })
})
