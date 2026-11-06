/** Typed panel routes, route parser, and sessionStorage location history. */
import { TICKET_FILTERS, type TicketFilter } from '../app/api.ts'
import { DECISION_FILTERS, type DecisionFilter } from './api.ts'
import type { SetupPlace } from '../setup.ts'
import type { T } from './text.ts'

// 一级导航只有四页：概览看状态、评估看判定、执行看工单、设置改配置。
// 触发事件流不再单独成页：它只是决策的输入，去看某条判定时挂在判定详情里；完整的原始流水在「设置 › 日志」。
export const TABS = ['overview', 'eval', 'execution', 'settings'] as const
export type Tab = typeof TABS[number]
export const SETTINGS_GROUPS = ['source', 'eval', 'execution', 'devices', 'prompts', 'deployment', 'logs'] as const
export type SettingsGroup = typeof SETTINGS_GROUPS[number]
export type Route = { page: 'overview'; id?: undefined; query?: undefined }
  // 评估页：筛选条件进路由，刷新与分享都还原同一屏。
  | { page: 'eval'; id?: undefined; query?: { filter?: DecisionFilter; window?: '24h' } }
  // 线程详情：从判定详情点进来，一级导航仍高亮「评估」。
  | { page: 'trigger'; id: string; query?: { trigger?: string } }
  | { page: 'execution'; id?: undefined; query?: { filter?: TicketFilter } }
  | { page: 'execution'; id: string; query?: undefined }
  | { page: 'settings'; id?: undefined; query: { group: SettingsGroup; source?: string; version?: string } }
export const HOME: Route = { page: 'overview' }
/** 一级导航高亮项：线程详情属于评估页，其余页面就是自己。 */
export const tabOf = (route: Route): Tab => route.page === 'trigger' ? 'eval' : route.page
export const settingsRoute = (group: SettingsGroup, query: { source?: string; version?: string } = {}): Route =>
  ({ page: 'settings', query: { group, ...query } })
export const setupPage = (place: SetupPlace): Route =>
  place === 'deployment' ? settingsRoute('deployment') : settingsRoute('source', { source: place })
export const routeLabel = (t: T, route: Route): string =>
  route.id !== undefined ? t(route.page === 'trigger' ? 'term.thread' : 'term.ticket') : t(`tab.${tabOf(route)}`)

const pick = <V extends string>(values: readonly V[], value: unknown): V | undefined => values.find(item => item === value)
function compact<Q extends object>(query: Q): Q | undefined {
  const set = Object.entries(query).filter(([, value]) => value !== undefined)
  return set.length ? Object.fromEntries(set) as Q : undefined
}
/** Validate and normalize a stored route, dropping unrecognized values or removed pages (such as the legacy `policy` tab). */
export function parseRoute(value: unknown): Route | undefined {
  const { page, id, query } = (value ?? {}) as { page?: unknown; id?: unknown; query?: Record<string, unknown> }
  const text = (name: string) => typeof query?.[name] === 'string' ? query[name] as string : undefined
  const record = typeof id === 'string' && id ? id : undefined
  switch (page) {
    case 'overview': return { page }
    // 旧书签兼容：`logs` 页（触发/决策两个子视图）并进评估页；列表形态的 `trigger` 也落到评估页。
    case 'logs': return query?.window === '24h' ? { page: 'eval', query: { window: '24h' as const } } : { page: 'eval' }
    case 'trigger': return record ? { page, id: record, query: compact({ trigger: text('trigger') }) } : { page: 'eval' }
    case 'eval': return { page, query: compact({ filter: pick(DECISION_FILTERS, query?.filter),
      window: query?.window === '24h' ? '24h' as const : undefined }) }
    case 'execution': return record ? { page, id: record } : { page, query: compact({ filter: pick(TICKET_FILTERS, query?.filter) }) }
    case 'settings': return { page, query: { group: pick(SETTINGS_GROUPS, query?.group) ?? 'source',
      ...compact({ source: text('source'), version: text('version') }) } }
    default: return undefined
  }
}

const ROUTE_KEY = 'dsh-foreman/route'
export interface Location { route: Route; stack: Route[]; group?: SettingsGroup | undefined }
export const lastSettingsGroup = ({ route, group }: Location): SettingsGroup => route.page === 'settings' ? route.query.group
  : group ?? 'source'
export function initialLocation(): Location {
  try {
    const stored = JSON.parse(sessionStorage.getItem(ROUTE_KEY) ?? 'null') as { route?: unknown; stack?: unknown; group?: unknown } | null
    const route = parseRoute(stored?.route)
    const stack = Array.isArray(stored?.stack) ? stored.stack as unknown[] : []
    if (route) return { route, stack: stack.flatMap(item => parseRoute(item) ?? []), group: pick(SETTINGS_GROUPS, stored?.group) }
  } catch (error) {
    // Route memory is a convenience; an unreadable value falls back to HOME.
    void error
  }
  return { route: HOME, stack: [] }
}
export function remember(location: Location): void {
  try { sessionStorage.setItem(ROUTE_KEY, JSON.stringify(location)) } catch (failure) { void failure /* Route memory is a convenience. */ }
}
