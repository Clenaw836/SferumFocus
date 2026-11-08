import {useEffect, useRef, useState} from 'preact/hooks';
import {connectionRequest} from '../lib/api';

type Kind='rubrics'|'feedback'|'plans';
type Criterion={title:string;points:number};
type Block={title:string;minutes:number};
type Rubric={criteria:Criterion[];thresholds:number[]};
type Plan={goal:string;duration:number;blocks:Block[]};
type Tool={id:string;kind:Kind;title:string;data:Rubric|Plan|{body:string};revision:number;updated_at:string};
type Assessment={points:number;maximum:number;percent:number;suggested_mark:number};
const defaultCriteria=():Criterion[]=>[{title:'Понимание условия',points:2},{title:'Ход решения',points:5},{title:'Ответ и оформление',points:3}];
const defaultBlocks=():Block[]=>[{title:'Проверка предыдущей темы',minutes:5},{title:'Объяснение',minutes:10},{title:'Самостоятельная практика',minutes:20},{title:'Разбор ошибок',minutes:7},{title:'Итог и домашнее задание',minutes:3}];
const titles:Record<Kind,string>={rubrics:'Критерии оценивания',feedback:'Банк комментариев',plans:'План урока'};

export function TeacherToolkit(){
 const [kind,setKind]=useState<Kind>('rubrics'),[items,setItems]=useState<Tool[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
 const [title,setTitle]=useState('Проверка письменной работы'),[selected,setSelected]=useState(''),[revision,setRevision]=useState(0);
 const [criteria,setCriteria]=useState<Criterion[]>(defaultCriteria),[thresholds,setThresholds]=useState([50,70,90]),[scores,setScores]=useState([0,0,0]);
 const [body,setBody]=useState('Хорошо получилось: …\nСледующий шаг: …\nПроверьте себя: …');
 const [goal,setGoal]=useState('Сформулируйте, что ученик сможет сделать к концу урока'),[duration,setDuration]=useState(45),[blocks,setBlocks]=useState<Block[]>(defaultBlocks);
 const [assessment,setAssessment]=useState<Assessment|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[confirmDelete,setConfirmDelete]=useState(false);
 const draftId=useRef(''),lock=useRef(false),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;const ctrl=new AbortController();void connectionRequest<{items:Tool[]}>('/api/v1/teacher/tools',undefined,ctrl.signal).then(r=>{if(!ctrl.signal.aborted)setItems(r.items);}).catch(e=>{if(!ctrl.signal.aborted)setError(e instanceof Error?e.message:'Не удалось загрузить шаблоны');}).finally(()=>{if(!ctrl.signal.aborted)setLoading(false);});return()=>{mounted.current=false;ctrl.abort();};},[]);
 const clear=()=>{setError('');setNotice('');setAssessment(null);setConfirmDelete(false);};
 const reset=(next:Kind)=>{setKind(next);setSelected('');setRevision(0);draftId.current='';clear();setTitle(next==='rubrics'?'Проверка письменной работы':next==='feedback'?'Комментарий к работе':'Урок на 45 минут');setCriteria(defaultCriteria());setThresholds([50,70,90]);setScores([0,0,0]);setBody('Хорошо получилось: …\nСледующий шаг: …\nПроверьте себя: …');setGoal('Сформулируйте, что ученик сможет сделать к концу урока');setDuration(45);setBlocks(defaultBlocks());};
 const choose=(id:string)=>{if(!id){reset(kind);return;}const item=items.find(i=>i.id===id&&i.kind===kind);if(!item)return;clear();setSelected(item.id);setRevision(item.revision);setTitle(item.title);draftId.current=item.id;
  if(kind==='rubrics'){const d=item.data as Rubric;setCriteria(d.criteria.map(c=>({...c})));setThresholds([...d.thresholds]);setScores(d.criteria.map(()=>0));}
  if(kind==='feedback')setBody((item.data as {body:string}).body);
  if(kind==='plans'){const d=item.data as Plan;setGoal(d.goal);setDuration(d.duration);setBlocks(d.blocks.map(b=>({...b})));}
 };
 const data=()=>kind==='rubrics'?{criteria,thresholds}:kind==='feedback'?{body}:{goal,duration,blocks};
 const run=async(action:()=>Promise<void>)=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');try{await action();}catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Операция не выполнена');}finally{lock.current=false;if(mounted.current)setBusy(false);}};
 const save=()=>run(async()=>{
  if(!draftId.current)draftId.current=crypto.randomUUID();
  const saved=await connectionRequest<Tool>('/api/v1/teacher/tools/'+kind,{id:draftId.current,title,data:data(),expected_revision:revision});
  if(!mounted.current)return;setItems(list=>[saved,...list.filter(i=>i.id!==saved.id||i.kind!==saved.kind)]);setSelected(saved.id);setRevision(saved.revision);setNotice('Шаблон сохранён в вашем кабинете');
 });
 const remove=()=>run(async()=>{await connectionRequest('/api/v1/teacher/tools/'+kind+'/'+selected+'?revision='+revision,undefined,undefined,'DELETE');if(!mounted.current)return;setItems(list=>list.filter(i=>i.id!==selected||i.kind!==kind));reset(kind);setNotice('Шаблон удалён');});
 const calculate=()=>run(async()=>{const result=await connectionRequest<Assessment>('/api/v1/teacher/tools/assess',{rubric:{criteria,thresholds},scores});if(mounted.current)setAssessment(result);});
 const totalMinutes=blocks.reduce((sum,b)=>sum+(Number.isFinite(b.minutes)?b.minutes:0),0);
 const copy=()=>run(async()=>{const output=kind==='feedback'?body:kind==='plans'?[title,'Цель: '+goal,...blocks.map(b=>b.minutes+' мин — '+b.title),'Всего: '+totalMinutes+' из '+duration+' мин'].join('\n'):[title,...criteria.map((c,i)=>c.title+': '+scores[i]+'/'+c.points),...(assessment?['Итого: '+assessment.points+'/'+assessment.maximum,'Рекомендация: '+assessment.suggested_mark]:[])].join('\n');if(!navigator.clipboard)throw Error('Копирование недоступно в этом браузере. Выделите текст вручную.');await navigator.clipboard.writeText(output);if(mounted.current)setNotice('Текст скопирован. Проверьте его перед отправкой.');});
 const refresh=()=>run(async()=>{const result=await connectionRequest<{items:Tool[]}>('/api/v1/teacher/tools');if(mounted.current){setItems(result.items);setNotice('Список обновлён. Выберите шаблон заново, чтобы загрузить актуальную версию.');}});
 return <section class="tk-workspace" aria-labelledby="tk-title">
  <header><h2 id="tk-title">Инструменты учителя</h2><p>Свои критерии, готовые комментарии и план, который помещается в урок.</p></header>
  <div class="tk-tabs" role="group" aria-label="Инструмент">{(['rubrics','feedback','plans'] as Kind[]).map(k=><button key={k} type="button" aria-pressed={kind===k} disabled={busy} onClick={()=>reset(k)}>{titles[k]}</button>)}</div>
  {error&&<div role="alert" class="tk-error">{error}<button type="button" onClick={()=>void refresh()} disabled={busy}>Обновить список</button></div>}
  <fieldset disabled={busy||loading} class="tk-editor">
   <div class="tk-library"><label>Мои шаблоны<select aria-label="Мои шаблоны" value={selected} onChange={e=>choose(e.currentTarget.value)}><option value="">Новый шаблон</option>{items.filter(i=>i.kind===kind).map(i=><option key={i.id} value={i.id}>{i.title}</option>)}</select></label><button type="button" onClick={()=>reset(kind)}>Создать новый</button></div>
   <label>Название<input aria-label="Название шаблона" value={title} maxLength={100} onInput={e=>setTitle(e.currentTarget.value)}/></label>
   {kind==='rubrics'&&<>
    <div class="tk-section-title"><h3>За что ставим баллы</h3><span>До 8 критериев</span></div>
    {criteria.map((c,i)=><div class="tk-criterion" key={i}><label>Критерий {i+1}<input aria-label={'Критерий '+(i+1)} maxLength={100} value={c.title} onInput={e=>{const value=e.currentTarget.value;setCriteria(list=>list.map((x,n)=>n===i?{...x,title:value}:x));setAssessment(null);}}/></label><label>Максимум<input aria-label={'Максимум '+(i+1)} type="number" min="1" max="20" value={c.points} onInput={e=>{const value=Number(e.currentTarget.value);setCriteria(list=>list.map((x,n)=>n===i?{...x,points:value}:x));setAssessment(null);}}/></label><button type="button" aria-label={'Удалить критерий '+(i+1)} disabled={criteria.length===1} onClick={()=>{setCriteria(list=>list.filter((_,n)=>n!==i));setScores(list=>list.filter((_,n)=>n!==i));setAssessment(null);}}>Убрать</button></div>)}
    <button type="button" class="tk-add" disabled={criteria.length>=8} onClick={()=>{setCriteria(list=>[...list,{title:'Новый критерий',points:1}]);setScores(list=>[...list,0]);setAssessment(null);}}>Добавить критерий</button>
    <div class="tk-thresholds">{thresholds.map((value,i)=><label key={i}>Оценка {i+3}, от %<input aria-label={'Порог для '+(i+3)} type="number" min="1" max="100" value={value} onInput={e=>{const next=Number(e.currentTarget.value);setThresholds(list=>list.map((v,n)=>n===i?next:v));setAssessment(null);}}/></label>)}</div>
    <div class="tk-calculator"><h3>Проверить работу по критериям</h3><p>Введите баллы ученика. Результат не записывается в журнал автоматически.</p><div class="tk-score-fields">{criteria.map((c,i)=><label key={i}>{c.title}<input aria-label={'Набрано по критерию '+(i+1)} type="number" min="0" max={c.points} value={scores[i]??0} onInput={e=>{const next=Number(e.currentTarget.value);setScores(list=>list.map((v,n)=>n===i?next:v));setAssessment(null);}}/></label>)}</div><button type="button" onClick={()=>void calculate()}>Посчитать оценку</button>{assessment&&<output class="tk-result"><strong>{assessment.points} / {assessment.maximum}</strong><span>{assessment.percent}% · рекомендация: {assessment.suggested_mark}</span><small>По вашей шкале. Итоговое решение принимает учитель.</small></output>}</div>
   </>}
   {kind==='feedback'&&<><label>Текст комментария<textarea aria-label="Текст комментария" rows={7} maxLength={2000} value={body} onInput={e=>setBody(e.currentTarget.value)}/></label><p class="tk-note">Сохраните формулировки, которые используете часто. Перед отправкой добавьте конкретный пример из работы. Автоматической рассылки нет.</p></>}
   {kind==='plans'&&<><div class="tk-plan-top"><label>Цель урока<textarea aria-label="Цель урока" rows={2} maxLength={300} value={goal} onInput={e=>setGoal(e.currentTarget.value)}/></label><label>Урок, минут<input aria-label="Длительность урока" type="number" min="10" max="120" value={duration} onInput={e=>setDuration(Number(e.currentTarget.value))}/></label></div>
    {blocks.map((b,i)=><div class="tk-criterion" key={i}><label>Этап {i+1}<input aria-label={'Этап '+(i+1)} maxLength={100} value={b.title} onInput={e=>{const value=e.currentTarget.value;setBlocks(list=>list.map((x,n)=>n===i?{...x,title:value}:x));}}/></label><label>Минут<input aria-label={'Минут на этап '+(i+1)} type="number" min="1" max="120" value={b.minutes} onInput={e=>{const value=Number(e.currentTarget.value);setBlocks(list=>list.map((x,n)=>n===i?{...x,minutes:value}:x));}}/></label><button type="button" aria-label={'Удалить этап '+(i+1)} disabled={blocks.length===1} onClick={()=>setBlocks(list=>list.filter((_,n)=>n!==i))}>Убрать</button></div>)}
    <button type="button" class="tk-add" disabled={blocks.length>=10} onClick={()=>setBlocks(list=>[...list,{title:'Новый этап',minutes:1}])}>Добавить этап</button>
    <p class={totalMinutes>duration?'tk-budget tk-over':'tk-budget'} role="status">{totalMinutes} из {duration} минут · {totalMinutes>duration?'сократите план на '+(totalMinutes-duration)+' мин':'резерв '+(duration-totalMinutes)+' мин'}</p></>}
   <div class="tk-actions"><button type="button" class="tk-primary" onClick={()=>void save()} disabled={kind==='plans'&&totalMinutes>duration}>Сохранить шаблон</button><button type="button" onClick={()=>void copy()}>Копировать {kind==='feedback'?'комментарий':kind==='plans'?'план':'результат'}</button>{selected&&<button type="button" onClick={()=>setConfirmDelete(true)}>Удалить шаблон</button>}</div>
   {confirmDelete&&<div class="tk-confirm"><p>Удалить этот личный шаблон? Оценки и задания останутся без изменений.</p><button type="button" onClick={()=>void remove()}>Да, удалить</button><button type="button" onClick={()=>setConfirmDelete(false)}>Отмена</button></div>}
  </fieldset>
  <p role="status" aria-live="polite" class="tk-status">{loading?'Загружаем личные шаблоны…':notice}</p>
 </section>;
}
