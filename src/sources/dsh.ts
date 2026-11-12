/**
 * DSH 本地 Source：把操作者在「主会话」里亲手输入的消息当作事件源。
 *
 * 为什么需要它：dsh-foreman 原本只从 GitHub / 飞书接需求，没有「本机用户」这种来源。
 * 这个 Source 补上这一环——主会话里的一句话变成一个 Trigger，随后走正规链路：
 * Trigger → Intake → Eval 判定 → Ticket → Executor 干活 → 回复回到同一个会话。
 *
 * 关键约定：
 * - 一个实例就能覆盖所有工作区：主会话属于哪个工作区，它接下的工单就在哪个目录里执行。
 * - 只有 source.kind === 'user' 的消息才算需求；dsh-foreman 自己注入的回复、
 *   候选卡片带的是别的 kind，不会被当成新需求，从而不会自激成环。
 */
import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import { z } from 'zod'
import type { OutboundMessage, Trigger } from '../core/index.ts'
import { isoTime } from '../core/model.ts'
import type { ContextPart, Localized, SourceKind } from './kind.ts'

/** Source kind 的稳定标识；Trigger、策略、配置都按它归类。 */
export const SOURCE = 'dsh'

/** 操作者在策略里的身份标识。当前只有部署者本人，将来可扩展成多个本地用户。 */
export const OPERATOR_ID = 'operator'

/**
 * 配置 schema。
 * - workspace：该实例绑定的工作区绝对路径；空串表示交给 Executor 的默认工作目录。
 * - name：面板上显示的名字，纯展示用。
 */
const DshConfigSchema = z.object({
  // 提前拒绝相对路径，避免工单创建时才发现工作区配置错误。
  workspace: z.string().trim().refine(value => !value || isAbsolute(value), 'Workspace must be an absolute path').default(''),
  name: z.string().trim().max(60).optional(),
}).strict()

/** 配置类型，供服务端与面板共享。 */
export type DshConfig = z.infer<typeof DshConfigSchema>

/**
 * 把一条消息的内容块拼成纯文本。
 * 只取 text 块；图片、文件等块不会传给后续处理，threadContext 也不会读取它们。
 */
export const messageText = (blocks: readonly { type: string; text?: string }[]): string =>
  blocks.filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string).join('\n').trim()

/**
 * 一条消息里附带的图片或文件，只留定位所需的最小字段。
 *
 * 为什么只留 id 而不留整个 attachment 对象：Trigger 会存进 sqlite 并回放，
 * 塞大对象既没必要，也容易随 DSH 版本变化而失效。
 */
export interface DshAttachment {
  /** 附件在 DSH 附件库里的 id；文件是内容的 sha256，图片是归一化后的 id。 */
  id: string
  /** 图片用 read_image 读，文件按路径读。 */
  kind: 'image' | 'file'
  /** MIME 类型，评估与 worker 都靠它判断这是不是一张图。 */
  mediaType?: string
  /** 展示名，DSH 已剥掉本地路径信息。 */
  name?: string
  /** 原始字节数。 */
  bytes?: number
}

/** DSH 附件库的对象根目录；附件路径只能落在它下面。 */
export const ATTACHMENTS_ROOT = join(homedir(), '.dsh', 'attachments', 'v1', 'objects')

/**
 * 附件对象 ID 的合法形状：字母数字开头，之后只允许字母、数字、下划线和连字符，长度 2–128。
 *
 * 为什么必须收紧：附件 id 来自消息内容，而 `attachmentPath` 会把它当路径片段拼接。
 * 只要求"非空字符串"时，`../../../../tmp/secret` 这类 id 会被 `join()` 规范化到附件库之外，
 * 随后路径被写进 worker 的任务说明，等于把附件读取边界交给消息内容决定。
 * 真实 id 是内容的 sha256（64 位小写十六进制）或图片归一化 id，都落在这个字符集里；
 * 这里刻意不接受 `.`、`/`、`\` 与空串，路径穿越也就不需要再靠 `realpath` 兜底。
 */
const ATTACHMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/

/** 判断一个值是否是格式合法的附件对象 ID。 */
export const isAttachmentId = (id: unknown): id is string => typeof id === 'string' && ATTACHMENT_ID.test(id)

