// background.js — service worker.
// Excel download is handled here so it survives the popup closing.
const LOG_PREFIX = "[SNLE:background]";

function log(level, message, details) {
  const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (details === undefined) method.call(console, LOG_PREFIX, level, message);
  else method.call(console, LOG_PREFIX, level, message, JSON.stringify(details), details);
}

log("info", "service worker loaded", {
  extensionId: chrome.runtime.id,
  time: new Date().toISOString()
});

chrome.runtime.onInstalled.addListener((details) => {
  log("info", "extension installed/updated", {
    reason: details.reason,
    previousVersion: details.previousVersion || ""
  });
});

chrome.runtime.onStartup.addListener(() => {
  log("info", "browser startup event received");
});

self.addEventListener("error", (event) => {
  log("error", "service worker error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno
  });
});

self.addEventListener("unhandledrejection", (event) => {
  log("error", "service worker unhandled rejection", {
    reason: event.reason && (event.reason.stack || event.reason.message || String(event.reason))
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  log("debug", "message received", {
    action: msg && msg.action,
    target: msg && msg.target,
    tabId: sender && sender.tab && sender.tab.id
  });

  if (msg && msg.target === "background" && msg.action === "ping") {
    log("info", "ping received", {
      from: sender && sender.id,
      time: new Date().toISOString()
    });
    sendResponse({ ok: true, time: new Date().toISOString() });
    return false;
  }

  if (msg && msg.target === "background" && msg.action === "download") {
    const xlsxSize = typeof msg.xlsxBase64 === "string" ? msg.xlsxBase64.length : 0;
    const csvSize = typeof msg.csv === "string" ? msg.csv.length : 0;
    const filename = msg.filename || (msg.xlsxBase64 ? "sales-navigator-leads.xlsx" : "sales-navigator-leads.csv");
    log("info", "download requested", {
      filename: filename,
      xlsxBase64Characters: xlsxSize,
      csvCharacters: csvSize
    });

    const dataUrl = msg.xlsxBase64
      ? "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64," + msg.xlsxBase64
      : "data:text/csv;charset=utf-8," + encodeURIComponent(msg.csv || "");
    chrome.downloads.download(
      {
        url: dataUrl,
        filename: filename,
        saveAs: true
      },
      (downloadId) => {
        const error = chrome.runtime.lastError && chrome.runtime.lastError.message;
        if (error) {
          log("error", "download failed", { error: error });
        } else {
          log("info", "download started", { downloadId: downloadId });
        }
        sendResponse({ ok: !error, error: error });
      }
    );
    return true; // async response
  }
});
