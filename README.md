# Sales Navigator Lead Extractor (Chrome extension)

Captures lead data from **LinkedIn Sales Navigator** search results and exports it
to CSV. It works by observing the JSON that Sales Navigator's own app downloads from
LinkedIn's internal Sales API as you browse — no fragile HTML scraping, and it keeps
working even though Sales Navigator uses randomized CSS class names.

## Install (unpacked)

1. Open `chrome://extensions` in Chrome (or any Chromium browser).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this folder (`profileextractor`).
4. Pin the extension so you can see the toolbar icon.

## Use

1. Go to a Sales Navigator **search results** or **saved-list** page
   (`https://www.linkedin.com/sales/...`).
2. Scroll through the results / click through pages. Each batch of leads the page
   loads is captured automatically and deduplicated.
3. Click the extension icon → **Download CSV**.

The popup shows a running count of captured leads. **Clear captured data** resets it.

> Tip: if you opened the Sales Navigator tab *before* installing/enabling the
> extension, reload that tab once so the interceptor is in place.

## CSV columns

`ID, LinkedIn Name, First Name, Last Name, Email Discovery, Email Deliverability,
Email Type, Email Catch-all, Email Alternate, Description, Organisation Role,
Organisation Name, Organisation URL, Organisation Industry, Organisation Size,
Location, Industry, Current Role, Seniority, Job Function, Past Role(s), Education,
Tenure at Company, Tenure in Role, Name Resolution, Profile Link,
Sales Navigator Link, About, Shared Connections, Shared Connections Count`

### About the email columns
The five **Email\*** columns are intentionally left blank. LinkedIn does not expose
email addresses in the Sales Navigator search API — those fields in your sample come
from a separate email-enrichment provider (e.g. Apollo / Lusha / RocketReach). The
columns are kept in the output so you can fill them by running the CSV through your
enrichment tool of choice. If you have an enrichment API you want wired in directly,
that can be added.

## How it works (files)

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest, permissions, content-script registration |
| `inject.js` | Runs in the page; monkeypatches `fetch`/`XHR` to observe Sales API responses |
| `content.js` | Injects `inject.js`, parses lead records, stores them (deduped) in `chrome.storage.local` |
| `background.js` | Service worker; triggers the CSV file download |
| `popup.html` / `popup.js` | Toolbar UI: count, Download CSV, Clear |

## Debug logging

The extension writes detailed console logs with scoped prefixes:

- `[SNLE:inject]` in the Sales Navigator page console for intercepted `fetch`/XHR responses.
- `[SNLE:content]` in the Sales Navigator page console for parsing, extraction, storage, and popup messages.
- `[SNLE:popup]` in the popup DevTools console for refresh, download, and clear actions.
- `[SNLE:background]` in the extension service worker console for download requests/results.

Logs include endpoint context, payload shape, candidate/record counts, storage totals,
and errors. They intentionally avoid dumping full lead payloads.

## Notes / limitations
- Only data that Sales Navigator actually loads is captured. To get all rows in a
  large search, scroll/paginate through them first.
- Field availability varies by Sales Navigator response shape; the parser tries
  several known field names and merges across responses, keeping non-empty values.
- For personal/authorized use within LinkedIn's terms. Review LinkedIn's User
  Agreement before bulk-exporting.
