"""v3.2 · CUR-02: детерминированные квизы и практикумы для всех 283 тем реестра (0 пустых тем).

Источник фактов один — список ключевых понятий темы (app/topic_terms.py). Генератор ничего не придумывает сверх
него: вопросы проверяют, к какой теме относится понятие, а «доска понятий» раскладывает понятия темы и двух соседних
тем того же предмета и класса. Решаемость каждого этапа проверяет тот же перебор, что и для ручных практикумов
(tests/test_practicum_content.py), поэтому флаг ``auto_verified_solvable`` честный: «проверено автотестом
решаемости», а не рецензией методиста.
"""
from __future__ import annotations

import hashlib
import random
from functools import lru_cache
from typing import Any

from app import curriculum_registry as reg
from app.practicum_boards import board, cls_stage
from app.practicum_content import P, err, intro, q_match, q_single, summary, warm
from app.topic_terms import terms

GENERATED_PREFIX = "pg-"


def _rng(seed: str) -> random.Random:
    return random.Random(int.from_bytes(hashlib.sha256(seed.encode()).digest()[:8], "big"))


def _shuffled(items: list[Any], seed: str) -> list[Any]:
    out = list(items)
    _rng(seed).shuffle(out)
    return out


def topic_terms(t: reg.Topic) -> tuple[str, ...]:
    return terms().get((t.subject, t.grade, t.title), ())


def _neighbours(t: reg.Topic) -> list[reg.Topic]:
    """Две соседние темы того же предмета и класса (в порядке программы), у которых есть свои понятия."""
    same = [x for x in reg.topics_for(t.subject, t.grade) if x.topic_id != t.topic_id and topic_terms(x)]
    own = reg.topics_for(t.subject, t.grade)
    idx = next(i for i, x in enumerate(own) if x.topic_id == t.topic_id)
    same.sort(key=lambda x: (abs(own.index(x) - idx), own.index(x)))
    return same[:2]


def _skill(t: reg.Topic, n: int) -> int:
    return min(n, len(t.skills) - 1)


def _why(term: str, owner: reg.Topic) -> str:
    return f"«{term}» — понятие темы «{owner.title}»"


