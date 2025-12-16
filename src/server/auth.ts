// API key verification

export function verifyApiKey(key: string | null, expectedKey: string): boolean {
  if (!key) return false;
  // Constant-time comparison to prevent timing attacks
  if (key.length !== expectedKey.length) return false;

  let result = 0;
  for (let i = 0; i < key.length; i++) {
    result |= key.charCodeAt(i) ^ expectedKey.charCodeAt(i);
  }
  return result === 0;
}
