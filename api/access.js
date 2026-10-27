// POST /api/access  { wallet, message, signature(base64) }
// 1) checks the wallet really signed the login message
// 2) reads $PUMPERS balance and Pumpers NFTs through Helius
// 3) returns the player's level and whether they can open boxes
// Addresses and access rules live in api/_lib.js. HELIUS_API_KEY is a Vercel environment variable.
import { addr, decide, verifyLogin, hostOf, holdings } from "./_lib.js";
export { decide, verifyLogin } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { wallet, message, signature } = req.body || {};
  const err = verifyLogin(wallet, message, signature, hostOf(req));
  if (err) return res.status(401).json({ error: err });

  if (!addr("PUMPERS_MINT") && !addr("NFT_COLLECTION")) return res.json({ live: false, wallet });
  if (!process.env.HELIUS_API_KEY) return res.status(500).json({ error: "server not configured" });
  try {
    const { tokens, nfts } = await holdings(wallet);
    res.setHeader("cache-control", "no-store");
    return res.json({ live: true, wallet, tokens, nfts, access: decide(tokens, nfts) });
  } catch (e) {
    return res.status(502).json({ error: "holdings check failed" });
  }
}
