import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const doc = JSON.parse(readFileSync(new URL("../known-addresses.json", import.meta.url), "utf8"));

describe("known-addresses.json", () => {
  it("lists unique, well-formed addresses with a known role", () => {
    const seen = new Set<string>();
    for (const a of doc.addresses) {
      expect(a.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(doc.roles).toContain(a.role);
      expect(seen.has(a.address.toLowerCase())).toBe(false);
      seen.add(a.address.toLowerCase());
    }
  });
});
