# API reference

Base URL `/api`. JSON in/out. Errors: `{ "error": { "code": "BAD_REQUEST|UNAUTHORIZED|FORBIDDEN|NOT_FOUND|CONFLICT|INTERNAL", "message": "...", "details"?: {...} } }`.

Authenticated routes need `Authorization: Bearer <accessToken>`. Workspace-scoped routes also need `X-Workspace-Id: <uuid>`. The *Perm* column lists the required workspace permission (see RBAC in ARCHITECTURE.md).

## Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/login` | `{email, password}` | → `{accessToken, user}`; sets `gr_rt` cookie. 20 req / 15 min / IP |
| POST | `/auth/refresh` | – | cookie → `{accessToken}`; rotates cookie |
| POST | `/auth/logout` | – | revokes token family |
| GET | `/auth/me` | – | user + memberships |
| POST | `/auth/change-password` | `{currentPassword, newPassword}` | revokes all sessions |

## Workspaces, members, teams

| Method | Path | Perm |
|---|---|---|
| GET | `/workspaces` | authenticated |
| POST | `/workspaces` `{name, slug, description?}` | super admin |
| PATCH | `/workspace` `{name?, description?}` | workspace:manage |
| GET | `/members` | any member |
| POST | `/members` `{email, name, role, password?}` → `{member, tempPassword?}` | users:manage |
| PATCH | `/members/:userId` `{role}` | users:manage |
| DELETE | `/members/:userId` | users:manage (last admin protected) |
| GET / POST | `/teams` | any / teams:manage |
| PATCH / DELETE | `/teams/:id` | teams:manage |
| PUT | `/teams/:id/members` `{userIds}` | teams:manage |
| GET / PATCH | `/users`, `/users/:id` `{isActive?, isSuperAdmin?, name?}` | super admin |

## Data sources

| Method | Path | Perm |
|---|---|---|
| GET | `/datasources` | datasource:read |
| GET | `/datasources/:id` | datasource:read |
| POST | `/datasources` | datasource:manage |
| PUT | `/datasources/:id` (partial; omit `password` to keep it) | datasource:manage |
| DELETE | `/datasources/:id` | datasource:manage |
| POST | `/datasources/test` (same body as create, optional `id` to reuse stored secrets) → `{ok, latencyMs?, error?}` | datasource:manage |
| POST | `/datasources/:id/health` → `{status, latencyMs, error}` | datasource:read |

Body:
```json
{
  "name": "Warehouse", "type": "POSTGRES",
  "host": "db.internal", "port": 5432, "database": "dw", "username": "reader",
  "password": "•••", "connectionString": "optional, overrides host fields",
  "readOnly": true,
  "options": { "ssl": true, "poolMax": 10, "defaultSchema": "public" }
}
```
Response never contains secrets; it has `hasPassword` / `hasConnectionString` and live `status`, `lastLatencyMs`, `lastError`, `lastCheckedAt`.

## Explorer (explorer:read)

| Method | Path | Response |
|---|---|---|
| GET | `/explorer/:dsId/schemas[?fresh=1]` | `{schemas: string[]}` |
| GET | `/explorer/:dsId/schemas/:schema/objects` | `{objects: [{schema,name,kind,rowEstimate}]}` |
| GET | `/explorer/:dsId/schemas/:schema/tables/:table` | columns, indexes, foreignKeys, referencedBy, stats |
| GET | `/explorer/:dsId/schemas/:schema/tables/:table/preview?limit=100&offset=0` | QueryResult |
| GET | `/explorer/:dsId/completion[?schema=]` | `{tables: [{schema,table,columns}]}` |
| GET | `/explorer/:dsId/search?q=cust` | `{results: [{kind:'table'|'column', schema, table, column?}]}` |

## Queries (query:execute)

`POST /queries/execute`
```json
{
  "dataSourceId": "uuid",
  "sql": "SELECT ... WHERE $__timeFilter(ts) AND region IN ${region}",
  "timeRange": { "from": "2024-01-01T00:00:00Z", "to": "2024-01-02T00:00:00Z" },
  "variables": { "region": ["EU", "US"] },
  "maxRows": 5000,
  "transforms": {
    "filters": [{ "field": "status", "op": "eq", "value": "paid" }],
    "calculatedFields": [{ "name": "aov", "expression": "safediv(revenue, orders)" }],
    "groupBy": { "fields": ["region"], "aggregations": [{ "field": "revenue", "fn": "sum", "as": "total" }] },
    "sort": [{ "field": "total", "dir": "desc" }],
    "limit": 10
  }
}
```
→ `QueryResult { columns: [{name,type}], rows: [...], rowCount, truncated, durationMs, affectedRows? }`

| Method | Path | Notes |
|---|---|---|
| POST | `/queries/export` | execute body + `{format: 'csv'|'xlsx'|'json', fileName?}` → file download (≤100k rows, streamed for CSV/XLSX) |
| GET / DELETE | `/queries/history[?dataSourceId=&limit=&offset=]` | caller's own history |
| GET | `/queries/saved[?favorites=1]` | |
| POST / PUT / DELETE | `/queries/saved[/:id]` `{dataSourceId, name, sql, description?, isFavorite?, tags?}` | |

