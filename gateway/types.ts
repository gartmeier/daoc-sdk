// Gateway message protocol. Same envelope as rs-sdk's server/gateway/types.ts;
// the payloads are the DAoC contract from sdk/types.ts.

export * from '../sdk/types';

import type { ActionResult, BotAction, BotWorldState, ConnectionMode } from '../sdk/types';

export type SDKConnectionMode = ConnectionMode;

/** Headless client → gateway. */
export interface BotClientMessage {
    type: 'connected' | 'state' | 'actionResult';
    state?: BotWorldState;
    result?: ActionResult;
    /** Echoed from the 'action' frame for correlation. */
    actionId?: string;
    clientId?: string;
    username?: string;
    /** Kept for parity with rs-sdk; only checked by a configured auth hook. */
    password?: string;
    /** Max chat text per message the client accepts, relayed to SDKs. */
    maxMessageLength?: number;
}

/** Gateway → headless client. */
export interface SyncToBotMessage {
    type: 'action' | 'status' | 'error' | 'save_and_disconnect';
    action?: BotAction;
    actionId?: string;
    /** SDK deadline, so the client queue can expire work first. */
    actionTimeoutMs?: number;
    status?: string;
    error?: string;
    /**
     * For save_and_disconnect: another client registered as this bot. The
     * client should '&quit', wait for the server's 0xA4, close and not reconnect.
     */
    reason?: string;
}

/** SDK → gateway. */
export interface SDKMessage {
    type: 'sdk_connect' | 'sdk_action';
    /** Ignored on sdk_action: the session's target is always used. */
    username: string;
    password?: string;
    /** Log label only, never identity. */
    clientId?: string;
    mode?: SDKConnectionMode;
    actionId?: string;
    action?: BotAction;
    actionTimeoutMs?: number;
}

/** Gateway → SDK. */
export interface SyncToSDKMessage {
    type: 'sdk_connected' | 'sdk_state' | 'sdk_action_result' | 'sdk_error' | 'sdk_info';
    success?: boolean;
    state?: BotWorldState;
    /** Gateway clock (ms epoch) when the state frame arrived from the client. */
    stateReceivedAt?: number;
    actionId?: string;
    result?: ActionResult;
    error?: string;
    mode?: SDKConnectionMode;
    /** Always 0: older controllers are pre-empted. */
    otherControllers?: number;
    message?: string;
    maxMessageLength?: number;
}

/** Action types an observe-mode SDK may send. */
export const OBSERVER_ACTIONS: ReadonlySet<string> = new Set(['say', 'send']);

/** Credential check for bots, SDKs and HTTP callers. The default allows everything. */
export type GatewayAuthHook = (request: {
    kind: 'bot' | 'sdk' | 'http';
    username: string;
    password: string;
}) => Promise<{ success: boolean; error?: string }> | { success: boolean; error?: string };
