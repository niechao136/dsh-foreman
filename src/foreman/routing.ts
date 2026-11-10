/**
 * Chat and repository → project routing, indexed.
 *
 * `masterOf` runs synchronously inside the Engine's emit path, while resolving a workspace to its main Session
 * (`masterFor`) is asynchronous. Rather than make every caller await, this module keeps a synchronous map: the
 * settings carry the table, and a lookup is a hash map read.
 *
 * The index is keyed by the settings revision it was built from, so a changed mapping takes effect on the next
 * settings save — which is the answer to "what happens to messages already sent when the mapping changes": they
 * keep the workspace they were routed to, and anything that reaches a main Session from now on uses the new one.
 */
import type { ChatRoute, RepositoryRoute, Settings } from '../policy.ts'

/** A built index plus the settings revision it reflects. */
export interface ChatIndex {
  revision: number
  index: ReadonlyMap<string, ChatRoute>
  /** Repository routes by lower-cased `owner/name`, because GitHub names are case-insensitive. */
  repositories: ReadonlyMap<string, RepositoryRoute>
}

/** One entry per chat id and per repository; a duplicate keeps its first row, matching the lookup functions' rule. */
export function routeIndexOf(settings: Settings, revision = 0): ChatIndex {
  const index = new Map<string, ChatRoute>()
  for (const route of settings.routing.chats) if (!index.has(route.chatId)) index.set(route.chatId, route)
  const repositories = new Map<string, RepositoryRoute>()
  for (const route of settings.routing.repositories) {
    const name = route.repository.toLowerCase()
    if (!repositories.has(name)) repositories.set(name, route)
  }
  return { revision, index, repositories }
}

/** The route for a chat, or undefined when the table does not mention it. */
export function chatRouteOf(current: ChatIndex, chatId: string | undefined): { workspace: string; labels?: string[] } | undefined {
  if (chatId === undefined || chatId === '') return undefined
  const route = current.index.get(chatId)
  if (route === undefined) return undefined
  return route.labels === undefined ? { workspace: route.workspace } : { workspace: route.workspace, labels: [...route.labels] }
}

/** The route for a repository, or undefined when the table does not mention it; the name is compared case-insensitively. */
export function repositoryRouteOf(current: ChatIndex, repository: string | undefined): { workspace: string; labels?: string[] } | undefined {
  if (repository === undefined || repository === '') return undefined
  const route = current.repositories.get(repository.toLowerCase())
  if (route === undefined) return undefined
  return route.labels === undefined ? { workspace: route.workspace } : { workspace: route.workspace, labels: [...route.labels] }
}
