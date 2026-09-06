// .chk file parsing (reference manual §1.4.4.1). Line 1 drives the circuit input
// and may contain 0, 1, X and R (reset the circuit under test); line 2 is the
// expected output and may contain 0, 1 and X (don't care). Spaces are ignored and
// both sequences must be the same length.

export interface ParsedChk {
  input: string
  output: string
}

export function parseChk(text: string): ParsedChk | string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ''))
    .filter((l) => l.length > 0)
  if (lines.length !== 2) return 'A .chk file must contain exactly two sequences'
  const [input, output] = lines
  if (!/^[01XR]+$/i.test(input)) {
    return 'The input sequence may only contain 1, 0, X, R and spaces'
  }
  if (!/^[01X]+$/i.test(output)) {
    return 'The output sequence may only contain 1, 0, X and spaces'
  }
  if (input.length !== output.length) {
    return `Sequences differ in length (${input.length} vs ${output.length})`
  }
  return { input: input.toUpperCase(), output: output.toUpperCase() }
}
