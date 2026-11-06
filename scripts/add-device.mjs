#!/usr/bin/env node
/**
 * Register a device on the hub, or manage the ones already registered.
 *
 * Adding a device must not mean editing plugin configuration and restarting the hub — that is an anti-goal of the
 * design — so this writes the registry row directly and the running hub picks it up on the device's next hello.
 *
 * Plain ESM on `node:sqlite`, no dependencies: it has to run on a server where only the hub is installed.
 *
 *   node scripts/add-device.mjs add --home <dir> --id laptop --name "公司笔记本" \
 *        --root shop=/home/me/work/shop --label intranet
 *   node scripts/add-device.mjs list  --home <dir>
 *   node scripts/add-device.mjs rotate --home <dir> --id laptop
 *   node scripts/add-device.mjs revoke --home <dir> --id laptop
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DATABASE = 'state/superagent/orchestrator.sqlite'
const PREFIX = 'foreman-device:'

const usage = `Usage:
  add    --id <id> --name <name> [--label <label>]... [--root <project>=<path>]...
  list
  rotate --id <id>
  revoke --id <id>
All commands take --home <dir> (default: $DSH_HOME, else ~/.dsh) and --db <path> to override the database.`

const hashToken = token => createHash('sha256').update(token, 'utf8').digest('hex')

/** Reads repeating and single `--name value` options into a list of pairs. */
function options(argv) {
  const single = new Map()
  const many = { label: [], root: [] }
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]
    if (!name.startsWith('--')) throw new Error(`unexpected argument ${name}\n\n${usage}`)
    const key = name.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value\n\n${usage}`)
    if (key in many) many[key].push(value)
    else single.set(key, value)
    index++
  }
  return { single, many }
}

/** Opens the hub's database, refusing a path that is not one so a typo cannot write anywhere. */
function open(single) {
  const home = resolve(single.get('home') ?? process.env.DSH_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.dsh'))
  const path = single.get('db') ? resolve(single.get('db')) : join(home, DATABASE)
  if (!existsSync(path)) throw new Error(`no hub database at ${path}; is --home the DSH home of the loop instance?`)
  const db = new DatabaseSync(path)
  // The registry is a kv family, so this works without importing the hub's schema: the key format is the contract.
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return { db, path }
}

const read = (db, id) => {
  const row = db.prepare('SELECT value FROM kv WHERE key=?').get(PREFIX + id)
  return row === undefined ? undefined : JSON.parse(String(row.value))
}
const write = (db, record) => {
  db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(PREFIX + record.id, JSON.stringify(record))
}
const all = db => db.prepare('SELECT value FROM kv WHERE key LIKE ? ORDER BY key').all(`${PREFIX}%`).map(row => JSON.parse(String(row.value)))

/** `project=path`, split on the first `=` so a Windows path's own `=` survives. */
function rootsOf(values) {
  return values.map(value => {
    const at = value.indexOf('=')
    if (at <= 0) throw new Error(`--root needs <project>=<path>, not ${value}`)
    return { project: value.slice(0, at), path: value.slice(at + 1) }
  })
}

const [command, ...rest] = process.argv.slice(2)
if (command === undefined || ['-h', '--help', 'help'].includes(command)) {
  console.log(usage)
  process.exit(0)
}
try {
  const { single, many } = options(rest)
  const { db, path } = open(single)
  let output
  try {
    if (command === 'add') {
      const id = single.get('id'), name = single.get('name')
      if (!id) throw new Error('add needs --id')
      if (read(db, id) !== undefined) throw new Error(`a device with id ${id} is already registered; use rotate to replace its token`)
      const token = randomBytes(32).toString('hex')
      write(db, { id, name: name ?? id, labels: many.label, roots: rootsOf(many.root), tokenHash: hashToken(token) })
      // The token is printed once and never stored in readable form: there is nothing to look it up from later.
      output = JSON.stringify({ device: id, token, note: 'this token is shown once; only its hash is stored' }, null, 2)
    } else if (command === 'list') {
      output = all(db).map(({ tokenHash: _hidden, ...record }) => record)
        .map(record => JSON.stringify(record)).join('\n') || '(no device is registered)'
    } else if (command === 'rotate') {
      const id = single.get('id')
      const device = id === undefined ? undefined : read(db, id)
      if (device === undefined) throw new Error(`no device with id ${String(id)}`)
      const token = randomBytes(32).toString('hex')
      write(db, { ...device, tokenHash: hashToken(token) })
      output = JSON.stringify({ device: device.id, token }, null, 2)
    } else if (command === 'revoke') {
      const id = single.get('id')
      const device = id === undefined ? undefined : read(db, id)
      if (device === undefined) throw new Error(`no device with id ${String(id)}`)
      write(db, { ...device, revokedAt: new Date().toISOString() })
      output = `revoked ${device.id}: its next frame is refused and its connection is dropped`
    } else throw new Error(`unknown command ${command}\n\n${usage}`)
  } finally {
    db.close()
  }
  console.log(output)
  if (command !== 'list') console.log(`\ndatabase: ${path}\nthe running hub needs no restart; the device picks this up when it next connects.`)
} catch (error) {
  console.error(`add-device: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
