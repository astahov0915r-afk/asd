"""Подбор товаров через Maxford LLM по запросу пользователя."""

from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Any, Dict, List, Optional, Sequence, Set

from _maxford_llm import MaxfordLLM, MaxfordLLMAPIError, MaxfordLLMError

MXFD_LLM_ADDRESS = os.environ.get("MXFD_LLM_ADDRESS", "http://109.73.196.117:5000").rstrip("/")
MXFD_LLM_TOKEN = os.environ.get("MXFD_LLM_TOKEN", "id_001_x9f87g2h")

PRICE_SEGMENTS = ("бюджет", "эконом", "средний", "продвинутый", "премиум")

PRESET_CATEGORIES = (
    "Ноутбуки",
    "Смартфоны",
    "Планшеты",
    "Телевизоры",
    "Акустика",
    "Аудио",
    "ПК",
)

SYSTEM_PROMPT = """Ты — эксперт по подбору электроники в магазине Elequearo.
По запросу пользователя выбери РОВНО 5 товаров из переданного каталога (JSON).
Каждый товар — из другого ценового сегмента: бюджет, эконом, средний, продвинутый, премиум.
Учитывай рейтинг (rating) и число отзывов (review_count): при прочих равных выбирай выше.
Отвечай ТОЛЬКО валидным JSON без markdown:
{
  "analysis": "2-4 предложения: что понял из запроса и логика подбора",
  "picks": [
    {"id": <число id из каталога>, "segment": "бюджет|эконом|средний|продвинутый|премиум", "reason": "одно предложение"}
  ]
}
В picks должно быть ровно 5 элементов с разными segment. id только из каталога.
Если запрос про компьютер, ПК, ноутбук или десктоп — НЕ выбирай смартфоны и планшеты.
Категория каждого товара в каталоге указана в поле category — соблюдай её."""

SYSTEM_PROMPT_ALL_SEGMENTS = SYSTEM_PROMPT

SYSTEM_PROMPT_ONE_SEGMENT = """Ты — эксперт по подбору электроники в магазине Elequearo.
Выбери РОВНО 5 лучших товаров из каталога (JSON) для запроса пользователя.
Все 5 товаров должны быть в ОДНОМ ценовом сегменте, указанном в запросе (поле price_segment в каталоге).
Учитывай rating и review_count. Отвечай ТОЛЬКО JSON:
{"analysis": "...", "picks": [{"id": <id>, "segment": "<сегмент>", "reason": "..."}]}
В picks — 5 разных id, одинаковый segment. id только из каталога."""

SYSTEM_PROMPT_MULTI_SEGMENT = """Ты — эксперт по подбору электроники в магазине Elequearo.
Выбери по одному лучшему товару для КАЖДОГО указанного ценового сегмента (не больше 5 всего).
Сегмент бери из price_segment в каталоге. Учитывай rating и review_count. Только JSON:
{"analysis": "...", "picks": [{"id": <id>, "segment": "<сегмент>", "reason": "..."}]}
id только из каталога, segment должен совпадать с price_segment товара."""

_SEGMENT_QUERY_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"бюджет", re.I), "бюджет"),
    (re.compile(r"дешёв|дешев|недорог|доступн", re.I), "бюджет"),
    (re.compile(r"\bэконом", re.I), "эконом"),
    (re.compile(r"средн\w*\s+(?:цен|сегмент|класс)|\bсредний\b", re.I), "средний"),
    (re.compile(r"продвинут", re.I), "продвинутый"),
    (re.compile(r"премиум|флагман|топов|элитн", re.I), "премиум"),
)


