import { useEffect, useRef } from 'react'
import { LogicValue, type PinValueResolver } from '../model/types'
import { useCircuitStore, type ActiveTool } from '../store/circuitStore'
import { useCanvasInteraction } from '../editor/useCanvasInteraction'
import { renderCircuit } from '../rendering/renderCircuit'
import styles from '../styles/Canvas.module.css'

const resolvePinValue: PinValueResolver = (pinId) =>
  useCircuitStore.getState().pinValues[pinId] ?? LogicValue.Z

const CURSORS: Record<ActiveTool['kind'], string> = {
  select: 'default',
  wire: 'crosshair',
  label: 'text',
  move: 'move',
  delay: 'help',
  erase: 'pointer',
  place: 'crosshair'
}

export default function Canvas(): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const toolKind = useCircuitStore((s) => s.activeTool.kind)

  useCanvasInteraction(canvasRef)

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0

    function draw(): void {
      raf = 0
      const cssWidth = wrap!.clientWidth
      const cssHeight = wrap!.clientHeight
      const dpr =
        useCircuitStore.getState().graphicsMode === 'fixed' ? 1 : window.devicePixelRatio || 1
      canvas!.width = Math.max(1, Math.round(cssWidth * dpr))
      canvas!.height = Math.max(1, Math.round(cssHeight * dpr))
      canvas!.style.width = `${cssWidth}px`
      canvas!.style.height = `${cssHeight}px`

      const s = useCircuitStore.getState()
      renderCircuit({
        ctx: ctx!,
        cssWidth,
        cssHeight,
        dpr,
        netlist: s.netlist,
        viewport: s.viewport,
        selectedComponentIds: new Set(s.selection.componentIds),
        selectedWireIds: new Set(s.selection.wireIds),
        labelOnlyComponentId: s.selection.labelOnlyComponentId,
        highlightWireIds: new Set(s.highlight?.wireIds ?? []),
        showIoValues: s.showIoValues,
        gridEnabled: s.gridEnabled,
        resolvePinValue,
        busPinValues: s.busPinValues,
        wireDraftPoints: s.interaction.wireDraft?.points ?? null,
        cursor: s.interaction.cursor
      })
    }

    function schedule(): void {
      if (!raf) raf = requestAnimationFrame(draw)
    }

    // Redraw on any store change.
    const unsubscribe = useCircuitStore.subscribe(schedule)

    const observer = new ResizeObserver(() => {
      const s = useCircuitStore.getState()
      if (s.canvasSize.w !== wrap!.clientWidth || s.canvasSize.h !== wrap!.clientHeight) {
        s.setCanvasSize(wrap!.clientWidth, wrap!.clientHeight)
      }
      schedule()
    })
    observer.observe(wrap)

    useCircuitStore.getState().setCanvasSize(wrap.clientWidth, wrap.clientHeight)
    schedule()

    return () => {
      unsubscribe()
      observer.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <div className={styles.canvasWrap} ref={wrapRef}>
      <canvas ref={canvasRef} className={styles.canvas} style={{ cursor: CURSORS[toolKind] }} />
    </div>
  )
}
