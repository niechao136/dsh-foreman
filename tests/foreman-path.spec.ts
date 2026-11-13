import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath, pathKey, samePath } from '../src/foreman/path.ts'

const made: string[] = []
const directory = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'foreman-path-'))
  made.push(path)
  return path
}
afterEach(() => { for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true }) })

/** The case-sensitive comparison this module is expected to make on a POSIX host, and to fold on Windows/macOS. */
const foldsCase = process.platform === 'win32' || process.platform === 'darwin'

describe('pathKey', () => {
  it('collapses a trailing separator and redundant segments', () => {
    const expected = resolve('/root/dsh-foreman')
    expect(pathKey('/root/dsh-foreman/').resolved).toBe(expected)
    expect(pathKey('/root//dsh-foreman').resolved).toBe(expected)
    expect(pathKey('/root/x/../dsh-foreman').resolved).toBe(expected)
  })

  it('keeps a root path as a root, never as an empty path or a bare drive letter', () => {
    const key = pathKey('/')
    expect(key.resolved).toBe(resolve('/'))
    // Whatever this platform's root looks like, it is not empty and not a bare drive letter: `D:` means "the current
    // directory on drive D", which is a different path from the drive root `D:\`.
    expect(key.resolved).not.toBe('')
    expect(/^[A-Za-z]:$/.test(key.resolved)).toBe(false)
  })

  it('keeps the spelling for comparison and folds only where the filesystem ignores case', () => {
    const root = resolve('/Root/Dsh-Foreman')
    expect(pathKey('/Root/Dsh-Foreman').resolved).toBe(root)
    expect(pathKey('/Root/Dsh-Foreman').folded).toBe(foldsCase ? root.toLowerCase() : root)
  })

  it('leaves an empty path empty rather than resolving it to the working directory', () => {
    expect(pathKey('   ')).toEqual({ resolved: '', folded: '' })
  })
})

describe('samePath', () => {
  it('treats the spellings an operator types as one directory', () => {
    expect(samePath('/root/dsh-foreman/', '/root/dsh-foreman')).toBe(true)
    expect(samePath('/root/dsh-foreman', '/root/x/../dsh-foreman')).toBe(true)
  })

  it('folds case only on a filesystem that ignores it', () => {
    expect(samePath('/Root/Dsh-Foreman', '/root/dsh-foreman')).toBe(foldsCase)
  })

  it('does not treat a different directory as the same one', () => {
    // The real misconfiguration: `/root/dah-foreman` for `/root/dsh-foreman` fell back to the default main Session.
    expect(samePath('/root/dah-foreman', '/root/dsh-foreman')).toBe(false)
    expect(samePath('/root/dsh-foreman', '/root/dsh-foreman-node')).toBe(false)
    expect(samePath('F:\\\\github\\\\fold', 'F:\\\\github\\\\fold2')).toBe(false)
  })

  it('never matches an unset path against a real one', () => {
    expect(samePath('', '/root/dsh-foreman')).toBe(false)
    expect(samePath('   ', '   ')).toBe(false)
  })
})

describe('canonicalPath', () => {
  it('resolves a directory that exists to its real path', async () => {
    const base = directory(), real = join(base, 'project')
    mkdirSync(real)
    expect(await canonicalPath(real)).toBe(await canonicalPath(join(real, '..', 'project')))
  })

  it('follows a symlink to the directory it names', async () => {
    const base = directory(), real = join(base, 'project'), link = join(base, 'alias')
    mkdirSync(real)
    try { symlinkSync(real, link, 'dir') } catch { return /* Windows without the privilege: nothing to compare. */ }
    expect(await canonicalPath(link)).toBe(await canonicalPath(real))
  })

  it('reports a path that does not exist, so the caller can say so instead of silently rerouting', async () => {
    expect(await canonicalPath(join(directory(), 'missing'))).toBeUndefined()
  })
})
