import { expect, it } from 'vitest'
import { SettingsSchema, workspaceOfChat } from '../src/policy.ts'

const settings = SettingsSchema.parse({ routing: { chats: [
  { chatId: 'oc_shop', workspace: '/home/ubuntu/src/shop', labels: ['intranet'] },
] } })

it('finds the workspace a chat belongs to', () => {
  expect(workspaceOfChat(settings, 'oc_shop')).toEqual({ workspace: '/home/ubuntu/src/shop', labels: ['intranet'] })
})

it('leaves an unconfigured chat to the default main Session', () => {
  expect(workspaceOfChat(settings, 'oc_unknown')).toBeUndefined()
})

it('defaults to an empty routing table so an old database still loads', () => {
  expect(SettingsSchema.parse({}).routing.chats).toEqual([])
})

it('leaves labels out when the mapping names none, so no label filters device selection', () => {
  const plain = SettingsSchema.parse({ routing: { chats: [{ chatId: 'oc_plain', workspace: '/w/plain' }] } })
  expect(workspaceOfChat(plain, 'oc_plain')).toEqual({ workspace: '/w/plain' })
})

it('refuses a mapping whose workspace is not an absolute path', () => {
  expect(() => SettingsSchema.parse({ routing: { chats: [{ chatId: 'oc_x', workspace: 'relative/shop' }] } })).toThrow()
})

it('refuses a mapping with no chat id', () => {
  expect(() => SettingsSchema.parse({ routing: { chats: [{ workspace: '/w/shop' }] } })).toThrow()
})

it('takes the first mapping when a chat is listed twice, and keeps the rest loadable', () => {
  const twice = SettingsSchema.parse({ routing: { chats: [
    { chatId: 'oc_shop', workspace: '/w/first' },
    { chatId: 'oc_shop', workspace: '/w/second' },
  ] } })
  expect(workspaceOfChat(twice, 'oc_shop')).toEqual({ workspace: '/w/first' })
})

it('does not fail when routing is absent from a stored settings value', () => {
  expect(SettingsSchema.parse({ paused: true }).routing.chats).toEqual([])
})
