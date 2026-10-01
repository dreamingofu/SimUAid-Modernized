#!/usr/bin/env node
// Windows installer smoke test for CI (GitHub Actions windows runner only).
//
// Installs the NSIS x64 installer silently for the current user into a
// disposable folder under RUNNER_TEMP, drives the installed production app's
// real renderer over the Chrome DevTools Protocol (loopback
// --remote-debugging-port, Node 22 built-in fetch/WebSocket, no dependencies),
// repeats a same-version reinstall, then uninstalls, checking that a student
// circuit outside the install folder and the app's userData survive.
//
// Scope: a same-version repair/reinstall on an ephemeral runner. It is not a
// cross-version upgrade test and not a campus image, SmartScreen, AppLocker or
// code-signing test. The installer is unsigned.
//
// Usage: node scripts/ci/windows-installer-smoke.mjs --evidence <dir> [--installer <setup.exe>] [--plan]

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

const PRODUCT = 'SimUaid'
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EXPRESSION = "BCD + ABCD' + C'D + AB'D"
const EXPECTED = {
  minterms: 'Σm(1, 5, 7, 9, 11, 13, 14, 15)',
  minimum: "F = AD + BD + C'D + ABC",
  truth: '0100010101010111'
}
const LIMITS = [
  'Same-version silent reinstall/repair only; not a cross-version upgrade or data migration test.',
  'Ephemeral GitHub-hosted runner as a fresh user profile; not a campus image, SmartScreen, AppLocker, antivirus or roaming-profile test.',
  'Installer and app are unsigned; no code-signing or publisher-trust validation.',
  'Session 1 holds an unsaved generated circuit, so it is ended by terminating its exact process tree (the app correctly asks to save); graceful File > Exit is verified in sessions without unsaved changes.'
]

// ------------------------------------------------------------------ args/plan

function parseArgs(argv) {
  const args = { plan: false, installer: null, evidence: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--plan') args.plan = true
    else if (argv[i] === '--installer') args.installer = argv[++i]
    else if (argv[i] === '--evidence') args.evidence = argv[++i]
    else throw new Error(`Unknown argument ${argv[i]}`)
  }
  if (!args.plan && !args.evidence) throw new Error('--evidence <dir> is required')
  return args
}

export function installArgs(installDir) {
  // NSIS: /D= must be last, absolute and unquoted.
  return ['/S', '/currentuser', `/D=${installDir}`]
}

export function uninstallArgs(installDir) {
  // _?= runs the uninstaller in place so the process exit means it finished.
  return ['/S', '/currentuser', `_?=${installDir}`]
}

export function assertPlainPath(path) {
  if (!/^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$/.test(path)) {
    throw new Error(`Refusing path with spaces or special characters (NSIS /D and _?= cannot be quoted): ${path}`)
  }
}

/** Parses `reg query` output into keys with their values. */
export function parseReg(text) {
  const entries = []
  let current = null
  for (const line of text.split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) {
      current = { key: line.trim(), values: {} }
      entries.push(current)
    } else if (current) {
      const m = /^\s{4}(.+?)\s{4}(REG_\w+)\s{4}(.*)$/.exec(line)
      if (m) current.values[m[1]] = m[3]
    }
  }
  return entries
}

/** Expected probe vectors at each 100 ns midpoint, from the Lab 3 truth table. */
export function expectedVectors() {
  const bit = (k, shift) => String((k >> shift) & 1)
  const rows = Array.from({ length: 16 }, (_, k) => k)
  return {
    A: rows.map((k) => bit(k, 3)).join(''),
    B: rows.map((k) => bit(k, 2)).join(''),
    C: rows.map((k) => bit(k, 1)).join(''),
    D: rows.map((k) => bit(k, 0)).join(''),
    F: EXPECTED.truth
  }
}

