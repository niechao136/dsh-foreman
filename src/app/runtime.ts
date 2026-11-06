/** Application composition root and lifecycle manager for dsh-foreman. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, reasonText, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { Devices } from '../foreman/devices.ts'
import { ForemanExecutor } from '../foreman/executor.ts'
import { Hub } from '../foreman/hub.ts'
import { serve, type Served } from '../foreman/ws.ts'
import { prepareTicketWithForeman } from '../foreman/prepare.ts'
import { routeIndexOf, chatRouteOf, type ChatIndex } from '../foreman/routing.ts'
import { alignHello, onTimeout, applyReport, type AssignmentWhere } from '../foreman/reports.ts'
import type { Frame, ReportFrame } from '../foreman/protocol.ts'
import { attachmentPath } from '../sources/dsh.ts'

/** The ticket an assignment belongs to, and whether it is still open; undefined when the ledger has no such assignment. */
function assignmentWhere(store: Store, assignmentId: string): AssignmentWhere | undefined {
  for (const ticket of store.tickets.list()) {
    const assignment = ticket.assignments.find(entry => entry.id === assignmentId)
    if (assignment !== undefined) return { ticketId: ticket.id, open: ticket.ended === undefined }
  }
  return undefined
}

/**
 * 主会话的开场白。
 *
 * DSH 的侧栏只列有过消息的会话，空会话不出现；而且打开一条空会话看到的是新建页，
 * 看不出它是"某个工作区的主子"。所以每条主子建好后都投这一句，requestId 固定，重启幂等。
 */
/** 认得出的「这条会话不在了」：只有这种错误才值得重建，其他失败都按临时故障处理。 */
const missingSession = (error: unknown): boolean =>
  /unknown session|session not found|no such session/i.test(String((error as { message?: string } | undefined)?.message ?? error))

const MAIN_READY = '（就绪）这里是 dsh-foreman 的主会话。把需求直接发在这里：我会先判断它该不该做成工单，再派给执行器去干。'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type OrchestratorPorts, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'

// Source plugins interact with dsh-foreman exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost & OrchestratorPorts } }
const now = (): string => new Date().toISOString()

