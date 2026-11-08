/** Entry gate: do not hydrate any private store until server identity is confirmed. */
import "./lib/bootMark";   // FIRST: tells the ES5 boot guard (src/bootguard.js) that the bundle parsed and started
import { applyAppearance } from "./lib/theme";
import { initDefaultLightThemeAndA11y } from "./ui/ThemeAndA11yController";
initDefaultLightThemeAndA11y();
applyAppearance();   // manual theme / high-contrast choice before the first paint (never follows the OS theme)
import { installRadioKeys } from "./lib/radioKeys";
installRadioKeys();   // arrows/Home/End inside role="radiogroup" button groups (APG radio pattern)
import { LIVE, inSandbox, storeSandboxToken } from "./lib/sandbox";
import { whenBridge, ready as hostReady, initData as maxInitData } from "./lib/host";
import { bootStage, bootRecovery, bootHalted, bootInfo } from "./lib/bootDiag";
import {launchCredential as initData,ensureWebSession,telegram,telegramData,sameCredential} from "./lib/platform";
import { DEMO } from "./lib/demo";
import { prefetchInitial } from "./lib/api";
import { startSandbox } from "./lib/demoSession";
import { verifyIdentity, verifyWithRetries, isTransient, BootstrapError, recoveryCopy, demoURL } from "./lib/bootstrap";
// v3.0 · CSS-01 / v3.2 · PERF-01: единое ядро стилей — единственный CSS-импорт (KaTeX подключает lib/aiMarkdown.ts лениво).
import "./design-system-core.css";
import { bindIdentity, browserId, deviceMintFailure, ensureDevice, forgetDevice, identityChanged, invalidateIdentity } from "./lib/identity";

import {configureRole, preferredDemoRole, rolePolicy, roleScope, requestDemoRole} from "./lib/roleContext";
import {mountRole} from "./RoleRoot";
const root = document.getElementById("app")!;
/** Live demo: an ended/expired sandbox is not a broken login — offer a fresh synthetic class. */
function liveCopy(error: unknown): {title: string; message: string} | null {
  if (!LIVE) return null;
  if (error instanceof BootstrapError && error.code === "unauthorized") return {title: "Демо-сессия закончилась", message: "Песочница удалена или истекла. Начните заново — сервер создаст новый вымышленный класс; прежние демо-данные не сохраняются."};
  if (error instanceof Error && !(error instanceof BootstrapError) && error.message) return {title: "Демонстрация не запустилась", message: error.message};
  return null;
}
/** Safe, enumerable failure code for diagnostics (never the message: it may echo server text). */
function failureCode(error: unknown): string {
  if (error instanceof BootstrapError) return error.code;
  if (error instanceof Error && /Неоднозначная среда запуска/.test(error.message)) return "ambiguous";
  if (error instanceof Error && /сессию браузера|ответ сессии/.test(error.message)) return "web_session";
  return "unknown";
}
/** True once a private identity namespace is bound: from then on only a fresh JS realm may retry. */
let bound = false;
let booting = false;
function blocked(error: unknown = new BootstrapError("session")): void {
  root.replaceChildren();
  const copy = liveCopy(error) ?? recoveryCopy(error);
  const diag = bootInfo();
  const expired = LIVE && error instanceof BootstrapError && error.code === "unauthorized";
  const box = document.createElement("main"); box.className = "boot-recovery";
  box.setAttribute("aria-labelledby", "boot-title");
  const title = document.createElement("h1"); title.id = "boot-title"; title.tabIndex = -1; title.textContent = copy.title;
  const message = document.createElement("p"); message.setAttribute("role", "alert"); message.textContent = copy.message;
  const retry = document.createElement("button"); retry.type = "button"; retry.className = "boot-retry";
  retry.textContent = LIVE ? "Начать демонстрацию заново" : "Повторить подключение";
  // v2.1: до привязки личности приватные данные ещё не загружались — повторяем проверку на месте,
  // без перезагрузки WebView (в MAX перезагрузка снова показывает заглушку клиента). После привязки —
  // только чистый JS-realm (reload), чтобы не переиспользовать старые хранилища.
  retry.onclick = () => {
    if (retry.disabled) return;
    retry.disabled = true; retry.textContent = "Подключаемся…"; box.setAttribute("aria-busy", "true");
    if (expired) storeSandboxToken(null);
    if (!bound && !LIVE) { void start(); return; }
    location.reload();
  };
  // Демо — только по явному выбору пользователя, никогда автоматически.
  const demo = document.createElement("a"); demo.className = "boot-demo"; demo.textContent = "Открыть демо-режим"; demo.href = demoURL(location.href);
  const note = document.createElement("small"); note.textContent = "Демо-режим использует вымышленные данные. Это не восстановление личной сессии.";
  box.append(title, message, retry, demo, note);
  if (diag) {
    // P0 MAX: a support-visible code (random, no personal data) and the failed stage; the guard logs the same id server-side.
    box.dataset.errorId = diag.id; box.dataset.bootStage = diag.stage;
    const code = document.createElement("small"); code.className = "boot-code";
    code.textContent = `Код диагностики: ${diag.id} · этап: ${diag.stage} · ${failureCode(error)}`;
    box.append(code);
  }
  root.append(box); title.focus();
  bootRecovery(failureCode(error));
  hostReady();   // MAX must reveal THIS screen instead of its own «Техническая заминка» placeholder
}
/** Первичная проверка: 10 с на попытку и 2 повтора с паузой при сетевой ошибке/таймауте (MAX на мобильной сети). */
const verify = (signed: string) => verifyWithRetries(signed, location.origin, browserId());
/** v2.4 Step 1: an unsigned browser launch first gets a server-signed demo profile; if the server no longer
 *  recognises a stored one (restart with a new key), it is dropped and minted once more. Signed MAX/Telegram
 *  launches and the sandbox never use it. */
