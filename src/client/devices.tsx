/** Devices settings group: which machines may take work, whether each is online, and what it is running. */
import { Fragment, useState } from 'react'
import type { DeviceRow } from '../app/views/devices.ts'
import { usePoll } from './api.ts'
import { Button, Dot, Input } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { Field, FieldGrid } from './settings-kit.tsx'
import { Card, Empty, ErrorLine, Hint, KeyValues, ListSection, PageHead, Section, StatCard, When } from './widgets.tsx'

/** The device list, the registration form, and the two token actions. */
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
    <AddDevice onAdded={() => { void reload() }} />
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

/** One row being filled in: the project's logical name and the path it maps to on that machine. */
interface RootDraft { project: string; path: string }

/**
 * Registering a machine, in place.
 *
 * The three values the machine needs are shown together and once: the hub keeps only a token hash, so a token that
 * leaves this card is gone. That is why the card is not dismissible: closing it is losing the token, and the page
 * says so instead of letting someone find out at the device.
 */
function AddDevice({ onAdded }: { onAdded: () => void }) {
  const { t, call } = usePanel()
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [roots, setRoots] = useState<RootDraft[]>([])
  const [minted, setMinted] = useState<{ id: string; token: string }>()
  const [refusal, setRefusal] = useState<string>()
  const [busy, setBusy] = useState(false)
  const register = async () => {
    setBusy(true); setRefusal(undefined)
    try {
      const result = await call('POST devices', { body: { id: id.trim(), name: name.trim(), labels: [],
        roots: roots.map(root => ({ project: root.project.trim(), path: root.path.trim() })) } })
      setMinted({ id: result.id, token: result.token })
      setId(''); setName(''); setRoots([])
      onAdded()
    } catch (error) { setRefusal(errorText(error)) } finally { setBusy(false) }
  }
  const edit = (index: number, patch: Partial<RootDraft>) => {
    setRoots(current => current.map((root, at) => at === index ? { ...root, ...patch } : root))
  }
  return <>
    <Card title={t('devicesAdd')} hint={t('devicesAddHint')}>
      <FieldGrid>
        <Field label={t('devicesAddId')} required>
          <Input value={id} onChange={event => setId(event.target.value)} placeholder="laptop" />
        </Field>
        <Field label={t('devicesAddName')} required>
          <Input value={name} onChange={event => setName(event.target.value)} />
        </Field>
      </FieldGrid>
      {roots.length > 0 && <FieldGrid>
        {roots.map((root, index) => <Fragment key={index}>
          <Field label={index === 0 ? t('devicesAddProject') : `${t('devicesAddProject')} ${index + 1}`}>
            <Input value={root.project} onChange={event => edit(index, { project: event.target.value })} placeholder="shop" />
          </Field>
          <Field label={index === 0 ? t('devicesAddPath') : `${t('devicesAddPath')} ${index + 1}`}>
            <Input value={root.path} onChange={event => edit(index, { path: event.target.value })} placeholder="F:\\dsh\\shop" />
          </Field>
        </Fragment>)}
      </FieldGrid>}
      <div className="dt-form-actions">
        <Button size="sm" onClick={() => setRoots(current => [...current, { project: '', path: '' }])}>{t('devicesAddRoot')}</Button>
        <Button size="sm" variant="primary" busy={busy} disabled={id.trim() === '' || name.trim() === ''}
          onClick={() => { void register() }}>{t('devicesAddSubmit')}</Button>
      </div>
      {refusal !== undefined && <ErrorLine error={refusal} title={t('loadFailed')} />}
    </Card>
    {/* 令牌只在这里出现一次：库里只有哈希，刷新就没了。 */}
    {minted && <Card title={t('devicesAddMinted')} tone="warn">
      <Hint>{t('devicesAddMintedHint')}</Hint>
      <KeyValues rows={[
        ['url', `ws://127.0.0.1:8790`],
        ['deviceId', minted.id],
        ['token', minted.token],
      ]} />
      <code className="dt-mono" data-device-token>{minted.token}</code>
    </Card>}
  </>
}
