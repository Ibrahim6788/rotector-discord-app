/*
 * RotectorFlags — Vencord userplugin
 *
 * Aggregates safety status across every Rayward-provided source that supports
 * Discord lookups (Rotector, TASE, ServerSweep, Okappiki) and shows one
 * combined icon next to a username: grey check = clear everywhere, red ! =
 * flagged by 2+ corroborating servers, yellow ? = flagged but seen in only 1
 * server. Hover lists which companies flagged/cleared the account; clicking
 * opens a modal with one section per company (full reasons/evidence, scan
 * timestamps, and a manual refresh button), plus — when the account has any
 * linked Roblox accounts on record — a further breakdown of each linked
 * Roblox account across all five Roblox-capable sources (Rotector, TASE,
 * ServerSweep, Okappiki, RAB), each with its own full flagType range,
 * reviewer info, category, and pending/provisional findings.
 *
 * Install: Vencord/src/userplugins/rotectorFlags/{index.tsx,native.ts,assets.ts}
 * then `pnpm build` && `pnpm inject`.
 *
 * --- Read before changing colors/wording ---
 * Per the Rayward API terms (same terms apply per-provider):
 *   1. Cached lookups must not be kept longer than 24h.            -> CACHE_TTL_MS
 *   2. Anything shown must be labelled with which company it's from.
 *   3. `flagType 0` (Unflagged) must NEVER be presented as "Safe".
 *   4. Only Flagged (1) and Confirmed (2) are "safe to action" —
 *      every other value is a process state, not a finding.        -> isActionable()
 *   5. No bulk/background scraping — IDs (Discord or Roblox) are only
 *      queued for lookup as they're actually rendered/opened on screen.
 *
 * --- Scope notes ---
 * - RAB has no Discord lookup endpoint (Roblox-only per its spec) — excluded
 *   from DISCORD_PROVIDERS, included in ROBLOX_PROVIDERS.
 * - Discord's flagType is restricted to 0 or 2 only across all four Discord
 *   endpoints, hence the server-count heuristic (see `serverSplit` below) to
 *   add nuance. Roblox's flagType already has the full 0–8 range with a
 *   tone per value from /v2/providers, so Roblox sections skip that
 *   heuristic entirely and just trust the provider's own classification.
 * - Each open modal can now trigger up to 4 Discord + (5 × linked Roblox
 *   accounts) batched requests — still bounded by what's actually on
 *   screen/opened, never background polling, but worth knowing for
 *   Rayward's account-wide rate limit if someone has several linked accounts.
 */

import { addProfileBadge, BadgePosition, removeProfileBadge, type ProfileBadge } from "@api/Badges";
import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { addMessageDecoration, removeMessageDecoration } from "@api/MessageDecorations";
import { addMemberListDecorator, removeMemberListDecorator } from "@api/MemberListDecorators";
import { DataStore } from "@api/index";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { closeModal, ModalCloseButton, ModalContent, ModalHeader, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { Forms, Text, Tooltip, useEffect, useState } from "@webpack/common";

import { ProviderLogos, rotectorIcon } from "./assets";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const settings = definePluginSettings({
    apiKey: {
        type: OptionType.STRING,
        description: "Rayward API key (from rayward.app), with or without the 'rwd_' prefix",
        default: "",
    },
    showInChat: {
        type: OptionType.BOOLEAN,
        description: "Show the aggregated status icon next to usernames in chat",
        default: true,
    },
    showInMemberList: {
        type: OptionType.BOOLEAN,
        description: "Show the aggregated status icon in the member list / DM list",
        default: true,
    },
    showInProfile: {
        type: OptionType.BOOLEAN,
        description: "Show a status badge on the user's profile",
        default: true,
    },
    staffList: {
        type: OptionType.STRING,
        multiline: true,
        description: "Rotector staff — one Discord user ID per line (# comments and blank lines ignored)",
        default: "",
    },
    showStaffOverrides: {
        type: OptionType.BOOLEAN,
        description: "Show the Rotector-staff badge for IDs listed in the staff file (a real flag always overrides it)",
        default: true,
    },
});

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

// RAB has no /v2/lookup/rab/discord/user endpoint (Roblox-only per its spec),
// so it's excluded from the Discord provider set below — but it's included
// in the Roblox set, where it's fully supported.
const DISCORD_PROVIDERS = ["rotector", "tase", "serversweep", "okappiki"] as const;
type ProviderId = typeof DISCORD_PROVIDERS[number];

const ROBLOX_PROVIDERS = ["rotector", "tase", "serversweep", "okappiki", "rab"] as const;
type RobloxProviderId = typeof ROBLOX_PROVIDERS[number];

const API_BASE = "https://roscoe.rayward.app";
const CACHE_STORE_KEY = "RotectorFlags_cache_v3";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // hard 24h ceiling per API terms — do not raise this
const NOT_CONFIGURED_FLAG = -1; // sentinel: no API key set, distinct from a real 0 (Unflagged) result

function authHeader() {
    const key = settings.store.apiKey?.trim();
    if (!key) return null;
    return key.startsWith("Bearer") ? key : `Bearer ${key}`;
}

function isActionable(flagType: number | undefined) {
    return flagType === 1 || flagType === 2;
}

// --- Staff override: parsed live from the `staffList` setting (a plain
// multiline textarea in the plugin's own settings page) — no file, no
// separate cache, nothing to reload. The lookup always runs as normal
// regardless of staff status — staff only changes which icon shows, and
// only when there's no real flag to show instead.

function getStaffIds(): Set<string> {
    return new Set(
        (settings.store.staffList ?? "")
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !line.startsWith("#"))
    );
}

function useIsStaff(id: string | undefined): boolean {
    if (!id || !settings.store.showStaffOverrides) return false;
    return getStaffIds().has(id);
}

// --- /v2/providers metadata (name/tone per flagType per company) -----------

