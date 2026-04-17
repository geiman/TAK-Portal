/**
 * Data package service for TAK/OpenTAK.
 * Prefers OpenTAK `/api/data_packages` endpoints and falls back to Marti upload.
 */
const crypto = require("crypto");
const { buildTakAxios, getTakBaseUrl, isTakConfigured } = require("./tak.service");
const { getBool } = require("./env");

function assertTakAvailable() {
  if (getBool("TAK_BYPASS_ENABLED", false)) {
    const e = new Error("TAK operations are disabled (TAK_BYPASS_ENABLED=true).");
    e.code = "TAK_BYPASS";
    throw e;
  }
  if (!isTakConfigured()) {
    const e = new Error("TAK_URL is not configured in Server Settings.");
    e.code = "TAK_NOT_CONFIGURED";
    throw e;
  }
}

function getTakOriginBaseUrl() {
  const u = new URL(getTakBaseUrl());
  return `${u.protocol}//${u.host}`;
}

function buildTakOriginAxios(options = {}) {
  return buildTakAxios({
    ...options,
    baseURL: getTakOriginBaseUrl(),
  });
}

function normalizeDataPackageList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.items)) return payload.items;
  if (payload && Array.isArray(payload.results)) return payload.results;
  if (payload && payload.data && Array.isArray(payload.data.items)) return payload.data.items;
  if (payload && payload.data && Array.isArray(payload.data.results)) return payload.data.results;
  if (payload && payload.results && Array.isArray(payload.results.items)) return payload.results.items;
  return [];
}

function parseKeywords(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") {
    return v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

function scalar(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v).trim();
  return "";
}

function pickScalar(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (let i = 0; i < keys.length; i++) {
    const out = scalar(obj[keys[i]]);
    if (out) return out;
  }
  return "";
}

function asNumOrRaw(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

function normalizePackageRecord(item) {
  const o = item && typeof item === "object" ? item : {};
  const candidates = [
    o,
    o.file,
    o.File,
    o.metadata,
    o.Metadata,
    o.content,
    o.Content,
    o.resource,
    o.Resource,
    o.value,
    o.Value,
  ].filter((x) => x && typeof x === "object");

  let hash = "";
  let filename = "";
  let mimeType = "";
  let size = "";
  let creator = "";
  let created = "";
  let tool = "";
  let keywords = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!hash) {
      hash = pickScalar(c, [
        "hash",
        "sha256",
        "sha",
        "checksum",
        "contentHash",
        "content_hash",
        "fileHash",
        "file_hash",
        "uid",
        "UID",
        "id",
      ]);
    }
    if (!filename) {
      filename = pickScalar(c, [
        "filename",
        "fileName",
        "name",
        "label",
        "title",
        "original_filename",
        "downloadName",
      ]);
    }
    if (!mimeType) mimeType = pickScalar(c, ["mime_type", "mimetype", "contentType", "type"]);
    if (!size) size = pickScalar(c, ["size", "content_length", "contentLength", "length"]);
    if (!creator) creator = pickScalar(c, ["creator_uid", "creatorUid", "creator", "owner", "author"]);
    if (!created) created = pickScalar(c, ["created_at", "createTime", "created", "timestamp", "updated_at"]);
    if (!tool) tool = pickScalar(c, ["tool"]);
    if (!keywords.length) keywords = parseKeywords(c.keywords || c.keyword || c.tags);
  }

  return {
    ...o,
    hash,
    filename,
    mime_type: mimeType,
    size: asNumOrRaw(size),
    creator_uid: creator,
    created_at: created,
    tool,
    keywords,
  };
}

