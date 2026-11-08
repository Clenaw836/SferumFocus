"""v3.0 · Распознавание рукописного черновика + рамка шага с ошибкой (OCR-01, параметр аудита № 8).

Контур (по порядку):
  1. Vision-модель Groq (``meta-llama/llama-4-scout-17b-16e-instruct`` → фоллбэк ``llama-3.2-90b-vision-preview``).
     Код запроса готов, но вызывается ТОЛЬКО если центральный шлюз ИИ разрешает медиа (``ai_engine.has_vision()``).
     В этом релизе шлюз К1 (v2.4 Step 1, 152-ФЗ) медиа не выпускает — фото несовершеннолетних не покидают сервер,
     переключателя нет. Поэтому Vision-путь всегда честно отвечает ``engine_unavailable`` и в сеть не ходит;
     решение об открытии — за владельцем продукта (вопрос в SCORE_UPGRADE_REPORT.md).
  2. Офлайн: Tesseract ``rus+eng`` в TSV-режиме (аналог ``pytesseract.image_to_data``) в изолированном пуле
     ``app.ocr_pool`` — пословные координаты (x, y, w, h) и уверенность, сборка строк.
  3. Ученик правит распознанные строки (поле быстрой правки формулы) и отправляет их на проверку
     ``check_steps``: детерминированная проверка равносильности шагов (арифметика, тождества, линейные
     уравнения с одной переменной) на точных дробях; первая ошибка → номер шага и её рамка в долях кадра.
     Ответ ученику не выдаётся — только «где ошибка» (сократовский принцип), подсказку даёт тьютор.

Модуль не хранит фото и текст: всё считается в памяти запроса.
"""
from __future__ import annotations

import ast
import io
import math
import re
import subprocess
from dataclasses import dataclass
from fractions import Fraction
from typing import Any, Iterable

VISION_MODELS = ("meta-llama/llama-4-scout-17b-16e-instruct", "llama-3.2-90b-vision-preview")
MAX_LINES = 24
MAX_LINE_CHARS = 160
_VARS = "xyzabcdkmnpqt"


class OcrError(Exception):
    def __init__(self, message: str, status: int = 422, code: str = "OCR_ERROR"):
        super().__init__(message)
        self.message, self.status, self.code = message, status, code


@dataclass(frozen=True)
class Word:
    text: str
    conf: float
    x: int
    y: int
    w: int
    h: int
    line_key: tuple[int, int, int]


# ------------------------------------------------------------------ 1. Vision (закрыт шлюзом К1)
def vision_available() -> bool:
    from app import ai_engine
    return bool(ai_engine.has_vision())


def vision_request(b64: str, mime: str, hint: str = "") -> dict[str, Any]:
    """Тело запроса к Vision-модели (для проверки формы; отправка — только через ai_engine и шлюз).

    Текстовая подсказка ученика проходит ``scrub_pii`` до сборки запроса."""
    from app.pii_scrubber import scrub_pii
    prompt = ("Перепиши рукописный черновик по строкам, формулы — в ASCII (2*x+3=7). Верни JSON "
              '{"lines":[{"text":"…","bbox":[x,y,w,h]}]} с координатами в пикселях. Не решай задачу.')
    clean_hint = scrub_pii(hint or "")[:300]
    return {"models": list(VISION_MODELS), "messages": [
        {"role": "system", "content": prompt},
        {"role": "user", "content": [{"type": "text", "text": clean_hint or "Черновик ученика"},
                                     {"type": "image_url", "image_url": {"url": f"data:{mime};base64,<{len(b64)} b64 chars>"}}]}]}


# ------------------------------------------------------------------ 2. Tesseract TSV → слова → строки
def parse_tsv(tsv: str, min_conf: float = 0.0) -> list[Word]:
    """TSV Tesseract (level, page, block, par, line, word, left, top, width, height, conf, text) → слова."""
    out: list[Word] = []
    for row in (tsv or "").splitlines()[1:]:
        cols = row.split("\t")
        if len(cols) < 12 or not cols[11].strip():
            continue
        try:
            conf = float(cols[10])
            x, y, w, h = (int(cols[i]) for i in (6, 7, 8, 9))
            key = (int(cols[2]), int(cols[3]), int(cols[4]))
        except ValueError:
            continue
        if conf < min_conf or conf < 0 or w <= 0 or h <= 0:
            continue
        out.append(Word(cols[11].strip(), conf, x, y, w, h, key))
    return out


