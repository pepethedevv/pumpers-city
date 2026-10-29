// Shared code for the /api functions (files starting with "_" are not public routes on Vercel).
import nacl from "tweetnacl";
import bs58 from "bs58";

// ---------- public addresses (not secret; filled in at launch) ----------
// A Vercel environment variable with the same name wins if set.
export const ADDRESSES = {
  PUMPERS_MINT: "",     // $PUMPERS token address (at token launch)
  NFT_COLLECTION: "4G5jVgYKZBbBPtpeaS3SXpMfuhPDhmLEYoMXyoKMqbN7", // Pumpers NFT collection (Metaplex Core)
  PRIZE_MINT: "",       // the token prizes are paid in ($PUMP)
};
export const addr = k => process.env[k] || ADDRESSES[k];

// ---------- access rules (change here if the thresholds are lowered later) ----------
export const MIN_TOKENS = 1_000_000;          // no NFT
export const MIN_TOKENS_WITH_NFT = 500_000;   // Common / Rare / Epic NFT
export const NFTS_FOR_FREE_ACCESS = 10;       // this many NFTs need no tokens
export const TRAIL_TOKENS = 20_000_000;       // 2% of supply → gold trail
const TOKEN_LEVELS = [[20_000_000, "oneofone"], [10_000_000, "legendary"], [5_000_000, "epic"], [2_500_000, "rare"], [1_000_000, "common"]];
export const RANK = { none: 0, common: 1, rare: 2, epic: 3, legendary: 4, oneofone: 5 };
const fmt = n => Math.floor(n).toLocaleString("en-US");

export function decide(tokens, nfts) {
  const best = nfts.reduce((b, n) => (RANK[n.tier] > RANK[b] ? n.tier : b), "none");
  const tokenLevel = (TOKEN_LEVELS.find(([n]) => tokens >= n) || [0, "none"])[1];
  const level = RANK[tokenLevel] >= RANK[best] ? tokenLevel : best;
  let canOpen = false, reason;
  if (tokens >= MIN_TOKENS) { canOpen = true; reason = "You hold enough $PUMPERS to open boxes."; }
  else if (RANK[best] >= RANK.legendary) { canOpen = true; reason = `Your ${best === "oneofone" ? "Mythic" : "Legendary"} NFT opens boxes without tokens.`; }
  else if (nfts.length >= NFTS_FOR_FREE_ACCESS) { canOpen = true; reason = `Holding ${nfts.length} Pumpers NFTs opens boxes without tokens.`; }
  else if (nfts.length && tokens >= MIN_TOKENS_WITH_NFT) { canOpen = true; reason = `Your NFT plus ${fmt(MIN_TOKENS_WITH_NFT)}+ $PUMPERS opens boxes.`; }
  else if (nfts.length) reason = `With your NFT you need ${fmt(MIN_TOKENS_WITH_NFT)} $PUMPERS to open boxes. You have ${fmt(tokens)}.`;
  else reason = `To open boxes you need ${fmt(MIN_TOKENS)} $PUMPERS, or a Pumpers NFT plus ${fmt(MIN_TOKENS_WITH_NFT)}. You have ${fmt(tokens)}. You can still explore.`;
  return { canOpen, level, trail: best === "oneofone" || tokens >= TRAIL_TOKENS, reason };
}

// ---------- signed messages ----------
// first line names the action ("Pumpers City login" / "Pumpers City claim"), second line the wallet,
// plus Site and Time lines. Returns null if valid, otherwise a short error.
export function verifySigned(kind, wallet, message, signatureB64, host) {
  let pub;
  try { pub = bs58.decode(String(wallet)); } catch { return "bad wallet"; }
  if (pub.length !== 32) return "bad wallet";
  const lines = String(message || "").split("\n");
  if (lines[0] !== "Pumpers City " + kind || lines[1] !== "Wallet: " + wallet) return "bad message";
  const site = (lines.find(l => l.startsWith("Site: ")) || "").slice(6);
  if (host && site.replace(/^www\./, "") !== String(host).replace(/^www\./, "")) return "wrong site";
  const t = Date.parse((lines.find(l => l.startsWith("Time: ")) || "").slice(6));
  if (!t || Math.abs(Date.now() - t) > 10 * 60 * 1000) return "signature expired, please try again";
  let sig;
  try { sig = new Uint8Array(Buffer.from(String(signatureB64), "base64")); } catch { return "bad signature"; }
  const ok = sig.length === 64 && nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pub);
  return ok ? null : "signature check failed";
}
export const verifyLogin = (wallet, message, sig, host) => verifySigned("login", wallet, message, sig, host);
export const hostOf = req => req.headers["x-forwarded-host"] || req.headers.host;

