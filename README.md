# Rocket Arena multiplayer server

One small Node server that:

- **serves the game** (`../rocket-league.html`), so friends only need a link
- **matchmakes**: the first player who clicks *PLAY → REAL PLAYERS* waits (in a training session);
  the next one joins and they go **1v1**
- runs the **map vote** (Golden Valley / Neon Nights / Frozen Peaks). Different votes = tie → random pick
- **relays** the match: the waiting player is the *host* (runs the physics), the joiner is the *guest*
  (sends inputs, receives smooth 30 Hz snapshots)

## Run

```bash
cd rocket-server
node server.js          # PORT=9000 node server.js to change the port (default 8787)
```

It prints links like:

```
This computer:   http://localhost:8787
Same Wi-Fi/LAN:  http://192.168.1.52:8787
```

Open one of them in two browsers/computers, press **PLAY → REAL PLAYERS** in both.

## Playing over the internet

Expose the port with a tunnel and share that link, e.g. `ngrok http 8787`.
(If you open `rocket-league.html` straight from disk, type the server address into the SERVER box on the
PLAY screen, e.g. `localhost:8787` or `my-tunnel.ngrok.app`.)

## Test

```bash
node test.js     # checks queue → match → vote/tie → start → relay → leave
```

## Notes

- Dependencies: only `ws` (already in `node_modules`).
- The guest sees the world ~0.1 s behind the host (snapshot interpolation) and its controls travel to the host and back,
  so it feels best on the same network or a low-ping connection.

## Family game pass
Same protocol as the other Marshellis room servers (`marshellis/game-generator` -> `docs/game-pass.md`; `pass.js` is the
byte-identical copy of `docs/room-kit/pass.js`). The game gets a pass with `mg.getPass('rocket-arena')` and connects to
`wss://rocket-arena-server.fly.dev/?pass=<token>`. A verified player's name comes only from the pass; the client sends
`{"type":"renew","pass":...}` about every 10 minutes; at expiry the server sends `{"type":"timeup"}` and closes with 4003.
No pass, or no `GAME_PASS_SECRET` on the app = guest (the typed name is used). `GAME_PASS_REQUIRED=1` refuses guests (4001).
To turn on verified names and play-time limits: `fly secrets set GAME_PASS_SECRET=<same value as the site's Vercel env> -a rocket-arena-server`.

## Hosting (Fly.io, family setup)
This repo deploys to Fly.io (org `marshellis`, app `rocket-arena-server`) with
`.github/workflows/deploy.yml` on every push to `main`, using the org-level `FLY_API_TOKEN` secret
(this repo is public so it can read it). The game page lives at
https://marshellis.com/arcade/rocket-league.html and connects to `wss://rocket-arena-server.fly.dev`.
The machine sleeps when idle and wakes in a few seconds on the next connection. Keep it at ONE
machine (`fly scale count 1`): matches live in memory.
Health check: `https://rocket-arena-server.fly.dev/health`.
