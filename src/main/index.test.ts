import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => {
  const frame = { url: 'file:///app/out/renderer/index.html' }
  const handlers = new Map<string, (...args: any[]) => any>()
  const events = new Map<string, (...args: any[]) => any>()
  const webEvents = new Map<string, (...args: any[]) => any>()
  const policies = new Map<string, (...args: any[]) => any>()
  const webContents = {
    mainFrame: frame, send: vi.fn(),
    setWindowOpenHandler: vi.fn(fn => policies.set('window', fn)), on: vi.fn((name, fn) => webEvents.set(name, fn)),
    session: { setPermissionRequestHandler: vi.fn(fn => policies.set('permission-request', fn)), setPermissionCheckHandler: vi.fn(fn => policies.set('permission-check', fn)) }
  }
  const window = {
    webContents, on: vi.fn((name, fn) => events.set(name, fn)),
    setMenuBarVisibility: vi.fn(), show: vi.fn(), close: vi.fn(), destroy: vi.fn(), loadFile: vi.fn(), loadURL: vi.fn()
  }
  const windowOptions: any[] = []
  const BrowserWindow = vi.fn(function (options: any) { windowOptions.push(options); return window })
  Object.assign(BrowserWindow, { getAllWindows: () => [window] })
  return {
    handlers, events, webEvents, window, BrowserWindow, windowOptions, policies,
    app: { isPackaged: true, whenReady: () => Promise.resolve(), on: vi.fn(), quit: vi.fn() },
    dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
    readDocument: vi.fn(), writeDocument: vi.fn()
  }
})
vi.mock('electron', () => ({
  app: mock.app, BrowserWindow: mock.BrowserWindow, dialog: mock.dialog,
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => mock.handlers.set(name, fn) }
}))
vi.mock('./files', async (original) => ({
  ...await original<typeof import('./files')>(), readDocument: mock.readDocument, writeDocument: mock.writeDocument
}))
const trusted = () => ({ sender: mock.window.webContents, senderFrame: mock.window.webContents.mainFrame })
const invoke = (name: string, event = trusted(), ...args: unknown[]) => mock.handlers.get(name)!(event, ...args)
beforeAll(async () => { await import('./index'); await Promise.resolve() })
beforeEach(() => {
  mock.dialog.showOpenDialog.mockReset()
  mock.dialog.showSaveDialog.mockReset()
  mock.readDocument.mockReset()
  mock.writeDocument.mockReset()
})

