import {useState} from 'preact/hooks';
import {connectionRequest} from '../lib/api';
import {principal, roleContext} from '../lib/roleContext';
export function RoleModeSwitch(){
 const w=principal();const [busy,setBusy]=useState(false),[error,setError]=useState('');
 if(!w?.uid||w.auth==='demo'||w.account_role!=='teacher')return null;
 const next=roleContext().role==='teacher'?'student':'teacher';
 const change=async()=>{setBusy(true);setError('');try{await connectionRequest('/api/v1/webapp/role',{role:next});location.reload();}catch(e){setError(e instanceof Error?e.message:'Не удалось сменить режим');setBusy(false);}};
 return <div class="l-v l-g2 mt-3"><button class="btn btn-secondary btn-block" disabled={busy} onClick={()=>void change()}>{busy?'Переключение…':next==='teacher'?'Открыть кабинет учителя':'Открыть режим ученика'}</button>{error&&<p role="alert">{error}</p>}</div>;
}
