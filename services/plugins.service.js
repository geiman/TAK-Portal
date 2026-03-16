/**
 * Plugin Manager service: TAK.gov link state + plugin storage under data/plugins.
 * Mimics OpenTAKServer-style flow: link account → list/download plugins → store in data/plugins.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const PLUGINS_DIR = path.join(DATA_DIR, "plugins");
const MANIFEST_PATH = path.join(DATA_DIR, "plugin-manifest.json");

const LINK_CODE_TTL_MS = 3 * 60 * 1000; // 3 minutes, per TAK.gov docs

function ensurePluginsDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true });
}

function loadManifest() {
  ensurePluginsDir();
  if (!fs.existsSync(MANIFEST_PATH)) {
    return {
      takGovLink: { linked: false, linkCode: null, linkCodeExpiry: null },
      plugins: [],
    };
  }
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, "utf8");
    const data = JSON.parse(raw);
    const plugins = Array.isArray(data.plugins) ? data.plugins : [];
    const takGovLink = data.takGovLink && typeof data.takGovLink === "object"
      ? data.takGovLink
      : { linked: false, linkCode: null, linkCodeExpiry: null };
    return { takGovLink, plugins };
  } catch (err) {
    console.warn("[plugins.service] Failed to read manifest:", err?.message || err);
    return {
      takGovLink: { linked: false, linkCode: null, linkCodeExpiry: null },
      plugins: [],
    };
  }
}

function saveManifest(manifest) {
  ensurePluginsDir();
  const payload = {
    takGovLink: manifest.takGovLink || { linked: false, linkCode: null, linkCodeExpiry: null },
    plugins: Array.isArray(manifest.plugins) ? manifest.plugins : [],
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(payload, null, 2));
}

/**
 * Get current TAK.gov link status and, if requested, a new link code.
 * @param {boolean} generateNewCode - if true, generate and store a new link code
 * @returns {{ linked: boolean, linkCode?: string, linkCodeExpiry?: number, message?: string }}
 */
function getTakGovLinkState(generateNewCode = false) {
  const manifest = loadManifest();
  const { takGovLink } = manifest;

  if (generateNewCode) {
    const code = crypto.randomBytes(4).toString("hex").toUpperCase();
    const expiry = Date.now() + LINK_CODE_TTL_MS;
    const updated = {
      ...takGovLink,
      linkCode: code,
      linkCodeExpiry: expiry,
    };
    saveManifest({ ...manifest, takGovLink: updated });
    return {
      linked: !!takGovLink.linked,
      linkCode: code,
      linkCodeExpiry: expiry,
      message: "Enter this code at https://tak.gov/register-device within 3 minutes.",
    };
  }

  const hasValidCode = takGovLink.linkCode && takGovLink.linkCodeExpiry && Date.now() < takGovLink.linkCodeExpiry;
  return {
    linked: !!takGovLink.linked,
    linkCode: hasValidCode ? takGovLink.linkCode : null,
    linkCodeExpiry: takGovLink.linkCodeExpiry || null,
  };
}

/**
 * Submit the code that the user entered at tak.gov/register-device to mark account as linked.
 * In a full implementation this would verify with TAK.gov; for now we accept any non-empty code
 * and set linked = true (or we could require it to match our stored linkCode).
 * @param {string} code - code user entered at TAK.gov
 * @returns {{ success: boolean, message?: string }}
 */
function linkTakGovAccount(code) {
  const manifest = loadManifest();
  const { takGovLink } = manifest;
  const input = String(code || "").trim();
  if (!input) {
    return { success: false, message: "Link code is required." };
  }
  // Optional: require that the code matches our generated one and is not expired
  const matchesStored =
    takGovLink.linkCode &&
    takGovLink.linkCodeExpiry &&
    Date.now() < takGovLink.linkCodeExpiry &&
    input.toUpperCase() === String(takGovLink.linkCode).toUpperCase();
  if (!matchesStored) {
    return {
      success: false,
      message: "Invalid or expired code. Generate a new link code and enter it at https://tak.gov/register-device within 3 minutes, then click Link Account.",
    };
  }
  const updated = {
    ...takGovLink,
    linked: true,
    linkCode: null,
    linkCodeExpiry: null,
  };
  saveManifest({ ...manifest, takGovLink: updated });
  return { success: true, message: "TAK.gov account linked successfully." };
}

/**
 * Unlink TAK.gov (clears linked state only; does not remove downloaded plugins).
 */
function unlinkTakGovAccount() {
  const manifest = loadManifest();
  const updated = {
    ...manifest.takGovLink,
    linked: false,
    linkCode: null,
    linkCodeExpiry: null,
  };
  saveManifest({ ...manifest, takGovLink: updated });
  return { success: true };
}

/**
 * List all installed plugins (from manifest; verifies file still exists).
 */
function listPlugins() {
  const manifest = loadManifest();
  const result = [];
  for (const p of manifest.plugins) {
    const filePath = path.join(PLUGINS_DIR, p.filename || "");
    const exists = fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    result.push({
      ...p,
      exists,
      sizeBytes: exists ? fs.statSync(filePath).size : null,
    });
  }
  return result;
}

/**
 * Generate a unique id for a new plugin entry.
 */
function nextPluginId(plugins) {
  const ids = new Set((plugins || []).map((p) => p.id).filter(Boolean));
  let n = 1;
  while (ids.has("plugin-" + n)) n++;
  return "plugin-" + n;
}

/**
 * Add a plugin from a file path (e.g. after upload or download).
 * @param {string} sourceFilePath - path to the APK or plugin file
 * @param {{ name?: string, source?: string, atakFlavor?: string, atakVersion?: string }} meta
 * @returns {{ success: boolean, plugin?: object, error?: string }}
 */
