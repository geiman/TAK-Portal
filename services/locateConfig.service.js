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

function insertLocateBeforeVbm(xml, locateLine) {
  const body = removeLocateElements(xml);
  if (/<vbm\b/i.test(body)) {
    return body.replace(/(\s*)<vbm\b/i, (_m, indent) => `${locateLine}\n${indent}<vbm`);
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
    next = insertLocateBeforeVbm(xml, locateLine);
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