async function listDataPackages(query = {}) {
  assertTakAvailable();
  const client = buildTakOriginAxios({ timeout: 60000 });
  try {
    const res = await client.get("/api/data_packages", { params: query || {} });
    const list = normalizeDataPackageList(res.data)
      .map(normalizePackageRecord)
      .filter((x) => x.hash || x.filename);
    return {
      items: list,
      raw: res.data,
      source: "api_data_packages",
    };
  } catch (err) {
    const status = err?.response?.status;
    if (status && status !== 404 && status !== 405) throw err;
  }

  // Fallback for Marti-only builds: file metadata endpoint.
  try {
    const res = await client.get("/Marti/api/files/metadata", { params: query || {} });
    const list = normalizeDataPackageList(res.data)
      .map(normalizePackageRecord)
      .filter((x) => x.hash || x.filename);
    return {
      items: list,
      raw: res.data,
      source: "marti_files_metadata",
    };
  } catch (err) {
    const status = err?.response?.status;
    if (status && status !== 404 && status !== 405) throw err;
  }

  // Last fallback: sync search endpoint often includes package/file metadata.
  const res = await client.get("/Marti/sync/search", { params: query || {} });
  const list = normalizeDataPackageList(res.data)
    .map(normalizePackageRecord)
    .filter((x) => x.hash || x.filename);
  return {
    items: list,
    raw: res.data,
    source: "marti_sync_search",
  };
}

async function deleteDataPackage(hash) {
  assertTakAvailable();
  const h = String(hash || "").trim();
  if (!h) {
    const e = new Error("Data package hash is required.");
    e.code = "INVALID_HASH";
    throw e;
  }
  const client = buildTakOriginAxios({ timeout: 60000 });
  const res = await client.delete("/api/data_packages", {
    params: { hash: h },
    validateStatus: (s) => (s >= 200 && s < 300) || s === 404,
  });
  if (res.status === 404) return { ok: true, alreadyGone: true };
  return res.data;
}

async function downloadDataPackageStream(hash) {
  assertTakAvailable();
  const h = String(hash || "").trim();
  if (!h) {
    const e = new Error("Data package hash is required.");
    e.code = "INVALID_HASH";
    throw e;
  }
  const client = buildTakOriginAxios({ timeout: 180000 });
  const reqOpts = {
    params: { hash: h },
    responseType: "stream",
    validateStatus: () => true,
  };
  const primary = await client.get("/api/data_packages/download", reqOpts);
  if (primary.status !== 404 && primary.status !== 405) return primary;
  return client.get("/Marti/sync/content", reqOpts);
}

