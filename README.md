# gta6-trophy-rarity-forecast-01

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/lusiana27/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/lusiana27/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

A forecaster for GTA VI's PlayStation 5 trophy earn rates on Exophase, one week after launch. It reads a case file (the house's reads of the game's trophy page up to a checkpoint) and writes five quantiles per trophy (5/25/50/75/95%) of the earn rate at the target.

The method: Exophase publishes a game's counts in batches, hours apart, and each batch adds newly tracked players who have played far less than the players already tracked, so every trophy's rate falls at a refresh. The program models that directly — a dilution step (newcomers bring far fewer trophies each, with a playtime fraction fitted to the refreshes the history shows) plus a progression step (the incumbents keep playing) — fits the player-count growth from the history, and reports asymmetric spreads, wider on the downside, because the player count can only grow. On the kit's practice cases it scores a pinball loss of about 0.30 against the persistence baseline's 1.40, with a typical median miss of 0.17 points.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only, no network. The same case file always produces the same bytes, in about 0.3 seconds.

---

<sub>Entered on [make.fun](https://make.fun/?ref=j11vkafs&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
