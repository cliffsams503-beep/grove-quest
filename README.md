# Gemlight Keep

Co-op gem-hunting platformer: 15 levels (bosses on 5, 10 and 15), 20 heroes, local 2-player co-op and online rooms of up to 4 players.

## Run
    npm install
    npm start            # or: PORT=8080 node server.js
Open http://localhost:8080. On Render, use a Web Service with build command `npm install` and start command `npm start`. Render sets `PORT`. The page and the WebSocket (`/ws`) share that one port, and the client builds its socket URL from `location` (wss:// on https).

## Environment
| Var | Default | Meaning |
|---|---|---|
| `PORT` | 8080 | HTTP + WebSocket port (binds 0.0.0.0) |
| `GK_DEV` | off | `1` lets `?dev=1` grant 99,999 test points. Keep it off in production. |
| `GK_DAILY_CAP` | 600 | Max points a profile can earn per day (midnight Pacific reset) |
| `GK_DATA` | `./data/profiles.json` | Profile store (JSON file) |
| `GK_REG_LIMIT` | 5 | New profiles per IP per hour |

**Note:** profiles are saved to local disk (`data/profiles.json`). On Render's default filesystem they **reset on every redeploy or restart**. Attach a persistent disk and point `GK_DATA` at it to keep them.

## Controls
| | P1 (or solo) | P2 |
|---|---|---|
| Move | A / D | ← / → |
| Jump | W (Space in 1P) | ↑ |
| Attack | F | K or Numpad1 |
| Item (potion) | G | L or Numpad2 |
| Interact / revive (hold) | S | ↓ |
| Special (Nyx: Shadow Step) | E | J or Numpad3 |

Gamepads work too: stick/D-pad move, A jump, X attack, B item, Y/RB special, down interact. Esc pauses.

## Points
Points are earned only in online rooms and checked by the server: level clear 10 + 10×difficulty, round win (most gems collected that level, 2+ players) 15, boss kill 50 + 25×difficulty. 1P and Local Co-op can play anything already unlocked but earn nothing. Points are in-game only, with no currency, wallet or payout.
