/** 每个来源的设置卡：卡片头（标题 + 启用开关）+ 字段 + 保存条。来源状态页已删除，状态与统计在概览里看。 */
import { useEffect, useState } from 'react'
import type { FieldSpec } from '../sources/kind.ts'
import type { SourceView } from './api.ts'
import { DisclosureRow, Icon, Switch, Tag } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { ConfigHistory, FieldErrors, FieldGrid, Fields, invalidFields, SourceField, useBlockDraft, useSettings } from './settings-kit.tsx'
import { localized } from './text.ts'
import { Card, CheckSetupButton, Empty, Hint, SetupMessage, StatusLine } from './widgets.tsx'

/** A Source block as the card edits it: the stored value plus the credentials typed on this card. */
type SourceValue = SourceView['value'] & { secret?: Record<string, string> }

/**
 * One source's settings card: card head (title + enable switch) + fields + save bar.
 * 表单包在卡片外面，保存条因此是 .dt-card 的最后一个直接子元素（契约与 spec 都按这个位置取），
 * 而卡片本身走 Card，标题仍是 .dt-card-title（测试按标题找卡片）。
 */
function SourceCard({ source }: { source: SourceView }) {
  const { t, call } = usePanel()
  const { running, setup } = usePanelData()
  const { reload } = useSettings()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // The binaries a fresh scan reports. Scanned on mount because the settings payload is cached by the page, and a CLI
  // installed a minute ago must not look absent until the next full reload.
  const [clis, setClis] = useState<string[] | undefined>(undefined)
  const refreshClis = async () => {
    const { found } = await call('GET sources/:id/clis', { id: source.id })
    setClis(found)
    return found
  }
  useEffect(() => { void refreshClis().catch(() => setClis([])) }, [source.id])
  const refreshLabels = async () => { const { added } = await call('POST sources/:id/labels',
    { id: source.id }); await reload(); return added }
  // Credentials typed on the card travel inside the draft value, so the ordinary submit path saves them and `dirty`
  // notices a credential typed without any other change. The panel never receives a stored value back, so this starts
  // empty and only the boxes the operator filled are sent; the server merges them over what it already has.
  const draft = useBlockDraft<SourceValue>(`source:${source.id}`, source.value, source.revision)
  const value = draft.value
  const { problem, value: saved } = source
  const changed = (key: string) => String(value.config[key] ?? '') !== String(saved.config[key] ?? '')
  // Saving a modified setup-sensitive field restarts dsh-foreman, interrupting running Assignments.
  const restarts = draft.dirty && source.restarts.some(changed)
  const description = localized(t, source.description)
  // host 没就绪时表单统一只读（与部署页同一条策略），否则会出现「一页能改、一页不能改」。
  const readOnly = Boolean(setup?.problem)
  // Hide derived facts for unsaved field edits until the new value is saved.
  const field = (spec: FieldSpec) => <SourceField key={spec.key} field={spec} value={value.config[spec.key]} saved={saved.config[spec.key]}
    labels={source.labels}
    refreshLabels={refreshLabels} fact={spec.type === 'fact' || !changed(spec.key) ? source.facts[spec.key] : undefined}
    clis={clis ?? source.clis}
    onRefreshClis={refreshClis}
    secret={source.secret}
    onSecret={next => draft.edit({ ...value, secret: next })}
    onChange={next => draft.edit({ ...value, config: { ...value.config, [spec.key]: next } })} />
  const specs = source.fields.filter(spec => !spec.advanced)
  // rows 是宽控件（一行多格 + 行内增删），塞进两列栅格会被压成半列，所以只有全部是短字段时才用栅格。
  const gridded = specs.every(spec => spec.type !== 'rows')
  const advanced = source.fields.filter(spec => spec.advanced)
  // 卡片头右侧：未安装时给状态徽标，已安装且可编辑时给启用开关（只读时开关没有意义，交给横幅解释）。
  const actions = !source.installed ? <Tag tone="warning">{t('sourceNotInstalled')}</Tag>
    : readOnly ? undefined
    : <Switch checked={value.enabled} onChange={enabled => draft.edit({ ...value, enabled })}
      label={t('sourceEnable', { name: localized(t, source.title) })} />
  return <form id={`dt-source-${source.id}`} className="dt-form" onSubmit={event => { void draft.submit(event) }}>
    {/* v2 契约：卡片头的标题里再包一层 .dt-row-title（CSS 在 .dt-card-head 内让它 display:contents），
        这样 .dt-card-title 与 .dt-row-title 都能逐字读到来源名，徽标/开关仍只放在 .dt-card-actions。 */}
    <Card title={<span className="dt-row-title">{localized(t, source.title)}</span>} hint={description || undefined}
      actions={actions}>
      {readOnly && <p className="dt-banner">{t('readOnlyBanner')}</p>}
      {/* Setup 问题放在 fieldset 外：只读时字段全禁用，但「重新检查」必须还能点。 */}
      {problem && <StatusLine actions={<CheckSetupButton />}><SetupMessage problem={problem} lead /></StatusLine>}
      <FieldErrors issues={invalidFields(draft.state)}>
        <Fields disabled={draft.busy || readOnly} label={localized(t, source.title)}>
          {!source.installed && <Hint>{t('sourceNotInstalledHint')}</Hint>}
          {source.installed && gridded && <FieldGrid>{specs.map(field)}</FieldGrid>}
          {source.installed && !gridded && specs.map(field)}
          {source.installed && advanced.length > 0 && <DisclosureRow icon={<Icon name="settings" />} title={t('advanced')} open={advancedOpen}
            onToggle={() => setAdvancedOpen(!advancedOpen)}>
            <div className="dt-disclosure-body">{advanced.map(field)}</div>
          </DisclosureRow>}
        </Fields>
      </FieldErrors>
      <SaveBar {...draft} status={restarts && running > 0 ? t('restartInterrupts', { count: running }) : undefined}
        onDiscard={draft.discard} />
    </Card>
  </form>
}

export function SourceSettings({ focus }: { focus?: string }) {
  const { t } = usePanel()
  const { sources } = useSettings().settings
  // 一屏一张卡：左栏选中的那个来源才是详情（没选时默认第一个）。
  // 卡片仍然都在 DOM 里（隐藏的只是不显示），这样切换选项不会丢掉各卡自己的草稿状态。
  const selected = sources.find(source => source.id === focus)?.id ?? sources[0]?.id
  // 一个来源都没装：给空态，否则这里只剩一条版本历史，看起来像加载坏了。
  if (!sources.length) return <div className="dt-form">
    <Empty title={t('emptyList')} hint={t('emptyListHint')} />
    <ConfigHistory blocks={['source:']} />
  </div>
  return <div className="dt-form">
    {sources.map(source => <div key={source.id} hidden={source.id !== selected}>{<SourceCard source={source} />}</div>)}
    <ConfigHistory blocks={['source:']} />
  </div>
}
