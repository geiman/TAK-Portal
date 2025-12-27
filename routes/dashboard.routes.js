const router = require("express").Router();

const usersService = require("../services/users.service");
const agenciesStore = require("../services/agencies.service");
const mutualAidService = require("../services/mutualAid.service");
const bookmarksService = require("../services/bookmarks.service"); // ⬅️ new

router.get("/", async (req, res) => {
  try {
    const [users, groups] = await Promise.all([
      usersService.getAllUsers(),
      usersService.getAllGroups()
    ]);

    const agencies = agenciesStore.load();

    // --- Users by agency (suffix match) ---
    const agenciesNorm = agencies
      .map(a => ({
        name: a.name,
        type: String(a.type || "Unknown").trim() || "Unknown",
        suffix: String(a.suffix || "").trim().toLowerCase()
      }))
      .filter(a => a.suffix);

    const usersByAgency = {};
    for (const a of agenciesNorm) usersByAgency[a.name] = 0;

    let unknownAgency = 0;

    // --- Users by agency TYPE ---
    const usersByType = {};
    let unknownType = 0;

    for (const u of users) {
      const uname = String(u.username || "").toLowerCase();
      const match = agenciesNorm.find(a => uname.endsWith(a.suffix));

      if (match) {
        usersByAgency[match.name] += 1;

        const t = match.type || "Unknown";
        usersByType[t] = (usersByType[t] || 0) + 1;
      } else {
        unknownAgency += 1;
        unknownType += 1;
      }
    }

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
      // Non-fatal; banners are optional.
    }

    const bookmarks = bookmarksService.loadBookmarks(); // ⬅️ new

    res.render("dashboard", {
      stats: {
        totalUsers: users.length,
        totalGroups: groups.length,
        totalAgencies: agencies.length
      },
      mutualAid: {
        activeIncidents: activeIncidentCount,
        activeEvents: activeEventCount
      },
      charts: {
        usersByAgency,
        unknownAgency,
        usersByType,
        unknownType
      },
      bookmarks // ⬅️ new
    });
  } catch (err) {
    const bookmarks = bookmarksService.loadBookmarks(); // ⬅️ optional but nice

    res.status(500).render("dashboard", {
      stats: { totalUsers: 0, totalGroups: 0, totalAgencies: 0 },
      mutualAid: { activeIncidents: 0, activeEvents: 0 },
      charts: {
        usersByAgency: {},
        unknownAgency: 0,
        usersByType: {},
        unknownType: 0
      },
      bookmarks, // ⬅️ new
      error: err?.response?.data || err?.message || "Failed to load dashboard"
    });
  }
});

module.exports = router;
