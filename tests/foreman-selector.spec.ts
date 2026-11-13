import { expect, it } from 'vitest'
import { selectDevice } from '../src/foreman/selector.ts'
import type { DeviceRecord } from '../src/foreman/devices.ts'

const laptop: DeviceRecord = { id: 'laptop', name: '笔记本', labels: ['intranet'], tokenHash: 'x', roots: [{ project: 'shop', path: '/w/shop' }] }
const dorm: DeviceRecord = { id: 'dorm', name: '宿舍', labels: [], tokenHash: 'y', roots: [{ project: 'shop', path: '/h/shop' }] }
const online = [{ id: 'laptop', running: 2 }, { id: 'dorm', running: 0 }]

it('picks the device with the fewest running assignments', () => {
  expect(selectDevice({ project: 'shop' }, [laptop, dorm], online)).toEqual({ deviceId: 'dorm', kind: 'remote', directory: '/h/shop' })
})

it('honours an explicit device name', () => {
  expect(selectDevice({ device: '笔记本', project: 'shop' }, [laptop, dorm], online)!.deviceId).toBe('laptop')
})

it('drops devices without a root for the project, and offline ones', () => {
  expect(selectDevice({ project: 'other' }, [laptop, dorm], online)).toBeUndefined()
  expect(selectDevice({ project: 'shop' }, [laptop], [])).toBeUndefined()
})

it('never picks a device that is offline even when it is the only one named', () => {
  expect(selectDevice({ device: 'laptop', project: 'shop' }, [laptop], [])).toBeUndefined()
})

it('filters by required label', () => {
  expect(selectDevice({ labels: ['intranet'], project: 'shop' }, [laptop, dorm], online)!.deviceId).toBe('laptop')
})

it('never picks a revoked device', () => {
  const revoked = { ...laptop, revokedAt: '2026-11-06T00:00:00.000Z' }
  expect(selectDevice({ project: 'shop' }, [revoked], online)).toBeUndefined()
})

it('honours an explicit device by id as well as by name', () => {
  expect(selectDevice({ device: 'laptop', project: 'shop' }, [laptop, dorm], online)!.deviceId).toBe('laptop')
})

it('breaks a tie on the device seen most recently, and treats never-seen as oldest', () => {
  const fresh = { ...dorm, lastSeenAt: '2026-11-06T12:00:00.000Z' }
  expect(selectDevice({ project: 'shop' }, [laptop, fresh], [{ id: 'laptop', running: 0 }, { id: 'dorm', running: 0 }])!.deviceId).toBe('dorm')
  expect(selectDevice({ project: 'shop' }, [laptop, dorm], [{ id: 'laptop', running: 0 }, { id: 'dorm', running: 0 }])!.deviceId).toBe('laptop')
})

it('names the project root path exactly as the device declared it', () => {
  const windows = { ...dorm, roots: [{ project: 'shop', path: 'D:\\工作\\我的 项目' }] }
  expect(selectDevice({ project: 'shop' }, [windows], [{ id: 'dorm', running: 0 }])!.directory).toBe('D:\\工作\\我的 项目')
})

it('requires every label a request asks for, not just one', () => {
  expect(selectDevice({ labels: ['intranet', 'gpu'], project: 'shop' }, [laptop, dorm], online)).toBeUndefined()
})

it('picks nothing when every device is busy elsewhere but none has the root', () => {
  const other = { ...laptop, roots: [{ project: 'other', path: '/w/other' }] }
  expect(selectDevice({ project: 'shop', device: 'laptop' }, [other], online)).toBeUndefined()
})

it('carries a device the accept named through to the selection, by id or by name', () => {
  const other = { ...dorm, name: 'Dorm', tokenHash: 'z', roots: [{ project: 'shop', path: '/h/shop' }] }
  // Least-busy would pick `dorm`; naming `laptop` overrides it.
  expect(selectDevice({ device: 'laptop', project: 'shop' }, [laptop, other], online)!.deviceId).toBe('laptop')
  expect(selectDevice({ device: 'Dorm', project: 'shop' }, [laptop, other], online)!.deviceId).toBe('dorm')
})

it('matches a device named the way a person or an assessment writes it, not only the exact registry string', () => {
  // The real accept carried the display name and the id typed together; strict equality matched neither and the
  // ticket was blocked as though the machine were offline.
  const pc: DeviceRecord = { id: 'pc', name: '宿舍电脑', labels: [], tokenHash: 'q', roots: [{ project: 'fold', path: 'F:\\\\github\\\\fold' }] }
  const live = [{ id: 'pc', running: 0 }]
  expect(selectDevice({ device: '宿舍电脑 pc', project: 'fold' }, [pc], live)!.deviceId).toBe('pc')
  expect(selectDevice({ device: 'pc 宿舍电脑', project: 'fold' }, [pc], live)!.deviceId).toBe('pc')
  expect(selectDevice({ device: '宿舍电脑（pc）', project: 'fold' }, [pc], live)!.deviceId).toBe('pc')
  expect(selectDevice({ device: '  宿舍电脑  ', project: 'fold' }, [pc], live)!.deviceId).toBe('pc')
  // Casing is the machine's, not the sentence's.
  expect(selectDevice({ device: 'PC', project: 'fold' }, [pc], live)!.deviceId).toBe('pc')
})

it('never matches one device by a name that merely contains another device\'s id', () => {
  const a: DeviceRecord = { id: 'pc', name: 'Dorm', labels: [], tokenHash: 'a', roots: [{ project: 'shop', path: '/a' }] }
  const b: DeviceRecord = { id: 'pc-2', name: 'Office', labels: [], tokenHash: 'b', roots: [{ project: 'shop', path: '/b' }] }
  const live = [{ id: 'pc', running: 5 }, { id: 'pc-2', running: 0 }]
  // `pc-2` contains `pc`, but naming `pc` must still mean device `pc` and nothing else — no prefix matching.
  expect(selectDevice({ device: 'pc', project: 'shop' }, [a, b], live)!.deviceId).toBe('pc')
  expect(selectDevice({ device: 'pc-2', project: 'shop' }, [a, b], live)!.deviceId).toBe('pc-2')
})
