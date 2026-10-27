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

## Deploy

Hosted on Vercel with no build step. Every push to `main` deploys.

Environment variables (Vercel → Settings → Environment Variables):

| Name | When |
|---|---|
| `HELIUS_API_KEY` | Required for wallet checks |
| `NFT_COLLECTION` | After the NFT mint |
| `PUMPERS_MINT` | At token launch |

While `PUMPERS_MINT` and `NFT_COLLECTION` are empty, connected wallets are told the token and NFTs aren't live yet, and everyone explores as a guest.

## Testing

Add `?demo=1` to the URL to try every level, NFT tier and trail.
