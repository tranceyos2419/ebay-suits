/**
 * message_api.ts -- read-only access to eBay's Message REST API
 * (commerce/message/v1), which replaces the Trading API's GetMemberMessages /
 * GetMyMessages. Needs the commerce.message OAuth scope.
 *
 * Messages are grouped into conversations. conversation_type FROM_MEMBERS is
 * member-to-member mail (buyer questions and our replies); FROM_EBAY is eBay's
 * own notices. Conversations come newest activity first; the API caps `limit`
 * at 50 and pages by offset.
 */

import { oauthToken } from "../auth/ebay_auth.ts";
import { sleep } from "./util.ts";

export const MESSAGE_API = "https://api.ebay.com/commerce/message/v1";
export const MESSAGE_SCOPE = "https://api.ebay.com/oauth/api_scope/commerce.message";
const MAX_RETRIES = 4;
const MAX_LIMIT = 50;

export type ConversationType = "FROM_MEMBERS" | "FROM_EBAY";

export interface Message {
  messageId: string;
  messageBody?: string;
  senderUsername?: string;
  recipientUsername?: string;
  readStatus?: boolean;
  createdDate: string;
  messageMedia?: unknown[];
}

export interface Conversation {
  conversationId: string;
  conversationStatus?: string;
  conversationType?: ConversationType;
  conversationTitle?: string;
  createdDate?: string;
  referenceId?: string; // the item ID when referenceType is LISTING
  referenceType?: string;
  unreadCount?: number;
  latestMessage?: Message;
}

export function messageToken(account: string): Promise<string> {
  return oauthToken(account, [MESSAGE_SCOPE]);
}

/** GET `${MESSAGE_API}/${path}`, retrying network errors, 429s and 5xx with backoff. */
export async function messageGet(token: string, path: string, marketplace = "EBAY_US"): Promise<any> {
  const url = `${MESSAGE_API}/${path}`;
  for (let attempt = 0; ; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "X-EBAY-C-MARKETPLACE-ID": marketplace,
        },
      });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}\n${text.slice(0, 1000)}`);
    return text ? JSON.parse(text) : {};
  }
}

export interface ConversationQuery {
  type: ConversationType;
  /** Only conversations with activity in [start, end]. */
  start?: Date;
  end?: Date;
  /** Stop after this many conversations (default: all). */
  max?: number;
}

/** Conversations, newest activity first, one API page at a time. */
export async function* iterateConversations(token: string, q: ConversationQuery): AsyncGenerator<Conversation> {
  let yielded = 0;
  const max = q.max ?? Infinity;
  for (let offset = 0; yielded < max; ) {
    const params = new URLSearchParams({
      conversation_type: q.type,
      limit: String(Math.min(MAX_LIMIT, max - yielded)),
      offset: String(offset),
    });
    if (q.start) params.set("start_time", q.start.toISOString());
    if (q.end) params.set("end_time", q.end.toISOString());
    const page = await messageGet(token, `conversation?${params}`);
    const convs: Conversation[] = page.conversations ?? [];
    for (const c of convs) {
      if (yielded++ >= max) return;
      yield c;
    }
    offset += convs.length;
    if (!page.next || convs.length === 0) break;
  }
}

/** Conversations, newest activity first. */
export async function getConversations(token: string, q: ConversationQuery): Promise<Conversation[]> {
  const out: Conversation[] = [];
  for await (const c of iterateConversations(token, q)) out.push(c);
  return out;
}

/** One conversation's title and messages (newest first, up to `max`). */
export async function getConversation(
  token: string,
  conversationId: string,
  type: ConversationType,
  max = Infinity
): Promise<{ conversationTitle?: string; messages: Message[] }> {
  const messages: Message[] = [];
  let title: string | undefined;
  for (let offset = 0; messages.length < max; ) {
    const params = new URLSearchParams({
      conversation_type: type,
      limit: String(Math.min(MAX_LIMIT, max - messages.length)),
      offset: String(offset),
    });
    const page = await messageGet(token, `conversation/${encodeURIComponent(conversationId)}?${params}`);
    title ??= page.conversationTitle;
    const msgs: Message[] = page.messages ?? [];
    messages.push(...msgs);
    offset += msgs.length;
    if (!page.next || msgs.length === 0) break;
  }
  return { conversationTitle: title, messages: messages.slice(0, max) };
}
