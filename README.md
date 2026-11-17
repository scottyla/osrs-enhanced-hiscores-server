# OSRS Enhanced Hiscores: server

The website and API behind **https://osrsenhancedhiscores.com**. The RuneLite plugin that feeds it lives at https://github.com/scottyla/osrs-enhanced-hiscores.

Fastify + SQLite. Serves the ingest API for the plugin, the read API, and the dashboard in `public/`.

- [docs/DATA.md](docs/DATA.md): what the plugin collects, and from where
- [docs/TESTING.md](docs/TESTING.md): automated tests, local end-to-end setup, and the in-game checklist
- [docs/RELEASING.md](docs/RELEASING.md): Railway deployment, DNS, and the Plugin Hub submission

Runs TypeScript directly with Node's built-in type stripping (Node 22.18+ / 24), so there's no build step.

Live site: **https://osrsenhancedhiscores.com**

For local development:

```sh
npm install
npm start            # serves on port 8080 on your machine
npm test             # API tests against an in-memory database
npm run typecheck
node scripts/seed-demo.ts http://localhost:8080   # fake players, local server only (refuses the live site)
```

## Configuration

| Env var | Default | |
|---|---|---|
| `PORT` | `8080` | |
| `HOST` | `0.0.0.0` | |
| `DATABASE_PATH` | `data/hiscores.db` | SQLite file; the directory is created if missing |
| `TRUST_PROXY` | unset | Set to `true` behind a reverse proxy so rate limits use the real client IP |
| `SUBMIT_RATE_LIMIT` | `30` | Plugin submissions per IP per minute |

## Deploying

`deploy/` has a Docker Compose setup with Caddy for automatic HTTPS, and `deploy/backup.sh` for online SQLite backups. For Railway (the live site), see [docs/RELEASING.md](docs/RELEASING.md).

```sh
docker build -t osrs-enhanced-hiscores-server .
docker run -p 8080:8080 -v hiscores-data:/data osrs-enhanced-hiscores-server
```

## Boards

Defined in `src/boards.ts`. Like the official hiscores, one character can be on several boards:

| Board | Who |
|---|---|
| Normal | Main-game characters on normal worlds, including all ironmen |
| Ironman / Ultimate / Hardcore Ironman | Ironman, UIM and HCIM count on Ironman; UIM and HCIM also have their own boards |
| Group / Hardcore Group Ironman | Group ironmen (including unranked) / hardcore group ironmen |
| Hardcore Worlds | Characters on Hardcore Worlds (`WorldType.HARDCORE_MAIN`). Moves to Normal after a transfer. |
| Fresh Start Worlds | Fresh Start characters |
| Leagues / Deadman | Separate RuneScape profiles. Shows the newest season by default; `?season=` selects another. |
| Level 3 Skillers / 1 Defence | Normal-board characters with combat level 3 / Defence 1 (and combat above 3) |

Each RuneScape profile (STANDARD, each league, Deadman) is a separate `players` row, so league loot never mixes with main-game loot.

## API

All read endpoints accept `board` (default `normal`) and, for Leagues/Deadman, `season`.

| Method | Path | |
|---|---|---|
| `POST` | `/api/v1/submit` | Plugin ingest. Body schema in `src/validate.ts`. Header `X-Hiscores-Token` after the first submission. |
| `GET` | `/api/boards` | Boards, their groups, and seasons |
| `GET` | `/api/hiscores?category=&page=` | `category`: `overall`, `skill:ATTACK` (any skill), `loot_value`, `total_kills`, `collection_log`, `quest_points`, `playtime`, or `source` with `type`, `name` and `metric=kills\|value`. 25 per page. |
| `GET` | `/api/players?q=` | Name prefix search, with each player's default board |
| `GET` | `/api/players/:name` | Profile and ranks in every category on the board. Falls back to the player's own board if they aren't on the requested one. |
| `GET` | `/api/players/:name/loot/items?type=&name=` | Items for one boss/activity |
| `GET` | `/api/players/:name/drops?limit=` | Recent drops |
| `GET` | `/api/players/:name/collection-log` | Collection log items seen so far |
| `GET` | `/api/sources` | Bosses/activities with players on the board |
| `GET` | `/api/summary` | Player count and totals for the board |

## Data model notes

- **Loot sources are snapshots.** Each one is the Loot Tracker's full total for that source, so it *replaces* the stored row. Re-sending never double-counts. If a player resets their Loot Tracker data, the next sync replaces their totals with the smaller numbers.
- **Drops** are de-duplicated by a client-generated UUID. Only the latest 500 per player are kept. They feed the "Recent drops" list and don't affect totals.
- **Loot value** uses the GE price the plugin reported the last time it sent each item. `players.loot_value` is recomputed whenever that player's loot changes.
- **Locked-out players.** If a player loses their token (for example, a new PC without RuneLite profile sync), clear it so their next submission claims the character again:
  `UPDATE players SET token_hash = NULL WHERE username_key = 'their name';`
- **Schema changes.** `PRAGMA user_version` holds the schema version (currently 2). A v1 database from the first prototype is dropped and recreated on startup. From the first public release on, add real migrations in `src/db.ts` instead.

## Legal

Old School RuneScape and RuneScape are trademarks of Jagex Limited. Game content and images © Jagex Limited. All rights reserved. OSRS Enhanced Hiscores is an unofficial fan project, not affiliated with, endorsed by, or sponsored by Jagex or RuneLite.

This project's own source code is BSD 2-Clause licensed (see `LICENSE`); that license does not cover Jagex's content. See `NOTICE`.
