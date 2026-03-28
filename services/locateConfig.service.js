/**
 * Read/update <locate> in /opt/tak/CoreConfig.xml via SSH (Settings handshake).
 */

const takSshSvc = require("./takSsh.service");

const CORE_CONFIG_PATH = "/opt/tak/CoreConfig.xml";

function escapeXmlAttr(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeXmlAttr(s) {
  return String(s || "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function removeLocateElements(xml) {
  return String(xml || "").replace(/<locate\b[^>]*\/>/gi, "");
}

function buildLocateTag(groupDisplayName) {
  const g = escapeXmlAttr(groupDisplayName);
  return `<locate enabled="true" requireLogin="false" cot-type="a-h-G" group="${g}" addToMission="false" mission=""/>`;
}

/**
 * Insert <locate> on its own line after <cluster/> when present (matches typical CoreConfig layout).
 * Handles <cluster/><vbm on one line so locate is not glued to cluster or vbm.
 */
function insertLocateInConfig(xml, locateLine) {
  const body = removeLocateElements(xml);

  // <cluster/> and <vbm on the same line (no newline between)
  if (/<cluster\s*\/>\s*<vbm\b/i.test(body)) {
    return body.replace(
      /([ \t]*)<cluster\s*\/>\s*(<vbm\b)/i,
      (_full, spaces, vbmTag) => `${spaces}<cluster/>\n${spaces}${locateLine}\n${spaces}${vbmTag}`
    );
  }

  // <cluster/> with following content on later lines — add locate directly under cluster
  if (/<cluster\s*\/>/i.test(body)) {
    return body.replace(
      /([ \t]*)<cluster\s*\/>/i,
      (full, spaces) => `${spaces}<cluster/>\n${spaces}${locateLine}`
    );
  }

  // No cluster: insert before <vbm>, matching indentation of the vbm line
  if (/<vbm\b/i.test(body)) {
    return body.replace(/(\s*)(<vbm\b)/i, (_full, ws, vbmTag) => {
      const trimmed = String(ws || "");
      const indMatch = trimmed.match(/([ \t]*)$/);
      const indent = indMatch ? indMatch[1] : "    ";
      const prefix = trimmed.slice(0, Math.max(0, trimmed.length - indent.length));
      return `${prefix}${indent}${locateLine}\n${indent}${vbmTag}`;
    });
  }

  return body.replace(/(\s*)<\/Configuration>/i, (_m, indent) => `${locateLine}\n${indent}</Configuration>`);
}

function parseLocateFromXml(xml) {
  const m = String(xml || "").match(/<locate\b([^>]*)\/>/i);
  if (!m) return { enabled: false, group: "" };
  const attrs = m[1] || "";
  const en = /enabled\s*=\s*"([^"]*)"/i.exec(attrs);
  const gr = /group\s*=\s*"([^"]*)"/i.exec(attrs);
  const enabled = String(en?.[1] || "").toLowerCase() === "true";
  const group = unescapeXmlAttr(gr?.[1] || "");
  return { enabled, group };
}

function isSshConfigured() {
  const cfg = takSshSvc.getTakSshConfig();
  return { configured: !!cfg };
}

async function readRemoteCoreConfigXml() {
  const result = await takSshSvc.runRemoteSshCommand(`sudo cat ${CORE_CONFIG_PATH}`, 90000);
  if (!result.ok) {
    throw new Error(result.message || "Failed to read CoreConfig.xml over SSH.");
  }
  return result.stdout || "";
}

async function applyLocateConfiguration({ enabled, groupDisplayName }) {
  const ssh = isSshConfigured();
  if (!ssh.configured) {
    throw new Error("SSH is not configured. Complete the SSH handshake in Settings first.");
  }

  const xml = await readRemoteCoreConfigXml();
  let next;
  if (enabled) {
    const g = String(groupDisplayName || "").trim();
    if (!g) {
      throw new Error("Group name is required when locate is enabled.");
    }
    const locateLine = buildLocateTag(g);
    next = insertLocateInConfig(xml, locateLine);
  } else {
    next = removeLocateElements(xml);
  }

  const writeResult = await takSshSvc.writeRemoteFileViaSudoTee(CORE_CONFIG_PATH, next);
  if (!writeResult.ok) {
    throw new Error(writeResult.message || "Failed to write CoreConfig.xml.");
  }

  const restartResult = await takSshSvc.runRemoteSshCommand("sudo systemctl restart takserver", 120000);
  if (!restartResult.ok) {
    throw new Error(restartResult.message || "CoreConfig.xml was updated but TAK Server restart failed.");
  }

  return { message: "Locate settings applied and TAK Server is currently restarting." };
}

module.exports = {
  CORE_CONFIG_PATH,
  escapeXmlAttr,
  parseLocateFromXml,
  isSshConfigured,
  readRemoteCoreConfigXml,
  applyLocateConfiguration,
};
