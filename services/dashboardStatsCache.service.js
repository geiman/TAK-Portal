const settingsSvc = require("./settings.service");
const usersService = require("./users.service");
const groupsService = require("./groups.service");
const agenciesStore = require("./agencies.service");

const DEFAULT_REFRESH_SECONDS = 300;
const MIN_REFRESH_SECONDS = 30;

const _state = {
  timer: null,
  isRefreshing: false,
  lastError: null,
  refreshedAt: null,
  snapshot: {
    stats: {
      totalUsers: 0,
      totalGroups: 0,
      totalAgencies: 0,
    },
    charts: {
      usersByAgency: {},
      unknownAgency: 0,
      usersByType: {},
      unknownType: 0,
    },
  },
};

function parseRefreshSeconds() {
  const settings = settingsSvc.getSettings() || {};

  const raw =
    settings.DASHBOARD_AUTHENTIK_STATS_REFRESH_SECONDS ??
    process.env.DASHBOARD_AUTHENTIK_STATS_REFRESH_SECONDS;

  let seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) seconds = DEFAULT_REFRESH_SECONDS;
  if (seconds < MIN_REFRESH_SECONDS) seconds = MIN_REFRESH_SECONDS;

  return Math.floor(seconds);
}

function buildCharts(users, agencies) {
  const agenciesNorm = (agencies || [])
    .map((a) => ({
      name: String(a.name || "").trim(),
      type: String(a.type || "").trim(), // Fire, EMS, Law, etc
      suffix: String(a.suffix || "").trim().toLowerCase(),
    }))
    .filter((a) => a.name && a.suffix);

  // Fast lookup: suffix -> agency record
  const bySuffix = new Map();
  for (const a of agenciesNorm) bySuffix.set(a.suffix, a);

  // Optional: build a list of known suffixes for username fallback matching.
  // Sort longest-first to avoid ".pd" matching before ".lpd", etc.
  const knownSuffixes = Array.from(bySuffix.keys()).sort(
    (a, b) => b.length - a.length
  );

  const usersByAgency = {};
  const usersByType = {};
  let unknownAgency = 0;
  let unknownType = 0;

  for (const u of users || []) {
    const username = String(u?.username || "").trim().toLowerCase();

    // 1) Prefer explicit Authentik attribute (this is what the portal writes)
    const attrs = (u && typeof u === "object" ? u.attributes : null) || {};
    let suffix = String(attrs.agency || "").trim().toLowerCase();

    // 2) Fallback: common username convention "name.suffix"
    if (!suffix) {
      const parts = username.split(".");
      suffix = parts.length > 1 ? parts[parts.length - 1] : "";
    }

    // 3) Fallback: endsWith any known suffix (covers cases without dots, etc.)
    if (!suffix && username) {
      for (const s of knownSuffixes) {
        if (username.endsWith(s)) {
          suffix = s;
          break;
        }
      }
    }

    const agency = suffix ? bySuffix.get(suffix) : null;

    if (!agency) {
      unknownAgency += 1;
      unknownType += 1;
      continue;
    }

    const agencyName = agency.name || suffix.toUpperCase();
    const agencyType = agency.type || "Unknown";

    usersByAgency[agencyName] = (usersByAgency[agencyName] || 0) + 1;
    usersByType[agencyType] = (usersByType[agencyType] || 0) + 1;
  }

  return { usersByAgency, unknownAgency, usersByType, unknownType };
}

async function refreshNow() {
  if (_state.isRefreshing) return _state.snapshot;

  _state.isRefreshing = true;
  _state.lastError = null;

  try {
    // Authentik data
    const [users, groups] = await Promise.all([
      usersService.getAllUsers(),
      groupsService.getAllGroups(), // <-- use portal logic
    ]);

    // Local data (agencies)
    const agencies = agenciesStore.load();

    const charts = buildCharts(users || [], agencies || []);

    _state.snapshot = {
      stats: {
        totalUsers: Array.isArray(users) ? users.length : 0,
        totalGroups: Array.isArray(groups) ? groups.length : 0,
        totalAgencies: Array.isArray(agencies) ? agencies.length : 0,
      },
      charts,
    };

    _state.refreshedAt = new Date();
    return _state.snapshot;
  } catch (err) {
    _state.lastError = err?.message || String(err);
    console.warn("[DASHBOARD] Authentik stats cache refresh failed:", err);
    return _state.snapshot; // keep last good snapshot
  } finally {
    _state.isRefreshing = false;
  }
}

function stopDashboardStatsRefresher() {
  if (_state.timer) {
    clearInterval(_state.timer);
    _state.timer = null;
  }
}

function startDashboardStatsRefresher() {
  // If already running, do nothing (use restartDashboardStatsRefresher to reconfigure)
  if (_state.timer) return;

  const seconds = parseRefreshSeconds();

  // Prime immediately (best-effort)
  refreshNow().catch(() => null);

  _state.timer = setInterval(() => {
    refreshNow().catch(() => null);
  }, seconds * 1000);

  console.log(
    `[DASHBOARD] Authentik stats cache enabled: refresh every ${seconds}s`
  );
}

function restartDashboardStatsRefresher() {
  stopDashboardStatsRefresher();
  startDashboardStatsRefresher();
}

function getDashboardStatsSnapshot() {
  const refreshedAt = _state.refreshedAt;
  const ageMs = refreshedAt ? Date.now() - refreshedAt.getTime() : null;

  return {
    ..._state.snapshot,
    refreshedAt,
    ageMs,
    error: _state.lastError,
  };
}

module.exports = {
  startDashboardStatsRefresher,
  stopDashboardStatsRefresher,
  restartDashboardStatsRefresher,
  refreshNow,
  getDashboardStatsSnapshot,
};
