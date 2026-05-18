import json
import os
import sqlite3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from llm_service import enrich_product, pick_products

_ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(_ROOT, "electropick.db")


def _listen_host_port():
  """Локально — 127.0.0.1:8000; на Render и др. PaaS — 0.0.0.0 и порт из $PORT."""
  port = int(os.environ.get("PORT", "8000"))
  if str(os.environ.get("RENDER", "")).lower() in ("1", "true", "yes"):
    return "0.0.0.0", port
  host = os.environ.get("BIND_HOST", "127.0.0.1")
  return host, port


HOST, PORT = _listen_host_port()


def connect_db():
  conn = sqlite3.connect(DB_PATH)
  conn.row_factory = sqlite3.Row
  return conn


def _force_remove_db_files():
  for suffix in ("", "-wal", "-shm"):
    p = DB_PATH + suffix if suffix else DB_PATH
    try:
      if os.path.isfile(p):
        os.remove(p)
    except OSError:
      pass


def _recover_corrupt_db():
  if not os.path.isfile(DB_PATH):
    return
  try:
    conn = sqlite3.connect(DB_PATH)
    conn.execute("SELECT 1 FROM sqlite_master LIMIT 1")
    conn.close()
  except sqlite3.DatabaseError:
    try:
      os.replace(DB_PATH, DB_PATH + ".invalid")
    except OSError:
      _force_remove_db_files()


def init_db():
  _recover_corrupt_db()
  try:
    _init_db_connection()
  except sqlite3.DatabaseError:
    _force_remove_db_files()
    _init_db_connection()


def _init_db_connection():
  conn = connect_db()
  conn.execute(
    """
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      brand TEXT NOT NULL,
      price REAL NOT NULL,
      ram REAL DEFAULT 0,
      storage REAL DEFAULT 0,
      cpu TEXT DEFAULT '',
      screen REAL DEFAULT 0,
      description TEXT DEFAULT '',
      extras TEXT DEFAULT '',
      refresh_hz REAL DEFAULT 0,
      audio_watts REAL DEFAULT 0,
      rating REAL DEFAULT 0,
      review_count INTEGER DEFAULT 0
    )
    """
  )
  cols = [r[1] for r in conn.execute("PRAGMA table_info(products)").fetchall()]
  if "extras" not in cols:
    conn.execute("ALTER TABLE products ADD COLUMN extras TEXT DEFAULT ''")
  if "refresh_hz" not in cols:
    conn.execute("ALTER TABLE products ADD COLUMN refresh_hz REAL DEFAULT 0")
  if "audio_watts" not in cols:
    conn.execute("ALTER TABLE products ADD COLUMN audio_watts REAL DEFAULT 0")
  if "rating" not in cols:
    conn.execute("ALTER TABLE products ADD COLUMN rating REAL DEFAULT 0")
  if "review_count" not in cols:
    conn.execute("ALTER TABLE products ADD COLUMN review_count INTEGER DEFAULT 0")
  conn.commit()
  conn.close()


def get_products():
  conn = connect_db()
  rows = conn.execute(
    """
    SELECT id, name, category, brand, price, ram, storage, cpu, screen, description, extras, refresh_hz, audio_watts, rating, review_count
    FROM products
    ORDER BY id ASC
    """
  ).fetchall()
  conn.close()
  return [enrich_product(dict(row)) for row in rows]


def replace_products(products):
  conn = connect_db()
  conn.execute("DELETE FROM products")
  conn.executemany(
    """
    INSERT INTO products (id, name, category, brand, price, ram, storage, cpu, screen, description, extras, refresh_hz, audio_watts, rating, review_count)
    VALUES (:id, :name, :category, :brand, :price, :ram, :storage, :cpu, :screen, :description, :extras, :refresh_hz, :audio_watts, :rating, :review_count)
    """,
    products
  )
  conn.commit()
  conn.close()


def _first(row, *keys):
  for key in keys:
    if key in row and row[key] not in (None, ""):
      return row[key]
  lower_map = {str(k).lower(): k for k in row}
  for key in keys:
    lk = str(key).lower()
    if lk in lower_map:
      v = row[lower_map[lk]]
      if v not in (None, ""):
        return v
  return None


