import {useEffect, useState} from 'preact/hooks';
import {Icon} from './Icon';
/** One server request includes recognition + hint. No invented OCR percentage/phase. */
export function TutorPending({photo}: {photo: boolean}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 12000);
    return () => clearTimeout(timer);
  }, []);
  const label = photo ? 'Читаю фото и готовлю подсказку' : 'Думаю над подсказкой';
  return <div class={`turn f-b b-card l-rel ai tutor-pending l-h l-top l-g4${photo ? ' with-photo' : ''}`} role="status" aria-label={label} aria-atomic="true">
    {photo && <div class="tutor-scan b-tile l-fix l-rel o-h" aria-hidden="true"><Icon name="image"/><i/><i/><i/><span/></div>}
    <div class="tutor-pending-copy l-grow"><span class="turn-k l-blk f-c f-w6 f-a mb-2">{label}</span>
      <p class="f-2">{slow ? 'Запрос ещё выполняется. Можешь перейти в другой раздел — вернись за ответом, пока приложение открыто.' : photo ? 'Фото уже отправлено. Не нужно загружать его ещё раз.' : 'Начнём с одного наводящего вопроса, а не готового решения.'}</p>
      <div class="hint-skeleton l-v" aria-hidden="true"><i/><i/><i/></div>
    </div>
  </div>;
}
