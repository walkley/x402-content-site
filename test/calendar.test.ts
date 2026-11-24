import { describe, expect, it } from "vitest";
import { HolidayCalendar, InputError, MAX_RANGE_DAYS } from "../src/calendar.js";
import { calendar } from "../src/data.js";

const kind = (d: string) => calendar.lookup(d).kind;

function inputError(fn: () => unknown): InputError {
  try {
    fn();
  } catch (e) {
    if (e instanceof InputError) return e;
    throw e;
  }
  throw new Error("expected InputError");
}

describe("single date (2026 notice, 国办发明电〔2025〕7号)", () => {
  it("ordinary weekday and weekend", () => {
    expect(calendar.lookup("2026-03-03")).toMatchObject({ is_workday: true, kind: "workday", weekday: 2, holiday_name: null });
    expect(calendar.lookup("2026-03-07")).toMatchObject({ is_workday: false, kind: "weekend", weekday: 6 });
    expect(calendar.lookup("2026-03-08")).toMatchObject({ is_workday: false, kind: "weekend", weekday: 7 });
  });

  it("public holiday periods, including weekdays and weekend days inside them", () => {
    for (const d of ["2026-02-15", "2026-02-16", "2026-02-23"]) {
      expect(calendar.lookup(d)).toMatchObject({ is_workday: false, is_public_holiday: true, holiday_name: "春节" });
    }
    expect(calendar.lookup("2026-10-07")).toMatchObject({ is_public_holiday: true, holiday_name: "国庆节" });
    expect(calendar.lookup("2026-01-01").holiday_name).toBe("元旦");
    expect(kind("2026-02-24")).toBe("workday"); // first day back
    expect(kind("2026-10-08")).toBe("workday");
  });

  it("weekend makeup workdays (调休补班)", () => {
    for (const d of ["2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10"]) {
      const info = calendar.lookup(d);
      expect(info.weekday).toBeGreaterThanOrEqual(6);
      expect(info).toMatchObject({ is_workday: true, is_makeup_workday: true, is_public_holiday: false, kind: "makeup_workday" });
    }
  });

  it("returns the gov.cn notice as source", () => {
    expect(calendar.lookup("2026-02-14").source_url).toBe("https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm");
  });

  it("holiday range that crosses a year boundary (2023 元旦 starts 2022-12-31)", () => {
    expect(calendar.lookup("2022-12-31")).toMatchObject({ is_public_holiday: true, holiday_name: "元旦" });
    expect(calendar.lookup("2023-01-02")).toMatchObject({ is_public_holiday: true, holiday_name: "元旦" });
    expect(kind("2023-01-03")).toBe("workday");
  });

  it("2020 applies the national Spring Festival extension (国办发明电〔2020〕1号)", () => {
    const ext = "https://www.gov.cn/zhengce/content/2020-01/27/content_5472352.htm";
    for (const d of ["2020-01-30", "2020-01-31", "2020-02-01", "2020-02-02"]) {
      expect(calendar.lookup(d)).toMatchObject({ kind: "public_holiday", is_workday: false, is_makeup_workday: false, holiday_name: "春节", source_url: ext });
    }
    expect(calendar.lookup("2020-02-03")).toMatchObject({ kind: "workday", is_workday: true, weekday: 1 });
    expect(calendar.businessDays("2020-01-31", "2020-02-03")).toMatchObject({ workday_count: 1, workdays: ["2020-02-03"] });
    // The other 2020 makeup workdays from the annual notice are unchanged.
    expect(calendar.lookup("2020-01-19").kind).toBe("makeup_workday");
  });

  it("2027 single-day holidays", () => {
    expect(calendar.lookup("2027-06-09")).toMatchObject({ is_public_holiday: true, holiday_name: "端午节" });
    expect(kind("2027-06-10")).toBe("workday");
  });
});

