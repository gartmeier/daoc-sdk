-- Undo of bot-looks-tiara.sql: Niamh's black wizard hat back, the tiara template removed. Run it only while the gameserver is stopped.
START TRANSACTION;
UPDATE inventory SET ITemplate_Id = 't24_mentalist_21_hat', Color = 74 WHERE Inventory_ID = 'bdbdeb93-646a-41ac-a3df-a8ba7532d337' AND ITemplate_Id = 't24_mentalist_21_tiara';
DELETE FROM itemtemplate WHERE Id_nb = 't24_mentalist_21_tiara';
COMMIT;
