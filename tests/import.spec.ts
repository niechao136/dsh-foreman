import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { check, clearStaging, swap, unexpectedEntries, unpack, uploadPath } from '../src/app/import.ts'
import { CARRIED, DATABASE } from '../src/app/migrate.ts'

const canTar = process.platform !== 'win32'

/** A home-shaped tree with a ledger; `directories` become the work directories its tickets name. */
const home = (options: { directories?: string[]; ended?: string[]; schema?: string } = {}): string => {
  const root = mkdtempSync(join(tmpdir(), 'foreman-import-'))
  for (const dir of ['state/superagent', 'storages', 'sessions', 'profiles/web']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, '.credentials.yaml'), 'version: 1\n')
  writeFileSync(join(root, 'storages/workspace.json'), '{"workspaces":[]}')
  writeFileSync(join(root, 'sessions/s1.zstd'), 'x')
  const db = new DatabaseSync(join(root, DATABASE))
  db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO kv VALUES ('schema','${options.schema ?? '12'}');
    CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  for (const [index, directory] of (options.directories ?? []).entries()) {
    db.prepare('INSERT INTO ticket VALUES (?, ?)').run(`t${index}`, JSON.stringify({ execution: { directory } }))
  }
  // Finished tickets: their work directory was cleaned up, so they must not be required to exist.
  for (const [index, directory] of (options.ended ?? []).entries()) {
    db.prepare('INSERT INTO ticket VALUES (?, ?)').run(`e${index}`,
      JSON.stringify({ ended: { at: '2026-11-01T00:00:00.000Z', by: 'human', outcome: 'done' }, execution: { directory } }))
  }
  db.close()
  return root
}

/** An archive of `root`, built the way the exporter builds one. */
const archiveOf = (root: string): string => {
  const out = join(tmpdir(), `import-${process.pid}-${Math.random().toString(36).slice(2)}.tar.gz`)
  execFileSync('tar', ['-czf', out, '-C', root, '.'])
  return out
}