describe('desktop trust boundary', () => {
  it('enables sandbox and denies navigation, windows and permissions', () => {
    expect(mock.windowOptions[0].webPreferences.sandbox).toBe(true)
    const preventDefault = vi.fn()
    mock.webEvents.get('will-navigate')!({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(mock.policies.get('window')!()).toEqual({ action: 'deny' })
    expect(mock.policies.get('permission-check')!()).toBe(false)
  })
  it('rejects another renderer and a subframe on every privileged channel', () => {
    for (const name of mock.handlers.keys()) {
      expect(() => invoke(name, { sender: {} as any, senderFrame: trusted().senderFrame })).toThrow('Untrusted')
      expect(() => invoke(name, { sender: trusted().sender, senderFrame: { ...trusted().senderFrame } })).toThrow('Untrusted')
    }
  })
  it('rejects writes to files not selected through native dialog', async () => {
    await expect(invoke('file:saveCkt', trusted(), '/private/never-chosen.ckt', 'changed')).rejects.toThrow('Open or Save As')
    expect(mock.writeDocument).not.toHaveBeenCalled()
  })
  it('authorizes successful Open and Save As destinations for subsequent saves', async () => {
    mock.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/chosen.ckt'] })
    mock.readDocument.mockResolvedValue('contents')
    await invoke('dialog:openCkt')
    await invoke('file:saveCkt', trusted(), '/chosen.ckt', 'saved')
    expect(mock.writeDocument).toHaveBeenCalledWith('/chosen.ckt', 'saved')
    mock.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/saved-as.ckt' })
    await invoke('dialog:saveCktAs', trusted(), 'content', 'example.ckt')
    await invoke('file:saveCkt', trusted(), '/saved-as.ckt', 'later')
    expect(mock.writeDocument).toHaveBeenCalledWith('/saved-as.ckt', 'later')
  })
  it('does not authorize cancelled or failed selections', async () => {
    mock.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/failed.ckt'] })
    mock.readDocument.mockRejectedValue(new Error('permission denied'))
    await expect(invoke('dialog:openCkt')).rejects.toThrow('permission denied')
    await expect(invoke('file:saveCkt', trusted(), '/failed.ckt', 'content')).rejects.toThrow('Open or Save As')
    mock.dialog.showSaveDialog.mockResolvedValue({ canceled: true })
    expect(await invoke('dialog:saveCktAs', trusted(), 'content')).toBeNull()
  })
  it('rejects path traversal before showing export dialog', async () => {
    await expect(invoke('dialog:saveVhdl', trusted(), 'top.vhd', [{ name: '../escape.vhd', contents: 'x' }])).rejects.toThrow('filename')
    expect(mock.dialog.showSaveDialog).not.toHaveBeenCalled()
  })
})

describe('native close handshake', () => {
  it('uses a native cancel-safe fallback after a renderer crash', async () => {
    invoke('window:ready')
    mock.webEvents.get('render-process-gone')!()
    mock.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    const event = { preventDefault: vi.fn() }
    mock.events.get('close')!(event)
    await Promise.resolve()
    expect(event.preventDefault).toHaveBeenCalled()
    expect(mock.dialog.showMessageBox).toHaveBeenCalled()
    expect(mock.window.destroy).not.toHaveBeenCalled()
    mock.events.get('responsive')!()
  })
  it('falls back when a live renderer loses its close listener', async () => {
    vi.useFakeTimers()
    try {
      invoke('window:ready')
      mock.dialog.showMessageBox.mockResolvedValue({ response: 0 })
      mock.events.get('close')!({ preventDefault: vi.fn() })
      await vi.advanceTimersByTimeAsync(5000)
      expect(mock.dialog.showMessageBox).toHaveBeenCalled()
      expect(mock.window.destroy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not time out while a native save confirmation is open', async () => {
    vi.useFakeTimers()
    try {
      let resolve!: (result: { response: number }) => void
      mock.dialog.showMessageBox.mockImplementationOnce(() => new Promise(done => { resolve = done }))
      const confirmation = invoke('dialog:confirm', trusted(), { message: 'Save?', buttons: ['Cancel'] })
      await Promise.resolve()
      const count = mock.dialog.showMessageBox.mock.calls.length
      mock.events.get('close')!({ preventDefault: vi.fn() })
      await vi.advanceTimersByTimeAsync(5000)
      expect(mock.dialog.showMessageBox).toHaveBeenCalledTimes(count)
      resolve({ response: 0 })
      await confirmation
      mock.dialog.showMessageBox.mockResolvedValue({ response: 0 })
      await vi.advanceTimersByTimeAsync(5000)
      expect(mock.dialog.showMessageBox).toHaveBeenCalledTimes(count + 1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('keeps window open on cancel and only closes for current approved request', () => {
    invoke('window:ready')
    const event = { preventDefault: vi.fn() }
    mock.events.get('close')!(event)
    expect(event.preventDefault).toHaveBeenCalled()
    const request = mock.window.webContents.send.mock.lastCall![1]
    invoke('window:completeClose', trusted(), 'stale-request', true)
    expect(mock.window.close).not.toHaveBeenCalled()
    invoke('window:completeClose', trusted(), request, false)
    expect(mock.window.close).not.toHaveBeenCalled()
    mock.events.get('close')!(event)
    const second = mock.window.webContents.send.mock.lastCall![1]
    expect(second).not.toBe(request)
    invoke('window:completeClose', trusted(), second, true)
    expect(mock.window.close).toHaveBeenCalledTimes(1)
    const approved = { preventDefault: vi.fn() }
    mock.events.get('close')!(approved)
    expect(approved.preventDefault).not.toHaveBeenCalled()
  })
})
