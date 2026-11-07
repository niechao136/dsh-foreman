import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Devices, hashToken } from '../src/foreman/devices.ts'
import { KV } from '../src/kv.ts'
import { Store } from '../src/app/store.ts'

const open = () => new Devices(new Store(join(mkdtempSync(join(tmpdir(), 'foreman-')), 'o.sqlite')))

it('keeps only a hash of the token and verifies it', () => {
  const devices = open()
  const { device, token } = devices.add({ id: 'laptop', name: '公司笔记本', roots: [{ project: 'shop', path: 'D:\\工作\\我的 项目' }] })
  expect(device.tokenHash).not.toBe(token)
  expect(device.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  expect(device.tokenHash).toBe(hashToken(token))
  expect([devices.verify('laptop', token), devices.verify('laptop', 'nope')]).toEqual([true, false])
})

it('refuses a revoked device and lists what is left', () => {
  const devices = open()
  const { token } = devices.add({ id: 'laptop', name: 'L', roots: [] })
  devices.add({ id: 'dorm', name: 'D', roots: [] })
  devices.revoke('laptop')
  expect(devices.verify('laptop', token)).toBe(false)
  expect(devices.list().map(d => d.id).sort()).toEqual(['dorm', 'laptop'])
  expect(devices.get('laptop')!.revokedAt).toBeTruthy()
})

it('keeps the roots a device declared, character for character', () => {
  const devices = open()
  devices.add({ id: 'laptop', name: 'L', roots: [{ project: 'shop', path: '/Users/me/工作 dir' }] })
  expect(devices.get('laptop')!.roots[0]!.path).toBe('/Users/me/工作 dir')
})

it('rotates a token so the old one stops working and the new one starts', () => {
  const devices = open()
  const { token } = devices.add({ id: 'laptop', name: 'L', roots: [] })
  const next = devices.rotate('laptop')
  expect(next).not.toBe(token)
  expect(devices.verify('laptop', token)).toBe(false)
  expect(devices.verify('laptop', next)).toBe(true)
})

it('verifies nothing for a device it does not know', () => {
  expect(open().verify('ghost', 'anything')).toBe(false)
})

it('records when a device was last seen, and refuses an unknown one', () => {
  const devices = open()
  devices.add({ id: 'laptop', name: 'L', roots: [] })
  devices.seen('laptop', '2026-11-06T12:00:00.000Z')
  expect(devices.get('laptop')!.lastSeenAt).toBe('2026-11-06T12:00:00.000Z')
  expect(() => devices.seen('ghost', '2026-11-06T12:00:00.000Z')).toThrow(/ghost/)
})

it('refuses a second device under an id already taken', () => {
  const devices = open()
  devices.add({ id: 'laptop', name: 'L', roots: [] })
  expect(() => devices.add({ id: 'laptop', name: 'L again', roots: [] })).toThrow(/laptop/)
})

it('keeps each device under the foreman family, one record per id', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'foreman-')), 'o.sqlite'))
  new Devices(store).add({ id: 'laptop', name: 'L', labels: ['intranet'], roots: [] })
  expect(store.keys(KV.foreman.device.prefix)).toEqual([KV.foreman.device('laptop')])
  expect(store.get(KV.foreman.device('laptop'))!.labels).toEqual(['intranet'])
})

it('deletes a device outright, so a wrong registration does not stay forever', () => {
  // Revoking keeps the record for the audit trail. Deleting is for the mistake — a device registered under the wrong
  // id — and an operator needs both.
  const devices = open()
  devices.add({ id: 'typo', name: 'Typo', roots: [] })
  devices.revoke('typo')
  devices.delete('typo')
  expect(devices.get('typo')).toBeUndefined()
  expect(devices.list().map(device => device.id)).not.toContain('typo')
})

it('refuses to delete a device that is not there, so a typo is reported', () => {
  expect(() => open().delete('nope')).toThrow(/no device with id nope/)
})

it('changes a device\'s projects without touching its id or token', () => {
  // This is what lets a device take work for a project it was first registered without.
  const devices = open()
  const { token } = devices.add({ id: 'pc', name: '宿舍', labels: [], roots: [] })
  const before = devices.get('pc')!.tokenHash
  devices.update('pc', { name: '宿舍电脑', roots: [{ project: 'dsh-foreman', path: 'F:\\dsh' }] })
  const after = devices.get('pc')!
  expect(after.roots).toEqual([{ project: 'dsh-foreman', path: 'F:\\dsh' }])
  expect(after.name).toBe('宿舍电脑')
  // The token still works: changing what a device offers must not force it to be re-provisioned.
  expect(after.tokenHash).toBe(before)
  expect(devices.verify('pc', token)).toBe(true)
})

it('leaves fields the update did not mention alone', () => {
  const devices = open()
  devices.add({ id: 'pc', name: '宿舍', labels: ['intranet'], roots: [{ project: 'a', path: '/a' }] })
  devices.update('pc', { name: '改名' })
  expect(devices.get('pc')).toMatchObject({ name: '改名', labels: ['intranet'], roots: [{ project: 'a', path: '/a' }] })
})

it('refuses to update a device that is not there', () => {
  expect(() => open().update('nope', { name: 'x' })).toThrow(/no device with id nope/)
})
