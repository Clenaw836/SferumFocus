"""Explicit local/test provider page. Never asks for an ESIA credential."""
from fastapi import APIRouter,HTTPException
from fastapi.responses import HTMLResponse,Response
from app.diary_handoff import sandbox_enabled
router=APIRouter()
@router.get('/diary-sandbox',response_class=HTMLResponse)
def page():
    if not sandbox_enabled():raise HTTPException(404,'Sandbox выключен')
    return HTMLResponse('''<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Тестовый провайдер — НЕ Госуслуги</title><body><main><h1>Тестовый провайдер</h1><p><strong>Это НЕ Госуслуги, не SMS и не реальный вход в дневник.</strong></p><p>Скопируйте тестовый код в окно Sandbox в СферумФокус.</p><output id="code" aria-live="polite">Получаем тестовый код…</output><p>Срок действия — 3 минуты. Пароль и реальные коды ЕСИА не вводите.</p></main><script src="/diary-sandbox.js" defer></script></body></html>''',headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"})
@router.get('/diary-sandbox.js')
def script():
    if not sandbox_enabled():raise HTTPException(404,'Sandbox выключен')
    return Response('''const p=new URLSearchParams(location.hash.slice(1));history.replaceState(null,'',location.pathname);const body={challenge_id:p.get('challenge_id'),bridge_secret:p.get('bridge_secret')};p.delete('bridge_secret');fetch('/api/v1/diary/auth/sandbox/show-code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'omit',redirect:'error'}).then(async r=>{if(!r.ok)throw Error();const d=await r.json();document.getElementById('code').textContent=d.code;}).catch(()=>{document.getElementById('code').textContent='Тестовая сессия истекла или недоступна';}).finally(()=>{body.bridge_secret='';});''',media_type='application/javascript',headers={'Cache-Control':'no-store'})
