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

it('refuses to render an attachment whose bytes exceed the frame budget', () => {
  const withFile = { ...trigger, meta: { ...trigger.meta, attachments: [{ id: 'big12345', kind: 'file' }] } } as Trigger
  expect(() => renderForDevice({ ticket, trigger: withFile, readAttachment: () => Buffer.alloc(300 * 1024) })).toThrow(/too large/)
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
