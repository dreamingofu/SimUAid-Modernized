import { useEffect, type ReactNode } from 'react'
import styles from '../styles/Modal.module.css'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  /** Wider, height-bounded box with a scrolling body (reports and tables). */
  wide?: boolean
}

/** Minimal modal: dimmed overlay + centered box. Esc and overlay-click close it. */
export default function Modal({ title, onClose, children, wide = false }: ModalProps): React.JSX.Element {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div className={wide ? `${styles.box} ${styles.wide}` : styles.box} onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.title}>{title}</div>
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  )
}
