"""Owner-scoped teacher drafts with opt-in, verified upstream delivery.
Local drafts are never presented as official student grades.
"""
from __future__ import annotations
import asyncio
from datetime import date
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt
from app import teacher_journal_store as journal
from app.user_roles import get_user_role, role_fields, teacher_session

router = APIRouter(tags=['teacher-journal'])


def resources(request):
    from app.platform_routes import account
    from app.platform_auth import store
    return account(request)['uid'], store()


def teacher_owner(request, response):
    uid, repo = resources(request)
    response.headers['Cache-Control'] = 'no-store'
    if get_user_role(repo, uid) != 'teacher':
        raise HTTPException(403, 'Журнал доступен только в режиме учителя')
    return uid, repo


class RoleChoice(BaseModel):
    model_config = ConfigDict(extra='forbid')
    role: Literal['teacher','student']


@router.post('/api/v1/webapp/role')
def change_view(body: RoleChoice, request: Request, response: Response):
    uid, repo = resources(request)
    response.headers['Cache-Control'] = 'no-store'
    from app.onboarding_routes import _limit
    _limit(request, 'role-view', uid, 60)
    if body.role == 'teacher' and get_user_role(repo, uid) != 'teacher':
        raise HTTPException(403, 'Сначала выберите роль в мастере или подключите СГО как учитель')
    with repo.tx() as db:
        db.execute('UPDATE accounts SET view_role=? WHERE uid=?', (body.role, uid))
    return role_fields(repo, uid)


@router.get('/api/v1/sgo/status')
@router.get('/api/v1/sgo/diary')
def sgo_status(request: Request, response: Response):
    uid, repo = resources(request)
    from app.platform_routes import vault
    from app import sgo_profiles as profiles
    response.headers['Cache-Control'] = 'no-store'
    session = profiles.load_session(repo, vault(), uid)
    status = vault().status(uid)
    if session:
        status.update(status='connected' if session.status == 'active' else session.status,
                      provider='netschool', portal=session.sgo_base_url,
                      expires=session.expires_at)
    return {**status, **role_fields(repo,uid)}


class TeacherGradeCreateRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    class_name: str = Field(default='8А', min_length=1, max_length=20)
    subject: str = Field(default='Алгебра', min_length=1, max_length=80)
    student_id: Annotated[str, Field(min_length=1, max_length=120)] | StrictInt | None = None
    student_name: str = Field(min_length=1, max_length=120)
    grade: StrictInt = Field(ge=2, le=5)
    assignment_type: str = Field(default='Ответ на уроке', min_length=1, max_length=100)
    comment: str = Field(default='', max_length=300)
    lesson_date: date | None = None
    class_id: int | None = Field(default=None, gt=0)
    subject_id: int | None = Field(default=None, gt=0)
    classmeeting_id: int | None = Field(default=None, gt=0)
    assignment_id: int | None = Field(default=None, gt=0)
    confirm_sgo: bool = False
    operation_id: str = Field(default_factory=lambda: str(uuid4()), min_length=1, max_length=80, pattern=r'^[A-Za-z0-9_-]+$')


async def live_call(uid, repo, op):
    from app.platform_routes import vault
    from app.sgo_adapter import adapter
    api = adapter(repo, vault())
    try:
        return await asyncio.wait_for(api.teacher_call(uid, op), timeout=5.0)
    finally:
        if api.client is not None:
            await api.client.aclose()


async def upstream_grade(uid, repo, body):
    from app.sgo_teacher_client import ExportMarksBatchRequest, StudentMarkItem
    async def send(client):
        context = await client.get_teacher_context()
        if not context['is_teacher']:
            raise PermissionError('teacher_not_verified')
        classes = await client.get_teacher_classes_and_subjects()
        own = next((c for c in classes if c['class_id'] == body.class_id and c['class_name'] == body.class_name), None)
        if not own or not any(s['id'] == body.subject_id and s['name'] == body.subject for s in own['subjects']):
            raise PermissionError('class_or_subject_not_verified')
        roster = await client.get_gradebook_students(body.class_id, body.subject_id)
        if not any(str(s['student_id']) == str(body.student_id) for s in roster['students']):
            raise PermissionError('student_not_verified')
        req = ExportMarksBatchRequest(classmeeting_id=body.classmeeting_id, assignment_id=body.assignment_id,
                marks=[StudentMarkItem(student_id=int(body.student_id), mark=body.grade, comment=body.comment)],
                dry_run=False, confirm=True)
        return await client.export_verified_marks_to_sgo(req)
    return await live_call(uid, repo, send)


