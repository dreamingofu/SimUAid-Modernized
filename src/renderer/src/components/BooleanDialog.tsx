import { useMemo, useRef, useState } from 'react'
import Modal from './Modal'
import { useCircuitStore } from '../store/circuitStore'
import { analyzeExpression, formatReport, reportSummary, type BooleanAnalysis, type TruthRow } from '../boolean/expression'
import { buildSopCircuit, STIMULUS_INTERVAL_NS } from '../boolean/sopCircuit'
import styles from '../styles/Modal.module.css'

// Remembered for the session so reopening the dialog (e.g. after printing the
// report) keeps the student's work.
let lastInputs = 'A B C D'
let lastExpression = ''

function analyze(expression: string, inputs: string): { analysis: BooleanAnalysis | null; error: string } {
  if (!expression.trim()) return { analysis: null, error: '' }
  try {
    return { analysis: analyzeExpression(expression, inputs), error: '' }
  } catch (error) {
    return { analysis: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function TruthTable({ a, rows }: { a: BooleanAnalysis; rows: TruthRow[] }): React.JSX.Element {
  return (
    <table className={styles.reportTable}>
      <thead>
        <tr>
          <th>#</th>
          {a.variables.map((v) => <th key={v}>{v}</th>)}
          <th>{a.outputName}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.index}>
            <td>{r.index}</td>
            {r.inputs.map((bit, i) => <td key={i}>{bit}</td>)}
            <td><strong>{r.output}</strong></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Copies through a temporary selection; works without clipboard permissions. */
function copyText(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  return ok
}

export default function BooleanDialog(): React.JSX.Element {
  const closeDialog = useCircuitStore((s) => s.closeDialog)
  const setPrintJob = useCircuitStore((s) => s.setPrintJob)
  const openDialog = useCircuitStore((s) => s.openDialog)
  const openGeneratedCircuit = useCircuitStore((s) => s.openGeneratedCircuit)
  const [inputs, setInputs] = useState(lastInputs)
  const [expression, setExpression] = useState(lastExpression)
  const [notice, setNotice] = useState('')
  const pending = useRef(false)
  const [creating, setCreating] = useState(false)

  const { analysis: a, error } = useMemo(() => analyze(expression, inputs), [expression, inputs])
  const half = a && a.rows.length > 8 ? a.rows.length / 2 : null

  function close(): void {
    if (!pending.current) closeDialog()
  }

  function copy(): void {
    if (!a) return
    const ok = copyText(formatReport(a))
    setNotice(ok ? 'Report copied to the clipboard.' : 'Copy failed — use Print report, or select the text above and copy it.')
  }

  function print(): void {
    if (!a) return
    setPrintJob({
      title: `Boolean Analysis — ${a.outputName}(${a.variables.join(', ')})`,
      imageUrl: null,
      smRows: null,
      notes: reportSummary(a),
      table: {
        columns: ['#', ...a.variables, a.outputName],
        rows: a.rows.map((r) => [String(r.index), ...r.inputs.map(String), String(r.output)])
      }
    })
    openDialog({ kind: 'printPreview' })
  }

  async function create(): Promise<void> {
    if (!a || pending.current) return
    pending.current = true
    setCreating(true)
    setNotice('')
    try {
      const netlist = buildSopCircuit(a)
      const end = (1 << a.variables.length) * STIMULUS_INTERVAL_NS
      const created = await openGeneratedCircuit(
        netlist,
        `Created ${a.outputName} = ${a.minimumSop}. Choose Simulate → Go (runs 0–${end} ns), then Window → Timing Diagram.`
      )
      if (!created) setNotice(useCircuitStore.getState().statusMessage)
    } finally {
      pending.current = false
      setCreating(false)
    }
  }

  return (
    <Modal title="Boolean Expression — Truth Table & Minimum SOP" onClose={close} wide>
      <div className={styles.boolGrid}>
        <span>Inputs (MSB first)</span>
        <input
          aria-label="Inputs"
          value={inputs}
          spellCheck={false}
          disabled={creating}
          onChange={(e) => { setInputs(e.target.value); lastInputs = e.target.value; setNotice('') }}
        />
        <span>Expression</span>
        <input
          aria-label="Expression"
          value={expression}
          spellCheck={false}
          autoFocus
          disabled={creating}
          placeholder="e.g. F = BCD + ABCD' + C'D + AB'D"
          onChange={(e) => { setExpression(e.target.value); lastExpression = e.target.value; setNotice('') }}
        />
      </div>
      <p className={styles.note}>
        Adjacent terms AND, + is OR, a prime (A&apos;) is NOT; parentheses group; 0 and 1 are constants. 1–4 single-letter inputs.
      </p>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {a && (
        <>
          <div className={styles.boolGrid}>
            <span>Minterms</span>
            <span className={styles.mono}>
              {a.outputName} = Σm({a.minterms.join(', ')}) — {a.minterms.length} of {a.rows.length}
            </span>
            <span>Standard SOP</span>
            <span className={styles.mono}>{a.outputName} = {a.standardSop}</span>
            <span>Minimum SOP</span>
            <span className={styles.mono}>
              <strong>{a.outputName} = {a.minimumSop}</strong> ({a.terms.length} term{a.terms.length === 1 ? '' : 's'}, {a.literalCount} literal{a.literalCount === 1 ? '' : 's'})
            </span>
          </div>
          <div className={styles.truthTables}>
            {half ? (
              <>
                <TruthTable a={a} rows={a.rows.slice(0, half)} />
                <TruthTable a={a} rows={a.rows.slice(half)} />
              </>
            ) : (
              <TruthTable a={a} rows={a.rows} />
            )}
          </div>
          <p className={styles.note}>
            Create circuit opens a new, unsaved circuit with gates for the minimum SOP, an Input Signal per input
            counting {a.variables.join('')} = 0…{(1 << a.variables.length) - 1} every {STIMULUS_INTERVAL_NS} ns, and
            probes {[...a.variables, a.outputName].join(', ')}.
          </p>
        </>
      )}
      {notice && <p role="status" className={styles.note}>{notice}</p>}
      <div className={styles.actionsSplit}>
        <div>
          <button type="button" disabled={!a || creating} onClick={copy}>Copy report</button>
          <button type="button" disabled={!a || creating} onClick={print}>Print report…</button>
        </div>
        <div>
          <button type="button" disabled={creating} onClick={close}>Close</button>
          <button type="button" className={styles.primary} disabled={!a || creating} onClick={() => void create()}>
            {creating ? 'Creating…' : 'Create circuit…'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
