import { expect, it } from 'vitest'
import type { DeviceRecord } from '../src/foreman/devices.ts'
import { deviceRoster, rosterLines } from '../src/foreman/roster.ts'

const pc: DeviceRecord = { id: 'pc', name: '宿舍电脑', labels: ['intranet'], tokenHash: 'a',
  roots: [{ project: 'dsh-context-fold', path: 'F:\\\\github\\\\dsh-context-fold' }, { project: 'dsh-foreman', path: 'F:\\\\dsh' }],
  lastSeenAt: '2026-11-13T02:56:20.310Z' }
const laptop: DeviceRecord = { id: 'laptop', name: '公司笔记本', labels: [], tokenHash: 'b',
  roots: [{ project: 'dsh-foreman', path: 'D:\\\\dsh-plugin\\\\foreman' }] }
const retired: DeviceRecord = { ...laptop, id: 'old', name: '旧机器', revokedAt: '2026-11-01T00:00:00.000Z' }

it('lists every registered device with its live state, project names and load', () => {
  const roster = deviceRoster([pc, laptop, retired], [{ id: 'pc', running: 2, lastSeenAt: '2026-11-13T03:00:00.000Z' }])
  expect(roster).toEqual([
    { id: 'pc', name: '宿舍电脑', labels: ['intranet'], projects: ['dsh-context-fold', 'dsh-foreman'], online: true, running: 2,
      lastSeenAt: '2026-11-13T03:00:00.000Z' },
    { id: 'laptop', name: '公司笔记本', labels: [], projects: ['dsh-foreman'], online: false, running: 0,
      lastSeenAt: undefined },
    // Revoked is stated, not hidden: an operator needs to tell "removed" from "offline".
    { id: 'old', name: '旧机器', labels: [], projects: ['dsh-foreman'], online: false, revoked: true, running: 0,
      lastSeenAt: undefined },
  ])
})

it('publishes no device path, only the project names a routing decision needs', () => {
  const roster = deviceRoster([pc], [{ id: 'pc', running: 0 }])
  const text = rosterLines(roster).join('\n')
  expect(text).toContain('dsh-context-fold')
  expect(text).not.toContain('F:\\\\github')
  expect(JSON.stringify(roster)).not.toContain('github\\\\dsh-context-fold')
})

it('writes one line per machine, id first so the exact token is copyable', () => {
  const lines = rosterLines(deviceRoster([pc, laptop, retired], [{ id: 'pc', running: 1 }]))
  expect(lines).toEqual([
    '- pc — "宿舍电脑" (online, 1 running); projects: dsh-context-fold, dsh-foreman, labels: intranet',
    '- laptop — "公司笔记本" (offline); projects: dsh-foreman',
    '- old — "旧机器" (revoked); projects: dsh-foreman',
  ])
})

it('says a device declares no project rather than leaving the field blank', () => {
  const empty: DeviceRecord = { id: 'bare', name: 'bare', labels: [], tokenHash: 'c', roots: [] }
  expect(rosterLines(deviceRoster([empty], [{ id: 'bare', running: 0 }]))).toEqual(['- bare — "bare" (online); projects: (none declared)'])
})
