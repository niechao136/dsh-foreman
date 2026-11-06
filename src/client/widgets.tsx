/** Context-aware shared UI widgets: page/section headers, timestamps, Markdown rendering, and confirmation actions. */
import { Fragment, useState, type ReactNode } from 'react'
import type { SetupProblem } from '../setup.ts'
import { Button, Icon, InfoTip, Modal, StateDot, type DotState, type IconName } from './controls.tsx'
import { inlines, linkify, markdownBlocks, type Inline } from './markdown.ts'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { settingsRoute, type SettingsGroup } from './route.ts'
import { errorText, fullTime, readableMarkers, setupText, when } from './text.ts'

const external = { target: '_blank', rel: 'noopener noreferrer' } as const

export function When({ at }: { at: string | undefined }) {
  const { t } = usePanel()
  return <time dateTime={at} title={fullTime(at, t('lang'))}>{when(at, t('lang'))}</time>
}
export function SetupMessage({ problem, lead }: { problem: Pick<SetupProblem, 'code' | 'values'>; lead?: boolean }) {
  const { t } = usePanel()
  const text = setupText(t, problem)
  return <>
    {lead ? t('setupProblem', { detail: text }) : text}
    {problem.values.output && <span className="dt-detail-text dt-mono dt-clamp">{problem.values.output}</span>}
  </>
}
/**
 * 区块标题的共用骨架。BlockTitle 只暴露契约里的五个字段，而 Section 还要保留历史的 icon/badge 槽位，
 * 所以两者共用这一份实现，避免出现第二套标题排布。
 */
function Head({ title, level, count, hint, action, icon, badge }: {
  title: string; level: 2 | 3; count?: number | string; hint?: string; action?: ReactNode
  icon?: IconName; badge?: ReactNode
}) {
  // 语义层级跟着视觉层级走：h3 不能再包一层 h2 之前的判断，直接换标签最省事。
  const Heading = level === 3 ? 'h3' : 'h2'
  return <div className="dt-block-title" data-level={level}>
    <Heading className="dt-section-title">
      {icon && <span className="dt-section-icon"><Icon name={icon} size={14} /></span>}<span className="dt-section-name">{title}</span>
      {count !== undefined && <span className="dt-count">{count}</span>}{hint && <InfoTip text={hint} />}{badge}
    </Heading>
    {/* 右侧操作槽固定走 .dt-section-head：原来的 inline marginLeft:auto 在标题换行时会失效。 */}
    {action !== undefined && <span className="dt-section-head">{action}</span>}
  </div>
}

/** 列表/表单区块标题：默认 h2，level=3 用于卡片内的二级标题，右侧操作落在 .dt-section-head 槽。 */
export function BlockTitle({ title, level = 2, count, hint, action }: {
  title: string; level?: 2 | 3; count?: number; hint?: string; action?: ReactNode
}) {
  return <Head title={title} level={level} count={count} hint={hint} action={action} />
}

export function Section({ title, count, children, action, hint, badge, icon }: {
  title: string; count?: number | string; children: ReactNode; action?: ReactNode; hint?: string; badge?: ReactNode; icon?: IconName
}) {
  return <section className="dt-section">
    <Head title={title} level={2} count={count} hint={hint} action={action} icon={icon} badge={badge} />
    {children}
  </section>
}
/**
 * 轻量提示。stale 用于“刷新失败后留下的旧内容”这类场景：
 * 内容还在但可能过期，需要视觉上降级提示，而不是当成错误清空。
 */
