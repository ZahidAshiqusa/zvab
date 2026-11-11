'use strict';

/**
 * Zaid Ashiq X Ultra V. Coder Custom WhatsApp Commands
 * Owner: Zaid Ashiq X Ultra V. Coder (+254141693915)
 *
 * Implements:
 * 1. .button/msg/buttonlimit/button1/button2 (+targetNumber) — Pure msg + buttons, NO caption/footer
 * 2. .ptv +923number (send replied video as circular video note)
 * 3. .voice +923number (send replied audio/video as voice note PTT)
 * 4. .😍 (unlock View-Once media and send exclusively to Owner DM +254141693915)
 * 5. .qouted msg1/replied +number (send fake-quoted reply to target number — NO caption/footer)
 * 6. .online +9232number (subscribe & trace real-time online presence history)
 * 7. .status (3-button privacy selector: Everyone in contact, Only share with, Exclude people)
 * 8. .autoreact (3-service interactive selector -> 2-button ON/OFF toggle)
 * 9. Owner-only lock: Sending msg commands work ONLY for the owner of the linked WhatsApp number
 */

const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { bot } = require('../lib/pluginLoader');
const database = require('../lib/database');
const { VAULT_DIR } = require('../lib/storagePaths');
const simDatabase = require('../lib/simDatabase');
const autoReactService = require('../lib/autoReactService');
const variableService = require('../lib/variableService');
const contactsAndChatsService = require('../lib/contactsAndChatsService');
const { isLinkedSessionOwner } = require('../lib/statusService');

let sendButtons = null;
try {
    sendButtons = require('kango-wa').sendButtons;
} catch (_) {
    sendButtons = null;
}

const OWNER_CLEAN_NUMBER = '254141693915';
const OWNER_JID = `${OWNER_CLEAN_NUMBER}@s.whatsapp.net`;
const OWNER_NAME = 'Zaid Ashiq X Ultra V. Coder';

// Deduplication set so pre-processor and plugin loader never double-fire on the same message ID
const processedCommandIds = new Set();
function markProcessed(msgId) {
    if (!msgId) return false;
    if (processedCommandIds.has(msgId)) return true;
    processedCommandIds.add(msgId);
    if (processedCommandIds.size > 500) {
        const first = processedCommandIds.values().next().value;
        processedCommandIds.delete(first);
    }
    return false;
}

// Helper: Normalize phone number string into clean digits and WhatsApp JID
function parsePhoneNumber(raw) {
    if (!raw) return null;
    let digits = String(raw).replace(/[^0-9]/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.startsWith('0') && digits.length === 11) {
        digits = '92' + digits.slice(1);
    }
    if (digits.length < 7 || digits.length > 16) return null;
    return {
        clean: digits,
        jid: `${digits}@s.whatsapp.net`
    };
}

