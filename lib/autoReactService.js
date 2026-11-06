'use strict';

/**
 * Interactive Auto-React Service Engine
 * Brand: Zaid Ashiq X Ultra V. Coder
 *
 * Supports 3 independent Auto-React services:
 * 1. Auto React on Status (status@broadcast)
 * 2. Auto React on Clients Msg (incoming messages where !fromMe)
 * 3. Auto React on Every Msg (every message including owner's own messages)
 *
 * Interactive 2-Step WhatsApp Flow (.autoreact):
 * - Step 1: User types `.autoreact` -> Bot sends 3 buttons:
 *     [1] Auto react on status
 *     [2] Auto react on clients msg
 *     [3] Auto react on every msg
 * - Step 2: User clicks a service button -> Bot sends 2 buttons for that service:
 *     [1] ON
 *     [2] OFF
 * - Step 3: User clicks ON or OFF -> Service state is saved & confirmed immediately.
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./storagePaths');

let sendButtons = null;
try {
    sendButtons = require('kango-wa').sendButtons;
} catch (_) {
    sendButtons = null;
}

const AUTOREACT_CONFIG_PATH = path.join(DATA_DIR, 'autoreact_config.json');

const DEFAULT_CONFIG = {
    statusReact: true,
    clientsMsgReact: false,
    everyMsgReact: false,
    statusEmojis: ['❤️', '🔥', '😍', '✨', '💯', '👑'],
    msgEmojis: ['❤️', '🔥', '⚡', '✨', '👍', '💯']
};

// Track which service a chat recently selected so plain "ON" / "OFF" replies also work
const pendingChatServiceSelection = new Map(); // chatId -> 'status' | 'clients' | 'every'

// Prevent reacting twice to the same message ID
const reactedMessageIds = new Set();

function rememberReactedId(id) {
    if (!id) return true;
    if (reactedMessageIds.has(id)) return true;
    reactedMessageIds.add(id);
    if (reactedMessageIds.size > 600) {
        const oldest = reactedMessageIds.values().next().value;
        reactedMessageIds.delete(oldest);
    }
    return false;
}

function getAutoReactConfig() {
    try {
        if (fs.existsSync(AUTOREACT_CONFIG_PATH)) {
            const raw = JSON.parse(fs.readFileSync(AUTOREACT_CONFIG_PATH, 'utf8'));
            return {
                statusReact: raw.statusReact !== undefined ? Boolean(raw.statusReact) : DEFAULT_CONFIG.statusReact,
                clientsMsgReact: Boolean(raw.clientsMsgReact),
                everyMsgReact: Boolean(raw.everyMsgReact),
                statusEmojis: Array.isArray(raw.statusEmojis) && raw.statusEmojis.length > 0 ? raw.statusEmojis : DEFAULT_CONFIG.statusEmojis,
                msgEmojis: Array.isArray(raw.msgEmojis) && raw.msgEmojis.length > 0 ? raw.msgEmojis : DEFAULT_CONFIG.msgEmojis
            };
        }
    } catch (_) {}
    return { ...DEFAULT_CONFIG };
}

function saveAutoReactConfig(updates = {}) {
    const current = getAutoReactConfig();
    const next = {
        statusReact: updates.statusReact !== undefined ? Boolean(updates.statusReact) : current.statusReact,
        clientsMsgReact: updates.clientsMsgReact !== undefined ? Boolean(updates.clientsMsgReact) : current.clientsMsgReact,
        everyMsgReact: updates.everyMsgReact !== undefined ? Boolean(updates.everyMsgReact) : current.everyMsgReact,
        statusEmojis: Array.isArray(updates.statusEmojis) && updates.statusEmojis.length > 0
            ? updates.statusEmojis
            : current.statusEmojis,
        msgEmojis: Array.isArray(updates.msgEmojis) && updates.msgEmojis.length > 0
            ? updates.msgEmojis
            : current.msgEmojis
    };

    try {
        fs.mkdirSync(path.dirname(AUTOREACT_CONFIG_PATH), { recursive: true });
        fs.writeFileSync(AUTOREACT_CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
    } catch (err) {
        console.warn('[autoReact] Failed to save config:', err.message);
    }
    return next;
}

function pickRandomEmoji(list) {
    const arr = Array.isArray(list) && list.length > 0 ? list : ['❤️'];
    return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Extract button click ID or text from any incoming WhatsApp message (including interactive button responses)
 */