def normalize_row(row, idx):
  ram = _first(row, "ram", "memory", "озу", "ОЗУ", "RAM", "оперативная память", "оперативная_память")
  storage = _first(row, "storage", "ssd", "disk", "накопитель", "Накопитель", "диск", "SSD")
  price_raw = _first(row, "price", "цена", "Цена", "стоимость")
  cpu_raw = _first(row, "cpu", "процессор", "Процессор", "CPU", "chipset")
  screen_raw = _first(row, "screen", "экран", "Экран", "диагональ", "Диагональ", "display")
  refresh_raw = _first(
    row, "refresh_hz", "герцовка", "Герцовка", "hz", "Hz", "частота_кадров", "частота кадров", "refresh"
  )
  audio_watts_raw = _first(
    row, "audio_watts", "мощность_ватт", "Мощность Вт", "ватт", "Вт RMS", "watts", "RMS"
  )
  rating_raw = _first(row, "rating", "рейтинг", "Рейтинг", "оценка", "Оценка")
  review_raw = _first(
    row, "review_count", "reviews", "отзывы", "Отзывы", "число_отзывов", "количество отзывов"
  )
  rid = _first(row, "id", "ID")
  try:
    pid = int(float(rid)) if rid not in (None, "") else idx + 1
  except (TypeError, ValueError):
    pid = idx + 1
  name = str(_first(row, "name", "title", "название", "Название", "товар") or "").strip()
  category = str(_first(row, "category", "Категория", "категория") or "").strip()
  brand = str(_first(row, "brand", "Бренд", "бренд", "производитель") or "").strip()
  try:
    price = float(price_raw or 0)
  except (TypeError, ValueError):
    price = 0.0
  return {
    "id": pid,
    "name": name,
    "category": category,
    "brand": brand,
    "price": price,
    "ram": float(ram or 0),
    "storage": float(storage or 0),
    "cpu": str(cpu_raw or "").strip(),
    "screen": float(screen_raw or 0),
    "description": str(_first(row, "description", "описание", "Описание") or "").strip(),
    "extras": str(_first(row, "extras", "specs", "характеристики", "Характеристики") or "").strip(),
    "refresh_hz": float(refresh_raw or 0),
    "audio_watts": float(audio_watts_raw or 0),
    "rating": float(rating_raw or 0),
    "review_count": int(float(review_raw or 0)) if review_raw not in (None, "") else 0,
  }


def normalize_rows(rows):
  normalized = [normalize_row(row, i) for i, row in enumerate(rows)]
  return [row for row in normalized if row["name"] and row["category"] and row["brand"] and row["price"] > 0]


class ApiHandler(SimpleHTTPRequestHandler):
  def _send_json(self, payload, status=200):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Content-Length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)

  def do_GET(self):
    path = urlparse(self.path).path
    if path == "/api/products":
      return self._send_json(get_products())
    return super().do_GET()

  def do_POST(self):
    path = urlparse(self.path).path
    try:
      length = int(self.headers.get("Content-Length", "0"))
      raw = self.rfile.read(length)
      payload = json.loads(raw.decode("utf-8") if raw else "{}")
    except json.JSONDecodeError:
      return self._send_json({"error": "Invalid JSON"}, status=400)

    if path == "/api/pick":
      try:
        query = str(payload.get("query", "")).strip()
        raw_segments = payload.get("segments")
        seg_list = raw_segments if isinstance(raw_segments, list) else None
        result = pick_products(query, get_products(), segments=seg_list)
        status = 200 if result.get("ok") else 400
        return self._send_json(result, status=status)
      except Exception as error:
        return self._send_json({"ok": False, "error": str(error), "items": []}, status=500)

    if path != "/api/products":
      return self._send_json({"error": "Not found"}, status=404)
    try:
      products = payload.get("products", [])
      if not isinstance(products, list):
        return self._send_json({"error": "products must be an array"}, status=400)
      normalized = normalize_rows(products)
      normalized = [enrich_product(row) for row in normalized]
      replace_products(normalized)
      return self._send_json({"ok": True, "count": len(normalized)})
    except Exception as error:
      return self._send_json({"error": str(error)}, status=500)


def ensure_seed_if_empty():
  conn = connect_db()
  n = conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]
  conn.close()
  if n > 0:
    return
  seed_path = os.path.join(_ROOT, "catalog_seed.json")
  if not os.path.isfile(seed_path):
    return
  with open(seed_path, encoding="utf-8") as f:
    data = json.load(f)
  if not isinstance(data, list) or not data:
    return
  rows = normalize_rows(data)
  if rows:
    replace_products(rows)


def main():
  os.chdir(_ROOT)
  init_db()
  ensure_seed_if_empty()
  server = ThreadingHTTPServer((HOST, PORT), ApiHandler)
  print(f"Server running on http://{HOST}:{PORT}")
  server.serve_forever()


if __name__ == "__main__":
  main()
