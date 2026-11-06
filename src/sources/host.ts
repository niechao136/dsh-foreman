/** Host and context interfaces connecting Source plugins to the application; also imported by the web panel, so it must not import Node-only modules. */
import type { ChannelRef, ReceiveResult, OutboundMessage, Thread, ThreadFact, ThreadRef, Ticket, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import type { Deployment } from '../deployment.ts'
import type { SourceRegistry } from './registry.ts'
import type { SetupProblem } from '../setup.ts'
import type { Family, Key } from '../kv.ts'
import { fill } from '../infra/text.ts'

/**
 * Fixed English health templates (`{name}` placeholders) for codes core code reports.
 *
 * 扩展点：Source kind 自己的健康码用不着改这张表，它把文案表传给 `health()`，并在 `SourceKind.healthCodes`
 * 里声明面板标签即可。
 */
export const HEALTH_TEXT = {
  setupPending: 'Waiting for the deployment check',
  sourceOff: 'Off',
  pollFailures: '{count} consecutive failed polls; last: {error}',
} as const
/** A health code: a core one, or any code a Source kind declares in its own table. */
export type HealthCode = keyof typeof HEALTH_TEXT | (string & {})
export type Health = { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string; at?: string; code?: HealthCode; values?: Record<string, string>
  /** Panel label of `code` in both interface languages, taken from the declaring kind; the panel localizes this instead of its own table. */
  label?: { zh: string; en: string } }
/**
 * Builds a health report.
 * @param text English templates for the codes this reporter uses; defaults to the core table, so a Source kind
 *   passes its own and needs no entry in `HEALTH_TEXT`.
 */
export function health(state: Health['state'], code: HealthCode, values: Record<string, string> = {},
  text: Record<string, string> = HEALTH_TEXT): Health {
  return { state, detail: fill(text[code] ?? code, values), code, ...Object.keys(values).length ? { values } : {} }
}
export interface SourceHost {
  readonly sources: SourceRegistry
  /** Returns the context for one Source kind; its `report` writes only the health entries declared by the kind. */
  context(kind: { kind: string; health: readonly string[] }): SourceContext
}
/**
 * 编排器额外向 Source 插件暴露的运行时能力。
 *
 * 为什么单独一个接口：`SourceHost` 只管注册表与配置上下文，而"把回复送回主会话"
 * 和"把自己产生的 Trigger 交给评估"需要运行时对象（Runtime 实例）上的方法。
 * 本地 Source 依赖这两项，所以显式声明出来，避免插件用 any 绕过类型。
 */
export interface OrchestratorPorts {
  /** 主会话的 session id；本地 Source 用它区分"人打的"与"程序注入的"消息。 */
  readonly masterId: string
  /** 这条会话是不是某个工作区的主子；一个工作区一条，本地 Source 认所有主子。 */
  isMaster(sessionId: string): boolean
  /** 某条主子管的工作区目录；本地 Source 用它决定这条需求落在哪个目录。 */
  workspaceOf(sessionId: string): string | undefined
  /** 幂等投递一条回复到主会话（同 requestId 只产生一条消息）。 */
  /**
   * 把一条消息投进主会话。sessionId 指定投给哪一条：本地 Source 的 channel 地址里
   * 记着用户的会话 id，缺了它就只能投给默认主子，多主会话下等于发错人。
   */
  prompt(requestId: string, text: string, sessionId?: string): Promise<void>
  /** 摄取一条 Trigger；内部负责去重、作用域过滤，并按需排队评估。 */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
}
/** Display label, URL, and facts (`null` removes a fact) that a Source publishes on a Thread. */
export interface ThreadDescription { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }
/** Application capabilities exposed to a Source kind for reading state, ingesting triggers, managing threads/tickets, and reporting health. */
export interface SourceContext {
  readonly deployment: Deployment
  readonly commands: Commands
  readonly ready: Promise<void>
  /** True once setup resolved the repository and accounts; Sources poll only then. */
  configured(): boolean
  /** Setup problem keeping this Source's account from running; only the Feishu bot check reports one. */
  readonly problem?: SetupProblem | undefined
  /** Returns a Source's configuration while enabled, or undefined while disabled or uninstalled. */
  config<C extends Record<string, unknown>>(kind: string): C | undefined
  /** Ingests a trigger into the Engine and schedules the next evaluation pass; callers should await completion before advancing read cursors. */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  atomic<T>(work: () => T): T
  /** Source-scoped KV records (such as read cursors); setting `undefined` removes an entry. */
  state: { get<V>(key: Key<V>): V | undefined; set<V>(key: Key<V>, value: V | undefined): void; keys<V>(family: Family<V, never>): Key<V>[] }
  threads: {
    get(key: string): Thread | undefined
    subscribed(source: string): Thread[]
    describe(key: string, description: ThreadDescription): void
    /** Sets or removes (`undefined`) keys in a Thread's `meta` after rereading it; a missing Thread is left alone. */
    patch(key: string, meta: Record<string, unknown>): void
  }
  tickets: {
    get(id: string): Ticket | undefined
    /** Open tickets, newest first. */
    open(): Ticket[]
    /** Binds an open ticket to follow a Source Thread (`own` when opened by the ticket) so the Thread's close, not a ready report, ends the ticket. */
    bindThread(id: string, thread: ThreadRef, own: boolean): void
    /** Reports that a followed Thread closed at `at`; each open ticket following it ends once no `own` Thread remains open and no resumed work is still running. */
    threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void
  }
  triggers: { get(id: string): Trigger | undefined; /** The newest Trigger on a Thread. */ latest(thread: string): Trigger | undefined }
  notify(message: OutboundMessage): void
  /** Reports the state of one of this kind's declared health entries; throws for undeclared entry names. */
  report(entry: string, health: Health): void
}
export const sourceContext = (host: SourceHost, kind: { kind: string; health: readonly string[] }): SourceContext => host.context(kind)
