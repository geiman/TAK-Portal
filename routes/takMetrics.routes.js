const router = require("express").Router();
const { getTakMetricsSnapshot } = require("../services/takMetrics.service");

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

module.exports = router;
