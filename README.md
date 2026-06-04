# Sales Navigator Lead Extractor

A Chrome Manifest V3 extension that captures lead records from LinkedIn Sales
Navigator pages and exports them as CSV.

The extension does not scrape the rendered DOM. Sales Navigator is a client-side
application whose CSS classes and markup can change often, so this project
observes the JSON payloads that LinkedIn's own app downloads while you browse.
Those payloads are parsed into a stable flat lead schema, deduplicated in local
extension storage, and exported from the popup.

## What It Does

- Injects a page-context network interceptor into Sales Navigator pages.
- Watches relevant Sales Navigator `fetch` and `XMLHttpRequest` calls.
- Reads text, `Blob`, and `ArrayBuffer` response bodies.
- Parses likely lead/profile records out of nested JSON payloads.
- Normalizes records into a fixed CSV schema.
- Deduplicates leads by Sales Navigator ID, public profile identifier, or name.
- Stores captured leads in `chrome.storage.local`.
- Exports captured leads as UTF-8 CSV through the background service worker.

## Install

1. Open `chrome://extensions` in Chrome or another Chromium browser.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder.
5. Pin the extension for easier access.

After updating the code, reload the extension from `chrome://extensions` and
reload any already-open Sales Navigator tabs. Content scripts are injected when
matching pages load, so old tabs need a refresh.

## Use

1. Open a Sales Navigator search, list, or lead results page:
   `https://www.linkedin.com/sales/...`
2. Scroll or paginate through results so Sales Navigator loads the lead batches.
3. Open the extension popup.
4. Click **Download CSV**.

The popup reads stored leads directly from extension storage. It does not require
the active tab to answer a popup message before download, which makes the UI more
reliable when a page was opened before the extension was reloaded.

## Architecture

The extension is split into four execution contexts. This split is important
because Chrome extensions and web pages run in different JavaScript worlds.

| File | Context | Responsibility |
|------|---------|----------------|
| `manifest.json` | Chrome extension metadata | Declares MV3 settings, permissions, content script matches, background worker, popup, and web-accessible injected script. |
| `content.js` | Isolated content-script world on `linkedin.com/sales/*` | Injects `inject.js`, receives page messages, parses records, deduplicates, and writes to `chrome.storage.local`. |
| `inject.js` | Page JavaScript world | Monkeypatches `fetch` and `XMLHttpRequest` so the extension can observe Sales Navigator API responses. |
| `popup.html` / `popup.js` | Extension popup | Displays count, reads stored leads, clears storage, builds CSV, and asks the background worker to download. |
| `background.js` | MV3 service worker | Handles download requests and keeps download behavior independent of the popup lifecycle. |

## Data Flow

```text
Sales Navigator page
        |
        | fetch / XMLHttpRequest responses
        v
inject.js
        |
        | window.postMessage({ source: "snle-inject", type: "sales-api-response" })
        v
content.js
        |
        | parse -> normalize -> dedupe
        v
chrome.storage.local["snle_leads"]
        |
        | popup reads stored records
        v
popup.js
        |
        | chrome.runtime.sendMessage({ target: "background", action: "download" })
        v
background.js
        |
        | chrome.downloads.download(...)
        v
CSV file
```

## Why `inject.js` Exists

Chrome content scripts run in an isolated world. They can read the DOM, but they
cannot directly monkeypatch the page's own `window.fetch` or
`XMLHttpRequest.prototype` in a way the Sales Navigator app will use.

To observe the page's network responses, `content.js` creates a `<script>` tag
whose source is `chrome.runtime.getURL("inject.js")`. Because `inject.js` runs in
the page world, it can wrap the same `fetch` and `XMLHttpRequest` objects used by
Sales Navigator.

The injected script cannot use extension APIs directly, so it forwards parsed JSON
to the content script with `window.postMessage`.

## Network Interception Design

`inject.js` watches endpoints whose URLs look like Sales Navigator lead/profile
data calls. The matcher is intentionally substring-based because LinkedIn changes
endpoint names and query parameters over time.

Current patterns include:

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

### Fetch Responses

For `fetch`, the interceptor calls `res.clone().text()` so the original page
response remains untouched. The cloned response body is parsed as JSON and
forwarded to `content.js`.

