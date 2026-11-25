// services/apiTokens.service.js
//
// Portal API tokens for /api/v1 (scripts, local AI agents through the MCP
// server in tools/mcp-server). Tokens never act as global admins: a token acts
// as an agency admin for the agencies it is scoped to (or for all agencies via
// the all-agencies admin group), so the same agency checks the UI uses apply.
// Only a SHA-256 hash is stored; the plaintext token is returned once.

const crypto = require("crypto");
const db = require("./db");
const accessSvc = require("./access.service");
const agenciesStore = require("./agencies.service");

const TOKEN_PREFIX = "tpk_";
const MAX_NAME_LENGTH = 80;

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function generateToken() {
  const id = crypto.randomBytes(6).toString("hex");
  const secret = crypto.randomBytes(32).toString("base64url");
  const token = `${TOKEN_PREFIX}${id}_${secret}`;
  return { id, token, tokenPrefix: token.slice(0, TOKEN_PREFIX.length + id.length + 5) };
}

function looksLikeToken(value) {
  return /^tpk_[a-f0-9]{12}_[A-Za-z0-9_-]{40,}$/.test(String(value || ""));
}

/** Pull a portal token from `Authorization: Bearer ...` (or X-API-Key). */
function extractToken(req) {
  const auth = String(req.headers?.authorization || "").trim();
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (m) return m[1];
  const key = String(req.headers?.["x-api-key"] || "").trim();
  return key || "";
}

function normalizeSuffixList(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || "").split(",");
  return Array.from(
    new Set(list.map((s) => accessSvc.normalizeSuffix(s)).filter(Boolean))
  );
}

function rowToPublic(row) {
  if (!row) return null;
  const now = Date.now();
  const expired = row.expires_at ? new Date(row.expires_at).getTime() <= now : false;
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    allAgencies: !!row.all_agencies,
    agencySuffixes: Array.isArray(row.agency_suffixes) ? row.agency_suffixes : [],
    canCreateAgencies: !!row.can_create_agencies,
    canCreateMutualAid: !!row.can_create_mutual_aid,
    createdBy: row.created_by || null,
    createdAt: row.created_at || null,
    expiresAt: row.expires_at || null,
    lastUsedAt: row.last_used_at || null,
    lastUsedIp: row.last_used_ip || null,
    revokedAt: row.revoked_at || null,
    revokedBy: row.revoked_by || null,
    status: row.revoked_at ? "revoked" : expired ? "expired" : "active",
  };
}

/**
 * Validate create input. Returns normalized fields or throws (statusCode 400).
 */
function normalizeCreateInput(input = {}, agencies = agenciesStore.load()) {
  const bad = (msg) => {
    const e = new Error(msg);
    e.statusCode = 400;
    return e;
  };
  const name = String(input.name || "").trim();
  if (!name) throw bad("Token name is required.");
  if (name.length > MAX_NAME_LENGTH) throw bad(`Token name must be ${MAX_NAME_LENGTH} characters or fewer.`);

  const allAgencies = input.allAgencies === true || input.allAgencies === "true";
  let agencySuffixes = [];
  if (!allAgencies) {
    agencySuffixes = normalizeSuffixList(input.agencySuffixes);
    if (!agencySuffixes.length) throw bad("Choose at least one agency, or All agencies.");
    const known = new Set(agencies.map((a) => accessSvc.normalizeSuffix(a?.suffix)).filter(Boolean));
    const unknown = agencySuffixes.filter((s) => !known.has(s));
    if (unknown.length) throw bad(`Unknown agency: ${unknown.join(", ")}`);
  }

  const canCreateAgencies = input.canCreateAgencies === true || input.canCreateAgencies === "true";
  if (canCreateAgencies && !allAgencies) {
    throw bad("Only an All agencies token can create agencies.");
  }
  const canCreateMutualAid = input.canCreateMutualAid === true || input.canCreateMutualAid === "true";

  let expiresAt = null;
  const days = input.expiresInDays === "" || input.expiresInDays == null ? null : Number(input.expiresInDays);
  if (days !== null) {
    if (!Number.isFinite(days) || days < 1 || days > 3650) throw bad("Expiration must be 1 to 3650 days, or never.");
    expiresAt = new Date(Date.now() + Math.round(days) * 86400000).toISOString();
  }

  return { name, allAgencies, agencySuffixes, canCreateAgencies, canCreateMutualAid, expiresAt };
}

