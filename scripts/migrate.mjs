#!/usr/bin/env node
/**
 * Pack and verify a hub migration.
 *
 * Moving the hub is "stop, pack, copy, unpack at the same absolute paths, start". The steps that cannot be skipped are
 * the SQLite checkpoint (the database runs in WAL mode, so the newest writes live in a `-wal` file and copying only
 * the `.sqlite` silently loses them) and the path check (the rows hold absolute directories, so a ledger moved to a
 * differently-rooted home opens and verifies while every work directory it names is missing).
 *
 * The script is plain ESM with no dependencies beyond Node's own SQLite, because it has to run on a machine where the
 * hub may not be installed. On Windows it only checkpoints and prints what to copy: `tar` is not guaranteed there, and
 * a silent half-copy is worse than a printed list.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * The lists the panel's export and this script both carry.
 *
 * They are duplicated here on purpose. The packaged build is a bundle whose internal chunk names carry content hashes
 * (`feishu-CE_QMi6y.js`), so a script cannot import one module out of it by path; and the script has to run on a
 * machine where the hub is not installed at all. `src/app/migrate.ts` holds the same list for the runtime side, and
 * `tests/migration-script.spec.ts` asserts the two agree — that is the guard against them drifting apart.
 */
const DATABASE = 'state/superagent/orchestrator.sqlite'
/** Everything a move carries, relative to the DSH home. `.credentials.yaml` holds the panel's browser session. */
const CARRIED = ['state/superagent', 'storages', 'sessions', 'attachments', '.credentials.yaml', 'profiles']
/** Skipped inside `profiles`: rebuilt from `package.json` on the new machine, and built for the old one. */
const PROFILE_SKIP = 'node_modules'

const usage = `Usage:
  node scripts/migrate.mjs plan       --home <dir>
  node scripts/migrate.mjs checkpoint --home <dir>
  node scripts/migrate.mjs pack       --home <dir> --out <tar>
  node scripts/migrate.mjs verify     --home <dir> [--strict-paths]

--home is the DSH_HOME of the instance being moved (default: $DSH_HOME, else ~/.dsh).
verify reports work directories that open tickets name but this machine lacks, and continues: a fresh machine has not
cloned the projects yet, and their tickets are marked blocked at startup so the gap shows on the board. Pass
--strict-paths to make those directories a failure instead, which is what a final check before switching over wants.`