def group_lines(words: Iterable[Word]) -> list[dict[str, Any]]:
    """Слова одной строки → строка с объединённой рамкой и средней уверенностью; порядок — сверху вниз."""
    lines: dict[tuple[int, int, int], list[Word]] = {}
    for w in words:
        lines.setdefault(w.line_key, []).append(w)
    out = []
    for ws in lines.values():
        ws.sort(key=lambda w: w.x)
        x0, y0 = min(w.x for w in ws), min(w.y for w in ws)
        x1, y1 = max(w.x + w.w for w in ws), max(w.y + w.h for w in ws)
        out.append({"text": " ".join(w.text for w in ws)[:MAX_LINE_CHARS], "bbox": [x0, y0, x1 - x0, y1 - y0],
                    "conf": round(sum(w.conf for w in ws) / len(ws) / 100, 2),
                    "words": [{"text": w.text, "bbox": [w.x, w.y, w.w, w.h], "conf": round(w.conf / 100, 2)} for w in ws]})
    out.sort(key=lambda ln: (ln["bbox"][1], ln["bbox"][0]))
    return out[:MAX_LINES]


def tesseract_tsv(raw: bytes) -> tuple[str, int, int]:
    """Рабочая функция пула (верхнего уровня — сериализуется в процесс): PNG-подготовка + TSV + размер кадра."""
    from app.evidence import _prep_image  # noqa: PLC2701 — та же подготовка и защита от «бомб», что у расписания
    img = _prep_image(raw)
    from PIL import Image  # type: ignore
    with Image.open(io.BytesIO(img)) as im:
        width, height = im.size
    r = subprocess.run(["tesseract", "stdin", "stdout", "-l", "rus+eng", "--psm", "6", "tsv"],
                       input=img, capture_output=True, timeout=40, check=False)
    if r.returncode != 0:
        raise OcrError("Не удалось прочитать фото черновика", 422, "OCR_FAILED")
    return r.stdout.decode("utf-8", "replace"), width, height


async def read_draft(b64: str, mime: str | None, hint: str = "") -> dict[str, Any]:
    """Фото черновика → строки с рамками. Vision — только при открытом шлюзе (в этом релизе закрыт)."""
    import asyncio
    import base64
    import binascii
    from app.evidence import MAX_IMAGE_B64, tesseract_available
    if not b64 or len(b64) > MAX_IMAGE_B64:
        raise OcrError("Фото слишком большое — сожми его или сфотографируй ближе", 413, "TOO_LARGE")
    try:
        raw = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise OcrError("Файл не похож на изображение", 422, "BAD_IMAGE") from exc
    if vision_available():          # pragma: no cover — шлюз К1 закрыт в v3.0, см. docstring модуля
        raise OcrError("Vision-контур не включён в этом релизе", 503, "VISION_DISABLED")
    if not tesseract_available():
        # v3.2 · OCR-02: печатный текст читает встроенный распознаватель; рукопись честно уходит в ручной редактор
        built = await _builtin_draft(raw)
        if built is not None:
            return built
        return {"engine": "manual", "lines": [], "width": None, "height": None, "editable": True,
                "vision": {"available": False, "models": list(VISION_MODELS), "reason": "media_gate_k1"},
                "message": "Распознавание на сервере не настроено — впиши строки решения вручную, проверка сработает так же."}
    from app.ocr_pool import OCRBusy, OCRUnavailable, pool
    try:
        tsv, width, height = await asyncio.to_thread(pool().run, raw, operation=tesseract_tsv)
    except OCRBusy as exc:
        raise OcrError("Все места распознавания заняты — попробуй чуть позже или впиши строки", 503, "OCR_BUSY") from exc
    except OCRUnavailable as exc:
        raise OcrError("Фото не удалось прочитать вовремя — впиши строки вручную", 503, "OCR_TIMEOUT") from exc
    lines = group_lines(parse_tsv(tsv, min_conf=10))
    for ln in lines:
        ln["formula"] = normalize_formula(ln["text"])
    return {"engine": "tesseract", "lines": lines, "width": width, "height": height, "editable": True,
            "vision": {"available": False, "models": list(VISION_MODELS), "reason": "media_gate_k1"},
            "message": "Проверь строки: если OCR ошибся в символе — исправь его перед проверкой."}