async function createToken(input, { createdBy = null } = {}) {
  const fields = normalizeCreateInput(input);
  const { id, token, tokenPrefix } = generateToken();
  const r = await db.query(
    `INSERT INTO api_tokens
       (id, name, token_hash, token_prefix, all_agencies, agency_suffixes,
        can_create_agencies, can_create_mutual_aid, created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      id,
      fields.name,
      hashToken(token),
      tokenPrefix,
      fields.allAgencies,
      fields.agencySuffixes,
      fields.canCreateAgencies,
      fields.canCreateMutualAid,
      createdBy,
      fields.expiresAt,
    ]
  );
  return { token, item: rowToPublic(r.rows[0]) };
}

async function listTokens() {
  const r = await db.query("SELECT * FROM api_tokens ORDER BY created_at DESC");
  return r.rows.map(rowToPublic);
}

async function revokeToken(id, { revokedBy = null } = {}) {
  const r = await db.query(
    `UPDATE api_tokens SET revoked_at = now(), revoked_by = $2
     WHERE id = $1 AND revoked_at IS NULL
     RETURNING *`,
    [String(id || ""), revokedBy]
  );
  return rowToPublic(r.rows[0]);
}

async function revokeAllTokens({ revokedBy = null } = {}) {
  const r = await db.query(
    `UPDATE api_tokens SET revoked_at = now(), revoked_by = $1
     WHERE revoked_at IS NULL RETURNING id`,
    [revokedBy]
  );
  return r.rowCount || 0;
}

/**
 * Look up an active token. Returns the DB row or null.
 */
async function findActiveToken(token) {
  if (!looksLikeToken(token)) return null;
  const r = await db.query(
    `SELECT * FROM api_tokens
     WHERE token_hash = $1
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())`,
    [hashToken(token)]
  );
  return r.rows[0] || null;
}

async function touchToken(id, ip) {
  try {
    await db.query(
      "UPDATE api_tokens SET last_used_at = now(), last_used_ip = $2 WHERE id = $1",
      [id, ip ? String(ip).slice(0, 64) : null]
    );
  } catch (_) {
    // Non-fatal.
  }
}

/**
 * Build the req.authentikUser equivalent for a token. The token is an agency
 * admin (never a global admin) for its agencies, expressed as agency-admin
 * group names so accessSvc computes scope exactly as it does for people.
 */
function buildAuthUserForToken(row, agencies = agenciesStore.load()) {
  let groups = [];
  if (row.all_agencies) {
    groups = [accessSvc.ALL_AGENCIES_ADMIN_GROUP_NAME];
  } else {
    const wanted = new Set(normalizeSuffixList(row.agency_suffixes));
    for (const a of agencies) {
      if (!wanted.has(accessSvc.normalizeSuffix(a?.suffix))) continue;
      groups.push(...accessSvc.getAllAgencyAdminGroupNames(a));
    }
  }
  const allowedAgencySuffixes = accessSvc.getAllowedAgencySuffixesForGroups(groups);
  return {
    username: `api-token:${row.id}`,
    uid: null,
    displayName: `${row.name} (API token)`,
    groups,
    isGlobalAdmin: false,
    // An All agencies token stays an agency admin even before any agency exists.
    isAgencyAdmin: !!row.all_agencies || allowedAgencySuffixes.length > 0,
    isBridgeMember: false,
    allowedAgencySuffixes,
    isApiToken: true,
    apiToken: rowToPublic(row),
  };
}

module.exports = {
  TOKEN_PREFIX,
  hashToken,
  generateToken,
  looksLikeToken,
  extractToken,
  normalizeCreateInput,
  createToken,
  listTokens,
  revokeToken,
  revokeAllTokens,
  findActiveToken,
  touchToken,
  buildAuthUserForToken,
  rowToPublic,
};
