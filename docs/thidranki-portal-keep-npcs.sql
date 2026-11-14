-- Thidranki's three portal keeps (region 252) get a healer, a potion merchant and a poison merchant each,
-- and lose their training dummies (saved in docs/thidranki-pk-dummies.sql). See docs/thidranki-potion-vendor.md.
-- Rerunnable: it deletes what it adds first. The new NPCs appear on the next gameserver start.
--   docker compose -f server/docker/docker-compose.yml exec -T db mariadb -uroot -pdaoc-sdk opendaoc < docs/thidranki-portal-keep-npcs.sql

-- Merchant lists ------------------------------------------------------------------------------------------

DELETE FROM merchantitem WHERE ItemListID IN ('ThidPotionsAlb', 'ThidPotionsMid', 'ThidPotionsHib', 'ThidPoisonsAlb', 'ThidPoisonsMid', 'ThidPoisonsHib');

-- Level-20 endurance and power potions, instant and over time, in each realm's own version ('', '2', '3').
INSERT INTO merchantitem (ItemListID, ItemTemplateID, PageNumber, SlotPosition, LastTimeRowUpdated, MerchantItem_ID)
SELECT CONCAT('ThidPotions', r.name), CONCAT(p.id, r.suffix), 0, p.slot, NOW(), CONCAT('thid-potions-', LOWER(r.name), '-', p.slot)
FROM (SELECT 'Alb' AS name, '' AS suffix UNION ALL SELECT 'Mid', '2' UNION ALL SELECT 'Hib', '3') r
CROSS JOIN (SELECT 0 AS slot, 'Draught_of_Endurance' AS id UNION ALL SELECT 1, 'Draught_of_Invigoration'
            UNION ALL SELECT 2, 'Draught_of_Power' UNION ALL SELECT 3, 'Draught_of_Replenishment') p;

-- Every poison the realms' poison merchants sell, in each realm's own version: page 0 levels 1-22, page 1 levels
-- 23-50, in HibPoison2's order (that list has both pages; Albion splits them over Onyg and Melannon).
INSERT INTO merchantitem (ItemListID, ItemTemplateID, PageNumber, SlotPosition, LastTimeRowUpdated, MerchantItem_ID)
SELECT CONCAT('ThidPoisons', r.name), CONCAT(m.ItemTemplateID, r.suffix), m.PageNumber, m.SlotPosition, NOW(),
       CONCAT('thid-poisons-', LOWER(r.name), '-', m.PageNumber, '-', m.SlotPosition)
FROM (SELECT 'Alb' AS name, '' AS suffix UNION ALL SELECT 'Mid', '2' UNION ALL SELECT 'Hib', '3') r
CROSS JOIN merchantitem m WHERE m.ItemListID = 'HibPoison2';

-- NPCs: copies of each realm's own healer, potion merchant and poison merchant, along a wall of the keep's yard
-- the way Druim Ligen's merchants stand: 85-150 from the wall's inner face, 180-270 apart, nothing overhead (no
-- stairs), seen from the keep's centre where a release in the battleground lands, away from the gates, facing
-- into the yard. Peace flag (16) on all.

DELETE FROM mob WHERE Mob_ID LIKE 'thid-pk-%';

CREATE TEMPORARY TABLE thid_npc LIKE mob;
INSERT INTO thid_npc SELECT m.* FROM mob m WHERE m.Mob_ID IN (
  '4b88d3f4-72c3-4354-b29b-615166a1c6f5', -- Sister Ellayne, healer, Castle Sauvage
  'c55184df-f0fb-4247-9d99-9be50680a523', -- Hagdar, healer, Svasud Faste
  '870ceb8b-3635-4118-9602-9a584e0cfdec', -- Ilyana, healer, Druim Ligen
  '3005bf9f-10ac-4c4e-b931-32e42418ff23', -- Sabine, potion merchant, region 165
  '702a057c-be85-41c3-a86e-56d38af3443f', -- Salazo, potion merchant, region 165
  'bfe3b5be-24fc-4f78-946c-0242ee50eedf', -- Yoria, potion merchant, region 165
  'b283112c-3a11-4b5e-85a9-34f4b5bc14b4', -- Onyg, poison merchant, Castle Sauvage
  'b6c29d73-2c44-48c0-b762-35321f090d62', -- Svewn, poison merchant, Svasud Faste
  '26d35fd3-5b3f-4c19-aad6-a5165a9956cf'  -- Riber, poison merchant, Druim Ligen
);

