set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-connectallweb@192.168.1.42}"
DEPLOY_DIR="${DEPLOY_DIR:-graphan}"          # relative to the remote user's home
SERVICE="${1:-}"

cd "$(dirname "$0")"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)

echo "==> Packaging source"
TMP_TGZ="$(mktemp -t graphan-deploy.XXXXXX).tgz"
trap 'rm -f "$TMP_TGZ"' EXIT
tar --exclude=node_modules --exclude=./.env --exclude=dist --exclude=dist-seed \
    --exclude='*.log' --exclude=./.git --exclude=./docker-compose.override.yml \
    --exclude=./bigga -czf "$TMP_TGZ" .
echo "    $(du -h "$TMP_TGZ" | cut -f1)"

echo "==> Uploading to $DEPLOY_HOST:~/$DEPLOY_DIR"
# Replace source folders wholesale so deleted files don't linger; keep server-only files.
ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" \
  "set -e; mkdir -p ~/$DEPLOY_DIR && cd ~/$DEPLOY_DIR && rm -rf apps deploy docs && tar -xzf -" < "$TMP_TGZ"

echo "==> Building and restarting${SERVICE:+ ($SERVICE)}"
case "$SERVICE" in
  "")   REMOTE_CMD="docker compose up -d --build" ;;
  api)  REMOTE_CMD="docker compose build api migrate && docker compose up -d --no-deps migrate && docker compose wait migrate && docker compose up -d --no-deps api" ;;
  web)  REMOTE_CMD="docker compose up -d --build --no-deps web" ;;
  *)    echo "Unknown service '$SERVICE' (use: web | api | nothing for all)" >&2; exit 1 ;;
esac
ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "cd ~/$DEPLOY_DIR && $REMOTE_CMD && docker image prune -f >/dev/null && docker compose ps"

echo "==> Health check"
HOST_IP="${DEPLOY_HOST#*@}"
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null -m 3 "http://$HOST_IP:8070/"; then
    echo "    OK  ->  http://$HOST_IP:8070"; exit 0
  fi
  sleep 2
done
echo "    web did not respond on :8060 - check: ssh $DEPLOY_HOST '~/$DEPLOY_DIR/bigga logs'" >&2
exit 1
