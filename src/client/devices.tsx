/** Devices settings group: which machines may take work, whether each is online, and what it is running. */
import { useState } from 'react'
import type { DeviceRow } from '../app/views/devices.ts'
import { usePoll } from './api.ts'
import { Button, Dot } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { Card, Empty, ErrorLine, Hint, ListSection, PageHead, Section, StatCard, When } from './widgets.tsx'

/** The device list, read-only apart from revoking and rotating a token. */
export function DevicesSettings() {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET devices'), [])
  const [rotated, setRotated] = useState<{ id: string; token: string }>()
  const revoke = async (id: string) => { await call('POST devices/:id/revoke', { id }); await reload() }
  const rotate = async (id: string) => { setRotated({ id, token: (await call('POST devices/:id/rotate', { id })).token }); await reload() }
  return <>
    <PageHead back={false} title={t('settingsGroup.devices')} hint={t('devicesIntro')} />
    {data && <div className="dt-stats">
      <StatCard label={t('devicesTotal')} value={String(data.totals.devices)} />
      <StatCard label={t('devicesOnline')} value={String(data.totals.online)} tone={data.totals.online ? 'success' : 'info'} />
      <StatCard label={t('devicesRunning')} value={String(data.totals.running)} />
    </div>}
    <Section title={t('devicesList')}>
      <ListSection loading={!data} error={error ? errorText(error) : undefined} onRetry={() => { void reload() }}
        emptyTitle={t('devicesEmpty')} emptyHint={t('devicesEmptyHint')}>
        {data?.rows.length ? <ul className="dt-list" data-devices>{data.rows.map(row => <DeviceLine key={row.id} row={row}
          onRevoke={() => revoke(row.id)} onRotate={() => rotate(row.id)} />)}</ul> : undefined}
      </ListSection>
    </Section>
    {/* 新令牌只在这里显示一次：库里只有哈希，页面刷新后拿不回来。 */}
    {rotated && <Card title={t('devicesRotated')} tone="warn">
      <Hint>{t('devicesRotatedHint')}</Hint>
      <code className="dt-mono" data-device-token>{rotated.token}</code>
    </Card>}
    {error && data && <ErrorLine error={errorText(error)} title={t('loadFailed')} onRetry={() => { void reload() }} />}
  </>
}

/** One device: name, online dot, load, project names, last seen, and the two token actions. */
function DeviceLine({ row, onRevoke, onRotate }: { row: DeviceRow; onRevoke: () => Promise<void>; onRotate: () => Promise<void> }) {
  const { t } = usePanel()
  const [confirming, setConfirming] = useState(false)
  const tone = row.revoked ? 'idle' : row.online ? 'done' : 'warning'
  return <li className="dt-row" data-device={row.id} data-revoked={row.revoked ? 'true' : undefined}>
    <div className="dt-row-main">
      <div className="dt-row-title">
        <Dot state={tone} />
        {row.name}
        <span className="dt-mono">{row.id}</span>
        {row.revoked && <span className="dt-tag">{t('deviceRevoked')}</span>}
        {row.online && <span className="dt-tag" data-tone="success">{t('deviceOnline')}</span>}
      </div>
      <div className="dt-row-meta">
        <span>{t('deviceRunning', { count: String(row.running) })}</span>
        {row.projects.length > 0 && <span>{row.projects.join(t('listSeparator'))}</span>}
        {row.labels.length > 0 && <span>{row.labels.join(t('listSeparator'))}</span>}
        {row.lastSeenAt && <span>{t('deviceLastSeen')} <When at={row.lastSeenAt} /></span>}
      </div>
    </div>
    <div className="dt-row-actions">
      {!row.revoked && (confirming
        ? <><Button variant="danger" size="sm" onClick={() => { setConfirming(false); void onRevoke() }}>{t('deviceRevokeConfirm')}</Button>
          <Button size="sm" onClick={() => setConfirming(false)}>{t('cancel')}</Button></>
        : <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>{t('deviceRevoke')}</Button>)}
      {!row.revoked && <Button variant="ghost" size="sm" onClick={() => { void onRotate() }}>{t('deviceRotate')}</Button>}
    </div>
  </li>
}
