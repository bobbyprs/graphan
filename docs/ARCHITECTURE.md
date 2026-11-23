# Architecture

## 1. System overview

```
                    ┌──────────────────────── Browser (React SPA) ───────────────────────┐
                    │ TanStack Query cache · Socket.IO client · Monaco · ECharts · AG Grid │
                    └──────────────┬──────────────────────────────────┬──────────────────┘
                         HTTPS /api│ (JWT bearer + X-Workspace-Id)    │ WSS /ws (JWT in handshake)
                    ┌──────────────▼──────────────────────────────────▼──────────────────┐
                    │                    API service (Node 22 / Express)                  │
                    │  middleware: helmet · cors · rate-limit · authenticate ·            │
                    │              resolveWorkspace · requirePermission · zod validate    │
                    │  modules:    routes → service → repository (Prisma)                 │
                    │  connectors: pool manager ─▶ pg | mysql2 | mssql | oracledb |        │
                    │              mongodb | better-sqlite3                                │
                    │  realtime:   Socket.IO rooms (ws:<id>, dash:<id>, user:<id>)          │
                    │  jobs:       scheduler (leader via pg_try_advisory_lock)             │
                    └───────┬───────────────────────────────────────────┬────────────────┘
                            │ Prisma                                     │ pooled drivers
                  ┌─────────▼─────────┐                    ┌─────────────▼───────────────┐
                  │ PostgreSQL         │                    │ Customer databases          │
                  │ (app metadata)     │                    │ PG · MySQL · MSSQL · Oracle │
                  └────────────────────┘                    │ MongoDB · SQLite            │
                                                            └─────────────────────────────┘
```

### Microservice-ready modularity
Each folder under `apps/server/src/modules` is a bounded context with its own routes, service and (for core aggregates) repository. Modules talk to each other only through service functions, never through another module's repository. That makes the natural split points obvious:

| Candidate service | Modules | Notes |
|---|---|---|
| Identity | auth, users, workspaces, audit | JWT issuer; others only verify tokens |
| Query gateway | connectors, explorer, queries | Holds DB pools; horizontally scalable, CPU/IO heavy |
| Dashboards | dashboards | Calls the query gateway for panel data |
| Alerting | alerts, jobs | Singleton worker (already leader-elected) |

`ENABLE_SCHEDULER=false` already lets you run API-only replicas and a separate worker deployment from the same image.

## 2. Request lifecycle

1. `authenticate` verifies the access JWT (HS256, issuer + audience checked) → `req.user`.
2. `resolveWorkspace` reads `X-Workspace-Id`, loads the membership → `req.workspace = { id, role }` (super admins are ADMIN everywhere).
3. `requirePermission(...)` checks the role's permission set.
4. `validate(schema)` parses body/query with zod (unknown keys stripped).
5. Service executes; every entity lookup is scoped by `workspaceId` (no IDOR across workspaces).
6. `audit()` writes an audit row asynchronously (never fails the request).
7. Errors are normalised to `{ error: { code, message, details? } }`.

## 3. Authentication flow

```
Login ─────────────────────────────────────────────────────────────────────────────
 POST /api/auth/login {email,password}
   ├─ bcrypt(12) compare (constant-time dummy hash for unknown users)
   ├─ 5 failures → 15 min lock
   ├─ access token  (JWT, 15 min, in memory only on the client)
   └─ refresh token (256-bit random, sha256-hashed in DB, httpOnly+SameSite=Strict cookie, path=/api/auth)

Refresh (on 401 or page load) ─────────────────────────────────────────────────────
 POST /api/auth/refresh  (cookie)
   ├─ token found & not revoked → revoke it, issue new pair in the same "family"
   └─ token already revoked     → REUSE DETECTED → revoke whole family, 401

Logout / password change / user disabled → all refresh tokens revoked.
WebSocket handshake carries the access token; reconnects pick up the rotated token.
```

The SPA keeps the access token in a module variable (not `localStorage`), so XSS cannot exfiltrate a long-lived credential; the refresh cookie is not readable by JS.

