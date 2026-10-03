# Yahoo Fantasy Sports API: what it exposes

Research for issue #7 (part of #1). Sources were read on 2026-10-02. Every claim has a source number. The full URLs are in [Sources](#sources).

## Summary

- The API gives league standings (rank, wins, losses, ties, points for and against) and a weekly scoreboard (each matchup, both teams' weekly points, and the winner). This is enough for a weighted draft lottery and a matchup recap. [2]
- Access is not self-service now. You must apply to Yahoo, and Yahoo reviews each application. The API is read-only. [1][3]
- Authentication is the OAuth 2.0 authorization code flow. A server can keep a refresh token and get a new 1-hour access token when it needs one. [2][4]
- One league member's authorization is enough to read a private league. The documentation does not say that the commissioner or each manager must authorize. [2]
- The terms put three limits on Picks of Steel: no income without written permission, delete user data after 24 hours, and show "Fantasy data provided by Yahoo Fantasy" with the Yahoo Fantasy logo. [1][5]

## Endpoints and data

The base URL is `https://fantasysports.yahooapis.com/fantasy/v2`. [2]

The documentation shows the responses as XML. [2]

### Keys

| Key | Format | Example |
|---|---|---|
| Game (one sport, one season) | `{game_id}` or `{game_code}` | `461` (NFL 2025), `nfl` |
| League | `{game_key}.l.{league_id}` | `461.l.1000` |
| Team | `{league_key}.t.{team_id}` | `461.l.1000.t.1` |

A `game_code` such as `nfl` gives the current season. A `game_id` identifies one season. [2]

### League data

| Need | Endpoint | Data in the documented sample |
|---|---|---|
| League details | `/league/{league_key}` (metadata) | name, `num_teams`, `scoring_type`, `current_week`, `start_week`, `end_week`, `is_finished`, `season`, `renew`, `renewed` [2] |
| Standings | `/league/{league_key}/standings` | each team: `rank`, `playoff_seed`, `outcome_totals` (`wins`, `losses`, `ties`, `percentage`), `streak`, `points_for`, `points_against`, `draft_position` [2] |
| Weekly matchups and scores | `/league/{league_key}/scoreboard;week={week}` | each matchup: `week`, `status`, `is_playoffs`, `is_consolation`, `is_tied`, `winner_team_key`, `matchup_recap_title`, `matchup_grades`; each team: `team_points` and `team_projected_points` for the week, `win_probability` [2] |
| One team's matchups | `/team/{team_key}/matchups;weeks=1,3,6` | matchups for the given weeks (H2H leagues) [2] |
| Team weekly points | `/team/{team_key}/stats;type=week;week={week}` | week stats and points [2] |
| Teams and managers | `/league/{league_key}/teams` | team `name`, `team_logos`, `managers` [2] |
| Settings | `/league/{league_key}/settings` | draft type, scoring type, roster positions, divisions [2] |
| Draft results | `/league/{league_key}/draftresults` | draft picks for all teams [2] |

You can combine sub-resources in one request with `;out=`, for example `/league/{league_key};out=settings,standings`. [2]

### Manager and team names

The team resource contains `name` (the team name) and a `managers` list. The documentation says that a team "can be managed by either one or two managers". [2]

In the documented samples, each manager entry has only `manager_id`. The samples come from a public league. The documentation does not show a manager nickname field. See [Unverified](#unverified). [2]

### Past seasons

Each season of a sport has its own `game_id`. For example, NFL 2025 is `461` and NFL 2020 is `399`. [2]

- To find the `game_id` for a season, call `/games;game_codes=nfl;seasons=2024`. [2]
- To list all seasons of a sport, call `/games;game_codes=nfl`. [2]
- To list the leagues of the signed-in user, call `/users;use_login=1/games/leagues`. You can filter by `game_keys`. [2]

The league metadata has `renew` and `renewed` fields. These probably link a league to its previous and next season. The documentation does not explain them. [2]

## Authentication

### App registration (current process)

1. Read the API documentation. [1]
2. Apply at `https://sports.yahoo.com/developer/access/`. The form asks for the product, the data that you need, the expected users, and if the use is "personal or single league". [3]
3. Wait for review. Yahoo says: "If you're approved, we'll follow up with next steps." [1]
4. If you already have a Yahoo Developer Network (YDN) app, enter its Client ID in the form. If not, leave it blank. Yahoo provisions access after approval. [3]

Yahoo closes incomplete applications "without further correspondence". [3]

The documentation also gives the older path: create an app at `https://developer.yahoo.com/apps/create/`, ask for private user data, and select Fantasy Sports Read or Read/Write. [2] The app needs a name, a type, a home page URL, scopes, and an application domain. [4] The current access page says write access "is not available at this time". [3]

### OAuth 2.0 authorization code flow

1. Send the user to `https://api.login.yahoo.com/oauth2/request_auth` with `client_id`, `redirect_uri`, `response_type=code`, and an optional `state`. [4]
2. The user signs in to Yahoo and approves. Yahoo redirects to `redirect_uri` with `code` and `state`. [4]
3. The server sends a POST to `https://api.login.yahoo.com/oauth2/get_token` with `grant_type=authorization_code`, `code`, and `redirect_uri`. Authenticate with `Authorization: Basic base64(client_id:client_secret)`. [4]
4. The response has `access_token` (`expires_in: 3600`, one hour) and `refresh_token`. [4]
5. When the access token expires, send a POST to the same endpoint with `grant_type=refresh_token`. [4]

A user must sign in through a browser. There is no flow without a browser. [6]

### Who must authorize

"A particular user can only retrieve data for private leagues of which they are a member, or for public leagues." [2] The same rule applies to teams. [2]

So the token of any one league member can read the whole league: standings, scoreboard, and all teams. The documentation gives the commissioner no special read role. Other managers do not need to authorize for read access. [2]

## Server-side use from a Worker

Yahoo says that the authorization code flow is for "a server-side (Web) application". [4] A Cloudflare Worker can do every step: the redirect, the token exchange with `fetch`, and the refresh. The flow needs only HTTPS POSTs with form bodies. [4]

Rules for storing the tokens:

- Store the refresh token. Yahoo says: "You should store the refresh token for future use." [4]
- Always save the newest refresh token. Yahoo can issue a new refresh token and then revoke the old one. [4][6]
- The user must authorize again only if they revoke access in Yahoo account settings. [4]
- A password change revokes all refresh tokens. [6] The authorization code page says the opposite ("persists even when the user changes passwords"). [4] Plan for the FAQ behavior: if the refresh fails, ask the user to sign in again.
- Keep the client secret secret. Yahoo says that anyone with it "could masquerade as your application". [2]

A Durable Object is a good place to keep one league's refresh token, so that only one refresh runs at a time. This is a design suggestion. Yahoo does not say it.

The terms also require you to log access to your systems and to encrypt the files that hold usernames and passwords of systems that keep Yahoo user data. [5]

## Limits and terms

### Rate limits

Yahoo does not publish a number.

- The Fantasy page says that Yahoo can "temporarily throttle or limit access" when usage is "excessive over the course of short periods of time". [1]
- The general terms say that rate limits are "at Yahoo's absolute and sole discretion". [5]
- The terms forbid use that "exceeds reasonable request volume". [5]
- The sample responses contain `refresh_rate="60"`. The documentation does not explain this attribute. [2]

### Terms that affect Picks of Steel

| Rule | Effect on Picks of Steel | Source |
|---|---|---|
| You may not "derive income from the use or provision of the Yahoo APIs" without written permission from Yahoo. | A free app for one league is safe. Ads or payments need permission. | [5] |
| You must delete Yahoo user data within 24 hours, unless the API documents say that the data is "storable indefinitely". | Do not keep a league archive of standings or scores. Get the data again when a room needs it. | [5] |
| You may not show user data to a third party without the user's permission and a privacy policy that says so. | A room link that shows standings needs a privacy policy and consent from the authorizing member. | [5] |
| You may not share Yahoo GUIDs with a third party. | Do not put GUIDs in room state that goes to clients. | [5] |
| You must have a privacy policy that is easy to find. | Add one before launch. | [5] |
| You must show "Fantasy data provided by Yahoo Fantasy", link to Yahoo Fantasy, and include the official logo without changes. | Add an attribution line and logo to screens that show Yahoo data. | [1] |
| You may make only one developer account and one API key for each application. | Use one app for all environments, or ask Yahoo. | [1][5] |
| You may not use the API in a product that competes with Yahoo without permission. | Not checked against this app. See [Unverified](#unverified). | [5] |
| You may not "separate its underlying data". | The meaning is not clear. | [1] |

To get access, developers must agree to the "API Access and Use Agreement". [1]

## Unverified

- **JSON output.** The documentation shows only XML. I did not find a documented `format=json` parameter. I did not test it.
- **Manager nicknames.** The samples show only `manager_id`. I did not see a `nickname` field in the documentation. A private league response may contain more fields. I did not call the API.
- **`renew` and `renewed`.** I did not find how these fields link a league to past seasons.
- **The API Access and Use Agreement.** I did not find a public copy of this agreement. It may contain more rules than the general terms. [1]
- **Refresh token lifetime.** Yahoo says only that it has "a long lifetime". [4]
- **Approval for a small personal app.** I do not know if Yahoo approves single-league hobby apps, or how long the review takes. The form lists "personal or single league use" as a choice. [3]
- **Competition rule.** I did not check if Yahoo would see a draft lottery as a product that competes with its own features.
- **24-hour rule.** I did not find which data, if any, the API documents mark as "storable indefinitely".
- **Rate limit numbers.** Yahoo publishes none.

## Sources

1. Yahoo Fantasy API (access process, policies, attribution): https://sports.yahoo.com/developer/ (redirect target of https://developer.yahoo.com/fantasysports/guide/)
2. Yahoo Fantasy Sports API Documentation: https://sports.yahoo.com/developer/docs/
3. Apply for Yahoo Fantasy Sports API Access: https://sports.yahoo.com/developer/access/
4. Yahoo OAuth 2.0, Authorization Code Flow for Server-side Apps: https://developer.yahoo.com/oauth2/guide/flows_authcode/
5. Yahoo Developer API Terms of Use (REV 3-2022): https://policies.yahoo.com/us/en/yahoo/terms/product-atos/apiforydn/index.htm
6. Yahoo OAuth 2.0 FAQ: https://developer.yahoo.com/oauth2/guide/faq/
