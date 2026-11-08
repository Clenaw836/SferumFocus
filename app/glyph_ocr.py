"""v3.2 · OCR-02: встроенный распознаватель ПЕЧАТНОГО текста без tesseract (Pillow + битовые шаблоны глифов).

Зачем: в окружении без бинарника ``tesseract`` кнопки «Внести ДЗ по фото» и «Сообщить об изменении» больше не
отвечают 503 — фото скриншота/распечатки расписания читается детерминированно, без сети и без ИИ.

Как (честно и просто):
  0. Сначала — текстовые метаданные изображения (PNG tEXt/iTXt «Description/Comment», EXIF ImageDescription):
     некоторые приложения кладут туда подпись. Это ненадёжный пользовательский ввод — как и любой OCR-текст.
  1. Оттенки серого → порог Оцу → полярность (тёмная тема скриншота инвертируется).
  2. Строки — по горизонтальной проекции «чернил», глифы — по вертикальной проекции внутри строки.
  3. Каждый глиф → маска 16×16 (битовое число) + пропорции + положение относительно базовой линии строки;
     ближайший шаблон из ``app/data/glyph_atlas.json`` (Liberation Sans/Serif/Mono, Droid Sans: OFL/Apache)
     по расстоянию Хэмминга с поправками на пропорции. Слипшиеся глифы делятся по минимуму проекции.
  4. Постобработка: «ЬI» → «Ы», цифры/буквы по контексту токена (О↔0, З↔3, б↔6, l/I↔1), слова
     сверяются со словарём школьных предметов и дней недели (Левенштейн ≤ 1–2).
Ограничения: рукопись, сильный наклон, фото под углом и мелкий шрифт (< 9 px высоты строки) читаются плохо —
уверенность (legibility) тогда низкая, и интерфейс не применяет такой текст молча.
"""
from __future__ import annotations

import io
import json
import math
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

SIZE = 16
_ATLAS = Path(__file__).resolve().parent / "data" / "glyph_atlas.json"
MAX_SIDE = 1600
MAX_TEXT = 4000


def bitmask(img: Any) -> int:
    """Глиф (режим «L», чернила светлые = 255) → SIZE×SIZE бит (старший бит — левый верхний пиксель)."""
    from PIL import Image
    small = img.resize((SIZE, SIZE), Image.BOX)
    bits = 0
    for v in small.tobytes():
        bits = (bits << 1) | (1 if v >= 80 else 0)
    return bits


@lru_cache(maxsize=1)
def atlas() -> list[tuple[str, int, float, float, float]]:
    data = json.loads(_ATLAS.read_text(encoding="utf-8"))
    if data.get("size") != SIZE:
        raise ValueError("glyph_atlas.json: другой размер маски")
    return [(g["ch"], int(g["bits"], 16), float(g["ar"]), float(g["hr"]), float(g["bo"])) for g in data["glyphs"]]


def available() -> bool:
    try:
        import PIL  # noqa: F401
        return bool(atlas())
    except Exception:  # noqa: BLE001 — нет Pillow/атласа = встроенного распознавателя нет
        return False


# ------------------------------------------------------------------ 0. метаданные
_META_KEYS = ("Description", "Comment", "Text", "Title", "ImageDescription", "UserComment")


def metadata_text(img: Any) -> str:
    out: list[str] = []
    info = getattr(img, "info", {}) or {}
    for k in _META_KEYS:
        v = info.get(k)
        if isinstance(v, bytes):
            v = v.decode("utf-8", "ignore")
        if isinstance(v, str) and v.strip():
            out.append(v.strip())
    try:
        exif = img.getexif()
        v = exif.get(0x010E)
        if isinstance(v, bytes):
            v = v.decode("utf-8", "ignore")
        if isinstance(v, str) and v.strip():
            out.append(v.strip())
    except Exception:  # noqa: BLE001
        pass
    text = "\n".join(dict.fromkeys(out))
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", text)[:MAX_TEXT]


# ------------------------------------------------------------------ 1. бинаризация
def _otsu(hist: list[int]) -> int:
    total = sum(hist)
    sum_all = sum(i * h for i, h in enumerate(hist))
    w_b = sum_b = 0
    best, thr = -1.0, 127
    for t in range(256):
        w_b += hist[t]
        if not w_b:
            continue
        w_f = total - w_b
        if not w_f:
            break
        sum_b += t * hist[t]
        m_b, m_f = sum_b / w_b, (sum_all - sum_b) / w_f
        between = w_b * w_f * (m_b - m_f) ** 2
        if between > best:
            best, thr = between, t
    return thr


