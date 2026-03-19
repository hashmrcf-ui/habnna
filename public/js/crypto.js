/**
 * Ameen Crypto — Client-side E2E Encryption using WebCrypto API
 * Uses AES-GCM for message encryption + RSA-OAEP for key exchange
 */

const AmeenCrypto = (() => {
  // Generate RSA key pair for this session
  async function generateKeyPair() {
    return await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['encrypt', 'decrypt']
    );
  }

  // Export public key to base64 string for sharing
  async function exportPublicKey(publicKey) {
    const exported = await crypto.subtle.exportKey('spki', publicKey);
    return btoa(String.fromCharCode(...new Uint8Array(exported)));
  }

  // Import public key from base64 string
  async function importPublicKey(base64Key) {
    const binary = Uint8Array.from(atob(base64Key), c => c.charCodeAt(0));
    return await crypto.subtle.importKey(
      'spki', binary,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false, ['encrypt']
    );
  }

  // Generate symmetric AES-GCM key for a message
  async function generateMessageKey() {
    return await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true, ['encrypt', 'decrypt']
    );
  }

  // Encrypt message with AES-GCM
  async function encryptMessage(text, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(text);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return btoa(String.fromCharCode(...combined));
  }

  // Decrypt message
  async function decryptMessage(b64data, key) {
    try {
      const data = Uint8Array.from(atob(b64data), c => c.charCodeAt(0));
      const iv = data.slice(0, 12);
      const ciphertext = data.slice(12);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      return new TextDecoder().decode(decrypted);
    } catch {
      return null;
    }
  }

  // Encrypt AES key with recipient's RSA public key
  async function encryptKey(aesKey, recipientPublicKey) {
    const exported = await crypto.subtle.exportKey('raw', aesKey);
    const encrypted = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, recipientPublicKey, exported);
    return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
  }

  // Decrypt AES key with our RSA private key
  async function decryptKey(b64key, privateKey) {
    try {
      const data = Uint8Array.from(atob(b64key), c => c.charCodeAt(0));
      const decrypted = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, data);
      return await crypto.subtle.importKey('raw', decrypted, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    } catch {
      return null;
    }
  }

  return { generateKeyPair, exportPublicKey, importPublicKey, generateMessageKey, encryptMessage, decryptMessage, encryptKey, decryptKey };
})();
