# Net Bender Privacy Policy

_Last updated: October 23, 2026_

Net Bender is a developer tool that lets you pause, inspect and edit HTTP
requests and responses in tabs that **you explicitly choose** to intercept.

## What the extension accesses

When you attach Net Bender to a tab, it uses Chrome's `debugger` API to see
the requests and responses of that tab that match your filters. This can
include URLs, headers (which may contain cookies or authorization tokens) and
request/response bodies.

## What happens to that data

- It is processed **only on your device**, inside the extension.
- It is shown in the Intercept Console so you can review and edit it.
- Paused items and the action history are kept **in memory only** and are
  discarded when the browser closes or the extension restarts.
- Your filter settings (URL patterns, resource types and on/off toggles) are
  saved with `chrome.storage.local` on your device.

## What the extension does not do

- It does not send any data to the developer or to any third party.
- It contains no analytics, tracking, advertising or remote code.
- It does not sell or transfer user data, and does not use it for any purpose
  other than the interception feature you are using.
- It does not observe any tab you have not attached it to.

## Contact

Questions about this policy: YOUR-CONTACT-EMAIL
