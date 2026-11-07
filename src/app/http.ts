/** Loopback-only management HTTP routes with same-origin enforcement for the web panel. */
import type { Context } from '@deepseek-ai/cordis'
import { isLoopbackHost } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { THREAD_FILTERS, TICKET_FILTERS, type Api, type ApiResponse, type RouteParams } from './api.ts'
import { sourceSkills } from './context.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { PromptConflict, SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts }
  from './prompts.ts'
import { policyVersion } from '../policy.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { adoptForeignFile } from '../infra/environment.ts'
import { UserError, type EngineForPeople, type Ticket } from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { Health } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'
import type { LinkTarget, ViewHost } from './views/records.ts'
import type { Variable } from './execution-environment.ts'
import { policyHistory } from './settings-history.ts'
import { overview } from './views/overview.ts'
import { settingsView } from './views/settings.ts'
import { sourcesStatus, type SetupState } from './views/sources.ts'
import { decisionList, search, threadDetail, threadList } from './views/threads.ts'
import { logList, type LogKind, type LogLevel } from './views/logs.ts'
import { executorLoad, ticketDetail, ticketList } from './views/tickets.ts'
import { devicesView } from './views/devices.ts'
import type { DeviceInput, DeviceRecord } from '../foreman/devices.ts'
import type { Online } from '../foreman/selector.ts'

export interface HttpHost {
  readonly store: Store
  /** Feishu message links resolved since startup, used by search to match AppLink URLs. */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery'>
  readonly settings: Pick<Settings, 'view' | 'save' | 'pause' | 'sync' | 'refreshLabels'>
  readonly engine: EngineForPeople
  readonly executor: Pick<DshExecutor, 'activeCount'>
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly masterId: string
  /** 每个工作区的主子；侧栏据此把主子行都藏起来。 */
  masterIds(): string[]
  /** 取某个工作区的主子，没有就现建一条。 */
  masterFor(workspaceId: string): Promise<string>
  /** Resolves once startup finishes or setup determines what is still missing. */
  readonly ready: Promise<void>
  /** Resolved deployment; throws if read while waiting for setup (`!configured()`). */
  readonly deployment: Deployment
  readonly setupProblem?: SetupProblem | undefined
  /** Setup problems that pause one Source, keyed by its setup place (the Source kind ID). */
  readonly sourceProblems?: Record<string, SetupProblem> | undefined
  configured(): boolean
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  requestPass(): void
  models(): Promise<ModelCatalog>
  /** Every registered device, revoked ones included. */
  devices(): DeviceRecord[]
  /** The devices connected right now, with their load. */
  onlineDevices(): Online[]
  /** Register a device and mint its token; the token is not stored in readable form anywhere. */
  addDevice(input: DeviceInput): { id: string; token: string }
  revokeDevice(id: string): void
  /** Replaces a device's token and returns the new one, which is not stored in readable form anywhere. */
  rotateDeviceToken(id: string): string
  /**
   * 写请求的凭据校验；省略时用 {@link pageCredential} 向宿主页面入口核对。
   * 单独暴露出来是为了测试能直接给定结论，而不必真的监听端口。
   */
  readonly hostAuth?: (req: Pick<IncomingMessage, 'headers'>) => Promise<boolean>
}
/**
 * Represents a client-facing 400 or 404 error raised during management route parsing or lookup.
 * Route handlers throw it when request bodies are malformed or target records are missing, and registerHttp serializes its status and message in the HTTP response.
 */
class RouteError extends Error { constructor(readonly status: 400 | 404, message: string) { super(message) } }

/** Whether a registration failed because the id is taken, the only failure that is the caller's to fix. */
function isDuplicateDevice(error: unknown): boolean {
  return error instanceof Error && /is already registered/.test(error.message)
}
async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
/** 转发给宿主页面入口的凭据头：谁决定这次请求是哪个人，就转发谁，别的一概不带。 */
const CREDENTIAL_HEADERS = ['cookie', 'authorization']
const CREDENTIAL_TTL = 60_000
/** 凭据头的指纹；同一个浏览器的请求打一次探针就够了。 */
const credentialKey = (headers: IncomingMessage['headers']): string =>
  createHash('sha256').update(JSON.stringify(Object.entries(headers)
    .filter(([name, value]) => typeof value === 'string' && (CREDENTIAL_HEADERS.includes(name) || name.startsWith('x-dsh-')))
    .sort())).digest('hex')
