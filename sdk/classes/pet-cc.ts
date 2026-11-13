// A pet off crowd control, for the kits whose pets the group's petControl leaves alone (a turret, a shade's servant). On the side tick:
//  - the pet's own target under crowd control (holding, assigned, or a mezz on its way): passive, which stops a shot or swing;
//  - crowd control newly on an enemy within the pet's reach: passive too, though the pet isn't on it. Passive wipes the pet's list of what
//    it has been fighting (ControlledMobBrain.Disengage), and a defensive pet takes its next target off that list after each kill, at once,
//    before any side tick sees it. In the frozen window (2026-11-13) that broke 10 mezzes and roots in 7 sorties for Etain's turret, and 2
//    in 7 for Morgause's servant, though both went passive the moment they shot one;
//  - then, the focus clean and in reach, an attack order on it: the pet keeps its damage, its list holding the focus alone.
// learnings/classes/animist.md and necromancer.md have the runs.

import { ccHolds, claimedBy, type TacticsSettings } from '../group/behaviors';
import { isAlive } from '../group/blackboard';
import { dist } from '../group/battleground';
import type { Behavior, MemberContext } from '../group/member';
import type { Contact } from '../group/types';
import { focusToHit, waiting } from './summoner';

/** A mezz cast at it by another member this recently still counts as on its way. */
const CC_CLAIM_MS = 4000;
/** No second wipe within this. */
export const WIPE_MS = 1500;

/** Crowd control on it that holds, assigned to it, or being cast at it by another member: a hit from the pet would break it. */
export function ccOnIt(ctx: MemberContext, c: Contact): boolean {
    return ccHolds(ctx, c) || ctx.orders().cc.some(a => a.targetId === c.objectId) || claimedBy(ctx, 'cc', c.objectId, CC_CLAIM_MS).length > 0;
}

/** The ids in `now` that weren't in `before`. */
export function newlyHeld(before: readonly number[], now: readonly number[]): number[] {
    const was = new Set(before);
    return now.filter(id => !was.has(id));
}

/**
 * What the side tick does: nothing; passive (the list wiped); or passive and then the focus. Its own target held always acts;
 * crowd control newly near only when the pet isn't `busy` (a servant's 3 s cast half, which passive would end), and it stays new till then.
 */
export function offCcPlan(s: { targetHeld: boolean; fresh: boolean; busy: boolean; focusInReach: boolean }): 'none' | 'passive' | 'passive+focus' {
    if (!s.targetHeld && (!s.fresh || s.busy)) return 'none';
    return s.focusInReach ? 'passive+focus' : 'passive';
}

export interface PetOffCcOptions {
    name: string;
    /** Crowd control on an enemy within this of the pet wipes its list. */
    reach: number;
    /** The focus within this of the pet gets the order after the wipe. */
    focusReach: number;
    /** And within this of us (a servant's order needs its owner within 2000 of the target). */
    ownerReach?: number;
    /** Skip a wipe for crowd control near while this holds; the pet's own target held still acts. */
    busy?: (ctx: MemberContext) => boolean;
    /** Only while this holds (a shade, ...). */
    when?: (ctx: MemberContext) => boolean;
}

export const petOffCc = (o: PetOffCcOptions): Behavior<TacticsSettings> => ({
    name: o.name,
    side: true,
    interruptible: false,
    async run(ctx) {
        const petState = ctx.sdk.getPetState();
        const pet = petState ? ctx.sdk.getPet() : null;
        if (!petState || !pet || (o.when && !o.when(ctx))) return false;
        const me = ctx.me();
        const held = ctx.picture().contacts
            .filter(c => !c.stale && isAlive(c) && c.regionId === me.regionId && dist(c, pet) <= o.reach && ccOnIt(ctx, c))
            .map(c => c.objectId);
        const before: number[] = ctx.memory.get(`${o.name}Held`) ?? [];
        if (petState.aggression === 'passive') {
            ctx.memory.set(`${o.name}Held`, held);
            return false;
        }
        const now = Date.now();
        if (waiting(ctx.memory, `${o.name}At`, now - WIPE_MS)) return false;
        const onIt = ctx.contact(petState.targetObjectId);
        const go = focusToHit(ctx);
        const focus = go && !ccOnIt(ctx, go.mob) && dist(pet, go.seen) <= o.focusReach && go.seen.distance <= (o.ownerReach ?? Infinity) ? go : null;
        const busy = !!o.busy?.(ctx);
        const plan = offCcPlan({ targetHeld: !!onIt && ccOnIt(ctx, onIt), fresh: newlyHeld(before, held).length > 0, busy, focusInReach: !!focus });
        if (plan === 'none') {
            if (!busy) ctx.memory.set(`${o.name}Held`, held);
            return false;
        }
        ctx.memory.set(`${o.name}Held`, held);
        ctx.memory.set(`${o.name}At`, now);
        await ctx.sdk.sendPetCommand('passive');
        if (plan === 'passive+focus') await ctx.sdk.sendPetCommand('attack', focus!.mob.objectId);
        return false;
    },
});
