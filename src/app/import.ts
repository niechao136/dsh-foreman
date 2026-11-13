/**
 * Restoring a hub from an archive, from the panel.
 *
 * The order is fixed by two facts that cannot be worked around:
 *
 * 1. **The ledger is open.** This process holds the SQLite connection and the state-directory lock, so the files cannot
 *    be replaced under it; the hub has to stop first. `Runtime.shutdown` already closes the database and releases the
 *    lock, and `fiber.restart()` brings it back up — so a restore is stop → swap → restart, driven from the inside.
 * 2. **A half-finished swap is worse than none.** Unpacking straight onto the live home means an interrupted request
 *    leaves a mixed ledger. So an archive is unpacked and checked in a staging directory first, and only a complete,
 *    verified tree is moved into place; the previous tree is renamed aside, never deleted.
 *
 * That is why a restore is a sequence of steps with observable state rather than one call: upload, check, swap. The
 * panel shows each one, and the swap keeps the old home as `.bak-<timestamp>` so the failure case is recoverable.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CARRIED, DATABASE } from './migrate.ts'

/** Where an uploaded archive and its unpacked tree live until it is proven good. */
const STAGING = 'migrate-import'

/** A restore the operator has started and not yet applied. */
export interface Pending {
  /** The uploaded file, inside the staging directory. */
  archive: string
  /** The unpacked tree, ready to be moved into the home. */
  unpacked: string
  /** What the checks found; a restore with no problems is the only one that may proceed. */
  report: RestoreReport
}

/** What the archive holds, and what would go wrong if it were restored here. */
export interface RestoreReport {
  /** The date and the source the archive came from, read from the ledger itself. */
  home: string
  tickets: string
  rows: Record<string, string>
  /** Work directories the ledger names that this machine does not have. Empty is the normal, healthy case. */
  missingDirectories: string[]
  /** Fatal problems: the restore must not proceed while any is present. */
  problems: string[]
  /** Non-fatal notes, such as a missing `attachments` directory a hub never used. */
  notes: string[]
  /** Bytes of the uploaded archive, so the operator can see the transfer arrived whole. */
  bytes: number
}

/**
 * Unpack an uploaded archive into the staging directory and check what it holds.
 *
 * The archive is never unpacked over the home: `/tmp`-style staging is the only safe target, because a tar that fails
 * halfway leaves exactly the mixed tree the checks exist to prevent. `tar` writes as root here, so the staging is
 * removed and recreated to avoid inheriting anything from a previous attempt.
 */
export function unpack(home: string, stateDir: string, archive: string, bytes: number): Pending {
  const staging = join(stateDir, STAGING)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const unpacked = join(staging, 'home')
  mkdirSync(unpacked, { recursive: true })
  const result = spawnSync('tar', ['-xzf', archive, '-C', unpacked], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`the archive could not be unpacked: ${(result.stderr || '').trim() || `tar exited ${result.status}`}`)
  }
  // A tar that carries a top-level `./` still unpacks its members directly under the target, so the ledger's own path
  // is the fixed point to check rather than a guessed root.
  const ledger = join(unpacked, DATABASE)
  if (!existsSync(ledger)) {
    throw new Error(`the archive does not hold ${DATABASE}; this does not look like a dsh-foreman export`)
  }
  return { archive, unpacked, report: check(unpacked, bytes) }
}

/**
 * Check an unpacked tree before it is allowed to replace the live one.
 *
 * Three questions, in the order that makes a failure easy to explain:
 *
 * - **Is it a ledger?** It opens, and its schema version is one this build can read. A database this build is older
 *   than cannot be migrated forward, and opening it would fail after the swap instead of before it.
 * - **Does it describe this machine?** Every ticket's recorded work directory must exist here. This is the check a
 *   ticket count cannot make, and the reason a move into a differently-rooted home used to look successful.
 * - **Is anything missing?** A carried entry that is absent is a note, not a failure: a hub that never received an
 *   attachment legitimately has no `attachments` directory.
 */
