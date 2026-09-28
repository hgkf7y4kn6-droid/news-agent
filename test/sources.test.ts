import { describe, expect, it } from "vitest";
import { SOURCES } from "../src/sources";

describe("source catalog", () => {
  it("has 62 sources with unique ids and absolute feed URLs", () => {
    expect(SOURCES).toHaveLength(62);
    expect(new Set(SOURCES.map((s) => s.id)).size).toBe(62);
    for (const s of SOURCES) expect(s.url).toMatch(/^https:\/\/[^/]+\/.+/);
  });
});
