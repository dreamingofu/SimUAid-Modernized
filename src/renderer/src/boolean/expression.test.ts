import { describe, expect, it } from 'vitest'
import {
  analyzeExpression,
  BooleanSyntaxError,
  evaluateTruthMask,
  formatReport,
  formatSop,
  MAX_EXPRESSION_LENGTH,
  minimumCover,
  parseExpression,
  parseVariableList,
  primeImplicants,
  type Implicant
} from './expression'

const ABCD = 'A B C D'

function mask(expression: string, vars = ['A', 'B', 'C', 'D']): number {
  return evaluateTruthMask(parseExpression(expression), vars)
}

function onSetOf(minterms: number[]): number {
  return minterms.reduce((m, r) => m | (1 << r), 0)
}

function coverMask(terms: Implicant[], n: number): number {
  let m = 0
  for (let r = 0; r < 1 << n; r++) if (terms.some((t) => (r & t.mask) === t.bits)) m |= 1 << r
  return m
}

function popcount(x: number): number {
  let c = 0
  for (; x; x &= x - 1) c++
  return c
}

/** Brute-force minimum (terms, then literals) over every subset of prime implicants. */
function bruteForceCost(onSet: number, n: number): [number, number] {
  const primes = primeImplicants(onSet, n)
  let best: [number, number] = [Infinity, Infinity]
  for (let s = 0; s < 1 << primes.length; s++) {
    const chosen = primes.filter((_, i) => (s >> i) & 1)
    if (coverMask(chosen, n) !== onSet) continue
    const cost: [number, number] = [chosen.length, chosen.reduce((a, t) => a + popcount(t.mask), 0)]
    if (cost[0] < best[0] || (cost[0] === best[0] && cost[1] < best[1])) best = cost
  }
  return onSet === 0 ? [0, 0] : best
}

describe('Lab 3 assigned expression', () => {
  const a = analyzeExpression("BCD + ABCD' + C'D + AB'D", ABCD)

  it('finds the minterms and standard SOP', () => {
    expect(a.minterms).toEqual([1, 5, 7, 9, 11, 13, 14, 15])
    expect(a.standardSop).toBe(
      "A'B'C'D + A'BC'D + A'BCD + AB'C'D + AB'CD + ABC'D + ABCD' + ABCD")
    expect(a.rows.map((r) => r.output).join('')).toBe('0100010101010111')
  })

  it('finds the unique minimum SOP with deterministic term order', () => {
    expect(a.minimumSop).toBe("AD + BD + C'D + ABC")
    expect(a.terms).toHaveLength(4)
    expect(a.literalCount).toBe(9)
  })

  it('lists the truth table MSB-first', () => {
    expect(a.rows[0]).toEqual({ index: 0, inputs: [0, 0, 0, 0], output: 0 })
    expect(a.rows[14]).toEqual({ index: 14, inputs: [1, 1, 1, 0], output: 1 })
    expect(a.rows[3].inputs).toEqual([0, 0, 1, 1])
  })

  it('produces a copyable report', () => {
    const report = formatReport(a)
    expect(report).toContain('Σm(1, 5, 7, 9, 11, 13, 14, 15)')
    expect(report).toContain("Minimum SOP: F = AD + BD + C'D + ABC")
    expect(report.split('\n').filter((l) => /^\s+\d+ {2}[01] [01] [01] [01] [01]$/.test(l))).toHaveLength(16)
  })
})