// ---------- Helius ----------
export const rpcUrl = () => process.env.HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
export async function rpc(method, params) {
  const r = await fetch(rpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
// an NFT's traits: from its metadata file, or from the on-chain Attributes plugin of a Metaplex Core asset
export function traitsOf(it) {
  const a = it.content?.metadata?.attributes;
  if (Array.isArray(a) && a.length) return a;
  return (it.plugins?.attributes?.data?.attribute_list || []).map(x => ({ trait_type: x.key, value: x.value }));
}
// $PUMPERS balance and Pumpers NFTs of a wallet
export async function holdings(wallet) {
  const mint = addr("PUMPERS_MINT"), coll = addr("NFT_COLLECTION");
  let tokens = 0;
  if (mint) {
    const r = await rpc("getTokenAccountsByOwner", [wallet, { mint }, { encoding: "jsonParsed" }]);
    for (const a of r.value) tokens += Number(a.account.data.parsed.info.tokenAmount.uiAmountString || 0);
  }
  const nfts = [];
  if (coll) {
    for (let page = 1; page < 20; page++) {
      const r = await rpc("getAssetsByOwner", { ownerAddress: wallet, page, limit: 1000 });
      for (const it of r.items) {
        if (it.burnt || !(it.grouping || []).some(g => g.group_key === "collection" && g.group_value === coll)) continue;
        const md = it.content?.metadata || {}, attrs = traitsOf(it);
        const raw = String(attrs.find(a => /^(tier|rarity)$/i.test(a.trait_type))?.value || "common").toLowerCase();
        const tier = raw === "mythic" || raw === "1/1" || raw === "oneofone" ? "oneofone" : RANK[raw] ? raw : "common"; // Mythic = the 10 one-of-ones
        nfts.push({
          id: it.id, name: md.name || "Pumper", number: parseInt((md.name || "").match(/#(\d+)/)?.[1] || "0", 10), tier,
          image: it.content?.links?.image || it.content?.files?.[0]?.uri || "",
          oneofone: tier === "oneofone" ? String(attrs.find(a => a.trait_type === "Mythic" || a.trait_type === "1/1")?.value || "") || null : null,
        });
      }
      if (r.items.length < 1000) break;
    }
  }
  return { tokens, nfts };
}

// ---------- Supabase (REST) ----------
// SUPABASE_URL and SUPABASE_SERVICE_KEY live in Vercel environment variables.
export const dbReady = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
export async function db(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY, authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "content-type": "application/json", ...(prefer ? { prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`db ${r.status}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// Prizes stuck in "sending": look the transaction up and settle the row.
// Confirmed → "sent". Failed or expired without landing → back to "ready" so the player can claim again.
export async function reconcile(rows) {
  const pending = rows.filter(r => r.status === "sending" && r.signature);
  if (!pending.length || !process.env.HELIUS_API_KEY) return rows;
  const st = await rpc("getSignatureStatuses", [pending.map(r => r.signature), { searchTransactionHistory: true }]);
  const height = await rpc("getBlockHeight", [{ commitment: "confirmed" }]);
  for (let i = 0; i < pending.length; i++) {
    const r = pending[i], s = st.value[i];
    if (s && !s.err && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
      await db(`prizes?id=eq.${r.id}&status=eq.sending`, { method: "PATCH", body: { status: "sent", sent_at: new Date().toISOString() } });
      r.status = "sent";
    } else if ((s && s.err) || (!s && r.last_valid_height && height > r.last_valid_height)) {
      await db(`prizes?id=eq.${r.id}&status=eq.sending`, { method: "PATCH", body: { status: "ready", signature: null, last_valid_height: null, note: "previous send did not go through" } });
      r.status = "ready"; r.signature = null;
    }
  }
  return rows;
}
