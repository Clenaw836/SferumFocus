/** Bootstrap-only helpers. No private stores or App imports before verified identity. */
import {launchHeaders} from './platform';
import {inSandbox, sandboxHeaders} from './sandbox';
import {trustedApiURL, apiRedirectRejected} from './apiPolicy';
import {preferredDemoRole, type Principal} from './roleContext';
import {BOOT_TIMEOUT_MS, withBootRetries} from './bootNet';
export type BootstrapCode = 'network'|'timeout'|'unauthorized'|'forbidden'|'missing'|'service'|'rate'|'response'|'identity'|'redirect'|'configuration'|'session'|'unknown'|'unavailable'|'launch';
export class BootstrapError extends Error {
  constructor(public readonly code: BootstrapCode) { super(code); }
}
export async function verifyIdentity(signed: string, origin: string, device: string,
  {fetcher = fetch, timeoutMs = BOOT_TIMEOUT_MS}: {fetcher?: typeof fetch; timeoutMs?: number} = {}): Promise<Principal> {
  let url: string;
  try { url = trustedApiURL('/api/v1/webapp/whoami', origin); }
  catch { throw new BootstrapError('configuration'); }
  const c = new AbortController(); const timer = setTimeout(() => c.abort(), timeoutMs);
  try {
    let r: Response;
    const headers: Record<string, string> = inSandbox() ? sandboxHeaders() : {...(device ? {'X-User-Id': device} : {}), 'X-User-Role': preferredDemoRole(), ...launchHeaders(signed)};
    // A header fetch() cannot encode fails locally, before any request: report it as launch data, not «нет сети».
    if (Object.values(headers).some(v => /[^\x20-\x7e]/.test(v))) throw new BootstrapError('launch');
    try { r = await fetcher(url, {redirect: 'manual', signal: c.signal, headers}); }
    catch (e) { throw new BootstrapError(c.signal.aborted ? 'timeout' : e instanceof TypeError && /ISO-8859-1|ByteString|header/i.test(String(e.message)) ? 'launch' : 'network'); }
    if (apiRedirectRejected(r.type, r.status)) throw new BootstrapError('redirect');
    if (!r.ok) throw new BootstrapError(r.status===401 ? 'unauthorized' : r.status===403 ? 'forbidden'
      : [404,405].includes(r.status) ? 'missing' : r.status===429 ? 'rate' : r.status>=500 ? 'service' : 'unavailable');
    let w: unknown;
    try { w = await r.json(); }
    catch { throw new BootstrapError(c.signal.aborted ? 'timeout' : 'response'); }
    if (!w || typeof w !== 'object') throw new BootstrapError('identity');
    const who = w as Principal;
    if (typeof who.user !== 'string' || !who.user || who.user.length>512 || !['max','demo','telegram','web'].includes(who.auth)
      || (signed && who.auth !== (signed.startsWith('telegram:')?'telegram':'max'))) throw new BootstrapError('identity');
    return who;
  } finally { clearTimeout(timer); }
}
/** v2.1: проверка входа с повторами — 10 с на попытку, ещё две попытки через 600 и 1500 мс,
 *  только при сетевом сбое или таймауте. Отказ сервера (401/403/5xx) повторно не запрашивается. */
export function verifyWithRetries(signed: string, origin: string, device: string,
  options: {fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void>} = {}): Promise<Principal> {
  return withBootRetries(timeoutMs => verifyIdentity(signed, origin, device, {fetcher: options.fetcher, timeoutMs}),
    e => e instanceof BootstrapError && (e.code === 'network' || e.code === 'timeout'), options.sleep);
}
export const isTransient = (error: unknown): boolean =>
  error instanceof BootstrapError && (error.code === 'network' || error.code === 'timeout');
const copies: Record<BootstrapCode, {title: string; message: string}> = {
  network: {title:'Связь с сервером заняла больше времени',message:'Сеть ответила не сразу — мы уже сделали несколько попыток. Проверьте интернет и нажмите «Повторить подключение». Ваши данные в безопасности.'},
  timeout: {title:'Связь с сервером заняла больше времени',message:'Сервер не успел ответить даже после повторных попыток. Нажмите «Повторить подключение» — обычно со второго раза всё открывается.'},
  unauthorized: {title:'Нужно подтвердить вход',message:'Сервер не подтвердил вход. Сессия могла закончиться или данные входа не приняты. Открой приложение заново из мессенджера или браузера.'},
  forbidden: {title:'Нет доступа',message:'Сервер отказал в доступе. Открой приложение из мессенджера или браузера с нужной учётной записью. Если отказ повторится, обратись к администратору.'},
  missing: {title:'Сервер приложения не найден',message:'Проверка входа недоступна по этому адресу. Для локального запуска нужен сервер приложения: одного просмотра HTML из архива недостаточно.'},
  service: {title:'Сервис временно недоступен',message:'Сервер не смог выполнить проверку входа. Это не подтверждает проблему с твоей учётной записью. Попробуй позже.'},
  rate: {title:'Слишком много запросов',message:'Подожди немного перед следующей проверкой входа.'},
  response: {title:'Некорректный ответ сервера',message:'Не удалось прочитать ответ проверки входа. Проверь адрес приложения или обратись к администратору.'},
  identity: {title:'Не удалось подтвердить личность',message:'Ответ сервера не подтверждает текущий вход. Личные данные не открыты. Открой приложение заново из мессенджера или браузера.'},
  redirect: {title:'Небезопасное перенаправление',message:'Проверка входа остановлена: сервер предложил перенаправление. Используй исходную ссылку приложения или обратись к администратору.'},
  configuration: {title:'Не удалось безопасно подключиться',message:'Этот адрес не подходит для проверки входа. Используй защищённую ссылку приложения; для локального запуска — адрес из инструкции.'},
  session: {title:'Сессия изменилась',message:'Личные данные скрыты. Открой приложение заново из мессенджера или браузера, чтобы подтвердить текущий вход.'},
  unavailable: {title:'Не удалось проверить вход',message:'Сервер отклонил запрос проверки входа. Попробуй открыть приложение заново или обратись к администратору.'},
  launch: {title:'Данные запуска не переданы',message:'Приложение получило данные запуска в формате, который не удалось отправить на сервер. Личные данные не открыты. Обновите MAX и откройте приложение заново; если повторится — сообщите код диагностики ниже.'},
  unknown: {title:'Не удалось открыть приложение',message:'Запуск не завершён. Попробуй снова или открой приложение заново из мессенджера или браузера. Личные данные не открыты.'},
};
export const recoveryCopy = (error: unknown) => copies[error instanceof BootstrapError ? error.code : 'unknown'];
/** Explicit synthetic-only navigation. Do not carry credentials, API overrides or MAX launch parameters. */
export function demoURL(href: string): string {
  const u = new URL(href); const route = u.hash;
  u.search = '?demo=1'; u.hash = ['#tonight','#tutor','#blitz','#study','#diary','#progress'].includes(route) ? route : '#tonight';
  return u.href;
}

/** Leave offline demonstration with a fresh realm; never reuse its identity/data. */
export function diaryURL(href: string): string {
  const u = new URL(href);
  u.search = '?connect=diary'; u.hash = '#tonight';
  return u.href;
}
