/** SEC-01: the document origin is the only API authority. Query/meta overrides are not read. */
export function trustedApiURL(path: string, origin: string): string {
  const base = new URL(origin);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (base.username || base.password || !(base.protocol === "https:" || (base.protocol === "http:" && loopback)))
    throw new Error("API requires HTTPS (HTTP is permitted only for loopback development)");
  // Paths are internal route names, never URLs; reject backslashes and URL-normalization escapes.
  if (!path.startsWith("/api/") || /[\\\u0000-\u0020]/.test(path)) throw new Error("Invalid API path");
  const url = new URL(path, base.origin);
  if (url.origin !== base.origin || !url.pathname.startsWith("/api/") || url.username || url.password)
    throw new Error("Untrusted API destination");
  return url.href;
}
export function apiRedirectRejected(type: string, status: number): boolean {
  return type === "opaqueredirect" || (status >= 300 && status < 400);
}
