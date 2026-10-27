#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
case "$(uname -m)" in aarch64|arm64) architecture=arm64 ;; x86_64) architecture=amd64 ;; *) echo 'Unsupported proof architecture' >&2; exit 1 ;; esac
temporary="$(mktemp -d)"
server_pid=
cleanup() { if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi; rm -rf "$temporary"; }
trap cleanup EXIT
asset="livekit_1.13.11_linux_${architecture}.tar.gz"
curl --fail --silent --show-error --location "https://github.com/livekit/livekit/releases/download/v1.13.11/$asset" -o "$temporary/$asset"
curl --fail --silent --show-error --location https://github.com/livekit/livekit/releases/download/v1.13.11/checksums.txt -o "$temporary/checksums.txt"
(cd "$temporary" && sha256sum --check --ignore-missing checksums.txt)
tar -xzf "$temporary/$asset" -C "$temporary"
cat > "$temporary/livekit.yaml" <<'YAML'
port: 7885
bind_addresses: ['127.0.0.1']
rtc:
  node_ip: 127.0.0.1
  tcp_port: 7886
  udp_port: 7887
  use_external_ip: false
keys:
  devkey: secret-for-local-synthetic-proof-only
YAML
if curl --silent --max-time 1 http://127.0.0.1:7885/ >/dev/null; then
  echo 'The disposable media proof port is already occupied.' >&2; exit 1
fi
"$temporary/livekit-server" --config "$temporary/livekit.yaml" > "$temporary/server.log" 2>&1 &
server_pid=$!
for attempt in {1..30}; do
  if ! kill -0 "$server_pid" 2>/dev/null; then cat "$temporary/server.log" >&2; exit 1; fi
  if curl --fail --silent http://127.0.0.1:7885/ >/dev/null; then break; fi
  sleep 1
done
kill -0 "$server_pid"
if [[ -n "${SIGNALDOCK_MEDIA_PROOF_IMAGE:-}" ]]; then
  docker run --rm --network=host --read-only --cap-drop=ALL --security-opt=no-new-privileges \
    --tmpfs /tmp:rw,noexec,nosuid,size=128m,uid=1000,gid=1000 \
    -e LIVEKIT_URL=ws://127.0.0.1:7885 -e LIVEKIT_API_KEY=devkey \
    -e LIVEKIT_API_SECRET=secret-for-local-synthetic-proof-only \
    "$SIGNALDOCK_MEDIA_PROOF_IMAGE" node services/media-gateway/proof/local-roundtrip.mjs
else
  LIVEKIT_URL=ws://127.0.0.1:7885 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret-for-local-synthetic-proof-only \
    node services/media-gateway/proof/local-roundtrip.mjs
fi
kill -0 "$server_pid"
