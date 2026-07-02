import { ComponentType, LogicValue } from '../model/types'

const { ZERO, ONE, X } = LogicValue

export type GateFamily = 'and' | 'or' | 'nand' | 'nor' | 'xor' | 'xnor' | 'not'

const GATE_FAMILY: Partial<Record<ComponentType, GateFamily>> = {
  [ComponentType.AND2]: 'and',
  [ComponentType.AND3]: 'and',
  [ComponentType.AND4]: 'and',
  [ComponentType.AND5]: 'and',
  [ComponentType.OR2]: 'or',
  [ComponentType.OR3]: 'or',
  [ComponentType.OR4]: 'or',
  [ComponentType.OR5]: 'or',
  [ComponentType.NAND2]: 'nand',
  [ComponentType.NAND3]: 'nand',
  [ComponentType.NAND4]: 'nand',
  [ComponentType.NAND5]: 'nand',
  [ComponentType.NOR2]: 'nor',
  [ComponentType.NOR3]: 'nor',
  [ComponentType.NOR4]: 'nor',
  [ComponentType.NOR5]: 'nor',
  [ComponentType.XOR2]: 'xor',
  [ComponentType.XNOR2]: 'xnor',
  [ComponentType.NOT]: 'not'
}

export function gateFamily(type: ComponentType): GateFamily | null {
  return GATE_FAMILY[type] ?? null
}

function complement(v: LogicValue): LogicValue {
  if (v === ZERO) return ONE
  if (v === ONE) return ZERO
  return X
}

// A controlling 0 forces AND to 0 even when other inputs are Z/X.
function evalAnd(inputs: LogicValue[]): LogicValue {
  let allOne = true
  for (const v of inputs) {
    if (v === ZERO) return ZERO
    if (v !== ONE) allOne = false
  }
  return allOne ? ONE : X
}

// A controlling 1 forces OR to 1 even when other inputs are Z/X.
function evalOr(inputs: LogicValue[]): LogicValue {
  let allZero = true
  for (const v of inputs) {
    if (v === ONE) return ONE
    if (v !== ZERO) allZero = false
  }
  return allZero ? ZERO : X
}

function evalXor(inputs: LogicValue[]): LogicValue {
  let ones = 0
  for (const v of inputs) {
    if (v !== ZERO && v !== ONE) return X
    if (v === ONE) ones++
  }
  return ones % 2 === 1 ? ONE : ZERO
}

export function evalGate(family: GateFamily, inputs: LogicValue[]): LogicValue {
  switch (family) {
    case 'and':
      return evalAnd(inputs)
    case 'nand':
      return complement(evalAnd(inputs))
    case 'or':
      return evalOr(inputs)
    case 'nor':
      return complement(evalOr(inputs))
    case 'xor':
      return evalXor(inputs)
    case 'xnor':
      return complement(evalXor(inputs))
    case 'not':
      return complement(inputs[0] ?? LogicValue.Z)
  }
}

export type FlipFlopKind = 'd' | 'jk'

export interface FlipFlopInputs {
  clk: LogicValue
  s: LogicValue // preset, active low
  r: LogicValue // clear, active low
  d?: LogicValue
  j?: LogicValue
  k?: LogicValue
}

const isClean = (v: LogicValue): boolean => v === ZERO || v === ONE

/**
 * Resolves Q after applying asynchronous S/R (which override the clock) and, if
 * S/R are both inactive, the clocked behavior on the part's active edge.
 * Indeterminate control lines (Z/X on S or R) yield X — a flip-flop must have all
 * inputs driven.
 */
export function nextFlipFlopQ(
  kind: FlipFlopKind,
  inputs: FlipFlopInputs,
  prevQ: LogicValue,
  prevClk: LogicValue
): LogicValue {
  const { clk, s, r } = inputs

  if (!isClean(s) || !isClean(r)) return X
  if (s === ZERO && r === ZERO) return X
  if (s === ZERO) return ONE
  if (r === ZERO) return ZERO

  if (kind === 'd') {
    const rising = prevClk === ZERO && clk === ONE
    if (!rising) return prevQ
    const d = inputs.d ?? LogicValue.Z
    return isClean(d) ? d : X
  }

  const falling = prevClk === ONE && clk === ZERO
  if (!falling) return prevQ
  const j = inputs.j ?? LogicValue.Z
  const k = inputs.k ?? LogicValue.Z
  if (!isClean(j) || !isClean(k)) return X
  if (j === ONE && k === ONE) return complement(prevQ)
  if (j === ONE) return ONE
  if (k === ONE) return ZERO
  return prevQ
}
