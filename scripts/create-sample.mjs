/*
Purpose: Generate a reproducible SQLite workbench with related business data, many pages, and typed edge cases.
*/
import sqlite3 from 'sqlite3';
import { mkdir, open, unlink } from 'node:fs/promises';

const target = 'examples/sample-workbench.sqlite';
await mkdir('examples', { recursive: true });
let reserved;
try { reserved = await open(target, 'wx'); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log(`Preserved ${target}. Rename or remove it to generate a fresh workbench.`);
  process.exit(0);
}
await reserved.close();
const db = await new Promise((resolve, reject) => {
  const connection = new sqlite3.Database(target, error => error ? reject(error) : resolve(connection));
});
const exec = sql => new Promise((resolve, reject) => db.exec(sql, error => error ? reject(error) : resolve()));
const all = sql => new Promise((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
const close = () => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
try {
  await exec(`
    PRAGMA foreign_keys = ON;
    BEGIN;
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      country TEXT NOT NULL DEFAULT 'US',
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
      notes TEXT,
      preferences TEXT NOT NULL DEFAULT '{"newsletter":false}' CHECK(json_valid(preferences))
    );
    CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      sku TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
      description TEXT
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'paid', 'shipped', 'cancelled')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      shipping_country TEXT NOT NULL,
      notes TEXT
    );
    CREATE INDEX orders_customer_date ON orders(customer_id, created_at DESC);
    CREATE INDEX orders_status ON orders(status);
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity BETWEEN 1 AND 100),
      unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents >= 0),
      line_total_cents INTEGER GENERATED ALWAYS AS (quantity * unit_price_cents) STORED,
      UNIQUE(order_id, product_id)
    );
    CREATE INDEX order_items_product ON order_items(product_id);
    CREATE TABLE inventory (
      product_id INTEGER NOT NULL REFERENCES products(id),
      warehouse TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(product_id, warehouse)
    ) WITHOUT ROWID;
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      old_status TEXT,
      new_status TEXT,
      changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TRIGGER orders_status_audit AFTER UPDATE OF status ON orders
    WHEN OLD.status IS NOT NEW.status
    BEGIN
      INSERT INTO audit_log(order_id, old_status, new_status) VALUES (NEW.id, OLD.status, NEW.status);
    END;
    CREATE TABLE values_demo (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      integer_value INTEGER,
      real_value REAL,
      text_value TEXT,
      json_value TEXT CHECK(json_value IS NULL OR json_valid(json_value)),
      payload BLOB,
      display_label TEXT GENERATED ALWAYS AS (id || ': ' || label) VIRTUAL
    );
    CREATE TABLE import_contacts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      age INTEGER CHECK(age IS NULL OR age BETWEEN 0 AND 130),
      balance REAL NOT NULL DEFAULT 0 CHECK(balance >= 0),
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
    );
    CREATE TABLE scratch_notes (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE VIEW order_totals AS
      SELECT o.id, o.customer_id, c.name AS customer_name, o.status, o.created_at,
        COUNT(i.id) AS item_count, COALESCE(SUM(i.line_total_cents), 0) AS total_cents
      FROM orders o JOIN customers c ON c.id = o.customer_id
      LEFT JOIN order_items i ON i.order_id = o.id GROUP BY o.id;
    CREATE VIEW customer_totals AS
      SELECT c.id, c.name, c.email, c.country, COUNT(t.id) AS order_count,
        COALESCE(SUM(t.total_cents), 0) AS total_cents
      FROM customers c LEFT JOIN order_totals t ON t.customer_id = c.id GROUP BY c.id;
    CREATE VIEW schema_objects AS
      SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name;

    WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 500)
    INSERT INTO customers(id, name, email, country, active, notes, preferences)
    SELECT n,
      CASE n WHEN 1 THEN 'Alice Chen' WHEN 2 THEN 'Bob Martin' WHEN 3 THEN 'Carol García'
        WHEN 4 THEN '李小明' WHEN 5 THEN 'Amina Hassan' ELSE printf('Customer %04d', n) END,
      printf('customer%04d@example.com', n),
      CASE n % 6 WHEN 0 THEN 'US' WHEN 1 THEN 'CN' WHEN 2 THEN 'DE' WHEN 3 THEN 'ES' WHEN 4 THEN 'JP' ELSE 'GB' END,
      n % 9 != 0,
      CASE n % 5 WHEN 0 THEN NULL WHEN 1 THEN '' WHEN 2 THEN 'Line one' || char(10) || 'Line two'
        WHEN 3 THEN 'Follow up: 你好 · café · 東京' ELSE 'VIP, prefers "email"' END,
      json_object('newsletter', json(CASE WHEN n % 2 = 0 THEN 'true' ELSE 'false' END), 'tier', CASE n % 3 WHEN 0 THEN 'gold' ELSE 'standard' END)
    FROM numbers;
    INSERT INTO categories(name) VALUES ('Books'), ('Electronics'), ('Home'), ('Office'), ('Outdoors'), ('Clothing'), ('Food'), ('Art');
    WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 80)
    INSERT INTO products(id, category_id, sku, name, price_cents, description)
    SELECT n, (n - 1) % 8 + 1, printf('SKU-%04d', n), printf('Product %03d', n), 299 + n * 137,
      CASE n % 3 WHEN 0 THEN NULL WHEN 1 THEN 'Compact, durable, and recyclable.' ELSE 'Specification' || char(10) || 'Size: 25 × 30 cm' END
    FROM numbers;
    WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 12000)
    INSERT INTO orders(id, customer_id, status, created_at, shipping_country, notes)
    SELECT n, (n - 1) % 500 + 1,
      CASE n % 4 WHEN 0 THEN 'pending' WHEN 1 THEN 'paid' WHEN 2 THEN 'shipped' ELSE 'cancelled' END,
      datetime('2025-01-01', '+' || (n % 365) || ' days', '+' || (n % 86400) || ' seconds'),
      CASE n % 6 WHEN 0 THEN 'US' WHEN 1 THEN 'CN' WHEN 2 THEN 'DE' WHEN 3 THEN 'ES' WHEN 4 THEN 'JP' ELSE 'GB' END,
      CASE WHEN n IN (1, 200, 201, 400, 401, 12000) THEN 'Pagination marker: order ' || n
        WHEN n % 11 = 0 THEN 'Gift order' WHEN n % 7 = 0 THEN '' ELSE NULL END
    FROM numbers;
    INSERT INTO order_items(order_id, product_id, quantity, unit_price_cents)
    SELECT o.id, p.id, o.id % 4 + 1, p.price_cents FROM orders o JOIN products p ON p.id = (o.id - 1) % 80 + 1;
    INSERT INTO order_items(order_id, product_id, quantity, unit_price_cents)
    SELECT o.id, p.id, o.id % 3 + 1, p.price_cents FROM orders o JOIN products p ON p.id = (o.id + 18) % 80 + 1;
    INSERT INTO inventory(product_id, warehouse, quantity, updated_at)
    SELECT id, 'east', id * 3, '2026-01-01 09:00:00' FROM products;
    INSERT INTO inventory(product_id, warehouse, quantity, updated_at)
    SELECT id, 'west', id * 2, '2026-01-01 09:00:00' FROM products;
    INSERT INTO values_demo(id, label, integer_value, real_value, text_value, json_value, payload) VALUES
      (1, 'Largest signed integer', 9223372036854775807, 3.141592653589793, '', '{"kind":"integer","valid":true}', X'000102FF'),
      (2, 'Smallest signed integer', -9223372036854775808, -0.125, NULL, NULL, NULL),
      (3, 'Text NULL is text', 9007199254740993, 1.0e100, 'NULL', '{"items":[1,2,3],"message":"你好"}', X''),
      (4, 'Whitespace', 0, 0.0, ' ' || char(9) || char(10) || char(160), '{}', NULL),
      (5, 'Quotes and multiline', 42, 12.5, 'Comma, quote "here"' || char(10) || 'Second line', '{"nested":{"enabled":false}}', X'89504E47'),
      (6, 'Unicode and emoji', 123, 0.000001, '你好 · café · 東京 · 🗃️', '["alpha","beta"]', NULL);
    INSERT INTO scratch_notes(title, body) VALUES
      ('Try staged editing', 'Edit this note and a customer, switch tables, then save both together with Ctrl/Cmd+S.'),
      ('Try NULL and empty text', NULL),
      ('Try long text', 'This record is safe to duplicate and edit.' || char(10) || 'Use record details for multiline text and JSON in other tables.');
    UPDATE orders SET status = 'shipped' WHERE id = 1;
    COMMIT;
    ANALYZE;
  `);
  const integrity = await all('PRAGMA integrity_check');
  const foreignKeys = await all('PRAGMA foreign_key_check');
  if (integrity[0]?.integrity_check !== 'ok' || foreignKeys.length) throw new Error('Sample integrity checks failed.');
  const counts = await all('SELECT (SELECT COUNT(*) FROM customers) AS customers, (SELECT COUNT(*) FROM orders) AS orders, (SELECT COUNT(*) FROM order_items) AS order_items');
  await close();
  console.log(`Created ${target}: ${JSON.stringify(counts[0])}. Open orders to try pagination; see examples/README.md.`);
} catch (error) {
  await close().catch(() => undefined);
  await unlink(target).catch(() => undefined);
  throw error;
}
