### Container images

The workflow publishes the same multi-platform image for **Linux AMD64** and **Linux ARM64** to both registries:

| Registry                                    | Image                         |
| ------------------------------------------- | ----------------------------- |
| GitHub Container Registry (Compose default) | `ghcr.io/wisdomsky/palsentry` |
| Docker Hub                                  | `wisdomsky/palsentry`         |

`latest` follows the `main` branch. Every published build also has an immutable `sha-<12-character-commit>` tag. Version tags such as `v1.2.3` publish `1.2.3`, `1.2`, and `1` image tags.

Pin a release or use Docker Hub without editing Compose:

```sh
export PALSENTRY_IMAGE=ghcr.io/wisdomsky/palsentry:1.2.3
# Or: export PALSENTRY_IMAGE=docker.io/wisdomsky/palsentry:latest
```

## Quick start

### 1. Enable the Palworld REST API

Stop the game server, open `PalWorldSettings.ini`, and set these options inside `OptionSettings=(...)`:

```ini
RESTAPIEnabled=True
RESTAPIPort=8212
AdminPassword="choose-a-strong-game-admin-password"
```

Common locations are:

- Linux dedicated server: `Pal/Saved/Config/LinuxServer/PalWorldSettings.ini`
- Windows dedicated server: `Pal/Saved/Config/WindowsServer/PalWorldSettings.ini`

Restart Palworld after editing. Allow TCP port `8212` (or your chosen `RESTAPIPort`) **only from the machine/network where PalSentry runs**. Palworld authenticates REST requests with HTTP Basic Auth; its username is normally `admin` and its password is the configured `AdminPassword`.

To show guild bases on the live map, also start the Palworld dedicated server with the opt-in `-enable-gamedata-api` launch argument. This is optional: without it, player maps and every other dashboard feature continue to work, and the map explains how to enable the base layer.

### 2. Configure PalSentry

Only the Palworld connection values are required. Choose either configuration method.

**Option A — Docker environment variables (no `.env` file):**

```sh
export PALWORLD_REST_URL=http://192.168.1.50:8212
export PALWORLD_ADMIN_PASSWORD='the AdminPassword from PalWorldSettings.ini'
```

These exports apply to the current shell. Supply the same variables through your container manager when deploying from Portainer, a NAS UI, or another Docker platform.

The built-in dashboard login is `admin` / `admin`, the session secret uses a shared default, and destructive actions are enabled. Override them before exposing PalSentry beyond a trusted local network:

```sh
export PALSENTRY_LOGIN_PASSWORD='a separate PalSentry login password'
export PALSENTRY_SESSION_SECRET="$(openssl rand -hex 32)"
export PALSENTRY_ALLOW_DESTRUCTIVE=false
```

**Option B — optional Compose `.env` file:**

```sh
cp .env.example .env
```

Edit `.env` and fill in the required Palworld values. The template includes the PalSentry defaults and recommended security guidance. The file is ignored by Git; do not commit or share it. Single-quote custom secrets, especially password hashes or values containing `$` or `#`.

### 3. Start it

```sh
docker compose pull
docker compose up -d
docker compose ps
```

Open <http://localhost:3000> and sign in with `PALSENTRY_LOGIN_USERNAME` and your dashboard password.

Useful commands:

```sh
docker compose logs -f palsentry
docker compose restart palsentry
docker compose pull && docker compose up -d  # update the published image
docker compose down                           # keeps everything in ./data
```

PalSentry stores its database in the host's `./data` directory. Stop the service before backing up that directory. Deleting it permanently removes the player roster, bans, audit records, and metrics history.

To build the production image from this checkout instead of pulling it:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

`GET /api/health` is public and reports PalSentry liveness only. The Docker healthcheck deliberately remains healthy when Palworld is offline.

## Authentication and safety

### Use a password hash instead of plaintext

The default dashboard credentials are `admin` / `admin`. Change them before exposing the dashboard. The plaintext option is convenient, but PalSentry can use an scrypt hash supplied through the Docker environment or `.env`:

```sh
npm run hash-password
```

Or, after building the image, without installing project dependencies on the host:

```sh
docker run --rm -it --entrypoint node ghcr.io/wisdomsky/palsentry:latest \
  packages/server/scripts/hash-password.mjs
```

Put the emitted `PALSENTRY_LOGIN_PASSWORD_HASH='scrypt$…$…'` value in `.env` or export it with single quotes, clear any custom `PALSENTRY_LOGIN_PASSWORD`, and recreate the container. The hash takes precedence over the built-in `admin` password:

```sh
docker compose up -d --force-recreate
```