describe("invalid input", () => {
  it.each([
    [undefined],
    [""],
    ["2026-2-14"],
    ["20260214"],
    ["2026/02/14"],
    ["2026-02-30"],
    ["2026-13-01"],
    ["2026-00-10"],
    ["2026-02-14T00:00:00Z"],
    [" 2026-02-14"],
    ["2026-02-14' OR 1=1"],
  ])("rejects %j with 400", (value) => {
    const e = inputError(() => calendar.lookup(value));
    expect(e.status).toBe(400);
    expect(e.code).toBe("invalid_date");
  });

  it("accepts a real leap day and rejects a fake one", () => {
    expect(kind("2024-02-29")).toBe("workday");
    expect(inputError(() => calendar.lookup("2026-02-29")).code).toBe("invalid_date");
  });

  it("dates outside covered years return 404 year_not_covered", () => {
    for (const d of ["2019-12-31", "2028-01-01", "1999-01-01"]) {
      const e = inputError(() => calendar.lookup(d));
      expect(e).toMatchObject({ status: 404, code: "year_not_covered" });
    }
    expect(kind("2020-01-01")).toBe("public_holiday");
    expect(kind("2027-12-31")).toBe("workday");
  });
});

describe("business days", () => {
  it("counts a range with holidays and makeup days", () => {
    // 2026-09-28..2026-10-11: Mon-Wed 3 workdays, Oct 1-7 holiday, Oct 8-9 workdays, Oct 10 (Sat) makeup, Oct 11 Sun.
    const r = calendar.businessDays("2026-09-28", "2026-10-11");
    expect(r.calendar_days).toBe(14);
    expect(r.workdays).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-08", "2026-10-09", "2026-10-10"]);
    expect(r.workday_count).toBe(6);
  });

  it("single-day range", () => {
    expect(calendar.businessDays("2026-02-14", "2026-02-14")).toMatchObject({ calendar_days: 1, workday_count: 1 });
    expect(calendar.businessDays("2026-02-15", "2026-02-15")).toMatchObject({ calendar_days: 1, workday_count: 0, workdays: [] });
  });

  it("crosses a year boundary", () => {
    // 2026-12-28 Mon .. 2027-01-05 Tue. 2027 元旦 Jan 1-3 off.
    const r = calendar.businessDays("2026-12-28", "2027-01-05");
    expect(r.workdays).toEqual(["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-04", "2027-01-05"]);
  });

  it("full year 2026 matches the weekday count adjusted by the notice", () => {
    const r = calendar.businessDays("2026-01-01", "2026-12-31");
    expect(r.calendar_days).toBe(365);
    // 261 Mon-Fri, minus 19 weekdays inside holiday periods (元旦2 春节6 清明1 劳动3 端午1 中秋1 国庆5), plus 6 makeup days.
    expect(r.workday_count).toBe(248);
  });

  it(`allows ${MAX_RANGE_DAYS} days inclusive and rejects ${MAX_RANGE_DAYS + 1}`, () => {
    expect(calendar.businessDays("2024-01-01", "2024-12-31").calendar_days).toBe(366);
    expect(inputError(() => calendar.businessDays("2026-01-01", "2027-01-02"))).toMatchObject({ code: "range_too_large", status: 400 });
  });

  it("rejects reversed, malformed and uncovered ranges", () => {
    expect(inputError(() => calendar.businessDays("2026-02-02", "2026-02-01")).code).toBe("invalid_range");
    expect(inputError(() => calendar.businessDays("2026-02-01", undefined)).code).toBe("invalid_date");
    expect(inputError(() => calendar.businessDays("2027-12-01", "2028-01-05"))).toMatchObject({ code: "year_not_covered", status: 404 });
  });
});

describe("HolidayCalendar construction", () => {
  it("refuses empty data and gaps between years", () => {
    expect(() => new HolidayCalendar([])).toThrow();
    const f = (year: number) => ({ year, source_url: "x", published: `${year - 1}-11-01`, holidays: [], makeup_workdays: [] });
    expect(() => new HolidayCalendar([f(2024), f(2026)])).toThrow(/contiguous/);
  });
});
