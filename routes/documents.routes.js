/**
 * Documents API — beta; global admins + agency admins (per-document ACL).
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const docsSvc = require("../services/documents.service");
const settingsSvc = require("../services/settings.service");
const emailSvc = require("../services/email.service");
const auditSvc = require("../services/auditLog.service");

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const tmp = path.join(__dirname, "..", "data", "documents", "_tmp");
      if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });
      cb(null, tmp);
    },
    filename: (req, file, cb) => {
      const id = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const ext = path.extname(file.originalname || "") || "";
      cb(null, id + ext);
    },
  }),
  limits: { fileSize: docsSvc.MAX_FILE_BYTES },
});

function requireBeta(req, res, next) {
  const cfg = settingsSvc.getSettings() || {};
  if (String(cfg.BETA_MODE || "").toLowerCase() !== "true") {
    return res.status(404).json({ error: "Not found" });
  }
  next();
}

function requireDocumentsActor(req, res, next) {
  const u = req.authentikUser;
  if (!u || (!u.isGlobalAdmin && !u.isAgencyAdmin)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

function requireGlobal(req, res, next) {
  if (!req.authentikUser || !req.authentikUser.isGlobalAdmin) {
    return res.status(403).json({ error: "Global admin required" });
  }
  next();
}

router.use(requireBeta);
router.use(requireDocumentsActor);
router.use(express.json({ limit: "2mb" }));

router.get("/", (req, res) => {
  try {
    const list = docsSvc.listDocumentsForUser(req.authentikUser);
    const data = list.map((d) => docsSvc.summarizeDoc(d, false));
    return res.json({ data });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Failed to list" });
  }
});

router.post("/", requireGlobal, upload.single("file"), (req, res) => {
  try {
    const agencyRaw = req.body.agencySuffixes;
    let agencySuffixes = [];
    if (typeof agencyRaw === "string") {
      agencySuffixes = agencyRaw
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (Array.isArray(agencyRaw)) {
      agencySuffixes = agencyRaw;
    }

    const doc = docsSvc.createDocument(
      {
        title: req.body.title,
        description: req.body.description,
        category: req.body.category,
        agencySuffixes,
      },
      req.authentikUser
    );

    if (req.file) {
      docsSvc.addVersion(doc.id, req.file, req.authentikUser);
    }

    const fresh = docsSvc.getDocumentById(doc.id);
    try {
      auditSvc.logEvent({
        actor: req.authentikUser || null,
        request: {
          method: req.method,
          path: req.originalUrl || req.path,
          ip: req.ip,
        },
        action: "DOCUMENT_CREATE",
        targetType: "document",
        targetId: doc.id,
        details: { title: doc.title },
      });
    } catch (_) {}

    return res.json({ data: docsSvc.summarizeDoc(fresh, true) });
  } catch (e) {
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) {}
    }
    const code = e.message === "Forbidden" ? 403 : 400;
    return res.status(code).json({ error: e.message || "Failed to create" });
  }
});

router.put("/:id", requireGlobal, (req, res) => {
  try {
    const doc = docsSvc.getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });

    let agencySuffixes;
    if (req.body.agencySuffixes !== undefined) {
      const agencyRaw = req.body.agencySuffixes;
      if (typeof agencyRaw === "string") {
        agencySuffixes = agencyRaw
          .split(/[,;\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (Array.isArray(agencyRaw)) {
        agencySuffixes = agencyRaw;
      } else {
        agencySuffixes = [];
      }
    }

    docsSvc.updateDocumentMeta(
      req.params.id,
      {
        title: req.body.title,
        description: req.body.description,
        category: req.body.category,
        agencySuffixes,
      },
      req.authentikUser
    );

    const fresh = docsSvc.getDocumentById(req.params.id);
    try {
      auditSvc.logEvent({
        actor: req.authentikUser || null,
        request: {
          method: req.method,
          path: req.originalUrl || req.path,
          ip: req.ip,
        },
        action: "DOCUMENT_UPDATE",
        targetType: "document",
        targetId: req.params.id,
        details: {},
      });
    } catch (_) {}

    return res.json({ data: docsSvc.summarizeDoc(fresh, true) });
  } catch (e) {
    const code =
      e.message === "Forbidden" ? 403 : e.message === "Not found" ? 404 : 400;
    return res.status(code).json({ error: e.message || "Failed" });
  }
});

router.delete("/:id", requireGlobal, (req, res) => {
  try {
    docsSvc.deleteDocument(req.params.id, req.authentikUser);
    try {
      auditSvc.logEvent({
        actor: req.authentikUser || null,
        request: {
          method: req.method,
          path: req.originalUrl || req.path,
          ip: req.ip,
        },
        action: "DOCUMENT_DELETE",
        targetType: "document",
        targetId: req.params.id,
        details: {},
      });
    } catch (_) {}
    return res.json({ ok: true });
  } catch (e) {
    const code =
      e.message === "Forbidden" ? 403 : e.message === "Not found" ? 404 : 400;
    return res.status(code).json({ error: e.message || "Failed" });
  }
});

router.post("/:id/versions", requireGlobal, upload.single("file"), (req, res) => {
  try {
    const doc = docsSvc.getDocumentById(req.params.id);
    if (!doc) {
      if (req.file && req.file.path) try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(404).json({ error: "Not found" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "File required" });
    }
    docsSvc.addVersion(doc.id, req.file, req.authentikUser);
    const fresh = docsSvc.getDocumentById(doc.id);
    try {
      auditSvc.logEvent({
        actor: req.authentikUser || null,
        request: {
          method: req.method,
          path: req.originalUrl || req.path,
          ip: req.ip,
        },
        action: "DOCUMENT_VERSION_ADD",
        targetType: "document",
        targetId: doc.id,
        details: {},
      });
    } catch (_) {}
    return res.json({ data: docsSvc.summarizeDoc(fresh, true) });
  } catch (e) {
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) {}
    }
    const code =
      e.message === "Forbidden"
        ? 403
        : e.message === "Not found"
          ? 404
          : 400;
    return res.status(code).json({ error: e.message || "Upload failed" });
  }
});

router.get("/:id/versions/:vid/download", (req, res) => {
  try {
    const doc = docsSvc.getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (!docsSvc.canAccessDocument(req.authentikUser, doc)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const ver = docsSvc.getVersionRecord(doc, req.params.vid);
    if (!ver) return res.status(404).json({ error: "Version not found" });
    const abs = docsSvc.getVersionAbsolutePath(doc, ver);
    if (!abs || !fs.existsSync(abs)) {
      return res.status(404).json({ error: "File missing" });
    }
    try {
      auditSvc.logEvent({
        actor: req.authentikUser || null,
        request: {
          method: req.method,
          path: req.originalUrl || req.path,
          ip: req.ip,
        },
        action: "DOCUMENT_DOWNLOAD",
        targetType: "document",
        targetId: doc.id,
        details: { versionId: ver.id, version: ver.version },
      });
    } catch (_) {}
    return res.download(abs, ver.fileName);
  } catch (e) {
    return res.status(500).json({ error: e.message || "Download failed" });
  }
});

router.post("/:id/sign", (req, res) => {
  try {
    const doc = docsSvc.getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    const text = String(req.body?.acknowledgmentText || "").trim();
    if (text.length < 8) {
      return res.status(400).json({
        error: "Please enter a meaningful acknowledgment (at least 8 characters).",
      });
    }
    const sig = docsSvc.recordSignature(
      doc.id,
      req.body?.versionId,
      { acknowledgmentText: text },
      req.authentikUser,
      req
    );
    try {
      auditSvc.logEvent({
        actor: req.authentikUser || null,
        request: {
          method: req.method,
          path: req.originalUrl || req.path,
          ip: req.ip,
        },
        action: "DOCUMENT_SIGN",
        targetType: "document",
        targetId: doc.id,
        details: { versionId: sig.versionId, signatureId: sig.id },
      });
    } catch (_) {}
    return res.json({ data: sig });
  } catch (e) {
    const code =
      e.message === "Forbidden"
        ? 403
        : e.message === "Not found" || e.message === "Version not found"
          ? 404
          : 400;
    return res.status(code).json({ error: e.message || "Failed" });
  }
});

router.get("/:id/receipts/:sid/download", (req, res) => {
  try {
    const doc = docsSvc.getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (!docsSvc.canAccessDocument(req.authentikUser, doc)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const abs = docsSvc.getSignatureReceiptPath(doc, req.params.sid);
    if (!abs || !fs.existsSync(abs)) {
      return res.status(404).json({ error: "Receipt not found" });
    }
    const name = `acknowledgment-${req.params.sid}.txt`;
    return res.download(abs, name);
  } catch (e) {
    return res.status(500).json({ error: e.message || "Failed" });
  }
});

router.post("/:id/email", async (req, res) => {
  try {
    const doc = docsSvc.getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (!docsSvc.canAccessDocument(req.authentikUser, doc)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const to = String(req.body?.to || "")
      .trim()
      .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({ error: "Valid email address required" });
    }

    const versionId = String(req.body?.versionId || "").trim();
    const ver = docsSvc.getVersionRecord(doc, versionId);
    if (!ver) return res.status(400).json({ error: "Version not found" });

    const abs = docsSvc.getVersionAbsolutePath(doc, ver);
    if (!abs || !fs.existsSync(abs)) {
      return res.status(404).json({ error: "File missing" });
    }

    const note = String(req.body?.message || "").trim();
    const subject = `Document: ${doc.title} (v${ver.version})`;
    const text =
      `${note ? note + "\n\n" : ""}` +
      `Attached: ${ver.fileName} (version ${ver.version})\r\n` +
      `Sent from TAK Portal Documents.`;

    const result = await emailSvc.sendMail({
      to,
      subject,
      text,
      attachments: [
        {
          filename: ver.fileName,
          path: abs,
        },
      ],
    });

    if (!result.sent && !result.skipped) {
      return res.status(502).json({
        error: result.error || "Email failed",
      });
    }

    try {
      auditSvc.logEvent({
        actor: req.authentikUser || null,
        request: {
          method: req.method,
          path: req.originalUrl || req.path,
          ip: req.ip,
        },
        action: "DOCUMENT_EMAIL",
        targetType: "document",
        targetId: doc.id,
        details: {
          to,
          versionId: ver.id,
          skipped: !!result.skipped,
        },
      });
    } catch (_) {}

    return res.json({
      ok: true,
      sent: result.sent,
      skipped: result.skipped,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Failed" });
  }
});

router.get("/:id", (req, res) => {
  try {
    const doc = docsSvc.getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (!docsSvc.canAccessDocument(req.authentikUser, doc)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return res.json({ data: docsSvc.summarizeDoc(doc, true) });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Failed" });
  }
});

module.exports = router;
