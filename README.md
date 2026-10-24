# Hideout — Online Hide & Seek

A browser-based multiplayer hide-and-seek prototype using Cloudflare Workers, Durable Objects, and WebSockets.

## Features
- Private rooms with shareable room codes
- Host settings: play radius, ping interval, number of seekers
- Random role assignment at round start
- Real-time movement, player list, and temporary ping clues
- No account or signup required
- Responsive dark UI and stylized top-down forest map

## Run locally
Requires Node.js 20+.

```bash
npm install
npx wrangler login
npm run dev
```

Open the local URL printed by Wrangler in two or more browser tabs. Create a room in one tab and join with the room code in the other.

## Deploy to Cloudflare
1. Install dependencies with `npm install`.
2. Run `npx wrangler login`.
3. Run `npm run deploy`.
4. Follow the Wrangler prompts to create/enable the Durable Object and deploy the Worker.
5. Open the deployed `workers.dev` URL and share room codes with friends.

The `wrangler.toml` config serves `public/` as static assets and routes `/api/room/<CODE>` through the Worker to a Durable Object room.

## Controls
- Move: WASD or arrow keys
- Tag a nearby hider: E (seeker only)
- Room host: adjust settings (including 10-minute pings), start/end rounds

## Notes / prototype limitations
- This is an early playable prototype, not a hardened production service.
- Multiplayer state is live while players are connected; player accounts and persistent stats are not included.
- Ping clues are approximate, and hider coordinates are masked from seekers in the state messages.
- For a public launch, add rate limiting, stronger room-code allocation, reconnect handling, server-authoritative collision checks, and automated tests.
