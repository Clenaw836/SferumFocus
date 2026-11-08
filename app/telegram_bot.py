"""Telegram transport + explicit /start entry. Run python -m app.telegram_bot.

Polling is single-instance, local session credentials never go to Telegram.
The grade worker runs in the API lifespan, not once per HTTP request.
"""
from __future__ import annotations
import asyncio
import os
import logging
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
from urllib.parse import urlsplit
import httpx
from app.bot import format_grade_notification
from app.grade_watcher import DeliveryRejected,is_low_grade

class TelegramNotifier:
    def __init__(self,token=None,url=None,client=None):
        self.token=token or os.getenv('TELEGRAM_BOT_TOKEN') or os.getenv('BOT_TOKEN','');self.url=url or os.getenv('TELEGRAM_MINIAPP_URL') or os.getenv('PUBLIC_WEBAPP_URL','')
        p=urlsplit(self.url)
        if not self.token or p.scheme!='https' or not p.hostname or p.username or p.password:raise ValueError('Telegram token and HTTPS Mini App URL required')
        self.client=client
    async def __call__(self,chat_id,event,private):
        payload={'chat_id':chat_id,'text':format_grade_notification(event,private),'parse_mode':'HTML','protect_content':True,
                 'reply_markup':{'inline_keyboard':[[{'text':'Открыть дневник','web_app':{'url':self.url}}]]}}
        if not private and event.get('recovery_plan') and is_low_grade(event['grade']['value']):
            from urllib.parse import urlencode,urlunsplit
            u=urlsplit(self.url)
            query=u.query+('&' if u.query else '')+urlencode({'tutor_subject':event['grade']['subject'],'tutor_topic':event['grade'].get('topic','')[:200]})
            tutor=urlunsplit((u.scheme,u.netloc,u.path,query,'tutor'))
            payload['reply_markup']['inline_keyboard'].append([{'text':'Разобрать тему с тьютором','web_app':{'url':tutor}}])
        async def send(client):
            r=await client.post(f'https://api.telegram.org/bot{self.token}/sendMessage',json=payload)
            if r.status_code==429:
                try:delay=min(86400,max(1,int(r.json()['parameters']['retry_after'])))
                except (ValueError,KeyError,TypeError):delay=60
                raise DeliveryRejected(delay)
            if 400<=r.status_code<500:raise DeliveryRejected()
            r.raise_for_status();data=r.json()
            if not data.get('ok'):raise DeliveryRejected()
            return data['result']['message_id']
        if self.client:return await send(self.client)
        async with httpx.AsyncClient(timeout=10,trust_env=False) as client:return await send(client)

async def run():
    from app import config  # load optional local .env before reading secrets
    token=os.getenv('TELEGRAM_BOT_TOKEN') or os.getenv('BOT_TOKEN','');url=os.getenv('TELEGRAM_MINIAPP_URL') or os.getenv('PUBLIC_WEBAPP_URL','')
    TelegramNotifier(token,url)  # validate configuration before any requests
    offset=0
    async with httpx.AsyncClient(timeout=40,trust_env=False) as client:
        while True:
            try:
                r=await client.post(f'https://api.telegram.org/bot{token}/getUpdates',json={'offset':offset,'timeout':25,'allowed_updates':['message']})
                r.raise_for_status();data=r.json()
                if not data.get('ok'):raise ValueError('Telegram rejected polling')
                for update in data['result']:
                    message=update.get('message',{});chat=message.get('chat',{});user=message.get('from',{})
                    if chat.get('type')=='private' and user.get('id')==chat.get('id') and message.get('text','').split(' ')[0]=='/start':
                        await client.post(f'https://api.telegram.org/bot{token}/sendMessage',json={'chat_id':chat['id'],'text':'СферумФокус · открой мини-приложение, подключи дневник и выбери уведомления.','reply_markup':{'inline_keyboard':[[{'text':'Открыть СферумФокус','web_app':{'url':url}}]]}})
                    offset=max(offset,update['update_id']+1)
            except (httpx.HTTPError,ValueError,KeyError):
                # No exception text: HTTP client errors may contain bot-token URLs.
                await asyncio.sleep(5)

if __name__=='__main__':asyncio.run(run())