## 4. Authorisation (RBAC)

Workspace roles (hierarchical):

| Permission | Viewer | Analyst | Developer | Admin |
|---|:-:|:-:|:-:|:-:|
| View dashboards / alerts / data source list | ✔ | ✔ | ✔ | ✔ |
| Explore schemas, run read queries, export | | ✔ | ✔ | ✔ |
| Create dashboards, acknowledge alerts | | ✔ | ✔ | ✔ |
| Manage data sources & alert rules | | | ✔ | ✔ |
| Run write statements (on non-read-only sources) | | | ✔ | ✔ |
| Edit any dashboard | | | ✔ | ✔ |
| Members, roles, teams, audit log | | | | ✔ |

Dashboard-level ACL layers on top: effective level = max(owner → ADMIN, role baseline, explicit user/team grants). Non-private dashboards give every member VIEW; private ones only owner, grants and Developer/Admin.

**Viewers never submit SQL.** Panel data is fetched via `POST /dashboards/:id/panels/:panelId/data`, which executes the *saved* query with only parameters supplied by the client. Unsaved panels in edit mode go through `/queries/execute`, which requires `query:execute`.

## 5. Query execution pipeline

```
SQL text ─▶ guard ─▶ macro/variable expansion ─▶ driver ─▶ normalise ─▶ transforms ─▶ cache ─▶ client
            │        (bound params, dialect          (row cap,     (BigInt/Date/   (filter → calc
            │         placeholders $1 ? @p1 :1)       timeout,      Buffer → JSON)   → group → sort
            │                                         read-only tx)                  → limit)
            └─ read-only sources / non-write roles: single statement, SELECT/WITH/SHOW/EXPLAIN only,
               rejects data-modifying CTEs, SELECT INTO, FOR UPDATE, multi-statements
```

Defence in depth for read-only sources:
1. Statement classifier (comment/literal-aware) — `connectors/sql-guard.ts`.
2. Database-level read-only transaction where supported (PG `BEGIN READ ONLY`, MySQL `START TRANSACTION READ ONLY`, Oracle `SET TRANSACTION READ ONLY`, MSSQL rollback-wrapped + `ApplicationIntent=ReadOnly`, SQLite opened read-only).
3. Recommended: a read-only DB account (the sample DB uses `default_transaction_read_only=on`).

Row caps: PG/MySQL wrap SELECTs in `LIMIT n+1`; MSSQL uses `SET ROWCOUNT`; Oracle `maxRows`; SQLite/Mongo stop iterating. `truncated: true` is returned when the cap is hit.

## 6. Database schema (application metadata)

```
User ─┬─< WorkspaceMember >─ Workspace ─┬─< Team ─< TeamMember >─ User
      ├─< RefreshToken                  ├─< DataSource ─┬─< SavedQuery
      ├─< QueryHistory >────────────────┤               ├─< QueryHistory
      └─< AuditLog >────────────────────┤               └─< AlertRule ─┬─< AlertEvent
                                        ├─< Folder ─< Dashboard        └─< AlertRuleChannel >─ NotificationChannel
                                        ├─< Dashboard ─┬─< DashboardVersion
                                        │              └─< DashboardPermission (user | team, VIEW/EDIT/ADMIN)
                                        └─< NotificationChannel
```

Key decisions:
- **Dashboard definition is a JSON document** (panels, layout, variables, time) validated by zod (`dashboard.schema.ts`). One write = one atomic version; every save creates a `DashboardVersion`; `version` column gives optimistic concurrency (409 on conflict).
- **Secrets** (`DataSource.encryptedSecrets`, Teams webhook URLs) are AES-256-GCM envelopes `v1.<iv>.<tag>.<ct>`; the version prefix allows key rotation.
- **Indexes** on hot paths: query history by user/time, audit by workspace/time, alert rules by `(enabled, lastEvaluatedAt)`, events by rule/time.

Full definition: [`apps/server/prisma/schema.prisma`](../apps/server/prisma/schema.prisma).

