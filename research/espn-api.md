# ESPN fantasy football API: what it exposes

Research for issue #6 (part of #1). Checked on 2026-10-02.

## Summary

- The API is **unofficial and undocumented**. ESPN publishes no developer docs or keys for it. Client libraries reverse-engineer the JSON that the ESPN web app uses.
- One league `GET` returns everything we need: teams and names, managers, win-loss records, standings rank, and the full schedule with weekly scores per matchup.
- Public leagues need no credentials. Private leagues need two browser cookies from a league member's ESPN login: `espn_s2` and `SWID`. There is no supported login flow for a server.
- A Cloudflare Worker can call it server-side with a `Cookie` header. The cookies must be stored as a Worker secret, not sent to browsers.
- No published rate limit. The Disney Terms of Use forbid automated access and commercial use, so we use it at our own risk, for one league, at low volume.

## Endpoints and data

Base URL (current, used by `espn-api`):
`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl` ([constant.py](https://github.com/cwendt94/espn-api/blob/master/espn_api/requests/constant.py)).
The older host `fantasy.espn.com/apis/v3/games/` stopped working for scripts in April 2024 ([espn-api #539](https://github.com/cwendt94/espn-api/issues/539)). On 2026-10-02 it returned `302` to `https://www.espn.com/fantasy/` (my `curl -sI` test).

| What | Request | Source |
|---|---|---|
| League, 2018 and later | `GET /seasons/{year}/segments/0/leagues/{leagueId}?view=...` | [espn_requests.py](https://github.com/cwendt94/espn-api/blob/master/espn_api/requests/espn_requests.py) |
| League, before 2018 | `GET /leagueHistory/{leagueId}?seasonId={year}` | same file |
| Season metadata | `GET /seasons/{year}` | my test: returned `currentScoringPeriod`, `startDate`, `endDate` |
| Weekly scores | `view=mMatchupScore` (optional `scoringPeriodId={week}`) | [league.py `scoreboard`](https://github.com/cwendt94/espn-api/blob/master/espn_api/football/league.py) |
| Box scores (player level) | `view=mMatchupScore&view=mScoreboard` | same file, `box_scores` |
| Initial load | `view=mTeam&view=mRoster&view=mMatchup&view=mSettings&view=mStandings` | `get_league` in espn_requests.py |

`view` can repeat. Some calls also send an `x-fantasy-filter` JSON header to filter players or transactions (espn_requests.py).

### Real response (public league 48153503, season 2019)

I fetched `.../seasons/2019/segments/0/leagues/48153503?view=mTeam&view=mStandings&view=mSettings&view=mMatchupScore`. This league ID comes from the `espn-api` test suite. It returned `200` and 106 KB of JSON. Top-level keys:
`draftDetail, gameId, id, members, schedule, scoringPeriodId, seasonId, segmentId, settings, status, teams`.

- **`teams[]`** (14 teams): `id`, `name`, `abbrev`, `logo`, `owners[]` (SWID GUIDs), `primaryOwner`, `playoffSeed`, `rankCalculatedFinal`, `rankFinal`, `points`, `divisionId`, and `record.overall` = `{wins, losses, ties, percentage, pointsFor, pointsAgainst, gamesBack, streakLength, streakType}`. Older leagues may use `location` + `nickname` instead of `name` ([team.py](https://github.com/cwendt94/espn-api/blob/master/espn_api/football/team.py)).
- **`members[]`**: `id` (SWID GUID), `displayName`, `firstName`, `lastName`. Join `teams[].owners[]` to `members[].id` to get manager names ([base_league.py](https://github.com/cwendt94/espn-api/blob/master/espn_api/base_league.py)).
- **`schedule[]`** (112 matchups): `id`, `matchupPeriodId` (the week), `winner` (`HOME`/`AWAY`/...), `playoffTierType`, and `home`/`away` = `{teamId, totalPoints, pointsByScoringPeriod, adjustment, tiebreak}`.
- **`status`**: `currentMatchupPeriod`, `finalScoringPeriod`, `latestScoringPeriod`, `isActive`, `previousSeasons[]`, `standingsUpdateDate`.
- **`settings`**: `name`, `size`, `isPublic`, `scheduleSettings`, `scoringSettings`, and more.

### What this means for Picks of Steel

- **Weighted draft lottery:** sort `teams[]` by `rankFinal`/`rankCalculatedFinal` when the season is over, else by `playoffSeed`. That is what `espn-api` does in `standings()` ([league.py](https://github.com/cwendt94/espn-api/blob/master/espn_api/football/league.py)). `record.overall` gives wins and points for tie-breaks or custom weights.
- **Matchup recap:** filter `schedule[]` by `matchupPeriodId == week`. Map `teamId` to `teams[]` and owners to `members[]`.
- **Season history:** call the same URL with an older `year`. Use `leagueHistory` for years before 2018. `espn-api` tries the other URL form when it gets `401` (espn_requests.py `checkRequestStatus`).

## Authentication

- Public leagues: no auth. The test above sent no cookies.
- Private leagues: send cookies `espn_s2` and `SWID`. `espn-api` builds `{"espn_s2": ..., "SWID": ...}` and passes it as cookies on every request ([base_league.py](https://github.com/cwendt94/espn-api/blob/master/espn_api/base_league.py)).
- Without them, a private league returns `401` with `"type":"AUTH_LEAGUE_NOT_VISIBLE"`, "You are not authorized to view this League." (my test on league 411647). An unknown league returns `404` `GENERAL_NOT_FOUND`.
- How to get them: a league member logs in to ESPN in a browser and copies both cookies from DevTools > Application > Cookies. The maintainers also point to an open-source Chrome extension that reads them ([discussion #150](https://github.com/cwendt94/espn-api/discussions/150)).
- No programmatic login: username/password login through Disney's `registerdisney.go.com` now needs reCAPTCHA. The code for it is commented out in espn_requests.py.
- The cookies are the member's full ESPN session. Treat them as a password.

## Server-side use from a Worker

- **Cookies:** a Worker `fetch()` can set any request header, including `Cookie: espn_s2=...; SWID={...}` ([Workers fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/), [Headers](https://developers.cloudflare.com/workers/runtime-apis/headers/)). Store both values as [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/), or per room in Durable Object storage if each league brings its own.
- **CORS:** CORS does not apply to server-side requests. For reference, the API reflects the request `Origin` and sends `access-control-allow-credentials: true` (my test with `Origin: https://picks.example.com`). A browser still could not send the ESPN cookies, because they belong to `espn.com`. So the call must go through the Worker.
- **Subrequest budget:** one league call gives standings and all weekly scores. That fits the 50-subrequest Free limit per invocation ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).
- **Caching:** league responses send `cache-control: must-revalidate` and `vary: origin,x-fantasy-filter,accept-encoding` (my test). Cache the result in the Durable Object, for example once per room or once per week.

## Limits and terms

- **Rate limits:** ESPN publishes none. 20 quick requests to the public league all returned `200` (my test). The responses come through Amazon CloudFront (`server: CloudFront`, `x-amz-cf-pop`).
- **Official status:** none. `developer.espn.com` only redirects to `espn.go.com` (my `curl` test). The `espn-api` discussion says "ESPN abandoned the idea years ago" ([discussion #150](https://github.com/cwendt94/espn-api/discussions/150)). `espn-api` itself (MIT, 984 stars, pushed 2026-10-02) is the de facto reference ([repo](https://github.com/cwendt94/espn-api)).
- **Breakage risk:** ESPN changed the host in 2024 without notice ([#539](https://github.com/cwendt94/espn-api/issues/539)). Expect more changes like this. Code should fail gracefully and allow manual standings entry.
- **Terms of use:** espn.com links to the [Disney Terms of Use](https://disneytermsofuse.com/english/). Relevant clauses:
  - 2.A: license is "for your personal, noncommercial use only".
  - 2.B.viii: no "commercial or business-related use".
  - 2.B.x: no access "using a robot, spider, script, or other automated means", including "data mining or web scraping".
  - 1.F: "you will not share your account or account information with others".
- My reading: a free tool that one league uses for its own data is low-profile. It still conflicts with 2.B.x on a literal reading, and storing a member's cookies conflicts with 1.F. This is not legal advice.

## Unverified

- I did not test a private league with real `espn_s2`/`SWID` cookies.
- I did not run the request from a deployed Cloudflare Worker. I do not know if ESPN or CloudFront blocks Cloudflare egress IPs.
- I did not find how long `espn_s2` stays valid. The maintainer says it "remains the same through different sessions" ([discussion #150](https://github.com/cwendt94/espn-api/discussions/150)). It probably ends when the user logs out or ESPN rotates sessions.
- I did not test the `leagueHistory` endpoint with a real pre-2018 league. Both IDs I tried returned `404`.
- I did not test a current (2026) league. All current-year IDs from the test suite were private or gone.
- The real rate limit and any bot detection at higher volume are unknown.
- Every field name comes from one 2019 league and the `espn-api` source. ESPN can change them.

## Sources

- espn-api source, commit `825ee9a`: https://github.com/cwendt94/espn-api
  - https://github.com/cwendt94/espn-api/blob/master/espn_api/requests/constant.py
  - https://github.com/cwendt94/espn-api/blob/master/espn_api/requests/espn_requests.py
  - https://github.com/cwendt94/espn-api/blob/master/espn_api/base_league.py
  - https://github.com/cwendt94/espn-api/blob/master/espn_api/football/league.py
  - https://github.com/cwendt94/espn-api/blob/master/espn_api/football/team.py
- espn-api wiki (cookie parameters): https://github.com/cwendt94/espn-api/wiki
- Finding `espn_s2`/`SWID`: https://github.com/cwendt94/espn-api/discussions/150
- Host change, April 2024: https://github.com/cwendt94/espn-api/issues/539
- Live responses (fetched 2026-10-02 with `curl`):
  - https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2019/segments/0/leagues/48153503?view=mTeam&view=mStandings&view=mSettings&view=mMatchupScore
  - https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2025
  - https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2025/segments/0/leagues/411647?view=mTeam (401)
- Disney Terms of Use (linked from espn.com, updated 2024-05-24): https://disneytermsofuse.com/english/
- Cloudflare Workers docs:
  - https://developers.cloudflare.com/workers/runtime-apis/fetch/
  - https://developers.cloudflare.com/workers/runtime-apis/headers/
  - https://developers.cloudflare.com/workers/platform/limits/
  - https://developers.cloudflare.com/workers/configuration/secrets/
