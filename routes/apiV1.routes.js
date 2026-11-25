// routes/apiV1.routes.js
//
// Token-authenticated API for scripts and local AI agents (see
// docs/API-AND-MCP.md and tools/mcp-server). Mounted at /api/v1 behind
// services/apiTokenAuth.middleware.js.
//
// Guard rails (on top of the normal service checks such as duplicate email,
// agency active, password policy and agency scope):
// - tokens are never global admins; they act as agency admins for their scope
// - users created here are always regular users (no admin roles)
// - agency creation needs a token with "can create agencies"
// - mutual aid creation needs a token with "can create mutual aid"
// - every create has a matching validate endpoint that writes nothing
// - passwords are never returned

const express = require("express");
const router = express.Router();

const users = require("../services/users.service");
const accessSvc = require("../services/access.service");
const agenciesStore = require("../services/agencies.service");
const mutualAid = require("../services/mutualAid.service");
const auditSvc = require("../services/auditLog.service");
const auditDetails = require("../services/auditDetails.service");
const permsSvc = require("../services/permissions.service");
const { toSafeApiError } = require("../services/apiErrorPayload.service");
const agenciesRoutes = require("./agencies.routes");
const usersRoutes = require("./users.routes");

const MAX_BATCH = 200;

function errMessage(err) {
  try {
    const safe = toSafeApiError(err);
    if (typeof safe === "string") return safe;
    if (safe && typeof safe.message === "string") return safe.message;
  } catch (_) {
    /* fall through */
  }
  return String(err?.message || err || "Request failed");
}

function requestInfo(req) {
  return { method: req.method, path: req.originalUrl || req.path, ip: req.ip };
}

function requirePerm(permissionId, underlyingPath) {
  return (req, res, next) => {
    const eff = req.effectivePermissionSet;
    const ok = permissionId
      ? eff && permsSvc.can(eff, permissionId)
      : eff && permsSvc.canAccessPath(eff, underlyingPath, req.method);
    if (!ok) return res.status(403).json({ error: "This token is not allowed to do that." });
    return next();
  };
}

function requireTokenFlag(flag, message) {
  return (req, res, next) => {
    if (!req.authentikUser?.apiToken?.[flag]) {
      return res.status(403).json({ error: message });
    }
    return next();
  };
}

// ---------------------------------------------------------------------------
// Agency resolution: accept suffix, abbreviation (group prefix) or full name.
// ---------------------------------------------------------------------------
function resolveAgency(ref, agencies) {
  const key = String(ref || "").trim().toLowerCase();
  if (!key) return { error: "Agency is required." };
  const bySuffix = agencies.filter((a) => String(a?.suffix || "").trim().toLowerCase() === key);
  if (bySuffix.length === 1) return { agency: bySuffix[0] };
  const byPrefix = agencies.filter((a) => String(a?.groupPrefix || "").trim().toLowerCase() === key);
  if (byPrefix.length === 1) return { agency: byPrefix[0] };
  const byName = agencies.filter((a) => String(a?.name || "").trim().toLowerCase() === key);
  if (byName.length === 1) return { agency: byName[0] };
  if (bySuffix.length + byPrefix.length + byName.length > 1) {
    return { error: `Agency "${ref}" matches more than one agency; use its suffix.` };
  }
  return { error: `Agency "${ref}" not found.` };
}

function agencySummary(a) {
  return {
    name: a.name,
    suffix: a.suffix,
    abbreviation: a.groupPrefix || null,
    county: a.county || null,
    countyAbbrev: a.countyAbbrev || null,
    state: a.state || null,
    type: a.type || null,
    color: a.color || null,
    regionId: a.regionId || null,
    active: a.isActive !== false,
    usernameTokenPlacement: a.usernameTokenPlacement || "suffix",
  };
}

function templateSummaries(suffix) {
  return users.getTemplatesForAgency(suffix).map((t) => ({
    name: t.name,
    role: t.role,
    isDefault: !!t.isDefault,
    groups: t.groups,
  }));
}

