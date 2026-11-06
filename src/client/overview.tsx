/** Overview page: pending Tickets requiring human action, active system problems, 24-hour flow counts, and Executor load. */
import type { ReactNode } from 'react'
import { usePoll, type Problem } from './api.ts'
import { Button, Dot, Icon } from './controls.tsx'
import { revealSection } from './frame.ts'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { setupPage, settingsRoute, type Route } from './route.ts'
import { TicketLine } from './rows.tsx'
import { sourceMark } from './marks.ts'
import type { DshSuperagentKey } from './locales.ts'
import { errorText, healthText, localized, reasonLabel, valueLabel, readableMarkers } from './text.ts'
import { Card, CheckSetupButton, ConfirmButton, Empty, ErrorLine, Hint, LoadState, LoopTrack, PageHead, RepairSetupButton, Section, SetupMessage } from './widgets.tsx'

function ProblemLine({ problem, onChanged }: { problem: Problem; onChanged: () => Promise<void> }) {
  const { t, call, navigate } = usePanel()
  const post = useAction((request: () => Promise<unknown>) => request(), { reload: onChanged })
  const row = (title: string, detail: ReactNode, route: Route | undefined, hint?: string, actions?: ReactNode) => <li
    className="dt-row dt-link dt-att dt-att-error">
    <div className="dt-row-main">
      <div className="dt-att-what">{route ? <button type="button" className="dt-open dt-open-wrap"
        onClick={() => navigate(route)}>{title}</button> : title}</div>
      {detail}{hint && <Hint>{hint}</Hint>}{actions && <div className="dt-row-meta dt-row-buttons">{actions}</div>}
    </div>
  </li>
  const go = (label: string, route: Route) => <Button variant="outline" size="sm" icon={<Icon name="settings"
    size={14} />} onClick={() => navigate(route)}>{label}</Button>
  const raw = (text: string | undefined) => text && <p className="dt-error dt-clamp dt-mono">{text}</p>
  const worded = (text: string) => <p className="dt-error">{text}</p>
  switch (problem.kind) {
    // A failed Feishu bot check pauses only the Feishu Source; other setup problems halt the entire service.
    // 后端用 scope 区分「整个服务停摆」和「只停一个来源」；后者带来源名，所以面板不认识具体来源也能说清楚。
    case 'setup': {
      const source = problem.scope === 'source' ? localized(t, problem.title) : ''
      const key = `problemSetupFix.${problem.place}` as DshSuperagentKey
      const fixed = t(key)
      return row(source ? t('problemSetupSource', { source }) : t('problemSetup'), <p className="dt-error"><SetupMessage
        problem={problem} /></p>, setupPage(problem.place),
        fixed !== key ? fixed : source ? t('problemSetupFixSource', { source }) : undefined,
        // 「状态目录里有别人的文件」可以一键自救：把它改名留档后重新检查。
        problem.code === 'foreignFile' && typeof problem.values.file === 'string'
          ? <><RepairSetupButton file={problem.values.file} /> <CheckSetupButton /></>
          : <CheckSetupButton />)
    }
    case 'no-source': return row(t('problemNoSource'), undefined, settingsRoute('source'), undefined, go(t('actionOpenSources'),
      settingsRoute('source')))
    case 'no-allowed': return row(t('problemNoAllowed'), undefined, settingsRoute('eval'), undefined, go(t('actionAddAllowed'),
      settingsRoute('eval')))
    case 'executor-paused': return row(t('problemPaused'), undefined, { page: 'execution' }, undefined,
      <ConfirmButton variant="outline" icon="play" label={t('resumeProcessing')} title={t('resumeProcessing')}
        message={t('resumeProcessingConfirm')}
        onConfirm={async () => { await call('POST executor/pause', { body: { paused: false } }); await onChanged() }} />)
    case 'runtime-error': return row(t('problemRuntime', { name: valueLabel(t, 'health', problem.name) }), raw(problem.detail), undefined)
    case 'source-error': {
      const health = problem.source.health
      return row(t('sourceError', { source: localized(t, problem.source.title) }), health.code ? worded(healthText(t, health))
        : raw(health.detail), settingsRoute('source'), t('sourceErrorHint'))
    }
    case 'eval-overdue': return row(t('problemEvalOverdue', { thread: readableMarkers(t, problem.thread.title) }), undefined, { page: 'trigger',
      id: problem.thread.key })
    case 'eval-unavailable': return row(t('problemEvalUnavailable', { thread: readableMarkers(t, problem.thread.title) }), raw(reasonLabel(t,
      problem.reason)),
      { page: 'trigger', id: problem.thread.key, query: { trigger: problem.triggerId } }, undefined, <>
        <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST triggers/:id/requeue', { id: problem.triggerId })) }}>{t('requeue')}</Button>
        <Button variant="outline" size="sm" icon={<Icon name="dismiss" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST decisions/:id/dismiss', { id: problem.decisionId })) }}>{t('dismiss')}</Button>
      </>)
    case 'outgoing': return row(t('problemReply', { source: valueLabel(t, 'source', problem.outgoing.channel.source),
      attempts: problem.outgoing.attempts }),
      raw(problem.outgoing.error), undefined)
  }
}

export function OverviewPage() {
  const { t, call, navigate } = usePanel()
  const { setup } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET overview'), [])
  // 首屏没数据时统一走 LoadState：失败分支带重试，加载分支给骨架而不是空页面。
  if (!data) return <LoadState error={error} loading onRetry={reload} />
  const stat = (label: string, value: ReactNode, route?: Route) => <span className="dt-stat">
    <span className="dt-stat-label">{label}</span>
    {route ? <button type="button" className="dt-textlink dt-stat-value" onClick={() => navigate(route)}>{value}</button> : <span
      className="dt-stat-value">{value}</span>}
  </span>
  // 实时指标共用一条基线；按钮包含标签，读屏不会只听见一个没有上下文的数字。
  const metric = (label: string, value: ReactNode, route?: Route, target?: string) => <div className="dt-metric">
    {route || target ? <button type="button" className="dt-metric-link" onClick={() => route ? navigate(route)
      : revealSection(target!)}>
      <span className="dt-metric-label">{label}</span><span className="dt-metric-value">{value}</span>
    </button> : <><span className="dt-metric-label">{label}</span><span className="dt-metric-value">{value}</span></>}
  </div>
  const more = (route: Route) => <button type="button" className="dt-textlink dt-more-link"
    onClick={() => navigate(route)}>{t('details')}</button>
  // 闭环每一步的进度：有数即「已完成」，正在发生的环节标成 current。
  // 后台可能同时有执行与评估两条线，这里优先展示执行，其次评估——它们是同一条链上相邻的环节。
  const stage = data.executor.running > 0 ? 'running' : data.flow.evaluating > 0 ? 'evaluating' : 'idle'
  const step = (label: string, value: number | string, route: Route, hint?: string, current = false) => ({
    label,
    value,
    hint,
    // 数字表示「走过多少」，为 0 就是还没开始；字符串表示当前状态（例如策略版本），一律算已完成。
    state: current ? 'current' as const : typeof value === 'number' && value === 0 ? 'pending' as const : 'done' as const,
    onSelect: () => navigate(route),
  })
  const loopSteps = [
    step(t('flowReceivedLabel'), data.flow.received, settingsRoute('logs')),
    step(t('flowFilteredLabel'), data.flow.filtered, settingsRoute('source')),
    step(t('flowTriggeredLabel'), data.flow.triggers, settingsRoute('logs')),
    step(t('flowJudgedLabel'), data.flow.judged, { page: 'eval' }),
    step(t('flowAcceptedLabel'), data.flow.accepted, { page: 'eval', query: { filter: 'work' as const, window: '24h' as const } }),
    step(t('flowRunningLabel'), data.executor.running, { page: 'execution' }, `${data.executor.queued} ${t('queuedLabel')}`,
      stage === 'running'),
    step(t('flowEvaluatingLabel'), data.flow.evaluating, { page: 'eval', query: { filter: 'work' as const, window: '24h' as const } },
      undefined, stage === 'evaluating'),
    step(t('flowReturnedLabel'), data.policyVersion, settingsRoute('eval')),
  ]
  return <div className="dt-dashboard">
    {/* 已经有数据后刷新失败：只在顶部提示并给重试，不要把仪表盘整块替换成错误。 */}
    {error && <ErrorLine error={errorText(error)} title={t('loadFailed')} onRetry={reload} />}
    {/* 仪表盘模板：页面头 → 指标行 → 两列（办公室 / 待处理与问题）→ 来源明细 → 分节统计 → 流程明细。 */}
    <PageHead title={t('tab.overview')} hint={t('overviewHint')} back={false} />
    <div className="dt-metrics" role="group" aria-label={t('overviewLive')}>
      {metric(t('executingLabel'), <>{data.executor.running}<span className="dt-metric-limit"> / {data.executor.maxWorkers}</span></>, { page: 'execution' })}
      {metric(t('queuedLabel'), data.executor.queued, { page: 'execution' })}
      {metric(t('pendingTickets'), data.person.length, undefined, 'dt-overview-pending')}
      {metric(t('problems'), data.problems.length, undefined, 'dt-overview-problems')}
    </div>
    {/* 待处理工单与系统问题并排；办公室可视化已取消，概览只留可操作的数据。 */}
    <div className="dt-overview-column">
      <div id="dt-overview-pending" className="dt-dashboard-panel" tabIndex={-1}>
        <Section title={t('pendingTickets')} count={data.person.length}>
          {data.person.length ? <ul className="dt-list dt-cards">{data.person.map(ticket => <TicketLine key={ticket.id} ticket={ticket} question
            onChanged={reload} />)}</ul>
            : <Empty icon="inbox" title={t('needsYouNone')} hint={t('emptyListHint')} />}
        </Section>
      </div>
      <div id="dt-overview-problems" className="dt-dashboard-panel" tabIndex={-1}>
        <Section title={t('problems')} count={data.problems.length}>
          {data.problems.length > 0 ? <ul className="dt-list dt-cards">{data.problems.map((problem, index) => <ProblemLine key={index} problem={problem}
            onChanged={reload} />)}</ul> : <p className="dt-hint">{t('overviewNoProblems')}</p>}
        </Section>
      </div>
    </div>
    {/* 来源按列对齐，收到与过滤沿用后端统计口径，配置入口进设置 › 来源。 */}
    {data.sources.length > 0 && <Section title={t('term.source')} action={more(settingsRoute('source'))}>
      <div className="dt-source-grid">{data.sources.map(source => {
        const mark = sourceMark(t, source.state)
        return <button key={source.id} type="button" className="dt-source-card"
          onClick={() => navigate(settingsRoute('source', { source: source.id }))}>
          <span className="dt-source-card-name"><Dot state={mark.dot} label={mark.label} />{localized(t, source.title)}</span>
          <span className="dt-source-card-meta">{mark.label}</span>
          <span className="dt-source-count"><span>{t('sourceReceivedLabel')}</span><strong>{source.stats.received}</strong></span>
          <span className="dt-source-count"><span>{t('sourceFilteredLabel')}</span><strong>{source.stats.filtered}</strong></span>
        </button>
      })}</div>
    </Section>}
    <Section title={t('lastDay')} action={more(settingsRoute('logs'))}>
      {/* Received and evaluated counts operate on Triggers rather than Threads or Decisions, so they do not link to filtered views. */}
      <div className="dt-stats">
        {stat(t('flowReceivedLabel'), data.flow.received)}
        {stat(t('flowFilteredLabel'), data.flow.filtered, data.flow.filtered ? settingsRoute('source') : undefined)}
        {stat(t('flowJudgedLabel'), data.flow.judged)}
        {stat(t('flowAcceptedLabel'), data.flow.accepted, { page: 'eval', query: { filter: 'work' as const, window: '24h' as const } })}
        {data.flow.dropped > 0 && stat(t('flowDroppedLabel'), data.flow.dropped, settingsRoute('source'))}
      </div>
    </Section>
    <Section title={t('term.executor')} action={more({ page: 'execution' })}>
      {/* Pauses surface in `problems` above, so Executor counts render the same in both states; while setup waits, nothing runs. */}
      {setup?.problem ? <Hint>{t('executorWaitingSetup')}</Hint> : <div className="dt-stats">
        {stat(t('executingLabel'), `${data.executor.running} / ${data.executor.maxWorkers}`)}
        {stat(t('queuedLabel'), data.executor.queued)}
        {stat(t('idleLabel'), data.executor.idle)}
      </div>}
    </Section>
    <Card title={t('loopTitle')} className="dt-dashboard-flow">
      <p className="dt-hint">{t('overviewFlowHint')}</p>
      <LoopTrack label={t('loopTitle')} steps={loopSteps} />
    </Card>
  </div>
}
