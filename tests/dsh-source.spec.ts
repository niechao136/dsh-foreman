// 本地 Source 的单元测试：消息文本、Trigger 形状、回复投递、实例配置。
// 这些都不依赖 Cordis 运行时，因此可以直接调纯函数验证。
import { expect, it, vi } from 'vitest'
import { sep } from 'node:path'
import { ATTACHMENTS_ROOT, OPERATOR_ID, SOURCE, apply, attachmentPath, attachmentRefs, dshKind, dshTrigger, isAttachmentId,
  messageText } from '../src/sources/dsh.ts'
import type { OutboundMessage } from '../src/core/index.ts'
import { startRuntime } from './fixtures/host.ts'

// —— 一条用户消息 → 文本 ——
it('keeps only the text blocks of a user message', () => {
  // 单个文本块原样返回
  expect(messageText([{ type: 'text', text: '把侧栏按钮做出来' }])).toBe('把侧栏按钮做出来')
  // 非文本块（图片、工具结果）被跳过，文本块之间用换行连接
  expect(messageText([{ type: 'text', text: '上半' }, { type: 'image' }, { type: 'text', text: '下半' }])).toBe('上半\n下半')
  // 空内容 → 空串（调用方据此跳过，不产生空 Trigger）
  expect(messageText([])).toBe('')
})

// —— Trigger 形状：这是进 Intake 的唯一数据结构，字段错一个就路由不到 ——
it('turns one operator message into a direct Trigger on that Session', () => {
  const trigger = dshTrigger({ messageId: 'm-1', sessionId: 's-1', text: '把侧栏按钮做出来', at: '2026-11-01T08:00:00.000Z' })
  // id 用消息 id 派生，保证同一条消息重复投递时被 Intake 去重
  expect(trigger.id).toBe(`${SOURCE}:m-1`)
  expect(trigger.source).toBe(SOURCE)
  // 线程就是发起它的那个会话：回复能回到同一个地方
  expect(trigger.threads).toEqual([{ source: SOURCE, id: 's-1' }])
  // 发起人是操作者本人，且标记 human
  expect(trigger.actor).toEqual({ source: SOURCE, id: OPERATOR_ID })
  expect(trigger.human).toBe(true)
  // 直接对人说话，不是被 @ 提及
  expect(trigger.addressed).toBe('direct')
  expect(trigger.text).toBe('把侧栏按钮做出来')
  // 回复地址带 sessionId，channel.send 用它决定回到哪个会话
  expect(trigger.channel).toEqual({ source: SOURCE, thread: 's-1', address: { sessionId: 's-1' } })
  expect(trigger.meta).toMatchObject({ messageId: 'm-1', sessionId: 's-1' })
})

// —— 回复投递：Channel 只负责把文本交给 delivery，失败要抛错让 Outbox 重试 ——
it('sends a reply back to the Session that asked', async () => {
  const deliver = vi.fn(async () => {})
  const kind = dshKind({ deliver })
  const message = { id: 'r-1', text: '收到，已经建 Ticket', kind: 'acknowledgement',
    channel: { source: SOURCE, thread: 's-1', address: { sessionId: 's-1' } } } as OutboundMessage
  const result = await kind.channel?.send({} as never, message)
  expect(result).toBe('sent')
  // 第三个参数是归属会话：缺了它回复会进默认主子，多主会话下等于发错人。
  expect(deliver).toHaveBeenCalledWith('r-1', '收到，已经建 Ticket', 's-1')
})

// —— 实例配置：workspace 可留空，留空表示用执行器默认目录 ——
it('accepts an empty instance config and defaults the workspace to empty', () => {
  const kind = dshKind({ deliver: async () => {} })
  expect(kind.schema.parse({})).toEqual({ workspace: '' })
  expect(kind.schema.parse({ workspace: '/tmp/project' })).toMatchObject({ workspace: '/tmp/project' })
  // 相对路径在保存配置时就被拒绝，避免工单创建后才暴露错误。
  expect(() => kind.schema.parse({ workspace: 'relative/project' })).toThrow()
})

// —— 这个 Source 没有外部连接，所以不应该声明任何健康条目 ——
it('declares no health entries: it has no external connection', () => {
  expect(dshKind({ deliver: async () => {} }).health).toEqual([])
})

