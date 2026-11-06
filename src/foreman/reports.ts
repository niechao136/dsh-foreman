/**
 * What the hub does with what a device says: its reports, its disappearance, and its return.
 *
 * One rule governs all three — **no reassignment without the device's own word**. A report is passed through; a late
 * one is dropped with a log line, never an exception, because a device finishing work the ledger already closed is
 * normal. A disconnect only marks a time: `assignmentInterrupted` would restart the ticket while the device may still
 * be running it, which is the double execution the design exists to prevent. Only a timeout reports `blocked`, and
 * even then nothing is restarted — a person decides.
 */
import type { NodeReportState, ReportFrame } from './protocol.ts'

/** What the ledger says about an assignment a frame names. */
export interface AssignmentWhere { ticketId: string; open: boolean }

/** The states a device may report. `dropped` is excluded: that is a judgement, and a device has none. */
const ALLOWED: ReadonlySet<string> = new Set<NodeReportState>(['progress', 'ready', 'blocked', 'failed'])

export interface ApplyReportInput {
  /** Reports an outcome on a ticket; the Engine's `report` also returns the updated ticket, which is ignored here. */
  report: (ticketId: string, report: { state: NodeReportState; summary: string; question?: string }) => unknown
  /** The ticket and whether it is still open, for an assignment id; undefined when the ledger never had it. */
  ticketOf: (assignmentId: string) => AssignmentWhere | undefined
  log: (text: string) => void
}

/**
 * Maps a device's `report` frame onto the Engine.
 *
 * A report that cannot be applied — for an unknown assignment, for a ticket that already ended, or claiming `dropped`
 * — is logged and dropped. Throwing would take down the connection over a message the ledger simply does not need.
 */
export function applyReport(input: ApplyReportInput): (assignmentId: string, frame: ReportFrame) => void {
  return (assignmentId, frame) => {
    if (!ALLOWED.has(frame.state)) {
      input.log(`a device reported ${String(frame.state)} for ${assignmentId}; only progress, ready, blocked or failed are accepted`)
      return
    }
    const where = input.ticketOf(assignmentId)
    if (where === undefined) {
      input.log(`a device reported on assignment ${assignmentId}, which this ledger does not have`)
      return
    }
    if (!where.open) {
      input.log(`a late report for assignment ${assignmentId} arrived after its ticket ${where.ticketId} ended; dropped`)
      return
    }
    input.report(where.ticketId, { state: frame.state, summary: frame.summary,
      ...(frame.question === undefined ? {} : { question: frame.question }) })
  }
}

/**
 * Record that a device went away. Deliberately does nothing else: the assignment stays `running`, because the device
 * may be mid-work behind a flaky link, and restarting it would run the same thing twice.
 */
export function onDisconnect(input: { mark: (deviceId: string) => void; deviceId?: string }): void {
  input.mark(input.deviceId ?? '')
}

export interface OnTimeoutInput {
  /** When the device last proved it was alive, in epoch milliseconds. */
  since: number
  now: number
  limitMs: number
  report: (ticketId: string, report: { state: NodeReportState; summary: string; question?: string }) => unknown
  ticketOf: (assignmentId: string) => AssignmentWhere | undefined
  deviceId: string
  running: readonly string[]
}

/**
 * Hand a silent device's work to a person once it has been gone long enough.
 *
 * Nothing before the limit. After it, every assignment the device was running on an open ticket is reported
 * `blocked` with a reason naming the device, so the router session can ask. `assignmentInterrupted` is never called
 * here: the device may come back and report, and a restart in the meantime would duplicate the work.
 */
export function onTimeout(input: OnTimeoutInput): void {
  if (input.now - input.since <= input.limitMs) return
  for (const assignmentId of input.running) {
    const where = input.ticketOf(assignmentId)
    if (where === undefined || !where.open) continue
    input.report(where.ticketId, { state: 'blocked', summary: `device offline: ${input.deviceId} has not been heard from for ${Math.round((input.now - input.since) / 60_000)} minutes` })
  }
}

export interface AlignHelloInput {
  /** The assignments the device says it is running right now. */
  running: readonly string[]
  /** The assignments the ledger believes this device is running. */
  known: readonly string[]
  /** Stops an assignment the ledger has given up on but the device may still be working. */
  stop: (assignmentId: string) => void
}

/**
 * Reconciles a reconnecting device's word with the ledger.
 *
 * `attach` is what both sides agree is running: nothing to do but keep waiting. `stop` is what the ledger believes is
 * running and the device does not — the device has the truth about its own processes, so those are handed to the
 * caller to stop rather than silently restarted. What the device claims and the ledger does not know is neither:
 * it is a report the device will send or a stale belief, and stopping work the ledger never recorded would be a
 * decision made on a claim alone.
 */
export function alignHello(input: AlignHelloInput): { attach: string[]; stop: string[] } {
  const running = new Set(input.running)
  const known = new Set(input.known)
  return { attach: input.running.filter(id => known.has(id)), stop: input.known.filter(id => !running.has(id)) }
}
