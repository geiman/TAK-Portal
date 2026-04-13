/**
 * Portal documents repository (MOUs, policies, etc.).
 * Files live under data/documents/files/; manifest at data/documents/index.json
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
    return raw;
  } catch (_) {
    return { documents: [] };
  }
}

function saveIndex(data) {
  ensureDirs();
  fs.writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2));
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

function getDocumentById(id) {
  const idx = loadIndex();
  const idStr = String(id || "").trim();
  return idx.documents.find((d) => d && String(d.id) === idStr) || null;
}

function listDocumentsForUser(user) {
  const idx = loadIndex();
  return idx.documents.filter((d) => canAccessDocument(user, d));
}

function summarizeDoc(doc, includeVersions) {
  if (!doc) return null;
  const versions = Array.isArray(doc.versions) ? doc.versions : [];
  const latest = versions.length
    ? versions.reduce((a, b) => (a.version > b.version ? a : b))
    : null;
  const base = {
    id: doc.id,
    title: doc.title,
    description: doc.description || "",
    category: doc.category || "Other",
    agencySuffixes: normalizeSuffixes(doc.agencySuffixes),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    createdBy: doc.createdBy,
    versionCount: versions.length,
    latestVersion: latest
      ? {
          id: latest.id,
          version: latest.version,
          fileName: latest.fileName,
          mimeType: latest.mimeType,
          size: latest.size,
          uploadedAt: latest.uploadedAt,
        }
      : null,
  };
  if (includeVersions) {
    base.versions = versions.map((v) => ({
      id: v.id,
      version: v.version,
      fileName: v.fileName,
      mimeType: v.mimeType,
      size: v.size,
      uploadedAt: v.uploadedAt,
      uploadedBy: v.uploadedBy,
    }));
    base.signatures = Array.isArray(doc.signatures) ? doc.signatures : [];
  }
  return base;
}

function createDocument(
  { title, description, category, agencySuffixes },
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
    category: String(category || "Other").trim() || "Other",
    agencySuffixes: normalizeSuffixes(agencySuffixes),
    createdAt: now,
    updatedAt: now,
    createdBy: user.username || "",
    versions: [],
    signatures: [],
  };
  idx.documents.push(doc);
  saveIndex(idx);
  return doc;
}

function updateDocumentMeta(id, { title, description, category, agencySuffixes }, user) {
  if (!userCanManage(user)) throw new Error("Forbidden");
  const idx = loadIndex();
  const doc = idx.documents.find((d) => d.id === id);
  if (!doc) throw new Error("Not found");
  if (title != null) doc.title = String(title || "").trim() || doc.title;
  if (description != null) doc.description = String(description || "").trim();
  if (category != null) doc.category = String(category || "Other").trim() || "Other";
  if (agencySuffixes != null) doc.agencySuffixes = normalizeSuffixes(agencySuffixes);
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

function assertMime(mime) {
  const m = String(mime || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_MIME.has(m)) {
    throw new Error(
      `Unsupported file type. Allowed: PDF, Word (.doc/.docx), PNG, JPEG.`
    );
  }
}

function addVersion(docId, file, user) {
  if (!userCanManage(user)) throw new Error("Forbidden");
  const idx = loadIndex();
  const doc = idx.documents.find((d) => d.id === docId);
  if (!doc) throw new Error("Not found");
  if (!file || !file.path) throw new Error("No file");

  const stat = fs.statSync(file.path);
  if (stat.size > MAX_FILE_BYTES) {
    try {
      fs.unlinkSync(file.path);
    } catch (_) {}
    throw new Error(`File too large (max ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB)`);
  }

  assertMime(file.mimetype);

  ensureDirs();
  const destDir = path.join(FILES_DIR, doc.id);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const versions = Array.isArray(doc.versions) ? doc.versions : [];
  const nextNum = versions.length ? Math.max(...versions.map((v) => v.version)) + 1 : 1;
  const vid = crypto.randomUUID();
  const ext = path.extname(safeFilename(file.originalname)) || "";
  const storedName = `v${nextNum}_${vid}${ext}`;
  const destAbs = path.join(destDir, storedName);
  fs.renameSync(file.path, destAbs);

  const sha = sha256File(destAbs);
  const rel = path.relative(DATA_DIR, destAbs).replace(/\\/g, "/");

  const rec = {
    id: vid,
    version: nextNum,
    fileName: safeFilename(file.originalname),
    mimeType: String(file.mimetype || "").split(";")[0].trim(),
    size: stat.size,
    uploadedAt: new Date().toISOString(),
    uploadedBy: user.username || "",
    storageRelPath: rel,
    sha256: sha,
  };

  doc.versions = versions.concat(rec);
  doc.updatedAt = rec.uploadedAt;
  saveIndex(idx);
  return rec;
}

function getVersionRecord(doc, versionId) {
  const vid = String(versionId || "").trim();
  const versions = Array.isArray(doc.versions) ? doc.versions : [];
  return versions.find((v) => v && String(v.id) === vid) || null;
}

function absolutePathFromRel(rel) {
  const clean = String(rel || "").replace(/^\/+/, "");
  return path.join(DATA_DIR, clean);
}

function getVersionAbsolutePath(doc, version) {
  if (!version || !version.storageRelPath) return null;
  return absolutePathFromRel(version.storageRelPath);
}

function recordSignature(docId, versionId, { acknowledgmentText }, user, req) {
  const idx = loadIndex();
  const doc = idx.documents.find((d) => d.id === docId);
  if (!doc) throw new Error("Not found");
  if (!canAccessDocument(user, doc)) throw new Error("Forbidden");

  const ver = getVersionRecord(doc, versionId);
  if (!ver) throw new Error("Version not found");

  const sigId = crypto.randomUUID();
  const now = new Date().toISOString();
  const displayName =
    user && (user.displayName || user.username)
      ? user.displayName || user.username
      : user.username || "";

  const ip = req && req.ip ? String(req.ip) : "";

  const receiptDir = path.join(FILES_DIR, doc.id, "receipts");
  if (!fs.existsSync(receiptDir)) fs.mkdirSync(receiptDir, { recursive: true });

  const receiptName = `${sigId}.txt`;
  const receiptAbs = path.join(receiptDir, receiptName);
  const body =
    `TAK Portal — Document acknowledgment\r\n` +
    `=====================================\r\n\r\n` +
    `Document: ${doc.title}\r\n` +
    `Version: ${ver.version} (${ver.fileName})\r\n` +
    `Document ID: ${doc.id}\r\n` +
    `Version ID: ${ver.id}\r\n\r\n` +
    `Signer (account): ${user.username || ""}\r\n` +
    `Display name: ${displayName}\r\n` +
    `Signed at (UTC): ${now}\r\n` +
    `IP: ${ip || "(unknown)"}\r\n\r\n` +
    `Acknowledgment:\r\n` +
    `${String(acknowledgmentText || "").trim()}\r\n\r\n` +
    `This receipt was generated by the portal and stored with the document record.\r\n`;

  fs.writeFileSync(receiptAbs, body, "utf8");
  const receiptRel = path
    .relative(DATA_DIR, receiptAbs)
    .replace(/\\/g, "/");

  const sig = {
    id: sigId,
    versionId: ver.id,
    username: user.username || "",
    displayName,
    signedAt: now,
    ip,
    acknowledgmentText: String(acknowledgmentText || "").trim(),
    receiptRelPath: receiptRel,
  };

  doc.signatures = Array.isArray(doc.signatures) ? doc.signatures : [];
  doc.signatures.push(sig);
  doc.updatedAt = now;
  saveIndex(idx);
  return sig;
}

function getSignatureReceiptPath(doc, signatureId) {
  const sid = String(signatureId || "").trim();
  const sigs = Array.isArray(doc.signatures) ? doc.signatures : [];
  const s = sigs.find((x) => x && String(x.id) === sid);
  if (!s || !s.receiptRelPath) return null;
  return absolutePathFromRel(s.receiptRelPath);
}

module.exports = {
  DATA_DIR,
  FILES_DIR,
  MAX_FILE_BYTES,
  loadIndex,
  canAccessDocument,
  userCanManage,
  listDocumentsForUser,
  getDocumentById,
  summarizeDoc,
  createDocument,
  updateDocumentMeta,
  deleteDocument,
  addVersion,
  getVersionRecord,
  getVersionAbsolutePath,
  recordSignature,
  getSignatureReceiptPath,
  normalizeSuffixes,
};
