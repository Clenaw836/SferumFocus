"""Public integration entry point for the teacher journal and persisted UI role.

Implementation is split into small modules; this facade deliberately does not
accept unsigned account identifiers or grant upstream permissions from a UI role.
"""
from app.teacher_journal import router, TeacherGradeCreateRequest
from app.user_roles import get_user_role, set_user_role, role_fields

__all__ = ['router', 'TeacherGradeCreateRequest', 'get_user_role', 'set_user_role', 'role_fields']
