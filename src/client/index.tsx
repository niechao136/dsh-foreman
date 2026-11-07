/** Browser plugin entry point registering the sidebar icon, main management panel, and Plugin Manager config view. */
import { useCallback, useEffect, useRef } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { openKnownSession, SessionNavigationError } from '../navigation.ts'
import { App } from './app.tsx'
import { PluginConfig, usePageForm } from './deployment.tsx'
import { keepFrameInPlace } from './frame.ts'
import { en, zh } from './locales.ts'
import type { T } from './text.ts'

type ClientContext = Context & { sessions: ISessions }
const NS = 'dshSuperagent'
const PANEL_ID = 'dsh-foreman' as MainPanelId
const ENTRY = 'dsh-foreman'

function HammerIcon({ size }: SidebarPanelIconOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 3.5h9l3.5 1.75v2.5L15 9.5H6a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" /><path d="M10 9.5v10.25a1.75 1.75 0 0 0 3.5 0V9.5" /><path d="M10 15.5h3.5" />
  </svg>
}

/** Mounted panel wrapper; cancels any pending Session navigation when a new one starts or the panel unmounts. */
function Mounted({ ctx, t }: { ctx: ClientContext; t: T }) {
  const pending = useRef<AbortController>(undefined)
  useEffect(() => () => { pending.current?.abort() }, [])
  const openSession = useCallback(async (id: string) => {
    pending.current?.abort()
    const request = new AbortController(); pending.current = request
    try {
      await openKnownSession(ctx.sessions, id as SessionId, target => { ctx.uiWorkspace.openSession(target) }, request.signal)
    } catch (error) {
      if (error instanceof SessionNavigationError) throw new Error(t(error.code === 'not-ready' ? 'sessionListNotReady' : 'sessionNotListed'))
      throw error
    }
  }, [ctx, t])
  const form = usePageForm(ctx.get('configForms')?.get<Record<string, unknown>>(ENTRY))
  return <App t={t} openSession={openSession} deploymentForm={form} />
}

/** 按钮上的标记属性：既用来找自己，也用来避免重复插入。 */
const ENTRY_ATTR = 'data-main-session-entry'

/**
 * 侧栏工作区组标题行的「主会话」入口。
 *
 * 为什么是 DOM 注入：ui-workspace 把整个侧栏声明成 single 独占插槽，组标题行也没有任何子插槽，
 * 插件用 slots 挂不进去；`data-row-key` 是业务属性（不像 class 带构建哈希），适合当锚点。
 * 打开会话复用现成的 openKnownSession，和面板里跳会话走同一条路。
 */
