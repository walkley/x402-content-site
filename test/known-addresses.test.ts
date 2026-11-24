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

  it("lists the payTo receiving wallet as self_pay", () => {
    const payTo = doc.addresses.find(
      (a: { address: string }) => a.address.toLowerCase() === "0xaa9bc6380c65fe6d99d0805837ae460d73a91cb2",
    );
    expect(payTo?.role).toBe("self_pay");
  });
});
