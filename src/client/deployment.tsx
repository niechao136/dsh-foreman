/**
 * Deployment settings view shared between the panel Settings tab and the DSH Plugin Manager config page.
 * Edits host-level plugin configuration limits through DSH `ConfigForm` when writable.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { LIMITS } from '../limits.ts'
import type { SetupView } from './api.ts'
import { Input } from './controls.tsx'
import { SaveBar, useDraft } from './draft.tsx'
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
import { Field, FieldErrors, FieldGrid, Fields, invalidFields } from './settings-kit.tsx'
import { setupText, type T } from './text.ts'
import { Card, CheckSetupButton, Hint, LoadState, MetaList, PageHead, RepairSetupButton, SetupMessage, StatusLine } from './widgets.tsx'

export type DeploymentForm = ConfigPageForm | undefined
type Op = Parameters<ConfigPageForm['mutate']>[0][number]

const MACHINE_LIMITS = ['promptMaxChars', 'admissionContextMaxPages', 'admissionContextTimeoutMs'] as const
type Limits = Record<typeof MACHINE_LIMITS[number], string>
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const limitsOf = (values: object | undefined): Limits =>
  Object.fromEntries(MACHINE_LIMITS.map(key => [key, text((values as Record<string, unknown> | undefined)?.[key])])) as Limits
/**
 * One CLI row of the tools card.
 *
 * A found GitHub CLI is still reported as unused when no repository is subscribed: that is the state this row exists to
 * make visible, since setup silently skips the CLI check in that case.
 */
const cliText = (cli: SetupView['clis']['github'] | undefined, t: T): string => {
  if (!cli) return t('unsetValue')
  if (cli.state === 'unset') return t('deploymentCliUnset')
  if (cli.state === 'error') return t('deploymentCliMissing', { detail: cli.detail })
  return t('deploymentCliFound', { path: cli.path })
}
/**
 * The GitHub CLI row, which also has to say when a found CLI is not used.
 *
 * 为什么这一行特殊：没有订阅仓库时 setup 根本不检查 gh，正是“装了却没用”这个容易误判为“没发现”的状态。
 */
const githubCliText = (setup: SetupView, t: T): string => {
  const found = cliText(setup.clis?.github, t)
  return setup.clis?.github?.state === 'found' && !setup.accounts?.repositories.length
    ? `${found} · ${t('deploymentCliUnused')}` : found
}
export function usePageForm(form: ConfigForm<Record<string, unknown>> | undefined): DeploymentForm {
  const subscribe = useCallback((listener: () => void) => form ? form.subscribe(listener) : () => {}, [form])
  const state = useSyncExternalStore(subscribe, () => form?.getSnapshot())
  return useMemo(() => form && state ? { state, mutate: form.mutate.bind(form) } : undefined, [form, state])
}

/**
 * Deployment configuration form; falls back to read-only display when DSH config forms are unavailable or read-only.
 * `head` 只给插件管理的整页视图用：面板里的部署页外层已经有 PageHead（分组名），再来一个就是双标题。
 */
