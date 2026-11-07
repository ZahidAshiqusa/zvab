'use strict';

/**
 * WhatsApp Channel Auto-Reactor Service (.char)
 * Owner: Zaid Ashiq X Ultra V. Coder
 *
 * Usage:
 *   .char https://whatsapp.com/channel/XXXX 💞
 *   .char 120363404284793169@newsletter 💞
 *   .char (lists all tracked channels with interactive ON/OFF & Delete buttons)
 *
 * Automatically reacts with the configured emoji (e.g. 💞) on every new post
 * published in the given WhatsApp Channel (@newsletter).
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

const CHAR_CONFIG_PATH = path.join(DATA_DIR, 'channel_autoreact.json');
const REPO_CHAR_CONFIG_PATH = path.join(ROOT_DIR, 'data', 'channel_autoreact.json');

// Deduplication set so we never react twice to the same channel post
const reactedPostKeys = new Set();
function markPostReacted(key) {
    if (!key) return false;
    if (reactedPostKeys.has(key)) return true;
    reactedPostKeys.add(key);
    if (reactedPostKeys.size > 1000) {
        const oldest = reactedPostKeys.values().next().value;
        reactedPostKeys.delete(oldest);
    }
    return false;
}

function loadCharRules() {
    try {
        if (fs.existsSync(CHAR_CONFIG_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(CHAR_CONFIG_PATH, 'utf8'));
            if (Array.isArray(parsed.rules)) return parsed;
        }
    } catch (_) {}
    return { rules: [] };
}

function saveCharRules(data) {
    const payload = {
        rules: Array.isArray(data?.rules) ? data.rules : [],
        updatedAt: new Date().toISOString()
    };
    try {
        fs.writeFileSync(CHAR_CONFIG_PATH, JSON.stringify(payload, null, 2), 'utf8');
    } catch (_) {}
    try {
        if (REPO_CHAR_CONFIG_PATH !== CHAR_CONFIG_PATH && fs.existsSync(path.dirname(REPO_CHAR_CONFIG_PATH))) {
            fs.writeFileSync(REPO_CHAR_CONFIG_PATH, JSON.stringify(payload, null, 2), 'utf8');
        }
    } catch (_) {}
    return payload;
}

/**
 * Parse a WhatsApp channel URL, invite code, or @newsletter JID
 */
function parseChannelIdentifier(rawInput) {
    if (!rawInput) return null;
    const str = String(rawInput).trim();

    // 1. Full URL: https://whatsapp.com/channel/0029Va... or https://www.whatsapp.com/channel/0029Va.../123
    const urlMatch = str.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i);
    if (urlMatch) {
        return {
            type: 'invite',
            key: urlMatch[1],
            inviteCode: urlMatch[1],
            inviteUrl: `https://whatsapp.com/channel/${urlMatch[1]}`
        };
    }

    // 2. Direct @newsletter JID: 120363...@newsletter
    const jidMatch = str.match(/(\d+@newsletter)/i);
    if (jidMatch) {
        return {
            type: 'jid',
            key: jidMatch[1].toLowerCase(),
            channelJid: jidMatch[1].toLowerCase(),
            inviteUrl: ''
        };
    }

    // 3. Bare invite code (10+ alphanumeric characters)
    if (/^[A-Za-z0-9_-]{10,}$/.test(str) && !str.includes('@')) {
        return {
            type: 'invite',
            key: str,
            inviteCode: str,
            inviteUrl: `https://whatsapp.com/channel/${str}`
        };
    }

    return null;
}

/**
 * Extract channel reference and reaction emoji from `.char <link> <emoji>`
 */
