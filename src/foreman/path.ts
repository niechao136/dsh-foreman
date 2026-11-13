/**
 * Comparing a routing table's workspace path with the hub's workspace registry.
 *
 * The registry stores one canonical path per workspace: `resolveByPath` realpath-normalizes before it compares, and
 * the entity it returns carries that canonical form. A routing row is typed by hand into the panel, so it can differ
 * in ways that mean the same directory or that cannot be resolved at all:
 *
 * - a trailing separator, `//`, `.` or `..` segments;
 * - a different case on a case-insensitive filesystem;
 * - a symlinked path to the same directory;
 * - a typo such as `/root/dah-foreman` for `/root/dsh-foreman`.
 *
 * The first three should match and the last must not, but both used to end in the same silent fallback: the message
 * went to the default main Session and nothing anywhere said why. So this module normalizes what can be normalized
 * and reports what still does not match, which is what the runtime turns into a warning.
 *
 * Case folding follows the platform, deliberately: on Windows and macOS two spellings differing only in case are the
 * same directory, while on Linux they are two different projects and treating them as one would dispatch work into
 * the wrong checkout. A single global fold would fix one platform by breaking the other.
 */
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Whether this filesystem considers `Foo` and `foo` the same directory. */
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

/** One path as both the routing table and the registry may spell it, reduced to a comparable key. */
export interface PathKey {
  /** The path with separators collapsed and `.`/`..` resolved; still the spelling the operator typed. */
  resolved: string
  /** `resolved` lower-cased only where the filesystem ignores case; otherwise the same string. */
  folded: string
}

/**
 * Strip the trailing separators `resolve` leaves, except where they are the path itself.
 *
 * Two shapes end in a separator on purpose: a POSIX root (`/`) and a Windows drive root (`D:\`). Trimming those would
 * turn `/` into an empty string and `D:\` into `D:`, which Windows reads as "the current directory on drive D" — a
 * different path from the drive root, and one that would then compare equal to nothing meaningful.
 */
const stripTrailing = (path: string): string => {
  if (/^[\\/]$/.test(path) || /^[A-Za-z]:[\\/]$/.test(path)) return path
  return path.replace(/[\\/]+$/, '')
}

/**
 * Normalize a path for comparison: resolve `.`/`..` and redundant separators, strip a trailing separator, and keep a
 * `folded` form for the case-insensitive match. An empty or whitespace-only value stays empty rather than resolving
 * to the working directory, so a routing row that was never filled in cannot match a real project.
 */
export function pathKey(path: string): PathKey {
  const trimmed = path.trim()
  if (trimmed === '') return { resolved: '', folded: '' }
  const resolved = stripTrailing(resolve(trimmed))
  return { resolved, folded: CASE_INSENSITIVE ? resolved.toLowerCase() : resolved }
}

/** Whether two spellings name the same directory, by normalized and then (where applicable) case-folded comparison. */
export function samePath(left: string, right: string): boolean {
  const a = pathKey(left), b = pathKey(right)
  if (a.resolved === '' || b.resolved === '') return false
  return a.resolved === b.resolved || a.folded === b.folded
}

/**
 * The canonical form of a path on this machine, or undefined when it does not exist.
 *
 * Used to compare a routing row against a workspace the registry already knows: the registry's path is already
 * canonical, so resolving the row is what makes a symlinked or differently-cased spelling line up without opening a
 * workspace at a path that is not there. A path that does not exist is not an error here — the caller reports it.
 */
export async function canonicalPath(path: string): Promise<string | undefined> {
  try { return await realpath(resolve(path.trim())) } catch { return undefined }
}