@router.post('/api/v1/sgo/teacher/grade')
@router.post('/api/v1/teacher/grade')
async def create_grade(body: TeacherGradeCreateRequest, request: Request, response: Response):
    uid, repo = teacher_owner(request,response)
    from app.onboarding_routes import _limit
    from app.sgo_teacher_client import write_enabled
    _limit(request, 'teacher-journal-write', uid, 60)
    data = body.model_dump(mode='json')
    if body.student_id is None:
        import hashlib
        data['student_id'] = 'local_' + hashlib.sha256((body.class_name+'|'+body.student_name).encode()).hexdigest()[:20]
    else:
        data['student_id'] = str(body.student_id)
    try:
        entry, new = await asyncio.to_thread(journal.reserve, repo, uid, {**data, 'lesson_date': data['lesson_date']})
    except ValueError:
        raise HTTPException(409, 'Ключ операции уже использован для другой оценки') from None
    if not new:
        return {**entry,'replayed':True}
    if not body.confirm_sgo:
        return entry
    reason, status = 'local_only', 'draft'
    required = (body.class_id, body.subject_id, body.classmeeting_id, body.assignment_id)
    if body.confirm_sgo:
        if not write_enabled():
            reason = 'write_disabled'
        elif not all(required) or not str(body.student_id or '').isdigit():
            reason = 'missing_sgo_ids'
        elif not teacher_session(repo, uid):
            reason = 'sgo_not_linked'
        else:
            from app.sgo_adapter import SgoTeacherUnavailable
            from app.diary_providers import ProviderUnavailable, ReauthRequired
            from app.sgo_client import SgoUnsupported
            import httpx
            try:
                result = await upstream_grade(uid, repo, body)
                if result.get('ok') is True and result.get('dry_run') is False and result.get('exported_count') == 1:
                    status, reason = 'synced_sgo', 'accepted'
                else:
                    reason = 'upstream_rejected'
            except PermissionError:
                reason = 'scope_not_verified'
            except (TimeoutError, httpx.TransportError, SgoTeacherUnavailable, ProviderUnavailable, ReauthRequired):
                reason = 'delivery_unknown'
            except (SgoUnsupported, ValueError):
                reason = 'upstream_rejected'
    return await asyncio.to_thread(journal.finish, repo, uid, entry['id'], status, reason)


@router.get('/api/v1/sgo/teacher/journal')
@router.get('/api/v1/sgo/teacher/grades')
@router.get('/api/v1/teacher/grades')
async def read_journal(request: Request, response: Response,
        class_name: str = Query(default='8А',min_length=1,max_length=20),
        subject: str = Query(default='Алгебра',min_length=1,max_length=80),
        class_id: int | None = Query(default=None,gt=0), subject_id: int | None = Query(default=None,gt=0),
        before_id: int | None = Query(default=None,gt=0), limit: int = Query(default=100,ge=1,le=200)):
    uid, repo = teacher_owner(request,response)
    out = await asyncio.to_thread(journal.listing, repo, uid, class_name, subject, before_id=before_id, limit=limit)
    out.update(class_name=class_name, subject=subject, roster_source='local_journal', roster_available=False)
    if class_id and teacher_session(repo,uid):
        from app.sgo_adapter import SgoTeacherUnavailable
        from app.diary_providers import ProviderUnavailable, ReauthRequired
        from app.sgo_client import SgoUnsupported
        import httpx
        try:
            async def scoped_roster(client):
                context = await client.get_teacher_context()
                if not context.get('is_teacher'):
                    raise PermissionError('teacher scope not verified')
                overview = await client.get_teacher_classes_and_subjects()
                allowed = next((c for c in overview['classes'] if c['class_id']==class_id and c['class_name']==class_name), None)
                if allowed is None:
                    raise PermissionError('class scope not verified')
                if subject_id is not None and not any(s['id']==subject_id and s['name']==subject for s in allowed['subjects']):
                    raise PermissionError('subject scope not verified')
                return await client.get_gradebook_students(class_id,subject_id)
            result = await live_call(uid, repo, scoped_roster)
            students = {str(p['student_id']):p for p in out['students']}
            for p in result['students']:
                students[str(p['student_id'])] = p
            out.update(students=list(students.values()), roster_source='sgo_and_local', roster_available=True)
        except (SgoTeacherUnavailable, ProviderUnavailable, ReauthRequired, SgoUnsupported, httpx.HTTPError, TimeoutError, ValueError, PermissionError):
            out['roster_note'] = 'Список СГО недоступен. Можно указать имя для локального черновика.'
    return out


@router.delete('/api/v1/sgo/teacher/grade/{grade_id}')
def remove_grade(grade_id: int, request: Request, response: Response):
    uid, repo = teacher_owner(request,response)
    from app.onboarding_routes import _limit
    _limit(request,'teacher-journal-delete',uid,60)
    try:
        journal.delete_draft(repo,uid,grade_id)
    except LookupError:
        raise HTTPException(404,'Оценка не найдена') from None
    except ValueError:
        raise HTTPException(409,'Можно удалить только локальный черновик без незавершённой отправки в СГО') from None
    return {'deleted':True,'id':grade_id}


def own_teacher_context(uid):
    from app.onboarding_routes import store, vault
    from app import sgo_profiles as profiles
    repo, v = store(), vault()
    session = profiles.load_session(repo,v,uid)
    if not session or session.role != 'teacher' or session.status != 'active':
        return None
    cached = profiles.cache_get(repo,v,uid,'teacher','overview')
    teacher = (cached.payload.get('teacher_data') or {}) if cached else {}
    assignments = []
    for c in teacher.get('classes') or []:
        for s in c.get('subjects') or []:
            name = s.get('name') if isinstance(s,dict) else str(s)
            assignments.append({'class':c.get('name') or c.get('class_name') or '', 'subject':name,
                                'perms':{'view_schedule':True,'view_stats':False,'edit_schedule':False,'grade':False}})
    return {'id':'sgo-'+uid, 'school_id':'sgo:'+session.sgo_base_url+':'+session.scid,
            'full_name':session.extra.get('user_name') or 'Учитель СГО',
            'assignments':assignments, 'role_note':'СГО · личный журнал'}

from app.sgo_routes import Login as NativeLogin

@router.post('/api/v1/sgo/diary/connect')
async def native_connect_alias(body: NativeLogin, request: Request):
    from app.sgo_routes import connect
    return await connect(body, request)
