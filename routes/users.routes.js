const router = require("express").Router();
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const users = require("../services/users.service");
const groupsSvc = require("../services/groups.service");
const accessSvc = require("../services/access.service");
const userRequestsSvc = require("../services/userRequests.service");
const qrSvc = require("../services/qr.service");
const tokensSvc = require("../services/authentikTokens.service");
const { getString } = require("../services/env");
const auditSvc = require("../services/auditLog.service");

// Cache resolved Global Admin group PKs (from PORTAL_AUTH_REQUIRED_GROUP)
// so we can cheaply hide global-admin users from agency-admin views.
// Keep TTL short so changes in settings take effect quickly.
const GLOBAL_ADMIN_GROUP_CACHE_TTL_MS = 5 * 60 * 1000;
let _globalAdminGroupPkCache = {
  key: "",
  loadedAt: 0,
  pks: [],
};

function parseGroupList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((g) => String(g || "").trim().toLowerCase())
    .filter(Boolean);
}

async function getGlobalAdminGroupPks() {
  const raw = String(getString("PORTAL_AUTH_REQUIRED_GROUP", "").trim());
  const namesLower = parseGroupList(raw);
  const key = namesLower.join(",");

  if (!namesLower.length) return [];

  const now = Date.now();
  if (
    _globalAdminGroupPkCache.key === key &&
    now - _globalAdminGroupPkCache.loadedAt < GLOBAL_ADMIN_GROUP_CACHE_TTL_MS
  ) {
    return _globalAdminGroupPkCache.pks.slice();
  }

  // Resolve group names -> PKs (including hidden groups).
  const allGroups = await groupsSvc.getAllGroups({ includeHidden: true });
  const byNameLower = new Map(
    (Array.isArray(allGroups) ? allGroups : []).map((g) => [
      String(g?.name || "").trim().toLowerCase(),
      String(g?.pk),
    ])
  );

  const pks = [];
  for (const nm of namesLower) {
    const pk = byNameLower.get(nm);
    if (pk) pks.push(String(pk));
  }

  _globalAdminGroupPkCache = { key, loadedAt: now, pks };
  return pks.slice();
}

// -------------------- CSV import progress (in-memory) --------------------
// Lightweight job store for progress reporting.
// Polling this does NOT tax the system (just reads memory).
const importJobs = new Map();

