import { describe, expect, it } from "vitest";
import { cleanText, FeedError, parseFeed } from "../src/feeds";

const source = { id: "1", name: "Test Source" };

describe("parseFeed", () => {
  it("parses RSS 2.0 with HTML descriptions", () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
      <item><title>First &amp; foremost</title><link>https://example.com/a</link>
        <description><![CDATA[<p>Hello <b>world</b>&nbsp;&#8212; ok</p>]]></description>
        <pubDate>Mon, 28 Sep 2026 10:00:00 GMT</pubDate></item>
      <item><title>No link but permalink guid</title><guid>https://example.com/b</guid></item>
      <item><title>Dropped: no link</title></item>
    </channel></rss>`;
    const articles = parseFeed(xml, source);
    expect(articles).toHaveLength(2);
    expect(articles[0]).toEqual({
      title: "First & foremost",
      link: "https://example.com/a",
      summary: "Hello world — ok",
      published: "2026-09-28T10:00:00.000Z",
      sourceId: "1",
      source: "Test Source",
    });
    expect(articles[1].link).toBe("https://example.com/b");
    expect(articles[1].published).toBeNull();
  });

  it("parses a single-item RSS feed", () => {
    const xml = `<rss><channel><item><title>Only</title><link>https://example.com/x</link></item></channel></rss>`;
    expect(parseFeed(xml, source).map((a) => a.title)).toEqual(["Only"]);
  });

  it("parses Atom and prefers the alternate link", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title type="html">Atom &lt;i&gt;entry&lt;/i&gt;</title>
        <link rel="self" href="https://example.com/self"/>
        <link rel="alternate" href="https://example.com/post"/>
        <summary>Short</summary><updated>2026-09-01T00:00:00Z</updated></entry>
    </feed>`;
    const [a] = parseFeed(xml, source);
    expect(a.title).toBe("Atom entry");
    expect(a.link).toBe("https://example.com/post");
    expect(a.summary).toBe("Short");
    expect(a.published).toBe("2026-09-01T00:00:00.000Z");
  });

  it("parses RSS 1.0 (RDF)", () => {
    const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel><title>C</title></channel>
      <item><title>RDF item</title><link>https://example.com/r</link><dc:date>2026-09-02T00:00:00Z</dc:date></item>
    </rdf:RDF>`;
    const [a] = parseFeed(xml, source);
    expect(a.link).toBe("https://example.com/r");
    expect(a.published).toBe("2026-09-02T00:00:00.000Z");
  });

  it("rejects non-feed documents", () => {
    expect(() => parseFeed("<html><body>Not a feed</body></html>", source)).toThrow(FeedError);
  });

  it("truncates long summaries", () => {
    const long = "word ".repeat(300);
    const xml = `<rss><channel><item><title>L</title><link>https://e.com</link><description>${long}</description></item></channel></rss>`;
    expect(parseFeed(xml, source)[0].summary.length).toBeLessThanOrEqual(500);
  });
});

describe("cleanText", () => {
  it("strips scripts and tags and decodes entities", () => {
    expect(cleanText("<script>alert(1)</script><p>A&#x27;s &lt;tag&gt;</p>")).toBe("A's <tag>");
  });
});