## 7. Real-time & scheduling

| Event (Socket.IO) | Room | Emitted by |
|---|---|---|
| `datasource:status` | `ws:<workspace>` | health monitor (every 30 s) |
| `dashboard:refresh` | `dash:<dashboard>` | live-refresh ticker (only for dashboards with viewers) and scheduled cache warm-ups |
| `dashboard:updated` | `dash:<dashboard>` | dashboard save (other editors are warned) |
| `alert:state` | `ws:<workspace>` | alert evaluator on state transitions |

Jobs (leader only): health checks (30 s), alert evaluation (10 s tick, per-rule interval), dashboard cron warm-ups (reconciled every minute), cleanup of expired tokens and 90-day query history (hourly). Leadership = session-level `pg_try_advisory_lock` on a dedicated connection; losing the connection steps down immediately.

Clients also poll at the dashboard refresh interval, so live updates degrade gracefully if the socket is down.

## 8. Frontend component architecture

```
main.tsx
└─ QueryClientProvider → ThemeModeProvider → AuthProvider → App (router, lazy routes)
   ├─ LoginPage
   ├─ PublicDashboard ─▶ DashboardPage(publicToken)
   └─ AppShell (left nav · workspace switcher · theme toggle · alert toasts)
      ├─ DashboardsPage ─ NewDashboardDialog (templates)
      ├─ DashboardPage
      │   ├─ TimeRangePicker · RefreshPicker · VariablesBar
      │   ├─ DashboardGrid (react-grid-layout, 24 cols, responsive)
      │   │   └─ PanelFrame (usePanelData, menu, CSV export)
      │   │       └─ PanelRenderer ─▶ echartsOptions builders | KpiPanel | ResultsGrid | GeoMapPanel | Markdown
      │   ├─ PanelEditor (Monaco query · transforms · viz options · thresholds · drill-down · live preview)
      │   └─ DashboardSettingsDialog (general · variables · permissions · sharing · versions)
      ├─ ExplorePage ─ SchemaTree · TableDetailsPanel · SqlEditor · ResultsGrid · history/saved drawer
      ├─ DataSourcesPage ─ DataSourceDialog (test connection, advanced pool/TLS options)
      ├─ AlertsPage ─ RuleDialog (dry-run test) · ChannelDialog · history/ack
      └─ AdminPage ─ Members & roles · Teams · Audit log
```

State: server state lives in TanStack Query (keys prefixed by workspace id so switching workspaces never shows stale data); dashboard time range, refresh and variables are URL-synced (`?from=now-7d&var-region=EU`) so links are shareable; edit-mode drafts are local component state until saved.

Performance: route-level code splitting; Monaco trimmed to SQL+JSON and lazy; AG Grid virtualisation; `keepPreviousData` avoids chart flicker; server-side LRU panel cache keyed by dashboard version + parameters; explorer metadata cached 60 s.

## 9. Security checklist

- Parameter binding for all user values; identifiers quoted per dialect.
- Credentials encrypted at rest, never returned (`hasPassword` flag only); redacted from logs.
- SQLite paths confined to `SQLITE_BASE_DIR`; Teams webhooks restricted to Microsoft hosts (SSRF), `redirect: 'error'`.
- CSV export neutralises spreadsheet formula injection.
- Helmet headers + strict CSP in nginx; CORS allow-list; rate limits (global, login, public links).
- Containers run non-root with read-only root FS; K8s restricted PSS, NetworkPolicies.
- Audit log for logins, failed logins, data source/dashboard/alert/member changes, exports.

**Known trade-offs / next steps**
- Data source host targets are not restricted (Developers can point at internal hosts by design). Add an egress allow-list or NetworkPolicy egress rules if that is a concern.
- Multi-replica WebSocket fan-out needs `@socket.io/redis-adapter`; without it, events emitted by the leader only reach sockets on that pod (clients still refresh via polling).
- Panel/explorer caches are per-process; swap `lru-cache` for Redis to share across replicas.
