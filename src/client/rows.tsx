/** Shared list rows for Tickets, Threads, and Decisions, plus Source fact chips and automated-message run folding. */
import { useState } from 'react'
import type { DecisionRow, ThreadFacts, ThreadRow, TicketRow } from './api.ts'
import { Icon, Tag } from './controls.tsx'
import { decisionMark, threadMark, ticketMark } from './marks.ts'
import { usePanel } from './provider.tsx'
import { actorName, localized, readableMarkers, reasonLabel, valueLabel } from './text.ts'
import { ActionLink, ConfirmButton, LabelValue, SessionButton, StageMark, When } from './widgets.tsx'

export function TicketLine({ ticket, question, onChanged, context }: {
  ticket: TicketRow; question?: boolean; onChanged?: () => Promise<void>; context?: boolean
}) {
  const { t, call, navigate } = usePanel()
  const status = ticketMark(t, ticket)
  const after = async (request: Promise<unknown>) => { await request; await onChanged?.() }
  const note = question && ticket.note && { ...ticket.note, text: readableMarkers(t, ticket.note.text) }
  const answer = ticket.reply && ticket.stage === 'person' && ticket.action === 'answer' ? ticket.reply : undefined
  // data-state 无条件下发：左侧 2px 状态色条（.dt-ticket::before）以前只在 question 行出现，
  // 导致 failed/blocked 的工单在列表里没有颜色可循，与详情页 StatusLine 的状态标不一致。
  return <li className="dt-row dt-link dt-ticket" data-state={status.dot}>
    <div className="dt-ticket-stage"><StageMark state={status.dot} icon={status.icon} label={status.label} /></div>
    <div className="dt-ticket-body">
      {/* 标题单行省略（.dt-open），只有 title 能给出全文；同时与 Thread/Decision 行一样过 readableMarkers。 */}
      <div className="dt-row-title"><button type="button" className="dt-open" title={ticket.title} onClick={() => navigate({ page: 'execution',
        id: ticket.id })}>{readableMarkers(t, ticket.title)}</button></div>
      <div className="dt-row-meta dt-ticket-meta">
        {ticket.threads.map(thread => <ThreadChip key={thread.key} thread={thread} />)}
        {context && <ContextTag />}
        {ticket.undelivered > 0 && <LabelValue label={t('ticketUndeliveredLabel')} value={ticket.undelivered} />}
        {note ? <span className={note.error ? 'dt-ticket-note dt-ticket-note-error' : 'dt-ticket-note'} title={note.text}>{note.text}</span>
          : <When at={ticket.updatedAt} />}
      </div>
      {/* Always render the actions container so every Ticket row keeps a uniform three-line height. */}
      {/* v2 行原语：操作统一收在行尾的 .dt-row-actions，与详情页的 Assignment 行同一收尾位置。 */}
      <div className="dt-ticket-actions dt-row-actions">
        {answer && <ActionLink href={answer.url} icon="message">{t('answerIn', { source: valueLabel(t, 'source',
          answer.source) })}</ActionLink>}
        {(ticket.actions.retry || ticket.actions.stop) && onChanged && <>
          {ticket.actions.retry && <ConfirmButton variant="outline" icon="refresh" label={t('retry')} title={t('retryTitle')}
            message={t('retryConfirm', { title: ticket.title })}
            onConfirm={() => after(call('POST tickets/:id/retry', { id: ticket.id }))} />}
        </>}
        {/* 工单的 worker 会话在侧栏里是隐藏的（hideOwn 藏掉了 worker-* 行），列表行必须给出入口：
            只要这张工单已经有会话就显示，与它当前在等谁无关（执行中的工单也要能一键打开会话）。 */}
        {ticket.sessionId && <SessionButton variant="outline" sessionId={ticket.sessionId} />}
        {ticket.actions.stop && onChanged && <ConfirmButton variant="outline" icon="stop" label={t('stop')} title={t('stopConfirmTitle')}
          message={t('stopConfirm', { title: ticket.title })}
          onConfirm={() => after(call('POST tickets/:id/stop', { id: ticket.id }))} />}
      </div>
    </div>
  </li>
}

function ContextTag() {
  const { t } = usePanel()
  return <Tag tone="quiet" title={t('contextOnlyHint')}>{t('contextOnly')}</Tag>
}
/** Thread list row; on a Ticket page, \`ticketId\` omits that Ticket from fanout targets and \`context\` marks context-only threads. */
export function ThreadLine({ thread, ticketId, context }: { thread: ThreadRow; ticketId?: string; context?: boolean }) {
  const { t, navigate } = usePanel()
  const live = thread.tickets.filter(ticket => ticket.state === 'open' && ticket.id !== ticketId)
  const { dot, icon, label } = threadMark(t, thread)
  // 用字符串拼接代替模板字面量，输出与原来完全一致（标题 + 可选「等 N 个」）。
  const reaches = live.length > 0 && (live[0]!.title + (live.length > 1 ? t('andMore', { count: live.length - 1 }) : ''))
  return <li className="dt-row dt-link dt-ticket">
    <div className="dt-ticket-stage"><StageMark state={dot} icon={icon} label={label} /></div>
    <div className="dt-ticket-body">
      <div className="dt-row-title">
        <button type="button" className="dt-open" title={thread.pollError} onClick={() => navigate({ page: 'trigger',
          id: thread.key })}>{readableMarkers(t, thread.title)}</button>
      </div>
      <div className="dt-row-quote dt-line">
        {thread.latest && <>{actorName(t, thread.latest.actor)}{t('labelSeparator')}{readableMarkers(t, thread.latest.preview)
          || t('empty')}</>}
      </div>
      <div className="dt-row-meta dt-line">
        <ThreadChip thread={thread} />
        {context && <ContextTag />}
        {thread.pollError ? <span className="dt-line-text dt-error-text">{thread.pollError}</span> : reaches && <LabelValue
          label={t('fanoutTo')} value={reaches} />}
        <When at={thread.lastAt} />
      </div>
    </div>
  </li>
}