**Macros:** `$__timeFilter(col)`, `$__timeGroup(col, auto|5m|1h|$var)`, `$__timeFrom`, `$__timeTo`, `$__interval_s`. **Variables:** `${name}` or `$name`; arrays expand to `(p1, p2, …)`. Time expressions accepted by the API: `now`, `now-6h`, `now/d`, `now-1d/d`, ISO-8601, epoch.

## Dashboards (dashboard:read unless noted)

| Method | Path | Notes |
|---|---|---|
| GET | `/dashboards[?search=]` | visible to caller |
| POST | `/dashboards` | dashboard:create |
| GET | `/dashboards/:id` | includes `access: VIEW|EDIT|ADMIN`; `permissions` for admins |
| PUT | `/dashboards/:id` | EDIT; body must include `version` → 409 on conflict |
| DELETE | `/dashboards/:id` | ADMIN |
| POST | `/dashboards/:id/duplicate` | dashboard:create |
| GET | `/dashboards/:id/versions` | |
| POST | `/dashboards/:id/versions/:v/restore` | EDIT |
| PUT | `/dashboards/:id/permissions` `{grants:[{userId|teamId, level}]}` | ADMIN |
| POST | `/dashboards/:id/share` `{enabled}` → `{shareToken}` | ADMIN |
| POST | `/dashboards/:id/panels/:panelId/data` `{timeRange?, variables, filters?, fresh?}` | runs the **saved** panel query |
| GET | `/dashboards/:id/variables/:name/options` | `{values}` |
| GET | `/dashboards/templates` | built-in templates |
| POST | `/dashboards/from-template` `{templateId, dataSourceId, title?}` | dashboard:create |
| GET / POST | `/dashboards/folders` | |

Dashboard document:
```json
{
  "title": "Sales", "tags": ["sales"], "refreshInterval": "1m", "scheduleCron": "*/5 * * * *", "isPrivate": false,
  "definition": {
    "time": { "from": "now-30d", "to": "now" },
    "variables": [{ "name": "region", "type": "query", "dataSourceId": "uuid", "query": "SELECT name FROM regions", "multi": true, "includeAll": true, "default": ["$__all"] }],
    "panels": [{
      "id": "rev", "title": "Revenue", "type": "line",
      "gridPos": { "x": 0, "y": 0, "w": 12, "h": 8 },
      "dataSourceId": "uuid", "query": "SELECT ...",
      "transforms": { "calculatedFields": [] },
      "options": { "xField": "time", "yFields": ["revenue"], "unit": "currency" },
      "drilldown": { "field": "region", "variable": "region" }
    }]
  }
}
```
Panel `type`: `line | bar | area | pie | scatter | heatmap | gauge | kpi | table | treemap | geomap | text`.

### Public (no auth, rate-limited)
`GET /public/dashboards/:token`, `POST /public/dashboards/:token/panels/:panelId/data`, `GET /public/dashboards/:token/variables/:name/options`.

## Alerts

| Method | Path | Perm |
|---|---|---|
| GET | `/alerts/rules`, `/alerts/rules/:id` | alert:read |
| POST / PUT / DELETE | `/alerts/rules[/:id]` | alert:manage |
| POST | `/alerts/rules/test` (rule body, dry-run) → `{state, value, message}` | alert:manage |
| POST | `/alerts/rules/:id/evaluate` | alert:manage |
| GET | `/alerts/events[?ruleId=&unacknowledged=1]` | alert:read |
| POST | `/alerts/events/:id/ack` | alert:ack |
| GET | `/alerts/channels` | alert:read |
| POST | `/alerts/channels` `{name, type:'EMAIL', recipients}` or `{name, type:'TEAMS', webhookUrl}` | alert:manage |
| POST | `/alerts/channels/:id/test` | alert:manage |
| DELETE | `/alerts/channels/:id` | alert:manage |

Rule body:
```json
{
  "name": "High CPU", "dataSourceId": "uuid", "severity": "critical",
  "query": "SELECT AVG(cpu) AS value FROM server_metrics WHERE ts BETWEEN $__timeFrom AND $__timeTo",
  "condition": { "field": "value", "reducer": "last", "operator": "gt", "threshold": 80, "lookback": "now-15m", "noDataState": "NO_DATA" },
  "intervalSeconds": 60, "forSeconds": 300, "enabled": true, "channelIds": ["uuid"]
}
```
States: `OK → PENDING (forSeconds) → FIRING → OK`, plus `NO_DATA`, `ERROR`. Notifications on entering FIRING/ERROR and on resolution.

## Audit (audit:read)
`GET /audit?action=&userId=&entityType=&from=&to=&limit=&offset=` → `{items, total}`

## Health
`GET /healthz` (liveness) · `GET /readyz` (DB reachable; returns active pool count)

## WebSocket (`/ws`, Socket.IO)

Connect with `auth: { token: <accessToken> }`.

| Client → server | Payload |
|---|---|
| `workspace:join` | workspaceId (ack: boolean) |
| `dashboard:subscribe` / `dashboard:unsubscribe` | dashboardId |

| Server → client | Payload |
|---|---|
| `datasource:status` | `{id, status, latencyMs, error, checkedAt}` |
| `dashboard:refresh` | `{id, at}` |
| `dashboard:updated` | `{id, version, by}` |
| `alert:state` | `{ruleId, name, from, to, value, message}` |