/** Reads `--name value` pairs, and flags; a flag's next token being absent or another flag is what makes it one. */
function options(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]
    if (!name.startsWith('--')) throw new Error(`unexpected argument ${name}\n\n${usage}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) { values.set(name.slice(2), true); continue }
    values.set(name.slice(2), value)
    index++
  }
  return values
}

/** The DSH home to act on: `--home`, else `$DSH_HOME`, else `~/.dsh`. */
function homeOf(values) {
  const given = values.get('home') ?? process.env.DSH_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.dsh')
  return resolve(String(given))
}

/**
 * Bytes under a path, skipping every directory named `skip` at any depth.
 *
 * The exclusion has to be recursive because dependencies live one level deeper than the profile: `profiles/web` holds
 * `node_modules`, not `profiles`. A shallow check looked right in the plan and then counted the whole 21 MB anyway,
 * which is the same number the archive deliberately does not contain.
 */
function sizeOf(path, skip) {
  let info
  try { info = lstatSync(path) } catch { return 0 }
  if (!info.isDirectory()) return info.size
  let total = info.size
  let entries
  try { entries = readdirSync(path) } catch { return total }
  for (const name of entries) if (name !== skip) total += sizeOf(join(path, name), skip)
  return total
}

/** Bytes this home would carry, with `profiles/node_modules` excluded so the number matches what the tar holds. */
function carriedBytes(home, name) {
  const path = join(home, name)
  if (!existsSync(path)) return undefined
  return sizeOf(path, PROFILE_SKIP)
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
  } finally { db.close() }
  return database
}

/** Prints what a move carries, with each entry's size, so a partial copy is visible before it happens. */
function plan(home) {
  requireHome(home)
  const lines = [`home: ${home}`, `database: ${DATABASE}`, '']
  let total = 0
  for (const name of CARRIED) {
    const bytes = carriedBytes(home, name)
    if (bytes === undefined) { lines.push(`  ${name}: absent`); continue }
    total += bytes
    lines.push(`  ${name}: ${bytes} bytes`)
  }
  lines.push('', `total: ${total} bytes`, '',
    `profiles/${PROFILE_SKIP} is excluded: the new machine rebuilds it from package.json and pnpm-lock.yaml.`,
    'Copy these to the same absolute paths on the new machine; the database must keep its path or the ledger\'s absolute paths break.')
  return lines.join('\n')
}

/** Packs the carried entries into a tar, after the checkpoint. Windows has no guaranteed `tar`, so it prints instead. */
function pack(home, out) {
  const database = checkpoint(home)
  if (process.platform === 'win32') {
    throw new Error(`on Windows this script only checkpoints (${database}); copy ${CARRIED.join(', ')} to the new machine`
      + ' with the same absolute paths, then run verify there')
  }
  mkdirSync(dirname(out), { recursive: true })
  const present = CARRIED.filter(name => existsSync(join(home, name)))
  // `--exclude=node_modules` matches at any depth, so every profile drops its dependencies without naming them.
  const result = spawnSync('tar', ['-czf', out, '-C', home, `--exclude=${PROFILE_SKIP}`, ...present.map(name => `./${name}`)], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`tar failed with status ${result.status}`)
  return out
}

/**
 * The work directories open tickets name, with the ticket each belongs to, so a move can refuse or warn intelligently.
 *
 * Only open tickets count: a work directory is created when work starts and cleaned up after, so a finished ticket
 * still carries the path it used, and demanding that path exist would refuse the hub's own export. A directory the
 * executor makes on demand (it ends in the ticket's id) is skipped as well — its absence is the normal state before
 * the ticket runs.
 */
function ledgerDirectories(home) {
  const database = requireHome(home)
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const roots = new Set()
    for (const row of db.prepare('SELECT id, value FROM ticket').all()) {
      let ticket
      try { ticket = JSON.parse(String(row.value)) } catch { continue }
      if (ticket?.ended) continue
      const directory = ticket?.execution?.directory
      if (typeof directory !== 'string' || directory === '') continue
      // Same rule as the runtime: `<name>-<first 12 of the ticket id>` is created when the ticket runs.
      if (directory.endsWith(`-${String(row.id).slice(0, 12)}`)) continue
      roots.add(directory)
    }
    return [...roots]
  } catch { return [] } finally { db.close() }
}

/**
 * Checks that what a finished move produced is usable.
 *
 * It prints counts rather than asserting a specific number, because the number depends on the instance — the operator
 * compares it with the old machine's. The directory check is the part a count cannot make: a ledger whose rows name
 * directories that are not here opens, counts correctly, and then cannot run a single ticket.
 */
function verify(home, allowMissingPaths, strictPaths) {
  checkpoint(home)
  const counts = {}
  const counting = new DatabaseSync(requireHome(home), { readOnly: true })
  try {
    for (const table of ['kv', 'trigger', 'ticket']) {
      // A fresh or partially built database may lack a table; report that rather than failing the whole verify.
      try { counts[table] = String(counting.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0) } catch { counts[table] = 'absent' }
    }
  } finally { counting.close() }
  const lines = [
    `home: ${home}`,
    'checkpoint ok',
    `workspace.json: ${existsSync(join(home, 'storages/workspace.json')) ? 'present' : 'MISSING'}`,
    `tickets: ${counts.ticket}`,
    `rows: kv=${counts.kv} trigger=${counts.trigger} ticket=${counts.ticket}`,
  ]
  for (const name of CARRIED) if (!existsSync(join(home, name))) lines.push(`missing entry: ${name}`)
  const missing = ledgerDirectories(home).filter(directory => !existsSync(directory))
  if (missing.length) {
    const shown = missing.slice(0, 5).map(path => `  ${path}`).join('\n')
    const more = missing.length > 5 ? `\n  and ${missing.length - 5} more` : ''
    // `--allow-missing-paths` and `--strict-paths` are the two explicit answers to a question the default cannot
    // guess: a fresh machine legitimately has not cloned yet, while an operator checking a move wants it to fail.
    if (strictPaths) throw new Error([
      ...lines, '', `recorded work directories not on this machine (${missing.length}):`, `${shown}${more}`, '',
      'Unpack this ledger at the same absolute paths, or clone the projects first.',
    ].join('\n'))
    // The default reports them and continues: the affected tickets are marked blocked at startup, so the gap shows on
    // the board instead of making the whole restore unusable until every project happens to be cloned.
    lines.push('', `recorded work directories not on this machine (${missing.length}); their tickets will be blocked:`,
      `${shown}${more}`, '', 'Clone the projects and retry those tickets from the panel.')
    if (allowMissingPaths) lines.push('(reported because --allow-missing-paths was given; this is also the default.)')
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
    if (out === undefined || out === true) throw new Error(`pack needs --out <tar>\n\n${usage}`)
    console.log(`packed: ${pack(home, resolve(String(out)))}`)
  } else if (command === 'verify') console.log(verify(home, values.get('allow-missing-paths') === true, values.get('strict-paths') === true))
  else throw new Error(`unknown command ${command}\n\n${usage}`)
} catch (error) {
  console.error(`migrate: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
