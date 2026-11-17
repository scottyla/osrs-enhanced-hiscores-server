# Releasing

| | |
|---|---|
| Website + API | https://osrsenhancedhiscores.com (Railway project `osrs-enhanced-hiscores`) |
| Plugin repo | https://github.com/scottyla/osrs-enhanced-hiscores |
| Server repo | https://github.com/scottyla/osrs-enhanced-hiscores-server |

The Plugin Hub builds a plugin from the **root of a public GitHub repo** at a specific commit, so the plugin and the server are separate repos.

## 1. Server on Railway

Railway project **osrs-enhanced-hiscores**, service **osrs-enhanced-hiscores**. It builds from `Dockerfile`, and the database lives on a volume mounted at `/data`. The service settings live in Railway itself, not a config file in the repo: health check `/api/health` (60 s), restart on failure, 1 replica. SQLite can't be shared between replicas, so never scale it above 1.

### First-time setup

With the Railway CLI, from `server/`:

This has been done once already. It's recorded here in case it needs redoing. On Windows Git Bash, prefix commands that contain `/data` or `/api/...` with `MSYS_NO_PATHCONV=1`.

```sh
railway init --name osrs-enhanced-hiscores    # new project, links this folder
railway add --service osrs-enhanced-hiscores --variables TRUST_PROXY=true --variables RAILWAY_RUN_UID=0
railway service link osrs-enhanced-hiscores
railway volume add --mount-path /data          # the SQLite database lives here
# Health check / restart policy: service Settings in the dashboard (or the serviceInstanceUpdate API)
railway up --detach                            # build and deploy this folder
railway domain osrsenhancedhiscores.com        # prints the DNS records to add
```

`RAILWAY_RUN_UID=0` is needed because Railway mounts volumes as root and the image runs as the `node` user.

### DNS (Porkbun)

The domain's DNS is at Porkbun. Railway service domains are already created. The test URL is https://osrs-enhanced-hiscores-production.up.railway.app.

In Porkbun → Domain Management → osrsenhancedhiscores.com → **DNS**:

1. Delete Porkbun's default parking records: the root `ALIAS`/`A` record pointing at `pixie.porkbun.com`, and the `*` CNAME.
2. Add:

| Type | Host | Answer |
|---|---|---|
| ALIAS | *(blank)* | `7hkn9z5w.up.railway.app` |
| CNAME | `www` | `5pzfjkry.up.railway.app` |
| TXT | `_railway-verify` | `railway-verify=ffc2e6fd2d15cc18b325c66af83fdca6da7e812f3a6be6ffb727644b2751586d` |
| TXT | `_railway-verify.www` | `railway-verify=98754a0837c5087108058765935570afabb2735a5c0ea56911cc50696faf581d` |

`railway domain status osrsenhancedhiscores.com` shows verification and certificate progress. Railway issues HTTPS once DNS resolves, usually within minutes, at most a few hours.

### Deploying updates

Either run `railway up --detach` from `server/`, or connect the GitHub repo so every push to `master` deploys:

```sh
railway service source connect --repo scottyla/osrs-enhanced-hiscores-server --branch master --service osrs-enhanced-hiscores
```

Deploy server changes **before** plugin changes that depend on them. Older plugin versions keep running for a while after a Hub update, so the server must keep accepting the old format.

### Backups

Turn on scheduled backups for the volume in the Railway dashboard (service → Volume → Backups). For a manual copy, the database is `/data/hiscores.db` (`railway ssh` into the service).

### Other hosting

`deploy/` has a Docker Compose + Caddy setup for a plain VPS, plus `deploy/backup.sh`.

## 2. Plugin checklist

Already set: `DEFAULT_SERVER_URL` = `https://osrsenhancedhiscores.com`, `author=scottyla`, BSD-2 `LICENSE`, `icon.png` (48×48), `build=standard`, opt-in submission with the third-party IP warning, no reflection or extra dependencies.

Before submitting:

- [ ] The site is live over HTTPS (step 1).
- [ ] `./gradlew build` passes.
- [ ] The [in-game checklist](TESTING.md) passes against the **live** server. Your local dev client has `Server URL` saved as `http://localhost:8080`. Change it under the plugin's **Advanced** settings to `https://osrsenhancedhiscores.com`, or clear it to use the default.

## 3. Push the repos

Both folders are already git repos with an initial commit. Create two **public**, empty repos on GitHub (no README or license, so the histories don't conflict):

- `osrs-enhanced-hiscores`
- `osrs-enhanced-hiscores-server`

Then:

```sh
cd plugin
git remote add origin https://github.com/scottyla/osrs-enhanced-hiscores.git
git push -u origin master

cd ../server
git remote add origin https://github.com/scottyla/osrs-enhanced-hiscores-server.git
git push -u origin master
```

## 4. Plugin Hub PR

1. Fork https://github.com/runelite/plugin-hub and create a branch named `osrs-enhanced-hiscores`.
2. Add the file `plugins/osrs-enhanced-hiscores` (no extension):
   ```
   repository=https://github.com/scottyla/osrs-enhanced-hiscores.git
   commit=<full 40-character hash: run `git rev-parse HEAD` in plugin/>
   ```
3. Open a PR against `runelite/plugin-hub` with the description below. Check the `build` check and the "RuneLite Plugin Hub Checks" comment. To fix anything, push to the plugin repo and update `commit=` in the **same** PR.

### PR description

> **OSRS Enhanced Hiscores** adds hiscores for what the official hiscores don't track. That covers Loot Tracker totals (per boss and overall GE value), collection log progress, quest completion and quest times, achievement diaries, combat achievements, Slayer, boss kill counts/PBs and hours played, plus levels, XP and XP gains. Every game mode has its own boards (Normal, the ironman modes, Hardcore Worlds, Fresh Start, Leagues, Deadman). Website: https://osrsenhancedhiscores.com. Server source: https://github.com/scottyla/osrs-enhanced-hiscores-server
>
> - Submitting is **off by default** and shows the standard third-party IP warning. Each data type has its own toggle.
> - Read-only use of other plugins' saved data: the Loot Tracker's `loottracker` config, and Chat Commands' `killcount`/`personalbest` config, for the current RS profile.
> - Live drops come from `LootReceived`. Collection log items are read passively from script 4100 (`ScriptPreFired`) while the player browses the log; nothing is clicked or run for them.
> - Quest states come from `Quest.getState`, checked every 30 s and when quest points change. Diaries, combat achievements and Slayer come from gameval varbits/varps. Playtime is `VarClientID.ACCOUNT_SUMMARY_PLAYTIME`, only once the player reveals it.
> - The account hash identifies characters across name changes. A per-character token, stored in RS-profile config, stops anyone else overwriting a character's data. No bank or wealth data is collected.

## Updating the plugin later

Push to the plugin repo, then in your plugin-hub fork:

```sh
git remote add upstream https://github.com/runelite/plugin-hub.git   # once
git fetch upstream
git checkout -B osrs-enhanced-hiscores upstream/master
# edit plugins/osrs-enhanced-hiscores: commit=<new hash>
git commit -am "update osrs-enhanced-hiscores"
git push -f -u origin osrs-enhanced-hiscores
```

Then open a PR.
