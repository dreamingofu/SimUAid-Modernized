// Coordinate system helpers. The netlist stores *world* coordinates; the canvas
// shows them through a viewport that scales and translates world -> screen. All
// pointer math converts screen -> world first, then snaps to the grid.

export interface Point {
  x: number
  y: number
}

export interface Viewport {
  scale: number
  offsetX: number
  offsetY: number
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Editor grid size in world px; placement and free wire points snap to it. */
export const GRID = 10

/** Printed-page size in world px (used to draw page-boundary guides). */
export const PAGE_WIDTH = 1100
export const PAGE_HEIGHT = 850

export const MIN_SCALE = 0.25
export const MAX_SCALE = 4

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

export function worldToScreen(p: Point, vp: Viewport): Point {
  return { x: p.x * vp.scale + vp.offsetX, y: p.y * vp.scale + vp.offsetY }
}

export function screenToWorld(p: Point, vp: Viewport): Point {
  return { x: (p.x - vp.offsetX) / vp.scale, y: (p.y - vp.offsetY) / vp.scale }
}

export function snapToGrid(value: number, grid = GRID): number {
  return Math.round(value / grid) * grid
}

export function snapPoint(p: Point, grid = GRID): Point {
  return { x: snapToGrid(p.x, grid), y: snapToGrid(p.y, grid) }
}

/**
 * Computes a viewport that fits `bounds` (world) within a canvas of the given
 * size, centered, with some padding. Returns a sensible default when bounds are
 * empty/degenerate.
 */
export function fitToBounds(
  bounds: Bounds | null,
  canvasW: number,
  canvasH: number,
  padding = 48
): Viewport {
  if (!bounds || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) {
    return { scale: 1, offsetX: padding, offsetY: padding }
  }
  const bw = bounds.maxX - bounds.minX
  const bh = bounds.maxY - bounds.minY
  const scale = clampScale(
    Math.min((canvasW - 2 * padding) / bw, (canvasH - 2 * padding) / bh)
  )
  const offsetX = (canvasW - bw * scale) / 2 - bounds.minX * scale
  const offsetY = (canvasH - bh * scale) / 2 - bounds.minY * scale
  return { scale, offsetX, offsetY }
}
