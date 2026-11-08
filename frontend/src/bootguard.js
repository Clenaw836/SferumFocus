/* СферумФокус — boot guard (ES5, ~4 КБ). Встраивается ПЕРВЫМ скриптом в <head> и не зависит от основного бандла:
 * если бандл не разобрался (старый WebView), заблокирован CSP, упал до входа или завис, пользователь видит
 * диагностический экран с кодом, а сервер получает обезличенный сигнал (POST /api/v1/diagnostics/boot).
 * Никогда не читает и не отправляет initData, токены, имена или полный User-Agent: только этапы, коды и флаги.
 * Также: polyfill API, которых нет в iOS < 15.4 / Chrome < 92, и ранний WebApp.ready() внутри MAX,
 * чтобы клиент MAX показывал наш экран (загрузка/ошибка с кодом), а не собственную заглушку.
 * build.mjs прогоняет файл через esbuild target=es5 и падает, если синтаксис новее ES5. */
(function () {
  "use strict";
  var w = window, d = document, BUILD = "__SF_BUILD__", ENDPOINT = "/api/v1/diagnostics/boot";
  var SLOW_MS = 12000, READY_POLL_MS = 50, READY_POLL_MAX = 600, BRIDGE_FALLBACK_MS = 8000;
  var S = { v: BUILD, stage: "guard", t0: new Date().getTime(), errors: 0, err: "", res: "", code: "", id: "",
            done: false, shown: false, halted: false, sent: 0, ready: -1, rfb: 0, inMax: false };
  w.__sfBoot = S;
  function ms() { return new Date().getTime() - S.t0; }
  function ss(k, v) {
    try { if (v === undefined) return w.sessionStorage.getItem(k); w.sessionStorage.setItem(k, String(v)); } catch (e) { /* storage disabled */ }
    return null;
  }
  function rid() {
    var hex = "", a, i;
    try { a = new Uint8Array(4); (w.crypto || w.msCrypto).getRandomValues(a); for (i = 0; i < 4; i++) hex += (a[i] < 16 ? "0" : "") + a[i].toString(16); }
    catch (e) { hex = (Math.floor(Math.random() * 4294967295) + 4294967296).toString(16).slice(-8); }
    return hex.toUpperCase();
  }
  S.id = rid();

  /* ---- polyfills: рантайм-база бандла — Safari 15.4 / Chrome 92; здесь — для iOS 14–15.3 и старых WebView */
  function def(o, k, f) { if (o && typeof o[k] !== "function") { try { Object.defineProperty(o, k, { value: f, writable: true, configurable: true, enumerable: false }); } catch (e) { /* frozen */ } } }
  function at(n) {
    var len = this.length >>> 0, i = Number(n) || 0;
    i = i < 0 ? Math.ceil(i) : Math.floor(i);
    if (i < 0) i += len;
    return i < 0 || i >= len ? undefined : this[i];
  }
  def(Array.prototype, "at", at); def(String.prototype, "at", at);
  def(Object, "hasOwn", function (o, k) { return Object.prototype.hasOwnProperty.call(Object(o), k); });
  def(Array.prototype, "findLast", function (f, t) { for (var i = this.length - 1; i >= 0; i--) if (f.call(t, this[i], i, this)) return this[i]; return undefined; });
  def(Array.prototype, "findLastIndex", function (f, t) { for (var i = this.length - 1; i >= 0; i--) if (f.call(t, this[i], i, this)) return i; return -1; });
  if (w.crypto && typeof w.crypto.getRandomValues === "function") def(w.crypto, "randomUUID", function () {
    var b = new Uint8Array(16), h = [], i;
    w.crypto.getRandomValues(b); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    for (i = 0; i < 16; i++) h.push((b[i] + 256).toString(16).slice(1));
    return h.slice(0, 4).join("") + "-" + h.slice(4, 6).join("") + "-" + h.slice(6, 8).join("") + "-" + h.slice(8, 10).join("") + "-" + h.slice(10).join("");
  });

  /* ---- контекст запуска: только флаги/перечисления; подписанная строка не покидает эту функцию */
  function hashParam(k) {
    var parts, i, p, n = 0, val = null;
    try { parts = String(w.location.hash || "").replace(/^#/, "").split("&"); for (i = 0; i < parts.length; i++) { p = parts[i].split("="); if (p[0] === k) { n++; val = p.slice(1).join("="); } } }
    catch (e) { return null; }
    return n === 1 ? val : null;
  }
  var raw = hashParam("WebAppData"), plat = hashParam("WebAppPlatform"), launch = raw ? "hash" : "none", dec = "";
  if (!raw && ss("WebAppData")) launch = "storage"; /* официальный bridge кладёт WebAppData в sessionStorage */
  if (raw) { try { dec = decodeURIComponent(raw); } catch (e) { dec = "\u0000"; } }
  var ascii = dec === "" ? -1 : /^[\x21-\x7e]*$/.test(dec) ? 1 : 0; /* 0 → как есть в заголовок fetch не передать */
  var lenB = !dec ? 0 : dec.length < 512 ? 1 : dec.length < 2048 ? 2 : dec.length < 8192 ? 3 : 4;
  dec = ""; raw = raw ? "1" : "";
  plat = /^(ios|android|desktop|web)$/.test(plat || "") ? plat : plat ? "other" : "";
  var inIframe = false; try { inIframe = w.self !== w.top; } catch (e) { inIframe = true; }
  var inMax = !!(raw || plat || launch === "storage" || w.WebViewHandler);
  S.inMax = inMax;
  function ua() {
    var u = String(navigator.userAgent || ""), m, out = [];
    if ((m = /Android (\d+)/.exec(u))) out.push("android" + m[1]);
    else if ((m = /(?:iPhone|iPad|CPU) OS (\d+)/.exec(u))) out.push("ios" + m[1]);
    else if (/Windows/.test(u)) out.push("win"); else if (/Mac OS X/.test(u)) out.push("mac"); else if (/Linux/.test(u)) out.push("linux"); else out.push("other");
    if ((m = /Chrome\/(\d+)/.exec(u))) out.push("chrome" + m[1]);
    else if ((m = /Version\/(\d+)[.\d]* (?:Mobile\/\w+ )?Safari/.exec(u))) out.push("safari" + m[1]);
    else if ((m = /Firefox\/(\d+)/.exec(u))) out.push("firefox" + m[1]);
    else if (/AppleWebKit/.test(u)) out.push("webkit");
    if (/; wv\)/.test(u)) out.push("wv");
    return out.join("-").slice(0, 40);
  }

  /* ---- сигнал только по разрешённому транспорту, как lib/apiPolicy.ts: HTTPS или HTTP на loopback.
   * На публичном http: — ни одного запроса к API (rc_security_origin: «запрещённый транспорт → 0 запросов API»). */
  function transportOk() {
    var o = "";
    try { o = w.location.origin || (w.location.protocol + "//" + w.location.host); } catch (e) { return false; }
    return /^https:\/\//.test(o) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o);
  }

  /* ---- обезличенный сигнал на сервер: ≤3 за загрузку, ≤12 за сессию вкладки */
  function beacon(kind) {
    var n = +(ss("sf.diag.n") || 0), body;
    if (S.sent >= 3 || n >= 12 || !transportOk()) return;
    ss("sf.diag.n", n + 1); S.sent++;
    body = JSON.stringify({ v: BUILD, id: S.id, kind: kind, stage: S.stage, code: S.code, platform: plat, inmax: inMax ? 1 : 0,
      iframe: inIframe ? 1 : 0, bridge: w.WebApp ? 1 : 0, handler: w.WebViewHandler ? 1 : 0, launch: launch, ascii: ascii, len: lenB,
      ready: S.ready, rfb: S.rfb, ms: ms(), errors: S.errors, err: S.err, res: S.res, ua: ua() });
    try { if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, body)) return; } catch (e) { /* fall back to XHR */ }
    try { var x = new XMLHttpRequest(); x.open("POST", ENDPOINT, true); x.setRequestHeader("Content-Type", "text/plain;charset=UTF-8"); x.send(body); } catch (e) { /* offline */ }
  }
  S.beacon = beacon;

  /* ---- WebApp.ready() как можно раньше и ровно один раз (bridge грузится async и может прийти позже бандла) */
  var readyDone = false;
  function sendReady() {
    if (readyDone || !inMax) return readyDone;
    var wa = w.WebApp;
    if (!wa || typeof wa.ready !== "function" || !d.getElementById("app")) return false;
    try { wa.ready(); readyDone = true; S.ready = ms(); } catch (e) { /* old client */ }
    return readyDone;
  }
  S.sendReady = sendReady;
  (function poll(n) { if (sendReady() || n > READY_POLL_MAX) return; setTimeout(function () { poll(n + 1); }, READY_POLL_MS); })(0);
  /* Официальный max-web-app.js не загрузился (сеть/блокировка st.max.ru): без него клиент MAX не получит
   * WebAppReady и будет держать свою заглушку. Резерв — тот же транспорт, что использует сам bridge
   * (window.WebViewHandler.postEvent в нативном клиенте, postMessage родителю в веб-клиенте). Только событие,
   * без данных; только внутри MAX и только когда window.WebApp так и не появился. */
  setTimeout(function () {
    if (readyDone || !inMax || w.WebApp) return;
    try {
      if (w.WebViewHandler && typeof w.WebViewHandler.postEvent === "function") w.WebViewHandler.postEvent("WebAppReady", "{}");
      else if (inIframe) w.parent.postMessage(JSON.stringify({ type: "WebAppReady" }), "*");
      else return;
      readyDone = true; S.ready = ms(); S.rfb = 1;
    } catch (e) { /* host transport unavailable */ }
  }, BRIDGE_FALLBACK_MS);

  /* ---- экраны guard: полный (бандл не стартовал/зацикливание) и мягкий (долго) */
  function el(tag, text, cls) { var e = d.createElement(tag); if (text) e.appendChild(d.createTextNode(text)); if (cls) e.className = cls; return e; }
  var COPY = {
    bundle_syntax: "Это устройство не смогло выполнить код приложения: вероятно, устарел встроенный браузер (WebView). Обновите MAX и систему, затем откройте приложение снова.",
    bundle_csp: "Браузер заблокировал код приложения политикой безопасности. Обычно это значит, что страницу изменили по пути (прокси, расширение) или развёрнута неполная сборка.",
    bundle_reference: "Код приложения запустился не полностью: в этом браузере нет нужной функции. Обновите MAX и систему.",
    reload_loop: "Приложение перезагружалось слишком часто, поэтому запуск остановлен, чтобы не зациклиться.",
    slow: "Запуск занимает больше обычного. Можно подождать ещё немного или повторить."
  };
  function retryBudget() {
    var now = new Date().getTime(), list = [], i, recent = [];
    try { list = JSON.parse(ss("sf.boot.retry") || "[]"); } catch (e) { list = []; }
    for (i = 0; i < list.length; i++) if (now - list[i] < 120000) recent.push(list[i]);
    return recent;
  }
  function render(code, soft) {
    var root = d.getElementById("app") || d.body, box, title, msg, meta, btn, demo, recent, wait;
    if (!root) return;
    box = el("main", "", "boot-recovery boot-guard"); box.setAttribute("aria-labelledby", "boot-guard-title");
    box.setAttribute("data-boot-stage", S.stage); box.setAttribute("data-error-id", S.id); box.setAttribute("data-boot-code", code);
    title = el("h1", soft ? "Запуск задерживается" : "СферумФокус не запустился"); title.id = "boot-guard-title"; title.tabIndex = -1;
    msg = el("p", COPY[code] || (soft ? COPY.slow : "Запуск не завершён из-за ошибки в браузере. Личные данные не открыты.")); msg.setAttribute("role", soft ? "status" : "alert");
    meta = el("small", "Код диагностики: " + S.id + " · этап: " + S.stage + " · " + code + ". Сообщите код поддержке — личных данных в нём нет.");
    btn = el("button", "Повторить"); btn.type = "button";
    recent = retryBudget();
    if (recent.length >= 3) { btn.disabled = true; wait = el("small", "Было несколько попыток подряд. Подождите минуту и попробуйте снова."); }
    btn.onclick = function () { var r = retryBudget(); r.push(new Date().getTime()); ss("sf.boot.retry", JSON.stringify(r.slice(-5))); btn.disabled = true; btn.textContent = "Проверяем…"; w.location.reload(); };
    demo = el("a", "Открыть демонстрацию"); demo.href = w.location.pathname + "?demo=1#tonight";
    box.appendChild(title); box.appendChild(msg); box.appendChild(btn); if (wait) box.appendChild(wait); box.appendChild(demo); box.appendChild(meta);
    if (soft) { box.className += " boot-guard-soft"; root.appendChild(box); }
    else { while (root.firstChild) root.removeChild(root.firstChild); root.appendChild(box); try { title.focus(); } catch (e) { /* no focus */ } }
  }
  function whenDom(f) { if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", f); else f(); }
  function fail(code) {
    if (S.done || S.shown) return;
    S.shown = true; S.code = code;
    whenDom(function () { render(code, false); sendReady(); });
    beacon("fallback");
  }
  S.fail = fail;

  /* ---- ошибки до старта бандла */
  function kind(msg, e) {
    var m = String(msg || (e && e.message) || ""), n = String((e && e.name) || "");
    if (/ISO-8859-1|ByteString|header/i.test(m)) return "header";
    if (n === "SyntaxError" || /SyntaxError|Unexpected (token|identifier|character|keyword)|Invalid regular expression|Invalid character|invalid group/i.test(m)) return "syntax";
    if (n === "ReferenceError" || /ReferenceError|is not defined|Can't find variable/i.test(m)) return "reference";
    if (n === "TypeError" || /TypeError|is not a function|undefined is not an object|Cannot read propert/i.test(m)) return "type";
    if (n === "RangeError") return "range";
    return "other";
  }
  function onError(ev) {
    var t = ev && ev.target, src;
    if (t && t !== w && t.tagName) {
      if (t.tagName === "SCRIPT") { src = String(t.src || ""); S.res = /st\.max\.ru/.test(src) ? "bridge" : /telegram\.org/.test(src) ? "telegram" : "script"; }
      return; /* ошибка загрузки ресурса, не исключение */
    }
    if (S.done) return;
    if (String(ev && ev.message) === "Script error." || (ev && ev.filename && String(ev.filename).indexOf(w.location.origin) !== 0)) { S.res = S.res || "thirdparty"; return; }
    S.errors++; S.err = kind(ev && ev.message, ev && ev.error);
    if (S.stage === "guard") fail("bundle_" + S.err); /* до lib/bootMark.ts: бандл не разобрался/не стартовал */
  }
  function onRejection(ev) { if (S.done) return; var r = ev && ev.reason; S.errors++; S.err = kind(r && r.message, r); }
  function onCsp(ev) {
    var dir = String((ev && (ev.effectiveDirective || ev.violatedDirective)) || ""), uri = String((ev && ev.blockedURI) || "");
    if (!/^script-src/.test(dir)) return;
    if (uri === "inline" || uri === "") { S.err = "csp"; whenDom(function () { setTimeout(function () { if (S.stage === "guard") fail("bundle_csp"); }, 0); }); }
    else S.res = S.res || "csp";
  }
  try { w.addEventListener("error", onError, true); w.addEventListener("unhandledrejection", onRejection); d.addEventListener("securitypolicyviolation", onCsp); } catch (e) { /* very old engine */ }

  /* ---- защита от циклических перезагрузок: ≥6 загрузок за 20 с БЕЗ действий пользователя — стоп.
   * Касание/клавиша на странице (смена персонажа песочницы, «Обновить», «Повторить») — не цикл: счётчик
   * начинается заново. Сам цикл (приложение или клиент перезагружает страницу без участия человека) — ловится. */
  (function () {
    var now = new Date().getTime(), list = [], i, recent = [];
    if (ss("sf.boot.user") !== "1") { try { list = JSON.parse(ss("sf.boot.loads") || "[]"); } catch (e) { list = []; } }
    ss("sf.boot.user", "0");
    for (i = 0; i < list.length; i++) if (now - list[i] < 20000) recent.push(list[i]);
    recent.push(now); ss("sf.boot.loads", JSON.stringify(recent.slice(-10)));
    if (recent.length >= 6) { S.halted = true; fail("reload_loop"); }
  })();
  function onUser() { if (ss("sf.boot.user") !== "1") ss("sf.boot.user", "1"); }
  try { w.addEventListener("pointerdown", onUser, true); w.addEventListener("keydown", onUser, true); } catch (e) { /* very old engine */ }

  /* ---- API для бандла (lib/bootDiag.ts) */
  S.mark = function (st) { if (!S.done && /^[a-z_]{1,24}$/.test(String(st))) S.stage = String(st); };
  S.recovery = function (code) {
    S.code = /^[a-z_]{1,32}$/.test(String(code)) ? String(code) : "unknown"; S.shown = true;
    beacon("recovery"); sendReady();
  };
  S.ok = function () {
    if (S.done) return;
    S.done = true; S.stage = "done"; sendReady();
    if (inMax && !ss("sf.diag.ok")) { ss("sf.diag.ok", "1"); beacon("ok"); }
  };
  /* ---- сторож: бандл не стартовал совсем — полный экран; стартовал, но долго — мягкая подсказка */
  setTimeout(function () {
    if (S.done || S.shown) return;
    if (S.stage === "guard") { fail("bundle_" + (S.err || "stalled")); return; }
    S.code = "slow_" + S.stage; beacon("slow");
    whenDom(function () { if (!S.done && !S.shown) render("slow", true); });
  }, SLOW_MS);
})();
