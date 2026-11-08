/**
 * The Executor for a hub that runs some work locally and hands the rest to devices.
 *
 * It implements the same `Executor` port as `DshExecutor`, and it never chooses: `targetOf(assignment)` already says
 * where the work goes, written when the ticket was accepted. A local target is passed straight through — the local
 * executor behaves exactly as it did before devices existed. A remote one becomes frames on the hub's transport.
 *
 * Failure is reported, never papered over. A device that cannot be reached turns the ticket `blocked` so a person
 * decides; it is never reported `failed` (that means the work itself failed) and never quietly run on the host
 * instead (that would put the work somewhere the request never asked for).
 */
import type { Assignment, EngineForExecutor, Executor, Ticket, Trigger } from '../core/index.ts'
import { targetOf } from '../core/model.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import { FrameDedupe, type AssignFrame, type Frame, type InputFrame, type StopFrame } from './protocol.ts'
import { renderForDevice, type Rendered } from './render.ts'
import type { Online } from './selector.ts'

/** How a frame reaches a device. The hub is the only implementation; tests supply an in-memory one. */
export interface ForemanTransport {
  send(deviceId: string, frame: Frame): Promise<void>
}

/**
 * What the hub offers the rest of the runtime: the transport, plus which devices are connected and how busy they are.
 * `Hub` implements it; the runtime only needs this much, so tests can stand a fake in for the whole connection layer.
 */
export interface ForemanLink extends ForemanTransport {
  online(): Online[]
}

/**
 * The id of the `input` frame carrying `inputIds` to an assignment.
 *
 * Encoded so the device's `ack` of this frame tells the hub exactly which Inputs reached the device: the ledger needs
 * that to clear `ticket.undelivered`, and without it a remote ticket can never finish while it follows Threads.
 */
export const inputFrameId = (ticketId: string, assignmentId: string, inputIds: readonly string[]): string =>
  `input:${ticketId}:${assignmentId}:${inputIds.join(',')}`

/** The Input ids an `input` frame id carried, or undefined when the id is not one of ours. */
export function inputsOf(frameId: string): { ticketId: string; assignmentId: string; inputIds: string[] } | undefined {
  const match = /^input:([^:]+):([^:]+):(.*)$/.exec(frameId)
  if (match === null) return undefined
  const [, ticketId, assignmentId, joined] = match
  if (ticketId === undefined || assignmentId === undefined) return undefined
  return { ticketId, assignmentId, inputIds: joined === '' || joined === undefined ? [] : joined.split(',') }
}

/** What the executor needs from the Engine: the two callbacks an executor may call. */
export type ExecutorReporter = Pick<EngineForExecutor, 'report'>

export interface ForemanExecutorInput {
  /** The machine this hub runs on; a `local` target goes here unchanged. */
  local: DshExecutor
  transport: ForemanTransport
  /** Read lazily: the Engine is built after the executor. */
  engine: () => ExecutorReporter
  /** Reads an attachment's bytes from the hub's store, for the ones a rendered task carries. */
  readAttachment?: (id: string) => Buffer
  /** The Trigger a ticket came from, whose request text and attachments the device must receive. */
  triggerOf?: (ticket: Ticket) => { trigger?: Trigger }
  /**
   * The registered name of the device a job runs on, so the assignment text can say where it is running.
   *
   * The request is written by a person at the hub ("check the dorm computer"); the device receiving it IS that
   * computer, but nothing said so, and working that out cost a dozen exploratory steps on every dispatch.
   */
  deviceOf?: (deviceId: string) => { id: string; name: string } | undefined
  /** Logs what the hub decided; a delivery that fails silently is invisible otherwise. */
  log?: (text: string) => void
}

/**
 * Dispatches assignments by their target.
 *
 * The port's methods must return synchronously (the Engine calls them inside a transaction), so every remote frame
 * goes through a promise chain: the send happens after the transaction commits and never blocks the caller.
 */
