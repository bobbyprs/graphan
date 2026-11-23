# Smart builder (database analyzer)

**Smart builder** in the sidebar (or **Dashboards → Generate from database**, **Reports → Generate from database**)
analyses a whole database and proposes dashboard panels and report items. No SQL is needed.

1. Pick a data source and, optionally, schemas. Leave Schemas empty to analyse all of them (up to 80 tables).
2. Click **Analyse database**. Everything is read-only: table metadata, `COUNT`/`MIN`/`MAX`, a 1,000-row sample per table,
   join-overlap checks and the candidate queries. This usually takes a few seconds, and results are cached for 15 minutes (**Refresh** forces a new run).
3. Tick the suggestions you want. The recommended set is pre-selected. Choose **Dashboard** or **Report**, a title and a filter, then click **Create**.

## What it does

| Step | How |
|---|---|
| Column profiling | Null %, unique %, min, max and mean per column, and a predicted role (primary key, foreign key, time, audit time, measure, dimension, flag, label, identifier, text) with a confidence and a reason. |
| Join detection | Declared foreign keys score 100. Other key-like columns are scored as **name similarity × 0.3 + data-type match × 0.2 + value overlap × 0.5**. Overlap is checked against the target table. Only joins above 80% are kept. |
| KPI detection | Revenue (amount, sales, price…), quantity, performance (duration, latency…), size and rate columns, row counts of event tables, and success rates of outcome columns (`result`, `status` with pass/fail-like values). Each KPI gets a relevance score. |
| Insights | Trend (robust linear fit, R²), latest-period growth, seasonality (autocorrelation), outlier periods (MAD z-score), top contributors (Pareto share) and correlated measures, plus data-quality findings. |
| Suggestions | KPI cards with sparklines, trends (with forecast and anomaly detection on dashboards), stacked trends, breakdowns by dimensions of joined tables (names instead of ids, up to 2 joins), pass/fail breakdowns, a cross-tab heatmap or matrix, correlations, and a detail table with looked-up names. Every suggestion's query is run once and shown as a live preview. Ones that fail or return nothing are dropped. |
| Quality score | Out of 100: coverage (KPI, trend, breakdown, detail), relevance, visual variety, combining related tables, interactivity (filter, time range, drill-down) and size. It includes tips for improving the selection. |

The filter variable (dashboard) or parameter (report) is applied to each panel that can reach the column. That means the panel already joins the column's table, or every join key on the path to it is ≥ 98% filled. This way "All" never drops rows. The builder says how many panels it applies to.

## Ask a question

After an analysis, type a question in plain words in the **Ask** box, for example:

- `failed flashes by ecu name last 30 days`
- `top 5 users by number of sessions`
- `average odometer by user`
- `unique vehicles per month`
- `orders for "North America" in 2025`

Graphan answers from the analysed model on its own server. Nothing is sent to an external AI service. The answer shows a live chart, chips with what it understood (table, measure, grouping, filters, period, order), any words it ignored, and the SQL. **Add to selection** puts the answer on the dashboard or report like any other suggestion.

| Part of the question | Understood as |
|---|---|
| Measure | `how many` / `number of` (count), `total` / `sum`, `average`, `max` / `min`, `unique` / `distinct` (count distinct), a measure column's name, a KPI's name, `success rate` / `failure rate` |
| Grouping | `by` / `per` / `for each` / `across`, with up to two groupings (two produce a cross-tab). Columns of joined tables are reached through up to 2 joins, so `by ecu` uses the ECU table's name column. |
| Time | `per day` / `week` / `month`, `over time`, `trend`; periods such as `last 30 days`, `this month`, `last year`, `in 2025`, `in March 2026`, `since 2025-01-01`, `between … and …` |
| Filters | `failed` / `unsuccessful` / `successful` (outcome columns), `where status is open`, `with region = north`, and plain values such as `for ABS` or `"Cluster - BSVI"`. Values are checked against the data. |
| Order | `top 10`, `bottom 5`, `most`, `least` |

On a dashboard, a relative period ("last 30 days") sets the dashboard's time range, so the panel keeps following the time picker. In a report it sets the default of the From parameter. Fixed periods ("in 2025") are written into the query. When a period has no rows, the answer says where the data ends.

When a word could mean several tables, the answer offers **Answer from another table**. When a word isn't understood, teach it once as a synonym (see below).

## Data model (corrections)

Wrong guesses can be fixed once per data source. Corrections are stored in the Graphan database and applied to every later analysis and question. They're shared by everyone in the workspace, changing them needs the Analyst role, and every save is audited.

| Where | What you can correct |
|---|---|
| **Tables & columns** → a table | Display name, synonyms (words people use for it, such as "flash" or "vehicle"), time column (or none), label column (the name shown instead of an id when other tables join to it), hide from analysis |
| **Tables & columns** → a column | Role (measure, dimension, time, key, …, or Automatic), display name, synonyms |
| **Joins** | Remove a wrong join (declared or inferred), or **Add join** for one that is missing. Manual joins count as 100%. |
| **KPIs** | Rename a KPI, or hide one that isn't a useful number |

Changes collect in a draft. **Save & re-analyse** stores them and runs the analysis again, and **Discard** drops them. The summary chip shows how many corrections the data model has.

## Join completion in the SQL editor

Each analysis remembers the joins it found, plus manual ones. In the Query tool and the dashboard panel editor, typing `JOIN ` offers the whole clause for tables related to those already in the query. For example, `FROM master.tblflashsessionlog fs LEFT JOIN ` offers `ecu.tblecumaster e ON e.id = fs.ecumaster_id`. Suggestions work in both directions (many-to-one and one-to-many) and show the join's source and confidence. Join completion appears after a data source has been analysed once.

Generated dashboards and reports are ordinary, editable ones: change queries, layout or parameters afterwards.
Reports go to the `/Generated` folder. They have a date range (defaulting to the data's first date through today), and they export and subscribe like any other report.

Needs the Analyst role or higher. MongoDB data sources are not supported.
