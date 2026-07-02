// Binary min-heap ordered by (time, seq); seq keeps same-time events FIFO.

import type { LogicValue, PinId } from '../model/types'

export type SimEvent =
  | { time: number; seq: number; kind: 'drive'; pinId: PinId; value: LogicValue }
  | { time: number; seq: number; kind: 'busdrive'; pinId: PinId; value: LogicValue[] }
  | { time: number; seq: number; kind: 'eval'; componentId: string }
  | { time: number; seq: number; kind: 'softreset' }
  | { time: number; seq: number; kind: 'sample'; slot: number }

export class EventHeap {
  private items: SimEvent[] = []

  get size(): number {
    return this.items.length
  }

  peek(): SimEvent | undefined {
    return this.items[0]
  }

  values(): readonly SimEvent[] {
    return this.items
  }

  clear(): void {
    this.items = []
  }

  push(e: SimEvent): void {
    const items = this.items
    items.push(e)
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.before(items[i], items[parent])) {
        ;[items[i], items[parent]] = [items[parent], items[i]]
        i = parent
      } else break
    }
  }

  pop(): SimEvent | undefined {
    const items = this.items
    const top = items[0]
    const last = items.pop()
    if (last !== undefined && items.length > 0) {
      items[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let smallest = i
        if (l < items.length && this.before(items[l], items[smallest])) smallest = l
        if (r < items.length && this.before(items[r], items[smallest])) smallest = r
        if (smallest === i) break
        ;[items[i], items[smallest]] = [items[smallest], items[i]]
        i = smallest
      }
    }
    return top
  }

  private before(a: SimEvent, b: SimEvent): boolean {
    return a.time !== b.time ? a.time < b.time : a.seq < b.seq
  }
}
