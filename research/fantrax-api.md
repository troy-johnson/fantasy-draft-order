# Research: What does the Fantrax API expose?

Issue: [#8](https://github.com/troy-johnson/fantasy-draft-order/issues/8) (part of #1).
Date checked: 2026-10-02.

## Summary

- Fantrax has an official REST API, documented at https://www.fantrax.com/developer as "API Documentation v1.8 (Beta)". The document calls itself "a draft document that has basic usage information".
- It gives us what we need. `getStandings` returns rank, W-L-T, win %, games back, and points for. `getMatchupScores` returns the away and home team and score for each matchup in a scoring period. Any past period of the current season is available.
- The league endpoints take only a `leagueId`. I got standings, matchup scores, and league info for one real league with no login, no cookie, and no key. Only `getLeagues` needs a key: the user's `userSecretId`.
- A plain server-side `fetch` works if it sends a `User-Agent` header. With an empty `User-Agent`, Cloudflare in front of Fantrax returned a 403 challenge. I saw no rate-limit headers and no throttling in 30 quick calls.
- The API returns team names, not manager names. I found no documented endpoint for past seasons. The Terms of Service forbid scraping and say not to access the service "except through the interface provided by Company". The documented `/fxea` API is such an interface; the undocumented `/fxpa/req` endpoint that client libraries use probably is not.

## Endpoints and data

The official API is at `https://www.fantrax.com/fxea/general/<method>`. Parameters go in the query string, or as JSON in a POST body. All responses are JSON. ([Fantrax developer docs](https://www.fantrax.com/developer))

| Endpoint | What it returns (per docs) | Use for Picks of Steel |
| --- | --- | --- |
| `getLeagues?userSecretId=` | The user's leagues (name, ID) and the team(s) that the user owns in each. | Let a manager find their league ID. |
| `getLeagueInfo?leagueId=` | Team names and IDs, the matchup schedule, players, settings, `rosterPeriods`, `scoringPeriods` (number, startDate, endDate), `scoringSystem.type`, and the `playoffs` setup. Option `excludePlayerInfo=true` cuts the payload. | Team list, period dates, playoff cut line. |
| `getStandings?leagueId=` | "The current standings of the league", with rank, points, W-L-T, games back, win %. The docs list no parameters. | Weights for the draft lottery. |
| `getMatchupScores?leagueId=&period=N` | For each head-to-head matchup: away and home team (ID, name), fantasy point total, `gamesPlayed`, and a per-category breakdown. Default is the current period with live scores. Head-to-head leagues only. | Weekly matchup recap. |
| `getTeamRosters?leagueId=&period=N` | All rosters, players, statuses, positions, salary and contract data. | Not needed now. |
| `getDraftPicks`, `getDraftResults` | Future and current picks; draft results, live during a draft. | Possible later use. |
| `getPlayerIds`, `getAdp` | Player IDs and ADP by sport. | Not needed. |

Source for every row: https://www.fantrax.com/developer. The page renders in the browser, so I read its text from the JavaScript bundle that `https://www.fantrax.com/developer` loads.

### What I saw in live responses

I called the API with league `usglqmvqmelpe6um`. That league ID is the example in the [meisnate12/FantraxAPI README](https://github.com/meisnate12/FantraxAPI).

- `getStandings` returned a JSON array. Each item had `teamName`, `teamId`, `rank`, `points` (a W-L-T string such as `"18-4-0"`), `winPercentage`, `gamesBack`, and `totalPointsFor`.
- `getMatchupScores` returned `{"matchups":[{"away":{"teamName","teamId","score","gamesPlayed"},"home":{...},"categories":[...]}]}`.
- `getLeagueInfo` returned these top-level keys: `matchups`, `rosterInfo`, `endDate`, `poolSettings`, `rosterPeriods`, `scoringPeriods`, `teamInfo`, `draftType`, `draftSettings`, `leagueName`, `leagueHistoryId`, `scoringSystem`, `seasonYear`, `startDate`, `playoffs`.
- `teamInfo` entries had only `name` and `id`. `matchups` entries had `name`, `id`, and `shortName`. No field held a manager or owner name.

Commands (run from macOS with curl 8.7.1):

```sh
curl -s "https://www.fantrax.com/fxea/general/getStandings?leagueId=usglqmvqmelpe6um"
curl -s "https://www.fantrax.com/fxea/general/getMatchupScores?leagueId=usglqmvqmelpe6um"
curl -s "https://www.fantrax.com/fxea/general/getLeagueInfo?leagueId=usglqmvqmelpe6um&excludePlayerInfo=true"
```

### Manager names

The league endpoints give team names only. `getLeagues` returns "the name(s) and ID(s) that the user owns in each league", but only for the one user whose `userSecretId` you send ([docs](https://www.fantrax.com/developer)). So the app can map a manager to a team only if each manager connects their own secret ID, or if the room creator types the names.

### Past seasons

The docs list no history endpoint and no season parameter ([docs](https://www.fantrax.com/developer)). `getLeagueInfo` returns `seasonYear` and `leagueHistoryId` (seen live). I think that each Fantrax season has its own league ID, joined by `leagueHistoryId`, but I did not verify this. Past periods of the current season are available through `period=N` on `getMatchupScores` and `getTeamRosters`.

### The unofficial endpoint

The Python library [meisnate12/FantraxAPI](https://github.com/meisnate12/FantraxAPI) calls itself "Unofficial Python bindings". It does not use `/fxea`. It POSTs `{"msgs":[{"method":..., "data":{...}}]}` to `https://www.fantrax.com/fxpa/req`, which is the web app's own backend ([api.py](https://github.com/meisnate12/FantraxAPI/blob/master/fantraxapi/api.py)). Methods include `getStandings` (views such as `SCHEDULE`), `getFantasyLeagueInfo`, `getTeamRosterInfo`, `getLiveScoringStats`, and `getTradeBlocks`. Errors come back as `pageError.code`, for example `WARNING_NOT_LOGGED_IN` or `NOT_MEMBER_OF_LEAGUE` (same file). We do not need this endpoint, because `/fxea` now has standings and matchup scores.

The Go library [pmurley/go-fantrax](https://github.com/pmurley/go-fantrax) wraps `/fxea` and says it is "current as of documentation provided from Fantrax in April 2025". Its README does not list `getMatchupScores`, so Fantrax probably added that endpoint after April 2025.

## Authentication

- **League endpoints (`/fxea`)**: the docs list no auth parameter for `getLeagueInfo`, `getStandings`, `getMatchupScores`, `getTeamRosters`, `getDraftPicks`, or `getDraftResults` ([docs](https://www.fantrax.com/developer)). My calls with only `leagueId` succeeded.
- **`getLeagues`**: needs `userSecretId`, "the Secret ID shown on the Fantrax User Profile screen" ([docs](https://www.fantrax.com/developer)). With a fake ID, the API returned `{}`.
- **No API keys or OAuth**: the docs describe no app key, token, or OAuth flow ([docs](https://www.fantrax.com/developer)).
- **Public vs private leagues**: the docs do not say whether `/fxea` works for private leagues. The meisnate12 README says a private league, or private pages of a public league, needs a login cookie on `/fxpa/req`. It also says the author "was unable to decipher the api login method" and used Selenium to log in ([README](https://github.com/meisnate12/FantraxAPI)). Live, `/fxpa/req` `getTradeBlocks` returned `WARNING_NOT_LOGGED_IN` for the test league. `getStandings` and `getFantasyLeagueInfo` on `/fxpa/req` worked without login and reported `"isMember": false`.
- **Bad league ID**: `/fxea` returns HTTP 200 with a JSON `error` object, for example `{"error":{"code":"NO_LEAGUE","message":"This league does not exist..."}}`. Check the body, not only the status code.

## Server-side use from a Worker

- Fantrax runs behind Cloudflare. Responses had `server: cloudflare` and a `cf-ray` header.
- A request with an empty `User-Agent` got HTTP 403 with `cf-mitigated: challenge`. Requests with `User-Agent` set to `curl/8.7.1`, `node`, or `picks-of-steel/0.1 (+https://github.com/troy-johnson/fantasy-draft-order)` got HTTP 200.
- The API sends `cache-control: no-store`. The Worker or Durable Object must cache results itself.
- The API is read-only JSON over HTTPS GET, so it fits `fetch()` in a Worker. No cookie jar or browser login is needed for the `/fxea` league endpoints.
- I ran these tests from a home connection, not from a Worker. Cloudflare bot rules can treat Worker egress IPs differently. Test once from a deployed Worker before building on this.

Recommendation: always set an explicit `User-Agent` on the Worker `fetch`. Fetch standings once when a room is created, and store the snapshot in the Durable Object.

## Limits and terms

- **Rate limits**: the docs do not state any ([docs](https://www.fantrax.com/developer)). Responses had no `RateLimit-*` or `Retry-After` headers. 30 calls in a row all returned 200.
- **Status**: the API is official but in beta. The docs say it "has been built, and will continue to be built based on users' needs" and that "a more complete document will be available in the future" ([docs](https://www.fantrax.com/developer)).
- **Terms of Service** ([https://www.fantrax.com/terms-of-service](https://www.fantrax.com/terms-of-service)):
  - "Your account is for your personal, non-commercial use only."
  - Users must not "use manual or automated software, devices, or other processes to 'crawl,' 'scrape,' or 'spider' any page of the Company Service".
  - 8.7: "you will not access the Company Service by any means except through the interface provided by Company".
  - 8.7: "Running or displaying ... any information or material displayed via the Company Service ... on another website or application without the prior authorization of Company is prohibited."
- **My reading** (not legal advice): the published `/fxea` API is an interface that Fantrax provides, so calling it is lower risk than scraping or using `/fxpa/req`. The display clause in 8.7 could cover showing Fantrax standings in our app. The developer docs do not grant a separate license. For a free tool for one league, the risk looks low. For anything public or commercial, ask Fantrax first.

## Unverified

- Whether `/fxea` league endpoints work for a **private** league without auth. I had no private league ID to test.
- Whether calls from a **deployed Cloudflare Worker** pass Fantrax's Cloudflare bot rules. I tested only from a home IP with curl.
- Whether a Worker `fetch` sends a `User-Agent` by default. I did not check this. Set one explicitly.
- Whether `getStandings` accepts a `period` or season parameter. The docs list none, and I did not test any.
- How past seasons link together through `leagueHistoryId`, and whether a past season's league ID still answers `/fxea` calls.
- The format of `getStandings` and `getMatchupScores` for rotisserie, points-only, and category leagues. I tested one hockey head-to-head points league.
- Any real rate limit, and any terms specific to the API beyond the general Terms of Service.
- The "Last Updated" date of the Terms of Service. The text refers to it, but I did not extract it.

## Sources

- Fantrax API docs v1.8 (Beta): https://www.fantrax.com/developer
- Fantrax Terms of Service: https://www.fantrax.com/terms-of-service
- meisnate12/FantraxAPI README (unofficial Python client, private-league cookie login): https://github.com/meisnate12/FantraxAPI
- meisnate12/FantraxAPI `/fxpa/req` calls and error codes: https://github.com/meisnate12/FantraxAPI/blob/master/fantraxapi/api.py
- meisnate12/FantraxAPI standings fields: https://github.com/meisnate12/FantraxAPI/blob/master/fantraxapi/objs/standings.py
- pmurley/go-fantrax (Go client for `/fxea`, April 2025 docs): https://github.com/pmurley/go-fantrax
- Live responses: `https://www.fantrax.com/fxea/general/getStandings?leagueId=usglqmvqmelpe6um`, `.../getMatchupScores?leagueId=usglqmvqmelpe6um`, `.../getLeagueInfo?leagueId=usglqmvqmelpe6um&excludePlayerInfo=true` (called 2026-10-02)
