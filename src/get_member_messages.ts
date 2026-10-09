#!/usr/bin/env -S npx tsx
/**
 * get_member_messages.ts -- fetch the most recent buyer messages via the
 * Trading API's GetMemberMessages call.
 *
 * Usage:
 *   npx tsx src/get_member_messages.ts --account <name> [COUNT]
 */

import { findBlocks, findText } from "./xml_util.ts";
import { accountFromArgs, authnAuthToken } from "./ebay_auth.ts";
import { printErrors, tradingCall } from "./trading_api.ts";
import { DAY_MS, runMain } from "./util.ts";

async function main() {
  const { account, rest } = accountFromArgs(process.argv.slice(2));
  const count = parseInt(rest[0] ?? "3", 10);

  const now = new Date();
  const start = new Date(now.getTime() - 30 * DAY_MS); // last 30 days

  const r = await tradingCall(
    authnAuthToken(account),
    "GetMemberMessages",
    `  <MailMessageType>All</MailMessageType>
  <StartCreationTime>${start.toISOString()}</StartCreationTime>
  <EndCreationTime>${now.toISOString()}</EndCreationTime>
  <DetailLevel>ReturnMessages</DetailLevel>
  <Pagination>
    <EntriesPerPage>${Math.max(count, 10)}</EntriesPerPage>
    <PageNumber>1</PageNumber>
  </Pagination>`
  );
  console.log(`Ack: ${r.ack}`);
  printErrors(r.errors);
  if (!r.ok) return;

  const parsed = findBlocks(r.xml, "MemberMessageExchange").map((m) => ({
    sender: findText(m, "SenderID") ?? "",
    subject: findText(m, "Subject") ?? "",
    text: findText(m, "Body") ?? "",
    creationDate: findText(m, "CreationDate") ?? "",
    itemId: findText(m, "ItemID") ?? "",
  }));
  parsed.sort((a, b) => (a.creationDate < b.creationDate ? 1 : -1));
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
