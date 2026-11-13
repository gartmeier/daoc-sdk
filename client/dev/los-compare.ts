// A real client's line-of-sight answers (0xD0, from a tcpdump capture) against ours (sdk/vision.ts clientLineOfSight with the
// occluders), for one player: where it stood (its 0xA9 positions) and what the server's NPC packets (0xDA) showed. Prints the
// agreement per checker kind and every disagreement with a wall caster or roof archer.
//
//   bun client/dev/los-compare.ts <capture.pcap> [clientPort=45238] [gamePort=10300] [regionId=252]
//
// The player is the id the NPCs checked most as their target (0xA9 carries no object id). Moving NPCs (pets, fighters) are placed
// at their last spot in the capture, so their disagreements are mostly that; static guards (wall casters, roof archers) are exact.
// 2026-11-13, the user's Faste raid as Niamh: Runemasters 733 of 739 and Hunters 262 of 266 agree, the rest in the gateway.
import { readFileSync } from 'fs';
import { clientStreams, losAnswers, npcsShown } from './los-capture';
import { clientLineOfSight } from '../../sdk/vision';
const file = process.argv[2]!;
const clientPort = process.argv[3] ?? '45238';
const gamePort = Number(process.argv[4] ?? 10300);
const regionId = Number(process.argv[5] ?? 252);
const pcap = new Uint8Array(readFileSync(file));
const toServer = clientStreams(pcap, gamePort);
const fromServer = clientStreams(pcap, gamePort, true);
const client = [...toServer.keys()].find(k => k.endsWith(`:${clientPort}`))!;
const chunks = toServer.get(client)!;
const answers = losAnswers(client, chunks);
const npcs = npcsShown(fromServer.get(client) ?? fromServer.get([...fromServer.keys()][0]!)!);
// Niamh's own positions over time (0xA9 frames): x, y, z float32 LE, objectId at 22.
const pos: { t: number; x: number; y: number; z: number; oid: number }[] = [];
{ let buf = new Uint8Array(0); let t = 0;
  for (const c of chunks) { const nb = new Uint8Array(buf.length + c.data.length); nb.set(buf); nb.set(c.data, buf.length); buf = nb; t = c.t;
    while (buf.length >= 12) { const n = (buf[0]! << 8) | buf[1]!; if (buf.length < n + 12) break; const code = buf[9]!;
      if (code === 0xa9 && n >= 24) { const p = buf.subarray(10, 10 + n); const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
        pos.push({ t, x: dv.getFloat32(0, true), y: dv.getFloat32(4, true), z: dv.getFloat32(8, true), oid: dv.getUint16(22, false) }); }
      buf = buf.subarray(n + 12); } } }
const counts = new Map<number, number>();
for (const a of answers) if (npcs.has(a.checker)) counts.set(a.target, (counts.get(a.target) ?? 0) + 1);
const me = [...counts].sort((x, y) => y[1] - x[1])[0]![0];
console.log('answers', answers.length, 'positions', pos.length, 'my oid', me, 'npcs named', npcs.size);
const at = (t: number) => { let best = pos[0]!; for (const p of pos) { if (p.t <= t) best = p; else break; } return best; };
const los = clientLineOfSight('full')!;
let agree = 0, disagree = 0; const bad: string[] = []; const byKind: Record<string, [number, number]> = {};
for (const a of answers) {
  const meAt = at(a.t);
  const other = a.checker === me ? npcs.get(a.target) : a.target === me ? npcs.get(a.checker) : null;
  if (!other || !meAt) continue;
  const from = a.checker === me ? { x: meAt.x, y: meAt.y, z: meAt.z } : other;
  const to = a.checker === me ? other : { x: meAt.x, y: meAt.y, z: meAt.z };
  const ours = los(regionId, from, to);
  const key = `${other.name}${a.checker === me ? ' (me→it)' : ' (it→me)'}`;
  byKind[key] ??= [0, 0];
  if (ours === a.clear) { agree++; byKind[key]![0]++; } else { disagree++; byKind[key]![1]++; if (/Runemaster|Hunter/.test(other.name)) bad.push(`${a.t.toFixed(1)}s ${key} real ${a.clear ? 'clear' : 'BLOCKED'} ours ${ours ? 'clear' : 'BLOCKED'} me (${Math.round(meAt.x)}, ${Math.round(meAt.y)}, ${Math.round(meAt.z)}) it (${other.x}, ${other.y}, ${other.z})`); }
}
console.log('agree', agree, 'disagree', disagree);
for (const [k, [a, d]] of Object.entries(byKind)) console.log(' ', k, 'agree', a, 'disagree', d);
for (const b of bad) console.log(b);