/**
 * 判断一次写请求是否带着宿主网页自己的凭据。
 *
 * 为什么需要它：`x-orchestrator-request` 只是一个标记头，本机任何进程都能写；
 * 真正把人挡在外面的是宿主的 Web 服务——未认证的页面请求会得到 401
 * "dsh web authentication required"。插件不能把这条边界当成理所当然，
 * 所以把同一个请求的凭据头原样转发给宿主的页面入口，只信宿主的回答：
 *
 * - 宿主明确回答 401/403：拒绝这次写操作；
 * - 宿主其它回答（页面正常、入口不存在、宿主没开认证层）：放行，行为与加固前一致；
 * - 探针自身失败（宿主重启中、只监听 TLS）：同样放行，宁可少拦一次，也不把面板锁在门外。
 *
 * 结论按凭据指纹缓存 {@link CREDENTIAL_TTL} 毫秒，写操作本来就不频繁。
 */
/**
 * 请求到达时用的主机名。宿主的登录 cookie 归 Host 所有：用 localhost 登录，127.0.0.1 就不算登录，
 * 所以探测凭据必须用同一个名字，不能写死回环地址。
 */
const requestHost = (headers: IncomingMessage['headers']): string | undefined => {
  const host = headers.host
  if (!host) return undefined
  // IPv6 字面量形如 [::1]:3097，方括号要留在 URL 里。
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1) || undefined
  return host.split(':')[0] || undefined
}
export function pageCredential(port: number, host?: string): (req: Pick<IncomingMessage, 'headers'>) => Promise<boolean> {
  const decided = new Map<string, { allowed: boolean; at: number }>()
  return async req => {
    const key = credentialKey(req.headers)
    const hit = decided.get(key)
    if (hit && Date.now() - hit.at < CREDENTIAL_TTL) return hit.allowed
    const forwarded: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string' && (CREDENTIAL_HEADERS.includes(name) || name.startsWith('x-dsh-'))) forwarded[name] = value
    }
    // 先问请求自己的主机名（浏览器从哪个名字登录，cookie 就属于哪个名字），再退到另一个回环名字：
    // 同一个浏览器也可能在 localhost 登录、却从 127.0.0.1 打开页面，两个名字都得问一遍。
    const targets = [host ?? requestHost(req.headers) ?? '127.0.0.1']
    for (const name of ['127.0.0.1', 'localhost']) if (!targets.includes(name)) targets.push(name)
    let allowed = true
    for (const target of targets) {
      try {
        const response = await fetch(`http://${target}:${port}/`, { headers: forwarded, redirect: 'manual',
          signal: AbortSignal.timeout(1500) })
        // 宿主明确回答 401/403 才算拒绝；200、入口 404、宿主没开认证层都按放行处理。
        allowed = response.status !== 401 && response.status !== 403
      } catch {
        // 探针失败不拦人；理由见上。
        allowed = true
      }
      if (allowed) break
    }
    if (decided.size > 256) decided.clear()
    decided.set(key, { allowed, at: Date.now() })
    return allowed
  }
}
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}
/**
 * Maps errors to HTTP status codes and structured payloads that the panel localizes in the interface language.
 * `internal` receives anything that becomes a 500, so its original text and stack reach the service log only.
 */
function failure(error: unknown, internal: (id: string, error: unknown) => void): [number, Record<string, unknown>] {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof RouteError) return [error.status, { error: error.message }]
  if (error instanceof UserError) return [error.missing ? 404 : 400, { error: error.message, code: error.code, values: error.values }]
  if (error instanceof SettingsConflict || error instanceof PromptConflict) return [409, { error: error.message }]
  // 500 不回内部错误文本：message 里可能带本地绝对路径、CLI 命令或第三方错误细节，
  // 而同用户进程、面板脚本都能看到响应体。面板按 code 显示本地化文案，细节只写服务端日志。
  const id = randomUUID()
  internal(id, error)
  return [500, { code: 'internal-error', id }]
}

