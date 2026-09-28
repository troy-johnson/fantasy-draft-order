# Draft Ice

A live, hockey-themed fantasy draft order race built for Cloudflare Workers + Durable Objects.

## V1

- Create a room with 2–20 manager names
- Share a room URL; no accounts required
- Participants can identify themselves in the live lobby
- Commissioner-only start control
- Synchronized deterministic race in every connected browser
- Late join/reconnect recovery from `seed + startAt`
- Seed commitment shown before the race and revealed afterward
- Durable Object room persistence + WebSocket Hibernation
- Final draft order and local replay

## Stack

- React 19 + Vite
- Cloudflare Worker Static Assets
- SQLite-backed Cloudflare Durable Object
- Durable Object WebSocket Hibernation API

## Local development

```bash
npm install
npm run check
npm run dev
```

`wrangler dev` serves both the Worker API and the built React app. Create a room at the URL Wrangler prints.

## Deploy

Authenticate Wrangler once:

```bash
npx wrangler login
```

Then deploy:

```bash
npm run deploy
```

Cloudflare provisions the `DraftRoom` SQLite Durable Object namespace from the declarative `exports` block in `wrangler.jsonc`.

## Optional custom domain

After the first deploy, attach a Workers custom domain in Cloudflare, or add a route/custom-domain configuration once you know the hostname you want to use.

## Fairness model

At room creation the server generates a cryptographically random seed and publishes only `SHA-256(seed)`. The seed is stored inside the room Durable Object and isn't sent to clients until the commissioner starts the race. The entire animation and finish order are deterministic functions of the revealed seed + entrant list.

Creating an entirely new room creates a new seed. A room itself cannot be re-rolled in V1.