// ---------------------------------------------------------------------------
// Users: normalize one LLM/script-provided row into a createUser payload.
// ---------------------------------------------------------------------------
function buildUserPayload(raw, authUser, agencies) {
  const r = raw && typeof raw === "object" ? raw : {};
  const agencyRef = r.agency ?? r.agencySuffix ?? r.agencyAbbreviation;
  const resolved = resolveAgency(agencyRef, agencies);
  if (resolved.error) return { error: resolved.error };
  const agency = resolved.agency;
  if (!accessSvc.isSuffixAllowed(authUser, agency.suffix)) {
    return { error: `This token does not have access to agency ${agency.name} (${agency.suffix}).` };
  }

  let template = String(r.template ?? r.templateName ?? "").trim();
  if (!template) {
    const tpls = users.getTemplatesForAgency(agency.suffix);
    const def = tpls.find((t) => t.isDefault) || (tpls.length === 1 ? tpls[0] : null);
    if (!def) {
      const names = tpls.map((t) => t.name).filter(Boolean);
      return {
        error: names.length
          ? `Template is required for ${agency.name}. Options: ${names.join(", ")}`
          : `Agency ${agency.name} has no templates; create one in the portal first.`,
      };
    }
    template = def.name;
  }
  if (template.toLowerCase() === "manual group selection") {
    return { error: "Manual group selection is not available through the API; use a template." };
  }

  const permissions = String(r.permissions || "user").trim().toLowerCase();
  if (permissions && permissions !== "user") {
    return { error: "The API only creates regular users. Grant admin roles in the portal." };
  }

  return {
    payload: {
      badge: r.badge ?? r.badgeNumber ?? r.username,
      agencySuffix: agency.suffix,
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      password: r.password,
      radioCallsign: r.radioCallsign,
      templateIndex: template,
      role: r.role,
      permissions: "user",
    },
  };
}

function rowsFromBody(body) {
  if (Array.isArray(body?.users)) return body.users;
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object" && Object.keys(body).length) return [body];
  return [];
}

function createdByFor(authUser) {
  return { username: authUser.username, displayName: authUser.displayName || authUser.username };
}

