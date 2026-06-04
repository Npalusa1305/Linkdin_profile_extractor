// content.js — runs in the isolated content-script world on Sales Navigator pages.
// 1. Injects inject.js into the page so we can observe Sales API responses.
// 2. Receives those responses, parses lead records, and stores them (deduped).
// 3. Answers messages from the popup (get count / get rows / clear).

(function () {
  "use strict";

  const STORAGE_KEY = "snle_leads";
  const LOG_PREFIX = "[SNLE:content]";

  function log(level, message, details) {
    const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    if (details === undefined) method.call(console, LOG_PREFIX, level, message);
    else method.call(console, LOG_PREFIX, level, message, JSON.stringify(details), details);
  }

  window.addEventListener("error", (event) => {
    log("error", "content script error", {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    log("error", "content script unhandled rejection", {
      reason: event.reason && (event.reason.stack || event.reason.message || String(event.reason))
    });
  });

  function trimUrl(url) {
    if (typeof url !== "string") return "";
    return url.length > 180 ? url.slice(0, 177) + "..." : url;
  }

  // ---- inject the page-context interceptor ----
  function injectScript() {
    try {
      log("debug", "injecting page interceptor", { src: chrome.runtime.getURL("inject.js") });
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("inject.js");
      s.onload = function () {
        log("info", "page interceptor loaded");
        this.remove();
      };
      s.onerror = function () {
        log("error", "page interceptor failed to load");
        this.remove();
      };
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      log("warn", "inject failed", { error: e && e.message });
    }
  }
  injectScript();

  // ---- helpers ----
  function firstString() {
    for (let i = 0; i < arguments.length; i++) {
      const v = arguments[i];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  }

  function get(obj, path) {
    try {
      return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
    } catch (e) {
      return undefined;
    }
  }

  // Extract the ACwAA... member token and tracking params from an entityUrn like
  // urn:li:fs_salesProfile:(ACwAABc123,NAME_SEARCH,abcd)
  function parseSalesUrn(entityUrn) {
    const out = { id: "", leadPath: "" };
    if (typeof entityUrn !== "string") return out;
    const m = entityUrn.match(/\(([^)]+)\)/);
    if (m && m[1]) {
      out.leadPath = m[1]; // e.g. ACwAABc123,NAME_SEARCH,abcd
      out.id = m[1].split(",")[0];
    } else {
      // sometimes the urn is just urn:li:member:123 — keep numeric id
      const mm = entityUrn.match(/urn:li:[^:]+:(.+)$/);
      if (mm) out.id = mm[1];
    }
    return out;
  }

  // Convert an ISO-ish start date or {year, month} into "N years" of tenure.
  function tenureFromStart(started) {
    if (!started) return "";
    let year, month;
    if (typeof started === "object") {
      year = started.year;
      month = started.month || 1;
    } else if (typeof started === "number") {
      // epoch ms
      const d = new Date(started);
      year = d.getFullYear();
      month = d.getMonth() + 1;
    }
    if (!year) return "";
    const now = new Date();
    let months = (now.getFullYear() - year) * 12 + (now.getMonth() + 1 - month);
    if (months < 0) months = 0;
    const years = Math.floor(months / 12);
    if (years >= 1) return years + (years === 1 ? " year" : " years");
    return months + (months === 1 ? " month" : " months");
  }

  function tenureValue(pos, startKeys, monthKey) {
    // Prefer explicit month counts if present, else compute from a start date.
    if (monthKey != null && typeof pos[monthKey] === "number") {
      const yrs = Math.floor(pos[monthKey] / 12);
      return yrs >= 1 ? yrs + (yrs === 1 ? " year" : " years") : pos[monthKey] + " months";
    }
    for (const k of startKeys) {
      if (pos[k]) {
        const t = tenureFromStart(pos[k]);
        if (t) return t;
      }
    }
    return "";
  }

  function positionsArray(el) {
    // Try the various shapes Sales Navigator has used over time.
    return (
      el.currentPositions ||
      get(el, "fullProfile.currentPositions") ||
      el.positions ||
      (el.defaultPosition ? [el.defaultPosition] : []) ||
      []
    );
  }

  function pastPositionsArray(el) {
    return el.pastPositions || get(el, "fullProfile.pastPositions") || [];
  }

  function arrayFrom() {
    for (let i = 0; i < arguments.length; i++) {
      const v = arguments[i];
      if (Array.isArray(v)) return v;
    }
    return [];
  }

  function isLeadLike(obj) {
    if (!obj || typeof obj !== "object") return false;
    return Boolean(
      obj.firstName ||
      obj.lastName ||
      obj.fullName ||
      obj.publicIdentifier ||
      obj.flagshipProfileUrl ||
      obj.currentTitle ||
      get(obj, "fullProfile.firstName") ||
      get(obj, "fullProfile.lastName") ||
      get(obj, "miniProfile.firstName") ||
      get(obj, "profile.firstName") ||
      firstString(obj.entityUrn, obj.objectUrn, get(obj, "salesProfile.entityUrn")).indexOf("salesProfile") !== -1
    );
  }

  function unwrapLeadCandidate(candidate) {
    if (!candidate || typeof candidate !== "object") return candidate;
    return (
      candidate.lead ||
      candidate.profile ||
      candidate.salesProfile ||
      candidate.member ||
      candidate.miniProfile ||
      get(candidate, "entity.profile") ||
      get(candidate, "entity.salesProfile") ||
      get(candidate, "target.profile") ||
      get(candidate, "target.salesProfile") ||
      candidate
    );
  }

  function pushCandidate(candidates, seen, candidate, source) {
    const unwrapped = unwrapLeadCandidate(candidate);
    if (!unwrapped || typeof unwrapped !== "object" || seen.has(unwrapped)) return;
    if (!isLeadLike(unwrapped)) return;
    seen.add(unwrapped);
    candidates.push({ element: unwrapped, source: source });
  }

  function findLeadCandidates(payload) {
    const candidates = [];
    const seenCandidates = new WeakSet();
    const seenNodes = new WeakSet();
    const queue = [{ value: payload, path: "$", depth: 0 }];
    const maxNodes = 6000;
    const maxDepth = 12;
    let visited = 0;

    while (queue.length && visited < maxNodes) {
      const item = queue.shift();
      const value = item.value;
      if (!value || typeof value !== "object" || seenNodes.has(value)) continue;
      seenNodes.add(value);
      visited++;

      pushCandidate(candidates, seenCandidates, value, item.path);

      if (Array.isArray(value)) {
        const pathLooksUseful = /(?:elements|included|profiles|leads|results|items|records|entities)$/i.test(item.path);
        if (pathLooksUseful) {
          for (let i = 0; i < value.length; i++) {
            pushCandidate(candidates, seenCandidates, value[i], item.path + "[" + i + "]");
          }
        }
        if (item.depth < maxDepth) {
          for (let i = 0; i < value.length; i++) {
            queue.push({ value: value[i], path: item.path + "[" + i + "]", depth: item.depth + 1 });
          }
        }
        continue;
      }

      const directArrays = [
        ["elements", value.elements],
        ["included", value.included],
        ["profiles", value.profiles],
        ["leads", value.leads],
        ["results", value.results],
        ["items", value.items],
        ["records", value.records],
        ["data.elements", get(value, "data.elements")],
        ["data.included", get(value, "data.included")],
        ["data.profiles", get(value, "data.profiles")],
        ["data.leads", get(value, "data.leads")]
      ];

      for (const pair of directArrays) {
        const arr = pair[1];
        if (!Array.isArray(arr)) continue;
        for (let i = 0; i < arr.length; i++) {
          pushCandidate(candidates, seenCandidates, arr[i], item.path + "." + pair[0] + "[" + i + "]");
        }
      }

      if (item.depth >= maxDepth) continue;
      for (const key of Object.keys(value)) {
        const child = value[key];
        if (child && typeof child === "object") {
          queue.push({ value: child, path: item.path + "." + key, depth: item.depth + 1 });
        }
      }
    }

    return {
      candidates: candidates,
      visited: visited,
      truncated: queue.length > 0
    };
  }

  // Map one Sales API element to our flat record.
  function mapElement(el) {
    if (!el || typeof el !== "object") return null;

    const entityUrn = firstString(
      el.entityUrn,
      el.objectUrn,
      get(el, "salesProfile.entityUrn"),
      get(el, "miniProfile.entityUrn"),
      get(el, "profile.entityUrn")
    );
    const objectUrn = firstString(
      el.objectUrn,
      el.entityUrn,
      get(el, "salesProfile.objectUrn"),
      get(el, "miniProfile.objectUrn"),
      get(el, "profile.objectUrn")
    );
    const { id, leadPath } = parseSalesUrn(entityUrn || objectUrn);
    if (!id && !el.fullName && !el.firstName) return null;

    const firstName = firstString(
      el.firstName,
      get(el, "fullProfile.firstName"),
      get(el, "miniProfile.firstName"),
      get(el, "profile.firstName")
    );
    const lastName = firstString(
      el.lastName,
      get(el, "fullProfile.lastName"),
      get(el, "miniProfile.lastName"),
      get(el, "profile.lastName")
    );
    const fullName = firstString(
      el.fullName,
      get(el, "name.text"),
      get(el, "fullProfile.fullName"),
      get(el, "miniProfile.fullName"),
      get(el, "profile.fullName"),
      (firstName + " " + lastName).trim()
    );

    const cur = positionsArray(el)[0] || {};
    const role = firstString(cur.title, el.currentTitle, get(el, "headline.text"), get(el, "title.text"));
    const company = firstString(
      cur.companyName,
      get(cur, "company.name"),
      el.companyName,
      get(el, "company.name")
    );
    const companyUrn = firstString(cur.companyUrn, get(cur, "company.entityUrn"), get(cur, "company.objectUrn"));
    const companyUrl = companyUrn
      ? "https://www.linkedin.com/sales/company/" + (parseSalesUrn(companyUrn).id || companyUrn.split(":").pop())
      : "";

    const past = pastPositionsArray(el)
      .map((p) => {
        const t = firstString(p.title);
        const c = firstString(p.companyName, get(p, "company.name"));
        return [t, c].filter(Boolean).join(" @ ");
      })
      .filter(Boolean)
      .join(" | ");

    const education = arrayFrom(el.educations, el.education, get(el, "fullProfile.educations"))
      .map((e) => firstString(e.schoolName, e.school, get(e, "school.name")))
      .filter(Boolean)
      .join(" | ");

    const location = firstString(
      el.geoRegion,
      el.location,
      get(el, "fullProfile.geoRegion"),
      get(el, "location.name")
    );

    const industry = firstString(
      el.industry,
      get(el, "industryV2.name"),
      get(el, "company.industry"),
      get(cur, "company.industry")
    );

    const about = firstString(el.summary, get(el, "fullProfile.summary"), el.about);

    const sharedCount =
      el.numOfSharedConnections != null
        ? el.numOfSharedConnections
        : (el.sharedConnections && el.sharedConnections.length) || "";
    const sharedNames = (el.sharedConnections || [])
      .map((s) => firstString(s.fullName, ((s.firstName || "") + " " + (s.lastName || "")).trim()))
      .filter(Boolean)
      .join(" | ");

    const publicId = firstString(
      el.publicIdentifier,
      get(el, "fullProfile.publicIdentifier"),
      get(el, "miniProfile.publicIdentifier"),
      get(el, "profile.publicIdentifier")
    );
    const recordId = id || publicId || fullName;
    const profileLink = firstString(
      el.flagshipProfileUrl,
      publicId ? "https://www.linkedin.com/in/" + publicId : ""
    );
    const salesNavLink = leadPath ? "https://www.linkedin.com/sales/lead/" + leadPath : "";

    return {
      id: recordId,
      linkedinName: fullName,
      firstName: firstName,
      lastName: lastName,
      emailDiscovery: "",
      emailDeliverability: "",
      emailType: "",
      emailCatchAll: "",
      emailAlternate: "",
      description: firstString(el.headline && el.headline.text, role),
      organisationRole: role,
      organisationName: company,
      organisationUrl: companyUrl,
      organisationIndustry: industry,
      organisationSize: firstString(get(cur, "company.employeeCountRange"), el.companySize),
      location: location,
      industry: industry,
      currentRole: role,
      seniority: firstString(el.seniority, cur.seniority),
      jobFunction: firstString(el.function, cur.function, el.jobFunction),
      pastRoles: past,
      education: education,
      tenureAtCompany: tenureValue(cur, ["tenureAtCompanyStartedOn", "companyStartedOn", "startedOn"], "tenureAtCompany"),
      tenureInRole: tenureValue(cur, ["tenureStartedOn", "startedOn", "tenureAtPositionStartedOn"], "tenureAtPosition"),
      nameResolution: fullName,
      profileLink: profileLink,
      salesNavLink: salesNavLink,
      about: about,
      sharedConnections: sharedNames,
      sharedConnectionsCount: sharedCount
    };
  }

  // Pull lead elements out of an arbitrary Sales API payload.
  function extractElements(payload) {
    const out = [];
    if (!payload || typeof payload !== "object") {
      log("debug", "extract skipped non-object payload", { type: typeof payload });
      return out;
    }

    const result = findLeadCandidates(payload);
    const candidates = result.candidates;

    log("debug", "extracting lead candidates", {
      candidates: candidates.length,
      payloadKeys: Object.keys(payload).slice(0, 12),
      visitedNodes: result.visited,
      truncated: result.truncated,
      sampleSources: candidates.slice(0, 5).map((c) => c.source)
    });

    let mapped = 0;
    let missingId = 0;
    for (const c of candidates) {
      const el = c.element;
      const rec = mapElement(el);
      if (rec && rec.id) {
        mapped++;
        out.push(rec);
      } else if (rec) {
        missingId++;
      }
    }
    log("debug", "candidate extraction complete", {
      candidates: candidates.length,
      mapped: mapped,
      missingId: missingId
    });
    return out;
  }

  // ---- storage ----
  function saveRecords(records) {
    if (!records.length) {
      log("debug", "save skipped with no records");
      return;
    }
    chrome.storage.local.get([STORAGE_KEY], (data) => {
      const readError = chrome.runtime.lastError && chrome.runtime.lastError.message;
      if (readError) {
        log("error", "failed to read storage", { error: readError });
        return;
      }
      const map = data[STORAGE_KEY] || {};
      let added = 0;
      let updated = 0;
      for (const r of records) {
        if (!map[r.id]) added++;
        else updated++;
        // merge — keep any previously-captured non-empty fields
        map[r.id] = Object.assign({}, map[r.id] || {}, prune(r, map[r.id]));
      }
      chrome.storage.local.set({ [STORAGE_KEY]: map }, () => {
        const writeError = chrome.runtime.lastError && chrome.runtime.lastError.message;
        if (writeError) {
          log("error", "failed to write storage", { error: writeError });
          return;
        }
        log(added ? "info" : "debug", "records persisted", {
          received: records.length,
          added: added,
          updated: updated,
          total: Object.keys(map).length
        });
      });
    });
  }

  // Don't let a later, sparser response wipe earlier good values.
  function prune(fresh, existing) {
    if (!existing) return fresh;
    const merged = {};
    for (const k of Object.keys(fresh)) {
      merged[k] = fresh[k] !== "" && fresh[k] != null ? fresh[k] : existing[k];
    }
    return merged;
  }

  // ---- message bridge from the page ----
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== "snle-inject") return;
    if (d.type === "ready") {
      log("info", "page interceptor ready");
      return;
    }
    if (d.type === "sales-api-response") {
      try {
        log("debug", "sales api response received", {
          url: trimUrl(d.url),
          payloadKeys: d.payload && typeof d.payload === "object" ? Object.keys(d.payload).slice(0, 12) : []
        });
        const recs = extractElements(d.payload);
        if (recs.length) {
          log("debug", "saving extracted records", {
            url: trimUrl(d.url),
            records: recs.length,
            sampleIds: recs.slice(0, 5).map((r) => r.id)
          });
          saveRecords(recs);
        } else {
          log("debug", "no leads found in response", { url: trimUrl(d.url) });
        }
      } catch (e) {
        log("warn", "parse error", {
          url: trimUrl(d.url),
          error: e && e.message,
          stack: e && e.stack
        });
      }
    }
  });

  // ---- message bridge from the popup ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== "content") return;
    log("debug", "popup message received", {
      action: msg.action,
      senderId: sender && sender.id
    });
    if (msg.action === "getLeads") {
      chrome.storage.local.get([STORAGE_KEY], (data) => {
        const error = chrome.runtime.lastError && chrome.runtime.lastError.message;
        if (error) {
          log("error", "failed to read leads for popup", { error: error });
          sendResponse({ leads: [], error: error });
          return;
        }
        const map = data[STORAGE_KEY] || {};
        log("debug", "returning leads to popup", { count: Object.keys(map).length });
        sendResponse({ leads: Object.values(map) });
      });
      return true; // async
    }
    if (msg.action === "clear") {
      chrome.storage.local.set({ [STORAGE_KEY]: {} }, () => {
        const error = chrome.runtime.lastError && chrome.runtime.lastError.message;
        if (error) {
          log("error", "failed to clear leads", { error: error });
          sendResponse({ ok: false, error: error });
          return;
        }
        log("info", "captured leads cleared");
        sendResponse({ ok: true });
      });
      return true;
    }
  });

  log("info", "content script initialized", {
    url: trimUrl(location.href),
    readyState: document.readyState
  });
})();
