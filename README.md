# Palsentry

**Palsentry** is a modern monitoring and management dashboard for your [Palworld](https://www.palworldgame.com/) dedicated server.

Monitor players, track activity on a live world map, manage your server, review historical performance metrics, and perform common administrative tasks — all from a single web interface.

## Features

### Live World Map

The live world map displays all of your bases and their locations. It also shows all currently online players and their positions in real time.

![Live World Map](screenshots/3-livemap.png)

The map also includes a special **Tracking Mode**, allowing you to focus on a specific player and automatically follow their movements in real time.

The map keeps the selected player in view even when they travel long distances or teleport to another location.

![Player Tracking Mode](screenshots/3.2-livemap-tracking.png)

### Enhanced Server Tools

Palsentry does more than display server information — it also provides convenient administrative controls directly from the dashboard.

Perform common server operations such as:

- Broadcasting announcements
- Restarting the server
- Shutting down the server
- Kicking players
- Banning and unbanning players

![Server Dashboard](screenshots/1-dashboard.png)

### Player Management

The dashboard provides a quick overview of currently online players, while the dedicated **Players** page gives you access to both online and offline player records.

You can view additional information such as when a player was last online and manage players even when they are no longer connected to the server.

You can even permanently ban offline players — no need to wait for them to reconnect before taking action.

![Players](screenshots/2-players.png)

![Bans](screenshots/5-bans.png)

### Enhanced Server Metrics

Palsentry continuously collects server statistics and stores them for historical analysis.

By default, server metrics are collected every minute and displayed in clean, easy-to-read graphs, allowing you to monitor trends and better understand your server's performance over time.

![Server Metrics](screenshots/4-metrics.png)

## Setup

> [!IMPORTANT]
> Before starting, make sure the Palworld REST API and `-enable-gamedata-api` is enabled.

### Docker Compose

Create a `docker-compose.yml` file:

```yaml
services:
  palsentry:
    image: wisdomsky/palsentry:latest
    restart: unless-stopped
    ports:
      - '3000:3000'

    environment:
      PALSERVER_API_URL: 'http://192.168.1.50:8212'
      PALSERVER_ADMIN_PASSWORD: 'your Palworld AdminPassword'
      PALSENTRY_AUTH_USERNAME: 'admin'
      PALSENTRY_AUTH_PASSWORD: 'your dashboard password'
      PALSENTRY_SESSION_SECRET: 'replace-with-a-random-secret-at-least-32-characters-long'
```

Generate a secure session secret with:

```sh
openssl rand -hex 32
```

Replace the value of `PALSENTRY_SESSION_SECRET` in your Compose file, then start Palsentry:

```sh
docker compose up -d
```

Check the container status:

```sh
docker compose ps
```

View logs:

```sh
docker compose logs -f
```

Once running, open:

```text
http://localhost:3000
```

### Docker Run

```sh
docker run -d -p 3000:3000 -e PALSERVER_API_URL="http://192.168.1.50:8212" -e PALSERVER_ADMIN_PASSWORD="your Palworld AdminPassword" -e PALSENTRY_AUTH_USERNAME="admin" -e PALSENTRY_AUTH_PASSWORD="your dashboard password" -e PALSENTRY_SESSION_SECRET="replace-with-a-random-secret-at-least-32-characters-long" wisdomsky/palsentry:latest
```

## Environment Variables

| Variable                                   | Default                      | Description                                                                     |
| ------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------- |
| `PALSERVER_API_URL`                        | **Required**                 | Palworld REST API host and port                                                 |
| `PALSERVER_ADMIN_PASSWORD`                 | **Required**                 | Palworld `AdminPassword`                                                        |
| `PALSERVER_REST_USERNAME`                  | `admin`                      | HTTP Basic Authentication username used by the Palworld REST API                |
| `PALSENTRY_AUTH_USERNAME`                  | `admin`                      | Palsentry dashboard login username                                              |
| `PALSENTRY_AUTH_PASSWORD`                  | **One required**             | Plaintext dashboard password                                                    |
| `PALSENTRY_AUTH_PASSWORD_HASH`             | **One required**             | Generated scrypt password hash; takes precedence over `PALSENTRY_AUTH_PASSWORD` |
| `PALSENTRY_SESSION_SECRET`                 | **Required**                 | Cookie-signing secret; must be at least 32 characters                           |
| `PALSENTRY_SESSION_TTL_HOURS`              | `12`                         | Dashboard session lifetime in hours                                             |
| `PALSERVER_TIMEOUT_MS`                     | `10000`                      | Palworld REST API request timeout in milliseconds                               |
| `PALSENTRY_ALLOW_DESTRUCTIVE`              | `false`                      | Enables kick, ban, unban, shutdown, stop, and restart operations                |
| `PALSENTRY_TRUST_PROXY`                    | `false`                      | Trust proxy IP headers and use Secure cookies                                   |
| `PALSENTRY_SAMPLE_INTERVAL_SECONDS`        | `60`                         | Metrics and player-roster sampling interval (`5`–`3600`)                        |
| `PALSENTRY_HISTORY_RETENTION_DAYS`         | `30`                         | Number of days historical metrics are retained (`1`–`3650`)                     |
| `PALSENTRY_RESTART_WAIT_SECONDS`           | `30`                         | Default player-warning countdown before a restart                               |
| `PALSENTRY_RESTART_HEALTH_TIMEOUT_SECONDS` | `180`                        | Maximum time to wait for the server to become healthy after a restart           |
| `PALSENTRY_RESTART_POLL_INTERVAL_MS`       | `2000`                       | Health-check interval while waiting for the server to return                    |
| `PALSENTRY_MAP_PROJECTION`                 | `new`                        | Map projection mode: `none`, `new` for Palworld 1.0+, or `legacy`               |
| `PALSENTRY_BIND_ADDRESS`                   | `127.0.0.1`                  | Host address published by Docker Compose                                        |
| `PALSENTRY_HOST_PORT`                      | `3000`                       | Host port published by Docker Compose                                           |
| `PALSENTRY_IMAGE`                          | `wisdomsky/palsentry:latest` | Docker Compose image override                                                   |
| `LOG_LEVEL`                                | `info`                       | Logging level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`  |

## Security

Palsentry exposes administrative functionality for your Palworld server, so it should be treated as a privileged service.

For production deployments:

- Use a strong dashboard password.
- Use a randomly generated `PALSENTRY_SESSION_SECRET`.
- Keep `PALSENTRY_ALLOW_DESTRUCTIVE=false` unless destructive operations are required.
- Avoid exposing Palsentry directly to the public internet.
- Prefer access through a trusted LAN, VPN, or authenticated reverse proxy.
- Use HTTPS when exposing the dashboard through a reverse proxy.

## Persistent Data

Palsentry stores its persistent application data under:

```text
/data
```

```yaml
services:
  palsentry:
    image: wisdomsky/palsentry:latest
    restart: unless-stopped
    ports:
      - '3000:3000'

    environment:
      PALSERVER_API_URL: 'http://192.168.1.50:8212'
      PALSERVER_ADMIN_PASSWORD: 'your Palworld AdminPassword'
      PALSENTRY_AUTH_USERNAME: 'admin'
      PALSENTRY_AUTH_PASSWORD: 'your dashboard password'
      PALSENTRY_SESSION_SECRET: 'replace-with-a-random-secret-at-least-32-characters-long'

    volumes:
      - ./data:/data
```

This allows historical metrics, player information, and other persistent data to survive container upgrades and recreation.

## Updating

### Docker Compose

Pull the latest image and recreate the container:

```sh
docker compose pull
docker compose up -d
```

### Docker Run

Pull the latest image:

```sh
docker pull wisdomsky/palsentry:latest
```

Then recreate your container using the same `/data` volume and `PALSENTRY_SESSION_SECRET`.