function addPluginFromFile(sourceFilePath, meta = {}) {
  ensurePluginsDir();
  if (!fs.existsSync(sourceFilePath) || !fs.statSync(sourceFilePath).isFile()) {
    return { success: false, error: "File not found or not a file." };
  }
  const manifest = loadManifest();
  const baseName = path.basename(sourceFilePath);
  const ext = path.extname(baseName);
  const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const destFileName = safeName;
  const destPath = path.join(PLUGINS_DIR, destFileName);

  // If same filename exists, remove old file and manifest entry
  const existing = manifest.plugins.find((p) => p.filename === destFileName);
  if (existing) {
    try {
      const oldPath = path.join(PLUGINS_DIR, existing.filename);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    } catch (_) {}
    manifest.plugins = manifest.plugins.filter((p) => p.id !== existing.id);
  }

  try {
    fs.copyFileSync(sourceFilePath, destPath);
  } catch (err) {
    return { success: false, error: err?.message || "Failed to copy file." };
  }

  const stat = fs.statSync(destPath);
  const id = nextPluginId(manifest.plugins);
  const plugin = {
    id,
    name: meta.name || path.basename(destFileName, ext) || destFileName,
    filename: destFileName,
    size: stat.size,
    downloadedAt: new Date().toISOString(),
    source: meta.source || "upload",
    atakFlavor: meta.atakFlavor || null,
    atakVersion: meta.atakVersion || null,
  };
  manifest.plugins.push(plugin);
  saveManifest(manifest);
  return { success: true, plugin };
}

/**
 * Add a plugin from a URL (download and store).
 * @param {string} downloadUrl - URL to the plugin file (e.g. from TAK.gov or direct link)
 * @param {{ name?: string, source?: string, atakFlavor?: string, atakVersion?: string }} meta
 * @returns {Promise<{ success: boolean, plugin?: object, error?: string }>}
 */
async function addPluginFromUrl(downloadUrl, meta = {}) {
  const axios = require("axios");
  const manifest = loadManifest();
  ensurePluginsDir();

  let response;
  try {
    response = await axios.get(downloadUrl, {
      responseType: "arraybuffer",
      timeout: 120000,
      maxContentLength: 500 * 1024 * 1024, // 500 MB
      validateStatus: (status) => status === 200,
    });
  } catch (err) {
    const msg = err?.response?.status
      ? `HTTP ${err.response.status}`
      : err?.message || "Download failed.";
    return { success: false, error: msg };
  }

  const buffer = Buffer.from(response.data);
  const contentType = response.headers["content-type"] || "";
  const contentDisp = response.headers["content-disposition"] || "";
  let baseName = "plugin.apk";
  const match = contentDisp.match(/filename[*]?=(?:UTF-8'')?["']?([^"'\s;]+)/i) || [];
  if (match[1]) baseName = match[1].trim();
  else if (contentType.includes("octet-stream") || downloadUrl) {
    try {
      const u = new URL(downloadUrl);
      const pathname = u.pathname || "";
      const seg = pathname.split("/").filter(Boolean).pop();
      if (seg && /\.(apk|zip|jar)$/i.test(seg)) baseName = seg;
    } catch (_) {}
  }
  const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, "_") || "plugin.apk";
  const destPath = path.join(PLUGINS_DIR, safeName);

  const existing = manifest.plugins.find((p) => p.filename === safeName);
  if (existing) {
    try {
      const oldPath = path.join(PLUGINS_DIR, existing.filename);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    } catch (_) {}
    manifest.plugins = manifest.plugins.filter((p) => p.id !== existing.id);
  }

  try {
    fs.writeFileSync(destPath, buffer);
  } catch (err) {
    return { success: false, error: err?.message || "Failed to write file." };
  }

  const stat = fs.statSync(destPath);
  const id = nextPluginId(manifest.plugins);
  const plugin = {
    id,
    name: meta.name || path.basename(safeName, path.extname(safeName)) || safeName,
    filename: safeName,
    size: stat.size,
    downloadedAt: new Date().toISOString(),
    source: meta.source || "tak.gov",
    atakFlavor: meta.atakFlavor || null,
    atakVersion: meta.atakVersion || null,
  };
  manifest.plugins.push(plugin);
  saveManifest(manifest);
  return { success: true, plugin };
}

/**
 * Delete a plugin by id: remove from manifest and delete file.
 * @param {string} id - plugin id from manifest
 * @returns {{ success: boolean, error?: string }}
 */
function deletePlugin(id) {
  const manifest = loadManifest();
  const plugin = manifest.plugins.find((p) => p.id === id);
  if (!plugin) {
    return { success: false, error: "Plugin not found." };
  }
  const filePath = path.join(PLUGINS_DIR, plugin.filename);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.warn("[plugins.service] Failed to delete file:", filePath, err?.message || err);
  }
  manifest.plugins = manifest.plugins.filter((p) => p.id !== id);
  saveManifest(manifest);
  return { success: true };
}

/**
 * Get absolute path to a plugin file by id (for streaming/serve).
 */
function getPluginFilePath(id) {
  const manifest = loadManifest();
  const plugin = manifest.plugins.find((p) => p.id === id);
  if (!plugin) return null;
  const filePath = path.join(PLUGINS_DIR, plugin.filename);
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? filePath : null;
}

module.exports = {
  PLUGINS_DIR,
  MANIFEST_PATH,
  ensurePluginsDir,
  getTakGovLinkState,
  linkTakGovAccount,
  unlinkTakGovAccount,
  listPlugins,
  addPluginFromFile,
  addPluginFromUrl,
  deletePlugin,
  getPluginFilePath,
};
