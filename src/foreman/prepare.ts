/**
 * The seam between an accepted ticket and the device that will run it.
 *
 * The choice has to happen here, in `prepareTicket`, and not in the Executor: the Executor has no write channel
 * (its port only queues work), so a target chosen there would never reach the database. `Tickets.create` runs
 * `prepareTicket` before `newAssignment` and before saving, so what this function writes is what gets stored.
 */
import type { AssessmentOutcome, Ticket, Trigger } from '../core/index.ts'
import type { DeviceRecord } from './devices.ts'
import { selectDevice, type DeviceRequest, type Online } from './selector.ts'

/** The project a workspace path names: its last segment, on either path shape. Empty when there is no workspace. */
export function projectOf(workspace: string | undefined): string {
  if (workspace === undefined || workspace === '') return ''
  const trimmed = workspace.replace(/[\\/]+$/, '')
  const segment = trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1)
  return segment
}

export interface PrepareInput {
  /** Every registered device; read fresh on each accept, so adding one needs no restart. */
  devices: () => DeviceRecord[]
  /** The devices connected right now, with their load. */
  online: () => Online[]
  /**
   * The Trigger a ticket came from, when it has one. Its `meta.workspace` names the project, and a Feishu chat's
   * mapping may add required labels (Task 13).
   */
  triggerOf: (ticket: Ticket) => Trigger | undefined
  /** Labels a chat mapping imposes on the devices allowed to take this work. */
  labelsOf?: (trigger: Trigger | undefined) => string[] | undefined
  /**
   * The workspace a trigger's work belongs to, when the trigger does not carry one itself.
   *
   * The local Source records `meta.workspace`; a Feishu Trigger carries only its chat, whose project comes from the
   * routing table. Both end up as the project name the device roots are matched against.
   */
  workspaceOf?: (trigger: Trigger | undefined) => string | undefined
  /** The selection rule, injected so Task 13 can constrain it without this file knowing about chats. */
  select?: typeof selectDevice
  /** The local prepare, which fills in `execution`; a remote target does not change it (the device has its own directory). */
  local: (ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>) => Ticket
}

/**
 * Builds the `prepareTicket` hook: choose a device for the ticket, write the choice onto it, and let the local
 * prepare finish the job.
 *
 * When no device can take the work, the ticket keeps no target and is prepared exactly as it was before devices
 * existed — it runs on the host. That is deliberate: a request for a project this hub's own machine can reach should
 * not stall because some laptop is offline.
 */
export function prepareTicketWithForeman(input: PrepareInput) {
  const select = input.select ?? selectDevice
  return (ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket => {
    const trigger = input.triggerOf(ticket)
    // The trigger's own `meta.workspace` wins; a routing table supplies one for Sources that carry only a chat.
    const recorded = typeof trigger?.meta['workspace'] === 'string' ? trigger.meta['workspace'] as string : undefined
    const workspace = recorded ?? input.workspaceOf?.(trigger)
    const project = projectOf(workspace)
    if (project !== '') {
      const request: DeviceRequest = { project }
      if (outcome.device !== undefined && outcome.device !== '') request.device = outcome.device
      const labels = input.labelsOf?.(trigger)
      if (labels !== undefined && labels.length > 0) request.labels = labels
      const target = select(request, input.devices(), input.online())
      // `target` is written before `local` runs so the local prepare sees the final ticket; `local` returns a new
      // object (it spreads the ticket), so the target has to be set on what it returns when it drops it.
      const prepared = input.local({ ...ticket, ...(target === undefined ? {} : { target }) }, outcome)
      return prepared.target === undefined && target !== undefined ? { ...prepared, target } : prepared
    }
    const prepared = input.local(ticket, outcome)
    // An explicit device on an accept that names no project cannot be resolved to a path, so it is not a target.
    return prepared
  }
}
