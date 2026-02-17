const { getString, getInt, getBool } = require("./env");
const api = require("./authentik");
const agenciesStore = require("./agencies.service");
const templatesStore = require("./templates.service");
const tak = require("./tak.service");
const settingsSvc = require("./settings.service");

function getHiddenUserPrefixes() {
  return String(getString("USERS_HIDDEN_PREFIXES", ""))
    .split(",")
    .map(p => String(p || "").trim().toLowerCase())
    .filter(Boolean);
}

// ---------------- Action-lock helpers ----------------
// If a username starts with any prefix in USERS_ACTIONS_HIDDEN_PREFIXES,
// the UI hides action buttons AND the API will reject mutating operations.
function getUserActionLockPrefixes() {
  return String(getString("USERS_ACTIONS_HIDDEN_PREFIXES", ""))
    .split(",")
    .map(p => String(p || "").trim().toLowerCase())
    .filter(Boolean);
}

function isUserActionLocked(username) {
  const u = String(username || "").trim().toLowerCase();
  if (!u) return false;
  const prefixes = getUserActionLockPrefixes();
  if (!prefixes.length) return false;
  return prefixes.some(p => u.startsWith(p));
}

async function assertUserNotActionLocked(userId, { ignoreLocks } = {}) {
  const user = await getUserById(userId);
  if (!ignoreLocks && isUserActionLocked(user?.username)) {
    throw new Error(`Actions are locked for user ${user?.username || userId}`);
  }
  return user;
}

const emailSvc = require("./email.service");
const { renderTemplate, htmlToText } = require("./emailTemplates.service");

// Helpers
function normalizePath(p) {
  // Remove leading/trailing slashes
  return String(p || "").replace(/^\/+|\/+$/g, "");
}

function validateBadgeNumber(badge) {
  const b = String(badge || "").trim();
  if (!b) return "Badge / Username is required.";
  return null;
}