function parseCharCommandArgs(rawArgs) {
    const trimmed = String(rawArgs || '').trim();
    if (!trimmed) return { sub: 'list' };

    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const firstLower = tokens[0].toLowerCase();

    if (['list', 'status'].includes(firstLower)) {
        return { sub: 'list' };
    }
    if (['del', 'delete', 'remove', 'rm'].includes(firstLower) && tokens[1]) {
        return { sub: 'delete', target: tokens[1] };
    }
    if (['off', 'disable', 'pause'].includes(firstLower) && tokens[1]) {
        return { sub: 'toggle', enabled: false, target: tokens[1] };
    }
    if (['on', 'enable', 'resume'].includes(firstLower) && tokens[1]) {
        return { sub: 'toggle', enabled: true, target: tokens[1] };
    }

    // Standard: .char {chanellink} 💞 (or .char 💞 {chanellink})
    let channelToken = null;
    let emojiTokens = [];

    for (const tok of tokens) {
        if (!channelToken && parseChannelIdentifier(tok)) {
            channelToken = tok;
        } else {
            emojiTokens.push(tok);
        }
    }

    if (!channelToken) {
        return { sub: 'invalid', raw: trimmed };
    }

    const parsedChannel = parseChannelIdentifier(channelToken);
    const emoji = emojiTokens.join(' ').trim() || '💞';

    return {
        sub: 'add',
        parsedChannel,
        emoji
    };
}

/**
 * Resolve channel metadata via active Baileys socket if available
 */
async function resolveAndSubscribeChannel(sock, parsedChannel) {
    let channelJid = parsedChannel.channelJid || null;
    let inviteCode = parsedChannel.inviteCode || '';
    let inviteUrl = parsedChannel.inviteUrl || '';
    let channelName = '';
    let subscribersCount = null;

    if (sock && typeof sock.newsletterMetadata === 'function') {
        try {
            const meta = await sock.newsletterMetadata(parsedChannel.type, parsedChannel.key);
            if (meta) {
                if (meta.id) channelJid = String(meta.id).toLowerCase();
                if (meta.name || meta.thread_metadata?.name?.text) {
                    channelName = meta.name || meta.thread_metadata?.name?.text || '';
                }
                if (meta.invite || meta.thread_metadata?.invite) {
                    inviteCode = meta.invite || meta.thread_metadata?.invite;
                    inviteUrl = `https://whatsapp.com/channel/${inviteCode}`;
                }
                if (meta.subscribers !== undefined) {
                    subscribersCount = meta.subscribers;
                }
            }
        } catch (err) {
            console.warn(`[char] newsletterMetadata lookup warning (${parsedChannel.key}):`, err.message);
        }
    }

    // Automatically follow/subscribe to the channel so the bot receives live messages.upsert events
    if (channelJid && sock && typeof sock.newsletterFollow === 'function') {
        try {
            await sock.newsletterFollow(channelJid);
            console.log(`[char] ✅ Auto-followed WhatsApp Channel ${channelJid}`);
        } catch (_) {}
    }

    return {
        id: channelJid || inviteCode || parsedChannel.key,
        channelJid: channelJid || null,
        inviteCode: inviteCode || null,
        inviteUrl: inviteUrl || (inviteCode ? `https://whatsapp.com/channel/${inviteCode}` : ''),
        channelName: channelName || (channelJid ? `Channel ${channelJid.split('@')[0]}` : `Channel ${inviteCode}`),
        subscribersCount
    };
}

/**
 * Add or update a channel auto-react rule
 */
async function addOrUpdateCharRule(sock, rawChannelInput, emoji = '💞') {
    const parsedChannel = typeof rawChannelInput === 'object' && rawChannelInput.type
        ? rawChannelInput
        : parseChannelIdentifier(rawChannelInput);

    if (!parsedChannel) {
        throw new Error('Invalid WhatsApp Channel link or @newsletter JID. Copy the exact link from WhatsApp (https://whatsapp.com/channel/...).');
    }

    const cleanEmoji = String(emoji || '💞').trim() || '💞';
    const resolved = await resolveAndSubscribeChannel(sock, parsedChannel);

    const store = loadCharRules();
    const existingIdx = store.rules.findIndex(r =>
        (resolved.channelJid && r.channelJid === resolved.channelJid) ||
        (resolved.inviteCode && r.inviteCode && r.inviteCode.toLowerCase() === resolved.inviteCode.toLowerCase()) ||
        (r.id === resolved.id)
    );

    const now = new Date().toISOString();
    let savedRule;

    if (existingIdx >= 0) {
        savedRule = {
            ...store.rules[existingIdx],
            channelJid: resolved.channelJid || store.rules[existingIdx].channelJid,
            inviteCode: resolved.inviteCode || store.rules[existingIdx].inviteCode,
            inviteUrl: resolved.inviteUrl || store.rules[existingIdx].inviteUrl,
            channelName: resolved.channelName || store.rules[existingIdx].channelName,
            emoji: cleanEmoji,
            enabled: true,
            updatedAt: now
        };
        store.rules[existingIdx] = savedRule;
    } else {
        savedRule = {
            id: resolved.id,
            channelJid: resolved.channelJid,
            inviteCode: resolved.inviteCode,
            inviteUrl: resolved.inviteUrl,
            channelName: resolved.channelName,
            emoji: cleanEmoji,
            enabled: true,
            reactCount: 0,
            lastReactedAt: null,
            createdAt: now,
            updatedAt: now
        };
        store.rules.unshift(savedRule);
    }

    saveCharRules(store);
    return { rule: savedRule, rules: store.rules };
}

