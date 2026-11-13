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
import { useState } from 'react'
import { Button, Icon } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { usePoll } from './api.ts'
import { errorText } from './text.ts'
import { ErrorLine, Hint, LoadState, Section } from './widgets.tsx'

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
 * The restore card.
 *
 * It is deliberately not a working button yet: restoring replaces the ledger under a running hub, so it is staged as
 * upload → check → stop → swap → restart, and a half-built version of that flow is worse than none — it would look
 * like a restore succeeded while the ledger it replaced was already gone.
 */
function RestoreCard() {
  const { t } = usePanel()
  const [notice] = useState<string | undefined>(undefined)
  return <Section title={t('migrationImportTitle')} hint={t('migrationImportHint')}>
    <Hint>{notice ?? t('migrationImportNotYet')}</Hint>
    <Button variant="outline" size="sm" disabled>{t('migrationImportButton')}</Button>
  </Section>
}

/** The Migration page. */
export function MigrationSettings({ view }: { view: MigrationView }) {
  const { t } = usePanel()
  return <div className="dt-form">
    <ExportCard view={view} />
    <RestoreCard />
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