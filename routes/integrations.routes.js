const router = require("express").Router();
const users = require("../services/users.service");
const groupsSvc = require("../services/groups.service");
const auditSvc = require("../services/auditLog.service");

function toErrorPayload(err) {
  const data = err?.response?.data;
  if (data) return typeof data === "string" ? data : data;
  return err?.message || "Unknown error";
}

/**
 * GET /api/integrations
 * List all users whose username starts with "nodered-".
 * Mounted with requireGlobalAdmin.
 */
router.get("/", async (req, res) => {
  try {
    const list = await users.findIntegrationUsers();
    const allGroups = await groupsSvc.getAllGroups({ includeHidden: true });
    const groupByPk = new Map(
      (allGroups || []).map((g) => [String(g.pk), g])
    );

    const usersWithGroupNames = list.map((u) => {
      const groupPks = Array.isArray(u.groups) ? u.groups : [];
      const groupNames = groupPks
        .map((pk) => groupByPk.get(String(pk))?.name)
        .filter(Boolean);
      return {
        pk: u.pk,
        username: u.username,
        name: u.name,
        email: u.email || "",
        is_active: !!u.is_active,
        groups: groupPks,
        groupNames,
      };
    });

    res.json({ users: usersWithGroupNames });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * POST /api/integrations
 * Create a new integration user: username "nodered-{slug from title}", single group.
 * Mounted with requireGlobalAdmin.
 */
router.post("/", async (req, res) => {
  try {
    const { type, title, groupId, state, county, agencySuffix } = req.body || {};
    const authUser = req.authentikUser || null;
    const createdBy = authUser
      ? {
          username: authUser.username,
          displayName: authUser.displayName || authUser.username,
        }
      : null;

    const result = await users.createIntegrationUser(
      {
        type: type || "global",
        title: String(title || "").trim(),
        groupId,
        state: state ? String(state).trim() : undefined,
        county: county ? String(county).trim() : undefined,
        agencySuffix: agencySuffix ? String(agencySuffix).trim() : undefined,
      },
      { createdBy }
    );

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "CREATE_INTEGRATION_USER",
      targetType: "user",
      targetId: String(result?.user?.pk || ""),
      details: {
        username: result?.user?.username,
        group: Array.isArray(result?.groups) && result.groups[0]
          ? result.groups[0].name
          : "",
      },
    });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

module.exports = router;
