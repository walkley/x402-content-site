import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDate, formatDay } from "../src/calendar.js";
import { YEAR_FILES } from "../src/data.js";

const DIR = new URL("../data/cn-holidays/", import.meta.url);
const files = readdirSync(DIR).filter((f) => /^\d{4}\.json$/.test(f)).sort();

describe("data/cn-holidays contract", () => {
  it("every year file is bundled by src/data.ts", () => {
    expect(YEAR_FILES.map((f) => `${f.year}.json`).sort()).toEqual(files);
  });

  it.each(files)("%s matches the contract", (name) => {
    const f = JSON.parse(readFileSync(new URL(name, DIR), "utf8"));
    expect(Object.keys(f).sort()).toEqual(["holidays", "makeup_workdays", "published", "source_url", "year"]);
    expect(f.year).toBe(Number(name.slice(0, 4)));
    expect(f.source_url).toMatch(/^https:\/\/www\.gov\.cn\//);
    parseDate(f.published);
    expect(f.holidays.length).toBeGreaterThan(0);
    const off = new Set<string>();
    for (const h of f.holidays) {
      expect(Object.keys(h).sort()).toEqual(["end", "name", "start"]);
      expect(h.name).toBeTruthy();
      const s = parseDate(h.start), e = parseDate(h.end);
      expect(e).toBeGreaterThanOrEqual(s);
      for (let d = s; d <= e; d++) off.add(formatDay(d));
    }
    for (const m of f.makeup_workdays) {
      const wd = new Date(parseDate(m) * 86_400_000).getUTCDay();
      expect([0, 6]).toContain(wd); // makeup workdays are always Saturday or Sunday
      expect(off.has(m)).toBe(false);
    }
  });
});