/**
 * Composition root of dsh-foreman that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  /** The device registry: who may take work, and how to reach each one. */
  readonly devices: Devices
  /** Dispatches by target: local work passes through, remote work becomes frames. */
  readonly foreman!: ForemanExecutor
  /** Maps a device's report frame onto the Engine; set once the Engine exists. */
  private applyReport!: (assignmentId: string, frame: ReportFrame) => void
  /** The device listener, once `initialize` has started it; absent when `hubPort` is 0 or startup is still pending. */
  hub?: Hub
  private hubServer?: Served
  private hubTimer?: ReturnType<typeof setInterval>
  private readonly lastSeen = new Map<string, number>()
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  /** 每个工作区的主子会话；默认那一条是 masterId，其余按需创建。 */
  private readonly masters = new Map<string, string>()
  /** 正在创建中的主子：同一个工作区被连点两次时共用同一次创建，不会开出两条会话。 */
  private readonly spawning = new Map<string, Promise<string>>()
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-foreman: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      for (const [workspaceId, sessionId] of Object.entries(store.get(KV.runtime.masters) ?? {})) this.masters.set(workspaceId, sessionId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        isMaster: sessionId => this.isMaster(sessionId),
        lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text, trigger) => sessions.prompt(this.masterOf(trigger), id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      this.devices = new Devices(store)
      // Remote work travels as frames. Until the hub is listening (initialize), sending refuses: a ticket whose
      // target could not be reached turns `blocked` instead of quietly running here.
      this.foreman = new ForemanExecutor({ local: executor, readAttachment: id => readFileSync(attachmentPath(id)),
        triggerOf: ticket => ({ trigger: store.triggers.get(ticket.origin.triggerId) }),
        engine: () => this.engine,
        transport: { send: (deviceId, frame) => this.hub?.send(deviceId, frame)
          ?? Promise.reject(new Error(`the foreman hub is not listening, so ${deviceId} cannot be reached`)) },
        log: text => ctx.logger.warn('dsh-foreman: %s', text) })
      // The selection seam: a device is chosen while the ticket is accepted, then the local prepare fills `execution`.
      const prepareTicket = prepareTicketWithForeman({ devices: () => this.devices.list(), online: () => this.hub?.snapshot() ?? [],
        triggerOf: ticket => store.triggers.get(ticket.origin.triggerId),
        // A chat's labels constrain which devices may take its work: an office-only project never falls back to a
        // laptop that happens to be online. A chat without labels imposes none.
        labelsOf: trigger => {
          const chatId = trigger?.source === 'feishu' && typeof trigger.meta['chatId'] === 'string' ? trigger.meta['chatId'] : undefined
          return chatRouteOf(this.chatRoutes, chatId)?.labels
        },
        workspaceOf: trigger => {
          const chatId = trigger?.source === 'feishu' && typeof trigger.meta['chatId'] === 'string' ? trigger.meta['chatId'] : undefined
          return chatRouteOf(this.chatRoutes, chatId)?.workspace
        },
        local: (ticket, outcome) => executor.prepare(ticket, outcome) })
      // Frames that carry facts about work become Engine calls here, the hub itself writing nothing.
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor: this.foreman,
        outbox, prepareTicket, emit: event => {
          // A ticket's events belong to the main Session that started it; anything unattributable stays with the default one.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          const home = ended ? this.masterOf(store.triggers.get(ended.origin.triggerId)) : undefined
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(notice[0], notice[1], notice[2], home)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followedTrigger = 'triggerId' in event.data ? event.data.triggerId : undefined
          const followedHome = followedTrigger === undefined ? undefined : store.triggers.get(followedTrigger)
          const followup = followed && followedTrigger !== undefined ? followupNotice(store, sources, followedTrigger) : undefined
          if (followup) sessions.relay(followup.id, followup.text, this.masterOf(followedHome))
          // Notify the ticket's conversations whenever it ends via a pull request.
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repositories[0] ?? '')) outbox.send(message)
          }
        } })
      // What a device reports becomes an Engine call; the hub itself never writes the ledger. A late or impossible
      // report is logged and dropped rather than thrown, so a finished ticket cannot be revived by it.
      this.applyReport = applyReport({ report: (ticketId, workerReport) => { engine.report(ticketId, workerReport) },
        ticketOf: assignmentId => assignmentWhere(store, assignmentId), log: text => ctx.logger.warn('dsh-foreman: %s', text) })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get sourceProblems() { return setup.problems }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.breadcrumb('constructed')
      this.ready = this.initialize().then(() => this.breadcrumb('ready'), error => {
        // 激活失败时把原因留在 stateDir 里：宿主不会把插件错误写到任何可查的日志，只有这一份线索。
        this.breadcrumb(`initialize failed: ${String(error)}`)
        throw error
      })
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-foreman stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Setup problems that pause one Source, keyed by its setup place (the Source kind ID). */
  get sourceProblems(): Record<string, SetupProblem> { return this.setup.problems }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repositories: resolved.repositories, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  /** 所有已知的主子会话 id：默认那条，加上各工作区按需建出来的。 */
  masterIds(): string[] {
    return [...new Set([this.masterId, ...this.masters.values()])]
  }

  /** 这条会话是不是某个工作区的主子。 */
  /**
   * The main Session a Trigger's conversation belongs to.
   *
   * Three cases, in order of how much is known:
   * - The local Source's Thread *is* the Session that spoke, so a request made in any workspace's main Session reports
   *   back there.
   * - A Feishu chat mapped in the routing table belongs to that chat's project, so its work reports to that project's
   *   main Session.
   * - Everything else keeps the default main Session, which is how every chat behaved before the table existed.
   *
   * Synchronous on purpose: the Engine calls this inside its emit path, so it reads a cached chat index rather than
   * awaiting `masterFor`. A chat whose workspace has no main Session yet gets the default one; `masterFor` creates it
   * the first time someone opens that workspace, and the next message lands there.
   */
  private masterOf(trigger: Trigger | undefined): string {
    const thread = trigger?.source === 'dsh' ? trigger.threads[0] : undefined
    if (thread !== undefined) return String(thread.id)
    const chatId = trigger?.source === 'feishu' && typeof trigger.meta['chatId'] === 'string' ? trigger.meta['chatId'] : undefined
    if (chatId !== undefined) {
      const route = chatRouteOf(this.chatRoutes, chatId)
      const masterId = route === undefined ? undefined : this.masterIdForPath(route.workspace)
      if (masterId !== undefined) return masterId
    }
    return this.masterId
  }

  /**
   * The cached chat index, rebuilt whenever the settings revision moved.
   *
   * "Rebuilt on save" is what answers the open question the handoff listed: a mapping change applies to messages
   * that arrive after it. A message already routed keeps the workspace it went to, because its Ticket and its
   * conversation were decided when it was accepted.
   */
  private chatRoutes_: ChatIndex | undefined
  private get chatRoutes(): ChatIndex {
    const revision = this.store.get(KV.settings.revision) ?? 0
    if (this.chatRoutes_ === undefined || this.chatRoutes_.revision !== revision) {
      this.chatRoutes_ = routeIndexOf(this.store.settings(), revision)
      // A route to a workspace that has no main Session yet cannot be honoured synchronously; create those Sessions
      // in the background so the next message in that chat lands in its own project instead of the default one.
      void this.ensureChatWorkspaces(this.chatRoutes_)
    }
    return this.chatRoutes_
  }

  /**
   * Gives every chat's workspace a main Session, so `masterOf` can find one synchronously.
   *
   * A failure is logged and not retried: the next settings save rebuilds the index and tries again, and until then
   * that chat's messages keep the default main Session rather than being lost.
   */
  private async ensureChatWorkspaces(current: ChatIndex): Promise<void> {
    for (const route of current.index.values()) {
      try {
        // The registry shape varies across DSH versions; `workspaceRecordOf` already degrades to undefined.
        const workspace = await this.workspaceRecordOf(route.workspace)
        if (workspace === undefined) continue
        await this.masterFor(workspace.id)
      } catch (error) {
        this.ctx.logger.warn('dsh-foreman could not open a main Session for chat %s in %s: %s', route.chatId, route.workspace, String(error))
      }
    }
  }

  /** The main Session of the workspace at a path, if one has been created; undefined before that. */
  private masterIdForPath(path: string): string | undefined {
    for (const [workspaceId, id] of this.masters) {
      if (this.ctx.workspaceRegistry.get(workspaceId as never)?.path === path) return String(id)
    }
    return undefined
  }
  isMaster(sessionId: string): boolean {
    if (String(sessionId) === String(this.masterId)) return true
    for (const id of this.masters.values()) if (String(id) === String(sessionId)) return true
    return false
  }

  /** 某条主子管哪个目录；不是主子、或账上还没有它时为 undefined。 */
  workspaceOf(sessionId: string): string | undefined {
    for (const [workspaceId, id] of this.masters) {
      if (String(id) !== String(sessionId)) continue
      return this.ctx.workspaceRegistry.get(workspaceId as never)?.path
    }
    return undefined
  }

  /**
   * 取这个工作区的主子：已经有就返回，没有就现建一条并记账。
   *
   * 一个工作区一条，是这套编排的归属边界：谁派出去的活回谁那里。建的时候把 cwd 定成
   * 工作区自己的目录，所以那条会话天然就在这个组的上下文里干活。
   */
  masterFor(workspaceId: string): Promise<string> {
    // 正在建就先等它。建的过程中记账已经写上（decorate 那一刻就得认得出它是主子），
    // 于是查映射会拿到一条还没建完的会话；建失败就变成一格指向半成品的死账。
    const pending = this.spawning.get(workspaceId)
    if (pending !== undefined) return pending
    const known = this.masters.get(workspaceId)
    if (known !== undefined) {
      // 已经建过的那条也补投一次开场白：requestId 固定，投过的不会重复产生消息，
      // 但从旧版本升上来的那条可能是空的，补一次它才会出现在侧栏里。
      // 投不进去说明这条会话已经被外部删掉了：清掉记账重来一次，否则这一格永远指向不存在的会话。
      // 重建用的 id 由路径推出，ensure 对已存在的会话幂等，所以不会平白多建一条。
      return this.sessions.prompt(known, 'main-session-ready', MAIN_READY, 'queue').then(
        () => known,
        (error: unknown) => {
          // 临时失败不动记账：投递超时、宿主忙都重建成新会话，会把用户正用着的那条踢掉。
          if (!missingSession(error)) throw error
          // 只在映射还指着这条失效会话时清：两个请求并发失败时，先到的那个可能已经重建好并写了新映射，
          // 后到的这个不能把它再删掉。
          this.forgetIf(workspaceId, known)
          return this.masterFor(workspaceId)
        })
    }
    const spawned = this.spawnMaster(workspaceId).finally(() => { this.spawning.delete(workspaceId) })
    this.spawning.set(workspaceId, spawned)
    return spawned
  }

  /** 真正建一条主子会话：id 由工作区路径推出来，所以同一个目录重启后还是同一条。 */
  private async spawnMaster(workspaceId: string): Promise<string> {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId as never)
    if (workspace === undefined) throw new Error(`unknown workspace ${workspaceId}`)
    const id = `orchestrator-${key(workspace.path)}`
    // 记账要排在 ensure 之前：建会话会立刻触发 agent/created → decorate，
    // 那一刻它得已经被认成主子，才会挂上编排者的 preset 与路由工具。
    const previous = this.masters.get(workspaceId)
    this.remember(workspaceId, id)
    try {
      await this.sessions.ensure(id, workspace.path, `${this.machine.sessionTitle} · ${workspace.title}`, 'orchestrator')
    } catch (error) {
      // 建失败就把记账撤回：留着它，下次点 ★ 会直接拿到这条半成品会话，再也不会重试创建；
      // 重启后还会从 KV 里把它读回来，变成永久坏掉的一格。
      if (previous === undefined) this.forget(workspaceId)
      else this.remember(workspaceId, previous)
      throw error
    }
    // 和默认那条一样先投一句：否则它是一条空会话，侧栏不列、打开也看不出是什么。
    await this.sessions.prompt(id, 'main-session-ready', MAIN_READY, 'queue').catch(() => { /* 暂时不可投递时忽略，下次打开再补。 */ })
    this.remember(workspaceId, id)
    return id
  }

  /** 只在记账仍指向这条会话时撤掉它；已经被换成别的会话就什么都不做。 */
  private forgetIf(workspaceId: string, sessionId: string): void {
    // 有人已经在重建这一格：别动它的记账，两个失败回调来回删会把新账删没。
    if (this.spawning.has(workspaceId)) return
    if (this.masters.get(workspaceId) !== sessionId) return
    this.forget(workspaceId)
  }

  /** 撤掉某个工作区的记账（创建失败时回滚，下次点击会重新尝试）。 */
  private forget(workspaceId: string): void {
    if (!this.masters.delete(workspaceId)) return
    this.store.set(KV.runtime.masters, Object.fromEntries(this.masters))
  }

  /** 记下"这个工作区的主子是这条会话"，并立刻存盘。 */
  private remember(workspaceId: string, sessionId: string): void {
    if (this.masters.get(workspaceId) === sessionId) return
    this.masters.set(workspaceId, sessionId)
    this.store.set(KV.runtime.masters, Object.fromEntries(this.masters))
  }

  /** 幂等投递一条消息到主会话；本地 Source 用它把回复送回操作者。 */
  prompt(requestId: string, text: string, sessionId?: string): Promise<void> {
    return this.sessions.prompt(sessionId ?? this.masterId, requestId, text, 'steer')
  }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  /**
   * 默认主子的落点：配置值 → DSH 里第一个「存在、且不在 stateDir 下」的工作区 → stateDir 兜底。
   * 绝不能优先退回 stateDir：那会把 ~/.dsh/state/superagent 注册成一个工作区，侧栏就多出一行「superagent」。
   */
  private masterDirectory(): string {
    if (this.machine.workspace) return this.machine.workspace
    try {
      const entries = (this.ctx.workspaceRegistry.list?.() ?? []) as unknown as ReadonlyArray<{ path?: unknown }>
      for (const entry of entries) {
        const path = entry?.path
        if (typeof path !== 'string' || path === '') continue
        if (path.startsWith(this.machine.stateDir)) continue
        if (existsSync(path)) return path
      }
    } catch (error) {
      this.ctx.logger.warn('dsh-foreman could not read the workspace list: %s', String(error))
    }
    return this.machine.stateDir
  }

  /** 按目录找工作区记录；这个 DSH 版本没有该接口或找不到时返回 undefined。 */
  private async workspaceRecordOf(path: string): Promise<{ id: string } | undefined> {
    const registry = this.ctx.workspaceRegistry as unknown as { resolveByPath?: unknown }
    if (typeof registry?.resolveByPath !== 'function') return undefined
    try {
      return await this.ctx.workspaceRegistry.resolveByPath(path)
    } catch { return undefined }
  }

  /**
   * 激活过程的最后一步记录，写进 `<stateDir>/diagnostics/activation.log`。
   * 桌面端不会把插件错误写到任何日志里，出问题时这是唯一能看的地方；写入失败一律忽略，不能反过来影响启动。
   */
  private breadcrumb(step: string): void {
    try {
      const directory = join(this.machine.stateDir, 'diagnostics')
      mkdirSync(directory, { recursive: true })
      appendFileSync(join(directory, 'activation.log'), `${new Date().toISOString()} ${step}\n`)
    } catch { /* 诊断失败不影响启动 */ }
  }

  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    this.executor.install()
    // 主子的落点选择和创建都围在 try 里：workspaceRegistry 的形状在不同 DSH 版本里不完全一样，
    // 任何一次读取失手都只能降级（回退 stateDir），不能让整个插件激活失败、面板一片「没有响应」。
    this.breadcrumb('initializing')
    const directory = this.masterDirectory()
    try {
      this.breadcrumb(`master: ${directory}`)
      await this.sessions.ensure(this.masterId, directory, this.machine.sessionTitle, 'orchestrator')
      // 默认那个工作区也照同一套记一笔：M 气泡点在它上面时找回的是这一条，而不是又开一条。
      const home = await this.workspaceRecordOf(directory)
      if (home !== undefined) this.remember(home.id, this.masterId)
    } catch (error) {
      this.ctx.logger.warn('dsh-foreman could not place its master session in %s: %s', directory, String(error))
      if (directory !== this.machine.stateDir) {
        await this.sessions.ensure(this.masterId, this.machine.stateDir, this.machine.sessionTitle, 'orchestrator')
          .catch(fallback => this.ctx.logger.warn('dsh-foreman could not place its master session in the state directory either: %s', String(fallback)))
      }
    }
    // DSH 的侧栏只列出有过消息的会话；主会话刚建好是空的，会因此不在列表里出现。
    // 给他留一条开场说明：既让它可见，也顺带告诉操作者该怎么用。requestId 固定，重启不会重复发。
    await this.sessions.prompt(this.masterId, 'main-session-ready',
      MAIN_READY,
      'queue').catch(() => { /* 主会话暂时不可投递时忽略，下次启动再补。 */ })
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    await this.startHub()
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }

  /**
   * Start listening for devices, unless the hub is switched off (`hubPort` 0) or was already started.
   *
   * A port already in use is logged and left off rather than failing activation: the hub is one way to run work, and
   * a busy port must not make the whole panel unavailable. Every ticket then runs here, which the panel shows as no
   * device being online.
   */
  private async startHub(): Promise<void> {
    if (this.hubServer !== undefined || this.machine.hubPort === 0) return
    try {
      this.hubServer = await serve({ port: this.machine.hubPort, devices: this.devices,
        onFrame: (deviceId, frame) => this.receiveFrame(deviceId, frame),
        log: text => this.ctx.logger.warn('dsh-foreman: %s', text) })
      this.hub = this.hubServer.hub
      this.hubTimer = setInterval(() => this.checkHeartbeats(), 30_000)
      this.hubTimer.unref?.()
      this.ctx.logger.info('dsh-foreman hub listening on 127.0.0.1:%d for devices', this.hubServer.port)
    } catch (error) {
      this.ctx.logger.warn('dsh-foreman could not start its device hub on port %d: %s', this.machine.hubPort, String(error))
    }
  }

  /**
   * Turn one device frame into ledger facts.
   *
   * Only two frames change anything: `report` becomes an Engine report, and `accepted` marks the assignment started —
   * the device's own word, which is why the Executor never sets it. Everything else is either a heartbeat the hub
   * already recorded or a handshake the hub already checked.
   */
  private receiveFrame(deviceId: string, frame: Frame): void {
    this.lastSeen.set(deviceId, Date.now())
    try {
      if (frame.type === 'report') this.applyReport(frame.assignmentId, frame)
      else if (frame.type === 'accepted') {
        const where = assignmentWhere(this.store, frame.assignmentId)
        if (where !== undefined && where.open) this.engine.assignmentStarted(where.ticketId, frame.assignmentId)
      } else if (frame.type === 'hello') this.alignDevice(deviceId, frame.running)
    } catch (error) {
      // A frame the ledger refuses must not take the connection down: log it and let the device keep its link.
      this.ctx.logger.warn('dsh-foreman could not apply a %s frame from %s: %s', frame.type, deviceId, String(error))
    }
  }

  /**
   * Reconcile a reconnecting device against the ledger, in the design's terms (5.8).
   *
   * What both sides agree is running needs nothing. What the ledger thinks is running and the device does not is a
   * fact only the device can supply — it is handed back `blocked` for a person to decide, never restarted here.
   * Nothing is ever assigned again on the strength of a reconnect alone.
   */
  private alignDevice(deviceId: string, running: readonly string[]): void {
    const known = this.runningOn(this.store, deviceId)
    const { stop } = alignHello({ running, known, stop: () => {} })
    for (const assignmentId of stop) {
      const where = assignmentWhere(this.store, assignmentId)
      if (where === undefined || !where.open) continue
      // The device says it is not running this: that is the confirmation the design requires before a person may
      // move the work. Report blocked; a person decides whether to retry, and no second assignment is created here.
      this.applyReport(assignmentId, { v: 1, type: 'report', frameId: `align:${deviceId}:${assignmentId}`, assignmentId,
        state: 'blocked', summary: `${deviceId} reconnected but says it is not running this assignment` })
    }
  }

  /**
   * Report every assignment a silent device was running as `blocked`, once it has been quiet past `hubIdleMs`.
   *
   * The list of assignments comes from the **ledger**, not from the hub. A device that dropped its connection is gone
   * from the hub entirely, so asking the hub what it runs would find nothing the moment the case actually matters —
   * the machine pulled off the network. The hub supplies only the load and a last-seen stamp the ledger does not have.
   */
  private checkHeartbeats(): void {
    if (this.hub === undefined) return
    const nowMs = Date.now()
    const connected = new Map(this.hub.snapshot().map(device => [device.id, device]))
    for (const device of this.devices.list()) {
      if (device.revokedAt !== undefined) continue
      const running = this.runningOn(this.store, device.id)
      // A device with no assignment outstanding has nothing to time out, whichever way it went quiet.
      if (running.length === 0) continue
      const session = connected.get(device.id)
      const since = this.lastSeen.get(device.id) ?? session?.lastSeenAt ?? device.lastSeenAt
      const sinceMs = typeof since === 'string' ? Date.parse(since) : since
      if (sinceMs === undefined || Number.isNaN(sinceMs)) {
        // Never heard from at all: it cannot have been running anything of ours, so there is nothing to time out.
        continue
      }
      onTimeout({ since: sinceMs, now: nowMs, limitMs: this.machine.hubIdleMs.get(), deviceId: device.id, running,
        report: (ticketId, workerReport) => this.engine.report(ticketId, workerReport),
        ticketOf: assignmentId => assignmentWhere(this.store, assignmentId) })
    }
  }

  /** The assignments the ledger still believes a device is running, on open tickets only. */
  private runningOn(store: Store, deviceId: string): string[] {
    return store.tickets.open().flatMap(ticket => ticket.assignments
      .filter(assignment => assignment.state === 'running' && assignment.target?.deviceId === deviceId)
      .map(assignment => assignment.id))
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks,
      masterIds: () => runtime.masterIds(), masterFor: workspaceId => runtime.masterFor(workspaceId),
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get sourceProblems() { return setup.problems },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog(),
      devices: () => runtime.devices.list(), onlineDevices: () => runtime.hub?.snapshot() ?? [],
      revokeDevice: id => {
        runtime.devices.revoke(id)
        // Drop the connection now instead of waiting for its next heartbeat: a revoked token must stop working at once.
        runtime.hub?.detach(id)
      },
      rotateDeviceToken: id => {
        const token = runtime.devices.rotate(id)
        runtime.hub?.detach(id)
        return token
      } }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    try {
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      // The device listener goes before the database: a frame arriving after close would try to write to a closed store.
      if (this.hubTimer !== undefined) clearInterval(this.hubTimer)
      await this.hubServer?.close().catch(error => this.ctx.logger.warn('dsh-foreman could not close its device hub: %s', String(error)))
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-foreman could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
