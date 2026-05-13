const STORAGE_KEY = "tech_picker_db_v1";
const API_PRODUCTS_URL = "/api/products";

const PRESET_CATEGORIES = [
  "Ноутбуки",
  "Смартфоны",
  "Планшеты",
  "Телевизоры",
  "Акустика",
  "Аудио",
  "ПК"
];

/** Категории, для которых в боковой панели скрыты ОЗУ и накопитель — вместо них свои фильтры. */
const CATEGORIES_HIDE_RAM_STORAGE = new Set(["Телевизоры", "Акустика", "Аудио"]);

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

const elements = {
  queryInput: document.getElementById("queryInput"),
  pickBtn: document.getElementById("pickBtn"),
  analysisBox: document.getElementById("analysisBox"),
  categoryChips: document.getElementById("categoryChips"),
  filtersToggleBtn: document.getElementById("filtersToggleBtn"),
  filtersDrawer: document.getElementById("filtersDrawer"),
  closeDrawerBtn: document.getElementById("closeDrawerBtn"),
  categoryFilter: document.getElementById("categoryFilter"),
  brandFilter: document.getElementById("brandFilter"),
  ramFilter: document.getElementById("ramFilter"),
  storageFilter: document.getElementById("storageFilter"),
  minPriceInput: document.getElementById("minPriceInput"),
  maxPriceInput: document.getElementById("maxPriceInput"),
  resetFiltersBtn: document.getElementById("resetFiltersBtn"),
  cardsContainer: document.getElementById("cardsContainer"),
  cardTemplate: document.getElementById("cardTemplate"),
  resultCount: document.getElementById("resultCount"),
  excelInput: document.getElementById("excelInput"),
  exportJsonBtn: document.getElementById("exportJsonBtn"),
  voiceQueryBtn: document.getElementById("voiceQueryBtn"),
  voiceStatus: document.getElementById("voiceStatus"),
  ramStorageFilters: document.getElementById("ramStorageFilters"),
  tvSpecFilters: document.getElementById("tvSpecFilters"),
  audioSpecFilters: document.getElementById("audioSpecFilters"),
  screenFilter: document.getElementById("screenFilter"),
  refreshFilter: document.getElementById("refreshFilter"),
  audioWattsFilter: document.getElementById("audioWattsFilter"),
  audioBatteryFilter: document.getElementById("audioBatteryFilter"),
  audioFeatureFilter: document.getElementById("audioFeatureFilter"),
  audioWattsBlock: document.getElementById("audioWattsBlock"),
  audioBatteryBlock: document.getElementById("audioBatteryBlock")
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

function matchCategoryFromQuery(t) {
  for (const cat of allCategoriesMerged()) {
    const lc = String(cat).toLowerCase();
    if (t.includes(lc)) return cat;
  }
  if (/\bтелевизор/.test(t) || /(^|\s)тв(\s|$)/.test(t) || /\bsmart[\s-]*tv\b/.test(t)) return "Телевизоры";
  if (/наушник|гарнитур|earbuds?|вкладыш|tws|airpods/i.test(t)) return "Аудио";
  if (/акустик|колонк|саундбар|динамик|сабвуфер|музыкальн/i.test(t)) return "Акустика";
  return "";
}

function renderCheckboxGroup(container, values, name) {
  container.innerHTML = "";
  if (!values.length) {
    container.innerHTML = "<small>Нет данных</small>";
    return;
  }
  values.forEach(value => {
    const id = `${name}_${String(value).replace(/\s+/g, "_")}`;
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" value="${value}" data-filter="${name}" id="${id}"> ${value}`;
    container.appendChild(label);
  });
}

function effectiveRefreshHz(item) {
  const raw = Number(item.refresh_hz);
  if (Number.isFinite(raw) && raw > 0) return Math.round(raw);
  const m = String(item.cpu || "").match(/(\d{2,3})\s*гц/i);
  if (m) return Number(m[1]);
  return 0;
}

function effectiveAudioWatts(item) {
  const w = Number(item.audio_watts);
  if (Number.isFinite(w) && w > 0) return Math.round(w);
  const m = String(item.cpu || "").match(/\b(\d{2,4})\s*(?:Вт|вт)\b/);
  if (m) return Number(m[1]);
  return 0;
}

function itemAudioFeatures(item) {
  const blob = `${item.name} ${item.description} ${item.extras} ${item.cpu}`;
  return AUDIO_FEATURE_LABELS.filter(f => f.re.test(blob)).map(f => f.id);
}

function buildTvFilters() {
  const tvs = db.filter(i => i.category === "Телевизоры");
  const screens = [...new Set(tvs.map(i => Number(i.screen)).filter(n => Number.isFinite(n) && n > 0))].sort(
    (a, b) => a - b
  );
  const hz = [...new Set(tvs.map(effectiveRefreshHz).filter(h => h > 0))].sort((a, b) => a - b);
  renderCheckboxGroup(elements.screenFilter, screens, "screen");
  renderCheckboxGroup(elements.refreshFilter, hz, "refresh_hz");
}

function buildAudioCategoryFilters(cat) {
  const subset = db.filter(i => i.category === cat);
  const watts = [...new Set(subset.map(effectiveAudioWatts).filter(w => w > 0))].sort((a, b) => a - b);
  renderCheckboxGroup(elements.audioWattsFilter, watts, "audio_watts");
  if (elements.audioWattsBlock) {
    elements.audioWattsBlock.classList.toggle("hidden", watts.length === 0);
  }

  if (cat === "Аудио") {
    const bats = [...new Set(subset.map(i => Number(i.ram)).filter(n => Number.isFinite(n) && n > 0))].sort(
      (a, b) => a - b
    );
    renderCheckboxGroup(elements.audioBatteryFilter, bats, "audio_battery");
  } else if (elements.audioBatteryFilter) {
    elements.audioBatteryFilter.innerHTML = "";
  }

  const present = new Set();
  for (const it of subset) {
    for (const f of itemAudioFeatures(it)) present.add(f);
  }
  const featDefs = AUDIO_FEATURE_LABELS.filter(f => present.has(f.id));
  elements.audioFeatureFilter.innerHTML = "";
  if (!featDefs.length) {
    elements.audioFeatureFilter.innerHTML = "<small>Нет данных</small>";
    return;
  }
  featDefs.forEach(f => {
    const id = `audio_feat_${f.id}`;
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" value="${f.id}" data-filter="audio_feat" id="${id}"> ${f.label}`;
    elements.audioFeatureFilter.appendChild(label);
  });
}

function refreshCategoryDependantFilters() {
  const cat = elements.categoryFilter.value || "";
  const hideRam = CATEGORIES_HIDE_RAM_STORAGE.has(cat);

  if (elements.ramStorageFilters) elements.ramStorageFilters.classList.toggle("hidden", hideRam);
  if (elements.tvSpecFilters) elements.tvSpecFilters.classList.toggle("hidden", cat !== "Телевизоры");
  const showAudio = cat === "Акустика" || cat === "Аудио";
  if (elements.audioSpecFilters) elements.audioSpecFilters.classList.toggle("hidden", !showAudio);

  if (!hideRam) {
    renderCheckboxGroup(elements.ramFilter, uniqueSortedValues("ram"), "ram");
    renderCheckboxGroup(elements.storageFilter, uniqueSortedValues("storage"), "storage");
  }

  if (cat === "Телевизоры") buildTvFilters();
  if (showAudio) {
    if (elements.audioBatteryBlock) {
      elements.audioBatteryBlock.classList.toggle("hidden", cat !== "Аудио");
    }
    buildAudioCategoryFilters(cat);
  }
}

function initFilterOptions() {
  const categories = allCategoriesMerged();
  const brands = uniqueSortedValues("brand");

  elements.categoryFilter.innerHTML = `<option value="">Все</option>${categories
    .map(c => `<option value="${c}">${c}</option>`)
    .join("")}`;
  renderCheckboxGroup(elements.brandFilter, brands, "brand");
  refreshCategoryDependantFilters();
  renderCategoryChips(categories);
}

function chipHint(category) {
  if (category === "Смартфоны") return "Телефоны";
  if (category === "Ноутбуки") return "Работа и игры";
  if (category === "Планшеты") return "Планшеты";
  if (category === "Телевизоры") return "Smart TV, OLED, QLED";
  if (category === "Акустика") return "Колонки, саундбары";
  if (category === "Аудио") return "Наушники и микрофоны";
  if (category === "ПК") return "Мониторы, периферия";
  return "Подбор по категории";
}

function renderCategoryChips(categories) {
  elements.categoryChips.innerHTML = "";
  const source = categories.length ? categories : [...PRESET_CATEGORIES];
  source.forEach(category => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.dataset.category = category;
    button.innerHTML = `<strong>${category}</strong><small>${chipHint(category)}</small>`;
    if (category === activeCategoryChip) button.classList.add("active");
    elements.categoryChips.appendChild(button);
  });
}

