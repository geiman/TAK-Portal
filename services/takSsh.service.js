/**
 * services/takSsh.service.js
 *
 * Run makeCert.sh on the TAK server via SSH when creating an integration user.
 * Used so that nodered-* integration users get a client cert on the TAK server.
 *
 * Settings (all optional; if not set, cert creation is skipped):
 *   TAK_SSH_HOST       SSH host (default: hostname from TAK_URL)
 *   TAK_SSH_PORT       SSH port (default: 22)
 *   TAK_SSH_USER       SSH username (must be able to sudo -u tak)
 *   TAK_SSH_PRIVATE_KEY_PATH   Path to PEM private key file
 *   TAK_SSH_PASSPHRASE Optional passphrase for encrypted key
 *
 * Command run on server: sudo -u tak bash -c 'cd /opt/tak/certs && ./makeCert.sh client <username>'
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const childProcess = require("child_process");
const { Client } = require("ssh2");
const { getString, getInt, getBool } = require("./env");
const settingsSvc = require("./settings.service");

const DATA_SSH_DIR = path.join(__dirname, "..", "data", "ssh");
const DEFAULT_PRIVATE_KEY_PATH = path.join(DATA_SSH_DIR, "tak_ssh_ed25519");
const DEFAULT_PUBLIC_KEY_PATH = path.join(DATA_SSH_DIR, "tak_ssh_ed25519.pub");

function resolvePathMaybe(p) {
  if (!p || !String(p).trim()) return null;
  const raw = String(p).trim();
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function quoteForSingleQuotedShell(str) {
  return String(str || "").replace(/'/g, "'\"'\"'");
}

function getTakUrlHostname() {
  const raw = String(getString("TAK_URL", "")).trim();
  if (!raw) return null;
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

/**
 * @returns { { host, port, username, privateKey, passphrase? } | null }
 *   Config for SSH, or null if SSH is not configured (skip cert creation).
 */
function getTakSshConfig() {
  let keyPath = resolvePathMaybe(getString("TAK_SSH_PRIVATE_KEY_PATH", ""));
  if (!keyPath && fs.existsSync(DEFAULT_PRIVATE_KEY_PATH)) {
    keyPath = DEFAULT_PRIVATE_KEY_PATH;
  }
  if (!keyPath || !fs.existsSync(keyPath)) return null;

  let privateKey;
  try {
    privateKey = fs.readFileSync(keyPath, "utf8");
  } catch (err) {
    console.warn("[TAK SSH] Could not read private key:", err?.message || err);
    return null;
  }

  const username = String(getString("TAK_SSH_USER", "")).trim();
  if (!username) return null;

  let host = String(getString("TAK_SSH_HOST", "")).trim();
  if (!host) host = getTakUrlHostname();
  if (!host) return null;

  const port = getInt("TAK_SSH_PORT", 22) || 22;
  const passphrase = getString("TAK_SSH_PASSPHRASE", "").trim() || undefined;

  return { host, port, username, privateKey, passphrase };
}

function getLocalKeyStatus() {
  const privateKeyPath = resolvePathMaybe(getString("TAK_SSH_PRIVATE_KEY_PATH", "")) || DEFAULT_PRIVATE_KEY_PATH;
  const publicKeyPath = resolvePathMaybe(getString("TAK_SSH_PUBLIC_KEY_PATH", "")) || DEFAULT_PUBLIC_KEY_PATH;
  const hasPrivateKey = fs.existsSync(privateKeyPath);
  const hasPublicKey = fs.existsSync(publicKeyPath);

  return {
    privateKeyPath: path.relative(process.cwd(), privateKeyPath).replace(/\\/g, "/"),
    publicKeyPath: path.relative(process.cwd(), publicKeyPath).replace(/\\/g, "/"),
    hasPrivateKey,
    hasPublicKey,
    hasKeyPair: hasPrivateKey && hasPublicKey,
  };
}