def synthetic_review_stats(name: str, brand: str, price: float) -> tuple[float, int]:
    key = f"{name}|{brand}|{price}".encode("utf-8")
    h = int(hashlib.md5(key).hexdigest(), 16)
    rating = round(3.8 + (h % 12) * 0.1, 1)
    reviews = 80 + (h % 4900) + int(price // 1000) * 3
    return rating, reviews


def enrich_product(row: Dict[str, Any]) -> Dict[str, Any]:
    rating = row.get("rating")
    review_count = row.get("review_count")
    try:
        rating_f = float(rating) if rating not in (None, "") else 0.0
    except (TypeError, ValueError):
        rating_f = 0.0
    try:
        reviews_i = int(float(review_count)) if review_count not in (None, "") else 0
    except (TypeError, ValueError):
        reviews_i = 0
    if rating_f <= 0 or reviews_i <= 0:
        rating_f, reviews_i = synthetic_review_stats(
            str(row.get("name", "")),
            str(row.get("brand", "")),
            float(row.get("price") or 0),
        )
    out = dict(row)
    out["rating"] = rating_f
    out["review_count"] = reviews_i
    return out


_CATEGORY_ALIASES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"ноутбук|laptop|ультрабук|нэтбук|chromebook|макбук|macbook", re.I), "Ноутбуки"),
    (re.compile(r"смартфон|телефон|iphone|айфон|мобильник|мобил[аы]", re.I), "Смартфоны"),
    (re.compile(r"планшет|\bipad\b", re.I), "Планшеты"),
    (re.compile(r"\bтелевизор|\bsmart[\s-]*tv\b|(^|\s)тв(\s|$)", re.I), "Телевизоры"),
    (re.compile(r"наушник|гарнитур|earbuds?|tws|airpods", re.I), "Аудио"),
    (re.compile(r"акустик|колонк|саундбар|сабвуфер", re.I), "Акустика"),
)

_COMPUTER_QUERY_RE = re.compile(
    r"компьютер|компьютерн|компа\b|системник|системный\s+блок|"
    r"десктоп|desktop|моноблок|неттоп|рабочая\s+станция|workstation|"
    r"игровой\s+пк|сборк[аи]\s+пк|(?<![а-яё])пк(?![а-яё])|(?<![a-z])pc(?![a-z])",
    re.I,
)

_PC_PERIPHERAL_RE = re.compile(
    r"монитор|клавиатур|мыш[ьи]|видеокарт|процессор|материнск|ssd|накопител|"
    r"оперативн|озу|корпус|блок\s+питания|системный\s+блок",
    re.I,
)


def _category_in_query(t: str, cat: str) -> bool:
    """Совпадение категории по слову, без ложного «пк» внутри «компьютер»."""
    lc = str(cat).lower()
    if lc == "пк":
        return bool(re.search(r"(?<![а-яёa-z])пк(?![а-яёa-z])", t)) or bool(
            re.search(r"(?<![a-z])pc(?![a-z])", t)
        )
    return lc in t


def resolve_allowed_categories(text: str, categories: Sequence[str]) -> Optional[Set[str]]:
    """Набор допустимых категорий для запроса; None — без ограничения."""
    t = text.lower().strip()
    available = {str(c) for c in categories if c}

    explicit: Set[str] = set()
    for cat in sorted(available, key=len, reverse=True):
        if _category_in_query(t, cat):
            explicit.add(cat)

    wants_phone = bool(re.search(r"смартфон|телефон|iphone|айфон|мобильн", t, re.I))
    wants_tablet = bool(re.search(r"планшет|\bipad\b", t, re.I))
    wants_laptop = bool(re.search(r"ноутбук|laptop|ультрабук|macbook|макбук", t, re.I))
    wants_computer = bool(_COMPUTER_QUERY_RE.search(t)) or bool(_PC_PERIPHERAL_RE.search(t))

    for pattern, cat in _CATEGORY_ALIASES:
        if cat in available and pattern.search(t):
            explicit.add(cat)

    if explicit:
        if wants_computer and not wants_phone and not wants_tablet:
            explicit -= {"Смартфоны", "Планшеты"}
            explicit |= {c for c in ("Ноутбуки", "ПК") if c in available}
        return explicit

    if wants_laptop and not wants_phone and not wants_tablet:
        return {"Ноутбуки"} & available if "Ноутбуки" in available else None

    if wants_computer and not wants_phone and not wants_tablet:
        computer_cats = {c for c in ("Ноутбуки", "ПК") if c in available}
        return computer_cats or None

    if wants_phone and not wants_computer:
        return ({"Смартфоны"} & available) or None

    if wants_tablet and not wants_computer:
        return ({"Планшеты"} & available) or None

    return None


def category_filter_hint(allowed: Optional[Set[str]]) -> str:
    if not allowed:
        return ""
    names = ", ".join(sorted(allowed))
    return f"\nДопустимые категории (строго): {names}. Не предлагай товары из других категорий."


