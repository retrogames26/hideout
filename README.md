# Hideout — Real-World GPS Hide & Seek

A browser-based multiplayer hide-and-seek prototype using Cloudflare Workers, Durable Objects, WebSockets, browser GPS, and OpenStreetMap.

## Features
- Private rooms with shareable room codes; no account required
- Live GPS player markers on an OpenStreetMap street map
- Browser location permission requested for the host's hiding-zone centre and for active-round tracking
- Host-configurable hiding-zone centre and radius (100–2000 metres)
- Server-side distance checks flag players outside the configured hiding zone and ping seekers with an approximate location when a hider crosses the boundary
- GPS locations are broadcast only to members of the active room while a round is playing
- Browser GPS watch is stopped when the round ends, the player leaves, or the WebSocket closes
- Random seeker assignment, player list, and seeker tagging within 15 metres
- Responsive interface

## Run locally
Requires Node.js 20+.

```bash
npm install
npx wrangler login
npm run dev
```

Open the local URL printed by Wrangler in two or more browser tabs. Create a room in one tab, share the room code, and join from another device or tab. GPS requires a secure context; use HTTPS in deployed environments, and use localhost for local testing.

## Deploy to Cloudflare
1. Install dependencies with `npm install`.
2. Run `npx wrangler login`.
3. Run `npm run deploy`.
4. Follow Wrangler's prompts to create/enable the Durable Object and deploy the Worker.
5. Open the deployed `workers.dev` URL and share room codes with friends.

This repository is a **Cloudflare Worker** project, not a static Pages build. The `wrangler.toml` config serves `public/` as static assets and routes `/api/room/<CODE>` through the Worker to a Durable Object room. Do not put `npx wrangler deploy` in a Pages output-directory field.

## How to play
1. Create a room and share its code.
2. The host selects a radius and clicks **Set hiding zone to my location** (or clicks a point on the map) to choose the centre.
3. Start with at least two players. Every player must allow location permission for live GPS tracking.
4. Player locations appear on the map while the round is active. The host can end the round to stop location sharing.
5. Seekers can press `E` to tag a hider within 15 metres.

## Privacy and safety
- The browser asks for location permission; users can deny it or revoke it in browser settings.
- Exact GPS coordinates are not sent in the lobby/waiting phase. During an active round, coordinates are sent only to connected players in that room.
- Location sharing stops on round end, leaving the room, or connection closure. Reloading or closing the browser also ends the local GPS watch.
- The host-selected hiding-zone centre and radius are visible to room members.
- This is a prototype, not a safety-critical geofence. GPS accuracy varies and the client can potentially spoof location. The server flags locations outside the circle but does not physically prevent movement.
- Play only in an agreed outdoor area, get everyone's consent, obey local laws, avoid roads and traffic, and never trespass. Do not use this to track people without their knowledge.

## OpenStreetMap
Map tiles are provided by OpenStreetMap contributors. See https://www.openstreetmap.org/copyright for attribution and tile usage policy.

## Prototype limitations
- No accounts, persistent stats, anti-cheat, or production-grade reconnect flow.
- Players need a GPS-capable device/browser and a secure HTTPS context for geolocation.
- Do not treat the map or GPS boundary as a substitute for real-world supervision.
