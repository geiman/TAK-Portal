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
        status: req.body.status,
      },
      req.authentikUser
    );

    if (req.file) {
      docsSvc.setDraftFile(doc.id, req.file, req.authentikUser);
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
        status: req.body.status,
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

router.post("/:id/draft", requireGlobal, upload.single("file"), (req, res) => {
  try {
    const doc = docsSvc.getDocumentById(req.params.id);
    if (!doc) {
      if (req.file && req.file.path) try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(404).json({ error: "Not found" });
    }
    if (!req.file) return res.status(400).json({ error: "File required" });
    docsSvc.setDraftFile(doc.id, req.file, req.authentikUser);
    const fresh = docsSvc.getDocumentById(doc.id);
    try {
      auditSvc.logEvent({
        actor: req.authentikUser || null,
        request: {
          method: req.method,
          path: req.originalUrl || req.path,
          ip: req.ip,
        },
        action: "DOCUMENT_DRAFT_UPLOAD",
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

router.post("/:id/signed", requireGlobal, upload.single("file"), (req, res) => {
  try {
    const doc = docsSvc.getDocumentById(req.params.id);
    if (!doc) {
      if (req.file && req.file.path) try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(404).json({ error: "Not found" });
    }
    if (!req.file) return res.status(400).json({ error: "File required" });
    docsSvc.setSignedFile(doc.id, req.file, req.authentikUser);
    const fresh = docsSvc.getDocumentById(doc.id);
    try {
      auditSvc.logEvent({
        actor: req.authentikUser || null,
        request: {
          method: req.method,
          path: req.originalUrl || req.path,
          ip: req.ip,
        },
        action: "DOCUMENT_SIGNED_UPLOAD",
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

router.get("/:id/file", (req, res) => {
  try {
    const role = String(req.query.role || "draft").toLowerCase();
    if (role !== "draft" && role !== "signed") {
      return res.status(400).json({ error: "role must be draft or signed" });
    }
    const doc = docsSvc.getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (!docsSvc.canAccessDocument(req.authentikUser, doc)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const f = docsSvc.getFileRecord(doc, role);
    if (!f) return res.status(404).json({ error: "No file for this role" });
    const abs = docsSvc.getAbsolutePathForFile(f);
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
        details: { role },
      });
    } catch (_) {}
    return res.download(abs, f.fileName);
  } catch (e) {
    return res.status(500).json({ error: e.message || "Download failed" });
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

    const draft = docsSvc.getFileRecord(doc, "draft");
    if (!draft) {
      return res.status(400).json({
        error:
          "No draft / unsigned file uploaded yet. Upload a draft copy first.",
      });
    }

    const abs = docsSvc.getAbsolutePathForFile(draft);
    if (!abs || !fs.existsSync(abs)) {
      return res.status(404).json({ error: "Draft file missing on disk" });
    }

    const note = String(req.body?.message || "").trim();
    const subject = `Document for signature: ${doc.title}`;
    const text =
      `${note ? note + "\n\n" : ""}` +
      `Attached: ${draft.fileName} (draft / unsigned copy)\r\n` +
      `Status will be marked as pending signature after send.\r\n` +
      `Sent from TAK Portal Documents.`;

    const result = await emailSvc.sendMail({
      to,
      subject,
      text,
      attachments: [
        {
          filename: draft.fileName,
          path: abs,
        },
      ],
    });

    if (!result.sent && !result.skipped) {
      return res.status(502).json({
        error: result.error || "Email failed",
      });
    }

    if (result.sent) {
      try {
        docsSvc.recordEmailSentForSignature(doc.id);
      } catch (_) {}
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
