# Net Bender

A Chrome extension (Manifest V3) for intercepting HTTP traffic: pause requests
before they are sent and responses before the page receives them, edit them,
then forward or drop.

## Features

- **Intercept requests**: edit method, URL, headers and body; forward or drop.
- **Intercept responses**: edit status code, status text, headers and body; forward or drop.
- Per-tab attach/detach from the toolbar popup or the console sidebar.
- URL pattern (`*` / `?` wildcards) and resource-type filters.
- Queue of paused items, drafts kept per item, JSON formatting, binary-safe (base64) bodies.
- History of forwarded / modified / dropped items.
- Keyboard: `Ctrl+Enter` forward, `Ctrl+Shift+Enter` drop, `Alt+↑/↓` move through the queue, `Alt+Shift+N` opens the popup.

## How it works

Interception uses the Chrome DevTools Protocol `Fetch` domain through
`chrome.debugger`:

- `Fetch.enable` with patterns built from the filters and the request/response toggles.
- `Fetch.requestPaused` puts an item in the queue (request stage, or response stage with `Fetch.getResponseBody`).
- Forward unchanged → `Fetch.continueRequest`.
- Forward an edited request → `Fetch.continueRequest` with `url` / `method` / `headers` / `postData` overrides.
- Forward an edited response → `Fetch.fulfillRequest` (`Content-Encoding` / `Content-Length` are dropped because the body is already decoded).
- Drop → `Fetch.failRequest` with `Aborted`.

If no Intercept Console is open, paused traffic is forwarded automatically so
attached tabs never hang.

## Project layout

```
extension/            the unpacked extension (this folder is what ships)
  manifest.json
  background.js       service worker: debugger sessions and the Fetch domain
  lib/codec.js        body/header encoding helpers
  lib/theme.css       shared styles
  console/            Intercept Console (full-tab UI)
  popup/              toolbar popup
  icons/              generated PNG icons
assets/logo.svg       logo source
store/                Web Store listing text and promo images
scripts/
  build-assets.mjs    renders icons + promo tiles from assets/logo.svg (headless Chrome)
  package.mjs         zips extension/ into dist/ for upload
PRIVACY.md            privacy policy to host publicly
```

## Development

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Open any http(s) page, click the Net Bender icon → **Intercept this tab**.

After editing `assets/logo.svg`:

```bash
node scripts/build-assets.mjs
```

## Publishing

```bash
node scripts/package.mjs
```

Upload `dist/net-bender-<version>.zip` in the
[Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
and fill in the listing using `store/LISTING.md`. Bump `version` in
`extension/manifest.json` for every new upload.