/**
 * DSH 附件库里一个对象的绝对路径：objects/<id 前两位>/<id>。
 *
 * @throws 附件 id 格式不合法时抛错——拼出库外路径比拒绝更危险。
 */
export function attachmentPath(id: string): string {
  if (!isAttachmentId(id)) throw new Error(`Invalid DSH attachment id: ${String(id).slice(0, 40)}`)
  const path = join(ATTACHMENTS_ROOT, id.slice(0, 2), id)
  // 防御性复核：即使上面的校验被改坏，也不把附件库之外的路径交给调用方。
  if (!path.startsWith(ATTACHMENTS_ROOT + sep)) throw new Error('The attachment path leaves the attachment store')
  return path
}

/**
 * 从消息内容里挑出附件引用。
 *
 * DSH 的附件块只有 attachmentId、没有路径；路径按附件库的存储约定拼出来，
 * 这样 worker 才能用 read_image / read 真正打开它。
 */
export function attachmentRefs(blocks: readonly { type: string; text?: string; attachment?: unknown }[]): DshAttachment[] {
  const refs: DshAttachment[] = []
  for (const block of blocks) {
    if (block.type !== 'image' && block.type !== 'file') continue
    const raw = block.attachment as { attachmentId?: unknown; mediaType?: unknown; name?: unknown; bytes?: unknown } | undefined
    // 只收格式合法的附件对象 ID：非法 id（含路径分隔符、`..`、超长值）在这里就丢掉，
    // 免得下游把它当路径拼进 worker 的任务说明。
    if (!raw || !isAttachmentId(raw.attachmentId)) continue
    refs.push({
      id: raw.attachmentId,
      kind: block.type,
      ...typeof raw.mediaType === 'string' ? { mediaType: raw.mediaType } : {},
      ...typeof raw.name === 'string' ? { name: raw.name } : {},
      ...typeof raw.bytes === 'number' ? { bytes: raw.bytes } : {},
    })
  }
  return refs
}

/**
 * 由一条主会话消息构造 Trigger。
 *
 * 语义映射：
 * - 线程 = 会话本身，所以同一会话里的后续消息自然汇聚到同一个 Thread。
 * - 操作者 = 部署者本人，human 置真，保证它能发起明确的工单。
 * - 回复地址 = 同一个会话，Executor 的回话靠它送回主会话。
 *
 * @throws 不会抛错；空文本由调用方提前过滤。
 */
export function dshTrigger(input: {
  /** 这条消息在 DSH 会话里的唯一 id，用作 Trigger id 的一部分，天然幂等。 */
  messageId: string
  /** 会话 id，同时也是 Thread id 与回复地址。 */
  sessionId: string
  /** 消息正文。 */
  text: string
  /** 消息时间，交给 Intake 归一化。 */
  at: string
  /** 该 Source 实例绑定的工作区目录，写进 meta 供执行器选择工作目录。 */
  workspace?: string
  /** 这条消息附带的图片或文件；执行器会把它们的路径写进任务说明。 */
  attachments?: readonly DshAttachment[]
}): Trigger {
  return {
    id: `${SOURCE}:${input.messageId}`,
    source: SOURCE,
    threads: [{ source: SOURCE, id: input.sessionId }],
    actor: { source: SOURCE, id: OPERATOR_ID },
    human: true,
    addressed: 'direct',
    at: isoTime(input.at),
    text: input.text,
    channel: { source: SOURCE, thread: input.sessionId, address: { sessionId: input.sessionId } },
    meta: {
      messageId: input.messageId,
      sessionId: input.sessionId,
      // 每条本地消息都是一个新需求：Intake 看到这个标记就不会去复活已结束的工单，
      // 否则操作者问的第二件事会被第一张工单的执行器接着做掉。
      newTicket: true,
      // 一个话题把「同一件事」与「这个项目里的新一句话」分开：写 `#topic:readme-refresh` 的消息会接上
      // 那张同名话题的工单（即使它已结束），而没写话题的消息照旧各自开单。
      ...topicOf(input.text) ? { topic: topicOf(input.text) } : {},
      ...input.workspace ? { workspace: input.workspace } : {},
      ...input.attachments?.length ? { attachments: input.attachments } : {},
    },
  }
}