// ------------------------------------------------------------------ utilities

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function waitFor(label, fn, timeoutMs = 20_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      last = error
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}${last ? `: ${last.message}` : ''}`)
    }
    await sleep(intervalMs)
  }
}

function run(file, args, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    const keep = (chunk) => { if (out.length < 20_000) out += chunk }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${file} ${args.join(' ')} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => { clearTimeout(timer); resolvePromise({ code, output: out }) })
  })
}

function powershellJson(command) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true
  })
  if (r.status !== 0) throw new Error(`PowerShell failed: ${r.stderr || r.error}`)
  const text = r.stdout.trim()
  if (!text) return []
  const value = JSON.parse(text)
  return Array.isArray(value) ? value : [value]
}

function processesUnder(dir) {
  return powershellJson(
    'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ' +
    `$_.ExecutablePath.StartsWith('${dir}\\', [System.StringComparison]::OrdinalIgnoreCase) } | ` +
    'Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress'
  )
}

function killProcessesUnder(dir) {
  const procs = processesUnder(dir)
  for (const p of procs) spawnSync('taskkill.exe', ['/PID', String(p.ProcessId), '/T', '/F'], { windowsHide: true })
  return procs
}

const UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
]

/** Values of one registry key, or null when it does not exist. */
function regValues(key) {
  const r = spawnSync('reg.exe', ['query', key], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) return null
  return parseReg(r.stdout ?? '').find((e) => e.key.toLowerCase() === key.toLowerCase().replace(/^hkcu\\/, 'hkey_current_user\\'))?.values ?? {}
}

/** Uninstall registry entries whose DisplayName starts with the product name. */
function uninstallEntries() {
  const found = []
  for (const root of UNINSTALL_KEYS) {
    const search = spawnSync('reg.exe', ['query', root, '/s', '/f', PRODUCT, '/d'], { encoding: 'utf8', windowsHide: true })
    const keys = new Set(parseReg(search.stdout ?? '').map((e) => e.key))
    for (const key of keys) {
      const full = spawnSync('reg.exe', ['query', key], { encoding: 'utf8', windowsHide: true })
      for (const entry of parseReg(full.stdout ?? '')) {
        if (entry.key === key && (entry.values.DisplayName ?? '').startsWith(PRODUCT)) found.push(entry)
      }
    }
  }
  return found
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePromise(port))
    })
  })
}

// ------------------------------------------------------------------ CDP client

export class Cdp {
  static connect(url, timeoutMs = 15_000) {
    return new Promise((resolvePromise, reject) => {
      const ws = new WebSocket(url)
      const timer = setTimeout(() => { ws.close(); reject(new Error('CDP connect timed out')) }, timeoutMs)
      ws.addEventListener('open', () => { clearTimeout(timer); resolvePromise(new Cdp(ws)) })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`CDP connect failed: ${url}`)) })
    })
  }

  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: ok, reject: fail, timer } = this.pending.get(msg.id)
        clearTimeout(timer)
        this.pending.delete(msg.id)
        if (msg.error) fail(new Error(`${msg.error.message} (${msg.error.code})`))
        else ok(msg.result)
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params)
      }
    })
    ws.addEventListener('close', () => {
      for (const { reject: fail, timer } of this.pending.values()) { clearTimeout(timer); fail(new Error('CDP connection closed')) }
      this.pending.clear()
    })
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => { this.pending.delete(id); fail(new Error(`CDP ${method} timed out`)) }, timeoutMs)
      this.pending.set(id, { resolve: ok, reject: fail, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, fn) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), fn])
  }

  close() {
    try { this.ws.close() } catch { /* already closed */ }
  }
}

export async function evaluate(cdp, fn, ...args) {
  const expression = `(${fn.toString()})(...${JSON.stringify(args)})`
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(`Page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  return r.result.value
}

// Page-side functions (serialized into the renderer; must be self-contained).
function pageFindButton(text) {
  const label = (el) => {
    const span = el.querySelector('span')
    return (span ? span.textContent : el.textContent).replace(/^✓\s*/, '').trim()
  }
  const button = [...document.querySelectorAll('button')]
    .find((el) => label(el) === text && el.offsetParent !== null && !el.disabled)
  if (!button) return null
  button.scrollIntoView({ block: 'nearest' })
  const r = button.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

function pageState() {
  const inputs = document.querySelector('input[aria-label="Inputs"]')
  const expression = document.querySelector('input[aria-label="Expression"]')
  const rows = []
  for (const tr of document.querySelectorAll('table tbody tr')) {
    const cells = [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())
    rows.push(cells)
  }
  const title = [...document.querySelectorAll('span')].find((s) => s.textContent === 'Timing Diagram')
  const panel = title ? title.parentElement.parentElement : null
  return {
    title: document.title,
    text: document.body.innerText,
    dialogOpen: Boolean(inputs),
    inputs: inputs ? inputs.value : null,
    expression: expression ? expression.value : null,
    alert: document.querySelector('[role="alert"]')?.textContent ?? null,
    rows,
    timing: panel
      ? {
          text: panel.innerText,
          scale: panel.querySelector('select')?.value ?? null,
          hasCanvas: Boolean(panel.querySelector('canvas'))
        }
      : null,
    graphicsDialog: Boolean(document.querySelector('select option[value="fixed"]')),
    graphicsStored: localStorage.getItem('simuaid.graphicsMode')
  }
}

/** Resolves after two animation frames, i.e. once pending layout and paint have run. */
function pageNextFrames() {
  return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))
}

