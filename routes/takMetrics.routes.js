const router = require("express").Router();
const { getTakMetricsSnapshot, getSubscriptionsAll } = require("../services/takMetrics.service");
const accessSvc = require("../services/access.service");

router.get("/metrics", async (req, res) => {
  const user = req.authentikUser;
  const isAdmin = !!(user && (user.isGlobalAdmin || user.isAgencyAdmin));
  if (!isAdmin) return res.status(403).json({ error: "Forbidden" });

  try {
    const metrics = await getTakMetricsSnapshot();
    return res.json(metrics);
  } catch (err) {
    return res.status(500).json({
      error: err?.response?.data || err?.message || "Failed to fetch TAK metrics",
    });
  }
});

router.get("/subscriptions", async (req, res) => {
  const user = req.authentikUser;
  const isAdmin = !!(user && (user.isGlobalAdmin || user.isAgencyAdmin));
  if (!isAdmin) return res.status(403).json({ error: "Forbidden" });

  try {
    const result = await getSubscriptionsAll();
    if (result.data && result.configured && user && user.isAgencyAdmin && !user.isGlobalAdmin) {
      result.data = result.data.filter((item) =>
        accessSvc.isUsernameInAllowedAgencies(user, item && item.username)
      );
    }
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      configured: true,
      data: [],
      error: err?.message || "Failed to fetch subscriptions",
    });
  }
});

module.exports = router;
