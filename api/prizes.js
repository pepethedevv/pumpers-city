// GET /api/prizes?wallet=...  → the wallet's prizes (newest first)
// Prizes are public information (every payout is on-chain anyway), so no signature is needed to list them.
import bs58 from "bs58";
import { dbReady, db, reconcile } from "./_lib.js";

export default async function handler(req, res) {
  const wallet = String(req.query.wallet || "");
  try { if (bs58.decode(wallet).length !== 32) throw 0; } catch { return res.status(400).json({ error: "bad wallet" }); }
  res.setHeader("cache-control", "no-store");
  if (!dbReady()) return res.json({ live: false, prizes: [] });
  try {
    const rows = await db(`prizes?wallet=eq.${wallet}&select=id,amount,district,status,signature,last_valid_height,created_at,sent_at,note&order=created_at.desc&limit=100`);
    await reconcile(rows).catch(() => {});
    return res.json({ live: true, prizes: rows.map(({ last_valid_height, ...r }) => r) });
  } catch (e) {
    return res.status(502).json({ error: "could not load prizes" });
  }
}