function selectedCheckboxValues(filterName) {
  return [...document.querySelectorAll(`input[data-filter="${filterName}"]:checked`)].map(
    el => el.value
  );
}

const QUERY_STOPWORDS = new Set([
  "и",
  "в",
  "на",
  "под",
  "для",
  "с",
  "со",
  "по",
  "или",
  "до",
  "от",
  "не",
  "нам",
  "гб",
  "gb",
  "тб",
  "tb",
  "руб",
  "₽",
  "k",
  "к",
  "озу",
  "ram",
  "оперативной",
  "оперативная",
  "оперативную",
  "оперативки",
  "накопитель",
  "накопителя",
  "ssd",
  "hdd",
  "экран",
  "дюйм",
  "дюйма",
  "ноутбук",
  "смартфон",
  "телефон",
  "версия",
  "модель",
  "нужен",
  "нужна",
  "хочу",
  "ищу",
  "купить",
  "цене",
  "цена",
  "тип",
  "памяти",
  "память",
  "диск",
  "диагональ"
]);

function firstRowValue(row, ...keys) {
  for (const key of keys) {
    if (row[key] != null && row[key] !== "") return row[key];
  }
  const lower = Object.fromEntries(Object.keys(row).map(k => [String(k).toLowerCase(), k]));
  for (const key of keys) {
    const orig = lower[String(key).toLowerCase()];
    if (orig != null && row[orig] != null && row[orig] !== "") return row[orig];
  }
  return undefined;
}

