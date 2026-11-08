import { expect, it } from 'vitest'
import { renderForDevice } from '../src/foreman/render.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'

const ticket = { id: 'tk1', title: 'Fix it', source: 'dsh', mandate: { strength: 'explicit', basis: { rules: undefined } },
  execution: { name: 'fix', directory: '/w/shop', assignment: '' } } as unknown as Ticket
const trigger = { source: 'dsh', text: '修一下登录', threads: [], meta: { workspace: '/w/shop' } } as unknown as Trigger

it('renders the request text and never a hub-side resource pointer', () => {
  const { text } = renderForDevice({ ticket, trigger, readAttachment: () => Buffer.from('') })
  expect(text).toContain('修一下登录')
  expect(text).not.toMatch(/read: ticket\//)
})

it('carries attachments as bytes, not as hub paths', () => {
  const withFile = { ...trigger, meta: { ...trigger.meta, attachments: [{ id: 'abc12345', kind: 'file', name: 'a.txt', bytes: 5 }] } } as Trigger
  const result = renderForDevice({ ticket, trigger: withFile, readAttachment: () => Buffer.from('hello') })
  expect(result.attachments).toEqual([{ id: 'abc12345', name: 'a.txt', mediaType: undefined, bytes: Buffer.from('hello').toString('base64') }])
  expect(result.text).not.toContain('/.dsh/attachments')
})

it('strips the hub attachment paths a local ticket records in its execution text', () => {
  // ticketExecution() writes these lines for a worker on this host; a device must never see them.
  const withPaths = { ...ticket, execution: { name: 'fix', directory: '/w/shop',
    assignment: 'Fix the login.\nThe operator attached these; open them (read_image for images) before deciding anything:\n- file: a.txt at /home/me/.dsh/attachments/v1/objects/ab/abc12345'
  } } as unknown as Ticket
  const { text } = renderForDevice({ ticket: withPaths, trigger, readAttachment: () => Buffer.from('') })
  expect(text).not.toContain('/home/me/.dsh/attachments')
  expect(text).not.toContain('ab/abc12345')
  expect(text).toContain('Fix the login.')
})

it('keeps a scope sentence that names no path', () => {
  const scoped = { ...ticket, execution: { name: 'fix', directory: '/w/shop', assignment: 'Scope: the login form only.' } } as unknown as Ticket
  expect(renderForDevice({ ticket: scoped, trigger, readAttachment: () => Buffer.from('') }).text).toContain('Scope: the login form only.')
})

it('refuses to render an attachment whose bytes exceed the frame budget', () => {
  const withFile = { ...trigger, meta: { ...trigger.meta, attachments: [{ id: 'big12345', kind: 'file' }] } } as Trigger
  expect(() => renderForDevice({ ticket, trigger: withFile, readAttachment: () => Buffer.alloc(300 * 1024) })).toThrow(/too large/)
})

it('budgets the base64 size, so a frame it accepts really fits the cap', () => {
  // 200 KiB of file becomes ~273 KiB on the wire, past the 256 KiB cap — the renderer must refuse it here rather
  // than let the peer's parseFrame reject the frame it was promised was valid.
  const withFile = { ...trigger, meta: { ...trigger.meta, attachments: [{ id: 'edge1234', kind: 'file', name: 'a.bin' }] } } as Trigger
  expect(() => renderForDevice({ ticket, trigger: withFile, readAttachment: () => Buffer.alloc(200 * 1024) })).toThrow(/too large/)
})

it('accepts an attachment that fits the cap both raw and encoded', () => {
  const withFile = { ...trigger, meta: { ...trigger.meta, attachments: [{ id: 'ok123456', kind: 'file', name: 'a.bin' }] } } as Trigger
  const { attachments } = renderForDevice({ ticket, trigger: withFile, readAttachment: () => Buffer.alloc(120 * 1024) })
  expect(attachments.length).toBe(1)
  expect(attachments[0]!.bytes.length).toBeLessThan(256 * 1024)
})

it('names the ticket, its scope and its directory for the device, without hub paths', () => {
  const { text } = renderForDevice({ ticket, trigger, readAttachment: () => Buffer.from('') })
  expect(text).toContain('Fix it')
  expect(text).not.toContain('/w/shop')
})

it('tells the device how to open an attachment it received, by name', () => {
  const withFile = { ...trigger, meta: { ...trigger.meta, attachments: [{ id: 'abc12345', kind: 'file', name: 'a.txt' }] } } as Trigger
  const { text } = renderForDevice({ ticket, trigger: withFile, readAttachment: () => Buffer.from('hello') })
  expect(text).toContain('a.txt')
  expect(text).toMatch(/read_image|read/)
})

it('still renders a task when there is no trigger, falling back to the ticket', () => {
  const { text, attachments } = renderForDevice({ ticket, readAttachment: () => Buffer.from('') })
  expect(text).toContain('Fix it')
  expect(attachments).toEqual([])
})

it('does not render a dropped image as a file the device must open', () => {
  const withFile = { ...trigger, meta: { ...trigger.meta, attachments: [{ id: 'not a valid id!', kind: 'file', name: 'evil' }] } } as Trigger
  const result = renderForDevice({ ticket, trigger: withFile, readAttachment: () => Buffer.from('x') })
  expect(result.attachments).toEqual([])
  expect(result.text).not.toContain('evil')
})

it('keeps a media type the hub knows so the device can render an image inline', () => {
  const withFile = { ...trigger, meta: { ...trigger.meta, attachments: [{ id: 'img12345', kind: 'image', name: 'shot.png', mediaType: 'image/png' }] } } as Trigger
  const [attachment] = renderForDevice({ ticket, trigger: withFile, readAttachment: () => Buffer.from('png') }).attachments
  expect(attachment).toEqual({ id: 'img12345', name: 'shot.png', mediaType: 'image/png', bytes: Buffer.from('png').toString('base64') })
})

it('tells the device it has to report, because answering in chat reaches nobody', () => {
  // A real device worked thirty steps and never called foreman_report, so the hub waited at `running` forever.
  // The instruction has to travel with the assignment; nothing else tells the model that reporting is required.
  const { text } = renderForDevice({ ticket, trigger, readAttachment: () => Buffer.from('') })
  expect(text).toContain('foreman_report')
  expect(text).toMatch(/not finished until you/i)
})

it('says which machine the job is on, so the device need not work out that the request meant itself', () => {
  // A person at the hub writes "check the dorm computer" and the device receiving it IS that computer, but nothing
  // said so: the model spent its opening steps comparing names and listing directories looking for itself.
  const { text } = renderForDevice({ ticket, trigger, readAttachment: () => Buffer.from(''),
    device: { id: 'pc', name: '宿舍电脑', directory: 'F:\\dsh' } })
  expect(text).toContain('宿舍电脑')
  expect(text).toContain('pc')
  expect(text).toContain('F:\\dsh')
  // It has to say plainly that a named machine is this one, not merely list the directory.
  expect(text).toMatch(/it means you/i)
})

it('does not offer the directory name as a machine alias, because it is usually the project', () => {
  const { text } = renderForDevice({ ticket, trigger, readAttachment: () => Buffer.from(''),
    device: { id: 'pc', name: '宿舍电脑', directory: 'F:\\projects\\shop' } })
  // "shop" is the project there, not another name for the machine.
  expect(text).not.toContain('"shop"')
  expect(text).toContain('宿舍电脑')
})

it('omits the location when the caller does not know the device', () => {
  const { text } = renderForDevice({ ticket, trigger, readAttachment: () => Buffer.from('') })
  expect(text).not.toContain('Where this job runs')
})
