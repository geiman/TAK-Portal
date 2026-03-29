/**
 * Persisted locators (missing-person share links) and ping history.
 * Storage: data/locators.json
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getString } = require("./env");
const settingsSvc = require("./settings.service");
const { buildTakAxios } = require("./tak.service");

const FILE = path.join(__dirname, "..", "data", "locators.json");

function defaultStore() {
  return { locators: [], history: [] };
}

function load() {
  if (!fs.existsSync(FILE)) return defaultStore();
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return defaultStore();
    if (!Array.isArray(data.locators)) data.locators = [];
    if (!Array.isArray(data.history)) data.history = [];
    return data;
  } catch {
    return defaultStore();
  }
}

function save(data) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), "utf8");
}

function titleToSlug(title) {
  const s = String(title || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return s || "locator";
}

/**
 * Base URL for locate pings (no trailing slash, no query string).
 * Derived from TAK_URL: hostname + scheme, ignoring the Marti path. Port 8443 is
 * dropped so the relay matches the built-in locate tab (HTTPS on default 443), e.g.
 *   https://tak.example.com:8443/Marti → https://tak.example.com/locate/api
 */
function getTakLocateApiBase() {
  const raw = String(settingsSvc.getSettings()?.TAK_URL || getString("TAK_URL", "") || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const proto = u.protocol === "http:" || u.protocol === "https:" ? u.protocol : "https:";
    const hostname = u.hostname;
    if (!hostname) return "";

    const p = String(u.port || "");
    const useDefaultPort =
      !p || p === "8443" || p === "443" || (proto === "https:" && !u.port);
    const hostPart = useDefaultPort ? hostname : `${hostname}:${p}`;

    return `${proto}//${hostPart}/locate/api`;
  } catch {
    return "";
  }
}

/**
 * Display name sent to TAK locate API: "Last, First M/D/YY HH:MM:SS" (local time).
 */
function formatLocatePingNameForTak(firstName, lastName) {
  const last = String(lastName || "").trim();
  const first = String(firstName || "").trim();
  const label = last && first ? `${last}, ${first}` : last || first || "Unknown";
  const d = new Date();
  // Hyphens avoid "/" in query values (some TAK builds mishandle slashes in the name param).
  const md = `${d.getMonth() + 1}-${d.getDate()}-${String(d.getFullYear()).slice(-2)}`;
  const hm = d.toTimeString().slice(0, 8);
  return `${label} ${md} ${hm}`;
}

function summarizeTakResponseBody(data) {
  if (data == null || data === "") return "";
  if (typeof data === "string") return data.trim().slice(0, 500);
  try {
    return JSON.stringify(data).slice(0, 500);
  } catch {
    return "";
  }
}

function getBySlug(slug) {
  const s = String(slug || "").trim().toLowerCase();
  return load().locators.find((l) => l.slug === s) || null;
}

function getById(id) {
  return load().locators.find((l) => l.id === id) || null;
}

/**
 * Public poll payload so share pages can pick up interval edits and admin "manual ping" wake-ups without reload.
 */
function getClientConfigForPublicSlug(slug) {
  const l = getBySlug(slug);
  if (!l || l.archived) return null;
  const ping = Math.max(10, Math.min(86400, Number(l.pingIntervalSeconds) || 60));
  return {
    ok: true,
    pingIntervalSeconds: ping,
    active: !!l.active,
    intervalEpoch: Number(l.intervalEpoch) || 1,
    remotePingEpoch: Number(l.remotePingEpoch) || 1,
  };
}

function bumpRemotePingEpoch(locatorId) {
  const data = load();
  const li = data.locators.findIndex((l) => l.id === locatorId);
  if (li < 0) throw new Error("Locator not found.");
  data.locators[li].remotePingEpoch = (Number(data.locators[li].remotePingEpoch) || 0) + 1;
  data.locators[li].updatedAt = new Date().toISOString();
  save(data);
}

function listLocatorsForAdmin() {
  const data = load();
  const locators = data.locators.slice().sort((a, b) => {
    const ua = String(a.updatedAt || a.createdAt || "");
    const ub = String(b.updatedAt || b.createdAt || "");
    return ub.localeCompare(ua);
  });
  return locators.map((l) => {
    const pings = data.history.filter((h) => h.locatorId === l.id);
    const sorted = pings.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const last = sorted[0];
    const lastWithCoords = sorted.find(
      (h) =>
        h.latitude != null &&
        h.longitude != null &&
        Number.isFinite(Number(h.latitude)) &&
        Number.isFinite(Number(h.longitude))
    );
    return {
      ...l,
      lastPingAt: last ? last.at : null,
      lastCoordsAt: lastWithCoords ? lastWithCoords.at : null,
      lastLatitude: lastWithCoords != null ? Number(lastWithCoords.latitude) : null,
      lastLongitude: lastWithCoords != null ? Number(lastWithCoords.longitude) : null,
      lastAccuracyMeters:
        lastWithCoords != null && lastWithCoords.accuracyMeters != null
          ? Number(lastWithCoords.accuracyMeters)
          : null,
      lastBatteryLevel:
        lastWithCoords != null && lastWithCoords.batteryLevel != null
          ? normalizeBatteryLevel(lastWithCoords.batteryLevel)
          : null,
      lastBatteryCharging:
        lastWithCoords != null ? normalizeBatteryCharging(lastWithCoords.batteryCharging) : null,
      hasPositionPing: !!lastWithCoords,
    };
  });
}

