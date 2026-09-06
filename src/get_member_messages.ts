#!/usr/bin/env -S npx tsx
/**
 * get_member_messages.ts -- fetch the most recent buyer messages via the
 * Trading API's GetMemberMessages call.
 *
 * Usage:
 *   export EBAY_ACCESS_TOKEN="your-token"
 *   npx tsx get_member_messages.ts [COUNT]
 */

import { findText, findErrors } from "./xml_util.ts";

function findAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

async function main() {
  const count = parseInt(process.argv[2] ?? "3", 10);

  const token = process.env.EBAY_ACCESS_TOKEN;
  if (!token) {
    console.error('ERROR: set EBAY_ACCESS_TOKEN first, e.g.\n  export EBAY_ACCESS_TOKEN="your-token"');
    process.exit(1);
  }

  const now = new Date();
  const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // last 30 days

  const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GetMemberMessagesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <MailMessageType>All</MailMessageType>
  <StartCreationTime>${start.toISOString()}</StartCreationTime>
  <EndCreationTime>${now.toISOString()}</EndCreationTime>
  <DetailLevel>ReturnMessages</DetailLevel>
  <Pagination>
    <EntriesPerPage>${Math.max(count, 10)}</EntriesPerPage>
    <PageNumber>1</PageNumber>
  </Pagination>
</GetMemberMessagesRequest>`;

  const resp = await fetch("https://api.ebay.com/ws/api.dll", {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
      "X-EBAY-API-CALL-NAME": "GetMemberMessages",
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body: xmlBody,
  });

  if (!resp.ok) {
    console.log(`HTTP ${resp.status}`);
  }
  const body = await resp.text();

  const ack = findText(body, "Ack") ?? "Unknown";
  console.log(`Ack: ${ack}`);

  for (const err of findErrors(body)) {
    console.log(`  [${err.severity}] ${err.short} -- ${err.long}`);
  }

  if (ack === "Success" || ack === "Warning") {
    const messages = findAll(body, "MemberMessageExchange");
    const parsed = messages.map((m) => ({
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
    if (parsed.length === 0) {
      console.log("(no messages found in the last 30 days)");
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
