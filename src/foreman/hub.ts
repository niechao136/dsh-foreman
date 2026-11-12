/**
 * The hub: which devices are connected, what each is running, and how a frame gets to one.
 *
 * It knows nothing about WebSockets. A `Channel` is any two-way text pipe — the real one wraps a socket in `ws.ts`,
 * and tests use two `Channel`s wired to each other. That keeps every rule here (handshake, dedupe, revocation,
 * version) testable without a port, and keeps `ws` confined to one file.
 *
 * Nothing in this file writes the ledger. Frames that carry facts about work are handed to `onFrame`, which the
 * runtime maps onto the Engine; a hub that changed tickets itself would be a second writer, which the design forbids.
 */
import { FrameDedupe, FrameError, FOREMAN_PROTOCOL_VERSION, encodeFrame, parseFrame, type Capability, type Frame, type Root } from './protocol.ts'
import type { DeviceRecord } from './devices.ts'
import type { Online } from './selector.ts'

/** A two-way text pipe to one device: what the hub needs from a socket, and nothing more. */
export interface Channel {
  send(text: string): void
  close(): void
  onMessage(listener: (text: string) => void): void
  onClose(listener: () => void): void
}

/**
 * One end of a `memoryChannel()` pair: everything sent on `a` arrives at `b` and the other way round, asynchronously.
 * Built as a plain object rather than a class instance so a test can spread it and still keep its methods.
 */
type Memory = Channel & { closed: boolean; peer: Memory; messages: ((text: string) => void)[]; closes: (() => void)[] }

function memory(): Memory {
  const channel: Memory = {
    closed: false,
    peer: undefined as unknown as Memory,
    messages: [],
    closes: [],
    send(text: string) {
      if (channel.closed || channel.peer.closed) return
      const target = channel.peer
      queueMicrotask(() => { for (const listener of target.messages) listener(text) })
    },
    close() {
      if (channel.closed) return
      channel.closed = true
      const target = channel.peer
      queueMicrotask(() => { for (const listener of target.closes) listener() })
    },
    onMessage(listener: (text: string) => void) { channel.messages.push(listener) },
    onClose(listener: () => void) { channel.closes.push(listener) },
  }
  return channel
}

/** A pair of connected channels: `a` is the hub's end and `b` the device's, or the other way round. */
export function memoryChannel(): { a: Channel; b: Channel } {  const a = memory(), b = memory()
  a.peer = b; b.peer = a
  return { a, b }
}

/** The device registry surface a hub needs: token checks, a revocation read, and the last-seen stamp. */
export interface HubDevices {
  verify(id: string, token: string): boolean
  get(id: string): DeviceRecord | undefined
  seen(id: string, at: string): void
  list(): DeviceRecord[]
  /** Records what a device declares, for the empty record a fresh registration leaves behind. */
  update(id: string, change: { roots?: { project: string; path: string }[] }): DeviceRecord
}

/** What the hub keeps for one connected device, all of it in memory: a restart re-aligns from each device's hello. */
interface Connection {
  channel: Channel
  /** The token this connection proved at handshake; re-checked on later frames so a rotation or revocation lands. */
  token?: string
  /** True once the device proved its token; before that it may only send `hello`. */
  handshook: boolean
  /** Assignment ids the device last said it runs; a `hello` carries them, a `heartbeat` only a count. */
  running: string[]
  /** A heartbeat's count, when it disagrees with `running`; kept so `running()` answers with the freshest fact. */
  runningCount?: number
  lastSeenAt: string
  /** What this device announced it can do beyond the baseline; empty for a device older than capabilities. */
  capabilities: Capability[]
  readonly dedupe: FrameDedupe
}

export interface HubInput {
  devices: HubDevices
  /** Called for every accepted frame after the handshake; the runtime maps reports and acks onto the Engine. */
  onFrame: (deviceId: string, frame: Frame) => void
  /** Logs what the hub refused, so an operator can see why a device was dropped. */
  log?: (text: string) => void
  /** The clock, injectable so a heartbeat timeout is testable without waiting. */
  now?: () => string
}

/**
 * Tracks device connections and enforces the handshake.
 *
 * A connection becomes a device only after a `hello` whose token verifies: until then it may send nothing else and
 * `online()` does not list it. Every liveness frame re-checks the token, so revoking a device takes effect on its
 * next heartbeat instead of waiting for a restart. A frame id already acted on does nothing twice, which is what
 * makes a re-sent frame safe after a flaky connection.
 */
export class Hub {
  private readonly connections = new Map<string, Connection>()
  /** Connections that have arrived but not yet verified: parked so they cannot disturb an established one. */
  private readonly pending = new Map<Channel, { deviceId: string; connection: Connection }>()
  private readonly devices: HubDevices
  private readonly onFrame: (deviceId: string, frame: Frame) => void
  private readonly log: (text: string) => void
  private readonly now: () => string

