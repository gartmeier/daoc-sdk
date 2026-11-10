import { describe, expect, test } from 'bun:test';
import { formGroup } from './roster';
import type { Member } from './member';

/** Bots in in-game groups as the server keeps them: each group a list, its leader first. */
function world(groups: string[][]) {
    const groupOf = (n: string) => groups.find(g => g.includes(n));
    const leave = (n: string) => { const g = groupOf(n); if (!g) return; g.splice(g.indexOf(n), 1); if (g.length < 2) g.length = 0; };
    let pending: ((ok: boolean) => void) | null = null;
    const member = (n: string): Member => ({
        bot: n.toLowerCase(),
        sdk: {
            getPlayer: () => ({ name: n }),
            getGroup: () => (groupOf(n) ?? []).map(name => ({ name })),
            sendCommand: async (c: string) => { if (c === '/disband') leave(n); },
            waitForCondition: async () => true,
        },
        actions: {
            acceptGroupInvite: () => new Promise(r => { pending = ok => r({ success: ok, message: ok ? 'joined' : 'No group invite arrived' }); }),
            invite: async (who: string) => {
                const g = groupOf(n);
                if (g && g[0] !== n) { pending?.(false); return { success: false, message: 'You are not the leader of your group.' }; }
                if (groupOf(who)) { pending?.(false); return { success: false, message: 'already in a group' }; }
                if (g) g.push(who); else groups.push([n, who]);
                pending?.(true);
                return { success: true, message: 'invited' };
            },
        },
    } as unknown as Member);
    return { member, groups };
}

describe('formGroup', () => {
    test("a leader in a group someone else leads leaves it, and everyone joins the leader's", async () => {
        // Round 127: Fionn led, sat out and left; Ciaran got the lead; Cuchulainn now leads the line-up, Lugh and Oisin come in.
        const w = world([['Ciaran', 'Cuchulainn', 'Brigid']]);
        const ms = ['Ciaran', 'Cuchulainn', 'Brigid', 'Lugh', 'Oisin'].map(w.member);
        const lines = await formGroup(ms, 'cuchulainn');
        expect(lines[0]).toContain("left Ciaran's group");
        const g = w.groups.find(x => x.includes('Cuchulainn'))!;
        expect(g[0]).toBe('Cuchulainn');
        expect([...g].sort()).toEqual(['Brigid', 'Ciaran', 'Cuchulainn', 'Lugh', 'Oisin']);
    }, 30_000);

    test('a leader who already leads keeps its group', async () => {
        const w = world([['Cuchulainn', 'Ciaran']]);
        const lines = await formGroup(['Cuchulainn', 'Ciaran', 'Brigid'].map(w.member), 'cuchulainn');
        expect(lines.some(l => l.includes('left'))).toBe(false);
        expect(w.groups.find(x => x.includes('Cuchulainn'))).toEqual(['Cuchulainn', 'Ciaran', 'Brigid']);
    }, 30_000);
});
