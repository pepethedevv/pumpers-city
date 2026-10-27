# Pumpers City

A pixel city on Solana you explore right in your browser. Find boxes hidden across seven districts, pick their locks, earn XP, and win real $PUMP.

Your Pumper NFT is your character. Your $PUMPERS and NFT holdings decide your level, walk speed and XP bonus.

## What's in here

| Path | What it is |
|---|---|
| `index.html` | The site: landing gate over the live city, the game HUD, and the "How it works" guide |
| `assets/game.js` | The game client (Phaser 3): seven districts, boxes, lock-picking, trails |
| `assets/site.js` | Landing gate, wallet connection (Phantom, Solflare, Backpack), Pumper picker |
| `assets/style.css` | Styles |
| `assets/config.js` | Public settings: contract address, mint link, X link |
| `api/access.js` | Serverless function: verifies the wallet's signed login and reads $PUMPERS and NFT holdings through Helius |
| `sprites/atlas.png` | In-game sprites of every Pumper (64 per row, 32×32) |
| `api/prizes.js` | Lists a wallet's prizes (and settles any payout still in flight) |
| `api/claim.js` | Claims one prize: verifies the signed claim, re-checks holdings, locks the prize, sends $PUMP from the prize wallet |
| `api/_lib.js` | Shared code: public addresses, access rules, signature checks, Helius and Supabase helpers |
| `db/supabase.sql` | Database: `prizes`, `players` (XP and leaderboard), `game_settings` (prize waves), `take_prize()` (run in Supabase; safe to run again) |
| `server/` | Multiplayer game server (Node + WebSocket) for Railway. Players see each other; boxes, lock timing, XP and prizes are decided here |

## Deploy

Hosted on Vercel with no build step. Every push to `main` deploys.

Secrets live only in Vercel (Settings → Environment Variables):

| Name | What |
|---|---|
| `HELIUS_API_KEY` | Wallet checks and payouts |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Prize records |
| `PRIZE_WALLET_SECRET` | Private key of the prize wallet that pays claims (keep only the current prize wave in it) |

The public addresses are set in code:

| Where | What | When |
|---|---|---|
| `api/_lib.js` → `ADDRESSES.NFT_COLLECTION` | Pumpers NFT collection | After the NFT mint |
| `api/_lib.js` → `ADDRESSES.PUMPERS_MINT` | $PUMPERS token | At token launch |
| `api/_lib.js` → `ADDRESSES.PRIZE_MINT` | The token prizes are paid in ($PUMP) | Before prizes go live |
| `assets/config.js` → `MINT_URL` | Mint page link (shows the MINT button) | When minting opens |
| `assets/config.js` → `CA` | Contract address shown on the landing page | At token launch |

While the two addresses are empty, connected wallets are told the token and NFTs aren't live yet, and everyone explores as a guest.

## Testing

Add `?demo=1` to the URL to try every level, NFT tier and trail.

## Prizes

Winners open **MY PRIZES** in the game and press **CLAIM**. They sign a free message, the server checks the signature and their holdings again, moves the prize from `ready` to `sending` in one atomic update (so a double click can't pay twice), stores the transaction signature before sending, and marks it `sent` once confirmed. If a send is rejected the prize goes back to `ready`; if it is still in flight, the next prize list refresh settles it from the stored signature.

Prizes are only ever created by the server. The browser never decides a prize outside test mode.

## Game server (`server/`)

Runs on Render (`render.yaml` Blueprint) or any Node host with Root Directory `server` (`npm start`). Variables: `HELIUS_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (`PORT` is set by the host).
Optional: `ALLOWED_SITES` (default `pumperscity.com`), `CHANNEL_CAP` (100), `MAX_PLAYERS` (600), `OPENS_PER_HOUR` (150), `BOXES_PER_ROOM` (120).

- Login: the same signed wallet message as the site, then holdings through Helius (re-checked every 5 minutes).
- Each district is split into channels of 100 players. Positions go only to players nearby, 10 times a second.
- Movement speed and walls are checked on the server; box opening needs you next to the box; lock timing is checked against the server's needle.
- Prize waves come from the `game_settings` row and go out in batches: `prizes_active` prize boxes are hidden at once, and the next batch is hidden only after all of them are found, until `prizes_left` runs out. Only the server knows which boxes they are.
- Daily leaderboard: ranks the day's XP (19:00–19:00 UTC, `RESET_HOUR_UTC`). At the reset the server saves XP and calls `award_daily()`, which puts `daily_top` prizes (1st, 2nd, 3rd) into the winners' MY PRIZES, once per day.
- `GET /status` → players online, total $PUMP won, recent winners (used by the landing page).

`server/mapgen.mjs` and `server/lib.mjs` are generated from the site's map code and `api/_lib.js` (`build_server.py`), so the server and the browser always agree on maps and rules.
The site connects when `GAME_SERVER` is set in `assets/config.js`; without it the game runs single player.
