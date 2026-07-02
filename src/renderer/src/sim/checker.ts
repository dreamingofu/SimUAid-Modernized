// .chk file parsing. Line 1 drives the circuit input; line 2 is the expected
// output. Values: 0, 1, X (don't care) and R (reset the circuit under test);
// spaces are ignored. Both sequences must be the same length.

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
  if (!/^[01XR]+$/i.test(input) || !/^[01XR]+$/i.test(output)) {
    return 'Sequences may only contain 1, 0, X, R and spaces'
  }
  if (input.length !== output.length) {
    return `Sequences differ in length (${input.length} vs ${output.length})`
  }
  return { input: input.toUpperCase(), output: output.toUpperCase() }
}
