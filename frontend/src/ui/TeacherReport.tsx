import {useEffect, useRef, useState} from 'preact/hooks';
import {connectionRequest} from '../lib/api';

type Person = {student_id:string;student_name:string;class_name:string};
type Context = {demo:boolean;today:string;classes:string[];subjects:string[];students:Person[]};
type Summary = Person & {subject:string;marks:number[];average:number;count:number;drafts:number;review:number};
type Report = {demo:boolean;students:number;count:number;drafts:number;review:number;summary:Summary[];notice:string};
type ExportFile = {filename:string;media_type:string;content_base64:string};
const formats = [['xlsx','Excel .xlsx'],['csv','CSV'],['tsv','TSV'],['json','JSON'],['html','HTML для печати / PDF']];

export function TeacherReport(){
 const [ctx,setCtx]=useState<Context|null>(null),[report,setReport]=useState<Report|null>(null);
 const [className,setClassName]=useState(''),[subject,setSubject]=useState(''),[student,setStudent]=useState('');
 const [start,setStart]=useState(''),[end,setEnd]=useState(''),[status,setStatus]=useState('all'),[search,setSearch]=useState('');
 const [visible,setVisible]=useState(100);
 const [format,setFormat]=useState('xlsx'),[layout,setLayout]=useState('summary');
 const [loading,setLoading]=useState(true),[exporting,setExporting]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[retry,setRetry]=useState(0);
 const mounted=useRef(true),exportLock=useRef(false);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{
  const ctrl=new AbortController();setLoading(true);setError('');
  void connectionRequest<Context>('/api/v1/teacher/reports/context',undefined,ctrl.signal).then(c=>{
   if(ctrl.signal.aborted)return;setCtx(c);setClassName(c.classes[0]??'');setStart(c.today.slice(0,8)+'01');setEnd(c.today);
  }).catch(e=>{if(!ctrl.signal.aborted){setError(e instanceof Error?e.message:'Не удалось открыть табель');setLoading(false);}});
  return()=>ctrl.abort();
 },[retry]);
 const query=()=>new URLSearchParams({class_name:className,subject,student_id:student,date_from:start,date_to:end,status,search});
 useEffect(()=>{
  if(!ctx)return;
  const ctrl=new AbortController();setReport(null);setVisible(100);setError('');setNotice('');
  if(start&&end&&start>end){setError('Дата начала должна быть не позже окончания');setLoading(false);return()=>ctrl.abort();}
  setLoading(true);
  const timer=setTimeout(()=>{
   const q=new URLSearchParams({class_name:className,subject,student_id:student,status,search});
   if(start)q.set('date_from',start);if(end)q.set('date_to',end);
   void connectionRequest<Report>('/api/v1/teacher/reports?'+q,undefined,ctrl.signal).then(d=>{if(!ctrl.signal.aborted)setReport(d);}).catch(e=>{if(!ctrl.signal.aborted)setError(e instanceof Error?e.message:'Не удалось получить табель');}).finally(()=>{if(!ctrl.signal.aborted)setLoading(false);});
  },200);
  return()=>{clearTimeout(timer);ctrl.abort();};
 },[ctx,className,subject,student,start,end,status,search]);
 const download=async()=>{
  if(exportLock.current||loading||!report?.count)return;
  exportLock.current=true;setExporting(true);setError('');setNotice('');
  try{
   const q=query();if(!start)q.delete('date_from');if(!end)q.delete('date_to');q.set('export',format);q.set('layout',layout);
   const file=await connectionRequest<ExportFile>('/api/v1/teacher/reports?'+q);
   if(!mounted.current)return;
   const bytes=Uint8Array.from(atob(file.content_base64),c=>c.charCodeAt(0));
   const url=URL.createObjectURL(new Blob([bytes],{type:file.media_type}));const link=document.createElement('a');link.href=url;link.download=file.filename;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),3000);
   setNotice(format==='html'?'Откройте скачанный HTML и выберите «Печать → Сохранить как PDF».':'Табель скачан. Файл содержит персональные данные: передавайте его только тем, у кого есть право доступа.');
  }catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Не удалось скачать файл');}
  finally{exportLock.current=false;if(mounted.current)setExporting(false);}
 };
 const people=ctx?.students.filter(p=>!className||p.class_name===className)??[];
 return <section class="tr-workspace" aria-labelledby="teacher-report-heading">
  <header class="tr-header"><div><div class="tr-title-row"><h2 id="teacher-report-heading">Табель оценок</h2>{ctx?.demo&&<span class="tr-demo">Демоданные</span>}</div><p>Класс целиком или один ученик. Один период, все оценки под рукой.</p></div><a class="tr-help" href="#report-export">К экспорту <span aria-hidden="true">↓</span></a></header>
  <fieldset class="tr-filters" disabled={exporting}>
   <label><span>Класс</span><select aria-label="Класс" value={className} onChange={e=>{setClassName(e.currentTarget.value);setStudent('');}}><option value="">Все мои классы</option>{ctx?.classes.map(c=><option key={c} value={c}>{c}</option>)}</select></label>
   <label><span>Ученик</span><select aria-label="Ученик" value={student?JSON.stringify([className,student]):''} onChange={e=>{if(!e.currentTarget.value){setStudent('');return;}const [cl,id]=JSON.parse(e.currentTarget.value) as [string,string];setClassName(cl);setStudent(id);}}><option value="">Весь класс</option>{people.map(p=><option key={p.class_name+p.student_id} value={JSON.stringify([p.class_name,p.student_id])}>{p.student_name}{!className?' · '+p.class_name:''}</option>)}</select></label>
   <label><span>Предмет</span><select aria-label="Предмет" value={subject} onChange={e=>setSubject(e.currentTarget.value)}><option value="">Все предметы</option>{ctx?.subjects.map(s=><option key={s} value={s}>{s}</option>)}</select></label>
   <label><span>С даты</span><input aria-label="С даты" type="date" value={start} max={end||undefined} onInput={e=>setStart(e.currentTarget.value)}/></label>
   <label><span>По дату</span><input aria-label="По дату" type="date" value={end} min={start||undefined} onInput={e=>setEnd(e.currentTarget.value)}/></label>
   <label><span>Статус</span><select aria-label="Статус" value={status} onChange={e=>setStatus(e.currentTarget.value)}><option value="all">Все записи</option><option value="draft">Черновики</option><option value="synced_sgo">Подтверждено СГО</option><option value="review">Нужна сверка</option></select></label>
   <label class="tr-search"><span>Поиск ученика</span><input aria-label="Поиск ученика" type="search" placeholder="Фамилия или имя" maxLength={120} value={search} onInput={e=>setSearch(e.currentTarget.value)}/></label>
  </fieldset>
  <div class="tr-metrics" aria-label="Итоги выборки"><div><strong>{report?.students??'—'}</strong><span>учеников</span></div><div><strong>{report?.count??'—'}</strong><span>оценок</span></div><div><strong>{report?.drafts??'—'}</strong><span>черновиков</span></div><div class={report?.review?'tr-attention':''}><strong>{report?.review??'—'}</strong><span>нужна сверка</span></div></div>
  {error&&<div class="tr-message tr-error" role="alert">{error}<button type="button" onClick={()=>setRetry(r=>r+1)} disabled={exporting}>Повторить загрузку</button></div>}
  <div class="tr-table-wrap" tabIndex={0} role="region" aria-label="Табель: прокрутка таблицы" aria-busy={loading}>
   <table class="tr-table"><thead><tr><th scope="col">Ученик / предмет</th><th scope="col">Оценки за период</th><th scope="col">Средний</th><th scope="col">Записи</th></tr></thead><tbody>
    {loading?<tr><td colSpan={4} class="tr-empty" role="status">Загружаем оценки…</td></tr>:error&&!report?<tr><td colSpan={4} class="tr-empty">Табель не построен. Исправьте параметры или повторите загрузку.</td></tr>:report?.summary.length?report.summary.slice(0,visible).map(r=><tr key={r.class_name+r.student_id+r.subject}><th scope="row"><span class="tr-name">{r.student_name}</span><span class="tr-subject">{r.class_name} · {r.subject}</span></th><td><div class="tr-marks">{r.marks.slice(-30).map((m,i)=><span key={i} class={`tr-mark tr-mark-${m}`}>{m}</span>)}</div>{r.marks.length>30&&<small>Последние 30 из {r.count}; все записи — в файле</small>}</td><td class="tr-average">{r.average.toLocaleString('ru-RU',{maximumFractionDigits:2})}</td><td><span>{r.count}</span>{r.review>0?<small class="tr-review">Сверить: {r.review}</small>:<small>{r.drafts?'Черновики: '+r.drafts:'Подтверждено СГО'}</small>}</td></tr>):<tr><td colSpan={4} class="tr-empty"><strong>За этот период записей нет</strong><span>Измените даты, предмет или статус. Отсутствие оценки не означает двойку.</span></td></tr>}
   </tbody></table>
  </div>
  {report&&report.summary.length>visible&&<button type="button" class="tr-more" onClick={()=>setVisible(v=>v+100)}>Показать ещё строки</button>}
  <p class="tr-scrollhint">Прокрутите таблицу по горизонтали, чтобы увидеть все столбцы.</p>
  <p class="tr-footnote">Средний балл справочный, без весов работ. Это не четвертная или годовая оценка. Табель включает только записи приложения.</p>
  <footer class="tr-export" id="report-export"><div><h3>Забрать табель</h3><p>Сводка для просмотра или подробный список для переноса.</p></div><fieldset disabled={exporting||loading||!report?.count}><label><span>Вид</span><select aria-label="Вид" value={layout} onChange={e=>setLayout(e.currentTarget.value)}><option value="summary">Сводный табель</option><option value="details">Каждая оценка отдельно</option></select></label><label><span>Формат</span><select aria-label="Формат" value={format} onChange={e=>setFormat(e.currentTarget.value)}>{formats.map(([value,title])=><option key={value} value={value}>{title}</option>)}</select></label><button type="button" class="tr-download" onClick={()=>void download()}>{exporting?'Готовим файл…':'Скачать табель'}</button></fieldset></footer>
  {notice&&<p class="tr-message" role="status">{notice}</p>}
 </section>;
}
