-- Bot looks: a tiara for Niamh in place of her black wizard hat (the user's wish, 2026-11-14). Undo: bot-looks-tiara-undo.sql.
-- Model 538 is the client's 'Tiarra - Celt/Elf' (gamedata.mpk/items.csv, hce_hat06), the tiara made for Niamh's race (Elf). Left undyed.
-- Written 2026-11-14 from the live DB: one new item template (a copy of t24_mentalist_21) and one inventory row (Niamh's helm, slot 21).
-- Run it only while the gameserver is stopped (it caches item templates and inventories):
--   docker compose -f server/docker/docker-compose.yml exec -T db mariadb -uroot -pdaoc-sdk opendaoc < docs/bot-looks-tiara.sql
START TRANSACTION;
DROP TEMPORARY TABLE IF EXISTS tt; CREATE TEMPORARY TABLE tt AS SELECT * FROM itemtemplate WHERE Id_nb = 't24_mentalist_21';
UPDATE tt SET Id_nb = 't24_mentalist_21_tiara', ItemTemplate_ID = UUID(), Model = 538;
INSERT INTO itemtemplate SELECT * FROM tt;
UPDATE inventory SET ITemplate_Id = 't24_mentalist_21_tiara', Color = 0 WHERE Inventory_ID = 'bdbdeb93-646a-41ac-a3df-a8ba7532d337' AND ITemplate_Id = 't24_mentalist_21_hat';
COMMIT;
