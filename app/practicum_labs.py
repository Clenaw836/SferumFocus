"""Детерминированные модели интерактивных лабораторий «Практикумов СферумФокус».

Каждая механика — чистая функция ``derive(model, state, config) -> dict``: из параметров, которые ученик
выставил на холсте (ползунки, гири, атомы, блоки), вычисляет наблюдаемые величины (вершина параболы,
сила тока, площадь, валентность…). Проверка действия (``check``) сравнивает *состояние модели* с
ограничениями этапа, а не только выбранный вариант ответа: так «action_check» видит, что ученик
действительно выставил a < 0 или уравновесил чаши весов.

Ограничение этапа: ``{"q": "<величина>", "op": "eq|ne|lt|le|gt|ge|true|false|in|composition|neighbors",
"v": значение, "tol": допуск, "principle": "<id нарушенного принципа>", "say": "шаблон пояснения"}``.
Проверка ответа ученика: ``{"field": "<поле ввода>", "q": "<величина модели>", "tol": допуск, ...}`` —
сравнивает введённое число с величиной, посчитанной по *его же* состоянию модели.

Модуль не ходит в сеть и в БД; фронтенд (``frontend/src/ui/practicum/labs/*``) повторяет те же формулы
только для мгновенной отрисовки, итог всегда проверяет сервер.
"""
from __future__ import annotations

import math
from collections import Counter
from typing import Any

import re as _re

_ROBOT_CMD = _re.compile(r"(up|down|left|right)(\*[2-9])?")
MODELS = ("quadratic", "linear", "scales", "area", "ohm", "molecule", "climate", "order", "classify", "robot")

# --------------------------------------------------------------------------------------- utils


