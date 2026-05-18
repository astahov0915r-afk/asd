const STORAGE_KEY = "tech_picker_db_v1";
const API_PRODUCTS_URL = "/api/products";
const API_PICK_URL = "/api/pick";

const PRESET_CATEGORIES = [
  "Ноутбуки",
  "Смартфоны",
  "Планшеты",
  "Телевизоры",
  "Акустика",
  "Аудио",
  "ПК"
];

const POPULAR_QUERIES = [
  "Игровой ноутбук с RTX до 120 000 ₽",
  "Смартфон с хорошей камерой до 50 000 ₽",
  "OLED телевизор 55 дюймов до 100 000 ₽",
  "Наушники с шумоподавлением",
  "Ноутбук для учёбы 16 ГБ ОЗУ до 80 000 ₽",
  "Планшет для рисования",
  "Саундбар для домашнего кино",
  "Ультрабук лёгкий до 100 000 ₽"
];

const PRICE_SEGMENTS = ["бюджет", "эконом", "средний", "продвинутый", "премиум"];

const SEGMENT_LABELS = {
  бюджет: "Бюджет",
  эконом: "Эконом",
  средний: "Средний",
  продвинутый: "Продвинутый",
  премиум: "Премиум"
};

let selectedSegments = new Set();

const AUDIO_FEATURE_LABELS = [
  { id: "ANC", label: "ANC", re: /\banc\b|шумоподавлен/i },
  { id: "Bluetooth", label: "Bluetooth", re: /bluetooth|блютуз|\bbt\s*5[\d.]?/i },
  { id: "LDAC", label: "LDAC", re: /\bldac\b/i },
  { id: "Atmos", label: "Dolby Atmos", re: /\batmos\b|dolby\s*atmos/i },
  { id: "IPX", label: "Влагозащита IPX", re: /\bipx\d?\b|\bip54\b|\bip55\b/i },
  { id: "eARC", label: "HDMI eARC", re: /\bearc\b/i }
];

let db = [];
let activeCategoryChip = "";
let pickInFlight = false;

const elements = {
  queryInput: document.getElementById("queryInput"),
  pickBtn: document.getElementById("pickBtn"),
  analysisBox: document.getElementById("analysisBox"),
  categoryChips: document.getElementById("categoryChips"),
  popularQueries: document.getElementById("popularQueries"),
  segmentFilters: document.getElementById("segmentFilters"),
  cardsContainer: document.getElementById("cardsContainer"),
  cardTemplate: document.getElementById("cardTemplate"),
  resultCount: document.getElementById("resultCount"),
  exportJsonBtn: document.getElementById("exportJsonBtn"),
  voiceQueryBtn: document.getElementById("voiceQueryBtn"),
  voiceStatus: document.getElementById("voiceStatus")
};

let voiceRecognition = null;
let voiceListening = false;
let voicePrefix = "";
let voiceBuffer = "";

function loadDbFromLocal() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveDbToLocal(data) {
  db = data;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

async function loadDbFromServer() {
  const response = await fetch(API_PRODUCTS_URL);
  if (!response.ok) throw new Error(`Server load error: ${response.status}`);
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

async function saveDbToServer(data) {
  const response = await fetch(API_PRODUCTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ products: data })
  });
  if (!response.ok) throw new Error(`Server save error: ${response.status}`);
}

function uniqueSortedValues(field) {
  return [...new Set(db.map(item => item[field]).filter(Boolean))].sort((a, b) =>
    String(a).localeCompare(String(b), "ru")
  );
}

function allCategoriesMerged() {
  return [...new Set([...PRESET_CATEGORIES, ...uniqueSortedValues("category")])].sort((a, b) =>
    String(a).localeCompare(String(b), "ru")
  );
}

function chipHint(category) {
  const hints = {
    Смартфоны: "Телефоны",
    Ноутбуки: "Работа и игры",
    Планшеты: "Планшеты",
    Телевизоры: "Smart TV, OLED",
    Акустика: "Колонки, саундбары",
    Аудио: "Наушники",
    ПК: "Мониторы, периферия"
  };
  return hints[category] || "Подбор по категории";
}

function renderCategoryChips() {
  const categories = allCategoriesMerged();
  elements.categoryChips.innerHTML = "";
  categories.forEach(category => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.dataset.category = category;
    button.innerHTML = `<strong>${category}</strong><small>${chipHint(category)}</small>`;
    if (category === activeCategoryChip) button.classList.add("active");
    elements.categoryChips.appendChild(button);
  });
}

function getSelectedSegments() {
  return [...selectedSegments];
}

