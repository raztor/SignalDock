# Configurable servers and sessions

## Connection flow

1. Enter a server URL or select a recent server.
2. Fetch public instance information and check protocol compatibility.
3. Show the effective URL, instance identity, and connection status.
4. Authenticate with that instance's username and password.
5. Load authorized radios, capabilities, preferences, and notification settings.

The backend URL is a runtime choice, not a mandatory build-time environment variable. A self-hosted web deployment may supply a public runtime configuration containing a default URL and branding, without secrets or rebuilding the client. A custom mobile build may also set defaults while retaining server selection.

## Recent servers and isolation

Store a local alias, canonical base URL, `instanceId`, instance public-key identity, last connection, and optional username. Never store a plaintext password. Each account/session/cache entry is scoped to instance and user.

The app may remember several sessions, with one active instance for operation initially. Authorized background notifications from other saved instances remain available. Adding, renaming, removing, or signing out of server A must not affect B.

Switching instances closes media and event sockets, releases control/TX intentions, clears in-memory domain caches, and creates a new context generation. Late responses from the old generation are ignored. Switching radios inside the instance uses the same protection for radio-specific operations.

QR codes and links can prefill a server URL, never import a password/session or automatically trust a new destination. Push payloads can identify a saved instance but cannot introduce a new backend URL.

## URL and discovery contract

Support a reverse-proxy prefix, for example `https://radio.example.invalid/signaldock`. Normalize scheme/host/trailing slash while preserving the prefix. Reject embedded credentials, fragments, and unsupported query parameters.

Discovery uses `GET {baseUrl}/api/v1/server-info`. Advertised authenticated API routes remain on the same origin/base. External media or signed-file destinations need explicit configuration and must not receive the general API bearer token.

The instance creates a persistent UUID and public/private identity key. A changed identity at a known URL requires explicit reconnection before reusing credentials. Routine TLS certificate renewal does not change instance identity. Backups must preserve identity keys; a cloned installation must receive a new identity.

Production requires valid HTTPS. HTTP loopback exceptions are development-only. The client never silently disables TLS validation or follows a credential-bearing redirect to another origin.

## Session storage modes

| Client mode | Session handling |
|---|---|
| Native mobile | Short-lived access token in memory; per-instance refresh token in SecureStore |
| Same-origin self-hosted web | HttpOnly/Secure refresh or session cookie, with CSRF protection |
| Universal web against another origin | Access/refresh in memory initially; no dependence on third-party cookies or password storage in localStorage |

Universal web may require sign-in again after reload. Recent non-secret server entries persist. Each backend allows explicit web origins through CORS; installation can preconfigure the published web origin once its domain exists. Custom frontends add their origin through setup.

A private server still requires LAN/VPN or reachable HTTPS. The push relay is not a tunnel. Public web → private backend combinations need browser validation for private-network and mixed-content restrictions; same-origin self-hosted web is the simplest supported setup.

## Acceptance

Two instances with colliding usernames/resource IDs; delayed responses during switching; logout/refresh expiry; URL prefixes; incompatible API major versions; changed instance identity; private unreachable server; and a push from a non-active saved instance. No credential from A may reach B.