export function Hint({ children, stale }: { children: ReactNode; stale?: boolean }) {
  return <p className={stale === true ? 'dt-hint dt-stale' : 'dt-hint'}>{children}</p>
}
export function LabelValue({ label, value }: { label: string; value: ReactNode }) {
  return <span className="dt-lv"><span className="dt-lv-label">{label}</span> <span className="dt-lv-value">{value}</span></span>
}
export function KeyValues({ rows }: { rows: [string, ReactNode][] }) {
  // display:contents 走 .dt-contents：内联样式在窄屏规则里覆盖不了，也不便于统一维护。
  return <dl className="dt-kv">{rows.map(([key, value], index) => <div key={index}
    className="dt-contents"><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
}

function Inlines({ parts }: { parts: Inline[] }) {
  return <>{parts.map((part, index) => part.kind === 'bold' ? <strong key={index}>{part.text}</strong>
    : part.kind === 'code' ? <code key={index} className="dt-code">{part.text}</code>
    : part.kind === 'link' ? <a key={index} className="dt-inline-link" href={part.url} title={part.url} {...external}>{part.text}</a>
    : <Fragment key={index}>{part.text}</Fragment>)}</>
}
/** Renders a safe Markdown subset (headings, lists, paragraphs, bold, inline code, links) without interpreting raw HTML. */
export function MarkdownLite({ text }: { text: string }) {
  const { t } = usePanel()
  return <div className="dt-md">{markdownBlocks(readableMarkers(t, text)).map((block, index) => {
    if (block.kind !== 'list') return <p key={index} className={block.kind === 'heading' ? 'dt-md-heading' : undefined}><Inlines
      parts={inlines(block.text)} /></p>
    const items = block.items.map((item, at) => <li key={at}><Inlines parts={inlines(item)} /></li>)
    return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>
  })}</div>
}
function MoreToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = usePanel()
  return <button type="button" className="dt-textlink dt-more" aria-expanded={open} onClick={onToggle}>{open ? t('collapse')
    : t('expand')}</button>
}
export function ClampText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 480 || text.split('\n').length > 8
  return <>
    <div className={long && !open ? 'dt-event-text dt-clamp-8' : 'dt-event-text'}><Inlines parts={linkify(text)} /></div>
    {long && <MoreToggle open={open} onToggle={() => setOpen(!open)} />}
  </>
}

export function ConfirmButton({ label, title, message, onConfirm, variant = 'ghost', icon }: {
  label: string; title: string; message: string; onConfirm: () => Promise<unknown>; variant?: 'ghost' | 'outline'; icon?: IconName
}) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const confirm = useAction(onConfirm)
  return <>
    <Button variant={variant} size="sm" icon={icon && <Icon name={icon} size={14} />} onClick={() => setOpen(true)}>{label}</Button>
    <Modal open={open} onClose={() => setOpen(false)} title={title} closeLabel={t('close')} description={message}
      footer={<>
        <Button variant="ghost" onClick={() => setOpen(false)}>{t('cancel')}</Button>
        <Button variant="primary" disabled={confirm.busy}
          onClick={() => { void confirm.run().then(done => { if (done) setOpen(false) }) }}>{t('confirm')}</Button>
      </>} />
  </>
}
export function SessionButton({ sessionId, label,
  variant = 'ghost' }: { sessionId: string; label?: string; variant?: 'ghost' | 'outline' }) {
  const { t, openSession, notify } = usePanel()
  return <Button variant={variant} size="sm" icon={<Icon name="session" size={14} />}
    onClick={() => { openSession(sessionId).catch(error => notify(errorText(error))) }}>{label ?? t('openSession')}</Button>
}
export function ExternalLink({ href, children, icon = 'external' }: { href: string; children: ReactNode; icon?: IconName }) {
  return <a className="dt-inline-link dt-icon-link" href={href} {...external}><Icon name={icon} size={13} />{children}</a>
}
export function ActionLink({ href, children, icon = 'external' }: { href: string; children: ReactNode; icon?: IconName }) {
  return <a className="dt-btn dt-btn-outline dt-btn-sm" href={href} {...external}><span className="dt-btn-icon"><Icon name={icon}
    size={14} /></span>{children}</a>
}
export function StageMark({ state, icon, label }: { state: DotState; icon: IconName; label: string }) {
  return <span className="dt-stage" data-state={state}>{state === 'ongoing' ? <StateDot state="ongoing" /> : <Icon name={icon}
    size={14} />}{label}</span>
}
/** 空状态：图标 + 标题 + 提示 + 一个主操作；所有列表共用同一套层级，不再各页拼 <p>。 */
export function Empty({ icon, title, hint, action }: { icon?: IconName; title: string; hint?: string; action?: ReactNode }) {
  return <div className="dt-empty">
    {icon && <span className="dt-empty-icon"><Icon name={icon} size={20} /></span>}
    <p className="dt-empty-title">{title}</p>
    {hint && <p className="dt-empty-hint">{hint}</p>}
    {action !== undefined && <div className="dt-empty-action">{action}</div>}
  </div>
}

