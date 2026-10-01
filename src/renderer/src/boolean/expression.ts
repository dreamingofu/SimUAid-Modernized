// Boolean expression analysis for up to four single-letter inputs: a small
// recursive-descent parser (no eval), truth-table evaluation over bitmasks, the
// standard sum of minterms, and an exact minimum sum of products.
//
// Notation: adjacency or `*`/`·` is AND, `+` is OR, a postfix prime (' ’ ′) is
// NOT, parentheses group, and 0/1 are constants. Variable names are single
// letters and case-insensitive (`a` is `A`). An optional `F =` prefix names the
// output.

export const MAX_VARIABLES = 4
export const MAX_EXPRESSION_LENGTH = 512
export const MAX_NESTING = 16
export const MAX_NODES = 400

export type Expr =
  | { kind: 'const'; value: 0 | 1 }
  | { kind: 'var'; name: string }
  | { kind: 'not'; operand: Expr }
  | { kind: 'and'; operands: Expr[] }
  | { kind: 'or'; operands: Expr[] }

/** A product term: `mask` marks which variables appear, `bits` their required values. */
export interface Implicant {
  mask: number
  bits: number
}

export interface TruthRow {
  index: number
  inputs: number[]
  output: 0 | 1
}

export interface BooleanAnalysis {
  /** Inputs in truth-table order; the first is the most significant bit. */
  variables: string[]
  outputName: string
  /** The expression as entered, without the optional `F =` prefix. */
  expression: string
  minterms: number[]
  rows: TruthRow[]
  standardSop: string
  /** Prime implicants of the minimum cover, in display order. */
  terms: Implicant[]
  minimumSop: string
  literalCount: number
}

export class BooleanSyntaxError extends Error {
  /** 1-based column within the text the user typed, when one applies. */
  constructor(message: string, readonly column: number | null = null) {
    super(column === null ? message : `${message} (column ${column})`)
    this.name = 'BooleanSyntaxError'
  }
}

const PRIMES = new Set(["'", '’', '′', '‘', 'ʼ'])
const AND_OPS = new Set(['*', '·', '⋅', '•', '&'])
const OR_OPS = new Set(['+', '|'])

type Token =
  | { kind: 'var'; name: string; col: number }
  | { kind: 'const'; value: 0 | 1; col: number }
  | { kind: 'prime'; col: number }
  | { kind: 'and'; col: number }
  | { kind: 'or'; col: number }
  | { kind: 'open'; glyph: '(' | '['; col: number }
  | { kind: 'close'; glyph: ')' | ']'; col: number }

function tokenize(text: string, offset: number): Token[] {
  const tokens: Token[] = []
  // Iterate code points so a Unicode prime keeps its column honest.
  let col = offset
  for (const ch of text) {
    col += 1
    if (/\s/.test(ch)) continue
    if (/^[A-Za-z]$/.test(ch)) tokens.push({ kind: 'var', name: ch.toUpperCase(), col })
    else if (ch === '0' || ch === '1') tokens.push({ kind: 'const', value: ch === '1' ? 1 : 0, col })
    else if (PRIMES.has(ch)) tokens.push({ kind: 'prime', col })
    else if (AND_OPS.has(ch)) tokens.push({ kind: 'and', col })
    else if (OR_OPS.has(ch)) tokens.push({ kind: 'or', col })
    else if (ch === '(' || ch === '[') tokens.push({ kind: 'open', glyph: ch, col })
    else if (ch === ')' || ch === ']') tokens.push({ kind: 'close', glyph: ch, col })
    else if (ch === '~' || ch === '!' || ch === '¬') {
      throw new BooleanSyntaxError(`Prefix NOT "${ch}" is not supported; write a prime after the term instead, e.g. A' or (A+B)'`, col)
    } else if (/^[2-9]$/.test(ch)) {
      throw new BooleanSyntaxError(`"${ch}" is not a Boolean constant; only 0 and 1 are allowed`, col)
    } else {
      throw new BooleanSyntaxError(`Unexpected character "${ch}"; use letters, +, ', parentheses, 0 or 1`, col)
    }
  }
  return tokens
}

class Parser {
  private pos = 0
  private nodes = 0

  constructor(private tokens: Token[], private endCol: number) {}

  parse(): Expr {
    if (this.tokens.length === 0) throw new BooleanSyntaxError('Enter an expression, e.g. AB + C\'D')
    const expr = this.parseOr(0)
    const extra = this.tokens[this.pos]
    if (extra) {
      if (extra.kind === 'close') {
        throw new BooleanSyntaxError(`Unmatched "${extra.glyph}"; remove it or add a matching "${OPENER[extra.glyph]}"`, extra.col)
      }
      throw new BooleanSyntaxError('Unexpected symbol', extra.col)
    }
    return expr
  }

