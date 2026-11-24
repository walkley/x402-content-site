"""Self-check for data/cn-holidays/<year>.json.

For each year it fetches source_url from gov.cn, parses the notice text on its
own (independent of the hand-transcribed JSON), and checks:
  1. every holiday name/start/end and every makeup workday equals the notice;
  2. every makeup workday is a Saturday or Sunday;
  3. no makeup workday falls inside a holiday range;
  4. JSON keys are exactly the agreed schema;
  5. "共N天" in the notice equals end - start + 1 (when the notice states it).
Optional: --compare <dir> diffs against NateScarlet/holiday-cn files <dir>/<year>.json.

Usage: python3 verify.py [--compare DIR]   (exit code 1 on any failure)
"""
import datetime as dt
import glob
import html
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
NUM = "一二三四五六七八九十"
DATE_RE = re.compile(r"(?:(\d{4})年)?(?:(\d{1,2})月)?(\d{1,2})日")
DAYS_RE = re.compile(r"共(\d+)天")


def fetch_text(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    raw = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
    text = re.sub(r"<script.*?</script>|<style.*?</style>", "", raw, flags=re.S)
    text = html.unescape(re.sub(r"<[^>]+>", "", text))
    return re.sub(r"\s+", "", text)


def dates_in(s, year):
    out, y, m = [], year, None
    for yy, mm, dd in DATE_RE.findall(s):
        y = int(yy) if yy else y
        m = int(mm) if mm else m
        out.append(dt.date(y, m, int(dd)).isoformat())
    return out


def parse_notice(text, year):
    body = text[text.index("具体安排通知如下。") + len("具体安排通知如下。"):]
    body = body[: body.index("节假日期间")]
    # Section markers "一、" only at body start or after a full stop; "初七、周二" must not split.
    parts = re.split(rf"(?:^|。)[{NUM}]+、", body)[1:]
    hols, makeups = [], []
    for p in parts:
        name, rest = p.split("：", 1)
        sentences = [s for s in rest.split("。") if s]
        rng = dates_in(sentences[0].split("放假")[0], year)
        start, end = rng[0], rng[-1]
        m = DAYS_RE.search(sentences[0])
        hols.append({"name": name, "start": start, "end": end,
                     "days": int(m.group(1)) if m else None})
        for s in sentences[1:]:
            if s.endswith("上班"):
                makeups += dates_in(s, year)
    return hols, makeups


def check_year(path):
    errs = []
    d = json.load(open(path, encoding="utf-8"))
    year = d["year"]
    if list(d) != ["year", "source_url", "published", "holidays", "makeup_workdays"]:
        errs.append(f"top-level keys {list(d)}")
    for h in d["holidays"]:
        if list(h) != ["name", "start", "end"]:
            errs.append(f"holiday keys {list(h)}")
    if not d["source_url"].startswith("https://www.gov.cn/"):
        errs.append("source_url not on www.gov.cn")

    text = fetch_text(d["source_url"])
    if f"国务院办公厅关于{year}年部分节假日安排的通知" not in text:
        errs.append("notice title not found on page")
    pub = dt.date.fromisoformat(d["published"])
    if f"{pub.year}年{pub.month}月{pub.day}日" not in text:
        errs.append(f"published {d['published']} not in signature date")

    hols, makeups = parse_notice(text, year)
    got = [{"name": h["name"], "start": h["start"], "end": h["end"]} for h in hols]
    if got != d["holidays"]:
        errs.append(f"holidays differ:\n  notice={got}\n  json  ={d['holidays']}")
    if makeups != d["makeup_workdays"]:
        errs.append(f"makeup differ: notice={makeups} json={d['makeup_workdays']}")
    for h in hols:
        n = (dt.date.fromisoformat(h["end"]) - dt.date.fromisoformat(h["start"])).days + 1
        if h["days"] is not None and h["days"] != n:
            errs.append(f"{h['name']}: 共{h['days']}天 but range is {n} days")

    for w in d["makeup_workdays"]:
        wd = dt.date.fromisoformat(w).weekday()
        if wd < 5:
            errs.append(f"makeup {w} is weekday {wd}")
        for h in d["holidays"]:
            if h["start"] <= w <= h["end"]:
                errs.append(f"makeup {w} inside {h['name']}")
    return year, errs, len(d["holidays"]), len(d["makeup_workdays"])


def compare(path, other_dir):
    d = json.load(open(path, encoding="utf-8"))
    year = d["year"]
    f = os.path.join(other_dir, f"{year}.json")
    if not os.path.exists(f):
        return "no third-party file"
    o = json.load(open(f, encoding="utf-8"))
    off, work = set(), set(d["makeup_workdays"])
    for h in d["holidays"]:
        s, e = dt.date.fromisoformat(h["start"]), dt.date.fromisoformat(h["end"])
        while s <= e:
            off.add(s.isoformat())
            s += dt.timedelta(days=1)
    # holiday-cn lists every day; isOffDay=false means makeup workday.
    # Only compare days inside this calendar year's scope as listed by holiday-cn.
    o_off = {x["date"] for x in o["days"] if x["isOffDay"]}
    o_work = {x["date"] for x in o["days"] if not x["isOffDay"]}
    diffs = []
    for label, a, b in (("off", off, o_off), ("makeup", work, o_work)):
        if a - b:
            diffs.append(f"{label} only here: {sorted(a - b)}")
        if b - a:
            diffs.append(f"{label} only holiday-cn: {sorted(b - a)}")
    return "; ".join(diffs) or "identical"


def main():
    other = sys.argv[sys.argv.index("--compare") + 1] if "--compare" in sys.argv else None
    failed = False
    for path in sorted(glob.glob(os.path.join(HERE, "[0-9][0-9][0-9][0-9].json"))):
        year, errs, nh, nm = check_year(path)
        status = "PASS" if not errs else "FAIL"
        failed |= bool(errs)
        line = f"{year}: {status} ({nh} holidays, {nm} makeup workdays)"
        if other:
            line += f" | vs holiday-cn: {compare(path, other)}"
        print(line)
        for e in errs:
            print("   -", e)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
