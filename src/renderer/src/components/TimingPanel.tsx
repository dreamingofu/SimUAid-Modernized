import { useEffect, useRef } from 'react'
import { LogicValue } from '../model/types'
import { useCircuitStore } from '../store/circuitStore'
import { COLORS } from '../rendering/colors'
import styles from '../styles/TimingPanel.module.css'

const ROW_H = 30
const AXIS_H = 22
const DIVISION_PX = 50
const SCALE_OPTIONS = [1, 2, 5, 10, 20]

function levelY(value: LogicValue, top: number): number {
  if (value === LogicValue.ONE) return top + 6
  if (value === LogicValue.ZERO) return top + ROW_H - 6
  return top + ROW_H / 2
}

export default function TimingPanel(): React.JSX.Element {
  const waveforms = useCircuitStore((s) => s.waveforms)
  const components = useCircuitStore((s) => s.netlist.components)
  const scaleNs = useCircuitStore((s) => s.timingScaleNs)
  const cursorNs = useCircuitStore((s) => s.timingCursorNs)
  const simLimit = useCircuitStore((s) => s.netlist.metadata.simulation.simTimeNs)
  const setTimingScale = useCircuitStore((s) => s.setTimingScale)
  const setTimingCursor = useCircuitStore((s) => s.setTimingCursor)
  const close = useCircuitStore((s) => s.toggleTimingPanel)
  const setPrintJob = useCircuitStore((s) => s.setPrintJob)
  const openDialog = useCircuitStore((s) => s.openDialog)

  const canvasRef = useRef<HTMLCanvasElement>(null)

  const labelOf = (probeId: string): string =>
    components.find((c) => c.id === probeId)?.label || '??'

  const pxPerNs = DIVISION_PX / scaleNs
  const latest = waveforms.reduce(
    (m, t) => Math.max(m, t.samples.length ? t.samples[t.samples.length - 1].t : 0),
    0
  )
  const axisMaxNs = Math.max(simLimit, latest, scaleNs * 4)
  const axisWidth = Math.max(240, Math.round(axisMaxNs * pxPerNs))
  const height = AXIS_H + waveforms.length * ROW_H

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(axisWidth * dpr)
    canvas.height = Math.round(Math.max(height, ROW_H) * dpr)
    canvas.style.width = `${axisWidth}px`
    canvas.style.height = `${Math.max(height, ROW_H)}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, axisWidth, height)

    // Time-axis grid + labels.
    ctx.fillStyle = COLORS.background
    ctx.fillRect(0, 0, axisWidth, height)
    ctx.strokeStyle = COLORS.grid
    ctx.fillStyle = COLORS.value
    ctx.font = '10px "Segoe UI", system-ui, sans-serif'
    ctx.textBaseline = 'top'
    ctx.lineWidth = 1
    for (let t = 0; t <= axisMaxNs; t += scaleNs) {
      const x = Math.round(t * pxPerNs) + 0.5
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
      ctx.stroke()
      ctx.fillText(String(t), x + 2, 2)
    }

    // Waveforms.
    ctx.strokeStyle = COLORS.gate
    ctx.lineWidth = 1.5
    waveforms.forEach((trace, i) => {
      const top = AXIS_H + i * ROW_H
      ctx.strokeStyle = '#e0e0e0'
      ctx.beginPath()
      ctx.moveTo(0, top + ROW_H + 0.5)
      ctx.lineTo(axisWidth, top + ROW_H + 0.5)
      ctx.stroke()

      const samples = trace.samples.length ? trace.samples : [{ t: 0, v: LogicValue.Z }]
      for (let s = 0; s < samples.length; s++) {
        const cur = samples[s]
        const xStart = cur.t * pxPerNs
        const xEnd = (s + 1 < samples.length ? samples[s + 1].t : axisMaxNs) * pxPerNs
        if (trace.bus) {
          drawBusSegment(ctx, cur.hex ?? '?', xStart, xEnd, top, s > 0)
        } else {
          drawSegment(ctx, cur.v, xStart, xEnd, top)
          if (s + 1 < samples.length) {
            const xe = xEnd
            ctx.strokeStyle = COLORS.gate
            ctx.lineWidth = 1.5
            ctx.beginPath()
            ctx.moveTo(xe, levelY(cur.v, top))
            ctx.lineTo(xe, levelY(samples[s + 1].v, top))
            ctx.stroke()
          }
        }
      }
    })

    // Cursor.
    if (cursorNs !== null) {
      const x = Math.round(cursorNs * pxPerNs) + 0.5
      ctx.strokeStyle = COLORS.highlight
      ctx.setLineDash([4, 3])
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }, [waveforms, scaleNs, cursorNs, axisMaxNs, axisWidth, height, pxPerNs])

  function onCanvasClick(e: React.MouseEvent<HTMLCanvasElement>): void {
    const rect = e.currentTarget.getBoundingClientRect()
    setTimingCursor(Math.max(0, (e.clientX - rect.left) / pxPerNs))
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span>Timing Diagram</span>
        <div className={styles.controls}>
          <label className={styles.scale}>
            Scale
            <select value={scaleNs} onChange={(e) => setTimingScale(Number(e.target.value))}>
              {SCALE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} ns/div
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={styles.close}
            title="Print timing diagram"
            onClick={() => {
              const canvas = canvasRef.current
              if (!canvas) return
              setPrintJob({ title: 'Timing Diagram', imageUrl: canvas.toDataURL('image/png'), smRows: null })
              openDialog({ kind: 'printPreview' })
            }}
          >
            🖶
          </button>
          <button type="button" className={styles.close} onClick={close} title="Close">
            ✕
          </button>
        </div>
      </div>
      <div className={styles.cursorBox}>
        Cursor: {cursorNs === null ? '—' : `${Math.round(cursorNs)} ns`}
      </div>
      <div className={styles.body}>
        <div className={styles.labels}>
          <div style={{ height: AXIS_H }} />
          {waveforms.map((trace) => (
            <div key={trace.probeId} className={styles.label} style={{ height: ROW_H }}>
              {labelOf(trace.probeId)}
            </div>
          ))}
        </div>
        <div className={styles.scroll}>
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

/** Bus trace segment: parallel rails with an X-crossing at transitions + hex text. */
function drawBusSegment(
  ctx: CanvasRenderingContext2D,
  hex: string,
  xStart: number,
  xEnd: number,
  top: number,
  transition: boolean
): void {
  const yTop = top + 7
  const yBot = top + ROW_H - 7
  const slant = transition ? 4 : 0
  ctx.strokeStyle = COLORS.gate
  ctx.lineWidth = 1.25
  ctx.beginPath()
  ctx.moveTo(xStart + slant, yTop)
  ctx.lineTo(xEnd, yTop)
  ctx.moveTo(xStart + slant, yBot)
  ctx.lineTo(xEnd, yBot)
  if (transition) {
    ctx.moveTo(xStart - 4, yTop)
    ctx.lineTo(xStart + slant, yBot)
    ctx.moveTo(xStart - 4, yBot)
    ctx.lineTo(xStart + slant, yTop)
  }
  ctx.stroke()
  if (xEnd - xStart > 18) {
    ctx.fillStyle = COLORS.gate
    ctx.font = '10px "Segoe UI", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(hex, (xStart + xEnd) / 2, (yTop + yBot) / 2)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  }
}

function drawSegment(
  ctx: CanvasRenderingContext2D,
  value: LogicValue,
  xStart: number,
  xEnd: number,
  top: number
): void {
  if (value === LogicValue.X) {
    ctx.fillStyle = 'rgba(209, 43, 43, 0.18)'
    ctx.fillRect(xStart, top + 6, Math.max(0, xEnd - xStart), ROW_H - 12)
    return
  }
  ctx.strokeStyle = COLORS.gate
  ctx.lineWidth = 1.5
  if (value === LogicValue.Z) ctx.setLineDash([4, 3])
  const y = levelY(value, top)
  ctx.beginPath()
  ctx.moveTo(xStart, y)
  ctx.lineTo(xEnd, y)
  ctx.stroke()
  ctx.setLineDash([])
}
