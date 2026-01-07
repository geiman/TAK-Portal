require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const settingsSvc = require("./services/settings.service");
const axios = require("axios");
const { getString } = require("./services/env");
const { URL } = require("url");
const pkg = require("./package.json");
const mutualAidSvc = require("./services/mutualAid.service");
const portalAuth = require("./services/portalAuth.middleware");
const emailSvc = require("./services/email.service");
const emailTemplatesSvc = require("./services/emailTemplates.service");

const app = express();

// Expose version to all EJS views (e.g. sidebar)
app.locals.APP_VERSION = pkg.version || "dev";
app.locals.APP_LATEST_VERSION = pkg.version || "dev";
app.locals.APP_UPDATE_AVAILABLE = false;

// Simple semver compare: returns true if `latest` > `current`
function isNewerVersion(latest, current) {
  const toParts = (v) =>
    String(v || "0.0.0")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);

  const [la, lb, lc] = toParts(latest);
  const [ca, cb, cc] = toParts(current);

  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

async function checkForUpdates() {
  try {
    // You can move this to an env var if you like
    const repo = process.env.GITHUB_REPO || "AdventureSeeker423/TAK-Portal";

    // Grab package.json from main and read its version
    const url = `https://raw.githubusercontent.com/${repo}/main/package.json`;
    const response = await axios.get(url, { timeout: 5000 });

    const data =
      typeof response.data === "string"
        ? JSON.parse(response.data)
        : response.data;

    const latestVersion = data.version || app.locals.APP_VERSION;

    app.locals.APP_LATEST_VERSION = latestVersion;
    app.locals.APP_UPDATE_AVAILABLE = isNewerVersion(
      latestVersion,
      app.locals.APP_VERSION
    );

    console.log(
      `[update-check] current=${app.locals.APP_VERSION} latest=${latestVersion} update=${app.locals.APP_UPDATE_AVAILABLE}`
    );
  } catch (err) {
    console.warn("Failed to check for updates:", err.message || err);
  }
}

// Run once on startup, then periodically (e.g. every 1 hour)
checkForUpdates();
setInterval(checkForUpdates, 60 * 60 * 1000);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/branding", express.static(path.join(__dirname, "data", "branding")));

// Multer storage for settings uploads (certs + branding)
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      let targetDir;

      if (
        file.fieldname === "TAK_API_P12_UPLOAD" ||
        file.fieldname === "TAK_CA_UPLOAD"
      ) {
        targetDir = path.join(__dirname, "data", "certs");
      } else if (file.fieldname === "BRAND_LOGO_UPLOAD") {
        targetDir = path.join(__dirname, "data", "branding");
      } else {
        targetDir = path.join(__dirname, "data", "uploads");
      }

      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      cb(null, targetDir);
    } catch (err) {
      console.error("Failed to determine upload destination:", err);
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const safeOriginal = file.originalname
      ? file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_")
      : "upload";

    if (file.fieldname === "TAK_API_P12_UPLOAD") {
      return cb(null, "tak-client.p12");
    }

    if (file.fieldname === "TAK_CA_UPLOAD") {
      return cb(null, "tak-ca.pem");
    }

    if (file.fieldname === "BRAND_LOGO_UPLOAD") {
      const ext = path.extname(safeOriginal) || ".png";
      return cb(null, "logo" + ext);
    }

    cb(null, safeOriginal);
  },
});

const upload = multer({ storage: uploadStorage });

// Expose settings + theme/logo to all views
app.use((req, res, next) => {
  try {
    const settings = settingsSvc.getSettings();
    res.locals.settings = settings || {};
    res.locals.brandTheme = settings.BRAND_THEME || "dark-blue";
    res.locals.brandLogoUrl = settings.BRAND_LOGO_URL || "";
  } catch (err) {
    console.warn("Failed to load settings for request:", err?.message || err);
    res.locals.settings = {};
    res.locals.brandTheme = "dark-blue";
    res.locals.brandLogoUrl = "";
  }
  next();
});

// >>> Enforce optional Authentik/group access control <<<
app.use(portalAuth);

