// Logic-vector utilities shared by the simulator. Vectors are LSB-first.

import { LogicValue } from '../model/types'

const { ZERO, ONE, X, Z } = LogicValue

export const clean = (v: LogicValue): boolean => v === ZERO || v === ONE

export const xVec = (bits: number): LogicValue[] => new Array<LogicValue>(bits).fill(X)
export const zVec = (bits: number): LogicValue[] => new Array<LogicValue>(bits).fill(Z)

export function vecEqual(a: LogicValue[] | undefined, b: LogicValue[]): boolean {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** null when any bit is not a clean 0/1. */
export function vecToNum(vec: LogicValue[]): number | null {
  let n = 0
  for (let i = vec.length - 1; i >= 0; i--) {
    if (!clean(vec[i])) return null
    n = n * 2 + (vec[i] === ONE ? 1 : 0)
  }
  return n
}

export function numToVec(n: number, bits: number): LogicValue[] {
  const vec: LogicValue[] = []
  for (let i = 0; i < bits; i++) vec.push((n >> i) & 1 ? ONE : ZERO)
  return vec
}

/** Uppercase hex; 'X'/'Z' fills when bits are not clean. */
export function vecToHex(vec: LogicValue[]): string {
  const digits = Math.ceil(vec.length / 4)
  if (vec.every((v) => v === Z)) return 'Z'.repeat(digits)
  if (!vec.every(clean)) return 'X'.repeat(digits)
  let out = ''
  for (let d = 0; d < digits; d++) {
    let nibble = 0
    for (let b = 3; b >= 0; b--) {
      const i = d * 4 + b
      nibble = nibble * 2 + (i < vec.length && vec[i] === ONE ? 1 : 0)
    }
    out = nibble.toString(16).toUpperCase() + out
  }
  return out
}

/** Hex string (no prefix) -> vector, or null when not valid hex. */
export function hexToVec(hex: string, bits: number): LogicValue[] | null {
  const s = hex.trim()
  if (!/^[0-9a-fA-F]+$/.test(s)) return null
  const vec = zVec(bits).fill(ZERO)
  for (let d = 0; d < s.length; d++) {
    const nibble = parseInt(s[s.length - 1 - d], 16)
    for (let b = 0; b < 4; b++) {
      const i = d * 4 + b
      if (i < bits) vec[i] = (nibble >> b) & 1 ? ONE : ZERO
    }
  }
  return vec
}