function renderSegmentFilters() {
  if (!elements.segmentFilters) return;
  elements.segmentFilters.innerHTML = "";

  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = "segment-chip" + (selectedSegments.size === 0 ? " active" : "");
  allBtn.dataset.segment = "";
  allBtn.textContent = "Все сегменты";
  allBtn.addEventListener("click", () => {
    selectedSegments.clear();
    renderSegmentFilters();
  });
  elements.segmentFilters.appendChild(allBtn);

  PRICE_SEGMENTS.forEach(seg => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "segment-chip" + (selectedSegments.has(seg) ? " active" : "");
    btn.dataset.segment = seg;
    btn.textContent = SEGMENT_LABELS[seg] || seg;
    btn.addEventListener("click", () => {
      if (selectedSegments.has(seg) && selectedSegments.size === 1) {
        selectedSegments.clear();
      } else {
        selectedSegments.clear();
        selectedSegments.add(seg);
      }
      renderSegmentFilters();
      if (elements.queryInput.value.trim()) runPick();
    });
    elements.segmentFilters.appendChild(btn);
  });
}

function renderPopularQueries() {
  if (!elements.popularQueries) return;
  elements.popularQueries.innerHTML = "";
  POPULAR_QUERIES.forEach(text => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "popular-chip";
    btn.textContent = text;
    btn.addEventListener("click", () => {
      elements.queryInput.value = text;
      runPick();
    });
    elements.popularQueries.appendChild(btn);
  });
}

function syncActiveChip() {
  document.querySelectorAll(".chip").forEach(chip => {
    chip.classList.toggle("active", chip.dataset.category === activeCategoryChip);
  });
}

function formatPrice(value) {
  return new Intl.NumberFormat("ru-RU").format(Number(value)) + " ₽";
}

function formatReviews(item) {
  const rating = Number(item.rating);
  const count = Number(item.review_count);
  if (!Number.isFinite(rating) || rating <= 0) return "";
  const reviews = Number.isFinite(count) && count > 0 ? count : 0;
  return reviews ? `★ ${rating.toFixed(1)} · ${reviews.toLocaleString("ru-RU")} отзывов` : `★ ${rating.toFixed(1)}`;
}

function effectiveRefreshHz(item) {
  const raw = Number(item.refresh_hz);
  if (Number.isFinite(raw) && raw > 0) return Math.round(raw);
  const m = String(item.cpu || "").match(/(\d{2,3})\s*гц/i);
  return m ? Number(m[1]) : 0;
}

function effectiveAudioWatts(item) {
  const w = Number(item.audio_watts);
  if (Number.isFinite(w) && w > 0) return Math.round(w);
  const m = String(item.cpu || "").match(/\b(\d{2,4})\s*(?:Вт|вт)\b/);
  return m ? Number(m[1]) : 0;
}

function itemAudioFeatures(item) {
  const blob = `${item.name} ${item.description} ${item.extras} ${item.cpu}`;
  return AUDIO_FEATURE_LABELS.filter(f => f.re.test(blob)).map(f => f.id);
}

function formatCategorySpecsLine(item) {
  const cat = item.category;
  const ex = String(item.extras ?? "").trim();
  if (cat !== "Телевизоры" && cat !== "Акустика" && cat !== "Аудио" && ex) return ex;
  const cpu = item.cpu || "";
  const ram = Number(item.ram);
  const storage = Number(item.storage);
  const screen = Number(item.screen);
  const desc = String(item.description || "").trim();

  if (cat === "Телевизоры") {
    const bits = [];
    const hz = effectiveRefreshHz(item);
    const panel = String(item.cpu || "").trim();
    if (panel) bits.push(panel.split(",")[0].trim().slice(0, 90));
    if (screen > 0) bits.push(`диагональ ${screen}"`);
    if (hz > 0) bits.push(`${hz} Гц`);
    if (desc) bits.push(desc);
    if (ex) bits.push(ex);
    return bits.join(" · ").slice(0, 320) || "—";
  }
  if (cat === "Акустика") {
    const bits = [];
    const w = effectiveAudioWatts(item);
    if (w > 0) bits.push(`${w} Вт`);
    if (desc) bits.push(desc);
    const feat = itemAudioFeatures(item);
    if (feat.length) bits.push(feat.join(", "));
    if (ex) bits.push(ex);
    return bits.join(" · ").slice(0, 320) || "—";
  }
  if (cat === "Аудио") {
    const bits = [];
    const bat = Number(item.ram);
    if (bat > 0) bits.push(`до ${bat} ч`);
    if (desc) bits.push(desc);
    const feat = itemAudioFeatures(item);
    if (feat.length) bits.push(feat.join(", "));
    if (ex) bits.push(ex);
    return bits.join(" · ").slice(0, 320) || "—";
  }
  const scrPart = screen > 0 ? ` · экран ${screen}"` : "";
  return `CPU: ${cpu || "—"} · ОЗУ ${ram || "—"} ГБ · накопитель ${storage || "—"} ГБ${scrPart}`;
}

