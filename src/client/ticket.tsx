/** Ticket detail page: stage and actions, Mandate details, undelivered/delivered Inputs, subscribed Threads, and Assignments. */
import { useState, type ReactNode } from 'react'
import { ApiError, usePoll, type TicketPageView } from './api.ts'
import { DisclosureRow, Dot, Icon, Tag, type IconName } from './controls.tsx'
import { decisionMark, reportDot, ticketMark } from './marks.ts'
import { usePanel } from './provider.tsx'
import { settingsRoute } from './route.ts'
import { Earlier, ThreadLine, automatedRuns } from './rows.tsx'
import { actorName, localized, readableMarkers, reasonLabel, valueLabel, when } from './text.ts'
import { ActionLink, Card, ConfirmButton, DetailLayout, Empty, ExternalLink, Hint, KeyValues, LabelValue, LoadState, LoopTrack,
  MarkdownLite, MetaList, PageHead, SessionButton, StageMark, StatusLine, Truncated, When, type LoopStep } from './widgets.tsx'

type Input = TicketPageView['inputs'][number]
function InputLine({ input, earlier = [] }: { input: Input; earlier?: { id: string; at: string; preview: string }[] }) {
  const { t, navigate } = usePanel()
  const trigger = input.kind === 'trigger' ? input.trigger : undefined
  const headline = trigger ? actorName(t, trigger.actor) + t('labelSeparator') + (readableMarkers(t, trigger.preview) || t('empty')) : ''
  return <li className="dt-row">
    <Dot state={input.delivered ? 'idle' : 'warning'} label={input.delivered ? t('inputDelivered') : t('inputUndelivered')} />
    <div className="dt-row-main">
      {/* 单行省略的标题必须给全文 title，否则长输入在详情页里永远读不全。 */}
      {trigger ? <div className="dt-row-title"><button type="button" className="dt-open" title={headline} onClick={() => navigate({
        page: 'trigger', id: trigger.thread, query: { trigger: trigger.id } })}>
        {headline}
      </button></div> : <div className="dt-row-title">{valueLabel(t, 'input', input.kind)}</div>}
      <div className="dt-row-meta">{input.kind === 'trigger' && <span>{valueLabel(t, 'input', input.kind)}</span>}<When
        at={input.at} /></div>
      {(input.kind === 'text' || input.kind === 'note') && input.text && <div className="dt-row-quote"><MarkdownLite text={input.text} /></div>}
      {trigger?.handback && <Hint>{t('inputHandedBack', { reason: trigger.handback.reason })}</Hint>}
      <Earlier items={earlier} />
    </div>
  </li>
}
function InputList({ inputs }: { inputs: Input[] }) {
  const sender = (input: Input) => input.kind === 'trigger' && input.trigger && !input.trigger.human
    ? input.trigger.actor.source + ':' + input.trigger.actor.id : undefined
  const shown = (input: Input) => ({ id: input.id, at: input.at, preview: input.kind === 'trigger' ? input.trigger?.preview ?? '' : '' })
  return <ul className="dt-list">{automatedRuns(inputs, sender).map(run => <InputLine key={run.item.id} input={run.item}
    earlier={run.earlier.map(shown)} />)}</ul>
}

