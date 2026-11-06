/**
 * Rendering a ticket for a device.
 *
 * A device has none of the hub's resources: no `read: ticket/...` pointers, no attachment object store, no hub
 * paths. So the task text is finished here, on the hub, and attachments travel as bytes. Done wrong, the device's
 * worker would try to open a path that exists only on the hub and fail — or worse, read the wrong file.
 *
 * Nothing in the rendered text may name a hub path: the device's own directory rides on the frame, not in the text.
 */
import type { Ticket, Trigger } from '../core/index.ts'
import { isAttachmentId } from '../sources/dsh.ts'
import { MAX_FRAME_BYTES, type FrameAttachment } from './protocol.ts'

/** One attachment as the local Source records it in a Trigger's `meta.attachments`. */
interface AttachmentRef {
  id?: unknown
  kind?: unknown
  name?: unknown
  mediaType?: unknown
}

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

/** How many attachment bytes may ride on one frame, leaving room for the text and the rest of the frame. */
const ATTACHMENT_BUDGET = MAX_FRAME_BYTES - 32 * 1024

/** The attachments a trigger names, filtered to ids the hub will actually be able to read. */
const refsOf = (trigger: Trigger | undefined): AttachmentRef[] => {
  const refs = trigger?.meta['attachments']
  if (!Array.isArray(refs)) return []
  return refs.filter((ref): ref is AttachmentRef => typeof ref === 'object' && ref !== null)
    // An id that cannot be read must not become a line telling the device to open something that is not there.
    .filter(ref => isAttachmentId(ref.id))
}

/** The display name of an attachment: what the source recorded, else its id, so the device always has something to open. */
const nameOf = (ref: AttachmentRef): string => typeof ref.name === 'string' && ref.name !== '' ? ref.name : String(ref.id)

/** Renders the section listing attachments, or nothing when the task carries none. */
function attachmentSection(names: readonly string[]): string {
  if (names.length === 0) return ''
  const listing = names.map(name => `- ${name}`).join('\n')
  return `\n## 随任务送达的附件\n\n${listing}\n\n这些附件已经随本次任务到达本机，用 read（文本）或 read_image（图片）按上面的名字打开。\n`
}

/**
 * Builds the text a device's worker reads and the bytes that travel with it.
 *
 * The text has three parts: what the ticket is for, the request as the person wrote it, and the attachment names.
 * The request text is the source's own words, unchanged — a device should read what was asked, not a paraphrase.
 *
 * @throws When the attachments together exceed the frame budget: a truncated task would be worse than a refused one.
 */
export function renderForDevice(input: RenderInput): Rendered {
  const { ticket, trigger } = input
  const refs = refsOf(trigger)
  const attachments: FrameAttachment[] = []
  let total = 0
  for (const ref of refs) {
    const bytes = input.readAttachment(String(ref.id))
    total += bytes.byteLength
    if (total > ATTACHMENT_BUDGET) {
      throw new Error(`the attachments of ticket ${ticket.id} are too large to send: more than ${ATTACHMENT_BUDGET} bytes`)
    }
    attachments.push({ id: String(ref.id), name: nameOf(ref),
      mediaType: typeof ref.mediaType === 'string' ? ref.mediaType : undefined, bytes: bytes.toString('base64') })
  }
  const scope = ticket.execution?.assignment?.trim() ?? ''
  const request = trigger?.text?.trim() ?? ''
  const sections = [`# ${ticket.title}`, scope === '' ? '' : `\n${scope}\n`, request === '' ? '' : `\n## 原始需求\n\n${request}\n`,
    attachmentSection(attachments.map(attachment => attachment.name ?? attachment.id))]
  return { text: sections.filter(section => section !== '').join(''), attachments }
}
