# Sales Navigator Lead Extractor

A Chrome Manifest V3 extension for collecting LinkedIn Sales Navigator lead
records across result pages and exporting them as a formatted Excel workbook.

The extension observes Sales Navigator's own JSON API responses while you browse.
It does not depend on fragile page markup or randomized CSS classes. Captured
records are normalized, deduplicated in local extension storage, and exported as
`.xlsx`.

## Features

- Captures leads from Sales Navigator search/list/result pages.
- Observes `fetch` and `XMLHttpRequest` responses from the page context.
- Handles text, `Blob`, and `ArrayBuffer` response bodies.
- Recursively parses nested Sales Navigator payloads.
- Deduplicates leads across pages and repeated loads.
- Collects multiple pages with a user-set page count and delay.
- Supports continuing from the next page after a completed run.
- Shows live progress: current page, pages checked, pages with captured leads,
  total leads, estimate, and next action countdown.
- Exports a LIX-style formatted Excel workbook with frozen headers, filters,
  wrapped cells, column widths, and clean borders.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder.
5. Reload any already-open Sales Navigator tabs.

After code changes, reload the unpacked extension in `chrome://extensions` and
refresh Sales Navigator tabs so the updated content script is injected.

Starting a new **Collect pages** run clears previously captured leads, reloads
the currently open Sales Navigator page, and begins capture from that page.

## Use

1. Open a Sales Navigator page under `https://www.linkedin.com/sales/...`.
2. Open the extension popup.
3. Set **Pages to collect**.
4. Set **Delay (sec)**.
5. Click **Collect pages**.
6. When collection is finished, click **Download Excel**.

To start over without collecting, click **Clear captured data** in the popup.

### Page Collection

**Pages to collect** means the page range to check during the run.

- `1` means check the page currently open.
- `2` means check the current page plus one Next page.
- `100` means check up to 100 pages, if Sales Navigator has that many.

The popup remembers the last page count and delay you entered. The default page
count is 4.

**Collect pages** reloads the currently open Sales Navigator page, clears old
captured data, and then starts collection from that page. It then advances page
by page until the requested page count is reached.

**Continue next pages** starts from the next page, useful when the current page
was already collected or already loaded. For example, after collecting pages
1-4, enter `4` and click **Continue next pages** to check pages 5-8.

The extension waits between page advances and stops if it cannot find an enabled
Next control or if the page stops producing a page/content change. The
**Estimated profiles** number is only a planning estimate based on roughly 25
profiles per page. The popup shows both **Pages checked** and **Pages with
captured leads** so you can tell whether a page was visited but produced no new
records.

During an active page collection run, storage is capped at `Pages to collect *
25` leads. This keeps a four-page run at 100 rows even if a Sales Navigator
payload includes an extra lead-like object outside the visible result cards.
Each checked page can add up to 25 new leads, and rows are exported in the order
they were captured page by page.

When the requested page range finishes, the extension stays on the final checked
page and shows that scraping stopped there automatically.

## Architecture

The extension uses four JavaScript contexts:

| File | Context | Purpose |
|------|---------|---------|
| `manifest.json` | Extension manifest | Declares MV3 metadata, permissions, content script, popup, background worker, and injected script access. |
| `inject.js` | Page world | Wraps the page's `fetch` and `XMLHttpRequest` to observe Sales Navigator API responses. |
| `content.js` | Isolated content script | Injects `inject.js`, receives page messages, parses payloads, stores records, and runs pagination. |
| `popup.html` / `popup.js` | Extension popup | Shows controls/progress, reads stored leads, builds Excel, and requests download. |
| `background.js` | MV3 service worker | Handles ping and download messages, then calls `chrome.downloads.download`. |

## Data Flow

```text
Sales Navigator page
  -> fetch/XHR response
  -> inject.js reads JSON body
  -> window.postMessage(...)
  -> content.js parses and dedupes records
  -> chrome.storage.local["snle_leads"]
  -> popup.js builds .xlsx workbook
  -> background.js downloads file
```

Pagination uses the same pipeline. The content script clicks the visible enabled
Next control, waits for a URL/page change or new captured leads, and then updates
progress. All pages write into the same deduped storage map.

## Network Interception

`inject.js` watches Sales Navigator-like endpoints, including:

- `salesApiLeadSearch`
- `salesApiPeopleSearch`
- `salesApiLeadsByList`
- `salesApiSavedLeads`
- `salesApiSearchSpotlights`
- `salesApiLeads`
- `/sales-api/salesApi`
- `voyagerSalesDash`
- `salesDash`
- `salesSearchDash`
- `salesLead`
- `salesProfile`
- `/voyager/api/graphql`

For `fetch`, it reads `res.clone().text()` so the page response is not consumed.
For XHR, it reads:

- `responseText` for text responses
- `Blob.text()` for blob responses
- `TextDecoder("utf-8")` for array buffers