describe('parsing normal Boolean notation', () => {
  it.each([
    ["AB'", "A*B'"],
    ["A·B'", "AB'"],
    ["(A+B)'", "A'B'"],
    ["(AB)'", "A' + B'"],
    ["A''", 'A'],
    ['A(B + C)', 'AB + AC'],
    ['(A + B)(A + C)', 'A + BC'],
    ["A ’ B", "A'B"],
    ['a b + c', 'AB + C'],
    ["[A + B]'", "A'B'"],
    ["[(A + B)C]' + D", "A'B' + C' + D"],
    ["([A + B][C + D])'", "A'B' + C'D'"],
    ["A'′", 'A']
  ])('%s ≡ %s', (left, right) => {
    expect(mask(left)).toBe(mask(right))
  })

  it('handles constants', () => {
    expect(analyzeExpression('0', ABCD).minimumSop).toBe('0')
    expect(analyzeExpression('1', ABCD).minimumSop).toBe('1')
    expect(analyzeExpression("A + A'", ABCD).minimumSop).toBe('1')
    expect(analyzeExpression("AA'", ABCD).minimumSop).toBe('0')
    expect(analyzeExpression('A1 + 0', ABCD).minimumSop).toBe('A')
    expect(analyzeExpression("0'", ABCD).minterms).toHaveLength(16)
    expect(analyzeExpression('0', ABCD).standardSop).toBe('0')
  })

  it('applies absorption and consensus', () => {
    expect(analyzeExpression('A + AB', ABCD).minimumSop).toBe('A')
    expect(analyzeExpression('A(A + B)', ABCD).minimumSop).toBe('A')
    expect(analyzeExpression("A + A'B", ABCD).minimumSop).toBe('A + B')
    expect(analyzeExpression("AB + A'C + BC", ABCD).minimumSop).toBe("AB + A'C")
  })

  it('honours parentheses and precedence (AND binds tighter than OR)', () => {
    expect(mask('A + BC')).not.toBe(mask('(A + B)C'))
    expect(analyzeExpression('(A + B)C', ABCD).minimumSop).toBe('AC + BC')
    expect(analyzeExpression("((A + B)' + C)'", ABCD).minimumSop).toBe("AC' + BC'")
  })

  it('accepts an output name prefix', () => {
    const a = analyzeExpression('G = AB', ABCD)
    expect(a.outputName).toBe('G')
    expect(a.expression).toBe('AB')
  })

  it('keeps every listed input even when the function ignores one', () => {
    const a = analyzeExpression("AB + AB'", ABCD)
    expect(a.minimumSop).toBe('A')
    expect(a.variables).toEqual(['A', 'B', 'C', 'D'])
    expect(a.rows).toHaveLength(16)
  })

  it('supports one to four explicit ordered inputs', () => {
    expect(parseVariableList('ABCD')).toEqual(['A', 'B', 'C', 'D'])
    expect(parseVariableList('x, y')).toEqual(['X', 'Y'])
    const a = analyzeExpression("XY' + Y", 'Y X')
    expect(a.rows.map((r) => r.output).join('')).toBe('0111')
    expect(a.minimumSop).toBe('Y + X')
    expect(analyzeExpression('Q', 'Q').rows).toHaveLength(2)
  })

  it('agrees with a known equivalence (consensus form of XOR)', () => {
    expect(mask("AB' + A'B")).toBe(mask("(A + B)(A' + B')"))
    expect(mask("AB' + A'B")).toBe(mask("(AB + A'B')'"))
  })
})