function ensureLocalSshKeyPair() {
  ensureDir(DATA_SSH_DIR);

  if (fs.existsSync(DEFAULT_PRIVATE_KEY_PATH) && fs.existsSync(DEFAULT_PUBLIC_KEY_PATH)) {
    return getLocalKeyStatus();
  }

  // Prefer OpenSSH-native key generation so the .pub file format is always
  // valid for authorized_keys across Node versions/platforms.
  try {
    childProcess.execFileSync(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-f", DEFAULT_PRIVATE_KEY_PATH, "-C", "tak-portal"],
      { stdio: "ignore" }
    );
  } catch (err) {
    // Fallback if ssh-keygen is unavailable: generate private key in PEM and
    // derive authorized_keys-compatible public key from it.
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ format: "pem", type: "pkcs8" });
    fs.writeFileSync(DEFAULT_PRIVATE_KEY_PATH, String(privatePem), { mode: 0o600 });

    const pemToOpenSSH = childProcess.spawnSync(
      "ssh-keygen",
      ["-y", "-f", DEFAULT_PRIVATE_KEY_PATH],
      { encoding: "utf8" }
    );
    if (pemToOpenSSH.status !== 0 || !String(pemToOpenSSH.stdout || "").trim()) {
      throw new Error("Failed to generate OpenSSH public key (ssh-keygen required).");
    }
    fs.writeFileSync(DEFAULT_PUBLIC_KEY_PATH, String(pemToOpenSSH.stdout).trim() + "\n", { mode: 0o644 });
  }

  // Keep settings pointed at generated keys so they survive restart/redeploy.
  const current = settingsSvc.getSettings() || {};
  const next = { ...current };
  next.TAK_SSH_PRIVATE_KEY_PATH = path.relative(process.cwd(), DEFAULT_PRIVATE_KEY_PATH).replace(/\\/g, "/");
  next.TAK_SSH_PUBLIC_KEY_PATH = path.relative(process.cwd(), DEFAULT_PUBLIC_KEY_PATH).replace(/\\/g, "/");
  settingsSvc.saveSettings(next);

  return getLocalKeyStatus();
}

function execOverSsh(connectConfig, command, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const conn = new Client();
    let finished = false;
    const done = (payload) => {
      if (finished) return;
      finished = true;
      clearTimeout(t);
      try {
        conn.end();
      } catch (_) {}
      resolve(payload);
    };

    const t = setTimeout(() => {
      done({ ok: false, message: "SSH command timed out.", stdout: "", stderr: "", exitCode: null });
    }, timeoutMs);

    conn
      .on("keyboard-interactive", (name, instructions, instructionsLang, prompts, finish) => {
        if (connectConfig && connectConfig.password) {
          finish([String(connectConfig.password)]);
          return;
        }
        finish([]);
      })
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            done({ ok: false, message: err.message || String(err), stdout: "", stderr: "", exitCode: null });
            return;
          }

          let stdout = "";
          let stderr = "";
          stream.on("data", (data) => {
            stdout += data.toString();
          });
          stream.stderr.on("data", (data) => {
            stderr += data.toString();
          });
          stream.on("close", (code) => {
            const exitCode = Number.isInteger(code) ? code : null;
            if (exitCode !== 0) {
              done({
                ok: false,
                message: stderr.trim() || stdout.trim() || `Exit code ${exitCode}`,
                stdout,
                stderr,
                exitCode,
              });
              return;
            }
            done({ ok: true, stdout, stderr, exitCode: 0 });
          });
        });
      })
      .on("error", (err) => {
        done({ ok: false, message: err.message || String(err), stdout: "", stderr: "", exitCode: null });
      })
      .connect(connectConfig);
  });
}