def _num(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _snap(value: float, step: float) -> float:
    if step <= 0:
        return value
    return round(round(value / step) * step, 6)


def fmt(value: Any) -> str:
    """Число для текста пояснения: 2.0 → «2», 0.5 → «0,5», −3 → «−3»."""
    if value is None:
        return "—"
    if isinstance(value, bool):
        return "да" if value else "нет"
    if isinstance(value, (int, float)):
        v = round(float(value), 3)
        text = str(int(v)) if v == int(v) else f"{v:.3f}".rstrip("0").rstrip(".")
        return text.replace("-", "−").replace(".", ",")
    return str(value)


def parse_number(raw: Any) -> float | None:
    """Ответ ученика «2,5», «−3», «2.5 А» → 2.5 / −3; мусор → None."""
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return float(raw) if math.isfinite(float(raw)) else None
    text = str(raw or "").strip().replace(",", ".").replace("−", "-").replace("–", "-").replace(" ", "")
    num = ""
    for ch in text:
        if ch.isdigit() or ch in ".-" or (ch == "/" and num):
            num += ch
        elif num:
            break
    if not num or num in "-.":
        return None
    try:
        if "/" in num:
            top, bottom = num.split("/", 1)
            return float(top) / float(bottom) if float(bottom) else None
        return float(num)
    except ValueError:
        return None


# ------------------------------------------------------------------------------------- модели
RANGES: dict[str, dict[str, tuple[float, float, float]]] = {
    "quadratic": {"a": (-3, 3, 0.5), "b": (-8, 8, 1), "c": (-9, 9, 1)},
    "linear": {"k": (-4, 4, 0.5), "b": (-6, 6, 1)},
    "area": {"a": (1, 12, 1), "b": (1, 12, 1), "h": (1, 10, 1), "offset": (-6, 6, 1), "r": (1, 10, 1)},
    "ohm": {"U": (0, 24, 1), "R": (1, 30, 1), "R2": (1, 30, 1)},
    "climate": {"alt": (0, 10000, 100), "lat": (0, 90, 1)},
}


def normalize(model: str, state: dict[str, Any] | None, config: dict[str, Any] | None = None) -> dict[str, Any]:
    """Приводит состояние к допустимым диапазонам (клиенту нельзя «подсунуть» a = 10⁹ или a = 0)."""
    config = config or {}
    raw = dict(state or {})
    out: dict[str, Any] = {}
    if model in RANGES:
        for key, (low, high, step) in RANGES[model].items():
            if key in raw or key in config.get("initial", {}):
                fallback = _num(config.get("initial", {}).get(key, low), low)   # мусор от клиента → стартовое значение
                value = _num(raw.get(key, fallback), fallback)
                out[key] = _snap(_clamp(value, low, high), step)
        if model == "quadratic" and out.get("a", 1) == 0:
            out["a"] = 0.5          # a = 0 — уже не квадратичная функция; модель не позволяет вырождение
    if model == "area":
        shape = str(raw.get("shape") or config.get("initial", {}).get("shape") or "rectangle")
        out["shape"] = shape if shape in ("rectangle", "parallelogram", "triangle", "trapezoid", "circle") else "rectangle"
    elif model == "ohm":
        out["closed"] = bool(raw.get("closed", False))
        out["mode"] = raw.get("mode") if raw.get("mode") in ("single", "series", "parallel") else config.get("initial", {}).get("mode", "single")
        rows = raw.get("measurements") if isinstance(raw.get("measurements"), list) else []
        clean = []
        for row in rows[:12]:
            if isinstance(row, dict):
                clean.append({"U": _num(row.get("U")), "R": _num(row.get("R"), 1.0), "I": parse_number(row.get("I"))})
        out["measurements"] = clean
        if "student_calculated_I" in raw:
            out["student_calculated_I"] = parse_number(raw.get("student_calculated_I"))
    elif model == "scales":
        for key in ("lx", "lw", "rx", "rw", "div"):
            if key in raw or key in config.get("initial", {}):
                out[key] = int(_clamp(_num(raw.get(key, config.get("initial", {}).get(key, 0))), 0, 60))
    elif model == "molecule":
        atoms, ids = [], set()
        for atom in (raw.get("atoms") if isinstance(raw.get("atoms"), list) else [])[:16]:
            if isinstance(atom, dict) and str(atom.get("el")) in VALENCE and str(atom.get("id", "")) not in ids:
                ids.add(str(atom.get("id")))
                atoms.append({"id": str(atom.get("id")), "el": str(atom.get("el"))})
        bonds = []
        for bond in (raw.get("bonds") if isinstance(raw.get("bonds"), list) else [])[:24]:
            if not isinstance(bond, dict):
                continue
            a, b = str(bond.get("a")), str(bond.get("b"))
            if a in ids and b in ids and a != b:
                bonds.append({"a": a, "b": b, "order": int(_clamp(_num(bond.get("order"), 1), 1, 3))})
        out["atoms"], out["bonds"] = atoms, bonds
    elif model == "climate":
        out.setdefault("alt", 0)
        out.setdefault("lat", float(config.get("initial", {}).get("lat", 55)))
    elif model == "order":
        items = [str(i) for i in (raw.get("order") if isinstance(raw.get("order"), list) else [])][:12]
        out["order"] = list(dict.fromkeys(items))
    elif model == "classify":
        assign = raw.get("assign") if isinstance(raw.get("assign"), dict) else {}
        out["assign"] = {str(k): str(v) for k, v in list(assign.items())[:24]}
    elif model == "robot":
        out["program"] = [str(c) for c in (raw.get("program") if isinstance(raw.get("program"), list) else []) if _ROBOT_CMD.fullmatch(str(c))][:30]
    for key, value in raw.items():          # поля ответа (student_D, student_T …) не теряем
        if key.startswith("student_") and key not in out:
            out[key] = parse_number(value) if not isinstance(value, (list, dict)) else None
    return out


# валентности для школьного конструктора (S — высшая валентность VI в H₂SO₄)
VALENCE = {"H": 1, "O": 2, "C": 4, "N": 3, "S": 6, "Cl": 1}
ELEMENT_RU = {"H": "водород", "O": "кислород", "C": "углерод", "N": "азот", "S": "сера", "Cl": "хлор"}
# Условные (усреднённые) границы поясов по широте для учебной модели; реальные границы извилисты —
# об этом прямо сказано на экране экспедиции.
CLIMATE_BELTS = ((0, 5, "экваториальный"), (5, 20, "субэкваториальный"), (20, 30, "тропический"),
                 (30, 44, "субтропический"), (44, 66, "умеренный"), (66, 72, "субарктический"), (72, 91, "арктический"))
LAPSE_RATE_PER_KM = 6.0          # °C на 1 км подъёма (школьное правило тропосферы)
PRESSURE_DROP_PER_100M = 10.0    # мм рт. ст. на 100 м (школьное приближение для нижней тропосферы)
PRESSURE_RULE_MAX_ALT = 3000     # м: выше линейное правило уже заметно врёт


def _quadratic(state: dict[str, Any]) -> dict[str, Any]:
    a, b, c = _num(state.get("a"), 1), _num(state.get("b")), _num(state.get("c"))
    d = b * b - 4 * a * c
    x0 = -b / (2 * a)
    y0 = a * x0 * x0 + b * x0 + c
    roots: list[float] = []
    if d > 1e-9:
        r = math.sqrt(d)
        roots = sorted([(-b - r) / (2 * a), (-b + r) / (2 * a)])
    elif abs(d) <= 1e-9:
        roots = [x0]
    return {"a": a, "b": b, "c": c, "D": d, "x0": round(x0, 6), "y0": round(y0, 6), "n_roots": len(roots),
            "x1": round(roots[0], 6) if roots else None, "x2": round(roots[-1], 6) if roots else None,
            "opens": "up" if a > 0 else "down", "y_intercept": c}


def _linear(state: dict[str, Any]) -> dict[str, Any]:
    k, b = _num(state.get("k"), 1), _num(state.get("b"))
    return {"k": k, "b": b, "x_zero": round(-b / k, 6) if k else None, "increasing": k > 0, "y_intercept": b}


def _scales(state: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    x = _num(config.get("x_true"), 1)
    lx, lw, rx, rw = (int(_num(state.get(k))) for k in ("lx", "lw", "rx", "rw"))
    left, right = lx * x + lw, rx * x + rw
    isolated = (lx == 1 and lw == 0 and rx == 0) or (rx == 1 and rw == 0 and lx == 0)
    identity = lx == rx and lw == rw
    return {"lx": lx, "lw": lw, "rx": rx, "rw": rw, "left": left, "right": right,
            "balanced": abs(left - right) < 1e-9, "tilt": (left > right) - (left < right),
            "heavier": "левая" if left > right else ("правая" if right > left else "ни одна"),
            "isolated": isolated and abs(left - right) < 1e-9, "x_lost": identity,
            "x_found": (rw if lx == 1 else lw) if isolated else None, "x_count": lx + rx}


def _area(state: dict[str, Any]) -> dict[str, Any]:
    shape = state.get("shape", "rectangle")
    a, b, h, r = _num(state.get("a"), 1), _num(state.get("b"), 1), _num(state.get("h"), 1), _num(state.get("r"), 1)
    if shape == "rectangle":
        s, p = a * b, 2 * (a + b)
    elif shape == "parallelogram":
        s, p = a * h, None
    elif shape == "triangle":
        s, p = a * h / 2, None
    elif shape == "trapezoid":
        s, p = (a + b) / 2 * h, None
    else:
        s, p = math.pi * r * r, None
    out = {"shape": shape, "a": a, "b": b, "h": h, "S": round(s, 6), "P": p, "square": shape == "rectangle" and a == b,
           "bases_equal": a == b, "bases_sum": a + b, "bases_min": min(a, b), "bases_max": max(a, b)}
    if shape == "circle":
        out.update({"r": r, "C": round(2 * math.pi * r, 6), "S_over_pi": r * r, "C_over_pi": 2 * r})
    return out


def _ohm(state: dict[str, Any]) -> dict[str, Any]:
    u, r = _num(state.get("U")), max(_num(state.get("R"), 1), 1e-9)
    mode = state.get("mode", "single")
    r2 = max(_num(state.get("R2"), 1), 1e-9)
    total = r if mode == "single" else (r + r2 if mode == "series" else r * r2 / (r + r2))
    closed = bool(state.get("closed"))
    current = u / total if closed else 0.0
    power = u * current
    rows = state.get("measurements") or []
    rows_ok = [row for row in rows if row.get("I") is not None and abs(row["I"] - row["U"] / max(row["R"], 1e-9)) <= 0.051]
    us = {row["U"] for row in rows}
    return {"U": u, "R": r, "R2": r2, "mode": mode, "R_total": round(total, 6), "closed": closed,
            "I": round(current, 6), "P": round(power, 6),
            "heat": "нет" if power == 0 else ("слабый" if power < 10 else ("заметный" if power < 40 else "сильный")),
            "table_rows": len(rows), "table_ok": bool(rows) and len(rows_ok) == len(rows),
            "table_wrong": [i for i, row in enumerate(rows) if row not in rows_ok],
            "table_same_U": len(us) == 1 and bool(rows), "table_distinct_R": len({row["R"] for row in rows}),
            "student_calculated_I": state.get("student_calculated_I")}


def hill_formula(composition: dict[str, int]) -> str:
    order = (["C", "H"] if "C" in composition else []) + sorted(e for e in composition if not ("C" in composition and e in ("C", "H")))
    sub = str.maketrans("0123456789", "₀₁₂₃₄₅₆₇₈₉")
    return "".join(e + (str(composition[e]).translate(sub) if composition[e] > 1 else "") for e in order if e in composition)


def _molecule(state: dict[str, Any]) -> dict[str, Any]:
    atoms = state.get("atoms") or []
    bonds = state.get("bonds") or []
    by_id = {a["id"]: a["el"] for a in atoms}
    used = Counter()
    neighbors: dict[str, set[str]] = {a["id"]: set() for a in atoms}
    seen_pairs: set[frozenset[str]] = set()
    duplicate = False
    for bond in bonds:
        pair = frozenset((bond["a"], bond["b"]))
        if pair in seen_pairs:
            duplicate = True
        seen_pairs.add(pair)
        used[bond["a"]] += bond["order"]
        used[bond["b"]] += bond["order"]
        neighbors[bond["a"]].add(bond["b"])
        neighbors[bond["b"]].add(bond["a"])
    violations = [{"id": aid, "el": el, "used": used[aid], "valence": VALENCE[el]}
                  for aid, el in by_id.items() if used[aid] != VALENCE[el]]
    over = [v for v in violations if v["used"] > v["valence"]]
    # связность обходом в ширину
    connected = True
    if atoms:
        start = atoms[0]["id"]
        stack, reach = [start], {start}
        while stack:
            node = stack.pop()
            for nxt in neighbors[node]:
                if nxt not in reach:
                    reach.add(nxt)
                    stack.append(nxt)
        connected = len(reach) == len(atoms)
    composition = dict(Counter(by_id.values()))
    c_branch = max((sum(1 for n in neighbors[aid] if by_id[n] == "C") for aid, el in by_id.items() if el == "C"), default=0)
    return {"composition": composition, "formula": hill_formula(composition), "atoms": len(atoms), "bonds": len(bonds),
            "valence_ok": not violations and bool(atoms), "violations": violations, "over_valence": over,
            "connected": connected, "duplicate_bond": duplicate,
            "neighbor_els": {aid: sorted(by_id[n] for n in ns) for aid, ns in neighbors.items()},
            "by_id": by_id, "max_order": max((b["order"] for b in bonds), default=0),
            "double_bonds": sum(1 for b in bonds if b["order"] == 2), "max_c_c_neighbors": c_branch}


def climate_belt(lat: float) -> str:
    lat = abs(lat)
    for low, high, name in CLIMATE_BELTS:
        if low <= lat < high:
            return name
    return "арктический"


def _climate(state: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    alt, lat = _num(state.get("alt")), _num(state.get("lat"), 55)
    t0 = _num(config.get("t0"), 15)
    temp = t0 - LAPSE_RATE_PER_KM * alt / 1000
    # Линейное правило «−10 мм рт. ст. на 100 м» честно работает только в нижних ~3 км; выше барометр
    # модели показывает «—», а не выдуманное (тем более отрицательное) давление.
    rule_ok = alt <= PRESSURE_RULE_MAX_ALT
    pressure = 760 - PRESSURE_DROP_PER_100M * alt / 100 if rule_ok else None
    return {"alt": alt, "lat": lat, "t0": t0, "T": round(temp, 3), "p": round(pressure, 3) if pressure is not None else None,
            "p_rule_valid": rule_ok, "belt": climate_belt(lat)}


def _order(state: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    correct = [str(i) for i in config.get("correct", [])]
    order = state.get("order") or []
    first_wrong = next((i for i, (a, b) in enumerate(zip(order, correct)) if a != b), None)
    complete = sorted(order) == sorted(correct)
    if first_wrong is None and not complete:
        first_wrong = len(order)
    pairs = sum(1 for i in range(len(order) - 1) if order[i:i + 2] in [correct[j:j + 2] for j in range(len(correct) - 1)])
    return {"order": order, "complete": complete, "correct": complete and order == correct,
            "first_wrong": first_wrong, "pairs_ok": pairs, "total": len(correct),
            "wrong_item": order[first_wrong] if first_wrong is not None and first_wrong < len(order) else None}


def _classify(state: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    key = {str(item["id"]): str(item["bucket"]) for item in config.get("items", [])}
    assign = state.get("assign") or {}
    wrong = [i for i, b in assign.items() if i in key and key[i] != b]
    missing = [i for i in key if i not in assign]
    return {"assigned": len([i for i in assign if i in key]), "total": len(key), "wrong_items": wrong,
            "missing": missing, "missing_count": len(missing), "all_assigned": not missing, "correct": not wrong and not missing,
            "right_count": len([i for i in key if assign.get(i) == key[i]])}


_STEP = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}


def expand_program(program: list[str]) -> list[str]:
    """«right*3» — цикл «повтори 3 раза: вправо» (одна инструкция программы, три шага исполнителя)."""
    steps: list[str] = []
    for cmd in program:
        name, _, times = cmd.partition("*")
        steps.extend([name] * (int(times) if times else 1))
    return steps


def _robot(state: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    width, height = int(config.get("w", 6)), int(config.get("h", 5))
    x, y = (int(v) for v in config.get("start", (0, 0)))
    walls = {tuple(w) for w in config.get("walls", [])}
    goal = tuple(int(v) for v in config.get("goal", (width - 1, height - 1)))
    path, crashed_at = [(x, y)], None
    for i, cmd in enumerate(expand_program(state.get("program") or [])):
        dx, dy = _STEP[cmd]
        nx, ny = x + dx, y + dy
        if not (0 <= nx < width and 0 <= ny < height) or (nx, ny) in walls:
            crashed_at = i
            break
        x, y = nx, ny
        path.append((x, y))
    return {"x": x, "y": y, "path": path, "crashed": crashed_at is not None, "crashed_at": crashed_at,
            "crashed_step": crashed_at + 1 if crashed_at is not None else None,
            "reached": (x, y) == goal and crashed_at is None, "length": len(state.get("program") or []),
            "loops": sum(1 for c in state.get("program") or [] if "*" in c), "goal": list(goal)}


def derive(model: str, state: dict[str, Any], config: dict[str, Any] | None = None) -> dict[str, Any]:
    config = config or {}
    if model == "quadratic":
        return _quadratic(state)
    if model == "linear":
        return _linear(state)
    if model == "scales":
        return _scales(state, config)
    if model == "area":
        return _area(state)
    if model == "ohm":
        return _ohm(state)
    if model == "molecule":
        return _molecule(state)
    if model == "climate":
        return _climate(state, config)
    if model == "order":
        return _order(state, config)
    if model == "classify":
        return _classify(state, config)
    if model == "robot":
        return _robot(state, config)
    raise ValueError(f"unknown lab model {model}")


# ------------------------------------------------------------------------------------ проверка
def _quantity(name: str, derived: dict[str, Any], state: dict[str, Any], model: str) -> Any:
    if name.startswith("y(") and name.endswith(")"):          # значение функции в точке: «y(2)»
        x = _num(name[2:-1])
        if model == "quadratic":
            return derived["a"] * x * x + derived["b"] * x + derived["c"]
        if model == "linear":
            return derived["k"] * x + derived["b"]
    if name in derived:
        return derived[name]
    return state.get(name)


def _compare(op: str, actual: Any, expected: Any, tol: float) -> bool:
    if op == "true":
        return bool(actual) is True
    if op == "false":
        return not actual
    if op == "in":
        return actual in (expected or [])
    if op == "composition":
        return {k: int(v) for k, v in (actual or {}).items()} == {k: int(v) for k, v in (expected or {}).items()}
    if actual is None:
        return False
    if isinstance(expected, str) or isinstance(actual, str):
        same = str(actual) == str(expected)
        return same if op == "eq" else (not same if op == "ne" else False)
    a, e = _num(actual), _num(expected)
    return {"eq": abs(a - e) <= tol, "ne": abs(a - e) > tol, "lt": a < e, "le": a <= e + tol,
            "gt": a > e, "ge": a >= e - tol}.get(op, False)


def _neighbors_ok(rule: dict[str, Any], derived: dict[str, Any]) -> bool:
    """«Каждый H связан только с O» — проверка соседей в конструкторе молекул (H₂SO₄)."""
    el, only = rule.get("el"), set(rule.get("only", []))
    for aid, atom_el in derived["by_id"].items():
        if atom_el == el and not set(derived["neighbor_els"].get(aid, [])) <= only:
            return False
    return True


class _Fmt(dict):
    def __missing__(self, key: str) -> str:
        return "?"


def _say(template: str, derived: dict[str, Any], state: dict[str, Any], expected: Any = None) -> str:
    values = _Fmt({k: fmt(v) for k, v in {**state, **derived}.items() if not isinstance(v, (list, dict))})
    values["expected"] = fmt(expected)
    try:
        return template.format_map(values)
    except (ValueError, IndexError):
        return template


def check(model: str, step: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    """Проверка этапа: ``{"ok", "failed": [{principle, say}], "derived"}`` — сначала состояние модели, затем ответы."""
    lab = step.get("lab", {})
    clean = normalize(model, state, lab)
    derived = derive(model, clean, lab)
    failed: list[dict[str, Any]] = []
    for rule in step.get("constraints", []):
        if rule.get("op") == "neighbors":
            ok = _neighbors_ok(rule.get("v", {}), derived)
        else:
            ok = _compare(rule.get("op", "eq"), _quantity(rule["q"], derived, clean, model), rule.get("v"), float(rule.get("tol", 1e-6)))
        if not ok:
            failed.append({"principle": rule.get("principle", "model"), "kind": "model", "q": rule.get("q"),
                           "say": _say(rule.get("say", ""), derived, clean, rule.get("v"))})
    for ans in step.get("answers", []):
        given = clean.get(ans["field"])
        if given is None:
            given = parse_number(state.get(ans["field"]))
        target = _quantity(ans["q"], derived, clean, model) if "q" in ans else ans.get("v")
        ok = given is not None and target is not None and abs(_num(given) - _num(target)) <= float(ans.get("tol", 0.01))
        if not ok:
            failed.append({"principle": ans.get("principle", "answer"), "kind": "answer", "field": ans["field"],
                           "label": ans.get("label", ""), "given": given,
                           "say": _say(ans.get("say", ""), derived, {**clean, ans["field"]: given if given is not None else "—"}, target)})
    return {"ok": not failed, "failed": failed, "derived": _public(derived), "state": clean}


def _public(derived: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in derived.items() if k not in ("by_id",)}


__all__ = ["MODELS", "VALENCE", "check", "climate_belt", "derive", "fmt", "hill_formula", "normalize", "parse_number"]
