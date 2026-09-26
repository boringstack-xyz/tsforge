# tsforge Chrome extension

Lets a local tsforge session read pages in your real, logged-in Chrome — **read and
navigate only**, inside a "tsforge" tab group. Full guide:
https://tsforge.dev/integrations/chrome/

```bash
bun run --cwd packages/chrome-extension build
```

Then `chrome://extensions` → Developer mode → **Load unpacked** →
`packages/chrome-extension/dist`, start tsforge with `TSFORGE_BROWSER=1`, run `/browser`,
and paste the token into the extension's options page.

Where the rules live:

- `src/click-policy.ts` — what may be clicked (links, pagination, expanders; never forms,
  inputs, or action buttons). Re-checked on the live element at click time.
- `src/handlers.ts` — tab-group scoping, adopt permission, http(s)-only navigation.
- `src/snapshot.ts` — sanitized page → HTML + ref table (no scripts, form values, hidden text).
- `src/connection.ts` — localhost bridge client (hello/token, ping, backoff reconnect).
- `src/fetch-policy.ts` + `src/page-fetch.ts` — `page.fetch` for built-in site plugins
  (Reddit): same-origin GET from a group tab, hosts compiled in (`FETCH_HOSTS`), no
  cross-site redirects, JSON/text only, ≤ 5 MB.

After updating tsforge, rebuild and reload the extension — `/browser` reports it as
**outdated** when the protocol versions differ.

The protocol types are shared with tsforge (`packages/core/src/chrome-bridge/`). The
manifest's public `key` pins the extension ID the bridge accepts.
