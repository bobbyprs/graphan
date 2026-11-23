# Deployment

## Docker Compose (single host)

```bash
cp .env.example .env      # set JWT_*, CREDENTIALS_ENCRYPTION_KEY, POSTGRES_PASSWORD, SMTP_*
docker compose up -d --build
```

Services: `db` (metadata Postgres), `sample-db` (demo data), `migrate` (one-shot `prisma migrate deploy` + idempotent seed), `api`, `web` (nginx serving the SPA and proxying `/api` + `/ws`). UI on `:8080`.

Drop `sample-db` and the `SAMPLE_DB_*` variables for production; the seed then creates a data source pointing nowhere that you can delete.

## Kubernetes

```bash
# build & push
docker build -f apps/server/Dockerfile -t ghcr.io/your-org/graphan-api:1.0.0 .
docker build -f apps/web/Dockerfile    -t ghcr.io/your-org/graphan-web:1.0.0 .
docker push ghcr.io/your-org/graphan-api:1.0.0 && docker push ghcr.io/your-org/graphan-web:1.0.0

# edit deploy/k8s/01-config.yaml (hostnames, SMTP) and provide real secrets, then
kubectl apply -k deploy/k8s
```

| Manifest | Purpose |
|---|---|
| `00-namespace` | namespace with `restricted` Pod Security |
| `01-config` | ConfigMap + example Secret (replace with External Secrets / Sealed Secrets) |
| `02-postgres` | StatefulSet for metadata DB (swap for a managed DB in production) |
| `03-migrate-job` | migrations + seed; run before each rollout (Argo CD PreSync annotation included) |
| `04-api` | Deployment (2 replicas, probes, non-root, RO root FS), Service, HPA (2–10), PDB |
| `05-web` | nginx-unprivileged Deployment + Service |
| `06-ingress` | TLS ingress routing `/api` + `/ws` → API, `/` → web; default-deny NetworkPolicies |

### Scaling notes
- **API replicas** are stateless apart from in-memory caches. Background jobs are leader-elected through a Postgres advisory lock, so any number of replicas is safe.
- **WebSockets across replicas:** add `@socket.io/redis-adapter` (one line in `realtime/socket.ts`) so leader-emitted events reach every pod. Ingress cookie affinity is pre-configured.
- **Connection pools** are per replica per data source (`poolMax`, default 10). Size customer DB connection limits as `replicas × poolMax`.
- **Heavy query workloads:** run dedicated API replicas with `ENABLE_SCHEDULER=false` behind the ingress, and one small worker deployment with `ENABLE_SCHEDULER=true`.

## Operations

| Task | How |
|---|---|
| Rotate JWT secrets | change secret + restart → all users re-login |
| Rotate `CREDENTIALS_ENCRYPTION_KEY` | add a `v2` envelope in `lib/crypto.ts` that tries the new key then the old, re-save data sources, remove old key |
| Backups | back up the metadata Postgres (dashboards, users, encrypted credentials). Keep the encryption key in a separate secret store — without it stored credentials are unrecoverable |
| Logs | JSON (pino) to stdout with request ids; secrets redacted |
| Probes | `/healthz` liveness, `/readyz` readiness (checks metadata DB) |
| Air-gapped geo maps | place a world GeoJSON at `apps/web/public/world.json` (or set `VITE_WORLD_GEOJSON_URL`) |