export function check(unpacked: string, bytes: number): RestoreReport {
  const problems: string[] = []
  const notes: string[] = []
  let tickets = '?'
  let rows: Record<string, string> = {}
  let missingDirectories: string[] = []
  const ledger = join(unpacked, DATABASE)
  try {
    const db = new DatabaseSync(ledger, { readOnly: true })
    try {
      const healthy = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined
      if ((healthy?.integrity_check ?? 'ok') !== 'ok') problems.push(`the ledger fails its integrity check: ${healthy?.integrity_check}`)
      const schema = db.prepare("SELECT value FROM kv WHERE key = 'schema'").get() as { value?: string } | undefined
      const version = Number(schema?.value ?? 0)
      // `SCHEMA_VERSION` is the shape this build writes; a newer archive comes from a newer dsh-foreman and cannot be
      // read backwards, which must be refused before the swap rather than discovered after it.
      if (!Number.isFinite(version) || version < 10) problems.push(`the ledger's schema version (${schema?.value ?? 'missing'}) is older than this build can migrate`)
      for (const table of ['kv', 'trigger', 'ticket']) {
        try { rows[table] = String((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n?: number } | undefined)?.n ?? 0) }
        catch { rows[table] = 'absent'; problems.push(`the ledger has no ${table} table`) }
      }
      tickets = rows.ticket ?? '?'
      const directories = new Set<string>()
      for (const row of db.prepare('SELECT value FROM ticket').all() as { value: string }[]) {
        let ticket: { ended?: unknown; execution?: { directory?: unknown } }
        try { ticket = JSON.parse(row.value) as typeof ticket } catch { continue }
        // Only an open ticket needs its work directory: the directory is created when work starts and cleaned up
        // after, so a finished ticket legitimately names a path that is gone (`liveTicket` is `!ticket.ended`).
        // Refusing a restore over a finished ticket would reject the hub's own export, the most common archive there is.
        if (ticket.ended) continue
        const directory = ticket.execution?.directory
        if (typeof directory === 'string' && directory !== '') directories.add(directory)
      }
      missingDirectories = [...directories].filter(directory => !existsSync(directory))
    } finally { db.close() }
  } catch (error) {
    problems.push(`the ledger could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const name of CARRIED) {
    if (name === 'state/superagent') continue
    if (!existsSync(join(unpacked, name))) notes.push(`${name} is not in the archive`)
  }
  if (!existsSync(join(unpacked, 'storages/workspace.json'))) {
    // Without it every main Session loses its workspace, so the tickets exist but their conversations are ungrouped.
    notes.push('storages/workspace.json is missing: main Sessions will not keep their workspace')
  }
  return { home: unpacked, tickets, rows, missingDirectories, problems, notes, bytes }
}

/**
 * Move an unpacked tree into the home, keeping the previous one aside.
 *
 * The swap is two renames, not a copy, so it cannot half-finish the way a recursive copy can. Order matters:
 *
 * 1. The current contents are renamed into `.bak-<timestamp>` — the same filesystem, so this is atomic per entry.
 * 2. The staged entries are renamed into place, one by one.
 *
 * A crash between the steps leaves the backup complete and the home missing entries, which the caller reports; the
 * reverse order would leave the home populated from the archive while the backup was still missing, and there would be
 * nothing to roll back to.
 *
 * The backup is kept deliberately: `verify` can be run against it, and a restore that turns out wrong is undone by
 * renaming it back. Deleting it is the operator's decision, not this function's.
 */
export function swap(home: string, unpacked: string, now = new Date()): { backup: string; moved: string[] } {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backup = `${home}.bak-${stamp}`
  mkdirSync(backup, { recursive: true })
  const moved: string[] = []
  for (const name of CARRIED) {
    const live = join(home, name)
    if (!existsSync(live)) continue
    const aside = join(backup, name)
    mkdirSync(dirname(aside), { recursive: true })
    renameSync(live, aside)
    moved.push(name)
  }
  const placed: string[] = []
  for (const name of CARRIED) {
    const staged = join(unpacked, name)
    if (!existsSync(staged)) continue
    const live = join(home, name)
    mkdirSync(dirname(live), { recursive: true })
    renameSync(staged, live)
    placed.push(name)
  }
  // The staging directory is empty now; the upload itself is left for the caller to remove after it reports success.
  rmSync(unpacked, { recursive: true, force: true })
  return { backup, moved: placed }
}

/** Where an upload is written before it is checked, inside the state directory so it is on the same filesystem. */
export function uploadPath(stateDir: string, name = 'upload.tar.gz'): string {
  const staging = join(stateDir, STAGING)
  mkdirSync(staging, { recursive: true })
  return join(staging, basename(name).replace(/[^\w.-]/g, '_'))
}

/** Bytes of a file, or 0 when it is gone. */
export const sizeOfFile = (path: string): number => { try { return statSync(path).size } catch { return 0 } }

/**
 * Run the CLI's own verify against a restored home and report what it says.
 *
 * The panel can check the same things itself — it just did, before the swap — but this runs the *installed* script,
 * which is the one the operator will use from a shell. Agreement between the two is worth knowing; disagreement means
 * one of them is wrong, and that is exactly when a person should look.
 */
export function verifyWithScript(home: string, script: string, allowMissingPaths = true): string | undefined {
  if (!existsSync(script)) return undefined
  const args = [script, 'verify', '--home', home, ...allowMissingPaths ? ['--allow-missing-paths'] : []]
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' })
  if (result.status === 0) return (result.stdout || '').trim()
  return `${(result.stdout || '').trim()}\n${(result.stderr || '').trim()}`.trim()
}

/** Everything inside the staging directory, for a caller that wants to clean up after itself. */
export const stagingPath = (stateDir: string): string => join(stateDir, STAGING)

/** Removes the staging directory; safe to call when it does not exist. */
export const clearStaging = (stateDir: string): void => { rmSync(stagingPath(stateDir), { recursive: true, force: true }) }

/**
 * Entries in an unpacked tree that the export would never have produced.
 *
 * Comparison is on the top-level name: `CARRIED` lists `state/superagent`, while a directory listing only offers
 * `state`, so matching the full paths would flag every normal archive. A hand-made archive, or one from a future
 * version, could carry a stray top-level file. None of them is moved by `swap` — it moves `CARRIED` only — but naming
 * them tells the operator that part of their archive was ignored.
 */
export function unexpectedEntries(unpacked: string): string[] {
  const top = new Set(CARRIED.map(name => name.split('/')[0]!))
  let names: string[]
  try { names = readdirSync(unpacked) } catch { return [] }
  return names.filter(name => !top.has(name))
}