function create({ title, pingIntervalSeconds }) {
  let titleStr = String(title || "").trim();
  if (!titleStr) titleStr = "Missing Person";
  const ping = Math.max(10, Math.min(86400, Number(pingIntervalSeconds) || 60));

  let slug = titleToSlug(titleStr);
  const data = load();
  let n = 0;
  while (data.locators.some((l) => l.slug === slug)) {
    n += 1;
    slug = `${titleToSlug(titleStr)}-${n}`;
  }

  const now = new Date().toISOString();
  const loc = {
    id: crypto.randomUUID(),
    slug,
    title: titleStr,
    pingIntervalSeconds: ping,
    intervalEpoch: 1,
    remotePingEpoch: 1,
    active: true,
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
  data.locators.push(loc);
  save(data);
  return loc;
}

function update(id, patch) {
  const data = load();
  const idx = data.locators.findIndex((l) => l.id === id);
  if (idx < 0) throw new Error("Locator not found.");
  const l = { ...data.locators[idx] };

  if (patch.title !== undefined) {
    const t = String(patch.title || "").trim();
    if (t) l.title = t;
  }
  if (patch.pingIntervalSeconds !== undefined) {
    const next = Math.max(10, Math.min(86400, Number(patch.pingIntervalSeconds) || 60));
    if (next !== l.pingIntervalSeconds) {
      l.pingIntervalSeconds = next;
      l.intervalEpoch = (Number(l.intervalEpoch) || 0) + 1;
    }
  }
  if (patch.active !== undefined) l.active = !!patch.active;

  l.updatedAt = new Date().toISOString();
  data.locators[idx] = l;
  save(data);
  return l;
}

function archive(id) {
  const data = load();
  const idx = data.locators.findIndex((l) => l.id === id);
  if (idx < 0) throw new Error("Locator not found.");
  data.locators[idx].archived = true;
  data.locators[idx].active = false;
  data.locators[idx].updatedAt = new Date().toISOString();
  save(data);
  return data.locators[idx];
}

function reactivate(id) {
  const data = load();
  const idx = data.locators.findIndex((l) => l.id === id);
  if (idx < 0) throw new Error("Locator not found.");
  if (!data.locators[idx].archived) throw new Error("Locator is not archived.");
  data.locators[idx].archived = false;
  data.locators[idx].active = true;
  data.locators[idx].updatedAt = new Date().toISOString();
  save(data);
  return data.locators[idx];
}

/** Remove locator and all of its ping history (cannot be undone). */
function permanentDelete(id) {
  const data = load();
  const idx = data.locators.findIndex((l) => l.id === id);
  if (idx < 0) throw new Error("Locator not found.");
  const locId = data.locators[idx].id;
  data.locators.splice(idx, 1);
  data.history = data.history.filter((h) => h.locatorId !== locId);
  save(data);
}

function normalizeBatteryLevel(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function normalizeBatteryCharging(v) {
  if (v === true || v === "true" || v === "1" || v === "on") return true;
  if (v === false || v === "false" || v === "0" || v === "off") return false;
  return null;
}

/** Append battery line for TAK locate remarks (user remarks unchanged in stored history). */
function formatLocateRemarksForTak(remarks, batteryLevel, batteryCharging) {
  const r = String(remarks || "").trim();
  const lvl = normalizeBatteryLevel(batteryLevel);
  if (lvl == null) return r;
  const pct = Math.round(lvl * 100);
  let suffix = `Battery ${pct}%`;
  if (batteryCharging === true) suffix += " (charging)";
  return r ? `${r} · ${suffix}` : suffix;
}

function addHistoryEntry({
  locatorId,
  latitude,
  longitude,
  name,
  remarks,
  kind,
  accuracyMeters,
  batteryLevel,
  batteryCharging,
}) {
  const data = load();
  const acc =
    accuracyMeters != null && Number.isFinite(Number(accuracyMeters))
      ? Number(accuracyMeters)
      : null;
  const bl = normalizeBatteryLevel(batteryLevel);
  const bc = normalizeBatteryCharging(batteryCharging);
  const entry = {
    id: crypto.randomUUID(),
    locatorId,
    at: new Date().toISOString(),
    latitude: latitude == null ? null : Number(latitude),
    longitude: longitude == null ? null : Number(longitude),
    accuracyMeters: acc,
    name: String(name || "").trim(),
    remarks: String(remarks || "").trim(),
    kind: kind === "manual" ? "manual" : "interval",
    batteryLevel: bl,
    batteryCharging: bc,
  };
  data.history.push(entry);

  const li = data.locators.findIndex((l) => l.id === locatorId);
  if (li >= 0) {
    data.locators[li].updatedAt = entry.at;
  }

  const forLoc = data.history.filter((h) => h.locatorId === locatorId);
  if (forLoc.length > 5000) {
    const sorted = forLoc.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const drop = sorted.slice(0, forLoc.length - 5000).map((h) => h.id);
    data.history = data.history.filter((h) => !drop.includes(h.id));
  }
  save(data);
  return entry;
}

function listHistory(locatorId, { limit = 200 } = {}) {
  const data = load();
  const rows = data.history.filter((h) => h.locatorId === locatorId);
  const newestFirst = rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const recent = newestFirst.slice(0, limit);
  return recent.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** Wake devices only; no history row (admin dashboard "Manual ping"). */
function addManualOperatorPing(locatorId) {
  bumpRemotePingEpoch(locatorId);
}

/**
 * Relay a position ping to the TAK Server locate API (server-side; avoids browser CORS).
 */
async function relayPingToTak({ latitude, longitude, name, remarks }) {
  const base = getTakLocateApiBase();
  if (!base) {
    throw new Error("TAK_URL is not configured in Server Settings; cannot reach the TAK locate API.");
  }
  const u = new URL(base);
  u.searchParams.set("latitude", String(latitude));
  u.searchParams.set("longitude", String(longitude));
  u.searchParams.set("name", name);
  u.searchParams.set("remarks", remarks || "");

  let client;
  try {
    // Use the locate API origin as baseURL (not Marti /api base) and POST path + query only.
    client = buildTakAxios({
      allowInsecureServer: true,
      baseURL: u.origin,
      timeout: 25000,
    });
  } catch (setupErr) {
    throw new Error(setupErr?.message || String(setupErr));
  }

  const pathAndQuery = `${u.pathname}${u.search}`;

  try {
    const resp = await client.post(pathAndQuery, "", {
      headers: {
        Accept: "*/*",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "TAK-Portal-LocateRelay/1.0",
      },
      validateStatus: (s) => s >= 200 && s < 600,
    });
    if (resp.status < 200 || resp.status >= 300) {
      const bodyHint = summarizeTakResponseBody(resp.data);
      let msg = `TAK locate API returned HTTP ${resp.status}`;
      if (bodyHint) msg += `. Server response: ${bodyHint}`;
      if (resp.status === 403) {
        msg +=
          ". HTTP 403: ensure CoreConfig <locate requireLogin=\"false\" /> and TAK was restarted, " +
          "and that the relay URL (derived from TAK_URL: host without :8443, path /locate/api) matches your deployment. " +
          "Check takserver-api logs and client-cert rules for /locate/api.";
      } else if (resp.status === 404) {
        msg += ". HTTP 404 — confirm locate is enabled and reachable at https://<host>/locate/api on port 443.";
      } else if (resp.status >= 500) {
        msg +=
          ". HTTP 5xx usually indicates an error inside takserver-api processing this request; check TAK logs for /locate/api.";
      }
      throw new Error(msg);
    }
  } catch (err) {
    const msg = err?.message || String(err);
    const code = err?.code || "";
    const causeMsg = String(err?.cause?.message || "");
    const causeCode = err?.cause?.code || "";
    const scan = `${msg} ${causeMsg}`;
    const scanCode = code || causeCode;
    if (
      /ssl\/tls alert bad certificate|alert number 42|bad certificate/i.test(scan) ||
      scanCode === "ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE"
    ) {
      throw new Error(
        "The TAK server rejected the TLS client certificate (mTLS). " +
          "Use the same TAK_API_P12_PATH (or TAK_API_CERT_PATH + TAK_API_KEY_PATH) that works for Marti/API calls—a cert the TAK server trusts for HTTPS clients."
      );
    }
    throw err;
  }
}

module.exports = {
  FILE,
  titleToSlug,
  formatLocatePingNameForTak,
  formatLocateRemarksForTak,
  getTakLocateApiBase,
  getClientConfigForPublicSlug,
  getBySlug,
  getById,
  listLocatorsForAdmin,
  create,
  update,
  archive,
  reactivate,
  permanentDelete,
  addHistoryEntry,
  listHistory,
  addManualOperatorPing,
  relayPingToTak,
};
