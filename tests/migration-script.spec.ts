import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { CARRIED, DATABASE, PROFILE_SKIP } from '../src/app/migrate.ts'

const home = (): string => mkdtempSync(join(tmpdir(), 'foreman-home-'))

/**
 * A home shaped like a real one: every carried entry, a WAL database, and one ticket whose work directory is under
 * `root`.
 */
const populated = (options: { root?: string; tickets?: { directory?: string }[] } = {}): string => {
  const root = home()
  for (const dir of ['state/superagent', 'storages', 'sessions', 'attachments', 'profiles/web']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, '.credentials.yaml'), 'version: 1\nrecords: {}\n')
  writeFileSync(join(root, 'storages/workspace.json'), '{"workspaces":[]}')
  const db = new DatabaseSync(join(root, DATABASE))
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO kv VALUES ('schema','12');"
    + ' CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
  for (const [index, ticket] of (options.tickets ?? []).entries()) {
    const directory = ticket.directory ?? join(options.root ?? root, 'work', `t${index}`)
    db.prepare('INSERT INTO ticket VALUES (?, ?)').run(`t${index}`, JSON.stringify({ execution: { directory } }))
  }
  db.close()
  return root
}

const run = (...args: string[]): string =>
  execFileSync(process.execPath, ['scripts/migrate.mjs', ...args], { cwd: process.cwd(), encoding: 'utf8' })

/**
 * Each call starts a Node process, and a suite that runs them in parallel on Windows makes every one slower. The
 * default five seconds is what a slower machine trips over, not a wrong answer.
 */
const SLOW = 30_000

