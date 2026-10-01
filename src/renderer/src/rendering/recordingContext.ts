// Test helper: a fake canvas context for timing-diagram drawing tests.

export interface RecordedText {
  text: string
  /** Left and right edges of the drawn text, from textAlign and a 6 px/char width. */
  left: number
  right: number
}

/**
 * Minimal 2D context that records the furthest x reached by waveform strokes
 * (lineWidth 1.5) and the horizontal extent of every fillText call.
 */
export function recordingContext(): {
  ctx: CanvasRenderingContext2D
  traceMaxX: () => number
  texts: RecordedText[]
} {
  let maxX = -Infinity
  const texts: RecordedText[] = []
  const state: Record<string | symbol, unknown> = { lineWidth: 1, textAlign: 'start' }
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key]
      if (key === 'measureText') return (text: string) => ({ width: text.length * 6 })
      if (key === 'fillText') {
        return (text: string, x: number) => {
          const w = text.length * 6
          const align = target.textAlign
          const left = align === 'right' || align === 'end' ? x - w : align === 'center' ? x - w / 2 : x
          texts.push({ text, left, right: left + w })
        }
      }
      if (key === 'lineTo' || key === 'moveTo') {
        return (x: number) => { if (target.lineWidth === 1.5) maxX = Math.max(maxX, x) }
      }
      return () => undefined
    },
    set(target, key, value) {
      target[key] = value
      return true
    }
  }) as unknown as CanvasRenderingContext2D
  return { ctx, traceMaxX: () => maxX, texts }
}
