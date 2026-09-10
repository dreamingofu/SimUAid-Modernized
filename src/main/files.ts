import { randomUUID } from 'node:crypto'
import { open, realpath, rename, unlink, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join, win32 } from 'node:path'

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024

export function validateText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new Error('Document must be text smaller than 10 MiB.')
  }
}

export function validateExportFiles(value: unknown): asserts value is { name: string; contents: string }[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error('Export must contain between 1 and 100 files.')
  }
  const names = new Set<string>()
  for (const file of value) {
    if (!file || typeof file.name !== 'string' || !/^[a-zA-Z0-9_-]+\.vhd$/i.test(file.name)
      || basename(file.name) !== file.name || win32.basename(file.name) !== file.name) {
      throw new Error('Invalid VHDL filename.')
    }
    if (names.has(file.name.toLowerCase())) throw new Error('Duplicate VHDL filename.')
    names.add(file.name.toLowerCase())
    validateText(file.contents)
  }
}

export async function readDocument(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES) throw new Error('Select a file smaller than 10 MiB.')
    // A fixed buffer also bounds reads if another process grows the file.
    const buffer = Buffer.alloc(MAX_DOCUMENT_BYTES + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null)
      if (!bytesRead) break
      total += bytesRead
    }
    if (total > MAX_DOCUMENT_BYTES) throw new Error('Document exceeds 10 MiB.')
    return buffer.subarray(0, total).toString('utf8')
  } finally {
    await handle.close()
  }
}

/** Replace only after the entire new document has reached disk. */
export async function writeDocument(path: string, contents: string): Promise<void> {
  validateText(contents)
  const previous = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (previous && !previous.isFile()) throw new Error('Destination is not a regular file.')
  if (previous) {
    // Atomic replacement must respect an existing file's permissions and links.
    // fs.access(W_OK) ignores Windows ACLs. Request write access without
    // truncating or creating the file before preparing its replacement.
    const existing = await open(path, constants.O_WRONLY)
    await existing.close()
    path = await realpath(path)
  }
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', previous ? previous.mode & 0o777 : 0o600)
  try {
    try {
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}
