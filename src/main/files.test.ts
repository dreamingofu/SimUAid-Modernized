import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, stat, chmod, symlink, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDocument, writeDocument, validateExportFiles, MAX_DOCUMENT_BYTES } from './files'

const directories: string[] = []
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'simuaid-files-'))
  directories.push(path)
  return path
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('circuit disk storage', () => {
  it('replaces a document completely and leaves no temporary file', async () => {
    const dir = await directory()
    const path = join(dir, 'circuit.ckt')
    await writeFile(path, 'old circuit')
    await writeDocument(path, 'new circuit \u2192 complete')
    expect(await readDocument(path)).toBe('new circuit \u2192 complete')
    expect(await readdir(dir)).toEqual(['circuit.ckt'])
  })
  it('rejects oversized input without damaging existing work', async () => {
    const dir = await directory()
    const path = join(dir, 'circuit.ckt')
    await writeFile(path, 'original')
    await expect(writeDocument(path, 'x'.repeat(MAX_DOCUMENT_BYTES + 1))).rejects.toThrow('10 MiB')
    expect(await readFile(path, 'utf8')).toBe('original')
    expect(await readdir(dir)).toEqual(['circuit.ckt'])
  })
  it('rejects directories and oversized disk files', async () => {
    const dir = await directory()
    const path = join(dir, 'huge.ckt')
    await writeFile(path, 'x'.repeat(MAX_DOCUMENT_BYTES + 1))
    await expect(readDocument(path)).rejects.toThrow('10 MiB')
    await expect(readDocument(dir)).rejects.toThrow('Select a file')
    await expect(writeDocument(dir, 'data')).rejects.toThrow('regular file')
    expect((await stat(dir)).isDirectory()).toBe(true)
  })
  it.skipIf(process.platform === 'win32')('respects read-only documents', async () => {
    const dir = await directory()
    const path = join(dir, 'readonly.ckt')
    await writeFile(path, 'original')
    await chmod(path, 0o444)
    try {
      await expect(writeDocument(path, 'changed')).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe('original')
    } finally {
      await chmod(path, 0o600)
    }
  })
  it.skipIf(process.platform === 'win32')('saves through symlinks without replacing the link', async () => {
    const dir = await directory()
    const path = join(dir, 'original.ckt')
    const link = join(dir, 'link.ckt')
    await writeFile(path, 'before')
    await symlink(path, link)
    await writeDocument(link, 'after')
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('after')
  })
  it('reports invalid destinations without leaving temporary files', async () => {
    const dir = await directory()
    await mkdir(join(dir, 'existing'))
    await expect(writeDocument(join(dir, 'missing', 'circuit.ckt'), 'data')).rejects.toThrow()
    expect(await readdir(dir)).toEqual(['existing'])
  })
})

describe('VHDL export boundary', () => {
  it.each(['../outside.vhd', '/tmp/outside.vhd', 'C:\\outside.vhd', 'sub\\outside.vhd', 'bad.txt'])('rejects unsafe filename %s', name => {
    expect(() => validateExportFiles([{ name, contents: 'data' }])).toThrow('filename')
  })
  it('rejects empty exports, case-colliding names and invalid contents', () => {
    expect(() => validateExportFiles([])).toThrow()
    expect(() => validateExportFiles([{ name: 'A.vhd', contents: '' }, { name: 'a.vhd', contents: '' }])).toThrow('Duplicate')
    expect(() => validateExportFiles([{ name: 'good.vhd', contents: null }])).toThrow('text')
  })
  it('accepts normal component and top-level names', () => {
    expect(() => validateExportFiles([{ name: 'circuit_top.vhd', contents: 'entity circuit_top is' }])).not.toThrow()
  })
})
