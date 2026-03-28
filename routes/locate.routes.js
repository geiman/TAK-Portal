const router = require("express").Router();
const locateConfig = require("../services/locateConfig.service");
const locatorsSvc = require("../services/locators.service");
const emailSvc = require("../services/email.service");
const auditSvc = require("../services/auditLog.service");
const { renderTemplate, htmlToText } = require("../services/emailTemplates.service");
const { toSafeApiError } = require("../services/apiErrorPayload.service");

const EMAIL_RE = /^\S+@\S+\.[A-Za-z]{2,}$/;

function parseRecipientEmails(raw) {
  const s = String(raw || "").trim();
  if (!s) return { error: "Enter at least one email address." };
  const parts = s
    .split(/[;,]/g)
    .map((x) => String(x).trim())
    .filter(Boolean);
  if (!parts.length) return { error: "Enter at least one email address." };
  const seen = new Set();
  const emails = [];
  for (const e of parts) {
    if (!EMAIL_RE.test(e)) {
      return { error: `Invalid email address: ${e}` };
    }
    const lower = e.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    emails.push(e);
  }
  if (!emails.length) return { error: "Enter at least one email address." };
  return { emails };
}

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

router.post("/locators/:id/reactivate", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const loc = locatorsSvc.reactivate(id);
    res.json({ ok: true, locator: loc });
  } catch (err) {
    res.status(400).json({ ok: false, error: toSafeApiError(err) });
  }
});

router.delete("/locators/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    locatorsSvc.permanentDelete(id);
    res.json({ ok: true });
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

router.post("/locators/:id/send-link-email", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const loc = locatorsSvc.getById(id);
    if (!loc || loc.archived) {
      return res.status(404).json({ ok: false, error: "Locator not found." });
    }

    const parsed = parseRecipientEmails(req.body?.recipients ?? req.body?.to ?? "");
    if (parsed.error) {
      return res.status(400).json({ ok: false, error: parsed.error });
    }
    const emails = parsed.emails;

    const emailCfg = emailSvc.getSmtpConfig();
    if (!emailSvc.isEmailEnabled() || !emailCfg.host || !emailCfg.from) {
      return res.status(400).json({
        ok: false,
        error: "Email is disabled or SMTP is not configured.",
      });
    }

    const proto = String(req.get("x-forwarded-proto") || req.protocol || "https")
      .split(",")[0]
      .trim() || "https";
    const host = req.get("host") || "";
    const url = `${proto}://${host}/locate/${encodeURIComponent(loc.slug)}`;

    const subject = "Share your location";
    const message = `Please open this link on your phone to share your location with responders:\n\n${url}\n`;

    const escapeHtml = (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    const messageBody = escapeHtml(message).replace(/\n/g, "<br>");
    const html = renderTemplate("bulk_email.html", { subject, messageBody });
    const text = htmlToText(html);

    const result = await emailSvc.sendMail({
      to: emails.join(","),
      subject,
      text,
      html,
    });

    if (!result.sent) {
      if (result.skipped) {
        return res.status(400).json({
          ok: false,
          error: "Email is disabled (EMAIL_ENABLED=false)",
        });
      }
      return res.status(500).json({
        ok: false,
        error: result.error || "Email send failed",
      });
    }

    auditSvc.logEvent({
      actor: req.authentikUser || null,
      request: {
        method: req.method,
        path: req.originalUrl || req.path,
        ip: req.ip,
      },
      action: "LOCATE_LINK_EMAIL_SENT",
      targetType: "locator",
      targetId: id,
      details: { recipientCount: emails.length, slug: loc.slug },
    });

    res.json({ ok: true, count: emails.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: toSafeApiError(err) });
  }
});

module.exports = router;
