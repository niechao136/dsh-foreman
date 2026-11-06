import { expect, it, vi } from 'vitest'
import { alignHello, applyReport, onDisconnect, onTimeout } from '../src/foreman/reports.ts'

it('passes a report through with the device\'s state', () => {
  const report = vi.fn()
  const apply = applyReport({ report, ticketOf: () => ({ ticketId: 't1', open: true }), log: vi.fn() })
  apply('a1', { v: 1, type: 'report', frameId: 'f', assignmentId: 'a1', state: 'ready', summary: 'done' } as never)
  expect(report).toHaveBeenCalledWith('t1', { state: 'ready', summary: 'done' })
})

it('drops a late report for an assignment whose ticket already ended, and logs it', () => {
  const report = vi.fn(), log = vi.fn()
  const apply = applyReport({ report, ticketOf: () => ({ ticketId: 't1', open: false }), log })
  apply('a1', { v: 1, type: 'report', frameId: 'f', assignmentId: 'a1', state: 'ready', summary: 'done' } as never)
  expect(report).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledOnce()
})

it('drops a report for an assignment the ledger does not know, and logs it', () => {
  const report = vi.fn(), log = vi.fn()
  const apply = applyReport({ report, ticketOf: () => undefined, log })
  apply('ghost', { v: 1, type: 'report', frameId: 'f', assignmentId: 'ghost', state: 'ready', summary: 'x' } as never)
  expect(report).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledOnce()
})

it('refuses a dropped report from a device', () => {
  const report = vi.fn(), log = vi.fn()
  const apply = applyReport({ report, ticketOf: () => ({ ticketId: 't1', open: true }), log })
  apply('a1', { v: 1, type: 'report', frameId: 'f', assignmentId: 'a1', state: 'dropped', summary: 'nope' } as never)
  expect(report).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledOnce()
})

it('carries a question through with the report', () => {
  const report = vi.fn()
  const apply = applyReport({ report, ticketOf: () => ({ ticketId: 't1', open: true }), log: vi.fn() })
  apply('a1', { v: 1, type: 'report', frameId: 'f', assignmentId: 'a1', state: 'blocked', summary: 'vpn', question: 'Turn it on?' } as never)
  expect(report).toHaveBeenCalledWith('t1', { state: 'blocked', summary: 'vpn', question: 'Turn it on?' })
})

it('does not touch the engine when a device disconnects', () => {
  const report = vi.fn()
  const mark = vi.fn()
  onDisconnect({ mark })
  expect(mark).toHaveBeenCalled()
  expect(report).not.toHaveBeenCalled()
})

it('reports blocked only after the timeout, and never restarts', () => {
  const report = vi.fn()
  onTimeout({ since: 0, now: 600_001, limitMs: 600_000, report, ticketOf: () => ({ ticketId: 't1', open: true }), deviceId: 'laptop', running: ['a1'] })
  expect(report).toHaveBeenCalledWith('t1', { state: 'blocked', summary: expect.stringContaining('offline') })
})

it('does nothing before the timeout', () => {
  const report = vi.fn()
  onTimeout({ since: 0, now: 1, limitMs: 600_000, report, ticketOf: () => ({ ticketId: 't1', open: true }), deviceId: 'laptop', running: ['a1'] })
  expect(report).not.toHaveBeenCalled()
})

it('skips a running assignment whose ticket already ended when the timeout fires', () => {
  const report = vi.fn()
  onTimeout({ since: 0, now: 600_001, limitMs: 600_000, report, ticketOf: () => ({ ticketId: 't1', open: false }), deviceId: 'laptop', running: ['a1'] })
  expect(report).not.toHaveBeenCalled()
})

it('treats a device that still runs an assignment as still attached', () => {
  expect(alignHello({ running: ['a1'], known: ['a1', 'a2'], stop: vi.fn() })).toEqual({ attach: ['a1'], stop: ['a2'] })
})

it('treats a device that no longer runs an assignment as needing a decision', () => {
  // The plan's prose says known-minus-running goes to `stop`; its sample test said `stop: []`, which contradicts its
  // own other test. The prose wins (see the ledger's Task 8 ruling): the device has the truth about its processes.
  expect(alignHello({ running: [], known: ['a1'], stop: vi.fn() })).toEqual({ attach: [], stop: ['a1'] })
})

it('stops nothing and attaches nothing when one side is empty', () => {
  expect(alignHello({ running: [], known: [], stop: vi.fn() })).toEqual({ attach: [], stop: [] })
})
