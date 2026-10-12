# Last Stand

A browser first-person shooter built with Next.js and three.js.

- **Online PvP** — free-for-all deathmatch, up to 8 players per room, first to 20 kills. Quick match or private rooms with a 4-letter code / invite link.
- **Solo practice** — survive waves of bots. Best score is saved in your browser.

No database: rooms and scores live in the game server's memory and disappear when a room empties.

## Run locally

```bash
npm install
npm run dev        # http://localhost:3000 — page and game server on one port
```

Open two browser windows to play against yourself.

## How it works

- `server.ts` — one Node process serves the Next.js app and the game WebSocket at `/ws`.
- `server/game-server.ts` — authoritative game server: rooms, health, damage, kills, respawns, match resets. It validates every hit against the target's recent positions, so clients can't claim impossible shots.
- `lib/game/` — arena layout and wire protocol shared by client and server.
- `components/fps/` — the client: three.js engine, network client, HUD and menus.

## Deploy

Multiplayer needs a long-running server that holds WebSocket connections, so deploy to a host that runs Node processes — **Render, Railway, Fly.io, or any VPS**. (Vercel's serverless functions can't hold WebSockets; there the page would load but online play wouldn't connect.)

- Build command: `npm install && npm run build`
- Start command: `npm start`
- The server listens on `PORT` (set automatically by most hosts). Health check: `/healthz`.
- Run a single instance: rooms are in memory, so players must reach the same process.

To host the game server separately from the page, set `NEXT_PUBLIC_GAME_SERVER_URL` (e.g. `wss://game.example.com/ws`) at build time.