/**
 * The topic a message names with `#topic:<name>`, if any.
 *
 * A thread cannot say "the same piece of work" for the local operator, because the thread is the whole conversation
 * of a project. This is the smallest explicit signal that can: the person writes it once, and a later message about
 * the same thing reuses it, which is what lets a finished ticket be continued instead of duplicated.
 */
export const topicOf = (text: string): string | undefined => {
  const match = /#topic:([A-Za-z0-9._-]{1,80})/.exec(text)
  return match?.[1]
}

/**
 * 回复投递能力。
 *
 * 为什么不用 `kind.channel.send` 自带的 host：那边的 host 只有 `commands`（见 registry.ts），
 * 拿不到 sessions，没法往主会话投递。所以由插件入口把投递函数注入进来。
 */
export interface DshDelivery {
  /** 幂等投递一条回复到主会话；同一个 id 重复调用不应产生两条消息。 */
  /** sessionId 省略时投给默认主子；本地消息都带得上，别的来源才没有。 */
  deliver(id: string, text: string, sessionId?: string): Promise<void>
}

/**
 * 面板字段：只有显示名。
 *
 * 以前这里让人填一个「工作区目录」，但本地来源其实是监听**所有**工作区的主会话，
 * 工单落在消息所在的那个工作区（见 dshTrigger 的 workspace 来源），填一个固定目录既误导又没用。
 * schema 里仍保留 workspace 作为旧配置的兜底，只是不再出现在面板上。
 */
const fields: SourceKind<DshConfig>['fields'] = [
  {
    key: 'name',
    type: 'text',
    label: { zh: '显示名', en: 'Display name' },
    hint: { zh: '只影响面板显示，不影响行为。', en: 'Affects the panel label only, not behavior.' },
  },
]

/**
 * 构造 Source kind 描述对象。
 *
 * 做成函数而不是常量，是因为回复投递依赖插件入口拿到的 Context；
 * 用闭包注入，避免在 kind 里持有全局状态。
 */
