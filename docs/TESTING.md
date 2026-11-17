# Testing OSRS Enhanced Hiscores

There are three layers of testing:

1. **Automated tests**: run on every push by CI, and before every release.
2. **Local end-to-end**: your own RuneLite dev client against a local server, using the checklist below.
3. **Staging**: the real server deployed, with a few friends playing on it before the Plugin Hub release.

## 1. Automated tests

```sh
cd plugin && ./gradlew test     # needs JDK 11+
cd server && npm test           # needs Node 22.18+ / 24
cd server && npm run typecheck
```

| Suite | What it covers |
|---|---|
| plugin repo `src/test/.../GameModeTest` | Which hiscores a world counts toward: normal, Hardcore Worlds, Fresh Start, Leagues, Deadman. Beta, PvP Arena, speedrunning and tournament worlds are ignored. |
| plugin repo `src/test/.../LootTrackerReaderTest` | Parsing the Loot Tracker's saved data. The fixture matches what RuneLite 1.13.6 writes, so update it if RuneLite changes the format. |
| `test/api.test.ts` | Submit API and token checks, which board each account type lands on, moving boards (Hardcore Worlds transfer, HCIM death), ranking order, personal-page ranks, wrong-board lookups, input validation. |

## 2. Local end-to-end

### Setup

```sh
# Terminal 1: server + dashboard on http://localhost:8080 (fresh database in server/data/)
cd server
npm install
npm start

# Optional: fill the dashboard with fake players to compare against
SUBMIT_RATE_LIMIT=10000 npm start      # instead of the plain npm start above
node scripts/seed-demo.ts

# Terminal 2: RuneLite dev client with the plugin loaded
cd plugin
./gradlew run
```

**Logging in to the dev client with a Jagex account:** click the Jagex account button in the client's sidebar, choose **Add Jagex Account**, log in, pick a character, then click **Play Now**. Later launches only need the character selection. If you have an old `~/.runelite/credentials.properties` from the legacy setup, delete it.

In the client, open **Configuration → OSRS Enhanced Hiscores** and turn on **Submit data**. Check that **Loot Tracker** is enabled too.

Plugin debug logs go to the terminal and to `~/.runelite/logs/client.log`. The `run` task passes `--debug`, so `log.debug` lines are shown.

### In-game checklist

Work through this on a real character. The "Check" column is where to look on the dashboard (`http://localhost:8080`) or in the API.

| # | Do this | Check |
|---|---|---|
| 1 | Log in with **Submit data off** | Server logs show no `POST /api/v1/submit` |
| 2 | Turn **Submit data on** | The RuneLite IP warning dialog appears |
| 3 | Wait about 10 seconds after login | Your character appears on the Normal board (plus Ironman etc. if applicable) with correct levels, XP, combat level and quest points |
| 4 | Compare the loot log with RuneLite's Loot Tracker panel (grouped view) | Every boss/activity and its kill count matches |
| 5 | Kill something that drops loot, wait 30 seconds | It shows under "Recent drops" with the right items |
| 6 | Wait about 5 minutes (the Loot Tracker saves every 5 minutes) | That boss's kill count in the loot log goes up by one |
| 7 | Compare collection log totals with the Character Summary tab | Total and per-category counts match. **Note whether they're right straight after login or only after opening the collection log.** |
| 8 | Open the collection log and click through a few pages | Those pages' obtained items appear under "Collection log items" |
| 9 | Character Summary → reveal playtime | "Hours played" matches the in-game time. **This confirms the value is in minutes.** If it's 60× off, fix `playtimeMinutes` in the plugin. |
| 10 | Hop worlds, then wait 30 seconds | No duplicate drops and no errors in the log |
| 11 | Log out, then back in | Drops from just before logout arrive. No second full history upload in the same session. |
| 12 | Restart the client and log in | Submissions still succeed (the token was saved). Server never returns 403. |
| 13 | Stop the server, get a drop, start the server again within about 5 minutes | The drop arrives after the restart, because the plugin retries |
| 14 | Change any plugin setting | No errors. Turning **Submit data** off stops submissions. |
| 15 | Log in on a **Leagues** or **Deadman** world, if one is running | The character appears only on that board, not on Normal |
| 16 | Log in to a **Hardcore Worlds** character | It appears only on Hardcore Worlds. Check the badge on the player page. |
| 17 | Ironman / HCIM / GIM character, if you have one | Correct badge, and listed on Normal and the matching ironman boards |
| 18 | Log in and look at the player page's Quests card | All quests listed with the right status; the completed count matches your quest list |
| 19 | Start a quest, then finish it (Cook's Assistant is quick) | It shows as completed with today's date, a played time and a start-to-finish time; it appears under **Quest speed** |
| 20 | Kill a boss so the game prints its kill count (Chat Commands plugin on) | That boss's KC (and PB, if a time was shown) appears under Kill counts within 30 s |
| 21 | Complete a clue scroll | "Clue Scrolls (tier)" count matches the chat message |
| 22 | Compare the **Achievement diaries** grid with the in-game diary journal | Every tick matches, including Karamja easy/medium/hard |
| 23 | Compare combat achievement **points** with the in-game Combat Achievements overview | Points match; tasks count matches the number of completed tasks |
| 24 | Compare Slayer points and streak with what a Slayer master or the Slayer rewards interface shows | Both match |
| 25 | Gain a level | It appears under Recent level-ups with the right time |
| 26 | The next day (UTC), check XP gains | Today/This week numbers reflect XP since the first submission of each day |

Things only real play can confirm (the code was written against RuneLite 1.13.6 without in-game testing):

- **#7**: whether the collection log count variables are populated at login.
- **#8**: the collection log draw script (id 4100) arguments `[widget, itemId, quantity]`.
- **#9**: the unit of `VarClientID.ACCOUNT_SUMMARY_PLAYTIME`.
- **#16**: that Hardcore Worlds report `WorldType.HARDCORE_MAIN`.
- **#22–24**: the diary, combat achievement and Slayer variables are populated at login (rather than only after opening their interfaces).

### Inspecting the server

```sh
curl "https://osrsenhancedhiscores.com/api/players/<name>"                 # profile + ranks
curl "https://osrsenhancedhiscores.com/api/hiscores?board=hardcore_worlds"
curl "https://osrsenhancedhiscores.com/api/players/<name>/drops"
```

For a local development server, use your local address instead.

To start over, stop the server and delete `server/data/`.

## 3. Staging and beta

1. Deploy the server (see [the server README](../README.md)). Use the real domain you'll ship with.
2. In your dev client, set **Advanced → Server URL** to the deployed URL and repeat checklist items 3–12.
3. Beta testers: `cd plugin && ./gradlew shadowJar` builds `build/libs/osrs-enhanced-hiscores-*-all.jar`, a complete RuneLite dev client with the plugin. Testers run it with `java -jar <jar> --developer-mode` (Java 11+) and log in through the Jagex account sidebar button as above. Only send this to people you trust, and tell them it's a dev build.
4. Watch the server logs for 4xx/5xx responses, and check a few testers' profiles against their in-game Loot Tracker and Character Summary.
