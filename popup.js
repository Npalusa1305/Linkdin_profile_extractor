// popup.js — UI: shows captured count, downloads Excel, clears data.
const STORAGE_KEY = "snle_leads";
const PENDING_COLLECTION_KEY = "snle_pending_collection";
const COLLECTION_STATE_KEY = "snle_collection_state";
const AUDIT_STORAGE_KEY = "snle_field_audit";
const SETTINGS_STORAGE = "snle_popup_settings";
const LOG_PREFIX = "[SNLE:popup]";

function log(level, message, details) {
  const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (details === undefined) method.call(console, LOG_PREFIX, level, message);
  else method.call(console, LOG_PREFIX, level, message, JSON.stringify(details), details);
}

window.addEventListener("error", (event) => {
  log("error", "popup error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno
  });
});

window.addEventListener("unhandledrejection", (event) => {
  log("error", "popup unhandled rejection", {
    reason: event.reason && (event.reason.stack || event.reason.message || String(event.reason))
  });
});

// Column order + headers (matches the requested export format).
const COLUMNS = [
  ["id", "ID"],
  ["linkedinName", "LinkedIn Name"],
  ["firstName", "First Name"],
  ["lastName", "Last Name"],
  ["description", "Description"],
  ["organisationId", "Organisation ID"],
  ["organisationName", "Organisation"],
  ["organisationSalesNavLink", "Organisation Sales Nav Link"],
  ["organisationWebsite", "Organisation Website"],
  ["organisationSize", "Organisation Size"],
  ["location", "Location"],
  ["industry", "Industry"],
  ["currentRole", "Current Role(s)"],
  ["seniority", "Seniority"],
  ["jobFunction", "Job Function"],
  ["pastRoles", "Past Role(s)"],
  ["education", "Education"],
  ["tenureAtCompany", "Tenure at Company"],
  ["tenureInRole", "Tenure in Role"],
  ["nameResolution", "Name Resolved?"],
  ["profileLink", "Profile Link"],
  ["salesNavLink", "Sales Navigator Profile Link"],
  ["about", "About"],
  ["sharedConnections", "Shared Connections"],
  ["sharedConnectionNames", "Shared Connection Names"]
];

const $ = (id) => document.getElementById(id);

function xmlEscape(value) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function columnName(index) {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function columnWidth(key, header) {
  if (/about|description|pastRoles|education|shared/.test(key)) return 34;
  if (/url|link|website/.test(key)) return 32;
  if (/organisation|linkedinName|nameResolution/.test(key)) return 24;
  return Math.max(12, Math.min(22, header.length + 3));
}

function headerStyle(key) {
  return 1;
}

function bodyStyle(key, value) {
  return 2;
}

function worksheetXml(rows) {
  const lastColumn = columnName(COLUMNS.length - 1);
  const lastRow = Math.max(1, rows.length + 1);
  const cols = COLUMNS.map(([key, header], i) => {
    const width = columnWidth(key, header);
    return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
  }).join("");

  const headerCells = COLUMNS.map(([key, header], i) => {
    const ref = `${columnName(i)}1`;
    return `<c r="${ref}" t="inlineStr" s="${headerStyle(key)}"><is><t>${xmlEscape(header)}</t></is></c>`;
  }).join("");

  const bodyRows = rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const cells = COLUMNS.map(([key], colIndex) => {
      const ref = `${columnName(colIndex)}${rowNumber}`;
      const value = row[key] == null ? "" : String(row[key]);
      return `<c r="${ref}" t="inlineStr" s="${bodyStyle(key, value)}"><is><t>${xmlEscape(value)}</t></is></c>`;
    }).join("");
    return `<row r="${rowNumber}" spans="1:${COLUMNS.length}" ht="38" customHeight="1">${cells}</row>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${cols}</cols>
  <sheetData>
    <row r="1" spans="1:${COLUMNS.length}" ht="28" customHeight="1">${headerCells}</row>
    ${bodyRows}
  </sheetData>
  <autoFilter ref="A1:${lastColumn}${lastRow}"/>
</worksheet>`;
}

function workbookXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Leads" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><color rgb="FF1F2328"/><name val="Aptos"/></font>
    <font><b/><sz val="11"/><color rgb="FF1F2328"/><name val="Aptos"/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFD0D7DE"/></left><right style="thin"><color rgb="FFD0D7DE"/></right><top style="thin"><color rgb="FFD0D7DE"/></top><bottom style="thin"><color rgb="FFD0D7DE"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function staticXmlFiles() {
  return {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    "docProps/app.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Sales Navigator Lead Extractor</Application>
</Properties>`,
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Sales Navigator Leads</dc:title>
  <dc:creator>Sales Navigator Lead Extractor</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`
  };
}

