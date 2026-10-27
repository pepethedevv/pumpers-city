// Landing gate, wallet connection, pass card and guide.
(function () {
  const cfg = window.PC_CONFIG || {};
  const show = (id, on = true) => { $(id).hidden = !on; };
  const fmt = n => Math.floor(n).toLocaleString("en-US");
  const short = a => a.slice(0, 4) + "…" + a.slice(-4);
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  PC.boot();

  // ---------- config on the page ----------
  if (cfg.X_URL) $("xlink").href = cfg.X_URL;
  if (cfg.MINT_URL) { $("mintBtn").href = cfg.MINT_URL; show("mintBtn"); }
  if (cfg.CA) {
    $("caval").textContent = cfg.CA; show("ca");
    $("cacopy").addEventListener("click", () => navigator.clipboard?.writeText(cfg.CA).then(() => { $("cacopy").textContent = "COPIED"; setTimeout(() => $("cacopy").textContent = "COPY", 1500); }));
  }

  // ---------- modals ----------
  document.querySelectorAll(".modal").forEach(m => m.addEventListener("click", e => { if (e.target === m || e.target.closest("[data-close]")) m.hidden = true; }));
  addEventListener("keydown", e => { if (e.key === "Escape") { document.querySelectorAll(".modal").forEach(m => m.hidden = true); closeGuide(); } });

  // ---------- guide ----------
  function openGuide() {
    const playing = $("gate").hidden;
    document.querySelectorAll("[data-close-guide]").forEach(b => b.textContent = playing ? "← BACK TO THE GAME" : "← BACK TO START");
    show("guide"); $("guide").scrollTop = 0;
  }
  function closeGuide() { show("guide", false); }
  document.querySelectorAll("[data-open-guide]").forEach(b => b.addEventListener("click", openGuide));
  $("guideClose").addEventListener("click", closeGuide);
  document.querySelectorAll("[data-close-guide]").forEach(b => b.addEventListener("click", closeGuide));
  document.querySelectorAll(".toc a").forEach(a => a.addEventListener("click", e => { e.preventDefault(); document.querySelector(a.getAttribute("href")).scrollIntoView(); }));

  // ---------- entering the city ----------
  function enter(profile) {
    document.querySelectorAll(".modal").forEach(m => m.hidden = true);
    show("gate", false);
    PC.play(profile);
  }
  $("leave").addEventListener("click", () => { PC.leave(); show("gate"); });

  $("guest").addEventListener("click", () => {
    if (window.PC_DEMO) return openDemo();
    enter({ name: "Guest", tier: "none", canOpen: false });
  });

  // ---------- demo characters (?demo=1) ----------
  function openDemo() {
    $("chars").innerHTML = CHARS.map(c => { const tr = TIERS[c.tier];
      return `<button type="button" data-k="${c.k}"><img src="${texSrc(c.tex)}" alt="">${c.k}<small style="color:${tr.color}">${c.note || tr.label + " NFT"}${c.trail && !c.note ? " · own trail" : ""}</small><small>${c.explorer ? "" : "XP x" + tr.xp + " · speed +" + Math.round((tr.speed - 1) * 100) + "%"}</small></button>`; }).join("");
    $("chars").querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
      const c = CHARS.find(c => c.k === b.dataset.k);
      enter({ name: c.k, tex: c.tex, tier: c.tier, canOpen: !c.explorer, trail: c.trail || null });
    }));
    show("demoModal");
  }

  // ---------- wallets ----------
  const WALLETS = [
    { name: "Phantom", get: () => window.phantom?.solana, site: "https://phantom.app/", deep: u => `https://phantom.app/ul/browse/${encodeURIComponent(u)}?ref=${encodeURIComponent(location.origin)}` },
    { name: "Solflare", get: () => window.solflare, site: "https://solflare.com/", deep: u => `https://solflare.com/ul/v1/browse/${encodeURIComponent(u)}?ref=${encodeURIComponent(location.origin)}` },
    { name: "Backpack", get: () => window.backpack, site: "https://backpack.app/" },
  ];
  $("connect").addEventListener("click", () => {
    const list = $("walletList"); list.innerHTML = ""; $("walletMsg").textContent = "";
    for (const w of WALLETS) {
      const p = w.get();
      if (p) {
        const b = document.createElement("button"); b.type = "button"; b.className = "wbtn";
        b.innerHTML = `<span>${w.name}</span><small>detected</small>`;
        b.addEventListener("click", () => connectWith(w, p));
        list.append(b);
      } else if (isMobile && w.deep) {
        const a = document.createElement("a"); a.className = "wbtn"; a.href = w.deep(location.href);
        a.innerHTML = `<span>Open in ${w.name}</span><small>app</small>`; list.append(a);
      } else {
        const a = document.createElement("a"); a.className = "wbtn"; a.href = w.site; a.target = "_blank"; a.rel = "noopener";
        a.innerHTML = `<span>${w.name}</span><small>install</small>`; list.append(a);
      }
    }
    show("walletModal");
  });

  const b64 = bytes => btoa(String.fromCharCode(...bytes));
  async function connectWith(w, provider) {
    const msg = $("walletMsg");
    try {
      msg.textContent = "Waiting for " + w.name + "…";
      const res = await provider.connect();
      const pk = (res?.publicKey || provider.publicKey).toString();
      const message = `Pumpers City login\nWallet: ${pk}\nSite: ${location.host}\nTime: ${new Date().toISOString()}\n\nThis signature only proves you own this wallet. It is free and moves no funds.`;
      msg.textContent = "Please sign the login message in " + w.name + "…";
      const signed = await provider.signMessage(new TextEncoder().encode(message), "utf8");
      const sig = signed?.signature || signed;
      msg.textContent = "Checking your holdings…";
      let data;
      try {
        const r = await fetch(cfg.API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: pk, message, signature: b64(new Uint8Array(sig)) }) });
        data = await r.json();
        if (!r.ok) throw new Error(data.error || "check failed");
      } catch (e) {
        data = { offline: true, wallet: pk };
      }
      show("walletModal", false);
      showPass(data, pk);
    } catch (e) {
      msg.textContent = e?.message?.includes("User rejected") ? "Request was cancelled in the wallet." : "Couldn't connect: " + (e?.message || e);
    }
  }

  // ---------- pass card + Pumper picker ----------
  const RANK = { oneofone: 5, legendary: 4, epic: 3, rare: 2, common: 1 };
  let pass = null, chosen = null;
  let atlas = null;
  const loadAtlas = () => atlas || (atlas = new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = "sprites/atlas.png"; }));
  // draw a Pumper exactly as it looks in the game (64 per row, 32x32 in the atlas)
  async function thumb(n, canvas) {
    const x = canvas.getContext("2d"); x.imageSmoothingEnabled = false;
    if (n.oneofone) { const img = new Image(); img.onload = () => x.drawImage(img, 0, 0, 64, 64); img.src = texSrc("o_" + n.oneofone); return; }
    const a = await loadAtlas();
    if (a) x.drawImage(a, ((n.number - 1) % 64) * 32, Math.floor((n.number - 1) / 64) * 32, 32, 32, 0, 0, 64, 64);
  }
  function profileFor(n) {
    const d = pass.data, a = d.access || {};
    return {
      name: n ? n.name : short(pass.pk),
      spriteNum: n && !n.oneofone ? n.number : null,
      tex: n?.oneofone ? "o_" + n.oneofone : null,
      tier: d.live ? a.level : "none",
      canOpen: !!(d.live && a.canOpen),
      trail: d.live ? (n?.oneofone || (a.trail ? "whale" : null)) : null,
    };
  }
  function renderPicker(nfts) {
    const pick = $("nftPick"); pick.innerHTML = "";
    if (!nfts.length) return;
    const sorted = nfts.slice().sort((x, y) => (RANK[y.tier] - RANK[x.tier]) || (x.number - y.number));
    pick.innerHTML = `<div class="picktitle">CHOOSE YOUR PUMPER <span>${nfts.length} owned</span></div>` + sorted.map((n, i) => {
      const tr = TIERS[n.tier] || TIERS.common;
      return `<button type="button" data-i="${i}"><canvas width="64" height="64"></canvas><b>${esc(n.oneofone || "#" + n.number)}</b><small style="color:${tr.color}">${tr.label.toUpperCase()}</small></button>`;
    }).join("");
    const btns = [...pick.querySelectorAll("button")];
    btns.forEach((b, i) => thumb(sorted[i], b.querySelector("canvas")));
    const select = i => { chosen = sorted[i]; btns.forEach((b, j) => b.classList.toggle("sel", j === i)); };
    btns.forEach((b, i) => b.addEventListener("click", () => select(i)));
    const cur = chosen && sorted.findIndex(n => n.number === chosen.number && n.oneofone === chosen.oneofone);
    select(cur >= 0 ? cur : 0);
  }
  function showPass(d, pk) {
    pass = { data: d, pk }; chosen = null;
    const body = $("accessBody");
    const a = d.access || { canOpen: false, level: "none" }, tr = TIERS[a.level] || TIERS.none;
    let html = `<dl class="pass"><dt>Wallet</dt><dd>${short(pk)}</dd>`;
    if (d.live) {
      html += `<dt>$PUMPERS</dt><dd>${fmt(d.tokens)}</dd><dt>Pumpers NFTs</dt><dd>${d.nfts.length}</dd>
        <dt>Level</dt><dd style="color:${tr.color}">${a.level === "none" ? "–" : tr.label.toUpperCase()}</dd>
        <dt>Perks</dt><dd>${a.level === "none" ? "–" : "XP x" + tr.xp + " · speed +" + Math.round((tr.speed - 1) * 100) + "%"}${a.trail ? " · trail" : ""}</dd>
        <dt>Open boxes</dt><dd class="${a.canOpen ? "ok" : "no"}">${a.canOpen ? "YES" : "NO"}</dd></dl>`;
      html += `<div class="notice">${esc(a.reason || "")}${d.nfts.length > 1 ? " Your level comes from your best Pumper, whichever one you play as." : ""}</div>`;
    } else if (d.offline) {
      html += `</dl><div class="notice">We couldn't check your holdings right now. You can enter as an explorer and reconnect later.</div>`;
    } else {
      html += `</dl><div class="notice">$PUMPERS and the NFTs aren't live yet. Until launch, everyone explores the city as a guest. Follow <a href="${cfg.X_URL}" target="_blank" rel="noopener">@pumperscity</a> for the launch.</div>`;
    }
    body.innerHTML = html; body.hidden = false;
    renderPicker(d.nfts || []);
    $("accessTitle").textContent = "YOUR PASS";
    $("enter").textContent = "ENTER THE CITY";
    $("enter").onclick = () => { enter(profileFor(chosen)); $("switch").hidden = !((d.nfts || []).length > 1); };
    show("accessModal");
  }
  // switch Pumper while playing
  $("switch").addEventListener("click", () => {
    if (!pass) return;
    $("accessBody").hidden = true;
    renderPicker(pass.data.nfts || []);
    $("accessTitle").textContent = "SWITCH PUMPER";
    $("enter").textContent = "PLAY AS THIS PUMPER";
    $("enter").onclick = () => { show("accessModal", false); PC.setCharacter(profileFor(chosen)); };
    show("accessModal");
  });
  $("leave").addEventListener("click", () => { $("switch").hidden = true; });
})();
