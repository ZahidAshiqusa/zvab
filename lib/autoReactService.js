'use strict';

/**
 * Interactive Auto-React Service Engine with Custom Emoji Selection
 * Brand: Zaid Ashiq X Ultra V. Coder
 *
 * Supports 3 independent Auto-React services, each with its own Custom Emoji:
 * 1. Auto React on Status (status@broadcast) -> statusCustomEmoji
 * 2. Auto React on Clients Msg (incoming messages where !fromMe) -> clientsCustomEmoji
 * 3. Auto React on Every Msg (every message including owner's own messages) -> everyCustomEmoji
 *
 * Interactive WhatsApp Flow (.autoreact):
 * - Step 1: User types `.autoreact` -> Bot sends 3 service buttons:
 *     [1] Auto react on status
 *     [2] Auto react on clients msg
 *     [3] Auto react on every msg
 * - Step 2: User clicks a service button -> Bot sends 2 buttons for that service:
 *     [1] <Service> ON
 *     [2] <Service> OFF
 * - Step 3: When user clicks ON -> Bot enables the service and asks for Custom Emoji
 *     (with quick emoji buttons OR user can simply send/reply ANY custom emoji in chat!).
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR, ROOT_DIR } = require('./storagePaths');

let sendButtons = null;
try {
    sendButtons = require('kango-wa').sendButtons;
} catch (_) {
    sendButtons = null;
}

const AUTOREACT_CONFIG_PATH = path.join(DATA_DIR, 'autoreact_config.json');
const REPO_AUTOREACT_CONFIG_PATH = path.join(ROOT_DIR, 'data', 'autoreact_config.json');

const DEFAULT_CONFIG = {
    statusReact: true,
    clientsMsgReact: false,
    everyMsgReact: false,
    statusCustomEmoji: '❤️',
    clientsCustomEmoji: '❤️',
    everyCustomEmoji: '❤️',
    statusEmojis: ['❤️'],
    msgEmojis: ['❤️']
};

// Track which service a chat recently selected for ON/OFF
const pendingChatServiceSelection = new Map(); // chatId -> { serviceType, timestamp }

// Track which service a chat is currently choosing a Custom Emoji for
const pendingChatEmojiSelection = new Map(); // chatId -> { serviceType, timestamp }

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

/**
 * Parse a custom emoji string into an array of one or more emojis
 */
function parseEmojiInputList(rawEmoji, fallback = '❤️') {
    if (!rawEmoji) return [fallback];
    const str = String(rawEmoji).trim();
    if (!str) return [fallback];

    // Match all emoji grapheme sequences (including skin tones, ZWJ sequences, hearts, etc.)
    const emojiMatches = str.match(/(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})|[\u{1F3FB}-\u{1F3FF}])*/gu);
    if (emojiMatches && emojiMatches.length > 0) {
        return emojiMatches;
    }

    // Fallback: split by comma/space if non-standard symbol was provided
    const tokens = str.split(/[\s,]+/).filter(Boolean);
    return tokens.length > 0 ? tokens : [fallback];
}

function getAutoReactConfig() {
    try {
        if (fs.existsSync(AUTOREACT_CONFIG_PATH)) {
            const raw = JSON.parse(fs.readFileSync(AUTOREACT_CONFIG_PATH, 'utf8'));
            const statusCustomEmoji = String(raw.statusCustomEmoji || (Array.isArray(raw.statusEmojis) && raw.statusEmojis[0]) || DEFAULT_CONFIG.statusCustomEmoji).trim();
            const clientsCustomEmoji = String(raw.clientsCustomEmoji || (Array.isArray(raw.msgEmojis) && raw.msgEmojis[0]) || DEFAULT_CONFIG.clientsCustomEmoji).trim();
            const everyCustomEmoji = String(raw.everyCustomEmoji || (Array.isArray(raw.msgEmojis) && raw.msgEmojis[0]) || DEFAULT_CONFIG.everyCustomEmoji).trim();

            return {
                statusReact: raw.statusReact !== undefined ? Boolean(raw.statusReact) : DEFAULT_CONFIG.statusReact,
                clientsMsgReact: Boolean(raw.clientsMsgReact),
                everyMsgReact: Boolean(raw.everyMsgReact),
                statusCustomEmoji,
                clientsCustomEmoji,
                everyCustomEmoji,
                statusEmojis: parseEmojiInputList(statusCustomEmoji, '❤️'),
                msgEmojis: parseEmojiInputList(clientsCustomEmoji, '❤️')
            };
        }
    } catch (_) {}
    return { ...DEFAULT_CONFIG };
}

