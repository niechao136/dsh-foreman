/** Localization, reason formatting, message marker cleanup, and relative timestamp helpers. */
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { DshSuperagentKey } from './locales.ts'
import type { Localized } from '../sources/kind.ts'
import type { SetupProblem } from '../setup.ts'
import type { Health } from '../sources/host.ts'
import { reasonText, type Reason } from '../core/reasons.ts'

export type T = Translate<DshSuperagentKey>
/** 截断长度集中在这里：同一处数字改一次就够，避免 140 之类的魔法数散落到各函数。 */
const LIMITS = { errorPreview: 140 }
export const errorText = (failure: unknown): string => failure instanceof Error ? failure.message : String(failure)
export const localized = (t: T, text: Localized | string | undefined): string =>
  typeof text === 'string' ? text : text ? text[t('lang') === 'en' ? 'en' : 'zh'] : ''
export const actorName = (t: T, actor: { name?: Localized } | undefined): string => actor?.name ? localized(t, actor.name)
  : t('automatedNotice')
export function valueLabel(t: T, group: string, key: string | undefined): string {
  if (!key) return ''
  const name = `${group}.${key}` as DshSuperagentKey
  const text = t(name)
  return text === name ? key : text
}
/** Format one or more structured or raw reasons in the active UI language, truncating multi-line host errors to their first line. */
export function reasonLabel(t: T, reason: string | Reason | readonly Reason[] | undefined): string {
  if (typeof reason === 'string') return reason ? label(t, { code: reason }) : ''
  // 分隔符按语言取：英文界面拼中文分号会显得是漏翻，集中用 reasonSeparator 保持一致。
  return [reason ?? []].flat().map(item => label(t, item)).filter(Boolean).join(t('reasonSeparator'))
}
function label(t: T, reason: Reason): string {
  const key = `reason.${reason.code}` as DshSuperagentKey
  const text = reason.code === 'said' ? reason.values?.text ?? '' : t(key, reason.values)
  if (reason.code !== 'said' && text !== key) return text
  const written = reason.code === 'said' ? text : reasonText({ ...reason, triggerId: undefined })
  if (/^\w*Error\b/.test(written)) {
    const first = written.split('\n')[0]!; const limit = LIMITS.errorPreview
    return first.length > limit ? `${first.slice(0, limit)}…` : first
  }
  return written
}
/** Fills `{name}` placeholders in a template the panel did not get from its own dictionary. */
const fill = (template: string, values: Record<string, unknown> = {}): string => template.replace(/\{(\w+)\}/g,
  (match, name: string) => values[name] === undefined || values[name] === null ? match : String(values[name]))
/**
 * Renders a setup problem: a Source kind ships its own `label` (中文/英文) and the panel just fills the placeholders,
 * so a Source added later needs no new dictionary entry; problems without a label fall back to `setup.<code>`.
 */
export const setupText = (t: T, problem: Pick<SetupProblem, 'code' | 'values'> & { label?: Localized }): string => {
  const key = `setup.${problem.code}` as DshSuperagentKey
  const own = t(key, problem.values)
  if (own !== key) return own
  return problem.label ? fill(localized(t, problem.label), problem.values) : problem.code
}
/** Renders a health entry: the panel's `healthCode.<code>` first, then the label its Source kind declared, then the raw detail. */
export const healthText = (t: T, health: Pick<Health, 'detail' | 'code' | 'values'> & { label?: Localized }): string => {
  if (!health.code) return health.detail
  const key = `healthCode.${health.code}` as DshSuperagentKey
  const own = t(key, health.values)
  if (own !== key) return own
  return health.label ? fill(localized(t, health.label), health.values) : health.detail
}
/** Replaces Feishu and GitHub content placeholders (images, cards, media, forwards, unresolved mentions) with localized labels. */
export function readableMarkers(t: T, text: string): string {
  return text.replace(/!\[[^\]]*\]\([^)]*\)|\[Image: [^\]]*\]|\[image\]/g, t('imageMarker'))
    .replace(/\[Chat card: [^\]]*\]/g, t('cardMarker'))
    .replace(/\[Media: [^\]]*\]/g, t('mediaMarker')).replace(/\[Merged forward\]/g, t('forwardMarker'))
    .replace(/@_user_\d+/g, t('unknownMention'))
}
const timeLocale = (lang: string) => lang === 'en' ? 'en' : 'zh-CN'
export function when(value: string | undefined, lang: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const seconds = Math.round((date.getTime() - Date.now()) / 1000)
  if (Math.abs(seconds) < 86_400) {
    const relative = new Intl.RelativeTimeFormat(timeLocale(lang), { numeric: 'auto' })
    if (Math.abs(seconds) < 60) return relative.format(0, 'second')
    if (Math.abs(seconds) < 3600) return relative.format(Math.round(seconds / 60), 'minute')
    return relative.format(Math.round(seconds / 3600), 'hour')
  }
  const sameYear = date.getFullYear() === new Date().getFullYear()
  const year = sameYear ? {} : { year: 'numeric' } as const
  return date.toLocaleString(timeLocale(lang), { ...year, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
export function fullTime(value: string | undefined, lang: string): string {
  const date = new Date(value ?? '')
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(timeLocale(lang))
}
