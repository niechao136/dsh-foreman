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

/**
 * How many **raw** attachment bytes fit in a frame once base64 has expanded them.
 *
 * base64 turns every 3 bytes into 4, so budgeting raw bytes against `MAX_FRAME_BYTES` would accept an attachment the
 * peer then refuses: 224 KiB raw becomes about 299 KiB on the wire, past the 256 KiB cap. The margin leaves room for
 * the rest of the frame — the task text, ids and JSON punctuation.
 */
const ENCODED_OVERHEAD = 4 / 3
const ATTACHMENT_BUDGET = Math.floor((MAX_FRAME_BYTES - 32 * 1024) / ENCODED_OVERHEAD)

/** The size a buffer takes once base64-encoded, without actually encoding it. */
const encodedSize = (bytes: number): number => Math.ceil(bytes / 3) * 4

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

/**
 * Renders the section listing attachments, or nothing when the task carries none.
 *
 * English, like the rest of the hub's worker-facing text (`ticketExecution` writes "The operator attached these…" in
 * the same voice). The request itself and the file names stay in whatever language the person used.
 */
function attachmentSection(names: readonly string[]): string {
  if (names.length === 0) return ''
  const listing = names.map(name => `- ${name}`).join('\n')
  return `\n## Attachments that arrived with this task\n\n${listing}\n\nThese files are on this machine already: open them by the names above with read (text) or read_image (images).\n`
}

/**
 * Builds the text a device's worker reads and the bytes that travel with it.
 *
 * The text has three parts: what the ticket is for, the scope the accept recorded, and the request as the person
 * wrote it. The request is the source's own words, unchanged — a device should read what was asked, not a
 * paraphrase.
 *
 * **The hub's `execution.assignment` is filtered, not included verbatim.** `ticketExecution` builds that text for a
 * worker on this host, and for a local ticket with attachments it lists absolute paths under
 * `~/.dsh/attachments/...` — paths that do not exist on a device, and that design 5.7 says must never leave the hub.
 * The device gets the bytes instead, plus the names listed at the end.
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
    // Count what the frame will weigh, not what the file weighs: base64 expands every 3 bytes to 4.
    total += encodedSize(bytes.byteLength)
    if (total > MAX_FRAME_BYTES - 32 * 1024) {
      throw new Error(`the attachments of ticket ${ticket.id} are too large to send: more than ${ATTACHMENT_BUDGET} bytes of file, once base64 has expanded them`)
    }
    attachments.push({ id: String(ref.id), name: nameOf(ref),
      mediaType: typeof ref.mediaType === 'string' ? ref.mediaType : undefined, bytes: bytes.toString('base64') })
  }
  const scope = scopeOf(ticket)
  const request = trigger?.text?.trim() ?? ''
  const sections = [`# ${ticket.title}`, scope === '' ? '' : `\n${scope}\n`, request === '' ? '' : `\n## The request as it was written\n\n${request}\n`,
    attachmentSection(attachments.map(attachment => attachment.name ?? attachment.id))]
  return { text: sections.filter(section => section !== '').join(''), attachments }
}

/**
 * The ticket's scope statement with any hub path removed.
 *
 * `execution.assignment` may be a routing note, a scope sentence, or — for a local ticket with attachments — a block
 * listing absolute hub attachment paths. A line that is only part of such a listing is dropped whole rather than
 * left as a dangling bullet, and any path-shaped run inside a kept line is removed.
 */
function scopeOf(ticket: Ticket): string {
  const assignment = ticket.execution?.assignment?.trim() ?? ''
  if (assignment === '') return ''
  return assignment.split('\n').flatMap(line => {
    if (/^\s*-\s*(?:image|file):/.test(line)) return []
    const cleaned = line.replace(/[A-Za-z]?:?[\\/](?:[^\s\\/:]+[\\/])+[^\s:;,"')]+/g, '').replace(/[ \t]{2,}/g, ' ').trim()
    return cleaned === '' || cleaned === '-' ? [] : [cleaned]
  }).join('\n').trim()
}
