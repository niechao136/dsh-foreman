import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

/** A hub home whose database has only a `kv` table, which is all the registry uses. */
const home = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'foreman-device-'))
  mkdirSync(join(root, 'state/superagent'), { recursive: true })
  const db = new DatabaseSync(join(root, 'state/superagent/orchestrator.sqlite'))
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.close()
  return root
}

const run = (root: string, ...args: string[]): string =>
  execFileSync(process.execPath, ['scripts/add-device.mjs', ...args, '--home', root], { cwd: process.cwd(), encoding: 'utf8' })

/** The token a command printed, which is the only copy that exists. */
const tokenOf = (stdout: string): string => (JSON.parse(stdout.slice(0, stdout.indexOf('\ndatabase:'))) as { token: string }).token

describe('the device registration script', () => {
  it('registers a device and prints a token whose hash is what the database keeps', () => {
    const root = home()
    const printed = run(root, 'add', '--id', 'laptop', '--name', '公司笔记本', '--label', 'intranet', '--root', 'shop=/home/me/工作 shop')
    const token = tokenOf(printed)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    const db = new DatabaseSync(join(root, 'state/superagent/orchestrator.sqlite'))
    const record = JSON.parse(String(db.prepare('SELECT value FROM kv WHERE key=?').get('foreman-device:laptop')?.value))
    db.close()
    expect(record).toMatchObject({ id: 'laptop', name: '公司笔记本', labels: ['intranet'],
      roots: [{ project: 'shop', path: '/home/me/工作 shop' }] })
    // The token itself must not be recoverable from the database.
    expect(record.tokenHash).not.toBe(token)
    expect(JSON.stringify(record)).not.toContain(token)
  })

  it('refuses a second device under an id already taken, naming what to do instead', () => {
    const root = home()
    run(root, 'add', '--id', 'laptop')
    expect(() => run(root, 'add', '--id', 'laptop')).toThrow(/already registered/)
  })

  it('lists what is registered without ever printing a hash', () => {
    const root = home()
    run(root, 'add', '--id', 'laptop', '--name', 'L')
    run(root, 'add', '--id', 'dorm', '--name', 'D')
    const listing = run(root, 'list')
    expect(listing).toContain('laptop')
    expect(listing).toContain('dorm')
    expect(listing).not.toContain('tokenHash')
  })

  it('rotates a token and revokes a device, both visible in the listing', () => {
    const root = home()
    const first = tokenOf(run(root, 'add', '--id', 'laptop'))
    const second = tokenOf(run(root, 'rotate', '--id', 'laptop'))
    expect(second).not.toBe(first)
    run(root, 'revoke', '--id', 'laptop')
    expect(JSON.parse(run(root, 'list').split('\n')[0]!)).toMatchObject({ id: 'laptop', revokedAt: expect.any(String) })
  })

  it('refuses a home that holds no hub database', () => {
    expect(() => run(join(tmpdir(), 'no-such-foreman-home'), 'list')).toThrow(/no hub database/)
  })

  it('refuses a --root that is not project=path', () => {
    expect(() => run(home(), 'add', '--id', 'x', '--root', 'no-equals-sign')).toThrow(/project>=<path|not no-equals-sign/)
  })
})
