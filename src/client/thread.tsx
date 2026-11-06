/** Thread detail page: Trigger timeline with gap-free pagination, Decisions, subscribed Tickets, and correlated Threads. */
import { useEffect, useState, type ReactNode } from 'react'
import { ApiError, usePoll, type ThreadPageView, type TriggerRow } from './api.ts'
import { DisclosureRow, Icon, Tag } from './controls.tsx'
import { decisionMark } from './marks.ts'
import { useAction, usePanel } from './provider.tsx'
import { DecisionLine, Earlier, TicketLine, automatedRuns } from './rows.tsx'
import { actorName, errorText, readableMarkers, reasonLabel, valueLabel, when, type T } from './text.ts'
import { ActionLink, Card, ClampText, ConfirmButton, DetailLayout, Empty, ErrorLine, Hint, LoadMore, LoadState, LoopTrack, PageHead,
  StatusLine, When, type LoopStep } from './widgets.tsx'

/** Disposition tags for a Trigger; omits `ignore` (the common case) and suppresses fanout tags when every target Ticket is already listed in `subscribed`. */
function triggerTags(t: T, trigger: TriggerRow, subscribed?: Set<string>): ReactNode {
  const d = trigger.disposition
  const tags: ReactNode[] = []
  if (d.queued) tags.push(<Tag key="q" tone="info">{t('dispositionQueued')}</Tag>)
  else if (d.evaluating) tags.push(<Tag key="e" tone="info">{t('dispositionEvaluating')}</Tag>)
  else if (d.filtered) tags.push(<Tag key="f" tone="neutral">{t('tagFiltered', { reason: reasonLabel(t, d.filtered) })}</Tag>)
  else if (d.decision && d.decision.outcome !== 'ignore') {
    const { tone, label } = decisionMark(t, d.decision.outcome)
    tags.push(<Tag key="d" tone={tone}>{label}</Tag>)
  }
  if (d.delivered) tags.push(<Tag key="o" tone="info" title={t('dispositionDeliveredHint')}>{t('dispositionDelivered')}</Tag>)
  else if (d.fanout.length && !(subscribed && d.fanout.every(id => subscribed.has(id)))) tags.push(<Tag key="o"
    tone="info">{t('dispositionFanout', { count: d.fanout.length })}</Tag>)
  return tags
}

function TriggerItem({ trigger, earlier, target, subscribed, requeue }: {
  trigger: TriggerRow; earlier: TriggerRow[]; target: string | undefined; subscribed: Set<string>
  requeue: { busy: boolean; run: () => void } | undefined
}) {
  const { t, navigate } = usePanel()
  const ticketId = trigger.disposition.decision?.ticketId
  const scroll = (element: HTMLLIElement | null) => {
    if (element && target === trigger.id
      && !element.dataset.scrolled) { element.dataset.scrolled = '1'; element.scrollIntoView?.({ block: 'center' }) }
  }
  // 状态类名用拼接代替模板字面量，输出与原表达式一致。
  return <li id={'trigger-' + trigger.id} className={'dt-event' + (target === trigger.id ? ' dt-highlight' : '')
    + (trigger.human ? '' : ' dt-event-quiet')} ref={scroll}>
    <div className="dt-event-foot"><strong className="dt-event-actor">{actorName(t, trigger.actor)}</strong><When
      at={trigger.at} /></div>
    <ClampText text={readableMarkers(t, trigger.text || trigger.preview)} />
    <Earlier items={earlier} />
    {trigger.disposition.handbacks.map(item => <Hint key={item.ticketId}>{t('handedBack', { ticket: item.title,
      reason: item.reason })}</Hint>)}
    <div className="dt-event-foot">
      {triggerTags(t, trigger, subscribed)}
      {ticketId && !subscribed.has(ticketId) && <button type="button" className="dt-textlink dt-icon-link"
        onClick={() => navigate({ page: 'execution', id: ticketId })}>{t('openTicket')}</button>}
      {requeue && <button type="button" className="dt-textlink dt-icon-link dt-reveal" disabled={requeue.busy} aria-busy={requeue.busy}
        onClick={requeue.run}>
        <Icon name="refresh" size={13} />{t('requeue')}
      </button>}
    </div>
  </li>
}
interface Older { triggers: TriggerRow[]; cursor: string | null }
const overlaps = (some: TriggerRow[], others: TriggerRow[]) => some.some(item => others.some(other => other.id === item.id))
const byTime = (triggers: TriggerRow[]) => [...new Map(triggers.map(item => [item.id, item])).values()]
  .sort((a, b) => a.at.localeCompare(b.at))
