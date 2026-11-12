/** Feishu outbound channel: posts threaded bot replies and constructs chat deep links. */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { feishuTriggerId } from './feishu-trigger.ts'

/** Feishu or Lark AppLink that opens a chat; used when the message's own link was not delivered with the event. */
export const feishuChatLink = (brand: 'feishu' | 'lark', chatId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
/**
 * True when Feishu permanently rejects a reply because the target message was recalled, withdrawn, or not found.
 * Only a Feishu response carrying one of these error codes means the target message is gone; timeouts or crashes do not.
 */
const gone = (error: unknown): boolean => {
  if (!(error instanceof CliError) || error.code === undefined) return false
  // 飞书业务码：230011 撤回、230012/230020 消息不存在；CLI 文案中英文都可能出现，两种都要认。
  if ([230011, 230012, 230020].includes(error.code)) return true
  return /withdrawn|recalled|not found/i.test(error.message) || /撤回|已删除|不存在/.test(error.message)
}
/**
 * Feishu's generic server error, the one that carries no actionable code of its own.
 *
 * Verified against the live API: replying with `--reply-in-thread` to a message that has no thread yet (a top-level
 * message nobody answered in the topic, so `thread_id` is null) fails with exactly this code and `retryable: true`,
 * while the *same* message accepts a plain reply and every message that already belongs to a thread accepts a
 * threaded one. Retrying can never help — there is no thread to join until one exists — so the caller must fall back
 * rather than back off.
 */
const NO_THREAD = 2200
/** True when Feishu refused a threaded reply only because the target message has no thread yet. */
const noThreadYet = (error: unknown): boolean => error instanceof CliError && error.code === NO_THREAD
/**
 * Replies in the topic of the target message; Feishu keeps at most one reply per idempotency key (the outgoing message's `message.id`).
 *
 * A threaded reply is preferred, because it keeps a Ticket's exchange in one topic. It is not always possible: a
 * top-level message that no one has answered in the topic yet has no thread to reply into, and Feishu answers that
 * with a bare 2200 that repeats forever. The reply then goes to the conversation instead of the topic — visible in the
 * same chat, one level flatter — which is far better than a message that never arrives.
 */
export async function sendFeishu(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const messageId = message.channel.address.messageId
  if (!messageId) throw new Error('Missing Feishu reply target')
  const text = checkedImText(message.text)
  const reply = (threaded: boolean) => ['im', '+messages-reply', '--message-id', messageId, '--markdown', text,
    ...threaded ? ['--reply-in-thread'] : [], '--idempotency-key', message.id]
  try { await host.commands.lark(reply(true)); return 'sent' }
  catch (error) {
    if (gone(error)) return 'gone'
    if (!noThreadYet(error)) throw error
  }
  // Retry the same idempotency key without the topic: Feishu treats the two as one message, so a fallback can never
  // post twice if the first attempt did land after all.
  try { await host.commands.lark(reply(false)) }
  catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}
/** Fallback chat link on the bot's brand; the message's own deep link on its Trigger is preferred when available. */
export const feishuLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  icon: 'message' as const,
  url: feishuChatLink(links.feishu?.brand ?? 'feishu', address.chatId ?? ''), label: { zh: '飞书消息', en: 'Feishu message' },
  ...address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {},
})
