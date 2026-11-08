import sqlite3
from pathlib import Path
from typing import Literal
from uuid import UUID
from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt
from app import demo_sandbox
from app.teacher_journal import teacher_owner
from app.teacher_toolkit import ToolkitStore, ToolkitConflict, assess

router=APIRouter(tags=['teacher-toolkit'])
Kind=Literal['rubrics','feedback','plans']


class ToolBody(BaseModel):
    model_config=ConfigDict(extra='forbid')
    id: UUID
    title: str=Field(min_length=1,max_length=100)
    data: dict
    expected_revision: StrictInt=Field(ge=0,le=1000000)


class AssessmentBody(BaseModel):
    model_config=ConfigDict(extra='forbid')
    rubric: dict
    scores: list[StrictInt]=Field(min_length=1,max_length=8)


def owner(request,response):
    response.headers['Cache-Control']='no-store'
    response.headers['X-Content-Type-Options']='nosniff'
    sandbox=demo_sandbox.state_of(request)
    if sandbox:
        if sandbox['role']!='teacher':raise HTTPException(403,'Инструменты доступны учителю')
        return 'demo:'+sandbox['sid']+':teacher',sandbox['expires']
    uid,_=teacher_owner(request,response)
    return 'account:'+uid,None


def store():
    from app.config import SFERUM_DATA_DIR
    return ToolkitStore(Path(SFERUM_DATA_DIR)/'teacher_tools.sqlite3')


def call(operation):
    try:return operation()
    except ToolkitConflict as exc:raise HTTPException(409,str(exc)) from None
    except LookupError as exc:raise HTTPException(404,str(exc)) from None
    except ValueError as exc:raise HTTPException(422,str(exc)) from None
    except (OSError,sqlite3.Error):raise HTTPException(503,'Хранилище инструментов временно недоступно') from None


@router.get('/api/v1/teacher/tools')
def tools_list(request:Request,response:Response):
    key,_=owner(request,response)
    return {'items':store().listing(key)}


@router.post('/api/v1/teacher/tools/assess')
def rubric_assess(body:AssessmentBody,request:Request,response:Response):
    owner(request,response)
    return call(lambda:assess(body.rubric,body.scores))


@router.post('/api/v1/teacher/tools/{kind}')
def tool_save(kind:Kind,body:ToolBody,request:Request,response:Response):
    key,expires=owner(request,response)
    from app.onboarding_routes import _limit
    _limit(request,'teacher-tools-save',key,60)
    return call(lambda:store().save(key,kind,str(body.id),body.title,body.data,body.expected_revision,expires))


@router.delete('/api/v1/teacher/tools/{kind}/{item_id}')
def tool_delete(kind:Kind,item_id:UUID,request:Request,response:Response,revision:int=Query(ge=1)):
    key,_=owner(request,response)
    from app.onboarding_routes import _limit
    _limit(request,'teacher-tools-delete',key,60)
    call(lambda:store().delete(key,kind,str(item_id),revision))
    return {'deleted':True}
