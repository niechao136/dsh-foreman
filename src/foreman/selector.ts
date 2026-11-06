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
    .filter(device => named === undefined || device.id === named || device.name === named)
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