/** 判定行。选中进右栏时传 `onSelect`（Eval 页），否则点标题直接跳到它的线程/工单（线程页的披露区）。 */
export function DecisionLine({ decision, selected, onSelect }: {
  decision: DecisionRow; selected?: boolean; onSelect?: () => void
}) {
  const { t, navigate } = usePanel()
  const matched = decision.rules.filter(rule => rule.matched).map(rule => rule.name)
  const mark = decisionMark(t, decision.outcome)
  const preview = readableMarkers(t, decision.preview)
  const reason = decision.reason ? reasonLabel(t, decision.reason) : ''
  // 闭环可见性：行内保留规则命中数与关联工单入口，二者都取自这条决策自身的字段。
  const ticketId = decision.ticketId
  const open = onSelect ?? (() => decision.ticketId ? navigate({ page: 'execution', id: decision.ticketId })
    : navigate({ page: 'trigger', id: decision.thread, query: { trigger: decision.triggerIds[0] ?? '' } }))
  return <li className="dt-row dt-link dt-ticket" data-selected={selected || undefined}
    aria-current={selected ? 'true' : undefined}>
    <div className="dt-ticket-stage"><StageMark state={mark.dot} icon={mark.icon} label={mark.label} /></div>
    <div className="dt-ticket-body">
      <div className="dt-row-title">
        <button type="button" className="dt-open" title={reason || undefined} onClick={open}>
          {decision.ticketTitle ?? (decision.threadTitle ? readableMarkers(t, decision.threadTitle) : preview || t('empty'))}
        </button>
      </div>
      <div className="dt-row-quote dt-line">{preview}</div>
      <div className="dt-row-meta dt-line">
        {reason && <span className="dt-line-text">{reason}</span>}
        {matched.length > 0 && <LabelValue label={t('ruleLabel')} value={matched.join(t('listSeparator'))} />}
        {decision.rules.length > 0 && <LabelValue label={t('rules')} value={matched.length + '/' + decision.rules.length} />}
        <When at={decision.at} />
      </div>
      {/* 关联工单入口收在行尾 .dt-row-actions，与 Ticket/Thread 行收尾位置一致；没有工单时整块不渲染，行高不变。 */}
      {ticketId && <div className="dt-row-actions">
        <button type="button" className="dt-textlink" title={decision.ticketTitle}
          onClick={() => navigate({ page: 'execution', id: ticketId })}>{t('flowTickedLabel')}</button>
      </div>}
    </div>
  </li>
}

function ThreadChip({ thread }: { thread: Pick<ThreadFacts, 'source' | 'facts' | 'url' | 'title'> }) {
  const { t } = usePanel()
  const cells = <>
    <span className="dt-chip-source">{valueLabel(t, 'source', thread.source)}</span>
    {Object.entries(thread.facts).map(([id, fact]) => <span key={id} className={fact.problem ? 'dt-chip-fact dt-chip-problem'
      : 'dt-chip-fact'}>
      {fact.label && <span className="dt-chip-label">{localized(t, fact.label)}</span>}{localized(t, fact.value)}
    </span>)}
  </>
  return thread.url ? <a className="dt-chip dt-chip-link" href={thread.url} target="_blank" rel="noopener noreferrer" title={thread.title}>
    {cells}<span className="dt-chip-open"><Icon name="external" size={11} /></span>
  </a> : <span className="dt-chip">{cells}</span>
}

type Run<I> = { item: I; earlier: I[] }
/** Group consecutive automated items from the same sender so only the newest is shown by default. */
export function automatedRuns<I>(items: I[], sender: (item: I) => string | undefined): Run<I>[] {
  const runs: Run<I>[] = []
  for (const item of items) {
    const last = runs.at(-1), from = sender(item)
    if (last && from !== undefined && sender(last.item) === from) last.earlier.push(item)
    else runs.push({ item, earlier: [] })
  }
  return runs
}
export function Earlier({ items }: { items: { id: string; at: string; preview: string }[] }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  if (!items.length) return null
  return <div>
    <button type="button" className="dt-textlink" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? t('collapse') : t('automatedEarlier', { count: items.length })}
    </button>
    {open && <ul className="dt-plain-list dt-hint">{items.map(item => <li key={item.id}><When
      at={item.at} /> · {readableMarkers(t, item.preview) || t('empty')}</li>)}</ul>}
  </div>
}
