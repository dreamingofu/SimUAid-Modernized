// Wires pointer/keyboard interaction to the canvas, switched by the active tool.
// All handlers read fresh state via useCircuitStore.getState(), so there are no
// stale closures. DOM listeners are attached imperatively and cleaned up.

import { useEffect, type RefObject } from 'react'
import { ComponentType } from '../model/types'
import { busWidthOfWire, useCircuitStore } from '../store/circuitStore'
import { getPartDefinition } from '../model/partDefinitions'
import {
  GRID,
  screenToWorld,
  snapPoint,
  type Point,
  type Viewport
} from '../geometry/coords'
import { findPinAt } from '../geometry/pins'
import { hitComponent, hitDeviceLabel, hitWire } from '../geometry/hitTest'
import { beep } from './beep'

const PIN_TOL_PX = 8
const LABEL_PIN_TOL_PX = 12
const WIRE_TOL_PX = 6

function hFirstFor(from: Point, to: Point, shift: boolean): boolean {
  const base = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
  return shift ? !base : base
}

export function useCanvasInteraction(canvasRef: RefObject<HTMLCanvasElement | null>): void {
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let pan: { x: number; y: number } | null = null
    let drag: { id: string; grabDx: number; grabDy: number } | null = null
    let spaceDown = false

    const viewport = (): Viewport => useCircuitStore.getState().viewport
    const screenPoint = (e: PointerEvent | WheelEvent | MouseEvent): Point => {
      const rect = canvas.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }
    const worldPoint = (e: PointerEvent | WheelEvent | MouseEvent): Point =>
      screenToWorld(screenPoint(e), viewport())
    const worldTol = (px: number): number => px / viewport().scale

    function onPointerDown(e: PointerEvent): void {
      const store = useCircuitStore.getState()

      // Panning: middle button, or Space + left button.
      if (e.button === 1 || (spaceDown && e.button === 0)) {
        pan = { x: e.clientX, y: e.clientY }
        canvas!.setPointerCapture(e.pointerId)
        e.preventDefault()
        return
      }
      if (e.button !== 0) return

      const world = worldPoint(e)
      const tool = store.activeTool

      switch (tool.kind) {
        case 'place': {
          const def = getPartDefinition(tool.componentType, tool.bits)
          store.addComponentAt(
            tool.componentType,
            { x: world.x - def.width / 2, y: world.y - def.height / 2 },
            tool.bits
          )
          return
        }

        case 'select': {
          if (e.shiftKey) {
            const wireHit = hitWire(store.netlist, world, worldTol(WIRE_TOL_PX))
            if (wireHit) {
              store.highlightNetByWire(wireHit.wireId)
              return
            }
          }
          const labelHit = hitDeviceLabel(store.netlist, world)
          if (labelHit) {
            store.selectLabelOnly(labelHit.id)
            return
          }
          const compHit = hitComponent(store.netlist, world)
          if (compHit) {
            if (compHit.type === ComponentType.SWITCH) {
              store.simToggleSwitch(compHit.id)
            } else {
              store.selectComponent(compHit.id)
            }
            return
          }
          const wireHit = hitWire(store.netlist, world, worldTol(WIRE_TOL_PX))
          if (wireHit) {
            store.selectWire(wireHit.wireId)
            return
          }
          store.clearSelection()
          return
        }

        case 'wire': {
          const pin = findPinAt(store.netlist, world, worldTol(PIN_TOL_PX))
          const draft = store.interaction.wireDraft
          if (!draft) {
            // Shift+click on a bus wire opens the Bus Tap dialog (manual §Bus Tap).
            if (e.shiftKey && !pin) {
              const wireHit = hitWire(store.netlist, world, worldTol(WIRE_TOL_PX))
              if (wireHit) {
                const wire = store.netlist.wires.find((w) => w.id === wireHit.wireId)
                if (wire && busWidthOfWire(store.netlist, wire) > 1) {
                  store.openDialog({ kind: 'busTap', wireId: wire.id, x: world.x, y: world.y })
                  return
                }
              }
            }
            if (pin) store.beginWire(pin.pinId, { x: pin.x, y: pin.y })
            return
          }
          const last = draft.points[draft.points.length - 1]
          if (pin) {
            const target = { x: pin.x, y: pin.y }
            if (store.finishWire(target, pin.pinId, hFirstFor(last, target, e.shiftKey))) beep()
          } else {
            const target = snapPoint(world)
            store.addWirePoint(target, hFirstFor(last, target, e.shiftKey))
          }
          return
        }

        case 'move': {
          const compHit = hitComponent(store.netlist, world)
          if (compHit) {
            store.selectComponent(compHit.id)
            drag = { id: compHit.id, grabDx: world.x - compHit.x, grabDy: world.y - compHit.y }
            canvas!.setPointerCapture(e.pointerId)
          }
          return
        }

        case 'delay': {
          const compHit = hitComponent(store.netlist, world)
          if (compHit) {
            store.openDialog(
              compHit.type === ComponentType.INPUT_SIGNAL
                ? { kind: 'inputSignal', componentId: compHit.id }
                : { kind: 'delay', componentId: compHit.id }
            )
          }
          return
        }

        case 'label': {
          const pin = findPinAt(store.netlist, world, worldTol(LABEL_PIN_TOL_PX))
          if (pin) {
            const existing =
              store.netlist.components.find((c) => c.id === pin.componentId)?.pinLabels[pin.name] ?? ''
            store.beginInlineEdit({
              kind: 'pin',
              componentId: pin.componentId,
              pinName: pin.name,
              value: existing,
              screenX: e.clientX,
              screenY: e.clientY
            })
            return
          }
          const compHit = hitComponent(store.netlist, world)
          if (compHit) {
            store.beginInlineEdit({
              kind: 'device',
              componentId: compHit.id,
              pinName: null,
              value: compHit.label,
              screenX: e.clientX,
              screenY: e.clientY
            })
          }
          return
        }

        case 'erase': {
          const compHit = hitComponent(store.netlist, world)
          if (compHit) {
            store.deleteComponentAndWires(compHit.id)
            return
          }
          const wireHit = hitWire(store.netlist, world, worldTol(WIRE_TOL_PX))
          if (wireHit) store.deleteWires([wireHit.wireId])
          return
        }
      }
    }

    function onPointerMove(e: PointerEvent): void {
      if (pan) {
        useCircuitStore.getState().panBy(e.clientX - pan.x, e.clientY - pan.y)
        pan = { x: e.clientX, y: e.clientY }
        return
      }
      if (drag) {
        const world = worldPoint(e)
        const store = useCircuitStore.getState()
        store.moveComponentTo(
          drag.id,
          Math.round((world.x - drag.grabDx) / GRID) * GRID,
          Math.round((world.y - drag.grabDy) / GRID) * GRID
        )
        return
      }
      const store = useCircuitStore.getState()
      if (store.activeTool.kind === 'wire' && store.interaction.wireDraft) {
        store.setWireCursor(worldPoint(e))
      }
    }

    function onPointerUp(e: PointerEvent): void {
      if (pan || drag) {
        try {
          canvas!.releasePointerCapture(e.pointerId)
        } catch {
          // capture may already be released
        }
      }
      pan = null
      drag = null
    }

    function onContextMenu(e: MouseEvent): void {
      e.preventDefault()
      const store = useCircuitStore.getState()
      const hit = hitComponent(store.netlist, worldPoint(e))
      if (hit?.type === ComponentType.STATE_MACHINE) store.setSmEditorOpen(true)
    }

    function onDoubleClick(e: MouseEvent): void {
      const store = useCircuitStore.getState()
      if (store.activeTool.kind !== 'wire') return
      const draft = store.interaction.wireDraft
      if (!draft) return
      const last = draft.points[draft.points.length - 1]
      const target = snapPoint(worldPoint(e))
      store.finishWire(target, null, hFirstFor(last, target, e.shiftKey))
    }

    function onWheel(e: WheelEvent): void {
      e.preventDefault()
      useCircuitStore.getState().zoomAt(screenPoint(e), e.deltaY < 0 ? 1.1 : 1 / 1.1)
    }

    function onKeyDown(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      const store = useCircuitStore.getState()

      if (e.key === ' ') {
        spaceDown = true
        return
      }
      if (e.key === 'Escape') {
        if (store.interaction.wireDraft) store.cancelWire()
        else if (store.interaction.inlineEdit) store.cancelInlineEdit()
        else store.clearSelection()
        return
      }
      const nudges: Record<string, Point> = {
        ArrowUp: { x: 0, y: -GRID },
        ArrowDown: { x: 0, y: GRID },
        ArrowLeft: { x: -GRID, y: 0 },
        ArrowRight: { x: GRID, y: 0 }
      }
      const delta = nudges[e.key]
      if (delta && store.selection.componentIds.length > 0) {
        e.preventDefault()
        store.nudgeSelection(delta.x, delta.y)
      }
    }

    function onKeyUp(e: KeyboardEvent): void {
      if (e.key === ' ') spaceDown = false
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('dblclick', onDoubleClick)
    canvas.addEventListener('contextmenu', onContextMenu)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('dblclick', onDoubleClick)
      canvas.removeEventListener('contextmenu', onContextMenu)
      canvas.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [canvasRef])
}