interface ProviderFlagType {
    value: number;
    name: string;
    description: string;
    tone: "safe" | "pending" | "mixed" | "unsafe";
    safeToAction: boolean;
    isFlagged: boolean;
}
interface ProviderMeta {
    id: string;
    name: string;
    accentColor: string | null;
    flagTypes: ProviderFlagType[];
}

let providerMetas: ProviderMeta[] = [];

async function loadProviderMetas() {
    const authorization = authHeader();
    if (!authorization) return;
    try {
        const res = await fetch(`${API_BASE}/v2/providers?audience=api`, { headers: { Authorization: authorization } });
        const json = await res.json();
        if (json.success) providerMetas = json.data;
    } catch (e) {
        console.error("[RotectorFlags] failed to load /v2/providers", e);
    }
}

function getProviderMeta(id: string) {
    return providerMetas.find(p => p.id === id);
}

function providerDisplayName(id: AnyProviderId): string {
    return getProviderMeta(id)?.name ?? id[0].toUpperCase() + id.slice(1);
}

// --- flag lookups: one independent batching queue per provider -------------

interface FlagReasonSource { id: string; label: string; summary?: string; }
interface FlagEvidence {
    kind: string; text?: string; discordId?: string; serverId?: string; name?: string;
    category?: string; description?: string; safeName?: string; types?: string[]; tags?: string[];
    outfitId?: string | null;
    messages?: number; typing?: number; reactions?: number; vcJoins?: number;
    joinedAt?: number | null; firstSeen?: number | null; lastSeen?: number | null; leftAt?: number | null;
    verifiedLeft?: boolean; staff?: boolean; booster?: boolean;
}
interface FlagReason { type: string; title: string; sources: FlagReasonSource[]; evidence?: FlagEvidence[]; }
interface ProvisionalReason { type: string; title: string; sources: FlagReasonSource[]; } // details withheld pending human review
interface LinkedRobloxAccount {
    robloxUserId: number; robloxUsername: string; flagType: number;
    detectedAt: number; updatedAt: number; sources: number[];
}
interface FlagEntry {
    id: string;
    flagType: number;
    reasons?: FlagReason[];
    provisionalReasons?: ProvisionalReason[]; // Roblox-side only
    headerMessage?: string;
    statusLabel?: string;
    linkedRobloxAccounts?: LinkedRobloxAccount[]; // Discord-side only
    // Roblox-side only extras:
    reviewer?: { username: string; displayName: string };
    isLocked?: boolean;
    queuedAt?: number;
    processed?: boolean;
    processedAt?: number;
    lastUpdated?: number;
    category?: string;
    categoryLabel?: string;
    fetchedAt: number;
}

// Distinct Discord servers cited as evidence for a flag — drives the
// mixed/orange/red split. Not every provider gives us a serverId on its
// discordGuild evidence (ServerSweep, for one, sends structured entries
// with the ID simply omitted; Okappiki lists servers as plain `text` lines
// instead of structured evidence at all) — counting only entries with a
// serverId was silently undercounting real multi-server flags down to
// "mixed". Every entry now counts for something: by serverId when present,
// else by display name, else by exact text line, else just as itself.
function distinctServerCount(flag: FlagEntry | undefined): number {
    if (!flag?.reasons) return 0;
    const seen = new Set<string>();
    let anonymous = 0;
    for (const reason of flag.reasons) {
        for (const ev of reason.evidence ?? []) {
            if (ev.kind === "discordGuild") {
                if (ev.serverId) seen.add(`g:${ev.serverId}`);
                else if (ev.safeName || ev.name) seen.add(`g-name:${ev.safeName ?? ev.name}`);
                else anonymous++;
            } else if (ev.kind === "text" && ev.text) {
                seen.add(`t:${ev.text}`);
            }
        }
    }
    return seen.size + anonymous;
}

type LookupKind = "discord" | "roblox";
type AnyProviderId = "rotector" | "tase" | "serversweep" | "okappiki" | "rab";

// Fixed brand colors for each company's left accent bar. Hardcoded rather
// than pulled from /v2/providers' accentColor field — that metadata was
// missing/inconsistent for everything except Rotector, which is what made
// the accent bars look broken for the other three companies.
const PROVIDER_ACCENT_COLORS: Record<AnyProviderId, string> = {
    rotector: "#2474f5", // Rotector's real brand blue
    tase: "#f23f42",
    serversweep: "#e67e22",
    okappiki: "#f0d020",
    rab: "#8b5cf6",
};

class ProviderLookup {
    cache = new Map<string, FlagEntry>();
    private pending = new Set<string>();
    private inFlight = new Set<string>();
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private subscribers = new Map<string, Set<() => void>>();

    constructor(public readonly provider: AnyProviderId, public readonly kind: LookupKind) { }

