/**
 * The one file that imports `ws`.
 *
 * Everything else talks through `Channel`, so the connection rules stay testable in memory and the transport can be
 * replaced (a unix socket, a tunnel client) without touching the hub. This server listens on loopback only: the
 * outside world reaches it through a tunnel that terminates TLS, because DSH's own web server refuses a non-loopback
 * host and the device endpoint must not grow onto the management panel.
 */
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { Hub, type Channel, type HubInput } from './hub.ts'
import { FOREMAN_PROTOCOL_VERSION } from './protocol.ts'

/**
 * A socket as the hub's `Channel`.
 *
 * The hub needs a device id when it attaches, and that id only arrives in the first frame, so text is buffered until
 * someone listens and replayed then, in order and exactly once. A socket that never sends a `hello` is never attached.
 */
class SocketChannel implements Channel {
  private readonly messages: ((text: string) => void)[] = []
  private readonly closes: (() => void)[] = []
  private readonly pending: string[] = []

  constructor(private readonly socket: WsSocket) {
    socket.on('message', data => {
      const text = typeof data === 'string' ? data : data.toString()
      if (this.messages.length === 0) { this.pending.push(text); return }
      for (const listener of this.messages) listener(text)
    })
    socket.on('close', () => { for (const listener of this.closes) listener() })
  }

  send(text: string): void { if (this.socket.readyState === this.socket.OPEN) this.socket.send(text) }
  close(): void { this.socket.close() }

  onMessage(listener: (text: string) => void): void {
    this.messages.push(listener)
    for (const text of this.pending.splice(0)) listener(text)
  }

  onClose(listener: () => void): void { this.closes.push(listener) }
}

export interface ServeInput extends Omit<HubInput, 'onFrame'> {
  port: number
  /** The host to listen on; loopback only, because TLS is terminated in a tunnel in front. */
  host?: string
  onFrame: HubInput['onFrame']
}

export interface Served {
  hub: Hub
  /** The port actually bound, useful when `port` is 0 in a test. */
  port: number
  close(): Promise<void>
}

/**
 * Listen for device connections and hand each to a `Hub`.
 *
 * A socket is attached under the device id its first frame claims — the id is a claim the hub then verifies — so the
 * handshake always runs against the real registry record rather than a provisional one.
 */
export async function serve(input: ServeInput): Promise<Served> {
  const host = input.host ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new Error(`the foreman hub listens on loopback only, not ${host}; terminate TLS in a tunnel in front of it`)
  }
  const hub = new Hub({ devices: input.devices, onFrame: input.onFrame, ...(input.log ? { log: input.log } : {}),
    ...(input.now ? { now: input.now } : {}) })
  const server = new WebSocketServer({ host, port: input.port })
  server.on('connection', socket => {
    const channel = new SocketChannel(socket)
    firstFrame(socket).then(first => {
      // A peer that does not open with a hello is told why before the socket closes. Closing silently would leave
      // the device reconnecting in a loop with nothing in its log, which is the hardest failure to diagnose.
      if (first.deviceId === undefined) { refuse(socket, first.reason); return }
      hub.attach(first.deviceId, channel)
    }).catch(error => refuse(socket, `the connection could not be read: ${String(error)}`))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  const port = (server.address() as AddressInfo).port
  return { hub, port, close: async () => {
    hub.closeAll()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  } }
}

/**
 * The device id the first frame claims, and why it is missing when it is.
 *
 * Reading it here rather than in the hub keeps `Hub` free of `ws` types without weakening the handshake: the hub
 * still verifies the token before the connection counts as online. A first frame that is not a `hello` is a peer
 * speaking something other than this protocol, which the hub would refuse anyway; the reason is carried out so the
 * socket can be told before it closes.
 */
function firstFrame(socket: WsSocket): Promise<{ deviceId?: string; reason: string }> {
  return new Promise(resolve => {
    const settle = (value: { deviceId?: string; reason: string }): void => { clearTimeout(timer); socket.off('close', closed); resolve(value) }
    const timer = setTimeout(() => settle({ reason: 'the connection did not open with a hello within 10 seconds' }), 10_000)
    const closed = (): void => settle({ reason: 'the connection closed before it said hello' })
    socket.once('message', data => {
      const text = typeof data === 'string' ? data : data.toString()
      const deviceId = deviceIdOf(text)
      settle(deviceId === undefined ? { reason: 'the first frame must be a hello naming a device' } : { deviceId, reason: '' })
    })
    socket.once('close', closed)
  })
}

/** Tell a socket why this hub is dropping it, then close it. A dead socket simply closes. */
function refuse(socket: WsSocket, reason: string): void {
  try {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ v: FOREMAN_PROTOCOL_VERSION, type: 'error', frameId: `error:${Date.now()}`, reason }))
    }
  } catch { /* Nothing to tell; the close is what matters. */ }
  socket.close()
}

/** The device id a frame claims, if the text parses as a hello; anything else is left to the hub to refuse. */
function deviceIdOf(text: string): string | undefined {
  try {
    const value = JSON.parse(text) as { type?: unknown; deviceId?: unknown }
    return value.type === 'hello' && typeof value.deviceId === 'string' && value.deviceId !== '' ? value.deviceId : undefined
  } catch { return undefined }
}
