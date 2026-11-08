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
  onDisconnect({ mark, deviceId: 'laptop' })
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

it('does not file the same blocked report again on every timer tick', () => {
  const report = vi.fn()
  onTimeout({ since: 0, now: 600_001, limitMs: 600_000, report, ticketOf: () => ({ ticketId: 't1', open: true }), deviceId: 'laptop',
    running: ['a1'], reportedStateOf: () => 'blocked' })
  expect(report).not.toHaveBeenCalled()
})

it('still reports when the last state was anything other than blocked or failed', () => {
  const report = vi.fn()
  onTimeout({ since: 0, now: 600_001, limitMs: 600_000, report, ticketOf: () => ({ ticketId: 't1', open: true }), deviceId: 'laptop',
    running: ['a1'], reportedStateOf: () => 'progress' })
  expect(report).toHaveBeenCalledOnce()
})

it('treats a device that still runs an assignment as still attached', () => {
  expect(alignHello({ running: ['a1'], known: ['a1', 'a2'] })).toEqual({ attach: ['a1'], stop: ['a2'] })
})

it('treats a device that no longer runs an assignment as needing a decision', () => {
  // The plan's prose says known-minus-running goes to `stop`; its sample test said `stop: []`, which contradicts its
  // own other test. The prose wins (see the ledger's Task 8 ruling): the device has the truth about its processes.
  expect(alignHello({ running: [], known: ['a1'] })).toEqual({ attach: [], stop: ['a1'] })
})

it('stops nothing and attaches nothing when one side is empty', () => {
  expect(alignHello({ running: [], known: [] })).toEqual({ attach: [], stop: [] })
})

it('relays a device report to the main Session, the same way a local worker does', () => {
  // A device report used to stop at the ledger: the ticket showed `ready` while the Session that dispatched it was
  // never told, so it neither relayed the result to the person nor carried on. A local worker's report calls
  // `reportRelay`; a remote one had no equivalent.
  const relayed: string[] = []
  const apply = applyReport({ report: () => undefined, ticketOf: () => ({ ticketId: 'tk1', open: true }),
    relay: ticketId => { relayed.push(ticketId) }, log: () => {} })
  apply('a1', { v: 1, type: 'report', frameId: 'f1', assignmentId: 'a1', state: 'ready', summary: 'done' } as never)
  expect(relayed).toEqual(['tk1'])
})

it('does not relay a report it refuses', () => {
  // A late report for an ended ticket is dropped, so relaying it would wake the Session about work it must not resume.
  const relayed: string[] = []
  const apply = applyReport({ report: () => undefined, ticketOf: () => ({ ticketId: 'tk1', open: false }),
    relay: ticketId => { relayed.push(ticketId) }, log: () => {} })
  apply('a1', { v: 1, type: 'report', frameId: 'f2', assignmentId: 'a1', state: 'ready', summary: 'late' } as never)
  expect(relayed).toEqual([])
})

it('keeps working when the relay itself fails, because the report is already recorded', () => {
  const apply = applyReport({ report: () => undefined, ticketOf: () => ({ ticketId: 'tk1', open: true }),
    relay: () => { throw new Error('session gone') }, log: () => {} })
  expect(() => apply('a1', { v: 1, type: 'report', frameId: 'f3', assignmentId: 'a1', state: 'ready', summary: 'x' } as never)).not.toThrow()
})
