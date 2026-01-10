const router = require("express").Router();

const usersService = require("../services/users.service");
const agenciesStore = require("../services/agencies.service");
const mutualAidService = require("../services/mutualAid.service");
const bookmarksService = require("../services/bookmarks.service");
const { getTakMetricsSnapshot } = require("../services/takMetrics.service");

function buildCharts(users, agencies) {
  const agenciesNorm = (agencies || [])
    .map((a) => ({
      name: String(a.name || "").trim(),
      type: String(a.type || "").trim(), // Fire, EMS, Law, etc
      suffix: String(a.suffix || "").trim().toLowerCase(),
    }))
    .filter((a) => a.name && a.suffix);

  const suffixToAgency = new Map();
  for (const a of agenciesNorm) {
    suffixToAgency.set(a.suffix, a);
  }

  const usersByAgency = {};
  for (const a of agenciesNorm) {
    usersByAgency[a.name] = 0;
  }

  let unknownAgency = 0;

  const usersByType = {};
  let unknownType = 0;

  const knownSuffixes = Array.from(suffixToAgency.keys());

  for (const u of users || []) {
    if (!u) continue;

    const attrs = u.attributes || {};
    let agencySuffix = String(attrs.agency || "").trim().toLowerCase();

    // Fallback to username suffix if needed
    if (!agencySuffix && u.username) {
      const uname = String(u.username).toLowerCase();
      for (const sfx of knownSuffixes) {
        if (uname.endsWith(sfx)) {
          agencySuffix = sfx;
          break;
        }
      }
    }

    const agency = agencySuffix ? suffixToAgency.get(agencySuffix) : null;
    if (!agency) {
      unknownAgency += 1;
      unknownType += 1;
      continue;
    }

    const agencyName = agency.name || agencySuffix.toUpperCase();
    const agencyType = agency.type || "Unknown";

    if (!Object.prototype.hasOwnProperty.call(usersByAgency, agencyName)) {
      usersByAgency[agencyName] = 0;
    }
    usersByAgency[agencyName] += 1;

    usersByType[agencyType] = (usersByType[agencyType] || 0) + 1;
  }

  return { usersByAgency, unknownAgency, usersByType, unknownType };
}

router.get("/", async (req, res) => {
  // Non-admins should not see the dashboard; send them to Setup My Device.
  const u = req.authentikUser;
  const isAdmin = !!(u && (u.isGlobalAdmin || u.isAgencyAdmin));
  if (!isAdmin) return res.redirect("/setup-my-device");

  try {
    const [users, groups] = await Promise.all([
      usersService.getAllUsers(),
      usersService.getAllGroups(),
    ]);

    const agencies = agenciesStore.load();
    const bookmarks = bookmarksService.loadBookmarks();
    const charts = buildCharts(users, agencies);

    // --- TAK server health metrics (best-effort; dashboard still loads if TAK is down) ---
    const takMetrics = await getTakMetricsSnapshot().catch(() => null);

    // --- Mutual Aid active banners ---
    let activeIncidentCount = 0;
    let activeEventCount = 0;
    try {
      const nowMs = Date.now();
      const items = mutualAidService.list();
      for (const it of items) {
        const t = String(it.type || "").trim().toUpperCase();
        const enabled = !!it.expireEnabled;
        const atMs = it.expireAt ? new Date(it.expireAt).getTime() : NaN;
        const expired = enabled && Number.isFinite(atMs) && atMs <= nowMs;
        if (expired) continue;
        if (t === "INCIDENT") activeIncidentCount += 1;
        if (t === "EVENT") activeEventCount += 1;
      }
    } catch (e) {
      console.error("[DASHBOARD] MutualAid stats failed:", e?.message || e);
    }

    const viewModel = {
      stats: {
        totalUsers: Array.isArray(users) ? users.length : 0,
        totalGroups: Array.isArray(groups) ? groups.length : 0,
        totalAgencies: Array.isArray(agencies) ? agencies.length : 0,
      },
      mutualAid: {
        activeIncidents: activeIncidentCount,
        activeEvents: activeEventCount,
      },
      charts,
      bookmarks,
      takMetrics,
    };

    res.render("dashboard", viewModel);
  } catch (err) {
    console.error("[DASHBOARD] Failed to load:", err?.message || err);

    const bookmarks = bookmarksService.loadBookmarks();

    const viewModel = {
      stats: { totalUsers: 0, totalGroups: 0, totalAgencies: 0 },
      mutualAid: { activeIncidents: 0, activeEvents: 0 },
      charts: {
        usersByAgency: {},
        unknownAgency: 0,
        usersByType: {},
        unknownType: 0,
      },
      bookmarks,
      takMetrics: null,
      error: err?.response?.data || err?.message || "Failed to load dashboard",
    };

    res.status(500).render("dashboard", viewModel);
  }
});

module.exports = router;
