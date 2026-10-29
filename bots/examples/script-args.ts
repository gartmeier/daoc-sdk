// Positional arguments of a bot script, minus the bot name when argv carries one.
//
// runScript (sdk/runner.ts loadEnvFromArgs) picks the bot in this order:
//   1. BOT_USERNAME + PASSWORD already in the environment (bun --env-file=...)
//   2. a bot.env next to the script (bots/<name>/x.ts)
//   3. the first positional argument (bun bots/examples/x.ts <name>)
// Only in case 3 is argv[0] the bot name. So the same script works as
//   bun bots/examples/grinder.ts mybot 60     and     bun bots/mybot/grinder.ts 60
//
// Import it as '../examples/script-args' so a copy in bots/<name>/ still resolves.

import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';

export interface ScriptArgsOptions {
    argv?: string[];
    env?: Record<string, string | undefined>;
    /** Whether a file exists (for tests). */
    exists?: (path: string) => boolean;
}

/** The positional (non `-` prefixed) arguments after the bot name, if the bot name came from argv. */
export function scriptArgs(options: ScriptArgsOptions = {}): string[] {
    const argv = options.argv ?? process.argv;
    const env = options.env ?? process.env;
    const exists = options.exists ?? existsSync;
    const positional = argv.slice(2).filter(a => !a.startsWith('-'));
    if (env.BOT_USERNAME && env.PASSWORD) return positional;
    const script = argv[1];
    if (script && exists(join(dirname(resolve(script)), 'bot.env'))) return positional;
    return positional.slice(1);
}
