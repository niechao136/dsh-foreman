import { expect, it, vi } from 'vitest'
import { prepareTicketWithForeman, projectOf } from '../src/foreman/prepare.ts'
import { selectDevice, type DeviceRequest } from '../src/foreman/selector.ts'
import type { AssessmentOutcome, AssignmentTarget, Ticket, Trigger } from '../src/core/index.ts'
import type { DeviceRecord } from '../src/foreman/devices.ts'

const devices: DeviceRecord[] = [
  { id: 'laptop', name: '笔记本', labels: ['intranet'], tokenHash: 'h', roots: [{ project: 'shop', path: '/laptop/shop' }] },
]
const online = [{ id: 'laptop', running: 0 }]
const outcome = { kind: 'accept', title: 'Fix it', scope: 'login', reason: 'asked' } as Extract<AssessmentOutcome, { kind: 'accept' }>
const ticket = { id: 'tk1', origin: { triggerId: 'tr1', triggerIds: ['tr1'] } } as unknown as Ticket
const trigger = (workspace: string): Trigger => ({ id: 'tr1', source: 'dsh', text: 'x', threads: [], meta: { workspace } } as unknown as Trigger)

const build = (workspace: string | undefined, extra: Partial<Parameters<typeof prepareTicketWithForeman>[0]> = {}) =>
  prepareTicketWithForeman({ devices: () => devices, online: () => online,
    triggerOf: () => workspace === undefined ? undefined : trigger(workspace),
    local: (subject, accepted) => ({ ...subject, execution: { assignment: accepted.scope } }) as Ticket, ...extra })

it('writes the chosen device onto the ticket, then lets the local prepare fill in the execution', () => {
  const prepared = build('/home/me/src/shop')(ticket, outcome)
  expect(prepared.target).toEqual({ deviceId: 'laptop', kind: 'remote', directory: '/laptop/shop' })
  expect(prepared.execution).toEqual({ assignment: 'login' })
})

it('leaves the target unset when no device can take the project', () => {
  const prepared = build('/home/me/src/other')(ticket, outcome)
  expect(prepared.target).toBeUndefined()
  expect(prepared.execution).toBeTruthy()
})

it('leaves the target unset when there is no workspace to name a project after', () => {
  expect(build(undefined)(ticket, outcome).target).toBeUndefined()
})

it('lets an accept that names a device override the automatic pick', () => {
  const named = { ...outcome, device: '笔记本' } as typeof outcome
  expect(build('/home/me/src/shop')(ticket, named).target!.deviceId).toBe('laptop')
})

it('reads the project name from the last segment of either kind of path', () => {
  expect([projectOf('/home/me/src/shop'), projectOf('D:\\工作\\shop'), projectOf('/w/shop/')]).toEqual(['shop', 'shop', 'shop'])
  expect(projectOf(undefined)).toBe('')
})

it('carries the labels a chat mapping requires into the selection', () => {
  const pick = vi.fn((_request: DeviceRequest) => undefined as AssignmentTarget | undefined)
  const prepare = prepareTicketWithForeman({ devices: () => devices, online: () => online, select: pick as typeof selectDevice,
    triggerOf: () => trigger('/w/shop'), labelsOf: () => ['intranet'], local: subject => subject })
  prepare(ticket, outcome)
  expect(pick.mock.calls[0]![0]).toEqual({ labels: ['intranet'], project: 'shop' })
})

it('takes the project from the routing table when the trigger records no workspace', () => {
  const chat = { id: 'tr1', source: 'feishu', text: 'x', threads: [], meta: { chatId: 'oc_shop' } } as unknown as Trigger
  const prepare = prepareTicketWithForeman({ devices: () => devices, online: () => online, triggerOf: () => chat,
    workspaceOf: () => '/home/ubuntu/src/shop', local: subject => subject })
  expect(prepare(ticket, outcome).target).toEqual({ deviceId: 'laptop', kind: 'remote', directory: '/laptop/shop' })
})

it('prefers the workspace a trigger records over the routing table', () => {
  const prepare = prepareTicketWithForeman({ devices: () => devices, online: () => online, triggerOf: () => trigger('/w/shop'),
    workspaceOf: () => '/w/other', local: subject => subject })
  expect(prepare(ticket, outcome).target?.directory).toBe('/laptop/shop')
})