CREATE TEMPORARY TABLE thid_place (src VARCHAR(255), id VARCHAR(255), x INT, y INT, z INT, heading INT, items VARCHAR(255));
INSERT INTO thid_place VALUES
  -- Albion Portal Keep, centre (37301, 52362, 3946). North-east corner of the yard, away from the gates (west):
  -- potions 117-136 from the north wall, poisons and healer about 136 from the east wall.
  ('4b88d3f4-72c3-4354-b29b-615166a1c6f5', 'thid-pk-alb-healer',  37601, 52962, 3946, 1024, NULL),
  ('3005bf9f-10ac-4c4e-b931-32e42418ff23', 'thid-pk-alb-potions', 37351, 53262, 3946, 2389, 'ThidPotionsAlb'),
  ('b283112c-3a11-4b5e-85a9-34f4b5bc14b4', 'thid-pk-alb-poisons', 37601, 53162, 3946,  910, 'ThidPoisonsAlb'),
  -- Midgard Portal Keep, centre (54053, 24680, 4323). Along the east wall, away from the gates (north-west), about
  -- 140-150 from it (the yard is smaller, so they stand about 500 from the centre).
  ('c55184df-f0fb-4247-9d99-9be50680a523', 'thid-pk-mid-healer',  54403, 24980, 4323, 1593, NULL),
  ('702a057c-be85-41c3-a86e-56d38af3443f', 'thid-pk-mid-potions', 54553, 24630, 4323, 1250, 'ThidPotionsMid'),
  ('b6c29d73-2c44-48c0-b762-35321f090d62', 'thid-pk-mid-poisons', 54503, 24830, 4323, 1138, 'ThidPoisonsMid'),
  -- Hibernia Portal Keep, centre (18362, 18257, 4323). Along the north-west wall instead, spaced like Druim Ligen's
  -- merchants: potions where the user's Niamh stood (145 from the wall), poisons on the north wall (105), the healer
  -- 180 east of them (100), clear of both stairs (south-west along the wall is under the stairs).
  ('870ceb8b-3635-4118-9602-9a584e0cfdec', 'thid-pk-hib-healer',  18280, 19110, 4323, 2048, NULL),
  ('bfe3b5be-24fc-4f78-946c-0242ee50eedf', 'thid-pk-hib-potions', 17901, 18994, 4326, 2443, 'ThidPotionsHib'),
  ('26d35fd3-5b3f-4c19-aad6-a5165a9956cf', 'thid-pk-hib-poisons', 18100, 19120, 4323, 2048, 'ThidPoisonsHib');

INSERT INTO mob
SELECT t.ClassType, t.TranslationId, t.Name, t.Suffix, t.Guild, t.ExamineArticle, t.MessageArticle,
       p.x, p.y, p.z, t.Speed, p.heading, 252, t.Model, t.Size,
       t.Strength, t.Constitution, t.Dexterity, t.Quickness, t.Intelligence, t.Piety, t.Empathy, t.Charisma,
       t.Level, t.Realm, t.EquipmentTemplateID, COALESCE(p.items, t.ItemsListTemplateID), t.NPCTemplateID, t.Race, t.Flags | 16,
       t.AggroLevel, t.AggroRange, t.MeleeDamageType, t.RespawnInterval, t.FactionID, t.BodyType, t.HouseNumber,
       t.Brain, '', t.OwnerID, 0, t.IsCloakHoodUp, t.Gender, NULL, t.VisibleWeaponSlots, NOW(), p.id
FROM thid_place p JOIN thid_npc t ON t.Mob_ID = p.src;

DROP TEMPORARY TABLE thid_place;
DROP TEMPORARY TABLE thid_npc;

-- Training dummies: 3 DPS and 2 hitback dummies in each portal keep, saved in docs/thidranki-pk-dummies.sql.
DELETE FROM mob WHERE Region = 252 AND ClassType IN ('DOL.GS.HitbackDummy', 'DOL.GS.DPSDummy');
