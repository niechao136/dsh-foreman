
import { expect, it } from 'vitest'
import { SettingsSchema, workspaceOfRepository } from '../src/policy.ts'
import { repositoryRouteOf, routeIndexOf } from '../src/foreman/routing.ts'

const settings = SettingsSchema.parse({ routing: { repositories: [
  { repository: 'acme/widgets', workspace: '/home/ubuntu/src/widgets', labels: ['intranet'] },
] } })

it('finds the workspace a repository belongs to', () => {
  expect(workspaceOfRepository(settings, 'acme/widgets')).toEqual({ workspace: '/home/ubuntu/src/widgets', labels: ['intranet'] })
})

it('matches a repository name case-insensitively, as GitHub does', () => {
  expect(workspaceOfRepository(settings, 'Acme/Widgets')?.workspace).toBe('/home/ubuntu/src/widgets')
})

it('leaves an unconfigured repository to the default main Session and to host execution', () => {
  expect(workspaceOfRepository(settings, 'acme/unknown')).toBeUndefined()
  expect(workspaceOfRepository(settings, undefined)).toBeUndefined()
})

it('defaults to an empty repository table so an old database still loads', () => {
  expect(SettingsSchema.parse({}).routing.repositories).toEqual([])
  expect(SettingsSchema.parse({ routing: { chats: [{ chatId: 'oc_x', workspace: '/w/x' }] } }).routing.repositories).toEqual([])
})

it('leaves labels out when the mapping names none', () => {
  const plain = SettingsSchema.parse({ routing: { repositories: [{ repository: 'acme/plain', workspace: '/w/plain' }] } })
  expect(workspaceOfRepository(plain, 'acme/plain')).toEqual({ workspace: '/w/plain' })
})

it('refuses a mapping whose repository is not owner/name, or whose workspace is relative', () => {
  expect(() => SettingsSchema.parse({ routing: { repositories: [{ repository: 'widgets', workspace: '/w/x' }] } })).toThrow()
  expect(() => SettingsSchema.parse({ routing: { repositories: [{ repository: 'acme/widgets', workspace: 'relative' }] } })).toThrow()
})

it('takes the first mapping when a repository is listed twice, the second spelling differing only in case', () => {
  const twice = SettingsSchema.parse({ routing: { repositories: [
    { repository: 'acme/widgets', workspace: '/w/first' },
    { repository: 'Acme/Widgets', workspace: '/w/second' },
  ] } })
  expect(workspaceOfRepository(twice, 'ACME/WIDGETS')).toEqual({ workspace: '/w/first' })
})

it('indexes repositories beside chats, so one lookup table serves both Sources', () => {
  const index = routeIndexOf(SettingsSchema.parse({ routing: {
    chats: [{ chatId: 'oc_shop', workspace: '/w/shop' }],
    repositories: [{ repository: 'acme/widgets', workspace: '/w/widgets' }],
  } }))
  expect(repositoryRouteOf(index, 'acme/widgets')).toEqual({ workspace: '/w/widgets' })
  expect(repositoryRouteOf(index, 'acme/other')).toBeUndefined()
})
