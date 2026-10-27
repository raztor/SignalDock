#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
destination="${1:?Usage: backup.sh /absolute/private/backup-directory}"
[[ "$destination" = /* ]] || { echo 'Use an absolute backup directory.' >&2; exit 1; }
mkdir -m 700 "$destination"
compose=(docker compose --env-file deploy/.env -f deploy/compose.yaml)
running=()
while IFS= read -r service; do
  case "$service" in api|worker) running+=("$service");; esac
done < <("${compose[@]}" ps --services --status running)
restart_services() {
  if (( ${#running[@]} )); then "${compose[@]}" start "${running[@]}" >/dev/null; fi
}
trap restart_services EXIT
"${compose[@]}" stop api worker
"${compose[@]}" exec -T db pg_dump -U signaldock --format=custom signaldock > "$destination/database.dump"
"${compose[@]}" run --rm --no-deps --entrypoint tar api -C /data -czf - . > "$destination/instance-data.tar.gz"
chmod 600 "$destination/database.dump" "$destination/instance-data.tar.gz"
echo 'Database and private identity/artifact volume backed up during station maintenance.'
