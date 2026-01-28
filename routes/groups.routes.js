const router = require("express").Router();
const groups = require("../services/groups.service");
const mutualAid = require("../services/mutualAid.service");
const agencies = require("../services/agencies.service");
const accessSvc = require("../services/access.service");
const usersService = require("../services/users.service");


function ensureTakPrefix(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  return n.toLowerCase().startsWith("tak_") ? n : `tak_${n}`;
}

function stripTakPrefix(name) {
  const n = String(name || "").trim();
  if (n.toLowerCase().startsWith("tak_")) return n.slice(4);
  return n;
}

function toErrorPayload(err) {
  const data = err?.response?.data;
  if (data) return typeof data === "string" ? data : data;
  return err?.message || "Unknown error";
}

router.get("/", async (req, res) => {
  try {
    const forceRefresh = req.query.forceRefresh === "true";
    const all = await groups.getAllGroups({ forceRefresh });
    const authUser = req.authentikUser || null;
    const filtered = accessSvc.filterGroupsForUser(authUser, all);
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: toErrorPayload(err) });
  }
});

router.post("/", async (req, res) => {
  try {
    const rawName = String(req.body?.name || "").trim();
    const name = ensureTakPrefix(rawName);
    const nameWithoutTak = stripTakPrefix(name);
    if (!rawName) {
      return res.status(400).json({ error: "Group name is required" });
    }

    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);

    // Private groups are a global-admin-only feature
    const hasPrivate = Object.prototype.hasOwnProperty.call(req.body || {}, "private");
    const privateStatus = hasPrivate
      ? String(req.body.private || "").trim().toLowerCase()
      : undefined;

    if (!access.isGlobalAdmin && hasPrivate) {
      return res.status(403).json({ error: "You do not have permission to set group privacy." });
    }

    if (!access.isGlobalAdmin) {
      const allowedSuffixes = access.allowedAgencySuffixes || [];
      if (!allowedSuffixes.length) {
        return res
          .status(403)
          .json({ error: "You do not have permission to create groups." });
      }

      const allAgencies = agencies.load();
      const allowedPrefixes = allAgencies
        .filter((a) =>
          allowedSuffixes.includes(
            String(a.suffix || "").trim().toLowerCase()
          )
        )
        .map((a) => String(a.groupPrefix || "").trim().toUpperCase())
        .filter(Boolean);

      const upperName = nameWithoutTak.toUpperCase();
      const canCreateForAny = allowedPrefixes.some((prefix) => {
        // Support both "CPD-GROUP" and "CPD - GROUP"
        return (
          upperName.startsWith(prefix + "-") ||
          upperName.startsWith(prefix + " -")
        );
      });

      if (!canCreateForAny) {
        return res.status(403).json({
          error:
            "You may only create agency-specific groups for your own agency.",
        });
      }
    }

    const description = String(req.body?.description || "").trim() || null;

    const rawGroupType = String(req.body?.groupType || "").trim();
    const groupType =
      rawGroupType === "Agency" || rawGroupType === "County" || rawGroupType === "Global"
        ? rawGroupType
        : "Global";

    const groupTypeDetail = String(req.body?.groupTypeDetail || "").trim() || null;

    const createdBy = authUser
      ? {
          username: authUser.username,
          displayName: authUser.displayName || authUser.username,
        }
      : null;

    const createdAt = new Date().toISOString();

    // Build attributes in deterministic order
// 1) created_at
// 2) description
// 3) created_type
// 4) created_type_detail
// 5) created_by_username
// 6) created_by_display_name

const attributes = {};

// 1) created_at
attributes.created_at = createdAt;

// 2) description (if provided)
if (description) {
  attributes.description = description;
}

// 2b) private (global admins only; default is "no")
if (access.isGlobalAdmin && hasPrivate) {
  attributes.private = privateStatus === "yes" ? "yes" : "no";
}

// 3) created_type
attributes.created_type = groupType;

// 4) created_type_detail
attributes.created_type_detail = groupTypeDetail || null;

// 5–6) created_by_*
if (createdBy) {
  attributes.created_by_username = createdBy.username;
  attributes.created_by_display_name = createdBy.displayName;
}

// Private flag (Global Admins only)
if (access.isGlobalAdmin && typeof privateStatus === "string" && privateStatus) {
  // Accept common truthy values; store as "yes"/"no" for consistency
  const truthy = privateStatus === "yes" || privateStatus === "true" || privateStatus === "1";
  attributes.private = truthy ? "yes" : "no";
}
attributes.cn = `CN: ${nameWithoutTak}`;

    const out = await groups.createGroup(name, { attributes });
    res.json({ success: true, group: out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

/**
 * Rename group
 * Expected body: { name: "NEW_GROUP_NAME" }
 */
router.patch("/:groupId", async (req, res) => {
  try {
    const rawName = String(req.body?.name || "").trim();
    const name = ensureTakPrefix(rawName);
    const nameWithoutTak = stripTakPrefix(name);
    if (!name) {
      return res.status(400).json({ error: "Group name is required" });
    }

    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);

    // Private groups are a global-admin-only feature
    const hasPrivate = Object.prototype.hasOwnProperty.call(req.body || {}, "private");
    const privateStatus = hasPrivate
      ? String(req.body.private || "").trim().toLowerCase()
      : undefined;

    if (!access.isGlobalAdmin && hasPrivate) {
      return res.status(403).json({ error: "You do not have permission to set group privacy." });
    }

    // Optional: description update
    const hasDescription = Object.prototype.hasOwnProperty.call(req.body || {}, "description");
    const description = hasDescription ? String(req.body.description || "").trim() : undefined;

    const out = await groups.renameGroup(req.params.groupId, name, {
      description,
      private: access.isGlobalAdmin ? privateStatus : undefined,
      cn: `CN: ${nameWithoutTak}`,
    });
    res.json({ success: true, group: out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// Impact preview before delete
router.get("/:groupId/impact", async (req, res) => {
  try {
    const out = await groups.getDeleteImpact(req.params.groupId);
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// Delete now cleans up users + templates
router.delete("/:groupId", async (req, res) => {
  try {
    const out = await groups.deleteGroupWithCleanup(req.params.groupId);
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

router.post("/mass-assign", async (req, res) => {
  try {
    const out = await groups.massAssignUsersToGroup({
      groupId: req.body?.groupId,
      suffixes: req.body?.suffixes,
      // allow multiple source groups (backwards compatible)
      sourceGroupIds: req.body?.sourceGroupIds ?? req.body?.sourceGroupId,
      userIds: req.body?.userIds,
    });
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// Mass unassign users from a group
router.post("/mass-unassign", async (req, res) => {
  try {
    const out = await groups.massUnassignUsersFromGroup({
      groupId: req.body?.groupId,
      suffixes: req.body?.suffixes,
      // allow multiple source groups (same semantics as mass-assign)
      sourceGroupIds: req.body?.sourceGroupIds ?? req.body?.sourceGroupId,
      userIds: req.body?.userIds,
    });
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

// Fetch members of a single group, plus related mutual-aid entries
router.get("/:groupId/members", async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const group = await groups.getGroupById(groupId);
    const authUser = req.authentikUser || null;
    const access = accessSvc.getAgencyAccess(authUser);

    // For agency admins, try to use their agency_abbreviation attribute
    // to allow Authentik to filter members server-side.
    let agencyAbbreviation = null;
    if (!access.isGlobalAdmin && authUser?.uid) {
      try {
        // Only use attribute-based filtering when the user appears to be a
        // single-agency admin; otherwise fall back to legacy suffix gate.
        const allowed = access.allowedAgencySuffixes || [];
        if (allowed.length === 1) {
          const me = await usersService.getUserById(authUser.uid);
          const attrs = me?.attributes || {};
          const abbr = String(attrs.agency_abbreviation || "").trim();
          if (abbr) {
            agencyAbbreviation = abbr;
          }
        }
      } catch (e) {
        agencyAbbreviation = null;
      }
    }

    const users = await groups.getGroupMembers(groupId, {
      authUser,
      agencyAbbreviation,
    });

    let mutual = [];
    try {
      const items = mutualAid.list() || [];
      const groupName = String(group?.name || "").trim();
      mutual = items.filter((it) => {
        const idMatch = String(it.groupId || "") === String(groupId);
        const nameMatch =
          groupName && String(it.groupName || "").trim() === groupName;
        return idMatch || nameMatch;
      });
    } catch (e) {
      mutual = [];
    }

    res.json({
      group,
      users,
      mutualAid: mutual,
      memberCount: Array.isArray(users) ? users.length : 0,
    });
  } catch (err) {
    res.status(400).json({ error: toErrorPayload(err) });
  }
});

module.exports = router;