def compact_catalog_item(item: Dict[str, Any]) -> Dict[str, Any]:
    row = {
        "id": item["id"],
        "name": item["name"],
        "category": item["category"],
        "brand": item["brand"],
        "price": item["price"],
        "rating": item.get("rating"),
        "review_count": item.get("review_count"),
        "ram": item.get("ram"),
        "storage": item.get("storage"),
        "cpu": item.get("cpu"),
        "screen": item.get("screen"),
        "description": (item.get("description") or "")[:120],
    }
    if item.get("price_segment"):
        row["price_segment"] = item["price_segment"]
    return row


def normalize_segments_input(segments: Optional[Sequence[str]]) -> Optional[Set[str]]:
    if not segments:
        return None
    picked = {str(s).strip().lower() for s in segments if str(s).strip()}
    valid = picked & set(PRICE_SEGMENTS)
    return valid or None


def parse_segments_from_query(text: str) -> Set[str]:
    found: Set[str] = set()
    for pattern, seg in _SEGMENT_QUERY_PATTERNS:
        if pattern.search(text):
            found.add(seg)
    return found


def merge_segment_filters(
    query: str,
    segments: Optional[Sequence[str]],
) -> Optional[Set[str]]:
    """Сегменты с плашки UI имеют приоритет; иначе — из текста запроса."""
    from_ui = normalize_segments_input(segments)
    if from_ui:
        return from_ui
    from_query = parse_segments_from_query(query)
    return from_query if from_query else None


