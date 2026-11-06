import { expect, it } from 'vitest'
import { devicesView } from '../src/app/views/devices.ts'

it('marks which devices are online and which are revoked', () => {
  const view = devicesView({ online: ['laptop'],
    devices: [{ id: 'laptop', name: '笔记本', labels: [], roots: [], tokenHash: 'h' },
      { id: 'dorm', name: '宿舍', labels: [], roots: [], tokenHash: 'h', revokedAt: '2026-11-06T00:00:00.000Z' }] })
  expect(view.rows.map(row => [row.id, row.online, row.revoked])).toEqual([['laptop', true, false], ['dorm', false, true]])
})

it('reports how many assignments each device runs, and its last sign of life', () => {
  const view = devicesView({ devices: [{ id: 'laptop', name: 'L', labels: [], roots: [], tokenHash: 'h' }],
    online: [{ id: 'laptop', running: 3, lastSeenAt: '2026-11-06T12:00:00.000Z' }] })
  expect(view.rows[0]).toMatchObject({ running: 3, lastSeenAt: '2026-11-06T12:00:00.000Z' })
})

it('lists the projects a device can reach, by their logical names only', () => {
  const view = devicesView({ online: [], devices: [{ id: 'laptop', name: 'L', labels: ['intranet'], tokenHash: 'h',
    roots: [{ project: 'shop', path: 'D:\\工作\\shop' }, { project: 'docs', path: '/w/docs' }] }] })
  expect(view.rows[0]!.projects).toEqual(['shop', 'docs'])
  // The device's own path must not reach the panel: it is the one thing the hub never publishes.
  expect(JSON.stringify(view)).not.toContain('D:\\工作\\shop')
})

it('counts how many devices are online and how many are revoked', () => {
  const view = devicesView({ online: ['laptop'], devices: [
    { id: 'laptop', name: 'L', labels: [], roots: [], tokenHash: 'h' },
    { id: 'dorm', name: 'D', labels: [], roots: [], tokenHash: 'h', revokedAt: 'x' }] })
  expect(view.totals).toEqual({ devices: 2, online: 1, revoked: 1, running: 0 })
})

it('says so when no device is registered, without failing', () => {
  expect(devicesView({ devices: [], online: [] }).rows).toEqual([])
})
