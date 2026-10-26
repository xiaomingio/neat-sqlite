/*
Purpose: Demonstrate SQLite queries against sample-workbench.sqlite. Execute one statement at a time.
*/

-- Pagination: orders has 12,000 rows, or 60 pages at 200 rows per page.
SELECT COUNT(*) AS order_count FROM orders;

-- Boundary markers make it easy to recognize page changes in the Data tab.
SELECT id, customer_id, status, notes
FROM orders
WHERE id IN (1, 200, 201, 400, 401, 12000)
ORDER BY id;

-- JOIN: customers, orders, generated line totals, and a read-only view.
SELECT t.id, t.customer_name, t.status, t.item_count, t.total_cents
FROM order_totals t
WHERE t.status = 'shipped'
ORDER BY t.total_cents DESC, t.id
LIMIT 25;

-- GROUP BY: compare customers by committed spending.
SELECT country, COUNT(*) AS customers, SUM(total_cents) AS total_cents
FROM customer_totals
GROUP BY country
ORDER BY total_cents DESC;

-- CTE and a window function: rank products inside each category.
WITH revenue AS (
  SELECT p.id, p.name, c.name AS category, SUM(i.line_total_cents) AS revenue_cents
  FROM products p
  JOIN categories c ON c.id = p.category_id
  JOIN order_items i ON i.product_id = p.id
  GROUP BY p.id
)
SELECT name, category, revenue_cents,
  DENSE_RANK() OVER (PARTITION BY category ORDER BY revenue_cents DESC) AS category_rank
FROM revenue
ORDER BY category, category_rank;

-- Exact integers, NULL, empty text, BLOBs, and generated fields.
SELECT id, label, integer_value, typeof(integer_value) AS storage_type,
  text_value, typeof(text_value) AS text_storage, length(payload) AS blob_bytes,
  display_label
FROM values_demo
ORDER BY id;

-- JSON: inspect preferences without modifying the data.
SELECT id, name, json_extract(preferences, '$.tier') AS tier
FROM customers
WHERE json_extract(preferences, '$.newsletter') = 1
ORDER BY id
LIMIT 20;

-- Composite primary keys in a WITHOUT ROWID table.
SELECT product_id, warehouse, quantity
FROM inventory
WHERE product_id BETWEEN 1 AND 5
ORDER BY product_id, warehouse;

-- Trigger output: editing an order's status produces another audit record on save.
SELECT a.id, a.order_id, a.old_status, a.new_status, a.changed_at
FROM audit_log a
ORDER BY a.id DESC;