async def _builtin_draft(raw: bytes) -> dict[str, Any] | None:
    import asyncio
    from app import glyph_ocr
    if not glyph_ocr.available():
        return None
    try:
        res = await asyncio.wait_for(asyncio.to_thread(glyph_ocr.recognize, raw), timeout=8)
    except (ValueError, OSError, asyncio.TimeoutError):
        return None
    lines = [{"text": ln["text"], "bbox": ln["bbox"], "conf": ln["conf"], "words": [], "formula": normalize_formula(ln["text"])}
             for ln in res["lines"] if ln["text"].strip()][:MAX_LINES]
    if not lines or res["legibility"] < 0.35:
        return None
    return {"engine": res["engine"], "lines": lines, "width": res["width"], "height": res["height"], "editable": True,
            "vision": {"available": False, "models": list(VISION_MODELS), "reason": "media_gate_k1"},
            "message": "Прочитано встроенным распознавателем печатного текста — проверь строки и исправь символы перед проверкой."}


# ------------------------------------------------------------------ 3. Нормализация формулы
_CONFUSIONS = (("×", "*"), ("·", "*"), ("∙", "*"), ("÷", "/"), ("−", "-"), ("–", "-"), ("—", "-"), ("²", "^2"), ("³", "^3"),
               ("½", "(1/2)"), ("¼", "(1/4)"), ("₁", "1"), ("₂", "2"), ("+/-", "±"), ("+-", "±"), ("sqrt", "√"), ("¾", "(3/4)"), ("（", "("), ("）", ")"), ("：", ":"), ("＝", "="))
_CYR_LAT = str.maketrans({"х": "x", "Х": "x", "у": "y", "а": "a", "о": "o", "О": "0", "З": "3", "б": "b", "т": "t", "п": "n"})


def normalize_formula(text: str) -> str:
    """Типичные ошибки OCR и школьная запись → ASCII-формула: «2х+3=7», «3·(х−1)», «x²», «7:2», «0,5»."""
    s = (text or "")[:MAX_LINE_CHARS]
    s = re.sub(r"(?i)^\s*(ответ|решение|проверка|дано|найти|шаг\s*\d+)\s*[:.)-]?\s*", "", s)
    for a, b in _CONFUSIONS:
        s = s.replace(a, b)
    s = s.translate(_CYR_LAT)
    s = re.sub(r"(?<=\d)[oO](?=\d)|(?<=\d)[oO]\b", "0", s)            # «1o» → «10»
    s = re.sub(r"(?<=\d)[lI|](?=\d)|\b[lI|](?=\d)", "1", s)           # «l2» → «12»
    s = re.sub(r"(?<=\d),(?=\d)", ".", s)                             # десятичная запятая
    s = re.sub(r"(?<=[\d)])\s*[xX]\s*(?=\()", "*", s)                  # «2 x (3)» как умножение
    s = re.sub(r"(?<=\d)\s*:\s*(?=[\d(])", "/", s)                    # «7 : 2» деление
    s = re.sub(r"\s+", "", s)
    return re.sub(r"[^0-9a-z+\-*/^().=<>±√]", "", s.lower())


# ------------------------------------------------------------------ 4. Проверка шагов (точные дроби, без eval)
_ALLOWED = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant, ast.Name, ast.Load,
            ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.USub, ast.UAdd, ast.Call)


class _Irrational(Exception):
    """√ из числа, не являющегося точным квадратом: строку честно не проверяем (дроби остаются точными)."""


def _implicit_mul(expr: str) -> str:
    expr = re.sub(r"√(\d+(?:\.\d+)?|[a-z])", r"√(\1)", expr)          # √25 → √(25)
    expr = re.sub(r"(?<=[\d)a-z])√", "*√", expr)                     # 2√3 → 2*√3
    expr = expr.replace("^", "**")
    expr = re.sub(r"(?<=[\d)])(?=[a-z(])", "*", expr)                 # 2x, 2(x+1), )(
    expr = re.sub(r"(?<=[a-z])(?=[\d(])", "*", expr)                  # x2 → x*2, x(…)
    return re.sub(r"(?<=[a-z])(?=[a-z])", "*", expr).replace("√", "S")   # ab → a*b; √ → S(…)


def _parse(expr: str) -> ast.Expression:
    if not expr or len(expr) > MAX_LINE_CHARS:
        raise OcrError("Пустое или слишком длинное выражение", code="BAD_EXPR")
    try:
        tree = ast.parse(_implicit_mul(expr), mode="eval")
    except SyntaxError as exc:
        raise OcrError("Не получилось прочитать выражение — проверь скобки и знаки", code="BAD_EXPR") from exc
    for node in ast.walk(tree):
        if not isinstance(node, _ALLOWED):
            raise OcrError("В выражении есть недопустимые символы", code="BAD_EXPR")
        if isinstance(node, ast.Call):
            if not (isinstance(node.func, ast.Name) and node.func.id == "S" and len(node.args) == 1 and not node.keywords):
                raise OcrError("В выражении есть недопустимые символы", code="BAD_EXPR")
            continue
        if isinstance(node, ast.Name) and node.id == "S":
            continue
        if isinstance(node, ast.Constant) and not isinstance(node.value, (int, float)):
            raise OcrError("В выражении есть недопустимые символы", code="BAD_EXPR")
        if isinstance(node, ast.Name) and (len(node.id) != 1 or node.id not in _VARS):
            raise OcrError("Переменная должна быть одной латинской буквой", code="BAD_EXPR")
    return tree