export function DeploymentPage({ setup, form, accounts: showAccounts, head = false }: {
  setup: SetupView; form: DeploymentForm; accounts?: boolean; head?: boolean
}) {
  const { t, notify } = usePanel()
  const snapshot = form?.state
  const editable = snapshot?.status === 'ready' && snapshot.writable
   // Pass `revision` only while DSH serves writable values so a draft started before `ready` rebases once writable.
  const draft = useDraft({ saved: limitsOf(editable ? snapshot.value : setup.machine), revision: editable ? snapshot.revision : undefined,
    reload: async () => {},
    save: async (value, revision, base) => {
      const ops: Op[] = MACHINE_LIMITS.filter(key => value[key].trim() !== base[key].trim())
        .map(key => value[key].trim() ? { op: 'set', path: [key], value: Number(value[key]) } : { op: 'unset', path: [key] })
      if (!form || !await form.mutate(ops, revision)) throw new Error(t('deploymentRefused'))
      notify(t('saved'))
      return { revision: revision + 1, restarting: false }
    } })
  const accounts = setup.accounts
  // Remote browsers (`memory` mode) are read-only; `unavailable` indicates `dsh-foreman` is still starting.
  const readOnlyHint = !form ? t('deploymentNoForms') : snapshot?.mode === 'memory' ? t('deploymentReadOnly')
    : snapshot?.status === 'loading' ? t('loading') : snapshot?.status === 'unavailable' ? t('deploymentUnavailable')
    : !editable ? t('deploymentReadOnly') : undefined
  // 禁用交给外层 fieldset 一处承担，同时逐控件 disabled（jsdom 不实现 fieldset 的禁用语义，只靠 fieldset 断言会假通过）。
  const limit = (key: typeof MACHINE_LIMITS[number], label: string) => <Field label={label} path={key} required>
    <Input type="number" min={LIMITS[key].min} max={LIMITS[key].max} step={1} required disabled={draft.busy || !editable}
      value={draft.value[key]}
      onChange={event => draft.edit({ ...draft.value, [key]: event.target.value })} />
  </Field>
  // 这一行只讲部署期配置的飞书机器人；机器人检查的失败原因由后端按来源下发，部署页不读专属字段。
  const botProblem = setup.problems.find(problem => problem.place === 'feishu')
  const feishu = accounts?.feishu ? accounts.feishu.name || accounts.feishu.botId
    : botProblem ? setupText(t, botProblem) : t('deploymentFeishuNone')
  return <>
    {head && <PageHead back={false} title={t('settingsGroup.deployment')} />}
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      {/* Setup 问题放在 fieldset 外：只读时字段全禁用，但「重新检查」必须还能点。 */}
      {setup.problem && <StatusLine actions={setup.problem.code === 'foreignFile' && typeof setup.problem.values.file === 'string'
        ? <><RepairSetupButton file={setup.problem.values.file} /> <CheckSetupButton /></> : <CheckSetupButton />}>
        <SetupMessage problem={setup.problem} lead /></StatusLine>}
      <FieldErrors issues={invalidFields(draft.state)}>
        <Fields disabled={draft.busy || !editable} label={t('tab.settings')}>
          <Hint>{t('deploymentIntro')}</Hint>
          {/* 只读原因用状态行而不是正文段落：它随模式变化，是“现在为什么不能改”。 */}
          {readOnlyHint && <StatusLine>{readOnlyHint}</StatusLine>}
          {/* 一张卡一个主题：派生信息 → 本机路径 → 限额，字段只在最后一张卡里进两列栅格。 */}
          {showAccounts && <Card title={t('deploymentDerived')} hint={t('deploymentDerivedHint')}>
            <MetaList items={[
              { label: t('deploymentRepository'), value: accounts?.repositories.length
                ? accounts.repositories.join(t('listSeparator')) : t('unsetValue') },
              { label: t('deploymentAgent'), value: accounts ? `@${accounts.agent}` : t('unsetValue') },
              { label: t('deploymentFeishu'), value: feishu },
            ]} />
            <Hint>{t('deploymentAccountsWhere')}</Hint>
          </Card>}
          {/* 工具是否装上，和来源是否用了它，是两件事：这一张卡只回答“这台机器上有没有、装在哪”。 */}
          {showAccounts && <Card title={t('deploymentClis')} hint={t('deploymentClisHint')}>
            <MetaList items={[
              { label: t('deploymentGithubCli'), value: githubCliText(setup, t) },              { label: t('deploymentFeishuCli'), value: cliText(setup.clis?.feishu, t) },
            ]} />
          </Card>}
          <Card title={t('deploymentMachine')}>
            <MetaList items={[{ label: t('deploymentStateDir'),
              value: <span className="dt-mono">{setup.machine.stateDir}</span> }]} />
            <Hint>{t('deploymentStateDirHint')}</Hint>
          </Card>
          <Card title={t('deploymentLimits')} hint={t('deploymentLimitsHint')}>
            <FieldGrid>
              {limit('promptMaxChars', t('deploymentPromptMaxChars'))}
              {limit('admissionContextMaxPages', t('deploymentContextPages'))}
              {limit('admissionContextTimeoutMs', t('deploymentContextTimeout'))}
            </FieldGrid>
          </Card>
        </Fields>
      </FieldErrors>
      {editable && <SaveBar {...draft} onDiscard={draft.discard} />}
    </form>
  </>
}

/** Plugin Manager config page; includes derived repository and accounts because Source settings live in the main panel. */
function PluginPage({ form }: { form: DeploymentForm }) {
  const { state, error, reload } = usePanelData()
  // 加载/失败走统一 LoadState：这里原来手写 p.dt-hint，和其它页的错误播报不一致。
  // onRetry 不可省：插件管理里没有外层“重新加载”入口，失败后不给按钮就只能重进页面。
  return <div className="dt-embedded">
    {state ? <DeploymentPage setup={state.setup} form={form} accounts head />
      : <LoadState loading={error === undefined} error={error} onRetry={() => { void reload() }} />}
  </div>
}
/** DSH Plugin Manager config view entry; renders nothing in `summary` mode because DSH displays the package description. */
export function PluginConfig({ t, view, form }: { t: T; view: 'page' | 'summary'; form: DeploymentForm }) {
  return view === 'page' ? <PanelProvider t={t} interval={10_000}><PluginPage form={form} /></PanelProvider> : null
}
