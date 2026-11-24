-- v3: sync events carry the resolved project ids. Applied once, tracked in schema_version.
ALTER TABLE sync_events ADD COLUMN projects TEXT;
INSERT INTO schema_version (version, at) VALUES (1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