If both values are present, the hash wins. Login attempts are limited to 10 per source IP per 15 minutes. Sessions are stateless signed cookies; changing `PALSENTRY_SESSION_SECRET` immediately invalidates every session.

### Destructive-action gate

PalSentry starts with destructive actions enabled:

```dotenv
PALSENTRY_ALLOW_DESTRUCTIVE=true
```

Kick, ban, unban, shutdown, stop, and restart are available by default, and the UI still requires a confirmation dialog. Set the flag to `false` and recreate the container to disable those actions at both the API and UI layers. Broadcast and save remain available. This gate is independent of login authentication.

### Reverse proxies and HTTPS

Set `PALSENTRY_TRUST_PROXY=true` **only** when all access comes through a trusted HTTPS reverse proxy. It marks the session cookie `Secure` and trusts forwarded addresses for audit attribution. Also block direct access to port 3000; otherwise a direct client could forge forwarding headers.

If this flag is enabled while you browse over plain HTTP, login appears not to stick because browsers correctly refuse to send the Secure cookie.

## Restarting the game server

Palworld's REST API has shutdown and stop endpoints, but **no restart endpoint**. PalSentry implements restart as:

1. announce the countdown;
2. save the world;
3. request graceful shutdown;
4. wait for the game process to stop; and
5. poll until a new process is healthy.

The **Palworld game container**, not merely the PalSentry container, must therefore have:

```yaml
services:
  palworld:
    restart: unless-stopped
```

PalSentry never mounts the Docker socket and cannot start a stopped container directly. It recognizes a completed restart by observing an offline/online transition or a reset in Palworld's uptime. If the process does not return within `PALSENTRY_RESTART_HEALTH_TIMEOUT_SECONDS`, the UI gives a clean failure with a restart-policy hint.

Always test this once while players are not relying on the server.

## Data and API limitations

PalSentry stores `/data/palsentry.db` in the host's `./data` bind-mounted directory using SQLite WAL mode. It contains:

- the PalSentry-created ban registry;
- the immutable action audit trail;
- sampled metrics history; and
- the player roster described under **Players** below.

Palworld exposes no endpoint for listing bans. Consequently, PalSentry cannot discover bans issued before it was installed or through the game console. You can still use **Bans → Unban by player id**, and the UI clearly distinguishes its own registry from the game server's actual ban list. Player actions always target Palworld's `userid`, never a potentially duplicated display name.

Palworld exposes only a point-in-time metrics snapshot. PalSentry creates history by polling and retains it for `PALSENTRY_HISTORY_RETENTION_DAYS` (30 by default). A new installation therefore has no historical chart data until samples accumulate.

The same is true of `/players`, which lists only who is connected at the moment it is called. PalSentry keeps its own roster rather than trusting that endpoint as a history, for the reasons in the next section.

## Players

**Players** lists everyone PalSentry has ever seen, not just who is connected right now. Palworld's `/players` endpoint forgets a player the moment they disconnect, so the roster is PalSentry's own table, observed in the background at `PALSENTRY_SAMPLE_INTERVAL_SECONDS` (60s by default) — players who connect and leave between two page views are still recorded.

Each row carries a **Last online** column, immediately before the actions:

- connected players show a live green indicator and **Now**;
- everyone else shows a compact age (`30m ago`, `1h ago`, `9d ago`), refreshed every 30 seconds even when polling is switched off;
- hovering the column gives the exact local date and time.

The table sorts by **Last online**, newest first, so whoever is connected sits at the top. Every other column is sortable and searchable as before.

Online rows behave as they always have. Offline rows keep their identity, level, and last known position, and lose only what describes a live session: **IP address, ping, and building count are deliberately not stored once a player disconnects**, so the roster does not quietly become a permanent connection log. For the same reason those cells read `—`, and **Kick** and **Track in map** are hidden for offline players — there is no session to act on. **Ban** and **Unban** stay available, because a ban is an account-level action.

If the game server cannot be reached, nobody is reported online, the roster is still shown with last-known positions and times, and a note explains that live status is unavailable. That also means a restart does not empty the table.

The dashboard is a live view, so its player card shows connected players only.

## Metrics

**Metrics** holds four full-width charts — players online, server FPS, base camps, and server frame time — one per row. Each chart keeps its own range filter, so changing one never reloads another, and each remembers its selection in this browser across navigation and reloads.

Every chart is drawn against a labelled grid, so a height on the plot reads as a value and a position reads as a date:

- the value axis carries round gridline labels, stepped in whole numbers for counts and in tenths for frame time, and never below zero for metrics that cannot go negative;
- the time axis labels five or six points across the range, adding the date once a span exceeds a day, and thins out automatically on narrow screens;
- hovering (or tapping, or arrowing with the keyboard once a chart has focus) shows a crosshair, a dot on the nearest sample, and a readout naming that sample's exact value and local date and time;
- short series also draw a dot per sample, so individual buckets stay distinguishable.

