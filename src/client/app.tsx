/** Root panel shell: sticky app bar with global search and glossary, top-level navigation tabs, and active route view. */
import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { SearchView } from './api.ts'
import { Button, Dot, Icon, Input, Modal, SegmentedTabs } from './controls.tsx'
import type { DeploymentForm } from './deployment.tsx'
import { EvalStatus } from './eval.tsx'
import { ExecutionStatus } from './execution.tsx'
import { ticketMark } from './marks.ts'
import { GLOSSARY, GLOSSARY_VALUES, en, zh, type DshSuperagentKey } from './locales.ts'
import { OverviewPage } from './overview.tsx'
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
import { HOME, TABS, initialLocation, lastSettingsGroup, remember, routeLabel, settingsRoute, tabOf, type Location, type Route,
  type Tab } from './route.ts'
import { SettingsPage } from './settings.tsx'
import { actorName, errorText, reasonLabel, valueLabel, type T, readableMarkers } from './text.ts'
import { ThreadPage } from './thread.tsx'
import { TicketPage } from './ticket.tsx'
import { ErrorLine, Hint, When } from './widgets.tsx'

export interface AppProps {
  t: T; openSession: (sessionId: string) => Promise<void>
  deploymentForm: DeploymentForm
}

/* 术语表分组标题：来源仍是领域概念（配置在「设置 › 来源」），但已不是页面，
   不能再借用删掉的 tab.source 文案，单独给一个 glossaryGroup 键。 */
const GROUP_HEADING: Record<keyof typeof GLOSSARY, DshSuperagentKey> = {
  roles: 'glossaryGroup.roles', source: 'glossaryGroup.source', trigger: 'tab.trigger',
  eval: 'tab.eval', execution: 'tab.execution',
}

