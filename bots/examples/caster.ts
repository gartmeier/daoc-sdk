// Kill one monster with spells: self-buff, nuke from range, melee to finish.
//
//   bun bots/examples/caster.ts <bot> [name-pattern]
//   bun bots/<bot>/caster.ts [name-pattern]                     (a copy next to bot.env)
//   MCP: execute_code({ bot_name, script: 'bots/examples/caster.ts', args: { pattern: 'skeleton' } })
//
// For casters (Mage, Elementalist, Cabalist, Magician, Mystic, Seer, ...).
// When no mob is in view it walks toward a spawn point but stops about
// 0.85 x spell range short of it, so the first cast starts from range.
// Melee interrupts casting, so after two interrupts the bot finishes in melee;
// level-1 casters rarely outlast a mob that reaches them (no kiting helper yet).

import { runScript, type ScriptContext } from '../../sdk/runner';
import { findNpcSpawns } from '../../data/index';
import type { Spell } from '../../sdk/types';
import { scriptArgs } from '../examples/script-args';

const DAMAGE = /^(DirectDamage|Bolt|DamageOverTime|Lifedrain|DirectDamageWithDebuff)$/;
const BUFF = /Buff|Shield|Absorb|DamageAdd/;
/** Stand this far inside the range: more room than castSpell's own approach leaves (the smaller of 10 % or 150), for a mob's first steps. */
const STANDOFF = 0.85;
/** castSpell reasons that end the casting loop instead of retrying it. */
const STOP_CASTING = new Set(['no_power', 'not_found', 'spell_not_found', 'no_target', 'invalid_target', 'died', 'dead']);

interface Args { pattern?: string }

const main = async ({ bot, sdk, args = {} }: ScriptContext & { args?: Args }) => {
    const pattern = args.pattern;
    if (bot.isDead()) await bot.releaseAndRespawn();
    const spells = sdk.getSkills().spells;
    const info = (sp: Spell) => bot.getSpellInfo(sp);
    const byLevel = (a: Spell, b: Spell) => b.level - a.level;
    const nuke = spells.filter(sp => DAMAGE.test(info(sp)?.type ?? '') && info(sp)?.target === 'Enemy').sort(byLevel)[0];
    if (!nuke) return { why: `no damage spell; known: ${spells.map(s => s.name).join(', ') || 'none'}` };
    console.log(`nuke: ${nuke.name} (${info(nuke)?.type}, range ${info(nuke)?.range}, ${info(nuke)?.power} power)`);

    // Self buffs that are not already running.
    for (const sp of spells.filter(sp => info(sp)?.target === 'Self' && BUFF.test(info(sp)?.type ?? ''))) {
        if (sdk.findEffect(sp.name)) continue;
        const b = await bot.castSpell(sp);
        console.log(`buff ${sp.name}: ${b.message}`);
    }

    const range = info(nuke)?.range || 1500;
    const filter = { pattern: pattern ? new RegExp(pattern, 'i') : undefined, radius: Math.max(3000, range) };
    let mob = bot.findKillableNpc(filter);
    if (!mob) {
        const me = sdk.getPlayer()!;
        const spawn = findNpcSpawns({ name: filter.pattern, regionId: me.regionId, near: me, radius: 10_000, levelRange: [0, me.level], realm: 0 })
            .find(s => s.classType === 'GameNPC' && !(s.flags & 0x10));
        if (spawn) {
            // Stop short of the camp on the line towards it: walking into it starts the fight in melee range.
            const d = Math.hypot(spawn.x - me.x, spawn.y - me.y);
            const standoff = STANDOFF * range;
            console.log(`walking ${Math.round(Math.max(0, d - standoff))} units towards a ${spawn.name} spawn (stopping ${Math.round(standoff)} short)`);
            if (d > standoff) {
                const f = (d - standoff) / d;
                await bot.walkTo(Math.round(me.x + (spawn.x - me.x) * f), Math.round(me.y + (spawn.y - me.y) * f), { tolerance: 100 });
            }
            mob = bot.findKillableNpc(filter);
        }
    }
    if (!mob) return { why: `no killable NPC within ${filter.radius} units` };
    console.log(`target: ${mob.name} (level ${mob.level}) ${Math.round(mob.distance)} units away`);

    const xp0 = sdk.getPlayer()!.experience;
    const level0 = sdk.getPlayer()!.level;
    // Evidence of the kill: the server's death event for this mob (a mob that
    // merely walks out of view is not a kill).
    const event0 = Math.max(0, ...(sdk.getState()?.combatEvents ?? []).map(e => e.id));
    let mobDied = false;
    const offState = sdk.onStateUpdate(s => {
        if (s.combatEvents.some(e => e.id > event0 && e.kind === 'death' && e.targetObjectId === mob.objectId)) mobDied = true;
    });
    const alive = () => !mobDied && (sdk.getNearbyNpc(mob.objectId)?.healthPercent ?? 0) > 0;
    let casts = 0, damage = 0, interrupts = 0;
    const deadline = Date.now() + 60_000;
    try {
        while (Date.now() < deadline && alive() && !bot.isDead()) {
            const c = await bot.castSpell(nuke, mob.objectId);
            if (c.success) {
                casts++;
                damage += c.damage;
                interrupts = 0;
                console.log(`  ${c.message}, ${mob.name} at ${sdk.getNearbyNpc(mob.objectId)?.healthPercent ?? 0}%`);
                continue;
            }
            console.log(`  ${c.reason}: ${c.message}`);
            if (c.reason === 'interrupted' || c.reason === 'must_wait') {
                // must_wait is the cooldown after an interrupt, not another one.
                if (c.reason === 'interrupted' && ++interrupts >= 2) break;
                await Bun.sleep(c.retryAfterMs ?? 2000);
                continue;
            }
            // Nothing a retry fixes: out of power, the target is gone (no_target: castSpell
            // already re-selected it once), or we died mid-cast. Melee/respawn handling follows.
            if (STOP_CASTING.has(c.reason ?? '')) break;
            await Bun.sleep(1000);
        }

        let finishedInMelee = false;
        let meleeKill = false;
        if (alive() && !bot.isDead()) {
            console.log('finishing in melee');
            finishedInMelee = true;
            const k = await bot.killNpc(mob.objectId);
            meleeKill = k.killed;
            console.log(`  ${k.message}`);
        }
        // Death, xp and loot messages trail the death event slightly.
        if (mobDied) await Bun.sleep(800);
        if (bot.isDead()) {
            const rel = await bot.releaseAndRespawn();
            return { killed: false, died: true, casts, damage, respawn: rel.message };
        }
        const p = sdk.getPlayer()!;
        const xp = p.level === level0 ? p.experience - xp0 : null;
        const rest = p.healthPercent < 80 || p.manaPercent < 60 ? await bot.rest({ healthPercent: 80, manaPercent: 80 }) : null;
        return {
            killed: mobDied || meleeKill,
            casts, spellDamage: damage, finishedInMelee,
            xp: xp ?? `level ${level0} -> ${p.level}`,
            rest: rest?.message,
        };
    } finally {
        offState();
    }
};

export default main;

if (import.meta.main) {
    const [pattern] = scriptArgs();
    await runScript(main, { args: { pattern }, timeout: 180_000 });
}