function toggleCharRule(idOrTarget, enabledBool) {
    const target = String(idOrTarget || '').trim();
    const parsed = parseChannelIdentifier(target);
    const store = loadCharRules();

    const rule = store.rules.find(r =>
        r.id === target ||
        r.channelJid === target ||
        (r.inviteCode && r.inviteCode.toLowerCase() === target.toLowerCase()) ||
        (parsed?.inviteCode && r.inviteCode?.toLowerCase() === parsed.inviteCode.toLowerCase()) ||
        (parsed?.channelJid && r.channelJid === parsed.channelJid)
    );

    if (!rule) return null;
    rule.enabled = Boolean(enabledBool);
    rule.updatedAt = new Date().toISOString();
    saveCharRules(store);
    return rule;
}

function deleteCharRule(idOrTarget) {
    const target = String(idOrTarget || '').trim();
    const parsed = parseChannelIdentifier(target);
    const store = loadCharRules();
    const beforeLen = store.rules.length;

    store.rules = store.rules.filter(r => !(
        r.id === target ||
        r.channelJid === target ||
        (r.inviteCode && r.inviteCode.toLowerCase() === target.toLowerCase()) ||
        (parsed?.inviteCode && r.inviteCode?.toLowerCase() === parsed.inviteCode.toLowerCase()) ||
        (parsed?.channelJid && r.channelJid === parsed.channelJid)
    ));

    saveCharRules(store);
    return store.rules.length < beforeLen;
}

/**
 * React to a specific channel post via Baileys newsletterReactMessage (with fallback)
 */
async function reactToChannelPost(sock, channelJid, msg, emoji) {
    if (!sock || !channelJid || !emoji) return false;

    // Extract newsletter server_id (required by WhatsApp for @newsletter reactions)
    const serverId =
        msg?.key?.server_id ||
        msg?.newsletterServerId ||
        msg?.serverId ||
        msg?.messageStubParameters?.[0] ||
        msg?.key?.id ||
        null;

    if (!serverId) return false;

    const dedupKey = `${channelJid}:${serverId}:${emoji}`;
    if (markPostReacted(dedupKey)) return false;

    let reacted = false;

    // 1. Primary Baileys method for WhatsApp Channels (@newsletter)
    if (typeof sock.newsletterReactMessage === 'function') {
        try {
            await sock.newsletterReactMessage(channelJid, String(serverId), emoji);
            reacted = true;
        } catch (err) {
            console.warn(`[char] newsletterReactMessage failed for ${channelJid} (serverId=${serverId}):`, err.message);
        }
    }

    // 2. Fallback: standard sendMessage react if newsletterReactMessage is unavailable or failed
    if (!reacted && typeof sock.sendMessage === 'function' && msg?.key) {
        try {
            await sock.sendMessage(channelJid, {
                react: {
                    text: emoji,
                    key: msg.key
                }
            });
            reacted = true;
        } catch (_) {}
    }

    if (reacted) {
        console.log(`[char] 💞 Auto-reacted "${emoji}" to new post #${serverId} in channel ${channelJid}`);
    }
    return reacted;
}

/**
 * Inspect incoming messages.upsert for any @newsletter post matching our tracked channels
 */
