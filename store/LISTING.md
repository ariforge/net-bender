# Chrome Web Store listing — Net Bender

Copy these into the Developer Dashboard (https://chrome.google.com/webstore/devconsole).

## Store listing tab

**Name** (from manifest): Net Bender - HTTP Interceptor

**Summary** (from manifest, max 132 chars):
Pause, inspect and edit HTTP requests and responses before they reach the server or the page.

**Category:** Developer Tools

**Language:** English

**Description:**

```
Net Bender is an HTTP interceptor that lives in your browser. Pick a tab, and every matching request pauses before it leaves Chrome, and every matching response pauses before the page sees it. Change anything, then forward it or drop it.

INTERCEPT REQUESTS
• Edit the method, URL, headers and body before the request is sent
• Forward unchanged, forward with your edits, or drop it entirely

INTERCEPT RESPONSES
• Edit the status code, status text, headers and body before the page receives them
• Mock API responses, test error handling, or inject data without touching the server

BUILT FOR DEBUGGING
• Filter by URL pattern (wildcards) and resource type (Document, XHR, Fetch, Script, Image…)
• Queue of paused items with a full editor for each
• One-click "Format JSON" for request and response bodies
• Binary bodies are kept intact as base64
• History of everything you forwarded, modified or dropped
• Keyboard shortcuts: Ctrl+Enter to forward, Ctrl+Shift+Enter to drop, Alt+↑/↓ to move through the queue

HOW TO USE
1. Open the page you want to work on and click the Net Bender icon.
2. Click "Intercept this tab". The Intercept Console opens.
3. Turn on "Intercept requests" and/or "Intercept responses".
4. Use the page. Matching traffic pauses in the console, where you can edit it and press Forward.

Chrome shows a "Net Bender started debugging this browser" bar while a tab is attached. That is Chrome's standard notice for the debugger API that powers interception. Click "Stop intercepting" (or Cancel on the bar) to release the tab.

PRIVACY
Everything stays on your device. Net Bender has no servers, no analytics and no tracking, and only sees tabs you explicitly attach.
```

**Graphic assets** (in this folder):
- Store icon: `../extension/icons/icon128.png`
- Small promo tile (440×280): `promo-small-440x280.png`
- Marquee promo tile (1400×560): `promo-marquee-1400x560.png`
- Screenshots (1280×800): `screenshot-*.png`

## Privacy practices tab

**Single purpose description:**
Net Bender lets developers pause, inspect and modify the HTTP requests and responses of a browser tab they explicitly choose, for debugging and testing web applications.

**Permission justifications:**

- `debugger` — Interception is implemented with the Chrome DevTools Protocol Fetch domain, which is only available through the debugger API. It is used to pause requests and responses in tabs the user explicitly attaches, read their headers and bodies, and continue, modify or fail them according to the user's choice. The extension never attaches to a tab on its own.
- `storage` — Saves the user's interception settings (URL patterns, resource types, request/response toggles) locally, and remembers which tabs are attached if the service worker restarts.

**Remote code:** No, I am not using remote code. All JavaScript is packaged in the extension.

**Data usage** — check:
- [x] Web history — only the URLs of requests in tabs the user attaches, processed locally
- [x] Website content — request/response bodies of attached tabs, processed locally
- [x] Authentication information — headers such as Cookie/Authorization may be visible in the editor, processed locally

Then certify all three:
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** host `PRIVACY.md` publicly (for example GitHub Pages or a public Gist) and paste the URL.