function newJobId() {
  // Simple unique ID: time + random
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Small helper to keep error responses consistent and safe
function toErrorPayload(err) {
  const data = err?.response?.data;
  if (data) {
    if (typeof data === "string") return data;
    try {
      return JSON.stringify(data);
    } catch (_) {
      return "Unknown error";
    }
  }
  return err?.message || "Unknown error";
}

router.get("/meta", async (req, res) => {
  try {
    const agencySuffix = req.query.agencySuffix || "";
    const authUser = req.authentikUser || null;

    if (agencySuffix && !accessSvc.isSuffixAllowed(authUser, agencySuffix)) {
      return res.status(403).json({ error: "You do not have access to that agency." });
    }

    const dynamic = users.getTemplatesForAgency(agencySuffix);
    const allGroups = await groupsSvc.getAllGroups({});
    let groups = accessSvc.filterGroupsForUser(authUser, allGroups);

    const templates = [
      // index 0 = Manual, as the EJS expects
      {
        key: "manual",
        label: "Manual Group Selection",
        groups: [],
      },
      ...dynamic.map((t, idx) => ({
        // pick something stable/unique for key; name is fine if unique per agency
        key: t.name || `tpl-${idx}`,
        label: t.name || `Template ${idx + 1}`,
        agencySuffix: t.agencySuffix,
        groups: t.groups,
        isDefault: t.isDefault,
      })),
    ];
    groups.sort((a, b) => {
      const an = String(a?.name || "").toLowerCase();
      const bn = String(b?.name || "").toLowerCase();
      return an.localeCompare(bn, undefined, { numeric: true, sensitivity: "base" });
    });

    // Apply hidden prefix filtering (final pass)
    const hiddenRaw = String(getString("GROUPS_HIDDEN_PREFIXES", "") || "");
    const hiddenPrefixes = hiddenRaw
      .split(",")
      .map(p => String(p || "").trim().toLowerCase())
      .filter(Boolean);

    if (hiddenPrefixes.length) {
      groups = groups.filter(g => {
        const raw = String(g?.name || "").trim().toLowerCase();
        const withoutTak = raw.startsWith("tak_") ? raw.slice(4) : raw;

        return !hiddenPrefixes.some(prefix =>
          raw.startsWith(prefix) || withoutTak.startsWith(prefix)
        );
      });
    }

    res.json({
      groups,
      templates,
    });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

// Lookup a group by exact name, INCLUDING groups hidden from the portal UI.
// Used for permission toggles like: authentik-<Agency Abbreviation>-AgencyAdmin
router.get("/group-lookup", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);

    const name = String(req.query.name || "").trim();
    if (!name) {
      return res.status(400).json({ error: "Group name is required" });
    }

    // Global admins can resolve any group name (including hidden).
    // Agency admins may ONLY resolve their own computed AgencyAdmin group(s)
    // so the Manage Users UI can:
    //  - show the friendly group name in "Current Groups"
    //  - compute the Role column (User/Admin)
    // without exposing arbitrary hidden groups.
    if (!access.isGlobalAdmin) {
      const prefixes = accessSvc.getAgencyAndCountyPrefixesForUser(authUser).agencyPrefixes;
      const allowedPrefixes = Array.isArray(prefixes)
        ? prefixes.map(p => String(p || "").trim().toUpperCase()).filter(Boolean)
        : [];

      const target = name.toLowerCase();
      const allowedNames = new Set(
        allowedPrefixes.map(abbr => `authentik-${abbr}-agencyadmin`.toLowerCase())
      );

      if (!allowedNames.has(target)) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    // Bypass GROUPS_HIDDEN_PREFIXES by requesting all groups (including hidden).
    // groups.service.getAllGroups supports includeHidden=true.
    const allGroups = await groupsSvc.getAllGroups({ includeHidden: true });
    const target = name.toLowerCase();
    const found = (Array.isArray(allGroups) ? allGroups : []).find(
      (g) => String(g?.name || "").trim().toLowerCase() === target
    );

    if (!found) {
      return res.status(404).json({ error: "Group not found" });
    }

    res.json({ pk: found.pk, name: found.name });
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});


router.get("/groups", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const all = await groupsSvc.getAllGroups({});
    const filtered = accessSvc.filterGroupsForUser(authUser, all);
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

router.post("/", async (req, res) => {
  try {
    const payload = req.body || {};
    const authUser = req.authentikUser || null;

    if (payload.agencySuffix && !accessSvc.isSuffixAllowed(authUser, payload.agencySuffix)) {
      return res.status(403).json({ error: "You do not have access to that agency." });
    }

    const createdBy = authUser
      ? {
          username: authUser.username,
          displayName: authUser.displayName || authUser.username,
        }
      : null;

    const result = await users.createUser(payload, {
      createdBy,
      creationMethod: "manual",
    });

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "CREATE_USER",
      targetType: "user",
      targetId: String(result?.user?.pk || ""),
      details: {
        username: result?.user?.username,
        email: result?.user?.email,
        name: result?.user?.name,
        groups: Array.isArray(result?.groups)
          ? result.groups.map((g) => g?.name).filter(Boolean)
          : [],
        created_method: "manual",
      },
    });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.post("/import-csv", upload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No CSV file uploaded" });
    }

    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    const allowedAgencySuffixes = access.isGlobalAdmin ? null : (access.allowedAgencySuffixes || []);

    const createdBy = authUser
      ? {
          username: authUser.username,
          displayName: authUser.displayName || authUser.username,
        }
      : null;

    const startedAt = Date.now();
    const result = await users.importUsersFromCsvBuffer(req.file.buffer, {
      allowedAgencySuffixes,
      createdBy,
      creationMethod: "csv",
    });
    const durationMs = Date.now() - startedAt;

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "IMPORT_USERS_CSV",
      targetType: "user",
      targetId: "bulk",
      details: {
        created: Array.isArray(result?.created) ? result.created.length : result?.created || 0,
        skipped: Array.isArray(result?.skipped) ? result.skipped.length : result?.skipped || 0,
        durationMs,
      },
    });

    res.json({
      success: true,
      ...result,
      durationMs,
      durationSeconds: Math.round((durationMs / 1000) * 10) / 10,
    });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// NEW: start an async CSV import job (progress via polling)
router.post("/import-csv/start", upload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No CSV file uploaded" });
    }

    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    const allowedAgencySuffixes = access.isGlobalAdmin ? null : (access.allowedAgencySuffixes || []);

    const createdBy = authUser
      ? {
          username: authUser.username,
          displayName: authUser.displayName || authUser.username,
        }
      : null;

    const jobId = newJobId();
    const startedAt = Date.now();

    // Initialize job state
    importJobs.set(jobId, {
      jobId,
      status: "running", // running | done | failed
      phase: "queued",   // queued | parsing | validating | creating | done
      total: 0,
      processed: 0,
      created: 0,
      skipped: 0,
      startedAt,
      finishedAt: null,
      durationMs: null,
      durationSeconds: null,
      error: null,
      result: null,
    });

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "IMPORT_USERS_CSV_STARTED",
      targetType: "user",
      targetId: "bulk",
      details: { jobId },
    });

    // Kick off the import without blocking the HTTP response
    (async () => {
      try {
        const result = await users.importUsersFromCsvBuffer(req.file.buffer, {
          allowedAgencySuffixes,
          createdBy,
          creationMethod: "csv",
          onProgress: (p) => {
            const job = importJobs.get(jobId);
            if (!job || job.status !== "running") return;
            job.phase = String(p?.phase || job.phase);
            if (Number.isFinite(Number(p?.total))) job.total = Number(p.total);
            if (Number.isFinite(Number(p?.processed))) job.processed = Number(p.processed);
            if (Number.isFinite(Number(p?.created))) job.created = Number(p.created);
            if (Number.isFinite(Number(p?.skipped))) job.skipped = Number(p.skipped);
          }
        });

        const finishedAt = Date.now();
        const durationMs = finishedAt - startedAt;
        const job = importJobs.get(jobId);
        if (job) {
          job.status = "done";
          job.phase = "done";
          job.finishedAt = finishedAt;
          job.durationMs = durationMs;
          job.durationSeconds = Math.round((durationMs / 1000) * 10) / 10;
          job.result = result;
          job.total = job.total || Number(result?.created?.length || 0) + Number(result?.skipped?.length || 0);
          job.processed = job.total;
          job.created = Number(result?.created?.length || 0);
          job.skipped = Number(result?.skipped?.length || 0);

          const usernamesCreated = (result && result.created) ? result.created.map((c) => c.username).filter(Boolean) : [];
          const createdDetails = (result && result.created) ? result.created.map((c) => ({ username: c.username, templateName: c.templateName || "" })) : [];
          const templatesUsed = [...new Set(createdDetails.map((d) => d.templateName).filter(Boolean))];
          const skippedUsernames = (result && result.skipped) ? result.skipped.map((s) => s.username).filter(Boolean) : [];
          const firstUsername = usernamesCreated[0] || null;
          const bulkAgency = firstUsername ? auditSvc.inferAgencyFromUsername(firstUsername) : null;

          auditSvc.logEvent({
            actor: authUser,
            request: { method: "JOB", path: "/api/users/import-csv/start", ip: req.ip },
            action: "IMPORT_USERS_CSV_COMPLETED",
            targetType: "user",
            targetId: "bulk",
            agencySuffix: bulkAgency?.agencySuffix || undefined,
            agencyName: bulkAgency?.agencyName || undefined,
            details: {
              jobId,
              created: job.created,
              skipped: job.skipped,
              durationMs,
              usernamesCreated,
              createdDetails,
              templatesUsed,
              skippedUsernames,
            },
          });
        }
      } catch (e) {
        const finishedAt = Date.now();
        const durationMs = finishedAt - startedAt;
        const job = importJobs.get(jobId);
        if (job) {
          job.status = "failed";
          job.phase = "failed";
          job.finishedAt = finishedAt;
          job.durationMs = durationMs;
          job.durationSeconds = Math.round((durationMs / 1000) * 10) / 10;
          job.error = toErrorPayload(e);
        }

        auditSvc.logEvent({
          actor: authUser,
          request: { method: "JOB", path: "/api/users/import-csv/start", ip: req.ip },
          action: "IMPORT_USERS_CSV_FAILED",
          targetType: "user",
          targetId: "bulk",
          details: { jobId, error: toErrorPayload(e) },
        });
      }
    })();

    // Auto-clean this job after 1 hour to avoid unbounded memory usage
    setTimeout(() => {
      importJobs.delete(jobId);
    }, 60 * 60 * 1000).unref?.();

    res.json({ success: true, jobId });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// NEW: poll an import job's progress
router.get("/import-csv/status/:jobId", (req, res) => {
  const jobId = String(req.params.jobId || "");
  const job = importJobs.get(jobId);
  if (!job) return res.status(404).json({ error: "Import job not found" });

  // Return a safe subset
  res.json({
    success: true,
    jobId: job.jobId,
    status: job.status,
    phase: job.phase,
    total: job.total,
    processed: job.processed,
    created: job.created,
    skipped: job.skipped,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
    durationSeconds: job.durationSeconds,
    error: job.error,
    result: job.result,
  });
});

/**
 * FIXED: /search
 *
 * - Global admins: unchanged (still use users.searchUsersPaged -> Authentik pagination).
 * - Non-global (agency) admins: deterministic in-memory paging over the
 *   fully filtered set using users.findUsers + accessSvc.isUsernameInAllowedAgencies.
 *
 * This ensures:
 *   - total is exact for what the agency admin can see
 *   - there are no blank pages beyond the last page with data
 *   - hasNext / hasPrev are accurate
 */
router.get("/search", async (req, res) => {
  try {
    const q = req.query.q || "";
    const requestedPage = parseInt(req.query.page, 10) || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || 50;

    const sortKey = String(req.query.sortKey || "name");
    const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc"
      ? "desc"
      : "asc";

    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);
    // ----- ROLE + SORT HELPERS (single groups fetch for both) -----
    const allGroups = await groupsSvc.getAllGroups({ includeHidden: true });
    const groupList = Array.isArray(allGroups) ? allGroups : [];
    const groupNameByPk = new Map(
      groupList.map(g => [String(g.pk), String(g.name || "").toLowerCase()])
    );
    const namesLower = parseGroupList(getString("PORTAL_AUTH_REQUIRED_GROUP", "").trim());
    const byNameLower = new Map(
      groupList.map((g) => [String(g?.name || "").trim().toLowerCase(), String(g?.pk)])
    );
    const globalAdminGroupPks = namesLower.map((nm) => byNameLower.get(nm)).filter(Boolean);
    const globalAdminSet = new Set(globalAdminGroupPks.map(String));

    function computeRole(user) {
      const groups = Array.isArray(user?.groups)
        ? user.groups.map(String)
        : [];

      if (groups.some(g => globalAdminSet.has(g))) {
        return "0-global";
      }

      for (const gid of groups) {
        const name = groupNameByPk.get(gid);
        if (name && name.endsWith("-agencyadmin")) {
          return "1-agency";
        }
      }

      return "2-user";
    }

    function getAgencyAbbr(user) {
      const attrs = user?.attributes || {};
      const raw = attrs.agency_abbreviation || attrs.agencyAbbreviation || attrs.agencyAbbr || attrs.agencyabbr || "";
      return String(raw || "").trim().toLowerCase();
    }

    function getSortValue(user) {
      if (!user) return "";

      if (sortKey === "username") return String(user.username || "").toLowerCase();
      if (sortKey === "agency") return getAgencyAbbr(user);
      if (sortKey === "name") return String(user.name || "").toLowerCase();
      if (sortKey === "email") return String(user.email || "").toLowerCase();
      if (sortKey === "status") return user.is_active ? "enabled" : "disabled";
      if (sortKey === "role") return computeRole(user) + "-" + String(user.name || "").toLowerCase();

      return String(user.name || "").toLowerCase();
    }

    function applySort(arr) {
      arr.sort((a, b) => {
        const av = getSortValue(a);
        const bv = getSortValue(b);

        let cmp = String(av).localeCompare(String(bv), undefined, {
          numeric: true,
          sensitivity: "base"
        });

        // When sorting by agency, tiebreak by name (not username)
        if (cmp === 0 && sortKey === "agency") {
          const aName = String(a?.name || "").toLowerCase();
          const bName = String(b?.name || "").toLowerCase();
          cmp = aName.localeCompare(bName, undefined, { numeric: true, sensitivity: "base" });
        }

        return sortDir === "desc" ? -cmp : cmp;
      });
    }


    // ---------------- GLOBAL ADMINS ----------------
    if (access.isGlobalAdmin) {

      const currentPageRequested = requestedPage < 1 ? 1 : requestedPage;

      // Get ALL matching users (not paged)
      const allMatching = await users.findUsers({ q, forceRefresh: false });

      const visible = Array.isArray(allMatching) ? allMatching.slice() : [];

      // Sort entire dataset BEFORE pagination
      applySort(visible);

      const total = visible.length;

      if (total === 0) {
        return res.json({
          users: [],
          total: 0,
          page: 1,
          pageSize,
          hasNext: false,
          hasPrev: false,
        });
      }

      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(currentPageRequested, totalPages);

      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      const pageItems = visible.slice(start, end);

      return res.json({
        users: pageItems,
        total,
        page,
        pageSize,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      });
    }

    // ---------------- AGENCY ADMINS ----------------

    const currentPageRequested = requestedPage < 1 ? 1 : requestedPage;

    const allMatching = await users.findUsers({ q, forceRefresh: false });

    let visible = allMatching.filter((u) =>
      accessSvc.isUsernameInAllowedAgencies(authUser, u.username)
    );

    if (access.isAgencyAdmin && globalAdminSet.size) {
      visible = visible.filter((u) => {
        const gs = Array.isArray(u?.groups) ? u.groups.map(String) : [];
        return !gs.some((gid) => globalAdminSet.has(gid));
      });
    }

    applySort(visible);

    const total = visible.length;

    if (total === 0) {
      return res.json({
        users: [],
        total: 0,
        page: 1,
        pageSize,
        hasNext: false,
        hasPrev: false,
      });
    }

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(currentPageRequested, totalPages);

    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const pageItems = visible.slice(start, end);

    return res.json({
      users: pageItems,
      total,
      page,
      pageSize,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    });

  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

router.post("/:userId/reset-password", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    await users.resetPassword(req.params.userId, req.body?.password);
    const user = await users.getUserById(req.params.userId).catch(() => null);

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "RESET_USER_PASSWORD",
      targetType: "user",
      targetId: String(req.params.userId),
      details: { username: user?.username ?? null },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.post("/:userId/resend-onboarding", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;

    const result = await users.resendOnboardingEmail(req.params.userId);

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "RESEND_ONBOARDING_EMAIL",
      targetType: "user",
      targetId: String(req.params.userId),
      details: {
        username: result?.username || null,
        email: result?.email || null
      },
    });

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.put("/:userId/email", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    await users.updateEmail(req.params.userId, req.body?.email);
    const user = await users.getUserById(req.params.userId).catch(() => null);

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "UPDATE_USER_EMAIL",
      targetType: "user",
      targetId: String(req.params.userId),
      details: { username: user?.username ?? null, email: user?.email ?? null },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// NEW: update name
router.put("/:userId/name", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    await users.updateName(req.params.userId, req.body?.name);
    const user = await users.getUserById(req.params.userId).catch(() => null);
    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "UPDATE_USER_NAME",
      targetType: "user",
      targetId: String(req.params.userId),
      details: { username: user?.username ?? null, name: user?.name ?? null },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// Overwrite groups
router.put("/:userId/groups", async (req, res) => {
  try {
    const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];
    const authUser = req.authentikUser || null;
    await users.setUserGroups(req.params.userId, groupIds);
    const user = await users.getUserById(req.params.userId).catch(() => null);

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "SET_USER_GROUPS",
      targetType: "user",
      targetId: String(req.params.userId),
      details: {
        username: user?.username ?? null,
        groups: groupIds,
      },
    });
    res.json({ success: true, groups: groupIds });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.post("/:userId/groups", async (req, res) => {
  try {
    const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];
    const authUser = req.authentikUser || null;
    await users.setUserGroups(req.params.userId, groupIds);
    const user = await users.getUserById(req.params.userId).catch(() => null);
    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "SET_USER_GROUPS",
      targetType: "user",
      targetId: String(req.params.userId),
      details: {
        username: user?.username ?? null,
        groups: groupIds,
      },
    });
    res.json({ success: true, groups: groupIds });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// Add groups
router.post("/:userId/groups/add", async (req, res) => {
  try {
    const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];
    const authUser = req.authentikUser || null;
    const out = await users.addUserGroups(req.params.userId, groupIds);
    const user = await users.getUserById(req.params.userId).catch(() => null);

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "ADD_USER_GROUPS",
      targetType: "user",
      targetId: String(req.params.userId),
      details: {
        username: user?.username ?? null,
        groups: Array.isArray(out) ? out : groupIds,
      },
    });
    res.json({ success: true, groups: out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// Remove groups
router.post("/:userId/groups/remove", async (req, res) => {
  try {
    const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];
    const authUser = req.authentikUser || null;
    const out = await users.removeUserGroups(req.params.userId, groupIds);
    const user = await users.getUserById(req.params.userId).catch(() => null);

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "REMOVE_USER_GROUPS",
      targetType: "user",
      targetId: String(req.params.userId),
      details: {
        username: user?.username ?? null,
        groups: Array.isArray(out) ? out : groupIds,
      },
    });
    res.json({ success: true, groups: out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.put("/:userId/active", async (req, res) => {
  try {
    const isActive = !!req.body?.is_active;
    const authUser = req.authentikUser || null;
    await users.toggleUserActive(req.params.userId, isActive);
    const user = await users.getUserById(req.params.userId).catch(() => null);

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "SET_USER_ACTIVE",
      targetType: "user",
      targetId: String(req.params.userId),
      details: { username: user?.username ?? null, is_active: !!isActive },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.delete("/:userId", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;
    const before = await users.getUserById(req.params.userId).catch(() => null);
    await users.deleteUser(req.params.userId);

    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "DELETE_USER",
      targetType: "user",
      targetId: String(req.params.userId),
      details: { username: before?.username || null },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});


// Generate an enrollment QR for a specific user (admin-only)
router.post("/enroll-qr", async (req, res) => {
  try {
    const authUser = req.authentikUser || null;

    // Require an authenticated admin (global or agency admin)
    const access = accessSvc.getAgencyAccess(authUser);
    if (!authUser || (!access.isGlobalAdmin && !access.isAgencyAdmin)) {
      return res.status(403).json({ ok: false, error: "Admin access required" });
    }

    const userId = String(req.body?.userId || req.body?.pk || "").trim();
    const username = String(req.body?.username || "").trim();

    if (!userId || !username) {
      return res.status(400).json({ ok: false, error: "Missing userId or username" });
    }

    // Enforce agency-scoped admins can only generate for their allowed agencies
    if (!access.isGlobalAdmin && !accessSvc.isUsernameInAllowedAgencies(authUser, username)) {
      return res.status(403).json({ ok: false, error: "You do not have access to that user." });
    }

    const takUrl = qrSvc.getTakUrl();
    if (!takUrl) {
      return res.status(500).json({
        ok: false,
        error:
          "TAK_URL is not configured. Set it in Settings (TAK URL) or via the TAK_URL environment variable.",
      });
    }

    const { identifier, key, expiresAt } =
      await tokensSvc.getOrCreateEnrollmentAppPassword({
        username,
        userId,
      });

    const enrollUrl = qrSvc.buildEnrollUrl({ username, token: key });
    const qrCode = await qrSvc.generateDisplayQrDataUrl(enrollUrl);

    // Audit (never store token/key)
    auditSvc.logEvent({
      actor: authUser,
      request: { method: req.method, path: req.originalUrl || req.path, ip: req.ip },
      action: "GENERATE_ENROLLMENT_QR",
      targetType: "user",
      targetId: String(userId),
      details: { username, tokenIdentifier: identifier, expiresAt },
    });

    return res.json({
      ok: true,
      username,
      tokenIdentifier: identifier,
      token: key,
      expiresAt,
      enrollUrl,
      qrCode,
    });
  } catch (err) {
    console.error("[users] Failed to create enrollment QR:", err?.message || err);
    return res.status(500).json({
      ok: false,
      error:
        err?.response?.status
          ? `Authentik API error (HTTP ${err.response.status})`
          : (err?.message || "Failed to generate enrollment QR"),
    });
  }
});


module.exports = router;