async function handleIncomingChannelPosts(sock, chatUpdate) {
    const messages = chatUpdate?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const store = loadCharRules();
    const activeRules = store.rules.filter(r => r.enabled);
    if (activeRules.length === 0) return;

    // Resolve any rule that only had an inviteCode (if socket wasn't connected when added)
    let rulesUpdated = false;
    for (const rule of activeRules) {
        if (!rule.channelJid && rule.inviteCode && sock && typeof sock.newsletterMetadata === 'function') {
            try {
                const meta = await sock.newsletterMetadata('invite', rule.inviteCode);
                if (meta?.id) {
                    rule.channelJid = String(meta.id).toLowerCase();
                    if (meta.name) rule.channelName = meta.name;
                    rulesUpdated = true;
                    if (typeof sock.newsletterFollow === 'function') {
                        await sock.newsletterFollow(rule.channelJid).catch(() => {});
                    }
                }
            } catch (_) {}
        }
    }

    for (const msg of messages) {
        const remoteJid = String(msg?.key?.remoteJid || '').toLowerCase();
        if (!remoteJid.endsWith('@newsletter')) continue;

        const matchingRule = activeRules.find(r =>
            r.channelJid && r.channelJid.toLowerCase() === remoteJid
        );
        if (!matchingRule) continue;

        const ok = await reactToChannelPost(sock, remoteJid, msg, matchingRule.emoji || '💞');
        if (ok) {
            matchingRule.reactCount = (Number(matchingRule.reactCount) || 0) + 1;
            matchingRule.lastReactedAt = new Date().toISOString();
            rulesUpdated = true;
        }
    }

    if (rulesUpdated) {
        saveCharRules(store);
    }
}

/**
 * Send clean interactive buttons without caption/footer
 */
async function sendCleanCharButtons(sock, chatId, text, buttons, quotedMsg) {
    if (sendButtons) {
        try {
            await sendButtons(sock, chatId, {
                title: '',
                text,
                footer: '',
                buttons: buttons.map(b => ({ id: b.id, text: b.text }))
            });
            return;
        } catch (_) {}
    }

    try {
        await sock.sendMessage(chatId, {
            text,
            buttons: buttons.map(b => ({
                buttonId: b.id,
                buttonText: { displayText: b.text },
                type: 1
            })),
            headerType: 1
        }, quotedMsg ? { quoted: quotedMsg } : {});
    } catch (_) {
        await sock.sendMessage(chatId, { text }, quotedMsg ? { quoted: quotedMsg } : {});
    }
}

/**
 * Handle WhatsApp .char command and button callbacks
 */
