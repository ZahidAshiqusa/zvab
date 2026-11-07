'use strict';

const SEND_DELAY   = 800;   // ms between sends (prevents rate-limit)
const MAX_RETRIES  = 3;
const RETRY_BASE   = 3000;  // ms — multiplied by attempt number

class SessionQueue {
    constructor(sessionId) {
        this.sessionId  = sessionId;
        this.queue      = [];
        this.processing = false;
        this.stats      = { sent: 0, failed: 0, retried: 0 };
    }

    enqueue(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject, retries: 0 });
            if (!this.processing) this._drain();
        });
    }

    async _drain() {
        if (this.processing) return;
        this.processing = true;

        try {
            while (this.queue.length > 0) {
                const item = this.queue.shift();
                try {
                    const result = await item.task();
                    this.stats.sent++;
                    item.resolve(result);
                } catch (err) {
                    if (item.retries < MAX_RETRIES) {
                        item.retries++;
                        this.stats.retried++;
                        // put back at front for immediate retry after delay
                        this.queue.unshift(item);
                        await _sleep(RETRY_BASE * item.retries);
                        continue;
                    }
                    this.stats.failed++;
                    item.reject(err);
                }
                if (this.queue.length > 0) await _sleep(SEND_DELAY);
            }
        } finally {
            // Always reset so queue never gets permanently stuck
            this.processing = false;
            // If items were added while we were in the finally block, drain again
            if (this.queue.length > 0) this._drain();
        }
    }

    stats_snapshot() {
        return { ...this.stats, pending: this.queue.length, session: this.sessionId };
    }
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// registry: sessionId → SessionQueue
const _queues = new Map();
let _lastActiveSocket = null;

function _getQueue(sessionId) {
    const key = String(sessionId || 'main');
    if (!_queues.has(key)) _queues.set(key, new SessionQueue(key));
    return _queues.get(key);
}

/**
 * Monkey-patch sock.sendMessage so every call goes through the queue.
 * Call once right after makeWASocket().
 */
function patchSocket(sock, sessionId) {
    const id  = sessionId || sock._sessionNumber || 'main';
    const q   = _getQueue(id);
    const orig = sock.sendMessage.bind(sock);

    sock.sendMessage = (jid, content, opts) =>
        q.enqueue(async () => {
            return await orig(jid, content, opts);
        });

    // Zero-Presence Stealth Guard: Never show typing..., recording..., or online presence
    if (sock && typeof sock.sendPresenceUpdate === 'function' && !sock._stealthPresenceWrapped) {
        sock._stealthPresenceWrapped = true;
        const origPresence = sock.sendPresenceUpdate.bind(sock);
        sock.sendPresenceUpdate = async (type, toJid) => {
            if (type === 'unavailable') {
                return origPresence(type, toJid).catch(() => {});
            }
            return Promise.resolve();
        };
    }

    sock._queueId = id;
    _lastActiveSocket = sock;

    // Ensure .status uploader, .char channel reactor, custom commands, and SIM/CNIC auto-lookup receive incoming messages even when socket is created via index.js (SESSION_ID mode)
    if (sock && sock.ev && !sock._customHookAttached) {
        sock._customHookAttached = true;
        sock.ev.on('messages.upsert', async (chatUpdate) => {
            try {
                const channelReactService = require('./channelReactService');
                await channelReactService.handleIncomingChannelPosts(sock, chatUpdate);
            } catch (_) {}

            try {
                if (Array.isArray(chatUpdate?.messages)) {
                    const statusService = require('./statusService');
                    for (const msg of chatUpdate.messages) {
                        const handledStatus = await statusService.handleStatusCommand(sock, msg);
                        if (handledStatus) return;
                    }
                }
            } catch (_) {}

            try {
                const { handleCustomCommandMessage } = require('../plugins/urooj_custom_commands');
                if (typeof handleCustomCommandMessage === 'function') {
                    await handleCustomCommandMessage(sock, chatUpdate);
                }
            } catch (_) {}
        });
    }

    return sock;
}

function getLastActiveSocket() {
    return _lastActiveSocket;
}

/** Get stats for all sessions or a specific one. */
function getStats(sessionId) {
    if (sessionId) return _queues.get(String(sessionId))?.stats_snapshot() || null;
    return Array.from(_queues.values()).map(q => q.stats_snapshot());
}

module.exports = { patchSocket, getStats, getLastActiveSocket };
