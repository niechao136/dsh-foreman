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
import type { Assignment, EngineForExecutor, Executor, Ticket } from '../core/index.ts'
import { targetOf } from '../core/model.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import { FrameDedupe, type AssignFrame, type Frame, type InputFrame, type StopFrame } from './protocol.ts'
import { renderForDevice } from './render.ts'
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
  /** Serialises sends so frames for one device reach it in the order they were produced. */
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly input: ForemanExecutorInput) {}

  /** Queue a pending assignment for launch: local goes to the local executor, remote becomes one `assign` frame. */
  start(ticket: Ticket, assignment: Assignment): void {
    const target = targetOf(assignment)
    if (target.kind === 'local') {
      this.input.local.start(ticket, assignment)
      return
    }
    const frame = this.assignFrame(ticket, assignment, target.deviceId, target.directory)
    if (!this.sent.take(frame.frameId)) return
    this.enqueue(() => this.input.transport.send(target.deviceId, frame).catch(error => {
      this.input.log?.(`could not assign ${assignment.id} to ${target.deviceId}: ${String(error)}`)
      // The device may be offline; a person decides whether to wait, move the work, or change the device.
      this.input.engine().report(ticket.id, { state: 'blocked', summary: `device offline: ${target.deviceId}` })
    }))
  }

  /**
   * Queue delivery of the ticket's waiting Inputs. A local assignment keeps the local executor's behaviour; a remote
   * one gets an `input` frame. A failed input delivery is silent: the next delivery of the same ticket retries it.
   */
  deliver(ticket: Ticket, assignment: Assignment): void {
    const target = targetOf(assignment)
    if (target.kind === 'local') {
      this.input.local.deliver(ticket, assignment)
      return
    }
    const frame: InputFrame = { v: 1, type: 'input', frameId: `input:${ticket.id}:${assignment.id}:${ticket.undelivered.join(',')}`,
      assignmentId: assignment.id, text: this.render(ticket).text, attachments: this.render(ticket).attachments }
    if (!this.sent.take(frame.frameId)) return
    this.enqueue(() => this.input.transport.send(target.deviceId, frame).catch(error => {
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
    const rendered = this.render(ticket)
    return { v: 1, type: 'assign', frameId: `assign:${assignment.id}`, assignmentId: assignment.id, ticketId: ticket.id,
      directory, text: rendered.text, attachments: rendered.attachments, permissionPreset: 'workspace-write' }
  }

  /**
   * The task as the device reads it. Rendered on the hub because the device has none of the hub's resources; the
   * device directory rides on the frame, not in the text.
   */
  private render(ticket: Ticket): ReturnType<typeof renderForDevice> {
    return renderForDevice({ ticket, readAttachment: this.input.readAttachment ?? (() => Buffer.alloc(0)) })
  }

  /** Append work to the send chain, keeping the chain alive after a failure. */
  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work, work)
  }
}
