/*
Purpose: Create a local sample database with related tables, a view, and representative SQLite values.
*/
import sqlite3 from 'sqlite3';
import { mkdir, access } from 'node:fs/promises';
const target = 'examples/sample.sqlite';
await mkdir('examples', { recursive: true });
try { await access(target); throw new Error(`${target} already exists. Move it before generating another sample.`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const db = new sqlite3.Database(target);
await new Promise((resolve, reject) => db.exec(`
PRAGMA foreign_keys=ON;
BEGIN;
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, active INTEGER NOT NULL DEFAULT 1, notes TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), amount REAL NOT NULL CHECK(amount >= 0), created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE values_demo (id INTEGER PRIMARY KEY, integer_value INTEGER, real_value REAL, empty_text TEXT, nullable_text TEXT, payload BLOB, label TEXT GENERATED ALWAYS AS ('Row ' || id) VIRTUAL);
CREATE VIEW user_totals AS SELECT users.id, users.name, COUNT(orders.id) AS orders, COALESCE(SUM(orders.amount),0) AS total FROM users LEFT JOIN orders ON orders.user_id=users.id GROUP BY users.id;
INSERT INTO users(name,email,notes) VALUES ('Alice','alice@example.com','Multiline' || char(10) || 'notes'),('Bob','bob@example.com',NULL),('Carol',NULL,'Unicode: 你好');
INSERT INTO orders(user_id,amount) VALUES (1,29.95),(1,100),(2,15.5);
INSERT INTO values_demo VALUES (1,9223372036854775807,3.14159,'',NULL,X'000102FF'),(2,-9223372036854775808,0,'NULL','',NULL);
COMMIT;
`, error => error ? reject(error) : resolve()));
await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
console.log(`Created ${target}`);
