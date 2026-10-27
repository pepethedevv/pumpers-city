// POST /api/claim  { wallet, prizeId, message, signature(base64) }
// The player signs "Pumpers City claim" for one prize. We check the signature, check their holdings
// again, lock the prize so it can't be claimed twice, and send the $PUMP from the prize wallet.
//
// Vercel environment variables (secret):
//   HELIUS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
//   PRIZE_WALLET_SECRET   private key of the prize wallet (base58 from Phantom, or a JSON number array)
import bs58 from "bs58";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { addr, decide, verifySigned, hostOf, holdings, dbReady, db, reconcile, rpcUrl } from "./_lib.js";

export function prizeKeypair(secret) {
  const s = String(secret || "").trim();
  const bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s);
  return Keypair.fromSecretKey(bytes);
}
// whole-token amount → raw units without floating point drift
export function toRaw(amount, decimals) {
  const [i, f = ""] = String(amount).split(".");
  return BigInt(i + (f + "0".repeat(decimals)).slice(0, decimals));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  res.setHeader("cache-control", "no-store");
  const { wallet, prizeId, message, signature } = req.body || {};
  const err = verifySigned("claim", wallet, message, signature, hostOf(req));
  if (err) return res.status(401).json({ error: err });
  if (!String(message).split("\n").includes("Prize: " + prizeId)) return res.status(401).json({ error: "this signature is for a different prize" });
  if (!dbReady() || !process.env.PRIZE_WALLET_SECRET || !addr("PRIZE_MINT") || !process.env.HELIUS_API_KEY)
    return res.status(503).json({ error: "Claiming opens at launch." });

  try {
    const id = encodeURIComponent(prizeId), w = encodeURIComponent(wallet);
    let [row] = await db(`prizes?id=eq.${id}&wallet=eq.${w}&select=*`);
    if (!row) return res.status(404).json({ error: "prize not found" });
    if (row.status === "sending") { [row] = await reconcile([row]); }
    if (row.status === "sent") return res.json({ status: "sent", signature: row.signature });
    if (row.status === "sending") return res.status(202).json({ status: "sending", signature: row.signature });
    if (row.status === "held") return res.status(409).json({ error: "This prize is being reviewed." });
    if (row.status !== "ready") return res.status(409).json({ error: "This prize can't be claimed." });

    // holdings are checked again before paying
    const { tokens, nfts } = await holdings(wallet);
    const access = decide(tokens, nfts);
    if (!access.canOpen) return res.status(403).json({ error: "Your wallet doesn't meet the box rules right now. " + access.reason });

    // lock: only one request can move the prize from ready to sending
    const locked = await db(`prizes?id=eq.${id}&wallet=eq.${w}&status=eq.ready`, { method: "PATCH", prefer: "return=representation", body: { status: "sending", claimed_at: new Date().toISOString(), note: null } });
    if (!locked?.length) return res.status(409).json({ error: "This prize is already being claimed." });

    const conn = new Connection(rpcUrl(), "confirmed");
    const payer = prizeKeypair(process.env.PRIZE_WALLET_SECRET);
    const mintPk = new PublicKey(addr("PRIZE_MINT")), owner = new PublicKey(wallet);
    const mintInfo = await conn.getAccountInfo(mintPk);
    const programId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const mint = await getMint(conn, mintPk, "confirmed", programId);
    const from = getAssociatedTokenAddressSync(mintPk, payer.publicKey, false, programId);
    const to = getAssociatedTokenAddressSync(mintPk, owner, false, programId);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, to, owner, mintPk, programId),
      createTransferCheckedInstruction(from, mintPk, to, payer.publicKey, toRaw(row.amount, mint.decimals), mint.decimals, [], programId),
    );
    tx.sign(payer);
    const sig = bs58.encode(tx.signature);
    // remember the signature before sending, so a timeout can never lead to paying twice
    await db(`prizes?id=eq.${id}`, { method: "PATCH", body: { signature: sig, last_valid_height: lastValidBlockHeight } });
    try {
      await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
    } catch (e) {
      // only release the prize when the network clearly rejected it (simulation failed, empty wallet...);
      // on a plain connection error the transaction may still land, so the prize list settles it later
      const rejected = e?.name === "SendTransactionError" || /simulat|insufficient|custom program error/i.test(String(e?.message));
      if (!rejected) return res.status(202).json({ status: "sending", signature: sig });
      await db(`prizes?id=eq.${id}&status=eq.sending`, { method: "PATCH", body: { status: "ready", signature: null, last_valid_height: null, note: "payout failed, try again" } });
      return res.status(502).json({ error: "Payout failed. Please try again in a minute." });
    }
    try {
      const c = await Promise.race([
        conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed"),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 25000)),
      ]);
      if (c.value.err) throw new Error("failed");
      await db(`prizes?id=eq.${id}`, { method: "PATCH", body: { status: "sent", sent_at: new Date().toISOString() } });
      return res.json({ status: "sent", signature: sig });
    } catch {
      // still in flight: the prize list settles it on the next refresh
      return res.status(202).json({ status: "sending", signature: sig });
    }
  } catch (e) {
    return res.status(502).json({ error: "Claim failed. Please try again." });
  }
}