/** Geometry of the circuit canvas and the timing panel. */
function pageLayout() {
  const title = [...document.querySelectorAll('span')].find((s) => s.textContent === 'Timing Diagram')
  const panel = title.parentElement.parentElement
  const plot = panel.querySelector('canvas')
  const scroll = plot.parentElement
  // The circuit canvas is sized from its container by a ResizeObserver, so
  // measure both: they agree once the editor has caught up with a resize.
  const circuit = [...document.querySelectorAll('canvas')].find((c) => !panel.contains(c))
  return {
    viewport: window.innerWidth,
    panel: panel.getBoundingClientRect().width,
    circuit: circuit.parentElement.getBoundingClientRect().width,
    circuitCanvas: circuit.getBoundingClientRect().width,
    scrollClient: scroll.clientWidth,
    scrollWidth: scroll.scrollWidth,
    plotCss: parseFloat(plot.style.width),
    scale: panel.querySelector('select').value
  }
}

/**
 * Layout rules: the timing panel keeps its CSS width clamp(420px, 40vw, 760px)
 * regardless of the waveform's width, the circuit gets the rest, a fixed scale
 * scrolls inside the panel, and Fit run needs no scrolling.
 */
export function layoutProblems(l) {
  const problems = []
  const maxPanel = Math.min(760, Math.max(420, 0.4 * l.viewport)) + 1
  if (l.panel > maxPanel) problems.push(`timing panel ${l.panel}px wider than ${maxPanel}px`)
  if (l.circuit < l.viewport - maxPanel - 2) problems.push(`circuit only ${l.circuit}px of ${l.viewport}px`)
  if (l.circuit + l.panel > l.viewport + 2) problems.push(`circuit + panel ${l.circuit + l.panel}px overflow ${l.viewport}px`)
  if (Math.abs(l.circuitCanvas - l.circuit) > 2) problems.push(`circuit canvas ${l.circuitCanvas}px not yet resized to ${l.circuit}px`)
  if (l.viewport >= 1000 && l.circuit < 0.5 * l.viewport) problems.push(`circuit below half of ${l.viewport}px`)
  if (l.scale === 'fit' && l.plotCss > l.scrollClient + 1) problems.push(`Fit plot ${l.plotCss}px exceeds ${l.scrollClient}px`)
  if (l.scale !== 'fit' && l.plotCss > l.scrollClient && l.scrollWidth <= l.scrollClient) {
    problems.push('fixed-scale plot is clipped instead of scrolling')
  }
  return problems
}

/** Reads each waveform's level at every interval midpoint from the timing canvas pixels. */
function pageReadWaveforms(intervals, intervalNs) {
  const title = [...document.querySelectorAll('span')].find((s) => s.textContent === 'Timing Diagram')
  const panel = title.parentElement.parentElement
  const canvas = panel.querySelector('canvas')
  const scale = panel.querySelector('select').value
  const cssWidth = parseFloat(canvas.style.width)
  // Fixed scales draw 50 px per division; Fit stretches the run over the plot
  // width less the 40 px end padding.
  const pxPerNs = scale === 'fit' ? (cssWidth - 40) / (intervals * intervalNs) : 50 / Number(scale)
  const scaleNs = scale
  const ratio = canvas.width / cssWidth
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
  const dark = (cssX, cssY) => {
    for (let dy = -1.5; dy <= 1.5; dy += 0.5) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const x = Math.round((cssX + dx) * ratio)
        const y = Math.round((cssY + dy) * ratio)
        if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue
        const i = (y * canvas.width + x) * 4
        const lum = 0.299 * data.data[i] + 0.587 * data.data[i + 1] + 0.114 * data.data[i + 2]
        if (data.data[i + 3] > 128 && lum < 110) return true
      }
    }
    return false
  }
  const labels = [...panel.querySelectorAll('div')]
    .filter((d) => d.children.length === 0 && /^[A-Z]$/.test(d.textContent.trim()))
    .map((d) => d.textContent.trim())
  const out = {}
  labels.forEach((label, row) => {
    const top = 22 + row * 30
    let v = ''
    for (let k = 0; k < intervals; k++) {
      const x = (k * intervalNs + intervalNs / 2) * pxPerNs
      const hi = dark(x, top + 6)
      const lo = dark(x, top + 24)
      v += hi && !lo ? '1' : lo && !hi ? '0' : '?'
    }
    out[label] = v
  })
  return { labels, vectors: out, scaleNs, ratio, width: canvas.width, height: canvas.height }
}