function buildShopSearchUrl(site, item) {
  const text = encodeURIComponent(`${item.name} ${item.brand}`.trim());
  const urls = {
    citilink: `https://www.citilink.ru/search/?text=${text}`,
    dns: `https://www.dns-shop.ru/search/?q=${text}`,
    wildberries: `https://www.wildberries.ru/catalog/0/search.aspx?search=${text}`,
    ozon: `https://www.ozon.ru/search/?text=${text}`
  };
  return urls[site] || "#";
}

function segmentLabel(segment) {
  const key = String(segment || "").toLowerCase();
  return SEGMENT_LABELS[key] || segment || "Сегмент";
}

function resultCountLabel(count, maxExpected) {
  const seg = getSelectedSegments();
  if (seg.length === 1) return `${count} товаров · сегмент «${SEGMENT_LABELS[seg[0]] || seg[0]}»`;
  if (seg.length > 1) return `${count} товаров · ${seg.map(s => SEGMENT_LABELS[s] || s).join(", ")}`;
  return `${count} из ${maxExpected || 5}`;
}

function renderCards(items, maxExpected = 5) {
  elements.cardsContainer.innerHTML = "";
  elements.resultCount.textContent = resultCountLabel(items.length, maxExpected);

  if (!db.length) {
    elements.cardsContainer.innerHTML = "<p>Каталог пуст.</p>";
    return;
  }

  if (!items.length) {
    elements.cardsContainer.innerHTML = "<p>Ничего не подобрано. Уточните запрос.</p>";
    return;
  }

  items.forEach(item => {
    const card = elements.cardTemplate.content.firstElementChild.cloneNode(true);
    card.querySelector(".card-segment").textContent = segmentLabel(item.segment);
    const ratingEl = card.querySelector(".card-rating");
    const ratingText = formatReviews(item);
    ratingEl.textContent = ratingText;
    ratingEl.hidden = !ratingText;
    card.querySelector(".card-title").textContent = item.name;
    card.querySelector(".card-meta").textContent = `${item.category} | ${item.brand}`;
    const reasonEl = card.querySelector(".card-reason");
    if (item.reason) {
      reasonEl.textContent = item.reason;
      reasonEl.hidden = false;
    } else {
      reasonEl.hidden = true;
    }
    card.querySelector(".card-specs").textContent = formatCategorySpecsLine(item);
    card.querySelector(".card-price").textContent = formatPrice(item.price);
    const panel = card.querySelector(".card-shops-panel");
    const toggle = card.querySelector(".card-shops-toggle");
    const sid = `shops-${item.id}-${Math.random().toString(36).slice(2, 8)}`;
    panel.id = sid;
    toggle.setAttribute("aria-controls", sid);
    card.querySelectorAll(".card-shop-link").forEach(a => {
      a.href = buildShopSearchUrl(a.dataset.site, item);
    });
    elements.cardsContainer.appendChild(card);
  });
}

function setAnalysis(text) {
  elements.analysisBox.textContent = text;
}

function setPickLoading(loading) {
  pickInFlight = loading;
  elements.pickBtn.disabled = loading;
  elements.pickBtn.textContent = loading ? "Подбираю…" : "Подобрать";
}

async function runPick() {
  const query = elements.queryInput.value.trim();
  if (!query) {
    setAnalysis("Введите запрос или выберите популярный вариант ниже.");
    renderCards([]);
    return;
  }
  if (pickInFlight) return;

  setPickLoading(true);
  setAnalysis("Maxford LLM анализирует каталог…");
  renderCards([]);

  try {
    const segments = getSelectedSegments();
    const response = await fetch(API_PICK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, segments })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `Ошибка ${response.status}`);
    }
    const applied = Array.isArray(data.segments_applied) ? data.segments_applied : segments;
    const lines = [data.analysis || "Подбор выполнен."];
    if (applied.length) {
      lines.push(
        `\nСегменты: ${applied.map(s => SEGMENT_LABELS[s] || s).join(", ")}`
      );
    }
    if (data.warning) lines.push(`\n⚠ ${data.warning}`);
    setAnalysis(lines.join("\n"));
    const maxExpected = applied.length === 1 ? 5 : applied.length > 1 ? applied.length : 5;
    renderCards(data.items || [], maxExpected);
  } catch (error) {
    console.error(error);
    setAnalysis(
      `Не удалось подобрать: ${error.message || error}. Запустите server.py (http://127.0.0.1:8000) и проверьте доступ к LLM.`
    );
    renderCards([]);
  } finally {
    setPickLoading(false);
  }
}

