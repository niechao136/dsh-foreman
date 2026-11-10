/** Settings tab shell: a sticky group nav (card) beside the form area of the chosen group. */
import type { ReactNode } from 'react'
import type { StateView } from './api.ts'
import { Dot } from './controls.tsx'
import { DeploymentPage, type DeploymentForm } from './deployment.tsx'
import { DevicesSettings } from './devices.tsx'
import { EvalSettings } from './eval.tsx'
import { LogsSettings } from './logs.tsx'
import { ExecutionSettings } from './execution.tsx'
import { PromptsPage } from './prompts.tsx'
import { RoutingSettings } from './routing.tsx'
import { usePanel } from './provider.tsx'
import { SETTINGS_GROUPS, settingsRoute, type SettingsGroup } from './route.ts'
import { SettingsProvider, useSettingsQuery } from './settings-kit.tsx'
import { SourceSettings } from './source.tsx'
import { errorText, localized } from './text.ts'
import { ErrorLine, LoadState, PageHead } from './widgets.tsx'

/**
 * 分组内的选项（目前只有来源是多张卡：一个来源一张）。
 *
 * 读的是设置上下文而不是单独再拉一次 `GET sources`：设置页整屏只发一次设置请求，
 * 左栏靠查询态自己画骨架，所以数据没到时右栏在等、左栏已经成型。
 */
function SourceNav({ current }: { current?: string }) {
  const { t, navigate } = usePanel()
  const { settings, error, reload } = useSettingsQuery()
  const sources = settings?.sources ?? []
  // 没有指定时默认选中第一个来源，右栏永远有内容，不必先空着手点一次。
  const selected = current ?? sources[0]?.id
  if (!settings) {
    if (error) return <ErrorLine error={errorText(error)} title={t('loadFailed')} clamp onRetry={() => { void reload() }} />
    // 骨架而不是空白：左栏宽度固定，先占位可以避免右栏整体跳动。
    return <div className="dt-skeleton" aria-hidden="true" />
  }
  // 一个来源都没装时不画空态：设置页是表单页，空态提示交给右侧表单区（SourceSettings），
  // 140px 的左栏里塞一整块空态会把分组导航挤变形。
  if (!sources.length) return null
  return <div className="dt-settings-subnav">
    {sources.map(source => <button key={source.id} type="button" className="dt-settings-sublink"
      aria-current={source.id === selected ? 'true' : undefined}
      onClick={() => navigate(settingsRoute('source', { source: source.id }), true)}>
      {/* 选项上的点：有问题就红，关掉就灰，其余按「已启用」算正常。 */}
      <Dot state={source.problem ? 'error' : source.installed ? 'done' : 'idle'} />
      {/* title 让窄左栏里被 ellipsis 截断的来源名还能看到全名。 */}
      <span className="dt-line" title={localized(t, source.title)}>{localized(t, source.title)}</span>
    </button>)}
  </div>
}

/**
 * 右栏的数据守门：设置没到就只把右栏换成骨架/错误，左栏留在原处。
 * 各设置页都假定 `useSettings().settings` 已就绪（eval/execution 直接解构它），
 * 所以守门必须包在所有页面之外，而不能改成给一个占位空对象。
 */
function SettingsBody({ children }: { children: ReactNode }) {
  const { t } = usePanel()
  const { settings, error, reload } = useSettingsQuery()
  if (!settings) return <LoadState error={error} loading={!error} onRetry={() => { void reload() }} />
  return <>
    {/* 已有数据时再失败只提示不替换：把用户正在编辑的整页抽换成错误页更糟。 */}
    {error && <ErrorLine error={errorText(error)} title={t('loadFailed')} onRetry={() => { void reload() }} />}
    {children}
  </>
}

export function SettingsPage({ group, query, state, deploymentForm }: {
  group: SettingsGroup; query: { source?: string; version?: string }; state: StateView; deploymentForm: DeploymentForm
}) {
  const { t, navigate } = usePanel()
  const content = (() => {
    switch (group) {
      case 'source': return <SourceSettings {...query.source ? { focus: query.source } : {}} />
      case 'eval': return <EvalSettings version={query.version} />
      case 'execution': return <ExecutionSettings />
      case 'routing': return <RoutingSettings version={query.version} />
      case 'devices': return <DevicesSettings />
      case 'prompts': return <PromptsPage />
      case 'deployment': return <DeploymentPage setup={state.setup} form={deploymentForm} />
      case 'logs': return <LogsSettings />
    }
  })()
  // Provider 包整屏：左右两栏读同一份查询，左栏不必再发一次请求，也不会被右栏的加载态抽走。
  return <SettingsProvider>
    {/* 设置页是一级页面（导航在顶部 TabBar），所以不显示返回按钮；eyebrow 说明它属于「设置」这一族。 */}
    <PageHead back={false} eyebrow={t('tab.settings')} title={t(`settingsGroup.${group}`)} />
    <div className="dt-settings">
      {/* 左栏：sticky 分组导航。v2 里它不再包一层 Card：.dt-card 只属于右侧内容卡（页面按 .dt-card 逐个取卡片），
          导航自己由 .dt-settings-nav 提供 sticky 与竖排布局。 */}
      <nav className="dt-settings-nav" aria-label={t('tab.settings')}>
        {SETTINGS_GROUPS.map(value => <div key={value} className="dt-settings-group">
          <button type="button" className="dt-settings-link"
            aria-current={value === group ? 'page' : undefined} onClick={() => navigate(settingsRoute(value), true)}>
            {t(`settingsGroup.${value}`)}
          </button>
          {/* 来源分组的二级选项只在当前分组展开，别的分组保持一行一个。 */}
          {value === group && value === 'source' && <SourceNav current={query.source} />}
        </div>)}
      </nav>
      <div className="dt-settings-body">
        <SettingsBody>{content}</SettingsBody>
      </div>
    </div>
  </SettingsProvider>
}
