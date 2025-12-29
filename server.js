require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const settingsSvc = require("./services/settings.service");

const { getString } = require("./services/env");
const pkg = require("./package.json");
const mutualAidSvc = require("./services/mutualAid.service");
const portalAuth = require("./services/portalAuth.middleware");

const app = express();

// Expose version to all EJS views (e.g. sidebar)
app.locals.APP_VERSION = pkg.version || "dev";

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
// Expose settings + theme/logo to all views
app.use((req, res, next) => {
  try {
    const settings = settingsSvc.getSettings();
    res.locals.settings = settings || {};
    res.locals.brandTheme = settings.BRAND_THEME || "dark-blue";
    res.locals.brandLogoUrl = settings.BRAND_LOGO_URL || "";
  } catch (err) {
    console.warn(
      "Failed to load settings for request:",
      err?.message || err
    );
    res.locals.settings = {};
    res.locals.brandTheme = "dark-blue";
    res.locals.brandLogoUrl = "";
  }
  next();
});

// >>> NEW: enforce optional Authentik/group access control <<<
app.use(portalAuth);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// API Routes
app.use("/api/agencies", require("./routes/agencies.routes"));
app.use("/api/users", require("./routes/users.routes"));
app.use("/api/groups", require("./routes/groups.routes"));
app.use("/api/templates", require("./routes/templates.routes"));
app.use("/api/qr", require("./routes/qr.routes"));
app.use("/api/mutual-aid", require("./routes/mutualAid.routes"));
app.use("/", require("./routes/dashboard.routes"));

// UI Routes
app.get("/", (req, res) => res.redirect("/users/create"));
app.get("/users/create", (req, res) => res.render("users-create"));
app.get("/users/manage", (req, res) => res.render("users-manage"));
app.get("/groups", (req, res) => res.render("groups"));
app.get("/agencies", (req, res) => res.render("agencies"));
app.get("/templates", (req, res) => res.render("templates"));
app.get("/mutual-aid", (req, res) => res.render("mutual-aid"));
app.get("/qr-generator", (req, res) => res.render("qr-generator"));

app.get("/settings", (req, res) => {
  const settings = settingsSvc.getSettings();
  const keys = Object.keys(settings).sort();
  res.render("settings", { settings, keys });
});

app.post(
  "/settings",
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
    Object.keys(bodySettings).forEach((key) => {
      merged[key] = bodySettings[key];
    });

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

// Export a zip of the data folder
app.get("/settings/export-data", (req, res) => {
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
