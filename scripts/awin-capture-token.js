/**
 * Capture an Awin "nova" session token from a logged-in Chrome tab.
 *
 * Why this exists: Awin's partner-management API is only reachable with the
 * session JWT that app.awin.com itself uses. There is no way to mint one
 * outside a browser, it lasts about an hour, and tokens copied from Awin's
 * older UI carry read-only scopes that fail every write with a 403. This grabs
 * the right one and tells you if it is the wrong one.
 *
 * HOW TO USE
 *   1. Open https://app.awin.com and log in.
 *   2. Open DevTools (F12 or Cmd+Opt+I) and pick the Console tab.
 *   3. Paste this entire file in and press Enter.
 *   4. If it prints a token, it is already on your clipboard.
 *      If it says it is listening, click Partnerships > All partnerships >
 *      Pending partners and it will capture the token from that request.
 *
 * Chrome blocks pasting into the console the first time. If it warns you, type
 * "allow pasting" and press Enter, then paste again.
 *
 * The token is a bearer credential: anyone holding it can do anything you can
 * do in Awin until it expires. Keep it out of chat logs, screenshots and
 * commits — prefer the local run described at the bottom of this file.
 */

(() => {
  const NOVA_CLIENT = "nova";

  const decode = (jwt) => {
    try {
      const [, payload] = jwt.split(".");
      return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    } catch {
      return null;
    }
  };

  const report = (token) => {
    const claims = decode(token) ?? {};
    const client = claims["https://awin.com/client"];
    const secondsLeft = claims.exp ? Math.round(claims.exp - Date.now() / 1000) : null;

    if (client && client !== NOVA_CLIENT) {
      console.warn(
        `%cThis is a "${client}" token — read-only. Writes will fail with 403.\n` +
          "Open app.awin.com itself (not the older UI) and run this again.",
        "color:#b45309;font-weight:bold",
      );
      return false;
    }
    if (secondsLeft !== null && secondsLeft <= 0) {
      console.warn("%cThis token has already expired. Reload the page and retry.", "color:#b91c1c");
      return false;
    }

    console.log(
      `%cGot a ${client ?? "?"} token — valid for ${Math.round((secondsLeft ?? 0) / 60)} more minutes.`,
      "color:#15803d;font-weight:bold",
    );
    console.log(token);
    try {
      copy(token); // DevTools helper
      console.log("%cCopied to clipboard.", "color:#15803d");
    } catch {
      console.log("Select the line above and copy it manually.");
    }
    return true;
  };

  // 1. Auth0's SPA SDK caches the token in localStorage when the app opts into
  //    that. Cheapest path, so try it first.
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith("@@auth0spajs@@")) continue;
    try {
      const token = JSON.parse(localStorage.getItem(key))?.body?.access_token;
      if (token && report(token)) return;
    } catch {
      /* not the entry we want */
    }
  }

  // 2. Otherwise the SDK is holding it in memory, where nothing can read it.
  //    Wrap fetch and XHR and take the header off the next backend call.
  console.log(
    "%cNo cached token found — listening for the next request.\n" +
      "Now click Partnerships > All partnerships > Pending partners.",
    "color:#1d4ed8;font-weight:bold",
  );

  const seen = (value) => {
    const token = String(value ?? "").replace(/^Bearer\s+/i, "");
    if (!token.startsWith("ey")) return;
    if (report(token)) {
      window.fetch = originalFetch;
      XMLHttpRequest.prototype.setRequestHeader = originalSetHeader;
    }
  };

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
      seen(headers.get("authorization"));
    } catch {
      /* ignore malformed header bags */
    }
    return originalFetch.apply(this, arguments);
  };

  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (String(name).toLowerCase() === "authorization") seen(value);
    return originalSetHeader.apply(this, arguments);
  };

  setTimeout(() => {
    if (window.fetch !== originalFetch) return;
    console.warn("Still nothing after 2 minutes — reload the page and try again.");
  }, 120000);
})();

/*
 * RUNNING THE TRIAGE LOCALLY, so the token stays on your machine
 *
 *   git clone <this repo> && cd the-frame
 *   export AWIN_SESSION_JWT='<paste>'          # Windows: set AWIN_SESSION_JWT=...
 *   node scripts/awin-partner-triage.mjs list --enrich
 *   node scripts/awin-partner-triage.mjs apply --confirm
 *
 * Needs Node 18 or newer and nothing else — no npm install. Check with
 * `node --version`. The plan file it writes is safe to share; it holds
 * decisions and reasons, no credentials.
 */
