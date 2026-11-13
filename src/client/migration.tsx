/**
 * The Migration settings group: download this hub, and (later) restore one.
 *
 * The CLI already moves a hub, but it asks the operator to stop it and to know which directories matter. This page is
 * the same operation with the decisions made once, in one place: what a move carries, what it deliberately leaves
 * behind, and what has to be true on the machine that receives it.
 *
 * The download is a plain link, not a `fetch`: the archive is built and streamed server-side, and the browser writing
 * it straight to disk is what keeps a large sessions directory from having to pass through JavaScript memory.
 */
import { useRef, useState } from 'react'
import { Button, Icon } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { usePoll } from './api.ts'
import { errorText } from './text.ts'
import { ErrorLine, Hint, LoadState, Section } from './widgets.tsx'

/** What the restore route reports about an uploaded archive, matching the server's `RestoreReport`. */
export interface RestoreReport {
  home: string
  tickets: string
  rows: Record<string, string>
  missingDirectories: string[]
  /** The tickets whose directory is missing; they are marked blocked after the restore. */
  affectedTickets: string[]
  problems: string[]
  notes: string[]
  bytes: number
}

/** What the server says about this installation's ability to move, and what it would carry. */
export interface MigrationView {
  /** False where `tar` is missing (Windows), which the server refuses rather than half-packing. */
  canExport: boolean
  /** Why an export is unavailable, in English; the panel shows it under the button. */
  reason?: string
  entries: { name: string; bytes?: number }[]
  /** Whether restoring is implemented and allowed on this build. */
  canImport: boolean
}

const size = (bytes: number | undefined): string => {
  if (bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The export card: what is packed, what is left out, and the one button that starts the download. */
function ExportCard({ view }: { view: MigrationView }) {
  const { t } = usePanel()
  const total = view.entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)
  return <Section title={t('migrationExportTitle')} hint={t('migrationExportHint')}>
    <ul className="dt-list dt-migration-entries">
      {view.entries.map(entry => <li className="dt-migration-entry" key={entry.name}>
        <span className="dt-mono">{entry.name}</span>
        <span className="dt-migration-size">{entry.bytes === undefined ? t('migrationAbsent') : size(entry.bytes)}</span>
      </li>)}
    </ul>
    <p className="dt-hint">{t('migrationTotal', { total: size(total) })}</p>
    {view.canExport
      ? <a className="dt-btn dt-btn-primary" href="/orchestrator/export" download>
        <Icon name="download" size={14} />{t('migrationExportButton')}
      </a>
      : <Hint>{view.reason ?? t('migrationExportUnavailable')}</Hint>}
  </Section>
}

/**
 * The restore card: upload an archive, read what it holds, and only then apply it.
 *
 * The report is the whole point of the two-step flow. A restore replaces the ledger, so the operator has to see the
 * ticket count and — more importantly — whether the archive describes work directories this machine actually has.
 * Applying is a separate button for that reason, and it says what it will do: stop, swap, restart.
 */
function RestoreCard({ canImport }: { canImport: boolean }) {
  const { t } = usePanel()
  const [report, setReport] = useState<RestoreReport | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [applied, setApplied] = useState<{ backup: string; blocked: string[] } | undefined>()
  const file = useRef<HTMLInputElement>(null)

  const upload = async () => {
    const chosen = file.current?.files?.[0]
    if (!chosen) return
    setBusy(true); setError(undefined); setReport(undefined); setApplied(undefined)
    try {
      // Raw bytes straight to the restore route: the archive never passes through JSON parsing or a fetch body limit.
      const response = await fetch('/orchestrator/restore', { method: 'POST', body: chosen,
        headers: { 'x-orchestrator-request': '1', 'content-type': 'application/gzip' } })
      const body = await response.json() as RestoreReport | { error?: string }
      if (!response.ok) { setError((body as { error?: string }).error ?? t('loadFailed')); return }
      setReport(body as RestoreReport)
    } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }
  const apply = async () => {
    setBusy(true); setError(undefined)
    try {
      const response = await fetch('/orchestrator/migration/apply', { method: 'POST',
        headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' } })
      const body = await response.json() as { backup?: string; blocked?: string[]; error?: string }
      if (!response.ok) { setError(body.error ?? t('loadFailed')); return }
      setApplied({ backup: String(body.backup), blocked: body.blocked ?? [] })
    } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }

  /** Only a fatal problem stops the restore; a missing project directory is something to see, not a refusal. */
  const blocked = report !== undefined && report.problems.length > 0
  return <Section title={t('migrationImportTitle')} hint={t('migrationImportHint')}>
    {!canImport
      ? <Hint>{t('migrationExportUnavailable')}</Hint>
      : <>
        <div className="dt-restore-pick">
          <input ref={file} type="file" accept=".gz,.tgz,application/gzip" aria-label={t('migrationImportButton')} />
          <Button variant="outline" size="sm" busy={busy} disabled={busy} onClick={() => { void upload() }}>{t('migrationUpload')}</Button>
        </div>
        {error !== undefined && <ErrorLine error={error} title={t('loadFailed')} />}
        {report !== undefined && <RestoreReportView report={report} />}
        {applied !== undefined
          ? <>
            <Hint>{t('migrationApplied', { backup: applied.backup })}</Hint>
            {/* Naming the blocked tickets is the point of allowing a restore whose projects are not here yet. */}
            {applied.blocked.length > 0 && <Hint>{t('migrationBlockedTickets', { count: String(applied.blocked.length) })}</Hint>}
          </>
          : <Button variant="danger" size="sm" busy={busy} disabled={busy || blocked || report === undefined}
            onClick={() => { void apply() }}>{t('migrationApply')}</Button>}
      </>}
  </Section>
}

/** What the archive holds, and what would stop it from being restored. */
function RestoreReportView({ report }: { report: RestoreReport }) {
  const { t } = usePanel()
  const blocked = report.problems.length > 0
  return <div className="dt-restore-report">
    <p className="dt-hint">{t('migrationReportSummary', { tickets: report.tickets, bytes: size(report.bytes) })}</p>
    {report.problems.map(problem => <ErrorLine key={problem} error={problem} />)}
    {report.missingDirectories.length > 0 && <>
      {/* A warning rather than an error: the restore proceeds, and these tickets are blocked until the projects exist. */}
      <Hint>{t('migrationMissingDirs', { count: String(report.missingDirectories.length) })}</Hint>
      <ul className="dt-restore-paths">{report.missingDirectories.slice(0, 8).map(path => <li key={path} className="dt-mono">{path}</li>)}</ul>
    </>}
    {report.notes.length > 0 && <Hint>{report.notes.join('; ')}</Hint>}
    {!blocked && <Hint>{t('migrationReadyToApply')}</Hint>}
  </div>
}

/** The Migration page. */
export function MigrationSettings({ view }: { view: MigrationView }) {
  const { t } = usePanel()
  return <div className="dt-form">
    <ExportCard view={view} />
    <RestoreCard canImport={view.canImport} />
    <Hint>{t('migrationAfterExport')}</Hint>
  </div>
}

/**
 * The settings group's entry point: it loads what a move would carry before rendering.
 *
 * `usePoll` with no dependencies loads once and offers a retry, which is right here: the entry list only changes when
 * the operator adds a session or a workspace, not while the page is open.
 */
export function MigrationPage() {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET migration'), [])
  if (!data) return <LoadState error={error ?? undefined} loading={!error} onRetry={() => { void reload() }} />
  return <div className="dt-form">
    {error && <ErrorLine error={errorText(error)} title={t('loadFailed')} onRetry={() => { void reload() }} />}
    <MigrationSettings view={data} />
  </div>
}