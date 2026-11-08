import { trustedApiURL } from "./apiPolicy";
import {sameCredential} from './telegramLaunch';
import { closeQuizSession } from "./closeQuizSession";
import { tutorSession } from "./tutorSession";
import { inSandbox, rememberSandboxScope } from "./sandbox";
/** Private storage is bound only by the server bootstrap, before App imports. */
let scope = "unverified";
let credential: string | null = null;
let active = true;
let cleanup: (() => void) | null = null;
export function onIdentityCleanup(fn: () => void): void { cleanup = fn; }
let revoke: (() => void) | null = null;
export const accountKey = (key: string): string => `sf.account.${scope}.${key}`;
export function bindIdentity(namespace: string, signedData: string, onRevoke: () => void): void {
  tutorSession.reset();
  closeQuizSession.reset();
  scope = namespace; credential = signedData; active = true; revoke = onRevoke;
  if (inSandbox()) rememberSandboxScope(namespace);   // erased together with the sandbox (purgeSandboxStorage)
}
export function identityChanged(current: string): boolean { return !active || (credential !== null && !sameCredential(credential, current)); }
export function guardIdentity(current: string): void {
  if (identityChanged(current)) { invalidateIdentity(); throw new Error("Сессия изменилась — открой приложение заново"); }
}
export function invalidateIdentity(): void {
  if (!active) return;
  active = false;
  tutorSession.reset();
  closeQuizSession.reset();
  try { cleanup?.(); } finally { revoke?.(); }
}
/** v2.4 Step 1 · the browser never invents its identity. The anonymous demo profile is a token minted and
 *  signed by the server (POST /api/v1/webapp/device-identity); servers that require a MAX signature refuse
 *  to mint one. Not authorization: it only separates anonymous demo data, and the server verifies it. */
const DEVICE_TOKEN = "sf.browser.device-token.v1";
const LEGACY_DEVICE_ID = "sf.browser.device-id";      // pre-v2.4 client-generated id: no longer sent
const TOKEN_SHAPE = /^sfd1\.[A-Za-z0-9_-]{8,64}\.[A-Za-z0-9_-]{43}$/;
export function browserId(): string {
  try { const t = localStorage.getItem(DEVICE_TOKEN) || ""; return TOKEN_SHAPE.test(t) ? t : ""; }
  catch { return ""; }
}
export function forgetDevice(): void {
  try { localStorage.removeItem(DEVICE_TOKEN); localStorage.removeItem(LEGACY_DEVICE_ID); } catch { /* приватный режим */ }
}
export type MintFailure = "rate" | "network" | "service" | "storage" | null;
let mintFailure: MintFailure = null;
/** Why the last ensureDevice() left the browser without a profile (null = it did not fail). */
export const deviceMintFailure = (): MintFailure => mintFailure;
/** Ask the server for a signed anonymous demo profile once; failure leaves the browser without one. */
export async function ensureDevice(origin: string, fetcher: typeof fetch = fetch): Promise<string> {
  const have = browserId();
  mintFailure = null;
  if (have) return have;
  let url: string;
  try { url = trustedApiURL("/api/v1/webapp/device-identity", origin); } catch { mintFailure = "service"; return ""; }
  try {
    const r = await fetcher(url, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!r.ok) { mintFailure = r.status === 429 ? "rate" : "service"; void r.text().catch(() => undefined); return ""; }   // тело дочитываем: соединение не висит
    let j: unknown;
    try { j = await r.json(); } catch { mintFailure = "service"; return ""; }
    const t = j && typeof j === "object" && typeof (j as { device?: unknown }).device === "string" ? (j as { device: string }).device : "";
    if (!TOKEN_SHAPE.test(t)) { mintFailure = "service"; return ""; }
    try { localStorage.setItem(DEVICE_TOKEN, t); localStorage.removeItem(LEGACY_DEVICE_ID); } catch { /* приватный режим */ }
    if (browserId() !== t) { mintFailure = "storage"; return ""; }
    return t;
  } catch { mintFailure = "network"; return ""; }
}
