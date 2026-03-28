const router = require("express").Router();
const locateConfig = require("../services/locateConfig.service");
const locatorsSvc = require("../services/locators.service");
const { toSafeApiError } = require("../services/apiErrorPayload.service");

router.get("/config", async (req, res) => {
  try {
    const ssh = locateConfig.isSshConfigured();
    if (!ssh.configured) {
      return res.json({
        ok: true,
        sshConfigured: false,
        enabled: false,
        group: "",
      });
    }
    const xml = await locateConfig.readRemoteCoreConfigXml();
    const parsed = locateConfig.parseLocateFromXml(xml);
    res.json({
      ok: true,
      sshConfigured: true,
      enabled: parsed.enabled,
      group: parsed.group || "",
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/apply", async (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    const group = String(req.body?.group || "").trim();
    if (enabled && !group) {
      return res.status(400).json({
        ok: false,
        error: "Select a TAK group when locate is enabled.",
      });
    }
    const out = await locateConfig.applyLocateConfiguration({
      enabled,
      groupDisplayName: group,
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
});

// ---- Missing-person locators (admin) ----

router.get("/locators", async (req, res) => {
  try {
    const locators = locatorsSvc.listLocatorsForAdmin();
    res.json({ ok: true, locators });
  } catch (err) {
    res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/locators", async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const pingIntervalSeconds = req.body?.pingIntervalSeconds;
    const loc = locatorsSvc.create({ title, pingIntervalSeconds });
    res.json({ ok: true, locator: loc });
  } catch (err) {
    res.status(400).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.patch("/locators/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const loc = locatorsSvc.update(id, {
      title: req.body?.title,
      pingIntervalSeconds: req.body?.pingIntervalSeconds,
      active: req.body?.active,
    });
    res.json({ ok: true, locator: loc });
  } catch (err) {
    res.status(400).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/locators/:id/archive", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const loc = locatorsSvc.archive(id);
    res.json({ ok: true, locator: loc });
  } catch (err) {
    res.status(400).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.post("/locators/:id/manual-ping", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const loc = locatorsSvc.getById(id);
    if (!loc || loc.archived) {
      return res.status(404).json({ ok: false, error: "Locator not found." });
    }
    locatorsSvc.addManualOperatorPing(id);
    res.json({ ok: true, message: "Devices with this link open will send a location update soon." });
  } catch (err) {
    res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.get("/locators/:id/history", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const loc = locatorsSvc.getById(id);
    if (!loc) {
      return res.status(404).json({ ok: false, error: "Locator not found." });
    }
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || "200"), 10) || 200));
    const history = locatorsSvc.listHistory(id, { limit });
    res.json({ ok: true, history });
  } catch (err) {
    res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
});

module.exports = router;
