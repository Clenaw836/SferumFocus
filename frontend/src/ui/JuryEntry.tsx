import {enterJury} from '../lib/jury';
import {liveURL} from '../lib/demoSession';
/** Две честные демонстрации: автономная копия без сети и живая песочница на настоящем сервере. */
export function JuryEntry(){
  const server=location.protocol==='https:'||location.hostname==='localhost'||location.hostname==='127.0.0.1';
  return <section class="jury-entry b-card mt-4 mb-4" aria-label="Демо для жюри"><button type="button" class="btn btn-primary btn-block" onClick={enterJury}>Быстрый вход для жюри «Идея Фикс» (Демо: Ученик 8А / Учитель)</button><p class="hint-text">Вымышленные данные · без пароля. Роль учителя переключается в профиле. Реальный дневник подключается отдельно.</p>
    {server&&<><button type="button" class="btn btn-secondary btn-block jury-live mt-2" onClick={()=>location.assign(liveURL(location.href))}>Живая демонстрация: учитель → ученик</button>
    <p class="hint-text">На сервере создаётся отдельная песочница: вымышленный учитель выдаёт классу 8А блиц-опрос, ученик проходит его, учитель видит результаты. Данные изолированы и удаляются после демонстрации.</p></>}
  </section>;
}
