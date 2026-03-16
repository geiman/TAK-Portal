/**
 * Plugin Manager API: TAK.gov link, list/download/delete plugins.
 * All routes require global admin (mounted with requireGlobalAdmin).
 */

const router = require("express").Router();
const path = require("path");
const fs = require("fs");
const pluginsSvc = require("../services/plugins.service");
const auditSvc = require("../services/auditLog.service");
const multer = require("multer");

// Upload plugin APK to temp dir; we copy into data/plugins in the service then remove temp file
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, "..", "data", "uploads");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const base = (file.originalname || "plugin").replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `plugin_${Date.now()}_${base}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
});

function toErrorPayload(err) {
  const data = err?.response?.data;
  if (data) return typeof data === "string" ? data : data;
  return err?.message || "Unknown error";
}

/**
 * GET /api/plugins/state
 * Returns TAK.gov link state and list of installed plugins.
 */
router.get("/state", (req, res) => {
  try {
    const linkState = pluginsSvc.getTakGovLinkState(false);
    const plugins = pluginsSvc.listPlugins();
    res.json({
      takGovLink: linkState,
      plugins,
    });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * POST /api/plugins/link-code
 * Generate a new link code for TAK.gov register-device.
 */
router.post("/link-code", (req, res) => {
  try {
    const state = pluginsSvc.getTakGovLinkState(true);
    const auditUser = req.authentikUser;
    auditSvc.logEvent({
      actor: auditUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "PLUGIN_LINK_CODE_GENERATED",
      targetType: "plugin_manager",
      targetId: null,
      details: {},
    });
    res.json({ success: true, ...state });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * POST /api/plugins/link
 * Body: { code: "..." } - code entered at https://tak.gov/register-device
 */
router.post("/link", (req, res) => {
  try {
    const { code } = req.body || {};
    const result = pluginsSvc.linkTakGovAccount(code);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.message });
    }
    const auditUser = req.authentikUser;
    auditSvc.logEvent({
      actor: auditUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "PLUGIN_TAKGOV_LINKED",
      targetType: "plugin_manager",
      targetId: null,
      details: {},
    });
    res.json({ success: true, message: result.message });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * POST /api/plugins/unlink
 * Unlink TAK.gov account.
 */
router.post("/unlink", (req, res) => {
  try {
    pluginsSvc.unlinkTakGovAccount();
    const auditUser = req.authentikUser;
    auditSvc.logEvent({
      actor: auditUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "PLUGIN_TAKGOV_UNLINKED",
      targetType: "plugin_manager",
      targetId: null,
      details: {},
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * GET /api/plugins
 * List installed plugins only.
 */
router.get("/", (req, res) => {
  try {
    const plugins = pluginsSvc.listPlugins();
    res.json({ plugins });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * POST /api/plugins/download
 * Body: { url, name?, atakFlavor?, atakVersion? } - download plugin from URL and add to store.
 */
router.post("/download", async (req, res) => {
  try {
    const { url, name, atakFlavor, atakVersion } = req.body || {};
    const downloadUrl = typeof url === "string" ? url.trim() : "";
    if (!downloadUrl) {
      return res.status(400).json({ error: "URL is required." });
    }
    const result = await pluginsSvc.addPluginFromUrl(downloadUrl, {
      name: name || undefined,
      source: "tak.gov",
      atakFlavor: atakFlavor || undefined,
      atakVersion: atakVersion || undefined,
    });
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    const auditUser = req.authentikUser;
    auditSvc.logEvent({
      actor: auditUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "PLUGIN_DOWNLOADED",
      targetType: "plugin",
      targetId: result.plugin?.id || null,
      details: { name: result.plugin?.name, filename: result.plugin?.filename },
    });
    res.json({ success: true, plugin: result.plugin });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * POST /api/plugins/upload
 * Multipart: single file field "plugin". Adds to data/plugins and manifest.
 */
router.post("/upload", upload.single("plugin"), (req, res) => {
  try {
    if (!req.file || !req.file.path) {
      return res.status(400).json({ error: "No plugin file uploaded." });
    }
    const { name, atakFlavor, atakVersion } = req.body || {};
    const result = pluginsSvc.addPluginFromFile(req.file.path, {
      name: name || undefined,
      source: "upload",
      atakFlavor: atakFlavor || undefined,
      atakVersion: atakVersion || undefined,
    });
    try {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    } catch (_) {}
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    const auditUser = req.authentikUser;
    auditSvc.logEvent({
      actor: auditUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "PLUGIN_UPLOADED",
      targetType: "plugin",
      targetId: result.plugin?.id || null,
      details: { name: result.plugin?.name, filename: result.plugin?.filename },
    });
    res.json({ success: true, plugin: result.plugin });
  } catch (err) {
    try {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    } catch (_) {}
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * DELETE /api/plugins/:id
 * Remove plugin and its file.
 */
router.delete("/:id", (req, res) => {
  try {
    const { id } = req.params;
    const result = pluginsSvc.deletePlugin(id);
    if (!result.success) {
      return res.status(404).json({ error: result.error });
    }
    const auditUser = req.authentikUser;
    auditSvc.logEvent({
      actor: auditUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "PLUGIN_DELETED",
      targetType: "plugin",
      targetId: id,
      details: {},
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

/**
 * GET /api/plugins/:id/download
 * Stream plugin file for download (admin only).
 */
router.get("/:id/download", (req, res) => {
  try {
    const { id } = req.params;
    const filePath = pluginsSvc.getPluginFilePath(id);
    if (!filePath) {
      return res.status(404).json({ error: "Plugin not found." });
    }
    const filename = path.basename(filePath);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

module.exports = router;