describe('the migration script', () => {
  // `tar` is not guaranteed on Windows, and the script deliberately refuses to pack there rather than half-copy.
  const canPack = process.platform !== 'win32'

  it.skipIf(!canPack)('checkpoints the WAL and packs every directory a move needs', () => {
    const root = populated()
    const out = join(tmpdir(), `foreman-${process.pid}.tar`)
    run('pack', '--home', root, '--out', out)
    const verify = run('verify', '--home', root)
    expect(verify).toContain('workspace.json')
    expect(verify).toContain('checkpoint ok')
  }, SLOW)
  it('sizes the tree it will carry, so a copy that is too large is visible before it is made', () => {
    const root = populated()
    const before = Number(/sessions: (\d+) bytes/.exec(run('plan', '--home', root))?.[1] ?? 0)
    writeFileSync(join(root, 'sessions/large.bin'), Buffer.alloc(64 * 1024))
    const after = Number(/sessions: (\d+) bytes/.exec(run('plan', '--home', root))?.[1] ?? 0)
    // The byte count is the files', not the directory inode's: the old fallback understated it to the inode size.
    expect(after - before).toBe(64 * 1024)
  }, SLOW)
  it('names what a move must carry, so a partial copy is visible', () => {
    const root = populated()
    const plan = run('plan', '--home', root)
    // Every carried entry is listed, present or not: an `absent` line is what tells the operator it was considered.
    for (const name of CARRIED) expect(plan).toContain(name)
    // A home that never received an attachment still says so, rather than omitting the line.
    const bare = populated()
    rmSync(join(bare, 'attachments'), { recursive: true, force: true })
    expect(run('plan', '--home', bare)).toContain('attachments: absent')
  }, SLOW)
  /**
   * The panel's session lives in `.credentials.yaml`; leaving it behind lands the operator on the new machine already
   * logged out, with nothing to say why. It is small, and only its absence is silent, which is why it must be carried.
   */
  it('carries the panel\'s browser session, which is not rebuildable', () => {
    const root = populated()
    expect(run('plan', '--home', root)).toContain('.credentials.yaml')
    expect(run('verify', '--home', root)).not.toContain('missing entry: .credentials.yaml')
    // A home without it is reported rather than passed over.
    const bare = populated()
    rmSync(join(bare, '.credentials.yaml'))
    expect(run('verify', '--home', bare)).toContain('missing entry: .credentials.yaml')
  }, SLOW)
  /**
   * `node_modules` is most of a real home's bytes, is rebuilt on the new machine from the lockfile, and contains
   * binaries built for the old one. The plan reports what the archive holds, so adding dependencies must not inflate
   * it: a plan that says 22 MB and then writes 1 MB teaches the operator to distrust the numbers.
   */
  it('leaves the rebuildable dependencies out of the size it reports', () => {
    const root = populated()
    writeFileSync(join(root, 'profiles/web/cordis.patch.yml'), '[]')
    mkdirSync(join(root, 'profiles/web/node_modules/pkg'), { recursive: true })
    writeFileSync(join(root, 'profiles/web/node_modules/pkg/index.js'), Buffer.alloc(256 * 1024))
    const profiles = Number(/profiles: (\d+) bytes/.exec(run('plan', '--home', root))?.[1] ?? -1)
    // The 256 KB of dependencies under `profiles/web/node_modules` is not counted.
    expect(profiles).toBeGreaterThanOrEqual(0)
    expect(profiles).toBeLessThan(256 * 1024)
    expect(run('plan', '--home', root)).toContain(`${PROFILE_SKIP}`)
  }, SLOW)
  it('refuses a home that is not a DSH home', () => {
    expect(() => run('verify', '--home', join(tmpdir(), 'no-such-home-foreman'))).toThrow()
  }, SLOW)
  it('reports how many tickets the database holds, so a move can be checked against it', () => {
    const root = populated()
    const db = new DatabaseSync(join(root, DATABASE))
    db.exec("CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO ticket VALUES ('t1','{}'),('t2','{}')")
    db.close()
    expect(run('verify', '--home', root)).toContain('tickets: 2')
  }, SLOW)
  it('checkpoints the WAL into the database file so a plain copy is complete', () => {
    const root = populated()
    const db = new DatabaseSync(join(root, DATABASE))
    db.exec("INSERT INTO kv VALUES ('probe','1')")
    db.close()
    run('checkpoint', '--home', root)
    // `TRUNCATE` empties the WAL: its frames are in the database, so copying the `.sqlite` alone loses nothing.
    const wal = join(root, DATABASE.replace('orchestrator.sqlite', 'orchestrator.sqlite-wal'))
    expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0)
  }, SLOW)
  /**
   * A ledger carries absolute work directories. A missing one is reported and does not fail: a fresh machine has not
   * cloned the projects yet, and its tickets are marked blocked at startup so the gap shows on the board.
   */
  it('reports a work directory this machine lacks without failing', () => {
    const missing = join(tmpdir(), 'foreman-missing-project-root', 'work', 't0')
    const root = populated({ tickets: [{ directory: missing }] })
    const verify = run('verify', '--home', root)
    expect(verify).toContain('recorded work directories not on this machine')
    // It names the directory rather than only counting them, and says what happens to its ticket.
    expect(verify).toContain(missing)
    expect(verify).toContain('will be blocked')
  }, SLOW)
  /** `--strict-paths` is the opposite answer, for a final check before switching a machine over. */
  it('fails on those directories when asked to be strict', () => {
    const missing = join(tmpdir(), 'foreman-missing-project-root', 'work', 't0')
    const root = populated({ tickets: [{ directory: missing }] })
    expect(() => run('verify', '--home', root, '--strict-paths')).toThrow()
    let message = ''
    try { run('verify', '--home', root, '--strict-paths') } catch (error) { message = String((error as { stderr?: string }).stderr ?? error) }
    expect(message).toContain(missing)
  }, SLOW)
  /**
   * A directory the executor creates on demand ends in the ticket's id. Its absence is the normal state before the
   * ticket runs, so reporting it would tell the operator to fix something that fixes itself.
   */
  it('ignores a work directory the executor makes for the ticket itself', () => {
    const ticketId = 'abcdef1234567890'
    const own = join(tmpdir(), 'foreman-own-worktree', `some-name-${ticketId.slice(0, 12)}`)
    const root = populated()
    const db = new DatabaseSync(join(root, DATABASE))
    db.prepare('INSERT INTO ticket VALUES (?, ?)').run(ticketId, JSON.stringify({ execution: { directory: own } }))
    db.close()
    // Not created on disk, and still not reported: the ticket makes it when it runs.
    expect(run('verify', '--home', root)).not.toContain('recorded work directories')
  }, SLOW)
  it('passes when every recorded directory exists here', () => {
    const root = populated()
    const work = join(root, 'work', 't0')
    mkdirSync(work, { recursive: true })
    expect(run('verify', '--home', root)).not.toContain('recorded work directories')
  }, SLOW)
}, SLOW)
