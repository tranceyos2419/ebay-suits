/**
 * xml_util.ts -- tiny helpers for pulling values out of eBay Trading API XML
 * responses without pulling in an XML parsing dependency.
 *
 * eBay's Trading API responses are simple, non-recursive-in-tag-name
 * documents for the fields we care about here, so a couple of small regexes
 * are sufficient (mirrors the narrow use of ElementTree.findtext in the
 * original Python scripts).
 */

/** Find the first `<tag>...</tag>` value anywhere in `xml`, ignoring any namespace prefix. */
export function findText(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`);
  const m = xml.match(re);
  return m ? m[1] : undefined;
}

export interface TradingError {
  severity: string;
  short: string;
  long: string;
}

/** Extract all <Errors> blocks (SeverityCode / ShortMessage / LongMessage). */
export function findErrors(xml: string): TradingError[] {
  const errors: TradingError[] = [];
  const re = /<(?:\w+:)?Errors[^>]*>([\s\S]*?)<\/(?:\w+:)?Errors>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    errors.push({
      severity: findText(block, "SeverityCode") ?? "",
      short: findText(block, "ShortMessage") ?? "",
      long: findText(block, "LongMessage") ?? "",
    });
  }
  return errors;
}

/**
 * Find every non-nested `<tag>...</tag>` block anywhere in `xml`, ignoring
 * namespace prefixes, and return their inner contents. Mirrors findErrors'
 * pattern but for any repeating tag (e.g. `<Item>` entries in a list
 * response) -- assumes `tag` does not nest inside itself.
 */
export function findBlocks(xml: string, tag: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}