    getCached(id: string): FlagEntry | undefined {
        const entry = this.cache.get(id);
        if (!entry) return undefined;
        if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) {
            this.cache.delete(id);
            return undefined;
        }
        return entry;
    }

    subscribe(id: string, cb: () => void) {
        if (!this.subscribers.has(id)) this.subscribers.set(id, new Set());
        this.subscribers.get(id)!.add(cb);
        return () => this.subscribers.get(id)?.delete(cb);
    }

    private notify(id: string) {
        this.subscribers.get(id)?.forEach(cb => cb());
    }

    queueLookup(id: string) {
        if (!id || this.getCached(id) || this.inFlight.has(id) || this.pending.has(id)) return;
        this.pending.add(id);
        if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 250);
    }

    /** Bypasses the 24h cache for one user and re-queues an immediate lookup. */
    forceRefresh(id: string) {
        this.cache.delete(id);
        this.notify(id); // flip the UI to "Checking…" right away
        this.queueLookup(id);
    }

    private async flush() {
        this.flushTimer = null;
        const ids = [...this.pending].slice(0, 100);
        if (!ids.length) return;
        ids.forEach(id => { this.pending.delete(id); this.inFlight.add(id); });

        const authorization = authHeader();
        if (!authorization) {
            const now = Date.now();
            ids.forEach(id => {
                this.inFlight.delete(id);
                this.cache.set(id, { id, flagType: NOT_CONFIGURED_FLAG, fetchedAt: now });
                this.notify(id);
            });
            return;
        }

        try {
            // Roblox IDs go over the wire as numbers per the API's schema;
            // Discord snowflakes stay strings (they can exceed safe-integer range).
            const payloadIds: (string | number)[] = this.kind === "roblox" ? ids.map(Number) : ids;
            const res = await fetch(`${API_BASE}/v2/lookup/${this.provider}/${this.kind}/user`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: authorization },
                body: JSON.stringify({ ids: payloadIds }),
            });

            if (res.status === 503) {
                // Source didn't answer — explicitly NOT "unflagged" per the terms. Don't cache.
                ids.forEach(id => this.inFlight.delete(id));
                return;
            }

            const json = await res.json();
            if (json.success) {
                const now = Date.now();
                for (const id of ids) {
                    const data = json.data[id];
                    if (!data) continue;
                    this.cache.set(id, { ...data, fetchedAt: now });
                }
                persistAllCaches();
            }
        } catch (e) {
            console.error(`[RotectorFlags] ${this.kind}/${this.provider} lookup failed`, e);
        } finally {
            ids.forEach(id => { this.inFlight.delete(id); this.notify(id); });
            if (this.pending.size) this.flushTimer = setTimeout(() => this.flush(), 250);
        }
    }
}

const discordLookups: Record<ProviderId, ProviderLookup> = Object.fromEntries(
    DISCORD_PROVIDERS.map(p => [p, new ProviderLookup(p, "discord")])
) as Record<ProviderId, ProviderLookup>;

const robloxLookups: Record<RobloxProviderId, ProviderLookup> = Object.fromEntries(
    ROBLOX_PROVIDERS.map(p => [p, new ProviderLookup(p, "roblox")])
) as Record<RobloxProviderId, ProviderLookup>;

interface CacheBlob {
    discord: Partial<Record<ProviderId, Record<string, FlagEntry>>>;
    roblox: Partial<Record<RobloxProviderId, Record<string, FlagEntry>>>;
}

async function loadAllCaches() {
    const stored = await DataStore.get<CacheBlob>(CACHE_STORE_KEY);
    if (!stored) return;
    const now = Date.now();
    for (const p of DISCORD_PROVIDERS) {
        const entries = stored.discord?.[p];
        if (!entries) continue;
        for (const [id, entry] of Object.entries(entries)) {
            if (now - entry.fetchedAt < CACHE_TTL_MS) discordLookups[p].cache.set(id, entry);
        }
    }
    for (const p of ROBLOX_PROVIDERS) {
        const entries = stored.roblox?.[p];
        if (!entries) continue;
        for (const [id, entry] of Object.entries(entries)) {
            if (now - entry.fetchedAt < CACHE_TTL_MS) robloxLookups[p].cache.set(id, entry);
        }
    }
}

function persistAllCaches() {
    const blob: CacheBlob = {
        discord: Object.fromEntries(DISCORD_PROVIDERS.map(p => [p, Object.fromEntries(discordLookups[p].cache)])),
        roblox: Object.fromEntries(ROBLOX_PROVIDERS.map(p => [p, Object.fromEntries(robloxLookups[p].cache)])),
    };
    DataStore.set(CACHE_STORE_KEY, blob);
}

function useFlags(discordId: string | undefined): Partial<Record<ProviderId, FlagEntry>> {
    const [, bump] = useState(0);

    useEffect(() => {
        if (!discordId) return;
        const unsubs = DISCORD_PROVIDERS.map(p => {
            const lookup = discordLookups[p];
            if (!lookup.getCached(discordId)) lookup.queueLookup(discordId);
            return lookup.subscribe(discordId, () => bump(n => n + 1));
        });
        return () => unsubs.forEach(u => u());
    }, [discordId]);

    if (!discordId) return {};
    const result: Partial<Record<ProviderId, FlagEntry>> = {};
    for (const p of DISCORD_PROVIDERS) result[p] = discordLookups[p].getCached(discordId);
    return result;
}

function useRobloxFlags(robloxId: string | undefined): Partial<Record<RobloxProviderId, FlagEntry>> {
    const [, bump] = useState(0);

    useEffect(() => {
        if (!robloxId) return;
        const unsubs = ROBLOX_PROVIDERS.map(p => {
            const lookup = robloxLookups[p];
            if (!lookup.getCached(robloxId)) lookup.queueLookup(robloxId);
            return lookup.subscribe(robloxId, () => bump(n => n + 1));
        });
        return () => unsubs.forEach(u => u());
    }, [robloxId]);

    if (!robloxId) return {};
    const result: Partial<Record<RobloxProviderId, FlagEntry>> = {};
    for (const p of ROBLOX_PROVIDERS) result[p] = robloxLookups[p].getCached(robloxId);
    return result;
}

// ---------------------------------------------------------------------------
// Visuals
// ---------------------------------------------------------------------------

interface FlagVisual { bg: string; fg: string; glyph: string; label: string; }

const TONE_VISUALS: Record<ProviderFlagType["tone"], Omit<FlagVisual, "glyph" | "label">> = {
    safe: { bg: "#80848e2e", fg: "#b5bac1" },
    pending: { bg: "#80848e2e", fg: "#b5bac1" },
    mixed: { bg: "#f0b2322e", fg: "#f0b232" },
    unsafe: { bg: "#f2383a2e", fg: "#f2383a" },
};
const PAST_OFFENDER: Omit<FlagVisual, "glyph" | "label"> = { bg: "#a35cff2e", fg: "#a35cff" };
// UI-only aggregate tier — not one of the API's tones. Used when 2+ companies
// each independently report a weaker "mixed" (single-server) signal: no one
// company crossed its own red threshold, but corroboration across several
// companies reads as more serious than any one of them alone.
const ORANGE_MERGE: Omit<FlagVisual, "glyph" | "label"> = { bg: "#e67e222e", fg: "#e67e22" };
const CHECKING_VISUAL: FlagVisual = { bg: "#80848e1a", fg: "#80848e", glyph: "…", label: "Checking…" };
const NOT_CONFIGURED_VISUAL: FlagVisual = { bg: "#80848e1a", fg: "#80848e", glyph: "–", label: "No API key set" };

