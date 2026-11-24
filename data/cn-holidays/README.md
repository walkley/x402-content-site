# Data contract: `data/cn-holidays/<year>.json`

One file per calendar year, named after the year. The API loads every year listed in `src/data.ts`; the years must be contiguous, and `test/data.test.ts` fails if a file here is not bundled.

```json
{
  "year": 2026,
  "source_url": "https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm",
  "published": "2025-11-04",
  "holidays": [{ "name": "春节", "start": "2026-02-15", "end": "2026-02-23" }],
  "makeup_workdays": ["2026-02-14", "2026-02-28"]
}
```

| Field | Meaning |
|---|---|
| `year` | The year the notice covers. Equals the file name. |
| `source_url` | The State Council (国务院办公厅) notice on www.gov.cn; for an amended year, the amending notice. |
| `published` | Date the `source_url` notice was signed (落款日期), `YYYY-MM-DD`. The newest value across files is shown as "data updated". |
| `holidays[]` | Official holiday periods (放假). `name` is copied from the notice heading. `start` and `end` are inclusive. A one-day holiday has `start == end`. A period may start in the previous year (2023 元旦 starts 2022-12-31) and stays in the file of the notice that announced it. |
| `makeup_workdays[]` | Weekend days the notice designates as working days (调休上班). Always a Saturday or Sunday, never inside a holiday period. |

No other fields. Dates are always zero-padded `YYYY-MM-DD`.

How the API classifies a date: inside a holiday period → `public_holiday`; else listed in `makeup_workdays` → `makeup_workday` (a working day); else Saturday/Sunday → `weekend`; else `workday`.

Each file records the schedule actually in force nationally. Normally that is the annual notice as published. When a later national notice changes it, the file applies the change and `source_url`/`published` point to the amending notice. So far this applies only to 2020: the Spring Festival extension (国办发明电〔2020〕1号) makes 2020-01-24..2020-02-02 the holiday and removes the 2020-02-01 makeup workday. Provincial schedules are not included. See `SOURCES.md` for sources, the verification run (`verify.py`, which applies the amendment explicitly) and details.
