import { HolidayCalendar, type YearFile } from "./calendar.js";
import y2020 from "../data/cn-holidays/2020.json";
import y2021 from "../data/cn-holidays/2021.json";
import y2022 from "../data/cn-holidays/2022.json";
import y2023 from "../data/cn-holidays/2023.json";
import y2024 from "../data/cn-holidays/2024.json";
import y2025 from "../data/cn-holidays/2025.json";
import y2026 from "../data/cn-holidays/2026.json";
import y2027 from "../data/cn-holidays/2027.json";

// shortcut: year files are imported by hand so the bundle stays static; add one line per new
// year. test/data.test.ts fails if a file in data/cn-holidays/ is missing from this list.
export const YEAR_FILES: YearFile[] = [y2020, y2021, y2022, y2023, y2024, y2025, y2026, y2027];

export const calendar = new HolidayCalendar(YEAR_FILES);
