// Shared shape for native message-box requests, used by the renderer (via
// window.api.confirm) and the main process handler. Pure types — no imports.

export interface ConfirmOptions {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
  message: string
  detail?: string
  buttons: string[]
  /** Index of the default (Enter) button. */
  defaultId?: number
  /** Index returned if the dialog is dismissed (Esc / window close). */
  cancelId?: number
}
