import { expect, it } from 'vitest'
import { chatRouteOf, routeIndexOf } from '../src/foreman/routing.ts'
import { SettingsSchema } from '../src/policy.ts'

const settings = (chats: unknown[]) => SettingsSchema.parse({ routing: { chats } })

it('reads the workspace and labels a chat maps to', () => {
  const index = routeIndexOf(settings([{ chatId: 'oc_shop', workspace: '/w/shop', labels: ['intranet'] }]))
  expect(chatRouteOf(index, 'oc_shop')).toMatchObject({ workspace: '/w/shop', labels: ['intranet'] })
})

it('answers undefined for a chat the table does not mention', () => {
  const index = routeIndexOf(settings([{ chatId: 'oc_shop', workspace: '/w/shop' }]))
  expect(chatRouteOf(index, 'oc_other')).toBeUndefined()
  expect(chatRouteOf(index, undefined)).toBeUndefined()
})

it('builds a fresh index when settings change, so a new mapping applies without a restart', () => {
  const before = routeIndexOf(settings([{ chatId: 'oc_shop', workspace: '/w/old' }]))
  const after = routeIndexOf(settings([{ chatId: 'oc_shop', workspace: '/w/new' }]))
  expect([chatRouteOf(before, 'oc_shop')!.workspace, chatRouteOf(after, 'oc_shop')!.workspace]).toEqual(['/w/old', '/w/new'])
})

it('is keyed by the settings revision, so an unchanged table is not rebuilt', () => {
  const first = routeIndexOf(settings([]), 7)
  const second = routeIndexOf(settings([]), 7)
  expect(first.revision).toBe(7)
  expect(first.index).not.toBe(second.index)
})
