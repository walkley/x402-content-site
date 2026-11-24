// Pure date logic for the China statutory holiday / makeup-workday calendar.
// Data files follow the contract documented in data/cn-holidays/README.md.

export interface HolidayRange {
  name: string;
  start: string; // YYYY-MM-DD, inclusive
  end: string; // YYYY-MM-DD, inclusive
}

export interface YearFile {
  year: number;
  source_url: string;
  published: string; // YYYY-MM-DD
  holidays: HolidayRange[];
  makeup_workdays: string[];
}

export type DayKind = "workday" | "weekend" | "public_holiday" | "makeup_workday";

export interface DayInfo {
  date: string;
  weekday: number; // ISO weekday, 1 = Monday ... 7 = Sunday
  is_workday: boolean;
  is_public_holiday: boolean;
  is_makeup_workday: boolean;
  holiday_name: string | null;
  kind: DayKind;
  source_url: string;
}

export class InputError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
export const MAX_RANGE_DAYS = 366;

/** Parse a strict YYYY-MM-DD calendar date into a UTC day number. */
export function parseDate(value: unknown, field = "date"): number {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new InputError("invalid_date", `${field} must be a date in YYYY-MM-DD format`);
  }
  const [, y, m, d] = DATE_RE.exec(value)!;
  const ms = Date.UTC(Number(y), Number(m) - 1, Number(d));
  // Reject roll-over dates such as 2026-02-30 or 2026-13-01.
  if (formatDay(ms / DAY_MS) !== value) {
    throw new InputError("invalid_date", `${field} is not a valid calendar date: ${value}`);
  }
  return ms / DAY_MS;
}

export function formatDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function isoWeekday(day: number): number {
  const w = new Date(day * DAY_MS).getUTCDay(); // 0 = Sunday
  return w === 0 ? 7 : w;
}

export class HolidayCalendar {
  private readonly holidayByDate = new Map<string, { name: string; source: string }>();
  private readonly makeupByDate = new Map<string, string>();
  private readonly sourceByYear = new Map<number, string>();
  readonly years: number[];
  readonly dataUpdated: string;

  constructor(files: YearFile[]) {
    if (files.length === 0) throw new Error("no holiday data files");
    for (const f of files) {
      this.sourceByYear.set(f.year, f.source_url);
      for (const h of f.holidays) {
        // A range may cross a year boundary (2023 元旦 starts 2022-12-31), so index by date.
        for (let d = parseDate(h.start); d <= parseDate(h.end); d++) {
          this.holidayByDate.set(formatDay(d), { name: h.name, source: f.source_url });
        }
      }
      for (const m of f.makeup_workdays) {
        this.makeupByDate.set(formatDay(parseDate(m)), f.source_url);
      }
    }
    this.years = [...this.sourceByYear.keys()].sort((a, b) => a - b);
    this.dataUpdated = files.map((f) => f.published).sort().at(-1)!;
    for (let i = 1; i < this.years.length; i++) {
      if (this.years[i] !== this.years[i - 1] + 1) throw new Error("holiday data years must be contiguous");
    }
  }

  get sources(): { year: number; source_url: string }[] {
    return this.years.map((year) => ({ year, source_url: this.sourceByYear.get(year)! }));
  }

  get firstDate(): string {
    return `${this.years[0]}-01-01`;
  }

  get lastDate(): string {
    return `${this.years.at(-1)}-12-31`;
  }

  private assertCovered(day: number, field: string): void {
    const year = new Date(day * DAY_MS).getUTCFullYear();
    if (!this.sourceByYear.has(year)) {
      throw new InputError(
        "year_not_covered",
        `${field} ${formatDay(day)} is outside the covered range ${this.firstDate}..${this.lastDate}`,
        404,
      );
    }
  }

  private infoForDay(day: number): DayInfo {
    const date = formatDay(day);
    const weekday = isoWeekday(day);
    const holiday = this.holidayByDate.get(date);
    const makeupSource = this.makeupByDate.get(date);
    const year = new Date(day * DAY_MS).getUTCFullYear();
    let kind: DayKind;
    if (holiday) kind = "public_holiday";
    else if (makeupSource) kind = "makeup_workday";
    else kind = weekday >= 6 ? "weekend" : "workday";
    return {
      date,
      weekday,
      is_workday: kind === "workday" || kind === "makeup_workday",
      is_public_holiday: kind === "public_holiday",
      is_makeup_workday: kind === "makeup_workday",
      holiday_name: holiday?.name ?? null,
      kind,
      source_url: holiday?.source ?? makeupSource ?? this.sourceByYear.get(year)!,
    };
  }

  /** Validate a single date and return its classification. Throws InputError. */
  lookup(date: unknown): DayInfo {
    const day = parseDate(date);
    this.assertCovered(day, "date");
    return this.infoForDay(day);
  }

  /** Validate a range without computing it (used before charging). Throws InputError. */
  validateRange(from: unknown, to: unknown): { start: number; end: number } {
    const start = parseDate(from, "from");
    const end = parseDate(to, "to");
    if (end < start) throw new InputError("invalid_range", "to must be on or after from");
    const days = end - start + 1;
    if (days > MAX_RANGE_DAYS) {
      throw new InputError("range_too_large", `range is ${days} days; maximum is ${MAX_RANGE_DAYS} days inclusive`);
    }
    this.assertCovered(start, "from");
    this.assertCovered(end, "to");
    return { start, end };
  }

  businessDays(from: unknown, to: unknown) {
    const { start, end } = this.validateRange(from, to);
    const workdays: string[] = [];
    for (let d = start; d <= end; d++) {
      if (this.infoForDay(d).is_workday) workdays.push(formatDay(d));
    }
    return {
      from: formatDay(start),
      to: formatDay(end),
      calendar_days: end - start + 1,
      workday_count: workdays.length,
      workdays,
    };
  }
}