const GLYPH_OVERRIDES: Record<number, string> = {
    0: "✓", 1: "!", 2: "!", 3: "…", 4: "?", 5: "?", 6: "✓", 8: "×",
};
const FALLBACK_NAMES: Record<number, string> = {
    0: "No flag on record", 1: "Flagged", 2: "Confirmed", 3: "Queued",
    4: "Provisional", 5: "Mixed", 6: "Past Offender", 8: "Redacted",
};

// Per-company status icon (used inside the details modal, one per section).
// `serverSplit` is Discord-only: Discord's flagType is coarse (just 0/2), so
// we lean on evidence to add nuance. Roblox's flagType is already granular
// (Queued/Provisional/Mixed/etc via each provider's own tone metadata), so
// Roblox sections call this without serverSplit and just trust that.
function getProviderVisual(providerId: AnyProviderId, flag: FlagEntry | undefined, opts: { serverSplit?: boolean; } = {}): FlagVisual {
    const flagType = flag?.flagType;
    if (flagType === undefined) return CHECKING_VISUAL;
    if (flagType === NOT_CONFIGURED_FLAG) return NOT_CONFIGURED_VISUAL;

    // Actionable (Flagged/Confirmed) accounts split further by how many
    // distinct servers back the finding: 1 server reads as "mixed" (yellow),
    // 2 servers is "orange" (independent corroboration, but still limited),
    // 3+ is a solid red flag.
    if (opts.serverSplit && isActionable(flagType)) {
        const count = distinctServerCount(flag);
        const def = getProviderMeta(providerId)?.flagTypes.find(f => f.value === flagType);
        if (count >= 3) {
            return { ...TONE_VISUALS.unsafe, glyph: "!", label: def?.name ?? "Flagged" };
        }
        if (count === 2) {
            return {
                ...ORANGE_MERGE,
                glyph: "!",
                label: def?.name ? `${def.name} — 2 servers` : "Flagged — 2 servers",
            };
        }
        return {
            ...TONE_VISUALS.mixed,
            glyph: "?",
            label: count === 1 ? "Flagged — seen in 1 server" : (def?.name ? `${def.name} — limited server evidence` : "Flagged — limited server evidence"),
        };
    }

    const def = getProviderMeta(providerId)?.flagTypes.find(f => f.value === flagType);
    const base = flagType === 6 ? PAST_OFFENDER : TONE_VISUALS[def?.tone ?? (flagType === 0 ? "safe" : isActionable(flagType) ? "unsafe" : "pending")];
    return {
        ...base,
        glyph: GLYPH_OVERRIDES[flagType] ?? "?",
        label: def?.name ?? FALLBACK_NAMES[flagType] ?? `Unknown (${flagType})`,
    };
}

// Aggregate status across every company (used for the compact inline icon).
interface Aggregate extends FlagVisual {
    flaggedBy: string[]; // 3+ servers under that company — red on its own
    orangeBy: string[]; // exactly 2 servers under that company — orange on its own
    mixedBy: string[]; // 0-1 servers — the weak "mixed" signal
    clearFrom: string[];
    pendingFrom: string[];
    notConfigured: boolean;
}
function aggregate(flags: Partial<Record<ProviderId, FlagEntry>>): Aggregate {
    const flaggedBy: string[] = [];
    const orangeBy: string[] = [];
    const mixedBy: string[] = [];
    const clearFrom: string[] = [];
    const pendingFrom: string[] = [];
    let notConfiguredCount = 0;

    for (const p of DISCORD_PROVIDERS) {
        const entry = flags[p];
        const name = providerDisplayName(p);
        if (!entry) { pendingFrom.push(name); continue; }
        if (entry.flagType === NOT_CONFIGURED_FLAG) { notConfiguredCount++; continue; }
        if (isActionable(entry.flagType)) {
            const count = distinctServerCount(entry);
            if (count >= 3) flaggedBy.push(name);
            else if (count === 2) orangeBy.push(name);
            else mixedBy.push(name);
        } else {
            clearFrom.push(name);
        }
    }

    if (notConfiguredCount === DISCORD_PROVIDERS.length) {
        return { ...NOT_CONFIGURED_VISUAL, flaggedBy, orangeBy, mixedBy, clearFrom, pendingFrom, notConfigured: true };
    }
    // Red: either a company already hit its own 3+-server threshold, or
    // corroboration is broad enough (more than 3 companies showing a flag
    // at all, any severity) that it reads as red regardless.
    if (flaggedBy.length || flaggedBy.length + orangeBy.length + mixedBy.length > 3) {
        return { ...TONE_VISUALS.unsafe, glyph: "!", label: "Flagged", flaggedBy, orangeBy, mixedBy, clearFrom, pendingFrom, notConfigured: false };
    }
    // Orange: either a single company already sits at its own 2-server
    // threshold, or 2+ companies each independently report the weaker
    // 0-1-server "mixed" signal — no one of them is damning, but agreement
    // across several is.
    if (orangeBy.length || mixedBy.length >= 2) {
        return { ...ORANGE_MERGE, glyph: "!", label: "Mixed — multiple servers/companies", flaggedBy, orangeBy, mixedBy, clearFrom, pendingFrom, notConfigured: false };
    }
    if (mixedBy.length === 1) {
        return { ...TONE_VISUALS.mixed, glyph: "?", label: "Mixed", flaggedBy, orangeBy, mixedBy, clearFrom, pendingFrom, notConfigured: false };
    }
    if (pendingFrom.length) {
        return { ...CHECKING_VISUAL, flaggedBy, orangeBy, mixedBy, clearFrom, pendingFrom, notConfigured: false };
    }
    return { ...TONE_VISUALS.safe, glyph: "✓", label: "No flags found", flaggedBy, orangeBy, mixedBy, clearFrom, pendingFrom, notConfigured: false };
}