@lru_cache(maxsize=None)
def generated_practicum(topic_id: str) -> dict[str, Any] | None:
    t = reg.topic(topic_id)
    if t is None:
        return None
    own = list(topic_terms(t))
    nb = _neighbours(t)
    if len(own) < 4 or len(nb) < 2:
        return None
    n1, n2 = nb
    a, b = list(topic_terms(n1)), list(topic_terms(n2))
    taken = {x.casefold() for x in own}
    a = [x for x in a if x.casefold() not in taken][:4]
    b = [x for x in b if x.casefold() not in taken and x not in a][:4]
    if len(a) < 4 or len(b) < 4:
        return None
    buckets3 = [("t0", t.title), ("n1", n1.title), ("n2", n2.title)]
    seed = t.topic_id

    def cards(raw: list[tuple[str, str, reg.Topic]], salt: str) -> list[tuple[str, str, str]]:
        return _shuffled([(term, bid, _why(term, owner)) for term, bid, owner in raw], seed + salt)

    explore_board = board(buckets3[:2], cards([(own[0], "t0", t), (own[1], "t0", t), (a[0], "n1", n1), (a[1], "n1", n1)], "e"), "e")
    act_board = board(buckets3, cards([(own[1], "t0", t), (own[2], "t0", t), (a[1], "n1", n1), (a[2], "n1", n1),
                                       (b[0], "n2", n2), (b[1], "n2", n2)], "a"), "a")
    hint_board = board([buckets3[0], buckets3[2]], cards([(own[3], "t0", t), (own[0], "t0", t), (b[2], "n2", n2), (b[3], "n2", n2)], "h"), "h")
    final_board = board(buckets3, cards([*[(x, "t0", t) for x in own], (a[0], "n1", n1), (a[3], "n1", n1),
                                         (b[1], "n2", n2), (b[3], "n2", n2)], "f"), "f")
    hints = [f"Вспомни, где в учебнике вводится понятие: в теме «{t.title}» или в соседней.",
             f"Понятия темы «{t.title}»: {', '.join(own[:2])}…",
             "Сначала разложи карточки, в которых уверен, — оставшиеся разложатся методом исключения."]
    w_opts = _shuffled([own[0], a[0], b[0], a[1]], seed + "w")
    e_opts = [f"«{a[0]}» — понятие темы «{n1.title}», а не «{t.title}»",
              f"Ошибки нет: «{a[0]}» — понятие темы «{t.title}»",
              f"«{a[0]}» не относится ни к одной теме курса",
              f"«{a[0]}» — понятие другого предмета"]
    odd = _shuffled([own[0], own[1], own[2], b[2]], seed + "o")
    multi_opts = _shuffled([own[1], own[2], own[3], a[3], b[0]], seed + "m")
    quiz = [
        q_single(f"Какое понятие лишнее для темы «{t.title}»?", odd, odd.index(b[2]),
                 f"«{b[2]}» — понятие темы «{n2.title}». Остальные относятся к теме «{t.title}».", _skill(t, 0)),
        {"kind": "multi_choice", "text": f"Отметь все понятия темы «{t.title}»", "options": multi_opts,
         "correct": sorted(multi_opts.index(x) for x in (own[1], own[2], own[3])),
         "explain": f"К теме «{t.title}» относятся: {', '.join(own[1:])}. «{a[3]}» — из темы «{n1.title}», «{b[0]}» — из темы «{n2.title}».",
         "skill": _skill(t, 1)},
        q_match("Соотнеси понятие и тему", [(own[3], t.title), (a[2], n1.title), (b[1], n2.title)],
                f"{_why(own[3], t)}; {_why(a[2], n1)}; {_why(b[1], n2)}.", _skill(t, 2)),
    ]
    own_list = reg.topics_for(t.subject, t.grade)
    idx = next(i for i, x in enumerate(own_list) if x.topic_id == t.topic_id)
    nxt = own_list[idx + 1].title if idx + 1 < len(own_list) else None
    stages = [
        intro(f"Тема «{t.title}» держится на понятиях: {', '.join(own)}. В практикуме ты учишься узнавать их "
              f"среди понятий соседних тем — «{n1.title}» и «{n2.title}».",
              "Когда понятия разложены по темам, быстрее находишь нужный параграф и правило для домашнего задания.",
              "Проверочные работы (ВПР, ОГЭ, ЕГЭ) начинаются с узнавания терминов темы."),
        warm(f"Какое понятие относится к теме «{t.title}»?", w_opts, w_opts.index(own[0]),
             f"«{own[0]}» — понятие темы «{t.title}». Остальные — из соседних тем.", _skill(t, 0)),
        cls_stage("exploration", f"Разложи понятия: тема «{t.title}» или тема «{n1.title}».", explore_board, _skill(t, 0)),
        cls_stage("action_check", "Разложи понятия по трём темам.", act_board, _skill(t, 1), hints),
        cls_stage("progressive_hints", f"Отдели понятия темы «{t.title}» от понятий темы «{n2.title}».", hint_board,
                  _skill(t, 1), hints),
        err(f"Ученик отнёс понятие «{a[0]}» к теме «{t.title}».", "Где ошибка?", e_opts, 0,
            f"Понятие «{a[0]}» вводится в теме «{n1.title}». Перед ответом сверяйся с параграфом, где понятие встречается впервые.",
            _skill(t, 2)),
        cls_stage("final_challenge", "Разложи восемь понятий по темам без подсказок.", final_board, _skill(t, 2)),
        summary([f"Понятия темы «{t.title}»: {', '.join(own)}", f"Отличать их от тем «{n1.title}» и «{n2.title}»"],
                f"Дальше — тема «{nxt}»." if nxt else "Закрепи тему квизом в Практике."),
    ]
    p = P(GENERATED_PREFIX + t.topic_id, t.topic_id, f"Карта понятий: {t.title}",
          f"Узнавать ключевые понятия темы «{t.title}» и отличать их от понятий соседних тем",
          "Раскладываешь понятия по темам; после проверки каждая карточка показывает, к какой теме она относится",
          "basic", 8, "Закрепление", "concept_classifier", "classify", stages, quiz)
    p["generated"] = True
    return p


def generated_for(covered: set[str]) -> list[dict[str, Any]]:
    """Практикумы для тем, у которых нет ручного практикума."""
    out = []
    for t in reg.all_topics():
        if t.topic_id in covered:
            continue
        p = generated_practicum(t.topic_id)
        if p is not None:
            out.append(p)
    return out


def topic_quiz(t: reg.Topic) -> list[dict[str, Any]]:
    """Вопросы по понятиям темы для квиза — для любой из 283 тем, даже если у неё есть ручной практикум."""
    p = generated_practicum(t.topic_id)
    if p is None:
        return []
    out = [{**q, "source": p["practicum_id"]} for q in p["quiz"]]
    for st in p["stages"]:
        if st["kind"] in ("warmup", "error_explanation"):
            q = st["question"]
            out.append({"kind": "single_choice", "text": q["text"] if st["kind"] == "warmup" else f"{st['case']} {q['text']}",
                        "options": q["options"], "correct": q["correct"], "explain": q["explain"], "skill": st["skill"],
                        "source": p["practicum_id"]})
    return out