function Glossary({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = usePanel()
  const chinese = t('tab.overview') === zh['tab.overview']
  const [own, other] = chinese ? [zh, en] : [en, zh]
  const heading = (group: keyof typeof GLOSSARY) => t(GROUP_HEADING[group])
  return <Modal className="dt-glossary-modal" open={open} onClose={onClose} title={t('glossary')} closeLabel={t('close')}
    description={t('glossaryIntro')} footer={<Button variant="primary" onClick={onClose}>{t('close')}</Button>}>
    <div className="dt-glossary-body">
      <table className="dt-glossary">
        <thead><tr>
          <th>{t(chinese ? 'glossaryChinese' : 'glossaryEnglish')}</th><th>{t(chinese ? 'glossaryEnglish' : 'glossaryChinese')}</th>
          <th>{t('glossaryMeaning')}</th>
        </tr></thead>
        {Object.entries(GLOSSARY).map(([group, keys]) => <tbody key={group}>
          <tr><th colSpan={3} scope="rowgroup" className="dt-glossary-group">{heading(group as keyof typeof GLOSSARY)}</th></tr>
          {keys.map(key => <tr key={key}><td>{own[`term.${key}`]}</td><td>{other[`term.${key}`]}</td><td>{own[`meaning.${key}`]}</td></tr>)}
        </tbody>)}
      </table>
      <p className="dt-legend-title">{t('legendTitle')}</p>
      <ul className="dt-legend">{(['done', 'ongoing', 'warning', 'error', 'idle'] as const).map(state => <li key={state}>
        <Dot state={state} /><span>{t(`legend.${state}`)}</span>
      </li>)}</ul>
      {/* display:contents 抽成 .dt-contents：内联样式散在 JSX 里既难统一也没法在窄屏规则里覆盖。 */}
      <dl className="dt-values">{Object.entries(GLOSSARY_VALUES).map(([group, values]) => <div key={group} className="dt-contents">
        <dt>{own[`term.${group}` as DshSuperagentKey]}</dt>
        <dd>{values.map(key => `${own[key]} ${other[key]}`).join(' · ')}</dd>
      </div>)}</dl>
    </div>
  </Modal>
}

function Highlight({ text, query }: { text: string; query: string }) {
  const index = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  if (index < 0) return <>{text}</>
  return <>{text.slice(0, index)}<mark className="dt-mark">{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>
}
function Result({ name, open, children }: { name: ReactNode; open: (() => void) | undefined; children: ReactNode }) {
  // dt-link 决定 hover/光标样式，必须跟着 open 走：被过滤的条目点了没反应，不能装作可点。
  return <li className={open ? 'dt-row dt-link' : 'dt-row'}><div className="dt-row-main">
    <div className="dt-row-title">{open ? <button type="button" className="dt-open" onClick={open}>{name}</button> : name}</div>
    <div className="dt-row-meta">{children}</div>
  </div></li>
}
function SearchResults({ result, query, onClose }: { result: SearchView; query: string; onClose: () => void }) {
  const { t, navigate } = usePanel()
  const { setup } = usePanelData()
  const empty = !result.items.length && !result.threads.length && !result.tickets.length
  const counts = { tickets: result.tickets.length, threads: result.threads.length, items: result.items.length }
  const go = (route: Route) => () => { onClose(); navigate(route) }
  return <div className="dt-search-results" role="region" aria-label={t('searchLabel')}>
    <div className="dt-search-head">
      <span className="dt-hint">{empty ? t(setup?.accounts?.feishu ? 'searchNone' : 'searchNoneGithub')
        : t(result.items.length >= 20 ? 'searchFoundCapped' : 'searchFound', counts)}</span>
      <Button variant="ghost" size="sm" icon={<Icon name="close" size={14} />} aria-label={t('close')} onClick={onClose} />
    </div>
    {!empty && <ul className="dt-list">
      {result.tickets.map(ticket => <Result key={ticket.id} name={<Highlight text={ticket.title} query={query} />}
        open={go({ page: 'execution', id: ticket.id })}>
        <span>{t('term.ticket')}</span><span>{ticket.stage === 'ended' ? t('ticket.ended') : ticketMark(t, ticket).label}</span>
      </Result>)}
      {result.threads.map(thread => <Result key={thread.key} name={readableMarkers(t, thread.title)} open={go({ page: 'trigger',
        id: thread.key })}>
        <span>{t('term.thread')}</span>
      </Result>)}
      {/* Filtered triggers have no Thread and display their filter reason instead of a link. */}
      {result.items.map(item => <Result key={item.id} name={<Highlight text={readableMarkers(t, item.preview) || t('empty')}
        query={query} />}
        open={item.filtered === undefined ? go({ page: 'trigger', id: item.threads[0]!, query: { trigger: item.id } }) : undefined}>
        <span>{valueLabel(t, 'source', item.source)}</span><span>{actorName(t, item.actor)}</span>
        {item.threadTitle && <span className="dt-ellipsis">{t('inThread', { thread: readableMarkers(t, item.threadTitle) })}</span>}
        {item.filtered !== undefined && <span>{t('searchFiltered', { reason: reasonLabel(t, item.filtered) })}</span>}
        {/* 时间统一放最后：列表行都是「标签→状态→来源→时间」，搜索结果不能自成一套读序。 */}
        <When at={item.at} />
      </Result>)}
    </ul>}
  </div>
}

/**
 * 顶部应用栏（v2）：左侧产品名 + 面包屑，右侧全局搜索、术语表、打开主会话。
 * 从「内容区里的一条工具栏」提到最外层吸顶，页面滚动时入口始终在视野内。
 */
function AppBar({ masterId, crumbs }: { masterId: string | undefined; crumbs: readonly string[] }) {
  const { t, call, openSession, notify } = usePanel()
  const [glossary, setGlossary] = useState(false)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ query: string; value: SearchView }>()
  // Ignore responses from superseded or cleared search requests.
  const latest = useRef(0)
  const show = (value?: { query: string; value: SearchView }) => { latest.current++; setResult(value) }
  const search = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (!result) return
    const close = (event: PointerEvent) => { if (!search.current?.contains(event.target as Node)) show() }
    document.addEventListener('pointerdown', close)
    return () => { document.removeEventListener('pointerdown', close) }
  }, [result])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const text = query.trim()
    if (!text) { show(); return }
    const request = ++latest.current
    call('GET search', { query: { q: text } }).then(value => { if (request === latest.current) setResult({ query: text, value }) },
      failure => { if (request === latest.current) notify(errorText(failure)) })
  }
  return <header className="dt-appbar">
    <div className="dt-appbar-lead">
      <span className="dt-appbar-brand">{t('title')}</span>
      {/* 面包屑：页面名 → 记录名，最后一段是当前位置，不参与点击（详情页的返回走 PageHead）。 */}
      <span className="dt-crumbs">
        {crumbs.map((crumb, index) => <Fragment key={`${index}-${crumb}`}>
          {index > 0 && <Icon name="chevron-right" size={12} />}
          <span className="dt-crumb" data-current={index === crumbs.length - 1 || undefined}>{crumb}</span>
        </Fragment>)}
      </span>
    </div>
    <div className="dt-appbar-actions">
      <form ref={search} className="dt-search" role="search" onSubmit={submit} onKeyDown={event => { if (event.key === 'Escape') show() }}>
        <Input type="search" icon={<Icon name="search" />} value={query} placeholder={t('searchPlaceholder')} aria-label={t('searchLabel')}
          onChange={event => { setQuery(event.target.value); if (!event.target.value) show() }} />
        {result && <SearchResults result={result.value} query={result.query} onClose={() => { show() }} />}
      </form>
      <Button variant="ghost" size="sm" icon={<Icon name="question" />} aria-label={t('glossary')} title={t('glossary')} aria-haspopup="dialog"
        onClick={() => setGlossary(true)} />
      <Button variant="outline" size="sm" icon={<Icon name="session" size={14} />} disabled={!masterId}
        onClick={() => { if (masterId) openSession(masterId).catch(failure => notify(errorText(failure))) }}>{t('openMaster')}</Button>
    </div>
    <Glossary open={glossary} onClose={() => setGlossary(false)} />
  </header>
}