async function processUsers(req, res, { dryRun }) {
  const authUser = req.authentikUser;
  const rows = rowsFromBody(req.body);
  if (!rows.length) return res.status(400).json({ error: "Send { users: [ ... ] } with at least one user." });
  if (rows.length > MAX_BATCH) return res.status(400).json({ error: `At most ${MAX_BATCH} users per request.` });

  const agencies = agenciesStore.load();
  const seenUsernames = new Map();
  const seenEmails = new Map();
  const results = [];

  for (let i = 0; i < rows.length; i++) {
    const out = { index: i, ok: false };
    try {
      const built = buildUserPayload(rows[i], authUser, agencies);
      if (built.error) throw new Error(built.error);
      const payload = built.payload;

      // Always validate first so in-batch duplicates are caught before writes.
      const check = await users.createUser(payload, {
        dryRun: true,
        createdBy: createdByFor(authUser),
        creationMethod: "api",
        allowAllAgencies: false,
        allowedAgencySuffixesForAssign: authUser.allowedAgencySuffixes || [],
      });
      const uname = String(check.preview.username || "").toLowerCase();
      const mail = String(check.preview.email || "").toLowerCase();
      if (seenUsernames.has(uname)) {
        throw new Error(`Same username as row ${seenUsernames.get(uname)} in this request (${check.preview.username}).`);
      }
      if (mail && seenEmails.has(mail)) {
        throw new Error(`Same email as row ${seenEmails.get(mail)} in this request (${check.preview.email}).`);
      }
      seenUsernames.set(uname, i);
      if (mail) seenEmails.set(mail, i);

      if (dryRun) {
        Object.assign(out, { ok: true, username: check.preview.username, preview: check.preview, warnings: check.warnings });
      } else {
        const result = await users.createUser(payload, {
          createdBy: createdByFor(authUser),
          creationMethod: "api",
          // Like CSV import: for batches, queue the Authentik sync instead of
          // waiting up to 8s per user (keeps large batches inside proxy timeouts).
          bulk: rows.length > 1,
          allowAllAgencies: false,
          allowedAgencySuffixesForAssign: authUser.allowedAgencySuffixes || [],
        });
        auditSvc.logEvent({
          actor: authUser,
          request: requestInfo(req),
          action: "CREATE_USER",
          targetType: "user",
          targetId: String(result?.user?.pk || ""),
          details: {
            username: result?.user?.username,
            email: result?.user?.email,
            name: result?.user?.name,
            groups: Array.isArray(result?.groups) ? result.groups.map((g) => g?.name).filter(Boolean) : [],
            created_method: "api",
            api_token: authUser.apiToken?.name,
          },
        });
        Object.assign(out, {
          ok: true,
          username: result?.user?.username || check.preview.username,
          preview: check.preview,
          warnings: check.warnings,
          syncPending: rows.length > 1 ? true : !!result?.syncPending,
        });
      }
    } catch (err) {
      out.error = errMessage(err);
    }
    results.push(out);
  }

  const okCount = results.filter((r) => r.ok).length;
  return res.json({
    dryRun: !!dryRun,
    total: results.length,
    ok: okCount,
    failed: results.length - okCount,
    results,
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get("/me", (req, res) => {
  const u = req.authentikUser;
  const agencies = agenciesStore.load();
  const allowed = new Set(u.allowedAgencySuffixes || []);
  res.json({
    token: u.apiToken,
    actingAs: u.displayName,
    agencies: agencies
      .filter((a) => allowed.has(accessSvc.normalizeSuffix(a?.suffix)))
      .map((a) => ({ name: a.name, suffix: a.suffix, abbreviation: a.groupPrefix || null })),
    passwordPolicy: (() => {
      try {
        return require("../services/passwordPolicy.service").getViewModel(
          require("../services/settings.service").getSettings() || {}
        );
      } catch (_) {
        return null;
      }
    })(),
  });
});

// Agencies the token can see, with their user templates.
router.get("/agencies", (req, res) => {
  const visible = accessSvc.filterAgenciesForUser(req.authentikUser, agenciesStore.load());
  const includeTemplates = String(req.query.templates || "true").toLowerCase() !== "false";
  res.json(
    visible.map((a) => ({
      ...agencySummary(a),
      ...(includeTemplates ? { templates: templateSummaries(a.suffix) } : {}),
    }))
  );
});

router.get("/agencies/:ref/templates", (req, res) => {
  const resolved = resolveAgency(req.params.ref, agenciesStore.load());
  if (resolved.error) return res.status(404).json({ error: resolved.error });
  if (!accessSvc.isSuffixAllowed(req.authentikUser, resolved.agency.suffix)) {
    return res.status(403).json({ error: "This token does not have access to that agency." });
  }
  return res.json(templateSummaries(resolved.agency.suffix));
});

async function handleAgency(req, res, dryRun) {
  try {
    const result = await agenciesRoutes.createAgencyFromPayload(req.body || {}, {
      actor: req.authentikUser,
      request: requestInfo(req),
      dryRun,
    });
    if (dryRun) return res.json({ ok: true, dryRun: true, preview: result.preview });
    return res.json({ ok: true, dryRun: false, mainGroup: result.mainGroup || null });
  } catch (err) {
    return res.status(err.statusCode || 400).json({ ok: false, error: errMessage(err) });
  }
}

const canCreateAgencies = requireTokenFlag(
  "canCreateAgencies",
  "This token cannot create agencies. Create a token with Can create agencies."
);
router.post("/agencies/validate", canCreateAgencies, (req, res) => handleAgency(req, res, true));
router.post("/agencies", canCreateAgencies, (req, res) => handleAgency(req, res, false));

// Users
router.get("/users/search", requirePerm("page.users"), (req, res, next) => {
  // Reuse the Users page search (agency scoping included).
  req.url = "/search" + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");
  return usersRoutes(req, res, next);
});
router.post("/users/validate", requirePerm("page.users"), (req, res) => processUsers(req, res, { dryRun: true }));
router.post("/users", requirePerm("page.users"), (req, res) => processUsers(req, res, { dryRun: false }));

// Mutual aid
function stripSecrets(item) {
  if (!item || typeof item !== "object") return item;
  const { password, ...rest } = item;
  return rest;
}

router.get("/mutual-aid", requirePerm("page.mutual_aid"), async (req, res) => {
  try {
    const items = await mutualAid.listForUserWithCertStatus(req.authentikUser);
    return res.json((items || []).map(stripSecrets));
  } catch (err) {
    return res.status(500).json({ error: errMessage(err) });
  }
});

router.post(
  "/mutual-aid",
  requirePerm("page.mutual_aid"),
  requireTokenFlag("canCreateMutualAid", "This token cannot create mutual aid. Create a token with Can create mutual aid."),
  async (req, res) => {
    const authUser = req.authentikUser;
    try {
      const out = await mutualAid.create({
        type: req.body?.type,
        title: req.body?.title,
        expireEnabled: req.body?.expireEnabled,
        expireAt: req.body?.expireAt,
        groupMode: req.body?.groupMode,
        existingGroupId: req.body?.existingGroupId,
        password: req.body?.password,
        createdBy: mutualAid.buildCreatedByFromAuthUser(authUser),
        authUser,
      });
      auditSvc.logEvent({
        actor: authUser,
        request: requestInfo(req),
        action: "CREATE_MUTUAL_AID",
        targetType: "mutual_aid",
        targetId: String(out?.title || out?.id || ""),
        details: {
          summary: auditDetails.buildMutualAidSummary("CREATE_MUTUAL_AID", out),
          type: out?.type,
          title: out?.title,
          expireEnabled: !!out?.expireEnabled,
          expireAt: out?.expireAt || null,
          groupMode: out?.groupMode,
          groupName: out?.groupName,
          username: out?.username,
          passwordSource: out?.passwordSource || "generated",
          api_token: authUser.apiToken?.name,
        },
      });
      return res.json({ ok: true, item: stripSecrets(out) });
    } catch (err) {
      const status = Number(err?.status || err?.statusCode) || 400;
      return res.status(status).json({ ok: false, error: errMessage(err) });
    }
  }
);

router.use((req, res) => res.status(404).json({ error: "Unknown API endpoint." }));

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  res.status(500).json({ error: errMessage(err) });
});

module.exports = router;
module.exports._internal = { resolveAgency, buildUserPayload, rowsFromBody, stripSecrets };
