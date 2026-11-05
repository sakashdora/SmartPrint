-- Read-only census of a SmartPrint database. Run it against a RESTORED SNAPSHOT or a Neon branch, never
-- as a habit against the live database:  psql "$CENSUS_DATABASE_URL" -f scripts/census.sql
-- Nothing here writes. It answers the questions Phase 2 (organizations backfill) depends on.
SET search_path = smartprint, public;
SET default_transaction_read_only = on;

SELECT 'users by role' AS what, role AS key, status, COUNT(*) AS n FROM users GROUP BY role, status ORDER BY 2, 3;
SELECT 'shops by status' AS what, status AS key, COUNT(*) AS n FROM shops GROUP BY status ORDER BY 2;
SELECT 'shops without an owner row' AS what, COUNT(*) AS n FROM shops s LEFT JOIN users u ON u.id = s.owner_id WHERE u.id IS NULL;
SELECT 'duplicate e-mails differing only by case' AS what, COUNT(*) AS n FROM (SELECT lower(email) FROM users GROUP BY lower(email) HAVING COUNT(*) > 1) d;
SELECT 'orders by status' AS what, status AS key, payment, COUNT(*) AS n FROM orders GROUP BY status, payment ORDER BY 2, 3;
SELECT 'orders per shop (top 10)' AS what, s.slug AS key, COUNT(*) AS n FROM orders o JOIN shops s ON s.id = o.shop_id GROUP BY s.slug ORDER BY n DESC LIMIT 10;
SELECT 'documents (count, MiB)' AS what, COUNT(*) AS n, ROUND(COALESCE(SUM(OCTET_LENGTH(payload)), 0) / 1048576.0, 1) AS mib FROM documents;
SELECT 'documents not referenced by any order or quote' AS what, COUNT(*) AS n FROM documents d
  WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.document_id = d.id) AND NOT EXISTS (SELECT 1 FROM quotes q WHERE q.document_id = d.id);
SELECT 'documents of expired quotes with no order (cleanup candidates)' AS what, COUNT(*) AS n FROM documents d
  WHERE EXISTS (SELECT 1 FROM quotes q WHERE q.document_id = d.id)
    AND NOT EXISTS (SELECT 1 FROM quotes q WHERE q.document_id = d.id AND q.expires > to_char(now() - interval '5 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.document_id = d.id);
SELECT 'devices' AS what, active, COUNT(*) AS n FROM devices GROUP BY active;
SELECT 'orders without an order_history row' AS what, COUNT(*) AS n FROM orders o WHERE NOT EXISTS (SELECT 1 FROM order_history h WHERE h.order_id = o.id);
SELECT 'leases in non-final state' AS what, state AS key, COUNT(*) AS n FROM print_leases GROUP BY state;
SELECT 'table sizes (rows)' AS what, 'quotes' AS key, COUNT(*) AS n FROM quotes
UNION ALL SELECT 'table sizes (rows)', 'notifications', COUNT(*) FROM notifications
UNION ALL SELECT 'table sizes (rows)', 'audit', COUNT(*) FROM audit
UNION ALL SELECT 'table sizes (rows)', 'idempotency_keys', COUNT(*) FROM idempotency_keys
UNION ALL SELECT 'table sizes (rows)', 'payment_events', COUNT(*) FROM payment_events
UNION ALL SELECT 'table sizes (rows)', 'rate_limits', COUNT(*) FROM rate_limits
UNION ALL SELECT 'table sizes (rows)', 'sessions', COUNT(*) FROM sessions;
SELECT 'devices.paused column present' AS what, COUNT(*) AS n FROM information_schema.columns WHERE table_schema = 'smartprint' AND table_name = 'devices' AND column_name IN ('paused', 'paused_note');
SELECT 'schema_migrations' AS what, id AS key, applied FROM schema_migrations ORDER BY id;
