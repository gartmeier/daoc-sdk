// bots/<name>/bot.env → DaocClient + GatewayBridge (shared by runner.ts and swarm.ts).

import { readFileSync } from 'node:fs';
import { deriveGatewayUrl, findBotEnv, parseEnvFile, REPO_ROOT } from '../sdk/index';
import { validateCharacter } from '../data/index';
import { DaocClient, defaultCharName } from './client';
import { GatewayBridge, type BridgeOptions } from './bridge';
import { defaultClass, defaultRace } from './session';
import { realmName, realmNumber } from './model/classes';
import { moverGround } from '../sdk/ground';
import { clientLineOfSight, describeClientLos } from '../sdk/vision';

export interface BotConfig {
    botName: string;
    username: string;
    password: string;
    charName: string;
    realm: 'albion' | 'midgard' | 'hibernia';
    className: string;
    raceName: string;
    /** 0 male, 1 female (resolved by validateCharacter when GENDER is unset). */
    gender: number;
    host: string;
    port: number;
    gatewayUrl: string;
    showChat: boolean;
    warnings: string[];
}

export class BotConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BotConfigError';
    }
}

/** Parse SERVER (host[:port], default 127.0.0.1:10300). */
export function parseServer(server: string | undefined): { host: string; port: number } {
    const s = (server ?? '').trim();
    if (!s) return { host: '127.0.0.1', port: 10300 };
    const m = s.match(/^\[?([^\]]+?)\]?(?::(\d+))?$/);
    if (!m?.[1]) throw new BotConfigError(`bad SERVER '${s}' (expected host:port)`);
    const port = m[2] ? Number(m[2]) : 10300;
    if (!(port > 0 && port < 65536)) throw new BotConfigError(`bad SERVER port in '${s}'`);
    return { host: m[1], port };
}

/** Build and validate a bot config from bot.env keys (see docs/DESIGN.md). */
export function botConfigFromEnv(botName: string, env: Record<string, string>): BotConfig {
    const username = env.BOT_USERNAME || botName;
    const password = env.PASSWORD;
    if (!/^[a-zA-Z0-9]+$/.test(username)) throw new BotConfigError(`BOT_USERNAME '${username}' must be letters and digits only`);
    if (!password) throw new BotConfigError('PASSWORD is not set');
    const charName = env.CHAR_NAME || defaultCharName(username);
    if (!/^[A-Z][a-zA-Z]{2,}$/.test(charName)) {
        throw new BotConfigError(`CHAR_NAME '${charName}' must match ^[A-Z][a-zA-Z]+$ with at least 3 letters`);
    }
    let realm: 1 | 2 | 3;
    try {
        realm = realmNumber(env.REALM || 'albion');
    } catch (e) {
        throw new BotConfigError((e as Error).message);
    }
    const className = env.CLASS || defaultClass(realm);
    const raceName = env.RACE || defaultRace(realm);
    const g = (env.GENDER ?? '').trim().toLowerCase();
    let gender: 'male' | 'female' | undefined;
    if (g === 'male' || g === 'm' || g === '0') gender = 'male';
    else if (g === 'female' || g === 'f' || g === '1') gender = 'female';
    else if (g) throw new BotConfigError(`GENDER '${env.GENDER}' must be male or female`);
    const v = validateCharacter({ realm, class: className, race: raceName, gender });
    if (!v.valid) throw new BotConfigError(`invalid character in bot.env: ${v.errors.join('; ')}`);
    const { host, port } = parseServer(env.SERVER);
    return {
        botName, username, password, charName,
        realm: realmName(realm) as BotConfig['realm'],
        className: v.classInfo?.name ?? className,
        raceName: v.raceInfo?.name ?? raceName,
        gender: v.gender === 'female' ? 1 : 0,
        host, port,
        gatewayUrl: deriveGatewayUrl(env.GATEWAY_URL),
        showChat: (env.SHOW_CHAT ?? 'true').toLowerCase() !== 'false',
        warnings: v.warnings,
    };
}

/** Read bots/<botName>/bot.env (cwd first, then the repo root). */
export function loadBotConfig(botName: string, repoRoot: string = REPO_ROOT): BotConfig {
    const path = findBotEnv(botName, repoRoot);
    if (!path) throw new BotConfigError(`no bots/${botName}/bot.env (create it with: bun bots/create-bot.ts ${botName})`);
    return botConfigFromEnv(botName, parseEnvFile(readFileSync(path, 'utf-8')));
}

export interface BotBridge {
    config: BotConfig;
    client: DaocClient;
    bridge: GatewayBridge;
}

/** One logged-out DaocClient plus its gateway bridge; call bridge.run() to start. */
export function createBotBridge(config: BotConfig, opts: Partial<BridgeOptions> & { trace?: boolean } = {}): BotBridge {
    const log = opts.log ?? ((msg: string) => console.log(`[${config.botName}] ${msg}`));
    const lineOfSight = clientLineOfSight();
    log(describeClientLos());
    const client = new DaocClient({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        charName: config.charName,
        realm: config.realm,
        className: config.className,
        raceName: config.raceName,
        gender: config.gender,
        createIfMissing: true,
        log: msg => log(`[client] ${msg}`),
        trace: opts.trace,
        ground: moverGround(),
        lineOfSight,
    });
    const bridge = new GatewayBridge(client, {
        gatewayUrl: config.gatewayUrl,
        username: config.username,
        password: config.password,
        showChat: config.showChat,
        ...opts,
        log,
    });
    for (const w of config.warnings) log(`WARNING: ${w}`);
    return { config, client, bridge };
}