  private node<T extends Expr>(expr: T): T {
    if (++this.nodes > MAX_NODES) {
      throw new BooleanSyntaxError(`Expression is too complex (more than ${MAX_NODES} operations); simplify or split it`)
    }
    return expr
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private parseOr(depth: number): Expr {
    const operands = [this.parseAnd(depth)]
    while (this.peek()?.kind === 'or') {
      const op = this.tokens[this.pos++]
      const next = this.peek()
      if (!next || next.kind === 'or' || next.kind === 'close' || next.kind === 'and' || next.kind === 'prime') {
        throw new BooleanSyntaxError('"+" needs a term after it', next?.col ?? op.col)
      }
      operands.push(this.parseAnd(depth))
    }
    return operands.length === 1 ? operands[0] : this.node({ kind: 'or', operands })
  }

  private parseAnd(depth: number): Expr {
    const operands = [this.parseFactor(depth)]
    for (;;) {
      const next = this.peek()
      if (!next) break
      if (next.kind === 'and') {
        this.pos++
        const after = this.peek()
        if (!after || !startsFactor(after)) {
          throw new BooleanSyntaxError('AND operator needs a term after it', after?.col ?? next.col)
        }
        operands.push(this.parseFactor(depth))
      } else if (startsFactor(next)) {
        // Adjacency is AND: AB, A(B+C), (A+B)(C+D).
        operands.push(this.parseFactor(depth))
      } else {
        break
      }
    }
    return operands.length === 1 ? operands[0] : this.node({ kind: 'and', operands })
  }

  private parseFactor(depth: number): Expr {
    let expr = this.parsePrimary(depth)
    while (this.peek()?.kind === 'prime') {
      this.pos++
      expr = this.node({ kind: 'not', operand: expr })
    }
    return expr
  }

  private parsePrimary(depth: number): Expr {
    const token = this.peek()
    if (!token) throw new BooleanSyntaxError('Expression ends early; a term is missing', this.endCol)
    switch (token.kind) {
      case 'var':
        this.pos++
        return this.node({ kind: 'var', name: token.name })
      case 'const':
        this.pos++
        return this.node({ kind: 'const', value: token.value })
      case 'open': {
        if (depth + 1 > MAX_NESTING) {
          throw new BooleanSyntaxError(`Parentheses are nested more than ${MAX_NESTING} levels deep`, token.col)
        }
        this.pos++
        const closer = CLOSER[token.glyph]
        if (this.peek()?.kind === 'close') {
          throw new BooleanSyntaxError(`Empty group "${token.glyph}${closer}"`, token.col)
        }
        const inner = this.parseOr(depth + 1)
        const end = this.peek()
        if (end?.kind !== 'close') {
          throw new BooleanSyntaxError(`Missing "${closer}" for the "${token.glyph}" here`, token.col)
        }
        if (end.glyph !== closer) {
          throw new BooleanSyntaxError(`"${end.glyph}" does not match the "${token.glyph}" at column ${token.col}; use "${closer}"`, end.col)
        }
        this.pos++
        return inner
      }
      case 'prime':
        throw new BooleanSyntaxError('A prime (\') must follow a variable, constant or ")"', token.col)
      case 'or':
        throw new BooleanSyntaxError('"+" needs a term before it', token.col)
      case 'and':
        throw new BooleanSyntaxError('AND operator needs a term before it', token.col)
      case 'close':
        throw new BooleanSyntaxError(`Unmatched "${token.glyph}" or missing term before it`, token.col)
    }
  }
}

const CLOSER = { '(': ')', '[': ']' } as const
const OPENER = { ')': '(', ']': '[' } as const

function startsFactor(token: Token): boolean {
  return token.kind === 'var' || token.kind === 'const' || token.kind === 'open'
}

/** Parses an ordered input list such as "A B C D", "A,B,C,D" or "ABCD". */
export function parseVariableList(text: string): string[] {
  const letters = [...text.replace(/[\s,;]+/g, '')]
  if (letters.length === 0) throw new BooleanSyntaxError('List the inputs in order, e.g. A B C D')
  const vars: string[] = []
  for (const ch of letters) {
    if (!/^[A-Za-z]$/.test(ch)) {
      throw new BooleanSyntaxError(`Input names must be single letters; "${ch}" is not a letter`)
    }
    const name = ch.toUpperCase()
    if (vars.includes(name)) throw new BooleanSyntaxError(`Input ${name} is listed twice`)
    vars.push(name)
  }
  if (vars.length > MAX_VARIABLES) {
    throw new BooleanSyntaxError(`At most ${MAX_VARIABLES} inputs are supported; ${vars.length} were listed`)
  }
  return vars
}

/** Splits an optional "F =" prefix off the expression text. */
export function splitOutputName(text: string): { outputName: string; body: string; offset: number } {
  const match = /^\s*([A-Za-z][A-Za-z0-9_]{0,7})\s*=/.exec(text)
  if (!match) return { outputName: 'F', body: text, offset: 0 }
  return { outputName: match[1], body: text.slice(match[0].length), offset: [...match[0]].length }
}

export function parseExpression(text: string, offset = 0): Expr {
  if (text.length > MAX_EXPRESSION_LENGTH) {
    throw new BooleanSyntaxError(`Expression is longer than ${MAX_EXPRESSION_LENGTH} characters`)
  }
  const tokens = tokenize(text, offset)
  return new Parser(tokens, offset + [...text].length).parse()
}

function collectVariables(expr: Expr, out: Set<string>): void {
  switch (expr.kind) {
    case 'var': out.add(expr.name); return
    case 'const': return
    case 'not': collectVariables(expr.operand, out); return
    default: for (const e of expr.operands) collectVariables(e, out)
  }
}

/**
 * Evaluates the expression for every input row at once: bit `r` of the result
 * is the output for row `r`, where row `r` assigns the first variable its most
 * significant bit.
 */
export function evaluateTruthMask(expr: Expr, variables: string[]): number {
  const n = variables.length
  const rows = 1 << n
  const all = rows === 32 ? 0xffffffff : (1 << rows) - 1
  const varMask = (i: number): number => {
    let m = 0
    for (let r = 0; r < rows; r++) if ((r >> (n - 1 - i)) & 1) m |= 1 << r
    return m
  }
  const masks = new Map(variables.map((v, i) => [v, varMask(i)]))
  const evaluate = (e: Expr): number => {
    switch (e.kind) {
      case 'const': return e.value ? all : 0
      case 'var': return masks.get(e.name)!
      case 'not': return ~evaluate(e.operand) & all
      case 'and': return e.operands.reduce((m, o) => m & evaluate(o), all)
      case 'or': return e.operands.reduce((m, o) => m | evaluate(o), 0)
    }
  }
  return evaluate(expr) & all
}

function covers(imp: Implicant, minterm: number): boolean {
  return (minterm & imp.mask) === imp.bits
}

/** All prime implicants of the on-set (n ≤ 4, so every cube can be enumerated). */
export function primeImplicants(onSet: number, n: number): Implicant[] {
  const rows = 1 << n
  const implicants: Implicant[] = []
  for (let mask = 0; mask < rows; mask++) {
    for (let bits = 0; bits < rows; bits++) {
      if ((bits & ~mask) !== 0) continue
      let ok = true
      for (let r = 0; r < rows && ok; r++) {
        if (covers({ mask, bits }, r) && !((onSet >> r) & 1)) ok = false
      }
      if (ok) implicants.push({ mask, bits })
    }
  }
  // Prime: no other implicant strictly contains it (drops a literal it keeps).
  return implicants.filter((a) => !implicants.some((b) =>
    b !== a && (b.mask & a.mask) === b.mask && b.mask !== a.mask && (a.bits & b.mask) === b.bits))
}

function popcount(x: number): number {
  let c = 0
  for (; x; x &= x - 1) c++
  return c
}

/** Sort key: variables in order, uncomplemented before complemented before absent. */
function termKey(imp: Implicant, n: number): string {
  let key = ''
  for (let i = 0; i < n; i++) {
    const bit = 1 << (n - 1 - i)
    key += !(imp.mask & bit) ? '3' : imp.bits & bit ? '1' : '2'
  }
  return key
}

function compareTerms(a: Implicant, b: Implicant, n: number): number {
  const byLiterals = popcount(a.mask) - popcount(b.mask)
  if (byLiterals !== 0) return byLiterals
  const ka = termKey(a, n)
  const kb = termKey(b, n)
  return ka < kb ? -1 : ka > kb ? 1 : 0
}

/**
 * Exact minimum cover: fewest product terms, then fewest literals, ties broken
 * by the sorted term order so the answer is deterministic.
 */
export function minimumCover(onSet: number, n: number): Implicant[] {
  if (onSet === 0) return []
  const rows = 1 << n
  const primes = primeImplicants(onSet, n).sort((a, b) => compareTerms(a, b, n))
  const minterms: number[] = []
  for (let r = 0; r < rows; r++) if ((onSet >> r) & 1) minterms.push(r)

  let best: { terms: Implicant[]; literals: number; key: string } | null = null
  const consider = (chosen: Implicant[]): void => {
    const terms = [...chosen].sort((a, b) => compareTerms(a, b, n))
    const literals = terms.reduce((s, t) => s + popcount(t.mask), 0)
    const key = terms.map((t) => termKey(t, n)).join('|')
    if (!best || terms.length < best.terms.length ||
        (terms.length === best.terms.length && (literals < best.literals ||
          (literals === best.literals && key < best.key)))) {
      best = { terms, literals, key }
    }
  }

  const search = (chosen: Implicant[], literals: number): void => {
    const uncovered = minterms.filter((m) => !chosen.some((t) => covers(t, m)))
    if (uncovered.length === 0) {
      consider(chosen)
      return
    }
    // Any completion needs at least one more term.
    if (best && (chosen.length + 1 > best.terms.length ||
        (chosen.length + 1 === best.terms.length && literals + 1 > best.literals))) return
    // Branch on the uncovered minterm with the fewest candidate primes.
    let pivot = uncovered[0]
    let candidates = primes.filter((p) => covers(p, pivot))
    for (const m of uncovered) {
      const c = primes.filter((p) => covers(p, m))
      if (c.length < candidates.length) { pivot = m; candidates = c }
    }
    for (const p of candidates) search([...chosen, p], literals + popcount(p.mask))
  }
  search([], 0)
  return best!.terms
}

export function formatTerm(imp: Implicant, variables: string[]): string {
  const n = variables.length
  if (imp.mask === 0) return '1'
  let text = ''
  for (let i = 0; i < n; i++) {
    const bit = 1 << (n - 1 - i)
    if (!(imp.mask & bit)) continue
    text += variables[i] + (imp.bits & bit ? '' : "'")
  }
  return text
}

export function formatSop(terms: Implicant[], variables: string[]): string {
  if (terms.length === 0) return '0'
  return terms.map((t) => formatTerm(t, variables)).join(' + ')
}

/** Parses, evaluates and minimizes. Throws BooleanSyntaxError with an actionable message. */
export function analyzeExpression(expressionText: string, variablesText: string): BooleanAnalysis {
  const variables = parseVariableList(variablesText)
  const { outputName, body, offset } = splitOutputName(expressionText)
  const upperOutput = outputName.toUpperCase()
  if (variables.includes(upperOutput)) {
    throw new BooleanSyntaxError(`Output name ${outputName} is also an input; choose a different output name`)
  }
  const expr = parseExpression(body, offset)
  const used = new Set<string>()
  collectVariables(expr, used)
  const unknown = [...used].filter((v) => !variables.includes(v)).sort()
  if (unknown.length > 0) {
    throw new BooleanSyntaxError(
      `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not in the input list (${variables.join(', ')}); ` +
      'add it to Inputs or correct the expression')
  }
  const n = variables.length
  const onSet = evaluateTruthMask(expr, variables)
  const rows: TruthRow[] = []
  const minterms: number[] = []
  for (let r = 0; r < 1 << n; r++) {
    const output = ((onSet >> r) & 1) as 0 | 1
    if (output) minterms.push(r)
    rows.push({ index: r, inputs: variables.map((_, i) => (r >> (n - 1 - i)) & 1), output })
  }
  const full = (1 << n) - 1
  const standardSop = minterms.length === 0
    ? '0'
    : minterms.map((m) => formatTerm({ mask: full, bits: m }, variables)).join(' + ')
  const terms = minimumCover(onSet, n)
  return {
    variables,
    outputName,
    expression: body.trim(),
    minterms,
    rows,
    standardSop,
    terms,
    minimumSop: formatSop(terms, variables),
    literalCount: terms.reduce((s, t) => s + popcount(t.mask), 0)
  }
}

/** The report's headline facts, one per line. */
export function reportSummary(a: BooleanAnalysis): string[] {
  return [
    `${a.outputName} = ${a.expression}`,
    `Inputs (MSB first): ${a.variables.join(', ')}`,
    `Minterms: ${a.outputName} = Σm(${a.minterms.join(', ')})  [${a.minterms.length} of ${a.rows.length}]`,
    `Standard SOP: ${a.outputName} = ${a.standardSop}`,
    `Minimum SOP: ${a.outputName} = ${a.minimumSop}  [${a.terms.length} term(s), ${a.literalCount} literal(s)]`
  ]
}

/** Plain-text report suitable for copying into a lab write-up. */
export function formatReport(a: BooleanAnalysis): string {
  const header = [...a.variables, a.outputName].join(' ')
  return [
    ...reportSummary(a),
    '',
    `Row  ${header}`,
    ...a.rows.map((r) => `${String(r.index).padStart(3)}  ${[...r.inputs, r.output].join(' ')}`)
  ].join('\n')
}