  constructor(input: HubInput) {
    this.devices = input.devices
    this.onFrame = input.onFrame
    this.log = input.log ?? (() => {})
    this.now = input.now ?? (() => new Date().toISOString())
  }

  /**
   * Register a connection under the device id the transport says it belongs to; it is a claim until `hello`.
   *
   * A new connection does NOT evict an established one here. Evicting on arrival let two clients using the same id
   * close each other in a loop — each reconnect killed the other's socket, neither ever finished its handshake, and
   * the device stayed offline forever while both kept retrying. Instead a fresh connection waits in `pending` until
   * its `hello` verifies, and only then replaces whoever held the id (`admit`). A half-finished connection therefore
   * cannot disturb a working one, while a genuine reconnect still takes over once it has proved itself.
   */
  attach(deviceId: string, channel: Channel): void {
    const connection: Connection = { channel, handshook: false, running: [], lastSeenAt: this.now(), capabilities: [], dedupe: new FrameDedupe(new Set()) }
    // The claim is parked until the token is verified; a second connection under the same id simply waits its turn.
    this.pending.set(channel, { deviceId, connection })
    channel.onMessage(text => this.receive(deviceId, connection, text))
    channel.onClose(() => {
      this.pending.delete(channel)
      // Only forget it when this is still the current connection: a reconnect already replaced it.
      if (this.connections.get(deviceId) === connection) this.connections.delete(deviceId)
    })
  }

  /** Promote a verified connection to be the one the id answers to, replacing whatever held it. */
  private admit(deviceId: string, connection: Connection): void {
    const previous = this.connections.get(deviceId)
    if (previous !== undefined && previous !== connection) previous.channel.close()
    this.connections.set(deviceId, connection)
    this.pending.delete(connection.channel)
  }

  /** Drop a device's connection and stop listing it as online. */
  detach(deviceId: string): void {
    const connection = this.connections.get(deviceId)
    if (connection === undefined) return
    this.connections.delete(deviceId)
    connection.channel.close()
  }

  /** The ids of the devices that completed the handshake, in connection order. */
  online(): string[] {
    return [...this.connections].filter(([, connection]) => connection.handshook).map(([id]) => id)
  }

  /** Every handshook device with its load and last sign of life — what the selector ranks. */
  snapshot(): Online[] {
    return [...this.connections].filter(([, connection]) => connection.handshook)
      .map(([id, connection]) => ({ id, running: this.running(id), lastSeenAt: connection.lastSeenAt }))
  }

  /** How many assignments a device reports running; zero for one that is not connected. */
  running(deviceId: string): number {
    const connection = this.connections.get(deviceId)
    return connection?.runningCount ?? connection?.running.length ?? 0
  }

  /**
   * What a connected device announced it can do; empty for a device that predates capabilities or is not connected.
   *
   * Callers use this to skip an optional feature rather than send a frame the device cannot answer — a device on an
   * older release keeps taking work, just without the newer detail.
   */
  capabilitiesOf(deviceId: string): Capability[] { return [...(this.connections.get(deviceId)?.capabilities ?? [])] }

