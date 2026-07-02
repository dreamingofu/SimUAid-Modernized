import { useEffect, useRef } from 'react'
import { useCircuitStore } from '../store/circuitStore'
import { findDuplicateOutputLabels } from '../netlist/nets'
import styles from '../styles/InlineLabelEditor.module.css'

/**
 * Floating <input> for LABEL mode, rendered as a fixed overlay at the click point
 * (so it is never clipped by the canvas container). Focus is deferred until after
 * the opening click settles, and the spurious blur that can fire immediately after
 * opening is ignored — otherwise it would commit an empty label and close at once.
 * Commits on Enter / blur; cancels on Escape; warns on duplicate output labels.
 */
export default function InlineLabelEditor(): React.JSX.Element | null {
  const edit = useCircuitStore((s) => s.interaction.inlineEdit)
  const setValue = useCircuitStore((s) => s.setInlineEditValue)
  const commit = useCircuitStore((s) => s.commitInlineEdit)
  const cancel = useCircuitStore((s) => s.cancelInlineEdit)
  const inputRef = useRef<HTMLInputElement>(null)
  const openedAtRef = useRef(0)

  const editKey = edit ? `${edit.kind}:${edit.componentId}:${edit.pinName ?? ''}` : null
  useEffect(() => {
    if (!editKey) return
    openedAtRef.current = Date.now()
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(raf)
  }, [editKey])

  if (!edit) return null

  async function handleCommit(): Promise<void> {
    const wasPin = edit?.kind === 'pin'
    commit()
    if (wasPin) {
      const dups = findDuplicateOutputLabels(useCircuitStore.getState().netlist)
      if (dups.length > 0) {
        await window.api.confirm({
          type: 'warning',
          message: 'Duplicate output label',
          detail: `The label "${dups.join('", "')}" is used on more than one output pin. Connecting outputs together is usually a mistake.`,
          buttons: ['OK'],
          defaultId: 0,
          cancelId: 0
        })
      }
    }
  }

  return (
    <input
      ref={inputRef}
      className={styles.editor}
      style={{
        left: edit.screenX,
        top: edit.screenY - 14,
        color: edit.kind === 'device' ? '#d12b2b' : '#000000'
      }}
      value={edit.value}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        // Ignore the spurious blur that fires right after opening.
        if (Date.now() - openedAtRef.current < 300) {
          requestAnimationFrame(() => inputRef.current?.focus())
          return
        }
        void handleCommit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          void handleCommit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancel()
        }
      }}
    />
  )
}
