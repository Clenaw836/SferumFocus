/** V23 · Согласие на обработку данных дневника перед подключением (эталон, экран 5 «Подключение СГО», шаг 3 из 3).
 *  Текст описывает только то, что делает код; каждое обещание проверяет tests/test_v23_consent_claims.py
 *  (пароль и его MD5 не попадают в базу и журнал, сессия и копия данных зашифрованы, отключение их удаляет).
 *  Юридическую форму согласия (в том числе для несовершеннолетних) утверждает школа/оператор — см. KNOWN_LIMITATIONS_V23. */
import type { Ref } from "preact";

export const CONSENT_ERROR = "Отметьте согласие на обработку данных дневника";

export function DiaryConsent({ checked, onChange, disabled = false, inputRef, invalid = false }:
  { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; inputRef?: Ref<HTMLInputElement>; invalid?: boolean }) {
  return <div class="diary-consent l-v l-g1">
    <label class="dc-check l-a1 f-b b-tile b-tap">
      <input ref={inputRef} type="checkbox" checked={checked} disabled={disabled} aria-invalid={invalid}
        aria-describedby="dc-note" onChange={(e) => onChange(e.currentTarget.checked)} />
      <span>Я согласен(на) на обработку данных дневника: оценки, расписание и задания нужны для плана вечера и подсказок.</span>
    </label>
    <details class="dc-more" id="dc-note">
      <summary class="f-a">Безопасность данных</summary>
      <ul class="f-2">
        <li>Пароль нужен только для входа и не сохраняется.</li>
        <li>Сессия дневника и копия оценок, расписания и заданий хранятся на сервере в зашифрованном виде.</li>
        <li>Для подсказок тьютора ИИ-сервис получает текст или фото задания и ваш вопрос. Логин, пароль и оценки туда не отправляются.</li>
        <li>Кнопка «Отключить дневник и удалить данные сессии» в профиле удаляет сессию и копию данных.</li>
      </ul>
    </details>
  </div>;
}
