import {useEffect, useRef, useState} from 'preact/hooks';
import {connectionRequest} from '../lib/api';
import {schoolDay} from '../lib/day';

type Student = {student_id:string|number; student_name:string};
type Grade = {id:number; student_id:string; student_name:string; class_name:string; subject:string; grade:number; assignment_type:string; comment:string; lesson_date:string; sync_status:'draft'|'synced_sgo'; status_label:string; sync_reason:string};
type Journal = {students:Student[]; grades:Grade[]; has_more:boolean; next_before_id:number|null; roster_note?:string};
type SgoClass = {class_id:number; class_name:string; subjects:{id:number;name:string}[]};
const SUBJECTS=['Алгебра','Геометрия','Физика','Русский язык','Информатика','История','Биология','Химия','Английский язык'];
const WORKS=['Ответ на уроке','Домашнее задание','Самостоятельная работа','Контрольная','Блиц-опрос'];
const reasonText:Record<string,string>={pending:'Отправка не завершена. Сверьте журнал СГО перед повторным вводом.',delivery_unknown:'Ответ СГО не получен. Оценка могла дойти: проверьте СГО. Автоповтора нет.',write_disabled:'Отправка в СГО выключена администратором.',missing_sgo_ids:'Для СГО нужны подтверждённые идентификаторы класса, предмета, ученика, урока и работы.',sgo_not_linked:'Нужен вход в СГО как учитель.',scope_not_verified:'СГО не подтвердил права или принадлежность ученика к классу.',upstream_rejected:'СГО не подтвердил сохранение оценки.'};

