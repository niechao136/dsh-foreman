/**
 * The devices view: what the panel shows about the machines that may take work.
 *
 * A pure function, so the shape the client renders is testable without an HTTP server or a DOM. It deliberately
 * publishes **no device path**: the hub learned those paths to route work, and putting them on a page shared over a
 * tunnel would hand anyone who can open the panel a map of every laptop's disk. Project names are enough to tell
 * which device can take which job.
 */
import type { DeviceRecord } from '../../foreman/devices.ts'
import type { Online } from '../../foreman/selector.ts'

/** One row of the device list. */
export interface DeviceRow {
  id: string
  name: string
  labels: string[]
  /** Project names this device declared; never its paths. */
  projects: string[]
  online: boolean
  revoked: boolean
  running: number
  lastSeenAt?: string
}

export interface DevicesView {
  rows: DeviceRow[]
  totals: { devices: number; online: number; revoked: number; running: number }
}

/**
 * Builds the device list.
 *
 * `devices` is what the registry holds — revoked ones included, because an operator needs to see what was removed
 * and when. `online` accepts either the hub's bare ids or its richer snapshot; a bare id means "connected, load
 * unknown", which is what a hub that has not yet heard a heartbeat can honestly say.
 */
export function devicesView(input: { devices: readonly DeviceRecord[]; online: readonly (string | Online)[] }): DevicesView {
  const connected = new Map<string, Online>()
  for (const entry of input.online) {
    if (typeof entry === 'string') connected.set(entry, { id: entry, running: 0 })
    else connected.set(entry.id, entry)
  }
  const rows = input.devices.map(device => {
    const session = connected.get(device.id)
    return {
      id: device.id,
      name: device.name,
      labels: [...device.labels],
      projects: device.roots.map(root => root.project),
      online: session !== undefined && device.revokedAt === undefined,
      revoked: device.revokedAt !== undefined,
      running: session?.running ?? 0,
      ...(session?.lastSeenAt ?? device.lastSeenAt) === undefined
        ? {} : { lastSeenAt: session?.lastSeenAt ?? device.lastSeenAt },
    }
  })
  return {
    rows,
    totals: { devices: rows.length, online: rows.filter(row => row.online).length,
      revoked: rows.filter(row => row.revoked).length, running: rows.reduce((sum, row) => sum + row.running, 0) },
  }
}