const gapBetween = (newest: ThreadPageView, older: Older | undefined): boolean =>
  !!older && newest.earlier !== null && !overlaps(newest.timeline, older.triggers)
function mergeTimeline(newest: ThreadPageView, older: Older | undefined): ThreadPageView {
  if (!older || newest.earlier === null || gapBetween(newest, older)) return newest
  return { ...newest, timeline: byTime([...older.triggers, ...newest.timeline]), earlier: older.cursor }
}
const PAGE = 50
/**
 * Manage a Thread's timeline across live polling, deep-linked `target` Triggers, and manual pagination.
 * Fills any gap between the latest polled page and older loaded pages before merging so the timeline remains contiguous.
 */
function useThreadTimeline(key: string, target: string | undefined) {
  const { call, notify } = usePanel()
  const [older, setOlder] = useState<Older>()
  const { data: newest, error, reload } = usePoll(() => call('GET threads/:key', { key, query: { limit: PAGE } }), [key])
  const data = newest && mergeTimeline(newest, older)
  const read = (id: string) => !!newest?.timeline.some(item => item.id === id) || !!older?.triggers.some(item => item.id === id)
  const missing = !!target && !!newest && !read(target)
  useEffect(() => {
    if (!missing) return
    let active = true
    call('GET threads/:key', { key, query: { limit: PAGE, around: target } }).then(page => {
      if (active) setOlder({ triggers: page.timeline, cursor: page.earlier })
    }, (failure: unknown) => { if (active) notify(errorText(failure)) })
    return () => { active = false }
  }, [missing, call, key, target, notify])
  const gap = !!newest && gapBetween(newest, older)
  useEffect(() => {
    if (!gap || !newest || !older) return
    let active = true
    const fill = async () => {
      let run = newest.timeline, cursor = newest.earlier
      while (cursor !== null && !overlaps(run, older.triggers)) {
        const page = await call('GET threads/:key', { key, query: { limit: PAGE, before: cursor } })
        run = [...page.timeline, ...run]; cursor = page.earlier
      }
      if (active) setOlder({ triggers: byTime([...older.triggers, ...run]), cursor: overlaps(run, older.triggers) ? older.cursor : cursor })
    }
    fill().catch((failure: unknown) => { if (active) notify(errorText(failure)) })
    return () => { active = false }
  }, [gap, newest, older, call, key, notify])
  const earlier = useAction(async (shown: ThreadPageView) => {
    const page = await call('GET threads/:key', { key, query: { limit: PAGE, before: shown.earlier! } })
    setOlder({ triggers: [...page.timeline, ...shown.timeline], cursor: page.earlier })
  })
  return { data, error, reload, earlier }
}
export function ThreadPage({ id, target }: { id: string; target?: string }) {
  const { t, call, navigate, notify } = usePanel()
  const [decisionsOpen, setDecisionsOpen] = useState(false)
  const { data, error, reload, earlier } = useThreadTimeline(id, target)
  const requeue = useAction(async (trigger: string) => {
    const result = await call('POST triggers/:id/requeue', { id: trigger })
    if (!result.queued) notify(t('requeueAlready'))
  }, { reload })
  // 记录已被删除（404）时是终态：继续渲染缓存的时间线会让人误以为线程还活着，因此直接切空态。
  if (error instanceof ApiError && error.missing) return <>
    <PageHead title={t('term.thread')} />
    <Empty icon="question" title={t('notFound')} hint={t('threadNotFound')} />
  </>
  if (!data) return <><PageHead
    title={t('term.thread')} />{error ? <LoadState error={error} loading={false} onRetry={() => { void reload() }}
      /> : <LoadState loading />}</>
  const subscribed = new Set(data.tickets.map(ticket => ticket.id))
  // Never fold a deep-linked `target` Trigger into an automated run.
  const sender = (trigger: TriggerRow) => !trigger.human && trigger.id !== target
    ? trigger.actor.source + ':' + trigger.actor.id : undefined
  const unsubscribe = async () => {
    const result = await call('POST threads/:key/unsubscribe', { key: data.key })
    if (result.context_delivery === 'pending') notify(t('unsubscribePending'))
    await reload()
  }
  // 决策闭环：触发 → 决策 → 回报（工单把触发交还）→ 评估 → 回流策略。数字全部来自本次 GET threads/:key
  // 的返回（timeline / decisions / evaluating / pending）与已加载的旧页，不额外请求。
  const handbacks = data.timeline.reduce((sum, item) => sum + item.disposition.handbacks.length, 0)
  const judged = data.decisions.length
  // current：有评估在跑＝评估；有排队等评估的触发＝等决策；有在打工单＝等回报；其余没有当前步。
  const currentStep = data.evaluating ? 3 : data.stage === 'queued' ? 1 : data.stage === 'subscribed' ? 2 : -1
  const scrollTo = (section: string) => () => document.getElementById(section)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  const loopSteps: LoopStep[] = [
    // 触发：这条线程已加载的触发条数（加载更多后同步变多）。
    { label: t('flowTriggeredLabel'), value: data.timeline.length, onSelect: scrollTo('thread-timeline'),
      state: data.timeline.length > 0 ? 'done' : 'pending' },
    // 决策：决策列表条数；没有决策时显式写「未开始」。
    { label: t('flowDecidedLabel'), value: judged > 0 ? judged : t('loopPending'),
      onSelect: judged > 0 ? scrollTo('thread-decisions') : undefined,
      state: currentStep === 1 ? 'current' : judged > 0 ? 'done' : 'pending' },
    // 回报：工单把触发交还并带原因的条数（handbacks）。
    { label: t('flowReportedLabel'), value: handbacks, onSelect: scrollTo('thread-timeline'),
      state: currentStep === 2 ? 'current' : handbacks > 0 ? 'done' : 'pending' },
    // 评估：评估中显示在评的触发数，否则显示已评估的决策数。
    { label: t('flowEvaluatingLabel'), value: data.evaluating ? data.evaluating.triggers : judged,
      state: currentStep === 3 ? 'current' : judged > 0 && !data.evaluating ? 'done' : 'pending' },
    // 回流：还没回到策略的触发数（pending = 正在等评估的）。
    { label: t('flowReturnedLabel'), value: data.pending,
      state: judged > 0 && data.pending === 0 && !data.evaluating ? 'done' : 'pending' },
  ]
  return <>
    <PageHead title={readableMarkers(t, data.title)}>{data.url && <ActionLink href={data.url}>{t('openOriginal')}</ActionLink>}</PageHead>
    {/* 刷新失败但内容仍在：错误行给重试，页面继续展示上一次的数据，不静默吞掉失败。 */}
    {error && <LoadState error={error} loading={false} onRetry={() => { void reload() }} />}
    {/* 决策闭环：把「触发 → 决策 → 回报 → 评估 → 回流」摊在一屏里，当前步由 thread stage 推导，
        决策/回报两步可点击滚到对应区块。 */}
    <Card title={t('decisionLoop')} hint={t('loopHint')}>
      <LoopTrack steps={loopSteps} />
    </Card>
    {/*
      详情页模板（v2）：主列 = 状态行 / 评估横幅 / 订阅工单 / 决定 / 关联线程 / 时间线；
      右栏 = 危险操作（退订）。Thread 的元信息本来就在状态行里，右栏不再重复一份。
    */}
    <DetailLayout
      main={<>
        <StatusLine>
          <span>{valueLabel(t, 'source', data.source)}</span>
          <span>{t('threadLatest', { time: when(data.lastAt, t('lang')) })}</span>
          <span>{t('threadCreated', { time: when(data.createdAt, t('lang')) })}</span>
        </StatusLine>
        {data.evaluating && <p className="dt-banner">
          {t('evaluatingBanner', { count: data.evaluating.triggers, strength: valueLabel(t, 'strength', data.evaluating.strength),
            deadline: when(data.evaluating.deadline, t('lang')) })}
        </p>}
        {/* 轮询错误可能是长文本：ErrorLine 自带 clamp 与 title，截断后仍能悬停看全文。 */}
        {data.pollError && <ErrorLine error={t('pollFailed', { error: data.pollError })} clamp />}
        {data.tickets.length > 0 && <Card title={t('subscribedTickets')}
          actions={<span className="dt-count">{data.tickets.length}</span>}>
          <ul className="dt-list">{data.tickets.map(ticket => <TicketLine key={ticket.id} ticket={ticket}
            context={data.context.includes(ticket.id)} />)}</ul>
        </Card>}
        {/* 决定是一组可折叠的次要内容，保留 DisclosureRow（.dt-disclosure 钩子），不改成 Card 卡片。 */}
        {/* 包裹层只提供滚动锚点 id，DisclosureRow 的折叠行为不变。 */}
        {data.decisions.length > 0 && <div id="thread-decisions"><DisclosureRow icon={<Icon name="decision" />} title={t('threadDecisions',
          { count: data.decisions.length })} open={decisionsOpen}
          onToggle={() => setDecisionsOpen(!decisionsOpen)}>
          <div className="dt-disclosure-body"><ul className="dt-list">{data.decisions.map(decision => <DecisionLine key={decision.id}
            decision={decision} />)}</ul></div>
        </DisclosureRow></div>}
        {data.correlated.length > 0 && <Card title={t('term.correlation')}>
          <ul className="dt-plain-list">{data.correlated.map(item => <li key={item.key}>
            <button type="button" className="dt-textlink" onClick={() => navigate({ page: 'trigger', id: item.key })}>{readableMarkers(t,
              item.title)}</button>
          </li>)}</ul>
        </Card>}
        <div id="thread-timeline"><Card title={t('timeline')} actions={<span className="dt-count">{t('newestFirst')}</span>}>
          {data.timeline.length ? <ol className="dt-timeline">{automatedRuns(data.timeline.slice().reverse(), sender).map(({ item,
            earlier: folded }) =>
            <TriggerItem key={item.id} trigger={item} earlier={folded} target={target} subscribed={subscribed}
              requeue={item.actions.requeue ? { busy: requeue.busy, run: () => { void requeue.run(item.id) } } : undefined} />)}</ol>
                : <Empty icon="inbox" title={t('noTriggers')} hint={t('emptyListHint')} />}
          {/* 与三个列表页同一套「加载更多」：LoadMore 原语 + .dt-list-state 容器，不再各页自己拼 Button/div。 */}
          {data.earlier && <div className="dt-list-state"><LoadMore label={t('loadEarlier')} onMore={() => { void earlier.run(data) }} /></div>}
        </Card></div>
      </>}
      aside={data.tickets.length > 0 ? <div className="dt-danger-zone">
        <span className="dt-hint">{t('unsubscribeHint')}</span>
        <ConfirmButton variant="outline" icon="unsubscribe" label={t('unsubscribe')} title={t('unsubscribeTitle')}
          message={t('unsubscribeConfirm', { title: data.title })}
          onConfirm={unsubscribe} />
      </div> : undefined}
    />
  </>
}
