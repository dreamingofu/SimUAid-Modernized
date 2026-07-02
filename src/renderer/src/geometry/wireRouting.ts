// Wire geometry. Wires are stored as arrays of segments (Phase 1 model) but are
// easiest to manipulate as a connected polyline of points. These helpers convert
// between the two and produce orthogonal (H/V-only) routes.

import type { Point } from './coords'
import type { WireSegment } from '../model/types'

/** Converts a connected segment list into its polyline of points. */
export function segmentsToPoints(segments: WireSegment[]): Point[] {
  if (segments.length === 0) return []
  const points: Point[] = [{ x: segments[0].x1, y: segments[0].y1 }]
  for (const seg of segments) {
    points.push({ x: seg.x2, y: seg.y2 })
  }
  return points
}

/** Converts a polyline of points into a connected segment list. */
export function pointsToSegments(points: Point[]): WireSegment[] {
  const segments: WireSegment[] = []
  for (let i = 0; i < points.length - 1; i++) {
    segments.push({
      x1: points[i].x,
      y1: points[i].y,
      x2: points[i + 1].x,
      y2: points[i + 1].y
    })
  }
  return segments
}

/**
 * Produces an orthogonal route from `from` to `to`. If they already share an x or
 * y, it is a single straight segment; otherwise one corner is inserted. `hFirst`
 * chooses whether the first leg is horizontal or vertical.
 */
export function routeOrthogonal(from: Point, to: Point, hFirst: boolean): Point[] {
  if (from.x === to.x || from.y === to.y) return [from, to]
  const corner = hFirst ? { x: to.x, y: from.y } : { x: from.x, y: to.y }
  return [from, corner, to]
}

/**
 * Re-anchors a wire endpoint to `newPos` when the attached component moves. Per
 * the agreed strategy: move only this endpoint and let the single attached
 * segment extend/shorten. If that would make the segment non-orthogonal, insert a
 * corner so all segments stay H/V — the rest of the wire is never re-routed.
 */
export function reattachEndpoint(points: Point[], atStart: boolean, newPos: Point): Point[] {
  if (points.length < 2) return points
  const endIndex = atStart ? 0 : points.length - 1
  const neighborIndex = atStart ? 1 : points.length - 2
  const oldPt = points[endIndex]
  const neighbor = points[neighborIndex]

  const result = points.slice()
  result[endIndex] = newPos

  // Still orthogonal (shares an axis with its neighbor) -> just extended/shortened.
  if (neighbor.x === newPos.x || neighbor.y === newPos.y) return result

  // Otherwise insert a corner that keeps both sub-segments orthogonal, preserving
  // the original first-leg orientation.
  const wasHorizontal = oldPt.y === neighbor.y
  const corner = wasHorizontal
    ? { x: neighbor.x, y: newPos.y }
    : { x: newPos.x, y: neighbor.y }

  if (atStart) result.splice(1, 0, corner)
  else result.splice(result.length - 1, 0, corner)
  return result
}