// —— 端到端：主会话里人手打的一句话，真的会变成一条 Trigger ——
it('turns a message typed into the main Session into a Trigger that reaches Intake', async () => {
  const h = await startRuntime()
  try {
    // 用最小 Context 挂插件：只需要 orchestrator 服务与事件订阅，其余由夹具的 Runtime 提供。
    const ctx = {
      orchestrator: h.runtime,
      effect: (run: () => unknown) => { run() },
      on: (event: string, listener: (...args: never[]) => void) => h.ctx.on(event as never, listener as never),
    }
    apply(ctx as never)

    // 一条消息的两种来源：人手输入（user）与程序注入（别的 kind）。
    const message = (id: string, kind: string, text: string) => ({ id, role: 'user', source: { kind }, content: [{ type: 'text', text }] })

    // 模拟 DSH 把一条人手输入的消息交给主会话。
    h.ctx.emit('session/event', { id: h.runtime.masterId } as never,
      { type: 'user/message', data: message('m-1', 'user', '把侧栏按钮做出来') } as never)
    await Promise.resolve()

    const trigger = h.runtime.store.triggers.get('dsh:m-1')
    // 一句话变成了一条 Trigger，来源与文本都对。
    expect(trigger?.source).toBe('dsh')
    expect(trigger?.text).toBe('把侧栏按钮做出来')
    // 发起人被记成操作者本人，且标记为人类。
    expect(trigger?.actor.id).toBe(OPERATOR_ID)
    expect(trigger?.human).toBe(true)

    // 程序注入的消息不该产生 Trigger，否则会和自己投递的回复打转。
    h.ctx.emit('session/event', { id: h.runtime.masterId } as never,
      { type: 'user/message', data: message('m-2', 'dsh-foreman', '系统注入') } as never)
    await Promise.resolve()
    expect(h.runtime.store.triggers.get('dsh:m-2')).toBeUndefined()

    // worker 会话里的消息也不该产生 Trigger。
    h.ctx.emit('session/event', { id: 'worker-1' } as never,
      { type: 'user/message', data: message('m-3', 'user', '执行环节的消息') } as never)
    await Promise.resolve()
    expect(h.runtime.store.triggers.get('dsh:m-3')).toBeUndefined()
  } finally {
    await h.stop()
  }
})
it('extracts attachment references and resolves them to a readable path', () => {
  // 只有 image / file 块算附件：文本块与工具块都不该出现在清单里
  expect(attachmentRefs([
    { type: 'text', text: '标题' },
    { type: 'image', attachment: { attachmentId: 'ab12', mediaType: 'image/png', bytes: 1 } },
    { type: 'file', attachment: { attachmentId: 'cd34', name: 'a.md', bytes: 2 } },
  ])).toEqual([
    { id: 'ab12', kind: 'image', mediaType: 'image/png', bytes: 1 },
    { id: 'cd34', kind: 'file', name: 'a.md', bytes: 2 },
  ])
  // 没有 attachmentId 的块直接跳过：否则会拼出一个打不开的路径
  expect(attachmentRefs([{ type: 'image', attachment: {} }, { type: 'image' }])).toEqual([])
  // 路径按 DSH 附件库约定拼：objects/<id 前两位>/<id>
  expect(attachmentPath('ab12cd')).toMatch(/\/\.dsh\/attachments\/v1\/objects\/ab\/ab12cd$/)
})

it('refuses attachment ids that are not a plain identifier', () => {
  // 审计报告的中风险项：id 直接拼进路径，含 .. 或 / 就能指到附件库外面。
  for (const id of ['../../../../tmp/secret', '../x', 'ab/12', 'ab\\12', '.', '..', '', 'a'.repeat(129)]) {
    expect(isAttachmentId(id), id).toBe(false)
    expect(attachmentRefs([{ type: 'image', attachment: { attachmentId: id } }]), id).toEqual([])
    expect(() => attachmentPath(id), id).toThrow('Invalid DSH attachment id')
  }
  // 合法 id 原样放在一级目录下，路径不会越过附件库。
  const root = ATTACHMENTS_ROOT + sep
  for (const id of ['ab12', 'ab12cd34', 'FF00', 'A'.repeat(128)]) expect(attachmentPath(id).startsWith(root), id).toBe(true)
  expect(isAttachmentId(42)).toBe(false)
  expect(isAttachmentId(undefined)).toBe(false)
})

it('carries attachments through the Trigger instead of dropping the message', async () => {
  let listener: (...args: any[]) => void = () => {}
  const receive = vi.fn().mockResolvedValue(undefined)
  const prompt = vi.fn().mockResolvedValue(undefined)
  const ctx = {
    // 主子判定：只有 'master' 这条算主子，别的一律当普通会话（与 Runtime.isMaster 同义）。
    orchestrator: { masterId: 'master', isMaster: (id: string) => id === 'master', workspaceOf: () => undefined,
      sources: { instance: () => undefined, register: () => () => {} }, prompt, receive },
    logger: { warn: vi.fn() },
    effect: (run: () => unknown) => { run() },
    on: (_event: string, callback: (...args: any[]) => void) => { listener = callback },
  }
  apply(ctx as never)
  const imageId = 'ab'.repeat(32), fileId = 'cd'.repeat(32)
  const image = { type: 'image', attachment: { attachmentId: imageId, mediaType: 'image/png', bytes: 10 } }
  const file = { type: 'file', attachment: { attachmentId: fileId, name: 'a.md', bytes: 3 } }
  const emit = (id: string, content: object[]) => listener({ id: 'master' }, {
    type: 'user/message', data: { id, source: { kind: 'user' }, content },
  })
  // 图文混发：文字是需求正文，图片跟着 Trigger 一起进链路
  emit('mixed', [{ type: 'text', text: '请修改' }, image])
  // 纯附件：用占位正文占住，不再被当成"没有内容"丢掉
  emit('only', [image, file])
  await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2))
  expect(receive).toHaveBeenCalledWith(expect.objectContaining({ id: 'dsh:mixed', text: '请修改' }))
  expect(receive).toHaveBeenCalledWith(expect.objectContaining({ id: 'dsh:only', text: '（要求见 2 个附件）' }))
  // 附件引用写进 meta：执行器据此拼出可读路径，worker 才能真的打开它们
  expect(receive.mock.calls[0]![0].meta.attachments).toEqual([{ id: imageId, kind: 'image', mediaType: 'image/png', bytes: 10 }])
  expect(receive.mock.calls[1]![0].meta.attachments).toEqual([
    { id: imageId, kind: 'image', mediaType: 'image/png', bytes: 10 },
    { id: fileId, kind: 'file', name: 'a.md', bytes: 3 },
  ])
  // 不再往主会话回"读不到附件"的提示：附件现在会真的传下去
  expect(prompt).not.toHaveBeenCalled()
})
