/** Shared settings context, block draft hook, form controls, Source schema field renderer, and configuration history. */
import { cloneElement, createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement,
  type ReactNode } from 'react'
import type { ApiResponse } from '../app/api.ts'
import type { FieldSpec, Localized, SecretSpec } from '../sources/kind.ts'
import { usePoll, type HistoryView, type Settings, type SettingsView, type SourceView } from './api.ts'
import { Button, DisclosureRow, Icon, IconButton, InfoTip, Input, SegmentedControl, Switch } from './controls.tsx'
import { useDraft, type DraftState } from './draft.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { settingsRoute } from './route.ts'
import { errorText, localized, valueLabel, when, type T } from './text.ts'
import { ErrorLine, Hint } from './widgets.tsx'

/** Parse a numeric input string, returning `null` when empty so the server rejects blank required numbers instead of coercing to 0. */
export const numberOf = (text: string): number | null => text.trim() ? Number(text) : null
interface SettingsData { settings: SettingsView; reload: () => Promise<void> }
/** 设置数据的查询态：左栏（骨架/错误）与右栏（守门）各自决定画什么，所以暴露未就绪的情况。 */
export interface SettingsQuery {
  settings?: SettingsView | undefined
  error?: Error | undefined
  reload: () => Promise<void>
}
const SettingsContext = createContext<SettingsQuery | undefined>(undefined)
export function useSettingsQuery(): SettingsQuery {
  const value = useContext(SettingsContext)
  if (!value) throw new Error('A settings block rendered outside the settings')
  return value
}
export function useSettings(): SettingsData {
  const { settings, reload } = useSettingsQuery()
  if (!settings) throw new Error('A settings block read the settings before they arrived')
  return { settings, reload }
}
/**
 * 只提供数据，不替换子树：设置没到时由调用方决定在哪画骨架/错误。
 * 之前的写法在 Provider 里直接返回 LoadState，左栏会跟着右栏一起消失，整页先塌成一行再跳回来。
 * 读取失败且已有旧数据时不抽走页面，把提示交给右栏的守门组件。
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const { call } = usePanel()
  const { restarts } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET settings'), [call, restarts])
  return <SettingsContext.Provider value={{ settings: data, error, reload }}>{children}</SettingsContext.Provider>
}
export function useBlockDraft<V>(block: string, saved: V, revision: number, toValue: (draft: V) => unknown = draft => draft) {
  const { t, call, notify } = usePanel()
  const { state } = usePanelData()
  const { reload } = useSettings()
  return useDraft({ key: `dsh-foreman/draft/${state?.masterId ?? ''}/${block}`, saved, revision, reload, save: async (value, from) => {
    const result = await call('PUT settings/:block', { block, body: { value: toValue(value), revision: from } })
    notify(t(result.restarting ? 'savedRestarting' : 'saved'))
    return result
  } })
}

/**
 * 服务端 422 只回 `issues[].path`（没有字段容器），这里把路径散给各 Field 自查。
 * 路径层级随来源不同（`config.x` / `x`），所以按“末段相同”匹配，宁可多报也不漏报。
 */
const InvalidFieldsContext = createContext<readonly string[]>([])
export function FieldErrors({ issues, children }: { issues: readonly string[]; children: ReactNode }) {
  return <InvalidFieldsContext.Provider value={issues}>{children}</InvalidFieldsContext.Provider>
}
/** 从草稿状态里取非法字段路径；非 422 失败没有路径，返回空数组。 */
export const invalidFields = (state: DraftState<unknown, unknown>): readonly string[] =>
  state.notice?.kind === 'invalid' ? state.notice.fields : []
const samePath = (issue: string, path: string): boolean =>
  issue === path || issue.endsWith(`.${path}`) || path.endsWith(`.${issue}`)
export function useFieldError(path: string | undefined): string | undefined {
  const { t } = usePanel()
  const issues = useContext(InvalidFieldsContext)
  if (path === undefined) return undefined
  return issues.some(issue => samePath(issue, path)) ? t('invalidField') : undefined
}