Ranges are the presets `1h`, `6h`, `24h`, `7d`, and `30d`, or **Custom range** with start and end date-and-time controls interpreted in your browser's local timezone. Custom ranges may cover any span the server still retains; long spans are downsampled on the server to roughly 360 points, and responses carry the effective absolute bounds they were built from. Setting **Custom range** seeds a recent window, and **Apply** commits your edits; validation errors never discard the last successful chart.

Preset charts refresh on the sample cadence while the tab is open. A fixed custom range loads once, because a completed past range cannot gain new samples. History is fetched only on this tab — the dashboard's polling loop does not request it.

## Player tracking on the map

Each row of the dashboard's online-player preview has a **Show in map** action. It opens the map following that player, identified in the URL by their stable account id (`/map?track=<userId>`), so the link survives a reload and browser back/forward navigation.

While following:

- the map recentres on the player's latest position on every refresh and switches between Palpagos and World Tree automatically if the player teleports;
- follow mode raises zoom to at least 250% of the fitted scale when tracking starts or the player genuinely changes region, and keeps any closer zoom you have set;
- panning and switching region tabs stay available, but the next refresh recentres and restores the player's region;
- the tracked marker and its row in the positions table are highlighted, and **Stop tracking** clears the URL query while leaving the current view in place; and
- if the player disappears from the online list while the server is still responding, tracking stops, the notice explains why, and the last map view is retained.

## Live map

The map plots raw Unreal coordinates on separate **Palpagos** and **World Tree** surfaces. Both 8192×8192 textures are bundled with the SPA, so the map works without a runtime dependency on a third-party host. They were sourced from the [PalworldSaveTools](https://github.com/deafdudecomputers/PalworldSaveTools) project; provenance and checksums are recorded in [`packages/web/public/maps/README.md`](packages/web/public/maps/README.md).

Palworld, its artwork, and game data are owned by Pocketpair. Bundling these derived textures does not place them under PalSentry's AGPLv3 license, and this project is not affiliated with or endorsed by Pocketpair.

The map view keeps independent pan/zoom state for each region while it is open. Calibration settings are also per region and are saved only in that browser. The map supports mouse/touch drag, cursor-centered wheel zoom, pinch zoom, keyboard arrows and `+`/`-`, and explicit zoom/Fit controls. If either texture fails to load, only that region falls back to its interactive coordinate grid.

Guild bases come from Palworld's opt-in `/game-data` snapshot and are refreshed separately from players. Start Palworld with `-enable-gamedata-api` to enable them. Every valid `PalBox` is shown even when its guild has no online members; hover, focus, or tap a base marker to see its guild name. If the endpoint is disabled or temporarily unavailable, the last successful base snapshot is retained where possible and the player map remains interactive.

To use your own legally obtained textures instead:

1. provide the images under `./map/`;
2. uncomment the map bind mount in `docker-compose.yml`; and
3. set one or both overrides:

   ```dotenv
   PALSENTRY_MAP_TEXTURE_URL=/map/t_worldmap.png
   PALSENTRY_WORLD_TREE_TEXTURE_URL=/map/t_treemap.png
   PALSENTRY_MAP_PROJECTION=new
   ```

To turn both textures off and use interactive coordinate grids, set `PALSENTRY_MAP_PROJECTION=none`.

`new` is the default Palpagos calibration for Palworld 1.0+; `legacy` is available for older maps. Pocketpair does not document these projections and game updates can move map data, so verify placement yourself.

Advanced local-runtime variables (`PALSENTRY_HOST`, `PALSENTRY_PORT`, `PALSENTRY_DATA_DIR`, `PALSENTRY_DB_PATH`, and `PALSENTRY_WEB_DIST`) are documented in `.env.example`. Compose pins the in-container listener to `0.0.0.0:3000` and storage to `/data` so host-side settings cannot accidentally break its port or volume mapping.

## Local development

Requirements: Node.js 20.19 or newer and npm 10 or newer.

```sh
# Either export the required variables or copy and configure .env.example.
cp .env.example .env
npm ci
npm run dev
```

Open <http://localhost:5173>. Vite proxies `/api` to the Node process on port 3000, preserving the same-origin behavior used in production.

A development compose override is also available:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

### Try it without Palworld

A small mock implements the documented REST surface and provides four moving fake players plus six guild bases across both map regions:

```sh
MOCK_ADMIN_PASSWORD=mock-admin-password npm run mock
```

Point `.env` at `http://127.0.0.1:8212` and use the same mock admin password. Set `MOCK_GAME_DATA_ENABLED=false` when starting the mock to exercise the optional-base fallback. The mock is a development aid only; it is not a Palworld emulator.

The mock also has deterministic hooks for looking at map tracking by hand, since its normal player movement is random:

```sh
# Pin USER-DAVE to a fixed Palpagos → World Tree route and advance it on every player read.
MOCK_TELEPORT_USER=USER-DAVE MOCK_TELEPORT_EVERY=1 npm run mock

# Drop USER-ALICE from the online roster after 25s while the server keeps answering.
MOCK_DROP_USER=USER-ALICE MOCK_DROP_USER_AFTER_SECONDS=25 npm run mock
```

Put the same paths in a short `.env` (or export them) and open <http://localhost:5173/map?track=USER-DAVE> to watch the follow recentre and swap regions, or `track=USER-ALICE` to watch the offline notice appear. The drop hook is also how to see roster retention by hand: after the wait, **Players** keeps Alice with a **Last online** age while **Dashboard** and **Map** drop her entirely.

### Checks

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run test:smoke
```

The smoke test starts a real mock API plus the built PalSentry process on ephemeral test data and covers login, protected reads (including `/api/history`), metrics history presets and custom ranges, actions, ban history, restart recovery, audit records, SPA deep links, and game-server outage handling.

## Publishing containers (maintainers)

[`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml) runs checks and a no-push image build for pull requests. Pushes to `main`, semantic-version tags such as `v1.2.3`, and manual runs publish one AMD64/ARM64 build to Docker Hub and GHCR with a shared digest, OCI metadata, provenance, and an SBOM.

