# Embedding Graphan dashboards in another application

Graphan dashboards can be shown inside your own application in an `<iframe>`. Your application keeps
its own login: its **backend** signs a short-lived token, and Graphan trusts that token. Your users
don't need Graphan accounts.

```
Your app (backend)  ──signs JWT with EMBED_SECRET──►  iframe src=/embed/dashboard/<token>
                                                         │
Graphan web  ──POST /api/embed/session {token}──►  Graphan API verifies signature, expiry,
                                                    dashboard is embed-enabled
             ◄── embed session (8h, header only) ──
             ──panel data with X-Embed-Session──►  locked params always applied server-side
```

## 1. One-time setup (Graphan)

1. Set `EMBED_SECRET` on the API server (at least 32 random characters) and restart it:
   ```
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```
   Give the same value to your application's backend, and only to its backend. Never put it in browser code.
2. **Production only.** Allow your app's origin to frame Graphan by setting `EMBED_FRAME_ANCESTORS` on the web
   container (space-separated), e.g. `EMBED_FRAME_ANCESTORS="https://app.example.com"`.
   Only `/embed/*` pages can be framed; the rest of Graphan stays `SAMEORIGIN`.
3. Open the dashboard → **Settings → Sharing** → turn on **Embed in other applications (signed)**.
   That panel shows the dashboard ID and a ready-to-copy code sample.

## 2. Sign a token in your backend

| Claim | Required | Meaning |
|---|---|---|
| `resource.dashboard` | yes | Dashboard ID (UUID) |
| `exp` | yes | Expiry, Unix seconds, **at most 1 hour ahead** (10 minutes recommended) |
| `params` | no | Locked variable values, e.g. `{ "region": ["India"] }`. Each name must be a variable on the dashboard |
| `user` | no | Your user's identifier, recorded in Graphan's audit log (`dashboard.embed_view`) |

Algorithm: **HS256**, key: `EMBED_SECRET`.

**Node.js**
```js
const jwt = require('jsonwebtoken');
const token = jwt.sign(
  { resource: { dashboard: DASHBOARD_ID }, params: { region: [user.region] }, user: user.email,
    exp: Math.floor(Date.now() / 1000) + 600 },
  process.env.GRAPHAN_EMBED_SECRET,
);
const url = `https://graphan.example.com/embed/dashboard/${token}`;
```

**C# / .NET** (System.IdentityModel.Tokens.Jwt)
```csharp
var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(embedSecret));
var payload = new JwtPayload {
  { "resource", new Dictionary<string, object> { ["dashboard"] = dashboardId } },
  { "params", new Dictionary<string, object> { ["region"] = new[] { user.Region } } },
  { "user", user.Email },
  { "exp", DateTimeOffset.UtcNow.AddMinutes(10).ToUnixTimeSeconds() },
};
var token = new JwtSecurityTokenHandler().WriteToken(
  new JwtSecurityToken(new JwtHeader(new SigningCredentials(key, SecurityAlgorithms.HmacSha256)), payload));
```

**Python** (PyJWT)
```python
token = jwt.encode({"resource": {"dashboard": DASHBOARD_ID}, "params": {"region": [user.region]},
                    "user": user.email, "exp": int(time.time()) + 600}, EMBED_SECRET, algorithm="HS256")
```

**Java** (jjwt)
```java
String token = Jwts.builder()
  .claim("resource", Map.of("dashboard", dashboardId))
  .claim("params", Map.of("region", List.of(user.getRegion())))
  .claim("user", user.getEmail())
  .expiration(Date.from(Instant.now().plusSeconds(600)))
  .signWith(Keys.hmacShaKeyFor(embedSecret.getBytes(StandardCharsets.UTF_8)))
  .compact();
```

## 3. Show it

```html
<iframe src="https://graphan.example.com/embed/dashboard/TOKEN?titled=false"
        style="width:100%;height:800px;border:0"></iframe>
```

Options in the query string:
- `titled=false`: hide the title.
- `controls=false`: hide the time range and refresh pickers.
- Grafana-style `from=now-7d&to=now` and `var-category=Electronics` also work. Locked params ignore them.

## Embedding a paginated report

Reports use the same secret and token format. Use `resource: { report: "<report id>" }`, turn on
**Designer → Page & settings → Allow signed embedding**, and point the iframe at `/embed/report/<token>`.
`params` lock (and hide) report parameters, e.g. `{ "region": ["India"] }`. The embedded viewer has View
Report, Export (PDF/Excel/Word/CSV/HTML/JSON) and Print layout. Drill-through, subscriptions, history and
editing are not available inside the embed.

## Security notes

- **Row-level security:** write panel queries against a variable, e.g. `WHERE tenant_id IN ${tenant_id}`, and
  pass `tenant_id` in `params`. Locked values are hidden from the viewer. The server applies them to every
  request, whatever the browser sends, and always as bound parameters.
- Tokens are verified on open and exchanged for an 8-hour session (`EMBED_SESSION_TTL`). The session is
  sent in a header, never in a URL. Turning embedding off for a dashboard takes effect on the next request.
- Embedded viewers can only run the dashboard's saved, read-only panel queries. They can't edit or
  run SQL, and they can't call any other Graphan API.
- Options for *query* variables that are not locked come from the variable's own query, so make sure those
  queries don't list other tenants' values.
