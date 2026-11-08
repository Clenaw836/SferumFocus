"""Revoke local grants first; remote logout is bounded and never blocks deletion."""
import asyncio
import sqlite3
from app.diary_providers import ReauthRequired
from app.sgo_client import NetSchoolClient
from app.sgo_directory import Directory

async def disconnect_diary(repo,vault,uid,*,client=None):
    try:connection=vault.get(uid)
    except ValueError:connection=None  # A corrupt record must still be deletable.
    result=vault.disconnect(uid)
    # v2.2: сессия мастера подключения (sgo_sessions: токен, cookies, ФИО) и SWR-кэш данных СГО живут в своих
    # таблицах. Раньше «Отключить и удалить» их не трогал: обзор дневника и ФИО оставались после отключения.
    try:
        from app import sgo_profiles
        sgo_profiles.delete_session(repo,uid)
        result['sgo_session_deleted']=True
    except sqlite3.OperationalError:
        result['sgo_session_deleted']=False   # старая БД без таблиц мастера — удалять нечего
    result['remote_logout']='not_applicable'
    if connection and connection.get('provider')=='netschool':
        result['remote_logout']='not_supported'
        session=connection.get('session') or {}
        if session.get('protocol')=='netschool-native-v1':
            result['remote_logout']='unconfirmed'
            try:
                host=Directory(repo).host(session['host_id'])
                await asyncio.wait_for(NetSchoolClient(host,client).logout(session),timeout=8)
                result['remote_logout']='confirmed'
            except ReauthRequired:result['remote_logout']='already_expired'
            except Exception:
                # No provider response, URL, cookies, token or exception repr escapes.
                pass
    return result
