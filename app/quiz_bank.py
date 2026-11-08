"""Встроенный банк блиц-опросов: параметрические шаблоны, ответы считает программа.

Используется, когда ИИ на сервере не подключён (нет ключа) или учитель сам выбрал «Из встроенного банка».
Числа подбираются так, чтобы ответ был «школьным» (целым, конечной десятичной или простой дробью), а верный
ответ вычисляется кодом из тех же параметров, что попали в текст вопроса, — без угадывания и без сети.

Детерминизм: одинаковые (темы банка, число вопросов, сложность, вариант) дают тот же черновик; «вариант 2» —
другие числа той же сложности (например, для параллельного класса).  Банк ничего не хранит и не выдаёт: это
черновик для конструктора, учитель проверяет каждый вопрос и только потом нажимает «Выдать».

Честные границы: банк покрывает только перечисленные ниже темы математики, физики, химии и информатики.
Для остальных тем и предметов — понятный отказ (422) со списком доступных тем, а не «похожие» вопросы.
"""
from __future__ import annotations

import hashlib
import math
import random
import re
import unicodedata
from dataclasses import dataclass
from fractions import Fraction
from typing import Any, Callable

from app.assignments import _norm_answer

MINUS = "\u2212"
SUP = str.maketrans("0123456789-", "⁰¹²³⁴⁵⁶⁷⁸⁹⁻")
SUB = str.maketrans("0123456789", "₀₁₂₃₄₅₆₇₈₉")
LEVEL = {"easy": 0, "normal": 1, "hard": 2}
MAX_COUNT = 10


class BankError(Exception):
    """Honest refusal: no generator for this subject/topic.  ``code`` is machine-readable."""

    def __init__(self, detail: str, code: str, topics: list[dict[str, str]] | None = None):
        super().__init__(detail)
        self.detail, self.code, self.topics = detail, code, topics or []


class _Retry(Exception):
    """Parameters gave a degenerate question (duplicate options etc.) — draw again."""