### XHR Responses

Sales Navigator may use different `responseType` values. The interceptor handles:

- Empty response type or `text`: read `xhr.responseText`.
- `blob`: call `xhr.response.text()`.
- `arraybuffer`: decode with `TextDecoder("utf-8")`.

This matters because Sales Navigator commonly returns lead-search responses as
`Blob` objects. Earlier versions of this extension skipped those responses, which
produced logs like `skipping xhr response type blob` and resulted in no captured
records.

## Parsing Strategy

Sales Navigator payloads do not have one stable shape. Lead data may appear under
keys such as `elements`, `data.elements`, `included`, `results`, `items`,
`records`, `lead`, `profile`, `salesProfile`, `miniProfile`, or nested entity
containers.

The parser in `content.js` is designed around tolerant discovery rather than a
single hard-coded path.

### Candidate Discovery

`findLeadCandidates(payload)` performs a bounded breadth-first scan:

- It walks nested objects and arrays up to a maximum depth.
- It caps visited nodes to avoid runaway traversal on huge payloads.
- It tracks seen objects with `WeakSet` to avoid cycles and duplicates.
- It gives special attention to useful array names like `elements`, `included`,
  `profiles`, `leads`, `results`, `items`, `records`, and `entities`.

Each possible object is passed through:

- `unwrapLeadCandidate(...)`, which unwraps common containers such as `lead`,
  `profile`, `salesProfile`, `member`, `miniProfile`, `entity.profile`, and
  `target.salesProfile`.
- `isLeadLike(...)`, which checks for lead/profile signals such as name fields,
  profile URLs, public identifiers, current title, or Sales profile URNs.

This lets the extension survive payload changes where the lead object moves from,
for example, `data.elements[]` to `included[]` or `results[].entity.salesProfile`.

### Record Mapping

`mapElement(el)` converts one candidate object into the flat CSV record shape.
It uses defensive field access and tries multiple known field paths for each
column. For example:

- Name fields may come from `firstName`, `fullProfile.firstName`,
  `miniProfile.firstName`, or `profile.firstName`.
- Role data may come from `currentPositions[0].title`, `currentTitle`,
  `headline.text`, or `title.text`.
- Company data may come from current position fields or top-level company fields.
- Public profile links are built from `publicIdentifier` when available.
- Sales Navigator lead links are built from Sales profile URN tracking data.

The parser uses helper functions:

- `firstString(...)`: returns the first non-empty string from a list of options.
- `get(obj, "a.b.c")`: safely reads nested fields.
- `parseSalesUrn(...)`: extracts Sales Navigator member tokens and lead-path
  values from URNs like `urn:li:fs_salesProfile:(ACwA...,NAME_SEARCH,...)`.
- `tenureFromStart(...)` and `tenureValue(...)`: convert start-date shapes or
  month counts into human-readable tenure values.

### Deduplication And Merge Rules

Captured records are stored in a map under `chrome.storage.local["snle_leads"]`.
The key is:

1. Sales Navigator profile/member ID when available.
2. LinkedIn public identifier when available.
3. Full name as a fallback.

When a later response contains a record already seen, the extension merges fields
instead of replacing the old object wholesale. The `prune(...)` helper keeps
previous non-empty values when a newer response is sparse. This is useful because
Sales Navigator often loads summary search cards first and richer profile data
later, or vice versa.

## Storage Model

All captured data lives in `chrome.storage.local` under:

```js
snle_leads
```

The value is an object map:

```json
{
  "ACwA...": {
    "id": "ACwA...",
    "linkedinName": "Example Person",
    "firstName": "Example",
    "lastName": "Person"
  }
}
```

The popup reads this storage key directly. Clearing data sets the map back to an
empty object.

## CSV Export

CSV export is built in `popup.js` from the stored lead array. The file includes a
UTF-8 byte-order mark so Excel opens non-ASCII characters correctly.

The popup sends the CSV string to `background.js`, and the background worker calls
`chrome.downloads.download(...)`. Downloads are handled in the background worker
so they can continue even if the popup closes.

## CSV Columns

The export uses this fixed column order:

