/**
 * Choosing which device does a piece of work. A pure function: no clock, no network, no store — so the rule is
 * testable on its own and the accept step can call it inside the Engine's transaction without side effects.
 *
 * The decision is made once, at accept, and written onto the Ticket (see the design's 5.3): the Executor then only
 * carries it out. Nothing here retries, queues, or falls back to the host — a request with no reachable device
 * ends up `blocked`, handed to a person, rather than silently running somewhere else.
 */
import type { AssignmentTarget } from '../core/model.ts'
import type { DeviceRecord } from './devices.ts'

/** A device that is connected right now, with how much it is already doing. */
export interface Online {
  id: string
  running: number
  lastSeenAt?: string
}

/**
 * Whether a request's named machine is this device.
 *
 * The name comes from an assessment reading a person's sentence, so it is not a machine-readable id: one real accept
 * carried `"宿舍电脑 pc"` — the display name and the id typed together — and strict equality matched neither, so the
 * selector found no candidate and the ticket was blocked as if the machine were offline. The comparison therefore
 * normalizes what a person plausibly writes and tries the whole string first, then each piece: an id or a name, in
 * any case, with the spacing, punctuation and `()`/`（）` a sentence picks up on the way.
 *
 * It stays deliberately narrow: only id and name are matched, never a path or a prefix, so a name that merely
 * contains another device's id cannot capture work meant for that device.
 */
export function namesDevice(device: { id: string; name: string }, named: string): boolean {
  const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[()（）/·,，、|]+/g, ' ').trim()
  const wanted = normalize(named)
  if (wanted === '') return false
  const candidates = [normalize(device.id), normalize(device.name)].filter(item => item !== '')
  if (candidates.includes(wanted)) return true
  // The whole string matched nothing: accept any single token that is exactly the id or the name, which is what an
  // assessment writes when it repeats the person's words alongside the registry's answer.
  const tokens = wanted.split(/\s+/).filter(token => token !== '')
  if (tokens.length < 2) return false
  return candidates.some(candidate => tokens.includes(candidate))
}

/** What a ticket asks of a device: a named one (`outcome.device`), required capabilities, and the project to work on. */
export interface DeviceRequest {
  /** A device id or its display name, when the request itself named a place to do the work. */
  device?: string
  /** Capabilities the device must all carry, such as `intranet` for a project only the office network reaches. */
  labels?: string[]
  /** The project's logical name, matched against the `roots` each device declared. */
  project: string
}

/** Milliseconds since epoch for a last-seen stamp, with a never-seen device sorting before every seen one. */
const seenAt = (device: DeviceRecord): number => {
  const parsed = Date.parse(device.lastSeenAt ?? '')
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
}

/**
 * Picks the device a request should go to, or `undefined` when none can take it.
 *
 * The filters are conjunctive and in a deliberate order: revoked devices never work; a device that is not connected
 * right now cannot be chosen, even when it is the one named; a device without a root for the project cannot reach the
 * code; an explicitly named or label-constrained request narrows further. Of what is left, the least busy wins, and a
 * tie goes to the device that reported most recently — the freshest sign of life.
 */
export function selectDevice(request: DeviceRequest, devices: readonly DeviceRecord[], online: readonly Online[]): AssignmentTarget | undefined {
  const connected = new Map(online.map(device => [device.id, device]))
  const named = request.device
  const wanted = request.labels ?? []
  const candidates = devices.filter(device => device.revokedAt === undefined)
    .filter(device => connected.has(device.id))
    .filter(device => device.roots.some(root => root.project === request.project))
    .filter(device => named === undefined || namesDevice(device, named))
    .filter(device => wanted.every(label => device.labels.includes(label)))
  if (candidates.length === 0) return undefined
  const ranked = [...candidates].sort((left, right) => {
    const busy = (connected.get(left.id)!.running) - (connected.get(right.id)!.running)
    if (busy !== 0) return busy
    const freshness = seenAt(right) - seenAt(left)
    if (freshness !== 0) return freshness
    return left.id.localeCompare(right.id)
  })
  const chosen = ranked[0]!
  const root = chosen.roots.find(entry => entry.project === request.project)!
  // `kind: 'remote'` even for a device registered under this host's own name: it is reached over the hub, not by
  // calling the local executor, and pretending otherwise would skip the connection and its version checks.
  return { deviceId: chosen.id, kind: 'remote', directory: root.path }
}
