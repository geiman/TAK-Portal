const crypto = require("crypto");
const QRCode = require("qrcode");

const api = require("./authentik");
const groupsSvc = require("./groups.service");
const usersSvc = require("./users.service");
const store = require("./mutualAid.store");
const settingsSvc = require("./settings.service");
const emailSvc = require("./email.service");
const { renderTemplate, htmlToText } = require("./emailTemplates.service");

// ---- Expiration scheduler (in-memory) ----
// Expiration settings are persisted in mutual-aid.json. Timers are best-effort
// and rehydrated on server start.
const expirationTimers = new Map(); // id -> Timeout

function clearExpirationTimer(id) {
  const key = String(id || "");
  const t = expirationTimers.get(key);
  if (t) clearTimeout(t);
  expirationTimers.delete(key);
}

async function handleExpirationFire(id) {
  try {
    const item = getById(id);
    if (!item) return;

    const enabled = !!item.expireEnabled;
    const at = item.expireAt ? new Date(item.expireAt).getTime() : NaN;
    if (!enabled || !Number.isFinite(at)) return;

    // Only fire if we're at/after the scheduled time.
    if (Date.now() < at) {
      // Clock drift/restart: reschedule.
      scheduleExpiration(item);
      return;
    }

    // Treat as if the delete button was clicked.
    await remove({ id: item.id });
  } catch (e) {
    console.error("[MUTUAL AID] expiration delete failed:", e?.message || e);
  } finally {
    clearExpirationTimer(id);
  }
}

function scheduleExpiration(item) {
  if (!item) return;
  clearExpirationTimer(item.id);

  if (!item.expireEnabled) return;
  // Expiration is supported for both EVENT and INCIDENT.

  const atMs = item.expireAt ? new Date(item.expireAt).getTime() : NaN;
  if (!Number.isFinite(atMs)) return;

  const delay = atMs - Date.now();
  if (delay <= 0) {
    // Fire ASAP on next tick.
    const t = setTimeout(() => void handleExpirationFire(item.id), 0);
    expirationTimers.set(String(item.id), t);
    return;
  }

  // Cap long timeouts to avoid max-delay issues (Node timers are ~24.8 days)
  const MAX_DELAY = 2_000_000_000; // ~23.1 days
  const t = setTimeout(() => {
    // If far in future, chain timers.
    if (delay > MAX_DELAY) {
      scheduleExpiration(item);
      return;
    }
    void handleExpirationFire(item.id);
  }, Math.min(delay, MAX_DELAY));

  expirationTimers.set(String(item.id), t);
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeTitle(title) {
  return String(title || "").trim();
}

function sanitizeUsernameSlug(title) {
  // lowercase, no spaces, keep a-z0-9_- only
  return String(title || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9_-]/g, "");
}

function buildMutualAidUsername(type, title) {
  const t = String(type || "").trim().toLowerCase();
  const slug = sanitizeUsernameSlug(title);
  if (!slug) return "";
  if (t !== "incident" && t !== "event") return slug;
  return `${t}-${slug}`;
}

function buildGroupName(type, title) {
  const t = String(type || "").trim().toUpperCase();
  if (t !== "INCIDENT" && t !== "EVENT") {
    throw new Error("Type must be INCIDENT or EVENT");
  }
  const name = sanitizeTitle(title);
  if (!name) throw new Error("Name is required");
  return `${t}-${name}`;
}

function randomPassword(length = 18) {
  // Use a mix of upper/lower/digits/symbols
  // (avoid ambiguous/whitespace characters)
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%&*_-+=?";
  const all = upper + lower + digits + symbols;

  const pick = (charset) => charset[crypto.randomInt(0, charset.length)];

  // Ensure at least one from each category
  let out = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (out.length < length) out.push(pick(all));

  // Shuffle
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}

function getTakHost() {
  // Match QR Generator behavior: prefer TAK_URL from settings.json, fall back to env.
  try {
    const settings = settingsSvc.getSettings ? settingsSvc.getSettings() || {} : {};
    let takUrl = null;

    if (
      settings.TAK_URL &&
      typeof settings.TAK_URL === "string" &&
      settings.TAK_URL.trim()
    ) {
      takUrl = settings.TAK_URL.trim();
    } else if (process.env.TAK_URL && String(process.env.TAK_URL).trim()) {
      takUrl = String(process.env.TAK_URL).trim();
    }

    if (!takUrl) {
      throw new Error(
        "TAK_URL is not configured. Set it in Settings (TAK URL) or via the TAK_URL environment variable."
      );
    }

    return new URL(takUrl).hostname;
  } catch (e) {
    throw new Error(
      "TAK_URL is not configured. Set it in Settings (TAK URL) or via the TAK_URL environment variable."
    );
  }
}