const CRC_TABLE = (() => {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function utf8(value) {
  return new TextEncoder().encode(value);
}

function u16(value) {
  return [value & 0xFF, (value >>> 8) & 0xFF];
}

function u32(value) {
  return [value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF];
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function zipStore(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = utf8(file.name);
    const data = utf8(file.content);
    const crc = crc32(data);
    const localHeader = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0)
    ]);
    localParts.push(localHeader, nameBytes, data);

    const centralHeader = new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0),
      ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)
    ]);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + data.length;
  }

  const centralDirectory = concatBytes(centralParts);
  const localFiles = concatBytes(localParts);
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(centralDirectory.length), ...u32(localFiles.length), ...u16(0)
  ]);
  return concatBytes([localFiles, centralDirectory, end]);
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function toXlsxBase64(rows) {
  log("debug", "building xlsx", { rows: rows.length, columns: COLUMNS.length });
  const files = staticXmlFiles();
  files["xl/workbook.xml"] = workbookXml();
  files["xl/styles.xml"] = stylesXml();
  files["xl/worksheets/sheet1.xml"] = worksheetXml(rows);
  const zipBytes = zipStore(Object.keys(files).map((name) => ({ name: name, content: files[name] })));
  return bytesToBase64(zipBytes);
}

let cachedLeads = [];
let lastTab = null;
let progressTimer = null;

function pingBackground() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: "background", action: "ping" }, (resp) => {
      if (chrome.runtime.lastError) {
        log("error", "background ping failed", { error: chrome.runtime.lastError.message });
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      log(resp && resp.ok ? "info" : "warn", "background ping response", {
        ok: resp && resp.ok,
        time: resp && resp.time
      });
      resolve(resp || { ok: false });
    });
  });
}

function getStoredLeads() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (data) => {
      const error = chrome.runtime.lastError && chrome.runtime.lastError.message;
      if (error) {
        log("error", "storage read failed", { error: error });
        resolve({ leads: [], error: error });
        return;
      }

      const map = data[STORAGE_KEY] || {};
      const leads = Object.values(map).sort((a, b) => {
        const ao = Number(a.__captureOrder) || 0;
        const bo = Number(b.__captureOrder) || 0;
        return ao - bo;
      });
      log("debug", "storage read complete", { leads: leads.length });
      resolve({ leads: leads });
    });
  });
}

function clearStoredLeads() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: {}, [AUDIT_STORAGE_KEY]: [] }, () => {
      const error = chrome.runtime.lastError && chrome.runtime.lastError.message;
      if (error) {
        log("error", "storage clear failed", { error: error });
        resolve({ ok: false, error: error });
        return;
      }

      log("info", "storage cleared");
      resolve({ ok: true });
    });
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  lastTab = tab || null;
  log("debug", "active tab resolved", {
    tabId: tab && tab.id,
    url: tab && tab.url
  });
  return tab;
}

function sendToContent(tabId, payload) {
  return new Promise((resolve) => {
    if (tabId == null) {
      resolve({ ok: false, error: "No active Sales Navigator tab." });
      return;
    }

    chrome.tabs.sendMessage(tabId, Object.assign({ target: "content" }, payload), (resp) => {
      if (chrome.runtime.lastError) {
        const error = chrome.runtime.lastError.message;
        log("warn", "content command failed", {
          action: payload && payload.action,
          tabId: tabId,
          error: error
        });
        resolve({ ok: false, error: error });
        return;
      }

      resolve(resp || { ok: false, error: "No content response." });
    });
  });
}

