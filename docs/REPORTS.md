# Paginated reports (SSRS-style)

Graphan **Reports** are printable, parameterised reports: the equivalent of SQL Server Reporting
Services (SSRS) reports, next to the interactive dashboards. Open **Reports** in the sidebar.

## SSRS feature map

| SSRS | Graphan |
|---|---|
| Report Server catalog, folders | **Reports → Catalog**, folder paths like `/Finance/Monthly` |
| Report Builder / RDL | **Designer** (`/reports/:id/edit`) with Data · Layout · Page & settings · JSON (the JSON is the "RDL") |
| Data sources / datasets | Datasets: SQL on any connected data source (PostgreSQL, MySQL, SQL Server, Oracle, SQLite, MongoDB) |
| Calculated fields | Dataset → *Calculated fields* (`revenue - cost`, `round(x, 2)`, …) |
| Report parameters, multi-value, "Select all" | Parameters: string/integer/float/date/datetime/boolean, multi-value, required, hidden |
| Available values from query, cascading parameters | *Get values from a query*; queries may use earlier parameters (`WHERE category IN ${category}`) |
| Default values, "default from query" | Static defaults, date keywords (`today`, `today-7d`, `startOfMonth`, `startOfYear`, `endOfMonth`), "select all / first value" |
| Tablix: row groups, group header/footer, subtotals, grand total | **Table** item: up to 5 nested groups, header row, subtotal row, grand total, Sum/Avg/Min/Max/Count/CountDistinct/First/Last |
| Toggle visibility (expand/collapse) | Click a group header in the viewer (and Excel outline +/−); *Start collapsed* option |
| Interactive sort | Click a column header in the viewer (sorts within each group) |
| Page break between groups, repeat header rows | Group → *Page break between*; table → *Repeat header on each page* |
| HideDuplicates, conditional formatting (color expressions) | Column → *Hide repeated values*; *Conditional format* (`<`, `>=`, `contains`, … → text/fill colour, bold) |
| Matrix (cross-tab) | **Matrix** item: row groups × column group, aggregate, row/column totals |
| Charts | **Chart** item: column, bar, stacked, line, area, pie, donut; series split by a field; data labels |
| Textbox expressions | `{{Parameters.x}}`, `{{Globals.ReportName}}`, `{{Globals.ExecutionTime}}`, `{{User.Name}}`, `{{Sum(ds.field, C2)}}` |
| Format strings | `N0` `N2` `C2` `P1` `F2` `D` `DT` `T` or date patterns like `dd-MMM-yyyy HH:mm` |
| KPIs / indicators | **KPI cards** with expressions and colours |
| Images / logo | **Image** item (uploaded, stored in the report, no remote URLs) |
| Subreports | **Subreport** item: renders another report inline with mapped parameters (max 3 levels) |
| Drill-through actions | Column → *Drill-through*: opens a target report with `param=field`, `@param` (pass this report's parameter) or `=literal`; Back returns to the parent |
| Page setup, header/footer, page numbers | A3/A4/A5/Letter/Legal, portrait/landscape, margins; 3-part header/footer with `{{Globals.PageNumber}}` / `{{Globals.TotalPages}}` |
| Report viewer toolbar | View Report, Refresh, Export, **Print layout** (paginated PDF with page navigation/print), zoom, copy link |
| Rendering extensions | **PDF, Excel (.xlsx, grouped outline, real numbers), Word (.docx), CSV, HTML (web archive), JSON** |
| URL access (`rs:Format`, parameters in URL) | `/reports/:id?p.region=North&p.region=South` · API `GET /api/reports/:id/export?format=PDF&p.region=North` |
| Standard subscriptions | **Subscribe**: schedule (hourly/daily/weekly/monthly/cron + time zone), format, To/Cc, subject, comment, link, "skip when no data" |
| E-mail with report in body (MHTML) | Format **HTML**: rendered in the e-mail body, charts as inline images |
| Data-driven subscriptions | Developer/Admin: a query returns one row per recipient with e-mail, optional CC/format, and parameter values |
| "Use default" for subscription parameters | Per-parameter switch, so rolling dates (`today-7d`) keep moving |
| Report history / snapshots | Camera button or subscription delivery *Save to report history*; snapshots keep the data as of that time (retention per report) |
| Execution log | **Reports → Execution log** (Developer/Admin): every view/export/subscription with duration, rows, cache hit, errors (90 days) |
| Caching | Report setting *Cache results (minutes)* per parameter combination |
| Item-level security | Viewer+ can view/export; Analyst+ creates reports and subscriptions; owner or Developer/Admin edits; data-driven subscriptions need Developer+ |
| ReportViewer control embedding | Signed embedding: `/embed/report/<token>` with locked (hidden) parameters (see [EMBEDDING.md](EMBEDDING.md)) |

Not included (yet): free-form pixel layout (absolute positioning of text boxes on the page), maps,
gauges/sparklines inside table cells, document map, and file-share delivery.

## Quick start

1. **Reports → New report → Sales report pack** (choose *Sample Sales DB*). This creates *Sales Performance*
   and its drill-through report *Order Details* in `/Sales`.
2. Change the parameters and click **View Report**. Click a product to drill through; use **Print layout** to
   see pages; **Export** to PDF, Excel or Word.
3. **Subscribe** to receive it by e-mail every Monday at 08:00 (needs SMTP, see below).

## Building a report

1. **New report → Blank** opens the designer.
2. **Data** tab: add a dataset (data source + SQL). Use parameters as `${name}`; multi-value parameters
   work with `IN ${name}`. Values are always sent as bound parameters (no SQL injection).
3. **Data** tab: add parameters (prompt, type, available values, default).
4. **Layout** tab: Insert a Table, Matrix, Chart, KPI cards, Text, Image, Subreport, Line or Page break.
   Click **Preview** to fill in the field pickers.
5. **Page & settings**: paper, orientation, margins, header/footer, currency/locale/time zone, caching,
   snapshot retention, embedding.
6. **Save**. Versions are checked, so two people saving at once get a conflict message instead of
   overwriting each other.

Reports can be moved between Graphan servers with **⋮ → Download definition (.json)** and **Import**.
The data source IDs in the file must exist on the target server; edit them in the designer's JSON tab.

## E-mail delivery

Subscriptions send e-mail through the server's SMTP settings (`.env`):

```
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_USER=reports@yourcompany.com
SMTP_PASSWORD=...
SMTP_FROM="Graphan Reports <reports@yourcompany.com>"
APP_PUBLIC_URL=https://graphan.yourcompany.com   # used for links in e-mails and drill-through in Excel
```

Without SMTP, e-mail subscriptions fail with *"SMTP is not configured"* (visible in the subscription's
delivery history). *Save to report history* subscriptions work without SMTP.

Schedules run on one API replica at a time (the scheduler leader), in the subscription's time zone.
