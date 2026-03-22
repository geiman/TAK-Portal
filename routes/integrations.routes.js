const router = require("express").Router();
const users = require("../services/users.service");
const groupsSvc = require("../services/groups.service");
const auditSvc = require("../services/auditLog.service");
const { toSafeApiError } = require("../services/apiErrorPayload.service");

function toErrorPayload(err) {
  return toSafeApiError(err);
}

function stripTakPrefix(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  return n.toLowerCase().startsWith("tak_") ? n.slice(4) : n;
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
        .map((pk) => {
          const name = groupByPk.get(String(pk))?.name;
          return name ? stripTakPrefix(name) : null;
        })
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

/**
 * PUT /api/integrations/:userId/group
 * Set the integration user's group (replaces current). Only for nodered- users; bypasses action lock.
 */
router.put("/:userId/group", async (req, res) => {
  try {
    const userId = req.params.userId;
    const { groupId } = req.body || {};
    const user = await users.getUserById(userId);
    const username = String(user?.username || "").toLowerCase();
    if (!username.startsWith("nodered-")) {
      return res.status(403).json({ error: "Not an integration user." });
    }
    const groupIdStr = String(groupId || "").trim();
    if (!groupIdStr) return res.status(400).json({ error: "groupId required." });
    await users.setUserGroups(userId, [groupIdStr], { ignoreLocks: true });
    const authUser = req.authentikUser || null;
    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "SET_INTEGRATION_GROUP",
      targetType: "user",
      targetId: String(userId),
      details: { username: user?.username, groupId: groupIdStr },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

/**
 * DELETE /api/integrations/:userId
 * Delete the integration user. Only for nodered- users; bypasses action lock.
 */
router.delete("/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const user = await users.getUserById(userId);
    const username = String(user?.username || "").toLowerCase();
    if (!username.startsWith("nodered-")) {
      return res.status(403).json({ error: "Not an integration user." });
    }
    await users.deleteUser(userId, { ignoreLocks: true });
    const authUser = req.authentikUser || null;
    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "DELETE_INTEGRATION_USER",
      targetType: "user",
      targetId: String(userId),
      details: { username: user?.username },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

module.exports = router;