def _eval(node: ast.AST, env: dict[str, Fraction]) -> Fraction:
    if isinstance(node, ast.Expression):
        return _eval(node.body, env)
    if isinstance(node, ast.Constant):
        return Fraction(str(node.value))
    if isinstance(node, ast.Name):
        if node.id not in env:
            raise OcrError("Не получилось прочитать выражение — проверь запись", code="BAD_EXPR")
        return env[node.id]
    if isinstance(node, ast.UnaryOp):
        v = _eval(node.operand, env)
        return -v if isinstance(node.op, ast.USub) else v
    if isinstance(node, ast.Call):
        return _sqrt(_eval(node.args[0], env))
    a, b = _eval(node.left, env), _eval(node.right, env)          # type: ignore[attr-defined]
    op = node.op                                                   # type: ignore[attr-defined]
    if isinstance(op, ast.Add):
        return a + b
    if isinstance(op, ast.Sub):
        return a - b
    if isinstance(op, ast.Mult):
        return a * b
    if isinstance(op, ast.Div):
        if b == 0:
            raise ZeroDivisionError
        return a / b
    if b.denominator != 1 or abs(b) > 6:
        raise OcrError("Степень должна быть небольшим целым числом", code="BAD_EXPR")
    return a ** int(b)


def _isqrt_exact(n: int) -> int | None:
    if n < 0:
        return None
    r = math.isqrt(n)
    return r if r * r == n else None


def _sqrt(q: Fraction) -> Fraction:
    if q < 0:
        raise _Irrational
    a, b = _isqrt_exact(q.numerator), _isqrt_exact(q.denominator)
    if a is None or b is None:
        raise _Irrational
    return Fraction(a, b)


def _names(tree: ast.AST) -> set[str]:
    return {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and n.id != "S"}


_PROBES = (Fraction(2, 7), Fraction(5, 3), Fraction(-7, 4), Fraction(11, 5), Fraction(-3, 8))
_SEP = re.compile(r"\s*(?:;|,(?!\d)|\bили\b|\bлибо\b|\bor\b)\s*", re.I)
_EMPTY = re.compile(r"(нет\s+корней|корней\s+нет|нет\s+решений|решений\s+нет|∅|не\s+имеет\s+(?:действительных\s+)?корней)", re.I)
_SUBSCRIPT = re.compile(r"(?<![a-z\d])([xyz])([12])(?![\d.])")


def _expand_pm(f: str) -> list[str]:
    """«x=(5±1)/2» → две строки (+ и −); больше двух «±» в строке не раскрываем."""
    if "±" not in f:
        return [f]
    if f.count("±") > 2:
        raise OcrError("Слишком много «±» в одной строке", code="BAD_EXPR")
    out = [f]
    while any("±" in x for x in out):
        out = [y for x in out for y in ((x.replace("±", "+", 1), x.replace("±", "-", 1)) if "±" in x else (x,))]
    return out


def _poly(lhs: ast.AST, rhs: ast.AST, v: str) -> tuple[Fraction, Fraction, Fraction] | None:
    """lhs − rhs как многочлен степени ≤ 2 от v → (a, b, c); иначе None (дробно-рациональное, степень > 2)."""
    vals = [_eval(lhs, {v: p}) - _eval(rhs, {v: p}) for p in _PROBES]
    x0, x1, x2 = _PROBES[:3]
    y0, y1, y2 = vals[:3]
    d01, d12 = (y1 - y0) / (x1 - x0), (y2 - y1) / (x2 - x1)
    a = (d12 - d01) / (x2 - x0)
    b = d01 - a * (x0 + x1)
    c = y0 - a * x0 * x0 - b * x0
    if all(a * p * p + b * p + c == y for p, y in zip(_PROBES, vals)):
        return a, b, c
    return None