function pageSetSelect(optionValue, value) {
  const select = document.querySelector(`select option[value="${optionValue}"]`)?.parentElement
  if (!select) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

function pageFocusInput(ariaLabel) {
  const input = document.querySelector(`input[aria-label="${ariaLabel}"]`)
  if (!input) return false
  input.focus()
  input.select()
  return document.activeElement === input
}

function pageCanvasPng() {
  const title = [...document.querySelectorAll('span')].find((s) => s.textContent === 'Timing Diagram')
  return title.parentElement.parentElement.querySelector('canvas').toDataURL('image/png')
}

// ------------------------------------------------------------------ app session

export class AppSession {
  constructor(name, exe, evidenceDir) {
    this.name = name
    this.exe = exe
    this.evidenceDir = evidenceDir
    this.consoleErrors = []
    this.exited = null
  }

  async start() {
    this.port = await freePort()
    // Loopback-only DevTools endpoint on a random free port. Node's WebSocket
    // sends no Origin header, so no --remote-allow-origins override is needed.
    this.child = spawn(this.exe, ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${this.port}`], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false
    })
    this.pid = this.child.pid
    let log = ''
    const keep = (chunk) => { if (log.length < 50_000) log += chunk }
    this.child.stdout.on('data', keep)
    this.child.stderr.on('data', keep)
    this.exitPromise = new Promise((r) => this.child.on('exit', (code, signal) => { this.exited = { code, signal }; r(this.exited) }))
    this.log = () => log
    const target = await waitFor(`${this.name} DevTools page target`, async () => {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/list`)
      const list = await res.json()
      return list.find((t) => t.type === 'page' && t.url.startsWith('file:') && t.url.endsWith('index.html'))
    }, 90_000, 500)
    this.targetUrl = target.url
    this.cdp = await Cdp.connect(target.webSocketDebuggerUrl)
    this.cdp.on('Runtime.exceptionThrown', (p) => this.consoleErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text))
    this.cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') this.consoleErrors.push(p.args.map((a) => a.value ?? a.description).join(' '))
    })
    await this.cdp.send('Runtime.enable')
    await waitFor(`${this.name} menu bar`, () => evaluate(this.cdp, pageFindButton, 'File'), 60_000)
  }

  state() {
    return evaluate(this.cdp, pageState)
  }

  async click(text, timeoutMs = 10_000) {
    const point = await waitFor(`button "${text}"`, () => evaluate(this.cdp, pageFindButton, text), timeoutMs)
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
    }
  }

  async menu(top, item) {
    await this.click(top)
    await this.click(item)
  }

  async type(ariaLabel, text) {
    await waitFor(`focus ${ariaLabel}`, () => evaluate(this.cdp, pageFocusInput, ariaLabel))
    await this.cdp.send('Input.insertText', { text })
  }

  async until(label, predicate, timeoutMs = 15_000) {
    let last
    try {
      return await waitFor(label, async () => { last = await this.state(); return predicate(last) && last }, timeoutMs)
    } catch (error) {
      error.message += `\nLast page text:\n${last?.text?.slice(0, 2000) ?? '(none)'}`
      throw error
    }
  }

  async screenshot(file) {
    try {
      const shot = await this.cdp.send('Page.captureScreenshot', { format: 'png' }, 30_000)
      writeFileSync(join(this.evidenceDir, file), Buffer.from(shot.data, 'base64'))
      return file
    } catch (error) {
      return `screenshot failed: ${error.message}`
    }
  }

  async exitViaMenu(installDir) {
    await this.menu('File', 'Exit')
    await Promise.race([this.exitPromise, sleep(30_000).then(() => { throw new Error(`${this.name} did not exit within 30 s of File > Exit`) })])
    await waitFor('no app processes after exit', () => processesUnder(installDir).length === 0, 30_000, 1000)
    this.cdp.close()
  }

  async terminate(installDir) {
    this.cdp?.close()
    const killed = killProcessesUnder(installDir)
    await waitFor('app processes terminated', () => processesUnder(installDir).length === 0, 30_000, 1000)
    return killed.map((p) => ({ pid: p.ProcessId, name: p.Name }))
  }

  summary() {
    return {
      pid: this.pid,
      port: this.port,
      target: this.targetUrl,
      exit: this.exited,
      consoleErrors: this.consoleErrors,
      log: this.log?.().slice(0, 5000)
    }
  }
}

