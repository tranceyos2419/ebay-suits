#!/usr/bin/env -S npx tsx
/**
 * get_member_messages.ts -- fetch the most recent buyer messages (messages
 * other members sent us) from the last 30 days via eBay's Message API
 * (src/lib/message_api.ts, conversation_type FROM_MEMBERS).
 *
 * The Message API groups messages into conversations, and a conversation
 * also holds our own replies; those are left out unless --include-sent is
 * given. "Subject" is the conversation's title (the API has no per-message
 * subject).
 *
 * Usage:
 *   npx tsx src/messages/get_member_messages.ts --account <name> [COUNT] [--include-sent]
 */

import { accountFromArgs, getAccount, getUserId, IDENTITY_SCOPE, oauthToken } from "../auth/ebay_auth.ts";
import { getConversation, iterateConversations, messageToken } from "../lib/message_api.ts";
import { DAY_MS, runMain } from "../lib/util.ts";

interface Msg {
  sender: string;
  subject: string;
  text: string;
  creationDate: string;
  itemId: string;
}

async function main() {
  const { account, rest } = accountFromArgs(process.argv.slice(2));
  const includeSent = rest.includes("--include-sent");
  const count = parseInt(rest.find((a) => !a.startsWith("--")) ?? "3", 10);

  const now = new Date();
  const start = new Date(now.getTime() - 30 * DAY_MS); // last 30 days
  const startIso = start.toISOString();
  const nowIso = now.toISOString();
  const token = await messageToken(account);
  const me = (getAccount(account).ebayUserId ?? (await getUserId(await oauthToken(account, [IDENTITY_SCOPE])))).toLowerCase();

  // Conversations come newest activity first, so once COUNT messages are in
  // hand that are newer than the next conversation's latest message, no later
  // conversation can add a newer one.
  const parsed: Msg[] = [];
  for await (const c of iterateConversations(token, { type: "FROM_MEMBERS", start, end: now })) {
    const latest = c.latestMessage?.createdDate ?? c.createdDate ?? "";
    if (parsed.length >= count && latest && latest < parsed[count - 1].creationDate) break;
    if (latest && latest < startIso) break;

    const { conversationTitle, messages } = await getConversation(token, c.conversationId, "FROM_MEMBERS");
    for (const m of messages) {
      const date = m.createdDate ?? "";
      if (date < startIso || date > nowIso) continue;
      if (!includeSent && (m.senderUsername ?? "").toLowerCase() === me) continue;
      parsed.push({
        sender: m.senderUsername ?? "",
        subject: (conversationTitle ?? "").split("\n")[0].trim(),
        text: m.messageBody ?? "",
        creationDate: date,
        itemId: c.referenceType === "LISTING" ? (c.referenceId ?? "") : "",
      });
    }
    parsed.sort((a, b) => (a.creationDate < b.creationDate ? 1 : -1));
  }

  for (const msg of parsed.slice(0, count)) {
    console.log("----");
    console.log(`From: ${msg.sender}`);
    console.log(`Date: ${msg.creationDate}`);
    console.log(`Item: ${msg.itemId}`);
    console.log(`Subject: ${msg.subject}`);
    console.log(`Text: ${msg.text}`);
  }
  if (parsed.length === 0) console.log("(no messages found in the last 30 days)");
}

runMain(main);