describe('malformed input produces actionable errors', () => {
  const cases: [string, RegExp][] = [
    ['', /Enter an expression/],
    ['   ', /Enter an expression/],
    ['A +', /needs a term after/],
    ['+ A', /needs a term before/],
    ['A ++ B', /needs a term after/],
    ['(A + B', /Missing "\)".*column 1/],
    ['A + B)', /Unmatched "\)".*column 6/],
    ['()', /Empty group "\(\)"/],
    ['[]', /Empty group "\[\]"/],
    ['[A+B)', /"\)" does not match the "\[" at column 1; use "\]".*column 5/],
    ['(A+B]', /"\]" does not match the "\(" at column 1; use "\)".*column 5/],
    ['([A+B)]', /"\)" does not match the "\[" at column 2/],
    ['[(A+B])', /"\]" does not match the "\(" at column 2/],
    ['A + B]', /Unmatched "\]".*remove it or add a matching "\["/],
    ['[A + B', /Missing "\]" for the "\["/],
    ["'A", /prime.*must follow/],
    ['~A', /Prefix NOT/],
    ['!A', /Prefix NOT/],
    ['A # B', /Unexpected character "#".*column 3/],
    ['A2', /only 0 and 1/],
    ['AE', /E is not in the input list \(A, B, C, D\)/],
    ['A* + B', /AND operator needs a term after/],
    ['A = A + B', /also an input/]
  ]
  it.each(cases)('%j', (text, message) => {
    expect(() => analyzeExpression(text, ABCD)).toThrow(BooleanSyntaxError)
    expect(() => analyzeExpression(text, ABCD)).toThrow(message)
  })

  it('validates the input list', () => {
    expect(() => parseVariableList('')).toThrow(/List the inputs/)
    expect(() => parseVariableList('A A')).toThrow(/listed twice/)
    expect(() => parseVariableList('A B C D E')).toThrow(/At most 4/)
    expect(() => parseVariableList('A1')).toThrow(/single letters/)
  })

  it('bounds input size and nesting', () => {
    expect(() => analyzeExpression('A'.repeat(MAX_EXPRESSION_LENGTH + 1), ABCD)).toThrow(/longer than/)
    expect(() => analyzeExpression('('.repeat(17) + 'A' + ')'.repeat(17), ABCD)).toThrow(/nested more than 16/)
    expect(() => analyzeExpression('('.repeat(16) + 'A' + ')'.repeat(16), ABCD)).not.toThrow()
    expect(() => analyzeExpression("A" + "'".repeat(450), ABCD)).toThrow(/too complex/)
  })

  it('never evaluates the text as code', () => {
    expect(() => analyzeExpression('constructor', ABCD)).toThrow(/not in the input list/)
    expect(() => analyzeExpression('alert(1)', ABCD)).toThrow(/not in the input list/)
  })
})

describe('exact minimization', () => {
  it('matches brute force for every function of three variables', () => {
    for (let f = 0; f < 256; f++) {
      const terms = minimumCover(f, 3)
      expect(coverMask(terms, 3)).toBe(f)
      expect([terms.length, terms.reduce((s, t) => s + popcount(t.mask), 0)]).toEqual(bruteForceCost(f, 3))
    }
  })

  it('covers exactly the on-set for every function of four variables', () => {
    for (let f = 0; f < 1 << 16; f++) {
      expect(coverMask(minimumCover(f, 4), 4)).toBe(f)
    }
  }, 60_000)

  it('matches brute force on hard four-variable functions', () => {
    const hard = [
      onSetOf([0, 3, 5, 6, 9, 10, 12, 15]), // XOR/XNOR checkerboard
      onSetOf([0, 1, 2, 5, 6, 7, 8, 9, 10, 14]), // cyclic core
      onSetOf([0, 2, 4, 5, 6, 7, 8, 10, 13, 15]),
      onSetOf([1, 5, 7, 9, 11, 13, 14, 15])
    ]
    let seed = 7
    for (let i = 0; i < 40; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      hard.push(seed & 0xffff)
    }
    for (const f of hard) {
      const terms = minimumCover(f, 4)
      expect([terms.length, terms.reduce((s, t) => s + popcount(t.mask), 0)]).toEqual(bruteForceCost(f, 4))
    }
  })

  it('breaks ties deterministically', () => {
    // Cyclic function with two equal-cost minimum covers.
    const f = onSetOf([0, 1, 2, 5, 6, 7])
    const vars = ['A', 'B', 'C']
    const first = formatSop(minimumCover(f, 3), vars)
    for (let i = 0; i < 5; i++) expect(formatSop(minimumCover(f, 3), vars)).toBe(first)
    expect(first).toBe("AB + A'C' + B'C")
  })
})
