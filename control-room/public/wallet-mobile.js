// On a phone there is no injected wallet in Safari/Chrome: the page has to be opened inside the
// wallet app's own browser. These are the wallets' documented universal links that do exactly
// that for the current page. Nothing here signs, connects or talks to a wallet.
globalThis.GatewayWalletMobile = (() => {
  const WALLETS = {
    solana: [
      { name: "Phantom", link: (url, ref) => `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}` },
      { name: "Solflare", link: (url, ref) => `https://solflare.com/ul/v1/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}` },
    ],
    evm: [
      { name: "MetaMask", link: (url) => `https://metamask.app.link/dapp/${url.replace(/^https:\/\//, "")}` },
    ],
  };
  const isMobile = (nav = navigator) => /Android|iPhone|iPad|iPod/i.test(nav.userAgent || "") || ((nav.maxTouchPoints || 0) > 1 && /Macintosh/.test(nav.userAgent || ""));
  /// The deep links for this page: only ever an https page of this site.
  function links({ chain, url = location.href, origin = location.origin } = {}) {
    let u; try { u = new URL(url); } catch { return []; }
    if (u.protocol !== "https:" || u.origin !== origin) return [];
    return (WALLETS[chain === "solana" ? "solana" : "evm"] || []).map((w) => ({ name: w.name, href: w.link(u.href, origin) }));
  }
  /// Renders "open this page in your wallet app" buttons after `anchor` (idempotent). Returns the box.
  function offer({ chain, anchor, doc = document, mobile = isMobile() } = {}) {
    if (!anchor) return null;
    const list = links({ chain });
    const existing = doc.getElementById("walletMobile");
    if (!list.length) { existing?.remove(); return null; }
    const box = existing || doc.createElement("div");
    box.id = "walletMobile"; box.className = "hint wallet-mobile";
    box.replaceChildren();
    const text = doc.createElement("span");
    text.textContent = mobile ? "On a phone, open this page inside your wallet app: " : "No wallet extension found. On a phone, open this page inside your wallet app: ";
    box.append(text);
    for (const w of list) {
      const a = doc.createElement("a"); a.className = "btn sm"; a.href = w.href; a.rel = "noopener"; a.textContent = `Open in ${w.name}`; a.style.marginRight = "6px"; box.append(a);
    }
    if (!existing) anchor.insertAdjacentElement("afterend", box);
    return box;
  }
  return { isMobile, links, offer };
})();
