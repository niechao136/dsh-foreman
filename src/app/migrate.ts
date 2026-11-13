/**
 * What a hub move carries, what it must not, and how a moved ledger is checked.
 *
 * Moving the hub is "stop, pack, copy, unpack at the same absolute paths, start" (docs/migration.md). Two parts of
 * that are easy to get subtly wrong, and both are silent:
 *
 * - **The WAL.** The database runs in WAL mode, so the newest writes live in `-wal`; copying only the `.sqlite` loses
 *   the most recent tickets. Packing therefore checkpoints first and refuses a database another process still holds.
 * - **The paths.** `Execution.directory` and the worker shim paths are absolute and written into rows. Unpacking a
 *   ledger that was built under `/root` into `/home/ubuntu` produces a database that opens, verifies and reports a
 *   matching ticket count — and then fails to find a work directory. That must be an error at move time.
 *
 * This module holds the lists and the checks so the CLI (`scripts/migrate.mjs`) and the panel's export both use the
 * same ones: a rule that exists in two places is a rule that will disagree with itself.
 */
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * The directories and files a move carries, relative to the DSH home.
 *
 * `storages` is not optional: it holds the workspace UUIDs the main Sessions are keyed by, so without it every main
 * Session loses its workspace on the new machine. `.credentials.yaml` is here for the same reason of consequence
 * rather than size: it holds the browser session that the panel is opened with, and leaving it behind means the
 * operator arrives on the new machine already logged out, with nothing to say why.
 */
export const CARRIED = ['state/superagent', 'storages', 'sessions', 'attachments', '.credentials.yaml', 'profiles'] as const
/** The database inside the state directory. Its path must not change, because rows refer to paths below it. */
export const DATABASE = 'state/superagent/orchestrator.sqlite'

/**
 * Paths inside `profiles` that a move skips.
 *
 * `node_modules` is twenty-one of the thirty-one megabytes here, and every byte of it is rebuildable: the new machine
 * installs the same bundles from `package.json` + `pnpm-lock.yaml`. Carrying it also imports binaries built for the
 * old machine. `data/` is the opposite — authentication state that cannot be rebuilt — so it stays.
 */
export const PROFILE_SKIP = ['node_modules'] as const

/** One thing a move carries, and how much of it there is. */
export interface Carried {
  name: string
  /** Bytes, or undefined when the entry is absent — which is not an error, but the operator should see it. */
  bytes?: number
}

/**
 * Total bytes of a file or directory tree, without following links, skipping any directory named `skip` at any depth.
 *
 * The skip is recursive because dependencies live below the profile, not beside it: `profiles/web/node_modules`, not
 * `profiles/node_modules`. A shallow exclusion reported the whole tree while the archive left it out, which is the one
 * number an operator uses to decide whether the copy is small.
 */
export function sizeOf(path: string, skip?: string): number {
  let info
  try { info = lstatSync(path) } catch { return 0 }
  if (!info.isDirectory()) return info.size
  let total = info.size
  let entries
  try { entries = readdirSync(path) } catch { return total }
  for (const name of entries) if (name !== skip) total += sizeOf(join(path, name), skip)
  return total
}

/**
 * What this home would carry, entry by entry.
 *
 * Every entry reports the size actually packed, so a `plan` that says 22 MB never stands beside an archive of 1 MB.
 */
export function carried(home: string): Carried[] {
  return CARRIED.map(name => {
    const path = join(home, name)
    if (!existsSync(path)) return { name }
    return { name, bytes: sizeOf(path, name === 'profiles' ? PROFILE_SKIP[0] : undefined) }
  })
}

/**
 * The arguments `tar` needs to pack this home.
 *
 * `--exclude=node_modules` matches at any depth, so every profile drops its dependencies without the caller having to
 * enumerate them. Entries that are absent are left out rather than passed: `tar` fails on a missing member, and an
 * absent `attachments` is normal on a hub that has received none.
 */
export function tarArguments(home: string): string[] {
  const present = CARRIED.filter(name => existsSync(join(home, name)))
  return ['-C', home, '--exclude=node_modules', ...present.map(name => `./${name}`)]
}

/**
 * Checkpoints the WAL into the database file.
 *
 * `TRUNCATE` writes the frames back and empties the `-wal`, which is what makes a plain file copy complete. A
 * checkpoint that reports it could not finish throws: packing a database that still has unmerged writes is exactly
 * the silent data loss this step exists to prevent.
 */
export function checkpoint(home: string): { database: string; busy: number } {
  const database = join(home, DATABASE)
  if (!existsSync(database)) throw new Error(`${home} is not a DSH home: ${database} does not exist`)
  const db = new DatabaseSync(database)
  try {
    const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | undefined
    const busy = Number(row?.busy ?? 0)
    if (busy !== 0) throw new Error(`the database is still in use by another process (busy=${busy}); stop the hub first`)
    return { database, busy }
  } finally { db.close() }
}

/**
 * A consistent snapshot of the ledger, written beside it, without stopping the hub.
 *
 * `VACUUM INTO` reads through the connection's own view, so it neither blocks the running hub nor misses the WAL —
 * which makes it the right primitive for the panel's export, where the operator cannot be asked to stop first. The
 * result is a plain database file with no `-wal` beside it, so a copy of it is complete.
 */
export function snapshot(home: string, out: string): string {
  const database = join(home, DATABASE)
  if (!existsSync(database)) throw new Error(`${home} is not a DSH home: ${database} does not exist`)
  const db = new DatabaseSync(database, { readOnly: true })
  try { db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`) } finally { db.close() }
  return out
}

/**
 * The work directories that open tickets name, so a move into a differently-rooted home can be refused.
 *
 * Only open tickets count. A work directory is created when work starts and cleaned up after, so a finished ticket
 * still carries the path it used — and demanding that path exist would refuse the hub's own export, which is the most
 * common archive a restore ever sees.
 */
export function ledgerRoots(home: string): string[] {
  const database = join(home, DATABASE)
  if (!existsSync(database)) return []
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const roots = new Set<string>()
    for (const row of db.prepare('SELECT value FROM ticket').all() as { value: string }[]) {
      let ticket: { ended?: unknown; execution?: { directory?: unknown } }
      try { ticket = JSON.parse(row.value) as typeof ticket } catch { continue }
      if (ticket.ended) continue
      const directory = ticket.execution?.directory
      if (typeof directory === 'string' && directory !== '') roots.add(directory)
    }
    return [...roots]
  } catch { return [] } finally { db.close() }
}

/**
 * Whether a moved ledger's recorded directories exist on this machine.
 *
 * Returns the directories that do not, so the caller can name them. An empty list means the ledger describes places
 * this machine can actually reach; that is the check a ticket count cannot make.
 */
export function missingDirectories(home: string): string[] {
  return ledgerRoots(home).filter(directory => !existsSync(directory))
}

/** Table row counts for a verify report; a table a fresh database lacks is reported rather than failing the whole check. */
export function counts(home: string): Record<string, string> {
  const database = join(home, DATABASE)
  const result: Record<string, string> = {}
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    for (const table of ['kv', 'trigger', 'ticket']) {
      try { result[table] = String((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n?: number } | undefined)?.n ?? 0) }
      catch { result[table] = 'absent' }
    }
  } finally { db.close() }
  return result
}