This is important because Sales Navigator often returns lead-search responses as
`Blob` objects.

## Parsing Strategy

Sales Navigator payloads are not stable. Lead data may appear under keys like
`elements`, `data.elements`, `included`, `results`, `items`, `records`, `lead`,
`profile`, `salesProfile`, `miniProfile`, or nested entity containers.

`content.js` handles this with tolerant parsing:

- `findLeadCandidates(payload)` performs a bounded breadth-first scan.
- `WeakSet` tracking prevents cycles and duplicate candidate objects.
- `unwrapLeadCandidate(...)` unwraps common containers like `lead`, `profile`,
  `salesProfile`, `member`, `miniProfile`, `entity.profile`, and
  `target.salesProfile`.
- `isLeadLike(...)` checks for profile signals such as names, profile URLs,
  public IDs, titles, or Sales profile URNs.
- `mapElement(...)` converts candidate objects into the workbook schema.

The mapper tries multiple paths for each field. For sparse fields it uses
fallbacks where reasonable:

- Organisation ID from company URNs/IDs.
- Organisation Website when LinkedIn includes website fields.
- Seniority and Job Function from LinkedIn fields first, then title-based
  inference.
- Profile links from flagship URL or public identifier.

## Deduplication And Storage

Captured records are stored in:

```js
chrome.storage.local["snle_leads"]
```

The storage value is an object keyed by the best available identity:

1. LinkedIn public identifier/profile URL
2. Exact name plus organisation
3. Sales Navigator/member ID fallback

The exported `ID` also prefers the public LinkedIn identifier when available,
which makes the file easier to compare with LIX exports that use vanity IDs.

When the same lead appears again, newer non-empty fields are merged in without
overwriting older good values with blanks. Name-only rows that have no useful
role, company, location, description, or public profile data are skipped.

## Excel Export

The workbook is generated locally in `popup.js` using plain JavaScript. No paid
service or package install is required.

Formatting includes:

- Frozen header row
- Auto-filter
- Plain bold headers with borders
- Bordered body cells
- Wrapped text
- Field-aware column widths

The popup sends the workbook as base64 to `background.js`, which downloads it
with the Excel MIME type.

## Workbook Columns

The workbook exports:

`ID, LinkedIn Name, First Name, Last Name, Description, Organisation ID,
Organisation, Organisation Sales Nav Link, Organisation Website, Organisation
Size, Location, Industry, Current Role(s), Seniority, Job Function,
Past Role(s), Education, Tenure at Company, Tenure in Role, Name Resolved?,
Profile Link, Sales Navigator Profile Link, About, Shared Connections,
Shared Connection Names`

## Field Completeness

Sales Navigator search results usually include card-level data:

- Name
- Current role
- Company
- Location
- Sales Navigator profile link
- Sometimes tenure

Fields that may be blank unless richer profile/detail payloads are loaded:

- Past Role(s)
- Education
- Organisation Website
- Organisation Size
- Shared Connection Names

The default workbook export follows the 25-column LIX-style schema. Email
discovery fields are not included in the exported workbook.

## Logging

Logs are scoped by context:

- `[SNLE:inject]`: page-world network interception and response forwarding.
- `[SNLE:content]`: parsing, storage, pagination, and record persistence.
- `[SNLE:popup]`: popup state, progress, Excel creation, and download messages.
- `[SNLE:background]`: service worker startup, pings, and download handling.

Common useful sequence:

```text
[SNLE:inject] info interceptor installed ...
[SNLE:inject] debug forwarding sales api response ...
[SNLE:content] debug extracting lead candidates ...
[SNLE:content] info records persisted ...
```

If records are not increasing, inspect the Sales Navigator page console first.

## Common Issues

### Popup Shows Old UI

Reload the unpacked extension in `chrome://extensions`. Confirm the manifest
version is current, then reopen the popup.

### Popup Shows Old Leads

Click **Clear captured data** or start a new **Collect pages** run. A normal
browser refresh no longer clears storage by itself because page-to-page
collection may involve reloads and progress needs to survive them.

### Collection Stops Early

Possible reasons:

- Sales Navigator has no enabled Next button.
- The current search has fewer pages than requested.
- The page did not load new results after clicking Next.
- The active tab was closed or navigated away.

Use **Continue next pages** if the current page is already captured and you want
to resume from the next page.

### Total Leads Lower Than Pages × 25

This can happen when:

- The current page was already captured before the run.
- Leads are deduped across pages.
- Sales Navigator returns fewer than 25 results on a page.
- Some payloads do not contain parseable lead records.

The progress panel shows total deduped leads captured, not raw rows loaded.

## Responsible Use

This extension is for authorized workflows. It uses explicit user controls,
bounded page counts, and delays for reliability and to avoid aggressive loading.
It is not intended to bypass LinkedIn safeguards or terms.

## Repository

```text
https://github.com/Npalusa1305/Linkdin_profile_extractor
```
