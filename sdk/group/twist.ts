// A fight with a twist: while the fight behaviour swings, instant songs go out in turn. The fight holds its turn for a whole
// kill (up to 90 s), so song() gets no turn there and this keeps its own clock, which ends with the fight's turn. The raw send
// is what song() does while swinging: castSpell would select us and the swing would lose its target.

import type { Behavior, MemberContext } from './member';
import { nextTwist, SONG_SETTINGS, type SongSettings, type TwistSettings } from './songs';

/** How often the clock looks; everyMs paces the songs. */
const LOOK_MS = 250;

export function twistTurn<S extends { songs?: SongSettings }>(ctx: MemberContext<S>, twist: TwistSettings): void {
    const now = Date.now();
    const me = ctx.me();
    if (ctx.orders().phase !== 'engage' || !me.attacking || ctx.bot.isDead()) return;
    const last: { name: string; at: number } | undefined = ctx.memory.get('songCast');
    if (last && now - last.at < twist.everyMs) return;
    const sentAt: Map<string, number> = ctx.memory.get('twistSent') ?? new Map();
    ctx.memory.set('twistSent', sentAt);
    const low = me.endurancePercent < (ctx.settings.songs ?? SONG_SETTINGS).enduranceBelow;
    const want = nextTwist(ctx.spells.songs(), last?.name ?? null, sentAt, now, twist.order, low);
    if (!want) return;
    sentAt.set(want.spell.name, now);
    // Shared with song(), so neither sends what the other has just sent, which would stop it.
    ctx.memory.set('songCast', { name: want.spell.name, at: now });
    const sent = want.spell.skillIndex !== undefined ? ctx.sdk.sendUseSkill(want.spell.skillIndex) : ctx.sdk.sendCastSpell(want.spell.lineIndex, want.spell.spellIndex);
    void sent.catch(() => {});
}

/** `fight`, with a twist while it runs. It keeps the fight's name, so a role's list takes it as its fight. */
export function twisting<S extends { songs?: SongSettings }>(fight: Behavior<S>, twist: TwistSettings): Behavior<S> {
    return {
        ...fight,
        async run(ctx) {
            const clock = setInterval(() => twistTurn(ctx, twist), LOOK_MS);
            try {
                return await fight.run(ctx);
            } finally {
                clearInterval(clock);
            }
        },
    };
}