def assign_price_segments(
    pool: List[Dict[str, Any]],
    lock_segments: Optional[Set[str]] = None,
) -> None:
    if not pool:
        return
    if lock_segments and len(lock_segments) == 1:
        seg = next(iter(lock_segments))
        for item in pool:
            item["price_segment"] = seg
        return
    indices = sorted(range(len(pool)), key=lambda i: float(pool[i].get("price") or 0))
    n = len(indices)
    for rank, idx in enumerate(indices):
        seg_idx = min(4, (rank * 5) // n) if n > 1 else 0
        pool[idx]["price_segment"] = PRICE_SEGMENTS[seg_idx]
    if lock_segments:
        for item in pool:
            if item.get("price_segment") not in lock_segments:
                item["price_segment"] = min(
                    lock_segments,
                    key=lambda s: PRICE_SEGMENTS.index(s),
                )


def _pool_for_segment_ranks(
    pool: List[Dict[str, Any]],
    target_segments: Set[str],
) -> List[Dict[str, Any]]:
    """Берём товары по ценовым квантилям внутри уже отфильтрованного списка."""
    n = len(pool)
    if n == 0:
        return []
    order = sorted(range(n), key=lambda i: float(pool[i].get("price") or 0))
    rank_of = {order[r]: r for r in range(n)}
    wanted_ranks: Set[int] = set()
    seg_count = len(PRICE_SEGMENTS)
    for seg in target_segments:
        if seg not in PRICE_SEGMENTS:
            continue
        qi = PRICE_SEGMENTS.index(seg)
        start = (qi * n) // seg_count
        end = max(((qi + 1) * n) // seg_count, start + 1)
        for r in range(start, min(end, n)):
            wanted_ranks.add(r)
    out: List[Dict[str, Any]] = []
    for i in range(n):
        rank = rank_of.get(i, -1)
        if rank not in wanted_ranks:
            continue
        row = dict(pool[i])
        qi = min(seg_count - 1, (rank * seg_count) // n) if n > 1 else 0
        row["price_segment"] = PRICE_SEGMENTS[qi]
        out.append(row)
    return out


def filter_pool_by_segments(
    pool: List[Dict[str, Any]],
    target_segments: Optional[Set[str]],
) -> List[Dict[str, Any]]:
    if not pool:
        return pool
    assign_price_segments(pool)
    if not target_segments:
        return pool
    filtered = [dict(p) for p in pool if p.get("price_segment") in target_segments]
    if not filtered:
        filtered = _pool_for_segment_ranks(pool, target_segments)
    if target_segments and len(target_segments) == 1:
        seg = next(iter(target_segments))
        for row in filtered:
            row["price_segment"] = seg
    return filtered


def segment_filter_hint(target_segments: Optional[Set[str]]) -> str:
    if not target_segments:
        return ""
    names = ", ".join(sorted(target_segments))
    return f"\nЦеновые сегменты (только они): {names}. Поле price_segment в каталоге."


def pick_system_prompt(target_segments: Optional[Set[str]]) -> str:
    if not target_segments:
        return SYSTEM_PROMPT_ALL_SEGMENTS
    if len(target_segments) == 1:
        return SYSTEM_PROMPT_ONE_SEGMENT
    if len(target_segments) < len(PRICE_SEGMENTS):
        return SYSTEM_PROMPT_MULTI_SEGMENT
    return SYSTEM_PROMPT_ALL_SEGMENTS


def pick_count_target(target_segments: Optional[Set[str]]) -> int:
    if not target_segments:
        return 5
    if len(target_segments) == 1:
        return 5
    return min(5, len(target_segments))


def prefilter_catalog(
    products: List[Dict[str, Any]],
    query: str,
    limit: int = 55,
) -> tuple[List[Dict[str, Any]], Optional[Set[str]]]:
    enriched = [enrich_product(p) for p in products]
    categories = sorted({str(p["category"]) for p in enriched if p.get("category")})
    allowed = resolve_allowed_categories(query, categories)
    if allowed:
        pool = [p for p in enriched if p.get("category") in allowed]
    else:
        pool = list(enriched)
    pool.sort(key=lambda p: (-float(p.get("rating") or 0), -int(p.get("review_count") or 0)))
    if len(pool) > limit:
        step = max(1, len(pool) // limit)
        pool = pool[::step][:limit]
    return pool, allowed


def _filter_picks_by_category(
    picks: List[Dict[str, Any]],
    catalog: List[Dict[str, Any]],
    allowed: Optional[Set[str]],
) -> List[Dict[str, Any]]:
    if not allowed:
        return picks
    by_id = {int(p["id"]): p for p in catalog}
    filtered = []
    for pick in picks:
        pid = int(pick["id"])
        item = by_id.get(pid)
        if item and item.get("category") in allowed:
            filtered.append(pick)
    return filtered


def _top_by_rating(items: List[Dict[str, Any]], limit: int) -> List[Dict[str, Any]]:
    return sorted(
        items,
        key=lambda p: (-float(p.get("rating") or 0), -int(p.get("review_count") or 0)),
    )[:limit]


def _fallback_picks(
    products: List[Dict[str, Any]],
    target_segments: Optional[Set[str]] = None,
) -> Dict[str, Any]:
    if not products:
        return {"analysis": "Каталог пуст — добавьте товары через импорт.", "picks": []}

    pool = [dict(p) for p in products]
    assign_price_segments(pool)
    picks: List[Dict[str, Any]] = []

    if target_segments and len(target_segments) == 1:
        seg = next(iter(target_segments))
        in_seg = [p for p in pool if p.get("price_segment") == seg]
        for item in _top_by_rating(in_seg or pool, 5):
            picks.append(
                {
                    "id": item["id"],
                    "segment": seg,
                    "reason": f"Лучший в сегменте «{seg}» по рейтингу {item.get('rating')}.",
                }
            )
        return {
            "analysis": f"LLM недоступен — топ‑5 в сегменте «{seg}» по рейтингу и отзывам.",
            "picks": picks,
        }

    if target_segments and len(target_segments) < len(PRICE_SEGMENTS):
        for seg in PRICE_SEGMENTS:
            if seg not in target_segments:
                continue
            in_seg = [p for p in pool if p.get("price_segment") == seg]
            if not in_seg:
                continue
            item = _top_by_rating(in_seg, 1)[0]
            picks.append(
                {
                    "id": item["id"],
                    "segment": seg,
                    "reason": f"Лучший в сегменте «{seg}».",
                }
            )
        return {
            "analysis": "LLM недоступен — лучшие позиции по выбранным сегментам.",
            "picks": picks[:5],
        }

    sorted_items = sorted(pool, key=lambda p: float(p.get("price") or 0))
    n = len(sorted_items)
    indices = [0, n // 4, n // 2, (3 * n) // 4, n - 1] if n >= 5 else list(range(n))
    for i, idx in enumerate(indices[:5]):
        item = sorted_items[min(idx, n - 1)]
        seg = item.get("price_segment") or PRICE_SEGMENTS[min(i, len(PRICE_SEGMENTS) - 1)]
        picks.append(
            {
                "id": item["id"],
                "segment": seg,
                "reason": f"Подбор по цене и рейтингу {item.get('rating')} ({item.get('review_count')} отзывов).",
            }
        )
    return {
        "analysis": "LLM недоступен — 5 позиций по ценовым сегментам (рейтинг и отзывы).",
        "picks": picks,
    }


def _normalize_llm_picks(
    data: Dict[str, Any],
    catalog: List[Dict[str, Any]],
    target_segments: Optional[Set[str]] = None,
    max_items: int = 5,
) -> Dict[str, Any]:
    by_id = {int(p["id"]): p for p in catalog}
    raw_picks = data.get("picks")
    if not isinstance(raw_picks, list):
        raw_picks = []
    picks: List[Dict[str, Any]] = []
    used_segments: Set[str] = set()
    used_ids: Set[int] = set()
    single_segment = target_segments and len(target_segments) == 1

    for entry in raw_picks:
        if not isinstance(entry, dict) or len(picks) >= max_items:
            break
        try:
            pid = int(entry.get("id"))
        except (TypeError, ValueError):
            continue
        if pid not in by_id or pid in used_ids:
            continue
        item = by_id[pid]
        segment = str(item.get("price_segment") or "").strip().lower()
        if segment not in PRICE_SEGMENTS:
            segment = str(entry.get("segment") or PRICE_SEGMENTS[0]).strip().lower()
        if target_segments:
            if segment not in target_segments:
                continue
            if single_segment:
                segment = next(iter(target_segments))  # type: ignore[arg-type]
            elif segment in used_segments:
                continue
        elif segment in used_segments:
            continue
        used_segments.add(segment)
        used_ids.add(pid)
        picks.append(
            {
                "id": pid,
                "segment": segment,
                "reason": str(entry.get("reason") or "").strip()[:300],
            }
        )

    analysis = str(data.get("analysis") or "").strip()
    return {"analysis": analysis, "picks": picks}


def _fill_missing_segments(
    picks: List[Dict[str, Any]],
    catalog: List[Dict[str, Any]],
    target_segments: Optional[Set[str]] = None,
    max_items: int = 5,
) -> List[Dict[str, Any]]:
    if len(picks) >= max_items:
        return picks[:max_items]

    pool = [dict(p) for p in catalog]
    assign_price_segments(pool, lock_segments=target_segments)
    used_ids = {int(p["id"]) for p in picks}

    if target_segments and len(target_segments) == 1:
        seg = next(iter(target_segments))
        candidates = [p for p in pool if p.get("price_segment") == seg and int(p["id"]) not in used_ids]
        for item in _top_by_rating(candidates, max_items - len(picks)):
            picks.append(
                {
                    "id": int(item["id"]),
                    "segment": seg,
                    "reason": "Дополнено по рейтингу в выбранном сегменте.",
                }
            )
            used_ids.add(int(item["id"]))
        return picks[:max_items]

    if target_segments:
        segments_to_fill = [s for s in PRICE_SEGMENTS if s in target_segments]
    else:
        segments_to_fill = list(PRICE_SEGMENTS)
    used_segment_names = {p["segment"] for p in picks}

    for seg in segments_to_fill:
        if len(picks) >= max_items:
            break
        if seg in used_segment_names:
            continue
        in_seg = [
            p
            for p in pool
            if p.get("price_segment") == seg and int(p["id"]) not in used_ids
        ]
        if not in_seg:
            continue
        item = _top_by_rating(in_seg, 1)[0]
        picks.append(
            {
                "id": int(item["id"]),
                "segment": seg,
                "reason": "Дополнено автоматически по ценовому сегменту.",
            }
        )
        used_ids.add(int(item["id"]))
        used_segment_names.add(seg)

    return picks[:max_items]


def _strict_filter_picks(
    picks: List[Dict[str, Any]],
    catalog: List[Dict[str, Any]],
    target_segments: Optional[Set[str]],
    max_items: int,
) -> List[Dict[str, Any]]:
    if not target_segments:
        return picks[:max_items]
    cat_copy = [dict(p) for p in catalog]
    assign_price_segments(cat_copy, lock_segments=target_segments)
    by_id = {int(p["id"]): p for p in cat_copy}
    out: List[Dict[str, Any]] = []
    for pick in picks:
        pid = int(pick["id"])
        item = by_id.get(pid)
        if not item:
            continue
        seg = str(item.get("price_segment") or "").strip().lower()
        if seg not in target_segments:
            continue
        out.append({**pick, "segment": seg})
        if len(out) >= max_items:
            break
    return out


def pick_products(
    query: str,
    products: List[Dict[str, Any]],
    segments: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    q = (query or "").strip()
    if not q:
        return {"ok": False, "error": "Пустой запрос", "analysis": "", "items": []}
    if not products:
        return {"ok": False, "error": "Каталог пуст", "analysis": "", "items": []}

    target_segments = merge_segment_filters(q, segments)
    max_items = pick_count_target(target_segments)

    catalog, allowed = prefilter_catalog(products, q)
    if not catalog:
        return {
            "ok": False,
            "error": "В каталоге нет товаров по этому запросу",
            "analysis": "",
            "items": [],
        }
    catalog = filter_pool_by_segments(catalog, target_segments)
    compact = [compact_catalog_item(p) for p in catalog]

    llm_data: Dict[str, Any]
    try:
        llm = MaxfordLLM(
            base_url=MXFD_LLM_ADDRESS,
            token=MXFD_LLM_TOKEN,
            system_prompt=pick_system_prompt(target_segments),
            temperature=0.15,
            model="Lite",
            max_tokens=1200,
        )
        seg_line = ""
        if target_segments and len(target_segments) == 1:
            seg_line = f"\nСегмент: {next(iter(target_segments))}. Нужно 5 товаров только этого сегмента."
        user_prompt = (
            f"Запрос пользователя: {q}"
            f"{category_filter_hint(allowed)}"
            f"{segment_filter_hint(target_segments)}"
            f"{seg_line}\n\n"
            f"Каталог ({len(compact)} позиций):\n"
            f"{json.dumps(compact, ensure_ascii=False)}"
        )
        raw = llm.chat(user_prompt)
        llm_data = MaxfordLLM.parse_json_dict(raw)
    except (MaxfordLLMError, ValueError) as exc:
        llm_data = _fallback_picks(catalog, target_segments)
        llm_data["_llm_warning"] = str(exc)

    normalized = _normalize_llm_picks(llm_data, catalog, target_segments, max_items)
    picks = _filter_picks_by_category(normalized["picks"], catalog, allowed)
    picks = _fill_missing_segments(picks, catalog, target_segments, max_items)
    picks = _filter_picks_by_category(picks, catalog, allowed)
    picks = _strict_filter_picks(picks, catalog, target_segments, max_items)
    if target_segments and len(picks) < max_items:
        picks = _fill_missing_segments(picks, catalog, target_segments, max_items)
        picks = _strict_filter_picks(picks, catalog, target_segments, max_items)

    by_id = {int(p["id"]): enrich_product(p) for p in products}
    catalog_by_id = {int(p["id"]): p for p in catalog}

    items = []
    for pick in picks[:max_items]:
        pid = int(pick["id"])
        product = by_id.get(pid)
        if not product:
            continue
        cat_row = catalog_by_id.get(pid)
        seg = str((cat_row or {}).get("price_segment") or pick.get("segment") or "").strip().lower()
        if target_segments and seg not in target_segments:
            continue
        items.append(
            {
                **product,
                "segment": seg,
                "reason": pick.get("reason", ""),
            }
        )

    result: Dict[str, Any] = {
        "ok": True,
        "analysis": normalized.get("analysis") or llm_data.get("analysis", ""),
        "items": items,
        "query": q,
        "segments_applied": sorted(target_segments) if target_segments else [],
        "segments": sorted(target_segments) if target_segments else list(PRICE_SEGMENTS),
    }
    if llm_data.get("_llm_warning"):
        result["warning"] = llm_data["_llm_warning"]
    return result