function pageLimitValue() {
  const value = parseInt($("pageLimit").value, 10);
  if (Number.isNaN(value)) return 4;
  return Math.max(1, Math.min(1000, value));
}

function pageDelayValue() {
  const value = parseInt($("pageDelay").value, 10);
  if (Number.isNaN(value)) return 8000;
  return Math.max(5000, Math.min(120000, value * 1000));
}

function secondsUntil(time) {
  if (!time) return "";
  return Math.max(0, Math.ceil((time - Date.now()) / 1000));
}

function pageNumberFromUrl(url) {
  try {
    const value = new URL(url).searchParams.get("page");
    const page = parseInt(value, 10);
    return Number.isNaN(page) ? 1 : page;
  } catch (e) {
    return 1;
  }
}

function setLoading(active, text) {
  $("loading").style.display = active ? "flex" : "none";
  $("loadingText").textContent = text || "Working...";
}

function setCollectionControlsRunning(running) {
  $("collect").disabled = running;
  $("continueCollect").disabled = running;
  $("pageLimit").disabled = running;
  $("pageDelay").disabled = running;
}

function saveSettings() {
  chrome.storage.local.set({
    [SETTINGS_STORAGE]: {
      pageLimit: pageLimitValue(),
      pageDelaySeconds: Math.round(pageDelayValue() / 1000)
    }
  });
}

function loadSettings() {
  chrome.storage.local.get([SETTINGS_STORAGE], (data) => {
    const settings = data[SETTINGS_STORAGE] || {};
    if (settings.pageLimit) $("pageLimit").value = String(settings.pageLimit);
    if (settings.pageDelaySeconds) $("pageDelay").value = String(settings.pageDelaySeconds);
    updateEstimatedProfilesPreview();
  });
}

function renderProgress(state) {
  if (!state) {
    $("progress").style.display = "none";
    return;
  }

  $("progress").style.display = "block";
  $("progressState").textContent = state.stopped ? "Stopped" : (state.running ? "Collecting" : (state.lastMessage || "Idle"));
  setLoading(Boolean(state.running), state.lastMessage || "Collecting...");
  setCollectionControlsRunning(Boolean(state.running));
  $("currentPage").textContent = state.currentPage || "-";
  $("pagesChecked").textContent = String(state.pagesAttempted || 0);
  $("pagesCheckedLimit").textContent = String(state.maxPages || 0);
  $("pagesAdvanced").textContent = String(state.pagesVisited || 0);
  $("pagesLimit").textContent = String(state.maxPages || 0);
  $("totalProfiles").textContent = String(Math.max(state.lastLeadCount || 0, cachedLeads.length));
  $("estimatedProfiles").textContent = String(state.estimatedProfiles || (pageLimitValue() * 25));

  const waitSeconds = secondsUntil(state.nextActionAt);
  $("nextAction").textContent = state.running && waitSeconds !== ""
    ? `in ${waitSeconds}s`
    : (state.lastMessage || "-");
}

function updateEstimatedProfilesPreview() {
  const pages = pageLimitValue();
  $("estimatedProfiles").textContent = String(pages * 25);
  if ($("progress").style.display !== "block") return;
  $("pagesCheckedLimit").textContent = String(pages);
  $("pagesLimit").textContent = String(pages);
}

async function updateLeadCountOnly() {
  const resp = await getStoredLeads();
  cachedLeads = resp.leads || [];
  $("count").textContent = String(cachedLeads.length);
  $("download").disabled = cachedLeads.length === 0;
}

async function updatePaginationStatus(tabId) {
  const resp = await sendToContent(tabId, { action: "paginationStatus" });
  if (resp && resp.ok) {
    renderProgress(resp.state);
    return resp.state;
  }
  return new Promise((resolve) => {
    chrome.storage.local.get([COLLECTION_STATE_KEY], (data) => {
      const state = data[COLLECTION_STATE_KEY];
      if (state && state.running && Date.now() - (state.updatedAt || 0) < 10 * 60 * 1000) {
        renderProgress(state);
        resolve(state);
        return;
      }
      resolve(null);
    });
  });
}

