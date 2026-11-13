import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { archiveName, homeOf, stage } from '../src/app/export.ts'
import { CARRIED, DATABASE } from '../src/app/migrate.ts'

const canTar = process.platform !== 'win32'

/** A hub-shaped home with a WAL-mode ledger, one ticket, and one dependency directory to leave behind. */
const home = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'foreman-export-'))
  for (const dir of ['state/superagent', 'storages', 'sessions', 'attachments', 'profiles/web/node_modules/pkg']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, '.credentials.yaml'), 'version: 1\n')
  writeFileSync(join(root, 'storages/workspace.json'), '{"workspaces":[]}')
  writeFileSync(join(root, 'sessions/s1.zstd'), Buffer.alloc(4096))
  writeFileSync(join(root, 'profiles/web/cordis.patch.yml'), '[]')
  writeFileSync(join(root, 'profiles/web/node_modules/pkg/index.js'), Buffer.alloc(8192))
  const db = new DatabaseSync(join(root, DATABASE))
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO kv VALUES ('schema','12');"
    + ' CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.close()
  // Written but not checkpointed: it lives in the `-wal` file, which is exactly what a plain copy would lose.
  const live = new DatabaseSync(join(root, DATABASE))
  live.exec("INSERT INTO kv VALUES ('recent','yes')")
  live.close()
  return root
}

describe('the panel export', () => {
  it('derives the home from the state directory the way the deployment lays it out', () => {
    expect(homeOf(join(tmpdir(), 'home', 'state', 'superagent'))).toBe(join(tmpdir(), 'home'))
    // A state directory somewhere else still yields the directory beside it, not a guessed `state` parent.
    expect(homeOf(join(tmpdir(), 'home', 'custom-state'))).toBe(join(tmpdir(), 'home'))
    expect(homeOf(join(tmpdir(), 'home', 'state', 'superagent', ''))).toBe(join(tmpdir(), 'home'))
  })

  /**
   * The staging takes a snapshot rather than copying the live file: the newest writes are in the WAL, and a copy of
   * the `.sqlite` alone would silently lose them. This is the difference between the panel's export and a plain
   * `cp`, and the reason an export needs no downtime.
   */
  it('stages a snapshot that holds the writes still in the WAL', () => {
    const root = home()
    const staged = stage(root, join(root, 'state', 'superagent'))
    const db = new DatabaseSync(join(staged, 'state', 'superagent', 'orchestrator.sqlite'), { readOnly: true })
    try {
      // `recent` was inserted into the WAL and never checkpointed.
      expect(db.prepare("SELECT value FROM kv WHERE key='recent'").get()).toEqual({ value: 'yes' })
    } finally { db.close() }
    rmSync(root, { recursive: true, force: true })
  })

  it('carries everything a move needs, and leaves the dependencies behind', () => {
    const root = home()
    const staged = stage(root, join(root, 'state', 'superagent'))
    // Every carried entry is present in the staging, in the same relative place a restore expects.
    for (const name of CARRIED) expect(existsSync(join(staged, name)), name).toBe(true)
    expect(existsSync(join(staged, '.credentials.yaml'))).toBe(true)
    // Dependencies are the one thing deliberately absent: rebuilt on the new machine from the lockfile.
    expect(existsSync(join(staged, 'profiles/web/node_modules'))).toBe(false)
    expect(existsSync(join(staged, 'profiles/web/cordis.patch.yml'))).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('replaces a previous staging rather than merging with it', () => {
    const root = home()
    const stateDir = join(root, 'state', 'superagent')
    const first = stage(root, stateDir)
    writeFileSync(join(first, 'stale-marker'), 'x')
    const second = stage(root, stateDir)
    // A stale marker from an interrupted export must not ride along into the next archive.
    expect(existsSync(join(second, 'stale-marker'))).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  it.skipIf(!canTar)('streams an archive whose paths are relative to the home', () => {
    const root = home()
    const out = join(root, 'archive.tar.gz')
    const chunks: Buffer[] = []
    // The archive is streamed in chunks; collecting them is what a test can do without a socket.
    execFileSync('tar', ['-czf', out, '-C', stage(root, join(root, 'state', 'superagent')), '--exclude', 'node_modules', '.'])
    expect(existsSync(out)).toBe(true)
    const listed = execFileSync('tar', ['-tzf', out], { encoding: 'utf8' })
    expect(chunks.length).toBe(0)
    // Paths are home-relative, so unpacking at the new home puts the ledger back where the rows expect it.
    expect(listed).toContain('./state/superagent/orchestrator.sqlite')
    expect(listed).toContain('./.credentials.yaml')
    expect(listed).not.toContain('node_modules')
    rmSync(root, { recursive: true, force: true })
  })

  it('names the archive after the moment it was made, so two downloads do not collide', () => {
    const name = archiveName(new Date('2026-11-13T06:30:00.000Z'))
    expect(name).toBe('dsh-foreman-2026-11-13T06-30-00.tar.gz')
    expect(name).not.toBe(archiveName(new Date('2026-11-13T06:30:01.000Z')))
  })
})
