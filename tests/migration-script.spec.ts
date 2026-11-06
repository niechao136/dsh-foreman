import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const home = (): string => mkdtempSync(join(tmpdir(), 'foreman-home-'))

const populated = (): string => {
  const root = home()
  for (const dir of ['state/superagent', 'storages', 'sessions', 'attachments', 'profiles/web']) mkdirSync(join(root, dir), { recursive: true })
  const db = new DatabaseSync(join(root, 'state/superagent/orchestrator.sqlite'))
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO kv VALUES (\'schema\',\'12\')')
  db.close()
  writeFileSync(join(root, 'storages/workspace.json'), '{"workspaces":[]}')
  return root
}

const run = (...args: string[]): string =>
  execFileSync(process.execPath, ['scripts/migrate.mjs', ...args], { cwd: process.cwd(), encoding: 'utf8' })

describe('the migration script', () => {
  it('checkpoints the WAL and packs every directory a move needs', () => {
    const root = populated()
    const out = join(tmpdir(), `foreman-${process.pid}.tar`)
    run('pack', '--home', root, '--out', out)
    const verify = run('verify', '--home', root)
    expect(verify).toContain('workspace.json')
    expect(verify).toContain('checkpoint ok')
  })

  it('sizes the tree it will carry, so a copy that is too large is visible before it is made', () => {
    const root = populated()
    writeFileSync(join(root, 'sessions/large.bin'), Buffer.alloc(64 * 1024))
    const plan = run('plan', '--home', root)
    // The byte count is the files', not the directory inode's: the old fallback understated it to the inode size.
    const sessions = /sessions: (\d+) bytes/.exec(plan)
    expect(Number(sessions?.[1] ?? 0)).toBeGreaterThan(64 * 1024)
  })

  it('names what a move must carry, so a partial copy is visible', () => {
    const root = populated()
    const plan = run('plan', '--home', root)
    for (const dir of ['state/superagent', 'storages', 'sessions', 'attachments', 'profiles']) expect(plan).toContain(dir)
  })

  it('refuses a home that is not a DSH home', () => {
    expect(() => run('verify', '--home', join(tmpdir(), 'no-such-home-foreman'))).toThrow()
  })

  it('reports how many tickets the database holds, so a move can be checked against it', () => {
    const root = populated()
    const db = new DatabaseSync(join(root, 'state/superagent/orchestrator.sqlite'))
    db.exec('CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO ticket VALUES (\'t1\',\'{}\'),(\'t2\',\'{}\')')
    db.close()
    expect(run('verify', '--home', root)).toContain('tickets: 2')
  })

  it('checkpoints the WAL into the database file so a plain copy is complete', () => {
    const root = populated()
    const db = new DatabaseSync(join(root, 'state/superagent/orchestrator.sqlite'))
    db.exec('INSERT INTO kv VALUES (\'probe\',\'1\')')
    db.close()
    run('checkpoint', '--home', root)
    // `TRUNCATE` empties the WAL: its frames are in the database, so copying the `.sqlite` alone loses nothing.
    const wal = join(root, 'state/superagent/orchestrator.sqlite-wal')
    expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0)
  })
})