function stopProgressPolling() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

function startProgressPolling(tabId) {
  stopProgressPolling();
  progressTimer = setInterval(async () => {
    await updateLeadCountOnly();
    const state = await updatePaginationStatus(tabId);
    if (state && !state.running) {
      $("status").textContent = state.pagesAttempted >= state.maxPages
        ? "Scraping stopped on the requested final page. Use Continue next pages to keep going."
        : (state.lastMessage || "Collection stopped.");
      setLoading(false);
      setCollectionControlsRunning(false);
      stopProgressPolling();
    }
  }, 750);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (changes[STORAGE_KEY]) {
    const map = changes[STORAGE_KEY].newValue || {};
    cachedLeads = Object.values(map).sort((a, b) => {
      const ao = Number(a.__captureOrder) || 0;
      const bo = Number(b.__captureOrder) || 0;
      return ao - bo;
    });
    $("count").textContent = String(cachedLeads.length);
    $("download").disabled = cachedLeads.length === 0;
  }

  if (changes[COLLECTION_STATE_KEY]) {
    const state = changes[COLLECTION_STATE_KEY].newValue;
    if (state && state.maxPages) {
      renderProgress(state);
      if (!state.running) {
        setLoading(false);
        setCollectionControlsRunning(false);
        $("status").textContent = state.pagesAttempted >= state.maxPages
          ? "Scraping stopped on the requested final page. Use Continue next pages to keep going."
          : (state.lastMessage || "Collection stopped.");
      }
    }
  }
});

async function refresh() {
  log("info", "refresh started");
  await pingBackground();
  const tab = await getActiveTab();
  const onSalesNav = tab && tab.url && tab.url.indexOf("linkedin.com/sales/") !== -1;
  $("notSalesNav").style.display = onSalesNav ? "none" : "block";
  log("debug", "sales navigator tab check", {
    onSalesNav: Boolean(onSalesNav),
    tabId: tab && tab.id
  });

  const resp = await getStoredLeads();

  cachedLeads = resp.leads || [];
  $("count").textContent = String(cachedLeads.length);
  $("download").disabled = cachedLeads.length === 0;
  $("status").textContent = resp.error ? "Could not read captured leads." : "";
  if (onSalesNav && tab && tab.id != null) {
    updatePaginationStatus(tab.id);
  } else {
    setLoading(false);
  }
  log("info", "refresh complete", { leads: cachedLeads.length });
}

$("download").addEventListener("click", async () => {
  log("info", "download clicked", { cachedLeads: cachedLeads.length });
  if (!cachedLeads.length) {
    log("debug", "download skipped with no cached leads");
    return;
  }
  setLoading(true, "Preparing Excel...");
  const workbookBase64 = toXlsxBase64(cachedLeads);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  chrome.runtime.sendMessage(
    {
      target: "background",
      action: "download",
      xlsxBase64: workbookBase64,
      filename: `sales-navigator-leads-${stamp}.xlsx`
    },
    (resp) => {
      if (chrome.runtime.lastError) {
        log("error", "download message failed", { error: chrome.runtime.lastError.message });
        setLoading(false);
        $("status").textContent = "Download failed: " + chrome.runtime.lastError.message;
        return;
      }
      log(resp && resp.ok ? "info" : "error", "download response received", {
        ok: resp && resp.ok,
        error: resp && resp.error
      });
      setLoading(false);
      $("status").textContent = resp && resp.ok ? "Download started." : "Download failed: " + ((resp && resp.error) || "unknown");
    }
  );
});