export function TeacherGradeJournal(){
 const [className,setClassName]=useState('8А'),[subject,setSubject]=useState('Алгебра');
 const [classes,setClasses]=useState<SgoClass[]>([]),[students,setStudents]=useState<Student[]>([]),[grades,setGrades]=useState<Grade[]>([]);
 const [studentId,setStudentId]=useState(''),[studentName,setStudentName]=useState('');
 const [grade,setGrade]=useState(5),[work,setWork]=useState(WORKS[0]),[comment,setComment]=useState(''),[lessonDate,setLessonDate]=useState(schoolDay());
 const [classmeeting,setClassmeeting]=useState(''),[assignment,setAssignment]=useState(''),[confirmSgo,setConfirmSgo]=useState(false);
 const [writeEnabled,setWriteEnabled]=useState(false),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [before,setBefore]=useState<number|null>(null),[more,setMore]=useState(false);
 const [revision,setRevision]=useState(0);
 const generation=useRef(0),sending=useRef(false),operation=useRef<{key:string;fingerprint:string}|null>(null);
 const selectedClass=classes.find(c=>c.class_name===className),selectedSubject=selectedClass?.subjects.find(s=>s.name===subject);
 const params=()=>new URLSearchParams({class_name:className,subject,...(selectedClass?{class_id:String(selectedClass.class_id)}:{}),...(selectedSubject?{subject_id:String(selectedSubject.id)}:{})});
 useEffect(()=>{
  const c=new AbortController();
  void connectionRequest<{classes:SgoClass[]}>('/api/v1/teacher/sgo/classes',undefined,c.signal).then(d=>{if(!c.signal.aborted)setClasses(d.classes);}).catch(()=>{});
  void connectionRequest<{write_enabled:boolean}>('/api/v1/teacher/sgo/status',undefined,c.signal).then(d=>{if(!c.signal.aborted)setWriteEnabled(d.write_enabled);}).catch(()=>{});
  return()=>c.abort();
 },[]);
 useEffect(()=>{
  const n=++generation.current,c=new AbortController();setLoading(true);setError('');setGrades([]);setStudents([]);setStudentId('');setStudentName('');setConfirmSgo(false);
  void connectionRequest<Journal>('/api/v1/sgo/teacher/journal?'+params(),undefined,c.signal).then(d=>{if(n!==generation.current||c.signal.aborted)return;setGrades(d.grades);setStudents(d.students);setBefore(d.next_before_id);setMore(d.has_more);}).catch(e=>{if(!c.signal.aborted)setError(e instanceof Error?e.message:'Не удалось загрузить журнал');}).finally(()=>{if(n===generation.current)setLoading(false);});
  return()=>c.abort();
 },[className,subject,selectedClass?.class_id,selectedSubject?.id,revision]);
 const loadMore=async()=>{if(!before||busy)return;const n=generation.current,q=params();q.set('before_id',String(before));setBusy(true);try{const d=await connectionRequest<Journal>('/api/v1/sgo/teacher/journal?'+q);if(n!==generation.current)return;setGrades(g=>[...g,...d.grades]);setBefore(d.next_before_id);setMore(d.has_more);}catch(e){setError(String(e instanceof Error?e.message:e));}finally{setBusy(false);}};
 const submit=async()=>{
  if(sending.current||!studentName.trim())return;
  sending.current=true;setBusy(true);setError('');setNotice('');
  const n=generation.current;
  const payload={class_name:className,subject,student_id:studentId||null,student_name:studentName.trim(),grade,assignment_type:work,comment,lesson_date:lessonDate,class_id:selectedClass?.class_id??null,subject_id:selectedSubject?.id??null,classmeeting_id:classmeeting?Number(classmeeting):null,assignment_id:assignment?Number(assignment):null,confirm_sgo:confirmSgo};
  const fingerprint=JSON.stringify(payload);
  if(operation.current?.fingerprint!==fingerprint)operation.current={key:crypto.randomUUID(),fingerprint};
  try{
   const saved=await connectionRequest<Grade>('/api/v1/sgo/teacher/grade',{...payload,operation_id:operation.current.key});
   if(n!==generation.current)return;
   setGrades(g=>[saved,...g.filter(x=>x.id!==saved.id)]);setNotice(saved.status_label+(reasonText[saved.sync_reason]?' · '+reasonText[saved.sync_reason]:''));
   setStudents(s=>s.some(p=>String(p.student_id)===studentId&&p.student_name===studentName.trim())?s:[...s,{student_id:saved.student_id,student_name:studentName.trim()}]);
   operation.current=null;setConfirmSgo(false);
  }catch(e){setError(e instanceof Error?e.message:'Не удалось сохранить. Повторное нажатие безопасно: ключ операции сохранён.');}
  finally{sending.current=false;setBusy(false);}
 };
 const remove=async(id:number)=>{setBusy(true);setError('');try{await connectionRequest('/api/v1/sgo/teacher/grade/'+id,undefined,undefined,'DELETE');setGrades(g=>g.filter(x=>x.id!==id));setNotice('Локальный черновик удалён');}catch(e){setError(e instanceof Error?e.message:'Не удалось удалить');}finally{setBusy(false);}};
 const exportTsv=async()=>{
  setBusy(true);setError('');
  try{
   const rows:Grade[]=[];let cursor:number|null=null;
   do{const q=params();q.set('limit','200');if(cursor)q.set('before_id',String(cursor));const d=await connectionRequest<Journal>('/api/v1/sgo/teacher/journal?'+q);rows.push(...d.grades);cursor=d.has_more?d.next_before_id:null;}while(cursor);
   const safe=(v:unknown)=>{const s=String(v??'').replace(/[\t\r\n]/g,' ');return /^[=+\-@]/.test(s)?"'"+s:s;};
   const data=[['Ученик','Класс','Предмет','Оценка','Тип работы','Комментарий','Дата','Статус'],...rows.map(g=>[g.student_name,g.class_name,g.subject,g.grade,g.assignment_type,g.comment,g.lesson_date,g.status_label])].map(r=>r.map(safe).join('\t')).join('\r\n');
   const url=URL.createObjectURL(new Blob(['\ufeff'+data],{type:'text/tab-separated-values;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='journal.tsv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(e){setError(e instanceof Error?e.message:'Экспорт не выполнен');}finally{setBusy(false);}
 };
 return <section class="screen b-card teacher-grade-journal" aria-labelledby="grade-journal-title">
  <header class="l-v l-g2 mb-4"><p class="eyebrow">ЖУРНАЛ УЧИТЕЛЯ</p><h2 id="grade-journal-title">Журнал и выставление оценок</h2><p class="f-2">Черновики сохраняются в вашей локальной БД приложения. Они не становятся официальными оценками ученика без подтверждения СГО.</p></header>
  <form class="l-v l-g3" onSubmit={e=>{e.preventDefault();void submit();}}>
   <fieldset disabled={busy} class="grade-fields l-v l-g3">
    <div class="grade-grid">
     <label class="field"><span class="field-label">Класс</span><input class="input" list="grade-classes" value={className} required maxLength={20} onInput={e=>setClassName(e.currentTarget.value)}/><datalist id="grade-classes">{Array.from(new Set(['8А','7А','9Б',...classes.map(c=>c.class_name)])).map(c=><option value={c}/>)}</datalist></label>
     <label class="field"><span class="field-label">Предмет</span><input class="input" list="grade-subjects" value={subject} required maxLength={80} onInput={e=>setSubject(e.currentTarget.value)}/><datalist id="grade-subjects">{Array.from(new Set([...SUBJECTS,...(selectedClass?.subjects.map(s=>s.name)??[])])).map(s=><option value={s}/>)}</datalist></label>
    </div>
    <label class="field"><span class="field-label">Ученик из журнала</span><select class="input" value={studentId} onChange={e=>{const id=e.currentTarget.value;setStudentId(id);setStudentName(students.find(s=>String(s.student_id)===id)?.student_name??'');}}><option value="">Указать имя вручную</option>{students.filter(s=>s.student_id).map(s=><option value={String(s.student_id)}>{s.student_name}</option>)}</select></label>
    <label class="field"><span class="field-label">Фамилия и имя ученика</span><input class="input" required maxLength={120} value={studentName} onInput={e=>{setStudentName(e.currentTarget.value);setStudentId('');}}/></label>
    <div role="group" aria-label="Оценка" class="grade-mark-buttons">{[5,4,3,2].map(m=><button type="button" class={`btn ${grade===m?'btn-primary':'btn-secondary'}`} aria-pressed={grade===m} onClick={()=>setGrade(m)}>{m}</button>)}</div>
    <div class="grade-grid"><label class="field"><span class="field-label">Тип работы</span><select class="input" value={work} onChange={e=>setWork(e.currentTarget.value)}>{WORKS.map(w=><option value={w}>{w}</option>)}</select></label><label class="field"><span class="field-label">Дата урока</span><input class="input" type="date" required value={lessonDate} onInput={e=>setLessonDate(e.currentTarget.value)}/></label></div>
    <label class="field"><span class="field-label">Комментарий · необязательно</span><textarea class="input" maxLength={300} value={comment} onInput={e=>setComment(e.currentTarget.value)}/></label>
    <details class="b-card p-3"><summary>Отправка в СГО · дополнительные настройки</summary><p class="f-2 mt-3">{writeEnabled?'Для отправки выберите реального ученика СГО и укажите идентификаторы урока и работы из журнала.':'Отправка в СГО выключена. Оценка сохранится локальным черновиком.'}</p><div class="grade-grid mt-3"><label class="field"><span class="field-label">ID урока СГО</span><input class="input" type="number" min="1" value={classmeeting} onInput={e=>setClassmeeting(e.currentTarget.value)}/></label><label class="field"><span class="field-label">ID работы СГО</span><input class="input" type="number" min="1" value={assignment} onInput={e=>setAssignment(e.currentTarget.value)}/></label></div><label class="l-h l-g3 mt-3"><input type="checkbox" checked={confirmSgo} disabled={!writeEnabled||!selectedClass||!selectedSubject||!studentId||!classmeeting||!assignment} onChange={e=>setConfirmSgo(e.currentTarget.checked)}/><span>Подтверждаю отправку этой оценки в реальный СГО</span></label></details>
    <button type="submit" class="btn btn-primary btn-block" disabled={!studentName.trim()||!className.trim()||!subject.trim()}>{busy?'Сохранение…':confirmSgo?'Выставить оценку и отправить в СГО':'Выставить оценку · сохранить черновик'}</button>
   </fieldset>
  </form>
  {error&&<div role="alert" class="f-bad mt-3"><p>{error}</p><button class="btn btn-secondary mt-2" disabled={busy} onClick={()=>setRevision(r=>r+1)}>Обновить журнал</button></div>}
  <p role="status" aria-live="polite" class="f-2 mt-3">{loading?'Загрузка журнала…':notice}</p>
  <div class="l-h l-btw l-wrap l-g3 mt-6 mb-3"><h3>Выставленные оценки</h3><button class="btn btn-secondary" disabled={busy||loading} onClick={()=>void exportTsv()}>Экспорт TSV для Excel</button></div>
  {!loading&&!grades.length&&<p class="f-2">Оценок пока нет. Укажите ученика и сохраните первую запись.</p>}
  <ul class="grade-records l-v l-g3">{grades.map(g=><li class="b-card p-3" key={g.id}><div class="l-h l-btw l-g3"><div><strong>{g.student_name}</strong><p class="f-2">{g.class_name} · {g.subject}</p></div><strong class="grade-value">{g.grade}</strong></div><p class="mt-2">{g.assignment_type} · {g.lesson_date}</p>{g.comment&&<p class="f-2">{g.comment}</p>}<p class="mt-2"><strong>{g.status_label}</strong></p>{reasonText[g.sync_reason]&&<p class="f-2 mt-2">{reasonText[g.sync_reason]}</p>}{g.sync_status==='draft'&&!['pending','delivery_unknown'].includes(g.sync_reason)&&<button class="btn btn-ghost mt-2" disabled={busy} onClick={()=>void remove(g.id)}>Удалить черновик</button>}</li>)}</ul>
  {more&&<button class="btn btn-secondary btn-block mt-3" disabled={busy} onClick={()=>void loadMore()}>Показать ещё</button>}
 </section>;
}