def _roots(a: Fraction, b: Fraction, c: Fraction) -> tuple[str, Any]:
    """Множество решений ax²+bx+c=0: ('set', frozenset) | ('irr', (b/a, c/a)) | ('all', None) | ('none', None)."""
    if a == 0:
        if b == 0:
            return ("all", None) if c == 0 else ("set", frozenset())
        return "set", frozenset({-c / b})
    disc = b * b - 4 * a * c
    if disc < 0:
        return "set", frozenset()
    try:
        r = _sqrt(disc)
    except _Irrational:
        return "irr", (b / a, c / a)
    return "set", frozenset({(-b + r) / (2 * a), (-b - r) / (2 * a)})


def _affine(lhs: ast.AST, rhs: ast.AST, names: list[str]) -> dict[str, Fraction] | None:
    """lhs − rhs линейно по всем переменным → {var: коэф., '': свободный член}; иначе None."""
    import itertools
    env0 = {n: Fraction(0) for n in names}
    f = lambda env: _eval(lhs, env) - _eval(rhs, env)  # noqa: E731
    c0 = f(env0)
    coef = {"": c0}
    for n in names:
        coef[n] = f({**env0, n: Fraction(1)}) - c0
    for combo in itertools.islice(itertools.product(_PROBES[:3], repeat=len(names)), 12):
        env = dict(zip(names, combo))
        if f(env) != c0 + sum(coef[n] * env[n] for n in names):
            return None
    return coef


def _solve(eqs: list[dict[str, Fraction]], names: list[str]) -> tuple[int, dict[str, Fraction] | None]:
    """Гаусс на дробях: ранг и единственное решение (если ранг = число переменных и система совместна)."""
    rows = [[e.get(n, Fraction(0)) for n in names] + [-e.get("", Fraction(0))] for e in eqs]
    rank, col, m = 0, 0, len(names)
    while rank < len(rows) and col < m:
        piv = next((r for r in range(rank, len(rows)) if rows[r][col] != 0), None)
        if piv is None:
            col += 1
            continue
        rows[rank], rows[piv] = rows[piv], rows[rank]
        pv = rows[rank][col]
        rows[rank] = [x / pv for x in rows[rank]]
        for r in range(len(rows)):
            if r != rank and rows[r][col] != 0:
                k = rows[r][col]
                rows[r] = [x - k * y for x, y in zip(rows[r], rows[rank])]
        rank += 1
        col += 1
    if any(all(x == 0 for x in row[:m]) and row[m] != 0 for row in rows):
        return rank, None
    if rank < m:
        return rank, None
    return rank, {names[i]: rows[i][m] for i in range(m)}


def _claim(part: str) -> dict[str, Any]:
    """Одна часть строки (строку уже разрезали по «;», «,», «или») → анализ."""
    if _EMPTY.search(part):
        return {"kind": "roots", "formula": "∅", "set": frozenset()}
    f = normalize_formula(part)
    if not f:
        raise OcrError("Пустое или слишком длинное выражение", code="BAD_EXPR")
    # Виет: x1+x2=…, x1*x2=… / x1x2=…
    vm = re.fullmatch(r"x1\+x2=(.+)|x1\*?x2=(.+)", f)
    if vm:
        rhs = [_parse(x) for x in (vm.group(1) or vm.group(2)).split("=")]
        if any(_names(t) for t in rhs):
            return {"kind": "unsupported", "formula": f}
        vals = {_eval(t, {}) for t in rhs}
        if len(vals) != 1:
            return {"kind": "false", "formula": f}
        return {"kind": "vieta_sum" if vm.group(1) else "vieta_prod", "formula": f, "value": vals.pop()}
    # дискриминант: d = b^2-4ac = 25-24 = 1 (a, b, c подставляются из последнего квадратного уравнения)
    if re.match(r"d=", f):
        return {"kind": "disc", "formula": f, "parts": [_parse(x) for x in f.split("=")[1:] if x]}
    sub = _SUBSCRIPT.match(f)
    if sub and f[sub.end():sub.end() + 1] == "=":
        f = sub.group(1) + f[sub.end():]           # x1=… → корень x=…
    variants = _expand_pm(f)
    if len(variants) > 1:
        sets = [_claim_single(x) for x in variants]
        if all(x["kind"] == "linear" for x in sets):
            return {"kind": "roots", "formula": f, "set": frozenset(x["root"] for x in sets), "var": sets[0]["var"]}
        return {"kind": "unsupported", "formula": f}
    return _claim_single(f)