async function onboardTakSshWithPassword({ host, port, username, password }) {
  const h = String(host || "").trim();
  const u = String(username || "").trim();
  const p = String(password || "");
  const sshPort = Number.parseInt(String(port || "22"), 10) || 22;

  if (!h) throw new Error("Target host is required.");
  if (!u) throw new Error("SSH username is required.");
  if (!p) throw new Error("SSH password is required for first-time handshake.");

  const keyStatus = ensureLocalSshKeyPair();
  const pubKeyAbs = path.resolve(process.cwd(), keyStatus.publicKeyPath);
  const pubKey = fs.readFileSync(pubKeyAbs, "utf8").trim();
  if (!pubKey) throw new Error("Generated public key is empty.");

  const safePub = quoteForSingleQuotedShell(pubKey);
  const addKeyCommand =
    "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys; " +
    `grep -qxF '${safePub}' ~/.ssh/authorized_keys || echo '${safePub}' >> ~/.ssh/authorized_keys`;

  const result = await execOverSsh(
    {
      host: h,
      port: sshPort,
      username: u,
      password: p,
      readyTimeout: 15000,
      tryKeyboard: true,
    },
    addKeyCommand
  );

  if (!result.ok) {
    throw new Error(result.message || "SSH handshake failed.");
  }

  const current = settingsSvc.getSettings() || {};
  settingsSvc.saveSettings({
    ...current,
    TAK_SSH_HOST: h,
    TAK_SSH_PORT: String(sshPort),
    TAK_SSH_USER: u,
    TAK_SSH_ONBOARDED: "true",
    TAK_SSH_LAST_HANDSHAKE_AT: new Date().toISOString(),
    TAK_SSH_PRIVATE_KEY_PATH: keyStatus.privateKeyPath,
    TAK_SSH_PUBLIC_KEY_PATH: keyStatus.publicKeyPath,
  });

  return {
    ok: true,
    keyStatus: getLocalKeyStatus(),
    message: "SSH key installed on remote server. Handshake complete.",
  };
}

async function runRemoteSshCommand(command) {
  const raw = String(command || "").trim();
  if (!raw) {
    return { ok: false, message: "Command is required.", stdout: "", stderr: "", exitCode: null };
  }
  const cfg = getTakSshConfig();
  if (!cfg) {
    return {
      ok: false,
      message: "SSH is not configured. Complete the SSH handshake in Settings first.",
      stdout: "",
      stderr: "",
      exitCode: null,
    };
  }

  return execOverSsh(
    {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      privateKey: cfg.privateKey,
      passphrase: cfg.passphrase,
      readyTimeout: 15000,
    },
    raw
  );
}

/**
 * Run on TAK server: sudo -u tak bash -c 'cd /opt/tak/certs && ./makeCert.sh client <username>'
 * @param {string} username - Integration username (e.g. nodered-aircraft-all)
 * @returns { Promise<{ ok: boolean, skipped?: boolean, message?: string }> }
 */
function createTakClientCertForIntegration(username) {
  const TAK_DEBUG = getBool("TAK_DEBUG", false);
  const bypass = getBool("TAK_BYPASS_ENABLED", false);
  if (bypass) {
    return Promise.resolve({ ok: false, skipped: true, message: "TAK bypass enabled." });
  }

  const un = String(username || "").trim();
  if (!un) return Promise.resolve({ ok: false, message: "Username required." });

  const config = getTakSshConfig();
  if (!config) {
    return Promise.resolve({
      ok: false,
      skipped: true,
      message: "TAK SSH not configured (set TAK_SSH_USER and TAK_SSH_PRIVATE_KEY_PATH).",
    });
  }

  // Safe for shell: single-quote wrapped; username is alphanumeric + hyphens only for integrations
  const safeName = un.replace(/'/g, "'\"'\"'");
  const command = `sudo -u tak bash -c 'cd /opt/tak/certs && ./makeCert.sh client ${safeName}'`;

  if (TAK_DEBUG) console.log("[TAK SSH] Connecting to", config.host + ":" + config.port, "as", config.username);

  return execOverSsh(
    {
      host: config.host,
      port: config.port,
      username: config.username,
      privateKey: config.privateKey,
      passphrase: config.passphrase,
      readyTimeout: 15000,
    },
    command
  ).then((result) => {
    if (!result.ok) return { ok: false, message: result.message };
    if (TAK_DEBUG) console.log("[TAK SSH] makeCert.sh succeeded for", un);
    return { ok: true };
  });
}

module.exports = {
  getLocalKeyStatus,
  ensureLocalSshKeyPair,
  onboardTakSshWithPassword,
  runRemoteSshCommand,
  getTakSshConfig,
  createTakClientCertForIntegration,
};
