#!/usr/bin/env node
/**
 * Pack and verify a hub migration.
 *
 * Moving the hub is "stop, pack, copy, unpack at the same absolute paths, start". The one step that cannot be
 * skipped is the SQLite checkpoint: the database runs in WAL mode, so the newest writes live in a `-wal` file, and
 * copying only the `.sqlite` silently loses them. srv-01 has no `sqlite3` command, so the checkpoint goes through
 * `node:sqlite` here.
 *
 * The script is plain ESM with no dependencies, because it has to run on a machine where the hub may not be
 * installed. On Windows it only checkpoints and prints what to copy: `tar` is not guaranteed there, and a silent
 * half-copy is worse than a printed list.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** The directories a move must carry. `storages` is not optional: it holds the workspace UUIDs the main Sessions are keyed by. */
const DIRECTORIES = ['state/superagent', 'storages', 'sessions', 'attachments', 'profiles']
/** The database inside the state directory. */
const DATABASE = 'state/superagent/orchestrator.sqlite'

const usage = `Usage:
  node scripts/migrate.mjs plan       --home <dir>
  node scripts/migrate.mjs checkpoint --home <dir>
  node scripts/migrate.mjs pack       --home <dir> --out <tar>
  node scripts/migrate.mjs verify     --home <dir>

--home is the DSH_HOME of the instance being moved (default: $DSH_HOME, else ~/.dsh).`

/** Reads `--name value` pairs; a missing value is an error rather than an empty string. */
function options(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]
    if (!name.startsWith('--')) throw new Error(`unexpected argument ${name}\n\n${usage}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value\n\n${usage}`)
    values.set(name.slice(2), value)
    index++
  }
  return values
}

/** The DSH home to act on: `--home`, else `$DSH_HOME`, else `~/.dsh`. */
function homeOf(values) {
  const given = values.get('home') ?? process.env.DSH_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.dsh')
  return resolve(given)
}

/** Refuses a directory that is not a DSH home, so a typo cannot checkpoint or pack the wrong database. */
function requireHome(home) {
  const database = join(home, DATABASE)
  if (!existsSync(database)) throw new Error(`${home} is not a DSH home: ${database} does not exist`)
  return database
}

/**
 * Checkpoints the WAL into the database file and closes it.
 *
 * `TRUNCATE` writes the frames back and empties the `-wal`, which is what makes a plain file copy complete. A
 * checkpoint that reports it could not finish throws: packing a database that still has unmerged writes is exactly
 * the silent data loss this step exists to prevent.
 */
function checkpoint(home) {
  const database = requireHome(home)
  const db = new DatabaseSync(database)
  try {
    const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    // The pragma answers { busy, log, checkpointed }: `busy` non-zero means another connection still holds the WAL.
    if (row && Number(row.busy) !== 0) throw new Error(`the database is still in use by another process (busy=${row.busy}); stop the hub first`)
  } finally {
    db.close()
  }
  return database
}

/** Prints what a move carries, with each directory's size, so a partial copy is visible before it happens. */
function plan(home) {
  requireHome(home)
  const lines = [`home: ${home}`, `database: ${DATABASE}`, '']
  let total = 0
  for (const directory of DIRECTORIES) {
    const path = join(home, directory)
    if (!existsSync(path)) { lines.push(`  ${directory}: absent`); continue }
    const bytes = sizeOf(path)
    total += bytes
    lines.push(`  ${directory}: ${bytes} bytes`)
  }
  lines.push('', `total: ${total} bytes`, '', 'Copy these to the same absolute paths on the new machine; the database must keep its path or the ledger\'s absolute paths break.')
  return lines.join('\n')
}

/** Total bytes of a file or directory tree, without following links. */
function sizeOf(path) {
  const info = statSync(path)
  if (!info.isDirectory()) return info.size
  const result = spawnSync('du', ['-sb', path], { encoding: 'utf8' })
  if (result.status === 0) return Number(result.stdout.split(/\s+/)[0]) || 0
  // No `du` (Windows): report the directory's own size, which is enough to show it was looked at.
  return info.size
}

/** Packs the directories into a tar, after the checkpoint. Windows has no guaranteed `tar`, so it prints instead. */
function pack(home, out) {
  const database = checkpoint(home)
  if (process.platform === 'win32') {
    throw new Error(`on Windows this script only checkpoints (${database}); copy ${DIRECTORIES.join(', ')} to the new machine with the same absolute paths, then run verify there`)
  }
  mkdirSync(dirname(out), { recursive: true })
  const existing = DIRECTORIES.filter(directory => existsSync(join(home, directory)))
  const result = spawnSync('tar', ['-czf', out, '-C', home, ...existing], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`tar failed with status ${result.status}`)
  return out
}

/**
 * Checks that what a finished move produced is usable: the database opens, the checkpoint took, and the workspace
 * copy is present. It prints counts rather than asserting a specific number, because the number depends on the
 * instance — the operator compares it with the old machine's.
 */
function verify(home) {
  const database = requireHome(home)
  // Re-checkpointing is safe and tells us whether the WAL came back after the copy.
  const db = new DatabaseSync(database)
  let checkpointed
  try {
    checkpointed = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    const busy = checkpointed ? Number(checkpointed.busy) : 0
    if (busy !== 0) throw new Error('the database is in use; stop the hub before verifying a move')
  } finally {
    db.close()
  }
  const counts = {}
  const counting = new DatabaseSync(database)
  try {
    for (const table of ['kv', 'trigger', 'ticket']) {
      // A fresh or partially built database may lack a table; report that rather than failing the whole verify.
      try { counts[table] = String(counting.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0) } catch { counts[table] = 'absent' }
    }
  } finally {
    counting.close()
  }
  const lines = [
    `home: ${home}`,
    'checkpoint ok',
    `workspace.json: ${existsSync(join(home, 'storages/workspace.json')) ? 'present' : 'MISSING'}`,
    `tickets: ${counts.ticket}`,
    `rows: kv=${counts.kv} trigger=${counts.trigger} ticket=${counts.ticket}`,
  ]
  for (const directory of DIRECTORIES) {
    if (!existsSync(join(home, directory))) lines.push(`missing directory: ${directory}`)
  }
  return lines.join('\n')
}

const [command, ...rest] = process.argv.slice(2)
if (command === undefined || ['-h', '--help', 'help'].includes(command)) {
  console.log(usage)
  process.exit(0)
}
try {
  const values = options(rest)
  const home = homeOf(values)
  if (command === 'plan') console.log(plan(home))
  else if (command === 'checkpoint') console.log(`checkpoint ok: ${checkpoint(home)}`)
  else if (command === 'pack') {
    const out = values.get('out')
    if (out === undefined) throw new Error(`pack needs --out <tar>\n\n${usage}`)
    console.log(`packed: ${pack(home, resolve(out))}`)
  } else if (command === 'verify') console.log(verify(home))
  else throw new Error(`unknown command ${command}\n\n${usage}`)
} catch (error) {
  console.error(`migrate: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