def _claim_single(f: str) -> dict[str, Any]:
    parts = f.split("=")
    if len(parts) == 1:
        tree = _parse(parts[0])
        names = _names(tree)
        if names:
            return {"kind": "expression", "formula": f, "var": sorted(names)}
        return {"kind": "number", "formula": f, "value": _eval(tree, {})}
    if any(not x for x in parts):
        raise OcrError("В шаге должен быть ровно один знак «=»", code="BAD_EXPR")
    trees = [_parse(x) for x in parts]
    names = sorted(set().union(*(_names(t) for t in trees)))
    if not names:
        vals = [_eval(t, {}) for t in trees]
        ok = all(v == vals[0] for v in vals)
        return {"kind": "number" if ok else "false", "formula": f, "value": vals[-1]}
    if len(parts) > 2:
        # «x = (5+1)/2 = 3»: все части после переменной должны быть равны
        if isinstance(trees[0].body, ast.Name) and not any(_names(t) for t in trees[1:]):
            vals = [_eval(t, {}) for t in trees[1:]]
            if any(v != vals[0] for v in vals):
                return {"kind": "false", "formula": f}
            return {"kind": "linear", "formula": f, "var": trees[0].body.id, "root": vals[0]}
        return {"kind": "unsupported", "formula": f}
    lhs, rhs = trees
    if len(names) > 1:
        try:
            coef = _affine(lhs, rhs, names)
        except ZeroDivisionError:
            coef = None
        if coef is None or all(coef[n] == 0 for n in names):
            return {"kind": "unsupported", "formula": f}
        return {"kind": "system", "formula": f, "coef": coef, "names": names}
    v = names[0]
    try:
        poly = _poly(lhs, rhs, v)
    except ZeroDivisionError:
        return {"kind": "unsupported", "formula": f}
    if poly is None:
        return {"kind": "unsupported", "formula": f}
    a, b, c = poly
    if a == 0 and b == 0:
        return {"kind": "identity" if c == 0 else "false", "formula": f, "var": v}
    if a == 0:
        return {"kind": "linear", "formula": f, "var": v, "root": -c / b}
    kind, sol = _roots(a, b, c)
    return {"kind": "quadratic", "formula": f, "var": v, "abc": (a, b, c), "sol": (kind, sol)}


def _analyze(line: str) -> dict[str, Any]:
    """Строка → {kind: number|identity|linear|quadratic|roots|system|disc|vieta_*|unsupported|false, …}.
    Несколько утверждений в строке («x=2 или x=3», «x+y=5; x−y=1») разбираются по отдельности."""
    raw = (line or "")[:MAX_LINE_CHARS]
    raw = re.sub(r"(?i)^\s*(ответ|решение|проверка|дано|найти|шаг\s*\d+)\s*[:.)-]?\s*", "", raw)
    pieces = [p for p in _SEP.split(raw) if p and p.strip()]
    if len(pieces) <= 1:
        return _claim(raw)
    claims = [_claim(p) for p in pieces]
    if all(c["kind"] in ("linear", "roots") for c in claims) and len({c.get("var") for c in claims if c["kind"] == "linear"}) <= 1 \
            and all(c["kind"] != "linear" or True for c in claims) and len({c.get("var") for c in claims if c.get("var")}) <= 1:
        roots: set[Fraction] = set()
        for c in claims:
            roots |= {c["root"]} if c["kind"] == "linear" else set(c["set"])
        return {"kind": "roots", "formula": "; ".join(c["formula"] for c in claims), "set": frozenset(roots),
                "var": next((c.get("var") for c in claims if c.get("var")), None)}
    return {"kind": "multi", "formula": "; ".join(c["formula"] for c in claims), "claims": claims}


def _fmt(q: Fraction) -> str:
    return str(q.numerator) if q.denominator == 1 else f"{q.numerator}/{q.denominator}"


def _same(sol: tuple[str, Any] | None, other: tuple[str, Any]) -> bool:
    return sol is not None and sol[0] == other[0] and sol[1] == other[1]