export function dshKind(delivery: DshDelivery): SourceKind<DshConfig> {
  return {
    kind: SOURCE,
    title: { zh: '本机操作者（所有工作区）', en: 'Local operator (all workspaces)' },
    description: {
      zh: '监听所有工作区的主会话：操作者在哪里说话，需求就在那个工作区里执行，回复回到同一个会话。',
      en: 'Watches the main Session of every workspace: a request runs in the workspace it was typed in, and the reply returns to that Session.',
    },
    schema: DshConfigSchema,
    fields,
    // 这个 Source 没有外部连接，不需要任何健康条目。
    health: [],
    channel: {
      /**
       * 把回复投递回主会话。
       * 永远返回 sent：主会话在本进程里，投递失败会抛错（让 Outbox 重试），而不是 gone。
       */
      send: async (_host, message: OutboundMessage): Promise<'sent' | 'gone'> => {
        // 地址里记着这条消息是从哪条主会话来的：回复必须回到那里，而不是默认主子。
        const address = message.channel.address as { sessionId?: string } | undefined
        await delivery.deliver(message.id, message.text, address?.sessionId)
        return 'sent'
      },
      /** 本地会话没有可点击的 URL，返回空链接。 */
      link: (address: Record<string, string>) => ({
        url: '',
        label: { zh: '本机会话', en: 'Local Session' } as Localized,
      }),
    },
    /**
     * 线程上下文读取器。
     * 第一版返回空：Trigger 自带的 text 已经足够判断，读取会话历史留作后续增强。
     */
    threadContext: {
      /** Trigger 自身消息在 Thread 里的 id。 */
      messageId: trigger => String(trigger.meta.messageId ?? ''),
      async read(): Promise<ContextPart> {
        return { messages: [], body: {} }
      },
    },
    /**
     * 策略部分。
     *
     * 用 `allowed` 名单表达「谁的需求算数」：当前默认只有操作者本人。
     * 复用现有的准入逻辑，不改 core；将来加本地用户时只需在名单里加一行。
     */
    policy: {
      schema: z.object({
        // 默认就把操作者本人放进来：这个 Source 的存在意义就是"本人发起"，
        // 空名单会让概览一直提示"没有人能发起工作"。
        allowed: z.array(z.object({
          id: z.string().trim().min(1),
          name: z.string().trim().max(100).optional(),
        }).strict()).default([{ id: OPERATOR_ID }]),
      }).strict(),
      fields: [
        {
          key: 'allowed',
          type: 'rows',
          label: { zh: '能发起工作的操作者', en: 'Operators who may originate work' },
          columns: [
            { key: 'id', type: 'text', label: { zh: '标识', en: 'ID' } },
            { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
          ],
        },
      ],
      explicit: {
        zh: '操作者本人的消息一律是明确的请求，不需要额外配置。',
        en: "The operator's own messages are always explicit requests; that needs no setting.",
      },
      /** 准入表只有一行：操作者本人。 */
      rows: () => [{
        id: OPERATOR_ID,
        label: { zh: '操作者本人', en: 'The operator' },
        note: { zh: '总是接收', en: 'Always received' },
        cells: { listedUnaddressed: true, unlistedAddressed: false, unlistedUnaddressed: false },
      }],
    },
  }
}

/** Cordis 插件名，需与 cordis.patch.yml 里的 name 一致。 */
export const name = 'dsh-foreman-dsh'
/** 依赖编排器服务：Source 注册、会话投递、Trigger 投递都从它来。 */
export const inject = ['orchestrator']

/**
 * 插件入口：注册 kind，并订阅主会话里人手输入的消息。
 */
export function apply(ctx: Context): void {
  // 回复投递：主会话就是编排器自己的会话，用 sessions.prompt 幂等投递一条 steer 消息。
  const delivery: DshDelivery = {
    async deliver(id, text, sessionId) {
      const orchestrator = ctx.orchestrator
      await orchestrator.prompt(id, text, sessionId)
    },
  }

  const kind = dshKind(delivery)

  // 把 kind 注册进 Source 注册表；同名重复注册会抛错，effect 保证卸载时清理。
  ctx.effect(() => ctx.orchestrator.sources.register(kind), 'dsh: source kind')

  // 订阅主会话的用户消息：这是本 Source 唯一的事件来源。
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const orchestrator = ctx.orchestrator
    // 只关心主子；worker 会话里人手输入的消息由 Executor 另行处理。
    // 每个工作区各有一条主子，所以这里认的是"是不是主子"，而不是"是不是那唯一的主子"。
    if (!orchestrator.isMaster(String(session.id))) return
    // 只关心用户消息事件。
    if (event.type !== 'user/message') return
    const message = event.data
    // 只接收人手打的消息：我们自己注入的回复与候选卡片带别的 source.kind。
    if (message.source.kind !== 'user') return
    const text = messageText(message.content)
    // 附件跟着需求一起走：执行器会把它们在附件库里的路径写进任务说明，
    // worker 用 read_image / read 打开，而不是只能读到文字。
    const attachments = attachmentRefs(message.content)
    // 纯附件消息也算需求，用一句占位文本占住正文，真正的信息在附件里。
    const demand = text || (attachments.length > 0
      ? (attachments.length === 1 ? '（要求见附件）' : `（要求见 ${attachments.length} 个附件）`)
      : '')
    // 既没有文字也没有附件，没有可执行的内容。
    if (!demand) return
    // 该实例的配置决定工作区；配置还没加载时退化为 undefined，由执行器用默认目录。
    const config = orchestrator.sources.instance<DshConfig>(SOURCE)?.config
    const trigger = dshTrigger({
      messageId: String(message.id),
      sessionId: String(session.id),
      text: demand,
      at: new Date().toISOString(),
      // 主子属于哪个工作区，这条需求就落在哪个目录；实例配置只作为兜底。
      workspace: orchestrator.workspaceOf(String(session.id)) ?? (config?.workspace || undefined),
      attachments,
    })
    // 走 Passes 而不是 Engine：它除了入库还会调度下一轮评估。
    // receive 可能同步抛错，那样后面的 .catch 根本挂不上；用 async 包一层，同步与异步的失败都落到同一个处理里。
    void (async () => { await orchestrator.receive(trigger) })().catch((error: unknown) => {
      // 摄取失败不该打断会话，但必须留下可定位的记录；不能指望"下一条消息"充当重试。
      ctx.logger.warn('dsh source: trigger %s was not ingested: %s', trigger.id, String(error))
    })
  }), 'dsh: operator messages')
}
