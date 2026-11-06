/**
 * Chat → project routing, indexed.
 *
 * `masterOf` runs synchronously inside the Engine's emit path, while resolving a workspace to its main Session
 * (`masterFor`) is asynchronous. Rather than make every caller await, this module keeps a synchronous map: the
 * settings carry the table, and a lookup is a hash map read.
 *
 * The index is keyed by the settings revision it was built from, so a changed mapping takes effect on the next
 * settings save — which is the answer to "what happens to messages already sent when the mapping changes": they
 * keep the workspace they were routed to, and anything that reaches a main Session from now on uses the new one.
 */
import type { ChatRoute, Settings } from '../policy.ts'

/** A built index plus the settings revision it reflects. */
export interface ChatIndex {
  revision: number
  index: ReadonlyMap<string, ChatRoute>
}

/** One entry per chat id; a duplicate keeps its first row, matching `workspaceOfChat`'s rule. */
export function routeIndexOf(settings: Settings, revision = 0): ChatIndex {
  const index = new Map<string, ChatRoute>()
  for (const route of settings.routing.chats) if (!index.has(route.chatId)) index.set(route.chatId, route)
  return { revision, index }
}

/** The route for a chat, or undefined when the table does not mention it. */
export function chatRouteOf(current: ChatIndex, chatId: string | undefined): { workspace: string; labels?: string[] } | undefined {
  if (chatId === undefined || chatId === '') return undefined
  const route = current.index.get(chatId)
  if (route === undefined) return undefined
  return route.labels === undefined ? { workspace: route.workspace } : { workspace: route.workspace, labels: [...route.labels] }
}
