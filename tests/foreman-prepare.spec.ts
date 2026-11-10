import { expect, it, vi } from 'vitest'
import { prepareTicketWithForeman, projectOf, reselectForRetry } from '../src/foreman/prepare.ts'
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

/**
 * A request that named a machine, when no such machine can take it.
 *
 * The shipped behaviour was to prepare the ticket for the host instead. On a real ticket ("look at the projects on
 * my laptop") that ran a worker Session in an empty directory on the server and reported success — the person got an
 * answer to a question nobody asked, and no sign that their machine was never touched.
 */
it('records why it could not run when the request named a device that is not available', () => {
  // Nothing is online, and the accept named "pc": preparing this for the host would run it somewhere it was not asked.
  const prepared = build('/w/shop', { online: () => [] })(ticket, { ...outcome, device: 'pc' })
  expect(prepared.target).toBeUndefined()
  expect(prepared.blockedReason).toMatch(/no online device can take this/)
  expect(prepared.blockedReason).toMatch(/device "pc"/)
})

it('still runs on the host when nothing named a device and no device reaches the project', () => {
  // This fallback stays: a project the host itself can reach should not stall because a laptop is offline, and no
  // machine was named — the host is a legitimate answer to "do this work".
  const prepared = build('/w/other')(ticket, outcome)
  expect(prepared.blockedReason).toBeUndefined()
  expect(prepared.target).toBeUndefined()
})

it('reselects a machine for a retry only when the selector picked it, never when the request named it', () => {
  const devices = [
    { id: 'laptop', name: 'L', labels: [], tokenHash: 'h', roots: [{ project: 'shop', path: '/laptop/shop' }] },
    { id: 'dorm', name: 'D', labels: [], tokenHash: 'h', roots: [{ project: 'shop', path: '/dorm/shop' }] },
  ]
  const online = [{ id: 'dorm', running: 0 }]
  const select = reselectForRetry({ devices: () => devices as never, online: () => online, triggerOf: () => trigger('/w/shop'),
    workspaceOf: () => '/w/shop', local: subject => subject })
  const ticket = { id: 'tk1', target: { deviceId: 'laptop', kind: 'remote', directory: '/laptop/shop' } } as unknown as Ticket
  // The laptop is offline and the dorm PC can take the project: the retry moves.
  expect(select(ticket)).toEqual({ deviceId: 'dorm', kind: 'remote', directory: '/dorm/shop' })
  // A request that named the laptop keeps it: moving that work would run it where nobody asked.
  const pinned = { ...ticket, target: { ...ticket.target!, pinned: true } } as unknown as Ticket
  expect(select(pinned)).toBeUndefined()
  // Nothing else can take it: the machine stays, and the ticket stays blocked for a person.
  expect(reselectForRetry({ devices: () => devices as never, online: () => [], triggerOf: () => trigger('/w/shop'),
    workspaceOf: () => '/w/shop', local: subject => subject })(ticket)).toBeUndefined()
})

