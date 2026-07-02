// State-machine table parsing. Input expressions AND pin labels together; a
// label followed by a prime (') is complemented; tokens can concatenate labels
// (e.g. "A'B" = A' AND B); "-" means don't-care. Output cells list the output
// labels that are 1 ("0" = all outputs 0). Rows are matched in order.

import { LogicValue, type Component, type SmRow } from '../model/types'

export interface SmTerm {
  pinName: string
  negated: boolean
}

export interface CompiledSmRow {
  index: number
  present: number
  /** null = don't-care (matches any input combination). */
  terms: SmTerm[] | null
  /** Pin names driven to 1; the rest of the outputs are 0. */
  highOutputs: string[]
  next: number
}

export interface SmCellError {
  row: number
  column: keyof SmRow
  message: string
}

export interface CompiledSmTable {
  rows: CompiledSmRow[]
  errors: SmCellError[]
}

function isRowEmpty(row: SmRow): boolean {
  return !row.present.trim() && !row.input.trim() && !row.output.trim() && !row.next.trim()
}

/** label -> pin name maps for the labeled input/output pins of an SM component. */
export function smLabelMaps(comp: Component): {
  inputs: Map<string, string>
  outputs: Map<string, string>
} {
  const inputs = new Map<string, string>()
  const outputs = new Map<string, string>()
  const nIn = comp.smInputs ?? 0
  const nOut = comp.smOutputs ?? 0
  for (let i = 1; i <= nIn; i++) {
    const label = comp.pinLabels[`in${i}`]
    if (label) inputs.set(label, `in${i}`)
  }
  for (let i = 1; i <= nOut; i++) {
    const label = comp.pinLabels[`out${i}`]
    if (label) outputs.set(label, `out${i}`)
  }
  return { inputs, outputs }
}

/** Greedy longest-label match so multi-character labels concatenate unambiguously. */
export function parseInputExpr(
  expr: string,
  labelToPin: Map<string, string>
): SmTerm[] | null | string {
  const text = expr.trim()
  if (text === '-') return null
  if (!text) return 'Input is empty (use - for don’t-care)'

  const labels = [...labelToPin.keys()].sort((a, b) => b.length - a.length)
  const terms: SmTerm[] = []
  for (const token of text.split(/\s+/)) {
    let i = 0
    while (i < token.length) {
      let matched = ''
      for (const label of labels) {
        if (token.startsWith(label, i)) {
          matched = label
          break
        }
      }
      if (!matched) return `Unknown input label at "${token.slice(i)}"`
      i += matched.length
      let negated = false
      if (token[i] === "'") {
        negated = true
        i++
      }
      terms.push({ pinName: labelToPin.get(matched)!, negated })
    }
  }
  return terms
}

export function parseOutputs(
  expr: string,
  labelToPin: Map<string, string>
): string[] | string {
  const text = expr.trim()
  if (!text) return 'Output is empty (use 0 for all-zero)'
  if (text === '0') return []
  const pins: string[] = []
  for (const token of text.split(/\s+/)) {
    const pin = labelToPin.get(token)
    if (!pin) return `Unknown output label "${token}"`
    pins.push(pin)
  }
  return pins
}

function parseState(text: string): number | string {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return 'State must be a non-negative integer'
  return parseInt(t, 10)
}

export function checkCell(
  comp: Component,
  row: SmRow,
  column: keyof SmRow
): string | null {
  if (isRowEmpty(row)) return null
  const { inputs, outputs } = smLabelMaps(comp)
  switch (column) {
    case 'present':
    case 'next': {
      const r = parseState(row[column])
      return typeof r === 'string' ? r : null
    }
    case 'input': {
      const r = parseInputExpr(row.input, inputs)
      return typeof r === 'string' ? r : null
    }
    case 'output': {
      const r = parseOutputs(row.output, outputs)
      return typeof r === 'string' ? r : null
    }
  }
}

export function compileTable(comp: Component): CompiledSmTable {
  const rows: CompiledSmRow[] = []
  const errors: SmCellError[] = []
  const { inputs, outputs } = smLabelMaps(comp)

  ;(comp.smTable ?? []).forEach((row, index) => {
    if (isRowEmpty(row)) return
    let bad = false
    const present = parseState(row.present)
    if (typeof present === 'string') {
      errors.push({ row: index, column: 'present', message: present })
      bad = true
    }
    const next = parseState(row.next)
    if (typeof next === 'string') {
      errors.push({ row: index, column: 'next', message: next })
      bad = true
    }
    const terms = parseInputExpr(row.input, inputs)
    if (typeof terms === 'string') {
      errors.push({ row: index, column: 'input', message: terms })
      bad = true
    }
    const highOutputs = parseOutputs(row.output, outputs)
    if (typeof highOutputs === 'string') {
      errors.push({ row: index, column: 'output', message: highOutputs })
      bad = true
    }
    if (!bad) {
      rows.push({
        index,
        present: present as number,
        terms: terms as SmTerm[] | null,
        highOutputs: highOutputs as string[],
        next: next as number
      })
    }
  })

  return { rows, errors }
}

/** Evaluates a compiled row's input terms; null when any referenced pin is X/Z. */
export function termsMatch(
  terms: SmTerm[] | null,
  readPin: (pinName: string) => LogicValue
): boolean | null {
  if (terms === null) return true
  for (const term of terms) {
    const v = readPin(term.pinName)
    if (v !== LogicValue.ZERO && v !== LogicValue.ONE) return null
    const isOne = v === LogicValue.ONE
    if (term.negated === isOne) return false
  }
  return true
}
