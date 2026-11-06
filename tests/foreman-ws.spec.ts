import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { serve, type Served } from '../src/foreman/ws.ts'
import { FOREMAN_PROTOCOL_VERSION, type Frame } from '../src/foreman/protocol.ts'
import { Devices } from '../src/foreman/devices.ts'
import { Store } from '../src/app/store.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const open = () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'foreman-ws-')), 'o.sqlite'))
  return { store, devices: new Devices(store) }
}

const servers: Served[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close().catch(() => {})
})

/** A server on an ephemeral port, with one device registered. */
const listening = async () => {
  const { devices } = open()
  const { token } = devices.add({ id: 'laptop', name: 'L', roots: [{ project: 'shop', path: '/w/shop' }] })
  const frames: Frame[] = []
  const server = await serve({ port: 0, devices, onFrame: (_deviceId, frame) => { frames.push(frame) } })
  servers.push(server)
  return { server, devices, token, frames }
}

/**
 * Opens a socket, sends `send`, and resolves once `done` holds or the budget runs out.
 *
 * The predicate is polled as well as checked per message: a hello draws no reply from the hub, so waiting for a
 * message that never comes would time out on a healthy connection.
 */
const exchange = (port: number, send: string[], done: (texts: string[]) => boolean): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    const texts: string[] = []
    const finish = (error?: Error): void => { clearInterval(poll); clearTimeout(timer); socket.close(); error ? reject(error) : resolve(texts) }
    const poll = setInterval(() => { if (done(texts)) finish() }, 10)
    const timer = setTimeout(() => finish(new Error(`timed out with ${JSON.stringify(texts)}`)), 5000)
    socket.on('open', () => { for (const text of send) socket.send(text) })
    socket.on('message', data => { texts.push(data.toString()); if (done(texts)) finish() })
    socket.on('close', () => finish())
    socket.on('error', error => finish(error))
  })

describe('the device listener', () => {
  it('admits a hello with a good token and hands its frames to the hub', async () => {
    const { server, token, frames } = await listening()
    const hello = { v: FOREMAN_PROTOCOL_VERSION, type: 'hello', frameId: 'h1', deviceId: 'laptop', token, version: '0.1.0',
      roots: [{ project: 'shop', path: '/w/shop' }], running: [] }
    await exchange(server.port, [JSON.stringify(hello)], () => server.hub.online().includes('laptop'))
    expect(server.hub.online()).toEqual(['laptop'])
    expect(frames.map(frame => frame.type)).toEqual(['hello'])
    expect(server.hub.snapshot()[0]).toMatchObject({ id: 'laptop', running: 0 })
  })

  it('tells a peer that opens with something other than a hello why, then refuses a non-loopback host', async () => {
    const { server } = await listening()
    const texts = await exchange(server.port, [JSON.stringify({ v: FOREMAN_PROTOCOL_VERSION, type: 'heartbeat', frameId: 'x', deviceId: 'laptop', running: 0 })],
      list => list.length > 0)
    expect(JSON.parse(texts[0]!)).toMatchObject({ type: 'error', reason: expect.stringContaining('hello') })
    expect(server.hub.online()).toEqual([])
  })

  it('refuses to bind anything but loopback, because TLS belongs to the tunnel in front', async () => {
    const { devices } = open()
    await expect(serve({ port: 0, host: '0.0.0.0', devices, onFrame: () => {} })).rejects.toThrow(/loopback only/)
  })

  it('sends a frame the hub queued for a connected device', async () => {
    const { server, token } = await listening()
    const hello = { v: FOREMAN_PROTOCOL_VERSION, type: 'hello', frameId: 'h1', deviceId: 'laptop', token, version: '0.1.0', roots: [], running: [] }
    await exchange(server.port, [JSON.stringify(hello)], () => server.hub.online().includes('laptop'))
    expect(server.hub.online()).toEqual(['laptop'])
    // A heartbeat the hub sends reaches the device on the same socket it dialled in on.
    await expect(server.hub.send('laptop', { v: FOREMAN_PROTOCOL_VERSION, type: 'heartbeat', frameId: 'hb', deviceId: 'laptop', running: 0 }))
      .resolves.toBeUndefined()
  })
})
