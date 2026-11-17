# What the plugin collects

| Data | Source in the client | When it's sent |
|---|---|---|
| Loot log totals per boss/activity | The Loot Tracker plugin's saved totals (`loottracker` config, `drops_<TYPE>_<name>`) | Everything on the first login of each session, then each source the Loot Tracker re-saves (about every 5 minutes) |
| Individual drops (recent drops feed) | `LootReceived` event from the Loot Tracker | Batched every 30 seconds |
| Levels, XP, combat level | `client.getRealSkillLevel` / `getSkillExperience` | After login, then whenever they change |
| Quest points | `VarPlayerID.QP` | After login, then whenever it changes |
| Collection log totals and per-category counts | `VarPlayerID.COLLECTION_COUNT*` | After login, then whenever they change |
| Collection log items | The collection log's item-draw script (4100) while the player has the log open | As the player browses log pages |
| Hours played | `VarClientID.ACCOUNT_SUMMARY_PLAYTIME` (minutes) | Only after the player reveals playtime in the Character Summary tab |
| Quests: status, and time taken for quests started after install | `Quest.getState`, checked every 30 s and when quest points change | Changes only (everything on the first login) |
| Boss kill counts and personal bests | Saved by RuneLite's Chat Commands plugin (`killcount` / `personalbest` config) | Everything on the first login, then when they change |
| Clue completions per tier | "You have completed N elite Treasure Trails." chat message | When a clue is completed |
| Achievement diaries (12 regions × 4 tiers) | `*_DIARY_*_COMPLETE` / `ATJUN_*_DONE` varbits | With stats |
| Combat achievement points and tasks completed | `VarbitID.CA_POINTS`, `CA_TASK_COMPLETED_0..20` bitfields | With stats |
| Slayer points and task streak | `VarbitID.SLAYER_POINTS`, `SLAYER_TASKS_COMPLETED` | With stats |
| Level-up dates | `StatChanged`, from install onward | As they happen |
| XP gains (day/week/month) | The server keeps the first XP snapshot of each day | Server-side |

The world decides the board (`GameMode.java`, using RuneLite's own `HiscoreEndpoint.fromWorldTypes`). Normal worlds, Hardcore Worlds, Fresh Start, Leagues and Deadman are tracked. Beta, PvP Arena, quest speedrunning and tournament worlds are ignored. Ironman boards come from the account type.

Players are keyed by RuneLite's account hash, so a name change carries their history over. The first submission for an account gets a random token, which the plugin stores in the player's RuneScape profile config. Later submissions must send that token, so nobody else who learns the account hash can overwrite the account's data.
