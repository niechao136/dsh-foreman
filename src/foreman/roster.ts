/**
 * The device roster as the main Session and an assessment are allowed to see it.
 *
 * The router picks a machine from this list, so it has to be *in* the conversation: one real accept asked for the
 * "dorm computer", the registry held a device whose display name is exactly 宿舍电脑, and the assessment ignored the
 * request twice because nothing in its context listed any device at all. The operator then pasted the panel's device
 * page into the chat, and the next assessment dispatched correctly — which is the whole bug in one anecdote.
 *
 * Two rules keep this small and safe:
 *
 * - **No paths.** A device's roots name real directories on that machine, and the panel is reachable over a tunnel.
 *   Only the project *names* are published, which is all a routing decision needs — the hub resolves the name to the
 *   device's own path at dispatch time.
 * - **Only what can take work now.** An offline or revoked device is listed with its state rather than hidden, because
 *   "the machine you asked for is offline" is a different answer from "no such machine", and the operator needs to
 *   tell them apart.
 */
import type { DeviceRecord } from './devices.ts'
import type { Online } from './selector.ts'

/** One machine as a prompt may name it. */
export interface RosterEntry {
  id: string
  name: string
  /** Capabilities a device carries, such as `intranet`. */
  labels: string[]
  /** Project names it can reach; never their paths. */
  projects: string[]
  online: boolean
  revoked?: true
  /** How many assignments it is running right now, so a busy machine reads as busy. */
  running: number
  lastSeenAt?: string
}

/**
 * Build the roster: every registered device, in id order, with its live state.
 *
 * `online` is the hub's snapshot; a device missing from it is connected-but-silent or gone, and both read as offline
 * here — the accept step treats them the same way, so the two must not disagree.
 */
export function deviceRoster(devices: readonly DeviceRecord[], online: readonly Online[]): RosterEntry[] {
  const connected = new Map(online.map(device => [device.id, device]))
  return devices.map(device => {
    const session = connected.get(device.id)
    return {
      id: device.id,
      name: device.name,
      labels: [...device.labels],
      projects: device.roots.map(root => root.project),
      online: device.revokedAt === undefined && session !== undefined,
      ...device.revokedAt === undefined ? {} : { revoked: true as const },
      running: session?.running ?? 0,
      ...(session?.lastSeenAt ?? device.lastSeenAt) === undefined ? {} : { lastSeenAt: session?.lastSeenAt ?? device.lastSeenAt },
    }
  })
}

/**
 * The roster as it appears in a prompt or card body.
 *
 * One line per machine, id first so the model copies the exact token the selector matches on, then the display name
 * a person used, then the projects it can reach. `(offline)` is spelled out rather than left implicit: a named
 * machine that is offline leaves the ticket blocked, and the assessment should see that before it names it.
 */
export function rosterLines(roster: readonly RosterEntry[]): string[] {
  return roster.map(device => {
    const state = device.revoked ? 'revoked' : device.online ? (device.running > 0 ? `online, ${device.running} running` : 'online') : 'offline'
    const labels = device.labels.length ? `, labels: ${device.labels.join(', ')}` : ''
    const projects = device.projects.length ? device.projects.join(', ') : '(none declared)'
    return `- ${device.id} — "${device.name}" (${state}); projects: ${projects}${labels}`
  })
}