function installMainSessionEntry(ctx: ClientContext, t: T): () => void {
  // 服务端记着"每个工作区的主子是谁"。整页生命周期里这份账基本不变，取到一次就缓存。
  let known: { masterId?: string; masterIds?: string[] } | undefined
  const mainState = async (): Promise<{ masterId?: string; masterIds?: string[] }> => {
    if (known) return known
    // 拼成绝对地址：相对路径在测试宿主里解析不了，而真实页面里两者等价。
    const url = new URL('/orchestrator/api/state', window.location.href)
    // 取不到就当没有，界面退化成"只有面板、没有侧栏入口"，不影响其他功能。
    const response = await fetch(url, { headers: { 'x-orchestrator-request': '1' } }).catch(() => undefined)
    if (response?.ok !== true) return {}
    known = (await response.json()) as { masterId?: string; masterIds?: string[] }
    return known
  }
  // 某个工作区的主子：服务端按需创建，点一次就有一条，之后再点还是同一条。
  const masterOf = async (workspaceId: string): Promise<string | undefined> => {
    const url = new URL('/orchestrator/api/master', window.location.href)
    url.searchParams.set('workspace', workspaceId)
    const response = await fetch(url, { headers: { 'x-orchestrator-request': '1' } }).catch(() => undefined)
    if (response?.ok !== true) return undefined
    const id = ((await response.json()) as { masterId?: string }).masterId
    // 新建出来的主子也要排进隐藏名单，否则它一会儿就会以普通会话的样子冒出来。
    if (id) {
      known = { ...known, masterIds: [...new Set([...(known?.masterIds ?? []), id])] }
      if (!hidden.includes(id)) { hidden = [...hidden, id]; hide(hidden) }
    }
    return id
  }
  // 主子不占工作区组里的一行：入口按钮就是它的门，列表里再出现一次只是噪音。
  // 没有从 Host 的会话清单里摘掉它 —— 摘掉之后 uiWorkspace.openSession 就不再认这个 id，
  // 入口按钮反而打不开。所以分流留在这一层：数据完整，只有侧栏这里不画。
  // 用 style 而不是删节点，是因为行由 React 渲染，删掉会在下次渲染时又回来。
  const hide = (ids: readonly string[]) => {
    for (const id of ids) {
      // 测试宿主没有 CSS.escape，回退成原样拼接；会话 id 只含字母数字和连字符。
      const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id
      for (const row of document.querySelectorAll<HTMLElement>(`[data-row-key="session:${escaped}"]`)) {
        if (row.style.display !== 'none') row.style.display = 'none'
      }
    }
  }
  // 点开某个工作区的主子；没带工作区时退回默认那一条。
  const open = async (workspaceId?: string) => {
    // 指明了工作区就不能退回默认主子：那会让人以为进了 A，实际打开的是默认工作区。
    // 只有压根没带工作区（比如没有所在组行）时才用默认那条。
    const id = workspaceId ? await masterOf(workspaceId) : (await mainState()).masterId
    if (!id) return
    // 目标会话可能还没出现在列表里（刚启动），openKnownSession 会等到列表就绪。
    await openKnownSession(ctx.sessions, id as SessionId, target => { ctx.uiWorkspace.openSession(target) }, new AbortController().signal)
  }
  // 按钮所在的组行带着工作区 id，所以点哪一组就打开哪一组自己的主子。
  const workspaceOf = (node: HTMLElement): string | undefined => {
    const row = node.closest<HTMLElement>('[data-row-key^="workspace:"]')
    const key = row?.getAttribute('data-row-key') ?? ''
    return key.startsWith('workspace:') ? key.slice('workspace:'.length) : undefined
  }
  /**
   * 插件自己建的会话里，只有主会话被藏起来。
   *
   * `orchestrator-` 是主会话本身，人用行上的 M 气泡进，侧栏再列一行就是重复。
   *
   * `worker-` 以前也藏，理由是「数量会多」。但那让人失去唯一的线索：任务到底在哪台机器、哪个目录里跑。
   * 一张工单派到别的设备时，设备上那条会话就是答案，而它恰恰被藏掉了。现在保留显示：多一行，
   * 换来看得见工作发生的地方。
   */
  const ours = (id: string): boolean => id.startsWith('orchestrator-')
  const rowId = (row: Element): string => (row.getAttribute('data-row-key') ?? '').replace(/^session:/, '')
  /**
   * 收起插件自己的会话行，以及状态目录那一个伪工作区行。
   *
   * 组行一律保留：一个组名下只有主会话或 worker 会话，并不说明这一行没用——人的工作区本来
   * 就可能只挂一条主会话。连组行一起藏会把入口按钮（M 气泡）也带走，侧栏看起来就像工作区蒸发。
   */
  const hideOwn = () => {
    for (const row of document.querySelectorAll<HTMLElement>('[data-row-key^="session:"]')) {
      // Worker Sessions are deliberately NOT hidden: they are where the work actually happens, and hiding them left
      // a person unable to find the Session a dispatched ticket ran in.
      if (!ours(rowId(row))) continue
      if (row.style.display !== 'none') row.style.display = 'none'
    }
    for (const row of document.querySelectorAll<HTMLElement>('[data-row-key^="workspace:"]')) {
      // 状态目录本身（~/.dsh/state/superagent）会被宿主当成一个「工作区」列出来，标题就是目录名；
      // 它只是插件放库和诊断文件的地方，不是人的工作区，所以只收这一行。
      const label = (row.textContent ?? '').trim()
      if (label === 'superagent' && row.style.display !== 'none') row.style.display = 'none'
    }
  }
  let hidden: string[] = []
  // 名单是服务端给的，而服务端会随着“有人点了别的工作区的入口按钮”而变多。
  // 每次 DOM 变动都重取一遍太费，节流到 3 秒，保证新出现的主子几秒内也被藏掉。
  let syncedAt = 0
  const syncHidden = async () => {
    if (Date.now() - syncedAt < 3_000) return
    syncedAt = Date.now()
    known = undefined
    const state = await mainState()
    if (state.masterIds?.length) { hidden = state.masterIds; hide(hidden) }
  }
  /**
   * 组行的「动作区」：放「…」和「＋」的那一格。
   *
   * 优先认语义标记：桌面端常装 claude-style 这类主题插件，它会给行内各段打
   * `data-dsh-claude-part` 标记，其中动作区是 `row-actions`。
   * 没有标记的宿主退回结构找法：行内「直接子元素里有 <button>」的最深容器。
   * 两样都找不到就返回 undefined，由调用方退回行尾方案。
   */
  const actionsOf = (row: HTMLElement): HTMLElement | undefined => {
    const tagged = row.querySelector<HTMLElement>('[data-dsh-claude-part~="row-actions"]')
    if (tagged !== null) return tagged
    let found: HTMLElement | undefined
    for (const element of row.querySelectorAll<HTMLElement>('*')) {
      // 按钮自己不算容器；只看「子元素就是按钮」的容器。
      if (element.tagName === 'BUTTON') continue
      if ([...element.children].some(child => child.tagName === 'BUTTON')) found = element
    }
    return found
  }
  // 侧栏结构样本：一页只回传一次，落盘在 stateDir/diagnostics 下。
  // 只做诊断，失败不影响功能，所以吞掉错误。
  let dumped = false
  const dump = (row: HTMLElement, strategy: string) => {
    if (dumped) return
    dumped = true
    // 样本取整条侧栏：分组标题、行内各段、动作区都在一起，才好判断额外的注入点在哪。
    let root = row
    for (let parent = row.parentElement; parent && parent.querySelectorAll('[data-row-key]').length > 1; parent = parent.parentElement) root = parent
    const url = new URL('/orchestrator/api/sidebar-dom', window.location.href)
    void fetch(url, {
      method: 'POST',
      headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ html: root.outerHTML.slice(0, 190_000), strategy }),
    }).catch(() => undefined)
  }
  // DSH 内核给「没归到工作区的会话桶」的固定文案来自它自己的 i18n 表（group.ungrouped），
  // 插件改不了那张表，所以在这一行渲染出来之后把标签改写成本产品对外的叫法。
  const UNGROUPED = ['未分组', 'Ungrouped']
  const relabel = () => {
    for (const row of document.querySelectorAll<HTMLElement>('[data-row-key^="workspace:"]')) {
      // 标签既可能在行内某一段里，也可能直接是行的文本子节点，两处都看。
      for (const node of [row, ...row.querySelectorAll<HTMLElement>('*')]) {
        for (const child of node.childNodes) {
          if (child.nodeType !== Node.TEXT_NODE) continue
          const text = child.textContent?.trim() ?? ''
          if (UNGROUPED.includes(text)) child.textContent = 'chat'
        }
      }
    }
  }
  const insert = () => {
        // 隐藏排在插入之后：同一轮 DOM 变动里先保证入口在，再把列表项压掉。
    hide(hidden)
    for (const row of document.querySelectorAll<HTMLElement>('[data-row-key^="workspace:"]')) {
      // 已经有按钮说明这一行处理过了，跳过可以避免每次 DOM 变动都重建节点。
      if (row.querySelector(`[${ENTRY_ATTR}]`)) continue
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute(ENTRY_ATTR, '1')
      button.title = t('mainEntry')
      button.setAttribute('aria-label', t('mainEntry'))
      // 入口画成一枚气泡，气泡里是 M（main）：圆形带一个左下角的尖，读起来像一条消息，
      // 而且比星号更贴近「这是主会话」的含义，也不会被误认成收藏。
      button.textContent = 'M'
      // 摆在动作区里（和「…」「＋」并排）：间距由动作区自己的 gap 决定，所以 margin 归零。
      button.style.cssText = 'display:inline-flex;flex:0 0 auto;align-items:center;justify-content:center;'
        + 'width:18px;height:18px;margin:0;padding:0;border:1px solid currentColor;'
        // 三个角是圆的，左下角收成小圆角，看起来就是一个气泡的尾巴。
        + 'border-radius:50% 50% 50% 5px;background:transparent;color:inherit;opacity:.55;'
        + 'cursor:pointer;font-size:9px;font-weight:600;line-height:1;letter-spacing:0'
      button.addEventListener('mouseenter', () => { button.style.opacity = '1' })
      button.addEventListener('mouseleave', () => { button.style.opacity = '.55' })
      // 这一行整行可拖拽（draggable="true"）：鼠标按下如果冒泡到行上就会启动原生拖拽，
      // 拖拽一开始 click 就不再派发，按钮表现为"点不动"。所以在按下阶段就拦掉。
      button.draggable = false
      button.addEventListener('pointerdown', event => { event.stopPropagation() })
      button.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation() })
      // 阻止冒泡：这一行本身可点击（折叠/展开工作区），点按钮不该顺带切换。
      button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void open(workspaceOf(button)) })
      // 和「…」「＋」排在一起：动作区本来就在鼠标移入时才显形，按钮跟着它一起出现，
      // 不再占着行首/行尾的位置，也不会压住别的按钮。
      const actions = actionsOf(row)
      if (actions !== undefined) {
        actions.append(button)
        dump(row, 'actions')
      } else {
        // 兜底：贴行尾，并用 order 压到最后，免得主题插件给行内其它段排过序。
        button.style.order = '99'
        button.style.margin = '0 0 0 2px'
        row.append(button)
        dump(row, 'row-tail')
      }
    }
    relabel()
    hideOwn()
    void syncHidden()
  }
  // 侧栏是 React 渲染的，重渲染会抹掉外部插入的节点和行上的 display，所以持续观察并补回。
  const observer = new MutationObserver(insert)
  observer.observe(document.body, { childList: true, subtree: true })
  insert()
  // 先把手里的主子取到，隐藏才能开始生效；拿不到就只保留按钮，不影响使用。
  void mainState().then(state => { if (state.masterIds?.length) { hidden = state.masterIds; insert() } })
  return () => observer.disconnect()
}

export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']
/** Registers the panel, sidebar icon, and Plugin Manager config view; `configForms` is optional (without it, machine settings are read-only). */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-foreman: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
    (props: { t: T }) => <Mounted ctx={ctx} t={props.t} />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => t('panel'), locale: NS }, HammerIcon))
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: `${ENTRY}#${ENTRY}`, locale: NS },
    (props: PluginConfigViewProps & { t: T }) => <PluginConfig t={props.t} view={props.view} form={props.form} />))
  // 侧栏每个工作区组标题行都放一个主会话入口；卸载时断开观察，避免留下活着的监听器。
  ctx.effect(() => installMainSessionEntry(ctx, t), 'dsh-foreman: sidebar main-session entry')
  // 宿主文档被任何 focus/scrollIntoView 顶走时立刻拉回，免得底部露出一条窗口背景色（「黑下巴」）。
  ctx.effect(() => keepFrameInPlace(), 'dsh-foreman: keep the host frame from scrolling')
}