def _ink(img: Any) -> Any:
    """→ изображение «L», где чернила = 255, фон = 0."""
    from PIL import ImageOps
    g = ImageOps.exif_transpose(img).convert("L")
    if max(g.size) > MAX_SIDE:
        k = MAX_SIDE / max(g.size)
        g = g.resize((max(1, int(g.width * k)), max(1, int(g.height * k))))
    t = _otsu(g.histogram())
    dark_bg = sum(g.histogram()[:t + 1]) > g.width * g.height / 2
    return g.point(lambda v, t=t, d=dark_bg: 255 if ((v > t) if d else (v <= t)) else 0)


def _runs(counts: list[int], min_gap: int = 1) -> list[tuple[int, int]]:
    runs, start, gap = [], None, 0
    for i, c in enumerate(counts):
        if c:
            if start is None:
                start = i
            gap = 0
            end = i
        elif start is not None:
            gap += 1
            if gap >= min_gap:
                runs.append((start, end + 1))
                start = None
    if start is not None:
        runs.append((start, end + 1))
    return runs


def _row_counts(ink: Any) -> list[int]:
    w = ink.width
    data = ink.tobytes()
    return [w - data[y * w:(y + 1) * w].count(0) for y in range(ink.height)]


def _lines(ink: Any) -> list[tuple[int, int]]:
    bands = _runs(_row_counts(ink))
    if not bands:
        return []
    hs = sorted(b - a for a, b in bands)
    med = hs[len(hs) // 2]
    merged: list[list[int]] = []
    for a, b in bands:
        # точки/кратка над строкой (й, ё) и маленькие хвосты — к соседней строке
        if merged and (a - merged[-1][1] < max(2, med * 0.35)) and ((b - a) < med * 0.45 or (merged[-1][1] - merged[-1][0]) < med * 0.45):
            merged[-1][1] = b
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged if b - a >= 6]


# ------------------------------------------------------------------ 2–3. глифы и сопоставление
def _score(bits: int, ar: float, hr: float, bo: float, tpl: tuple[str, int, float, float, float]) -> float:
    _ch, tb, tar, thr, tbo = tpl
    return ((bits ^ tb).bit_count() / (SIZE * SIZE) + 0.32 * abs(math.log((ar + 0.02) / (tar + 0.02)))
            + 0.55 * abs(hr - thr) + 0.55 * abs(bo - tbo))


def _best(crop: Any, ar: float, hr: float, bo: float) -> tuple[str, float]:
    bits = bitmask(crop)
    best_ch, best = "?", 9.0
    for tpl in atlas():
        s = _score(bits, ar, hr, bo, tpl)
        if s < best:
            best_ch, best = tpl[0], s
    return best_ch, best


def _components(line: Any) -> list[list[int]]:
    """Связные области «чернил» строки (8-связность) через горизонтальные отрезки + union-find → [x0, y0, x1, y1, area]."""
    w, h = line.width, line.height
    data = line.tobytes()
    parent: list[int] = []
    boxes: list[list[int]] = []

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    prev: list[tuple[int, int, int]] = []
    for y in range(h):
        row = data[y * w:(y + 1) * w]
        cur: list[tuple[int, int, int]] = []
        x = row.find(255)
        while x != -1:
            e = row.find(0, x)
            if e == -1:
                e = w
            idx = len(parent)
            parent.append(idx); boxes.append([x, y, e, y + 1, e - x])
            for a, b, j in prev:
                if a <= e and b >= x:          # перекрытие с допуском по диагонали (8-связность)
                    ra, rb = find(idx), find(j)
                    if ra != rb:
                        parent[rb] = ra
            cur.append((x, e, idx))
            x = row.find(255, e)
        prev = cur
    comps: dict[int, list[int]] = {}
    for i, bx in enumerate(boxes):
        r = find(i)
        c = comps.get(r)
        if c is None:
            comps[r] = list(bx)
        else:
            c[0] = min(c[0], bx[0]); c[1] = min(c[1], bx[1]); c[2] = max(c[2], bx[2]); c[3] = max(c[3], bx[3]); c[4] += bx[4]
    return [c for c in comps.values() if c[4] >= 2]


def _glyph_boxes(line: Any) -> list[tuple[int, int, int, int]]:
    comps = sorted(_components(line), key=lambda c: c[0])
    if not comps:
        return []
    cap = max(4, sorted(c[3] - c[1] for c in comps)[int(len(comps) * 0.8)] if len(comps) > 1 else comps[0][3] - comps[0][1])
    small = lambda c: (c[3] - c[1]) < 0.45 * cap  # noqa: E731 — точки, кратка, черта «=»
    merged: list[list[int]] = []
    for c in comps:
        for m in reversed(merged[-3:]):
            ov = min(m[2], c[2]) - max(m[0], c[0])
            if ov >= 0.5 * min(m[2] - m[0], c[2] - c[0]) and (small(c) or small(m)):
                m[0] = min(m[0], c[0]); m[1] = min(m[1], c[1]); m[2] = max(m[2], c[2]); m[3] = max(m[3], c[3]); m[4] += c[4]
                break
        else:
            merged.append(list(c))
    return [(m[0], m[1], m[2], m[3]) for m in sorted(merged, key=lambda m: m[0])]


