import { useEffect, useRef, useState } from 'react'
import { MENU_STRUCTURE, type MenuCommandId, type MenuItemSpec } from '../../../shared/menu'
import { SimMode } from '../model/types'
import { dispatchCommand } from '../commands'
import { useCircuitStore } from '../store/circuitStore'
import styles from '../styles/MenuBar.module.css'

/** Turns an Electron accelerator string into a display label (e.g. Ctrl+N). */
function formatAccelerator(accelerator?: string): string {
  if (!accelerator) return ''
  return accelerator.replace('CmdOrCtrl', 'Ctrl').replace('Cmd', '⌘')
}

export default function MenuBar(): React.JSX.Element {
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const showIoValues = useCircuitStore((s) => s.showIoValues)
  const timingPanelVisible = useCircuitStore((s) => s.timingPanelVisible)
  const simMode = useCircuitStore((s) => s.simMode)

  const isChecked = (id: MenuCommandId | undefined): boolean => {
    if (id === 'view.showIo') return showIoValues
    if (id === 'window.timingDiagram') return timingPanelVisible
    if (id === 'sim.changeMode') return simMode === SimMode.CHANGE
    return false
  }

  // Close the open menu when clicking outside the bar.
  useEffect(() => {
    function onPointerDown(event: MouseEvent): void {
      if (barRef.current && !barRef.current.contains(event.target as Node)) {
        setOpenIndex(null)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  return (
    <div className={styles.menubar} ref={barRef}>
      {MENU_STRUCTURE.map((menu, index) => {
        const open = openIndex === index
        return (
          <div key={menu.label} className={styles.menu}>
            <button
              type="button"
              className={`${styles.top} ${open ? styles.topOpen : ''}`}
              onClick={() => setOpenIndex(open ? null : index)}
              onMouseEnter={() => {
                if (openIndex !== null) setOpenIndex(index)
              }}
            >
              {menu.label}
            </button>
            {open && (
              <div className={styles.dropdown}>
                {menu.items.map((item, itemIndex) => (
                  <MenuEntry
                    key={item.id ?? item.label ?? `sep-${itemIndex}`}
                    item={item}
                    isChecked={isChecked}
                    onCommand={(id) => {
                      setOpenIndex(null)
                      void dispatchCommand(id)
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

interface MenuEntryProps {
  item: MenuItemSpec
  isChecked: (id: MenuCommandId | undefined) => boolean
  onCommand: (id: MenuCommandId) => void
}

function MenuEntry({ item, isChecked, onCommand }: MenuEntryProps): React.JSX.Element {
  if (item.type === 'separator') return <div className={styles.separator} />

  if (item.submenu) {
    return (
      <div className={styles.submenuParent}>
        <div className={`${styles.item} ${styles.submenuLabel}`}>
          <span className={styles.itemLabel}>{item.label}</span>
          <span className={styles.accel}>▸</span>
        </div>
        <div className={styles.subDropdown}>
          {item.submenu.map((sub, i) => (
            <MenuEntry
              key={sub.id ?? sub.label ?? `sep-${i}`}
              item={sub}
              isChecked={isChecked}
              onCommand={onCommand}
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <button
      type="button"
      className={styles.item}
      onClick={() => {
        if (item.id) onCommand(item.id)
      }}
    >
      <span className={styles.itemLabel}>
        {isChecked(item.id) ? '✓ ' : ''}
        {item.label}
      </span>
      <span className={styles.accel}>{formatAccelerator(item.accelerator)}</span>
    </button>
  )
}