function safeFilename(name, fallback) {
  const cleaned = String(name || "")
    .replace(/[^\w.\- ()\[\]]+/g, "_")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

async function uploadDataPackage(buffer, originalName, metadata = {}) {
  assertTakAvailable();
  if (!buffer || !Buffer.isBuffer(buffer) || !buffer.length) {
    const e = new Error("File content is required.");
    e.code = "INVALID_UPLOAD";
    throw e;
  }
  const filename = safeFilename(originalName || "data-package.zip", "data-package.zip");
  const mimeType = String(metadata.mimeType || "application/zip");
  const client = buildTakOriginAxios({ timeout: 180000 });
  const BlobCtor = global.Blob || require("node:buffer").Blob;

  // Preferred: OpenTAKServer REST endpoint.
  try {
    const form = new FormData();
    const blob = new BlobCtor([buffer], { type: mimeType });
    form.append("file", blob, filename);

    Object.keys(metadata || {}).forEach((k) => {
      const v = metadata[k];
      if (v != null && v !== "" && k !== "mimeType") form.append(k, String(v));
    });

    const res = await client.post("/api/data_packages", form, {
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    return res.data;
  } catch (err) {
    const status = err?.response?.status;
    if (status && status !== 404 && status !== 405) throw err;
  }

  // Fallback: Marti endpoint for package/file upload.
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  const creatorUid = String(metadata.creator_uid || metadata.creatorUid || "tak-portal").trim();

  const fallbackForm = new FormData();
  const fallbackBlob = new BlobCtor([buffer], { type: mimeType });
  fallbackForm.append("assetfile", fallbackBlob, filename);
  fallbackForm.append("filename", filename);

  const fallbackRes = await client.post("/Marti/sync/missionupload", fallbackForm, {
    params: {
      hash,
      filename,
      creatorUid,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return fallbackRes.data;
}

async function getDataPackageMetadata(hash) {
  assertTakAvailable();
  const h = String(hash || "").trim();
  if (!h) {
    const e = new Error("Data package hash is required.");
    e.code = "INVALID_HASH";
    throw e;
  }
  const client = buildTakOriginAxios({ timeout: 60000 });
  const out = {
    hash: h,
    tool: "",
    keywords: [],
  };

  try {
    const toolRes = await client.get(`/Marti/api/sync/metadata/${encodeURIComponent(h)}/tool`);
    const d = toolRes.data;
    if (typeof d === "string") out.tool = d.trim();
    else if (d && typeof d === "object") out.tool = String(d.tool || d.value || "").trim();
  } catch (_) {
    // optional endpoint by TAK build
  }

  try {
    const listRes = await client.get("/api/data_packages", { params: { hash: h } });
    const list = normalizeDataPackageList(listRes.data);
    if (list.length) {
      const item = list[0] || {};
      const kws = item.keywords || item.keyword || item.tags;
      if (Array.isArray(kws)) out.keywords = kws.map((x) => String(x)).filter(Boolean);
      else if (typeof kws === "string") {
        out.keywords = kws
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
      }
      if (!out.tool) out.tool = String(item.tool || "").trim();
      out.installOnEnrollment = item.install_on_enrollment ?? item.installOnEnrollment;
      out.installOnConnection = item.install_on_connection ?? item.installOnConnection;
    }
  } catch (_) {
    // optional metadata source
  }

  try {
    const listRes = await client.get("/Marti/api/files/metadata", { params: { hash: h } });
    const list = normalizeDataPackageList(listRes.data).map(normalizePackageRecord);
    if (list.length) {
      const item = list[0] || {};
      if (!out.tool) out.tool = String(item.tool || "").trim();
      if (!out.keywords || !out.keywords.length) out.keywords = parseKeywords(item.keywords);
    }
  } catch (_) {
    // optional metadata source
  }

  return out;
}

async function updateDataPackageMetadata(hash, patch = {}) {
  assertTakAvailable();
  const h = String(hash || "").trim();
  if (!h) {
    const e = new Error("Data package hash is required.");
    e.code = "INVALID_HASH";
    throw e;
  }
  const client = buildTakOriginAxios({ timeout: 60000 });
  const out = { ok: true };

  if (patch.tool != null) {
    const tool = String(patch.tool || "").trim();
    await client.put(`/Marti/api/sync/metadata/${encodeURIComponent(h)}/tool`, tool, {
      headers: { "Content-Type": "text/plain; charset=utf-8", Accept: "application/json" },
    });
    out.tool = tool;
  }

  if (patch.keywords != null) {
    const keywords = Array.isArray(patch.keywords)
      ? patch.keywords
      : String(patch.keywords || "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
    await client.put(`/Marti/api/sync/metadata/${encodeURIComponent(h)}/keywords`, keywords, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
    });
    out.keywords = keywords;
  }

  // OTS-specific flags; if endpoint/build does not support it we continue.
  if (
    patch.installOnEnrollment != null ||
    patch.installOnConnection != null
  ) {
    try {
      const body = {
        install_on_enrollment: patch.installOnEnrollment === true,
        install_on_connection: patch.installOnConnection === true,
      };
      await client.put("/api/data_packages", body, {
        params: { hash: h },
        headers: { "Content-Type": "application/json", Accept: "application/json" },
      });
      out.installOnEnrollment = body.install_on_enrollment;
      out.installOnConnection = body.install_on_connection;
    } catch (_) {
      out.flagsUnsupported = true;
    }
  }

  return out;
}

module.exports = {
  assertTakAvailable,
  listDataPackages,
  deleteDataPackage,
  downloadDataPackageStream,
  uploadDataPackage,
  getDataPackageMetadata,
  updateDataPackageMetadata,
};