/** Fieldset wrapper that restores focus to the previously active input after a save completes and re-enables the form. */
export function Fields({ disabled, label, children }: { disabled: boolean; label?: string; children: ReactNode }) {
  const set = useRef<HTMLFieldSetElement>(null)
  const focused = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const active = document.activeElement
    if (disabled) focused.current = active instanceof HTMLElement && set.current?.contains(active) ? active : null
    else if (focused.current && (!active
      || active === document.body)) { focused.current.focus({ preventScroll: true }); focused.current = null }
  }, [disabled])
  // legend 只给读屏用（.dt-sr-only）：视觉上分组靠卡片边界，语义上靠 legend。
  return <fieldset ref={set} className="dt-fieldset" disabled={disabled}>
    {label !== undefined && <legend className="dt-sr-only">{label}</legend>}{children}
  </fieldset>
}

/**
 * 字段栅格：设置页的短字段统一进两列（`.dt-field-grid`，窄屏由 CSS 折成单列）。
 * 只包短字段（数字 / 文本 / 分段 / 开关）；rows 这类宽控件留在栅格外，避免被压成半列。
 */
export function FieldGrid({ children }: { children: ReactNode }) {
  return <div className="dt-field-grid">{children}</div>
}
type FieldControl = { id?: string; 'aria-labelledby'?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean
  'aria-required'?: boolean }
/**
 * 一个字段 = 标签 + 控件 + 说明/错误。
 * 标签与控件的关联对原生控件靠 htmlFor，对 SegmentedControl 这类非表单控件它会被忽略，
 * 所以额外补 `aria-labelledby` 与“点标签聚焦当前选项”，否则点标签什么都不发生。
 */
