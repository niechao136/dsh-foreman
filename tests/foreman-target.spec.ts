import { expect, it } from 'vitest'
import { assignmentTargetOf, targetOf } from '../src/core/model.ts'
import type { Assignment, Ticket } from '../src/core/index.ts'

it('reads an assignment written before targets existed as local', () => {
  const legacy = { id: 'assignment:t:0', state: 'running', createdAt: '2026-01-01T00:00:00.000Z' } as Assignment
  expect(targetOf(legacy)).toEqual({ deviceId: 'local', kind: 'local', directory: '' })
})

it('reads a targeted assignment as itself', () => {
  const target = { deviceId: 'laptop', kind: 'remote' as const, directory: 'D:\\工作\\我的 项目' }
  expect(targetOf({ ...{ id: 'a', state: 'running', createdAt: 'x' }, target } as Assignment)).toEqual(target)
})

it('gives an assignment the target its ticket chose, and nothing when it chose none', () => {
  const target = { deviceId: 'laptop', kind: 'remote' as const, directory: 'D:\\工作\\我的 项目' }
  const chosen = { id: 'tk1', target } as unknown as Ticket
  const plain = { id: 'tk2' } as unknown as Ticket
  expect([assignmentTargetOf(chosen), assignmentTargetOf(plain)]).toEqual([{ target }, {}])
})

it('keeps a device path character for character, including a backslash and a space', () => {
  const target = { deviceId: 'laptop', kind: 'remote' as const, directory: 'D:\\工作\\我的 项目' }
  expect(targetOf({ id: 'a', state: 'running', createdAt: 'x', target } as Assignment).directory).toBe('D:\\工作\\我的 项目')
})