function Details({ icon, title, open = false, children }: { icon: IconName; title: ReactNode; open?: boolean; children: ReactNode }) {
  const [shown, setShown] = useState(open)
  return <DisclosureRow icon={<Icon name={icon} />} title={title} open={shown} onToggle={() => setShown(!shown)}>
    <div className="dt-disclosure-body">{children}</div>
  </DisclosureRow>
}
function Assignments({ ticket }: { ticket: TicketPageView }) {
  const { t } = usePanel()
  const report = (state: string) => t('assignmentReportShort', { state: valueLabel(t, 'report', state) })
  return <ul className="dt-list">{ticket.assignments.slice().reverse().map((item, index) => <li key={item.id} className="dt-row">
    <Dot state={item.state === 'running' ? reportDot(item.report?.state) : 'idle'} label={valueLabel(t, 'assignment', item.state)} />
    <div className="dt-row-main">
      <div className="dt-row-title">{t('assignmentNumber', { number: ticket.assignments.length - index })}</div>
      <div className="dt-row-meta">
        {/* A running Assignment whose worker reported a non-progress state has ended its turn; show that report as its tag and end its span there. */}
        {item.turnEndedAt && item.report ? <Tag tone="neutral">{report(item.report.state)}</Tag> : <Tag tone={item.state === 'running'
          ? 'info'
          : 'neutral'}>{valueLabel(t, 'assignment', item.state)}</Tag>}
        {item.state !== 'running' && item.report && <span>{report(item.report.state)}</span>}
        <span>{t('assignmentSpan', { from: when(item.startedAt ?? item.createdAt, t('lang')), to: when(item.endedAt ?? item.turnEndedAt,
          t('lang')) || t('now') })}</span>
        {item.endedReason && <span>{reasonLabel(t, item.endedReason)}</span>}
      </div>
    </div>
    {item.ref && item.ref !== ticket.sessionId && <div className="dt-row-actions"><SessionButton variant="outline"
      sessionId={item.ref} /></div>}
  </li>)}</ul>
}
function MandateDetails({ ticket, actor }: { ticket: TicketPageView; actor: string }) {
  const { t, navigate } = usePanel()
  const { mandate, decision } = ticket
  const fact = (item: TicketPageView['basis']['facts'][number]): string => {
    if (item.name === 'legacyAuthority') return valueLabel(t, 'legacy', item.value)
    if (item.name === 'mode' || item.name === 'addressed') return valueLabel(t, item.name, item.value)
    if (item.name === 'admission') return valueLabel(t, 'admissionCell', item.value)
    if (item.name === 'rules') return item.value.map(rule => rule.name).join(t('listSeparator'))
    return item.name === 'sender' ? item.value : t('yes')
  }
  const { legacy } = ticket.basis
  // Omit `sender` when it matches `actor`, which is already shown on the status line.
  const facts = ticket.basis.facts.filter(item => !(item.name === 'sender' && item.value === actor))
  const direction = decision?.direction
  const rows: [string, ReactNode][] = decision ? [
    [t('term.trigger'), <button type="button" className="dt-trigger-link" onClick={() => navigate({ page: 'trigger', id: decision.thread,
      query: { trigger: decision.triggerIds[0] ?? '' } })}>
      <span className="dt-trigger-text">{readableMarkers(t, decision.preview) || t('empty')}</span>
      {/* 分隔符走 t('labelSeparator')：这里原来硬编码 ' · '，英文界面下与其它「来源：发起人」的写法不一致。 */}
      <span className="dt-row-meta"><span>{valueLabel(t, 'source', mandate.actor.source)}{t('labelSeparator')}{actor}</span><When
        at={decision.at} /></span>
    </button>],
    [t('term.decision'), <div className="dt-kv-stack">
      <span>{decisionMark(t, decision.outcome).label}</span>
      <Hint>{reasonLabel(t, decision.reason)}</Hint>
      {decision.rules.map(rule => <Hint key={rule.id}>{t(rule.matched ? 'ruleMatched' : 'ruleUnmatched', { rule: rule.name,
        reason: rule.reason })}</Hint>)}
      {direction && <Hint>{t('directionLine', { intent: direction.answer_requested && !direction.implementation_requested ? t('intentAnswer') : t(direction.implementation_requested ? 'intentYes' : 'intentNo'),
        basis: valueLabel(t, 'targetBasis', direction.target_basis),
        design: t(direction.requires_design_decision ? 'designNeeded' : 'designNotNeeded') })} {t('directionEvidence',
          { evidence: direction.evidence })}</Hint>}
    </div>],
  ] : []
  const version = <button type="button" className="dt-textlink dt-mono" onClick={() => navigate(settingsRoute('eval',
    { version: mandate.policyVersion }))}>{mandate.policyVersion.slice(0, 8)}</button>
  // v2：主列以 Card 分组，Section 的图标槽在 Card 里由标题承担。
  return <Card title={t('mandateDetails')}>
    <KeyValues rows={[...rows, [t('term.scope'), legacy ? t('legacyScopeShort') : mandate.scope || t('empty')],
      ...facts.map((item): [string, string] => [valueLabel(t, 'basis', item.name), fact(item)]),
      ...legacy ? [] : [[t('policyVersion'), version] as [string, ReactNode]]]} />
  </Card>
}