function FlagIcon({ visual, size = 14 }: { visual: FlagVisual; size?: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" style={{ display: "block" }}>
            <circle cx={8} cy={8} r={7.5} fill={visual.bg} stroke={visual.fg} strokeWidth={1} />
            <text x={8} y={8.5} textAnchor="middle" dominantBaseline="middle" fontSize={9} fontWeight={700} fill={visual.fg} fontFamily="var(--font-primary, sans-serif)">
                {visual.glyph}
            </text>
        </svg>
    );
}

function tooltipText(agg: Aggregate): string {
    if (agg.notConfigured) return "Set your Rayward API key in the plugin's settings";

    const lines: string[] = [];
    if (agg.flaggedBy.length) lines.push(`Flagged by: ${agg.flaggedBy.join(", ")}`);
    if (agg.orangeBy.length) lines.push(`Flagged (2 servers) by: ${agg.orangeBy.join(", ")}`);
    if (agg.mixedBy.length) lines.push(`Seen in 1 server only: ${agg.mixedBy.join(", ")}`);
    const anyFlag = agg.flaggedBy.length || agg.orangeBy.length || agg.mixedBy.length;
    if (agg.clearFrom.length) lines.push(`${anyFlag ? "Clear" : "No flags"}: ${agg.clearFrom.join(", ")}`);
    if (agg.pendingFrom.length) lines.push(`Checking: ${agg.pendingFrom.join(", ")}`);
    if (!anyFlag) lines.push("(not a guarantee of safety)");
    lines.push("Click for details");
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Details modal — one section per company
// ---------------------------------------------------------------------------

function renderEvidence(ev: FlagEvidence, key: number) {
    switch (ev.kind) {
        case "text":
            return <Forms.FormText key={key} style={{ margin: "4px 0" }}>{ev.text}</Forms.FormText>;
        case "outfit":
            return (
                <Forms.FormText key={key} style={{ margin: "4px 0" }}>
                    Outfit "{ev.name}" ({ev.category}) — {ev.description}
                    {ev.outfitId ? ` [outfit ID: ${ev.outfitId}]` : ""}
                </Forms.FormText>
            );
        case "discordGuild": {
            const activity = [
                ev.messages ? `${ev.messages} messages` : null,
                ev.typing ? `${ev.typing} typing` : null,
                ev.reactions ? `${ev.reactions} reactions` : null,
                ev.vcJoins ? `${ev.vcJoins} VC joins` : null,
            ].filter(Boolean).join(" · ");
            const dates = [
                ev.joinedAt ? `joined ${formatDate(ev.joinedAt * 1000)}` : null,
                ev.firstSeen ? `first seen ${formatDate(ev.firstSeen * 1000)}` : null,
                ev.lastSeen ? `last seen ${formatDate(ev.lastSeen * 1000)}` : null,
                ev.leftAt ? `left ${formatDate(ev.leftAt * 1000)}` : (ev.verifiedLeft ? "confirmed left (date unknown)" : null),
            ].filter(Boolean).join(" · ");
            const tags = [...(ev.types ?? []), ...(ev.tags ?? []), ev.staff ? "staff/mod" : null, ev.booster ? "booster" : null]
                .filter(Boolean).join(" · ");
            return (
                // Its own card, not just another paragraph — this is what
                // actually separates one server from the next visually.
                <div
                    key={key}
                    style={{
                        margin: "6px 0", padding: "8px 10px",
                        background: "var(--background-secondary)", borderRadius: 6,
                        borderLeft: "3px solid var(--background-modifier-accent)",
                    }}
                >
                    <Text variant="text-sm/semibold" style={{ display: "block" }}>
                        {ev.safeName ?? ev.name ?? "unknown"}
                        <span style={{ opacity: 0.55, fontWeight: 400, marginLeft: 6 }}>ID: {ev.serverId ?? "unknown"}</span>
                    </Text>
                    {tags && <Text variant="text-xs/normal" style={{ opacity: 0.65, display: "block", marginTop: 3 }}>{tags}</Text>}
                    {dates && <Text variant="text-xs/normal" style={{ opacity: 0.5, display: "block", marginTop: 3 }}>{dates}</Text>}
                    {activity && <Text variant="text-xs/normal" style={{ opacity: 0.5, display: "block", marginTop: 3 }}>{activity}</Text>}
                </div>
            );
        }
        case "discordUser":
            return (
                <Forms.FormText key={key} style={{ margin: "4px 0", opacity: 0.85 }}>
                    Linked Discord account on record (ID: {ev.discordId ?? "masked"})
                </Forms.FormText>
            );
        default:
            return null; // unknown evidence kinds are added without a version bump — skip, don't break
    }
}

function renderProvisionalReasons(flag: FlagEntry | undefined) {
    if (!flag?.provisionalReasons?.length) return null;
    const n = flag.provisionalReasons.length;
    return (
        <Text variant="text-xs/normal" style={{ opacity: 0.55, marginTop: 6, display: "block" }}>
            {n} finding{n > 1 ? "s" : ""} awaiting human review (details withheld): {flag.provisionalReasons.map(r => r.title).join(", ")}
        </Text>
    );
}

// Everything the Roblox lookup gives us beyond what the Discord lookup does.
function robloxMetaLine(flag: FlagEntry | undefined): string | null {
    if (!flag) return null;
    const parts: string[] = [];
    if (flag.categoryLabel) parts.push(`Category: ${flag.categoryLabel}`);
    if (flag.reviewer) parts.push(`Reviewed by ${flag.reviewer.displayName} (@${flag.reviewer.username})`);
    if (flag.isLocked) parts.push("Locked");
    if (flag.processed === false) parts.push("Still processing");
    if (flag.lastUpdated) parts.push(`Provider's last analysis ${formatDate(flag.lastUpdated * 1000)}`);
    return parts.length ? parts.join(" · ") : null;
}

function formatDate(ms: number): string {
    return new Date(ms).toLocaleString(undefined, {
        year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
}

// A filled pill in a fixed brand color, not a theme token — the previous
// version used --background-tertiary, which apparently renders very dark in
// your theme too, so it was still low-contrast against the card behind it.
// Blurple is guaranteed visible against every Discord theme, light or dark.
function refreshButtonStyle(isBusy: boolean, compact: boolean): React.CSSProperties {
    return {
        fontSize: compact ? 10 : 11,
        color: "#ffffff",
        opacity: isBusy ? 0.35 : 1,
        cursor: isBusy ? "default" : "pointer",
        background: "#5865F2",
        borderRadius: 4,
        padding: compact ? "2px 6px" : "3px 8px",
        whiteSpace: "nowrap",
        flexShrink: 0,
    };
}

function ProviderSection({ providerId, flag, discordId }: { providerId: ProviderId; flag: FlagEntry | undefined; discordId: string; }) {
    const visual = getProviderVisual(providerId, flag, { serverSplit: true });
    const logo = ProviderLogos[providerId];
    const isBusy = !flag || flag.flagType === undefined;
    const isRealResult = flag && flag.flagType !== NOT_CONFIGURED_FLAG;

    return (
        <div style={{
            padding: "10px 12px", background: "var(--background-secondary)", borderRadius: 8, marginBottom: 8,
            borderLeft: `3px solid ${PROVIDER_ACCENT_COLORS[providerId]}`,
        }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                {logo && <img src={logo} alt="" style={{ height: 16, width: "auto" }} />}
                <Text variant="text-md/bold">{providerDisplayName(providerId)}</Text>
                <FlagIcon visual={visual} size={16} />
                <Text variant="text-xs/normal" style={{ opacity: 0.7 }}>{flag?.statusLabel ?? visual.label}</Text>
                <div style={{ flexGrow: 1 }} />
                <span
                    role="button"
                    onClick={() => !isBusy && discordLookups[providerId].forceRefresh(discordId)}
                    style={refreshButtonStyle(isBusy, false)}
                >
                    ↻ Refresh
                </span>
            </div>
            {isRealResult && (
                <Text variant="text-xs/normal" style={{ opacity: 0.5, marginBottom: 6, display: "block" }}>
                    First scanned {formatDate(flag!.fetchedAt)} · refreshes {formatDate(flag!.fetchedAt + CACHE_TTL_MS)}
                </Text>
            )}
            {!flag?.reasons?.length ? (
                <Forms.FormText type="description">
                    {flag?.flagType === 0
                        ? "No violations detected yet — not a guarantee of safety."
                        : flag?.flagType === NOT_CONFIGURED_FLAG
                            ? "Set your Rayward API key to check this company."
                            : "No reasons recorded for this status."}
                </Forms.FormText>
            ) : (
                flag.reasons.map((reason, i) => (
                    <div key={i} style={{ marginTop: 8 }}>
                        <Text variant="text-sm/semibold">{reason.title}</Text>
                        <Text variant="text-xs/normal" style={{ opacity: 0.6 }}>
                            {reason.sources.map(s => s.label).join(", ")}
                        </Text>
                        {reason.evidence?.map((ev, j) => renderEvidence(ev, j))}
                    </div>
                ))
            )}
        </div>
    );
}

// Roblox equivalent of ProviderSection — same shape, plus the extra fields
// the Roblox lookup returns (reviewer, lock state, category, provider's own
// last-analysis timestamp, provisional/pending findings) and no server-count
// override, since Roblox's flagType is already fine-grained.
// Uses --background-tertiary against the account block's --background-secondary
// below, so the nesting reads clearly on any theme, not just a lighter one.
function RobloxProviderSection({ providerId, flag, robloxId }: { providerId: RobloxProviderId; flag: FlagEntry | undefined; robloxId: string; }) {
    const visual = getProviderVisual(providerId, flag);
    const logo = ProviderLogos[providerId];
    const isBusy = !flag || flag.flagType === undefined;
    const isRealResult = flag && flag.flagType !== NOT_CONFIGURED_FLAG;
    const meta = robloxMetaLine(flag);

    return (
        <div style={{
            padding: "8px 10px", background: "var(--background-tertiary)", borderRadius: 6, marginBottom: 6,
            borderLeft: `3px solid ${PROVIDER_ACCENT_COLORS[providerId]}`,
        }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                {logo && <img src={logo} alt="" style={{ height: 14, width: "auto" }} />}
                <Text variant="text-sm/bold">{providerDisplayName(providerId)}</Text>
                <FlagIcon visual={visual} size={14} />
                <Text variant="text-xs/normal" style={{ opacity: 0.7 }}>{flag?.statusLabel ?? visual.label}</Text>
                <div style={{ flexGrow: 1 }} />
                <span
                    role="button"
                    onClick={() => !isBusy && robloxLookups[providerId].forceRefresh(robloxId)}
                    style={refreshButtonStyle(isBusy, true)}
                >
                    ↻
                </span>
            </div>
            {isRealResult && (
                <Text variant="text-xs/normal" style={{ opacity: 0.5, marginBottom: 4, display: "block" }}>
                    First scanned {formatDate(flag!.fetchedAt)} · refreshes {formatDate(flag!.fetchedAt + CACHE_TTL_MS)}
                </Text>
            )}
            {meta && <Text variant="text-xs/normal" style={{ opacity: 0.6, marginBottom: 4, display: "block" }}>{meta}</Text>}
            {!flag?.reasons?.length ? (
                <Forms.FormText type="description">
                    {flag?.flagType === 0
                        ? "No violations detected yet — not a guarantee of safety."
                        : flag?.flagType === NOT_CONFIGURED_FLAG
                            ? "Set your Rayward API key to check this company."
                            : "No reasons recorded for this status."}
                </Forms.FormText>
            ) : (
                flag.reasons.map((reason, i) => (
                    <div key={i} style={{ marginTop: 6 }}>
                        <Text variant="text-xs/semibold">{reason.title}</Text>
                        <Text variant="text-xs/normal" style={{ opacity: 0.55 }}>
                            {reason.sources.map(s => s.label).join(", ")}
                        </Text>
                        {reason.evidence?.map((ev, j) => renderEvidence(ev, j))}
                    </div>
                ))
            )}
            {renderProvisionalReasons(flag)}
        </div>
    );
}

// Every Roblox account any Discord provider reported as linked, deduped by ID.
function getLinkedRobloxAccounts(flags: Partial<Record<ProviderId, FlagEntry>>): { id: string; username: string; }[] {
    const byId = new Map<string, string>();
    for (const p of DISCORD_PROVIDERS) {
        for (const acc of flags[p]?.linkedRobloxAccounts ?? []) {
            byId.set(String(acc.robloxUserId), acc.robloxUsername);
        }
    }
    return [...byId.entries()].map(([id, username]) => ({ id, username }));
}

function RobloxAccountBlock({ account }: { account: { id: string; username: string; }; }) {
    const flags = useRobloxFlags(account.id);
    return (
        <div style={{ padding: "10px 12px", background: "var(--background-secondary)", borderRadius: 8, marginBottom: 10 }}>
            <Text variant="text-md/bold" style={{ marginBottom: 8, display: "block" }}>
                Roblox: {account.username} (ID: {account.id})
            </Text>
            {ROBLOX_PROVIDERS.map(p => (
                <RobloxProviderSection key={p} providerId={p} flag={flags[p]} robloxId={account.id} />
            ))}
        </div>
    );
}
const WrappedRobloxAccountBlock = ErrorBoundary.wrap(RobloxAccountBlock, { noop: true });

function FlagDetailsModal({ modalProps, discordId }: { modalProps: any; discordId: string; }) {
    // Reactive (not just a one-time snapshot) so the "↻ Refresh" button in
    // each section actually updates what's on screen once the new fetch lands.
    const flags = useFlags(discordId);
    const robloxAccounts = getLinkedRobloxAccounts(flags);
    const isStaff = useIsStaff(discordId);

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <Text variant="heading-lg/semibold" style={{ flexGrow: 1 }}>Safety status — {discordId}</Text>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>
            <ModalContent style={{ padding: "16px 20px" }}>
                {isStaff && (
                    <Forms.FormText type="description" style={{ marginBottom: 10 }}>
                        Listed in your staff file. This only changes which icon shows in chat —
                        it does not stop lookups, and any real flag below still takes priority
                        over the staff badge.
                    </Forms.FormText>
                )}
                {DISCORD_PROVIDERS.map(p => (
                    <ProviderSection key={p} providerId={p} flag={flags[p]} discordId={discordId} />
                ))}

                {robloxAccounts.length > 0 && (
                    <>
                        <Forms.FormDivider style={{ margin: "12px 0" }} />
                        <Text variant="heading-sm/semibold" style={{ marginBottom: 8, display: "block" }}>
                            Linked Roblox account{robloxAccounts.length > 1 ? "s" : ""} ({robloxAccounts.length})
                        </Text>
                        {robloxAccounts.map(acc => (
                            <WrappedRobloxAccountBlock key={acc.id} account={acc} />
                        ))}
                    </>
                )}

                <Forms.FormDivider style={{ margin: "12px 0" }} />
                <Forms.FormText type="description">
                    Each section above is that company's own classification. Only "Flagged"
                    and "Confirmed" indicate a confirmed violation — other states are process
                    information, not a finding against this account.
                </Forms.FormText>
            </ModalContent>
        </ModalRoot>
    );
}

function openFlagModal(discordId: string) {
    return openModal(props => <FlagDetailsModal modalProps={props} discordId={discordId} />);
}

// Standalone Roblox lookup — same per-provider sections as the "Linked Roblox
// accounts" part of the Discord modal, just not nested under a Discord user.
// Used by the /rotector-roblox command below.
function RobloxLookupModal({ modalProps, robloxId, username }: { modalProps: any; robloxId: string; username?: string; }) {
    const flags = useRobloxFlags(robloxId);
    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <Text variant="heading-lg/semibold" style={{ flexGrow: 1 }}>
                    Roblox safety status — {username ? `${username} (${robloxId})` : robloxId}
                </Text>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>
            <ModalContent style={{ padding: "16px 20px" }}>
                {ROBLOX_PROVIDERS.map(p => (
                    <RobloxProviderSection key={p} providerId={p} flag={flags[p]} robloxId={robloxId} />
                ))}
            </ModalContent>
        </ModalRoot>
    );
}

function openRobloxModal(robloxId: string, username?: string) {
    return openModal(props => <RobloxLookupModal modalProps={props} robloxId={robloxId} username={username} />);
}

// Roblox's own public username->ID API (not a Rayward endpoint) — needs its
// own CSP allowance, see native.ts.
async function resolveRobloxUsername(username: string): Promise<{ id: string; name: string; } | null> {
    const res = await fetch("https://users.roblox.com/v1/usernames/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
    });
    const json = await res.json();
    const match = json?.data?.[0];
    return match ? { id: String(match.id), name: match.name } : null;
}

// ---------------------------------------------------------------------------
// Badge components
// ---------------------------------------------------------------------------

function allResolved(flags: Partial<Record<ProviderId, FlagEntry>>) {
    return DISCORD_PROVIDERS.every(p => flags[p] !== undefined);
}

// Rotector's shield icon (cropped from the logo you provided — just the
// eye, no wordmark), colored with the same brand blue as its accent bar.
const STAFF_COLOR = PROVIDER_ACCENT_COLORS.rotector;

function StaffIcon({ size = 14 }: { size?: number; }) {
    return (
        <span style={{
            display: "inline-block", width: size, height: size, borderRadius: "50%",
            overflow: "hidden", flexShrink: 0, background: "#fff",
        }}>
            <img src={rotectorIcon} alt="" style={{ width: "100%", height: "100%", display: "block" }} />
        </span>
    );
}

function StaffBadge({ size = 14 }: { size?: number; }) {
    return (
        <Tooltip text="Marked as Rotector Staff">
            {tooltipProps => (
                <span {...tooltipProps} style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 4, verticalAlign: "middle" }}>
                    <StaffIcon size={size} />
                    <span style={{
                        fontSize: 9, fontWeight: 800, letterSpacing: 0.5, color: "#fff",
                        background: STAFF_COLOR, borderRadius: 3, padding: "1px 4px", lineHeight: "12px",
                    }}>
                        STAFF
                    </span>
                </span>
            )}
        </Tooltip>
    );
}
const WrappedStaffBadge = ErrorBoundary.wrap(StaffBadge, { noop: true });

