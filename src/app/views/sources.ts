/** Source status view: health, 24-hour trigger counts, and recently filtered or dropped messages per Source instance. */
import { threadKey } from '../../core/index.ts'
import type { Deployment } from '../../deployment.ts'
import type { Health } from '../../sources/host.ts'
import type { SourceInstance } from '../../sources/kind.ts'
import type { SourceRegistry } from '../../sources/registry.ts'
import type { SetupProblem } from '../../setup.ts'
import { dayAgo, snapshot, type ViewHost } from './records.ts'
import { preview } from './text.ts'

export type HealthMap = Record<string, Health>
/**
 * Resolves health entries for a Source instance, attaching the panel label each code was declared with and applying
 * its lifecycle `mode`:
 * - `pending` (the default for the core `sourceOff` code): an enabled Source shows 启动中 until the code clears.
 * - `steady`: the reported state stands, because the code describes an intentional stop (local-workspace mode).
 *
 * 扩展点：码表来自 kind 自己（`SourceKind.healthCodes`），所以新增来源不需要改这里。
 */
export function sourceHealth(sources: SourceRegistry, instance: SourceInstance, health: HealthMap) {
  const kind = sources.kind(instance.kind)
  const starting: Health = { state: 'starting', detail: '' }
  const codes = kind?.healthCodes ?? {}
  const parts = (kind?.health ?? []).map(name => {
    const entry = health[name]
    // No report yet: the Source has not run, which a pending start describes correctly.
    if (!entry) return { name, ...starting }
    const spec = entry.code === undefined ? undefined : codes[entry.code]
    const pending = spec ? spec.mode !== 'steady' : entry.code === 'sourceOff'
    const shown = instance.enabled && pending && entry.state === 'paused' ? starting : entry
    // 覆盖成「启动中」后原来的码（例如 sourceOff）不再成立，标签也就不该跟着走。
    return { name, ...shown, ...spec && shown === entry ? { label: spec.label } : {} }
  })
  return { id: instance.id, title: kind?.title ?? { zh: instance.id, en: instance.id }, health: parts }
}
export interface SetupState {
  /** Resolved deployment facts; undefined while waiting for initial setup. */
  deployment?: Deployment | undefined
  /** Setup failure that stops all Sources. */
  problem?: SetupProblem | undefined
  /** Problems that pause one Source only, keyed by that Source's setup place (its kind id). */
  sourceProblems?: Record<string, SetupProblem> | undefined
}
/** 概览用的来源摘要：只有标题与状态，不查 24 小时统计——明细属于来源页。 */
export function sourceSummary(sources: SourceRegistry, health: HealthMap, setup: SetupState) {
  return sources.instances().map(instance => {
    const { health: parts, title } = sourceHealth(sources, instance, health)
    return { id: instance.id, title, installed: instance.installed, enabled: instance.enabled,
      state: sourceState(instance, parts, setup) }
  })
}
export type SourceSummary = ReturnType<typeof sourceSummary>[number]
/** The problem that keeps a Source from running: its own place first, then a global failure pointing at it. */
export const problemOf = (id: string, setup: SetupState): SetupProblem | undefined =>
  setup.sourceProblems?.[id] ?? (setup.problem?.place === id ? setup.problem : undefined)
/** Source lifecycle state in priority order: missing kind, disabled, setup/part error, blocked on global setup, starting, paused, or ready. */
export type SourceState = 'missing' | 'off' | 'error' | 'setup' | 'starting' | 'paused' | 'ready'
function sourceState(instance: SourceInstance & { installed: boolean }, parts: { state: string }[], setup: SetupState): SourceState {
  if (!instance.installed) return 'missing'
  if (!instance.enabled) return 'off'
  if (problemOf(instance.id, setup) || parts.some(part => part.state === 'error')) return 'error'
  if (setup.problem) return 'setup'
  if (parts.some(part => part.state === 'starting')) return 'starting'
  return parts.some(part => part.state === 'paused') ? 'paused' : 'ready'
}
export function sourcesStatus(host: ViewHost, health: HealthMap, setup: SetupState) {
  const { store, sources } = host
  const view = snapshot(host)
  const since = dayAgo()
  const stats = store.read.triggerStats(since)
  const filtered = (source: string) => store.read.triggers({ source, filtered: true }, 0, 5).items.filter(trigger => trigger.at >= since)
    .map(trigger => ({ id: trigger.id, at: trigger.at, actor: view.actor(trigger.actor, trigger.human), preview: preview(trigger.text, 120),
      reason: store.triggers.disposition(trigger.id)?.filtered }))
  const dropped = droppedReplies(host)
  return sources.instances().map(instance => {
    const { health: parts, ...named } = sourceHealth(sources, instance, health)
    const problem = problemOf(instance.id, setup)
    return { ...named, installed: instance.installed, enabled: instance.enabled, state: sourceState(instance, parts, setup), health: parts,
      ...problem ? { problem } : {}, stats: stats[instance.id] ?? { received: 0, filtered: 0, lastAt: '' }, filtered: filtered(instance.id),
      dropped: dropped.filter(item => item.channel.source === instance.id) }
  })
}
export type SourceStatusView = ReturnType<typeof sourcesStatus>[number]
/** Replies dropped in the last 24 hours, enriched with their associated ticket and thread. */
export function droppedReplies({ store, links }: Pick<ViewHost, 'store' | 'links'>) {
  // Fetch the exact 24-hour dropped count so this list's length matches the overview's `dropped` metric.
  return store.read.droppedReplies(store.read.droppedSince(dayAgo())).map(item => {
    const ticket = item.ticketId ? store.tickets.get(item.ticketId) : undefined
    const { triggerId } = links(item.channel)
    const home = triggerId ? store.triggers.get(triggerId)?.threads[0] : undefined
    const thread = home ? threadKey(home) : store.threads.get(item.channel.thread) ? item.channel.thread : undefined
    return { id: item.id, kind: item.kind, channel: item.channel, preview: preview(item.text), dropped: item.dropped,
      ...ticket ? { ticket: { id: ticket.id, title: ticket.title } } : {}, ...thread ? { thread } : {} }
  })
}