class _State:
    """Контекст проверки: множество решений уравнения с одной переменной, коэффициенты последнего квадратного
    уравнения (для D и Виета) и система линейных уравнений с её решением."""

    def __init__(self) -> None:
        self.sol: tuple[str, Any] | None = None
        self.abc: tuple[Fraction, Fraction, Fraction] | None = None
        self.abc_step: int | None = None
        self.eqs: list[dict[str, Fraction]] = []
        self.names: list[str] = []
        self.solution: dict[str, Fraction] | None = None
        self.prev_value: Fraction | None = None

    # -- уравнение с одной переменной / система
    def single(self, a: dict[str, Any], i: int) -> tuple[str, str]:
        kind = a["kind"]
        if self.solution is not None and a.get("var") in self.solution and kind in ("linear", "roots"):
            want = self.solution[a["var"]]
            got = {a["root"]} if kind == "linear" else set(a["set"])
            return ("ok", "") if got == {want} else ("error", "Это значение не удовлетворяет системе — подставь его в оба уравнения")
        if kind == "linear":
            new = ("set", frozenset({a["root"]}))
        elif kind == "roots":
            new = ("set", a["set"])
        else:
            new = a["sol"]
            if kind == "quadratic":
                self.abc, self.abc_step = a["abc"], i
        if self.sol is None:
            self.sol = new
            return "ok", "Квадратное уравнение: дальше сверяем каждый шаг с его корнями" if kind == "quadratic" else ""
        if _same(self.sol, new):
            return "ok", ""
        if self.sol[0] == "set" and new[0] == "set" and new[1] and set(new[1]) < set(self.sol[1]):
            return "partial", "Одна из веток решения"
        self.sol = new
        if kind == "quadratic":
            return "error", "Этот шаг меняет корни уравнения — проверь перенос слагаемых и знаки"
        return "error", "Этот шаг меняет решение уравнения — проверь перенос и знаки"

    def system(self, a: dict[str, Any]) -> tuple[str, str]:
        coef, names = a["coef"], a["names"]
        if self.solution is not None:
            if set(names) <= set(self.solution):
                ok = coef[""] + sum(coef[n] * self.solution[n] for n in names) == 0
                return ("ok", "") if ok else ("error", "Это уравнение не следует из системы — проверь сложение, вычитание и подстановку")
            return "unchecked", "В этой строке новые переменные — такой шаг пока не проверяется автоматически"
        all_names = sorted(set(self.names) | set(names))
        if len(all_names) > 3:
            return "unchecked", "Системы больше чем с тремя неизвестными пока не проверяются"
        before, _ = _solve(self.eqs, all_names) if self.eqs else (0, None)
        self.eqs.append(coef)
        self.names = all_names
        rank, solution = _solve(self.eqs, all_names)
        if rank == before:
            consistent = _solve(self.eqs, all_names)[1] is not None or rank < len(all_names)
            return ("ok", "Равносильное преобразование системы") if consistent else ("error", "Это уравнение противоречит системе")
        if solution is not None:
            self.solution = solution
            return "ok", "Система задана: дальше каждую строку проверяем подстановкой"
        return "ok", "Условие системы"


def check_steps(lines: list[str], boxes: list[list[float] | None] | None = None,
                width: int | None = None, height: int | None = None) -> dict[str, Any]:
    """Шаги решения сверху вниз → первая ошибка (номер шага, рамка в долях кадра) без выдачи ответа.

    Правила (v3.2): соседние уравнения равносильны — совпадает МНОЖЕСТВО решений (линейные, квадратные с точными
    корнями, «x=2 или x=3», «x=(5±1)/2»); строка «D = …» сверяется с b²−4ac последнего квадратного уравнения;
    «x1+x2», «x1·x2» — с теоремой Виета; системы линейных уравнений (до трёх неизвестных) решаются точно на дробях,
    и каждая следующая строка проверяется подстановкой. Числовой шаг «a = b» должен быть верным; цепочка выражений без
    «=» сравнивается по значению с предыдущей строкой. Иррациональные корни (√ не из точного квадрата) — «не проверено».
    Верный переход после первой ошибки — «carried» (следствие ошибки), а не вторая ошибка и не «верно».
    Ни корни, ни дискриминант, ни решение системы в ответ не попадают."""
    clean = [str(x or "").strip()[:MAX_LINE_CHARS] for x in (lines or [])][:MAX_LINES]
    clean = [x for x in clean if x]
    if not clean:
        raise OcrError("Нет строк решения для проверки", code="NO_LINES")
    steps: list[dict[str, Any]] = []
    first_error: int | None = None
    st = _State()
    for i, text in enumerate(clean):
        step: dict[str, Any] = {"i": i, "text": text}
        try:
            a = _analyze(text)
        except OcrError as exc:
            step.update(status="unreadable", reason=exc.message)
            steps.append(step)
            continue
        except ZeroDivisionError:
            a = {"kind": "false", "formula": normalize_formula(text)}
        except _Irrational:
            a = {"kind": "unsupported", "formula": normalize_formula(text)}
        step["formula"] = a["formula"]
        try:
            status, reason = _judge(a, st, i, len(clean))
        except ZeroDivisionError:
            status, reason = "error", "В этом шаге получается деление на ноль"
        except _Irrational:
            status, reason = "unchecked", "Корень не извлекается нацело — такой шаг пока не проверяется автоматически"
        step["kind"] = {"quadratic": "quadratic", "disc": "discriminant", "vieta_sum": "vieta", "vieta_prod": "vieta",
                        "system": "system", "roots": "roots"}.get(a["kind"], "step")
        if a["kind"] in ("linear", "roots") and i == len(clean) - 1 and st.sol is not None:
            step["final"] = True
        if status == "ok" and first_error is not None and a["kind"] in ("linear", "number", "quadratic", "roots", "system", "disc"):
            status, reason = "carried", f"Переход верный, но опирается на ошибку в шаге {first_error + 1}"
        step.update(status=status, reason=reason)
        if status == "error" and first_error is None:
            first_error = i
        steps.append(step)
    bbox = None
    if first_error is not None and boxes and first_error < len(boxes) and boxes[first_error]:
        bbox = rel_bbox(boxes[first_error], width, height)
    checked = sum(1 for s in steps if s["status"] in ("ok", "error", "carried"))
    return {"steps": steps, "first_error": first_error, "error_bbox": bbox, "checked": checked, "total": len(steps),
            "verdict": "error" if first_error is not None else ("ok" if checked else "unchecked"),
            "message": (f"Ошибка в шаге {first_error + 1}: {steps[first_error]['reason']}" if first_error is not None
                        else "Ошибок в проверенных шагах не найдено" if checked else "Не нашлось шагов, которые можно проверить")}


