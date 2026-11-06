import { expect, it, vi } from 'vitest'
import { Hub, memoryChannel } from '../src/foreman/hub.ts'
import type { Frame } from '../src/foreman/protocol.ts'

const devices = (verify: (id: string, token: string) => boolean) => ({ verify, get: () => ({ id: 'laptop', name: 'L', labels: [], roots: [], tokenHash: 'h' }),
  seen: vi.fn(), list: () => [] }) as never

const hello = (deviceId = 'laptop', token = 'tok', extra: Record<string, unknown> = {}) =>
  ({ v: 1, type: 'hello', frameId: 'h1', deviceId, token, version: '0.1.0', roots: [], running: [], ...extra })
const settle = () => new Promise(resolve => setTimeout(resolve, 5))

it('accepts a hello with a good token and remembers what the device says it runs', async () => {
  const onFrame = vi.fn()
  const hub = new Hub({ devices: devices(() => true), onFrame })
  const { a, b } = memoryChannel()
  hub.attach('laptop', a)
  b.send(JSON.stringify(hello('laptop', 'tok', { running: ['a1'] })))
  await vi.waitFor(() => expect(onFrame).toHaveBeenCalled())
  expect([hub.online(), hub.running('laptop')]).toEqual([['laptop'], 1])
})

it('closes the channel when the token is wrong', async () => {
  const close = vi.fn()
  const hub = new Hub({ devices: devices(() => false), onFrame: vi.fn() })
  const { a, b } = memoryChannel()
  const channel = { ...a, close }
  hub.attach('laptop', channel)
  b.send(JSON.stringify(hello()))
  await vi.waitFor(() => expect(close).toHaveBeenCalled())
  expect(hub.online()).toEqual([])
})

it('drops a device whose token was revoked after it connected', async () => {
  let ok = true
  const close = vi.fn()
  const hub = new Hub({ devices: devices(() => ok), onFrame: vi.fn() })
  const { a, b } = memoryChannel()
  hub.attach('laptop', { ...a, close })
  b.send(JSON.stringify(hello()))
  await vi.waitFor(() => expect(hub.online()).toEqual(['laptop']))
  ok = false
  b.send(JSON.stringify({ v: 1, type: 'heartbeat', frameId: 'hb1', deviceId: 'laptop', running: 0 }))
  await vi.waitFor(() => expect(close).toHaveBeenCalled())
})

it('replies with the protocol version when the device speaks another one', async () => {
  const sent: string[] = []
  const hub = new Hub({ devices: devices(() => true), onFrame: vi.fn() })
  const { a, b } = memoryChannel()
  hub.attach('laptop', { ...a, send: text => { sent.push(text) } })
  b.send(JSON.stringify({ ...hello(), v: 9 }))
  await vi.waitFor(() => expect(sent.length).toBe(1))
  expect(JSON.parse(sent[0]!)).toMatchObject({ type: 'error', reason: expect.stringContaining('protocol version 9') })
})

it('replies with an error and closes on malformed JSON instead of throwing', async () => {
  const sent: string[] = []
  const close = vi.fn()
  const hub = new Hub({ devices: devices(() => true), onFrame: vi.fn() })
  const { a, b } = memoryChannel()
  hub.attach('laptop', { ...a, send: text => { sent.push(text) }, close })
  expect(() => b.send('{nope')).not.toThrow()
  await vi.waitFor(() => expect(close).toHaveBeenCalled())
  expect(JSON.parse(sent[0]!)).toMatchObject({ type: 'error', reason: expect.stringContaining('malformed') })
})

it('sends a frame to a connected device and refuses one that is not', async () => {
  const hub = new Hub({ devices: devices(() => true), onFrame: vi.fn() })
  const { a, b } = memoryChannel()
  const received: string[] = []
  b.onMessage(text => { received.push(text) })
  hub.attach('laptop', a)
  b.send(JSON.stringify(hello()))
  await vi.waitFor(() => expect(hub.online()).toEqual(['laptop']))
  received.length = 0
  await hub.send('laptop', { v: 1, type: 'heartbeat', frameId: 'x1', deviceId: 'laptop', running: 0 } as Frame)
  expect(JSON.parse(received[0]!)).toMatchObject({ frameId: 'x1' })
  await expect(hub.send('dorm', { v: 1, type: 'heartbeat', frameId: 'x2', deviceId: 'dorm', running: 0 } as Frame))
    .rejects.toThrow(/not connected/)
})

it('refuses to send to a connection that has not proven its token yet', async () => {
  const hub = new Hub({ devices: devices(() => true), onFrame: vi.fn() })
  const { a } = memoryChannel()
  hub.attach('laptop', a)
  await expect(hub.send('laptop', { v: 1, type: 'heartbeat', frameId: 'x1', deviceId: 'laptop', running: 0 } as Frame))
    .rejects.toThrow(/not connected/)
})

it('forgets a device when its channel closes', async () => {
  const hub = new Hub({ devices: devices(() => true), onFrame: vi.fn() })
  const { a, b } = memoryChannel()
  hub.attach('laptop', a)
  b.send(JSON.stringify(hello()))
  await vi.waitFor(() => expect(hub.online()).toEqual(['laptop']))
  b.close()
  await settle()
  expect(hub.online()).toEqual([])
})

it('ignores a second frame with the same frameId', async () => {
  const onFrame = vi.fn()
  const hub = new Hub({ devices: devices(() => true), onFrame })
  const { a, b } = memoryChannel()
  hub.attach('laptop', a)
  b.send(JSON.stringify(hello()))
  await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1))
  b.send(JSON.stringify(hello()))
  await settle()
  expect(onFrame).toHaveBeenCalledTimes(1)
})

it('reports each device running count from its latest heartbeat', async () => {
  const hub = new Hub({ devices: devices(() => true), onFrame: vi.fn() })
  const { a, b } = memoryChannel()
  hub.attach('laptop', a)
  b.send(JSON.stringify(hello('laptop', 'tok', { running: ['a1', 'a2'] })))
  await vi.waitFor(() => expect(hub.running('laptop')).toBe(2))
  b.send(JSON.stringify({ v: 1, type: 'heartbeat', frameId: 'hb2', deviceId: 'laptop', running: 1 }))
  await vi.waitFor(() => expect(hub.running('laptop')).toBe(1))
  expect(hub.snapshot()).toEqual([{ id: 'laptop', running: 1, lastSeenAt: expect.any(String) }])
})

it('lists no device as online before it said hello', async () => {
  const hub = new Hub({ devices: devices(() => true), onFrame: vi.fn() })
  const { a } = memoryChannel()
  hub.attach('laptop', a)
  expect(hub.online()).toEqual([])
})