/**
 * 页面骨架（v2）：AppBar（吸顶）→ 一级导航栏（吸顶）→ 唯一滚动内容区。
 * 导航从左侧竖排 rail 改成顶部横排，内容区因此拿到全宽，详情页才放得下右栏。
 */
function Pages({ route, openTab, deploymentForm }: { route: Route; openTab: (tab: Tab) => void; deploymentForm: DeploymentForm }) {
  const { t } = usePanel()
  const { state, error, reload } = usePanelData()
  // Keep the active tab scrolled into view on narrow screens when routes change via links.
  useEffect(() => { document.getElementById(`dt-tab-${tabOf(route)}`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) }, [route])
  // 等待与失败都复用共享组件：错误走 errorText 并给重试，避免这里自己拼一段不可重试的原文。
  const waiting = error ? <ErrorLine error={errorText(error)} title={t('loadFailed')} onRetry={reload} />
    : <Hint>{t('loading')}</Hint>
  const page = (() => {
    switch (route.page) {
      case 'overview': return <OverviewPage />
      // 评估页：判定流水 + 右栏解剖，筛选与 24 小时窗口都在路由里。
      case 'eval': return <EvalStatus filter={route.query?.filter ?? 'all'} window={route.query?.window}
        paused={!!state?.paused} />
      // 线程详情是评估页的下一层，一级导航仍高亮「评估」。
      case 'trigger': return <ThreadPage key={route.id} id={route.id} target={route.query?.trigger} />
      case 'execution': return route.id !== undefined ? <TicketPage key={route.id} id={route.id} />
        : state ? <ExecutionStatus filter={route.query?.filter ?? 'open'} state={state} reload={reload} /> : waiting
      case 'settings': return state ? <SettingsPage key={state.masterId} group={route.query.group} query={route.query} state={state}
        deploymentForm={deploymentForm} /> : waiting
    }
  })()
  // 面包屑：一级是页面名，详情页再补一段记录类型（具体标题由页面内的 PageHead 给出）。
  const crumbs: string[] = [t(`tab.${tabOf(route)}`)]
  if (route.id !== undefined) crumbs.push(routeLabel(t, route))
  return <div className="dt-app">
    <AppBar masterId={state?.masterId} crumbs={crumbs} />
    <div className="dt-navbar-wrap">
      <SegmentedTabs variant="bar" label={t('pagesLabel')} value={tabOf(route)} onChange={openTab}
        items={TABS.map(value => ({ value, label: t(`tab.${value}`), id: `dt-tab-${value}`, panelId: 'dt-page' }))} />
    </div>
    <div className="dt-content">
      {/* 已经有数据时刷新失败：给出可重试的提示，同时不打断下面继续显示的内容。 */}
      {error && state && <ErrorLine error={errorText(error)} title={t('loadFailed')} onRetry={reload} />}
      <main id="dt-page" role="tabpanel" aria-labelledby={`dt-tab-${tabOf(route)}`} className="dt-main">{page}</main>
    </div>
  </div>
}

/** Root panel component managing route history and shared panel state. */
export function App({ t, openSession, deploymentForm }: AppProps) {
  const [location, setLocation] = useState(initialLocation)
  useEffect(() => { remember(location) }, [location])
  // Preserve the last opened settings group across navigation so the Settings tab reopens at it.
  const move = useCallback((next: (current: Location) => Pick<Location, 'route' | 'stack'>) =>
    setLocation(current => ({ ...next(current), group: lastSettingsGroup(current) })), [])
  /** Navigates to `route`; `replace` swaps the current entry (filters, paging) instead of pushing a back step. */
  const navigate = useCallback((route: Route, replace = false) => move(current => ({ route,
    stack: replace ? current.stack : [...current.stack, current.route].slice(-20) })), [move])
  const back = useCallback(() => move(current => ({ route: current.stack.at(-1) ?? HOME, stack: current.stack.slice(0, -1) })), [move])
  const openTab = useCallback((tab: Tab) => move(current => ({ stack: [], route: tab === 'settings'
    ? settingsRoute(lastSettingsGroup(current)) : { page: tab, id: undefined } })), [move])
  return <PanelProvider t={t} openSession={openSession} navigate={navigate} back={back} backLabel={routeLabel(t, location.stack.at(-1) ?? HOME)}>
    <Pages route={location.route} openTab={openTab} deploymentForm={deploymentForm} />
  </PanelProvider>
}