def _judge(a: dict[str, Any], st: _State, i: int, total: int) -> tuple[str, str]:
    kind = a["kind"]
    if kind == "multi":
        verdicts = [_judge(c, st, i, total) for c in a["claims"]]
        bad = next((v for v in verdicts if v[0] == "error"), None)
        if bad:
            return bad
        if all(v[0] in ("ok", "partial") for v in verdicts):
            return "ok", ""
        return next((v for v in verdicts if v[0] == "unchecked"), ("unchecked", "Такой шаг пока не проверяется автоматически"))
    if kind == "false":
        return "error", "Равенство в этом шаге неверно — пересчитай обе части"
    if kind in ("linear", "roots", "quadratic"):
        status, reason = st.single(a, i)
        if status == "partial":
            if i == total - 1 and kind in ("linear", "roots"):
                return "error", "Найдены не все корни — проверь вторую ветку решения"
            return "ok", reason
        return status, reason
    if kind == "system":
        return st.system(a)
    if kind == "number":
        if st.prev_value is not None and "=" not in a["formula"] and a["value"] != st.prev_value:
            st.prev_value = a["value"]
            return "error", "Значение изменилось по сравнению с прошлой строкой"
        st.prev_value = a["value"]
        return "ok", ""
    if kind == "identity":
        return "ok", "Тождество: обе части равны при любом значении"
    if kind == "disc":
        if st.abc is None:
            return "unchecked", "Дискриминант сверяется с квадратным уравнением выше — его пока нет"
        qa, qb, qc = st.abc
        env = {"a": qa, "b": qb, "c": qc}
        want = qb * qb - 4 * qa * qc
        vals = [_eval(t, env) for t in a["parts"]]
        if any(v != want for v in vals):
            return "error", f"Дискриминант не сходится с a, b, c из шага {st.abc_step + 1}: проверь b² − 4ac и знаки"
        return "ok", ""
    if kind in ("vieta_sum", "vieta_prod"):
        if st.abc is None:
            return "unchecked", "Теорема Виета сверяется с квадратным уравнением выше — его пока нет"
        qa, qb, qc = st.abc
        want = -qb / qa if kind == "vieta_sum" else qc / qa
        if a["value"] != want:
            return "error", ("Сумма корней по Виету не сходится — вспомни знак перед b" if kind == "vieta_sum"
                             else "Произведение корней по Виету не сходится — проверь c / a")
        return "ok", ""
    return "unchecked", "Такой шаг пока не проверяется автоматически"


def rel_bbox(box: list[float], width: int | None, height: int | None) -> dict[str, float] | None:
    """Пиксельная рамка → доли кадра [0..1] (для наложения поверх фото любого размера)."""
    if not box or len(box) != 4:
        return None
    x, y, w, h = (float(v) for v in box)
    if width and height and width > 0 and height > 0 and max(x + w, y + h) > 1.0001:
        x, w = x / width, w / width
        y, h = y / height, h / height
    clamp = lambda v: round(max(0.0, min(1.0, v)), 4)  # noqa: E731
    return {"x": clamp(x), "y": clamp(y), "w": clamp(w), "h": clamp(h)}
