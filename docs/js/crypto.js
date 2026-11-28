/**
 * Encrypted backup envelope (AES-256-GCM + PBKDF2-SHA256).
 *
 * The JSON backup is encrypted in the browser before it is downloaded or
 * shared, so a backup file on a USB stick or WhatsApp chat does not expose the
 * shop's customer list. The passphrase never leaves the device.
 */

const MAGIC = 'DXNB1';
const ITERATIONS = 210000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

function toBase64(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(String(text || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function subtle() {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Encrypted backup needs a secure browser context (HTTPS or localhost).');
  }
  return crypto.subtle;
}

async function deriveKey(passphrase, salt) {
  const material = await subtle().importKey(
    'raw',
    new TextEncoder().encode(String(passphrase)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypts a JSON-serialisable object and returns a portable envelope. */
export async function encryptBackup(payload, passphrase) {
  if (!passphrase || String(passphrase).length < 8) {
    throw new Error('Use a backup passphrase of at least 8 characters.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    format: MAGIC,
    version: 1,
    algorithm: 'AES-256-GCM',
    kdf: `PBKDF2-SHA256-${ITERATIONS}`,
    createdAt: new Date().toISOString(),
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(ciphertext),
  };
}

/** Decrypts an envelope produced by encryptBackup. */
export async function decryptBackup(envelope, passphrase) {
  const doc = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  if (!doc || doc.format !== MAGIC) throw new Error('This is not an encrypted Stockpoint backup.');
  const salt = fromBase64(doc.salt);
  const iv = fromBase64(doc.iv);
  const key = await deriveKey(passphrase, salt);
  let plaintext;
  try {
    plaintext = await subtle().decrypt({ name: 'AES-GCM', iv }, key, fromBase64(doc.data));
  } catch {
    throw new Error('Wrong passphrase, or the backup file is damaged.');
  }
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export function isEncryptedBackup(text) {
  try {
    const doc = typeof text === 'string' ? JSON.parse(text) : text;
    return doc?.format === MAGIC;
  } catch {
    return false;
  }
}

export const ENCRYPTED_BACKUP_MAGIC = MAGIC;
