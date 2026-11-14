-- Bot looks: the guild emblems with the logo ids the client means (gamedata.mpk/insignia.csv). Undo: bot-looks-emblems-undo.sql.
-- Generated 2026-11-14T08:59:25.757Z from the live DB. Run it only while the gameserver is stopped (it caches guilds and inventories):
--   docker compose -f server/docker/docker-compose.yml exec -T db mariadb -uroot -pdaoc-sdk opendaoc < docs/<this file>
-- Each guild's emblem keeps its pattern and colours; only the logo id changes. 9 guilds, 86 inventory rows (cloaks and shields).
START TRANSACTION;
-- The Copper Knights: knight's helm, B_emblem_058.dds = logo 141 (was 58); 11 items
UPDATE inventory SET Emblem = 72428 WHERE Emblem = 29932;
UPDATE guild SET Emblem = 72428 WHERE GuildName = 'The Copper Knights' AND Emblem = 29932;
-- Knights of the Ninth Hour: crossed torches, B_emblem_029.dds = logo 29 (was 29); 12 items
UPDATE inventory SET Emblem = 15115 WHERE Emblem = 15115;
UPDATE guild SET Emblem = 15115 WHERE GuildName = 'Knights of the Ninth Hour' AND Emblem = 15115;
-- Order of the Brass Lion: lion rampant, B_emblem_074.dds = logo 207 (was 74); 6 items
UPDATE inventory SET Emblem = 105987 WHERE Emblem = 37891;
UPDATE guild SET Emblem = 105987 WHERE GuildName = 'Order of the Brass Lion' AND Emblem = 37891;
-- Einherjar: horned helm, N_emblem_061.dds = logo 194 (was 61); 14 items
UPDATE inventory SET Emblem = 99498 WHERE Emblem = 31402;
UPDATE guild SET Emblem = 99498 WHERE GuildName = 'Einherjar' AND Emblem = 31402;
-- Iron Ravens: raven's head, N_emblem_036.dds = logo 76 (was 36); 10 items
UPDATE inventory SET Emblem = 39280 WHERE Emblem = 18800;
UPDATE guild SET Emblem = 39280 WHERE GuildName = 'Iron Ravens' AND Emblem = 18800;
-- Mimirs Well: Odin's eye, N_emblem_027.dds = logo 67 (was 27); 6 items
UPDATE inventory SET Emblem = 34358 WHERE Emblem = 13878;
UPDATE guild SET Emblem = 34358 WHERE GuildName = 'Mimirs Well' AND Emblem = 13878;
-- Silver Hand: hands and heart, H_emblem_077.dds = logo 248 (was 77); 12 items
UPDATE inventory SET Emblem = 127176 WHERE Emblem = 39624;
UPDATE guild SET Emblem = 127176 WHERE GuildName = 'Silver Hand' AND Emblem = 39624;
-- Fianna: stag, H_emblem_039.dds = logo 119 (was 39); 9 items
UPDATE inventory SET Emblem = 61265 WHERE Emblem = 20305;
UPDATE guild SET Emblem = 61265 WHERE GuildName = 'Fianna' AND Emblem = 20305;
-- The Cauldron: cauldron, H_emblem_045.dds = logo 153 (was 45); 6 items
UPDATE inventory SET Emblem = 78364 WHERE Emblem = 23068;
UPDATE guild SET Emblem = 78364 WHERE GuildName = 'The Cauldron' AND Emblem = 23068;
COMMIT;
