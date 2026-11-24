# 中国法定节假日与调休补班数据来源

数据范围 2020 至 2027 年，每年一个 `<year>.json`。2027 年通知已于 2026-11-05 发布，已收录。所有日期均取自中国政府网（www.gov.cn）上国务院办公厅的节假日通知原文：每年以年度安排通知为准，被后续全国性通知修改的年份（目前只有 2020 年）按修改后的实际执行情况记录。第三方数据只用于交叉比对，没有作为来源。核对日期：2026-11-24。

## 各年通知

| 年份 | 通知标题（文号） | 原文链接 | 发布日期 |
|---|---|---|---|
| 2020 | 国务院办公厅关于2020年部分节假日安排的通知（国办发明电〔2019〕16号），经国务院办公厅关于延长2020年春节假期的通知（国办发明电〔2020〕1号）修改 | [年度通知](https://www.gov.cn/zhengce/content/2019-11/21/content_5454164.htm)、[延长通知](https://www.gov.cn/zhengce/content/2020-01/27/content_5472352.htm) | 2019-11-21；延长通知 2020-01-26 |
| 2021 | 国务院办公厅关于2021年部分节假日安排的通知（国办发明电〔2020〕27号） | [gov.cn](https://www.gov.cn/zhengce/content/2020-11/25/content_5564127.htm) | 2020-11-25 |
| 2022 | 国务院办公厅关于2022年部分节假日安排的通知（国办发明电〔2021〕11号） | [gov.cn](https://www.gov.cn/zhengce/content/2021-10/25/content_5644835.htm) | 2021-10-25 |
| 2023 | 国务院办公厅关于2023年部分节假日安排的通知（国办发明电〔2022〕16号） | [gov.cn](https://www.gov.cn/zhengce/content/2022-12/08/content_5730844.htm) | 2022-12-08 |
| 2024 | 国务院办公厅关于2024年部分节假日安排的通知（国办发明电〔2023〕7号） | [gov.cn](https://www.gov.cn/zhengce/content/202310/content_6911527.htm) | 2023-10-25 |
| 2025 | 国务院办公厅关于2025年部分节假日安排的通知（国办发明电〔2024〕12号） | [gov.cn](https://www.gov.cn/zhengce/content/202411/content_6986382.htm) | 2024-11-12 |
| 2026 | 国务院办公厅关于2026年部分节假日安排的通知（国办发明电〔2025〕7号） | [gov.cn](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm) | 2025-11-04 |
| 2027 | 国务院办公厅关于2027年部分节假日安排的通知（国办发明电〔2026〕10号） | [gov.cn](https://www.gov.cn/zhengce/zhengceku/202611/content_7085102.htm) | 2026-11-05 |

发布日期取通知落款日期。2026、2027 年的链接通过 gov.cn 站内搜索接口（sousuo.www.gov.cn，按标题检索）找到，其余年份为 gov.cn 原有链接，均已逐页打开确认标题和正文。

## 核对方式

1. 逐年打开 gov.cn 原文，手工把每一条“X月X日至X日放假”和“X月X日（星期X）上班”转写成 JSON。
2. 用 `verify.py` 自检。脚本重新抓取每个 `source_url`，独立解析通知正文（按“一、二、……”分节，取首句“放假”之前的日期作为区间，取以“上班”结尾的句子中的日期作为补班日），再与 JSON 逐项比较。具体检查：
   - 每个假日的 name/start/end 和每个补班日与原文解析结果完全一致，顺序也一致；
   - 页面含该年通知标题，落款日期等于 `published`；
   - 原文写了“共N天”的，区间天数等于 N；
   - 补班日都是周六或周日；
   - 补班日不落在任何假日区间内；
   - JSON 只有约定字段，没有多余字段。
3. 为确认脚本能发现错误，做过一次变异测试：把 2026 年春节结束日改成 02-22 并加一个补班日 02-16（周一，春节期间），脚本报出 4 条错误并以退出码 1 结束。
4. 与第三方数据 [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn)（GitHub raw JSON）比对：把本数据的假日区间展开成逐日放假集合，和它的 `isOffDay` 逐日比较。

## 自检结果

运行命令：`python3 verify.py --compare /tmp/hc`（/tmp/hc 为下载的 holiday-cn 各年文件），2026-11-24 运行，退出码 0。

```
2020: PASS (6 holidays, 6 makeup workdays) | vs holiday-cn: makeup only holiday-cn: ['2020-02-03']
2021: PASS (7 holidays, 7 makeup workdays) | vs holiday-cn: identical
2022: PASS (7 holidays, 7 makeup workdays) | vs holiday-cn: identical
2023: PASS (6 holidays, 7 makeup workdays) | vs holiday-cn: identical
2024: PASS (7 holidays, 8 makeup workdays) | vs holiday-cn: identical
2025: PASS (6 holidays, 5 makeup workdays) | vs holiday-cn: identical
2026: PASS (7 holidays, 6 makeup workdays) | vs holiday-cn: identical
2027: PASS (7 holidays, 5 makeup workdays) | vs holiday-cn: identical
```

## 2020 年：按延长通知后的实际执行记录

2020 年春节假期后来被另一份全国性通知延长。[国务院办公厅关于延长2020年春节假期的通知](https://www.gov.cn/zhengce/content/2020-01/27/content_5472352.htm)（国办发明电〔2020〕1号，2020-01-26 落款）写明“延长2020年春节假期至2月2日（农历正月初九，星期日），2月3日（星期一）起正常上班”。

API 卖的是“这天上不上班”，所以 `2020.json` 按实际执行记录（2026-11-24 按评审意见修改）：

- 春节为 2020-01-24 至 2020-02-02；
- 删去原补班日 2020-02-01（周六），延长后这天不再上班；
- `source_url` 指向延长通知，`published` 为其落款日期 2020-01-26。其余假日和补班日不变，仍以年度通知为准。

`verify.py` 对 2020 年先解析年度通知，再套用延长通知的改动（`AMENDMENTS`），同时检查延长通知页面含上面引用的原句和落款日期。年度通知原文写的“共10天”指原区间，延长后不再比对天数。变异测试：把春节结束日改回 02-01，脚本报错并以退出码 1 结束。

与 [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn) 比对后只剩一处表面差异：holiday-cn 把 2020-02-03（周一）列成 `isOffDay=false` 的“上班日”。它本来就是普通工作日，本数据和 API 也判为上班，结论一致。

部分省份（如湖北、上海）当时另有更长的地方性延期，本数据只记录全国性通知，不含地方安排。

## 字段约定说明

- `name` 照抄通知小标题。合并放假的年份保留原文写法：2020、2025 年为“国庆节、中秋节”，2023 年为“中秋节、国庆节”。
- 原文只写一天的假日，start 与 end 相同。例如 2024 年元旦写“1月1日放假，与周末连休”、端午节写“6月10日放假，与周末连休”，只记录原文写明的这一天，不把相邻周末并入区间。
- 2023 年元旦区间跨年（2022-12-31 至 2023-01-02），按原文记在 2023 年文件中。
- 2024 年通知中“鼓励……安排职工在除夕（2月9日）休息”不是法定放假，没有记入。