/**
 * 内联错误行：role="alert" 让读屏立即播报；clamp 让长错误不撑破布局；
 * onRetry 把“重试”放在错误旁边，省掉页面自己再摆一个按钮。
 */
export function ErrorLine({ error, onRetry, clamp, title }: {
  error: string; onRetry?: () => void; clamp?: boolean; title?: string
}) {
  const { t } = usePanel()
  return <div className="dt-error-line" role="alert" title={title ?? error}>
    <Icon name="alert" size={14} />
    {title !== undefined && <strong>{title}</strong>}
    <span className={clamp ? 'dt-clamp' : undefined}>{error}</span>
    {onRetry !== undefined && <Button variant="outline" size="sm" onClick={onRetry}>{t('retry')}</Button>}
  </div>
}

/** 状态行（保存中/已保存/未保存/只读）：单独成块，横向对齐交给 .dt-status-line 的 flex，不再用负 margin 贴边。 */
export function StatusLine({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return <div className="dt-status-line"><span>{children}</span>{actions !== undefined && <span>{actions}</span>}</div>
}

/**
 * 列表区域的四态容器：错误 → 加载 → 空 → 内容，四态互斥。
 * 页面只传状态，不再各自写 if 链，避免同一处同时冒出“加载中”和“没有数据”。
 */
export function ListSection({ loading, error, onRetry, empty, emptyTitle, emptyHint, emptyAction, more, onMore, children }: {
  loading?: boolean; error?: string; onRetry?: () => void; empty?: boolean; emptyTitle?: string; emptyHint?: string
  emptyAction?: ReactNode; more?: boolean; onMore?: () => void; children: ReactNode
}) {
  const { t } = usePanel()
  // 错误优先于加载：重新请求失败时继续显示骨架，用户就看不到失败原因。
  if (error !== undefined) return <div className="dt-list-state"><ErrorLine error={error} title={t('loadFailed')} onRetry={onRetry} /></div>
  if (loading === true) {
    // 骨架用三条灰条占位：比一行“正在读取…”更少跳动，也不会让内容区高度塌陷。
    // 灰条本身 aria-hidden，真正播报给读屏的是 .dt-sr-only 里那句“正在读取…”。
    return <div className="dt-list-state"><div className="dt-skeleton" role="status">
      <span className="dt-sr-only">{t('loading')}</span><span /><span /><span /></div></div>
  }
  if (empty === true) {
    return <div className="dt-list-state"><Empty title={emptyTitle ?? t('emptyList')} hint={emptyHint ?? t('emptyListHint')}
      action={emptyAction} /></div>
  }
  return <>{children}{more === true && onMore !== undefined && <div className="dt-list-state"><LoadMore onMore={onMore} /></div>}</>
}

/** 单行截断文本：title 兜底给出全文，样式交给 .dt-clamp，调用方仍可追加自己的类名。 */
export function Truncated({ text, className }: { text: string; className?: string }) {
  return <span className={className ? `dt-clamp ${className}` : 'dt-clamp'} title={text}>{text}</span>
}

export function LoadState({ error, loading, onRetry, missing }: {
  error?: Error | undefined; loading: boolean; onRetry?: () => void; missing?: boolean
}) {
  const { t } = usePanel()
  // 统一走 errorText：抛出的既可能是 Error 也可能是任意值，归一后 ErrorLine 才好渲染。
  if (error) return <ErrorLine error={errorText(error)} title={t('loadFailed')} onRetry={onRetry} />
  // missing 是“请求成功但对象不存在”的终态，不是网络故障：给空状态而不是可重试的错误。
  if (missing === true) return <Empty icon="question" title={t('notFound')} />
  return loading ? <Hint>{t('loading')}</Hint> : null
}
/**
 * 「再取一批」按钮。默认文案是通用的「加载更多」；时间线这类倒序列表要的是「加载更早的触发」，
 * 由调用方传 label 覆盖，避免为了一个文案在每个页面复制一遍 Button + Icon。
 */
export function LoadMore({ onMore, label }: { onMore: () => void; label?: string }) {
  const { t } = usePanel()
  return <Button variant="outline" size="sm" icon={<Icon name="chevron-down" size={14} />} onClick={onMore}>{label ?? t('loadMore')}</Button>
}

/**
 * 标题行：列表页有真实标题时用它当主标题，通用的 statusTitle 降为副标题，
 * 否则每个列表页的标题都叫“状态”，用户无法从标题区分页面。
 */
export function StatusHead({ hint, settings, title }: { hint: string; settings?: SettingsGroup; title?: string }) {
  const { t, navigate } = usePanel()
  return <div className="dt-status-head">
    <div className="dt-status-titles">
      <h2 className="dt-status-title">{title ?? t('statusTitle')}</h2>
      {title !== undefined && <span className="dt-status-subtitle">{t('statusTitle')}</span>}
      <InfoTip text={hint} />
    </div>
    {settings && <Button variant="ghost" size="sm" icon={<Icon name="settings" />}
      onClick={() => navigate(settingsRoute(settings))}>{t('tab.settings')}</Button>}
  </div>
}
/**
 * 页面头（v2）：返回链 + 标题区（eyebrow / 标题 / 说明 / 右侧操作）。
 * 一级页面不传 back（导航交给顶部 TabBar），详情页传 back 显示返回。
 */
export function PageHead({ title, hint, children, eyebrow, back = true }: {
  title: ReactNode; hint?: ReactNode; children?: ReactNode; eyebrow?: ReactNode; back?: boolean
}) {
  const { back: goBack, backLabel } = usePanel()
  return <div className="dt-page-head">
    {back && <div className="dt-page-back"><Button variant="ghost" size="sm" icon={<Icon name="chevron-left" />}
      onClick={goBack}>{backLabel}</Button></div>}
    <div className="dt-page-title">
      <div className="dt-page-titles">
        {eyebrow !== undefined && <span className="dt-page-eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
        {hint !== undefined && <p className="dt-hint">{hint}</p>}
      </div>
      {children !== undefined && <span className="dt-actions">{children}</span>}
    </div>
  </div>
}

/**
 * 卡片：页面里的最小内容单元。标题固定走 h3 + .dt-card-title（测试与样式都依赖这个钩子），
 * tone 只表达语义（warn/error/success），具体颜色由 CSS 的 data-tone 三件套决定。
 */
export function Card({ title, hint, actions, tone, className, children }: {
  title?: ReactNode; hint?: string; actions?: ReactNode; tone?: 'warn' | 'error' | 'success'
  className?: string; children?: ReactNode
}) {
  const head = title !== undefined || actions !== undefined
  return <section className={className === undefined ? 'dt-card' : `dt-card ${className}`} data-tone={tone}>
    {head && <div className="dt-card-head">
      {title !== undefined && <h3 className="dt-card-heading"><span className="dt-card-title">{title}</span>
        {hint !== undefined && <InfoTip text={hint} />}</h3>}
      {actions !== undefined && <span className="dt-card-actions">{actions}</span>}
    </div>}
    {children}
  </section>
}

/** 指标卡：仪表盘顶部的数字块，数字用 tabular-nums 保证多卡对齐。 */
export function StatCard({ label, value, hint, tone, icon }: {
  label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: 'warn' | 'error' | 'success' | 'info'; icon?: IconName
}) {
  // 类名用 dt-stat-card 而不是 dt-stat：.dt-stat 是分节里的内联统计条（测试按它断言），两者层级不同。
  return <div className="dt-stat-card" data-tone={tone}>
    <span className="dt-stat-card-label">{icon !== undefined && <Icon name={icon} size={13} />}{label}</span>
    <span className="dt-stat-card-value">{value}</span>
    {hint !== undefined && <span className="dt-stat-card-hint">{hint}</span>}
  </div>
}

/** 详情页右栏的键值列表：标签在上、值在下，长值自动折行（.dt-kv 是两列栅格，长文本会挤）。 */
export function MetaList({ items }: { items: readonly { label: ReactNode; value: ReactNode }[] }) {
  return <dl className="dt-meta-list">{items.map((item, index) => <div className="dt-meta-item" key={index}>
    <dt>{item.label}</dt><dd>{item.value}</dd>
  </div>)}</dl>
}

/** 列表页筛选条：左侧筛选控件，右侧操作，窄屏自动折行。 */
export function Toolbar({ children, actions }: { children?: ReactNode; actions?: ReactNode }) {
  if (children === undefined && actions === undefined) return null
  return <div className="dt-toolbar-row">
    {children !== undefined && <div className="dt-toolbar-filters">{children}</div>}
    {actions !== undefined && <div className="dt-toolbar-actions">{actions}</div>}
  </div>
}

/** 详情页两列布局：主列吃剩余宽度，右栏固定 300px 并在滚动时吸顶；<900px 折成单列。 */
export function DetailLayout({ main, aside }: { main: ReactNode; aside?: ReactNode }) {
  return <div className={aside === undefined ? 'dt-detail dt-detail-solo' : 'dt-detail'}>
    <div className="dt-detail-main">{main}</div>
    {aside !== undefined && <aside className="dt-detail-aside">{aside}</aside>}
  </div>
}
/** Trigger a host setup re-check and restart, prompting for confirmation when running Assignments would be interrupted. */
/** 部署检查卡在「状态目录里有别人的文件」时的自救按钮：改名留档，再重新检查。 */
export function RepairSetupButton({ file }: { file: string }) {
  const { t, call, notify, restart } = usePanel()
  const action = useAction(async () => { await call('POST setup/adopt', { body: { file } }); notify(t('setupRepairing')); restart() })
  const icon = <Icon name="trash" size={14} />
  return <Button variant="outline" size="sm" icon={icon} disabled={action.busy}
    onClick={() => { void action.run() }}>{t('setupRepair')}</Button>
}

export function CheckSetupButton() {
  const { t, call, notify, restart } = usePanel()
  const { running } = usePanelData()
  const check = async () => { await call('POST setup/check'); notify(t('setupChecking')); restart() }
  const action = useAction(check)
  if (running > 0) {
    const message = t('setupCheckInterrupts', { count: running })
    return <ConfirmButton variant="outline" icon="refresh" label={t('setupCheck')} title={t('setupCheck')} message={message}
      onConfirm={check} />
  }
  const icon = <Icon name="refresh" size={14} />
  return <Button variant="outline" size="sm" icon={icon} disabled={action.busy}
    onClick={() => { void action.run() }}>{t('setupCheck')}</Button>
}

/** 闭环里的一步：state 决定线的颜色，onSelect 让这一步可以点进它对应的页面。 */
export interface LoopStep {
  label: string
  value?: ReactNode
  hint?: string
  state?: 'done' | 'current' | 'pending'
  icon?: IconName
  onSelect?: () => void
}

/**
 * 闭环轨：把一条流程的若干步横向排开，用每步顶部的线区分「已完成 / 当前 / 未开始」，
 * 让「收到消息 → 过滤 → 触发 → 决策 → 工单 → 执行 → 评估 → 回流」一眼可见且每步可点。
 * 只负责展示，不推导数据；每页按自己的视图模型传入 steps。
 */
export function LoopTrack({ steps, label }: { steps: readonly LoopStep[]; label?: string }) {
  return <div className="dt-loop">
    {label !== undefined && <span className="dt-loop-caption">{label}</span>}
    <ol className="dt-loop-track">
      {steps.map((step, index) => {
        // 主体内容两种渲染共用：可点时才包一层按钮，保证键盘与读屏都能走。
        const body = <>
          <span className="dt-loop-mark" aria-hidden="true">{step.icon === undefined ? <span className="dt-loop-index">{index + 1}</span>
            : <Icon name={step.icon} size={13} />}</span>
          <span className="dt-loop-text">
            <span className="dt-loop-label">{step.label}</span>
            {step.value !== undefined && <span className="dt-loop-value">{step.value}</span>}
            {step.hint !== undefined && <span className="dt-loop-hint">{step.hint}</span>}
          </span>
        </>
        return <li key={step.label} className="dt-loop-step" data-state={step.state ?? 'pending'}
          aria-current={step.state === 'current' ? 'step' : undefined}>
          {step.onSelect === undefined ? <div className="dt-loop-body">{body}</div>
            : <button type="button" className="dt-loop-body dt-loop-link" onClick={step.onSelect}>{body}</button>}
        </li>
      })}
    </ol>
  </div>
}