// ------------------------------------------------------------------ renderer workflows

/** Changes a saved preference through View > Change Graphics Mode. */
export async function setPreferenceWorkflow(s) {
  const initial = await s.until('clean untitled document', (st) => st.title === `Untitled — ${PRODUCT}`)
  await s.menu('View', 'Change Graphics Mode')
  await waitFor('graphics mode dialog', () => evaluate(s.cdp, pageSetSelect, 'fixed', 'fixed'))
  const changed = await s.until('graphics preference saved', (st) => st.graphicsStored === 'fixed' && st.text.includes('Graphics mode: fixed pixel'))
  await s.click('OK')
  await s.until('graphics dialog closed', (st) => !st.graphicsDialog)
  return { initialTitle: initial.title, graphicsStored: changed.graphicsStored }
}

/** Lab 3: analyze the assigned expression, create its circuit, Go to 1600 ns, read the timing diagram. */
export async function labWorkflow(s, evidenceDir) {
  const pref = await s.state()
  if (pref.graphicsStored !== 'fixed') throw new Error(`Saved preference lost between launches: ${pref.graphicsStored}`)

  await s.menu('Tools', 'Boolean Expression / Truth Table…')
  await s.until('Boolean dialog', (st) => st.dialogOpen && st.inputs === 'A B C D')
  await s.type('Expression', EXPRESSION)
  const analysis = await s.until('analysis results', (st) =>
    st.expression === EXPRESSION && st.rows.length === 16 && st.text.includes(EXPECTED.minimum))
  const truth = analysis.rows
    .map((cells) => ({ index: Number(cells[0]), f: cells[cells.length - 1] }))
    .sort((a, b) => a.index - b.index)
  const vector = truth.map((r) => r.f).join('')
  if (vector !== EXPECTED.truth) throw new Error(`Truth table F column ${vector} != ${EXPECTED.truth}`)
  if (!analysis.text.includes(EXPECTED.minterms)) throw new Error('Minterm list missing from the dialog')
  const dialogShot = await s.screenshot('session-1b-boolean-dialog.png')

  await s.click('Create circuit…')
  const created = await s.until('generated circuit', (st) =>
    !st.dialogOpen && st.text.includes(`Created ${EXPECTED.minimum}`) && st.title.startsWith('• '))

  await s.menu('Window', 'Open/Close Timing Diagram')
  await s.until('timing panel', (st) => st.timing !== null)
  await s.menu('Simulate', 'Go')
  const ran = await s.until('simulation to 1600 ns', (st) =>
    st.text.includes('Time: 1600 ns') && st.timing?.hasCanvas && st.timing.text.includes('0–1600 ns'))
  if (ran.timing.scale !== '100') throw new Error(`Timing scale ${ran.timing.scale}, expected 100 ns/div`)
  const waves = await readExactVectors(s, '100 ns/div')
  const png = await evaluate(s.cdp, pageCanvasPng)
  writeFileSync(join(evidenceDir, 'session-1b-timing-canvas.png'), Buffer.from(png.split(',')[1], 'base64'))

  // Layout at the runner's real window size and at common laptop widths: the
  // panel stays bounded and the circuit keeps its share; refit, then capture.
  const layouts = []
  const screenshots = [dialogShot, 'session-1b-timing-canvas.png']
  for (const size of [null, { width: 1366, height: 768 }, { width: 1008, height: 681 }]) {
    if (size) await s.cdp.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 0, mobile: false })
    const name = size ? `${size.width}x${size.height}` : 'window'
    const layout = await checkLayout(s, name)
    await evaluate(s.cdp, pageNextFrames) // Fit reads the size the editor stored after resizing
    await s.menu('View', 'Fit To Window')
    await s.until('fit to window', (st) => st.text.includes('Fit to window'))
    await evaluate(s.cdp, pageNextFrames)
    screenshots.push(await s.screenshot(`session-1b-${name}.png`))
    layouts.push({ name, ...layout })
  }
  await waitFor('Fit run scale', () => evaluate(s.cdp, pageSetSelect, 'fit', 'fit'))
  const fitLayout = await checkLayout(s, 'fit-run 1008x681')
  const fitWaves = await readExactVectors(s, 'Fit run')
  screenshots.push(await s.screenshot('session-1b-1008x681-fit-run.png'))
  await s.cdp.send('Emulation.clearDeviceMetricsOverride')
  return {
    truthVector: vector,
    createdTitle: created.title,
    timingText: ran.timing.text,
    waveforms: waves,
    fitWaveforms: fitWaves,
    layouts: [...layouts, { name: 'fit-run 1008x681', ...fitLayout }],
    screenshots
  }
}

