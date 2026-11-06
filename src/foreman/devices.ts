/**
 * The device registry: which machines may take work, and what each one can reach.
 *
 * A device is not a domain concept — no Ticket references one — but it is also not plugin configuration,
 * because a ticket's accept step reads it and adding a device must not restart the hub. So it lives in the
 * same SQLite database as everything else, in the `foreman` key family, and this class is its only writer.
 *
 * Only a SHA-256 of each token is stored: a leaked database does not hand anyone a way in, and rotating a
 * token means replacing one hash. Nothing here imports a third-party module — hashing is `node:crypto`.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Root } from './protocol.ts'
import type { Store } from '../app/store.ts'
import { KV } from '../kv.ts'

/** One machine allowed to take assignments. `revokedAt` keeps the record for the audit trail instead of deleting it. */
export interface DeviceRecord {
  id: string
  name: string
  /** Capabilities a request may require, such as `intranet` for a project only reachable from the office. */
  labels: string[]
  /** The projects this device can work on, as its own absolute paths; the hub maps a project name to one of these. */
  roots: Root[]
  /** SHA-256 of the device token, hex. The token itself is never stored. */
  tokenHash: string
  lastSeenAt?: string
  revokedAt?: string
}

/** What a caller supplies when registering a device; the id is its stable name, chosen once. */
export interface DeviceInput {
  id: string
  name: string
  labels?: string[]
  roots: Root[]
}

/** The SHA-256 of a token, hex — the only form of it the hub keeps, and what `verify` compares against. */
export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

/** A new token: 32 random bytes, hex, which no one can guess and the registry only ever sees as a hash. */
const newToken = (): string => randomBytes(32).toString('hex')

/**
 * Reads and writes the device registry.
 *
 * The store is any `get`/`set`/`keys` surface, so tests can stand one up on a temporary SQLite file and the
 * runtime passes its own. Every write goes through `KV.foreman.device(id)`, whose prefix is what `list` walks.
 */
export class Devices {
  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'keys' | 'delete'>) {}

  /** Every registered device, revoked ones included, in id order. */
  list(): DeviceRecord[] {
    return this.store.keys(KV.foreman.device.prefix)
      .map(key => this.store.get(key as never) as DeviceRecord | undefined)
      .filter((record): record is DeviceRecord => record !== undefined)
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  /** One device, or undefined when no such id is registered. */
  get(id: string): DeviceRecord | undefined {
    return this.store.get(KV.foreman.device(id))
  }

  /**
   * Register a device and mint its token; the token is returned once and never readable again.
   * @throws When the id is already taken — re-adding would silently rotate a live device's token.
   */
  add(input: DeviceInput): { device: DeviceRecord; token: string } {
    if (this.get(input.id) !== undefined) throw new Error(`a device with id ${input.id} is already registered; rotate its token instead`)
    const token = newToken()
    const device: DeviceRecord = { id: input.id, name: input.name, labels: [...input.labels ?? []], roots: input.roots.map(root => ({ ...root })),
      tokenHash: hashToken(token) }
    this.store.set(KV.foreman.device(device.id), device)
    return { device, token }
  }

  /**
   * Replace a device's token, which invalidates the old one at its next frame.
   * @throws When the device is unknown.
   */
  rotate(id: string): string {
    const device = this.require(id)
    const token = newToken()
    this.store.set(KV.foreman.device(id), { ...device, tokenHash: hashToken(token) })
    return token
  }

  /**
   * Revoke a device: it stays listed for the audit trail, but `verify` refuses it and the hub drops its connection.
   * Revoking twice is harmless.
   * @throws When the device is unknown.
   */
  revoke(id: string): void {
    const device = this.require(id)
    if (device.revokedAt !== undefined) return
    this.store.set(KV.foreman.device(id), { ...device, revokedAt: new Date().toISOString() })
  }

  /** Whether a token is this device's and the device is still allowed to connect; `false` for an unknown or revoked id. */
  verify(id: string, token: string): boolean {
    const device = this.get(id)
    if (device === undefined || device.revokedAt !== undefined) return false
    return device.tokenHash === hashToken(token)
  }

  /**
   * Record that a device just proved it is alive.
   * @throws When the device is unknown, which means it was deleted mid-session.
   */
  seen(id: string, at: string): void {
    this.store.set(KV.foreman.device(id), { ...this.require(id), lastSeenAt: at })
  }

  private require(id: string): DeviceRecord {
    const device = this.get(id)
    if (device === undefined) throw new Error(`no device with id ${id}`)
    return device
  }
}
