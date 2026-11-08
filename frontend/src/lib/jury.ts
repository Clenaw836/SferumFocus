import {demoURL} from './bootstrap';
/** Explicit isolated local fixture; never issues or escalates a server identity. */
export function juryURL(href:string):string{const u=new URL(demoURL(href));u.searchParams.set('jury','1');return u.href;}
export function enterJury():void{try{sessionStorage.setItem('sf.demo.role','student');}catch{}location.assign(juryURL(location.href));}