function validatePassword(password) {
  const p = String(password || "");
  if (p.length < 12) return "Password must be at least 12 characters.";
  if (!/[a-z]/.test(p)) return "Password must contain a lowercase letter.";
  if (!/[A-Z]/.test(p)) return "Password must contain an uppercase letter.";
  if (!/[0-9]/.test(p)) return "Password must contain a number.";
  if (!/[!@#$%^&*()_+\-=[\]{};':\"\\|,.<>/?]/.test(p))
    return "Password must contain a symbol.";
  return null;
}

async function resolveGroupNames(groupIds) {
  const ids = Array.isArray(groupIds)
    ? groupIds.map(x => String(x).trim()).filter(Boolean)
    : [];
  if (!ids.length) return [];

  // Include hidden/internal groups when resolving names so notifications and
  // admin UIs never fall back to raw UUIDs.
  const all = await getAllGroups({ includeHidden: true });
  const byPk = new Map(all.map(g => [String(g.pk), String(g.name || "").trim()]));
  return ids
    .map(id => byPk.get(String(id)) || String(id))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function safeMailTo(user) {
  const to = String(user?.email || "").trim();
  return to || null;
}

function parseName(displayName) {
  const s = String(displayName || "").trim();

  // Split on first comma only
  const [last, rest] = s.split(",", 2);

  const lastName = (last || "").trim();
  const firstName = (rest || "").trim();

  return {
    lastName,
    lastNameUpper: lastName.toUpperCase(),
    firstName,
  };
}

function getTakPortalPublicUrl() {
  try {
    const settings = settingsSvc.getSettings ? settingsSvc.getSettings() || {} : {};

    if (
      settings.TAK_PORTAL_PUBLIC_URL &&
      typeof settings.TAK_PORTAL_PUBLIC_URL === "string" &&
      settings.TAK_PORTAL_PUBLIC_URL.trim()
    ) {
      return settings.TAK_PORTAL_PUBLIC_URL.trim();
    }

    const env = getString("TAK_PORTAL_PUBLIC_URL", "").trim();
    if (env) return env;

    return "";
  } catch {
    return "";
  }
}

/**
 * Build an HTML block for "TAK Portal" content.
 * NOTE: This is used with {{{takPortalBlock}}} in templates so it must be valid HTML.
 */
function buildTakPortalBlock({
  takPortalPublicUrl,
  introHtml,
  buttonText,
  elseHtml,
} = {}) {
  const url = String(takPortalPublicUrl || "").trim();

  if (url) {
    const intro = String(introHtml || "").trim();
    const btnText = String(buttonText || "Open TAK Portal").trim();

    const btnPadV = 12;
    const btnPadH = 22;
    const btnRadius = 8;
    const btnBg = "#2563eb";
    const btnTextColor = "#ffffff";

    return `
      ${intro ? `<p style="margin:0 0 12px; font-size:14px; line-height:21px;">${intro}</p>` : ""}

      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 16px;">
        <tr>
          <td align="center">

            <!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml"
              href="${url}"
              style="height:${btnPadV * 2 + 16}px; v-text-anchor:middle; width:320px;"
              arcsize="${Math.round((btnRadius / 40) * 100)}%"
              stroke="f"
              fillcolor="${btnBg}">
              <w:anchorlock/>
              <center style="color:${btnTextColor}; font-family:Segoe UI, Arial, sans-serif; font-size:14px; font-weight:700;">
                ${btnText}
              </center>
            </v:roundrect>
            <![endif]-->

            <!--[if !mso]><!-- -->
            <table role="presentation" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td bgcolor="${btnBg}" style="border-radius:${btnRadius}px;">
                  <a href="${url}" target="_blank" rel="noopener noreferrer"
                     style="display:inline-block; padding:${btnPadV}px ${btnPadH}px;
                            font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                            font-size:14px; line-height:16px; font-weight:700;
                            color:${btnTextColor} !important; mso-style-priority:100;
                            text-decoration:none; border-radius:${btnRadius}px;">
                    <span style="color:${btnTextColor} !important; text-decoration:none;">${btnText}</span>
                  </a>
                </td>
              </tr>
            </table>
            <!--<![endif]-->

          </td>
        </tr>
      </table>
    `.trim();
  }

  const fallback = String(elseHtml || "").trim();
  return `
    <p style="margin:0 0 16px; font-size:14px; line-height:21px;">
      ${fallback}
    </p>
  `.trim();
}

/**
 * User-created email.
 *
 * hasPassword === true  -> use "user_created_password_set.html"
 * hasPassword === false -> use "user_created_no_password.html"
 *
 */
async function emailUserCreated({ user, groups, hasPassword }) {
  const to = safeMailTo(user);
  if (!to) return;

  const groupNames = Array.isArray(groups)
    ? groups
        .map(g => String(g?.name || "").trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
    : [];

  const subject = "TAK Account Created";
  const displayName = String(user?.name || "").trim() || "there";
  const { lastName, lastNameUpper, firstName } = parseName(displayName);
  const groupsCsv = groupNames.length ? groupNames.join(", ") : "(none)";

  const attrs = user?.attributes || {};
  const agencies = agenciesStore.load();

  const agencySuffix = String(attrs.agency || "").toLowerCase();
  const agency =
    agencies.find(
      a => String(a.suffix || "").toLowerCase() === agencySuffix
    ) || null;

  const badgeNumber = String(attrs.badge_number || "");
  const agencyAbbreviation =
    String(
      agency?.groupPrefix ||
      attrs.agency_abbreviation ||
      ""
    );
  const agencyColor =
    String(
      agency?.color ||
      attrs.agency_color ||
      ""
    );

  // For user-created emails only: if the user was created from an agency template,
  // prefer that template's color override (when present). Otherwise fall back to
  // the agency color behavior above.
  let agencyColorEffective = agencyColor;
  try {
    const createdTemplateName = String(attrs.created_template || "").trim();

    // "Manual Group Selection" is the non-template option in the UI.
    if (createdTemplateName && createdTemplateName !== "Manual Group Selection") {
      const tplAgencySuffix = String(attrs.agency || agencySuffix || "")
        .trim()
        .toLowerCase();
      const allTemplates = templatesStore.load();
      const match = allTemplates.find(t =>
        String(t?.agencySuffix || "").trim().toLowerCase() === tplAgencySuffix &&
        String(t?.name || "").trim().toLowerCase() === createdTemplateName.toLowerCase()
      );
      const override = String(match?.colorOverride || "").trim();
      if (override) agencyColorEffective = override;
    }
  } catch (e) {
    // Never block email sending because of template lookup issues.
  }

  const templateKey = hasPassword
    ? "user_created_password_set.html"
    : "user_created_no_password.html";

  const takPortalPublicUrl = getTakPortalPublicUrl();

  const takPortalBlock = hasPassword
    ? buildTakPortalBlock({
        takPortalPublicUrl,
        introHtml:
          "Use the TAK Portal to access device setup instructions, reset your password, or generate a QR code for faster sign-in on your mobile device.",
        buttonText: "Open TAK Portal",
        elseHtml:
          "If you forget your password or need help setting up TAK on your device, contact your TAK Portal Administrator.",
      })
    : buildTakPortalBlock({
        takPortalPublicUrl,
        introHtml:
          "Use the TAK Portal to set your password, access device setup instructions, or generate a QR code for faster sign-in on your mobile device.",
        buttonText: "Open TAK Portal To Set Your Password",
        elseHtml:
          "To set your password or get help setting up TAK on your device, contact your TAK Portal Administrator.",
      });

  const html = renderTemplate(templateKey, {
    displayName,
    lastName,
    lastNameUpper,
    firstName,
    username: String(user?.username || ""),
    groupsCsv,
    hasPassword: !!hasPassword,
    badgeNumber,
    agencyAbbreviation,
    agencyColor: agencyColorEffective,
    takPortalPublicUrl, // keep available if any template uses it elsewhere
    takPortalBlock,     // NEW: injected HTML block used by {{{takPortalBlock}}}
  });

  const text = htmlToText(html);

  await emailSvc.sendMail({ to, subject, text, html });
}

async function emailPasswordChanged(user) {
  const to = safeMailTo(user);
  if (!to) return;

  const attrs = user?.attributes || {};
  const agencies = agenciesStore.load();

  const agencySuffix = String(attrs.agency || "").toLowerCase();
  const agency =
    agencies.find(
      a => String(a.suffix || "").toLowerCase() === agencySuffix
    ) || null;

  const badgeNumber = String(attrs.badge_number || "");
  const agencyAbbreviation =
    String(
      agency?.groupPrefix ||
      attrs.agency_abbreviation ||
      ""
    );
  const agencyColor =
    String(
      agency?.color ||
      attrs.agency_color ||
      ""
    );

  const subject = "TAK Password Updated";
  const displayName = String(user?.name || "").trim() || "there";
  const { lastName, lastNameUpper, firstName } = parseName(displayName);

  const takPortalPublicUrl = getTakPortalPublicUrl();
  const takPortalBlock = buildTakPortalBlock({
    takPortalPublicUrl,
    introHtml:
      "Use the TAK Portal to manage your password, access device setup instructions, or generate a QR code for faster sign-in on your mobile device.",
    buttonText: "Open TAK Portal",
    elseHtml:
      "If you need to change your password or get help setting up TAK on your device, contact your TAK Portal Administrator.",
  });

  const html = renderTemplate("password_changed.html", {
    displayName,
    lastName,
    lastNameUpper,
    firstName,
    username: String(user?.username || ""),
    badgeNumber,
    agencyAbbreviation,
    agencyColor,
    takPortalPublicUrl,
    takPortalBlock,
  });

  const text = htmlToText(html);

  await emailSvc.sendMail({ to, subject, text, html });
}

async function emailGroupsUpdated({ user, beforeIds, afterIds }) {
  const to = safeMailTo(user);
  if (!to) return;

  const [beforeNames, afterNames] = await Promise.all([
    resolveGroupNames(beforeIds),
    resolveGroupNames(afterIds),
  ]);

  const attrs = user?.attributes || {};
  const agencies = agenciesStore.load();

  const agencySuffix = String(attrs.agency || "").toLowerCase();
  const agency =
    agencies.find(
      a => String(a.suffix || "").toLowerCase() === agencySuffix
    ) || null;

  const badgeNumber = String(attrs.badge_number || "");
  const agencyAbbreviation =
    String(
      agency?.groupPrefix ||
      attrs.agency_abbreviation ||
      ""
    );
  const agencyColor =
    String(
      agency?.color ||
      attrs.agency_color ||
      ""
    );

  const subject = "TAK Groups Updated";
  const displayName = String(user?.name || "").trim() || "there";
  const { lastName, lastNameUpper, firstName } = parseName(displayName);
  const beforeGroupsCsv = beforeNames.length ? beforeNames.join(", ") : "(none)";
  const afterGroupsCsv = afterNames.length ? afterNames.join(", ") : "(none)";

  const takPortalPublicUrl = getTakPortalPublicUrl();
  const takPortalBlock = buildTakPortalBlock({
    takPortalPublicUrl,
    introHtml:
      "Use the TAK Portal to review your access, manage your account, follow device setup instructions, or generate a QR code for faster sign-in on your mobile device.",
    buttonText: "Open TAK Portal",
    elseHtml:
      "If you need to review your access or get help setting up TAK on your device, contact your TAK Portal Administrator.",
  });

  const html = renderTemplate("groups_updated.html", {
    displayName,
    lastName,
    lastNameUpper,
    firstName,
    username: String(user?.username || ""),
    beforeGroupsCsv,
    afterGroupsCsv,
    badgeNumber,
    agencyAbbreviation,
    agencyColor,
    takPortalPublicUrl,
    takPortalBlock,
  });

  const text = htmlToText(html);

  await emailSvc.sendMail({ to, subject, text, html });
}

// --- Debounced "groups updated" email logic ---
const GROUP_EMAIL_DEBOUNCE_MS = 3 * 60 * 1000;

// In-memory queue to debounce group-change emails per user.
// NOTE: This is per-process. If you run multiple Node instances,
// each process will handle its own debounce window.
const groupEmailQueue = new Map();

function scheduleDebouncedGroupsEmail({ user, beforeIds, afterIds }) {
  const userId = String(user?.pk || user?.id || "").trim();
  if (!userId) return;

  const existing = groupEmailQueue.get(userId);
  if (existing && existing.timeout) {
    clearTimeout(existing.timeout);
  }

  const entry = {
    // Keep the very first snapshot of "before" so the email shows all changes.
    user: existing?.user || user,
    beforeIds:
      existing?.beforeIds ||
      (Array.isArray(beforeIds) ? beforeIds.slice() : []),
    // Always use the latest "after" set so we reflect the final state.
    afterIds: Array.isArray(afterIds) ? afterIds.slice() : [],
  };

  entry.timeout = setTimeout(async () => {
    groupEmailQueue.delete(userId);
    try {
      await emailGroupsUpdated({
        user: entry.user,
        beforeIds: entry.beforeIds,
        afterIds: entry.afterIds,
      });
    } catch (err) {
      console.error(
        "[EMAIL] groups update notice (debounced) failed:",
        err?.message || err
      );
    }
  }, GROUP_EMAIL_DEBOUNCE_MS);

  groupEmailQueue.set(userId, entry);
}

// Get templates available for a given agency suffix.
// Templates are agency-specific; must match the given suffix.
// Returned templates are used AFTER the "Manual Group Selection" option in the UI.
function getTemplatesForAgency(agencySuffix) {
  const all = templatesStore.load();
  const sfx = String(agencySuffix || "").trim().toLowerCase();
  const filtered = all.filter(t => {
    const tSfx = String(t.agencySuffix || "").trim().toLowerCase();
    return tSfx === sfx;
  });
  return filtered.map(t => ({
    name: String(t.name || "").trim(),
    agencySuffix: String(t.agencySuffix || "").trim().toLowerCase(),
    groups: Array.isArray(t.groups)
      ? t.groups.map(g => String(g).trim()).filter(Boolean)
      : [],
    isDefault: !!t.isDefault,
  }));
}

// Authentik API helpers (groups)
async function getAllGroupsRaw(options = {}) {
  const { includeHidden = false } = options || {};
  let groups = [];
  let url = "/core/groups/";
  while (url) {
    const res = await api.get(url);
    groups = groups.concat(res.data.results);
    url = res.data.next
      ? res.data.next.replace(`${getString("AUTHENTIK_URL", "")}/api/v3`, "")
      : null;
  }

  // Hide internal Authentik groups from this portal UI by default.
  // Callers may opt-in to includeHidden=true when they need to resolve names
  // or preserve internal group memberships.
  if (!includeHidden) {
    groups = groups.filter(g => {
      const name = String(g?.name || "").trim().toLowerCase();
      return !name.startsWith("authentik");
    });
  }

  return groups;
}

// Fetch all users, then:
// - page using Authentik's `pagination` object (no hard cap on total)
// - hide service/system users by username prefix (USERS_HIDDEN_PREFIXES)
// - optionally filter by AUTHENTIK_USER_PATH if set
async function getAllUsersRaw() {
  let users = [];
  const pageSize = getInt("AUTHENTIK_USER_PAGE_SIZE", 500) || 500; // per-page size; total is unlimited
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    const url = `${getString("AUTHENTIK_URL", "")}/api/v3/core/users/?page=${page}&page_size=${pageSize}`;
    const res = await api.get(url);
    const data = res?.data || {};
    const results = Array.isArray(data.results) ? data.results : [];
    const pagination = data.pagination || {};

    users = users.concat(results);

    if (pagination && pagination.next) {
      page = pagination.next;
      hasNext = true;
    } else {
      hasNext = false;
    }
  }

  // --- prefix filter ---
  const hiddenPrefixes = getHiddenUserPrefixes();

  if (hiddenPrefixes.length) {
    users = users.filter(u => {
      const username = String(u?.username || "").trim().toLowerCase();
      return !hiddenPrefixes.some(p => username.startsWith(p));
    });
  }

  // --- path filter ---
  const folderRaw = String(getString("AUTHENTIK_USER_PATH", "")).trim();
  if (!folderRaw) {
    return users;
  }

  const target = normalizePath(folderRaw);

  return users.filter(u => {
    const up = normalizePath(u.path);
    return up === target || up.startsWith(target + "/");
  });
}

async function userExists(username) {
  const res = await api.get("/core/users/", { params: { username } });
  return res.data.results.length > 0;
}

// Main: Create user
async function createUser(
  {
    badge,
    agencySuffix,
    email,
    firstName,
    lastName,
    password,
    templateIndex,
    manualGroupIds,
    // Optional optimization: pass preloaded Authentik groups to avoid refetching for each user
    allGroups,
  },
  opts = {}
) {
  const {
    skipExistenceCheck = false,
    createdBy = null,
    creationMethod = "manual",
  } = opts;

  const createdAt = new Date().toISOString();
  let templateNameUsed = null;

  const badgeErr = validateBadgeNumber(badge);
  if (badgeErr) throw new Error(badgeErr);

  // Keep server-side password validation consistent with reset-password.
  // (The UI validates too, but API callers could bypass the UI.)
  const pwd = String(password || "").trim();
  if (pwd) {
    const pwdErr = validatePassword(pwd);
    if (pwdErr) throw new Error(pwdErr);
  }

  const agencies = agenciesStore.load();
  const agency = agencies.find(
    a =>
      a.suffix.toLowerCase() === String(agencySuffix || "").toLowerCase()
  );
  if (!agency) throw new Error("Invalid agency");

  const username = `${badge}${agency.suffix}`;
  if (!skipExistenceCheck && await userExists(username)) {
    throw new Error("Username already exists");
  }

  const first = String(firstName || "").trim();
  const last = String(lastName || "").trim();
  const mail = String(email || "").trim();

  if (!first) throw new Error("First name required");
  if (!last) throw new Error("Last name required");

  const name = `${last}, ${first}`;

  // Fetch all groups once (or reuse caller-provided cache)
  const allGroupsLocal = Array.isArray(allGroups) && allGroups.length
    ? allGroups
    : await getAllGroups();

  // Build fast lookup maps
  const byPk = new Map(allGroupsLocal.map(g => [String(g.pk), g]));
  const byNameLower = new Map(
    allGroupsLocal.map(g => [String(g.name || "").trim().toLowerCase(), g])
  );

  // Determine selected groups from template/manual
  let selectedGroups = [];
  const tIdx = Number(templateIndex);

  // Index 0 = Manual Group Selection
  if (Number.isInteger(tIdx) && tIdx === 0) {
    templateNameUsed = "Manual Group Selection";
    const raw = Array.isArray(manualGroupIds) ? manualGroupIds : [];

    // Allow UI to send either PKs or names
    selectedGroups = raw
      .map(x => String(x).trim())
      .filter(Boolean)
      .map(v => {
        // try pk match first
        const g1 = byPk.get(v);
        if (g1) return g1;

        // then try numeric-string pk match
        const g2 = byPk.get(String(Number(v)));
        if (g2) return g2;

        // then try name match
        return byNameLower.get(v.toLowerCase()) || null;
      })
      .filter(Boolean);

    if (!selectedGroups.length) {
      throw new Error(
        "Manual group selection did not match any Authentik groups."
      );
    }
  } else {
    // Dynamic templates start at index 1 in the UI
    const dynTemplates = getTemplatesForAgency(agency.suffix);
    const selectedTemplate = dynTemplates[tIdx - 1]; // subtract 1 because index 0 is manual

    if (selectedTemplate) {
      templateNameUsed = String(selectedTemplate.name || "") || null;

      selectedGroups = (selectedTemplate.groups || [])
        .map(n =>
          byNameLower.get(String(n).trim().toLowerCase())
        )
        .filter(Boolean);
    }
  }

  // Merge + dedupe by PK (selected groups only)
  const finalGroups = [
    ...new Map(selectedGroups.map(g => [g.pk, g])).values(),
  ];

  // Build payload
  const attributes = {
    agency: agency.suffix,
    agency_name: agency.name,

    badge_number: String(badge || ""),
    agency_abbreviation: String(agency.groupPrefix || ""),
    agency_color: String(agency.color || ""),
  };

  // who created the user
  if (createdBy && createdBy.username) {
    attributes.created_by_username = String(createdBy.username);
  }
  if (createdBy && createdBy.displayName) {
    attributes.created_by_display_name = String(createdBy.displayName);
  }

  // when / how / from which template
  attributes.created_at = createdAt;
  if (templateNameUsed) {
    attributes.created_template = templateNameUsed;
  }
  if (creationMethod) {
    attributes.created_method = String(creationMethod);
  }

  const payload = {
    username,
    email: mail,
    name,
    is_active: true,
    attributes,
  };

  // Ensure created users land in the correct "folder" (path)
  const folderRaw = String(getString("AUTHENTIK_USER_PATH", "")).trim();
  if (folderRaw) payload.path = normalizePath(folderRaw);

  // Track whether a password is being set at creation time
  const hasPassword = !!pwd;

  // Create user
  const res = await api.post("/core/users/", payload);
  const user = res.data;

  // NOTE: Authentik's create-user endpoint may not reliably apply the provided
  // password field (depending on configuration / permissions). However, the
  // dedicated set_password endpoint is known to work (and is what the UI uses
  // for resets). To keep behavior consistent, set the password *after* creation
  // when one was provided.
  if (pwd) {
    await api.post(`/core/users/${user.pk}/set_password/`, { password: pwd });
  }

  // Apply groups
  if (finalGroups.length) {
    await api.patch(`/core/users/${user.pk}/`, {
      groups: finalGroups.map(g => g.pk),
    });
  }

  // Email notification (never includes the password)
  try {
    await emailUserCreated({ user, groups: finalGroups, hasPassword });
  } catch (e) {
    // Don't fail user creation if email fails
    console.error("[EMAIL] user creation notice failed:", e?.message || e);
  }

  invalidateUsersCache();
  return { user, groups: finalGroups };
}

// Bulk CSV import
// This CSV format is intentionally minimal and strict:
// REQUIRED columns (case-insensitive):
//   badge
//   agency   (suffix or prefix)
//   firstName
//   lastName
//   email
//   password (may be blank)
//   template (name must exist for the agency)
// Any validation failure (except existing users) = ALL rows fail and NO users are created.
// Existing users are *skipped* but reported back.
async function importUsersFromCsvBuffer(buffer, opts = {}) {
  if (!buffer) throw new Error("No file uploaded");

  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;

  const allowedAgencySuffixes = Array.isArray(opts.allowedAgencySuffixes)
    ? opts.allowedAgencySuffixes.map((s) => String(s || "").trim().toLowerCase())
    : null;

  const createdBy = opts.createdBy || null;
  const creationMethod = opts.creationMethod || "csv";

  // Throttle progress callbacks to avoid taxing the system.
  let _lastProgressAt = 0;
  function reportProgress(payload) {
    if (!onProgress) return;
    const now = Date.now();
    // report at most 4x/sec, but always report final updates.
    const force = payload?.force === true;
    if (!force && now - _lastProgressAt < 250) return;
    _lastProgressAt = now;
    try {
      onProgress(payload);
    } catch (_) {
      // never allow progress reporting to break imports
    }
  }

  const rawText = buffer.toString("utf8");
  if (!rawText.trim()) throw new Error("CSV file is empty");

  const lines = rawText
    .split(/\r?\n/)
    .map(l => String(l || "").trim())
    .filter(Boolean);

  if (lines.length < 2)
    throw new Error("CSV must include header + at least one data row");

  reportProgress({ phase: "parsing", total: Math.max(0, lines.length - 1), processed: 0, created: 0, skipped: 0, force: true });

  // ----------- Columns -----------
  const header = lines[0].split(",").map(h => h.trim().toLowerCase());
  const required = [
    "badge",
    "agency",
    "firstname",
    "lastname",
    "email",
    "password",
    "template",
  ];

  for (const req of required) {
    if (!header.includes(req)) {
      throw new Error(`Missing required column: ${req}`);
    }
  }

  function get(parts, name) {
    const idx = header.indexOf(name);
    return idx >= 0 ? String(parts[idx] ?? "").trim() : "";
  }

  const agencies = agenciesStore.load();
  const rows = [];
  const errors = [];

  // Inform UI that we're validating (no network calls yet)
  reportProgress({
    phase: "validating",
    total: Math.max(0, lines.length - 1),
    processed: 0,
    created: 0,
    skipped: 0,
    force: true,
  });

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const lineNum = i + 1;

    const badge = get(parts, "badge");
    const agencyRaw = get(parts, "agency");
    const firstName = get(parts, "firstname");
    const lastName = get(parts, "lastname");
    const email = get(parts, "email");
    const password = get(parts, "password");
    const templateName = get(parts, "template");

    if (!badge) errors.push({ line: lineNum, message: "Missing badge" });
    if (!agencyRaw) errors.push({ line: lineNum, message: "Missing agency" });
    if (!firstName) errors.push({ line: lineNum, message: "Missing first name" });
    if (!lastName) errors.push({ line: lineNum, message: "Missing last name" });
    if (!templateName) errors.push({ line: lineNum, message: "Missing template" });

    // Badge must be numerics only (same rule as UI)
    const badgeErr = validateBadgeNumber(badge);
    if (badgeErr) {
      errors.push({ line: lineNum, message: badgeErr });
    }

    // Password: blank allowed. If non-blank, must pass validatePassword.
    if (password) {
      const pwdErr = validatePassword(password);
      if (pwdErr) {
        errors.push({ line: lineNum, message: pwdErr });
      }
    }

    // Resolve agency (suffix or prefix / groupPrefix)
    let agency = null;
    let agencySuffix = "";
    if (agencyRaw) {
      const lower = agencyRaw.toLowerCase();
      agency =
        agencies.find(a => String(a.suffix || "").toLowerCase() === lower) ||
        agencies.find(a => String(a.groupPrefix || "").toLowerCase() === lower);

      if (!agency) {
        errors.push({ line: lineNum, message: `Unknown agency "${agencyRaw}"` });
      } else {
        agencySuffix = String(agency.suffix || "").trim();

        if (allowedAgencySuffixes && allowedAgencySuffixes.length) {
          const sfxLower = String(agencySuffix || "").trim().toLowerCase();
          if (!allowedAgencySuffixes.includes(sfxLower)) {
            errors.push({
              line: lineNum,
              message: `You do not have access to agency "${agencyRaw}"`,
            });
          }
        }
      }
    }

    // Template must exist for the resolved agency
    if (templateName && agencySuffix) {
      const dyn = getTemplatesForAgency(agencySuffix);
      const found = dyn.find(
        t =>
          String(t.name || "").trim().toLowerCase() ===
          String(templateName).trim().toLowerCase()
      );
      if (!found) {
        errors.push({
          line: lineNum,
          message: `Template "${templateName}" not found for agency "${agencySuffix}"`,
        });
      }
    }

    rows.push({
      lineNum,
      badge,
      agencySuffix,
      firstName,
      lastName,
      email,
      password,
      templateName,
    });

    // Light progress during validation/parsing
    reportProgress({
      phase: "validating",
      total: Math.max(0, lines.length - 1),
      processed: Math.max(0, i),
      created: 0,
      skipped: 0,
    });
  }

  if (errors.length) {
    const msg =
      "CSV validation failed: " +
      errors.map(e => `Row ${e.line}: ${e.message}`).join("; ");
    throw new Error(msg);
  }

  reportProgress({ phase: "creating", total: rows.length, processed: 0, created: 0, skipped: 0, force: true });

  async function runWithConcurrencyLimit(items, limit, worker) {
    let index = 0;
    const workers = [];

    for (let i = 0; i < limit; i++) {
      workers.push(
        (async () => {
          while (true) {
            const current = index++;
            if (current >= items.length) break;
            await worker(items[current], current);
          }
        })()
      );
    }

    await Promise.all(workers);
  }

  const created = [];
  const skipped = [];
  let processed = 0;

  // Preload Authentik groups once for all rows to avoid repeated API calls
  const allGroups = await getAllGroups();

  const defaultLimit = 5;
  const envVal = getInt("USER_IMPORT_CONCURRENCY", defaultLimit);
  const importConcurrency =
    Number.isFinite(envVal) && envVal > 0 && envVal <= 25 ? envVal : defaultLimit;

  // Use a modest concurrency to balance speed vs load on Authentik
  await runWithConcurrencyLimit(rows, importConcurrency, async row => {
    try {
      const dyn = getTemplatesForAgency(row.agencySuffix);
      const idx = dyn.findIndex(
        t =>
          String(t.name || "").trim().toLowerCase() ===
          String(row.templateName || "").trim().toLowerCase()
      );
      if (idx < 0) {
        // Should not happen due to earlier validation, but keep defensive.
        throw new Error(
          `Template "${row.templateName}" not found during creation`
        );
      }

      const username = `${row.badge}${row.agencySuffix}`;

      // Option B behavior: if user already exists, skip but record it.
      if (await userExists(username)) {
        skipped.push({
          line: row.lineNum,
          username,
          reason: "Username already exists",
        });
        return;
      }

      // Dynamic templates are offset by +1 (0 = Manual Group Selection)
      const templateIndex = 1 + idx;

      const result = await createUser(
        {
          badge: row.badge,
          agencySuffix: row.agencySuffix,
          email: row.email,
          firstName: row.firstName,
          lastName: row.lastName,
          password: row.password || undefined, // <- per-row password / no-password
          templateIndex,
          manualGroupIds: [],
          allGroups,
        },
        {
          skipExistenceCheck: true,
          createdBy,
          creationMethod,
        }
      );

      const createdUsername =
        (result && result.user && result.user.username) || username;
      created.push({ username: createdUsername });
    } finally {
      processed += 1;
      reportProgress({
        phase: "creating",
        total: rows.length,
        processed,
        created: created.length,
        skipped: skipped.length,
      });
    }
  });

  reportProgress({
    phase: "done",
    total: rows.length,
    processed: rows.length,
    created: created.length,
    skipped: skipped.length,
    force: true,
  });

  invalidateUsersCache();
  return { count: created.length, created, skipped };
}

// Search users
// - If no q provided -> returns all users (already filtered by folder)
async function findUsers({ q, forceRefresh = false } = {}) {
  // Legacy helper kept for backwards compatibility:
  // fetches all users (honoring folder/prefix filters), then filters in-memory.
  let users = await getAllUsers({ forceRefresh });
  if (!q || !String(q).trim()) {
    return users;
  }

  const needle = String(q).trim().toLowerCase();
  return users.filter(u => {
    const username = String(u.username || "").toLowerCase();
    const email = String(u.email || "").toLowerCase();
    const name = String(u.name || "").toLowerCase();
    return (
      username.includes(needle) ||
      email.includes(needle) ||
      name.includes(needle)
    );
  });
}

async function searchUsersPaged({ q, page = 1, pageSize = 50 } = {}) {
  const params = {
    page,
    page_size: pageSize,
    ordering: "username",
  };

  // IMPORTANT: Keep pagination totals accurate without extra API calls.
  //
  // The portal supports hiding system/service users by username prefix
  // (USERS_HIDDEN_PREFIXES). When possible, we also apply Authentik's
  // server-side `type` filter so the API's `pagination.count` already
  // reflects the same visible set.
  //
  // Authentik exposes the following user `type` values:
  //   - external
  //   - internal
  //   - internal_service_account
  //   - service_account
  //
  // If the portal is configured to hide users by prefix, those hidden users
  // are almost always service accounts. Excluding service accounts here keeps
  // the "showing X of Y users" UI correct with a single request.
  const hiddenPrefixes = getHiddenUserPrefixes();
  if (hiddenPrefixes.length) {
    // NOTE: params.type is an array; axios serializes this as repeated
    // query params (?type=external&type=internal), which matches Authentik.
    params.type = ["external", "internal"];
  }

  // If AUTHENTIK_USER_PATH is set, ask Authentik to filter server-side so
  // pagination totals align with the visible user set.
  const folderRaw = String(getString("AUTHENTIK_USER_PATH", "")).trim();
  if (folderRaw) {
    params.path_startswith = normalizePath(folderRaw);
  }

  if (q && String(q).trim()) {
    // Authentik supports "search" across username/email/etc.
    params.search = String(q).trim();
  }

  const res = await api.get("/core/users/", { params });
  const data = res?.data || {};
  const raw = Array.isArray(data.results) ? data.results : [];

  // Apply the same prefix/path filters that getAllUsersRaw uses so that
  // paged search stays in sync with full-list queries.
  let users = raw.slice();

  // Even when we apply the server-side `type` filter above, keep this
  // prefix filter as a safety net in case the instance has custom naming.
  if (hiddenPrefixes.length) {
    users = users.filter(u => {
      const username = String(u?.username || "").trim().toLowerCase();
      return !hiddenPrefixes.some(p => username.startsWith(p));
    });
  }

  // If the instance doesn't support the `path_startswith` param (or if the
  // portal is using a strict folder match), keep the legacy in-memory path
  // enforcement.
  if (folderRaw) {
    const target = normalizePath(folderRaw);
    users = users.filter(u => {
      const up = normalizePath(u.path);
      return up === target || up.startsWith(target + "/");
    });
  }

  const pagination = data.pagination || {};
  let total = 0;

  // Prefer Authentik's pagination.count if available (total items)
  if (pagination && pagination.count != null) {
    const t = Number(pagination.count);
    if (!Number.isNaN(t) && t >= 0) {
      total = t;
    }
  }

  // Fallback to top-level count if that is how this version exposes it
  if (!total && data && data.count != null) {
    const c = Number(data.count);
    if (!Number.isNaN(c) && c >= 0) {
      total = c;
    }
  }

  // As a last resort, fall back to the current page length
  if (!total) {
    total = users.length;
  }

  // If we still have any hidden-prefix users on this page (e.g., if the
  // Authentik instance does not classify them as service accounts), adjust
  // the total downward for this request so the UI doesn't over-report.
  //
  // This preserves correctness when the API `type` filter is effective
  // (the common case), while still being strictly better than the unfiltered
  // count when it's not.
  if (hiddenPrefixes.length) {
    const filteredOnPage = raw.length - users.length;
    if (filteredOnPage > 0 && total >= filteredOnPage) {
      total = total - filteredOnPage;
    }
  }

  const currentPage =
    typeof pagination.current === "number"
      ? pagination.current
      : Number(params.page) || 1;

  return {
    users,
    total,
    page: currentPage,
    pageSize,
    hasNext: Boolean(pagination.next ?? data.next),
    hasPrev: Boolean(pagination.previous ?? data.previous),
  };
}

async function searchUsersByAgencyAbbreviationPaged({
  agencyAbbreviation,
  q,
  page = 1,
  pageSize = 50,
} = {}) {
  const abbr = String(agencyAbbreviation || "").trim();
  if (!abbr) {
    return {
      users: [],
      total: 0,
      page: 1,
      pageSize,
      hasNext: false,
      hasPrev: false,
    };
  }

  const params = {
    page,
    page_size: pageSize,
    ordering: "username",
    // Authentik uses Django filter-style query params for custom fields.
    // User attributes live under `attributes`, so we can filter by attribute key.
    "attributes__agency_abbreviation": abbr,
  };

  if (q && String(q).trim()) {
    // Authentik supports "search" across username/email/etc.
    params.search = String(q).trim();
  }

  const res = await api.get("/core/users/", { params });
  const data = res?.data || {};
  let users = Array.isArray(data.results) ? data.results : [];

  // Apply the same hidden-prefix/path filters used elsewhere.
  const hiddenPrefixesRaw = String(getString("USERS_HIDDEN_PREFIXES", "")).trim();
  const hiddenPrefixes = hiddenPrefixesRaw
    ? hiddenPrefixesRaw
        .split(",")
        .map((x) => String(x).trim().toLowerCase())
        .filter(Boolean)
    : [];

  if (hiddenPrefixes.length) {
    users = users.filter((u) => {
      const username = String(u?.username || "").trim().toLowerCase();
      return !hiddenPrefixes.some((p) => username.startsWith(p));
    });
  }

  const folderRaw = String(getString("AUTHENTIK_USER_PATH", "")).trim();
  if (folderRaw) {
    const target = normalizePath(folderRaw);
    users = users.filter((u) => {
      const up = normalizePath(u.path);
      return up === target || up.startsWith(target + "/");
    });
  }

  const pagination = data.pagination || {};
  let total = 0;

  if (pagination) {
    if (typeof pagination.count === "number") total = pagination.count;
    if (!total && typeof pagination.total === "number") total = pagination.total;
    if (!total && typeof pagination.total_items === "number")
      total = pagination.total_items;
  }

  if (!total && data && data.count != null) {
    const c = Number(data.count);
    if (!Number.isNaN(c) && c >= 0) total = c;
  }

  if (!total) total = users.length;

  const currentPage =
    typeof pagination.current === "number"
      ? pagination.current
      : Number(params.page) || 1;

  return {
    users,
    total,
    page: currentPage,
    pageSize,
    hasNext: Boolean(pagination.next ?? data.next),
    hasPrev: Boolean(pagination.previous ?? data.previous),
  };
}

async function resetPassword(userId, password) {
  await assertUserNotActionLocked(userId);
  const err = validatePassword(password);
  if (err) throw new Error(err);
  await api.post(`/core/users/${userId}/set_password/`, {
    password,
  });

  // Notify the user (does not include the new password)
  try {
    const user = await getUserById(userId);
    await emailPasswordChanged(user);
  } catch (e) {
    // Don't fail the password change if email fails
    console.error("[EMAIL] password change notice failed:", e?.message || e);
  }
  return true;
}

async function updateEmail(userId, email) {
  await assertUserNotActionLocked(userId);
  const mail = String(email || "").trim();
  await api.patch(`/core/users/${userId}/`, { email: mail });
  return true;
}

async function setUserGroups(userId, groupIds) {
  const userBefore = await assertUserNotActionLocked(userId);
  const ids = Array.isArray(groupIds)
    ? groupIds.map(x => String(x).trim()).filter(Boolean)
    : [];
  await api.patch(`/core/users/${userId}/`, { groups: ids });

  // Notify user via debounced email (do not fail operation if email fails)
  try {
    scheduleDebouncedGroupsEmail({
      user: userBefore,
      beforeIds: userBefore?.groups || [],
      afterIds: ids,
    });
  } catch (e) {
    console.error(
      "[EMAIL] groups update notice (debounced) failed:",
      e?.message || e
    );
  }
  return true;
}

async function toggleUserActive(userId, isActive) {
  await assertUserNotActionLocked(userId);
  // If disabling, revoke + VERIFY TAK certs first (if enabled)
  if (!isActive) {
    const shouldRevoke = getBool("TAK_REVOKE_ON_DISABLE", true);

    if (shouldRevoke) {
      const user = await getUserById(userId);

      // Hard stop if revocation cannot be verified.
      // tak.service.js already no-ops safely if TAK_URL isn't set.
      await tak.revokeCertsForUser(user?.username, { requireVerified: true });
    }
  }

  await api.patch(`/core/users/${userId}/`, {
    is_active: !!isActive,
  });

  invalidateUsersCache();
  return true;
}

async function deleteUser(userId, opts = {}) {
  // This will skip the lock check if opts.ignoreLocks === true
  const user = await assertUserNotActionLocked(userId, opts);
  // Revoke + VERIFY TAK certs BEFORE deleting the Authentik user
  // requireVerified defaults to true, but making it explicit is good.
  await tak.revokeCertsForUser(user?.username, { requireVerified: true });

  await api.delete(`/core/users/${userId}/`);
  invalidateUsersCache();
  return true;
}

async function updateName(userId, name) {
  await assertUserNotActionLocked(userId);
  const n = String(name || "").trim();
  if (!n) throw new Error("Name is required");
  await api.patch(`/core/users/${userId}/`, { name: n });
}

// Fetch single user (if you don't already have it)
async function getUserById(userId) {
  const res = await api.get(`/core/users/${userId}/`);
  return res.data;
}

// Add groups to a user (merge)
async function addUserGroups(userId, groupIds) {
  await assertUserNotActionLocked(userId);
  const idsToAdd = Array.isArray(groupIds)
    ? groupIds.map(x => String(x).trim()).filter(Boolean)
    : [];

  if (!idsToAdd.length)
    return (await getUserById(userId)).groups || [];

  const user = await getUserById(userId);
  const current = Array.isArray(user.groups)
    ? user.groups.map(x => String(x))
    : [];

  const merged = Array.from(new Set([...current, ...idsToAdd]));
  await setUserGroups(userId, merged);
  return merged;
}

// Remove groups from a user
async function removeUserGroups(userId, groupIds) {
  await assertUserNotActionLocked(userId);
  const idsToRemove = new Set(
    Array.isArray(groupIds)
      ? groupIds.map(x => String(x).trim()).filter(Boolean)
      : []
  );

  const user = await getUserById(userId);
  const current = Array.isArray(user.groups)
    ? user.groups.map(x => String(x))
    : [];

  const remaining = current.filter(id => !idsToRemove.has(String(id)));
  await setUserGroups(userId, remaining);
  return remaining;
}

let USERS_CACHE = null;
let USERS_CACHE_TS = 0;
// TTL in seconds; defaults to 30s. Use 0 to disable caching and always hit Authentik.
const USERS_CACHE_TTL_MS = (getInt("USERS_CACHE_TTL_SECONDS", 30) || 0) * 1000;

function invalidateUsersCache() {
  USERS_CACHE = null;
  USERS_CACHE_TS = 0;
}

function invalidateGroupsCache() {
  // Currently uncached, but keep function for symmetry / future use.
}

async function getAllUsers(options = {}) {
  const { forceRefresh = false } = options || {};

  // If caching is disabled via env, always hit Authentik directly.
  if (USERS_CACHE_TTL_MS <= 0) {
    return await getAllUsersRaw();
  }

  const now = Date.now();
  const cacheValid =
    USERS_CACHE &&
    USERS_CACHE_TS &&
    now - USERS_CACHE_TS < USERS_CACHE_TTL_MS;

  if (!forceRefresh && cacheValid) {
    return USERS_CACHE;
  }

  const users = await getAllUsersRaw();
  USERS_CACHE = users;
  USERS_CACHE_TS = now;
  return users;
}

async function getAllGroups(options = {}) {
  // ignore forceRefresh; always reload
  return await getAllGroupsRaw(options);
}

module.exports = {
  // meta/template support
  getTemplatesForAgency,

  // shared data
  getAllGroups,
  getAllUsers,
  invalidateUsersCache,
  invalidateGroupsCache,

  // user ops
  userExists,
  createUser,
  importUsersFromCsvBuffer,
  getUserById,
  findUsers,
  searchUsersPaged,
  searchUsersByAgencyAbbreviationPaged,
  resetPassword,
  updateEmail,
  updateName,
  setUserGroups,
  toggleUserActive,
  deleteUser,
  addUserGroups,
  removeUserGroups,
};
