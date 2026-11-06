/**
 * Rendering a ticket for a device.
 *
 * A device has none of the hub's resources: no `read: ticket/...` pointers, no attachment object store, no hub
 * paths. So the task text is finished here, on the hub, and attachments travel as bytes. This is the placeholder
 * Task 6 needs; Task 10 replaces it with the full text and the attachment list.
 */
import type { Ticket, Trigger } from '../core/index.ts'
import type { FrameAttachment } from './protocol.ts'

export interface RenderInput {
  ticket: Ticket
  /** The Trigger the ticket came from, which carries the request's own words and its attachments. */
  trigger?: Trigger
  /** Reads an attachment's bytes by id. */
  readAttachment: (id: string) => Buffer
}

export interface Rendered {
  text: string
  attachments: FrameAttachment[]
}

/** The task text a device receives, and the bytes that travel with it. */
export function renderForDevice(input: RenderInput): Rendered {
  const ticket = input.ticket
  return { text: ticket.execution?.assignment || ticket.title, attachments: [] }
}