async function startCollection(skipCurrent) {
  log("info", skipCurrent ? "continue collection clicked" : "collect clicked");
  const requestedPages = pageLimitValue();
  const requestedDelay = pageDelayValue();
  if (!requestedPages || requestedPages < 1) {
    $("status").textContent = "Enter pages to collect first.";
    return;
  }
  saveSettings();
  const tab = await getActiveTab();
  const onSalesNav = tab && tab.url && tab.url.indexOf("linkedin.com/sales/") !== -1;
  if (!onSalesNav) {
    $("status").textContent = "Open a Sales Navigator results page first.";
    return;
  }

  setCollectionControlsRunning(true);
  if (!skipCurrent) {
    const currentPage = pageNumberFromUrl(tab.url);
    const pending = {
      maxPages: requestedPages,
      delayMs: requestedDelay,
      skipCurrent: false,
      createdAt: Date.now()
    };
    chrome.storage.local.set({
      [PENDING_COLLECTION_KEY]: pending,
      [COLLECTION_STATE_KEY]: {
        running: true,
        pagesAttempted: 0,
        pagesVisited: 0,
        maxPages: requestedPages,
        delayMs: requestedDelay,
        currentPage: currentPage,
        lastLeadCount: 0,
        estimatedProfiles: requestedPages * 25,
        nextActionAt: Date.now() + 1000,
        lastMessage: "Reloading current page",
        updatedAt: Date.now()
      }
    }, () => {
      if (chrome.runtime.lastError) {
        const error = chrome.runtime.lastError.message;
        log("error", "pending collection save failed", { error: error });
        $("status").textContent = "Collection could not start: " + error;
        setCollectionControlsRunning(false);
        return;
      }

      const afterNavigation = () => {
        if (chrome.runtime.lastError) {
          const error = chrome.runtime.lastError.message;
          log("error", "collection page-1 navigation failed", { error: error });
          $("status").textContent = "Collection navigation failed: " + error;
          setLoading(false);
          setCollectionControlsRunning(false);
          return;
        }
        $("status").textContent = `Reloading current page to collect ${requestedPages} page(s).`;
        renderProgress({
          running: true,
          currentPage: currentPage,
          pagesAttempted: 0,
          pagesVisited: 0,
          maxPages: requestedPages,
          estimatedProfiles: requestedPages * 25,
          nextActionAt: Date.now() + 1000,
          lastMessage: "Reloading current page"
        });
        startProgressPolling(tab.id);
      };

      setLoading(true, "Reloading current page...");
      chrome.tabs.reload(tab.id, {}, afterNavigation);
    });
    return;
  }

  const resp = await sendToContent(tab.id, {
    action: "startPagination",
    maxPages: requestedPages,
    delayMs: requestedDelay,
    skipCurrent: Boolean(skipCurrent)
  });

  $("status").textContent = resp && resp.ok
    ? (skipCurrent ? "Continuing from the next page." : "Collection started. Keep the Sales Navigator tab open.")
    : "Collection could not start: " + ((resp && resp.error) || "unknown");
  if (resp && resp.ok) {
    setLoading(true, skipCurrent ? "Continuing..." : "Collecting...");
    renderProgress(resp.state);
    startProgressPolling(tab.id);
  } else {
    setLoading(false);
    setCollectionControlsRunning(false);
  }
}

$("collect").addEventListener("click", () => {
  startCollection(false);
});

$("continueCollect").addEventListener("click", () => {
  startCollection(true);
});

$("pageLimit").addEventListener("input", () => {
  updateEstimatedProfilesPreview();
  saveSettings();
});

$("pageDelay").addEventListener("input", saveSettings);

updateEstimatedProfilesPreview();
loadSettings();

$("clear").addEventListener("click", async () => {
  log("info", "clear clicked");
  const resp = await clearStoredLeads();
  setLoading(false);
  cachedLeads = [];
  chrome.storage.local.set({ [COLLECTION_STATE_KEY]: {} });
  $("count").textContent = "0";
  $("download").disabled = true;
  $("status").textContent = resp && resp.ok ? "Cleared." : "Clear failed.";
  log(resp && resp.ok ? "info" : "warn", "clear complete", {
    ok: resp && resp.ok,
    error: resp && resp.error
  });
});

refresh();
