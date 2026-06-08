// content.js — runs in the isolated content-script world on Sales Navigator pages.
// 1. Injects inject.js into the page so we can observe Sales API responses.
// 2. Receives those responses, parses lead records, and stores them (deduped).
// 3. Answers messages from the popup (get count / get rows / clear).

(function () {
  "use strict";

  const STORAGE_KEY = "snle_leads";
  const PENDING_COLLECTION_KEY = "snle_pending_collection";
  const COLLECTION_STATE_KEY = "snle_collection_state";
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

  function clearCapturedDataForPageLoad(callback) {
    chrome.storage.local.set({ [STORAGE_KEY]: {}, [COLLECTION_STATE_KEY]: {} }, () => {
      const writeError = chrome.runtime.lastError && chrome.runtime.lastError.message;
      if (writeError) {
        log("error", "failed to clear storage on page load", { error: writeError });
      } else {
        log("info", "captured data cleared for fresh page load");
      }
      if (typeof callback === "function") callback();
    });
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
  function bootContentScript() {
    chrome.storage.local.get([PENDING_COLLECTION_KEY], (data) => {
      const pending = data[PENDING_COLLECTION_KEY];
      const afterClear = () => {
        injectScript();
        resumePendingCollection();
        resumeActiveCollection();
      };
      if (pending && !pending.skipCurrent) clearCapturedDataForPageLoad(afterClear);
      else afterClear();
    });
  }

  bootContentScript();

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

  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;

  function normalizeEmail(value) {
    if (typeof value !== "string") return "";
    const match = value.match(EMAIL_RE);
    return match && match[0] ? match[0].trim().toLowerCase() : "";
  }

  function normalizeKey(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function publicIdFromProfileUrl(url) {
    if (typeof url !== "string") return "";
    const match = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
    return match && match[1] ? decodeURIComponent(match[1]).replace(/\/$/, "") : "";
  }

  function findEmails(obj) {
    const emails = [];
    const seenEmails = new Set();
    const seenNodes = new WeakSet();
    const queue = [{ value: obj, depth: 0 }];
    const maxNodes = 1200;
    const maxDepth = 8;
    let visited = 0;

    function addEmail(value) {
      const email = normalizeEmail(value);
      if (!email || seenEmails.has(email)) return;
      seenEmails.add(email);
      emails.push(email);
    }

    while (queue.length && visited < maxNodes && emails.length < 5) {
      const item = queue.shift();
      const value = item.value;
      if (value == null) continue;

      if (typeof value === "string") {
        addEmail(value);
        continue;
      }

      if (typeof value !== "object" || seenNodes.has(value)) continue;
      seenNodes.add(value);
      visited++;

      const entries = Array.isArray(value)
        ? value.map((child, index) => [String(index), child])
        : Object.keys(value).map((key) => [key, value[key]]);

      // Email-named fields are most likely to be trustworthy, so inspect them first.
      entries.sort((a, b) => {
        const ae = /email|e-?mail|mail/i.test(a[0]) ? 0 : 1;
        const be = /email|e-?mail|mail/i.test(b[0]) ? 0 : 1;
        return ae - be;
      });

      for (const pair of entries) {
        const key = pair[0];
        const child = pair[1];
        if (typeof child === "string" && /email|e-?mail|mail|address/i.test(key)) {
          addEmail(child);
        }
        if (item.depth < maxDepth && child && typeof child === "object") {
          queue.push({ value: child, depth: item.depth + 1 });
        } else if (typeof child === "string" && emails.length < 5) {
          addEmail(child);
        }
      }
    }

    return emails;
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
      get(el, "profile.currentPositions") ||
      get(el, "salesProfile.currentPositions") ||
      el.positions ||
      get(el, "fullProfile.positions") ||
      get(el, "profile.positions") ||
      (el.defaultPosition ? [el.defaultPosition] : []) ||
      []
    );
  }

  function pastPositionsArray(el) {
    return arrayFrom(
      el.pastPositions,
      get(el, "fullProfile.pastPositions"),
      get(el, "profile.pastPositions"),
      get(el, "salesProfile.pastPositions"),
      el.previousPositions,
      get(el, "fullProfile.previousPositions"),
      get(el, "profile.previousPositions")
    );
  }

  function arrayFrom() {
    for (let i = 0; i < arguments.length; i++) {
      const v = arguments[i];
      if (Array.isArray(v)) return v;
    }
    return [];
  }

  function inferSeniority(title) {
    const t = String(title || "").toLowerCase();
    if (!t) return "";
    if (/\b(founder|co[-\s]?founder|owner|partner)\b/.test(t)) return "Founder/Owner";
    if (/\b(chief|ceo|cto|cfo|coo|cio|cmo|cro|cpo|president)\b/.test(t)) return "C-Level";
    if (/\b(vp|vice president|svp|evp)\b/.test(t)) return "VP";
    if (/\b(head|director|managing director)\b/.test(t)) return "Director";
    if (/\b(manager|lead|principal)\b/.test(t)) return "Manager";
    if (/\b(senior|sr\.?|staff)\b/.test(t)) return "Senior";
    if (/\b(intern|trainee|student)\b/.test(t)) return "Entry";
    return "";
  }

  function inferJobFunction(title) {
    const t = String(title || "").toLowerCase();
    if (!t) return "";
    if (/\b(engineer|engineering|developer|software|frontend|backend|full stack|data scientist|devops|sre|architect)\b/.test(t)) return "Engineering";
    if (/\b(sales|account executive|business development|revenue|growth|partnership)\b/.test(t)) return "Sales";
    if (/\b(marketing|brand|demand generation|seo|content|communications)\b/.test(t)) return "Marketing";
    if (/\b(product|program manager|project manager|scrum)\b/.test(t)) return "Product/Program";
    if (/\b(finance|financial|accounting|controller|treasury|fp&a)\b/.test(t)) return "Finance";
    if (/\b(hr|people|talent|recruit|human resources)\b/.test(t)) return "Human Resources";
    if (/\b(operations|supply chain|logistics|procurement)\b/.test(t)) return "Operations";
    if (/\b(legal|counsel|attorney|compliance)\b/.test(t)) return "Legal";
    if (/\b(customer success|support|client services|implementation)\b/.test(t)) return "Customer Success";
    if (/\b(design|designer|ux|ui|creative)\b/.test(t)) return "Design";
    if (/\b(research|scientist|faculty|professor|teacher|instructor)\b/.test(t)) return "Education/Research";
    if (/\b(consultant|strategy|business analyst|analyst)\b/.test(t)) return "Consulting/Strategy";
    return "";
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
      get(el, "company.name"),
      get(el, "currentCompany.name")
    );
    const companyUrn = firstString(
      cur.companyUrn,
      get(cur, "company.entityUrn"),
      get(cur, "company.objectUrn"),
      el.companyUrn,
      get(el, "company.entityUrn"),
      get(el, "company.objectUrn"),
      get(el, "currentCompany.entityUrn"),
      get(el, "currentCompany.objectUrn")
    );
    const companyId = firstString(
      parseSalesUrn(companyUrn).id,
      get(cur, "company.id"),
      get(el, "company.id"),
      get(el, "currentCompany.id")
    );
    const companyUrl = companyUrn
      ? "https://www.linkedin.com/sales/company/" + (companyId || companyUrn.split(":").pop())
      : "";
    const companyWebsite = firstString(
      get(cur, "company.website"),
      get(cur, "company.websiteUrl"),
      get(cur, "company.companyWebsite"),
      get(el, "company.website"),
      get(el, "company.websiteUrl"),
      get(el, "currentCompany.website"),
      get(el, "currentCompany.websiteUrl")
    );

    const past = pastPositionsArray(el)
      .map((p) => {
        const t = firstString(p.title, get(p, "title.text"));
        const c = firstString(p.companyName, get(p, "company.name"), p.company);
        return [t, c].filter(Boolean).join(" @ ");
      })
      .filter(Boolean)
      .join(" | ");

    const education = arrayFrom(
      el.educations,
      el.education,
      get(el, "fullProfile.educations"),
      get(el, "profile.educations"),
      get(el, "salesProfile.educations")
    )
      .map((e) => firstString(e.schoolName, e.school, get(e, "school.name"), get(e, "schoolName.text")))
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
    const seniority = firstString(el.seniority, cur.seniority, get(el, "seniority.name"), inferSeniority(role));
    const jobFunction = firstString(
      el.function,
      cur.function,
      el.jobFunction,
      get(el, "function.name"),
      get(cur, "function.name"),
      inferJobFunction(role)
    );

    const publicId = firstString(
      el.publicIdentifier,
      get(el, "fullProfile.publicIdentifier"),
      get(el, "miniProfile.publicIdentifier"),
      get(el, "profile.publicIdentifier")
    );
    const profileLink = firstString(
      el.flagshipProfileUrl,
      get(el, "miniProfile.flagshipProfileUrl"),
      get(el, "profile.flagshipProfileUrl"),
      get(el, "fullProfile.flagshipProfileUrl"),
      publicId ? "https://www.linkedin.com/in/" + publicId : ""
    );
    const resolvedPublicId = firstString(publicId, publicIdFromProfileUrl(profileLink));
    const recordId = resolvedPublicId || id || fullName;
    const salesNavLink = leadPath ? "https://www.linkedin.com/sales/lead/" + leadPath : "";
    const emails = findEmails(el);
    const emailDiscovery = firstString(
      emails[0],
      normalizeEmail(el.email),
      normalizeEmail(el.emailAddress),
      normalizeEmail(el.primaryEmail),
      normalizeEmail(get(el, "contactInfo.email")),
      normalizeEmail(get(el, "contactInfo.emailAddress")),
      normalizeEmail(get(el, "profile.email")),
      normalizeEmail(get(el, "fullProfile.email"))
    );

    return {
      id: recordId,
      linkedinName: fullName,
      firstName: firstName,
      lastName: lastName,
      emailDiscovery: emailDiscovery,
      emailDeliverability: firstString(
        el.emailDeliverability,
        el.emailStatus,
        el.emailVerificationStatus,
        get(el, "email.deliverability"),
        get(el, "email.status")
      ),
      emailType: firstString(el.emailType, get(el, "email.type")),
      emailCatchAll: firstString(el.emailCatchAll, get(el, "email.catchAll"), get(el, "email.isCatchAll")),
      emailAlternate: emails.slice(1).join(" | "),
      description: firstString(el.headline && el.headline.text, role),
      organisationRole: role,
      organisationName: company,
      organisationId: companyId,
      organisationUrl: companyUrl,
      organisationSalesNavLink: companyUrl,
      organisationWebsite: companyWebsite,
      organisationIndustry: industry,
      organisationSize: firstString(
        get(cur, "company.employeeCountRange"),
        get(cur, "company.employeeCount"),
        get(el, "company.employeeCountRange"),
        get(el, "company.employeeCount"),
        el.companySize
      ),
      location: location,
      industry: industry,
      currentRole: role,
      seniority: seniority,
      jobFunction: jobFunction,
      pastRoles: past,
      education: education,
      tenureAtCompany: tenureValue(cur, ["tenureAtCompanyStartedOn", "companyStartedOn", "startedOn"], "tenureAtCompany"),
      tenureInRole: tenureValue(cur, ["tenureStartedOn", "startedOn", "tenureAtPositionStartedOn"], "tenureAtPosition"),
      nameResolution: fullName,
      profileLink: profileLink,
      salesNavLink: salesNavLink,
      about: about,
      sharedConnections: sharedNames,
      sharedConnectionNames: sharedNames,
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
    if (!paginationState.running) {
      log("debug", "save skipped outside active collection", { received: records.length });
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
      let skippedByLimit = 0;
      let skippedSparse = 0;
      let skippedByPageLimit = 0;
      const maxStoredLeads = paginationState.running && paginationState.maxPages
        ? paginationState.maxPages * 25
        : 0;
      for (const r of records) {
        if (!hasUsefulLeadDetails(r)) {
          skippedSparse++;
          continue;
        }
        const storageKey = storageKeyForRecord(r, map);
        const isNew = !map[storageKey];
        if (isNew && paginationState.currentPageSaved >= 25) {
          skippedByPageLimit++;
          continue;
        }
        if (isNew && maxStoredLeads && Object.keys(map).length >= maxStoredLeads) {
          skippedByLimit++;
          continue;
        }
        if (isNew) {
          added++;
          paginationState.currentPageSaved++;
          paginationState.captureSequence++;
          r.__capturePage = currentPageNumber();
          r.__captureOrder = paginationState.captureSequence;
        }
        else updated++;
        // merge — keep any previously-captured non-empty fields
        map[storageKey] = Object.assign({}, map[storageKey] || {}, prune(r, map[storageKey]));
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
          skippedByLimit: skippedByLimit,
          skippedSparse: skippedSparse,
          skippedByPageLimit: skippedByPageLimit,
          total: Object.keys(map).length
        });
        paginationState.lastLeadCount = Object.keys(map).length;
        updateEstimatedProfiles();
        paginationState.lastMessage = added
          ? `Captured ${added} new lead(s)`
          : paginationState.lastMessage;
        persistPaginationState();
      });
    });
  }

  function hasUsefulLeadDetails(record) {
    if (!record || !record.linkedinName) return false;
    return Boolean(
      record.currentRole ||
      record.description ||
      record.organisationName ||
      record.location ||
      record.profileLink
    );
  }

  function recordIdentity(record) {
    const publicId = publicIdFromProfileUrl(record.profileLink);
    if (publicId) return "public:" + normalizeKey(publicId);
    const name = normalizeKey(record.linkedinName);
    const org = normalizeKey(record.organisationName);
    return name ? "name:" + name + "|org:" + org : "id:" + normalizeKey(record.id);
  }

  function storageKeyForRecord(record, map) {
    const identity = recordIdentity(record);
    const fallback = record.id || identity;
    for (const key of Object.keys(map)) {
      if (recordIdentity(map[key]) === identity) return key;
      if (
        normalizeKey(map[key].linkedinName) &&
        normalizeKey(map[key].linkedinName) === normalizeKey(record.linkedinName) &&
        (!map[key].organisationName || !record.organisationName || normalizeKey(map[key].organisationName) === normalizeKey(record.organisationName))
      ) {
        return key;
      }
    }
    return fallback;
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

  // ---- pagination ----
  const paginationState = {
    running: false,
    stopped: false,
    pagesVisited: 0,
    pagesAttempted: 0,
    maxPages: 0,
    delayMs: 0,
    startedAt: 0,
    nextActionAt: 0,
    currentPage: 1,
    currentUrl: "",
    lastTransitionOk: false,
    lastLeadCount: 0,
    leadsAtStart: 0,
    pagesWithLeadDeltas: 0,
    currentPageSaved: 0,
    captureSequence: 0,
    observedLeadsPerPage: 25,
    estimatedProfiles: 0,
    skipCurrent: false,
    lastMessage: ""
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function cancellableDelay(ms) {
    const endAt = Date.now() + ms;
    paginationState.nextActionAt = endAt;
    persistPaginationState({ resumeAfterLoad: false });
    while (!paginationState.stopped && Date.now() < endAt) {
      await sleep(Math.min(500, endAt - Date.now()));
      persistPaginationState({ resumeAfterLoad: false });
    }
    return !paginationState.stopped;
  }

  function storedLeadCount() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (data) => {
        const map = data[STORAGE_KEY] || {};
        resolve(Object.keys(map).length);
      });
    });
  }

  function updateEstimatedProfiles() {
    paginationState.estimatedProfiles = Math.max(
      paginationState.maxPages * paginationState.observedLeadsPerPage,
      paginationState.lastLeadCount - paginationState.leadsAtStart
    );
  }

  function orderedMapValues(map) {
    return Object.values(map).sort((a, b) => {
      const ao = Number(a.__captureOrder) || 0;
      const bo = Number(b.__captureOrder) || 0;
      return ao - bo;
    });
  }

  function persistPaginationState(extra) {
    chrome.storage.local.set({
      [COLLECTION_STATE_KEY]: Object.assign({}, paginationState, extra || {}, {
        updatedAt: Date.now()
      })
    });
  }

  async function updateLeadDelta(previousLeadCount) {
    const currentLeadCount = await storedLeadCount();
    const delta = Math.max(0, currentLeadCount - previousLeadCount);
    paginationState.lastLeadCount = currentLeadCount;
    if (delta > 0) {
      paginationState.pagesVisited++;
      paginationState.pagesWithLeadDeltas++;
      paginationState.observedLeadsPerPage = Math.max(
        1,
        Math.round((currentLeadCount - paginationState.leadsAtStart) / paginationState.pagesWithLeadDeltas)
      );
      updateEstimatedProfiles();
    }
    return delta;
  }

  async function waitForLeadDelta(previousLeadCount, timeoutMs) {
    const started = Date.now();
    let lastLeadCount = previousLeadCount;
    while (!paginationState.stopped && Date.now() - started < timeoutMs) {
      await sleep(500);
      const leadCount = await storedLeadCount();
      if (leadCount !== lastLeadCount) {
        paginationState.lastLeadCount = leadCount;
        lastLeadCount = leadCount;
      }
      if (leadCount > previousLeadCount) return leadCount - previousLeadCount;
    }
    return 0;
  }

  function isVisible(el) {
    if (!el || typeof el.getBoundingClientRect !== "function") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function currentPageNumber() {
    try {
      const page = new URL(location.href).searchParams.get("page");
      const n = parseInt(page, 10);
      return Number.isNaN(n) ? 1 : n;
    } catch (e) {
      return 1;
    }
  }

  function updatePaginationLocation() {
    paginationState.currentPage = currentPageNumber();
    paginationState.currentUrl = location.href;
  }

  function isDisabled(el) {
    if (!el) return true;
    return Boolean(
      el.disabled ||
      el.getAttribute("aria-disabled") === "true" ||
      el.getAttribute("disabled") != null ||
      /\bdisabled\b|artdeco-button--disabled|ember-view--disabled/.test(el.className || "")
    );
  }

  function elementText(el) {
    return firstString(
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.textContent
    ).toLowerCase();
  }

  function findNextPageControl() {
    const selectors = [
      "button[aria-label*='Next']",
      "a[aria-label*='Next']",
      "button[title*='Next']",
      "a[title*='Next']",
      "button[data-control-name*='next']",
      "a[data-control-name*='next']",
      "button",
      "a"
    ];
    const seen = new Set();
    const candidates = [];

    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el)) continue;
        seen.add(el);
        candidates.push(el);
      }
    }

    return candidates.find((el) => {
      if (!isVisible(el) || isDisabled(el)) return false;
      const text = elementText(el);
      return /\bnext\b/.test(text) || text === "›" || text === ">";
    }) || null;
  }

  async function waitForNextPageControl(timeoutMs) {
    const started = Date.now();
    let next = findNextPageControl();
    while (!paginationState.stopped && !next && Date.now() - started < timeoutMs) {
      paginationState.lastMessage = "Waiting for Next button";
      await sleep(500);
      next = findNextPageControl();
    }
    return next;
  }

  function clickNextPage(next) {
    if (!next) return false;
    next.scrollIntoView({ block: "center", inline: "center" });
    next.click();
    return true;
  }

  async function waitForPageTransition(previousUrl, previousPage, previousLeadCount, timeoutMs) {
    const started = Date.now();
    let lastLeadCount = previousLeadCount;
    while (!paginationState.stopped && Date.now() - started < timeoutMs) {
      await sleep(500);
      const page = currentPageNumber();
      const leadCount = await storedLeadCount();
      if (leadCount !== lastLeadCount) {
        paginationState.lastLeadCount = leadCount;
        lastLeadCount = leadCount;
      }
      if (location.href !== previousUrl || page !== previousPage) {
        updatePaginationLocation();
        return true;
      }
      if (leadCount > previousLeadCount) {
        updatePaginationLocation();
        paginationState.lastMessage = "New leads captured after page advance";
        return true;
      }
    }
    updatePaginationLocation();
    return false;
  }

  async function checkCurrentPageCapture() {
    updatePaginationLocation();
    const previousLeadCount = await storedLeadCount();
    paginationState.lastLeadCount = previousLeadCount;
    paginationState.lastMessage = "Checking current page data";

    if (previousLeadCount > paginationState.leadsAtStart) {
      paginationState.pagesAttempted++;
      paginationState.pagesVisited++;
      paginationState.pagesWithLeadDeltas++;
      paginationState.observedLeadsPerPage = Math.max(
        1,
        Math.round((previousLeadCount - paginationState.leadsAtStart) / paginationState.pagesWithLeadDeltas)
      );
      updateEstimatedProfiles();
      paginationState.lastMessage = `Captured current page (${previousLeadCount - paginationState.leadsAtStart} new leads)`;
      persistPaginationState({ resumeAfterLoad: false });
      return true;
    }

    paginationState.nextActionAt = Date.now() + Math.min(5000, paginationState.delayMs);

    const delta = await waitForLeadDelta(previousLeadCount, Math.min(5000, paginationState.delayMs));
    paginationState.nextActionAt = 0;
    paginationState.pagesAttempted++;
    if (delta > 0) {
      await updateLeadDelta(previousLeadCount);
      paginationState.lastMessage = `Captured current page (${delta} new lead${delta === 1 ? "" : "s"})`;
      persistPaginationState({ resumeAfterLoad: false });
      log("info", "current page captured", {
        currentPage: paginationState.currentPage,
        delta: delta,
        pagesVisited: paginationState.pagesVisited
      });
      return true;
    }

    paginationState.lastMessage = "Current page checked, no new captured leads";
    persistPaginationState({ resumeAfterLoad: false });
    log("warn", "current page produced no new leads during collection start", {
      currentPage: paginationState.currentPage,
      leadCount: paginationState.lastLeadCount
    });
    return false;
  }

  async function startPagination(options) {
    if (paginationState.running) {
      return { ok: true, alreadyRunning: true, state: Object.assign({}, paginationState) };
    }

    paginationState.running = true;
    paginationState.stopped = false;
    paginationState.skipCurrent = Boolean(options.skipCurrent);
    paginationState.pagesVisited = Math.max(0, Number(options.pagesVisited) || 0);
    paginationState.pagesAttempted = Math.max(0, Number(options.pagesAttempted) || 0);
    paginationState.currentPageSaved = 0;
    paginationState.captureSequence = Math.max(0, Number(options.captureSequence) || paginationState.captureSequence || 0);
    paginationState.maxPages = Math.max(1, Math.min(1000, Number(options.maxPages) || 25));
    paginationState.delayMs = Math.max(5000, Math.min(120000, Number(options.delayMs) || 8000));
    paginationState.startedAt = Date.now();
    paginationState.lastTransitionOk = false;
    paginationState.lastLeadCount = await storedLeadCount();
    paginationState.leadsAtStart = Number.isFinite(Number(options.leadsAtStart))
      ? Math.max(0, Number(options.leadsAtStart))
      : paginationState.lastLeadCount;
    paginationState.pagesWithLeadDeltas = Math.max(0, Number(options.pagesWithLeadDeltas) || 0);
    paginationState.observedLeadsPerPage = Math.max(1, Number(options.observedLeadsPerPage) || 25);
    updateEstimatedProfiles();
    updatePaginationLocation();
    paginationState.lastMessage = paginationState.skipCurrent
      ? "Continuing from next page"
      : "Checking current page data";
    paginationState.nextActionAt = paginationState.skipCurrent
      ? Date.now() + paginationState.delayMs
      : Date.now() + Math.min(5000, paginationState.delayMs);

    log("info", "pagination started", {
      maxPages: paginationState.maxPages,
      delayMs: paginationState.delayMs,
      skipCurrent: paginationState.skipCurrent
    });

    persistPaginationState({ resumeAfterLoad: false });
    runPaginationLoop();
    return { ok: true, state: Object.assign({}, paginationState) };
  }

  function resumePendingCollection() {
    chrome.storage.local.get([PENDING_COLLECTION_KEY], (data) => {
      const readError = chrome.runtime.lastError && chrome.runtime.lastError.message;
      if (readError) {
        log("warn", "failed to read pending collection", { error: readError });
        return;
      }

      const pending = data[PENDING_COLLECTION_KEY];
      if (!pending || pending.skipCurrent) return;
      const ageMs = Date.now() - (pending.createdAt || 0);
      if (ageMs > 60000) {
        chrome.storage.local.remove(PENDING_COLLECTION_KEY);
        log("warn", "discarded stale pending collection", { ageMs: ageMs });
        return;
      }

      chrome.storage.local.remove(PENDING_COLLECTION_KEY, () => {
        log("info", "resuming pending collection after reload", {
          maxPages: pending.maxPages,
          delayMs: pending.delayMs
        });
        startPagination({
          maxPages: pending.maxPages,
          delayMs: pending.delayMs,
          skipCurrent: false,
          leadsAtStart: 0
        });
      });
    });
  }

  function resumeActiveCollection() {
    chrome.storage.local.get([COLLECTION_STATE_KEY], (data) => {
      const saved = data[COLLECTION_STATE_KEY];
      if (!saved || !saved.running || !saved.resumeAfterLoad) return;
      if (Date.now() - (saved.updatedAt || 0) > 10 * 60 * 1000) return;
      if (saved.pagesAttempted >= saved.maxPages) return;

      log("info", "resuming active collection after page load", {
        currentPage: currentPageNumber(),
        pagesAttempted: saved.pagesAttempted,
        maxPages: saved.maxPages
      });
        startPagination({
          maxPages: saved.maxPages,
          delayMs: saved.delayMs,
          skipCurrent: false,
          leadsAtStart: saved.leadsAtStart,
          pagesAttempted: saved.pagesAttempted,
          pagesVisited: saved.pagesVisited,
          pagesWithLeadDeltas: saved.pagesWithLeadDeltas,
          captureSequence: saved.captureSequence,
          observedLeadsPerPage: saved.observedLeadsPerPage
        });
    });
  }

  async function runPaginationLoop() {
    try {
      if (!paginationState.skipCurrent && !paginationState.stopped) {
        await checkCurrentPageCapture();
      }

      while (!paginationState.stopped && paginationState.pagesAttempted < paginationState.maxPages) {
        paginationState.lastMessage = "Waiting before next page";
        const shouldContinue = await cancellableDelay(paginationState.delayMs);
        paginationState.nextActionAt = 0;
        persistPaginationState({ resumeAfterLoad: false });
        if (!shouldContinue) {
          paginationState.lastMessage = "Scraping stopped. Staying on current page";
          persistPaginationState({ resumeAfterLoad: false });
          break;
        }
        if (paginationState.stopped) break;

        const previousUrl = location.href;
        const previousPage = currentPageNumber();
        const previousLeadCount = await storedLeadCount();
        paginationState.lastLeadCount = previousLeadCount;
        const next = await waitForNextPageControl(8000);
        if (paginationState.stopped) {
          paginationState.lastMessage = "Scraping stopped. Staying on current page";
          persistPaginationState({ resumeAfterLoad: false });
          break;
        }
        persistPaginationState({ resumeAfterLoad: true });
        const clicked = clickNextPage(next);
        if (!clicked) {
          paginationState.lastMessage = "No next page control found";
          paginationState.nextActionAt = 0;
          persistPaginationState({ resumeAfterLoad: false });
          log("info", "pagination completed", {
            reason: paginationState.lastMessage,
            pagesVisited: paginationState.pagesVisited,
            pagesAttempted: paginationState.pagesAttempted
          });
          break;
        }

        paginationState.lastMessage = "Waiting for page transition";
        paginationState.nextActionAt = 0;
        const transitioned = await waitForPageTransition(previousUrl, previousPage, previousLeadCount, 20000);
        persistPaginationState({ resumeAfterLoad: false });
        paginationState.lastTransitionOk = transitioned;
        if (!transitioned) {
          paginationState.lastMessage = "Next click did not change page";
          persistPaginationState({ resumeAfterLoad: false });
          log("warn", "pagination did not advance", {
            previousPage: previousPage,
            currentPage: paginationState.currentPage,
            pagesVisited: paginationState.pagesVisited,
            pagesAttempted: paginationState.pagesAttempted
          });
          break;
        }

        paginationState.currentPageSaved = 0;
        paginationState.pagesAttempted++;
        paginationState.lastMessage = "Waiting for page data";
        paginationState.nextActionAt = Date.now() + Math.min(10000, paginationState.delayMs);
        await waitForLeadDelta(previousLeadCount, Math.min(10000, paginationState.delayMs));
        paginationState.nextActionAt = 0;
        const delta = await updateLeadDelta(previousLeadCount);
        updateEstimatedProfiles();
        paginationState.lastMessage = delta > 0
          ? `Captured page ${paginationState.currentPage} (${delta} new lead${delta === 1 ? "" : "s"})`
          : "Moved to next page, no new leads captured";
        persistPaginationState({ resumeAfterLoad: false });
        log("info", "pagination advanced", {
          pagesVisited: paginationState.pagesVisited,
          pagesAttempted: paginationState.pagesAttempted,
          currentPage: paginationState.currentPage,
          delta: delta,
          observedLeadsPerPage: paginationState.observedLeadsPerPage,
          maxPages: paginationState.maxPages
        });
      }
      if (!paginationState.stopped && paginationState.pagesAttempted >= paginationState.maxPages) {
        paginationState.lastMessage = paginationState.skipCurrent
          ? "Scraping stopped on requested final next page"
          : "Scraping stopped on requested final page";
        persistPaginationState({ resumeAfterLoad: false });
      }
    } catch (e) {
      paginationState.lastMessage = "Pagination error";
      log("error", "pagination error", {
        error: e && e.message,
        stack: e && e.stack
      });
    } finally {
      paginationState.running = false;
      paginationState.nextActionAt = 0;
      updatePaginationLocation();
      persistPaginationState({ resumeAfterLoad: false });
      log("info", "pagination stopped", {
        stopped: paginationState.stopped,
        pagesVisited: paginationState.pagesVisited,
        pagesAttempted: paginationState.pagesAttempted,
        maxPages: paginationState.maxPages,
        lastMessage: paginationState.lastMessage
      });
    }
  }

  function stopPagination() {
    paginationState.stopped = true;
    paginationState.nextActionAt = 0;
    paginationState.lastMessage = "Scraping stopped. Staying on current page";
    persistPaginationState({ resumeAfterLoad: false });
    return { ok: true, state: Object.assign({}, paginationState) };
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
    if (msg.action === "startPagination") {
      startPagination({
        maxPages: msg.maxPages,
        delayMs: msg.delayMs
      }).then(sendResponse);
      return true;
    }
    if (msg.action === "stopPagination") {
      sendResponse(stopPagination());
      return true;
    }
    if (msg.action === "paginationStatus") {
      sendResponse({ ok: true, state: Object.assign({}, paginationState) });
      return true;
    }
  });

  log("info", "content script initialized", {
    url: trimUrl(location.href),
    readyState: document.readyState
  });
})();