export function Field({ label, hint, note, path, required = false,
  children }: { label: string; hint?: string | undefined; note?: ReactNode; path?: string; required?: boolean
  children: ReactElement<FieldControl> }) {
  const { t } = usePanel()
  const id = useId(), head = `${id}-label`, noteId = `${id}-note`, errorId = `${id}-error`
  const invalid = useFieldError(path)
  const described = invalid !== undefined ? errorId : note !== undefined ? noteId : undefined
  // 原生控件点 label 由浏览器聚焦；tablist 不会，这里补一次。
  const focusControl = () => {
    const control = document.getElementById(id)
    if (!control || control.tagName === 'INPUT' || control.tagName === 'SELECT' || control.tagName === 'TEXTAREA') return
    control.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
  }
  return <div className="dt-field" data-invalid={invalid === undefined ? undefined : 'true'}>
    <span className="dt-field-head">
      <label id={head} htmlFor={id} onClick={focusControl}>{label}</label>
      {/* 星号与“必填”放在 label 外：label 文本必须与字段名逐字相同（可点区域与读屏名都靠它），必填语义由 aria-required 承担。 */}
      {required && <><span className="dt-required" aria-hidden="true">*</span><span className="dt-sr-only">{t('requiredField')}</span></>}
      {hint && <InfoTip text={hint} />}
    </span>
    {cloneElement(children, { id, 'aria-labelledby': head, 'aria-invalid': invalid === undefined ? undefined : true,
      'aria-required': required || undefined, ...described === undefined ? {} : { 'aria-describedby': described } })}
    {invalid !== undefined && <div id={errorId}><ErrorLine error={invalid} /></div>}
    {note !== undefined && <small id={noteId}>{note}</small>}
  </div>
}
function SwitchRow({ label, hint, checked,
  onChange }: { label: string; hint?: string | undefined; checked: boolean; onChange: (next: boolean) => void }) {
  return <div className="dt-switch-row">
    <div className="dt-field-head">{label}{hint && <InfoTip text={hint} />}</div><Switch checked={checked} onChange={onChange}
      label={label} />
  </div>
}
type RoleModel = Settings['eval']['model']
export function ModelField({ id, value, onChange }: { id: string; value: RoleModel; onChange: (next: RoleModel) => void }) {
  const { t, call } = usePanel()
  const [catalog, setCatalog] = useState<ApiResponse<'GET models'>>()
  const [error, setError] = useState<string>()
  useEffect(() => { call('GET models').then(setCatalog, failure => setError(errorText(failure))) }, [call])
  const current = { provider: value?.provider ?? '', model: value?.model ?? '', effort: value?.reasoningEffort ?? '' }
  const set = (next: Partial<typeof current>) => {
    const { provider, model, effort } = { ...current, ...next }
    onChange(provider.trim() || model.trim() || effort.trim() ? { provider, model, ...effort ? { reasoningEffort: effort } : {} } : null)
  }
  const models = catalog?.groups.find(group => group.id === current.provider.trim())?.models ?? []
  const fallback = catalog?.default
  const input = (name: keyof typeof current, label: string, placeholder: string) => <Field label={label}>
    <Input list={`${id}-${name}s`} spellCheck={false} placeholder={placeholder} value={current[name]}
      onChange={event => set({ [name]: event.target.value })} />
  </Field>
  return <div className="dt-model">
    <Hint>{fallback ? t('defaultModel', { model: `${fallback.provider} / ${fallback.model}${fallback.reasoningEffort
      ? ` · ${fallback.reasoningEffort}` : ''}` }) : t('defaultModelUnavailable')}</Hint>
    {error && <ErrorLine error={t('modelCatalogError', { error })} />}
    {/* 三个模型字段走统一的字段栅格：与部署限额、来源字段保持同一节奏。 */}
    <FieldGrid>
      {input('provider', t('modelProvider'), t('modelInherit'))}{input('model', t('modelName'), t('modelInherit'))}{input('effort',
        t('modelEffort'), t('modelEffortDefault'))}
    </FieldGrid>
    <datalist id={`${id}-providers`}>{catalog?.groups.map(group => <option key={group.id}
      value={group.id}>{group.name}</option>)}</datalist>
    <datalist id={`${id}-models`}>{models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist>
    <datalist id={`${id}-efforts`}>
      {(models.find(model => model.id === current.model.trim())?.reasoning?.efforts ?? []).map(effort => <option key={effort.id}
        value={effort.id}>{effort.name}</option>)}
    </datalist>
  </div>
}

type HistoryChange = NonNullable<HistoryView['items'][number]['changes']>[number]
function changeText(t: T, change: HistoryChange, sources: SourceView[]): string {
  const source = sources.find(item => item.id === change.source)
  const field = (change.part ? source?.policy?.fields : source?.fields)?.find(item => item.key === change.field)
  const shown = (value: unknown) => value === undefined || value === null || value === '' ? t('unsetValue') : typeof value === 'boolean'
    ? t(value ? 'yes' : 'no')
    : change.code === 'mode' ? valueLabel(t, 'mode', String(value)) : String(value)
  return t(`change.${change.code}`,
    { items: (change.items ?? []).map(item => source?.labels[item] ?? item).join(t('listSeparator')),
    from: shown(change.from), to: shown(change.to), name: change.name ?? '', source: source ? localized(t, source.title)
      : change.source ?? '',
    field: field ? localized(t, field.label) : change.field ?? '' })
}
/**
 * Collapsible revision history for the specified settings blocks, optionally including all Policy-changing saves.
 * Revisions saved before per-block tracking existed have no `block` and appear under `policy`.
 */
export function ConfigHistory({ blocks, versions, focus }: { blocks: string[]; versions?: boolean; focus?: string }) {
  const { t, call } = usePanel()
  const { settings } = useSettings()
  const { sources } = settings
  const [open, setOpen] = useState(!!focus)
  const [data, setData] = useState<HistoryView>()
  const [error, setError] = useState<string>()
  const revisions = JSON.stringify([Object.values(settings.blocks).map(block => block.revision), sources.map(source => source.revision)])
  useEffect(() => { if (open) call('GET policy/history').then(setData, failure => setError(errorText(failure))) }, [open, call, revisions])
  const listed = (block: string | undefined) => block ? blocks.some(item => item === block || (item.endsWith(':')
    && block.startsWith(item))) : blocks.includes('policy')
  const items = data?.items.filter(item => (versions && item.policyChanged) || listed(item.block)) ?? []
  // Match the oldest save that produced the focused Policy version (where that version originated).
  const target = focus ? items.filter(item => item.policyChanged && item.policyVersion.startsWith(focus)).at(-1) : undefined
  const scroll = (element: HTMLLIElement | null) => { if (element
    && !element.dataset.scrolled) { element.dataset.scrolled = '1'; element.scrollIntoView?.({ block: 'center' }) } }
  return <DisclosureRow icon={<Icon name="history" />} title={t('configHistory')} open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      {error && <ErrorLine error={error} />}
      {data && <>
        <Hint>{t('historyIntro')}</Hint>
        {focus && !target && <Hint>{t('policyVersionUnrecorded', { version: focus.slice(0, 8) })}</Hint>}
        {items.length ? <ul className="dt-timeline">{items.map(item => <li key={item.revision} className={item === target
          ? 'dt-event dt-highlight' : 'dt-event'}
          ref={item === target ? scroll : undefined}>
          <div className="dt-row-title">{t('historyItem', { revision: item.revision, source: valueLabel(t, 'historySource',
            item.source) })}</div>
          <div className="dt-event-foot">{when(item.savedAt, t('lang'))}{item.policyChanged && <> · {t('historyPolicyChanged',
            { version: item.policyVersion.slice(0, 8) })}</>}</div>
          {item.changes === null ? <Hint>{t('historyNoBaseline')}</Hint> : item.changes.length
            ? <ul className="dt-changes">{item.changes.map((change, index) => <li key={index}>{changeText(t, change, sources)}</li>)}</ul>
              : <Hint>{t('historyNoChanges')}</Hint>}
          {item.notified.length > 0 && <Hint>{t('historyNotified', { count: item.notified.length,
            titles: item.notified.map(ticket => ticket.title).join(t('listSeparator')) })}</Hint>}
        </li>)}</ul> : <Hint>{t('historyEmpty')}</Hint>}
      </>}
    </div>
  </DisclosureRow>
}

type Row = Record<string, string>
type Column = Extract<FieldSpec, { type: 'rows' }>['columns'][number]
const ROWS_SHOWN = 6
const byName = ([, a]: [string, string], [, b]: [string, string]) => a.localeCompare(b)
function RowsField({ field, value, saved, onChange, labels, refreshLabels }: {
  field: Extract<FieldSpec, { type: 'rows' }>; value: unknown; saved: unknown; onChange: (next: unknown) => void; labels: Record<string,
    string>
  refreshLabels: (() => Promise<string[]>) | undefined
}) {
  const { t, notify } = usePanel()
  const [open, setOpen] = useState(false)
  const invalid = useFieldError(field.key)
  const refresh = useAction(async () => {
    try {
      const added = await refreshLabels!()
      notify(added.length ? t('labelsAdded', { names: added.join(t('listSeparator')) }) : t('labelsCurrent'))
    } catch (failure) { notify(t('labelsFailed', { error: errorText(failure) })) }
  })
  const label = localized(t, field.label), hint = localized(t, field.hint)
  const rows = Array.isArray(value) ? value as Row[] : []
  const set = (index: number, row: Row) => onChange(rows.map((item, position) => position === index ? row : item))
  const key = field.columns[0]!
  const savedKeys = new Set((Array.isArray(saved) ? saved as Row[] : []).map(row => row[key.key]))
  const choose = key.type === 'text' && key.choose && Object.keys(labels).length ? localized(t, key.choose) : ''
  // Exclude options already selected in another row.
  const choices = (id: string) => Object.entries(labels).filter(([option]) => option === id
    || !rows.some(other => other[key.key] === option)).sort(byName)
  const blank = Object.fromEntries(field.columns.map(column => [column.key, column.type === 'select' ? column.options[0]!.value : '']))
  // Summarize a row by its second column only when that column is free text (e.g., a display name), not a select option.
  const named = field.columns[1]?.type === 'text' ? field.columns[1] : undefined
  const rowName = (row: Row) => (named && row[named.key]) || labels[row[key.key] ?? ''] || row[key.key] || ''
  const cell = (row: Row, index: number, column: Column) => {
    const id = row[key.key] ?? '', change = (next: string) => set(index, { ...row, [column.key]: next })
    if (column === key && (savedKeys.has(id) || (!choose && labels[id]))) {
      return <span key={column.key} className={labels[id] ? 'dt-row-label' : 'dt-row-label dt-mono'} title={id}>{labels[id] ?? id}</span>
    }
    if (column === key && choose) {
      return <select key={column.key} className="dt-select" aria-label={choose} required value={id}
        onChange={event => change(event.target.value)}>
        <option value="" disabled>{choose}</option>
        {choices(id).map(([option, name]) => <option key={option} value={option}>{name}</option>)}
      </select>
    }
    if (column.type === 'select') {
      return <select key={column.key} className="dt-select" aria-label={localized(t, column.label)} value={row[column.key] ?? ''}
        onChange={event => change(event.target.value)}>
        {column.options.map(option => <option key={option.value} value={option.value}>{localized(t, option.label)}</option>)}
      </select>
    }
    return <Input key={column.key} className={column.optional ? undefined : 'dt-mono'} aria-label={localized(t, column.label)}
      placeholder={localized(t, column.label)}
      required={!column.optional} pattern={column.pattern} spellCheck={false} value={row[column.key] ?? ''}
        onChange={event => change(event.target.value)} />
  }
  return <div className="dt-field" data-invalid={invalid === undefined ? undefined : 'true'}>
    <div className="dt-subhead">
      <span className="dt-field-head">{label}{hint && <InfoTip text={hint} />}<span className="dt-count">{rows.length || ''}</span></span>
      <span className="dt-subhead-actions">
        {key.type === 'text' && key.refresh && refreshLabels && <Button variant="ghost" size="sm" className={refresh.busy ? 'dt-btn-busy'
          : undefined} icon={<Icon name="refresh" />}
          disabled={refresh.busy} aria-busy={refresh.busy} onClick={() => { void refresh.run() }}>{localized(t, key.refresh)}</Button>}
        {/* 新增用描边而不是 ghost：白底卡片里 ghost 几乎看不见，行编辑最常见的第一步反而最难发现。 */}
        <Button variant="outline" size="sm" icon={<Icon name="plus" />} onClick={() => { setOpen(true); onChange([...rows,
          blank]) }}>{t('addRow')}</Button>
      </span>
    </div>
    {rows.length > ROWS_SHOWN && <button type="button" className="dt-textlink dt-rows-summary" aria-expanded={open}
      title={rows.map(rowName).join(t('listSeparator'))}
      onClick={() => setOpen(!open)}>
      {open ? t('collapse') : rows.map(rowName).join(t('listSeparator'))}
    </button>}
    {(rows.length <= ROWS_SHOWN || open) && <ul className="dt-rows"
      style={{ ['--dt-columns' as string]: field.columns.length }}>{rows.map((row, index) => <li key={index} className="dt-rows-item">
      {field.columns.map(column => cell(row, index, column))}
      {/* 破坏性动作：danger 图标按钮 + tooltip，语义与确认由 aria-label/title 与 notify 一起承担。 */}
      <IconButton icon="trash" tone="danger" size="sm" label={t('removeRow', { name: rowName(row) })}
        onClick={() => { onChange(rows.filter((_, position) => position !== index))
          notify(t('deletedRecord', { name: rowName(row) })) }} />
    </li>)}</ul>}
    {invalid !== undefined && <ErrorLine error={invalid} />}
  </div>
}
/**
 * The CLI picker: a dropdown of what the machine has, a refresh button, and the credential form once one is chosen.
 *
 * Why a dropdown rather than a path box: an operator cannot type the absolute path of an installed CLI from memory, and
 * a typo produced a Source that silently never ran. The refresh button rescan exists because installing the CLI is
 * exactly when the old answer is wrong.
 *
 * The credential fields appear once a CLI is chosen — before that there is no account to give credentials for, and
 * asking earlier would be a form with no purpose.
 */
const TYPED = '__typed__'

function CliField({ field, label, hint, value, clis, onRefreshClis, onChange, secret, onSecret, fact, setKeys }: {
  field: Extract<FieldSpec, { type: 'cli' }>; label: string; hint: string; value: string
  clis: string[]; onRefreshClis?: () => Promise<string[]>; onChange: (next: string) => void
  secret?: Record<string, string>; onSecret?: (next: Record<string, string>) => void
  fact?: Localized | string | undefined
  setKeys?: string[]
}) {
  const { t, notify } = usePanel()
  const invalid = useFieldError(field.key)
  const [refusal, setRefusal] = useState<string>()
  const refresh = useAction(async () => {
    if (!onRefreshClis) return
    try {
      const found = await onRefreshClis()
      setRefusal(undefined)
      notify(found.length ? t('cliRefreshFound', { count: String(found.length) }) : t('cliRefreshEmpty'))
    } catch (failure) { setRefusal(errorText(failure)) }
  })
  // The stored value is shown even when the scan no longer reports it: a CLI that moved must stay visible so the
  // operator can see what was configured instead of finding an empty box they did not clear.
  const options = value !== '' && !clis.includes(value) ? [value, ...clis] : clis
  // "Type a path" is a real option, not a fallback: a wrapper script (a gh signed in through GH_CONFIG_DIR) is the
  // documented way to give an agent its own account, and it will never appear in a scan of standard directories.
  const [typed, setTyped] = useState(false)
  // The fact describes the SAVED value: an edited CLI reports no account until it is saved and probed again.
  const note = localized(t, fact)
  return <div className="dt-field">
    <span className="dt-field-head">{label}{hint && <InfoTip text={hint} />}</span>
    {note && <small className="dt-hint">{note}</small>}
    <div className="dt-cli-row">
      {typed
        ? <Input value={value} placeholder="/usr/local/bin/gh" spellCheck={false} aria-label={label}
          onChange={event => onChange(event.target.value)} />
        : <select className="dt-select" aria-label={label} value={value}
          onChange={event => {
            if (event.target.value === TYPED) { setTyped(true); return }
            onChange(event.target.value)
          }}>
          <option value="">{t('cliAutoFind', { names: field.fallbacks.join(', ') })}</option>
          {options.map(option => <option key={option} value={option}>{option}</option>)}
          <option value={TYPED}>{t('cliTypePath')}</option>
        </select>}
      <IconButton icon="refresh" size="sm" label={t('cliRefresh')}
        onClick={() => { setTyped(false); void refresh.run() }} />
    </div>
    {!options.length && <Hint>{t('cliRefreshHint')}</Hint>}
    {refusal !== undefined && <ErrorLine error={refusal} />}
    {invalid !== undefined && <ErrorLine error={invalid} />}
    {field.secret && value !== '' && onSecret && <SecretFields spec={field.secret} value={secret ?? {}}
      onChange={onSecret} setKeys={setKeys} />}
  </div>
}

/** The credential inputs of one CLI, as declared by the Source's `SecretSpec`. */
function SecretFields({ spec, value, onChange, setKeys = [] }: {
  spec: SecretSpec; value: Record<string, string>; onChange: (next: Record<string, string>) => void
  /** Keys that already hold a stored value; their box stays blank and says so, because the panel never receives it. */
  setKeys?: string[]
}) {
  const { t } = usePanel()
  return <fieldset className="dt-secret">
    <legend>{t('cliSecretLegend')}</legend>
    <Hint>{localized(t, spec.help) && `${t('cliSecretHelp')}${localized(t, spec.help)}`}</Hint>
    <FieldGrid>
      {spec.fields.map(item => <Field key={item.key} label={localized(t, item.label)}
        hint={item.hint ? localized(t, item.hint) : undefined}>
        <Input type={item.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} pattern={item.pattern}
          placeholder={setKeys.includes(item.key) ? t('cliSecretKeep') : undefined}
          value={value[item.key] ?? ''} onChange={event => onChange({ ...value, [item.key]: event.target.value })} />
      </Field>)}
    </FieldGrid>
  </fieldset>
}

export function SourceField({ field, value, saved, fact, onChange, labels, refreshLabels, clis, onRefreshClis, secret, onSecret, setKeys }: {
  field: FieldSpec; value: unknown; saved: unknown; fact: Localized | string | undefined; onChange: (next: unknown) => void
  labels: Record<string, string>
  refreshLabels?: () => Promise<string[]>
  /** Known binaries of this Source's CLI, and a way to rescan the machine. */
  clis?: string[]; onRefreshClis?: () => Promise<string[]>
  /** Stored credential of this Source: the draft's values, which start empty because the panel never receives one. */
  secret?: Record<string, string>; onSecret?: (next: Record<string, string>) => void
  /** Keys that already have a stored value, so a blank box can say "leave unchanged" instead of looking empty. */
  setKeys?: string[]
}) {
  const { t, navigate } = usePanel()
  const label = localized(t, field.label), hint = localized(t, field.hint)
  switch (field.type) {
    case 'switch': return <SwitchRow label={label} hint={hint} checked={value === true} onChange={onChange} />
    case 'cli': return <CliField field={field} label={label} hint={hint} value={String(value ?? '')} clis={clis ?? []}
      onRefreshClis={onRefreshClis} onChange={next => onChange(next)} secret={secret} onSecret={onSecret} fact={fact}
      setKeys={setKeys} />
    case 'select': return <Field label={label} hint={hint} path={field.key}>
      <SegmentedControl className="dt-segmented dt-field-segmented" label={label} value={String(value ?? field.options[0]!.value)}
        options={field.options.map(option => ({ value: option.value, label: localized(t, option.label) }))} onChange={onChange} />
    </Field>
    case 'number': return <Field label={label} hint={hint} path={field.key} required>
      <Input type="number" min={field.min} max={field.max} required value={String(value ?? '')}
        onChange={event => onChange(event.target.value === '' ? '' : Number(event.target.value))} />
    </Field>
    case 'text': return <Field label={label} hint={hint} note={localized(t, fact)} path={field.key}>
      {field.choose && Object.keys(labels).length
        ? <select className="dt-select" value={String(value ?? '')} onChange={event => onChange(event.target.value)}>
          <option value="">{localized(t, field.choose)}</option>
          {value && !labels[String(value)] ? <option value={String(value)}>{String(value)}</option> : null}
          {Object.entries(labels).sort(byName).map(([option, name]) => <option key={option} value={option}>{name}</option>)}
        </select>
        : <Input value={String(value ?? '')} readOnly={field.readonly} pattern={field.pattern} spellCheck={false}
          onChange={event => onChange(event.target.value)} />}
    </Field>
    case 'fact': return <div className="dt-field">
      <span className="dt-field-head">{label}{hint && <InfoTip text={hint} />}</span>
      <span className="dt-mono">{localized(t, fact) || t('empty')}</span>
      {field.settings && <small>
        <button type="button" className="dt-textlink"
          onClick={() => navigate(settingsRoute(field.settings!))}>{t(`openSettingsOf.${field.settings}`)}</button>
      </small>}
    </div>
    case 'rows': return <RowsField field={field} value={value} saved={saved} onChange={onChange} labels={labels}
      refreshLabels={refreshLabels} />
  }
}