function machineView({ stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs, hubPort }: Machine) {
  // `hubPort` is published because the device card has to name the address a device dials, and 0 means the hub is off:
  // a page that guessed a port would hand an operator an address nothing is listening on.
  return { stateDir, promptMaxChars: promptMaxChars.get(), admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get(), hubPort }
}
/** Every setup problem the panel shows: global first, then the ones that pause a single Source, each with that Source's title. */
function setupProblems(runtime: HttpHost) {
  const titleOf = (place: string) => runtime.sources.kind(place)?.title
  return [
    ...runtime.setupProblem ? [{ ...runtime.setupProblem, scope: 'service' as const, title: titleOf(runtime.setupProblem.place) }] : [],
    ...Object.values(runtime.sourceProblems ?? {}).map(problem => ({ ...problem, scope: 'source' as const, title: titleOf(problem.place) })),
  ]
}
function setupView(runtime: HttpHost) {
  const resolved = runtime.configured() ? runtime.deployment : undefined
  return {
    machine: machineView(runtime.machine), problem: runtime.setupProblem ?? null, problems: setupProblems(runtime),
    accounts: resolved ? { repositories: resolved.repositories, agent: resolved.github.login, feishu: resolved.feishu ? { appId: resolved.feishu.appId, brand: resolved.feishu.brand, botId: resolved.feishu.botId, name: resolved.feishu.name } : null } : null,
  }
}
/** Build the `/orchestrator/api/state` response consumed by the management panel and `scripts/dsh-foreman status` (`docs/006-deployment.md`). */
export function stateView(runtime: HttpHost) {
  const settings = runtime.store.settings()
  return { setup: setupView(runtime), load: { ...executorLoad(runtime.store, runtime.executor.activeCount()),
    maxWorkers: settings.executor.maxWorkers },
    masterId: runtime.masterId, masterIds: runtime.masterIds(), paused: settings.paused, health: runtime.health }
}
const views = (runtime: HttpHost): ViewHost => ({ store: runtime.store, sources: runtime.sources, links: runtime.links() })
const setupState = (runtime: HttpHost): SetupState => ({ deployment: runtime.configured() ? runtime.deployment : undefined,
  problem: runtime.setupProblem, sourceProblems: runtime.sourceProblems })
export type StateView = ReturnType<typeof stateView>
/** Builds a ticket's detail view; `environment` is empty while waiting for setup because it requires the resolved deployment. */
function ticketPage(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id), ticket = runtime.store.tickets.get(id)
  if (!detail || !ticket) throw new RouteError(404, 'Ticket not found')
  return { ...detail, environment: runtime.configured() ? runtime.ticketEnvironment(ticket) : [] }
}
export type TicketPageView = ReturnType<typeof ticketPage>
function promptsView(runtime: HttpHost, revision: number | undefined, offset: number) {
  const current = runtime.prompts.current()
  const shown = revision === undefined || revision === current.revision ? current : runtime.prompts.version(revision)
  // Each built-in part with the key of its text, which an override records as its base, and for the overrides shown whose
  // built-in text changed since, the text they were edited from when known.
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) }))
  return { masterId: runtime.masterId, current: shown, defaults: defaultPrompts(), sections: TEAM_SECTIONS, skillName: SKILL_NAME.source,
    builtin: Object.keys(sourceSkills), skillPrefix: SKILL_PREFIX, parts, defaultChanged: runtime.prompts.defaultChanged(shown.config),
    ...runtime.sessions.status(), ...runtime.prompts.history(offset) }
}
export type PromptsView = ReturnType<typeof promptsView>

interface Input<K extends keyof Api> {
  params: RouteParams<K>; query: Record<string, string>; body: (maxBytes?: number) => Promise<unknown>
}
type Routes = { [K in keyof Api]: (input: Input<K>) => ApiResponse<K> | Promise<ApiResponse<K>> }
const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(value => Math.min(max, value))
const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), offset, limit: limit(20, 1000) })
const ThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('subscribed'), offset, limit: limit(20, 1000) })
const ThreadQuery = z.object({ limit: limit(50, 100), before: z.string().optional(), around: z.string().optional() })
const DecisionsQuery = z.object({ kind: z.string().default(''), window: z.literal('24h').optional().catch(undefined), offset,
  limit: limit(30, 200) })
const count = z.coerce.number().int().nonnegative()
const LogsQuery = z.object({ kind: z.string().default(''), level: z.string().default(''), q: z.string().max(200).default(''),
  window: z.literal('24h').optional().catch(undefined), offset: count.default(0), limit: limit(100, 500) })
const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
const SourceBlock = z.templateLiteral(['source:', z.string().regex(/^[a-z][a-z0-9-]*$/)])
const SettingsBlockSchema = z.union([z.enum(['policy', 'eval', 'executor']), SourceBlock])
const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })

