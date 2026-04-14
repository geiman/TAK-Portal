/**
 * Portal documents — draft + optional executed (signed) file, status workflow.
 * Manifest: data/documents/index.json; files: data/documents/files/{docId}/
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data", "documents");
const INDEX_PATH = path.join(DATA_DIR, "index.json");
const FILES_DIR = path.join(DATA_DIR, "files");

const MAX_FILE_BYTES = 40 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
]);

const CATEGORIES = ["MOU", "Data Sharing Agreement", "SOP", "Other"];
const STATUSES = ["draft", "pending_signature", "signed"];

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });
}

function loadIndex() {
  ensureDirs();
  if (!fs.existsSync(INDEX_PATH)) {
    const empty = { documents: [] };
    fs.writeFileSync(INDEX_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
    if (!raw || !Array.isArray(raw.documents)) return { documents: [] };
    let dirty = false;
    raw.documents = raw.documents.map((doc) => {
      const m = migrateDocument(doc);
      if (m._migrated) dirty = true;
      delete m._migrated;
      return m;
    });
    if (dirty) saveIndex(raw);
    return raw;
  } catch (_) {
    return { documents: [] };
  }
}

function saveIndex(data) {
  ensureDirs();
  fs.writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2));
}

function normalizeCategory(c) {
  const s = String(c || "").trim();
  if (CATEGORIES.includes(s)) return s;
  if (s === "Policy") return "Other";
  return "Other";
}

function normalizeStatus(s) {
  const x = String(s || "").trim();
  if (STATUSES.includes(x)) return x;
  return "draft";
}

function migrateDocument(doc) {
  if (!doc || typeof doc !== "object") return doc;
  let migrated = false;

  if (Array.isArray(doc.versions) && doc.versions.length && !doc.draftFile) {
    const versions = doc.versions;
    const latest = versions.reduce((a, b) =>
      (a.version || 0) > (b.version || 0) ? a : b
    );
    if (latest && latest.storageRelPath) {
      doc.draftFile = {
        fileName: latest.fileName || "document",
        mimeType: latest.mimeType || "application/pdf",
        size: latest.size || 0,
        storageRelPath: latest.storageRelPath,
        uploadedAt: latest.uploadedAt || doc.updatedAt || doc.createdAt,
        uploadedBy: latest.uploadedBy || "",
        sha256: latest.sha256 || "",
      };
      migrated = true;
    }
    delete doc.versions;
  }
  if (doc.signatures) {
    delete doc.signatures;
    migrated = true;
  }
  if (!doc.status) {
    doc.status = "draft";
    migrated = true;
  } else {
    doc.status = normalizeStatus(doc.status);
  }
  if (doc.category) doc.category = normalizeCategory(doc.category);
  else doc.category = "Other";

  doc._migrated = migrated;
  return doc;
}

function normalizeSuffixes(arr) {
  if (!Array.isArray(arr)) return [];
  const out = new Set();
  for (const s of arr) {
    const n = String(s || "")
      .trim()
      .toLowerCase();
    if (n) out.add(n);
  }
  return Array.from(out).sort();
}

function canAccessDocument(user, doc) {
  if (!user || !doc) return false;
  if (user.isGlobalAdmin) return true;
  if (!user.isAgencyAdmin) return false;
  const allowed = normalizeSuffixes(doc.agencySuffixes);
  if (allowed.length === 0) return false;
  const mine = Array.isArray(user.allowedAgencySuffixes)
    ? user.allowedAgencySuffixes.map((s) => String(s || "").trim().toLowerCase())
    : [];
  return allowed.some((s) => mine.includes(s));
}

function userCanManage(user) {
  return !!(user && user.isGlobalAdmin);
}

function sha256File(absPath) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(absPath));
  return h.digest("hex");
}

function safeFilename(name) {
  const base = path.basename(String(name || "file"));
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "file";
}

function absolutePathFromRel(rel) {
  const clean = String(rel || "").replace(/^\/+/, "");
  return path.join(DATA_DIR, clean);
}

function fileSummary(f) {
  if (!f || !f.storageRelPath) return null;
  return {
    fileName: f.fileName,
    mimeType: f.mimeType,
    size: f.size,
    uploadedAt: f.uploadedAt,
    uploadedBy: f.uploadedBy,
  };
}

function getDocumentById(id) {
  const idx = loadIndex();
  const idStr = String(id || "").trim();
  return idx.documents.find((d) => d && String(d.id) === idStr) || null;
}

function listDocumentsForUser(user) {
  const idx = loadIndex();
  return idx.documents.filter((d) => canAccessDocument(user, d));
}

function summarizeDoc(doc, detail) {
  if (!doc) return null;
  const base = {
    id: doc.id,
    title: doc.title,
    description: doc.description || "",
    category: normalizeCategory(doc.category),
    status: normalizeStatus(doc.status),
    agencySuffixes: normalizeSuffixes(doc.agencySuffixes),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    createdBy: doc.createdBy,
    emailedAt: doc.emailedAt || null,
    draftFile: fileSummary(doc.draftFile),
    signedFile: fileSummary(doc.signedFile),
  };
  if (detail) {
    base.hasDraftFile = !!(doc.draftFile && doc.draftFile.storageRelPath);
    base.hasSignedFile = !!(doc.signedFile && doc.signedFile.storageRelPath);
  }
  return base;
}

function removeFileRel(rel) {
  if (!rel) return;
  const abs = absolutePathFromRel(rel);
  try {
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (_) {}
}

function storeFile(docId, file, role, user) {
  if (!file || !file.path) throw new Error("No file");
  const stat = fs.statSync(file.path);
  if (stat.size > MAX_FILE_BYTES) {
    try {
      fs.unlinkSync(file.path);
    } catch (_) {}
    throw new Error(`File too large (max ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB)`);
  }
  assertMime(file.mimetype);

  const destDir = path.join(FILES_DIR, docId);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const ext = path.extname(safeFilename(file.originalname)) || "";
  const storedName = `${role}_${crypto.randomUUID()}${ext}`;
  const destAbs = path.join(destDir, storedName);
  fs.renameSync(file.path, destAbs);

  const rel = path.relative(DATA_DIR, destAbs).replace(/\\/g, "/");
  return {
    fileName: safeFilename(file.originalname),
    mimeType: String(file.mimetype || "").split(";")[0].trim(),
    size: stat.size,
    uploadedAt: new Date().toISOString(),
    uploadedBy: user.username || "",
    storageRelPath: rel,
    sha256: sha256File(destAbs),
  };
}

function assertMime(mime) {
  const m = String(mime || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_MIME.has(m)) {
    throw new Error(
      `Unsupported file type. Allowed: PDF, Word (.doc/.docx), PNG, JPEG.`
    );
  }
}

function createDocument(
  { title, description, category, agencySuffixes, status },
  user
) {
  if (!userCanManage(user)) throw new Error("Forbidden");
  const idx = loadIndex();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const doc = {
    id,
    title: String(title || "").trim() || "Untitled",
    description: String(description || "").trim(),
    category: normalizeCategory(category),
    status: normalizeStatus(status || "draft"),
    agencySuffixes: normalizeSuffixes(agencySuffixes),
    createdAt: now,
    updatedAt: now,
    createdBy: user.username || "",
    emailedAt: null,
    draftFile: null,
    signedFile: null,
  };
  idx.documents.push(doc);
  saveIndex(idx);
  return doc;
}

function updateDocumentMeta(
  id,
  { title, description, category, agencySuffixes, status },
  user
) {
  if (!userCanManage(user)) throw new Error("Forbidden");
  const idx = loadIndex();
  const doc = idx.documents.find((d) => d.id === id);
  if (!doc) throw new Error("Not found");
  if (title != null) doc.title = String(title || "").trim() || doc.title;
  if (description != null) doc.description = String(description || "").trim();
  if (category != null) doc.category = normalizeCategory(category);
  if (agencySuffixes != null) doc.agencySuffixes = normalizeSuffixes(agencySuffixes);
  if (status != null) doc.status = normalizeStatus(status);
  doc.updatedAt = new Date().toISOString();
  saveIndex(idx);
  return doc;
}

function deleteDocument(id, user) {
  if (!userCanManage(user)) throw new Error("Forbidden");
  const idx = loadIndex();
  const i = idx.documents.findIndex((d) => d.id === id);
  if (i < 0) throw new Error("Not found");
  const doc = idx.documents[i];
  const dir = path.join(FILES_DIR, doc.id);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  idx.documents.splice(i, 1);
  saveIndex(idx);
}

function setDraftFile(docId, file, user) {
  if (!userCanManage(user)) throw new Error("Forbidden");
  const idx = loadIndex();
  const doc = idx.documents.find((d) => d.id === docId);
  if (!doc) throw new Error("Not found");
  if (doc.draftFile && doc.draftFile.storageRelPath) {
    removeFileRel(doc.draftFile.storageRelPath);
  }
  doc.draftFile = storeFile(docId, file, "draft", user);
  doc.updatedAt = doc.draftFile.uploadedAt;
  saveIndex(idx);
  return doc.draftFile;
}

function setSignedFile(docId, file, user) {
  if (!userCanManage(user)) throw new Error("Forbidden");
  const idx = loadIndex();
  const doc = idx.documents.find((d) => d.id === docId);
  if (!doc) throw new Error("Not found");
  if (doc.signedFile && doc.signedFile.storageRelPath) {
    removeFileRel(doc.signedFile.storageRelPath);
  }
  doc.signedFile = storeFile(docId, file, "signed", user);
  doc.status = "signed";
  doc.updatedAt = doc.signedFile.uploadedAt;
  saveIndex(idx);
  return doc.signedFile;
}

/** After a draft is emailed for signature, advance workflow (any role that could send). */
function recordEmailSentForSignature(docId) {
  const idx = loadIndex();
  const doc = idx.documents.find((d) => d.id === docId);
  if (!doc) throw new Error("Not found");
  const now = new Date().toISOString();
  doc.emailedAt = now;
  if (doc.status !== "signed") {
    doc.status = "pending_signature";
  }
  doc.updatedAt = now;
  saveIndex(idx);
}

function getFileRecord(doc, role) {
  if (role === "signed") return doc.signedFile || null;
  return doc.draftFile || null;
}

function getAbsolutePathForFile(f) {
  if (!f || !f.storageRelPath) return null;
  return absolutePathFromRel(f.storageRelPath);
}

module.exports = {
  DATA_DIR,
  FILES_DIR,
  MAX_FILE_BYTES,
  CATEGORIES,
  STATUSES,
  loadIndex,
  canAccessDocument,
  userCanManage,
  listDocumentsForUser,
  getDocumentById,
  summarizeDoc,
  createDocument,
  updateDocumentMeta,
  deleteDocument,
  setDraftFile,
  setSignedFile,
  recordEmailSentForSignature,
  getFileRecord,
  getAbsolutePathForFile,
  normalizeSuffixes,
  normalizeCategory,
};
