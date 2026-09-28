/*
 * Runs in Electron's main process (not the browser/renderer). Vencord auto-loads
 * any native.ts sitting next to a plugin's index.tsx and bundles it into the main
 * process build — this is the sanctioned way for a plugin to register its own
 * domain with Discord's Content-Security-Policy, rather than hand-editing
 * src/main/csp/index.ts (which would get overwritten on the next `git pull`).
 *
 * Without this, fetch() calls from index.tsx to roscoe.rayward.app (and to
 * Roblox's own username-lookup API) are silently blocked by Discord's CSP —
 * which is exactly the "stuck on Checking…" symptom.
 */

import { ConnectSrc, CspPolicies } from "@main/csp";
import { IpcMainInvokeEvent } from "electron";
import { existsSync, readFileSync } from "fs";

CspPolicies["roscoe.rayward.app"] = ConnectSrc;
// Roblox's public username->ID API, used by the /rotector-roblox command
// when you pass a username instead of a numeric ID.
CspPolicies["users.roblox.com"] = ConnectSrc;

/**
 * Reads the user-maintained staff list: one Discord ID per line, blank lines
 * and lines starting with # ignored. Runs in the main process because
 * arbitrary local file reads aren't available from the renderer sandbox.
 * Never throws — a missing/unreadable file just means an empty staff list.
 */
export async function readStaffFile(_: IpcMainInvokeEvent, path: string): Promise<string[]> {
    try {
        if (!path || !existsSync(path)) return [];
        const raw = readFileSync(path, "utf-8");
        return raw
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !line.startsWith("#"));
    } catch {
        return [];
    }
}
