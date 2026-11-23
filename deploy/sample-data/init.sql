-- Graphan sample database: sales + infrastructure metrics.
-- Raw tables store data relative to load time; views shift timestamps so the newest
-- row is always "now", keeping the sample dashboards populated indefinitely.

CREATE TABLE regions (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  country text NOT NULL,
  lat double precision NOT NULL,
  lon double precision NOT NULL
);

INSERT INTO regions (name, country, lat, lon) VALUES
  ('North America East', 'US', 40.71, -74.00),
  ('North America West', 'US', 37.77, -122.42),
  ('South America', 'BR', -23.55, -46.63),
  ('Western Europe', 'DE', 50.11, 8.68),
  ('Northern Europe', 'SE', 59.33, 18.07),
  ('Middle East', 'AE', 25.20, 55.27),
  ('India', 'IN', 17.39, 78.49),
  ('Southeast Asia', 'SG', 1.35, 103.82),
  ('East Asia', 'JP', 35.68, 139.69),
  ('Oceania', 'AU', -33.87, 151.21),
  ('Africa', 'ZA', -26.20, 28.05);

CREATE TABLE products (
  id serial PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,
  price numeric(10,2) NOT NULL
);

INSERT INTO products (name, category, price)
SELECT p.name, p.category, p.price FROM (VALUES
  ('Laptop Pro 14', 'Electronics', 1899), ('Laptop Air 13', 'Electronics', 1199), ('4K Monitor', 'Electronics', 449),
  ('Noise-cancelling Headphones', 'Electronics', 299), ('Smartphone X', 'Electronics', 999), ('Tablet 11', 'Electronics', 649),
  ('Ergonomic Chair', 'Furniture', 529), ('Standing Desk', 'Furniture', 799), ('Bookshelf', 'Furniture', 189), ('Desk Lamp', 'Furniture', 59),
  ('Cloud Backup (yr)', 'Software', 99), ('Office Suite (yr)', 'Software', 129), ('Antivirus (yr)', 'Software', 49), ('Design Tool (yr)', 'Software', 239),
  ('Coffee Beans 1kg', 'Grocery', 24), ('Green Tea 500g', 'Grocery', 18), ('Protein Bars (24)', 'Grocery', 36),
  ('Running Shoes', 'Apparel', 139), ('Rain Jacket', 'Apparel', 179), ('Merino Sweater', 'Apparel', 119)
) AS p(name, category, price);

CREATE TABLE customers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  segment text NOT NULL,
  region_id int NOT NULL REFERENCES regions(id),
  created_at timestamptz NOT NULL
);

INSERT INTO customers (name, segment, region_id, created_at)
SELECT 'Customer ' || lpad(g::text, 4, '0'),
       (ARRAY['Enterprise','SMB','Consumer','Public Sector'])[1 + (g % 4)],
       1 + (g % 11),
       now() - (random() * interval '365 days')
FROM generate_series(1, 2000) g;

CREATE TABLE orders_raw (
  id bigserial PRIMARY KEY,
  customer_id int NOT NULL REFERENCES customers(id),
  region_id int NOT NULL REFERENCES regions(id),
  product_id int NOT NULL REFERENCES products(id),
  quantity int NOT NULL,
  amount numeric(12,2) NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL
);

INSERT INTO orders_raw (customer_id, region_id, product_id, quantity, amount, status, created_at)
SELECT c.id, c.region_id, p.id, q.qty, round((p.price * q.qty * (0.85 + random() * 0.3))::numeric, 2),
       (ARRAY['delivered','delivered','delivered','delivered','shipped','processing','cancelled','returned'])[1 + floor(random() * 8)::int],
       -- weekly seasonality + growth trend
       now() - (power(random(), 1.15) * interval '90 days')
FROM generate_series(1, 60000) g
JOIN LATERAL (SELECT 1 + floor(random() * 2000)::int AS cid, 1 + floor(random() * 20)::int AS pid, 1 + floor(random() * 4)::int AS qty, g AS gg) q ON true
JOIN customers c ON c.id = q.cid
JOIN products p ON p.id = q.pid;

CREATE INDEX ON orders_raw (created_at);
CREATE INDEX ON orders_raw (region_id);

CREATE TABLE server_metrics_raw (
  ts timestamptz NOT NULL,
  host text NOT NULL,
  cpu double precision NOT NULL,
  memory double precision NOT NULL,
  latency_ms double precision NOT NULL,
  errors int NOT NULL
);

INSERT INTO server_metrics_raw (ts, host, cpu, memory, latency_ms, errors)
SELECT t,
       h,
       LEAST(100, GREATEST(1, 35 + 25 * sin(extract(epoch FROM t) / 3600 / 24 * 2 * pi()) + (hashtext(h) % 15) + random() * 20)),
       LEAST(100, GREATEST(5, 55 + (hashtext(h) % 20) + random() * 15)),
       GREATEST(5, 80 + random() * 120 + CASE WHEN random() < 0.02 THEN 400 ELSE 0 END),
       CASE WHEN random() < 0.1 THEN floor(random() * 12)::int ELSE 0 END
FROM generate_series(now() - interval '14 days', now(), interval '1 minute') t
CROSS JOIN unnest(ARRAY['api-01','api-02','api-03','worker-01','worker-02','db-primary']) h;

CREATE INDEX ON server_metrics_raw (ts);

-- Time-shifted views (what dashboards query)
CREATE VIEW orders AS
  SELECT o.id, o.customer_id, o.region_id, o.product_id, o.quantity, o.amount, o.status,
         o.created_at + (now() - (SELECT max(created_at) FROM orders_raw)) AS created_at
  FROM orders_raw o;

CREATE VIEW server_metrics AS
  SELECT m.ts + (now() - (SELECT max(ts) FROM server_metrics_raw)) AS ts, m.host, m.cpu, m.memory, m.latency_ms, m.errors
  FROM server_metrics_raw m;

ANALYZE;

-- Read-only role used by Graphan
CREATE ROLE sample_reader LOGIN PASSWORD 'sample_reader';
GRANT CONNECT ON DATABASE sample TO sample_reader;
GRANT USAGE ON SCHEMA public TO sample_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO sample_reader;
ALTER ROLE sample_reader SET default_transaction_read_only = on;