function FlagBadge({ discordId }: { discordId: string | undefined; }) {
    const flags = useFlags(discordId); // always runs — staff never skips the real lookup
    const isStaff = useIsStaff(discordId);
    if (!discordId) return null;

    const agg = aggregate(flags);
    const canOpen = allResolved(flags);
    const hasRealFlag = agg.flaggedBy.length > 0 || agg.mixedBy.length > 0;

    // Staff only shows once every provider has actually answered AND none of
    // them reported a real flag — a genuine flag always wins over the staff
    // badge, per your ask.
    if (isStaff && canOpen && !hasRealFlag) {
        return (
            <span role="button" onClick={() => openFlagModal(discordId)} style={{ cursor: "pointer" }}>
                <WrappedStaffBadge />
            </span>
        );
    }

    return (
        <Tooltip text={tooltipText(agg)}>
            {tooltipProps => (
                <span
                    {...tooltipProps}
                    role="button"
                    onClick={() => canOpen && openFlagModal(discordId)}
                    style={{ display: "inline-flex", marginLeft: 4, verticalAlign: "middle", cursor: canOpen ? "pointer" : "default" }}
                >
                    <FlagIcon visual={agg} />
                </span>
            )}
        </Tooltip>
    );
}
const WrappedFlagBadge = ErrorBoundary.wrap(FlagBadge, { noop: true });

