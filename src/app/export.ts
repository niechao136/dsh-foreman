/**
 * Exporting a hub as one archive from the panel, without stopping it.
 *
 * The CLI (`scripts/migrate.mjs`) has to checkpoint first and therefore has to ask the operator to stop the hub. The
 * panel cannot: it *is* the running hub. So the export uses a different primitive — `VACUUM INTO` reads a consistent
 * snapshot through the live connection, WAL included, and writes it to a plain file with no `-wal` beside it, so a
 * copy of that file is complete on its own.
 *
 * Everything is assembled in a staging directory shaped like the DSH home before packing, so the archive keeps the
 * relative paths a restore needs: a ledger that lands anywhere other than `state/superagent/orchestrator.sqlite`
 * describes directories that no longer exist. Staging also makes the pack a single `tar -C`, instead of a per-entry
 * `-C` dance that is easy to get subtly wrong.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { CARRIED, DATABASE, PROFILE_SKIP, snapshot } from './migrate.ts'

/** Where a half-built export lives while it is being streamed, under the state directory. */
const STAGING = 'migrate-export'

/** The dependency directory the export leaves behind, whichever profile it belongs to. */
const SKIP = PROFILE_SKIP[0]

/**
 * Build the staging home: a snapshot of the ledger plus every other carried entry.
 *
 * `VACUUM INTO` refuses an existing target, and a previous interrupted export must not leak a stale database into this
 * one, so the directory is removed and recreated first.
 */
export function stage(home: string, stateDir: string): string {
  const staging = join(stateDir, STAGING)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  // The snapshot replaces the live database: copying the live file instead would miss the WAL, which is the whole
  // reason `snapshot` exists.
  const statePath = join(staging, 'state', 'superagent')
  mkdirSync(statePath, { recursive: true })
  snapshot(home, join(statePath, 'orchestrator.sqlite'))
  for (const name of CARRIED) {
    if (name === 'state/superagent') continue
    const from = join(home, name)
    if (!existsSync(from)) continue
    const to = join(staging, name)
    if (name === 'profiles') {
      // `node_modules` is rebuilt on the new machine from the lockfile and contains binaries built for this one.
      cpSync(from, to, { recursive: true, filter: source => !source.split(/[\\/]/).includes(SKIP) })
    } else if (name === '.credentials.yaml') copyFileSync(from, to)
    else cpSync(from, to, { recursive: true })
  }
  return staging
}

/**
 * Stream a tar of this hub through `write`, resolving once the archive has been fully handed over.
 *
 * `tar -czf -` writes to stdout and its output is passed straight to the caller, so memory use stays flat: a sessions
 * directory of hundreds of megabytes must not have to fit in a request handler's buffer. A tar that fails is reported
 * as a rejection so the caller can abort the response — a truncated archive that looks complete is exactly the silent
 * half-copy the documentation warns about.
 *
 * The packed members are the staging directory's top-level entries, which is why the staging is shaped like the home:
 * `state`, `storages`, `sessions`, `.credentials.yaml`, and `profiles` with its dependencies already filtered out.
 */
export function pack(home: string, stateDir: string, write: (chunk: Buffer) => void,
  onChild?: (child: ChildProcess) => void): Promise<void> {
  const staging = stage(home, stateDir)
  const done = (): void => { rmSync(staging, { recursive: true, force: true }) }
  return new Promise<void>((resolve, reject) => {
    // `--exclude` is belt and braces: `stage` already left the dependencies behind, and a second filter costs nothing.
    const child: ChildProcess = spawn('tar', ['-czf', '-', '-C', staging, '--exclude', SKIP, '.'], { stdio: ['ignore', 'pipe', 'pipe'] })
    onChild?.(child)
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 2000) stderr += String(chunk) })
    child.stdout?.on('data', (chunk: Buffer) => write(chunk))
    child.on('error', (error: Error) => { done(); reject(error) })
    child.on('close', code => {
      done()
      if (code !== 0) reject(new Error(`tar failed with status ${code}: ${stderr.trim() || 'no output'}`))
      else resolve()
    })
  })
}

/** Whether an export can run here: `tar` is not guaranteed on Windows, where the CLI refuses to pack too. */
export const canExport = (): boolean => process.platform !== 'win32'

/** The archive's name: the instance and the moment, so two downloads never overwrite each other in a browser. */
export function archiveName(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `dsh-foreman-${stamp}.tar.gz`
}

/** The ledger's database inside a home, so callers do not re-derive the path. */
export const databaseOf = (home: string): string => join(home, DATABASE)

/**
 * The DSH home a state directory belongs to.
 *
 * The export carries entries beside the state directory (`storages`, `sessions`, `.credentials.yaml`, `profiles`), so
 * it needs the home rather than the configured `stateDir`. The default is `<DSH_HOME>/state/superagent`; a custom
 * `stateDir` elsewhere leaves no home to derive, and the panel then exports what it can name — the state directory's
 * parent — rather than guessing a place that does not exist.
 */
export function homeOf(stateDir: string): string {
  const parent = dirname(resolve(stateDir))
  return basename(parent) === 'state' ? dirname(parent) : parent
}
