# Field Audit Debugging

The extension stores a developer-only field audit in Chrome extension storage
under:

```js
snle_field_audit
```

The browser extension cannot silently write into this repo folder. Chrome only
allows extension writes through browser-managed storage or downloads.

To inspect the report after a small test collection, open DevTools for the Sales
Navigator tab and run:

```js
window.postMessage({ source: "snle-devtools", type: "dump-audit" }, "https://www.linkedin.com");
```

The content script prints a `[SNLE:field-audit]` JSON block in the console.

If you are in an extension context where `chrome.storage` is available, this
also works:

```js
chrome.storage.local.get(["snle_field_audit"], (data) => {
  console.log(JSON.stringify(data.snle_field_audit || [], null, 2));
});
```

To download the audit JSON without adding a popup UI button, run this in the
same DevTools console:

```js
chrome.storage.local.get(["snle_field_audit"], (data) => {
  const json = JSON.stringify(data.snle_field_audit || [], null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "snle-field-audit.json";
  a.click();
  URL.revokeObjectURL(url);
});
```

Each audit entry contains:

- `id`
- `linkedinName`
- `capturePage`
- `captureOrder`
- `storageKey`
- `fields`

Each `fields` item contains:

- `value`: the final value used by the mapper
- `source`: the JSON path or fallback that produced the value
- `rawType`: the raw source value type
- `rawValue`: only for selected computed values, such as tenure month counts
- `inferred`: `true` when the value came from a fallback such as title inference
