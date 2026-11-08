import {useEffect,useRef,useState} from "preact/hooks";
import {api,ApiError} from "../lib/api";
import type {TmResults} from "../lib/teacherTypes";
import {analyticsRows,lessonSuggestions} from "../lib/classAnalytics";
import {transition} from "../lib/motion";
import {Icon} from "../ui/Icon";

export function ClassAnalytics({cls,subject,supplied,allowed=true}:{cls:string;subject:string;supplied?:TmResults;allowed?:boolean}) {
 const [state,setState]=useState<{data?:TmResults;error?:string}>({});const [retry,setRetry]=useState(0);
 const content=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(supplied||!allowed)return;let active=true;setState({});void api.tm.results(cls,subject,"best").then(data=>{if(active)setState({data});}).catch(e=>{if(active)setState({error:e instanceof ApiError?e.message:"Аналитика недоступна"});});return()=>{active=false;};},[cls,subject,retry,supplied,allowed]);
 const r=supplied??state.data;
 useEffect(()=>{if(content.current)void transition(content.current,{opacity:[0,1],y:[6,0]},"mid");},[r?.check?.id,cls,subject]);
 const quality={ok:"Ошибки: 0–25 %",warn:"Ошибки: 26–50 %",bad:"Ошибки: 51–100 %",muted:"Нет ответов"};
 return <section tabIndex={0} class="class-analytics" aria-label={`Аналитика ${cls}, ${subject}`}>
  <div class="analytics-context l-h f-b f-2 mt-1 mb-4"><Icon name="chart" /><span>{cls} · {subject}</span></div>
  {!allowed?<div class="empty"><Icon name="lock" /><h3>Нет доступа</h3><p class="f-2">Нет права просмотра результатов этого класса и предмета. Доступ определяет сервер школы.</p></div>:state.error?<div class="empty" role="alert"><Icon name="wifiOff" /><h3>Аналитика недоступна</h3><p class="f-2">{state.error}</p><button class="btn btn-secondary" onClick={()=>setRetry(retry+1)}>Повторить</button></div>:!r?<div role="status" class="analytics-loading"><p>Загружаем аналитику…</p><div aria-hidden="true" class="sk" /><div aria-hidden="true" class="sk" /></div>:!r.available?<div class="empty"><Icon name="chart" /><h3>Нет данных</h3><p class="f-2">{r.reason??"Нужны результаты проверки этого класса и предмета."}</p></div>:<div ref={content} class="analytics-content">
   <header class="analytics-header">
    {r.is_demo&&<p class="teacher-demo-note f-m b-card mb-3"><b>DEMO · синтетические результаты</b></p>}
    <div class="eyebrow">Вопросы мини-проверки</div><h3 class="h-title">Что стоит повторить</h3>
    <p class="tm-small f-m faint">{r.check.title} · {r.check.date}</p>
    <dl class="analytics-summary l-h l-wrap l-g6 mt-4 mb-3"><div><dt>Ответили</dt><dd class="num f-w6">{r.responded}<span> из {r.class_size}</span></dd></div><div><dt>Вопросов</dt><dd class="num f-w6">{r.questions.length}</dd></div></dl>
    <p class="analytics-caveat l-h l-top f-2 tm-small f-m"><Icon name="info" />{r.caveat}</p>
   </header>
   <p class="tm-small f-m analytics-key f-2 mb-2">Цвет — доля ошибок; число — % верных ответов.</p>
   <details class="analytics-legend mt-4"><summary>Как читать карту<Icon name="chevron" /></summary><p class="tm-small f-m f-2">Цвет — доля ошибок: зелёный 0–25 %, жёлтый 26–50 %, красный 51–100 %. Серый — нет ответов. Число в ячейке — доля верных ответов.</p></details>
   <ul class="analytics-map l-fit l-g3 mt-4 mb-6">{analyticsRows(r).map(q=><li key={q.id} class={`analytics-cell l-v b-card t-${q.tone}`}>
    <div class="analytics-cell-head l-h l-base l-btw l-wrap l-g1"><b>{q.text}</b><span class="analytics-quality f-m f-2">{quality[q.tone]}</span></div>
    <span class="analytics-topic f-b f-2">{q.topic&&q.topic_link_confirmed?q.topic:"Тема не подтверждена"}</span>
    <strong class="analytics-pct f-xl num">{q.correct_pct==null||q.answered<=0?"Нет данных":<>{q.correct_pct}<span class="f-2"> % верно</span></>}</strong>
    {q.correct_pct!=null&&q.answered>0&&<div class="analytics-meter r-xs" aria-hidden="true"><span><i style={{transform:`scaleX(${q.correct_pct/100})`}} /></span></div>}
    <span class="tm-small f-m faint">Ответов: {q.answered}</span>
   </li>)}</ul>
   <section class="analytics-next pt-2"><div class="eyebrow">От данных к действию</div><h3 class="h-sec">На следующий урок</h3><p class="faint tm-small f-m">Предложения по одной проверке, не педагогический диагноз.</p>
   {r.insufficient?<p class="teacher-demo-note f-m b-card mb-3">Недостаточно ответов для рекомендаций. Нужна более полная проверка класса.</p>:lessonSuggestions(r).length?<ul class="analytics-recs l-v l-g3 mt-4 mb-4">{lessonSuggestions(r).map(q=><li key={q.id}><Icon name="book" /><div><b>Повторить: {q.topic}</b><p class="analytics-basis f-2">Основание: {q.correct_pct} % верных ответов; ответов {q.answered}, {q.text.toLowerCase()}.</p><p>Цель: проверить понимание темы «{q.topic}». Возможная практика: разобрать один пример вместе и предложить аналогичный для самостоятельной проверки.</p></div></li>)}</ul>:<p class="tm-small f-m">Нет достаточных связанных с темами данных для конкретной рекомендации. Проверьте связь вопросов с темами и полноту ответов.</p>}
   </section>
  </div>}
 </section>;
}