function exportJson() {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "tech-db.json";
  a.click();
  URL.revokeObjectURL(url);
}

function setVoiceUi(listening, message = "") {
  voiceListening = listening;
  if (elements.voiceQueryBtn) {
    elements.voiceQueryBtn.classList.toggle("listening", listening);
    elements.voiceQueryBtn.setAttribute("aria-pressed", listening ? "true" : "false");
    elements.voiceQueryBtn.textContent = listening ? "Стоп" : "Голосом";
  }
  if (elements.voiceStatus) elements.voiceStatus.textContent = message;
}

function stopVoiceRecognition() {
  if (voiceRecognition && voiceListening) {
    try {
      voiceRecognition.stop();
    } catch {
      /* ignore */
    }
  }
}

function initVoiceRecognition() {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor || !elements.voiceQueryBtn) return;

  voiceRecognition = new Ctor();
  voiceRecognition.lang = "ru-RU";
  voiceRecognition.interimResults = true;
  voiceRecognition.continuous = true;

  voiceRecognition.onresult = event => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const piece = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        voiceBuffer += piece;
        elements.queryInput.value = (voicePrefix + voiceBuffer).replace(/\s+/g, " ").trim();
      } else {
        interim += piece;
      }
    }
    if (interim) {
      elements.queryInput.value = (voicePrefix + voiceBuffer + interim).replace(/\s+/g, " ").trim();
    }
  };

  voiceRecognition.onerror = event => {
    const codes = {
      "not-allowed": "Нет доступа к микрофону",
      "no-speech": "Речь не распознана",
      network: "Сеть недоступна"
    };
    setVoiceUi(false, codes[event.error] || "");
  };

  voiceRecognition.onend = () => {
    voiceListening = false;
    if (elements.voiceQueryBtn) {
      elements.voiceQueryBtn.classList.remove("listening");
      elements.voiceQueryBtn.setAttribute("aria-pressed", "false");
      elements.voiceQueryBtn.textContent = "Голосом";
    }
  };

  elements.voiceQueryBtn.addEventListener("click", () => {
    if (voiceListening) {
      stopVoiceRecognition();
      setVoiceUi(false, "");
      return;
    }
    const trimmedEnd = elements.queryInput.value.replace(/\s+$/, "");
    voicePrefix = trimmedEnd.length ? `${trimmedEnd} ` : "";
    voiceBuffer = "";
    setVoiceUi(true, "Слушаю…");
    try {
      voiceRecognition.start();
    } catch {
      setVoiceUi(false, "Не удалось запустить распознавание");
    }
  });
}

function bindEvents() {
  initVoiceRecognition();
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor && elements.voiceQueryBtn) {
    elements.voiceQueryBtn.disabled = true;
    elements.voiceQueryBtn.title = "Голос: Chrome, Edge или Safari";
  }

  elements.pickBtn.addEventListener("click", runPick);
  elements.queryInput.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) runPick();
  });

  elements.categoryChips.addEventListener("click", event => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    activeCategoryChip = chip.dataset.category;
    syncActiveChip();
    const prefix = `${chip.dataset.category}: `;
    const current = elements.queryInput.value.trim();
    if (!current.toLowerCase().startsWith(chip.dataset.category.toLowerCase())) {
      elements.queryInput.value = prefix + current;
    }
    runPick();
  });

  elements.cardsContainer.addEventListener("click", event => {
    const toggle = event.target.closest(".card-shops-toggle");
    if (!toggle) return;
    const panel = toggle.closest(".card")?.querySelector(".card-shops-panel");
    if (!panel) return;
    const open = panel.hidden;
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });

  elements.exportJsonBtn?.addEventListener("click", exportJson);
}

async function loadSeedCatalogFromJson() {
  try {
    const response = await fetch("catalog_seed.json", { cache: "no-store" });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function init() {
  if (!elements.queryInput || !elements.cardsContainer) return;

  let serverDb = [];
  try {
    serverDb = await loadDbFromServer();
  } catch (error) {
    console.warn(error);
  }

  if (serverDb.length > 0) {
    db = serverDb;
  } else {
    const local = loadDbFromLocal();
    if (local.length > 0) {
      db = local;
      try {
        await saveDbToServer(db);
      } catch (error) {
        console.warn(error);
      }
    } else {
      const seed = await loadSeedCatalogFromJson();
      db = seed.length ? seed : [];
      saveDbToLocal(db);
      try {
        await saveDbToServer(db);
      } catch (error) {
        console.warn(error);
      }
    }
  }

  saveDbToLocal(db);
  renderCategoryChips();
  renderPopularQueries();
  renderSegmentFilters();
  bindEvents();
  renderCards([]);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => init().catch(console.error));
} else {
  init().catch(console.error);
}
