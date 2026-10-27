#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
destination="${1:?Usage: backup.sh /absolute/private/backup-directory}"
[[ "$destination" = /* ]] || { echo 'Use an absolute backup directory.' >&2; exit 1; }
compose=(docker compose --env-file deploy/.env -f deploy/compose.yaml)
temporary="$(mktemp -d)"
running=()
maintenance_started=false
cleanup() {
  status=$?
  trap - EXIT INT TERM
  rm -rf "$temporary"
  if [[ "$maintenance_started" = true ]] && (( ${#running[@]} )); then
    if ! "${compose[@]}" start "${running[@]}" >/dev/null; then
      echo 'Backup maintenance could not restart all previously running services.' >&2
      status=1
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
api_container="$("${compose[@]}" ps --all --quiet api)"
worker_container="$("${compose[@]}" ps --all --quiet worker)"
[[ "$api_container" =~ ^[a-f0-9]{12,64}$ ]] || { echo 'Exactly one existing API container is required.' >&2; exit 1; }
docker inspect "$api_container" > "$temporary/api.json"
worker_metadata=-
if [[ -n "$worker_container" ]]; then
  [[ "$worker_container" =~ ^[a-f0-9]{12,64}$ ]] || { echo 'At most one worker container is supported by this backup command.' >&2; exit 1; }
  docker inspect "$worker_container" > "$temporary/worker.json"
  worker_metadata="$temporary/worker.json"
fi
node scripts/ops/backup-config.mjs "$temporary/api.json" "$worker_metadata" "$temporary/connection.env" > "$temporary/configuration.json"
api_image="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).image)' "$temporary/configuration.json")"
# The bundled PostgreSQL client must be available before station writes stop.
"${compose[@]}" exec -T db pg_dump --version > /dev/null
"${compose[@]}" ps --services --status running > "$temporary/running.txt"
while IFS= read -r service; do
  case "$service" in api|worker) running+=("$service");; esac
done < "$temporary/running.txt"
mkdir -m 700 "$destination"
maintenance_started=true
"${compose[@]}" stop api worker
# No connection URI or password enters process arguments or ordinary output.
"${compose[@]}" exec -T db bash -c '
  set +x
  set -euo pipefail
  for existing in "${!PG@}"; do unset "$existing"; done
  while IFS= read -r -d "" key; do
    IFS= read -r -d "" value || exit 1
    case "$key" in
      PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|PGCONNECT_TIMEOUT|PGSSLMODE|PGSSLROOTCERT|PGSSLCERT|PGSSLKEY|PGSSLCRL|PGSSLCRLDIR|PGAPPNAME|PGOPTIONS|PGTARGETSESSIONATTRS|PGCHANNELBINDING|PGGSSENCMODE) export "$key=$value" ;;
      *) exit 1 ;;
    esac
  done
  exec pg_dump --format=custom --no-password
' < "$temporary/connection.env" > "$destination/database.dump"
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges --volumes-from "$api_container:ro" --entrypoint tar "$api_image" -C /data -czf - . > "$destination/instance-data.tar.gz"
chmod 600 "$destination/database.dump" "$destination/instance-data.tar.gz"
echo 'Database and private identity/artifact volume backed up during station maintenance.'
