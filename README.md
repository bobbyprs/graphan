# Graphan

A Grafana-style analytics platform: connect PostgreSQL, MySQL, SQL Server, Oracle, MongoDB and SQLite, explore schemas, write SQL in Monaco, and build drag-and-drop dashboards with live refresh, drill-down, alerting and role-based access control.

| Area | Highlights |
|---|---|
| **Data sources** | 6 engines, pooled connections, AES-256-GCM encrypted credentials, 30 s health checks pushed live over WebSocket, read-only enforcement |
| **Explorer** | Schemas → tables / views / procedures / functions; columns, indexes, FKs (both directions), row counts & size; paginated data preview; table + column search |
| **SQL editor** | Monaco with schema-aware completion, macros & variables, Ctrl/⌘+Enter (runs selection), execution time, history, saved/favourite queries, CSV / Excel / JSON export |
| **Dashboards** | 24-column drag & resize grid, 12 visualisations, templates, variables, drill-down, versions + restore, optimistic locking, sharing (users / teams / public link) |
| **Visualisations** | Line, Bar, Area, Pie/Donut, Scatter, Heat map, Gauge, KPI (+sparkline), Data table (AG Grid), Tree map, Geo map, Markdown text |
| **Analytics** | `$__timeFilter` / `$__timeGroup` time-series macros, auto-interval, calculated metrics (safe expression engine), group-by aggregations, live & scheduled refresh |
| **Alerting** | Threshold rules with reducers, pending period, no-data handling; email + Microsoft Teams; history & acknowledgement |
| **Security** | JWT (15 min) + rotating httpOnly refresh tokens with reuse detection, account lockout, RBAC (Admin / Developer / Analyst / Viewer), audit log, Helmet, rate limits, parameter binding everywhere |

![stack](https://img.shields.io/badge/stack-React%2018%20·%20MUI%206%20·%20TanStack%20Query%20·%20ECharts%20·%20AG%20Grid%20·%20Express%20·%20Prisma%20·%20Socket.IO-informational)

---

## Quick start (Docker)

```bash
cp .env.example .env
# generate real secrets:
node -e "c=require('crypto');console.log('JWT_ACCESS_SECRET='+c.randomBytes(48).toString('base64url'));console.log('JWT_REFRESH_SECRET='+c.randomBytes(48).toString('base64url'));console.log('CREDENTIALS_ENCRYPTION_KEY='+c.randomBytes(32).toString('base64'))"
# paste them into .env, then:
docker compose up -d --build
```

Open **http://localhost:8080** and sign in with `admin@graphan.local` / `Admin@12345` (change via `SEED_ADMIN_*`).

The stack includes a **sample database** (60k orders, 2k customers, 14 days of per-minute server metrics) and two seeded dashboards — *Sales Overview* and *Operations Monitor* — that exercise every chart type, variables, drill-down and calculated fields. Demo users: `developer@` / `analyst@` / `viewer@graphan.local`, password `Demo@123456`.

## Local development

Requirements: Node 20+, PostgreSQL 14+ (or just the compose databases).

```bash
docker compose up -d db sample-db         # metadata DB on :5432, sample data on :5433
cp .env.example .env                       # fill in secrets (see above)
npm install
npm run db:migrate                         # prisma migrate dev
npm run db:seed
npm run dev                                # API :4000 + web :5173 (Vite proxies /api and /ws)
```

| Command | What it does |
|---|---|
| `npm run dev` | API (tsx watch) and web (Vite) together |
| `npm run typecheck` | Type-check both apps |
| `npm test -w apps/server` | Unit tests (SQL guard, expression engine, macros, time parsing) |
| `npm run build` | Production builds (`apps/server/dist`, `apps/web/dist`) |

## Repository layout

```
graphan/
├─ apps/
│  ├─ server/                     Express + TypeScript API
│  │  ├─ prisma/                  schema.prisma, migrations/, seed.ts
│  │  └─ src/
│  │     ├─ config/               zod-validated environment
│  │     ├─ connectors/           one adapter per engine + pool manager, SQL guard, macro builder
│  │     ├─ lib/                  crypto, jwt, rbac, errors, time, logger, prisma
│  │     ├─ middleware/           authenticate, workspace resolution, permission guard, validation, errors
│  │     ├─ modules/              auth · users · workspaces · datasources · explorer · queries ·
│  │     │                        dashboards · alerts · audit   (routes → service → repository)
│  │     ├─ realtime/             Socket.IO gateway (rooms per workspace / dashboard / user)
│  │     └─ jobs/                 scheduler with Postgres advisory-lock leader election
│  └─ web/                        React + Vite SPA
│     └─ src/
│        ├─ api/                  axios client (token refresh), TanStack Query hooks, socket
│        ├─ auth/                 AuthContext, permission helpers
│        ├─ layouts/              AppShell (left nav, workspace switcher, theme)
│        ├─ components/           common/ · dashboard/ · explorer/ · viz/
│        ├─ pages/                Dashboards, Dashboard, Explore, DataSources, Alerts, Admin, Login
│        └─ theme/                Grafana-inspired dark/light themes
├─ deploy/
│  ├─ k8s/                        namespace, config/secret, postgres, migrate Job, api (HPA/PDB), web, ingress, network policies
│  └─ sample-data/init.sql        sample sales + metrics database
├─ docs/                          ARCHITECTURE.md · API.md · DEPLOYMENT.md
└─ docker-compose.yml
```

## Writing queries

```sql
SELECT $__timeGroup(o.created_at, auto) AS time,   -- dialect-specific bucketing
       SUM(o.amount)                    AS revenue
FROM orders o JOIN regions r ON r.id = o.region_id
WHERE $__timeFilter(o.created_at)                  -- BETWEEN bound params from the time picker
  AND r.name IN ${region}                          -- multi-value variable → (p1, p2, …)
GROUP BY 1 ORDER BY 1
```

All macro and variable values are sent as **bound parameters** — never concatenated into SQL. MongoDB queries are JSON: `{"collection":"orders","aggregate":[{"$match":{"ts":{"$gte":"$__timeFrom"}}}]}`.

Calculated metrics use a sandboxed expression language (no `eval`): `round(revenue / orders, 2)`, `pct(errors, total)`, `if(cpu > 90, 1, 0)`, `[unit price] * qty`.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design, auth flow, RBAC matrix, database schema, component architecture, security model
- [docs/API.md](docs/API.md) — REST + WebSocket reference
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Docker, Kubernetes, scaling, operations