function ruDigits(str) {
  if (str == null) return null;
  const v = parseInt(String(str).replace(/\s/g, "").replace(/\u00a0/g, ""), 10);
  return Number.isFinite(v) ? v : null;
}

function parseSpecConstraints(raw) {
  const t = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/,/g, ".");
  const c = {
    minPrice: null,
    maxPrice: null,
    minRam: null,
    maxRam: null,
    ramExact: null,
    minStorage: null,
    maxStorage: null,
    storageExact: null,
    minScreen: null,
    maxScreen: null,
    brand: "",
    category: "",
    cpuHints: [],
    usedNumbers: new Set()
  };

  const addUsed = n => {
    if (Number.isFinite(n)) c.usedNumbers.add(Math.round(n));
  };

  let m = t.match(/\bдо\s*(\d{1,3})\s*к\b/);
  if (m) {
    c.maxPrice = Number(m[1]) * 1000;
    addUsed(c.maxPrice);
  }
  m = t.match(/\bдо\s*([\d\s]{3,9})(?:\s*(?:руб|₽))?\b/);
  if (m) {
    const v = ruDigits(m[1]);
    if (v != null) {
      c.maxPrice = v;
      addUsed(v);
    }
  }
  m = t.match(/\b(?:меньше|не\s+дороже)\s*([\d\s]{3,9})(?:\s*(?:руб|₽))?\b/);
  if (m) {
    const v = ruDigits(m[1]);
    if (v != null) {
      c.maxPrice = v;
      addUsed(v);
    }
  }
  m = t.match(/\bот\s*([\d\s]{3,9})(?:\s*(?:руб|₽))?\b/);
  if (m) {
    const v = ruDigits(m[1]);
    if (v != null) {
      c.minPrice = v;
      addUsed(v);
    }
  }
  m = t.match(/\b(?:дороже|больше)\s*([\d\s]{3,9})(?:\s*(?:руб|₽))?\b/);
  if (m) {
    const v = ruDigits(m[1]);
    if (v != null) {
      c.minPrice = v;
      addUsed(v);
    }
  }

  m = t.match(/\b(\d+(?:[.,]\d+)?)\s*(?:тб|tb)\b/);
  if (m) {
    const tb = parseFloat(String(m[1]).replace(",", "."));
    if (Number.isFinite(tb)) {
      c.storageExact = Math.round(tb * 1000);
      addUsed(c.storageExact);
    }
  }

  m = t.match(/\b(?:ssd|накопител\w*|диск|хранилищ\w*)\s*(\d{2,5})\s*(?:гб|gb)?\b/);
  if (m) {
    const v = ruDigits(m[1]);
    if (v != null) {
      c.storageExact = v;
      addUsed(v);
    }
  }
  if (c.storageExact == null) {
    m = t.match(/\b(\d{2,5})\s*(?:гб|gb)\s*(?:ssd|накопител\w*|nvme|hdd)\b/);
    if (m) {
      const v = ruDigits(m[1]);
      if (v != null) {
        c.storageExact = v;
        addUsed(v);
      }
    }
  }

  m = t.match(/\b(?:озу|оперативн\w*|ram)\s*(\d{1,2})\s*(?:гб|gb)?\b/);
  if (m) {
    const v = ruDigits(m[1]);
    if (v != null) {
      c.ramExact = v;
      addUsed(v);
    }
  }
  if (c.ramExact == null) {
    m = t.match(/\b(\d{1,2})\s*(?:гб|gb)\s*(?:озу|оперативн\w*|ram)\b/);
    if (m) {
      const v = ruDigits(m[1]);
      if (v != null) {
        c.ramExact = v;
        addUsed(v);
      }
    }
  }

  m = t.match(/\bэкран\s*(?:от\s*)?(\d{1,2}(?:[.,]\d)?)\s*(?:дюйм|"|дюйма)?\b/);
  if (m) {
    const v = parseFloat(String(m[1]).replace(",", "."));
    if (Number.isFinite(v)) {
      c.minScreen = v;
      addUsed(Math.round(v * 10) / 10);
    }
  }
  m = t.match(/\b(\d{1,2}(?:[.,]\d)?)\s*(?:дюйм|"|дюйма)\b/);
  if (m && c.minScreen == null) {
    const v = parseFloat(String(m[1]).replace(",", "."));
    if (Number.isFinite(v)) {
      c.minScreen = v;
      addUsed(Math.round(v * 10) / 10);
    }
  }
  m = t.match(/\bдиагональ\s*(?:до\s*)?(\d{1,2}(?:[.,]\d)?)\b/);
  if (m) {
    const v = parseFloat(String(m[1]).replace(",", "."));
    if (Number.isFinite(v)) {
      c.maxScreen = v;
      addUsed(Math.round(v * 10) / 10);
    }
  }

  if (/\bintel\b|интел/.test(t)) c.cpuHints.push("intel");
  if (/\bamd\b|райзен|ryzen/.test(t)) c.cpuHints.push("amd");
  const mchip = t.match(/\bm([1-4])\b/);
  if (mchip) c.cpuHints.push(`m${mchip[1]}`);
  if (/\bsnapdragon\b|снапдрагон/.test(t)) c.cpuHints.push("snapdragon");
  if (/\bmediatek\b|медиатек/.test(t)) c.cpuHints.push("mediatek");
  if (/\bexynos\b|эксинос/.test(t)) c.cpuHints.push("exynos");

  c.brand =
    uniqueSortedValues("brand").find(b => t.includes(String(b).toLowerCase())) || "";
  c.category = matchCategoryFromQuery(t);

  return c;
}

function buildSearchHaystack(item) {
  const ram = Number(item.ram);
  const storage = Number(item.storage);
  const screen = Number(item.screen);
  const price = Number(item.price);
  const hz = effectiveRefreshHz(item);
  const aw = effectiveAudioWatts(item);
  const parts = [
    item.name,
    item.brand,
    item.category,
    item.cpu,
    item.description,
    item.extras,
    String(ram),
    `${ram} гб`,
    String(storage),
    `${storage} гб`,
    String(screen),
    String(hz),
    `${hz} гц`,
    String(aw),
    `${aw} вт`,
    String(price),
    formatPrice(price),
    ...itemAudioFeatures(item)
  ];
  return parts.filter(Boolean).join(" \u0001 ").toLowerCase();
}

function extractSearchTokens(fullText, c) {
  const t = fullText.trim().toLowerCase();
  const tokens = [];
  const re = /[\p{L}\p{N}]+/gu;
  let m;
  while ((m = re.exec(t)) !== null) {
    const p = m[0];
    if (p.length < 2) continue;
    if (QUERY_STOPWORDS.has(p)) continue;
    const asNum = parseInt(p, 10);
    if (String(asNum) === p && c.usedNumbers.has(asNum)) continue;
    tokens.push(p);
  }
  const brandLc = String(c.brand || "").toLowerCase();
  const catLc = String(c.category || "").toLowerCase();
  return tokens.filter(tok => {
    if (brandLc && tok === brandLc) return false;
    if (catLc && tok === catLc) return false;
    return true;
  });
}

function itemMatchesSpecQuery(item, rawQuery, drawerCategory, drawerMinPrice, drawerMaxPrice) {
  const q = rawQuery.trim();
  const spec = q ? parseSpecConstraints(q) : parseSpecConstraints("");
  const category = drawerCategory || spec.category;
  const minPrice = Math.max(
    drawerMinPrice,
    spec.minPrice != null ? spec.minPrice : 0
  );
  const maxPrice = Math.min(
    drawerMaxPrice,
    spec.maxPrice != null ? spec.maxPrice : Number.MAX_SAFE_INTEGER
  );
  const price = Number(item.price);
  if (price < minPrice || price > maxPrice) return false;
  if (category && item.category !== category) return false;

  const ram = Number(item.ram);
  const storage = Number(item.storage);
  const screen = Number(item.screen);

  const skipRamStorage =
    drawerCategory === "Телевизоры" ||
    drawerCategory === "Акустика" ||
    drawerCategory === "Аудио";

  if (!skipRamStorage) {
    if (spec.ramExact != null && ram !== spec.ramExact) return false;
    if (spec.minRam != null && ram < spec.minRam) return false;
    if (spec.maxRam != null && ram > spec.maxRam) return false;
    if (spec.storageExact != null && storage !== spec.storageExact) return false;
    if (spec.minStorage != null && storage < spec.minStorage) return false;
    if (spec.maxStorage != null && storage > spec.maxStorage) return false;
  }
  if (spec.minScreen != null && screen > 0 && screen < spec.minScreen) return false;
  if (spec.maxScreen != null && screen > 0 && screen > spec.maxScreen) return false;

  const hay = buildSearchHaystack(item);
  for (const hint of spec.cpuHints) {
    if (!hay.includes(hint)) return false;
  }
  if (spec.brand && item.brand !== spec.brand) return false;

  if (q.length) {
    const tokens = extractSearchTokens(q, spec);
    for (const tok of tokens) {
      if (!hay.includes(tok)) return false;
    }
  }
  return true;
}

function applyFilters() {
  const rawQ = elements.queryInput.value;
  const category = elements.categoryFilter.value;
  const selectedBrands = selectedCheckboxValues("brand");
  const selectedRam = selectedCheckboxValues("ram").map(Number);
  const selectedStorage = selectedCheckboxValues("storage").map(Number);
  const selectedScreen = selectedCheckboxValues("screen").map(Number);
  const selectedRefresh = selectedCheckboxValues("refresh_hz").map(Number);
  const selectedAudioWatts = selectedCheckboxValues("audio_watts").map(Number);
  const selectedAudioBat = selectedCheckboxValues("audio_battery").map(Number);
  const selectedAudioFeat = selectedCheckboxValues("audio_feat");
  const minPrice = Number(elements.minPriceInput.value) || 0;
  const maxPrice = Number(elements.maxPriceInput.value) || Number.MAX_SAFE_INTEGER;

  const filtered = db.filter(item => {
    if (!itemMatchesSpecQuery(item, rawQ, category, minPrice, maxPrice)) return false;
    if (selectedBrands.length && !selectedBrands.includes(item.brand)) return false;

    if (category === "Телевизоры") {
      if (selectedScreen.length && !selectedScreen.includes(Number(item.screen))) return false;
      const hz = effectiveRefreshHz(item);
      if (selectedRefresh.length && !selectedRefresh.includes(hz)) return false;
      return true;
    }

    if (category === "Акустика" || category === "Аудио") {
      const w = effectiveAudioWatts(item);
      if (selectedAudioWatts.length && !selectedAudioWatts.includes(w)) return false;
      if (category === "Аудио" && selectedAudioBat.length && !selectedAudioBat.includes(Number(item.ram))) {
        return false;
      }
      if (selectedAudioFeat.length) {
        const have = itemAudioFeatures(item);
        if (!selectedAudioFeat.every(f => have.includes(f))) return false;
      }
      return true;
    }

    if (selectedRam.length && !selectedRam.includes(Number(item.ram))) return false;
    if (selectedStorage.length && !selectedStorage.includes(Number(item.storage))) return false;
    return true;
  });

  renderCards(filtered);
  renderAnalysis(filtered);
}

function formatPrice(value) {
  return new Intl.NumberFormat("ru-RU").format(Number(value)) + " ₽";
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
    const cpuStr = String(item.cpu || "");
    const mCh = cpuStr.match(/(\d+(?:\.\d+)+)\s*ch\b/i) || cpuStr.match(/(\d+)\s*каналов?\b/i);
    if (mCh) bits.push(`конфигурация ${mCh[1]}`);
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
    const drv = String(item.cpu || "").match(/(\d{1,2}(?:\.\d)?)\s*мм/);
    if (drv) bits.push(`драйвер ${drv[1]} мм`);
    if (desc) bits.push(desc);
    const feat = itemAudioFeatures(item);
    if (feat.length) bits.push(feat.join(", "));
    if (ex) bits.push(ex);
    return bits.join(" · ").slice(0, 320) || "—";
  }
  if (cat === "ПК") {
    if (screen > 0) {
      const b = [];
      if (cpu) b.push(cpu);
      if (desc) b.push(desc);
      return b.join(" · ").slice(0, 300) || `${screen}"`;
    }
    const b = [];
    if (cpu) b.push(cpu);
    if (storage > 0) b.push(`${storage} ГБ`);
    if (desc) b.push(desc);
    return b.join(" · ").slice(0, 300) || "—";
  }
  const scrPart = screen > 0 ? ` · экран ${screen}"` : "";
  return `CPU: ${cpu || "—"} · ОЗУ ${ram || "—"} ГБ · накопитель ${storage || "—"} ГБ${scrPart}`;
}

function buildShopSearchUrl(site, item) {
  const text = encodeURIComponent(`${item.name} ${item.brand}`.trim());
  switch (site) {
    case "citilink":
      return `https://www.citilink.ru/search/?text=${text}`;
    case "dns":
      return `https://www.dns-shop.ru/search/?q=${text}`;
    case "wildberries":
      return `https://www.wildberries.ru/catalog/0/search.aspx?search=${text}`;
    case "ozon":
      return `https://www.ozon.ru/search/?text=${text}`;
    default:
      return "#";
  }
}

function renderCards(items) {
  elements.cardsContainer.innerHTML = "";
  elements.resultCount.textContent = `${items.length} товаров`;

  if (!db.length) {
    elements.cardsContainer.innerHTML =
      "<p>Каталог пуст. Откройте «Фильтры» и загрузите товары файлом .xlsx или .json (колонки можно на русском).</p>";
    return;
  }

  if (!items.length) {
    elements.cardsContainer.innerHTML = "<p>По выбранным фильтрам ничего не найдено.</p>";
    return;
  }

  items.forEach(item => {
    const card = elements.cardTemplate.content.firstElementChild.cloneNode(true);
    card.querySelector(".card-title").textContent = item.name;
    card.querySelector(".card-meta").textContent = `${item.category} | ${item.brand}`;
    const scr = Number(item.screen);
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

function parseQuery(input) {
  const s = parseSpecConstraints(input);
  return {
    minPrice: s.minPrice,
    maxPrice: s.maxPrice,
    ramExact: s.ramExact,
    storageExact: s.storageExact,
    minScreen: s.minScreen,
    maxScreen: s.maxScreen,
    brand: s.brand,
    category: s.category,
    cpuHints: s.cpuHints
  };
}

function renderAnalysis(filtered) {
  const query = elements.queryInput.value.trim();
  const parsed = parseQuery(query);
  const ramLine = parsed.ramExact != null ? `ОЗУ из запроса: ${parsed.ramExact} ГБ` : null;
  const storLine =
    parsed.storageExact != null ? `Накопитель из запроса: ${parsed.storageExact} ГБ` : null;
  const scrParts = [];
  if (parsed.minScreen != null) scrParts.push(`от ${parsed.minScreen}"`);
  if (parsed.maxScreen != null) scrParts.push(`до ${parsed.maxScreen}"`);
  const screenLine = scrParts.length ? `Экран: ${scrParts.join(", ")}` : null;
  const cpuLine = parsed.cpuHints?.length ? `CPU: ${parsed.cpuHints.join(", ")}` : null;
  const lines = [
    `Запрос: ${query || "не задан"}`,
    `Категория: ${elements.categoryFilter.value || parsed.category || activeCategoryChip || "любая"}`,
    `Бренд: ${selectedCheckboxValues("brand").join(", ") || parsed.brand || "любой"}`,
    `Цена (фильтры): ${elements.minPriceInput.value || "0"} – ${elements.maxPriceInput.value || "без лимита"} ₽`,
    ramLine,
    storLine,
    screenLine,
    cpuLine,
    `Найдено: ${filtered.length} позиций`
  ].filter(Boolean);
  elements.analysisBox.textContent = lines.join("\n");
}

function openDrawer() {
  elements.filtersDrawer.classList.add("open");
  elements.filtersDrawer.setAttribute("aria-hidden", "false");
}

function closeDrawer() {
  elements.filtersDrawer.classList.remove("open");
  elements.filtersDrawer.setAttribute("aria-hidden", "true");
}

function applyParsedQuery() {
  const parsed = parseQuery(elements.queryInput.value);
  if (parsed.category) {
    elements.categoryFilter.value = parsed.category;
    activeCategoryChip = parsed.category;
  }
  if (parsed.minPrice != null) {
    elements.minPriceInput.value = parsed.minPrice;
  }
  if (parsed.maxPrice != null) {
    elements.maxPriceInput.value = parsed.maxPrice;
  }
  if (parsed.brand) {
    document
      .querySelectorAll('input[data-filter="brand"]')
      .forEach(input => (input.checked = input.value === parsed.brand));
  }
  if (parsed.ramExact != null) {
    document.querySelectorAll('input[data-filter="ram"]').forEach(input => {
      input.checked = Number(input.value) === Number(parsed.ramExact);
    });
  }
  if (parsed.storageExact != null) {
    document.querySelectorAll('input[data-filter="storage"]').forEach(input => {
      input.checked = Number(input.value) === Number(parsed.storageExact);
    });
  }
  syncActiveChip();
  refreshCategoryDependantFilters();
}

function syncActiveChip() {
  const category = elements.categoryFilter.value || activeCategoryChip;
  document.querySelectorAll(".chip").forEach(chip => {
    chip.classList.toggle("active", chip.dataset.category === category);
  });
}

function normalizeRow(row, idx) {
  const fallbackId = idx + 1;
  const idRaw = firstRowValue(row, "id", "ID");
  let idNum = fallbackId;
  if (idRaw != null && idRaw !== "") {
    const n = Number(idRaw);
    if (Number.isFinite(n)) idNum = Math.round(n);
  }
  const name = String(firstRowValue(row, "name", "title", "название", "Название", "товар") ?? "").trim();
  const category = String(firstRowValue(row, "category", "Категория", "категория") ?? "").trim();
  const brand = String(firstRowValue(row, "brand", "Бренд", "бренд", "производитель") ?? "").trim();
  const price = Number(firstRowValue(row, "price", "цена", "Цена", "стоимость") ?? 0) || 0;
  const ram = Number(firstRowValue(row, "ram", "memory", "озу", "ОЗУ", "RAM", "оперативная память", "оперативная_память") ?? 0) || 0;
  const storage =
    Number(firstRowValue(row, "storage", "ssd", "disk", "накопитель", "Накопитель", "диск", "SSD") ?? 0) || 0;
  const cpu = String(firstRowValue(row, "cpu", "процессор", "Процессор", "CPU", "chipset") ?? "").trim();
  const screen = Number(firstRowValue(row, "screen", "экран", "Экран", "диагональ", "Диагональ", "display") ?? 0) || 0;
  const refresh_hz =
    Number(
      firstRowValue(row, "refresh_hz", "герцовка", "Герцовка", "частота_кадров", "частота кадров", "hz", "Hz") ?? 0
    ) || 0;
  const audio_watts =
    Number(firstRowValue(row, "audio_watts", "мощность_ватт", "Мощность Вт", "watts", "RMS") ?? 0) || 0;
  const description = String(firstRowValue(row, "description", "описание", "Описание") ?? "").trim();
  const extras = String(firstRowValue(row, "extras", "specs", "характеристики", "Характеристики") ?? "").trim();
  return {
    id: idNum,
    name,
    category,
    brand,
    price,
    ram,
    storage,
    cpu,
    screen,
    description,
    extras,
    refresh_hz,
    audio_watts
  };
}

function normalizeRows(rows) {
  return rows.map(normalizeRow).filter(row => row.name && row.category && row.brand && row.price > 0);
}

function fingerprintProduct(p) {
  return `${String(p.name).trim().toLowerCase()}|${String(p.brand).trim().toLowerCase()}|${Number(p.price)}|${Number(p.ram)}|${Number(p.storage)}|${Number(p.refresh_hz) || 0}|${Number(p.audio_watts) || 0}`;
}

async function mergeDb(newRows) {
  if (!newRows.length) {
    alert("В файле нет подходящих строк. Нужны колонки: название, категория, бренд, цена (можно на русском).");
    return false;
  }
  const seen = new Set(db.map(fingerprintProduct));
  let nextId = Math.max(0, ...db.map(r => Number(r.id) || 0), 0) + 1;
  const toAppend = [];
  for (const row of newRows) {
    const fp = fingerprintProduct(row);
    if (seen.has(fp)) continue;
    seen.add(fp);
    toAppend.push({ ...row, id: nextId++ });
  }
  if (!toAppend.length) {
    alert("Все строки из файла уже есть в каталоге (совпали название, бренд, цена, ОЗУ, накопитель и TV/аудио-параметры).");
    return false;
  }
  const merged = [...db, ...toAppend];
  saveDbToLocal(merged);
  let savedServer = false;
  try {
    await saveDbToServer(merged);
    savedServer = true;
  } catch (error) {
    console.warn(error);
  }
  initFilterOptions();
  applyFilters();
  let msg = `Добавлено позиций: ${toAppend.length}. Всего в каталоге: ${merged.length}.`;
  msg += savedServer
    ? " Сохранено на сервере и в браузере."
    : " Сервер недоступен — данные только в браузере (localStorage). Запусти server.py и обнови страницу, чтобы синхронизировать.";
  alert(msg);
  return true;
}

function importExcel(file) {
  const reader = new FileReader();
  reader.onload = async event => {
    try {
      const data = new Uint8Array(event.target.result);
      const workbook = XLSX.read(data, { type: "array" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      await mergeDb(normalizeRows(rows));
    } catch (error) {
      console.error(error);
      alert("Ошибка чтения Excel файла.");
    }
  };
  reader.readAsArrayBuffer(file);
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = async event => {
    try {
      const parsed = JSON.parse(String(event.target.result || "[]"));
      const rows = Array.isArray(parsed) ? parsed : parsed.products;
      if (!Array.isArray(rows)) {
        alert("JSON должен быть массивом товаров или объектом с полем products.");
        return;
      }
      await mergeDb(normalizeRows(rows));
    } catch (error) {
      console.error(error);
      alert("Ошибка чтения JSON файла.");
    }
  };
  reader.readAsText(file, "utf-8");
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
  if (elements.voiceStatus) {
    elements.voiceStatus.textContent = message;
  }
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
        applyFilters();
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
      "aborted": "",
      "network": "Сеть недоступна для распознавания"
    };
    const msg = codes[event.error] || (event.error ? `Ошибка: ${event.error}` : "");
    if (msg) setVoiceUi(false, msg);
    else setVoiceUi(false, "");
  };

  voiceRecognition.onend = () => {
    voiceListening = false;
    if (elements.voiceQueryBtn) {
      elements.voiceQueryBtn.classList.remove("listening");
      elements.voiceQueryBtn.setAttribute("aria-pressed", "false");
      elements.voiceQueryBtn.textContent = "Голосом";
    }
    if (elements.voiceStatus && elements.voiceStatus.textContent === "Слушаю…") {
      elements.voiceStatus.textContent = "";
    }
  };

  elements.voiceQueryBtn.addEventListener("click", () => {
    if (!voiceRecognition) return;
    if (voiceListening) {
      stopVoiceRecognition();
      setVoiceUi(false, "");
      applyFilters();
      return;
    }
    const trimmedEnd = elements.queryInput.value.replace(/\s+$/, "");
    voicePrefix = trimmedEnd.length ? `${trimmedEnd} ` : "";
    voiceBuffer = "";
    setVoiceUi(true, "Слушаю…");
    try {
      voiceRecognition.start();
    } catch (e) {
      console.warn(e);
      setVoiceUi(false, "Не удалось запустить распознавание");
    }
  });
}

function resetFilters() {
  elements.queryInput.value = "";
  stopVoiceRecognition();
  setVoiceUi(false, "");
  elements.categoryFilter.value = "";
  elements.minPriceInput.value = "";
  elements.maxPriceInput.value = "";
  activeCategoryChip = "";
  document
    .querySelectorAll('input[type="checkbox"][data-filter]')
    .forEach(checkbox => (checkbox.checked = false));
  syncActiveChip();
  refreshCategoryDependantFilters();
  applyFilters();
}

function bindEvents() {
  initVoiceRecognition();
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor && elements.voiceQueryBtn) {
    elements.voiceQueryBtn.disabled = true;
    elements.voiceQueryBtn.title = "Голосовой ввод недоступен в этом браузере (нужен Chrome, Edge или Safari)";
    if (elements.voiceStatus) elements.voiceStatus.textContent = "Голос: только Chrome / Edge / Safari";
  }

  elements.pickBtn.addEventListener("click", () => {
    applyParsedQuery();
    applyFilters();
  });
  elements.queryInput.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      applyParsedQuery();
      applyFilters();
    }
  });
  elements.categoryFilter.addEventListener("change", () => {
    refreshCategoryDependantFilters();
    applyFilters();
  });
  elements.minPriceInput.addEventListener("input", applyFilters);
  elements.maxPriceInput.addEventListener("input", applyFilters);
  if (elements.filtersDrawer) {
    elements.filtersDrawer.addEventListener("change", event => {
      const t = event.target;
      if (t && t.matches && t.matches('input[type="checkbox"][data-filter]')) applyFilters();
    });
  }
  elements.resetFiltersBtn.addEventListener("click", resetFilters);
  elements.filtersToggleBtn.addEventListener("click", openDrawer);
  elements.closeDrawerBtn.addEventListener("click", closeDrawer);
  elements.categoryChips.addEventListener("click", event => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    activeCategoryChip = chip.dataset.category;
    elements.categoryFilter.value = activeCategoryChip;
    syncActiveChip();
    refreshCategoryDependantFilters();
    applyFilters();
  });

  elements.excelInput.addEventListener("change", async event => {
    const [file] = event.target.files;
    if (file) {
      const lowerName = file.name.toLowerCase();
      try {
        if (lowerName.endsWith(".json")) {
          importJson(file);
        } else {
          importExcel(file);
        }
      } finally {
        // Сбрасываем value, чтобы выбор того же файла снова вызывал change.
        event.target.value = "";
      }
    }
  });

  elements.cardsContainer.addEventListener("click", event => {
    const toggle = event.target.closest(".card-shops-toggle");
    if (!toggle) return;
    const card = toggle.closest(".card");
    const panel = card && card.querySelector(".card-shops-panel");
    if (!panel) return;
    const open = panel.hidden;
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });

  elements.exportJsonBtn.addEventListener("click", exportJson);
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
  if (!elements.queryInput || !elements.cardsContainer) {
    console.error("ElectroPick: не найдены элементы DOM");
    return;
  }
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
  initFilterOptions();
  syncActiveChip();
  bindEvents();
  applyFilters();
}

function startApp() {
  init().catch(err => {
    console.error(err);
    const box = document.getElementById("analysisBox");
    if (box) box.textContent = `Ошибка запуска: ${err.message || err}. Откройте страницу через http://127.0.0.1:8000 (python server.py).`;
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startApp);
} else {
  startApp();
}
