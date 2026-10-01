import { useEffect, useRef, useState } from 'react'
import { useCircuitStore } from '../store/circuitStore'
import { renderTimingImage } from '../printing/print'
import {
  TIMING_AXIS_H,
  TIMING_ROW_H,
  TIMING_SCALES,
  boundedCanvasSize,
  drawTimingDiagram,
  scaleFits,
  timingExtent,
  timingHeight,
  timingLayout
} from '../rendering/timing'
import styles from '../styles/TimingPanel.module.css'

export default function TimingPanel(): React.JSX.Element {
  const waveforms = useCircuitStore((s) => s.waveforms)
  const components = useCircuitStore((s) => s.netlist.components)
  const circuitName = useCircuitStore((s) => s.netlist.metadata.name)
  const scale = useCircuitStore((s) => s.timingScaleNs)
  const cursorNs = useCircuitStore((s) => s.timingCursorNs)
  const simLimit = useCircuitStore((s) => s.netlist.metadata.simulation.simTimeNs)
  const simTimeNs = useCircuitStore((s) => s.simTimeNs)
  const setTimingScale = useCircuitStore((s) => s.setTimingScale)
  const setTimingCursor = useCircuitStore((s) => s.setTimingCursor)
  const close = useCircuitStore((s) => s.toggleTimingPanel)
  const setPrintJob = useCircuitStore((s) => s.setPrintJob)
  const openDialog = useCircuitStore((s) => s.openDialog)
  const setStatusMessage = useCircuitStore((s) => s.setStatusMessage)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [fitWidth, setFitWidth] = useState(320)

  // Fit tracks the visible plot width as the window or panel resizes.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = (): void => setFitWidth(Math.max(160, el.clientWidth - 4))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const labelOf = (probeId: string): string =>
    components.find((c) => c.id === probeId)?.label || '??'

  // The axis spans the configured run; traces stop where simulation actually got to.
  const { horizonNs, simulatedNs } = timingExtent(simLimit, simTimeNs, waveforms)
  const layout = timingLayout(scale, horizonNs, fitWidth)
  const height = timingHeight(waveforms.length)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const size = boundedCanvasSize(layout.width, height, window.devicePixelRatio || 1)
    canvas.width = size.width
    canvas.height = size.height
    canvas.style.width = `${layout.width}px`
    canvas.style.height = `${height}px`
    ctx.setTransform(size.ratio, 0, 0, size.ratio, 0, 0)
    drawTimingDiagram({
      ctx,
      traces: waveforms.map((trace) => ({ label: '', trace })),
      layout,
      labelWidth: 0,
      endNs: simulatedNs,
      cursorNs,
      unitLabels: true
    })
  }, [waveforms, layout.pxPerNs, layout.divNs, layout.width, layout.axisMaxNs, height, cursorNs, simulatedNs])

  function onCanvasClick(e: React.MouseEvent<HTMLCanvasElement>): void {
    const rect = e.currentTarget.getBoundingClientRect()
    setTimingCursor(Math.max(0, (e.clientX - rect.left) / layout.pxPerNs))
  }

  function print(): void {
    if (waveforms.length === 0 || simulatedNs === 0) {
      setStatusMessage('Nothing to print — run a Clock/Input simulation with probes first')
      return
    }
    const image = renderTimingImage(
      waveforms.map((trace) => ({ label: labelOf(trace.probeId), trace })),
      simulatedNs
    )
    if (!image) return
    setPrintJob({
      title: `Timing Diagram — ${circuitName || 'Untitled'} (0–${image.endNs} ns, ${image.divNs} ns/div)`,
      imageUrl: image.url,
      smRows: null
    })
    openDialog({ kind: 'printPreview' })
  }

  const value = scale === 'fit' ? 'fit' : String(scale)
  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span>Timing Diagram</span>
        <div className={styles.controls}>
          <label className={styles.scale}>
            Scale
            <select
              value={value}
              onChange={(e) => setTimingScale(e.target.value === 'fit' ? 'fit' : Number(e.target.value))}
            >
              <option value="fit">Fit run</option>
              {TIMING_SCALES.map((n) => (
                <option key={n} value={n} disabled={!scaleFits(n, Math.max(horizonNs, n * 4))}>
                  {n} ns/div
                </option>
              ))}
            </select>
          </label>
          <button type="button" className={styles.close} title="Print timing diagram" onClick={print}>
            🖶
          </button>
          <button type="button" className={styles.close} onClick={close} title="Close">
            ✕
          </button>
        </div>
      </div>
      <div className={styles.cursorBox}>
        <span>Cursor: {cursorNs === null ? '—' : `${Math.round(cursorNs)} ns`}</span>
        <span className={styles.axisInfo}>
          {layout.divNs} ns/div{layout.limited ? ' (finest that fits this run)' : ''} · 0–{Math.round(layout.axisMaxNs)} ns
        </span>
      </div>
      <div className={styles.body}>
        <div className={styles.labels}>
          <div style={{ height: TIMING_AXIS_H }} />
          {waveforms.map((trace) => (
            <div key={trace.probeId} className={styles.label} style={{ height: TIMING_ROW_H }}>
              {labelOf(trace.probeId)}
            </div>
          ))}
        </div>
        <div className={styles.scroll} ref={scrollRef}>
          {waveforms.length === 0 ? (
            <div className={styles.empty}>
              Place probes and run a Clock/Input simulation to see waveforms.
            </div>
          ) : (
            <canvas ref={canvasRef} onClick={onCanvasClick} />
          )}
        </div>
      </div>
    </div>
  )
}
