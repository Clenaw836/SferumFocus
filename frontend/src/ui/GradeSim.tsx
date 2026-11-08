/**
 * v2.3 · «Калькулятор оценок „Что, если…“» — компактная карточка в «Дневнике» (по референсу v2.3).
 * Раньше (v2.2) это был раскрывающийся блок внутри ленты дневника: он сдвигал расписание вниз.
 * Теперь карточка открывает нижний лист (Sheet) поверх дневника:
 *  • нажатием на карточку (кнопка с aria-haspopup="dialog");
 *  • чипом «Исправить» у предмета со средним ниже 4,0 — сразу к этому предмету;
 *  • кейсом жюри «Ученик: оценка» и маршрутом #grades (App → request).
 * Оценки запрашиваются только при открытии листа (Sheet не монтирует детей, пока закрыт). Лист рендерится в document.body (portal):
 * фон (#panel) получает inert, а лист остаётся доступным.
 */
import { createPortal } from "preact/compat";
import { useEffect, useState } from "preact/hooks";
import { plural } from "../lib/time";
import { GradeRecovery, GradeRecoveryDemo } from "./GradeRecovery";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

/** Запрос «открыть калькулятор» (subject — предмет для прокрутки; at — метка, чтобы повторный запрос сработал). */
export interface SimRequest { subject: string | null; at: number }
export interface SimProps {
  demo: boolean;
  request: SimRequest | null;
  onConsumed: () => void;
  onTutor: (subject: string, topic: string) => void;
  onMission: (subject: string, topic: string) => void;
}

export const GSIM_TITLE = "Калькулятор оценок «Что, если…»";

export function GradeSim({ demo, request, onConsumed, onTutor, onMission, lowCount }: SimProps & { lowCount: number }) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => {
    if (!request) return;
    setFocus(request.subject); setOpen(true);
    onConsumed();
  }, [request?.at]);
  const show = () => { setFocus(null); setOpen(true); };
  // Переход к тьютору или миссии закрывает лист: иначе фон остался бы inert.
  const tutor = (subject: string, topic: string) => { setOpen(false); onTutor(subject, topic); };
  const mission = (subject: string, topic: string) => { setOpen(false); onMission(subject, topic); };
  const meta = lowCount > 0
    ? `${lowCount} ${plural(lowCount, "предмет", "предмета", "предметов")} ниже 4,0 · посчитать план`
    : demo ? "Демо-оценки · посчитать, что нужно для цели" : "Посчитать, что нужно для цели";
  return <section class="gsim mt-3 mb-6" aria-labelledby="gsim-h">
    <h2 class="gsim-h">
      <button type="button" id="gsim-h" class="gsim-sum l-a1a l-g1 l-mid b-card l-w100" aria-haspopup="dialog" onClick={show}>
        <span class="gsim-ico l-center l-g0 f-a s-40 r-md u-sel" aria-hidden="true"><Icon name="target" /></span>
        <span class="gsim-title f-s">{GSIM_TITLE}</span>
        <span class="gsim-meta f-m f-2 f-num l-self-s">{meta}</span>
        <span class="gsim-chev l-center l-g0 f-3" aria-hidden="true"><Icon name="chevron" /></span>
      </button>
    </h2>
    {createPortal(<Sheet open={open} onClose={() => setOpen(false)} eyebrow={demo ? "Дневник · демо-данные" : "Дневник"} title={GSIM_TITLE}>
      <div class="gsim-sheet">
        {demo
          ? <GradeRecoveryDemo onMission={mission} focus={focus} />
          : <GradeRecovery onTutor={tutor} onMission={mission} focus={focus} />}
      </div>
    </Sheet>, document.body)}
  </section>;
}
