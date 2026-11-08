import {DEMO, resetDemo} from "./lib/demo";
import {render} from "preact";
import {useEffect, useState} from "preact/hooks";
import {invalidateIdentity} from "./lib/identity";
import {requestDemoRole, principal} from "./lib/roleContext";
import {TeacherToolkit} from './ui/TeacherToolkit';
import {TeacherReport} from './ui/TeacherReport';
import {TeacherGradeJournal} from "./ui/TeacherGradeJournal";
import {Teacher} from "./screens/Teacher";
import {Toaster} from "./ui/Toast";
import {ready, setupViewport, withLaunch} from "./lib/host";
import {bootOk} from "./lib/bootDiag";
import {verifiedProfile} from "./ui/ProfileSettings";
import {BrandBar} from "./ui/BrandBar";
import {SandboxBar} from "./ui/SandboxBar";
import {DiaryWelcome} from "./ui/DiaryWelcome";
import {DiaryOverviewCard} from "./ui/DiaryOverviewCard";
import {inSandbox} from "./lib/sandbox";
import {profileAccount} from "./lib/profileSync";
import {JuryDrawer} from "./ui/JuryDrawer";
import {liveURL, startSandbox, switchPersona} from "./lib/demoSession";
import {diaryURL} from "./lib/bootstrap";
import {toast} from "./ui/Toast";

/** Рабочее место учителя: аватар в верхней панели открывает профиль (как у ученика). */
function TeacherRoot({onStudent}: {onStudent: () => void}) {
  const [me, setMe] = useState(false);
  const [jury, setJury] = useState(false);
  const [pane,setPane]=useState<'work'|'report'|'tools'|'journal'>('work');
  useEffect(()=>{const follow=()=>{if(location.hash.startsWith('#teacher-'))setPane('work');};window.addEventListener('hashchange',follow);return()=>window.removeEventListener('hashchange',follow);},[]);
  const [name, setName] = useState<string | null>(verifiedProfile()?.full_name ?? null);
  // v2.1 · B3 «Демо для жюри»: ученик — сразу Дневник (What-If → 15-минутная миссия); учитель — задания (песочница) или день.
  const juryStudent = () => {
    setJury(false);
    if (inSandbox()) { void switchPersona("s1").catch(() => toast("Не удалось открыть ученика — попробуйте ещё раз", "warn")); return; }
    if (requestDemoRole("student")) { invalidateIdentity(); location.hash = withLaunch("grades"); location.reload(); }
  };
  const juryTeacher = () => { setPane('work');setJury(false); location.hash = withLaunch(inSandbox() ? "teacher-assignments" : "teacher-today"); };
  const live = DEMO && (location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname));
  return <div class="app teacher-workspace"><BrandBar context="Учитель" name={name} fallback="Учитель" onProfile={() => {setPane('work');setMe(true);}} jury={DEMO || inSandbox() ? { onOpen: () => setJury(true), demo: DEMO, who: DEMO ? "DEMO · Учитель" : null } : undefined}/><DiaryWelcome enabled={!inSandbox() && profileAccount()} role="teacher"/><SandboxBar /><nav class="teacher-sections" aria-label="Разделы кабинета"><button type="button" aria-pressed={pane==='work'} onClick={()=>setPane('work')}>Урок и задания</button>{(inSandbox()||!!principal()?.uid)&&<><button type="button" aria-pressed={pane==='report'} onClick={()=>setPane('report')}>Табель</button><button type="button" aria-pressed={pane==='tools'} onClick={()=>setPane('tools')}>Инструменты</button></>}{!DEMO&&!inSandbox()&&!!principal()?.uid&&<button type="button" aria-pressed={pane==='journal'} onClick={()=>setPane('journal')}>Журнал оценок</button>}</nav><main id="panel">{pane==='report'&&<TeacherReport/>}{pane==='tools'&&<TeacherToolkit/>}{pane==='journal'&&<TeacherGradeJournal/>}{pane==='work'&&<Teacher workspace onSwitchRole={onStudent} profileOpen={me} onProfileOpen={setMe} onName={setName} journal={<DiaryOverviewCard enabled={!inSandbox() && profileAccount()}/>}/>}</main>
    {(DEMO || inSandbox()) && <JuryDrawer open={jury} onClose={() => setJury(false)} onStudent={juryStudent} onTeacher={juryTeacher} current="teacher"
      sgoHref={DEMO ? diaryURL(location.href) : undefined} onReset={() => { setJury(false); if (inSandbox()) { void startSandbox("teacher").catch(() => toast("Не удалось начать заново — попробуйте ещё раз", "warn")); return; } resetDemo(); try { sessionStorage.removeItem("demo:launched"); } catch { /* нет sessionStorage */ } location.reload(); }}
      teacherNote={DEMO ? "Автономная копия: день учителя, подготовка и аналитика класса. Выдача заданий со статусами — в живой демонстрации на сервере" : "Раздел «Задания»: выдача классу, статусы учеников, дубль · отзыв · архив без перезагрузки"}
      onLive={live ? () => location.assign(liveURL(location.href)) : undefined}/>}<Toaster /></div>;
}


/** v3.2 · PERF-01: учительский режим — отдельный чанк; ученик его не скачивает. */
export function mountTeacher(root: HTMLElement): void {
  setupViewport(); ready();
  const student = () => { if (requestDemoRole("student")) { invalidateIdentity(); location.hash = withLaunch("tonight"); location.reload(); } };
  render(<TeacherRoot onStudent={student}/>, root);
  bootOk();
}