function saveAutoReactConfig(updates = {}) {
    const current = getAutoReactConfig();

    const statusCustomEmoji = updates.statusCustomEmoji !== undefined
        ? String(updates.statusCustomEmoji || '❤️').trim()
        : (Array.isArray(updates.statusEmojis) && updates.statusEmojis.length > 0
            ? updates.statusEmojis.join(' ')
            : current.statusCustomEmoji);

    const clientsCustomEmoji = updates.clientsCustomEmoji !== undefined
        ? String(updates.clientsCustomEmoji || '❤️').trim()
        : (Array.isArray(updates.msgEmojis) && updates.msgEmojis.length > 0
            ? updates.msgEmojis.join(' ')
            : current.clientsCustomEmoji);

    const everyCustomEmoji = updates.everyCustomEmoji !== undefined
        ? String(updates.everyCustomEmoji || '❤️').trim()
        : current.everyCustomEmoji;

    const next = {
        statusReact: updates.statusReact !== undefined ? Boolean(updates.statusReact) : current.statusReact,
        clientsMsgReact: updates.clientsMsgReact !== undefined ? Boolean(updates.clientsMsgReact) : current.clientsMsgReact,
        everyMsgReact: updates.everyMsgReact !== undefined ? Boolean(updates.everyMsgReact) : current.everyMsgReact,
        statusCustomEmoji: statusCustomEmoji || '❤️',
        clientsCustomEmoji: clientsCustomEmoji || '❤️',
        everyCustomEmoji: everyCustomEmoji || '❤️',
        statusEmojis: parseEmojiInputList(statusCustomEmoji, '❤️'),
        msgEmojis: parseEmojiInputList(clientsCustomEmoji, '❤️')
    };

    try {
        fs.mkdirSync(path.dirname(AUTOREACT_CONFIG_PATH), { recursive: true });
        fs.writeFileSync(AUTOREACT_CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
    } catch (err) {
        console.warn('[autoReact] Failed to save config:', err.message);
    }

    try {
        if (REPO_AUTOREACT_CONFIG_PATH !== AUTOREACT_CONFIG_PATH && fs.existsSync(path.dirname(REPO_AUTOREACT_CONFIG_PATH))) {
            fs.writeFileSync(REPO_AUTOREACT_CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
        }
    } catch (_) {}

    return next;
}

function pickServiceEmoji(customEmojiStr, fallbackList) {
    const parsed = parseEmojiInputList(customEmojiStr, '');
    if (parsed.length > 0 && parsed[0]) {
        return parsed[Math.floor(Math.random() * parsed.length)];
    }
    const arr = Array.isArray(fallbackList) && fallbackList.length > 0 ? fallbackList : ['❤️'];
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
        emojiKey: 'statusCustomEmoji',
        title: 'Auto React on Status',
        shortTarget: 'Status updates',
        desc: 'Automatically reacts with your custom emoji to WhatsApp Status stories (status@broadcast)'
    },
    clients: {
        key: 'clientsMsgReact',
        emojiKey: 'clientsCustomEmoji',
        title: 'Auto React on Clients Msg',
        shortTarget: 'Clients messages',
        desc: 'Automatically reacts with your custom emoji to incoming messages from clients/contacts'
    },
    every: {
        key: 'everyMsgReact',
        emojiKey: 'everyCustomEmoji',
        title: 'Auto React on Every Msg (Even Owner Msgs)',
        shortTarget: 'Every message (including Owner)',
        desc: 'Automatically reacts with your custom emoji to every message in chat including owner messages'
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
        `• *Auto React on Status:* ${cfg.statusReact ? '🟢 ON' : '🔴 OFF'} (Emoji: ${cfg.statusCustomEmoji || '❤️'})\n` +
        `• *Auto React on Clients Msg:* ${cfg.clientsMsgReact ? '🟢 ON' : '🔴 OFF'} (Emoji: ${cfg.clientsCustomEmoji || '❤️'})\n` +
        `• *Auto React on Every Msg (Even Owner):* ${cfg.everyMsgReact ? '🟢 ON' : '🔴 OFF'} (Emoji: ${cfg.everyCustomEmoji || '❤️'})`;

    const buttons = [
        { id: 'ar_srv_status', text: 'Auto react on status' },
        { id: 'ar_srv_clients', text: 'Auto react on clients msg' },
        { id: 'ar_srv_every', text: 'Auto react on every msg' }
    ];

    await dispatchCleanButtons(sock, chatId, statusText, buttons, message);
    return true;
}

/**
 * Step 2: Send ON/OFF Buttons when user selects one of the 3 Auto React services
 */
async function sendServiceToggleButtons(sock, chatId, serviceType, message) {
    const meta = SERVICE_META[serviceType];
    if (!meta) return false;

    pendingChatServiceSelection.set(chatId, {
        serviceType,
        timestamp: Date.now()
    });
    pendingChatEmojiSelection.delete(chatId);

    const cfg = getAutoReactConfig();
    const currentState = cfg[meta.key] ? 'ON 🟢' : 'OFF 🔴';
    const currentEmoji = cfg[meta.emojiKey] || '❤️';

    const promptText =
        `⚙️ *${meta.title}*\n` +
        `${meta.desc}\n\n` +
        `• Current Status: *${currentState}*\n` +
        `• Reaction Emoji: *${currentEmoji}*\n\n` +
        `Choose *ON* or *OFF* below:`;

    const buttons = [
        { id: `ar_toggle_${serviceType}_on`, text: `${meta.title} ON` },
        { id: `ar_toggle_${serviceType}_off`, text: `${meta.title} OFF` }
    ];

    await dispatchCleanButtons(sock, chatId, promptText, buttons, message);
    return true;
}

/**
 * Step 3A: When user turns ON a service (or requests emoji setup), ask for Custom Emoji!
 */
async function sendCustomEmojiPrompt(sock, chatId, serviceType, message) {
    const meta = SERVICE_META[serviceType];
    if (!meta) return false;

    // Enable the selected service immediately and wait for custom emoji choice
    const updated = saveAutoReactConfig({ [meta.key]: true });
    const currentEmoji = updated[meta.emojiKey] || '❤️';

    pendingChatServiceSelection.delete(chatId);
    pendingChatEmojiSelection.set(chatId, {
        serviceType,
        timestamp: Date.now()
    });

    const promptText =
        `🎨 *Custom Emoji for ${meta.title}*\n\n` +
        `✅ *${meta.title}* is now *ON 🟢* (Current Emoji: *${currentEmoji}*)\n\n` +
        `Which custom emoji do you want to react with on *${meta.shortTarget}*?\n` +
        `👉 *Send/reply ANY custom emoji in chat* (e.g. 💞, ❤️, 🔥, 😍, 👑, ⚡, 😂) or tap a quick emoji button below:`;

    const buttons = [
        { id: `ar_emoji_${serviceType}_💞`, text: '💞' },
        { id: `ar_emoji_${serviceType}_❤️`, text: '❤️' },
        { id: `ar_emoji_${serviceType}_🔥`, text: '🔥' },
        { id: `ar_emoji_${serviceType}_😍`, text: '😍' },
        { id: `ar_emoji_${serviceType}_👑`, text: '👑' }
    ];

    await dispatchCleanButtons(sock, chatId, promptText, buttons, message);
    return true;
}

/**
 * Step 3B: Save the user's chosen Custom Emoji for the service
 */
async function applyServiceCustomEmoji(sock, chatId, serviceType, rawEmojiInput, message) {
    const meta = SERVICE_META[serviceType];
    if (!meta) return false;

    const emojis = parseEmojiInputList(rawEmojiInput, '❤️');
    const customEmojiStr = emojis.join(' ');

    const updated = saveAutoReactConfig({
        [meta.key]: true,
        [meta.emojiKey]: customEmojiStr
    });

    pendingChatEmojiSelection.delete(chatId);
    pendingChatServiceSelection.delete(chatId);

    await sock.sendMessage(
        chatId,
        {
            text:
                `✅ *${meta.title}* Configured!\n\n` +
                `• *Status:* ON 🟢\n` +
                `• *Custom Reaction Emoji:* ${updated[meta.emojiKey]}\n\n` +
                `📊 *All Auto-React Services:*\n` +
                `• Status Auto-React: ${updated.statusReact ? `ON 🟢 (${updated.statusCustomEmoji})` : 'OFF 🔴'}\n` +
                `• Clients Msg Auto-React: ${updated.clientsMsgReact ? `ON 🟢 (${updated.clientsCustomEmoji})` : 'OFF 🔴'}\n` +
                `• Every Msg (Even Owner): ${updated.everyMsgReact ? `ON 🟢 (${updated.everyCustomEmoji})` : 'OFF 🔴'}`
        },
        { quoted: message }
    );
    return true;
}

/**
 * Apply OFF (or ON -> triggers custom emoji prompt) to the chosen Auto React service
 */
async function applyServiceToggle(sock, chatId, serviceType, enabled, message) {
    const meta = SERVICE_META[serviceType];
    if (!meta) return false;

    if (enabled) {
        return await sendCustomEmojiPrompt(sock, chatId, serviceType, message);
    }

    const updated = saveAutoReactConfig({ [meta.key]: false });
    pendingChatServiceSelection.delete(chatId);
    pendingChatEmojiSelection.delete(chatId);

    await sock.sendMessage(
        chatId,
        {
            text:
                `✅ *${meta.title}* is now *OFF 🔴*\n\n` +
                `• Status Auto-React: ${updated.statusReact ? `ON 🟢 (${updated.statusCustomEmoji})` : 'OFF 🔴'}\n` +
                `• Clients Msg Auto-React: ${updated.clientsMsgReact ? `ON 🟢 (${updated.clientsCustomEmoji})` : 'OFF 🔴'}\n` +
                `• Every Msg (Including Owner): ${updated.everyMsgReact ? `ON 🟢 (${updated.everyCustomEmoji})` : 'OFF 🔴'}`
        },
        { quoted: message }
    );
    return true;
}

/**
 * Check if a string contains at least one emoji (and is not a bot dot-command)
 */
function looksLikeCustomEmojiReply(str) {
    if (!str) return false;
    const trimmed = String(str).trim();
    if (!trimmed || trimmed.length > 32) return false;
    if (/^[.!#/@]/.test(trimmed)) return false;
    return /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})/u.test(trimmed);
}

/**
 * Handle `.autoreact` command, its 3-button / 2-button responses, and custom emoji replies
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

    // 2. Check explicit button IDs from Step 3 (Quick Custom Emoji Button Click: ar_emoji_<service>_<emoji>)
    const emojiBtnMatch = id.match(/^ar_emoji_(status|clients|every)_(.+)$/i);
    if (emojiBtnMatch) {
        const srv = emojiBtnMatch[1].toLowerCase();
        const chosenEmoji = emojiBtnMatch[2].trim();
        return await applyServiceCustomEmoji(sock, chatId, srv, chosenEmoji, message);
    }

    // 3. Check explicit button IDs or button texts from Step 2 (ON / OFF Toggle)
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

    // 4. If chat is waiting for a Custom Emoji reply (Step 3) and user sends any emoji in chat
    const pendingEmoji = pendingChatEmojiSelection.get(chatId);
    if (pendingEmoji && Date.now() - pendingEmoji.timestamp < 5 * 60 * 1000) {
        if (looksLikeCustomEmojiReply(text)) {
            return await applyServiceCustomEmoji(sock, chatId, pendingEmoji.serviceType, text.trim(), message);
        }
    }

    // 5. If chat has a recent pending service selection (Step 2) and user replies "on", "off", or directly an emoji
    const pending = pendingChatServiceSelection.get(chatId);
    if (pending && Date.now() - pending.timestamp < 5 * 60 * 1000) {
        if (lowerText === 'on' || lowerText === '1') {
            return await applyServiceToggle(sock, chatId, pending.serviceType, true, message);
        }
        if (lowerText === 'off' || lowerText === '2') {
            return await applyServiceToggle(sock, chatId, pending.serviceType, false, message);
        }
        if (looksLikeCustomEmojiReply(text)) {
            return await applyServiceCustomEmoji(sock, chatId, pending.serviceType, text.trim(), message);
        }
    }

    // 6. Direct `.autoreact` / `.areact` command (supports `.autoreact`, `.autoreact status 💞`, `.autoreact clients 🔥`, `.autoreact every 👑`)
    if (/^[.!#/]\s*(?:autoreact|areact)\b/i.test(text)) {
        const rawArgs = text.replace(/^[.!#/]\s*(?:autoreact|areact)\b/i, '').trim();
        const parts = rawArgs.split(/\s+/).filter(Boolean);
        const first = (parts[0] || '').toLowerCase();
        const restEmoji = parts.slice(1).join(' ').trim();

        if (first === 'status') {
            if (restEmoji && looksLikeCustomEmojiReply(restEmoji)) {
                return await applyServiceCustomEmoji(sock, chatId, 'status', restEmoji, message);
            }
            return await sendServiceToggleButtons(sock, chatId, 'status', message);
        }
        if (first === 'clients' || first === 'client' || first === 'msg') {
            if (restEmoji && looksLikeCustomEmojiReply(restEmoji)) {
                return await applyServiceCustomEmoji(sock, chatId, 'clients', restEmoji, message);
            }
            return await sendServiceToggleButtons(sock, chatId, 'clients', message);
        }
        if (first === 'every' || first === 'all') {
            if (restEmoji && looksLikeCustomEmojiReply(restEmoji)) {
                return await applyServiceCustomEmoji(sock, chatId, 'every', restEmoji, message);
            }
            return await sendServiceToggleButtons(sock, chatId, 'every', message);
        }
        // If user typed `.autoreact 💞`, apply custom emoji to all active services (or status + msg)
        if (rawArgs && looksLikeCustomEmojiReply(rawArgs)) {
            const emojis = parseEmojiInputList(rawArgs, '❤️').join(' ');
            const updated = saveAutoReactConfig({
                statusCustomEmoji: emojis,
                clientsCustomEmoji: emojis,
                everyCustomEmoji: emojis
            });
            await sock.sendMessage(
                chatId,
                {
                    text:
                        `✅ *Custom Auto-React Emoji Updated to ${emojis}*\n\n` +
                        `• Status Auto-React: ${updated.statusReact ? 'ON 🟢' : 'OFF 🔴'} (${updated.statusCustomEmoji})\n` +
                        `• Clients Msg Auto-React: ${updated.clientsMsgReact ? 'ON 🟢' : 'OFF 🔴'} (${updated.clientsCustomEmoji})\n` +
                        `• Every Msg Auto-React: ${updated.everyMsgReact ? 'ON 🟢' : 'OFF 🔴'} (${updated.everyCustomEmoji})`
                },
                { quoted: message }
            );
            return true;
        }
        return await sendAutoReactServiceMenu(sock, chatId, message);
    }

    return false;
}

/**
 * Automatically react to incoming/outgoing messages or statuses using the configured custom emoji
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

            // 1. Auto React on Status (status@broadcast) using statusCustomEmoji
            if (remoteJid === 'status@broadcast') {
                if (!cfg.statusReact) continue;
                if (rememberReactedId(`status_${msg.key.id}`)) continue;
                const emoji = pickServiceEmoji(cfg.statusCustomEmoji, cfg.statusEmojis);
                const participant = msg.key.participant || msg.participant;
                await sock.sendMessage(
                    'status@broadcast',
                    { react: { text: emoji, key: msg.key } },
                    participant ? { statusJidList: [participant] } : undefined
                ).catch(() => {});
                continue;
            }

            // Skip reacting to command/configuration messages so interactive prompts aren't interrupted
            const { id, text } = extractInteractiveInput(msg);
            if (
                id.startsWith('ar_') ||
                pendingChatEmojiSelection.has(remoteJid) ||
                pendingChatServiceSelection.has(remoteJid) ||
                /^[.!#/]\s*(?:autoreact|areact|status|poststatus|button|qouted|quoted|char|variable)\b/i.test(text)
            ) {
                continue;
            }

            const fromMe = Boolean(msg.key.fromMe);

            // 2. Auto React on Every Msg (including owner messages) using everyCustomEmoji
            if (cfg.everyMsgReact) {
                if (rememberReactedId(`msg_${msg.key.id}`)) continue;
                const emoji = pickServiceEmoji(cfg.everyCustomEmoji, cfg.msgEmojis);
                await sock.sendMessage(remoteJid, {
                    react: { text: emoji, key: msg.key }
                }).catch(() => {});
                continue;
            }

            // 3. Auto React on Clients Msg (only when !fromMe) using clientsCustomEmoji
            if (cfg.clientsMsgReact && !fromMe) {
                if (rememberReactedId(`msg_${msg.key.id}`)) continue;
                const emoji = pickServiceEmoji(cfg.clientsCustomEmoji, cfg.msgEmojis);
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