def _metrics(boxes: list[tuple[int, int, int, int]]) -> tuple[float, float]:
    maxh = max(y1 - y0 for _x0, y0, _x1, y1 in boxes)
    big = sorted(y1 for _x0, y0, _x1, y1 in boxes if y1 - y0 >= 0.5 * maxh) or [maxh]
    base = big[len(big) // 2]
    on = sorted(y1 - y0 for _x0, y0, _x1, y1 in boxes if abs(y1 - base) <= max(1, 0.1 * maxh) and y1 - y0 >= 0.5 * maxh)
    if not on:
        return float(base), float(maxh)
    top = [h for h in on if h >= 0.85 * on[-1]]
    return float(base), float(top[len(top) // 2])


def _read_line(line: Any) -> tuple[str, float, int]:
    boxes = _glyph_boxes(line)
    if not boxes:
        return "", 0.0, 0
    base, cap = _metrics(boxes)
    cap = max(cap, 4.0)
    glyphs: list[tuple[str, float, int, int]] = []
    for x0, y0, x1, y1 in boxes:
        w, h = x1 - x0, y1 - y0
        crop = line.crop((x0, y0, x1, y1))
        ch, s = _best(crop, w / max(1, h), h / cap, (base - y1) / cap)
        # слипшиеся глифы: широкий плохо узнанный кусок делим по минимуму проекции
        if s > 0.42 and w > 0.9 * cap:
            split = _split(line, x0, x1, base, cap)
            if split and split[1] < s:
                ch, s = split
        glyphs.append((ch, s, x0, x1))
    out: list[str] = []
    right = None
    for i, (ch, _s, x0, x1) in enumerate(glyphs):
        if right is not None:
            both_digits = out[-1][-1:].isdigit() and ch[:1].isdigit()
            if x0 - right > (0.5 if both_digits else 0.3) * cap:
                out.append(" ")
        right = max(x1, right or x1)
        out.append(ch)
    scores = [g[1] for g in glyphs]
    conf = max(0.0, min(1.0, 1.0 - (sum(scores) / len(scores) - 0.08) / 0.4)) if scores else 0.0
    return "".join(out), conf, len(scores)


def _split(line: Any, x0: int, x1: int, base: float, cap: float) -> tuple[str, float] | None:
    from PIL import Image
    seg = line.crop((x0, 0, x1, line.height))
    cols = _row_counts(seg.transpose(Image.TRANSPOSE))
    lo, hi = int(0.25 * cap), len(cols) - int(0.25 * cap)
    if hi <= lo:
        return None
    cut = min(range(lo, hi), key=lambda i: cols[i])
    parts, total = [], 0.0
    for a, b in ((0, cut), (cut, len(cols))):
        bb = seg.crop((a, 0, b, seg.height)).getbbox()
        if not bb:
            return None
        crop = seg.crop((a + bb[0], bb[1], a + bb[2], bb[3]))
        ch, s = _best(crop, crop.width / max(1, crop.height), crop.height / cap, (base - bb[3]) / cap)
        parts.append(ch); total += s
    return "".join(parts), total / 2


# ------------------------------------------------------------------ 4. постобработка
LEXICON = ("Расписание", "Алгебра", "Геометрия", "Математика", "Русский", "язык", "Литература", "Английский",
           "Немецкий", "Французский", "Информатика", "Физика", "Химия", "Биология", "География", "История",
           "Обществознание", "Физкультура", "Музыка", "Технология", "ИЗО", "ОБЖ", "ОБЗР", "Астрономия",
           "Литературное", "чтение", "Окружающий", "мир", "Вероятность", "статистика", "Родной", "класс",
           "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "урок", "уроки", "кабинет",
           "каб", "Домашнее", "задание", "параграф", "упр", "стр", "номер", "выучить", "прочитать", "решить",
           "среду", "четверг", "пятницу", "завтра", "сегодня", "изменение", "замена", "вместо", "на")
_LAT2CYR = str.maketrans("AaBCcEeHKMOoPpTXxyY", "АаВСсЕеНКМОоРрТХхуУ")
_DIGITLIKE = set("ОоOoЗзбlI|SBБ")
_TO_DIGIT = str.maketrans({"О": "0", "о": "0", "O": "0", "o": "0", "З": "3", "з": "3", "б": "6", "l": "1",
                           "I": "1", "|": "1", "S": "5", "B": "8", "Б": "6"})


def _lev(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


@lru_cache(maxsize=1)
def _lex() -> dict[str, str]:
    return {w.lower(): w for w in LEXICON}


def _fix_word(w: str) -> str:
    w = re.sub(r"[ЬьbБ][I1l|ı]", lambda m: "Ы" if m.group(0)[0] in "ЬБ" else "ы", w)
    w = w.replace("\'\'", '"')
    digits = sum(c.isdigit() for c in w)
    letters = sum(c.isalpha() for c in w)
    if digits and (digits >= letters or all(c in _DIGITLIKE for c in w if c.isalpha())):
        return w.translate(_TO_DIGIT)
    if letters and any("а" <= c.lower() <= "я" or c in "ёЁ" for c in w):
        core = re.sub(r"[^\w]", "", w)
        w = w.translate(_LAT2CYR).replace("0", "о" if core[:1].islower() else "О")
    m = re.match(r"^([«(\"']?)([\wЁё-]+)([».,:;!?)\"']*)$", w)
    if not m:
        return w
    pre, core, post = m.groups()
    low = core.lower()
    lex = _lex()
    if low in lex or len(core) < 3:
        return pre + (lex.get(low, core) if low in lex and core[:1].isupper() == lex[low][:1].isupper() else core) + post
    limit = 1 if len(core) < 7 else 2 if len(core) < 12 else 3
    best = min(lex, key=lambda k: _lev(low, k))
    if _lev(low, best) <= limit:
        cand = lex[best]
        cand = cand[:1].upper() + cand[1:] if core[:1].isupper() else cand[:1].lower() + cand[1:]
        return pre + cand + post
    return pre + core[:1] + core[1:].lower() + post if core[:1].isupper() and core[1:].isupper() and len(core) > 3 and not core.isupper() else pre + core + post


def _fix_line(text: str) -> str:
    words = [_fix_word(w) for w in text.split(" ")]
    s = " ".join(w for w in words if w)
    s = re.sub(r"(?<![\w])N[^\s\d]?(?=\s*\d)|(?<![\w])N9(?=\s+\d)", "№", s)   # «N°», «Nе 245» → «№ 245»
    s = re.sub(r"((?:[0-9IlО|]\s?){1,2})\s*:\s*([0-9ОЗо]{2})\b",
               lambda m: m.group(1).replace(" ", "").translate(_TO_DIGIT) + ":" + m.group(2).translate(_TO_DIGIT), s)  # «I I :25» → «11:25»
    s = re.sub(r"^([ЗзОоlI|бБ]{1,2})(?=\s?[.)\-–]\s*\d)", lambda m: m.group(1).translate(_TO_DIGIT), s)   # «З. 10:25» → «3. 10:25»
    s = re.sub(r"^(\d{1,2})\s*[.,:;\-–]\s*(?=\d{1,2}:\d{2})", r"\1. ", s)   # «1.08:30», «2:09:25» → «1. 08:30»
    s = re.sub(r"(\d{1,2})\s*:\s*(\d{2})\b", r"\1:\2", s)              # «08 : 30» → «08:30»
    return s.strip()


def recognize(raw: bytes) -> dict[str, Any]:
    """Байты изображения → {engine, text, lines:[{text, bbox, conf}], legibility, width, height}."""
    from PIL import Image, UnidentifiedImageError
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ValueError("not an image") from exc
    meta = metadata_text(img)
    if meta:
        return {"engine": "metadata", "text": meta, "lines": [{"text": t, "bbox": None, "conf": 1.0} for t in meta.splitlines() if t.strip()],
                "legibility": 0.9, "width": img.width, "height": img.height}
    ink = _ink(img)
    lines: list[dict[str, Any]] = []
    weight = conf_sum = 0.0
    for a, b in _lines(ink):
        band = ink.crop((0, a, ink.width, b))
        bb = band.getbbox()
        if not bb:
            continue
        text, conf, n = _read_line(band)
        text = _fix_line(text)
        if not text:
            continue
        k = img.width / ink.width
        lines.append({"text": text, "bbox": [round(bb[0] * k), round(a * k), round((bb[2] - bb[0]) * k), round((b - a) * k)],
                      "conf": round(conf, 2)})
        weight += n; conf_sum += conf * n
        if len(lines) >= 60:
            break
    legibility = round(conf_sum / weight, 2) if weight else 0.0
    return {"engine": "builtin", "text": "\n".join(ln["text"] for ln in lines)[:MAX_TEXT], "lines": lines,
            "legibility": legibility, "width": img.width, "height": img.height}
