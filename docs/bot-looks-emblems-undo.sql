-- Undo of bot-looks-emblems.sql: the emblems as bot-looks.sql set them.
-- Generated 2026-11-14T08:59:25.757Z from the live DB. Run it only while the gameserver is stopped (it caches guilds and inventories):
--   docker compose -f server/docker/docker-compose.yml exec -T db mariadb -uroot -pdaoc-sdk opendaoc < docs/<this file>
-- Each guild's emblem keeps its pattern and colours; only the logo id changes. 9 guilds, 86 inventory rows (cloaks and shields).
START TRANSACTION;
UPDATE inventory SET Emblem = 29932 WHERE Emblem = 72428;
UPDATE guild SET Emblem = 29932 WHERE GuildName = 'The Copper Knights' AND Emblem = 72428;
UPDATE inventory SET Emblem = 15115 WHERE Emblem = 15115;
UPDATE guild SET Emblem = 15115 WHERE GuildName = 'Knights of the Ninth Hour' AND Emblem = 15115;
UPDATE inventory SET Emblem = 37891 WHERE Emblem = 105987;
UPDATE guild SET Emblem = 37891 WHERE GuildName = 'Order of the Brass Lion' AND Emblem = 105987;
UPDATE inventory SET Emblem = 31402 WHERE Emblem = 99498;
UPDATE guild SET Emblem = 31402 WHERE GuildName = 'Einherjar' AND Emblem = 99498;
UPDATE inventory SET Emblem = 18800 WHERE Emblem = 39280;
UPDATE guild SET Emblem = 18800 WHERE GuildName = 'Iron Ravens' AND Emblem = 39280;
UPDATE inventory SET Emblem = 13878 WHERE Emblem = 34358;
UPDATE guild SET Emblem = 13878 WHERE GuildName = 'Mimirs Well' AND Emblem = 34358;
UPDATE inventory SET Emblem = 39624 WHERE Emblem = 127176;
UPDATE guild SET Emblem = 39624 WHERE GuildName = 'Silver Hand' AND Emblem = 127176;
UPDATE inventory SET Emblem = 20305 WHERE Emblem = 61265;
UPDATE guild SET Emblem = 20305 WHERE GuildName = 'Fianna' AND Emblem = 61265;
UPDATE inventory SET Emblem = 23068 WHERE Emblem = 78364;
UPDATE guild SET Emblem = 23068 WHERE GuildName = 'The Cauldron' AND Emblem = 78364;
COMMIT;
