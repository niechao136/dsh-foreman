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
    firstFrame(socket).then(deviceId => {
      if (deviceId === undefined) { socket.close(); return }
      hub.attach(deviceId, channel)
    }).catch(() => socket.close())
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
 * The device id the first frame claims, or undefined when the peer does not open with a hello.
 * Reading it here rather than in the hub keeps `Hub` free of `ws` types without weakening the handshake: the hub
 * still verifies the token before the connection counts as online.
 */
function firstFrame(socket: WsSocket): Promise<string | undefined> {
  return new Promise(resolve => {
    const settle = (value: string | undefined): void => { clearTimeout(timer); socket.off('close', closed); resolve(value) }
    const timer = setTimeout(() => settle(undefined), 10_000)
    const closed = (): void => settle(undefined)
    socket.once('message', data => settle(deviceIdOf(typeof data === 'string' ? data : data.toString())))
    socket.once('close', closed)
  })
}

/** The device id a frame claims, if the text parses as a hello; anything else is left to the hub to refuse. */
function deviceIdOf(text: string): string | undefined {
  try {
    const value = JSON.parse(text) as { type?: unknown; deviceId?: unknown }
    return value.type === 'hello' && typeof value.deviceId === 'string' && value.deviceId !== '' ? value.deviceId : undefined
  } catch { return undefined }
}
