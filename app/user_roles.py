"""Persisted UI role, distinct from authority to access school data.
No role, account or school identifier is taken from unsigned headers/cookies.
"""
from __future__ import annotations


def migrate(db):
    for table in ("accounts", "student_school_binding"):
        columns = {r[1] for r in db.execute(f"PRAGMA table_info({table})")}
        if "role" not in columns:
            db.execute(f"ALTER TABLE {table} ADD COLUMN role TEXT NOT NULL DEFAULT 'student'")
    if "view_role" not in {r[1] for r in db.execute("PRAGMA table_info(accounts)")}:
        db.execute("ALTER TABLE accounts ADD COLUMN view_role TEXT")


def get_user_role(repo, uid):
    # A UI preference does NOT prove permission to read/write upstream records.
    with repo.tx() as db:
        values = [r[0] for sql in (
            "SELECT role FROM accounts WHERE uid=?",
            "SELECT role FROM user_profiles WHERE user_id=?",
            "SELECT role FROM student_school_binding WHERE student_uid=?",
            "SELECT role FROM sgo_sessions WHERE user_id=? AND status NOT IN ('revoked','reauth_required')"
        ) for r in db.execute(sql, (uid,))]
    return "teacher" if "teacher" in values else "student"


def view_role(repo, uid):
    role = get_user_role(repo, uid)
    with repo.tx() as db:
        row = db.execute("SELECT view_role FROM accounts WHERE uid=?", (uid,)).fetchone()
    return row[0] if role == "teacher" and row and row[0] in ("teacher", "student") else role


def set_user_role(repo, uid, role):
    if role not in ("student", "teacher"):
        raise ValueError("invalid role")
    from app.sgo_profiles import update_profile
    update_profile(repo, uid, role=role)
    with repo.tx() as db:
        db.execute("UPDATE accounts SET role=?,view_role=NULL WHERE uid=?", (role, uid))
        db.execute("UPDATE student_school_binding SET role=? WHERE student_uid=?", (role, uid))
    return role


def teacher_session(repo, uid):
    with repo.tx() as db:
        row = db.execute("SELECT 1 FROM sgo_sessions WHERE user_id=? AND role='teacher' AND status='active'", (uid,)).fetchone()
    return bool(row)


def role_fields(repo, uid):
    account_role = get_user_role(repo, uid)
    active = view_role(repo, uid)
    return {"role": active, "is_teacher": account_role == "teacher", "account_role": account_role}
