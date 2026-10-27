// POST /api/access  { wallet, message, signature(base64) }
// 1) checks the wallet really signed the login message
// 2) reads $PUMPERS balance and Pumpers NFTs through Helius
// 3) returns the player's level and whether they can open boxes
//
// HELIUS_API_KEY is secret: it lives only in Vercel → Settings → Environment Variables.
// The token and collection addresses are public, so they are kept right here in the code.
// Fill them in at launch (a Vercel environment variable with the same name still wins if set).
export const ADDRESSES = {
  PUMPERS_MINT: "",     // $PUMPERS token address (at token launch)
  NFT_COLLECTION: "",   // Pumpers NFT collection address (after the mint)
};
import nacl from "tweetnacl";
import bs58 from "bs58";

// ---- access rules (change here if the thresholds are lowered later) ----
export const MIN_TOKENS = 1_000_000;          // no NFT
export const MIN_TOKENS_WITH_NFT = 500_000;   // Common / Rare / Epic NFT
export const NFTS_FOR_FREE_ACCESS = 10;       // this many NFTs need no tokens
export const TRAIL_TOKENS = 20_000_000;       // 2% of supply → gold trail
const TOKEN_LEVELS = [[20_000_000, "oneofone"], [10_000_000, "legendary"], [5_000_000, "epic"], [2_500_000, "rare"], [1_000_000, "common"]];
const RANK = { none: 0, common: 1, rare: 2, epic: 3, legendary: 4, oneofone: 5 };
const fmt = n => Math.floor(n).toLocaleString("en-US");

export function decide(tokens, nfts) {
  const best = nfts.reduce((b, n) => (RANK[n.tier] > RANK[b] ? n.tier : b), "none");
  const tokenLevel = (TOKEN_LEVELS.find(([n]) => tokens >= n) || [0, "none"])[1];
  const level = RANK[tokenLevel] >= RANK[best] ? tokenLevel : best;
  let canOpen = false, reason;
  if (tokens >= MIN_TOKENS) { canOpen = true; reason = "You hold enough $PUMPERS to open boxes."; }
  else if (RANK[best] >= RANK.legendary) { canOpen = true; reason = `Your ${best === "oneofone" ? "1/1" : "Legendary"} NFT opens boxes without tokens.`; }
  else if (nfts.length >= NFTS_FOR_FREE_ACCESS) { canOpen = true; reason = `Holding ${nfts.length} Pumpers NFTs opens boxes without tokens.`; }
  else if (nfts.length && tokens >= MIN_TOKENS_WITH_NFT) { canOpen = true; reason = `Your NFT plus ${fmt(MIN_TOKENS_WITH_NFT)}+ $PUMPERS opens boxes.`; }
  else if (nfts.length) reason = `With your NFT you need ${fmt(MIN_TOKENS_WITH_NFT)} $PUMPERS to open boxes. You have ${fmt(tokens)}.`;
  else reason = `To open boxes you need ${fmt(MIN_TOKENS)} $PUMPERS, or a Pumpers NFT plus ${fmt(MIN_TOKENS_WITH_NFT)}. You have ${fmt(tokens)}. You can still explore.`;
  return { canOpen, level, trail: best === "oneofone" || tokens >= TRAIL_TOKENS, reason };
}

export function verifyLogin(wallet, message, signatureB64, host) {
  let pub;
  try { pub = bs58.decode(wallet); } catch { return "bad wallet"; }
  if (pub.length !== 32) return "bad wallet";
  const lines = String(message || "").split("\n");
  if (lines[0] !== "Pumpers City login" || lines[1] !== "Wallet: " + wallet) return "bad message";
  const site = (lines.find(l => l.startsWith("Site: ")) || "").slice(6);
  if (host && site.replace(/^www\./, "") !== host.replace(/^www\./, "")) return "wrong site";
  const t = Date.parse((lines.find(l => l.startsWith("Time: ")) || "").slice(6));
  if (!t || Math.abs(Date.now() - t) > 10 * 60 * 1000) return "login expired, please try again";
  const ok = nacl.sign.detached.verify(new TextEncoder().encode(message), new Uint8Array(Buffer.from(String(signatureB64), "base64")), pub);
  return ok ? null : "signature check failed";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { wallet, message, signature } = req.body || {};
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const err = verifyLogin(wallet, message, signature, host);
  if (err) return res.status(401).json({ error: err });

  const mint = process.env.PUMPERS_MINT || ADDRESSES.PUMPERS_MINT, coll = process.env.NFT_COLLECTION || ADDRESSES.NFT_COLLECTION, key = process.env.HELIUS_API_KEY;
  if (!mint && !coll) return res.json({ live: false, wallet });
  if (!key) return res.status(500).json({ error: "server not configured" });

  const rpc = `https://mainnet.helius-rpc.com/?api-key=${key}`;
  const call = (method, params) => fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
    .then(r => r.json()).then(j => { if (j.error) throw new Error(j.error.message); return j.result; });

  try {
    let tokens = 0;
    if (mint) {
      const r = await call("getTokenAccountsByOwner", [wallet, { mint }, { encoding: "jsonParsed" }]);
      for (const a of r.value) tokens += Number(a.account.data.parsed.info.tokenAmount.uiAmountString || 0);
    }
    const nfts = [];
    if (coll) {
      for (let page = 1; page < 20; page++) {
        const r = await call("getAssetsByOwner", { ownerAddress: wallet, page, limit: 1000 });
        for (const it of r.items) {
          if (it.burnt || !(it.grouping || []).some(g => g.group_key === "collection" && g.group_value === coll)) continue;
          const md = it.content?.metadata || {}, attrs = md.attributes || [];
          const raw = String(attrs.find(a => /^(tier|rarity)$/i.test(a.trait_type))?.value || "common").toLowerCase();
          const tier = raw === "1/1" || raw === "oneofone" ? "oneofone" : RANK[raw] ? raw : "common";
          nfts.push({
            id: it.id, name: md.name || "Pumper", number: parseInt((md.name || "").match(/#(\d+)/)?.[1] || "0", 10), tier,
            image: it.content?.links?.image || it.content?.files?.[0]?.uri || "",
            oneofone: tier === "oneofone" ? String(attrs.find(a => a.trait_type === "1/1")?.value || "") || null : null,
          });
        }
        if (r.items.length < 1000) break;
      }
    }
    res.setHeader("cache-control", "no-store");
    return res.json({ live: true, wallet, tokens, nfts, access: decide(tokens, nfts) });
  } catch (e) {
    return res.status(502).json({ error: "holdings check failed" });
  }
}
