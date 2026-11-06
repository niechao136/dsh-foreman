import { expect, it, vi } from 'vitest'
import { ForemanExecutor } from '../src/foreman/executor.ts'
import type { Assignment, Ticket } from '../src/core/index.ts'

const ticket = { id: 'tk1', title: 'Fix it', assignments: [], inputs: [], undelivered: [] } as unknown as Ticket
const remote = { id: 'a1', state: 'pending', createdAt: 'x',
  target: { deviceId: 'laptop', kind: 'remote', directory: '/w/shop' } } as Assignment
const localAssignment = { id: 'a2', state: 'pending', createdAt: 'x' } as Assignment

const setup = (overrides: { send?: (deviceId: string, frame: never) => Promise<void> } = {}) => {
  const sent: { deviceId: string; frame: unknown }[] = []
  const report = vi.fn()
  const started = vi.fn()
  const local_ = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  const executor = new ForemanExecutor({ local: local_ as never, engine: () => ({ report, assignmentStarted: started }) as never,
    transport: { send: overrides.send ?? (async (deviceId, frame) => { sent.push({ deviceId, frame }) }) } })
  return { executor, sent, report, started, local: local_ }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 10))

it('hands a local assignment to DshExecutor unchanged', async () => {
  const { executor, local, sent } = setup()
  executor.start(ticket, localAssignment)
  await settle()
  expect(local.start).toHaveBeenCalledWith(ticket, localAssignment)
  expect(sent).toEqual([])
})

it('sends a remote assignment as one assign frame carrying the device-side directory', async () => {
  const { executor, local, sent } = setup()
  executor.start(ticket, remote)
  await settle()
  expect(local.start).not.toHaveBeenCalled()
  expect(sent[0]).toMatchObject({ deviceId: 'laptop', frame: { type: 'assign', assignmentId: 'a1', ticketId: 'tk1', directory: '/w/shop' } })
})

it('never marks a remote assignment started on its own: only the device accepting it does', async () => {
  const { executor, started, sent } = setup()
  executor.start(ticket, remote)
  await settle()
  expect(sent.length).toBe(1)
  expect(started).not.toHaveBeenCalled()
})

it('reports blocked, never failed and never local, when the device is gone', async () => {
  const { executor, report, local } = setup({ send: async () => { throw new Error('device offline') } })
  executor.start(ticket, remote)
  await settle()
  expect(report.mock.calls[0]![1]).toMatchObject({ state: 'blocked' })
  expect(local.start).not.toHaveBeenCalled()
})

it('delivers inputs to a remote assignment as an input frame and stays quiet when the device is gone', async () => {
  const { executor, sent } = setup()
  executor.deliver(ticket, remote)
  await settle()
  expect(sent[0]).toMatchObject({ deviceId: 'laptop', frame: { type: 'input', assignmentId: 'a1' } })
  const failing = setup({ send: async () => { throw new Error('offline') } })
  expect(() => failing.executor.deliver(ticket, remote)).not.toThrow()
  await settle()
})

it('stops a remote assignment with a stop frame rather than waiting for an answer', async () => {
  const { executor, sent } = setup()
  executor.stop(ticket, remote, 'a person stopped it')
  await settle()
  expect(sent[0]).toMatchObject({ deviceId: 'laptop', frame: { type: 'stop', assignmentId: 'a1', reason: 'a person stopped it' } })
})

it('never sends the same assignment twice when start is called again', async () => {
  const { executor, sent } = setup()
  executor.start(ticket, remote)
  executor.start(ticket, remote)
  await settle()
  expect(sent.length).toBe(1)
})

it('keeps a non-ASCII device path in the frame byte for byte', async () => {
  const windows = { ...remote, target: { deviceId: 'laptop', kind: 'remote' as const, directory: 'D:\\工作\\我的 项目' } } as Assignment
  const { executor, sent } = setup()
  executor.start(ticket, windows)
  await settle()
  expect((sent[0]!.frame as { directory: string }).directory).toBe('D:\\工作\\我的 项目')
})
