function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function encryptMemoForRecipientLink(memo: string) {
  if (!memo) return null;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(memo)));
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return [encodeBase64Url(iv), encodeBase64Url(rawKey), encodeBase64Url(ciphertext)].join(".");
}

export async function decryptMemoFromRecipientLink(envelope: string, expectedHash: { readonly length: number; readonly [index: number]: number }) {
  const [encodedIv, encodedKey, encodedCiphertext] = envelope.split(".");
  if (!encodedIv || !encodedKey || !encodedCiphertext) throw new Error("The private note link is malformed.");
  const key = await crypto.subtle.importKey("raw", decodeBase64Url(encodedKey), { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64Url(encodedIv) },
    key,
    decodeBase64Url(encodedCiphertext),
  ));
  const memo = new TextDecoder().decode(plaintext);
  const actualHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(memo)));
  if (actualHash.length !== expectedHash.length || actualHash.some((byte, index) => byte !== expectedHash[index])) {
    throw new Error("The private note does not match its payment commitment.");
  }
  return memo;
}

export function memoEnvelopeFromLocation() {
  const value = new URLSearchParams(window.location.hash.slice(1)).get("memo");
  return value || null;
}
