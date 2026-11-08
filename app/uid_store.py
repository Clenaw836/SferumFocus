"""v18.1 (Phase 3, D-06): однозначное имя файла пользователя.

Раньше имя строилось «очисткой» uid ([^a-zA-Z0-9_.-] → «_», обрезка до 80 символов). Это не биекция:
подписанный «max:100» и демо-заголовок «max_100» попадали в ОДИН файл, длинные uid — тоже, а uid
«_feed_last_good» указывал на общий кэш расписания школы.

Теперь: <каталог>/v2/<sha256(uid)><суффикс>. sha256 от исходной строки — разные uid → разные файлы,
выход из каталога и попадание в служебные файлы невозможны (в v2/ лежат только файлы пользователей).

Совместимость: старые файлы НЕ удаляются и НЕ переписываются. Если нового файла ещё нет, чтение берёт
старый — но только у его законного владельца (legacy_name). Первая же запись идёт в новый файл.
Законный владелец старого имени:
  • «max_<цифры>» — подписанный «max:<цифры>» (так сервер хранил MAX-пользователей); демо-uid «max_<цифры>»
    этот файл не получает никогда;
  • «чистый» uid (только [A-Za-z0-9_.-], ≤ 80, не с «_», не на «.import») — он сам: для него старое имя
    совпадало с uid без потерь;
  • любой другой uid (символы терялись при очистке) — старого файла не получает: владелец неоднозначен.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

_CLEAN = re.compile(r"^[A-Za-z0-9.-][A-Za-z0-9_.-]{0,79}$")
_LEGACY_MAX = re.compile(r"^max_\d+$")


def user_key(uid: str) -> str:
    return hashlib.sha256(uid.encode("utf-8")).hexdigest()


def user_file(base: Path, uid: str, suffix: str) -> Path:
    return base / "v2" / f"{user_key(uid)}{suffix}"


def legacy_name(uid: str) -> str | None:
    """Старое (до v18.1) имя файла без суффикса — только если этот uid его однозначный владелец."""
    if not uid:
        return None  # empty UID has no unambiguous legacy owner
    if uid.startswith("max:"):
        return f"max_{uid[4:]}" if uid[4:].isdigit() else None
    if _CLEAN.match(uid) and not _LEGACY_MAX.match(uid) and not uid.endswith(".import"):
        return uid
    return None


def legacy_file(base: Path, uid: str, suffix: str) -> Path | None:
    name = legacy_name(uid)
    return base / f"{name}{suffix}" if name else None