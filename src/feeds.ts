import { XMLParser } from "fast-xml-parser";
import type { Source } from "./sources";

export interface Article {
  title: string;
  link: string;
  summary: string;
  published: string | null;
  sourceId: string;
  source: string;
}

const FETCH_TIMEOUT_MS = 10_000;
const FEED_CACHE_TTL_S = 300;
const SUMMARY_MAX_CHARS = 500;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => name === "item" || name === "entry" || name === "link",
});

export class FeedError extends Error {}

export async function fetchFeed(source: Source): Promise<Article[]> {
  let res: Response;
  try {
    res = await fetch(source.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NewsAgent/1.0; +https://workers.cloudflare.com)",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cf: { cacheTtl: FEED_CACHE_TTL_S, cacheEverything: true },
    });
  } catch (err) {
    throw new FeedError(`Could not reach ${source.name}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new FeedError(`${source.name} returned HTTP ${res.status}`);
  }
  return parseFeed(await res.text(), source);
}

/** Parses RSS 2.0, RSS 1.0 (RDF) and Atom documents into a flat article list. */
export function parseFeed(xml: string, source: Pick<Source, "id" | "name">): Article[] {
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new FeedError(`${source.name} returned invalid XML: ${(err as Error).message}`);
  }

  const items: any[] =
    doc?.rss?.channel?.item ??
    doc?.feed?.entry ??
    doc?.["rdf:RDF"]?.item ??
    doc?.["rdf:RDF"]?.channel?.item;
  if (!Array.isArray(items)) {
    throw new FeedError(`${source.name} did not return an RSS or Atom feed`);
  }

  const articles: Article[] = [];
  for (const item of items) {
    const title = cleanText(textOf(item.title));
    const link = pickLink(item.link) || permalinkGuid(item.guid);
    if (!title || !link) continue;

    const rawSummary = textOf(item.description) || textOf(item.summary) || textOf(item["content:encoded"]) || textOf(item.content);
    articles.push({
      title,
      link,
      summary: truncate(cleanText(rawSummary), SUMMARY_MAX_CHARS),
      published: toIsoDate(textOf(item.pubDate) || textOf(item.published) || textOf(item.updated) || textOf(item["dc:date"])),
      sourceId: source.id,
      source: source.name,
    });
  }
  return articles;
}

function textOf(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return textOf(value[0]);
  if (typeof value === "object") return textOf((value as Record<string, unknown>)["#text"]);
  return "";
}

function pickLink(links: unknown): string {
  if (!Array.isArray(links)) return "";
  // Atom: prefer rel="alternate" (or no rel); RSS: plain text node.
  for (const link of links) {
    if (typeof link === "string" && link.trim()) return link.trim();
    if (link && typeof link === "object") {
      const href = (link as Record<string, string>)["@_href"];
      const rel = (link as Record<string, string>)["@_rel"];
      if (href && (!rel || rel === "alternate")) return href.trim();
      const text = textOf(link).trim();
      if (text) return text;
    }
  }
  return "";
}

function permalinkGuid(guid: unknown): string {
  const value = textOf(guid).trim();
  const isPermaLink = typeof guid === "object" && guid !== null ? (guid as Record<string, string>)["@_isPermaLink"] !== "false" : true;
  return isPermaLink && /^https?:\/\//.test(value) ? value : "";
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};

/** Strips HTML tags and decodes leftover entities (feeds often double-encode HTML in descriptions). */
export function cleanText(html: string): string {
  return html
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
      if (code[0] === "#") {
        const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
      }
      return NAMED_ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "…";
}

function toIsoDate(value: string): string | null {
  if (!value) return null;
  const time = Date.parse(value.trim());
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}