function enrollUrlForCreds(username, token) {
  const host = getTakHost();
  return (
    `tak://com.atakmap.app/enroll?` +
    `host=${host}` +
    `&username=${encodeURIComponent(username)}` +
    `&token=${encodeURIComponent(token)}`
  );
}

async function qrDataUrl(username, token) {
  const enrollUrl = enrollUrlForCreds(username, token);
  const qrCode = await QRCode.toDataURL(enrollUrl, {
    errorCorrectionLevel: "H",
    type: "image/png",
    width: 512,
    margin: 2,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  return { enrollUrl, qrCode };
}

async function qrPngBuffer(username, token) {
  const enrollUrl = enrollUrlForCreds(username, token);
  return QRCode.toBuffer(enrollUrl, {
    errorCorrectionLevel: "H",
    type: "png",
    width: 1200,
    margin: 3,
  });
}

function list() {
  const items = store.load();
  // newest first
  return items
    .slice()
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function getById(id) {
  const items = store.load();
  return items.find((x) => String(x.id) === String(id)) || null;
}

function saveAll(items) {
  store.save(items);
}

async function sendMutualAidCreatedEmail({ type, title, username, password, groupName }) {
  // Requirement: notify EMAIL_ALWAYS_CC and EMAIL_SEND_COPY_TO recipients.
  // We'll send *to* the union list to ensure delivery even if cc/bcc are empty.
  const cfg = emailSvc.getSmtpConfig();

  const parse = (v) =>
    String(v || "")
      .trim()
      .split(/[;,]/g)
      .map((x) => String(x).trim())
      .filter(Boolean);

  const recipients = Array.from(new Set([...parse(cfg.alwaysCc), ...parse(cfg.sendCopyTo)]));
  if (!recipients.length) return;

  const { enrollUrl, qrCode } = await qrDataUrl(username, password);
  const subject = `Mutual Aid ${String(type || "").toUpperCase()} created: ${title}`;

  const html = renderTemplate("mutual_aid_created.html", {
    type: String(type || "").toUpperCase(),
    title: String(title || ""),
    groupName: String(groupName || ""),
    username: String(username || ""),
    password: String(password || ""),
    enrollUrl,
    qrDataUrl: qrCode,
  });
  const text = htmlToText(html);

  await emailSvc.sendMail({
    to: recipients.join(","),
    subject,
    text,
    html,
  });
}

function coerceBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

function parseExpireAt(value) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) throw new Error("Invalid expiration date/time");
  return d.toISOString();
}

async function create({ type, title, expireEnabled, expireAt }) {
  const t = String(type || "").trim().toUpperCase();
  const name = sanitizeTitle(title);
  const groupName = buildGroupName(t, name);
  // Username should be incident-xxx / event-xxx.
  const username = buildMutualAidUsername(t, name);
  if (!username) throw new Error("Name must contain at least one letter/number for username");

  // Expiration options (EVENT + INCIDENT)
  const wantExpire = coerceBool(expireEnabled);
  const parsedExpireAt = wantExpire ? parseExpireAt(expireAt) : null;
  
  if (wantExpire && !parsedExpireAt) {
    throw new Error("Expiration date/time is required when expiration is enabled");
  }
  if (wantExpire && new Date(parsedExpireAt).getTime() <= Date.now()) {
    throw new Error("Expiration date/time must be in the future");
  }

  // 1) Create group
  const group = await groupsSvc.createGroup(groupName);

  // 2) Create user (minimal fields; password is numeric as requested)
  const password = randomPassword(18);
  const userPayload = {
    username,
    name, // display name
    is_active: true,
    password,
    attributes: {
      mutual_aid: true,
      mutual_aid_type: t,
      mutual_aid_group: groupName,
    },
  };

  const folderRaw = String(process.env.AUTHENTIK_USER_PATH || "").trim();
  if (folderRaw) {
    userPayload.path = String(folderRaw).replace(/^\/+|\/+$/g, "");
  }

  const res = await api.post("/core/users/", userPayload);
  const user = res.data;

// 3) Ensure user gets this mutual aid group
const finalGroups = [group];

  await api.patch(`/core/users/${user.pk}/`, {
    groups: finalGroups.map((g) => g.pk),
  });

  // 4) Persist record (stores password so QR can be regenerated later)
  const item = {
    id: crypto.randomUUID(),
    type: t,
    title: name,
    groupId: String(group.pk),
    groupName,
    userId: String(user.pk),
    username,
    password,
    expireEnabled: wantExpire,
    expireAt: parsedExpireAt,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  const items = store.load();
  items.push(item);
  saveAll(items);

  // 4b) Schedule expiration (best-effort)
  scheduleExpiration(item);

  // 5) Email notify (best-effort)
  try {
    await sendMutualAidCreatedEmail({
      type: t,
      title: name,
      username,
      password,
      groupName,
    });
  } catch (e) {
    console.error("[EMAIL] mutual aid created notice failed:", e?.message || e);
  }

  return item;
}

async function update({ id, type, title, expireEnabled, expireAt }) {
  const items = store.load();
  const idx = items.findIndex((x) => String(x.id) === String(id));
  if (idx < 0) throw new Error("Mutual aid item not found");

  const current = items[idx];
  const nextType = String(type || current.type || "").trim().toUpperCase();
  const nextTitle = sanitizeTitle(title ?? current.title);
  const nextGroupName = buildGroupName(nextType, nextTitle);

  // Username should follow the same formatting rules as creation.
  const nextUsername = buildMutualAidUsername(nextType, nextTitle);
  if (!nextUsername) throw new Error("Name must contain at least one letter/number for username");

  // Expiration options (EVENT + INCIDENT)
  const nextExpireEnabled = coerceBool(expireEnabled ?? current.expireEnabled);
  const nextExpireAt = nextExpireEnabled
    ? parseExpireAt(expireAt ?? current.expireAt)
    : null;
  if (nextExpireEnabled && !nextExpireAt) {
    throw new Error("Expiration date/time is required when expiration is enabled");
  }
  if (nextExpireEnabled && new Date(nextExpireAt).getTime() <= Date.now()) {
    throw new Error("Expiration date/time must be in the future");
  }

  // Rename group in Authentik if needed
  if (String(current.groupName) !== String(nextGroupName)) {
    await groupsSvc.renameGroup(current.groupId, nextGroupName, { ignoreLocks: true });
  }

  // Update user display name + username to match formatting rules.
  if (String(current.userId || "").trim()) {
    // If username is changing, ensure it isn't already taken (except by this user).
    if (String(current.username || "") !== String(nextUsername)) {
      const taken = await usersSvc.userExists(nextUsername);
      if (taken) throw new Error(`Username already exists: ${nextUsername}`);
    }

    await api
      .patch(`/core/users/${current.userId}/`, {
        username: nextUsername,
        name: nextTitle,
        attributes: {
          ...(current.attributes || {}),
          mutual_aid: true,
          mutual_aid_type: nextType,
          mutual_aid_group: nextGroupName,
        },
      })
      .catch(() => {
        // Non-fatal if attribute patch fails due to schema
        return null;
      });
  }

  const updated = {
    ...current,
    type: nextType,
    title: nextTitle,
    groupName: nextGroupName,
    username: nextUsername,
    expireEnabled: nextExpireEnabled,
    expireAt: nextExpireAt,
    updatedAt: nowIso(),
  };
  items[idx] = updated;
  saveAll(items);

  // Update expiration schedule
  scheduleExpiration(updated);
  return updated;
}

async function remove({ id }) {
  const items = store.load();
  const idx = items.findIndex((x) => String(x.id) === String(id));
  if (idx < 0) throw new Error("Mutual aid item not found");

  const item = items[idx];

  // If this item had an expiration timer, clear it.
  clearExpirationTimer(item.id);

  // Deletion semantics: like deleting a user
  // - revoke all client certs with matching creatorDn (done by usersSvc.deleteUser)
  // - delete the user in Authentik
  // - delete the group
  if (item.userId) {
    await usersSvc.deleteUser(item.userId, { ignoreLocks: true });
  }

  if (item.groupId) {
    // Use cleanup delete to keep templates consistent (safest)
    await groupsSvc.deleteGroupWithCleanup(item.groupId, { ignoreLocks: true });
  }

  // Remove from store
  items.splice(idx, 1);
  saveAll(items);
  return { success: true };
}

async function getQr({ id }) {
  const item = getById(id);
  if (!item) throw new Error("Mutual aid item not found");
  const { enrollUrl, qrCode } = await qrDataUrl(item.username, item.password);
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    username: item.username,
    enrollUrl,
    qrCode,
  };
}

async function getQrDownload({ id }) {
  const item = getById(id);
  if (!item) throw new Error("Mutual aid item not found");
  const pngBuffer = await qrPngBuffer(item.username, item.password);
  const safeUser = String(item.username || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "") || "mutual-aid";

  const filename = `tak-${safeUser}-enrollment-qr.png`;
  return { pngBuffer, filename };
}

function initExpirationScheduler() {
  try {
    const items = store.load();
    items.forEach((it) => scheduleExpiration(it));
  } catch (e) {
    console.error("[MUTUAL AID] failed to initialize expiration scheduler:", e?.message || e);
  }
}

module.exports = {
  initExpirationScheduler,
  list,
  create,
  update,
  remove,
  getQr,
  getQrDownload,
};