# ------------------------------------------------------------------ formatting
def _decimal(fr: Fraction) -> str | None:
    den = fr.denominator
    for k in range(0, 13):
        if (10 ** k) % den == 0:
            digits = abs(fr.numerator) * (10 ** k // den)
            s = str(digits).rjust(k + 1, "0")
            body = s if k == 0 else f"{s[:-k]},{s[-k:]}".rstrip("0").rstrip(",")
            return (MINUS if fr < 0 else "") + body
    return None


def num(x: Any) -> str:
    """Display form: Russian decimal comma, typographic minus, simple fractions as p/q."""
    fr = x if isinstance(x, Fraction) else Fraction(x).limit_denominator(10 ** 9) if isinstance(x, float) else Fraction(int(x))
    if fr.denominator == 1:
        return (MINUS if fr < 0 else "") + str(abs(fr.numerator))
    dec = _decimal(fr)
    if dec is not None:
        return dec
    return (MINUS if fr < 0 else "") + f"{abs(fr.numerator)}/{fr.denominator}"


def frac(fr: Fraction) -> str:
    """Always p/q (integers stay integers)."""
    if fr.denominator == 1:
        return num(fr)
    return (MINUS if fr < 0 else "") + f"{abs(fr.numerator)}/{fr.denominator}"


def ans(x: Any) -> str:
    """Accepted answer: ASCII minus (the grader compares numbers, so 0,5 = 0.5 = 1/2 anyway)."""
    return num(x).replace(MINUS, "-")


def par(x: Any) -> str:
    """Negative numbers in parentheses inside formulas: (−3)."""
    s = num(x)
    return f"({s})" if s.startswith(MINUS) else s


def sup(n: int) -> str:
    return str(n).translate(SUP)


def poly(terms: list[tuple[int, str]]) -> str:
    """[(2, "x²"), (−3, "x"), (1, "")] → «2x² − 3x + 1»."""
    parts: list[str] = []
    for c, var in terms:
        if c == 0:
            continue
        mag = abs(c)
        body = (str(mag) if (mag != 1 or not var) else "") + var
        parts.append((MINUS if c < 0 else "") + body if not parts else (f"{MINUS} " if c < 0 else "+ ") + body)
    return " ".join(parts) if parts else "0"


def root(k: int, m: int) -> str:
    return f"√{m}" if k == 1 else f"{k}√{m}"


def surd(n: int) -> str:
    """√n in simplest form: 20 → «2√5», 16 → «4»."""
    k, m = 1, n
    f = 2
    while f * f <= m:
        while m % (f * f) == 0:
            m //= f * f
            k *= f
        f += 1
    return str(k) if m == 1 else root(k, m)


def chem(formula: str) -> str:
    return formula.translate(SUB)


def _key(s: str) -> str:
    return _norm_answer(s)


# ------------------------------------------------------------------ question builders
def single(rng: random.Random, text: str, right: str, wrongs: list[str], explain: str = "", want: int = 4) -> dict[str, Any]:
    seen, pool = {_key(right)}, []
    for w in wrongs:
        k = _key(w)
        if not k or k in seen:
            continue
        seen.add(k)
        pool.append(w)
        if len(pool) == want - 1:
            break
    if not pool:
        raise _Retry
    opts = pool + [right]
    rng.shuffle(opts)
    return {"kind": "single", "text": text, "options": opts, "correct": [opts.index(right)], "answers": [], "explain": explain}


def fixed(text: str, options: list[str], right: int, explain: str = "") -> dict[str, Any]:
    """Options in a natural fixed order (Да/Нет, >/</=)."""
    return {"kind": "single", "text": text, "options": options, "correct": [right], "answers": [], "explain": explain}


def multi(rng: random.Random, text: str, items: list[tuple[str, bool]], explain: str = "") -> dict[str, Any]:
    seen, uniq = set(), []
    for t, ok in items:
        if _key(t) in seen:
            raise _Retry
        seen.add(_key(t))
        uniq.append((t, ok))
    rng.shuffle(uniq)
    correct = [i for i, (_, ok) in enumerate(uniq) if ok]
    if not correct or len(correct) == len(uniq):
        raise _Retry
    return {"kind": "multi", "text": text, "options": [t for t, _ in uniq], "correct": correct, "answers": [], "explain": explain}


def short(text: str, answers: list[str], explain: str = "") -> dict[str, Any]:
    out = list(dict.fromkeys(a for a in answers if a))[:5]
    return {"kind": "short", "text": text, "options": [], "correct": [], "answers": out, "explain": explain}


def short_num(text: str, value: Any, unit: str = "", explain: str = "") -> dict[str, Any]:
    a = ans(value)
    variants = [a] + ([f"{a}{unit}", f"{a} {unit}"] if unit in ("%", "°") else [f"{a} {unit}"] if unit else [])
    fr = value if isinstance(value, Fraction) else None
    if fr is not None and fr.denominator != 1:
        variants.append(frac(fr).replace(MINUS, "-"))
        whole, rest = divmod(abs(fr.numerator), fr.denominator)
        if whole and rest:
            variants.append(("-" if fr < 0 else "") + f"{whole} {rest}/{fr.denominator}")
    return short(text, variants, explain)


def pair(x: Any, y: Any) -> str:
    a, b = sorted((Fraction(x), Fraction(y)))
    return f"{num(a)} и {num(b)}"


# ------------------------------------------------------------------ algebra
def _quad(rng: random.Random, lvl: int) -> tuple[int, int, int, int, int]:
    if lvl == 0:
        a, (r1, r2) = 1, rng.sample(range(1, 8), 2)
    elif lvl == 1:
        a, (r1, r2) = 1, rng.sample([n for n in range(-8, 9) if n], 2)
    else:
        a, (r1, r2) = rng.choice([2, 3, -1, -2]), rng.sample([n for n in range(-6, 7) if n], 2)
    r1, r2 = sorted((r1, r2))
    return a, -a * (r1 + r2), a * r1 * r2, r1, r2


def _eq(a: int, b: int, c: int) -> str:
    return f"{poly([(a, 'x²'), (b, 'x'), (c, '')])} = 0"


def q_discriminant(rng, lvl):
    a, b, c, _, _ = _quad(rng, lvl)
    d = b * b - 4 * a * c
    return short_num(f"Найдите дискриминант уравнения {_eq(a, b, c)}.", d,
                     explain=f"D = b² − 4ac = {par(b)}² − 4·{par(a)}·{par(c)} = {num(d)}.")


def q_quad_roots(rng, lvl):
    a, b, c, r1, r2 = _quad(rng, lvl)
    d = b * b - 4 * a * c
    s = math.isqrt(d)
    wrongs = [pair(-r1, -r2), pair(r1, -r2), pair(-r1, r2), pair(r1 + 1, r2 + 1), pair(r1 - 1, r2 + 2), pair(r1 * 2, r2)]
    return single(rng, f"Решите уравнение {_eq(a, b, c)}.", pair(r1, r2), wrongs,
                  f"D = {num(d)}, √D = {s}; x = ({num(-b)} ± {s}) / {par(2 * a)} → x₁ = {num(r1)}, x₂ = {num(r2)}.")


def q_vieta_sum(rng, lvl):
    a, b, c, r1, r2 = _quad(rng, lvl)
    return short_num(f"Не решая уравнение {_eq(a, b, c)}, найдите сумму его корней.", r1 + r2,
                     explain=f"По теореме Виета x₁ + x₂ = −b/a = {num(-b)}/{par(a)} = {num(r1 + r2)}. Дискриминант положительный, корни существуют.")


def q_vieta_prod(rng, lvl):
    a, b, c, r1, r2 = _quad(rng, lvl)
    return short_num(f"Не решая уравнение {_eq(a, b, c)}, найдите произведение его корней.", r1 * r2,
                     explain=f"По теореме Виета x₁ · x₂ = c/a = {num(c)}/{par(a)} = {num(r1 * r2)}.")


def _quad_kind(rng: random.Random, lvl: int, kind: str) -> tuple[int, int, int]:
    if kind == "two":
        a, b, c, _, _ = _quad(rng, lvl)
        return a, b, c
    a = 1 if lvl < 2 else rng.choice([1, 2, 3])
    if kind == "one":
        r = rng.choice([n for n in range(-6, 7) if n])
        return a, -2 * a * r, a * r * r
    b = rng.randint(-6, 6)
    return a, b, b * b // (4 * a) + rng.randint(1, 5)


def q_roots_count(rng, lvl):
    kind = rng.choice(["two", "one", "none"])
    a, b, c = _quad_kind(rng, lvl, kind)
    d = b * b - 4 * a * c
    right = 0 if d > 0 else 1 if d == 0 else 2
    sign = "> 0" if d > 0 else "= 0" if d == 0 else "< 0"
    return fixed(f"Сколько действительных корней имеет уравнение {_eq(a, b, c)}?",
                 ["Два различных корня", "Один корень", "Нет действительных корней"], right,
                 f"D = {par(b)}² − 4·{par(a)}·{par(c)} = {num(d)} {sign}.")


def q_two_roots_multi(rng, lvl):
    kinds = ["two", rng.choice(["one", "none"])] + [rng.choice(["two", "one", "none"]) for _ in range(2)]
    items = []
    for k in kinds:
        a, b, c = _quad_kind(rng, lvl, k)
        items.append((_eq(a, b, c), b * b - 4 * a * c > 0))
    return multi(rng, "Отметьте все уравнения, которые имеют два различных действительных корня.", items,
                 "Два различных корня — когда дискриминант D = b² − 4ac больше нуля.")


def _sq_value(rng: random.Random, lvl: int) -> Fraction:
    if lvl == 0:
        return Fraction(rng.randint(2, 12))
    if lvl == 1:
        return Fraction(rng.randint(11, 20)) if rng.random() < 0.6 else Fraction(rng.randint(1, 9), 10)
    return Fraction(rng.randint(15, 40)) if rng.random() < 0.6 else Fraction(rng.randint(11, 19), 10)


def q_sqrt_value(rng, lvl):
    n = _sq_value(rng, lvl)
    return short_num(f"Вычислите √{num(n * n)}.", n, explain=f"{num(n)}² = {num(n * n)}, а арифметический корень неотрицателен, поэтому ответ {num(n)}.")


def q_sqrt_product(rng, lvl):
    m = rng.choice([2, 3, 5, 6, 7] if lvl < 2 else [2, 3, 5, 6, 7, 10, 11])
    p, q = rng.sample(range(1, 4 if lvl == 0 else 6), 2)
    a, b = m * p * p, m * q * q
    return short_num(f"Вычислите √{a} · √{b}.", m * p * q,
                     explain=f"√{a} · √{b} = √{a * b} = {m * p * q}, потому что {m * p * q}² = {a * b}.")


def q_sqrt_fraction(rng, lvl):
    while True:
        p, q = rng.randint(1, 9 if lvl < 2 else 15), rng.randint(2, 10 if lvl < 2 else 16)
        if p < q and math.gcd(p, q) == 1:
            break
    return short_num(f"Вычислите √({p * p}/{q * q}). Ответ запишите дробью.", Fraction(p, q),
                     explain=f"√({p * p}/{q * q}) = √{p * p} / √{q * q} = {p}/{q}.")


def q_sqrt_factor_out(rng, lvl):
    k = rng.randint(2, 5 if lvl == 0 else 7 if lvl == 1 else 10)
    m = rng.choice([2, 3, 5, 6, 7, 10])
    n = k * k * m
    return single(rng, f"Вынесите множитель из-под знака корня: √{n}.", root(k, m),
                  [root(m, k) if m != k else root(k + 2, m), root(k * k, m), root(k, k * m), root(k + 1, m), root(k - 1, m * 4) if k > 2 else root(2 * k, m)],
                  f"{n} = {k * k}·{m}, поэтому √{n} = √{k * k} · √{m} = {root(k, m)}.")


def q_sqrt_compare(rng, lvl):
    b = rng.randint(3, 9 if lvl < 2 else 15)
    n = b * b + rng.choice([-3, -2, -1, 1, 2, 3])
    right = 0 if b * b > n else 1
    cmp_ = ">" if b * b > n else "<"
    return fixed(f"Сравните числа {b} и √{n}.", [f"{b} > √{n}", f"{b} < √{n}", f"{b} = √{n}"], right,
                 f"{b} = √{b * b}, а {b * b} {cmp_} {n}, значит {b} {cmp_} √{n}.")


def q_sqrt_between(rng, lvl):
    hi = 50 if lvl == 0 else 150 if lvl == 1 else 600
    while True:
        n = rng.randint(5, hi)
        k = math.isqrt(n)
        if k * k != n:
            break
    wrongs = [f"{k - 1} и {k}", f"{k + 1} и {k + 2}", f"{k + 2} и {k + 3}"]
    return single(rng, f"Между какими последовательными целыми числами находится √{n}?", f"{k} и {k + 1}", wrongs,
                  f"{k}² = {k * k} < {n} < {(k + 1) ** 2} = {k + 1}², поэтому {k} < √{n} < {k + 1}.")


def q_sqrt_rational(rng, lvl):
    squares = [Fraction(n * n) for n in range(2, 13)] + [Fraction(n * n, 100) for n in range(1, 10)]
    non = [Fraction(n) for n in (2, 3, 5, 6, 7, 8, 10, 12, 15, 18, 20, 27, 50)] + [Fraction(n, 10) for n in (2, 5, 9)]
    good = rng.randint(1, 3)
    vals = [(v, True) for v in rng.sample(squares, good)] + [(v, False) for v in rng.sample(non, 4 - good)]
    return multi(rng, "Отметьте все числа, которые являются рациональными.", [(f"√{num(v)}", ok) for v, ok in vals],
                 "Корень рационален, только если под ним квадрат рационального числа: √0,25 = 0,5, √16 = 4; а √2, √0,5 — иррациональны.")


def q_sqrt_sum(rng, lvl):
    m = rng.choice([2, 3, 5, 6, 7])
    a, b = rng.sample(range(1, 6), 2)
    res = root(a + b, m)
    return single(rng, f"Упростите выражение √{m * a * a} + √{m * b * b}.", res,
                  [f"√{m * (a * a + b * b)}", root(a * b, m), root(a + b, 2 * m), root(a + b + 1, m), root(abs(a - b) or 2, m)],
                  f"√{m * a * a} = {root(a, m)}, √{m * b * b} = {root(b, m)}; сумма {res}.")


def q_linear_basic(rng, lvl):
    x = rng.randint(-9, 12) if lvl else rng.randint(1, 12)
    a = rng.choice([n for n in range(-9, 10) if n not in (0, 1)]) if lvl else rng.randint(2, 9)
    b = rng.randint(-20, 20) or 5
    c = a * x + b
    return short_num(f"Решите уравнение {poly([(a, 'x'), (b, '')])} = {num(c)}.", x,
                     explain=f"{num(a)}x = {num(c)} {MINUS} {par(b)} = {num(c - b)}, x = {num(c - b)} : {par(a)} = {num(x)}.")


def q_linear_both(rng, lvl):
    x = rng.randint(-8, 10)
    a, c = rng.sample([n for n in range(-7, 10) if n], 2)
    b = rng.randint(-15, 15)
    d = a * x + b - c * x
    return short_num(f"Решите уравнение {poly([(a, 'x'), (b, '')])} = {poly([(c, 'x'), (d, '')])}.", x,
                     explain=f"Переносим: ({num(a)} {MINUS} {par(c)})x = {num(d)} {MINUS} {par(b)}, {num(a - c)}x = {num(d - b)}, x = {num(x)}.")


def q_linear_brackets(rng, lvl):
    x = rng.randint(-6, 9)
    a = rng.choice([2, 3, 4, 5, -2, -3])
    p = rng.choice([n for n in range(-7, 8) if n])
    q = a * (x + p)
    inner = poly([(1, "x"), (p, "")])
    return short_num(f"Решите уравнение {num(a)}({inner}) = {num(q)}.", x,
                     explain=f"{inner} = {num(q)} : {par(a)} = {num(x + p)}, x = {num(x)}.")


def q_linear_pick(rng, lvl):
    x = rng.randint(-9, 9) or 4
    a = rng.choice([2, 3, 4, 5, -2, -3])
    b = rng.randint(-12, 12)
    c = a * x + b
    return single(rng, f"Какое из чисел является корнем уравнения {poly([(a, 'x'), (b, '')])} = {num(c)}?", num(x),
                  [num(-x), num(x + 1), num(x - 2), num(c), num(x + 3)], f"Подставим x = {num(x)}: {num(a)}·{par(x)} + {par(b)} = {num(c)}.")


def _frac(rng: random.Random, lvl: int) -> Fraction:
    dens = [2, 3, 4, 5, 6] if lvl == 0 else [2, 3, 4, 5, 6, 8, 9, 10, 12] if lvl == 1 else [3, 4, 5, 6, 7, 8, 9, 12, 15]
    d = rng.choice(dens)
    return Fraction(rng.randint(1, d - 1), d)


def q_frac_op(rng, lvl):
    a, b = _frac(rng, lvl), _frac(rng, lvl)
    op = rng.choice(["+", "−", "·", ":"] if lvl else ["+", "−"])
    if op == "−" and a < b:
        a, b = b, a
    res = a + b if op == "+" else a - b if op == "−" else a * b if op == "·" else a / b
    if res == 0:
        raise _Retry
    how = {"+": "приводим к общему знаменателю и складываем", "−": "приводим к общему знаменателю и вычитаем",
           "·": "числитель на числитель, знаменатель на знаменатель", ":": "умножаем на дробь, обратную делителю"}[op]
    return short_num(f"Вычислите: {frac(a)} {op} {frac(b)}. Ответ запишите несократимой дробью или целым числом.", res,
                     explain=f"{how.capitalize()}: {frac(a)} {op} {frac(b)} = {frac(res)}.")


def q_frac_reduce(rng, lvl):
    f = _frac(rng, lvl)
    k = rng.randint(2, 6 if lvl < 2 else 12)
    p, q = f.numerator * k, f.denominator * k
    wrongs = [f"{f.numerator}/{q}", f"{p}/{f.denominator}", f"{f.denominator}/{f.numerator}",
              f"{f.numerator}/{f.denominator + 1}", f"{f.numerator + 1}/{f.denominator + 1}"]
    wrongs = [w for w in wrongs if Fraction(w) != f and Fraction(w).denominator != 1 and w.split("/")[0] != w.split("/")[1]]
    return single(rng, f"Сократите дробь {p}/{q}.", frac(f), wrongs, f"НОД({p}, {q}) = {k}; {p}/{q} = {f.numerator}/{f.denominator}.")


def q_frac_of_number(rng, lvl):
    f = _frac(rng, lvl)
    n = f.denominator * rng.randint(2, 12 if lvl < 2 else 30)
    return short_num(f"Найдите {frac(f)} от числа {n}.", f * n, explain=f"{n} : {f.denominator} · {f.numerator} = {num(f * n)}.")


def q_frac_compare(rng, lvl):
    a, b = _frac(rng, lvl), _frac(rng, lvl)
    if a == b:
        raise _Retry
    big = frac(max(a, b))
    lcm = a.denominator * b.denominator // math.gcd(a.denominator, b.denominator)
    return fixed(f"Какая дробь больше: {frac(a)} или {frac(b)}?", [frac(a), frac(b), "Они равны"], 0 if a > b else 1,
                 f"Общий знаменатель {lcm}: {frac(a)} = {int(a * lcm)}/{lcm}, {frac(b)} = {int(b * lcm)}/{lcm}; больше {big}.")


def _pct(rng: random.Random, lvl: int) -> int:
    return rng.choice([10, 20, 25, 50] if lvl == 0 else [5, 10, 15, 20, 25, 30, 40, 60, 75] if lvl == 1 else [4, 8, 12, 15, 35, 45, 65, 85])


def q_pct_of(rng, lvl):
    p = _pct(rng, lvl)
    n = rng.choice(range(20, 1001 if lvl else 401, 20))
    if n * p % 100:
        raise _Retry
    return short_num(f"Найдите {p}% от числа {n}.", Fraction(n * p, 100), explain=f"{n} · {p} / 100 = {num(Fraction(n * p, 100))}.")


def q_pct_which(rng, lvl):
    p = _pct(rng, lvl)
    b = rng.choice([20, 40, 50, 80, 200, 250, 400, 500] if lvl < 2 else [60, 120, 160, 240, 300, 360, 640])
    a = Fraction(b * p, 100)
    if a.denominator != 1:
        raise _Retry
    return short_num(f"Сколько процентов составляет число {num(a)} от числа {b}?", p, "%",
                     f"{num(a)} / {b} · 100% = {p}%.")


def q_pct_whole(rng, lvl):
    p = _pct(rng, lvl)
    n = rng.choice(range(20, 801, 20))
    part = Fraction(n * p, 100)
    if part.denominator != 1:
        raise _Retry
    return short_num(f"{p}% числа равны {num(part)}. Найдите это число.", n, explain=f"{num(part)} : {p} · 100 = {n}.")


def q_pct_price(rng, lvl):
    p = _pct(rng, lvl)
    price = rng.choice(range(100, 5001, 50 if lvl else 100))
    up = rng.random() < 0.5
    new = Fraction(price * (100 + p if up else 100 - p), 100)
    if new.denominator != 1:
        raise _Retry
    word = "подорожал" if up else "подешевел"
    return short_num(f"Товар стоил {price} ₽ и {word} на {p}%. Сколько рублей он стоит теперь?", new, "₽",
                     f"{price} · {(100 + p) if up else (100 - p)} / 100 = {num(new)} ₽.")


def q_pct_twice(rng, lvl):
    p = rng.choice([10, 20, 30, 40, 50])
    net = Fraction(p * p, 100)
    return single(rng, f"Цену повысили на {p}%, а затем понизили на {p}%. Как изменилась цена по сравнению с исходной?",
                  f"Уменьшилась на {num(net)}%", ["Не изменилась", f"Увеличилась на {num(net)}%", f"Уменьшилась на {p}%", f"Увеличилась на {p}%"],
                  f"1 · (1 + {num(Fraction(p, 100))}) · (1 − {num(Fraction(p, 100))}) = 1 − {num(Fraction(p * p, 10000))}: цена уменьшилась на {num(net)}%.")


def q_pow_value(rng, lvl):
    if lvl == 0:
        b, e = rng.choice([(2, rng.randint(3, 7)), (3, rng.randint(2, 4)), (10, rng.randint(2, 5)), (5, 3), (4, 3)])
    else:
        b, e = rng.choice([(-2, rng.randint(3, 7)), (-3, rng.randint(2, 4)), (2, rng.randint(6, 10)), (-1, rng.randint(5, 20)), (Fraction(1, 2), rng.randint(2, 5))])
    base = f"({frac(b)})" if (isinstance(b, Fraction) or b < 0) else str(b)
    v = Fraction(b) ** e
    return short_num(f"Вычислите {base}{sup(e)}.", v, explain=f"{base}{sup(e)} = {'·'.join([base] * min(e, 6))}{'·…' if e > 6 else ''} = {frac(v)}.")


def q_pow_rules(rng, lvl):
    m, n = rng.sample(range(2, 9), 2)
    kind = rng.choice(["mul", "div", "pow"])
    if kind == "mul":
        text, e, why = f"a{sup(m)} · a{sup(n)}", m + n, "при умножении показатели складываются"
        wrong = [m * n, abs(m - n), m + n + 1]
    elif kind == "div":
        m, n = max(m, n), min(m, n)
        text, e, why = f"a{sup(m)} : a{sup(n)}", m - n, "при делении показатели вычитаются"
        wrong = [m + n, max(1, m // n) if m // n != m - n else m * n, m - n + 1]
    else:
        text, e, why = f"(a{sup(m)}){sup(n)}", m * n, "при возведении степени в степень показатели перемножаются"
        wrong = [m + n, m * n + 1, m ** 2 if m ** 2 != m * n else m + n + 2]
    form = lambda k: "a" if k == 1 else f"a{sup(k)}"  # noqa: E731
    return single(rng, f"Представьте в виде степени с основанием a: {text}.", form(e), [form(w) for w in wrong], f"{why.capitalize()}: {form(e)}.")


def q_pow_negative(rng, lvl):
    b, e = rng.choice([(2, rng.randint(1, 5)), (3, rng.randint(1, 3)), (10, rng.randint(1, 3)), (5, rng.randint(1, 2))])
    v = Fraction(1, b ** e)
    return short_num(f"Вычислите {b}{sup(-e)}. Ответ запишите дробью или десятичной дробью.", v,
                     explain=f"{b}{sup(-e)} = 1 / {b}{sup(e)} = {frac(v)}" + (f" = {num(v)}." if _decimal(v) and v.denominator != 1 else "."))


def q_pow_zero(rng, lvl):
    a, b, c = rng.randint(2, 99), rng.randint(2, 9), rng.randint(2, 4)
    v = 1 + b ** c
    return short_num(f"Вычислите {a}⁰ + {b}{sup(c)}.", v, explain=f"Любое ненулевое число в нулевой степени равно 1: 1 + {b ** c} = {v}.")


def q_square_expand(rng, lvl):
    k = rng.randint(1, 9)
    sign = rng.choice([1, -1])
    lead = 1 if lvl < 2 else rng.choice([2, 3])
    var = "x" if lead == 1 else f"{lead}x"
    text = f"({var} {'+' if sign > 0 else MINUS} {k})²"
    right = poly([(lead * lead, "x²"), (2 * lead * k * sign, "x"), (k * k, "")])
    wrongs = [poly([(lead * lead, "x²"), (k * k, "")]), poly([(lead * lead, "x²"), (lead * k * sign, "x"), (k * k, "")]),
              poly([(lead * lead, "x²"), (-2 * lead * k * sign, "x"), (k * k, "")]), poly([(lead * lead, "x²"), (2 * lead * k * sign, "x"), (2 * k, "")])]
    return single(rng, f"Раскройте скобки: {text}.", right, wrongs, f"(a ± b)² = a² ± 2ab + b²: {right}.")


def q_diff_squares_num(rng, lvl):
    mid = rng.choice([50, 100, 30, 40, 70] if lvl < 2 else [150, 250, 1000, 75])
    d = rng.randint(1, 9)
    a, b = mid + d, mid - d
    return short_num(f"Вычислите удобным способом: {a}² {MINUS} {b}².", (a - b) * (a + b),
                     explain=f"a² − b² = (a − b)(a + b) = {a - b} · {a + b} = {(a - b) * (a + b)}.")


def q_factor_diff(rng, lvl):
    k = rng.randint(2, 12)
    lead = 1 if lvl < 2 else rng.choice([2, 3, 4])
    v = "x" if lead == 1 else f"{lead}x"
    right = f"({v} {MINUS} {k})({v} + {k})"
    wrongs = [f"({v} {MINUS} {k})²", f"({v} + {k})²", f"({v} {MINUS} {k * k})({v} + {k * k})", f"({v} {MINUS} {k})({v} + {k + 1})"]
    return single(rng, f"Разложите на множители: {poly([(lead * lead, 'x²'), (-k * k, '')])}.", right, wrongs,
                  f"Разность квадратов: a² − b² = (a − b)(a + b), где a = {v}, b = {k}.")


def q_mental_square(rng, lvl):
    base = rng.choice([20, 30, 40, 50, 60, 70, 80, 90, 100] if lvl < 2 else [100, 200, 300, 500, 1000])
    d = rng.choice([1, 2, 3, -1, -2])
    n = base + d
    return short_num(f"Вычислите {n}², используя формулу квадрата суммы или разности.", n * n,
                     explain=f"({base} {'+' if d > 0 else MINUS} {abs(d)})² = {base * base} {'+' if d > 0 else MINUS} {2 * base * abs(d)} + {d * d} = {n * n}.")


def _line(rng: random.Random, lvl: int) -> tuple[int, int]:
    k = rng.choice([n for n in range(-5, 6) if n]) if lvl else rng.randint(1, 5)
    b = rng.randint(-9, 9)
    return k, b


def _yfx(k: int, b: int) -> str:
    return f"y = {poly([(k, 'x'), (b, '')])}"


def q_lin_value(rng, lvl):
    k, b = _line(rng, lvl)
    x = rng.randint(-6, 8)
    tail = f" + {par(b)}" if b else ""
    return short_num(f"Функция задана формулой {_yfx(k, b)}. Найдите значение y при x = {num(x)}.", k * x + b,
                     explain=f"y = {num(k)}·{par(x)}{tail} = {num(k * x + b)}.")


def q_lin_point(rng, lvl):
    k, b = _line(rng, lvl)
    x = rng.randint(-4, 5)
    y = k * x + b
    pt = lambda px, py: f"({num(px)}; {num(py)})"  # noqa: E731
    return single(rng, f"Какая из точек принадлежит графику функции {_yfx(k, b)}?", pt(x, y),
                  [pt(x, y + 1), pt(x + 1, y), pt(-x if x else 2, y), pt(y, x) if y != x else pt(x, -y - 1), pt(x, -y) if y else pt(x, 3)],
                  f"Подставим x = {num(x)}: y = {num(k)}·{par(x)} + {par(b)} = {num(y)}.")


def q_lin_zero(rng, lvl):
    k = rng.choice([n for n in range(-5, 6) if n not in (0,)])
    x0 = rng.randint(-6, 6)
    b = -k * x0
    return short_num(f"Найдите абсциссу точки пересечения графика функции {_yfx(k, b)} с осью Ox.", x0,
                     explain=f"На оси Ox y = 0: {poly([(k, 'x'), (b, '')])} = 0, x = {num(x0)}.")


def q_lin_slope(rng, lvl):
    k, b = _line(rng, lvl)
    x1, x2 = rng.sample(range(-5, 7), 2)
    y1, y2 = k * x1 + b, k * x2 + b
    return short_num(f"Прямая y = kx + b проходит через точки ({num(x1)}; {num(y1)}) и ({num(x2)}; {num(y2)}). Найдите k.", k,
                     explain=f"k = (y₂ − y₁) / (x₂ − x₁) = ({num(y2)} − {par(y1)}) / ({num(x2)} − {par(x1)}) = {num(k)}.")


def q_lin_parallel(rng, lvl):
    k, b = _line(rng, lvl)
    b2 = b + rng.choice([-5, -3, 2, 4, 7])
    right = _yfx(k, b2)
    wrongs = [_yfx(-k, b), _yfx(k + 1, b2), _yfx(-k, b2), _yfx(2 * k if k != 0 else 3, b)]
    return single(rng, f"График какой функции параллелен графику {_yfx(k, b)}?", right, wrongs,
                  "Прямые y = kx + b параллельны, когда угловые коэффициенты равны, а свободные члены различны.")


def q_ineq(rng, lvl):
    x0 = rng.randint(-6, 8)
    a = rng.choice([2, 3, 4, 5] if lvl == 0 else [2, 3, 4, 5, -2, -3, -4])
    b = rng.randint(-10, 10)
    strict = rng.random() < 0.6 or lvl == 0
    s = ">" if strict else "≥"
    c = a * x0 + b
    if a > 0:
        right = f"x {s} {num(x0)}"
    else:
        right = f"x {'<' if strict else '≤'} {num(x0)}"
    flip = {"x > ": "x < ", "x < ": "x > ", "x ≥ ": "x ≤ ", "x ≤ ": "x ≥ "}
    head = right[:4]
    wrongs = [flip[head] + num(x0), f"{head}{num(-x0)}" if x0 else f"{head}1", f"{head}{num(x0 + 1)}", flip[head] + num(-x0 if x0 else 2)]
    note = " При делении на отрицательное число знак неравенства меняется." if a < 0 else ""
    return single(rng, f"Решите неравенство {poly([(a, 'x'), (b, '')])} {s} {num(c)}.", right, wrongs,
                  f"{num(a)}x {s} {num(c)} {MINUS} {par(b)} = {num(c - b)}; делим на {par(a)}.{note} Ответ: {right}.")


def q_ineq_count(rng, lvl):
    lo = rng.randint(-8, 3)
    hi = lo + rng.randint(3, 9)
    return short_num(f"Сколько целых чисел удовлетворяют неравенству {num(lo)} < x ≤ {num(hi)}?", hi - lo,
                     explain=f"Это числа от {num(lo + 1)} до {num(hi)} включительно: {num(hi)} {MINUS} {par(lo)} = {hi - lo}.")


def q_system(rng, lvl):
    x, y = rng.randint(-5, 9), rng.randint(-5, 9)
    if lvl == 0:
        e1, e2 = f"x + y = {num(x + y)}", f"x {MINUS} y = {num(x - y)}"
    else:
        a, b = rng.choice([(2, 3), (3, 2), (1, 4), (5, 2), (3, -1)])
        c, d = rng.choice([(1, -1), (2, -1), (1, 2), (4, -3)])
        if a * d - b * c == 0:
            raise _Retry
        e1, e2 = f"{poly([(a, 'x'), (b, 'y')])} = {num(a * x + b * y)}", f"{poly([(c, 'x'), (d, 'y')])} = {num(c * x + d * y)}"
    pt = lambda px, py: f"({num(px)}; {num(py)})"  # noqa: E731
    return single(rng, f"Решите систему уравнений: {e1}; {e2}. Укажите пару (x; y).", pt(x, y),
                  [pt(y, x) if x != y else pt(x, -y if y else 1), pt(-x if x else 3, y), pt(x, -y if y else 2), pt(x + 1, y - 1)],
                  f"Подстановка x = {num(x)}, y = {num(y)} обращает оба уравнения в верные равенства.")


def _ap(rng: random.Random, lvl: int) -> tuple[int, int]:
    return rng.randint(-10, 15), rng.choice([n for n in range(-6, 8) if n]) if lvl else rng.randint(1, 6)


def q_ap_term(rng, lvl):
    a1, d = _ap(rng, lvl)
    n = rng.randint(5, 12 if lvl < 2 else 40)
    return short_num(f"Арифметическая прогрессия: a₁ = {num(a1)}, d = {num(d)}. Найдите a{str(n).translate(SUB)}.", a1 + (n - 1) * d,
                     explain=f"aₙ = a₁ + (n − 1)d = {num(a1)} + {n - 1}·{par(d)} = {num(a1 + (n - 1) * d)}.")


def q_ap_diff(rng, lvl):
    a1, d = _ap(rng, lvl)
    m, n = sorted(rng.sample(range(1, 11), 2))
    am, an = a1 + (m - 1) * d, a1 + (n - 1) * d
    return short_num(f"В арифметической прогрессии a{str(m).translate(SUB)} = {num(am)}, a{str(n).translate(SUB)} = {num(an)}. Найдите разность d.", d,
                     explain=f"d = (a{str(n).translate(SUB)} − a{str(m).translate(SUB)}) / ({n} − {m}) = ({num(an)} − {par(am)}) / {n - m} = {num(d)}.")


def q_ap_sum(rng, lvl):
    a1, d = _ap(rng, lvl)
    n = rng.randint(5, 12 if lvl < 2 else 20)
    an = a1 + (n - 1) * d
    s = Fraction((a1 + an) * n, 2)
    return short_num(f"Найдите сумму первых {n} членов арифметической прогрессии, если a₁ = {num(a1)}, d = {num(d)}.", s,
                     explain=f"aₙ = {num(an)}; Sₙ = (a₁ + aₙ)·n / 2 = ({num(a1)} + {par(an)})·{n} / 2 = {num(s)}.")


def _gp(rng: random.Random, lvl: int) -> tuple[int, int]:
    return rng.choice([1, 2, 3, 5, -1, -2] if lvl else [1, 2, 3]), rng.choice([2, 3, -2] if lvl else [2, 3])


def q_gp_term(rng, lvl):
    b1, q = _gp(rng, lvl)
    n = rng.randint(3, 6 if lvl < 2 else 8)
    v = b1 * q ** (n - 1)
    return short_num(f"Геометрическая прогрессия: b₁ = {num(b1)}, q = {num(q)}. Найдите b{str(n).translate(SUB)}.", v,
                     explain=f"bₙ = b₁·qⁿ⁻¹ = {num(b1)}·{par(q)}{sup(n - 1)} = {num(v)}.")


def q_gp_ratio(rng, lvl):
    b1, q = _gp(rng, lvl)
    n = rng.randint(2, 5)
    bn, bn1 = b1 * q ** (n - 1), b1 * q ** n
    return short_num(f"В геометрической прогрессии b{str(n).translate(SUB)} = {num(bn)}, b{str(n + 1).translate(SUB)} = {num(bn1)}. Найдите знаменатель q.", q,
                     explain=f"q = b{str(n + 1).translate(SUB)} / b{str(n).translate(SUB)} = {num(bn1)} / {par(bn)} = {num(q)}.")


def q_gp_sum(rng, lvl):
    b1, q = _gp(rng, lvl)
    n = rng.randint(3, 6)
    s = b1 * (q ** n - 1) // (q - 1)
    return short_num(f"Найдите сумму первых {n} членов геометрической прогрессии, если b₁ = {num(b1)}, q = {num(q)}.", s,
                     explain=f"Sₙ = b₁(qⁿ − 1)/(q − 1) = {num(b1)}·({par(q)}{sup(n)} − 1)/({num(q)} − 1) = {num(s)}.")


# ------------------------------------------------------------------ geometry
TRIPLES = [(3, 4, 5), (5, 12, 13), (8, 15, 17), (7, 24, 25), (20, 21, 29), (9, 40, 41)]


def _triple(rng: random.Random, lvl: int) -> tuple[int, int, int]:
    a, b, c = rng.choice(TRIPLES[:2] if lvl == 0 else TRIPLES[:4] if lvl == 1 else TRIPLES)
    k = rng.randint(1, 3 if lvl == 0 else 4)
    a, b = (b, a) if rng.random() < 0.5 else (a, b)
    return a * k, b * k, c * k


def q_pyth_hyp(rng, lvl):
    a, b, c = _triple(rng, lvl)
    return short_num(f"Катеты прямоугольного треугольника равны {a} и {b}. Найдите гипотенузу.", c,
                     explain=f"c = √(a² + b²) = √({a * a} + {b * b}) = √{c * c} = {c}.")


def q_pyth_leg(rng, lvl):
    a, b, c = _triple(rng, lvl)
    return short_num(f"Гипотенуза прямоугольного треугольника равна {c}, один из катетов — {a}. Найдите второй катет.", b,
                     explain=f"b = √(c² − a²) = √({c * c} − {a * a}) = √{b * b} = {b}.")


def q_pyth_check(rng, lvl):
    a, b, c = _triple(rng, lvl)
    yes = rng.random() < 0.5
    if not yes:
        c += rng.choice([-1, 1])
    sides = sorted((a, b, c))
    s = sides[0] ** 2 + sides[1] ** 2
    return fixed(f"Является ли прямоугольным треугольник со сторонами {sides[0]}, {sides[1]} и {sides[2]}?", ["Да", "Нет"], 0 if yes else 1,
                 f"{sides[0]}² + {sides[1]}² = {s}, {sides[2]}² = {sides[2] ** 2}: {'равны — по обратной теореме Пифагора треугольник прямоугольный' if yes else 'не равны, значит треугольник не прямоугольный'}.")


def q_pyth_diag(rng, lvl):
    a, b, c = _triple(rng, lvl)
    return short_num(f"Стороны прямоугольника равны {a} и {b}. Найдите его диагональ.", c,
                     explain=f"Диагональ — гипотенуза треугольника с катетами {a} и {b}: √({a * a} + {b * b}) = {c}.")


def q_pyth_root(rng, lvl):
    a, b = rng.sample(range(1, 8), 2)
    s = a * a + b * b
    k = math.isqrt(s)
    if k * k == s:
        raise _Retry
    right = surd(s)
    tail = "" if right == f"√{s}" else f" = {right}"
    return single(rng, f"Катеты прямоугольного треугольника равны {a} и {b}. Найдите гипотенузу.", right,
                  [str(a + b), surd(abs(a * a - b * b)), surd(s + 2), surd(s - 1), str(k)],
                  f"c = √({a}² + {b}²) = √{s}{tail}.")


def q_area(rng, lvl):
    kind = rng.choice(["rect", "tri", "trap", "par", "rhomb", "sq"])
    if kind == "rect":
        a, b = rng.randint(2, 15), rng.randint(2, 15)
        return short_num(f"Найдите площадь прямоугольника со сторонами {a} см и {b} см (в см²).", a * b, "см²", f"S = a·b = {a}·{b} = {a * b} см².")
    if kind == "tri":
        a, h = rng.randint(2, 16), rng.randint(2, 16)
        if a * h % 2:
            raise _Retry
        return short_num(f"Сторона треугольника равна {a} см, а высота, проведённая к ней, — {h} см. Найдите площадь треугольника (в см²).",
                         a * h // 2, "см²", f"S = ½·a·h = ½·{a}·{h} = {a * h // 2} см².")
    if kind == "trap":
        a, b, h = rng.randint(2, 14), rng.randint(2, 14), rng.randint(2, 12)
        if a == b or (a + b) * h % 2:
            raise _Retry
        return short_num(f"Основания трапеции равны {a} см и {b} см, высота — {h} см. Найдите площадь трапеции (в см²).",
                         (a + b) * h // 2, "см²", f"S = (a + b)/2·h = ({a} + {b})/2·{h} = {(a + b) * h // 2} см².")
    if kind == "par":
        a, h = rng.randint(3, 15), rng.randint(2, 12)
        return short_num(f"Сторона параллелограмма равна {a} см, высота, проведённая к ней, — {h} см. Найдите площадь (в см²).",
                         a * h, "см²", f"S = a·h = {a}·{h} = {a * h} см².")
    if kind == "rhomb":
        d1, d2 = rng.randint(2, 16), rng.randint(2, 16)
        if d1 * d2 % 2:
            raise _Retry
        return short_num(f"Диагонали ромба равны {d1} см и {d2} см. Найдите площадь ромба (в см²).", d1 * d2 // 2, "см²",
                         f"S = d₁·d₂ / 2 = {d1}·{d2} / 2 = {d1 * d2 // 2} см².")
    side = rng.randint(2, 15)
    return short_num(f"Периметр квадрата равен {4 * side} см. Найдите его площадь (в см²).", side * side, "см²",
                     f"Сторона = {4 * side} : 4 = {side} см; S = {side}² = {side * side} см².")


def q_circle(rng, lvl):
    r = rng.randint(2, 10)
    kind = rng.choice(["area", "len"])
    if kind == "area":
        right = f"{r * r}π"
        return single(rng, f"Найдите площадь круга радиуса {r} см.", f"{right} см²",
                      [f"{2 * r}π см²", f"{r}π см²", f"{2 * r * r}π см²", f"{r * r} см²", f"{4 * r * r}π см²"], f"S = πr² = π·{r}² = {right} см².")
    right = f"{2 * r}π"
    return single(rng, f"Найдите длину окружности радиуса {r} см.", f"{right} см",
                  [f"{r * r}π см", f"{r}π см", f"{4 * r}π см", f"{2 * r} см", f"{r * r * 2}π см"], f"C = 2πr = 2π·{r} = {right} см.")


def q_angle_third(rng, lvl):
    a, b = rng.randint(20, 100), rng.randint(20, 100)
    if a + b >= 170:
        raise _Retry
    return short_num(f"Два угла треугольника равны {a}° и {b}°. Найдите третий угол (в градусах).", 180 - a - b, "°",
                     f"Сумма углов треугольника 180°: 180° − {a}° − {b}° = {180 - a - b}°.")


def q_angle_iso(rng, lvl):
    if rng.random() < 0.5:
        v = rng.choice(range(20, 161, 2))
        return short_num(f"Угол при вершине равнобедренного треугольника равен {v}°. Найдите угол при основании (в градусах).",
                         (180 - v) // 2, "°", f"Углы при основании равны: (180° − {v}°) / 2 = {(180 - v) // 2}°.")
    base = rng.randint(20, 85)
    return short_num(f"Угол при основании равнобедренного треугольника равен {base}°. Найдите угол при вершине (в градусах).",
                     180 - 2 * base, "°", f"180° − 2·{base}° = {180 - 2 * base}°.")


def q_angle_ext(rng, lvl):
    a, b = rng.randint(20, 80), rng.randint(20, 80)
    return short_num(f"Два угла треугольника равны {a}° и {b}°. Найдите внешний угол при третьей вершине (в градусах).", a + b, "°",
                     f"Внешний угол равен сумме двух внутренних, не смежных с ним: {a}° + {b}° = {a + b}°.")


def q_angle_ratio(rng, lvl):
    p, q, r = rng.choice([(1, 2, 3), (2, 3, 4), (1, 1, 2), (3, 4, 5), (1, 4, 7), (2, 3, 7), (1, 2, 6), (4, 5, 9)])
    k = Fraction(180, p + q + r)
    if k.denominator != 1:
        raise _Retry
    return short_num(f"Углы треугольника относятся как {p} : {q} : {r}. Найдите наибольший угол (в градусах).", r * k, "°",
                     f"180° : ({p} + {q} + {r}) = {num(k)}°; наибольший угол {r}·{num(k)}° = {num(r * k)}°.")


def q_angle_right(rng, lvl):
    a = rng.randint(12, 78)
    return short_num(f"Один из острых углов прямоугольного треугольника равен {a}°. Найдите другой острый угол (в градусах).", 90 - a, "°",
                     f"Сумма острых углов прямоугольного треугольника 90°: 90° − {a}° = {90 - a}°.")


# ------------------------------------------------------------------ physics (g = 10 Н/кг, как в школьных задачниках)
def q_ohm(rng, lvl):
    r = rng.choice([2, 4, 5, 10, 20, 25, 40, 50, 100])
    i = rng.choice([Fraction(1, 2), Fraction(1, 4), 1, 2, 3, 4, 5] if lvl else [1, 2, 3, 4, 5])
    u = Fraction(r) * i
    if u.denominator != 1:
        raise _Retry
    kind = rng.choice(["I", "R", "U"])
    if kind == "I":
        return short_num(f"Напряжение на резисторе {num(u)} В, его сопротивление {r} Ом. Найдите силу тока (в амперах).", i, "А",
                         f"Закон Ома для участка цепи: I = U / R = {num(u)} / {r} = {num(i)} А.")
    if kind == "R":
        return short_num(f"При напряжении {num(u)} В сила тока в проводнике {num(i)} А. Найдите сопротивление проводника (в омах).", r, "Ом",
                         f"R = U / I = {num(u)} / {num(i)} = {r} Ом.")
    return short_num(f"Сила тока в резисторе сопротивлением {r} Ом равна {num(i)} А. Найдите напряжение на резисторе (в вольтах).", u, "В",
                     f"U = I·R = {num(i)}·{r} = {num(u)} В.")


def q_resist_join(rng, lvl):
    if rng.random() < 0.5:
        r1, r2 = rng.randint(2, 30), rng.randint(2, 30)
        return short_num(f"Резисторы {r1} Ом и {r2} Ом соединены последовательно. Найдите общее сопротивление (в омах).", r1 + r2, "Ом",
                         f"При последовательном соединении R = R₁ + R₂ = {r1} + {r2} = {r1 + r2} Ом.")
    r1, r2 = rng.choice([(3, 6), (4, 12), (6, 12), (10, 15), (20, 30), (12, 24), (6, 6), (10, 10), (2, 2), (12, 4), (30, 60)])
    r = Fraction(r1 * r2, r1 + r2)
    return short_num(f"Резисторы {r1} Ом и {r2} Ом соединены параллельно. Найдите общее сопротивление (в омах).", r, "Ом",
                     f"1/R = 1/{r1} + 1/{r2}, R = R₁R₂/(R₁ + R₂) = {r1 * r2}/{r1 + r2} = {num(r)} Ом.")


def q_ohm_change(rng, lvl):
    k = rng.choice([2, 3, 4])
    if rng.random() < 0.5:
        return single(rng, f"Как изменится сила тока на участке цепи, если напряжение увеличить в {k} раза, а сопротивление не менять?",
                      f"Увеличится в {k} раза", [f"Уменьшится в {k} раза", "Не изменится", f"Увеличится в {k * k} раза"],
                      f"I = U / R: при неизменном R сила тока прямо пропорциональна напряжению — увеличится в {k} раза.")
    return single(rng, f"Как изменится сила тока на участке цепи, если сопротивление увеличить в {k} раза при том же напряжении?",
                  f"Уменьшится в {k} раза", [f"Увеличится в {k} раза", "Не изменится", f"Уменьшится в {k * k} раза"],
                  f"I = U / R: при неизменном U сила тока обратно пропорциональна сопротивлению — уменьшится в {k} раза.")


def q_el_power(rng, lvl):
    u = rng.choice([12, 24, 36, 110, 220])
    i = rng.choice([Fraction(1, 2), 1, 2, 3, 5] if lvl else [1, 2, 3, 5])
    p = u * Fraction(i)
    return short_num(f"Напряжение на лампе {u} В, сила тока {num(i)} А. Найдите мощность тока (в ваттах).", p, "Вт",
                     f"P = U·I = {u}·{num(i)} = {num(p)} Вт.")


# вещество (род. п.), предмет (им. п.), предмет (род. п.), плотность кг/м³
DENSITY = [("воды", "Вода в баке", "воды в баке", 1000), ("алюминия", "Алюминиевый брусок", "алюминиевого бруска", 2700),
           ("железа", "Железная деталь", "железной детали", 7800), ("меди", "Медная деталь", "медной детали", 8900),
           ("льда", "Льдина", "льдины", 900), ("свинца", "Свинцовый груз", "свинцового груза", 11300),
           ("бетона", "Бетонный блок", "бетонного блока", 2300)]


def q_density(rng, lvl):
    name, obj, obj_gen, rho = rng.choice(DENSITY)
    v = rng.choice([Fraction(1, 1000), Fraction(2, 1000), Fraction(5, 1000), Fraction(1, 100), Fraction(2, 100), Fraction(1, 10), Fraction(1, 2)])
    m = rho * Fraction(v)
    kind = rng.choice(["m", "rho", "V"])
    if kind == "m":
        return short_num(f"Найдите массу {obj_gen} объёмом {num(v)} м³. Плотность {name} {rho} кг/м³. Ответ — в килограммах.", m, "кг",
                         f"m = ρ·V = {rho}·{num(v)} = {num(m)} кг.")
    if kind == "rho":
        return short_num(f"Тело массой {num(m)} кг имеет объём {num(v)} м³. Найдите плотность вещества (в кг/м³).", rho, "кг/м³",
                         f"ρ = m / V = {num(m)} / {num(v)} = {rho} кг/м³ — это плотность {name}.")
    return short_num(f"{obj} имеет массу {num(m)} кг. Плотность {name} {rho} кг/м³. Найдите объём (в м³).", v, "м³",
                     f"V = m / ρ = {num(m)} / {rho} = {num(v)} м³.")


def q_motion(rng, lvl):
    kind = rng.choice(["s", "v", "t", "conv"] if lvl else ["s", "v", "t"])
    if kind == "conv":
        kmh = rng.choice([18, 36, 54, 72, 90, 108])
        return short_num(f"Переведите скорость {kmh} км/ч в метры в секунду.", Fraction(kmh * 1000, 3600), "м/с",
                         f"{kmh} км/ч = {kmh}·1000 м / 3600 с = {num(Fraction(kmh * 1000, 3600))} м/с.")
    who, v = rng.choice([("Пешеход", 5), ("Велосипедист", 12), ("Велосипедист", 15), ("Велосипедист", 20), ("Автобус", 40), ("Автобус", 60),
                         ("Автомобиль", 80), ("Автомобиль", 90), ("Поезд", 60), ("Поезд", 80), ("Поезд", 90)])
    t = rng.choice([2, 3, 4, 5, 6])
    s = v * t
    if kind == "s":
        return short_num(f"{who} движется равномерно со скоростью {v} км/ч. Какой путь он пройдёт за {t} ч (в километрах)?", s, "км",
                         f"s = v·t = {v}·{t} = {s} км.")
    if kind == "v":
        return short_num(f"{who} прошёл {s} км за {t} ч, двигаясь равномерно. Найдите его скорость (в км/ч).", v, "км/ч",
                         f"v = s / t = {s} / {t} = {v} км/ч.")
    return short_num(f"{who} движется равномерно со скоростью {v} км/ч. За сколько часов он пройдёт {s} км?", t, "ч",
                     f"t = s / v = {s} / {v} = {t} ч.")


def q_avg_speed(rng, lvl):
    s1, v1 = rng.choice([(60, 60), (120, 60), (90, 45), (100, 50), (80, 40)])
    s2, v2 = rng.choice([(60, 30), (40, 20), (120, 40), (30, 15), (100, 100)])
    t = Fraction(s1, v1) + Fraction(s2, v2)
    v = Fraction(s1 + s2) / t
    if v.denominator != 1:
        raise _Retry
    return short_num(f"Автомобиль проехал {s1} км со скоростью {v1} км/ч, затем {s2} км со скоростью {v2} км/ч. Найдите среднюю скорость (в км/ч).",
                     v, "км/ч", f"t = {s1}/{v1} + {s2}/{v2} = {num(t)} ч; vср = ({s1} + {s2}) / {num(t)} = {num(v)} км/ч.")


def q_work(rng, lvl):
    kind = rng.choice(["A", "N", "lift"] if lvl else ["A", "N"])
    if kind == "A":
        f, s = rng.choice([10, 20, 50, 100, 200, 500]), rng.choice([2, 3, 5, 10, 20])
        return short_num(f"Под действием силы {f} Н тело переместилось на {s} м в направлении силы. Найдите работу силы (в джоулях).", f * s, "Дж",
                         f"A = F·s = {f}·{s} = {f * s} Дж.")
    if kind == "N":
        t = rng.choice([2, 4, 5, 10, 20])
        n = rng.choice([10, 25, 50, 100, 200])
        return short_num(f"За {t} с двигатель совершил работу {n * t} Дж. Найдите его мощность (в ваттах).", n, "Вт",
                         f"N = A / t = {n * t} / {t} = {n} Вт.")
    m, h = rng.choice([2, 5, 10, 20, 50]), rng.choice([2, 3, 5, 10])
    return short_num(f"Груз массой {m} кг равномерно подняли на высоту {h} м. Какую работу совершили (в джоулях)? g = 10 Н/кг.", m * 10 * h, "Дж",
                     f"A = m·g·h = {m}·10·{h} = {m * 10 * h} Дж.")


def q_pressure(rng, lvl):
    if rng.random() < 0.5 or lvl == 0:
        f = rng.choice([100, 200, 400, 500, 600, 1000, 1200])
        s = rng.choice([Fraction(1, 10), Fraction(2, 10), Fraction(1, 2), 1, 2, 4])
        p = f / Fraction(s)
        if p.denominator != 1:
            raise _Retry
        return short_num(f"Сила {f} Н действует перпендикулярно на площадь {num(s)} м². Найдите давление (в паскалях).", p, "Па",
                         f"p = F / S = {f} / {num(s)} = {num(p)} Па.")
    h = rng.choice([1, 2, 3, 5, 10, 20])
    p = 1000 * 10 * h
    return short_num(f"Найдите давление воды на глубине {h} м (в паскалях). Плотность воды 1000 кг/м³, g = 10 Н/кг, атмосферное давление не учитывайте.",
                     p, "Па", f"p = ρ·g·h = 1000·10·{h} = {p} Па.")


def q_gravity(rng, lvl):
    kind = rng.choice(["F", "m", "hooke"] if lvl else ["F", "m"])
    if kind == "F":
        m = rng.choice([Fraction(1, 2), 1, 2, 5, 10, 40, 60, 75])
        return short_num(f"Найдите силу тяжести, действующую на тело массой {num(m)} кг (в ньютонах). g = 10 Н/кг.", Fraction(m) * 10, "Н",
                         f"F = m·g = {num(m)}·10 = {num(Fraction(m) * 10)} Н.")
    if kind == "m":
        f = rng.choice([5, 20, 50, 150, 300, 700])
        return short_num(f"На тело действует сила тяжести {f} Н. Найдите его массу (в килограммах). g = 10 Н/кг.", Fraction(f, 10), "кг",
                         f"m = F / g = {f} / 10 = {num(Fraction(f, 10))} кг.")
    k, x_cm = rng.choice([50, 100, 200, 400, 500]), rng.choice([2, 4, 5, 10])
    f = Fraction(k * x_cm, 100)
    return short_num(f"Жёсткость пружины {k} Н/м. Какая сила растянет её на {x_cm} см (в ньютонах)?", f, "Н",
                     f"x = {x_cm} см = {num(Fraction(x_cm, 100))} м; F = k·x = {k}·{num(Fraction(x_cm, 100))} = {num(f)} Н.")


HEAT = {"воды": 4200, "алюминия": 920, "меди": 400, "железа": 460, "кирпича": 880}


def q_heat(rng, lvl):
    name, c = rng.choice(list(HEAT.items()) if lvl else [("воды", 4200)])
    m = rng.choice([Fraction(1, 2), 1, 2, 3, 5])
    dt = rng.choice([10, 20, 40, 50, 80])
    q = c * Fraction(m) * dt
    kj = q / 1000
    return short_num(f"Какое количество теплоты нужно, чтобы нагреть {num(m)} кг {name} на {dt} °C? Удельная теплоёмкость {name} {c} Дж/(кг·°C). Ответ — в килоджоулях.",
                     kj, "кДж", f"Q = c·m·Δt = {c}·{num(m)}·{dt} = {num(q)} Дж = {num(kj)} кДж.")


# ------------------------------------------------------------------ chemistry (Ar округлены, как в школьной таблице; Cl = 35,5)
AR = {"H": 1, "C": 12, "N": 14, "O": 16, "Na": 23, "Mg": 24, "Al": 27, "Si": 28, "P": 31, "S": 32, "Cl": Fraction(71, 2),
      "K": 39, "Ca": 40, "Fe": 56, "Cu": 64, "Zn": 65, "Ag": 108, "Ba": 137}
FORMULAS = [("H2O", "воды"), ("CO2", "углекислого газа"), ("NaCl", "хлорида натрия"), ("H2SO4", "серной кислоты"), ("CaCO3", "карбоната кальция"),
            ("NaOH", "гидроксида натрия"), ("HCl", "хлороводорода"), ("O2", "кислорода"), ("NH3", "аммиака"), ("CH4", "метана"),
            ("Ca(OH)2", "гидроксида кальция"), ("Al2O3", "оксида алюминия"), ("Fe2O3", "оксида железа(III)"), ("CuSO4", "сульфата меди(II)"),
            ("HNO3", "азотной кислоты"), ("MgO", "оксида магния"), ("C6H12O6", "глюкозы"), ("KOH", "гидроксида калия"), ("SO2", "оксида серы(IV)"),
            ("Al2(SO4)3", "сульфата алюминия"), ("H3PO4", "фосфорной кислоты"), ("CuO", "оксида меди(II)"), ("ZnO", "оксида цинка"), ("BaSO4", "сульфата бария")]


def parse_formula(formula: str) -> dict[str, int]:
    """«Al2(SO4)3» → {"Al": 2, "S": 3, "O": 12}.  Only the subset of notation used in the bank."""
    def group(s: str, i: int) -> tuple[dict[str, int], int]:
        out: dict[str, int] = {}
        while i < len(s) and s[i] != ")":
            if s[i] == "(":
                inner, i = group(s, i + 1)
                i += 1
                m = re.match(r"\d*", s[i:])
                k = int(m.group() or 1)
                i += len(m.group())
                for el, n in inner.items():
                    out[el] = out.get(el, 0) + n * k
                continue
            m = re.match(r"([A-Z][a-z]?)(\d*)", s[i:])
            if not m:
                raise ValueError(formula)
            out[m.group(1)] = out.get(m.group(1), 0) + int(m.group(2) or 1)
            i += len(m.group())
        return out, i
    counts, _ = group(formula, 0)
    return counts


def molar(formula: str) -> Fraction:
    return sum((Fraction(AR[el]) * n for el, n in parse_formula(formula).items()), Fraction(0))


def _mr_line(formula: str) -> str:
    return " + ".join(f"{n}·{num(AR[el])}" if n > 1 else f"{num(AR[el])}" for el, n in parse_formula(formula).items())


def q_molar(rng, lvl):
    pool = FORMULAS[:10] if lvl == 0 else FORMULAS[:18] if lvl == 1 else FORMULAS
    f, name = rng.choice(pool)
    m = molar(f)
    return short_num(f"Вычислите молярную массу {name} {chem(f)} (в г/моль).", m, "г/моль",
                     f"M({chem(f)}) = {_mr_line(f)} = {num(m)} г/моль.")


def q_moles(rng, lvl):
    f, name = rng.choice(FORMULAS[:12])
    m_ = molar(f)
    n = rng.choice([Fraction(1, 4), Fraction(1, 2), 1, 2, 3, 5] if lvl else [Fraction(1, 2), 1, 2, 3])
    mass = m_ * Fraction(n)
    kind = rng.choice(["n", "m", "V"] if f in ("CO2", "O2", "NH3", "CH4", "HCl") else ["n", "m"])
    if kind == "n":
        return short_num(f"Какое количество вещества (моль) содержится в {num(mass)} г {name} {chem(f)}?", n, "моль",
                         f"M({chem(f)}) = {num(m_)} г/моль; n = m / M = {num(mass)} / {num(m_)} = {num(n)} моль.")
    if kind == "m":
        return short_num(f"Найдите массу {num(n)} моль {name} {chem(f)} (в граммах).", mass, "г",
                         f"m = n·M = {num(n)}·{num(m_)} = {num(mass)} г.")
    v = Fraction(n) * Fraction(224, 10)
    return short_num(f"Найдите объём {num(n)} моль {name} {chem(f)} при нормальных условиях (в литрах). Vm = 22,4 л/моль.", v, "л",
                     f"V = n·Vm = {num(n)}·22,4 = {num(v)} л.")


def q_mass_fraction_el(rng, lvl):
    cands = [(f, name, el) for f, name in FORMULAS for el in parse_formula(f)
             if len(parse_formula(f)) > 1 and _decimal(Fraction(AR[el]) * parse_formula(f)[el] * 100 / molar(f)) and
             (Fraction(AR[el]) * parse_formula(f)[el] * 100 / molar(f)).denominator in (1, 2, 5, 10)]
    f, name, el = rng.choice(cands)
    w = Fraction(AR[el]) * parse_formula(f)[el] * 100 / molar(f)
    return short_num(f"Вычислите массовую долю элемента {el} в {chem(f)} (в процентах).", w, "%",
                     f"w({el}) = {parse_formula(f)[el]}·{num(AR[el])} / {num(molar(f))} · 100% = {num(w)}%.")


def q_solution(rng, lvl):
    kind = rng.choice(["w", "m", "dilute"] if lvl == 2 else ["w", "m"])
    msol = rng.choice([50, 80, 100, 150, 200, 250, 400, 500])
    w = rng.choice([2, 4, 5, 10, 15, 20, 25])
    ms = Fraction(msol * w, 100)
    if kind == "w":
        return short_num(f"В {num(msol - ms)} г воды растворили {num(ms)} г соли. Найдите массовую долю соли в растворе (в процентах).", w, "%",
                         f"Масса раствора {num(msol - ms)} + {num(ms)} = {msol} г; w = {num(ms)} / {msol} · 100% = {w}%.")
    if kind == "m":
        return short_num(f"Сколько граммов соли содержится в {msol} г {w}%-го раствора?", ms, "г",
                         f"m(соли) = {msol} · {w} / 100 = {num(ms)} г.")
    add = msol
    w2 = Fraction(ms * 100, msol + add)
    return short_num(f"К {msol} г {w}%-го раствора соли добавили {add} г воды. Найдите массовую долю соли в новом растворе (в процентах).", w2, "%",
                     f"Соли {num(ms)} г, раствора {msol + add} г: w = {num(ms)} / {msol + add} · 100% = {num(w2)}%.")


# ------------------------------------------------------------------ informatics
def q_to_binary(rng, lvl):
    n = rng.randint(5, 31 if lvl == 0 else 127 if lvl == 1 else 1023)
    b = format(n, "b")
    return short(f"Переведите число {n} из десятичной системы счисления в двоичную. Запишите только цифры.", [b],
                 f"Делим на 2 и записываем остатки снизу вверх: {n}₁₀ = {b}₂.")


def q_from_binary(rng, lvl):
    n = rng.randint(5, 31 if lvl == 0 else 255 if lvl == 1 else 2047)
    b = format(n, "b")
    terms = " + ".join(f"2{sup(len(b) - 1 - i)}" for i, ch in enumerate(b) if ch == "1")
    return short_num(f"Переведите двоичное число {b}₂ в десятичную систему счисления.", n, explain=f"{b}₂ = {terms} = {n}.")


def q_hex(rng, lvl):
    n = rng.randint(16, 255 if lvl < 2 else 4095)
    h = format(n, "X")
    return short_num(f"Переведите шестнадцатеричное число {h}₁₆ в десятичную систему счисления.", n,
                     explain=f"{h}₁₆ = " + " + ".join(f"{int(ch, 16)}·16{sup(len(h) - 1 - i)}" for i, ch in enumerate(h)) + f" = {n}.")


def q_ones(rng, lvl):
    n = rng.randint(9, 255 if lvl < 2 else 4095)
    b = format(n, "b")
    return short_num(f"Сколько единиц в двоичной записи числа {n}?", b.count("1"), explain=f"{n}₁₀ = {b}₂ — единиц: {b.count('1')}.")


def q_info_units(rng, lvl):
    kind = rng.choice(["bits", "kb", "text", "alphabet"] if lvl else ["bits", "kb", "alphabet"])
    if kind == "bits":
        n = rng.choice([2, 4, 8, 16, 32, 64, 128])
        return short_num(f"Сколько бит в {n} байтах?", n * 8, "бит", f"1 байт = 8 бит: {n}·8 = {n * 8} бит.")
    if kind == "kb":
        n = rng.choice([1, 2, 4, 8, 16])
        return short_num(f"Сколько байт в {n} Кбайт?", n * 1024, "байт", f"1 Кбайт = 1024 байта: {n}·1024 = {n * 1024} байт.")
    if kind == "alphabet":
        i = rng.randint(1, 8)
        return short_num(f"Алфавит содержит {2 ** i} символов. Сколько бит информации несёт один символ этого алфавита?", i, "бит",
                         f"N = 2ⁱ: {2 ** i} = 2{sup(i)}, поэтому i = {i} бит.")
    chars, bits = rng.choice([(64, 8), (128, 8), (256, 16), (512, 8), (1024, 16), (2048, 8)])
    kbytes = Fraction(chars * bits, 8 * 1024)
    return short_num(f"Текст из {chars} символов закодирован {bits}-битной кодировкой. Каков его информационный объём в Кбайтах?", kbytes, "Кбайт",
                     f"{chars}·{bits} бит = {chars * bits // 8} байт = {num(kbytes)} Кбайт.")


# ------------------------------------------------------------------ catalogue
@dataclass(frozen=True)
class Family:
    key: str
    title: str
    group: str
    patterns: tuple[str, ...]
    makers: tuple[Callable[[random.Random, int], dict[str, Any]], ...]


FAMILIES: tuple[Family, ...] = (
    Family("quad_eq", "Квадратные уравнения", "math", (r"квадратн\w*\s+уравнен", r"дискриминант", r"виет"),
           (q_discriminant, q_quad_roots, q_vieta_sum, q_vieta_prod, q_roots_count, q_two_roots_multi)),
    Family("sqrt", "Квадратные корни", "math", (r"квадратн\w*\s+кор", r"арифметическ\w*\s+(квадратн\w*\s+)?кор", r"корень из", r"извлечени\w*\s+кор", r"√"),
           (q_sqrt_value, q_sqrt_product, q_sqrt_fraction, q_sqrt_factor_out, q_sqrt_compare, q_sqrt_between, q_sqrt_rational, q_sqrt_sum)),
    Family("linear_eq", "Линейные уравнения", "math", (r"линейн\w*\s+уравнен", r"уравнени\w*\s+с\s+одн\w*\s+(неизвестн|переменн)", r"решени\w*\s+уравнен"),
           (q_linear_basic, q_linear_both, q_linear_brackets, q_linear_pick)),
    Family("fractions", "Обыкновенные дроби", "math", (r"дроб", r"обыкновенн"), (q_frac_op, q_frac_reduce, q_frac_of_number, q_frac_compare)),
    Family("percent", "Проценты", "math", (r"процент",), (q_pct_of, q_pct_which, q_pct_whole, q_pct_price, q_pct_twice)),
    Family("powers", "Степени и их свойства", "math", (r"степен(?!\w*\s+окислен)", r"показател"), (q_pow_value, q_pow_rules, q_pow_negative, q_pow_zero)),
    Family("short_mult", "Формулы сокращённого умножения", "math", (r"сокращенн\w*\s+умножен", r"квадрат\w*\s+(суммы|разност)", r"разност\w*\s+квадрат"),
           (q_square_expand, q_diff_squares_num, q_factor_diff, q_mental_square)),
    Family("linear_fn", "Линейная функция", "math", (r"линейн\w*\s+функц", r"углов\w*\s+коэффициент", r"график\w*\s+линейн"),
           (q_lin_value, q_lin_point, q_lin_zero, q_lin_slope, q_lin_parallel)),
    Family("inequalities", "Линейные неравенства", "math", (r"неравенств",), (q_ineq, q_ineq_count)),
    Family("systems", "Системы линейных уравнений", "math", (r"систем\w*\s+(линейн\w*\s+)?уравнен",), (q_system,)),
    Family("ap", "Арифметическая прогрессия", "math", (r"арифметическ\w*\s+прогресс",), (q_ap_term, q_ap_diff, q_ap_sum)),
    Family("gp", "Геометрическая прогрессия", "math", (r"геометрическ\w*\s+прогресс",), (q_gp_term, q_gp_ratio, q_gp_sum)),
    Family("pythagoras", "Теорема Пифагора", "math", (r"пифагор", r"гипотенуз", r"катет", r"прямоугольн\w*\s+треугольн"),
           (q_pyth_hyp, q_pyth_leg, q_pyth_check, q_pyth_diag, q_pyth_root)),
    Family("areas", "Площади фигур", "math", (r"площад",), (q_area, q_area, q_circle)),
    Family("angles", "Углы треугольника", "math", (r"сумм\w*\s+угл", r"угл\w*\s+треугольник", r"равнобедренн", r"внешн\w*\s+угл"),
           (q_angle_third, q_angle_iso, q_angle_ext, q_angle_ratio, q_angle_right)),
    Family("ohm", "Закон Ома и электрическая цепь", "physics", (r"закон\w*\s+ома", r"сил\w*\s+тока", r"сопротивлени", r"напряжени", r"электрическ\w*\s+(цеп|ток)", r"соединени\w*\s+(проводник|резистор)"),
           (q_ohm, q_resist_join, q_ohm_change, q_el_power)),
    Family("density", "Плотность вещества", "physics", (r"плотност",), (q_density,)),
    Family("motion", "Скорость, путь и время", "physics", (r"скорост", r"равномерн\w*\s+движени", r"механическ\w*\s+движени", r"\bпуть\b"),
           (q_motion, q_motion, q_avg_speed)),
    Family("work", "Механическая работа и мощность", "physics", (r"механическ\w*\s+работ", r"мощност", r"работ\w*\s+сил"), (q_work,)),
    Family("pressure", "Давление", "physics", (r"давлени",), (q_pressure,)),
    Family("gravity", "Сила тяжести, вес и сила упругости", "physics", (r"сил\w*\s+тяжест", r"\bвес(а|у|ом|е)?\b", r"упругост", r"гука"), (q_gravity,)),
    Family("heat", "Количество теплоты", "physics", (r"количеств\w*\s+теплот", r"теплоемк", r"нагревани"), (q_heat,)),
    Family("molar", "Молярная масса", "chemistry", (r"молярн\w*\s+масс", r"молекулярн\w*\s+масс", r"относительн\w*\s+(атомн|молекулярн)"), (q_molar,)),
    Family("moles", "Количество вещества и молярный объём", "chemistry", (r"количеств\w*\s+веществ", r"\bмол(ь|я|ей|ях|ями)?\b", r"молярн\w*\s+объем", r"авогадро"),
           (q_moles,)),
    Family("fraction_el", "Массовая доля элемента", "chemistry", (r"массов\w*\s+дол\w*\s+элемент",), (q_mass_fraction_el,)),
    Family("solution", "Массовая доля вещества в растворе", "chemistry", (r"массов\w*\s+дол", r"раствор", r"концентрац"), (q_solution,)),
    Family("numeral", "Системы счисления", "informatics", (r"систем\w*\s+счислени", r"двоичн", r"шестнадцатеричн", r"восьмеричн"),
           (q_to_binary, q_from_binary, q_hex, q_ones)),
    Family("info", "Количество информации", "informatics", (r"информац\w*\s+(объем|вес)", r"количеств\w*\s+информац", r"\bбит", r"байт", r"кодировани"),
           (q_info_units,)),
)
GROUP_OF_SUBJECT = (("math", r"алгебр|геометр|математ"), ("physics", r"физик"), ("chemistry", r"хими"), ("informatics", r"информат"))
GROUP_TITLE = {"math": "математика", "physics": "физика", "chemistry": "химия", "informatics": "информатика"}


def _norm(text: str) -> str:
    t = unicodedata.normalize("NFKC", str(text or "")).lower().replace("ё", "е")
    return re.sub(r"\s+", " ", t).strip()


def subject_group(subject: str) -> str | None:
    s = _norm(subject)
    for group, pat in GROUP_OF_SUBJECT:
        if re.search(pat, s):
            return group
    return None


def topics_for(subject: str) -> list[dict[str, str]]:
    group = subject_group(subject)
    return [{"key": f.key, "title": f.title} for f in FAMILIES if f.group == group]


def match(subject: str, topic: str) -> list[Family]:
    """Families of the subject's group whose patterns occur in the topic (the special «массовая доля элемента»
    wins over the generic «массовая доля»)."""
    group = subject_group(subject)
    if group is None:
        supported = ", ".join(sorted(GROUP_TITLE.values()))
        raise BankError(f"Для предмета «{subject.strip()[:60]}» во встроенном банке нет шаблонов (есть: {supported}). "
                        "Соберите опрос вручную — конструктор работает без ИИ.", "bank_subject_unsupported")
    t = _norm(topic)
    by_title = {_norm(f.title): f for f in FAMILIES if f.group == group}
    if t in by_title:
        return [by_title[t]]
    found = [f for f in FAMILIES if f.group == group and any(re.search(p, t) for p in f.patterns)]
    if any(f.key == "fraction_el" for f in found):
        found = [f for f in found if f.key != "solution"]
    if any(f.key == "quad_eq" for f in found) and not re.search(r"квадратн\w*\s+кор", t):
        found = [f for f in found if f.key != "sqrt"]
    if not found:
        titles = ", ".join(f["title"] for f in topics_for(subject))
        raise BankError(f"Для темы «{topic.strip()[:80]}» во встроенном банке нет вопросов. Темы банка по предмету: {titles}. "
                        "Выберите одну из них или соберите опрос вручную.", "bank_topic_unknown", topics_for(subject))
    return found[:3]


def _seed(keys: list[str], count: int, level: int, variant: int, i: int) -> random.Random:
    raw = f"sferum-bank-v1|{','.join(keys)}|{count}|{level}|{variant}|{i}".encode()
    return random.Random(int.from_bytes(hashlib.sha256(raw).digest()[:8], "big"))


def build(subject: str, topic: str, count: int = 5, difficulty: str = "normal", variant: int = 0) -> dict[str, Any]:
    """Deterministic draft.  Returns {questions, families, variant}; raises BankError for unknown subject/topic."""
    from app.assignments import HwError, normalize_quiz
    families = match(subject, topic)
    level = LEVEL.get(difficulty, 1)
    count = max(1, min(MAX_COUNT, int(count)))
    keys = [f.key for f in families]
    order_rng = _seed(keys, count, level, variant, -1)
    plans = []
    for f in families:
        makers = list(f.makers)
        order_rng.shuffle(makers)
        plans.append(makers)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    i = 0
    while len(out) < count and i < count * 12:
        fam = i % len(families)
        makers = plans[fam]
        maker = makers[(i // len(families)) % len(makers)]
        rng = _seed(keys, count, level, variant, i)
        i += 1
        try:
            q = maker(rng, level)
        except _Retry:
            continue
        sig = _norm(q["text"])
        if sig in seen:
            continue
        cand = {**q, "points": 1}
        try:
            item = normalize_quiz({"questions": [cand]})["questions"][0]
        except HwError:          # a template produced something the quiz validator refuses → skip, never ship it
            continue
        seen.add(sig)
        out.append({k: item[k] for k in ("kind", "text", "options", "correct", "answers", "points", "explain")})
    if not out:
        raise BankError("Не удалось собрать вопросы по этой теме. Соберите опрос вручную.", "bank_empty")
    return {"questions": out, "families": [f.title for f in families], "variant": variant}


__all__ = ["BankError", "FAMILIES", "build", "match", "molar", "parse_formula", "subject_group", "topics_for"]
