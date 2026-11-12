/** Eval status view (Decision log) and Eval settings group (Policy rules, per-Source admission, and assessor settings). */
import { useState } from 'react'
import { ADMISSION_DEFAULTS, ADMISSION_OPTIONS, type Admission, type AdmissionCell } from '../admission.ts'
import type { AdmissionRowView } from '../sources/kind.ts'
import { LIMITS } from '../limits.ts'
import { DECISION_FILTERS, DECISION_KINDS, usePoll, type DecisionFilter, type DecisionRow, type Settings, type SourceView } from './api.ts'
import { Button, DisclosureRow, Icon, InfoTip, Input, Pill, SegmentedControl, SegmentedTabs, Switch } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { useAction, usePanel } from './provider.tsx'
import { settingsRoute } from './route.ts'
import { DecisionLine } from './rows.tsx'
import { decisionMark } from './marks.ts'
import { ConfigHistory, Field, Fields, ModelField, SourceField, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { errorText, localized, readableMarkers, reasonLabel, valueLabel, when } from './text.ts'
import { Card, Empty, Hint, LabelValue, ListSection, PageHead, Section, StageMark, Toolbar, When } from './widgets.tsx'

/**
 * 指标条：这段时间内各档判定的数量。
 * 数字来自服务端的 `summary`（按窗口统计全部 kind），所以切换筛选时它不变——指标回答「判定健不健康」，
 * 列表回答「具体是哪几条」，两者职责分开。
 */
function DecisionMetrics({ total, byKind }: { total: number; byKind: Record<string, number> }) {
  const { t } = usePanel()
  const count = (kinds: string[]) => kinds.reduce((sum, kind) => sum + (byKind[kind] ?? 0), 0)
  const tile = (label: string, value: number) => <div className="dt-metric">
    <span className="dt-metric-label">{label}</span><span className="dt-metric-value">{value}</span>
  </div>
  return <div className="dt-metrics" role="group" aria-label={t('evalMetricsLabel')}>
    {tile(t('evalDecided'), total)}
    {tile(t('decisionFilter.work'), count(['accept', 'reopen']))}
    {tile(t('decisionFilter.stop'), count(['stop']))}
    {tile(t('decisionFilter.ignore'), count(['ignore']))}
    {tile(t('decisionFilter.unavailable'), count(['unavailable']))}
  </div>
}

/**
 * 右栏：把一条判定拆开——它是什么、为什么、命中了哪些规则、送进判定的是什么、判定之后发生了什么。
 * 取的都是 `DecisionRow` 已有的字段，不额外请求。
 */
function DecisionDetail({ decision }: { decision: DecisionRow }) {
  const { t, navigate } = usePanel()
  const mark = decisionMark(t, decision.outcome)
  const preview = readableMarkers(t, decision.preview)
  const matched = decision.rules.filter(rule => rule.matched)
  const title = decision.ticketTitle ?? (decision.threadTitle ? readableMarkers(t, decision.threadTitle) : preview || t('empty'))
  return <Card className="dt-detail-card" title={t('evalDetailTitle')} hint={t('evalDetailHint')}>
    <div className="dt-detail-head">
      <StageMark state={mark.dot} icon={mark.icon} label={mark.label} />
      <When at={decision.at} />
    </div>
    <p className="dt-detail-title">{title}</p>
    {/* 判定理由：完整文案在这里展开，行内只显示标签。 */}
    {decision.reason && <blockquote className="dt-detail-quote">{reasonLabel(t, decision.reason)}</blockquote>}
    {matched.length > 0 && <div className="dt-detail-block">
      <span className="dt-detail-label">{t('evalRuleHits')}</span>
      <ul className="dt-detail-rules">{matched.map((rule, index) => <li key={index}>
        <span className="dt-chip">{rule.name}</span>
        {rule.reason && <span className="dt-line-text">{localized(t, rule.reason)}</span>}
      </li>)}</ul>
    </div>}
    <div className="dt-detail-block">
      <span className="dt-detail-label">{t('evalContextLabel')}</span>
      <p className="dt-detail-context">{preview || t('empty')}</p>
    </div>
    {/* 判定之后：有工单就进工单页，没有就给回线程的入口，两条路都在右栏底部收口。 */}
    <div className="dt-actions">
      {decision.ticketId
        ? <Button variant="outline" size="sm" onClick={() => navigate({ page: 'execution', id: decision.ticketId! })}>{t('evalOpenTicket')}</Button>
        : <Button variant="outline" size="sm" onClick={() => navigate({ page: 'trigger', id: decision.thread,
          query: { trigger: decision.triggerIds[0] ?? '' } })}>{t('evalOpenThread')}</Button>}
    </div>
  </Card>
}

export function EvalStatus({ filter, window, paused }: {
  filter: DecisionFilter; window: '24h' | undefined; paused: boolean
}) {
  const { t, call, navigate } = usePanel()
  const [limit, setLimit] = useState(30)
  // 右栏跟随选中的判定；默认显示最新一条，列表刷新后选的还在就继续跟着它。
  const [chosen, setChosen] = useState<string>()
  const { data, error, reload } = usePoll(() => call('GET decisions', { query: { limit, kind: DECISION_KINDS[filter],
    ...window ? { window } : {} } }), [filter, limit, window])
  const current = data?.items.find(decision => decision.id === chosen) ?? data?.items[0]
  // 筛选与 24 小时窗口都进路由：换条件是一次导航，刷新/后退都能回到同一屏。
  const show = (key: DecisionFilter, last24h: boolean) => navigate({ page: 'eval',
    query: { ...key === 'all' ? {} : { filter: key }, ...last24h ? { window: '24h' as const } : {} } }, true)
  return <>
    {/* 列表页模板（v2）：页面头（标题 + 说明 + 设置入口）→ 指标条 → 筛选条 → 流水 + 右栏。 */}
    <PageHead back={false} title={t('term.decision')} hint={t('evalStatusIntro')}>
      <Button variant="ghost" size="sm" icon={<Icon name="settings" />}
        onClick={() => navigate(settingsRoute('eval'))}>{t('tab.settings')}</Button>
    </PageHead>
    {paused && <p className="dt-banner">
      {t('evalRecordsPaused')} <button type="button" className="dt-textlink"
        onClick={() => navigate({ page: 'execution' })}>{t('resumeWhere')}</button>
    </p>}
    {/* 指标条回答「这段时间判定健不健康」，与筛选无关；没有数据时不渲染，避免一排 0。 */}
    {data && data.summary.total > 0 && <DecisionMetrics total={data.summary.total} byKind={data.summary.byKind} />}
    {/*
      四态统一交给 ListSection：首次加载的骨架出现在筛选条之前，筛选条只在拿到数据后渲染，
      避免加载途中先闪一排筛选项；空列表仍保留筛选条，用户可以立刻换一个过滤条件。
    */}
    <ListSection loading={!data} error={error ? errorText(error) : undefined} onRetry={() => { void reload() }}
      more={data?.next_offset != null} onMore={() => setLimit(limit + 30)}>
      {/* v2 筛选条：pills 在左，可移除的「过去 24 小时」条件仍在同一行内。 */}
      <Toolbar>
        {DECISION_FILTERS.map(key => <Pill key={key} active={filter === key} onClick={() => { setLimit(30); show(key, !!window) }}>
          {t(`decisionFilter.${key}`)}
        </Pill>)}
        {window && <><span className="dt-filter-gap" />
          {/* 24 小时窗口是可移除的过滤条件，用普通按钮表达「点掉它」；Pill 的 aria-pressed 只表示选中，表达不了移除。 */}
          <Button variant="outline" size="sm" onClick={() => show(filter, false)}>{t('lastDayOnly')}</Button></>}
      </Toolbar>
      {data && (data.items.length && current ? <div className="dt-detail">
        <div className="dt-detail-main"><ul className="dt-list">{data.items.map(decision => <DecisionLine key={decision.id}
          decision={decision} selected={decision.id === current.id} onSelect={() => setChosen(decision.id)} />)}</ul></div>
        <aside className="dt-detail-aside"><DecisionDetail decision={current} /></aside>
      </div> : <Empty icon="inbox" title={t('emptyList')} hint={t('emptyListHint')} />)}
    </ListSection>
  </>
}

type Rule = Settings['policy']['rules'][number]
function RuleRow({ rule, expanded, onToggle, onChange, onDuplicate, onRemove }: {
  rule: Rule; expanded: boolean; onToggle: () => void; onChange: (rule: Rule) => void; onDuplicate: () => void; onRemove: () => void
}) {
  const { t } = usePanel()
  const name = rule.name.trim() || t('newRule')
  return <li className="dt-rule">
    <DisclosureRow icon={<span className="dt-rule-dot" data-enabled={rule.enabled
      || undefined} />} title={name} open={expanded} onToggle={onToggle}
      collapsedContent={<span className="dt-rule-preview">{rule.instruction}</span>}>
      <div className="dt-rule-body">
        <Field label={t('ruleName')}><Input value={rule.name} required maxLength={LIMITS.ruleName} onChange={event => onChange({ ...rule,
          name: event.target.value })} /></Field>
        <Field label={t('ruleInstruction')}>
          <textarea className="dt-textarea" rows={4} required maxLength={LIMITS.ruleInstruction} value={rule.instruction}
            placeholder={t('ruleInstructionPlaceholder')}
            onChange={event => onChange({ ...rule, instruction: event.target.value })} />
        </Field>
        <div className="dt-actions">
          <Button variant="ghost" size="sm" icon={<Icon name="copy" />} onClick={onDuplicate}>{t('duplicate')}</Button>
          <Button variant="ghost" size="sm" icon={<Icon name="trash" />} onClick={onRemove}>{t('remove')}</Button>
        </div>
      </div>
    </DisclosureRow>
    <Switch className="dt-rule-switch" checked={rule.enabled} onChange={enabled => onChange({ ...rule, enabled })} label={t('ruleEnable',
      { name })} />
  </li>
}

type Part = Record<string, unknown>
function SourcePart({ source, part, saved, dirty, onChange, reload }: {
  source: SourceView; part: Part; saved: Part; dirty: boolean; onChange: (next: Part) => void; reload: () => Promise<void>
}) {
  const { t, call, notify } = usePanel()
  const policy = source.policy!
  const sync = policy.sync
  const run = useAction(() => call('POST policy-sync/:id', { id: source.id }), { reload })
  // Syncing saves the Policy block, so require unsaved edits to be saved or discarded first.
  const syncNow = () => { if (dirty) notify(t('syncNeedsSave')); else void run.run() }
  return <div className="dt-part">
    {policy.fields.map(field => <SourceField key={field.key} field={field} value={part[field.key]} saved={saved[field.key]} fact={undefined}
      labels={source.labels}
      onChange={next => onChange({ ...part, [field.key]: next })} />)}
    {sync && <div className="dt-row-buttons">
      <Button variant="outline" size="sm" icon={<Icon name="refresh" />} disabled={run.busy || !sync.ready} onClick={syncNow}>{localized(t,
        sync.label)}</Button>
      {sync.health?.state === 'ready' && sync.health.at && <LabelValue label={t('syncDone')} value={when(sync.health.at, t('lang'))} />}
      {sync.health?.state === 'error' && <span className="dt-error dt-clamp">{sync.health.detail}</span>}
    </div>}
    {policy.rows ? <AdmissionTable rows={policy.rows} labels={source.labels} table={(part.admission ?? {}) as AdmissionTable}
      explicit={localized(t, policy.explicit)}
      onChange={admission => onChange({ ...part, admission })} />
      : <div className="dt-field"><span className="dt-field-head">{t('explicitRequest')}</span><span>{localized(t,
        policy.explicit)}</span></div>}
  </div>
}

type AdmissionTable = Record<string, Partial<Record<AdmissionCell, Admission>>>
const CELLS: readonly AdmissionCell[] = ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed']
function AdmissionTable({ rows, labels, table, explicit, onChange }: {
  rows: AdmissionRowView[]; labels: Record<string,
    string>; table: AdmissionTable; explicit: string; onChange: (table: AdmissionTable) => void
}) {
  const { t } = usePanel()
  const name = (row: AdmissionRowView) => labels[row.id] ?? localized(t, row.label)
  const set = (row: string, cell: AdmissionCell, value: Admission) => onChange({ ...table, [row]: { ...table[row], [cell]: value } })
  const select = (row: AdmissionRowView, cell: AdmissionCell) => {
    const value = table[row.id]?.[cell] ?? ADMISSION_DEFAULTS[cell]
    // Reserve a fixed-width slot for the warning icon so selecting a value never shifts column widths.
    return <td key={cell}><span className="dt-admission-cell">
      <select className="dt-select" aria-label={name(row) + ' · ' + t(`admissionCell.${cell}`)} value={value} onChange={event => set(row.id,
        cell, event.target.value as Admission)}>
        {ADMISSION_OPTIONS[cell].map(option => <option key={option} value={option}>{t(`admissionValue.${option}`)}</option>)}
      </select>
      <span className="dt-admission-slot">{cell === 'unlistedAddressed' && value === 'explicit' && <InfoTip
        text={t('admissionAnyoneWarning')} icon="alert" warn />}</span>
    </span></td>
  }
  return <Section title={t('admission')} hint={t('admissionHint')}>
    <Hint>{explicit}</Hint>
    <table className="dt-table dt-admission">
      <thead>
        <tr><th rowSpan={2}>{t('admissionScope')}</th><th>{t('admissionListed')}</th><th colSpan={2}>{t('admissionUnlisted')}</th></tr>
        <tr><th>{t('admissionUnaddressed')}</th><th>{t('admissionAddressed')}</th><th>{t('admissionUnaddressed')}</th></tr>
      </thead>
      <tbody>{rows.map(row => <tr key={row.id}>
        <td className="dt-admission-scope">{name(row)}<small>{localized(t, row.note)}</small></td>
        {CELLS.map(cell => row.cells[cell] ? select(row, cell) : <td key={cell} className="dt-admission-na"
          aria-label={t('admissionNotReceived')}>—</td>)}
      </tr>)}</tbody>
    </table>
    <Hint>{t('admissionFootnote')}</Hint>
  </Section>
}

function PolicyBlock() {
  const { t } = usePanel()
  const { settings: { blocks, sources, policyVersion }, reload } = useSettings()
  const draft = useBlockDraft('policy', blocks.policy.value, blocks.policy.revision)
  const policy = draft.value
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const parts = sources.filter(source => source.installed && source.policy)
  const [tab, setTab] = useState<string>()
  const current = parts.find(source => source.id === tab) ?? parts[0]
  const edit = (next: Partial<typeof policy>) => draft.edit({ ...policy, ...next })
  const toggle = (id: string) => { const next = new Set(expanded); if (next.has(id)) next.delete(id); else next.add(id); setExpanded(next) }
  const insert = (rule: Rule, at: number) => {
    setExpanded(new Set([...expanded, rule.id]))
    edit({ rules: [...policy.rules.slice(0, at), rule, ...policy.rules.slice(at)] })
  }
  // Expand all rules when native form validation fails inside a collapsed rule.
  const reveal = (target: EventTarget) => { if (target instanceof Element
    && target.closest('.dt-rules')) setExpanded(new Set(policy.rules.map(rule => rule.id))) }
  const part = (id: string) => (policy.sources[id] ?? { allowed: [] }) as Part
  const add = () => insert({ id: crypto.randomUUID(), name: '', enabled: true, instruction: '' }, policy.rules.length)
  return <form className="dt-form dt-block" onSubmit={event => { void draft.submit(event) }}
    onInvalidCapture={event => reveal(event.target)}>
    <Fields disabled={draft.busy}>
      <h2 className="dt-block-title">{t('term.policy')}<InfoTip text={t('policyIntro')} /></h2>
      <p className="dt-flow">
        <LabelValue label={t('policyVersion')} value={<span className="dt-mono">{policyVersion.slice(0, 8)}</span>} /><InfoTip
          text={t('policyVersionHint')} />
      </p>
      <Section title={t('rules')} hint={t('rulesHint')} action={<Button variant="ghost" size="sm" icon={<Icon name="plus" />}
        onClick={add}>{t('addRule')}</Button>}>
        {policy.rules.length ? <ul className="dt-rules">{policy.rules.map((rule, index) => <RuleRow key={rule.id} rule={rule}
          expanded={expanded.has(rule.id)}
          onToggle={() => toggle(rule.id)} onChange={next => edit({ rules: policy.rules.map((item, position) => position === index ? next
            : item) })}
          onDuplicate={() => insert({ ...rule, id: crypto.randomUUID(), name: (rule.name + t('copySuffix')).slice(0, LIMITS.ruleName) },
            index + 1)}
          onRemove={() => edit({ rules: policy.rules.filter((_, position) => position !== index) })} />)}</ul>
            : <Hint>{t('rulesEmpty')}</Hint>}
      </Section>
      {current && <Section title={t('policyPerSource')} hint={t('policyPerSourceHint')}>
        {/* 手写 .dt-subtabs 没有漫游 tabIndex、方向键与 aria-controls；SegmentedTabs 自带 walk()，键盘行为与页面标签一致。
            variant="subtabs" 让页内分区保持下划线样式，与左侧栏的药丸标签区分开。 */}
        {parts.length > 1 && <SegmentedTabs variant="subtabs" label={t('policyPerSource')} value={current.id}
          onChange={id => setTab(id)}
          items={parts.map(source => ({ value: source.id, label: localized(t, source.title), id: 'policy-' + source.id,
            panelId: 'dt-page' }))} />}
        <SourcePart key={current.id} source={current} part={part(current.id)}
          saved={(blocks.policy.value.sources[current.id] ?? {}) as Part} dirty={draft.dirty}
          reload={reload} onChange={next => edit({ sources: { ...policy.sources,
            [current.id]: next as typeof policy.sources[string] } })} />
      </Section>}
    </Fields>
    <SaveBar {...draft} onDiscard={draft.discard} />
  </form>
}

function EvalBlock() {
  const { t } = usePanel()
  const block = useSettings().settings.blocks.eval
  const saved = { ...block.value, timeoutSeconds: String(block.value.timeoutSeconds) }
  const draft = useBlockDraft('eval', saved, block.revision, value => ({ ...value, timeoutSeconds: numberOf(value.timeoutSeconds) }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  return <form className="dt-form dt-block" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <h2 className="dt-block-title">{t('evalSettings')}<InfoTip text={t('evalIntro')} /></h2>
      <Section title={t('acceptMode')} hint={t(`modeOption.${value.mode}`)}>
        <SegmentedControl className="dt-segmented" label={t('acceptMode')} value={value.mode} onChange={mode => edit({ mode })}
          options={(['off', 'observe', 'auto'] as const).map(mode => ({ value: mode, label: valueLabel(t, 'mode', mode),
            title: t(`modeOption.${mode}`) }))} />
      </Section>
      <Field label={t('evalTimeout')} hint={t('evalTimeoutHint')}>
        <Input type="number" min={LIMITS.evalTimeoutSeconds.min} max={LIMITS.evalTimeoutSeconds.max} required value={value.timeoutSeconds}
          onChange={event => edit({ timeoutSeconds: event.target.value })} />
      </Field>
      <Section title={t('assessorModel')} hint={t('assessorModelHint')}>
        <ModelField id="dt-eval-model" value={value.model} onChange={model => edit({ model })} />
      </Section>
    </Fields>
    <SaveBar {...draft} onDiscard={draft.discard} />
  </form>
}

/**
 * The Eval group keeps only the accept mode, the timeout and the assessor model.
 *
 * The Policy — the accept rules, the per-Source sender lists and the admission table — used to share this page, with
 * no navigation entry of its own. That made "who may originate work" effectively unreachable, and every sender was
 * judged not listed. It has its own group now (`PolicySettings`).
 */
export function EvalSettings({ version }: { version?: string | undefined }) {
  return <div className="dt-form">
    <EvalBlock />
    <ConfigHistory blocks={['eval']} versions {...version ? { focus: version } : {}} />
  </div>
}

/**
 * The Policy group: accept rules, the senders allowed on each Source, and the admission table.
 *
 * Split out of `eval.tsx` without changing a line of `PolicyBlock`: the block already owns its own save, so the two
 * groups stay independently saveable.
 */
export function PolicySettings({ version }: { version?: string | undefined }) {
  return <div className="dt-form">
    <PolicyBlock />
    <ConfigHistory blocks={['policy']} versions {...version ? { focus: version } : {}} />
  </div>
}