function extractInteractiveInput(message) {
    if (!message || !message.message) return { id: '', text: '' };
    let m = message.message;
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;

    let buttonId =
        m.buttonsResponseMessage?.selectedButtonId ||
        m.templateButtonReplyMessage?.selectedId ||
        m.listResponseMessage?.singleSelectReply?.selectedRowId ||
        '';

    let buttonText =
        m.buttonsResponseMessage?.selectedDisplayText ||
        m.templateButtonReplyMessage?.selectedDisplayText ||
        m.listResponseMessage?.title ||
        '';

    if (m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
        try {
            const params = JSON.parse(m.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
            buttonId = params.id || params.selectedId || buttonId;
            buttonText = params.display_text || buttonText;
        } catch (_) {}
    }

    const plainText = (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        buttonText ||
        ''
    ).trim();

    return {
        id: String(buttonId || '').trim(),
        text: String(plainText || '').trim()
    };
}

const SERVICE_META = {
    status: {
        key: 'statusReact',
        title: 'Auto React on Status',
        desc: 'Automatically reacts to WhatsApp Status stories (status@broadcast)'
    },
    clients: {
        key: 'clientsMsgReact',
        title: 'Auto React on Clients Msg',
        desc: 'Automatically reacts to incoming messages from clients/contacts'
    },
    every: {
        key: 'everyMsgReact',
        title: 'Auto React on Every Msg (Even Owner Msgs)',
        desc: 'Automatically reacts to every message in chat including owner messages'
    }
};

/**
 * Send interactive buttons without any caption/footer clutter
 */
async function dispatchCleanButtons(sock, chatId, text, buttons, quotedMsg = null) {
    let sent = false;
    if (sendButtons) {
        try {
            await sendButtons(
                sock,
                chatId,
                {
                    text,
                    buttons: buttons.map(b => ({ id: b.id, text: b.text }))
                },
                quotedMsg ? { quoted: quotedMsg } : undefined
            );
            sent = true;
        } catch (err) {
            console.warn('[autoReact] sendButtons fallback:', err.message);
        }
    }

    if (!sent) {
        const lines = buttons.map((b, i) => `${i + 1}. ${b.text}`).join('\n');
        await sock.sendMessage(
            chatId,
            { text: `${text}\n\n${lines}` },
            quotedMsg ? { quoted: quotedMsg } : undefined
        );
    }
}

/**
 * Step 1: Send 3 Service Selection Buttons when user types .autoreact
 */
async function sendAutoReactServiceMenu(sock, chatId, message) {
    const cfg = getAutoReactConfig();
    const statusText =
        `⚡ *Auto React Service Selector*\n\n` +
        `Which Auto React service do you need?\n\n` +
        `• *Auto React on Status:* ${cfg.statusReact ? '🟢 ON' : '🔴 OFF'}\n` +
        `• *Auto React on Clients Msg:* ${cfg.clientsMsgReact ? '🟢 ON' : '🔴 OFF'}\n` +
        `• *Auto React on Every Msg (Even Owner):* ${cfg.everyMsgReact ? '🟢 ON' : '🔴 OFF'}`;

    const buttons = [
        { id: 'ar_srv_status', text: 'Auto react on status' },
        { id: 'ar_srv_clients', text: 'Auto react on clients msg' },
        { id: 'ar_srv_every', text: 'Auto react on every msg' }
    ];

    await dispatchCleanButtons(sock, chatId, statusText, buttons, message);
    return true;
}

/**
 * Step 2: Send 2 ON/OFF Buttons when user selects one of the 3 Auto React services
 */
async function sendServiceToggleButtons(sock, chatId, serviceType, message) {
    const meta = SERVICE_META[serviceType];
    if (!meta) return false;

    pendingChatServiceSelection.set(chatId, {
        serviceType,
        timestamp: Date.now()
    });

    const cfg = getAutoReactConfig();
    const currentState = cfg[meta.key] ? 'ON 🟢' : 'OFF 🔴';

    const promptText =
        `⚙️ *${meta.title}*\n` +
        `${meta.desc}\n\n` +
        `Current Status: *${currentState}*\n` +
        `Choose *ON* or *OFF* below:`;

    const buttons = [
        { id: `ar_toggle_${serviceType}_on`, text: `${meta.title} ON` },
        { id: `ar_toggle_${serviceType}_off`, text: `${meta.title} OFF` }
    ];

    await dispatchCleanButtons(sock, chatId, promptText, buttons, message);
    return true;
}

/**
 * Step 3: Apply ON or OFF to the chosen Auto React service
 */
async function applyServiceToggle(sock, chatId, serviceType, enabled, message) {
    const meta = SERVICE_META[serviceType];
    if (!meta) return false;

    const updated = saveAutoReactConfig({ [meta.key]: Boolean(enabled) });
    pendingChatServiceSelection.delete(chatId);

    await sock.sendMessage(
        chatId,
        {
            text:
                `✅ *${meta.title}* is now *${enabled ? 'ON 🟢' : 'OFF 🔴'}*\n\n` +
                `• Status Auto-React: ${updated.statusReact ? 'ON 🟢' : 'OFF 🔴'}\n` +
                `• Clients Msg Auto-React: ${updated.clientsMsgReact ? 'ON 🟢' : 'OFF 🔴'}\n` +
                `• Every Msg (Including Owner): ${updated.everyMsgReact ? 'ON 🟢' : 'OFF 🔴'}`
        },
        { quoted: message }
    );
    return true;
}

/**
 * Handle `.autoreact` command and its 3-button / 2-button interactive responses
 */
async function handleAutoReactCommandOrButton(sock, chatId, message) {
    const { id, text } = extractInteractiveInput(message);
    const lowerId = id.toLowerCase();
    const lowerText = text.toLowerCase().trim();

    // 1. Check explicit button IDs from Step 1 (Service Selection)
    if (lowerId === 'ar_srv_status' || lowerText === 'auto react on status') {
        return await sendServiceToggleButtons(sock, chatId, 'status', message);
    }
    if (lowerId === 'ar_srv_clients' || lowerText === 'auto react on clients msg') {
        return await sendServiceToggleButtons(sock, chatId, 'clients', message);
    }
    if (
        lowerId === 'ar_srv_every' ||
        lowerText === 'auto react on every msg' ||
        lowerText === 'auto react on every msg even owner msgs'
    ) {
        return await sendServiceToggleButtons(sock, chatId, 'every', message);
    }

    // 2. Check explicit button IDs or button texts from Step 2 (ON / OFF Toggle)
    const toggleMatch = lowerId.match(/^ar_toggle_(status|clients|every)_(on|off)$/);
    if (toggleMatch) {
        return await applyServiceToggle(sock, chatId, toggleMatch[1], toggleMatch[2] === 'on', message);
    }

    for (const [srvKey, meta] of Object.entries(SERVICE_META)) {
        const titleLower = meta.title.toLowerCase();
        if (lowerText === `${titleLower} on`) {
            return await applyServiceToggle(sock, chatId, srvKey, true, message);
        }
        if (lowerText === `${titleLower} off`) {
            return await applyServiceToggle(sock, chatId, srvKey, false, message);
        }
    }

    // 3. If chat has a recent pending service selection (within 5 minutes) and user replies "on" or "off"
    const pending = pendingChatServiceSelection.get(chatId);
    if (pending && Date.now() - pending.timestamp < 5 * 60 * 1000) {
        if (lowerText === 'on' || lowerText === '1') {
            return await applyServiceToggle(sock, chatId, pending.serviceType, true, message);
        }
        if (lowerText === 'off' || lowerText === '2') {
            return await applyServiceToggle(sock, chatId, pending.serviceType, false, message);
        }
    }

    // 4. Direct `.autoreact` / `.areact` command
    if (/^[.!#/]\s*(?:autoreact|areact)\b/i.test(text)) {
        const arg = text.replace(/^[.!#/]\s*(?:autoreact|areact)\b/i, '').trim().toLowerCase();
        if (arg === 'status') {
            return await sendServiceToggleButtons(sock, chatId, 'status', message);
        }
        if (arg === 'clients' || arg === 'client') {
            return await sendServiceToggleButtons(sock, chatId, 'clients', message);
        }
        if (arg === 'every' || arg === 'all') {
            return await sendServiceToggleButtons(sock, chatId, 'every', message);
        }
        return await sendAutoReactServiceMenu(sock, chatId, message);
    }

    return false;
}

/**
 * Automatically react to incoming/outgoing messages or statuses based on active services
 */
async function processAutomaticMessageReactions(sock, chatUpdate) {
    if (!sock || typeof sock.sendMessage !== 'function') return;
    const messages = chatUpdate?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const cfg = getAutoReactConfig();
    if (!cfg.statusReact && !cfg.clientsMsgReact && !cfg.everyMsgReact) return;

    for (const msg of messages) {
        try {
            if (!msg || !msg.key || !msg.key.id || !msg.message) continue;
            // Ignore protocol/reaction messages themselves to avoid infinite loops
            if (
                msg.message.reactionMessage ||
                msg.message.protocolMessage ||
                msg.message.senderKeyDistributionMessage
            ) {
                continue;
            }

            const remoteJid = msg.key.remoteJid;
            if (!remoteJid) continue;

            // 1. Auto React on Status (status@broadcast)
            if (remoteJid === 'status@broadcast') {
                if (!cfg.statusReact) continue;
                if (rememberReactedId(`status_${msg.key.id}`)) continue;
                const emoji = pickRandomEmoji(cfg.statusEmojis);
                const participant = msg.key.participant || msg.participant;
                await sock.sendMessage(
                    'status@broadcast',
                    { react: { text: emoji, key: msg.key } },
                    participant ? { statusJidList: [participant] } : undefined
                ).catch(() => {});
                continue;
            }

            // Skip reacting to command messages starting with .autoreact / .status so buttons aren't interrupted
            const { text } = extractInteractiveInput(msg);
            if (/^[.!#/]\s*(?:autoreact|areact|status|poststatus|button|qouted|quoted)\b/i.test(text)) {
                continue;
            }

            const fromMe = Boolean(msg.key.fromMe);

            // 2. Auto React on Every Msg (including owner messages)
            if (cfg.everyMsgReact) {
                if (rememberReactedId(`msg_${msg.key.id}`)) continue;
                const emoji = pickRandomEmoji(cfg.msgEmojis);
                await sock.sendMessage(remoteJid, {
                    react: { text: emoji, key: msg.key }
                }).catch(() => {});
                continue;
            }

            // 3. Auto React on Clients Msg (only when !fromMe)
            if (cfg.clientsMsgReact && !fromMe) {
                if (rememberReactedId(`msg_${msg.key.id}`)) continue;
                const emoji = pickRandomEmoji(cfg.msgEmojis);
                await sock.sendMessage(remoteJid, {
                    react: { text: emoji, key: msg.key }
                }).catch(() => {});
            }
        } catch (_) {}
    }
}

module.exports = {
    getAutoReactConfig,
    saveAutoReactConfig,
    handleAutoReactCommandOrButton,
    processAutomaticMessageReactions,
    extractInteractiveInput
};