export function TicketPage({ id }: { id: string }) {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET tickets/:id', { id }), [id])
  const after = async (request: Promise<unknown>) => { await request; await reload() }
  // 记录已被删除（404）时是终态：轮询继续成功过一次后就可能 404，继续渲染旧工单会误导操作，因此切空态。
  if (error instanceof ApiError && error.missing) return <>
    <PageHead title={t('term.ticket')} />
    <Empty icon="question" title={t('notFound')} hint={t('ticketNotFound')} />
  </>
  if (!data) return <><PageHead
    title={t('term.ticket')} />{error ? <LoadState error={error} loading={false} onRetry={() => { void reload() }}
      /> : <LoadState loading />}</>
  const status = ticketMark(t, data)
  const actor = actorName(t, data.mandate.actor)
  const { legacy } = data.basis
  const undelivered = data.inputs.filter(input => !input.delivered)
  const failedText = /^(?:\w+Error|Error)\b[:：]/.test(data.summary)
  const failed = data.stage === 'person' && data.action === 'failed'
  const opening = data.threads.find(thread => thread.url)
  const ended = data.ended && (() => {
    const outcome = valueLabel(t, 'outcome', data.ended.outcome), reason = reasonLabel(t, data.ended.reason), time = when(data.ended.at,
      t('lang'))
    return reason ? t('endedAt', { time, outcome, reason }) : t('endedAtShort', { time, outcome })
  })()
  const channel = data.channels[0]
  // 工单流转：5 步全部从本页已有数据推导（inputs / decision / stage / assignments / turnEndedAt），不额外请求。
  const triggers = data.inputs.filter(input => input.kind === 'trigger').length
  const runningAssignments = data.assignments.filter(item => item.state === 'running').length
  const endedAssignments = data.assignments.filter(item => item.state === 'ended').length
  // 回报 = 把触发交还回线程的输入条数 + 本轮已结束 turn 的 Assignment 条数。
  const reported = data.inputs.filter(input => input.trigger?.handback).length
    + data.assignments.filter(item => item.turnEndedAt).length
  // current 由 stage 定位：working 在执行中；person 停在工单（等人）；idle 在两轮之间等回报；ended 已闭环，没有当前步。
  const currentStep = data.stage === 'working' ? 3 : data.stage === 'person' ? 2 : data.stage === 'idle' ? 4 : -1
  // 页内滚动：目标区块的 id 由下面 DetailLayout 里的包裹层提供，找不到就静默跳过。
  const scrollTo = (section: string) => () => document.getElementById(section)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  const flowSteps: LoopStep[] = [
    // 触发：这张工单收到的 Trigger 条数。
    { label: t('flowTriggeredLabel'), value: triggers, onSelect: scrollTo('ticket-mandate'),
      state: triggers > 0 ? 'done' : 'pending' },
    // 决策：没有决策时显式写「未开始」，避免留空让人以为漏渲染；有决策时用结果文案 + 原因。
    { label: t('flowDecidedLabel'), value: data.decision ? decisionMark(t, data.decision.outcome).label : t('loopPending'),
      hint: data.decision ? reasonLabel(t, data.decision.reason) : undefined, onSelect: scrollTo('ticket-mandate'),
      state: data.decision ? 'done' : 'pending' },
    // 工单：本页就是这张工单，value 用 stage 的真实标签。
    { label: t('flowTickedLabel'), value: status.label, state: currentStep === 2 ? 'current' : 'done' },
    // 执行：running / ended 的 Assignment 数，两个数字的含义写进 hint。
    { label: t('flowRunningLabel'), value: runningAssignments + ' / ' + endedAssignments,
      hint: t('flowRunningLabel') + ' / ' + t('loopDone'), onSelect: scrollTo('ticket-details'),
      state: currentStep === 3 ? 'current' : runningAssignments + endedAssignments > 0 ? 'done' : 'pending' },
    // 回报：有 handback 的输入 + 已结束 turn 的 Assignment 条数。
    { label: t('flowReportedLabel'), value: reported,
      onSelect: scrollTo(data.threads.length > 0 ? 'ticket-threads' : 'ticket-details'),
      state: currentStep === 4 ? 'current' : reported > 0 ? 'done' : 'pending' },
  ]
  return <>
    {/* 详情页标题与列表行同样过 readableMarkers：标题里的图片/引用标记不该原样显示。
        详情页保留返回按钮（PageHead 的 back 默认 true），返回的是上一级列表页。 */}
    <PageHead title={readableMarkers(t, data.title)}>
      {opening?.url && <ActionLink href={opening.url}>{t('openThread', { source: valueLabel(t, 'source', opening.source) })}</ActionLink>}
      {data.actions.retry && <ConfirmButton variant="outline" icon="refresh" label={t('retry')} title={t('retryTitle')}
        message={t('retryConfirm', { title: data.title })}
        onConfirm={() => after(call('POST tickets/:id/retry', { id }))} />}
      {data.sessionId && <SessionButton variant="outline" sessionId={data.sessionId} />}
    </PageHead>
    {/* 轮询失败但数据仍在：给错误行与重试，不清空已渲染的详情。 */}
    {error && <LoadState error={error} loading={false} onRetry={() => { void reload() }} />}
    {/* 工单流转：一屏说清「触发 → 决策 → 工单 → 执行 → 回报」，当前步由 stage 推导，
        每一步点一下滚到页内对应区块（授权详情 / 明细 / 订阅线程）。 */}
    <Card title={t('ticketLoop')} hint={t('loopHint')}>
      <LoopTrack steps={flowSteps} />
    </Card>
    {/*
      详情页模板（v2）：主列是真内容（状态行 / 告警 / 授权 / 输入 / 线程 / 明细），
      右栏是元信息（状态、工单 id）与危险操作；窄屏由 .dt-detail 自动折成单列。
    */}
    <DetailLayout
      main={<>
        <StatusLine>
          <StageMark state={status.dot} icon={status.icon} label={status.label} />
          <LabelValue label={t('ticketMandateLabel')} value={valueLabel(t, 'strength', data.mandate.strength)} />
          <LabelValue label={t('ticketActorLabel')} value={valueLabel(t, 'source', data.mandate.actor.source) + ' · ' + actor} />
          <LabelValue label={t('ticketUpdatedLabel')} value={when(data.updatedAt, t('lang'))} />
        </StatusLine>
        {ended && <Hint>{ended}</Hint>}
        {data.attention && <div className="dt-banner"><span className="dt-banner-label">{t('attentionPrefix')}</span><MarkdownLite
          text={data.attention.question} />
          {channel && <div className="dt-banner-actions">
            <ActionLink href={channel.url} icon="message">{t('answerIn', { source: valueLabel(t, 'source', channel.source) })}</ActionLink>
          </div>}
        </div>}
        {/* Ordinary progress stays in the Session/Channels; only a report that halted work (blocked/failed) is shown here. */}
        {data.actions.retry && data.summary && <p className={'dt-banner' + (failed ? ' dt-danger' : '') + (failedText ? ' dt-mono' : '')}>
          <span className="dt-banner-label">{t(failed ? 'failedPrefix' : 'blockedPrefix')}</span>
          {/* 失败摘要可能是一整段堆栈：截到 3 行，title 给全文。 */}
          <Truncated text={data.summary} />
        </p>}
        {data.deliveryError && <p className="dt-banner dt-danger dt-mono">
          <span className="dt-banner-label">{t('deliveryFailedPrefix')}</span>{data.deliveryError}
        </p>}
        {/* A remote job's own summary: the device Session never reaches this panel, so this is what tells a person
            whether the job failed on tests, on the environment, or somewhere else entirely. */}
        {(data.changedFiles?.length || data.tools?.length || data.lastError || data.steps) && <div id="ticket-result">
          <Card title={t('remoteResult')} hint={t('remoteResultHint')}>
            <KeyValues rows={[
              ...data.steps ? [[t('remoteSteps'), String(data.steps)] as [string, string]] : [],
              ...data.tests ? [[t('remoteTests'), t('remoteTestCounts', { passed: String(data.tests.passed),
                failed: String(data.tests.failed) })] as [string, string]] : [],
            ]} />
            {data.lastError && <p className="dt-error dt-mono dt-clamp">{data.lastError}</p>}
            {data.changedFiles?.length ? <div className="dt-detail-block">
              <span className="dt-detail-label">{t('remoteChanged', { count: String(data.changedFiles.length +
                (data.changedOverflow ?? 0)) })}</span>
              <ul className="dt-plain-list">{data.changedFiles.map(path => <li key={path} className="dt-mono">{path}</li>)}</ul>
              {data.changedOverflow ? <Hint>{t('remoteChangedMore', { count: String(data.changedOverflow) })}</Hint> : null}
            </div> : null}
            {data.tools?.length ? <div className="dt-detail-block">
              <span className="dt-detail-label">{t('remoteTools')}</span>
              <ul className="dt-plain-list">{data.tools.map(tool => <li key={tool.name}>
                <span className="dt-mono">{tool.name}</span> · {t('remoteToolCalls', { calls: String(tool.calls),
                  failures: String(tool.failures) })}
              </li>)}</ul>
            </div> : null}
          </Card>
        </div>}
        {/* 包裹层只提供滚动锚点 id，卡片内容与顺序不变。 */}
        <div id="ticket-mandate"><MandateDetails ticket={data} actor={actor} /></div>
        {undelivered.length > 0 && <div id="ticket-inputs"><Card title={t('undeliveredInputs')}
          actions={<span className="dt-count">{undelivered.length}</span>}>
          <Hint>{data.deliveryError ? t('inputRetryHint') : data.paused ? t('inputPausedHint') : t('inputWaitingHint')}</Hint>
          <InputList inputs={undelivered} />
        </Card></div>}
        {data.threads.length > 0 && <div id="ticket-threads"><Card title={t('subscribedThreads')}
          actions={<span className="dt-count">{data.threads.length}</span>}>
          <ul className="dt-list">{data.threads.map(thread => <ThreadLine key={thread.key} thread={thread} ticketId={data.id}
            context={thread.context} />)}</ul>
        </Card></div>}
        {/* 明细折叠区：环境变量 / 渠道 / 已送达输入 / 标识符仍用 DisclosureRow，不再套 Card（避免卡中卡）。 */}
        <div id="ticket-details" className="dt-details">
          {/* A single Assignment adds nothing beyond the status line; list Assignments only once work has been resumed or handed over. */}
          {data.assignments.length > 1 && <Details icon="queue" title={t('term.assignment') + ' · ' + data.assignments.length} open><Assignments
            ticket={data} /></Details>}
          {data.environment.length > 0 && <Details icon="settings" title={t('term.environment')}>
            <table className="dt-table"><tbody>{data.environment.map(variable => <tr key={variable.key} title={localized(t,
              variable.description)}>
              <td className="dt-mono">{variable.key}</td><td className="dt-mono">{variable.value || <span
                className="dt-hint">{t('empty')}</span>}</td>
            </tr>)}</tbody></table>
          </Details>}
          <Details icon="message" title={t('term.channel')}>
            <ul className="dt-plain-list">{data.channels.map((item, index) => <li key={index}>
              <ExternalLink href={item.url} icon={item.icon ?? 'message'}>{localized(t, item.label)}</ExternalLink>
            </li>)}</ul>
          </Details>
          {data.inputs.length > undelivered.length && <Details icon="inbox" title={t('deliveredInputs',
            { count: data.inputs.length - undelivered.length })}>
            <InputList inputs={data.inputs.filter(input => input.delivered)} />
          </Details>}
          <Details icon="hash" title={t('identifiers')}>
            <KeyValues rows={[[t('ticketId'), <span className="dt-mono">{data.id}</span>], [t('executionDirectory'), <span
              className="dt-mono">{data.directory ?? t('empty')}</span>],
              ...legacy && data.mandate.scope ? [[t('legacyAssignment'), <span
                className="dt-mono dt-clamp">{data.mandate.scope}</span>] as [string, ReactNode]] : []]} />
          </Details>
        </div>
      </>}
      aside={<>
        {/* 右栏只放主列里没有的元信息，避免与状态行重复同一句话。 */}
        <Card>
          <MetaList items={[
            { label: t('statusTitle'), value: status.label },
            { label: t('ticketId'), value: <span className="dt-mono">{data.id}</span> },
            { label: t('executionDirectory'), value: <span className="dt-mono dt-clamp">{data.directory ?? t('empty')}</span> },
          ]} />
        </Card>
        {data.actions.stop && <div className="dt-danger-zone">
          <span className="dt-hint">{t('stopHint')}</span>
          <ConfirmButton variant="outline" label={t('stop')} title={t('stopConfirmTitle')} message={t('stopConfirm', { title: data.title })}
            onConfirm={() => after(call('POST tickets/:id/stop', { id }))} />
        </div>}
      </>}
    />
  </>
}
