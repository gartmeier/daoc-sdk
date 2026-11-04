// The names of a specialization line. The DB gives each line a key and a display name, and on four
// lines a class trains they differ (specialization.sql). Which one you get depends on where you read it:
//
//   key:      classes.json, getStylesFor, Style.specName, ItemBonus.spec, and /train (train.cs:57-66)
//   display:  getSkills().specializations, getTrainer().specs, the server's chat lines
//
// Items call some lines something else again (language/EN/SkillHandler.txt). No imports: BotSDK
// reads these tables without loading the generated data. spec-names.test.ts checks them against the DB.

const DISPLAY_BY_KEY: ReadonlyMap<string, string> = new Map([
    ['Shields', 'Shield'], ['Light', 'Light Magic'], ['Mana', 'Mana Magic'], ['Void', 'Void Magic'],
]);

/** The bonus's name where classes.json calls the specialization something else (SkillBase m_specToSkill, m_specToFocus). */
const KEY_BY_BONUS: Readonly<Record<string, string>> = {
    Crossbow: 'Crossbows', Longbow: 'Longbows', 'Recurved Bow': 'Recurve Bow', Throwing: 'Thrown Weapons', Smiting: 'Smite',
    Enchantment: 'Enchantments', 'Cave Magic': 'Subterranean', Arboreal: 'Arboreal Path', Verdant: 'Verdant Path',
};

const KEY_BY_NAME = new Map<string, string>([
    ...Object.entries(KEY_BY_BONUS).map(([bonus, key]): [string, string] => [bonus.toLowerCase(), key]),
    ...[...DISPLAY_BY_KEY].flatMap(([key, display]): [string, string][] => [[key.toLowerCase(), key], [display.toLowerCase(), key]]),
]);

/** The line's DB key, from any of its names in any case. A name that isn't in these tables comes back as given. */
export const specKey = (name: string): string => KEY_BY_NAME.get(name.toLowerCase()) ?? name;

/** The name the skill list and the trainer window show, from any of the line's names. */
export const specDisplayName = (name: string): string => {
    const key = specKey(name);
    return DISPLAY_BY_KEY.get(key) ?? key;
};
