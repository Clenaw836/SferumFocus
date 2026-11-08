from __future__ import annotations
from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import time
from uuid import UUID
from app.json_storage import file_lock
from app.sqlite_wal import connect

KINDS = {'rubrics', 'feedback', 'plans'}


class ToolkitConflict(ValueError):
    pass


def text(value, name, limit):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
        raise ValueError(f'{name}: нужно от 1 до {limit} символов')
    return value.strip()


def integer(value, name, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f'{name}: целое число от {low} до {high}')
    return value


def fields(value, required):
    if not isinstance(value, dict) or set(value) != set(required):
        raise ValueError('Некорректные поля шаблона')


def validate(kind, data):
    if kind not in KINDS:
        raise ValueError('Неизвестный инструмент')
    if kind == 'feedback':
        fields(data, {'body'})
        return {'body': text(data['body'], 'Комментарий', 2000)}
    if kind == 'rubrics':
        fields(data, {'criteria', 'thresholds'})
        criteria=data['criteria'];thresholds=data['thresholds']
        if not isinstance(criteria,list) or not 1 <= len(criteria) <= 8:
            raise ValueError('Нужно от 1 до 8 критериев')
        clean=[]
        for item in criteria:
            fields(item, {'title', 'points'})
            clean.append({'title':text(item['title'],'Критерий',100),'points':integer(item['points'],'Баллы',1,20)})
        if sum(c['points'] for c in clean)>100:raise ValueError('Не больше 100 баллов в сумме')
        if not isinstance(thresholds,list) or len(thresholds)!=3:raise ValueError('Укажите три порога: для 3, 4 и 5')
        bounds=[integer(v,'Порог',1,100) for v in thresholds]
        if not bounds[0]<bounds[1]<bounds[2]:raise ValueError('Пороги должны возрастать')
        return {'criteria':clean,'thresholds':bounds}
    fields(data, {'goal','duration','blocks'})
    duration=integer(data['duration'],'Длительность урока',10,120)
    if not isinstance(data['blocks'],list) or not 1<=len(data['blocks'])<=10:raise ValueError('Нужно от 1 до 10 этапов')
    blocks=[]
    for item in data['blocks']:
        fields(item, {'title','minutes'})
        blocks.append({'title':text(item['title'],'Этап',100),'minutes':integer(item['minutes'],'Минуты',1,120)})
    if sum(b['minutes'] for b in blocks)>duration:raise ValueError('Этапы не помещаются в урок')
    return {'goal':text(data['goal'],'Цель урока',300),'duration':duration,'blocks':blocks}


def assess(data, scores):
    rubric=validate('rubrics',data)
    if not isinstance(scores,list) or len(scores)!=len(rubric['criteria']):raise ValueError('Поставьте баллы по каждому критерию')
    scores=[integer(score,'Балл',0,item['points']) for score,item in zip(scores,rubric['criteria'])]
    total=sum(scores);maximum=sum(item['points'] for item in rubric['criteria'])
    # Compare integer products so a boundary cannot change due to floating-point rounding.
    mark=2+sum(total*100>=threshold*maximum for threshold in rubric['thresholds'])
    return {'points':total,'maximum':maximum,'percent':round(total*100/maximum,2),'suggested_mark':mark}


SCHEMA='''CREATE TABLE IF NOT EXISTS teacher_tools (
 owner_key TEXT NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL,
 title TEXT NOT NULL, data_json TEXT NOT NULL, revision INTEGER NOT NULL,
 updated_at TEXT NOT NULL, expires_at INTEGER,
 PRIMARY KEY(owner_key,kind,item_id));
 CREATE INDEX IF NOT EXISTS teacher_tools_expiry ON teacher_tools(expires_at);'''


class ToolkitStore:
    def __init__(self,path):self.path=Path(path)

    @contextmanager
    def tx(self):
        with file_lock(self.path):
            db=connect(self.path,synchronous='FULL')
            try:
                db.executescript(SCHEMA)
                db.execute('BEGIN IMMEDIATE')
                db.execute('DELETE FROM teacher_tools WHERE expires_at IS NOT NULL AND expires_at<=?',(int(time.time()),))
                yield db
                db.commit()
            except BaseException:
                db.rollback();raise
            finally:db.close()

    @staticmethod
    def present(row):
        return {'id':row['item_id'],'kind':row['kind'],'title':row['title'],'data':json.loads(row['data_json']),'revision':row['revision'],'updated_at':row['updated_at']}

    def listing(self,owner):
        with self.tx() as db:
            rows=db.execute('SELECT * FROM teacher_tools WHERE owner_key=? ORDER BY updated_at DESC,item_id',(owner,)).fetchall()
        return [self.present(row) for row in rows]

    def save(self,owner,kind,item_id,title,data,expected_revision,expires_at=None):
        try:UUID(item_id)
        except (ValueError,TypeError,AttributeError):raise ValueError('Некорректный идентификатор') from None
        title=text(title,'Название',100);data=validate(kind,data)
        integer(expected_revision,'Версия',0,1000000)
        encoded=json.dumps(data,ensure_ascii=False,sort_keys=True,separators=(',',':'))
        with self.tx() as db:
            old=db.execute('SELECT * FROM teacher_tools WHERE owner_key=? AND kind=? AND item_id=?',(owner,kind,item_id)).fetchone()
            if old and old['title']==title and old['data_json']==encoded:return self.present(old)
            if old is None and expected_revision!=0:raise LookupError('Шаблон не найден')
            if old and old['revision']!=expected_revision:raise ToolkitConflict('Шаблон изменён в другой вкладке. Обновите список перед сохранением.')
            if old is None and db.execute('SELECT COUNT(*) FROM teacher_tools WHERE owner_key=?',(owner,)).fetchone()[0]>=100:
                raise ValueError('Не больше 100 личных шаблонов')
            revision=old['revision']+1 if old else 1
            now=datetime.now(timezone.utc).isoformat()
            db.execute('INSERT INTO teacher_tools(owner_key,kind,item_id,title,data_json,revision,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_key,kind,item_id) DO UPDATE SET title=excluded.title,data_json=excluded.data_json,revision=excluded.revision,updated_at=excluded.updated_at,expires_at=excluded.expires_at',
                (owner,kind,item_id,title,encoded,revision,now,expires_at))
            return self.present(db.execute('SELECT * FROM teacher_tools WHERE owner_key=? AND kind=? AND item_id=?',(owner,kind,item_id)).fetchone())

    def purge_owner(self,owner):
        if not self.path.exists():return
        with self.tx() as db:
            db.execute('DELETE FROM teacher_tools WHERE owner_key=?',(owner,))

    def delete(self,owner,kind,item_id,revision):
        with self.tx() as db:
            row=db.execute('SELECT revision FROM teacher_tools WHERE owner_key=? AND kind=? AND item_id=?',(owner,kind,item_id)).fetchone()
            if row is None:raise LookupError('Шаблон не найден')
            if row['revision']!=revision:raise ToolkitConflict('Шаблон изменён в другой вкладке')
            db.execute('DELETE FROM teacher_tools WHERE owner_key=? AND kind=? AND item_id=?',(owner,kind,item_id))