/** Waits for the painted diagram, then requires the exact truth-table vectors. */
async function readExactVectors(s, label) {
  let waves
  try {
    waves = await waitFor(`timing waveforms painted (${label})`, async () => {
      const w = await evaluate(s.cdp, pageReadWaveforms, 16, 100)
      return w.labels.length === 5 && Object.values(w.vectors).every((v) => !v.includes('?')) && w
    }, 10_000)
  } catch (error) {
    waves = await evaluate(s.cdp, pageReadWaveforms, 16, 100)
    throw new Error(`${error.message}; last read ${JSON.stringify(waves.vectors)}`)
  }
  if (waves.labels.join('') !== 'ABCDF') throw new Error(`Timing labels ${waves.labels.join(',')}`)
  for (const [name, v] of Object.entries(expectedVectors())) {
    if (waves.vectors[name] !== v) throw new Error(`Timing ${name} midpoints at ${label}: ${waves.vectors[name]} != ${v}`)
  }
  return waves
}

/** Waits for the layout rules to hold at the current viewport. */
async function checkLayout(s, name) {
  let last
  try {
    return await waitFor(`layout at ${name}`, async () => {
      last = await evaluate(s.cdp, pageLayout)
      return layoutProblems(last).length === 0 && last
    }, 10_000)
  } catch (error) {
    await s.screenshot(`layout-failure-${name.replace(/\W+/g, '-')}.png`)
    throw new Error(`${error.message}: ${layoutProblems(last).join('; ')} ${JSON.stringify(last)}`)
  }
}

/** After reinstall: the saved preference survived and a malformed expression is reported. */
export async function malformedInputWorkflow(s) {
  const initial = await s.until('clean untitled document', (st) => st.title === `Untitled — ${PRODUCT}`)
  if (initial.graphicsStored !== 'fixed') throw new Error('Saved preference lost across reinstall')
  await s.menu('Tools', 'Boolean Expression / Truth Table…')
  await s.until('Boolean dialog', (st) => st.dialogOpen)
  await s.type('Expression', 'A +')
  const bad = await s.until('malformed-input error', (st) => (st.alert ?? '').includes('needs a term after it'))
  await s.screenshot('session-2-malformed.png')
  await s.click('Close')
  await s.until('dialog closed', (st) => !st.dialogOpen)
  return { alert: bad.alert, graphicsStored: initial.graphicsStored }
}