export class ForemanExecutor implements Executor {
  /** Frame ids this executor has handed to the transport, so a repeated `start` does not assign the same work twice. */
  private readonly sent = new FrameDedupe(new Set())
  /**
   * Input frames waiting on the transport. Unlike `sent`, an entry here is released when its send fails, so the
   * ticket's next delivery retries it instead of being swallowed as a duplicate.
   */
  private readonly delivering = new Set<string>()
  /** Serialises sends so frames for one device reach it in the order they were produced. */
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly input: ForemanExecutorInput) {}

  /**
   * Queue a pending assignment for launch: local goes to the local executor, remote becomes one `assign` frame.
   *
   * Rendering happens inside this method, which the Engine calls within its transaction, so a render failure — an
   * attachment that is missing from the store, say — must not throw out of it and abort the accept. It is reported
   * `blocked` instead, which is the same outcome as a device that cannot be reached.
   */
  start(ticket: Ticket, assignment: Assignment): void {
    const target = targetOf(assignment)
    if (target.kind === 'local') {
      this.input.local.start(ticket, assignment)
      return
    }
    let frame: AssignFrame
    try {
      frame = this.assignFrame(ticket, assignment, target.deviceId, target.directory)
    } catch (error) {
      this.input.log?.(`could not render ${assignment.id} for ${target.deviceId}: ${String(error)}`)
      this.input.engine().report(ticket.id, { state: 'blocked', summary: `the task could not be prepared for ${target.deviceId}: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    if (!this.sent.take(frame.frameId)) return
    this.enqueue(() => this.input.transport.send(target.deviceId, frame).catch(error => {
      this.input.log?.(`could not assign ${assignment.id} to ${target.deviceId}: ${String(error)}`)
      // The device may be offline; a person decides whether to wait, move the work, or change the device.
      this.input.engine().report(ticket.id, { state: 'blocked', summary: `device offline: ${target.deviceId}` })
    }))
  }

  /**
   * Queue delivery of the ticket's waiting Inputs. A local assignment keeps the local executor's behaviour; a remote
   * one gets an `input` frame.
   *
   * A failed delivery releases its frame id, so the ticket's next `deliver` really does retry it. Keeping the id
   * would have made the retry a no-op and lost the Input silently — the comment on the port promises a retry.
   *
   * The frame id is the one the device's `ack` will carry back, and it encodes the Input ids it delivered, which is
   * how the hub knows which Inputs the device took (see `inputsOf`).
   */
  deliver(ticket: Ticket, assignment: Assignment): void {
    const target = targetOf(assignment)
    if (target.kind === 'local') {
      this.input.local.deliver(ticket, assignment)
      return
    }
    let frame: InputFrame
    try {
      const rendered = this.render(ticket)
      frame = { v: 1, type: 'input', frameId: inputFrameId(ticket.id, assignment.id, ticket.undelivered),
        assignmentId: assignment.id, text: rendered.text, attachments: rendered.attachments }
    } catch (error) {
      // Rendering must not throw inside the Engine's transaction: a failed input is retried by the next delivery.
      this.input.log?.(`could not render inputs for ${assignment.id} to ${target.deviceId}: ${String(error)}`)
      return
    }
    if (this.delivering.has(frame.frameId)) return
    this.delivering.add(frame.frameId)
    this.enqueue(() => this.input.transport.send(target.deviceId, frame).catch(error => {
      this.delivering.delete(frame.frameId)
      this.input.log?.(`could not deliver inputs for ${assignment.id} to ${target.deviceId}: ${String(error)}`)
    }))
  }

  /** Send a `stop` frame and do not wait for an answer, mirroring the fire-and-forget local stop; a late report is dropped. */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    const target = targetOf(assignment)
    if (target.kind === 'local') {
      this.input.local.stop(ticket, assignment, reason)
      return
    }
    const frame: StopFrame = { v: 1, type: 'stop', frameId: `stop:${assignment.id}:${reason}`, assignmentId: assignment.id, reason }
    this.enqueue(() => this.input.transport.send(target.deviceId, frame).catch(error => {
      this.input.log?.(`could not stop ${assignment.id} on ${target.deviceId}: ${String(error)}`)
    }))
  }

  private assignFrame(ticket: Ticket, assignment: Assignment, deviceId: string, directory: string): AssignFrame {
    const device = this.input.deviceOf?.(deviceId)
    const rendered = this.render(ticket, device === undefined ? undefined : { ...device, directory })
    return { v: 1, type: 'assign', frameId: `assign:${assignment.id}`, assignmentId: assignment.id, ticketId: ticket.id,
      directory, text: rendered.text, attachments: rendered.attachments, permissionPreset: 'workspace-write' }
  }

  /**
   * The task as the device reads it. Rendered on the hub because the device has none of the hub's resources; the
   * device directory rides on the frame, not in the text.
   */
  private render(ticket: Ticket, device?: { id: string; name: string; directory: string }): Rendered {
    const triggerOf = this.input.triggerOf ?? (() => ({}))
    return renderForDevice({ ticket, ...triggerOf(ticket), readAttachment: this.input.readAttachment ?? (() => Buffer.alloc(0)),
      ...(device === undefined ? {} : { device }) })
  }

  /** Append work to the send chain, keeping the chain alive after a failure. */
  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work, work)
  }
}