// Helper: only allow Global Admins to access certain routes (e.g. settings, templates)
function requireGlobalAdmin(req, res, next) {
  const user = req.authentikUser;
  if (!user || !user.isGlobalAdmin) {
    const username = user && user.username ? user.username : "";
    return res.status(403).render("access-denied", { username });
  }
  next();
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.get("/logout", (req, res) => {
  // Where to send the user back after logout (the portal itself)
  const portalUrl = `${req.protocol}://${req.get("host")}/`;

  // Prefer AUTHENTIK_PUBLIC_URL; fall back to AUTHENTIK_URL
  const base =
    getString("AUTHENTIK_PUBLIC_URL", "") || getString("AUTHENTIK_URL", "");

  if (!base) {
    console.error(
      "Logout requested but no AUTHENTIK_PUBLIC_URL or AUTHENTIK_URL is configured"
    );
    return res
      .status(500)
      .send(
        "Logout is not configured. Ask the administrator to set Authentik URL."
      );
  }

  let logoutUrl;
  try {
    const u = new URL(base);
    // Use Authentik's default invalidation (logout) flow
    // This is relative to whatever host you configured.
    u.pathname = "/flows/-/default/invalidation/";
    u.searchParams.set("next", portalUrl);
    logoutUrl = u.toString();
  } catch (err) {
    console.error("Invalid Authentik URL in settings:", base, err);
    return res
      .status(500)
      .send("Logout is misconfigured. Check Authentik URL in settings.");
  }

  res.redirect(logoutUrl);
});

// API Routes
app.use("/api/agencies", require("./routes/agencies.routes"));
app.use("/api/users", require("./routes/users.routes"));
app.use("/api/groups", require("./routes/groups.routes"));
app.use("/api/templates", require("./routes/templates.routes"));
app.use("/api/qr", require("./routes/qr.routes"));
app.use("/api/mutual-aid", require("./routes/mutualAid.routes"));
app.use("/dashboard", require("./routes/dashboard.routes"));

// UI Routes

app.get("/", (req, res) => {
  res.redirect("dashboard");
});

app.get("/users/create", (req, res) => res.render("users-create"));
app.get("/users/manage", (req, res) => res.render("users-manage"));
app.get("/groups", (req, res) => res.render("groups"));
app.get("/agencies", requireGlobalAdmin, (req, res) =>
  res.render("agencies")
); //require Global Admin
app.get("/templates", (req, res) => res.render("templates"));
app.get("/mutual-aid", requireGlobalAdmin, (req, res) =>
  res.render("mutual-aid")
); //require Global Admin
app.get("/qr-generator", (req, res) => res.render("qr-generator"));

app.get("/settings", requireGlobalAdmin, (req, res) => {
  const settings = settingsSvc.getSettings();
  const keys = Object.keys(settings).sort();

  // Discover available email HTML templates (for admin editing).
  let emailTemplates = [];
  try {
    const templatesDir = emailTemplatesSvc.getTemplatesDir();
    const fileNames = fs.readdirSync(templatesDir).filter((name) =>
      typeof name === "string" && name.toLowerCase().endsWith(".html")
    );

    const overrides =
      settings &&
      settings.EMAIL_TEMPLATES_OVERRIDES &&
      typeof settings.EMAIL_TEMPLATES_OVERRIDES === "object"
        ? settings.EMAIL_TEMPLATES_OVERRIDES
        : {};

    emailTemplates = fileNames.map((filename) => {
      let defaultHtml = "";
      try {
        defaultHtml = fs.readFileSync(path.join(templatesDir, filename), "utf8");
      } catch (err) {
        console.error(
          "[settings] Failed to read email template file:",
          filename,
          err
        );
      }

      const overrideHtmlRaw = overrides && overrides[filename];
      const overrideHtml =
        typeof overrideHtmlRaw === "string" ? overrideHtmlRaw : "";
      const html = overrideHtml || defaultHtml;

      return {
        filename,
        idSafe: filename.replace(/[^a-zA-Z0-9_-]+/g, "_"),
        html,
        overridden: !!overrideHtml,
      };
    });
  } catch (err) {
    console.error("[settings] Failed to load email templates:", err);
    emailTemplates = [];
  }

  res.render("settings", { settings, keys, emailTemplates });
});


app.post(
  "/settings",
  requireGlobalAdmin,
  upload.fields([
    { name: "TAK_API_P12_UPLOAD", maxCount: 1 },
    { name: "TAK_CA_UPLOAD", maxCount: 1 },
    { name: "BRAND_LOGO_UPLOAD", maxCount: 1 },
  ]),
  (req, res) => {
    const rawBody = req.body || {};

    // Grab the current full settings object
    const currentSettings = settingsSvc.getSettings() || {};
    // Start from existing settings so we don't lose anything (like BRAND_LOGO_URL)
    const merged = { ...currentSettings };

    // --- collect settings[*] fields from the form ---

    const bodySettings = {};

    // Nested "settings" object (non-multipart or other cases)
    if (rawBody.settings && typeof rawBody.settings === "object") {
      Object.keys(rawBody.settings).forEach((key) => {
        bodySettings[key] = rawBody.settings[key];
      });
    }

    // Flat fields like "settings[BRAND_THEME]" created by multer
    Object.keys(rawBody).forEach((key) => {
      const match = key.match(/^settings\[(.+)\]$/);
      if (match) {
        bodySettings[match[1]] = rawBody[key];
      }
    });

    // Apply simple settings onto merged
    // Note: email template overrides are handled separately so we can support
    // per-template "reset to default" behavior.
    Object.keys(bodySettings).forEach((key) => {
      if (
        key === "EMAIL_TEMPLATES_OVERRIDES" ||
        key === "EMAIL_TEMPLATES_OVERRIDES_RESET"
      ) {
        return;
      }
      merged[key] = bodySettings[key];
    });

    // Figure out if the user clicked a per-template "Save This Template" button.
    // When present, this is the filename of the template that was explicitly saved.
    const onlyTemplate =
      req.body && typeof req.body._saveTemplate === "string"
        ? req.body._saveTemplate
        : null;

    // --- email template overrides (HTML bodies) ---
    const currentOverrides =
      currentSettings &&
      currentSettings.EMAIL_TEMPLATES_OVERRIDES &&
      typeof currentSettings.EMAIL_TEMPLATES_OVERRIDES === "object"
        ? { ...currentSettings.EMAIL_TEMPLATES_OVERRIDES }
        : {};

    const overridesFromForm = bodySettings.EMAIL_TEMPLATES_OVERRIDES;
    if (overridesFromForm && typeof overridesFromForm === "object") {
      Object.keys(overridesFromForm).forEach((filename) => {
        // If a per-template Save was used, ignore other templates.
        if (onlyTemplate && filename !== onlyTemplate) {
          return;
        }

        const value = overridesFromForm[filename];
        if (typeof value === "string") {
          // If the admin typed anything (or even left the default in place),
          // treat it as the current override. It may be cleared below if reset is set.
          currentOverrides[filename] = value;
        }
      });
    }

    const resetMap = bodySettings.EMAIL_TEMPLATES_OVERRIDES_RESET;
    if (resetMap && typeof resetMap === "object") {
      Object.keys(resetMap).forEach((filename) => {
        // If a per-template Save was used, ignore reset flags for other templates.
        if (onlyTemplate && filename !== onlyTemplate) {
          return;
        }

        const rawFlag = resetMap[filename];
        const flag =
          typeof rawFlag === "string"
            ? rawFlag.trim().toLowerCase()
            : String(rawFlag || "").trim().toLowerCase();

        if (
          flag === "1" ||
          flag === "true" ||
          flag === "yes" ||
          flag === "on"
        ) {
          // "Reset to default" means: drop the override, so we fall back to the file.
          delete currentOverrides[filename];
        }
      });
    }

    if (Object.keys(currentOverrides).length > 0) {
      merged.EMAIL_TEMPLATES_OVERRIDES = currentOverrides;
    } else {
      delete merged.EMAIL_TEMPLATES_OVERRIDES;
    }


    // --- handle uploaded files (certs + logo) ---

    const files = req.files || {};

    const p12Files = files.TAK_API_P12_UPLOAD || [];
    if (p12Files.length > 0) {
      const f = p12Files[0];
      const relPath = path.relative(process.cwd(), f.path);
      merged.TAK_API_P12_PATH = relPath.replace(/\\/g, "/");
    }

    const caFiles = files.TAK_CA_UPLOAD || [];
    if (caFiles.length > 0) {
      const f = caFiles[0];
      const relPath = path.relative(process.cwd(), f.path);
      merged.TAK_CA_PATH = relPath.replace(/\\/g, "/");
    }

    const logoFiles = files.BRAND_LOGO_UPLOAD || [];
    if (logoFiles.length > 0) {
      const f = logoFiles[0];
      const webPath = "/branding/" + path.basename(f.path);
      merged.BRAND_LOGO_URL = webPath.replace(/\\/g, "/");
    }
    // IMPORTANT: if no logo file uploaded, we do NOT touch merged.BRAND_LOGO_URL
    // so it stays whatever it was before.

    // Save the FULL merged settings object
    settingsSvc.saveSettings(merged);

    res.redirect("/settings");
  }
);

// Send a simple SMTP test email using Always CC / BCC lists

app.post("/settings/test-email", requireGlobalAdmin, async (req, res) => {
  console.log("[settings] Test email requested");

  try {
    const result = await emailSvc.sendMail({
      // no explicit "to": we only use CC / BCC lists
      subject: "TAK Portal - Email SMTP Test",
      text: "TAK Portal - Email SMTP Test",
    });

    console.log("[settings] Test email result:", result);
    return res.redirect("/settings");
  } catch (err) {
    console.error("[settings] Test email failed:", err?.message || err);
    return res
      .status(500)
      .send("Failed to send test email. Check SMTP settings and server logs.");
  }
});

// Export a zip of the data folder
app.get("/settings/export-data", requireGlobalAdmin, (req, res) => {
  const archiver = require("archiver");
  const dataDir = path.join(__dirname, "data");

  if (!fs.existsSync(dataDir)) {
    return res.status(404).send("No data directory to export");
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="tak-portal-data.zip"'
  );

  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.on("error", (err) => {
    console.error("Export data zip error:", err);
    res.status(500).end("Failed to export data");
  });

  archive.pipe(res);
  archive.directory(dataDir, "data");
  archive.finalize();
});

const port = process.env.WEB_UI_PORT || 3000;

app.listen(port, () => {
  console.log(`✅ TAK Portal running on http://localhost:${port}`);

  // Rehydrate expiration timers from stored mutual aid records.
  try {
    mutualAidSvc.initExpirationScheduler();
  } catch (e) {
    console.log(
      "⚠️ Mutual aid expiration scheduler init failed",
      e?.message || e
    );
  }

  try {
    const takUrl = getString("TAK_URL", "");
    if (!takUrl) {
      console.log("⚠️ TAK_URL not set in settings.json");
      return;
    }

    const host = new URL(takUrl).hostname;
    console.log("TAK host:", host);
  } catch (e) {
    console.log("⚠️ Invalid TAK_URL in settings.json");
  }
});
