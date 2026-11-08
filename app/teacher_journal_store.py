"""Local, owner-scoped journal. No FastAPI or network dependency.
Insert before sending upstream; operation IDs prevent replay after a lost response.
"""
from __future__ import annotations
from datetime import date, datetime, timezone
import json

SCHEMA = '''
CREATE TABLE IF NOT EXISTS teacher_grades_journal (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 teacher_uid TEXT NOT NULL REFERENCES accounts(uid),
 class_name TEXT NOT NULL, subject TEXT NOT NULL,
 student_id TEXT NOT NULL, student_name TEXT NOT NULL,
 grade INTEGER NOT NULL CHECK(typeof(grade)='integer' AND grade IN (2,3,4,5)),
 assignment_type TEXT NOT NULL, comment TEXT NOT NULL DEFAULT '',
 lesson_date TEXT NOT NULL,
 sync_status TEXT NOT NULL DEFAULT 'draft' CHECK(sync_status IN ('draft','synced_sgo')),
 created_at TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 sync_reason TEXT NOT NULL DEFAULT 'local_only',
 request_json TEXT NOT NULL,
 UNIQUE(teacher_uid,operation_id)
);
CREATE INDEX IF NOT EXISTS teacher_journal_owner ON teacher_grades_journal(teacher_uid,class_name,subject,id);
'''


def migrate(db):
    for statement in SCHEMA.split(';'):
        if statement.strip():
            db.execute(statement)
    # Additive upgrade from the attached journal proposal, without deleting records.
    columns = {r[1] for r in db.execute('PRAGMA table_info(teacher_grades_journal)')}
    for name, definition in (('operation_id', 'TEXT'), ('sync_reason', "TEXT NOT NULL DEFAULT 'local_only'"), ('request_json', "TEXT NOT NULL DEFAULT '{}'")):
        if name not in columns:
            db.execute(f'ALTER TABLE teacher_grades_journal ADD COLUMN {name} {definition}')
    db.execute("UPDATE teacher_grades_journal SET operation_id='legacy_'||id WHERE operation_id IS NULL")
    db.execute('CREATE UNIQUE INDEX IF NOT EXISTS teacher_journal_operations ON teacher_grades_journal(teacher_uid,operation_id)')
    # Protect both newly created and pre-existing tables without rewriting stored grades.
    for event, suffix in (('INSERT', 'insert'), ('UPDATE OF grade', 'update')):
        db.execute(f"""CREATE TRIGGER IF NOT EXISTS teacher_journal_integer_grade_{suffix}
            BEFORE {event} ON teacher_grades_journal
            WHEN typeof(NEW.grade) <> 'integer' OR NEW.grade NOT IN (2,3,4,5)
            BEGIN SELECT RAISE(ABORT, 'invalid_grade'); END""")


def present(row):
    data = dict(row)
    for key in ('request_json', 'teacher_uid', 'operation_id'):
        data.pop(key, None)
    data['status'] = data['sync_status']
    data['status_label'] = 'Отправлено в СГО' if data['sync_status'] == 'synced_sgo' else 'Черновик · в локальной БД'
    return data


def reserve(repo, uid, body):
    """Returns (entry, new). A repeated key with another body is a conflict."""
    canonical = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    with repo.tx() as db:
        old = db.execute('SELECT * FROM teacher_grades_journal WHERE teacher_uid=? AND operation_id=?',
                         (uid, body['operation_id'])).fetchone()
        if old:
            if old['request_json'] != canonical:
                raise ValueError('operation_conflict')
            return present(old), False
        columns = ('class_name','subject','student_id','student_name','grade','assignment_type','comment','lesson_date')
        values = [body[k] if k != 'lesson_date' else (body[k] or date.today().isoformat()) for k in columns]
        cur = db.execute('INSERT INTO teacher_grades_journal(teacher_uid,' + ','.join(columns) +
                         ',created_at,operation_id,sync_reason,request_json) VALUES(' + ','.join('?' for _ in range(13)) + ')',
                         [uid, *values, datetime.now(timezone.utc).isoformat(), body['operation_id'],
                          'pending' if body.get('confirm_sgo') else 'local_only', canonical])
        row = db.execute('SELECT * FROM teacher_grades_journal WHERE id=?', (cur.lastrowid,)).fetchone()
        return present(row), True


def finish(repo, uid, grade_id, status, reason):
    if status not in ('draft', 'synced_sgo'):
        raise ValueError('invalid_sync_status')
    with repo.tx() as db:
        row = db.execute('SELECT * FROM teacher_grades_journal WHERE id=? AND teacher_uid=?', (grade_id, uid)).fetchone()
        if row is None:
            raise LookupError('not_found')
        if row['sync_status'] == 'synced_sgo':
            if status != row['sync_status'] or reason != row['sync_reason']:
                raise ValueError('synced_grade_immutable')
            return present(row)
        db.execute('UPDATE teacher_grades_journal SET sync_status=?,sync_reason=? WHERE id=? AND teacher_uid=?',
                   (status, reason, grade_id, uid))
        return present(db.execute('SELECT * FROM teacher_grades_journal WHERE id=? AND teacher_uid=?', (grade_id, uid)).fetchone())


def listing(repo, uid, class_name, subject, *, before_id=None, limit=100):
    with repo.tx() as db:
        rows = db.execute('SELECT * FROM teacher_grades_journal WHERE teacher_uid=? AND class_name=? AND subject=?'
                          ' AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?',
                          (uid, class_name, subject, before_id, before_id, limit+1)).fetchall()
        people = db.execute('SELECT student_id,student_name FROM teacher_grades_journal WHERE teacher_uid=? AND class_name=?'
                            ' GROUP BY student_id,student_name ORDER BY student_name LIMIT 1000', (uid,class_name)).fetchall()
    return {'grades':[present(r) for r in rows[:limit]],
            'students':[dict(r) for r in people], 'has_more':len(rows)>limit,
            'next_before_id':rows[limit-1]['id'] if len(rows)>limit else None}


def delete_draft(repo, uid, grade_id):
    with repo.tx() as db:
        row = db.execute('SELECT sync_status,sync_reason FROM teacher_grades_journal WHERE id=? AND teacher_uid=?', (grade_id,uid)).fetchone()
        if not row:
            raise LookupError('not_found')
        if row['sync_status'] != 'draft' or row['sync_reason'] in ('pending','delivery_unknown'):
            raise ValueError('not_deletable')
        db.execute('DELETE FROM teacher_grades_journal WHERE id=? AND teacher_uid=?', (grade_id,uid))
