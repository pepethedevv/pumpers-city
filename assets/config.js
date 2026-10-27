// Edit these when things go live. Empty values are hidden on the page.
window.PC_CONFIG = {
  X_URL: "https://x.com/pumperscity",
  CA: "",             // $PUMPERS contract address, shown on the landing page with a copy button
  MINT_URL: "",       // LaunchMyNFT mint page link; a MINT button appears on the landing page when set
  API: "/api/access", // wallet check endpoint (Vercel function in /api)
};
// Test mode: add ?demo=1 to the address to try every level and trail before launch
window.PC_DEMO = new URLSearchParams(location.search).has("demo");