describe('restoring a hub', () => {
  it('unpacks into staging and reports what the archive holds', () => {
    const root = home({ directories: [] })
    const archive = archiveOf(root)
    const stateDir = join(root, 'state', 'superagent')
    const pending = unpack(root, stateDir, archive, 1234)
    expect(pending.report.problems).toEqual([])
    expect(pending.report.tickets).toBe('0')
    expect(pending.report.bytes).toBe(1234)
    clearStaging(stateDir)
    rmSync(root, { recursive: true, force: true }); rmSync(archive, { force: true })
  })

  /**
   * The check that a ticket count cannot make: an archive whose rows name directories this machine does not have would
   * restore into a hub that opens, counts correctly, and cannot run a single ticket.
   */
  it('names work directories the archive expects but this machine lacks', () => {
    const missing = join(tmpdir(), 'foreman-absent-project', 'work', 't0')
    const root = home({ directories: [missing] })
    const archive = archiveOf(root)
    const stateDir = join(root, 'state', 'superagent')
    const pending = unpack(root, stateDir, archive, 10)
    expect(pending.report.missingDirectories).toEqual([missing])
    clearStaging(stateDir)
    rmSync(root, { recursive: true, force: true }); rmSync(archive, { force: true })
  })

  it('passes when every directory the archive names exists here', () => {
    const present = mkdtempSync(join(tmpdir(), 'foreman-project-'))
    const root = home({ directories: [present] })
    const archive = archiveOf(root)
    const stateDir = join(root, 'state', 'superagent')
    expect(unpack(root, stateDir, archive, 10).report.missingDirectories).toEqual([])
    clearStaging(stateDir)
    rmSync(root, { recursive: true, force: true }); rmSync(archive, { force: true }); rmSync(present, { recursive: true, force: true })
  })

  /**
   * A finished ticket's work directory is cleaned up after the work, so it legitimately names a path that is gone.
   * Requiring it would refuse the hub's own export — the most common archive a restore ever sees.
   */
  it('does not demand the work directory of a finished ticket', () => {
    const gone = join(tmpdir(), 'foreman-cleaned-up-work', 't0')
    const root = home({ ended: [gone] })
    const archive = archiveOf(root)
    const stateDir = join(root, 'state', 'superagent')
    const report = unpack(root, stateDir, archive, 1).report
    expect(report.missingDirectories).toEqual([])
    expect(report.problems).toEqual([])
    clearStaging(stateDir)
    rmSync(root, { recursive: true, force: true }); rmSync(archive, { force: true })
  })

  /** A hub older than this build can migrate is refused before the swap, not after it. */
  it('refuses a ledger too old for this build to migrate', () => {
    const root = home({ schema: '4' })
    const archive = archiveOf(root)
    const stateDir = join(root, 'state', 'superagent')
    const report = unpack(root, stateDir, archive, 1).report
    expect(report.problems.join(' ')).toContain('older than this build can migrate')
    clearStaging(stateDir)
    rmSync(root, { recursive: true, force: true }); rmSync(archive, { force: true })
  })

  it('refuses something that is not an export at all', () => {
    const empty = mkdtempSync(join(tmpdir(), 'foreman-notar-'))
    writeFileSync(join(empty, 'readme.txt'), 'not a hub')
    const archive = archiveOf(empty)
    const root = home()
    const stateDir = join(root, 'state', 'superagent')
    expect(() => unpack(root, stateDir, archive, 1)).toThrow(/does not look like a dsh-foreman export/)
    clearStaging(stateDir)
    rmSync(root, { recursive: true, force: true }); rmSync(archive, { force: true }); rmSync(empty, { recursive: true, force: true })
  })

  it('notes a missing carried entry without failing the restore', () => {
    const root = home()
    rmSync(join(root, 'attachments'), { recursive: true, force: true })
    const archive = archiveOf(root)
    const stateDir = join(root, 'state', 'superagent')
    const report = unpack(root, stateDir, archive, 1).report
    expect(report.problems).toEqual([])
    expect(report.notes.join(' ')).toContain('attachments')
    clearStaging(stateDir)
    rmSync(root, { recursive: true, force: true }); rmSync(archive, { force: true })
  })

  it('reports a missing workspace.json, which would ungroup every main Session', () => {
    const root = home()
    rmSync(join(root, 'storages/workspace.json'), { force: true })
    const archive = archiveOf(root)
    const stateDir = join(root, 'state', 'superagent')
    expect(unpack(root, stateDir, archive, 1).report.notes.join(' ')).toContain('workspace.json')
    clearStaging(stateDir)
    rmSync(root, { recursive: true, force: true }); rmSync(archive, { force: true })
  })

  /**
   * The swap renames the live tree aside and the staged tree in, rather than copying: a rename cannot half-finish the
   * way a recursive copy can, and the old tree is what makes a wrong restore recoverable.
   */
  it('keeps the previous home as a backup and moves the staged tree into place', () => {
    const live = home()
    const incoming = home({ directories: [] })
    // `swap` takes an unpacked tree: one directory per carried entry, exactly the staging layout.
    const unpacked = join(live, 'unpacked')
    mkdirSync(unpacked, { recursive: true })
    for (const name of CARRIED) {
      const from = join(incoming, name)
      if (!existsSync(from)) continue
      cpSync(from, join(unpacked, name), { recursive: true })
    }
    writeFileSync(join(unpacked, 'state', 'superagent', 'marker'), 'from-archive')
    const result = swap(live, unpacked, new Date('2026-11-13T06:00:00.000Z'))
    // The previous ledger is kept, and the archive's marker is the one now in place.
    expect(result.backup).toBe(`${live}.bak-2026-11-13T06-00-00`)
    expect(existsSync(join(result.backup, DATABASE))).toBe(true)
    expect(readFileSync(join(live, 'state', 'superagent', 'marker'), 'utf8')).toBe('from-archive')
    rmSync(live, { recursive: true, force: true }); rmSync(incoming, { recursive: true, force: true })
    rmSync(result.backup, { recursive: true, force: true })
  })

  it('names entries an export would not have produced', () => {
    const unpacked = mkdtempSync(join(tmpdir(), 'foreman-unexpected-'))
    mkdirSync(join(unpacked, 'state', 'superagent'), { recursive: true })
    writeFileSync(join(unpacked, 'state', 'superagent', 'orchestrator.sqlite'), '')
    writeFileSync(join(unpacked, 'not-carried.txt'), 'x')
    // `state` is the top-level name behind `state/superagent`, so it is expected; the stray file is not.
    expect(unexpectedEntries(unpacked)).toEqual(['not-carried.txt'])
    rmSync(unpacked, { recursive: true, force: true })
  })

  it('writes the upload inside the state directory, so it lands on the same filesystem', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'foreman-state-'))
    const path = uploadPath(stateDir, 'some archive (1).tar.gz')
    expect(path.startsWith(stateDir)).toBe(true)
    // A name from a browser can carry spaces and parentheses; the file name is sanitized, the directory is not.
    expect(path.endsWith('.tar.gz')).toBe(true)
    expect(path).not.toContain(' ')
    rmSync(stateDir, { recursive: true, force: true })
  })

  it.skipIf(!canTar)('reads a ledger this build wrote without complaint', () => {
    const root = home({ directories: [] })
    expect(check(root, 1).problems).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })
})