// Helper: Extract raw text (including interactive button responses) from a Baileys message object
function extractRawText(message) {
    if (!message || !message.message) return '';
    let m = message.message;
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;

    let interactiveText =
        m.buttonsResponseMessage?.selectedButtonId ||
        m.buttonsResponseMessage?.selectedDisplayText ||
        m.templateButtonReplyMessage?.selectedId ||
        m.templateButtonReplyMessage?.selectedDisplayText ||
        m.listResponseMessage?.singleSelectReply?.selectedRowId ||
        m.listResponseMessage?.title ||
        '';

    if (m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
        try {
            const params = JSON.parse(m.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
            interactiveText = params.id || params.display_text || interactiveText;
        } catch (_) {}
    }

    return (
        interactiveText ||
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        ''
    ).trim();
}

// Helper: Extract contextInfo & quotedMessage from a Baileys message
function getQuotedContext(message) {
    if (!message || !message.message) return { quotedMessage: null, contextInfo: null };
    let m = message.message;
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;

    const contextInfo =
        m.extendedTextMessage?.contextInfo ||
        m.imageMessage?.contextInfo ||
        m.videoMessage?.contextInfo ||
        m.audioMessage?.contextInfo ||
        m.documentMessage?.contextInfo ||
        m.stickerMessage?.contextInfo ||
        null;

    return {
        contextInfo,
        quotedMessage: contextInfo?.quotedMessage || null,
        quotedParticipant: contextInfo?.participant || contextInfo?.remoteJid || null,
        stanzaId: contextInfo?.stanzaId || null
    };
}

// Helper: Download media stream into a Buffer
async function downloadBuffer(mediaNode, type) {
    const stream = await downloadContentFromMessage(mediaNode, type);
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. .button/msg/buttonlimit/button1/button2 (+number)
//    Strictly sends ONLY message + buttons (NO caption / NO footer)
// ─────────────────────────────────────────────────────────────────────────────
async function executeButtonCommand(sock, chatId, message, rawInput) {
    if (!isLinkedSessionOwner(sock, message)) return;

    let body = String(rawInput || '').replace(/^[.!#/]?\s*button\b/i, '').trim();
    if (body.startsWith('/')) body = body.slice(1).trim();

    if (!body) {
        await sock.sendMessage(chatId, {
            text:
                `🔘 *${OWNER_NAME} Button Command*\n\n` +
                `*Usage 1:*\n` +
                `\`.button/Your Message/2/Button 1/Button 2 +923001234567\`\n\n` +
                `*Usage 2:*\n` +
                `\`.button/+923001234567/Your Message/2/Button 1/Button 2\``
        }, { quoted: message });
        return;
    }

    let targetPhone = null;
    const slashParts = body.split('/').map(s => s.trim()).filter(Boolean);

    if (slashParts.length >= 3) {
        const firstCandidate = parsePhoneNumber(slashParts[0]);
        if (firstCandidate && /^[+\d\s-]+$/.test(slashParts[0])) {
            targetPhone = firstCandidate;
            slashParts.shift();
        }
    }

    if (!targetPhone && slashParts.length >= 2) {
        const lastPart = slashParts[slashParts.length - 1];
        if (/^[+]?\d[\d\s-]{6,15}$/.test(lastPart)) {
            targetPhone = parsePhoneNumber(lastPart);
            if (targetPhone) slashParts.pop();
        } else {
            const trailingMatch = lastPart.match(/^(.*?)\s+([+]?\d[\d\s-]{6,15})$/);
            if (trailingMatch) {
                const parsed = parsePhoneNumber(trailingMatch[2]);
                if (parsed) {
                    targetPhone = parsed;
                    slashParts[slashParts.length - 1] = trailingMatch[1].trim();
                }
            }
        }
    }

    if (!targetPhone) {
        await sock.sendMessage(chatId, {
            text:
                `❌ *Target Phone Number Required!*\n\n` +
                `Please include the target number with country code:\n` +
                `• \`.button/Hello/2/Yes/No +923001234567\`\n` +
                `• \`.button/+923001234567/Hello/2/Yes/No\``
        }, { quoted: message });
        return;
    }

    const msgText = slashParts[0] || 'Hello!';
    const parsedLimit = parseInt(slashParts[1], 10);
    const buttonLimit = !isNaN(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 5) : 2;
    const rawButtonLabels = slashParts.slice(2).filter(Boolean);

    if (rawButtonLabels.length === 0) {
        rawButtonLabels.push('Option 1', 'Option 2');
    }

    const finalLabels = rawButtonLabels.slice(0, buttonLimit);
    const formattedButtons = finalLabels.map((label, idx) => ({
        id: `zaid_btn_${idx + 1}`,
        text: label
    }));

    let sentInteractive = false;

    // Strictly NO caption / NO footer in button message!
    if (sendButtons) {
        try {
            await sendButtons(sock, targetPhone.jid, {
                text: msgText,
                buttons: formattedButtons
            });
            sentInteractive = true;
        } catch (err) {
            console.warn('[.button] sendButtons fallback:', err.message);
        }
    }

    if (!sentInteractive) {
        const buttonLines = formattedButtons.map((b) => `[ ${b.text} ]`).join('\n');
        const fallbackText = `${msgText}\n\n${buttonLines}`;
        await sock.sendMessage(targetPhone.jid, { text: fallbackText });
    }

    await sock.sendMessage(chatId, {
        text:
            `✅ *Button Message Sent!*\n\n` +
            `📱 *To:* +${targetPhone.clean}\n` +
            `📝 *Message:* ${msgText}\n` +
            `🔘 *Buttons:* ${formattedButtons.map(b => b.text).join(', ')}`
    }, { quoted: message });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. .ptv +923number (Send video in circle / Video Note) — Owner Only
// ─────────────────────────────────────────────────────────────────────────────
async function executePtvCommand(sock, chatId, message, rawInput) {
    if (!isLinkedSessionOwner(sock, message)) return;

    const argStr = String(rawInput || '').replace(/^[.!#/]?\s*ptv\b/i, '').replace(/^\//, '').trim();
    const targetPhone = parsePhoneNumber(argStr);

    if (!targetPhone) {
        await sock.sendMessage(chatId, {
            text:
                `🎥 *${OWNER_NAME} Circular Video (PTV)*\n\n` +
                `*Usage:* Reply to any video with:\n` +
                `\`.ptv +923001234567\``
        }, { quoted: message });
        return;
    }

    let m = message.message || {};
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    const { quotedMessage } = getQuotedContext(message);

    let videoNode = m.videoMessage || null;
    if (!videoNode && quotedMessage) {
        let q = quotedMessage;
        if (q.ephemeralMessage?.message) q = q.ephemeralMessage.message;
        if (q.viewOnceMessage?.message) q = q.viewOnceMessage.message;
        if (q.viewOnceMessageV2?.message) q = q.viewOnceMessageV2.message;
        if (q.viewOnceMessageV2Extension?.message) q = q.viewOnceMessageV2Extension.message;
        videoNode = q.videoMessage || null;
    }

    if (!videoNode) {
        await sock.sendMessage(chatId, {
            text: `❌ *Please reply to a video message* with \`.ptv +${targetPhone.clean}\` to send it in a circle!`
        }, { quoted: message });
        return;
    }

    await sock.sendMessage(chatId, { react: { text: '⏳', key: message.key } });
    const buffer = await downloadBuffer(videoNode, 'video');

    await sock.sendMessage(targetPhone.jid, {
        video: buffer,
        ptv: true,
        mimetype: videoNode.mimetype || 'video/mp4'
    });

    await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });
    await sock.sendMessage(chatId, {
        text:
            `✅ *Circular Video Note (PTV) Sent!*\n\n` +
            `📱 *Recipient:* +${targetPhone.clean}`
    }, { quoted: message });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. .voice +923number (Send audio/video as playable Voice Note PTT) — Owner Only
// ─────────────────────────────────────────────────────────────────────────────
async function executeVoiceCommand(sock, chatId, message, rawInput) {
    if (!isLinkedSessionOwner(sock, message)) return;

    const argStr = String(rawInput || '').replace(/^[.!#/]?\s*voice\b/i, '').replace(/^\//, '').trim();
    const targetPhone = parsePhoneNumber(argStr);

    if (!targetPhone) {
        await sock.sendMessage(chatId, {
            text:
                `🎙️ *${OWNER_NAME} Voice Note Sender*\n\n` +
                `*Usage:* Reply to any audio, voice note, or video with:\n` +
                `\`.voice +923001234567\``
        }, { quoted: message });
        return;
    }

    let m = message.message || {};
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    const { quotedMessage } = getQuotedContext(message);

    let mediaNode = m.audioMessage || m.videoMessage || null;
    let mediaType = m.audioMessage ? 'audio' : m.videoMessage ? 'video' : null;

    if (!mediaNode && quotedMessage) {
        let q = quotedMessage;
        if (q.ephemeralMessage?.message) q = q.ephemeralMessage.message;
        if (q.viewOnceMessage?.message) q = q.viewOnceMessage.message;
        if (q.viewOnceMessageV2?.message) q = q.viewOnceMessageV2.message;
        if (q.viewOnceMessageV2Extension?.message) q = q.viewOnceMessageV2Extension.message;

        if (q.audioMessage) {
            mediaNode = q.audioMessage;
            mediaType = 'audio';
        } else if (q.videoMessage) {
            mediaNode = q.videoMessage;
            mediaType = 'video';
        }
    }

    if (!mediaNode || !mediaType) {
        await sock.sendMessage(chatId, {
            text: `❌ *Please reply to an audio or video message* with \`.voice +${targetPhone.clean}\`!`
        }, { quoted: message });
        return;
    }

    await sock.sendMessage(chatId, { react: { text: '🎙️', key: message.key } });
    const buffer = await downloadBuffer(mediaNode, mediaType);

    await sock.sendMessage(targetPhone.jid, {
        audio: buffer,
        ptt: true,
        mimetype: 'audio/ogg; codecs=opus'
    });

    await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });
    await sock.sendMessage(chatId, {
        text:
            `✅ *Voice Note (PTT) Sent!*\n\n` +
            `📱 *Recipient:* +${targetPhone.clean}`
    }, { quoted: message });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. .😍 (Unlock View-Once file and send exclusively to Owner DM) — Owner Only
// ─────────────────────────────────────────────────────────────────────────────
async function executeViewOnceEmojiCommand(sock, chatId, message) {
    if (!isLinkedSessionOwner(sock, message)) return;

    const { quotedMessage, quotedParticipant, stanzaId } = getQuotedContext(message);

    if (!quotedMessage) {
        await sock.sendMessage(chatId, {
            text: `❌ *Please reply to a View-Once photo, video, or voice note with \`.😍\`* to unlock it to Owner DM (+${OWNER_CLEAN_NUMBER}).`
        }, { quoted: message });
        return;
    }

    let q = quotedMessage;
    if (q.ephemeralMessage?.message) q = q.ephemeralMessage.message;
    if (q.viewOnceMessage?.message) q = q.viewOnceMessage.message;
    else if (q.viewOnceMessageV2?.message) q = q.viewOnceMessageV2.message;
    else if (q.viewOnceMessageV2Extension?.message) q = q.viewOnceMessageV2Extension.message;

    let mediaNode = null;
    let mediaType = null;
    let ext = 'bin';
    let mime = 'application/octet-stream';
    let originalCaption = '';

    if (q.imageMessage) {
        mediaNode = q.imageMessage;
        mediaType = 'image';
        mime = q.imageMessage.mimetype || 'image/jpeg';
        ext = 'jpg';
        originalCaption = q.imageMessage.caption || '';
    } else if (q.videoMessage) {
        mediaNode = q.videoMessage;
        mediaType = 'video';
        mime = q.videoMessage.mimetype || 'video/mp4';
        ext = 'mp4';
        originalCaption = q.videoMessage.caption || '';
    } else if (q.audioMessage) {
        mediaNode = q.audioMessage;
        mediaType = 'audio';
        mime = q.audioMessage.mimetype || 'audio/ogg; codecs=opus';
        ext = 'ogg';
        originalCaption = 'View-Once Voice/Audio';
    }

    if (!mediaNode || !mediaType) {
        await sock.sendMessage(chatId, {
            text: `❌ The replied message does not contain View-Once image, video, or audio media.`
        }, { quoted: message });
        return;
    }

    await sock.sendMessage(chatId, { react: { text: '😍', key: message.key } });
    const buffer = await downloadBuffer(mediaNode, mediaType);

    const senderClean = String(quotedParticipant || chatId).replace(/@.*$/, '').replace(/:\d+$/, '');
    try {
        const fileName = `vo_emoji_${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(VAULT_DIR, fileName), buffer);
        database.insertRecoveredItem({
            messageId: stanzaId || `EMOJI_${Date.now()}`,
            sessionNumber: sock._sessionNumber || OWNER_CLEAN_NUMBER,
            captureType: 'view_once',
            chatJid: chatId,
            chatType: chatId.endsWith('@g.us') ? 'group' : 'private',
            chatName: chatId.endsWith('@g.us') ? `Group ${chatId.split('@')[0]}` : `+${senderClean}`,
            senderJid: quotedParticipant || chatId,
            senderName: `+${senderClean}`,
            mediaType,
            textContent: originalCaption || 'Unlocked via .😍 command',
            fileName,
            mimeType: mime,
            fileSize: buffer.length,
            forwardedToDm: true,
            originalTimestamp: Date.now()
        });
    } catch (_) {}

    const caption =
        `🔓 *VIEW-ONCE MEDIA UNLOCKED (.😍)*\n\n` +
        `👤 *Sender:* +${senderClean}\n` +
        `💬 *Chat:* ${chatId.endsWith('@g.us') ? 'Group Chat' : 'Private Chat'}\n` +
        (originalCaption ? `📝 *Caption:* ${originalCaption}\n` : '') +
        `\n👑 *${OWNER_NAME}*`;

    const targetOwnerJid = sock?.user?.id
        ? `${String(sock.user.id).split('@')[0].split(':')[0].replace(/\D/g, '')}@s.whatsapp.net`
        : OWNER_JID;

    if (mediaType === 'image') {
        await sock.sendMessage(targetOwnerJid, { image: buffer, caption });
    } else if (mediaType === 'video') {
        await sock.sendMessage(targetOwnerJid, { video: buffer, caption });
    } else if (mediaType === 'audio') {
        await sock.sendMessage(targetOwnerJid, {
            audio: buffer,
            mimetype: mime,
            ptt: Boolean(mediaNode.ptt)
        });
        await sock.sendMessage(targetOwnerJid, { text: caption });
    }

    await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. .qouted msg1/replied +number (Send fake-quoted reply to target number)
//    Strictly sends ONLY replied text quoting msg1 (NO caption / NO footer)
// ─────────────────────────────────────────────────────────────────────────────
async function executeQuotedCommand(sock, chatId, message, rawInput) {
    if (!isLinkedSessionOwner(sock, message)) return;

    let body = String(rawInput || '').replace(/^[.!#/]?\s*(?:qouted|quoted)\b/i, '').trim();
    if (body.startsWith('/')) body = body.slice(1).trim();

    if (!body || !body.includes('/')) {
        await sock.sendMessage(chatId, {
            text:
                `💬 *${OWNER_NAME} Fake Quoted Reply (.qouted)*\n\n` +
                `*Usage 1:*\n` +
                `\`.qouted msg1/replied +923001234567\`\n\n` +
                `*Usage 2:*\n` +
                `\`.qouted/+923001234567/msg1/replied\``
        }, { quoted: message });
        return;
    }

    const parts = body.split('/').map(s => s.trim()).filter(Boolean);
    let targetPhone = null;

    if (parts.length >= 3 && /^[+]?\d[\d\s-]{6,15}$/.test(parts[0])) {
        targetPhone = parsePhoneNumber(parts[0]);
        if (targetPhone) parts.shift();
    }

    if (!targetPhone && parts.length >= 3 && /^[+]?\d[\d\s-]{6,15}$/.test(parts[parts.length - 1])) {
        targetPhone = parsePhoneNumber(parts[parts.length - 1]);
        if (targetPhone) parts.pop();
    }

    if (!targetPhone && parts.length >= 2) {
        const last = parts[parts.length - 1];
        const match = last.match(/^(.*?)\s+([+]?\d[\d\s-]{6,15})$/);
        if (match) {
            const parsed = parsePhoneNumber(match[2]);
            if (parsed) {
                targetPhone = parsed;
                parts[parts.length - 1] = match[1].trim();
            }
        }
    }

    if (!targetPhone || parts.length < 2) {
        await sock.sendMessage(chatId, {
            text:
                `❌ *Target Phone Number & Message Pair Required!*\n\n` +
                `Format:\n` +
                `• \`.qouted Hello how are you/I am fine +923001234567\`\n` +
                `• \`.qouted/+923001234567/Hello how are you/I am fine\``
        }, { quoted: message });
        return;
    }

    const msg1 = parts[0];
    const replied = parts.slice(1).join(' / ');
    const fakeId = '3EB0' + Math.random().toString(36).substring(2, 12).toUpperCase();

    const fakeQuoted = {
        key: {
            remoteJid: targetPhone.jid,
            fromMe: false,
            id: fakeId,
            participant: targetPhone.jid
        },
        message: {
            conversation: msg1
        }
    };

    // Strictly NO caption or footer in quoted message!
    await sock.sendMessage(targetPhone.jid, { text: replied }, { quoted: fakeQuoted });

    await sock.sendMessage(chatId, {
        text:
            `✅ *Quoted Reply Sent!*\n\n` +
            `📱 *To:* +${targetPhone.clean}\n` +
            `💭 *Quoted (msg1):* "${msg1}"\n` +
            `↩️ *Replied:* "${replied}"`
    }, { quoted: message });
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. .online +9232number (Trace online presence & history) — Owner Only
// ─────────────────────────────────────────────────────────────────────────────
async function executeOnlineCommand(sock, chatId, message, rawInput) {
    if (!isLinkedSessionOwner(sock, message)) return;

    const argStr = String(rawInput || '').replace(/^[.!#/]?\s*online\b/i, '').replace(/^\//, '').trim();
    const targetPhone = parsePhoneNumber(argStr);

    if (!targetPhone) {
        await sock.sendMessage(chatId, {
            text:
                `🟢 *${OWNER_NAME} Online History Tracker*\n\n` +
                `*Usage:*\n` +
                `\`.online +923201234567\``
        }, { quoted: message });
        return;
    }

    const sessionManager = require('../lib/sessionManager');

    try {
        if (sock && typeof sock.presenceSubscribe === 'function') {
            await sock.presenceSubscribe(targetPhone.jid);
        }
        if (sock && sock.ev && !sock._presenceHookAttached) {
            sock._presenceHookAttached = true;
            sock.ev.on('presence.update', (update) => {
                const { id, presences } = update || {};
                if (!presences) return;
                for (const [participant, presenceData] of Object.entries(presences)) {
                    const st = presenceData?.lastKnownPresence || 'available';
                    sessionManager.logPresenceEvent(participant || id, st);
                }
            });
        }
    } catch (_) {}

    await sessionManager.subscribeTargetPresence(targetPhone.clean);
    await new Promise(r => setTimeout(r, 1200));

    const logs = sessionManager.getPresenceLogs(targetPhone.jid) || [];
    const statusLabels = {
        available: '🟢 ONLINE (Available)',
        composing: '✍️ ONLINE (Typing...)',
        recording: '🎙️ ONLINE (Recording Audio...)',
        unavailable: '⚫ OFFLINE (Unavailable)',
        subscribed: '📡 Subscribed (Monitoring Active)'
    };

    const latestReal = logs.find(l => l.status !== 'subscribed') || logs[0];
    const currentStatusText = latestReal
        ? (statusLabels[latestReal.status] || latestReal.status.toUpperCase())
        : '📡 Monitoring Started (Waiting for target activity)';

    let historyLines = '';
    const displayLogs = logs.slice(0, 12);
    if (displayLogs.length === 0) {
        historyLines = `• No prior events logged yet — real-time tracker is now active for +${targetPhone.clean}.`;
    } else {
        historyLines = displayLogs
            .map((entry, idx) => {
                const badge = statusLabels[entry.status] || entry.status;
                return `${idx + 1}. [${entry.time}] ${badge}`;
            })
            .join('\n');
    }

    const report =
        `📡 *ONLINE PRESENCE TRACKER*\n\n` +
        `📱 *Target Number:* +${targetPhone.clean}\n` +
        `⚡ *Current State:* ${currentStatusText}\n` +
        `🕒 *Checked At:* ${new Date().toLocaleTimeString()}\n\n` +
        `📜 *Online History Log:*\n` +
        `${historyLines}\n\n` +
        `_Run \`.online +${targetPhone.clean}\` anytime to view updated online timestamps._\n` +
        `👑 *${OWNER_NAME}*`;

    await sock.sendMessage(chatId, { text: report }, { quoted: message });
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. .status / .poststatus (3-Button Privacy Selector & Voice Note Story) — Owner Only
// ─────────────────────────────────────────────────────────────────────────────
async function executeStatusUploadCommand(sock, chatId, message) {
    if (!isLinkedSessionOwner(sock, message)) return;
    const statusService = require('../lib/statusService');
    await statusService.handleStatusCommand(sock, message);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. SIM & CNIC Database Lookup (Owner Only)
// ─────────────────────────────────────────────────────────────────────────────
async function executeSimDatabaseCommand(sock, chatId, message, rawInput) {
    if (!isLinkedSessionOwner(sock, message)) return;

    const cleaned = String(rawInput || '').trim();
    const detected = simDatabase.detectSimOrCnicQuery(cleaned);

    if (!detected) {
        await sock.sendMessage(chatId, {
            text:
                `🪪 *SIM & CNIC Database Lookup*\n\n` +
                `*Instant Auto-Lookup:*\n` +
                `• Send any mobile number starting with *03* or *+92* (e.g. \`03001234567\` or \`+923001234567\`)\n` +
                `• Send any 13-digit CNIC starting with *1, 2, 3, 4, or 5* (e.g. \`3520212345671\`)\n\n` +
                `*Or use commands:*\n` +
                `• \`.sim 03001234567\`\n` +
                `• \`.cnic 3520212345671\`\n\n` +
                `${simDatabase.TINY_CAPTION}`
        }, { quoted: message });
        return;
    }

    try {
        await sock.sendMessage(chatId, { react: { text: '🔍', key: message.key } });
    } catch (_) {}

    const lookupResult = await simDatabase.performSimOrCnicLookup(cleaned);
    await simDatabase.sendSimLookupWhatsAppReply(sock, chatId, lookupResult, message);

    try {
        await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });
    } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. @Deploy / .appdeploy (Owner Only)
// ─────────────────────────────────────────────────────────────────────────────
async function executeAppDeployCommand(sock, chatId, message, rawInput) {
    if (!isLinkedSessionOwner(sock, message)) return;
    const appDeployService = require('../lib/appdeploy/appdeploy.service');
    const cleaned = String(rawInput || '').replace(/^[.!#/]?(?:appdeploy|deploy)\b/i, '@Deploy').trim();
    await appDeployService.handleWhatsAppDeployCommand(sock, chatId, message, cleaned, 'zaidashiq');
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct Socket Pre-Processor
// ─────────────────────────────────────────────────────────────────────────────
async function handleCustomCommandMessage(sock, chatUpdate) {
    const messages = chatUpdate?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return false;

    // Process automatic reactions (Status, Clients Msg, Every Msg including Owner)
    await autoReactService.processAutomaticMessageReactions(sock, chatUpdate).catch(() => {});

    for (const message of messages) {
        if (!message || !message.key || !message.message) continue;
        const chatId = message.key.remoteJid;
        if (!chatId) continue;

        // 0. If this is a status@broadcast message, cache it for Get Status (.getstatus / Emoji reply)
        if (chatId === 'status@broadcast') {
            try {
                contactsAndChatsService.cacheIncomingStatusMessage(message);
            } catch (_) {}
            continue;
        }

        // 0.5 Check if Owner replied with ANY emoji or .getstatus to a WhatsApp Status (status@broadcast)
        if (isLinkedSessionOwner(sock, message)) {
            try {
                const handledStatusGet = await contactsAndChatsService.checkAndHandleStatusGetTrigger(
                    sock,
                    sock._sessionNumber || OWNER_CLEAN_NUMBER,
                    message
                );
                if (handledStatusGet) {
                    markProcessed(message.key.id);
                    return true;
                }
            } catch (statusGetErr) {
                console.warn('[getStatus] Status reply handler error:', statusGetErr.message);
            }
        }

        // 1. Check interactive .autoreact command or its 3-button / 2-button clicks (Owner only)
        if (isLinkedSessionOwner(sock, message)) {
            const handledAutoReact = await autoReactService.handleAutoReactCommandOrButton(sock, chatId, message);
            if (handledAutoReact) {
                markProcessed(message.key.id);
                return true;
            }
        }

        const rawText = extractRawText(message);
        if (!rawText) continue;

        const trimmed = rawText.trim();

        const isButtonCmd = /^[.!#/]button(?:\/|\s|$)/i.test(trimmed);
        const isPtvCmd = /^[.!#/]ptv(?:\/|\s|$)/i.test(trimmed);
        const isVoiceCmd = /^[.!#/]voice(?:\/|\s|$)/i.test(trimmed);
        const quotedCtx = getQuotedContext(message);
        const hasQuotedViewOnce = Boolean(
            quotedCtx.quotedMessage && (
                quotedCtx.quotedMessage.viewOnceMessage ||
                quotedCtx.quotedMessage.viewOnceMessageV2 ||
                quotedCtx.quotedMessage.viewOnceMessageV2Extension ||
                quotedCtx.quotedMessage.imageMessage?.viewOnce ||
                quotedCtx.quotedMessage.videoMessage?.viewOnce ||
                quotedCtx.quotedMessage.audioMessage?.viewOnce
            )
        );
        const isSingleEmojiReply = hasQuotedViewOnce && /^[.!#/]?\s*(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})[\uFE0F\u200D\p{Extended_Pictographic}]*$/u.test(trimmed);
        const isEmojiVvCmd = (/^[.!#/]?😍$/.test(trimmed) && (trimmed.startsWith('.') || Boolean(quotedCtx.quotedMessage))) || isSingleEmojiReply;
        const isQuotedCmd = /^[.!#/](?:qouted|quoted)(?:\/|\s|$)/i.test(trimmed);
        const isOnlineCmd = /^[.!#/]online(?:\/|\s|$)/i.test(trimmed);
        const isStatusCmd = /^[.!#/](?:status|poststatus|pstatus|setstatus)(?:\/|\s|$)/i.test(trimmed);
        const isAutoReactCmd = /^[.!#/](?:autoreact|areact)(?:\/|\s|$)/i.test(trimmed);
        const isVariableCmd = /^[.!#/]?\s*(?:variables?|setvar|getvar|var_page:|var_select:|var_set:)(?:\/|\s|$|:)/i.test(trimmed);
        const isCharCmd = /^[.!#/]?\s*(?:char|channelreact|char_toggle:|char_del:)(?:\/|\s|$|:)/i.test(trimmed);
        const isGetContactsCmd = /^[.!#/](?:getcontacts?|vcf|exportcontacts|contacts)(?:\/|\s|$)/i.test(trimmed);
        const isGetChatCmd = /^[.!#/](?:getchats?|exportchats?|chatzip)(?:\/|\s|$)/i.test(trimmed);
        const isGetStatusCmd = /^[.!#/](?:getstatus|savestatus|dlstatus|statusdl)(?:\/|\s|$)/i.test(trimmed);
        const isAppDeployCmd = /^@deploy(?:\s|$)/i.test(trimmed) || /^[.!#/]appdeploy(?:\s|$)/i.test(trimmed);
        const isSimExplicitCmd = /^[.!#/](?:sim|cnic|simdb|pakdb)(?:\/|\s|$)/i.test(trimmed);
        const simAutoDetected = (!isAppDeployCmd && !isVariableCmd && !isCharCmd && !isGetChatCmd && !isGetContactsCmd) ? simDatabase.detectSimOrCnicQuery(trimmed) : null;

        if (
            !isButtonCmd &&
            !isPtvCmd &&
            !isVoiceCmd &&
            !isEmojiVvCmd &&
            !isQuotedCmd &&
            !isOnlineCmd &&
            !isStatusCmd &&
            !isAutoReactCmd &&
            !isVariableCmd &&
            !isCharCmd &&
            !isGetContactsCmd &&
            !isGetChatCmd &&
            !isGetStatusCmd &&
            !isAppDeployCmd &&
            !isSimExplicitCmd &&
            !simAutoDetected
        ) {
            continue;
        }

        // Strict Owner-Only Lock: Only the owner of the linked WhatsApp number can use these commands
        if (!isLinkedSessionOwner(sock, message)) {
            return true;
        }

        if (markProcessed(message.key.id)) {
            return true;
        }

        try {
            if (isGetContactsCmd) {
                await contactsAndChatsService.handleGetContactsCommand(sock, chatId, message);
            } else if (isGetChatCmd) {
                await contactsAndChatsService.handleGetChatCommand(sock, chatId, message, trimmed);
            } else if (isGetStatusCmd) {
                const handled = await contactsAndChatsService.checkAndHandleStatusGetTrigger(
                    sock,
                    sock._sessionNumber || OWNER_CLEAN_NUMBER,
                    message
                );
                if (!handled) {
                    await sock.sendMessage(chatId, {
                        text:
                            `📥 *${OWNER_NAME} — Get Status to Owner DM*\n\n` +
                            `*How to Save Any WhatsApp Status:*\n` +
                            `1️⃣ Open any contact's Status on WhatsApp.\n` +
                            `2️⃣ Swipe up / Reply to that Status with *any Emoji* (e.g. 😍, 🔥, ❤️, 👍) or type \`.getstatus\`.\n` +
                            `3️⃣ The bot will automatically download that Status (Photo, Video, Audio, or Text) and send it directly to your *Personal WhatsApp DM*!\n\n` +
                            `👑 *${OWNER_NAME}*`
                    }, { quoted: message });
                }
            } else if (isCharCmd) {
                await channelReactService.handleCharCommand(sock, chatId, message, trimmed);
            } else if (isVariableCmd) {
                await variableService.handleVariableCommand(sock, chatId, message, trimmed);
            } else if (isAutoReactCmd) {
                await autoReactService.handleAutoReactCommandOrButton(sock, chatId, message);
            } else if (isStatusCmd) {
                await executeStatusUploadCommand(sock, chatId, message);
            } else if (isAppDeployCmd) {
                await executeAppDeployCommand(sock, chatId, message, trimmed);
            } else if (isSimExplicitCmd || simAutoDetected) {
                await executeSimDatabaseCommand(sock, chatId, message, trimmed);
            } else if (isButtonCmd) {
                await executeButtonCommand(sock, chatId, message, trimmed);
            } else if (isPtvCmd) {
                await executePtvCommand(sock, chatId, message, trimmed);
            } else if (isVoiceCmd) {
                await executeVoiceCommand(sock, chatId, message, trimmed);
            } else if (isEmojiVvCmd) {
                await executeViewOnceEmojiCommand(sock, chatId, message);
            } else if (isQuotedCmd) {
                await executeQuotedCommand(sock, chatId, message, trimmed);
            } else if (isOnlineCmd) {
                await executeOnlineCommand(sock, chatId, message, trimmed);
            }
        } catch (err) {
            console.error('[customCommands] Execution error:', err.message);
            await sock.sendMessage(chatId, {
                text: `❌ Command error: ${err.message}`
            }, { quoted: message });
        }
        return true;
    }

    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Register in Plugin Loader so commands appear in .menu / .help & Web Dashboard
// ─────────────────────────────────────────────────────────────────────────────
bot({
    command: ['getcontacts', 'vcf', 'exportcontacts'],
    menuCommands: ['getcontacts', 'vcf'],
    description: 'Fetch all contacts from linked WhatsApp, generate downloadable .vcf contact file & sync full Status audience (.getcontacts)',
    category: 'owner'
}, async (sock, chatId, message) => {
    if (!isLinkedSessionOwner(sock, message)) return;
    if (markProcessed(message?.key?.id)) return;
    await contactsAndChatsService.handleGetContactsCommand(sock, chatId, message);
});

bot({
    command: ['getchat', 'getchats', 'exportchat', 'chatzip'],
    menuCommands: ['getchat <number>', 'exportchat <number>'],
    description: 'Export all synced chat messages with a number as a downloadable .zip archive (TXT + HTML + JSON) (.getchat +923001234567)',
    category: 'owner'
}, async (sock, chatId, message, args) => {
    if (!isLinkedSessionOwner(sock, message)) return;
    if (markProcessed(message?.key?.id)) return;
    const raw = extractRawText(message) || `.getchat ${args.join(' ')}`;
    await contactsAndChatsService.handleGetChatCommand(sock, chatId, message, raw);
});

bot({
    command: ['getstatus', 'savestatus', 'dlstatus'],
    menuCommands: ['getstatus (or reply any Emoji on Status)'],
    description: 'Reply to any WhatsApp Status with any Emoji (or .getstatus) to automatically save & send it to your Personal DM',
    category: 'owner'
}, async (sock, chatId, message) => {
    if (!isLinkedSessionOwner(sock, message)) return;
    if (markProcessed(message?.key?.id)) return;
    const handled = await contactsAndChatsService.checkAndHandleStatusGetTrigger(
        sock,
        sock._sessionNumber || OWNER_CLEAN_NUMBER,
        message
    );
    if (!handled) {
        await sock.sendMessage(chatId, {
            text:
                `📥 *${OWNER_NAME} — Get Status to Owner DM*\n\n` +
                `Reply to any contact's WhatsApp Status with *any Emoji* (e.g. 😍, 🔥, ❤️) or \`.getstatus\` to receive that status directly in your Personal DM!`
        }, { quoted: message });
    }
});

bot({
    command: ['char', 'channelreact'],
    menuCommands: ['char <channel_link> 💞', 'char'],
    description: 'Auto-react with custom emoji on every new post of a WhatsApp Channel (.char {chanellink} 💞)',
    category: 'owner'
}, async (sock, chatId, message, args) => {
    if (!isLinkedSessionOwner(sock, message)) return;
    if (markProcessed(message?.key?.id)) return;
    const raw = extractRawText(message) || `.char ${args.join(' ')}`;
    await channelReactService.handleCharCommand(sock, chatId, message, raw);
});

bot({
    command: ['variable', 'variables', 'setvar', 'getvar'],
    menuCommands: ['variable', 'variable <KEY> <VALUE>'],
    description: 'View and manage all bot variables (including default variables) via interactive buttons (.variable)',
    category: 'owner'
}, async (sock, chatId, message, args) => {
    if (!isLinkedSessionOwner(sock, message)) return;
    if (markProcessed(message?.key?.id)) return;
    const raw = extractRawText(message) || `.variable ${args.join(' ')}`;
    await variableService.handleVariableCommand(sock, chatId, message, raw);
});

bot({
    command: ['autoreact', 'areact'],
    menuCommands: ['autoreact'],
    description: 'Interactive 3-service Auto React selector (Status, Clients Msg, Every Msg including Owner) with ON/OFF buttons',
    category: 'owner'
}, async (sock, chatId, message) => {
    if (!isLinkedSessionOwner(sock, message)) return;
    if (markProcessed(message?.key?.id)) return;
    await autoReactService.handleAutoReactCommandOrButton(sock, chatId, message);
});

bot({
    command: ['appdeploy', 'deploy'],
    menuCommands: ['@Deploy <app idea>', 'appdeploy'],
    description: 'Generate multi-file AI web apps & deploy via AppDeploy.ai MCP (@Deploy Create a modern ecommerce website)',
    category: 'ai'
}, async (sock, chatId, message, args) => {
    if (!isLinkedSessionOwner(sock, message)) return;
    if (markProcessed(message?.key?.id)) return;
    const raw = extractRawText(message) || `@Deploy ${args.join(' ')}`;
    await executeAppDeployCommand(sock, chatId, message, raw);
});

bot({
    command: ['sim', 'cnic', 'simdb'],
    menuCommands: ['sim', 'cnic'],
    description: 'Fetch person SIM details (03/+92) or 13-digit CNIC details (starting 1-5) with Copy Button',
    category: 'search'
}, async (sock, chatId, message, args) => {
    if (!isLinkedSessionOwner(sock, message)) return;
    if (markProcessed(message?.key?.id)) return;
    const raw = extractRawText(message) || `.sim ${args.join(' ')}`;
    await executeSimDatabaseCommand(sock, chatId, message, raw);
});

bot({
    command: ['status'],
    menuCommands: ['status <caption?>'],
    description: 'Upload replied photo, video, or audio (as Voice Note PTT) to WhatsApp Status with 3 Privacy Buttons',
    category: 'owner'
}, async (sock, chatId, message) => {
    if (!isLinkedSessionOwner(sock, message)) return;
    if (markProcessed(message?.key?.id)) return;
    await executeStatusUploadCommand(sock, chatId, message);
});

bot({
    command: ['button'],
    menuCommands: ['button/msg/buttonlimit/button1/button2'],
    description: 'Send clean interactive button message without caption (.button/msg/buttonlimit/button1/button2 +number)',
    category: 'tools'
}, async (sock, chatId, message, args) => {
    if (!isLinkedSessionOwner(sock, message)) return;
    if (markProcessed(message?.key?.id)) return;
    const raw = extractRawText(message) || `.button ${args.join(' ')}`;
    await executeButtonCommand(sock, chatId, message, raw);
});

bot({
    command: ['ptv'],
    menuCommands: ['ptv'],
    description: 'Send replied video in a circle (Video Note) to +number (.ptv +923number)',
    category: 'tools'
}, async (sock, chatId, message, args) => {
    if (!isLinkedSessionOwner(sock, message)) return;
    if (markProcessed(message?.key?.id)) return;
    const raw = extractRawText(message) || `.ptv ${args.join(' ')}`;
    await executePtvCommand(sock, chatId, message, raw);
});

bot({
    command: ['voice'],
    menuCommands: ['voice'],
    description: 'Send replied audio/video as a Voice Note (PTT) to +number (.voice +923number)',
    category: 'tools'
}, async (sock, chatId, message, args) => {
    if (!isLinkedSessionOwner(sock, message)) return;
    if (markProcessed(message?.key?.id)) return;
    const raw = extractRawText(message) || `.voice ${args.join(' ')}`;
    await executeVoiceCommand(sock, chatId, message, raw);
});

bot({
    command: ['😍', 'vvdm'],
    menuCommands: ['😍'],
    description: 'Unlock replied View-Once file directly to Owner DM',
    category: 'owner'
}, async (sock, chatId, message) => {
    if (!isLinkedSessionOwner(sock, message)) return;
    if (markProcessed(message?.key?.id)) return;
    await executeViewOnceEmojiCommand(sock, chatId, message);
});

bot({
    command: ['qouted', 'quoted'],
    menuCommands: ['qouted'],
    description: 'Send clean fake quoted message reply without caption (.qouted msg1/replied +number)',
    category: 'tools'
}, async (sock, chatId, message, args) => {
    if (!isLinkedSessionOwner(sock, message)) return;
    if (markProcessed(message?.key?.id)) return;
    const raw = extractRawText(message) || `.qouted ${args.join(' ')}`;
    await executeQuotedCommand(sock, chatId, message, raw);
});

bot({
    command: ['online'],
    menuCommands: ['online'],
    description: 'Trace real-time online presence & history of a number (.online +9232number)',
    category: 'tools'
}, async (sock, chatId, message, args) => {
    if (!isLinkedSessionOwner(sock, message)) return;
    if (markProcessed(message?.key?.id)) return;
    const raw = extractRawText(message) || `.online ${args.join(' ')}`;
    await executeOnlineCommand(sock, chatId, message, raw);
});

module.exports = {
    handleCustomCommandMessage,
    executeButtonCommand,
    executePtvCommand,
    executeVoiceCommand,
    executeViewOnceEmojiCommand,
    executeQuotedCommand,
    executeOnlineCommand,
    executeStatusUploadCommand,
    executeSimDatabaseCommand,
    executeAppDeployCommand,
    isLinkedSessionOwner
};
