const express = require("express");
const router = express.Router();
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const Jimp = require("jimp");
const settingsSvc = require("../services/settings.service");



// Overlay branding logo (if configured) onto the center of a QR PNG buffer.
async function addLogoToPng(pngBuffer) {
  try {
    const settings = settingsSvc.getSettings();
    const logoUrl = settings.BRAND_LOGO_URL;

    if (!logoUrl) {
      return pngBuffer;
    }

    const logoFsPath = path.join(
      __dirname,
      "..",
      "public",
      logoUrl.replace(/^\//, "")
    );

    if (!fs.existsSync(logoFsPath)) {
      return pngBuffer;
    }

    const [qrImage, logoImage] = await Promise.all([
      Jimp.read(pngBuffer),
      Jimp.read(logoFsPath),
    ]);

    const qrWidth = qrImage.getWidth();
    const qrHeight = qrImage.getHeight();
    const logoMaxSize = Math.floor(Math.min(qrWidth, qrHeight) * 0.25);

    logoImage.contain(logoMaxSize, logoMaxSize);

    const x = Math.floor((qrWidth - logoImage.getWidth()) / 2);
    const y = Math.floor((qrHeight - logoImage.getHeight()) / 2);

    qrImage.composite(logoImage, x, y);

    return await qrImage.getBufferAsync(Jimp.MIME_PNG);
  } catch (err) {
    console.error("Failed to add logo to QR:", err);
    return pngBuffer;
  }
}

/**
 * Generate QR for on-page display (medium resolution)
 * POST /api/qr
 */
router.post("/", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Missing username or password" });
    }

    const takUrl = process.env.TAK_URL;
    if (!takUrl) {
      return res.status(500).json({ error: "TAK_URL not set in .env" });
    }

    const host = new URL(takUrl).hostname;

const enrollUrl =
  `tak://com.atakmap.app/enroll?` +
  `host=${host}` +
  `&username=${encodeURIComponent(username)}` +
  `&token=${encodeURIComponent(password)}`;

const basePng = await QRCode.toBuffer(enrollUrl, {
  errorCorrectionLevel: "H",
  type: "png",
  width: 512,     // Display size
  margin: 2,
  color: {
    dark: "#000000",
    light: "#FFFFFF"
  }
});

const finalPng = await addLogoToPng(basePng);
const qrCode = "data:image/png;base64," + finalPng.toString("base64");

return res.json({
  qrCode,
  enrollUrl
});
  } catch (err) {
    console.error("QR generation error:", err);
    return res.status(500).json({ error: "Failed to generate QR code" });
  }
});

/**
 * Download high-resolution QR (print-quality)
 * GET /api/qr/download?username=...&token=...
 */
router.get("/download", async (req, res) => {
  try {
    const username = String(req.query.username || "").trim();
    const token = String(req.query.token || "").trim();

    if (!username || !token) {
      return res.status(400).send("Missing username or token");
    }

    const takUrl = process.env.TAK_URL;
    if (!takUrl) {
      return res.status(500).send("TAK_URL not set in .env");
    }

    const host = new URL(takUrl).hostname;

    const enrollUrl =
      `tak://com.atakmap.app/enroll?` +
      `host=${host}` +
      `&username=${encodeURIComponent(username)}` +
      `&token=${encodeURIComponent(token)}`;

    // 🔥 High-resolution QR for download
    const pngBuffer = await QRCode.toBuffer(enrollUrl, {
      errorCorrectionLevel: "H",
      type: "png",
      width: 1200,   // Much higher than display
      margin: 3
    });
    const finalPng = await addLogoToPng(pngBuffer);

    const safeUser =
      username.toLowerCase().replace(/[^a-z0-9_-]/g, "") || "user";

    const filename = `tak-${safeUser}-enrollment-qr.png`;

    res.setHeader("Content-Type", "image/png");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );

    return res.send(finalPng);
  } catch (err) {
    console.error("QR download error:", err);
    return res.status(500).send("Failed to generate download QR");
  }
});

module.exports = router;