function routes(runtime: HttpHost): Routes {
  const { store } = runtime
  const ticket = (id: string) => { if (!store.tickets.get(id)) throw new RouteError(404, 'Ticket not found'); return id }
  const promptBody = (input: { body: (maxBytes?: number) => Promise<unknown> }) => input.body(4 * runtime.machine.promptMaxChars.get() + 4096)
  return {
    'GET state': () => stateView(runtime),
    'GET overview': () => overview(views(runtime), runtime.health, policyVersion(store.settings()),
      executorLoad(store, runtime.executor.activeCount()), setupProblems(runtime), sourcesStatus(views(runtime), runtime.health, setupState(runtime))),
    'GET search': ({ query }) => search(views(runtime), query.q ?? '', runtime.sourceLinks),
    'GET sources': () => sourcesStatus(views(runtime), runtime.health, setupState(runtime)),
    // 取某个工作区的主子：★ 按钮点一次就拿到这一条（服务端没有就现建，建过就复用同一条）。
    'GET master': async ({ query }) => {
      const workspace = (query.workspace ?? '').trim()
      if (!workspace) throw new RouteError(400, 'workspace is required')
      return { masterId: await runtime.masterFor(workspace) }
    },
    'GET settings': () => settingsView(store, runtime.sources, runtime.health, setupState(runtime), runtime.machine.stateDir),
    'POST sources/:id/labels': ({ params }) => runtime.settings.refreshLabels(params.id),
    'GET threads': ({ query }) => {
      const { filter, offset, limit } = ThreadsQuery.parse(query)
      return threadList(views(runtime), filter, offset, limit)
    },
    'GET threads/:key': ({ params, query }) => {
      const { limit, before, around } = ThreadQuery.parse(query)
      const detail = threadDetail(views(runtime), params.key, before, limit, around)
      if (!detail) throw new RouteError(404, 'Thread not found')
      return detail
    },
    'POST threads/:key/unsubscribe': async ({ params }) => {
      const removed = runtime.engine.unsubscribe(params.key)
      return { removed, thread: params.key, context_delivery: await runtime.sessions.delivery(`subscription:${params.key}`) }
    },
    'POST triggers/:id/requeue': ({ params }) => {
      const queued = runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { queued }
    },
    'GET decisions': ({ query }) => {
      const { kind, window, offset, limit } = DecisionsQuery.parse(query)
      const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return decisionList(views(runtime), kind.split(',').filter(Boolean), offset, limit, since)
    },
    'POST decisions/:id/dismiss': ({ params }) => { runtime.engine.dismiss(params.id); return { dismissed: true } },
    'GET logs': ({ query }) => {
      const { kind, level, q, window, offset, limit } = LogsQuery.parse(query)
      const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return logList(views(runtime), { kind: kind.split(',').filter(Boolean) as LogKind[], level: level.split(',').filter(Boolean) as LogLevel[], q, since, offset, limit })
    },
    'GET tickets': ({ query }) => {
      const { state, offset, limit } = TicketsQuery.parse(query)
      return ticketList(views(runtime), state, offset, limit)
    },
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    'POST tickets/:id/retry': ({ params }) => { const id = ticket(params.id); runtime.engine.retryTicket(id); return { retried: true } },
    'POST tickets/:id/stop': ({ params }) => { const id = ticket(params.id); runtime.engine.stopTicket(id); return { stopped: true } },
    'POST executor/pause': async ({ body }) => runtime.settings.pause(z.object({ paused: z.boolean() }).parse(await body()).paused, 'panel'),
    'PUT settings/:block': async ({ params, body }) => {
      const block = SettingsBlockSchema.parse(params.block)
      const known = !block.startsWith('source:') || runtime.sources.instances().some(instance => `source:${instance.id}` === block)
      if (!known) throw new RouteError(404, 'Source not found')
      const request = SaveRequest.parse(await body())
      return runtime.settings.save(block, request.value, request.revision, 'panel')
    },
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': async ({ params }) => ({ policy: await runtime.settings.sync(params.id) }),
    'POST setup/check': () => { runtime.checkSetup(); return { restarting: true } },
    'POST setup/adopt': async ({ body }) => {
      // 别的工具写进状态目录的文件（典型是宿主里的 `git config --global` 落到我们指向的 worker 配置）会让部署检查一直失败。
      // 只允许动我们自己那几个位置的文件：改名留档，再重新检查。
      const { file } = z.object({ file: z.string().min(1) }).parse(await body())
      // 只允许动我们自己那几个位置的文件；别的一律 refuse（400），不要把任意路径交给调用方。
      await adoptForeignFile(runtime.machine.stateDir, file).catch((error: unknown) => {
        throw error instanceof Error && error.message.startsWith('Only the worker files')
          ? new UserError('foreignWorkerFile') : error
      })
      runtime.checkSetup()
      return { restarting: true as const }
    },
    'GET models': () => runtime.models(),
    /** 设备注册表：谁可以接活、谁在线、各自在跑几件。设备自己的路径不外发，只列项目名。 */
    'GET devices': () => devicesView({ devices: runtime.devices(), online: runtime.onlineDevices() }),
    /** 登记一台新设备。令牌只在这一次响应里出现，刷新就没了。 */
    'POST devices': async input => {
      const body = z.object({ id: z.string().trim().min(1), name: z.string().trim().min(1),
        labels: z.array(z.string().trim().min(1)).optional(),
        roots: z.array(z.object({ project: z.string().trim().min(1), path: z.string().trim().min(1) })) }).parse(await input.body())
      // A duplicate id is the operator's mistake, so it is reported as a 400 naming rotate. Anything else — a store
      // or lock failure — is a server fault whose text may name the state directory, so it is left to `failure()`,
      // which answers 500 with an opaque id and keeps the detail in the log.
      try { return runtime.addDevice(body) }
      catch (error) {
        if (isDuplicateDevice(error)) throw new RouteError(400, (error as Error).message)
        throw error
      }
    },
    /** 吊销一台设备：登记保留（审计要看），下一次心跳就断开。 */
    'POST devices/:id/revoke': ({ params }) => {
      runtime.revokeDevice(decodeURIComponent(params.id!))
      return { revoked: true }
    },
    /** 轮换令牌：旧令牌立刻失效，新令牌只返回这一次。 */
    'POST devices/:id/rotate': ({ params }) => ({ token: runtime.rotateDeviceToken(decodeURIComponent(params.id!)) }),
    'GET prompts': ({ query }) => { const { revision, offset } = PromptsQuery.parse(query); return promptsView(runtime, revision, offset) },
    'PUT prompts': async input => {
      const request = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() }).parse(await promptBody(input))
      return savePrompts(runtime, request.config, request.baseRevision, 'panel')
    },
    'POST prompts/preview': async input => runtime.prompts.preview(await promptBody(input)),
    /** 侧栏结构样本：客户端每页回传一次，落到 stateDir，排查「按钮插错位置」时直接看真 DOM。 */
    'POST sidebar-dom': async ({ body }) => {
      const sample = z.object({ html: z.string().max(200_000), strategy: z.string().max(200) }).parse(await body())
      const directory = join(runtime.machine.stateDir, 'diagnostics')
      await mkdir(directory, { recursive: true })
      const path = join(directory, 'sidebar-dom.html')
      await writeFile(path, `<!-- strategy: ${sample.strategy} -->\n${sample.html}\n`, 'utf8')
      return { saved: true, path }
    },
  }
}
function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
function match(table: Routes, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const params: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decoded(segments[index]!) })
    return { run: run as (input: Input<keyof Api>) => unknown, params }
  }
  return undefined
}
export function registerHttp(ctx: Context, runtime: HttpHost): () => void {
  // 只要求"本机可达"，不要求字面写成 127.0.0.1：DSH 桌面端（Electron）把自己的 host
  // 归一化成 localhost 之类的写法，硬等于会让整个 initialize 在第一步就抛错，
  // 编排器停在半初始化——数据库开着、会话没建、HTTP 路由也不注册。
  const host = ctx.webServer.host
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]' || isLoopbackHost(host)
  if (!loopback) throw new Error(`Orchestrator management requires a loopback Web server; configured host is "${host}"`)
  // 写操作还要过宿主页面凭据这一关：标记头谁都能伪造，宿主的登录态不能。
  // 读操作维持原样，避免探针一旦失真就让整块面板变成空白。
  const credential = runtime.hostAuth ?? pageCredential(ctx.webServer.port)
  /** 任何 500 的细节只进日志：响应里留一个 id，事后能按它反查。 */
  const internal = (id: string, error: unknown) => ctx.logger.error('orchestrator api: internal error %s: %s', id,
    error instanceof Error ? error.stack ?? error.message : String(error))
  const table = routes(runtime)
  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/orchestrator/api/')) { res.writeHead(404); res.end(); return }
      if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      const method = req.method ?? 'GET'
      // 注入的 hostAuth 万一抛错也按放行处理：拦人的开关坏了，不该顺手把管理 API 一起关掉。
      if (method !== 'GET' && method !== 'HEAD' && !await credential(req).catch(() => true)) {
        json(res, 403, { code: 'credential-required' }); return
      }
      try {
        await runtime.ready
        const route = match(table, method, url.pathname.slice('/orchestrator/api/'.length).split('/'))
        if (!route) throw new RouteError(404, 'Unknown operation')
        const query = Object.fromEntries(url.searchParams)
        json(res, 200, await route.run({ params: route.params as never, query, body: maxBytes => readBody(req, maxBytes) }))
      } catch (error) { json(res, ...failure(error, internal)) }
    } })]
  return () => { for (const dispose of disposers) dispose() }
}
