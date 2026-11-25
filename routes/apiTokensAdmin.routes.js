// routes/apiTokensAdmin.routes.js
// Global-admin management of portal API tokens (Server Settings > API Tokens).
// Mounted at /api/settings/api-tokens.

const express = require("express");
const router = express.Router();
const apiTokens = require("../services/apiTokens.service");
const auditSvc = require("../services/auditLog.service");

function actorName(req) {
  const u = req.authentikUser;
  return u ? u.username || u.displayName || null : null;
}

function requestInfo(req) {
  return { method: req.method, path: req.originalUrl || req.path, ip: req.ip };
}

router.get("/", async (req, res) => {
  try {
    return res.json({ items: await apiTokens.listTokens() });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Failed to list tokens" });
  }
});

router.post("/", async (req, res) => {
  try {
    const { token, item } = await apiTokens.createToken(req.body || {}, {
      createdBy: actorName(req),
    });
    auditSvc.logEvent({
      actor: req.authentikUser,
      request: requestInfo(req),
      action: "API_TOKEN_CREATED",
      targetType: "api_token",
      targetId: item.id,
      details: {
        summary: `Created API token "${item.name}".`,
        name: item.name,
        allAgencies: item.allAgencies,
        agencySuffixes: item.agencySuffixes,
        canCreateAgencies: item.canCreateAgencies,
        canCreateMutualAid: item.canCreateMutualAid,
        expiresAt: item.expiresAt,
      },
    });
    return res.json({ token, item });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err?.message || "Failed to create token" });
  }
});

router.post("/revoke-all", async (req, res) => {
  try {
    const count = await apiTokens.revokeAllTokens({ revokedBy: actorName(req) });
    auditSvc.logEvent({
      actor: req.authentikUser,
      request: requestInfo(req),
      action: "API_TOKEN_REVOKED",
      targetType: "api_token",
      targetId: "all",
      details: { summary: `Revoked all API tokens (${count}).`, count },
    });
    return res.json({ ok: true, count });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Failed to revoke tokens" });
  }
});

router.post("/:id/revoke", async (req, res) => {
  try {
    const item = await apiTokens.revokeToken(req.params.id, { revokedBy: actorName(req) });
    if (!item) return res.status(404).json({ error: "Token not found or already revoked." });
    auditSvc.logEvent({
      actor: req.authentikUser,
      request: requestInfo(req),
      action: "API_TOKEN_REVOKED",
      targetType: "api_token",
      targetId: item.id,
      details: { summary: `Revoked API token "${item.name}".`, name: item.name },
    });
    return res.json({ ok: true, item });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Failed to revoke token" });
  }
});

module.exports = router;
