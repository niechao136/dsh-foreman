/**
 * The whole log: every Trigger that arrived, every Decision, what became of each Ticket, and messages that never
 * reached their Channel. It is one chronological view for a person troubleshooting, and an agent reading the API sees
 * the same rows the panel shows.
 */
import { threadKey, type Decision, type Ticket, type Trigger } from '../../core/index.ts'
import type { ViewHost } from './records.ts'
import { preview } from './text.ts'

/** What a line is about; the panel labels these. */
export type LogKind = 'trigger' | 'decision' | 'ticket' | 'reply'
/** How much attention it deserves; a filtered Trigger and a failed delivery are not the same as an arrival. */
export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  /** When it happened. A delivery that keeps failing has no timestamp of its own, so it sorts last. */
  at: string
  kind: LogKind
  level: LogLevel
  /** The line a person scans. */
  text: string
  /**
   * Its source, the reason code of a Decision, how a Ticket ended, or the error of a failed delivery: a code the
   * panel localizes, never a sentence built here.
   */
  detail?: string
  thread?: string
  ticketId?: string
  decisionId?: string
  triggerId?: string
}

export interface LogQuery {
  kind?: LogKind[]
  level?: LogLevel[]
  /** Case-insensitive substring over the text and its detail. */
  q?: string
  /** Only rows at or after this instant. */
  since?: string
  offset: number
  limit: number
}

/** Rows read from each source before filtering. A log page is for troubleshooting, not for paging a year of history. */
const CAP = 200

/** Newest first; rows without a timestamp (a reply still failing) go last. */
const newest = (left: LogEntry, right: LogEntry): number => right.at.localeCompare(left.at)

function arrival(trigger: Trigger): LogEntry {
  return {
    at: trigger.at,
    kind: 'trigger',
    level: 'info',
    text: preview(trigger.text),
    detail: trigger.source,
    thread: trigger.threads[0] ? threadKey(trigger.threads[0]) : undefined,
    triggerId: trigger.id,
  }
}

function judged(decision: Decision): LogEntry {
  return {
    at: decision.at,
    kind: 'decision',
    level: decision.kind === 'unavailable' ? 'warn' : 'info',
    text: decision.kind,
    detail: decision.reason[0]?.code,
    thread: decision.threadKey,
    ticketId: decision.ticketId,
    decisionId: decision.id,
  }
}

function worked(ticket: Ticket): LogEntry[] {
  const entries: LogEntry[] = [{ at: ticket.createdAt, kind: 'ticket', level: 'info', text: ticket.title, ticketId: ticket.id }]
  // The end is its own line: a Ticket opened yesterday that finished an hour ago belongs at the top of the log.
  if (ticket.ended) {
    entries.push({
      at: ticket.ended.at,
      kind: 'ticket',
      level: ticket.ended.outcome === 'dropped' ? 'warn' : 'info',
      text: ticket.title,
      detail: ticket.ended.reason ?? ticket.ended.outcome,
      ticketId: ticket.id,
    })
  }
  return entries
}

function undelivered(host: ViewHost): LogEntry[] {
  const entries: LogEntry[] = []
  for (const dropped of host.store.read.droppedReplies(50)) {
    entries.push({
      at: dropped.dropped.at,
      kind: 'reply',
      level: 'warn',
      text: preview(dropped.text),
      detail: dropped.dropped.reason,
      ticketId: dropped.ticketId,
    })
  }
  // A reply that keeps failing has no instant of its own: the effect carries attempts, not a clock.
  for (const failing of host.store.read.failingReplies()) {
    entries.push({
      at: '',
      kind: 'reply',
      level: 'error',
      text: preview(failing.text),
      detail: failing.error,
      ticketId: failing.ticketId,
    })
  }
  return entries
}

/** Every row the filters keep, newest first, with the page `offset` asks for. */
export function logList(host: ViewHost, options: LogQuery): { items: LogEntry[]; next_offset: number | null; total: number } {
  const { store } = host
  const entries = [
    ...store.read.triggers({}, 0, CAP).items.map(arrival),
    ...store.read.decisions({ kinds: [], since: options.since ?? '' }, 0, CAP).items.map(judged),
    ...store.tickets.list().slice(0, CAP).flatMap(worked),
    ...undelivered(host),
  ]
  const query = options.q?.trim().toLowerCase() ?? ''
  const kept = entries
    .filter(entry => !options.since || entry.at >= options.since)
    .filter(entry => !options.kind?.length || options.kind.includes(entry.kind))
    .filter(entry => !options.level?.length || options.level.includes(entry.level))
    .filter(entry => !query || entry.text.toLowerCase().includes(query) || (entry.detail ?? '').toLowerCase().includes(query))
    .sort(newest)
  return {
    items: kept.slice(options.offset, options.offset + options.limit),
    next_offset: kept.length > options.offset + options.limit ? options.offset + options.limit : null,
    total: kept.length,
  }
}

/** What the panel derives from one page: how many rows of each kind and level the filters kept. */
export type LogListView = ReturnType<typeof logList>
