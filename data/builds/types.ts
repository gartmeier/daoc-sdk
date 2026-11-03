// What a character spends its spec points on. Every character owns its build in bots/<bot>/build.ts; this
// folder holds researched builds to choose one from, one file per class. A line is always named by its
// KeyName (getClass(name).specializations): Shields, Light, Mana, Void, not Shield or Light Magic.

/** Where a character wants its lines by this level. */
export interface BuildTarget {
    level: number;
    /** KeyName to spec level, listed in buying order: the rule raises the first line still under its number (rule.ts). */
    specs: Record<string, number>;
}

/** What bots/<bot>/build.ts default-exports, with `satisfies Build`. */
export interface Build {
    className: string;
    name: string;
    /** Ascending in level, and a later target never lowers a line. One more target pins a step between two others. */
    targets: BuildTarget[];
}

export interface BuildSource {
    url: string;
    title: string;
    /** Which server and patch the source writes about. "excerpt" here: its numbers were seen only in a search excerpt. */
    era: string;
    /** What it says that this build uses. */
    says: string;
    /** How and when the page was checked. */
    checked?: string;
}

/** A researched build, to choose from before a bot starts. No guide covers level 24, so nothing here is one guide's whole build. */
export interface CatalogBuild {
    name: string;
    role: string;
    /** Why this build, where its numbers come from and the spells and styles they reach. */
    why: string;
    /**
     * The buying plan in words. The rule follows the listed order of the targets, so at a target's level the two
     * agree, and on the way there a plan that alternates between lines happens only with more targets.
     */
    order: string;
    /** adapted: a guide gives the build's numbers or shape, fitted to this server. derived: the numbers are ours. */
    basis: 'adapted' | 'derived';
    targets: BuildTarget[];
    sources: BuildSource[];
}

export interface ClassBuilds {
    className: string;
    notes: string;
    builds: CatalogBuild[];
}
