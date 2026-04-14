const router = require("express").Router();
const fs = require("fs");
const users = require("../services/users.service");
const groupsSvc = require("../services/groups.service");
const auditSvc = require("../services/auditLog.service");
const takSshSvc = require("../services/takSsh.service");
const { toSafeApiError } = require("../services/apiErrorPayload.service");
const archiver = require("archiver");

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
        certBundleReady: takSshSvc.hasStoredIntegrationCertFiles(u.username),
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

    let certBundleReady = false;
    let certError = "";
    try {
      await takSshSvc.provisionIntegrationCertFiles(result?.user?.username || "");
      certBundleReady = true;
    } catch (certErr) {
      certError = certErr?.message || String(certErr);
    }

    const groupName =
      Array.isArray(result?.groups) && result.groups[0]
        ? result.groups[0].name
        : "";
    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "CREATE_INTEGRATION_USER",
      targetType: "user",
      targetId: String(result?.user?.pk || ""),
      details: {
        username: result?.user?.username,
        group: groupName,
        certBundleReady,
        certError: certError || undefined,
        summary: `Created integration user ${result?.user?.username || ""}${
          groupName ? ` in group ${groupName}` : ""
        }. Client certificate bundle ${
          certBundleReady ? "was prepared successfully" : "could not be fully prepared"
        }${certError ? `: ${certError}` : ""}.`,
      },
    });

    res.json({ success: true, certBundleReady, certError, ...result });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.get("/:userId/certs/download", async (req, res) => {
  try {
    const userId = req.params.userId;
    const user = await users.getUserById(userId);
    const username = String(user?.username || "").toLowerCase();
    if (!username.startsWith("nodered-")) {
      return res.status(403).json({ error: "Not an integration user." });
    }

    const certPaths = await takSshSvc.getOrProvisionIntegrationCertFiles(username);
    if (!certPaths || !certPaths.pemPath || !certPaths.keyPath) {
      return res.status(404).json({ error: "Integration cert files not available." });
    }
    if (!fs.existsSync(certPaths.pemPath) || !fs.existsSync(certPaths.keyPath)) {
      return res.status(404).json({ error: "Integration cert files not found on disk." });
    }

    const safeName = String(username).replace(/[^a-z0-9-]/g, "");
    const includesP12 =
      !!(certPaths.p12Path && fs.existsSync(certPaths.p12Path));
    const fileList = includesP12
      ? `${safeName}.pem, ${safeName}.key, ${safeName}.p12`
      : `${safeName}.pem, ${safeName}.key`;
    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: {
        method: req.method,
        path: req.originalUrl || req.path,
        ip: req.ip,
      },
      action: "DOWNLOAD_INTEGRATION_CERT_BUNDLE",
      targetType: "user",
      targetId: String(userId),
      details: {
        username,
        displayName: String(user?.name || "").trim() || undefined,
        zipFileName: `${safeName}-certs.zip`,
        filesIncluded: includesP12 ? ["pem", "key", "p12"] : ["pem", "key"],
        summary: `Downloaded integration certificate bundle for ${username} (${fileList} in zip).`,
      },
    });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}-certs.zip"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      try {
        if (!res.headersSent) {
          res.status(500).json({ error: err?.message || String(err) });
          return;
        }
        res.end();
      } catch (_) {}
    });
    archive.pipe(res);
    archive.file(certPaths.pemPath, { name: `${safeName}.pem` });
    archive.file(certPaths.keyPath, { name: `${safeName}.key` });
    if (certPaths.p12Path && fs.existsSync(certPaths.p12Path)) {
      archive.file(certPaths.p12Path, { name: `${safeName}.p12` });
    }
    archive.finalize();
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
      details: {
        username: user?.username,
        groupId: groupIdStr,
        summary: `Changed integration user ${user?.username || userId} to Authentik group id ${groupIdStr}.`,
      },
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
    await takSshSvc.revokeIntegrationCertViaSshScript(username);
    await users.deleteUser(userId, { ignoreLocks: true });
    const authUser = req.authentikUser || null;
    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "DELETE_INTEGRATION_USER",
      targetType: "user",
      targetId: String(userId),
      details: {
        username: user?.username,
        sshRevokeScript: "ok",
        summary: `Deleted integration user ${user?.username || userId} and revoked its TAK client certificate on the server.`,
      },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

module.exports = router;