async function handleCharCommand(sock, chatId, message, rawText = '') {
    const trimmed = String(rawText || '').trim();

    // Check button callbacks: .char_toggle:<id>:<on|off> or .char_del:<id>
    const toggleMatch = trimmed.match(/^[.!#/]?\s*char_toggle:([^:]+):(on|off)$/i);
    if (toggleMatch) {
        const targetId = toggleMatch[1];
        const enable = toggleMatch[2].toLowerCase() === 'on';
        const updated = toggleCharRule(targetId, enable);
        if (!updated) {
            await sock.sendMessage(chatId, { text: `❌ Channel rule not found.` }, { quoted: message });
            return true;
        }
        await sock.sendMessage(chatId, {
            text: `✅ Channel Auto-React for *${updated.channelName}* (${updated.emoji}) is now *${enable ? 'ON ✅' : 'OFF ❌'}*`
        }, { quoted: message });
        return true;
    }

    const delMatch = trimmed.match(/^[.!#/]?\s*char_del:(.+)$/i);
    if (delMatch) {
        const targetId = delMatch[1].trim();
        const removed = deleteCharRule(targetId);
        await sock.sendMessage(chatId, {
            text: removed
                ? `🗑️ Removed Channel Auto-React rule for \`${targetId}\`.`
                : `❌ Channel rule not found.`
        }, { quoted: message });
        return true;
    }

    const body = trimmed.replace(/^[.!#/]?\s*(?:char|channelreact|creact)\b/i, '').trim();
    const parsed = parseCharCommandArgs(body);

    if (parsed.sub === 'list') {
        const { rules } = loadCharRules();
        if (rules.length === 0) {
            await sock.sendMessage(chatId, {
                text:
                    `💞 *WhatsApp Channel Auto-Reactor (.char)*\n\n` +
                    `No channels are configured yet.\n\n` +
                    `*Usage:*\n` +
                    `\`.char https://whatsapp.com/channel/XXXX 💞\`\n\n` +
                    `Reacts automatically with your chosen emoji on every new post published in that channel.`
            }, { quoted: message });
            return true;
        }

        const lines = rules.map((r, i) => {
            const state = r.enabled ? '✅ ON' : '❌ OFF';
            const linkOrJid = r.inviteUrl || r.channelJid || r.id;
            return `${i + 1}. *${r.channelName}* — ${r.emoji} (${state})\n   🔗 ${linkOrJid}\n   📊 Reacted Posts: ${r.reactCount || 0}`;
        }).join('\n\n');

        const first = rules[0];
        const buttons = [];
        if (first) {
            buttons.push({
                id: `.char_toggle:${first.id}:${first.enabled ? 'off' : 'on'}`,
                text: `${first.enabled ? 'Pause' : 'Resume'} ${first.channelName.slice(0, 14)}`
            });
            buttons.push({
                id: `.char_del:${first.id}`,
                text: `Remove ${first.channelName.slice(0, 14)}`
            });
        }

        const msgText =
            `💞 *Active Channel Auto-React Rules (${rules.length})*\n\n` +
            `${lines}\n\n` +
            `*Commands:*\n` +
            `• \`.char {channellink} 💞\` — Add or update channel emoji\n` +
            `• \`.char off {channellink}\` — Pause channel auto-react\n` +
            `• \`.char del {channellink}\` — Remove channel`;

        if (buttons.length > 0) {
            await sendCleanCharButtons(sock, chatId, msgText, buttons, message);
        } else {
            await sock.sendMessage(chatId, { text: msgText }, { quoted: message });
        }
        return true;
    }

    if (parsed.sub === 'invalid') {
        await sock.sendMessage(chatId, {
            text:
                `❌ *Invalid Channel Link Format*\n\n` +
                `*Usage:*\n` +
                `\`.char https://whatsapp.com/channel/XXXX 💞\`\n` +
                `or\n` +
                `\`.char 120363404284793169@newsletter 💞\``
        }, { quoted: message });
        return true;
    }

    if (parsed.sub === 'delete') {
        const removed = deleteCharRule(parsed.target);
        await sock.sendMessage(chatId, {
            text: removed
                ? `🗑️ Channel Auto-React removed for \`${parsed.target}\`.`
                : `❌ No matching channel rule found for \`${parsed.target}\`.`
        }, { quoted: message });
        return true;
    }

    if (parsed.sub === 'toggle') {
        const updated = toggleCharRule(parsed.target, parsed.enabled);
        if (!updated) {
            await sock.sendMessage(chatId, {
                text: `❌ No matching channel rule found for \`${parsed.target}\`.`
            }, { quoted: message });
            return true;
        }
        await sock.sendMessage(chatId, {
            text: `✅ Channel Auto-React for *${updated.channelName}* (${updated.emoji}) is now *${updated.enabled ? 'ON ✅' : 'OFF ❌'}*.`
        }, { quoted: message });
        return true;
    }

    // Add / Update rule: .char {chanellink} 💞
    const { rule } = await addOrUpdateCharRule(sock, parsed.parsedChannel, parsed.emoji);
    const confirmText =
        `💞 *Channel Auto-Reactor Activated*\n\n` +
        `📢 *Channel:* ${rule.channelName}\n` +
        (rule.channelJid ? `🆔 *Channel JID:* \`${rule.channelJid}\`\n` : '') +
        (rule.inviteUrl ? `🔗 *Link:* ${rule.inviteUrl}\n` : '') +
        `✨ *Auto-React Emoji:* ${rule.emoji}\n` +
        `📡 *Status:* *ON ✅ (Listening for every new post)*`;

    await sendCleanCharButtons(sock, chatId, confirmText, [
        { id: `.char_toggle:${rule.id}:off`, text: 'Turn OFF' },
        { id: `.char_del:${rule.id}`, text: 'Remove Channel' }
    ], message);
    return true;
}

module.exports = {
    loadCharRules,
    saveCharRules,
    parseChannelIdentifier,
    addOrUpdateCharRule,
    toggleCharRule,
    deleteCharRule,
    handleIncomingChannelPosts,
    handleCharCommand
};
