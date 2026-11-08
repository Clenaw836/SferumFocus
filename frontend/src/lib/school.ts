/** Never persist provider credentials or claim unprobed portal availability. */
export type School={school_uid:string;scid?:number;host_id:string;name:string;short_name:string;city:string;region:string;base_url:string;host_status:string;supported_auth_methods:string[];student_display_name?:string;class_name?:string};
export function schoolOrigin(url:string):string{const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname))throw new Error('Нужен HTTPS-адрес без пути и параметров');return u.origin;}
export function hostLabel(status:string):string{return status==='online'?'Сервер ответил на проверку':status==='unavailable'?'Сейчас нет связи с сервером':'Доступность ещё не проверена';}
export function allowedMethod(school:School|null,method:string):boolean{return !!school?.supported_auth_methods.includes(method);}

/** A temporary portal outage must not force a new login while the server retains its grant. */
export function hasDiarySession(connection:{provider?:string;status?:string}|null|undefined):boolean{return connection?.provider==='netschool'&&['connected','temporarily_unavailable'].includes(connection.status||'');}

/** Only a server-confirmed school card can start an external authorization. */
export function schoolOAuthCard(school:School,method:'gosuslugi_esia'|'moya_shkola'='gosuslugi_esia'){
 if(!Number.isSafeInteger(school.scid)||Number(school.scid)<=0)throw new Error('Обновите карточку школы перед входом');
 const u=new URL(school.base_url);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw new Error('Неверный портал школы');
 return {school_uid:school.school_uid,portal_url:school.base_url,scid:school.scid,method};
}
export function oauthTerminal(status:string):boolean{return ['failed','expired','cancelled'].includes(status);}