async function verifyDevice(signed: string) {
  if (signed || inSandbox()) return verify(signed);
  await ensureDevice(location.origin);
  let who: Awaited<ReturnType<typeof verify>>;
  try { who = await verify(signed); }
  catch (e) {
    if (!(e instanceof BootstrapError) || e.code !== "unauthorized" || !browserId()) throw e;
    forgetDevice();
    await ensureDevice(location.origin);
    who = await verify(signed);
  }
  // Never bind an anonymous browser to the server's shared «demo-user» bucket: without a signed
  // profile the user gets the recovery screen («Повторить подключение»), not someone else's demo data.
  if (who.auth === "demo" && !browserId()) {
    const why = deviceMintFailure();
    throw new BootstrapError(why === "rate" ? "rate" : why === "network" ? "network" : "service");
  }
  return who;
}
/** Фоновая перепроверка: одна попытка; временные сбои сети/сервера не выкидывают пользователя. */
const recheck = (signed: string) => verifyIdentity(signed, location.origin, browserId());
const backgroundTolerated = (error: unknown): boolean =>
  isTransient(error) || (error instanceof BootstrapError && (error.code === "service" || error.code === "rate"));
/** Поздний bridge MAX без данных во фрагменте: одна перезагрузка за сессию, окно 10 с. */
function watchLateBridge(): void {
  let n = 0;
  const id = setInterval(() => {
    if (++n > 100) { clearInterval(id); return; }
    if (!maxInitData()) return;
    clearInterval(id);
    try { if (sessionStorage.getItem("sf.bridge.late")) return; sessionStorage.setItem("sf.bridge.late", "1"); } catch { return; }
    location.reload();
  }, 100);
}
async function boot(): Promise<void> {
  if (bootHalted()) return;   // the guard stopped a reload loop and shows its own screen
  // «Живая демонстрация»: без токена сначала создаём песочницу на сервере (страница перезагрузится).
  if (LIVE && !inSandbox()) { await startSandbox("teacher"); return; }
  bootStage("bridge");
  if(!telegramData()&&!inSandbox()){
    // v3.2 · PERF: MAX кладёт данные запуска во фрагмент URL при каждом запуске — тогда ждём bridge, как раньше
    // (DeviceStorage, ready()). Без них это почти наверняка обычный браузер: ждём ≤ 250 мс, а если bridge
    // всё же принесёт подписанные данные позже, один раз перезагружаемся, чтобы вход через MAX победил.
    if(maxInitData())await whenBridge();
    else{await whenBridge(250);if(!maxInitData())watchLateBridge();}
  }
  // Telegram API only for a Telegram launch: in MAX the async telegram-web-app.js must not post host events.
  if (telegramData()) { try{telegram()?.ready?.();telegram()?.expand?.();}catch{/* host unavailable */} }
  bootStage("launch");
  const signed = initData();
  const localDemo = DEMO || location.protocol === "file:";
  if(!localDemo&&!inSandbox()&&(!signed||signed.startsWith('telegram:'))){bootStage("session");await ensureWebSession(signed);}
  bootStage("verify");
  let who = localDemo ? { auth: "demo", user: "explicit-local-demo", role: preferredDemoRole(), role_source: "demo", role_switch: true } : await verifyDevice(signed);
  if (!sameCredential(initData(), signed)) throw new BootstrapError("session");
  bootStage("role");
  configureRole(who);
  const requested = new URLSearchParams(location.search).get("startapp");
  if ((requested === "teacher" || requested === "student") && rolePolicy(who).canSwitch) {
    requestDemoRole(requested); who = {...who, role:requested}; configureRole(who);
  }
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(roleScope(who.uid?"account":who.auth,who.uid||who.user,rolePolicy(who).role)))))
    .map(x => x.toString(16).padStart(2, "0")).join("");
  if (!sameCredential(initData(), signed)) throw new BootstrapError("session");
  bindIdentity(digest, signed, () => blocked(new BootstrapError("session")));
  bound = true;
  if (rolePolicy(who).role !== "teacher") prefetchInitial();   // v3.2 · PERF: initial-state параллельно с монтированием
  // Credential changes clear rendered private data synchronously, then reload the entire JS realm.
  // No stale component/global store, pending queue or promise is reused by the next identity.
  // Revocation with unchanged credentials stays blocked until explicit retry.
  // Only an actual credential change starts a fresh realm; otherwise 401/403
  // would cause the polling loop to reload forever after active=false.
  // v2.1: MAX may briefly expose an empty or re-serialised initData while the WebView re-attaches the bridge.
  // Empty is not a new user, and one odd read is not a switch: require two consecutive canonical mismatches.
  let mismatches = 0;
  const changed = () => {
    const now = initData();
    if (!now || sameCredential(now, signed)) { mismatches = 0; return; }
    if (++mismatches < 2) return;
    invalidateIdentity(); location.reload();
  };
  setInterval(changed, 200);
  addEventListener("focus", changed); document.addEventListener("visibilitychange", changed);
  if (!localDemo) {
    let checking = false;
    const revalidate = async () => {
      changed(); if (checking || document.hidden || identityChanged(initData())) return;
      checking = true;
      try { const w = await recheck(signed); if (w.auth !== who.auth || w.user !== who.user || rolePolicy(w).role !== rolePolicy(who).role || rolePolicy(w).canSwitch !== rolePolicy(who).canSwitch) { invalidateIdentity(); location.reload(); } }
      catch (error) { if (backgroundTolerated(error)) return; invalidateIdentity(); blocked(error); }
      finally { checking = false; }
    };
    addEventListener("focus", () => void revalidate());
    document.addEventListener("visibilitychange", () => { if (!document.hidden) void revalidate(); });
    setInterval(() => void revalidate(), 30000);
  }
  // v3.2 · PERF-01: тьютор и план дня — независимые хранилища, их серверные копии запрашиваются параллельно.
  if(!localDemo&&who.uid){const {installTutorSync,installDaySync}=await import("./lib/syncs");await Promise.all([installTutorSync(),installDaySync()]);}
  bootStage("render");
  root.replaceChildren();   // an in-place retry leaves the recovery screen in #app
  await mountRole(root);
}
async function start(): Promise<void> {
  if (booting) return;
  booting = true;
  try { await boot(); } catch (error) { blocked(error); } finally { booting = false; }
}
void start();