// ------------------------------------------------------------------ main flow

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const runnerTemp = process.env.RUNNER_TEMP ?? 'C:\\RUNNER_TEMP'
  const root = win32.join(runnerTemp, 'simuaid-installer-smoke')
  const installDir = win32.join(root, 'install')
  const userDocs = win32.join(root, 'user-documents')

  if (args.plan) {
    console.log(JSON.stringify({
      root, installDir, userDocs,
      install: installArgs(installDir),
      uninstall: [`${installDir}\\Uninstall ${PRODUCT}.exe`, ...uninstallArgs(installDir)],
      expected: { ...EXPECTED, vectors: expectedVectors() },
      limits: LIMITS
    }, null, 2))
    return 0
  }

  if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP) {
    throw new Error('Refusing to run: this test installs software and only runs on a GitHub Actions Windows runner.')
  }
  assertPlainPath(installDir)
  if (existsSync(root)) throw new Error(`Disposable root already exists: ${root}`)

  const evidenceDir = resolve(args.evidence)
  mkdirSync(evidenceDir, { recursive: true })
  const evidence = {
    startedAt: new Date().toISOString(),
    ok: false,
    limits: LIMITS,
    runner: { os: process.env.ImageOS ?? null, imageVersion: process.env.ImageVersion ?? null, node: process.version },
    paths: { root, installDir, userDocs, appData: process.env.APPDATA ?? null },
    steps: []
  }
  const sessions = []
  const step = async (name, fn) => {
    const started = Date.now()
    const record = { name, ok: false }
    evidence.steps.push(record)
    console.log(`::group::${name}`)
    try {
      record.detail = await fn()
      record.ok = true
      return record.detail
    } catch (error) {
      record.error = error.stack ?? String(error)
      throw error
    } finally {
      record.ms = Date.now() - started
      console.log(JSON.stringify(record, null, 2).slice(0, 4000))
      console.log('::endgroup::')
    }
  }

  const exe = join(installDir, `${PRODUCT}.exe`)
  const uninstaller = join(installDir, `Uninstall ${PRODUCT}.exe`)
  let userDataSentinel = null
  let studentCircuit = null

  try {
    const installer = await step('Locate installer', () => {
      const version = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version
      const path = args.installer
        ? resolve(args.installer)
        : join(REPO, 'dist', `${PRODUCT}-${version}-windows-x64-setup.exe`)
      const others = readdirSync(join(REPO, 'dist')).filter((f) => f.endsWith('.exe'))
      if (!existsSync(path)) throw new Error(`Installer not found: ${path} (dist has ${others.join(', ')})`)
      evidence.installer = { path, version, bytes: statSync(path).size, sha256: sha256(path), distExes: others }
      return evidence.installer
    })

    await step('Prepare disposable folders and student circuit', () => {
      mkdirSync(userDocs, { recursive: true })
      studentCircuit = join(userDocs, 'student-lab3.ckt')
      copyFileSync(join(REPO, 'samples', 'lab3-assigned.ckt'), studentCircuit)
      return { studentCircuit, sha256: sha256(studentCircuit) }
    })
    const studentHash = sha256(studentCircuit)
    await step('Registry before install', () => {
      const entries = uninstallEntries()
      if (entries.length) throw new Error(`Runner already has ${PRODUCT} uninstall entries: ${JSON.stringify(entries)}`)
      return entries
    })

    const install = async (label) => step(label, async () => {
      const result = await run(installer.path, installArgs(installDir), 10 * 60_000)
      if (result.code !== 0) throw new Error(`Installer exited ${result.code}: ${result.output}`)
      if (!existsSync(exe)) throw new Error(`Installed app not found at ${exe}`)
      if (!existsSync(uninstaller)) throw new Error(`Uninstaller not found at ${uninstaller}`)
      const autoLaunched = processesUnder(installDir)
      if (autoLaunched.length) killProcessesUnder(installDir)
      const entries = uninstallEntries()
      const user = entries.filter((e) => e.key.startsWith('HKEY_CURRENT_USER'))
      const machine = entries.filter((e) => !e.key.startsWith('HKEY_CURRENT_USER'))
      if (machine.length) throw new Error(`Per-user install wrote machine-wide uninstall entries: ${JSON.stringify(machine)}`)
      if (user.length !== 1) throw new Error(`Expected one per-user uninstall entry, found ${user.length}`)
      // electron-builder: the uninstall entry holds the uninstall commands and
      // version; InstallLocation lives in HKCU\Software\<app GUID>, where the
      // GUID is the uninstall entry's key name.
      const entry = user[0].values
      const quoted = `"${uninstaller}"`
      if (entry.UninstallString !== `${quoted} /currentuser` || entry.QuietUninstallString !== `${quoted} /currentuser /S`) {
        throw new Error(`Unexpected uninstall commands: ${entry.UninstallString} | ${entry.QuietUninstallString}`)
      }
      if (entry.DisplayVersion !== installer.version) throw new Error(`DisplayVersion ${entry.DisplayVersion} != ${installer.version}`)
      const installKey = `HKCU\\Software\\${user[0].key.split('\\').pop()}`
      const installInfo = regValues(installKey)
      const location = (installInfo?.InstallLocation ?? '').replace(/\\$/, '').toLowerCase()
      if (location !== installDir.toLowerCase()) {
        throw new Error(`${installKey} InstallLocation ${installInfo?.InstallLocation} != ${installDir}`)
      }
      return {
        exitCode: result.code,
        exeSha256: sha256(exe),
        files: readdirSync(installDir),
        autoLaunched: autoLaunched.map((p) => p.Name),
        uninstallEntry: user[0],
        installKey,
        installInfo
      }
    })

    const first = await install('Install (silent, per-user, isolated folder)')

    // Session 1a: change a saved preference, then exit gracefully with a clean document.
    await step('Session 1a: preference + graceful File > Exit', async () => {
      const s = new AppSession('session-1a', exe, evidenceDir)
      sessions.push(s)
      await s.start()
      const pref = await setPreferenceWorkflow(s)
      await s.exitViaMenu(installDir)
      return { ...pref, session: s.summary() }
    })

    userDataSentinel = await step('Locate userData and write sentinel', () => {
      const appData = process.env.APPDATA
      const candidates = [join(appData, PRODUCT), join(appData, 'simuaid-modernized')]
      const found = candidates.filter((p) => existsSync(p))
      if (found.length !== 1) throw new Error(`Expected exactly one userData folder, found: ${JSON.stringify(found)}`)
      const path = join(found[0], 'installer-smoke-sentinel.txt')
      const token = randomUUID()
      writeFileSync(path, token)
      return { userData: found[0], path, token }
    })

    // Session 1b: the Lab 3 workflow in the installed production renderer.
    await step('Session 1b: Lab 3 workflow (Tools > Boolean, Create, Go 1600, Timing)', async () => {
      const s = new AppSession('session-1b', exe, evidenceDir)
      sessions.push(s)
      await s.start()
      const lab = await labWorkflow(s, evidenceDir)
      const processes = processesUnder(installDir)
      if (s.consoleErrors.length) throw new Error(`Renderer errors: ${s.consoleErrors.join(' | ')}`)
      const killed = await s.terminate(installDir)
      return {
        ...lab,
        processes,
        terminatedUnsavedSession: killed,
        session: s.summary()
      }
    })

    const again = await install('Reinstall (same version, silent, same folder)')
    await step('Check data preserved after reinstall', async () => {
      if (again.exeSha256 !== first.exeSha256) throw new Error('Reinstalled executable differs from the first install')
      if (readFileSync(userDataSentinel.path, 'utf8') !== userDataSentinel.token) throw new Error('userData sentinel changed by reinstall')
      if (sha256(studentCircuit) !== studentHash) throw new Error('Student circuit changed by reinstall')
      return { exeSha256: again.exeSha256 }
    })

    await step('Session 2: relaunch after reinstall, malformed input, graceful exit', async () => {
      const s = new AppSession('session-2', exe, evidenceDir)
      sessions.push(s)
      await s.start()
      const checked = await malformedInputWorkflow(s)
      if (s.consoleErrors.length) throw new Error(`Renderer errors: ${s.consoleErrors.join(' | ')}`)
      await s.exitViaMenu(installDir)
      return { ...checked, session: s.summary() }
    })

    await step('Uninstall (silent, per-user) and check preserved data', async () => {
      const result = await run(uninstaller, uninstallArgs(installDir), 5 * 60_000)
      if (result.code !== 0) throw new Error(`Uninstaller exited ${result.code}: ${result.output}`)
      await waitFor('installed app removed', () => !existsSync(exe), 120_000, 1000)
      const entries = uninstallEntries()
      if (entries.length) throw new Error(`Uninstall entries remain: ${JSON.stringify(entries)}`)
      if (regValues(first.installKey) !== null) throw new Error(`${first.installKey} remains after uninstall`)
      if (readFileSync(userDataSentinel.path, 'utf8') !== userDataSentinel.token) throw new Error('userData sentinel removed by uninstall')
      if (sha256(studentCircuit) !== studentHash) throw new Error('Student circuit changed by uninstall')
      return {
        exitCode: result.code,
        remainingInInstallDir: existsSync(installDir) ? readdirSync(installDir) : [],
        studentCircuitSha256: studentHash,
        userDataPreserved: true
      }
    })

    evidence.ok = true
  } catch (error) {
    evidence.error = error.stack ?? String(error)
  } finally {
    // Clean up only what this run created: its own processes and install folder.
    const cleanup = {}
    try {
      for (const s of sessions) s.cdp?.close()
      if (existsSync(installDir)) {
        cleanup.killed = killProcessesUnder(installDir).map((p) => p.ProcessId)
        if (existsSync(uninstaller) && existsSync(exe)) {
          cleanup.uninstall = (await run(uninstaller, uninstallArgs(installDir), 5 * 60_000)).code
        }
        rmSync(installDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 })
      }
      cleanup.installDirRemoved = !existsSync(installDir)
    } catch (error) {
      cleanup.error = String(error)
    }
    evidence.cleanup = cleanup
    evidence.finishedAt = new Date().toISOString()
    writeFileSync(join(evidenceDir, 'installer-smoke.json'), JSON.stringify(evidence, null, 2))
  }
  console.log(evidence.ok ? 'Windows installer smoke test passed.' : `Windows installer smoke test FAILED:\n${evidence.error}`)
  return evidence.ok ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code }, (error) => {
    console.error(error.stack ?? error)
    process.exitCode = 1
  })
}
