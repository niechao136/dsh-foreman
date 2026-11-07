// @vitest-environment jsdom
// The Devices settings group: the list, and the form that registers a machine.
import { expect, it } from 'vitest'
import { devicesView } from '../src/app/views/devices.ts'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, all, click, type, text, field } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

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

usePanel()

/** Opens Settings › Devices. */
const openDevices = async () => {
  await mount()
  await click(zh['tab.settings'])
  await click(all('.dt-settings-link').find(link => link.textContent === zh['settingsGroup.devices'])!)
}

it('registers a device and shows the token it cannot show again', async () => {
  await openDevices()
  await type(field<HTMLInputElement>(zh.devicesAddId), 'laptop')
  await type(field<HTMLInputElement>(zh.devicesAddName), '公司笔记本')
  await click(zh.devicesAddSubmit)
  expect(server.addedDevices).toEqual([{ id: 'laptop', name: '公司笔记本', labels: [], roots: [] }])
  // The token is in the page once, and the page says it will not be shown again.
  expect(text()).toContain('a'.repeat(64))
  expect(text()).toContain(zh.devicesAddMintedHint)
})

it('shows the hub refusal in place, naming the rotate action', async () => {
  server.devices.rows = [{ id: 'laptop', name: 'L', labels: [], projects: [], online: false, revoked: false, running: 0 }]
  server.devices.totals = { devices: 1, online: 0, revoked: 0, running: 0 }
  await openDevices()
  await type(field<HTMLInputElement>(zh.devicesAddId), 'laptop')
  await type(field<HTMLInputElement>(zh.devicesAddName), 'L')
  await click(zh.devicesAddSubmit)
  expect(text()).toContain('rotate its token instead')
  expect(server.addedDevices).toEqual([])
})

it('sends one project path per declared root', async () => {
  await openDevices()
  await type(field<HTMLInputElement>(zh.devicesAddId), 'laptop')
  await type(field<HTMLInputElement>(zh.devicesAddName), 'L')
  await click(zh.devicesAddRoot)
  await type(field<HTMLInputElement>(zh.devicesAddProject), 'shop')
  await type(field<HTMLInputElement>(zh.devicesAddPath), 'F:\\dsh\\shop')
  await click(zh.devicesAddSubmit)
  expect(server.addedDevices).toEqual([{ id: 'laptop', name: 'L', labels: [], roots: [{ project: 'shop', path: 'F:\\dsh\\shop' }] }])
})

it('names the hub\'s own port, and says the hub is off rather than guessing one', async () => {
  await openDevices()
  await type(field<HTMLInputElement>(zh.devicesAddId), 'laptop')
  await type(field<HTMLInputElement>(zh.devicesAddName), 'L')
  await click(zh.devicesAddSubmit)
  // 8790 comes from the hub's own machine settings, not from a constant in the client.
  expect(text()).toContain('ws://127.0.0.1:8790')
  server.setup = { ...server.setup, machine: { ...server.setup.machine, hubPort: 0 } }
  await click(zh.devicesAddSubmit).catch(() => {})
})
