/**
 * Settings › Logs: the whole log — every Trigger that arrived, every Decision, what became of each Ticket, and the
 * messages that never reached their Channel — so a person can troubleshoot, and an agent reads the same rows over the
 * API. It lives in Settings rather than a tab: raw history is for poking around, not daily work.
 */
import { useState } from 'react'
import { LOG_KINDS, LOG_LEVELS, type LogKind, type LogLevel } from '../app/api.ts'
import { usePoll, type LogRow } from './api.ts'
import { Input, Pill } from './controls.tsx'
import type { DshSuperagentKey } from './locales.ts'
import { usePanel } from './provider.tsx'
import { errorText, reasonLabel, valueLabel, type T } from './text.ts'
import { Empty, Hint, ListSection, Toolbar, When } from './widgets.tsx'

/** How a line reads as a noun: what happened, not which module wrote it. */
const KIND_LABEL: Record<LogKind, DshSuperagentKey> = {
  trigger: 'logKind.trigger', decision: 'logKind.decision', ticket: 'logKind.ticket', reply: 'logKind.reply',
}
/** A Decision row's text is the kind code the server stored; this turns it into what it meant. */
const DECISION_LABEL: Record<string, DshSuperagentKey> = {
  accept: 'logDecision.accept', reopen: 'logDecision.reopen', stop: 'logDecision.stop',
  ignore: 'logDecision.ignore', unavailable: 'logDecision.unavailable',
}

/**
 * A Decision's detail is its first reason code, a Ticket's end detail is an outcome code or a person's sentence, and a
 * delivery's detail is a drop reason or the host's error. Codes localize; anything else is shown as it was written.
 */
function detailOf(t: T, entry: LogRow): string {
  if (!entry.detail) return ''
  if (entry.kind === 'decision') return reasonLabel(t, entry.detail)
  const group = entry.kind === 'ticket' ? 'outcome' : entry.kind === 'reply' ? 'dropReason' : ''
  if (!group) return entry.detail
  const label = valueLabel(t, group, entry.detail)
  return label === entry.detail ? entry.detail : label
}

function LogLine({ entry }: { entry: LogRow }) {
  const { t, navigate } = usePanel()
  // 每行都尽量回到它说的那条记录；没有可去处的（比如投递失败）就只是日志。
  const reachable = entry.ticketId ?? entry.decisionId ?? entry.thread
  const open = (): void => {
    if (entry.ticketId) navigate({ page: 'execution', id: entry.ticketId })
    else if (entry.decisionId) navigate({ page: 'eval' })
    else if (entry.thread) navigate({ page: 'trigger', id: entry.thread })
  }
  const detail = detailOf(t, entry)
  const text = entry.kind === 'decision' ? t(DECISION_LABEL[entry.text] ?? 'logKind.decision') : entry.text
  return <li className="dt-log" data-level={entry.level} data-kind={entry.kind}>
    <When at={entry.at} />
    <span className="dt-log-kind">{t(KIND_LABEL[entry.kind])}</span>
    <button type="button" className="dt-log-text" onClick={open} disabled={reachable === undefined}>{text}</button>
    {detail !== '' && <span className="dt-log-detail">{detail}</span>}
  </li>
}

export function LogsSettings() {
  const { t, call } = usePanel()
  const [level, setLevel] = useState<'all' | LogLevel>('all')
  const [kind, setKind] = useState<'all' | LogKind>('all')
  const [question, setQuestion] = useState('')
  const [limit, setLimit] = useState(100)
  // 只发用户真正设过的条件：空的筛选不进查询串，日志 URL 也好看。
  const { data, error, reload } = usePoll(() => call('GET logs', { query: { limit,
    ...level === 'all' ? {} : { level }, ...kind === 'all' ? {} : { kind },
    ...question.trim() ? { q: question.trim() } : {} } }), [level, kind, question, limit])
  const levels: readonly ('all' | LogLevel)[] = ['all', ...LOG_LEVELS]
  const kinds: readonly ('all' | LogKind)[] = ['all', ...LOG_KINDS]
  return <>
    <Hint>{t('logsSettingsIntro')}</Hint>
    <ListSection loading={data === undefined} error={error ? errorText(error) : undefined} onRetry={() => { void reload() }}
      more={data?.next_offset != null} onMore={() => setLimit(limit + 100)}>
      <Toolbar actions={<Input value={question} placeholder={t('logSearch')} aria-label={t('logSearch')}
        onChange={event => { setLimit(100); setQuestion(event.target.value) }} />}>
        {levels.map(key => <Pill key={key} active={level === key} onClick={() => { setLimit(100); setLevel(key) }}>
          {t(`logLevel.${key}`)}
        </Pill>)}
        <span className="dt-filter-gap" />
        {kinds.map(key => <Pill key={key} active={kind === key} onClick={() => { setLimit(100); setKind(key) }}>
          {t(`logKind.${key}`)}
        </Pill>)}
      </Toolbar>
      {data && (data.items.length > 0
        ? <ul className="dt-log-list">{data.items.map(entry => <LogLine key={`${entry.kind}:${entry.at}:${entry.triggerId
          ?? entry.decisionId ?? entry.ticketId ?? entry.text}`} entry={entry} />)}</ul>
        : <Empty icon="history" title={t('logEmpty')} hint={t('logEmptyHint')} />)}
    </ListSection>
    {/* 这一页就是 API 的同一份数据：脚本和 agent 读 /logs，人在这里看，不必各有一套。 */}
    <Hint>{t('logsSettingsApi')}</Hint>
  </>
}