function ProfileFlagBadge({ userId }: { userId: string; }) {
    const flags = useFlags(userId); // always runs — staff never skips the real lookup
    const isStaff = useIsStaff(userId);

    const agg = aggregate(flags);
    const canOpen = allResolved(flags);
    const hasRealFlag = agg.flaggedBy.length > 0 || agg.mixedBy.length > 0;

    if (isStaff && canOpen && !hasRealFlag) {
        return (
            <span role="button" onClick={() => openFlagModal(userId)} style={{ cursor: "pointer" }}>
                <WrappedStaffBadge size={16} />
            </span>
        );
    }

    return (
        <Tooltip text={tooltipText(agg)}>
            {tooltipProps => (
                <span
                    {...tooltipProps}
                    role="button"
                    onClick={() => canOpen && openFlagModal(userId)}
                    style={{ display: "inline-flex", cursor: canOpen ? "pointer" : "default" }}
                >
                    <FlagIcon visual={agg} size={16} />
                </span>
            )}
        </Tooltip>
    );
}
const WrappedProfileBadge = ErrorBoundary.wrap(ProfileFlagBadge, { noop: true });

const profileBadge: ProfileBadge = {
    id: "rotector-flag",
    key: "rotector-flag",
    component: WrappedProfileBadge as any,
    position: BadgePosition.START,
    shouldShow: () => true,
};

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export default definePlugin({
    name: "RotectorFlags",
    description: "Aggregates Rotector/TASE/ServerSweep/Okappiki/RAB safety status (Discord + linked Roblox accounts) next to usernames in chat, the member list, and profiles",
    authors: [{ name: "IbrahimUmut", id: 0n }],
    settings,

    commands: [
        {
            name: "rotector-discord",
            description: "Check a Discord user ID against every connected safety provider",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                { name: "id", description: "Discord user ID to check", required: true, type: ApplicationCommandOptionType.STRING },
            ],
            execute: async (args, ctx) => {
                const id = findOption<string>(args, "id", "").trim();
                if (!/^\d{15,21}$/.test(id)) {
                    sendBotMessage(ctx.channel.id, { content: "That doesn't look like a valid Discord user ID (should be a 15-21 digit number)." });
                    return;
                }
                openFlagModal(id);
            },
        },
        {
            name: "rotector-roblox",
            description: "Check a Roblox user (ID or username) against every connected safety provider",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                { name: "user", description: "Roblox numeric ID or username", required: true, type: ApplicationCommandOptionType.STRING },
            ],
            execute: async (args, ctx) => {
                const input = findOption<string>(args, "user", "").trim();
                if (!input) return;

                if (/^\d+$/.test(input)) {
                    openRobloxModal(input);
                    return;
                }

                try {
                    const resolved = await resolveRobloxUsername(input);
                    if (!resolved) {
                        sendBotMessage(ctx.channel.id, { content: `Couldn't find a Roblox user named "${input}".` });
                        return;
                    }
                    openRobloxModal(resolved.id, resolved.name);
                } catch (e) {
                    console.error("[RotectorFlags] Roblox username resolution failed", e);
                    sendBotMessage(ctx.channel.id, { content: `Couldn't resolve "${input}" to a Roblox ID — try the numeric ID instead.` });
                }
            },
        },
    ],

    async start() {
        await loadAllCaches();
        await loadProviderMetas();

        if (settings.store.showInChat) {
            addMessageDecoration("rotector-flag", props => (
                <WrappedFlagBadge discordId={props.message?.author?.id} />
            ));
        }
        if (settings.store.showInMemberList) {
            addMemberListDecorator("rotector-flag", props => (
                <WrappedFlagBadge discordId={props.user?.id} />
            ));
        }
        if (settings.store.showInProfile) {
            addProfileBadge(profileBadge);
        }
    },

    stop() {
        removeMessageDecoration("rotector-flag");
        removeMemberListDecorator("rotector-flag");
        removeProfileBadge(profileBadge);
    },
});