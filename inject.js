// inject.js — runs in the PAGE context (not the isolated content-script world).
// It monkeypatches fetch() and XMLHttpRequest so it can observe the JSON that
// Sales Navigator's Ember app downloads from LinkedIn's internal Sales API.
// Matching responses are forwarded to the content script via window.postMessage.
(function () {
  "use strict";

  const LOG_PREFIX = "[SNLE:inject]";

  function log(level, message, details) {
    const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    if (details === undefined) method.call(console, LOG_PREFIX, level, message);
    else method.call(console, LOG_PREFIX, level, message, JSON.stringify(details), details);
  }

  function trimUrl(url) {
    if (typeof url !== "string") return "";
    return url.length > 180 ? url.slice(0, 177) + "..." : url;
  }

  // Endpoints that carry lead/people data. Sales Navigator changes these
  // occasionally, so we match loosely on substrings.
  const INTERESTING = [
    "salesApiLeadSearch",
    "salesApiPeopleSearch",
    "salesApiLeadsByList",
    "salesApiSavedLeads",
    "salesApiSearchSpotlights",
    "salesApiLeads", // single-lead profile fetch
    "/sales-api/salesApi",
    "voyagerSalesDash",
    "salesDash",
    "salesSearchDash",
    "salesLead",
    "salesProfile",
    "/voyager/api/graphql"
  ];

  function isInteresting(url) {
    if (!url) return false;
    return INTERESTING.some((s) => url.indexOf(s) !== -1);
  }

  function forward(url, text) {
    if (!text) {
      log("debug", "skipping empty response", { url: trimUrl(url) });
      return;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      log("debug", "skipping non-json response", {
        url: trimUrl(url),
        characters: text.length
      });
      return; // not JSON — ignore
    }
    try {
      log("debug", "forwarding sales api response", {
        url: trimUrl(url),
        characters: text.length,
        topLevelKeys: json && typeof json === "object" ? Object.keys(json).slice(0, 12) : []
      });
      window.postMessage(
        { source: "snle-inject", type: "sales-api-response", url: url, payload: json },
        "https://www.linkedin.com"
      );
    } catch (e) {
      log("warn", "failed to forward response", {
        url: trimUrl(url),
        error: e && e.message
      });
      // postMessage can throw on huge / circular payloads; ignore.
    }
  }

  function readXhrBody(xhr, url) {
    if (xhr.responseType === "" || xhr.responseType === "text") {
      forward(url, xhr.responseText);
      return;
    }

    if (xhr.responseType === "blob") {
      const blob = xhr.response;
      if (blob && typeof blob.text === "function") {
        blob.text().then((text) => forward(url, text)).catch((e) => {
          log("warn", "failed to read xhr blob response", {
            url: trimUrl(url),
            error: e && e.message
          });
        });
        return;
      }
    }

    if (xhr.responseType === "arraybuffer") {
      try {
        const text = new TextDecoder("utf-8").decode(xhr.response);
        forward(url, text);
      } catch (e) {
        log("warn", "failed to decode xhr arraybuffer response", {
          url: trimUrl(url),
          error: e && e.message
        });
      }
      return;
    }

    log("debug", "skipping unsupported xhr response type", {
      url: trimUrl(url),
      responseType: xhr.responseType
    });
  }

  // --- fetch ---
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input && input.url;
      const p = origFetch.apply(this, arguments);
      if (isInteresting(url)) {
        log("debug", "observing fetch", { url: trimUrl(url) });
        p.then((res) => {
          try {
            res.clone().text().then((t) => forward(url, t)).catch((e) => {
              log("warn", "failed to read fetch response", {
                url: trimUrl(url),
                error: e && e.message
              });
            });
          } catch (e) {
            log("warn", "failed to clone fetch response", {
              url: trimUrl(url),
              error: e && e.message
            });
          }
        }).catch((e) => {
          log("warn", "observed fetch rejected", {
            url: trimUrl(url),
            error: e && e.message
          });
        });
      }
      return p;
    };
  }

  // --- XMLHttpRequest ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__snleUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const url = this.__snleUrl;
    if (isInteresting(url)) {
      log("debug", "observing xhr", { url: trimUrl(url) });
      this.addEventListener("load", function () {
        try {
          readXhrBody(this, url);
        } catch (e) {
          log("warn", "failed to read xhr response", {
            url: trimUrl(url),
            error: e && e.message
          });
        }
      });
    }
    return origSend.apply(this, arguments);
  };

  log("info", "interceptor installed", {
    fetch: Boolean(origFetch),
    xhr: Boolean(origOpen && origSend),
    patterns: INTERESTING.length
  });
  window.postMessage({ source: "snle-inject", type: "ready" }, "https://www.linkedin.com");
})();
