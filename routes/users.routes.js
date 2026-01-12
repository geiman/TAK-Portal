const router = require("express").Router();
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const users = require("../services/users.service");
const groupsSvc = require("../services/groups.service");
const accessSvc = require("../services/access.service");
const qrSvc = require("../services/qr.service");
const tokensSvc = require("../services/authentikTokens.service");

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
    const groups = accessSvc.filterGroupsForUser(authUser, allGroups);

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

    res.json({
      groups,
      templates,
    });
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

    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);

    // Global admins use the original Authentik-backed pagination unchanged.
    if (access.isGlobalAdmin) {
      const result = await users.searchUsersPaged({
        q,
        page: requestedPage,
        pageSize,
      });
      return res.json(result);
    }

    
// ---------------- Non-global admins ----------------
// For an agency admin (non-global), avoid pulling the entire Authentik user list.
// Instead, filter server-side in Authentik using the user's `attributes.agency_abbreviation`.
//
// NOTE: If the current user appears to administer multiple agencies (multiple allowed suffixes),
// we fall back to the legacy suffix-based filtering to avoid accidentally hiding valid results.
const allowedSuffixes = Array.isArray(access.allowedAgencySuffixes)
  ? access.allowedAgencySuffixes.filter(Boolean)
  : [];

const canUseAttributeFilter =
  authUser &&
  authUser.uid &&
  allowedSuffixes.length === 1; // typical "single-agency admin" case

if (canUseAttributeFilter) {
  let agencyAbbr = "";
  try {
    const me = await users.getUserById(authUser.uid);
    agencyAbbr = String(me?.attributes?.agency_abbreviation || "").trim();
  } catch (e) {
    agencyAbbr = "";
  }

  if (agencyAbbr) {
    const result = await users.searchUsersByAgencyAbbreviationPaged({
      agencyAbbreviation: agencyAbbr,
      q,
      page: requestedPage,
      pageSize,
    });
    return res.json(result);
  }
}

// ---------------- Legacy fallback (suffix-based) ----------------
// Deterministic in-memory paging over the fully filtered set.
const currentPageRequested = requestedPage < 1 ? 1 : requestedPage;

// 1) Get all matching users (path + hidden-prefix filters already applied inside findUsers)
const allMatching = await users.findUsers({ q, forceRefresh: false });

// 2) Filter to only the users in allowed agencies for this authUser
const visible = allMatching.filter((u) =>
  accessSvc.isUsernameInAllowedAgencies(authUser, u.username)
);

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
    await users.resetPassword(req.params.userId, req.body?.password);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.put("/:userId/email", async (req, res) => {
  try {
    await users.updateEmail(req.params.userId, req.body?.email);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// NEW: update name
router.put("/:userId/name", async (req, res) => {
  try {
    await users.updateName(req.params.userId, req.body?.name);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// Overwrite groups
router.put("/:userId/groups", async (req, res) => {
  try {
    const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];
    await users.setUserGroups(req.params.userId, groupIds);
    res.json({ success: true, groups: groupIds });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.post("/:userId/groups", async (req, res) => {
  try {
    const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];
    await users.setUserGroups(req.params.userId, groupIds);
    res.json({ success: true, groups: groupIds });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// Add groups
router.post("/:userId/groups/add", async (req, res) => {
  try {
    const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];
    const out = await users.addUserGroups(req.params.userId, groupIds);
    res.json({ success: true, groups: out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// Remove groups
router.post("/:userId/groups/remove", async (req, res) => {
  try {
    const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];
    const out = await users.removeUserGroups(req.params.userId, groupIds);
    res.json({ success: true, groups: out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.put("/:userId/active", async (req, res) => {
  try {
    const isActive = !!req.body?.is_active;
    await users.toggleUserActive(req.params.userId, isActive);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.delete("/:userId", async (req, res) => {
  try {
    await users.deleteUser(req.params.userId);
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