Before the first publish:

1. Create `wisdomsky/palsentry` on Docker Hub as a **public** repository.
2. Add the GitHub repository secrets `DOCKERHUB_USERNAME` (set to `wisdomsky`) and `DOCKERHUB_TOKEN` (a Docker Hub access token with write access).
3. Ensure GitHub Actions has permission to create packages; the workflow grants its `GITHUB_TOKEN` `packages: write` only in the publish job.
4. After the first GHCR push, open the package settings on GitHub and change its visibility from **Private** to **Public**. New GHCR packages are private by default.

No separate GHCR token is needed. Publishing with `GITHUB_TOKEN` links the package to this repository automatically.

## Troubleshooting

### PalSentry starts but reports Palworld offline

- Confirm `RESTAPIEnabled=True` and restart Palworld after changing the INI.
- Use the game host's LAN/VPN IP, not `localhost`, from Docker.
- Verify `RESTAPIPort`, firewall rules, `PALSERVER_REST_USERNAME`, and `AdminPassword`.
- Check `docker compose logs -f palsentry`; mapped upstream errors distinguish refused connections, timeouts, and `401` credentials.

### Destructive buttons are disabled

Set or export `PALSENTRY_ALLOW_DESTRUCTIVE=true`, then run `docker compose up -d --force-recreate`. The server enforces the same gate, so directly calling the API cannot bypass the disabled UI.

### Restart times out

Ensure the **Palworld** service uses `restart: unless-stopped` and that its process actually exits after `/shutdown`. Check the game container's logs. PalSentry's own `restart: unless-stopped` setting does not restart Palworld.

### Login succeeds, then immediately returns to login

If connecting with plain HTTP, leave `PALSENTRY_TRUST_PROXY=false`. Set it to `true` only behind HTTPS and ensure the proxy forwards requests while direct access is blocked.

### Ban registry differs from the game

This is expected for console-issued or pre-existing bans because Palworld cannot list them over REST. Use the player id and the manual unban control, or inspect the game server's `Pal/Saved/SaveGames/banlist.txt` directly.

## Architecture

```text
Browser ── same-origin HTTP ──> Fastify + Vue static files ── Basic Auth ──> Palworld REST API
                                    │
                                    └── SQLite (/data/palsentry.db)
                                        bans · audit · metric samples · players
```

- **Frontend:** Vue 3, TypeScript, Pinia, Vue Router, Tailwind CSS 4
- **Backend:** Node.js, Fastify 5, TypeScript, better-sqlite3
- **Deployment:** multi-platform `node:22-slim` image for AMD64/ARM64, non-root UID 1001, read-only root filesystem, all Linux capabilities dropped

The app intentionally manages one Palworld server configured through environment variables. Core monitoring and administration use Palworld's documented REST endpoints; the map optionally reads the documented, opt-in `/game-data` snapshot for guild bases. PalSentry does not depend on RCON, Docker-socket access, or undocumented teleport/item APIs.
