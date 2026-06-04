// popup.js — UI: shows captured count, downloads CSV, clears data.
const STORAGE_KEY = "snle_leads";
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
  ["emailDiscovery", "Email Discovery"],
  ["emailDeliverability", "Email Deliverability"],
  ["emailType", "Email Type"],
  ["emailCatchAll", "Email Catch-all"],
  ["emailAlternate", "Email Alternate"],
  ["description", "Description"],
  ["organisationRole", "Organisation Role"],
  ["organisationName", "Organisation Name"],
  ["organisationUrl", "Organisation URL"],
  ["organisationIndustry", "Organisation Industry"],
  ["organisationSize", "Organisation Size"],
  ["location", "Location"],
  ["industry", "Industry"],
  ["currentRole", "Current Role"],
  ["seniority", "Seniority"],
  ["jobFunction", "Job Function"],
  ["pastRoles", "Past Role(s)"],
  ["education", "Education"],
  ["tenureAtCompany", "Tenure at Company"],
  ["tenureInRole", "Tenure in Role"],
  ["nameResolution", "Name Resolution"],
  ["profileLink", "Profile Link"],
  ["salesNavLink", "Sales Navigator Link"],
  ["about", "About"],
  ["sharedConnections", "Shared Connections"],
  ["sharedConnectionsCount", "Shared Connections Count"]
];

const $ = (id) => document.getElementById(id);

function csvCell(v) {
  if (v == null) v = "";
  v = String(v);
  if (/[",\n\r]/.test(v)) {
    v = '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

function toCsv(rows) {
  log("debug", "building csv", { rows: rows.length, columns: COLUMNS.length });
  const lines = [COLUMNS.map(([, h]) => csvCell(h)).join(",")];
  for (const r of rows) {
    lines.push(COLUMNS.map(([k]) => csvCell(r[k])).join(","));
  }
  // BOM so Excel reads UTF-8 correctly.
  return "﻿" + lines.join("\r\n");
}

let cachedLeads = [];

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
      const leads = Object.values(map);
      log("debug", "storage read complete", { leads: leads.length });
      resolve({ leads: leads });
    });
  });
}

function clearStoredLeads() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: {} }, () => {
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
  log("debug", "active tab resolved", {
    tabId: tab && tab.id,
    url: tab && tab.url
  });
  return tab;
}

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
  log("info", "refresh complete", { leads: cachedLeads.length });
}

$("refresh").addEventListener("click", () => {
  log("debug", "refresh clicked");
  refresh();
});

$("download").addEventListener("click", () => {
  log("info", "download clicked", { cachedLeads: cachedLeads.length });
  if (!cachedLeads.length) {
    log("debug", "download skipped with no cached leads");
    return;
  }
  const csv = toCsv(cachedLeads);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  chrome.runtime.sendMessage(
    { target: "background", action: "download", csv: csv, filename: `sales-navigator-leads-${stamp}.csv` },
    (resp) => {
      if (chrome.runtime.lastError) {
        log("error", "download message failed", { error: chrome.runtime.lastError.message });
        $("status").textContent = "Download failed: " + chrome.runtime.lastError.message;
        return;
      }
      log(resp && resp.ok ? "info" : "error", "download response received", {
        ok: resp && resp.ok,
        error: resp && resp.error
      });
      $("status").textContent = resp && resp.ok ? "Download started." : "Download failed: " + ((resp && resp.error) || "unknown");
    }
  );
});

$("clear").addEventListener("click", async () => {
  log("info", "clear clicked");
  const resp = await clearStoredLeads();
  cachedLeads = [];
  $("count").textContent = "0";
  $("download").disabled = true;
  $("status").textContent = resp && resp.ok ? "Cleared." : "Clear failed.";
  log(resp && resp.ok ? "info" : "warn", "clear complete", {
    ok: resp && resp.ok,
    error: resp && resp.error
  });
});

refresh();
