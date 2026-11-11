/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { LogKind, LogLevel, LogListView } from './views/logs.ts'
import type { TicketListView } from './views/tickets.ts'
import type { DevicesView } from './views/devices.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export const LOG_KINDS: readonly LogKind[] = ['trigger', 'decision', 'ticket', 'reply']
export const LOG_LEVELS: readonly LogLevel[] = ['info', 'warn', 'error']
export type { LogKind, LogLevel }
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

export interface Api {
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  /** 取某个工作区的主子会话；没有就现建一条。 */
  'GET master': { response: { masterId: string } }
  /**
   * 侧栏诊断：客户端把工作区组标题行的真实 DOM 结构回传一次。
   * 侧栏由别的插件渲染，结构会随宿主版本或主题插件变；落样本到 stateDir，出问题直接看行里到底有什么。
   */
  'POST sidebar-dom': { body: { html: string; strategy: string }; response: { saved: boolean; path: string } }
  'GET settings': { response: SettingsView }
  'POST sources/:id/labels': { response: { added: string[] } }
  /**
   * Every executable a source's CLI setting could name, for the settings card's dropdown.
   *
   * The refresh button calls this again after a CLI is installed: the whole point is that the answer changes without
   * restarting dsh-foreman, so it must be a request rather than a value baked into the settings payload.
   */
  'GET sources/:id/clis': { response: { found: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  /** 全部日志：到达、判定、工单开始与结束、没送达的消息，按时间合并成一条流水。 */
  'GET logs': { query?: Paged & { kind?: string; level?: string; q?: string; window?: '24h' }; response: LogListView }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  /** 部署检查卡在「状态目录里有别人的文件」时的自救入口：把该文件改名留档后重新检查。 */
  'POST setup/adopt': { body: { file: string }; response: { restarting: true } }
  'GET models': { response: ModelCatalog }
  /** 设备注册表：在线状态与负载，只列项目名，不列设备自己的路径。 */
  'GET devices': { response: DevicesView }
  /** 登记一台新设备；令牌只在这里返回一次，库里只存哈希。 */
  'POST devices': { body: { id: string; name: string; labels?: string[]; roots: { project: string; path: string }[] };
    response: { id: string; token: string } }
  'POST devices/:id/revoke': { response: { revoked: true } }
  /** 彻底删掉一台设备（吊销只是留着记录，删除是连记录一起去掉）。 */
  'DELETE devices/:id': { response: { deleted: true } }
  /** 改一台设备的显示名、标签或它能接的项目；id 与令牌不动。 */
  'PUT devices/:id': { body: { name?: string; labels?: string[]; roots?: { project: string; path?: string }[] };
    response: { updated: true } }
  'POST devices/:id/rotate': { response: { token: string } }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