`ID, LinkedIn Name, First Name, Last Name, Email Discovery, Email Deliverability,
Email Type, Email Catch-all, Email Alternate, Description, Organisation Role,
Organisation Name, Organisation URL, Organisation Industry, Organisation Size,
Location, Industry, Current Role, Seniority, Job Function, Past Role(s), Education,
Tenure at Company, Tenure in Role, Name Resolution, Profile Link,
Sales Navigator Link, About, Shared Connections, Shared Connections Count`

### Email Columns

The email columns are intentionally blank:

- `Email Discovery`
- `Email Deliverability`
- `Email Type`
- `Email Catch-all`
- `Email Alternate`

LinkedIn Sales Navigator search responses do not expose email addresses. These
columns are included to preserve a downstream enrichment-friendly CSV shape.

## Logging And Debugging

Logs are scoped by execution context:

- `[SNLE:inject]`: appears in the Sales Navigator page console. Shows interceptor
  installation, observed network calls, response-body handling, JSON forwarding,
  and parse skips.
- `[SNLE:content]`: appears in the Sales Navigator page console. Shows content
  script initialization, injected-script readiness, candidate extraction,
  normalized record counts, storage writes, and parser errors.
- `[SNLE:popup]`: appears in the popup DevTools console. Shows popup refresh,
  storage reads, background pings, CSV creation, downloads, and clear actions.
- `[SNLE:background]`: appears in the extension service worker console. Shows
  worker load, install/update events, pings, download requests, and download
  results.

Chrome has separate consoles for the page, popup, and service worker. If a log is
not visible, confirm that you are inspecting the correct context.

Useful expected capture sequence:

```text
[SNLE:content] info content script initialized ...
[SNLE:inject] info interceptor installed ...
[SNLE:inject] debug observing xhr ...
[SNLE:inject] debug forwarding sales api response ...
[SNLE:content] debug extracting lead candidates ...
[SNLE:content] info records persisted ...
```

If you see `skipping unsupported xhr response type`, the response body type is not
currently handled. If you see `forwarding sales api response` but no records are
persisted, the payload shape likely needs another parser path.

## Common Issues

### Popup Shows Zero Leads

- Reload the Sales Navigator tab after loading or updating the extension.
- Scroll or paginate so Sales Navigator actually loads result batches.
- Check the page console for `[SNLE:inject] forwarding sales api response`.
- Check the page console for `[SNLE:content] records persisted`.

### No Service Worker Logs

MV3 service workers sleep when idle. Open the popup; it sends a background ping
that should wake the worker and produce `[SNLE:background]` logs. Also make sure
you are inspecting the service worker for the correct unpacked extension instance.

### Old Popup Error Still Appears

If Chrome shows popup source that does not match the files in this repository,
reload the unpacked extension from `chrome://extensions`. The current popup reads
storage directly and does not use `chrome.tabs.sendMessage` for lead retrieval.

### `GET chrome-extension://invalid/`

Those messages can appear from unrelated page or extension asset handling. They
are not the main capture signal. The important signals are whether Sales API
responses are forwarded and whether content parsing persists records.

## Design Tradeoffs

- The extension favors API payload observation over DOM scraping because Sales
  Navigator markup and CSS are unstable.
- Endpoint matching is broad enough to catch Sales Navigator changes, but still
  scoped to Sales/Voyager-like names.
- The parser is tolerant and recursive rather than strict, because response
  nesting varies between search pages, saved lists, profile views, and experiments.
- The extension stores only normalized records, not full raw payloads, to reduce
  local storage size and avoid unnecessary sensitive data retention.
- Full payloads are not dumped to logs; logs include counts, keys, sources, and
  IDs for debugging.

## Limitations

- Captures only data that Sales Navigator loads in the browser.
- Field availability depends on the response shape and the user's Sales Navigator
  access.
- Email addresses are not captured because Sales Navigator search APIs do not
  provide them.
- LinkedIn can change internal API names or payload shapes at any time, requiring
  updates to endpoint matching or parser paths.
- Use only for accounts and workflows where you have authorization and where your
  usage complies with LinkedIn's terms.

## Repository

GitHub remote:

```text
https://github.com/Npalusa1305/Linkdin_profile_extractor
```