  /**
   * Send a frame to a connected device.
   * @throws When the device is not connected: the caller reports the ticket blocked rather than pretending it went out.
   */
  send(deviceId: string, frame: Frame): Promise<void> {
    const connection = this.connections.get(deviceId)
    if (connection === undefined || !connection.handshook) return Promise.reject(new Error(`device ${deviceId} is not connected`))
    try {
      connection.channel.send(encodeFrame(frame))
      return Promise.resolve()
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** Close every device connection, used at shutdown so in-flight work fails fast instead of hanging. */
  closeAll(): void {
    for (const [, parked] of [...this.pending]) parked.connection.channel.close()
    this.pending.clear()
    for (const [id, connection] of [...this.connections]) {
      this.connections.delete(id)
      connection.channel.close()
    }
  }

  /** Parses one inbound frame and enforces the handshake, revocation, dedupe and version rules. */
  private receive(deviceId: string, connection: Connection, text: string): void {
    let frame: Frame
    try {
      frame = parseFrame(text)
    } catch (error) {
      // A frame we cannot parse is a peer we cannot trust to speak this protocol: say why, then close.
      this.refuse(connection, error instanceof FrameError ? error.message : String(error))
      return
    }
    if (!connection.dedupe.take(frame.frameId)) return
    if (!connection.handshook) {
      if (frame.type !== 'hello') { this.refuse(connection, 'the first frame must be hello'); return }
      this.handshake(deviceId, connection, frame)
      return
    }
    // Revocation and token rotation are re-checked on every liveness frame, so both land without a restart.
    if ((frame.type === 'heartbeat' || frame.type === 'report' || frame.type === 'accepted')
      && !this.devices.verify(deviceId, connection.token ?? '')) {
      this.refuse(connection, 'this device is revoked, or its token was rotated')
      return
    }
    connection.lastSeenAt = this.now()
    if (frame.type === 'heartbeat') connection.runningCount = countOf(frame.running)
    if (frame.type === 'hello') { connection.running = [...frame.running]; connection.runningCount = frame.running.length }
    this.devices.seen(deviceId, connection.lastSeenAt)
    this.onFrame(deviceId, frame)
  }

  /** Admit a connection, or refuse it with a readable reason. Every refusal is sent as an `error` frame first. */
  private handshake(deviceId: string, connection: Connection, frame: Extract<Frame, { type: 'hello' }>): void {
    if (frame.deviceId !== deviceId) {
      this.refuse(connection, `hello says ${frame.deviceId} but this connection is ${deviceId}`)
      return
    }
    // The parser already refused another version, so this is defence in depth rather than a live path.
    if (frame.v !== FOREMAN_PROTOCOL_VERSION) {
      this.refuse(connection, `unsupported protocol version ${frame.v}; this hub speaks ${FOREMAN_PROTOCOL_VERSION}`)
      return
    }
    if (!this.devices.verify(deviceId, frame.token)) {
      this.refuse(connection, 'invalid token, or this device is revoked')
      return
    }
    // The registry's roots are what the selector maps a project through, so a device that declares different ones
    // would be handed a path it never offered. Say so plainly instead of letting the job fail somewhere unexpected.
    const mismatch = rootsMismatch(this.devices.get(deviceId)?.roots ?? [], frame.roots)
    if (mismatch !== undefined) {
      this.refuse(connection, mismatch)
      return
    }
    connection.handshook = true
    connection.token = frame.token
    // What this device can do beyond the baseline. An older device announces nothing, and every optional behaviour is
    // then simply skipped rather than the connection being refused: a laptop that sat switched off must not come back
    // to a hub it can never talk to again.
    connection.capabilities = [...(frame.capabilities ?? [])]
    connection.running = [...frame.running]
    connection.runningCount = connection.running.length
    connection.lastSeenAt = this.now()
    // A record with no projects takes the ones this device declares. Without writing them back, the check above would
    // keep passing on an empty record forever, and the ledger would still believe the device can reach nothing — so
    // no ticket could ever be dispatched to it.
    if ((this.devices.get(deviceId)?.roots.length ?? 0) === 0 && frame.roots.length > 0) {
      this.devices.update(deviceId, { roots: frame.roots.map(root => ({ project: root.project, path: root.path })) })
    }
    // Verified: this connection now owns the id, and any earlier one is retired.
    this.admit(deviceId, connection)
    this.devices.seen(deviceId, connection.lastSeenAt)
    this.onFrame(deviceId, frame)
  }

  /** Tell a connection why it is being dropped if the channel still takes text, then close it and forget what it claimed. */
  private refuse(connection: Connection, reason: string): void {
    try {
      connection.channel.send(encodeFrame({ v: FOREMAN_PROTOCOL_VERSION, type: 'error', frameId: `error:${this.now()}`, reason }))
    } catch { /* A dead channel cannot be told why; closing it is what matters. */ }
    this.log(`foreman hub refused a device: ${reason}`)
    // A refused connection never owned the id, so it is only forgotten from the parked set.
    this.pending.delete(connection.channel)
    connection.channel.close()
    for (const [id, current] of this.connections) if (current === connection) this.connections.delete(id)
  }
}

/**
 * A heartbeat's running count, bounded.
 *
 * A device states how many assignments it holds. The value feeds the selector's least-busy ranking, so a bogus or
 * hostile one must not be able to make a machine look idle or infinitely busy: anything that is not a sane count is
 * treated as none, and a real fleet's largest plausible load caps it.
 */
const MAX_RUNNING = 1000
function countOf(reported: unknown): number {
  if (typeof reported !== 'number' || !Number.isFinite(reported)) return 0
  return Math.min(MAX_RUNNING, Math.max(0, Math.floor(reported)))
}

/**
 * Whether a device's declared roots disagree with its registry record, and why.
 *
 * Compared as exact strings, deliberately: the registry holds the path the operator typed, and normalising here would
 * hide a real difference (a renamed directory, a different drive letter) that would otherwise surface as a job
 * failing in the wrong place. A device may also declare no roots at all, which says nothing to contradict.
 */
function rootsMismatch(registered: readonly Root[], declared: readonly Root[]): string | undefined {
  if (declared.length === 0) return undefined
  // An empty record is not a contradiction to reject: a device registered without projects yet declares them in its
  // first hello, and that is how it becomes usable. It is still not silently accepted as an authority — `adoptRoots`
  // copies the declaration into the record, so the next handshake is checked against it and a later drift is caught.
  if (registered.length === 0) return undefined
  const known = new Map(registered.map(root => [root.project, root.path]))
  for (const root of declared) {
    const path = known.get(root.project)
    if (path === undefined) {
      return `this device declares project ${root.project}, which its registry record does not have; add it with scripts/add-device.mjs first`
    }
    if (path !== root.path) {
      return `this device declares ${root.project} at a different path than its registry record; correct one of them, because the hub assigns work by the registered path`
    }
  }
  return undefined
}
