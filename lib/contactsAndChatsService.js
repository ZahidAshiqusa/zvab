'use strict';

/**
 * Contacts, Chats Exporter & Status Fetcher Service
 * Brand: Zaid Ashiq X Ultra V. Coder
 *
 * Features:
 * 1. Full Contacts Sync & VCF Generator (.getcontacts + Dashboard "Get Contacts" Button)
 *    - Captures contacts from messaging-history.set, contacts.upsert, contacts.update,
 *      chats.upsert, messages.upsert, and group participants.
 *    - Generates standard vCard 3.0 (.vcf) file of all linked contacts.
 *    - Feeds 100% of synced contacts into Status Uploader so all contacts see your WhatsApp Status.
 *
 * 2. Get Chats / Export Chat (.getchat <number> + Dashboard "Get Chats / Export Chat" Button)
 *    - Captures and indexes chat messages per phone number from history sync & live messages.
 *    - Exports a complete .zip archive (TXT + HTML + JSON) and provides temporary live chat access on Dashboard.
 *
 * 3. Get Status (Reply ANY Emoji on a WhatsApp Status -> Sends Status to Owner Personal DM + .getstatus)
 *    - Caches incoming status@broadcast items and intercepts owner replies (any emoji or .getstatus)
 *      to any WhatsApp Status, downloading and sending the Status media/text to Owner DM.
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { downloadContentFromMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');
const { DATA_DIR, ROOT_DIR } = require('./storagePaths');
const database = require('./database');

const CONTACTS_STORE_PATH = path.join(DATA_DIR, 'contacts_store.json');
const REPO_CONTACTS_STORE_PATH = path.join(ROOT_DIR, 'data', 'contacts_store.json');
const VCF_OUTPUT_PATH = path.join(DATA_DIR, 'Zaid_Ashiq_WhatsApp_Contacts.vcf');
const CHATS_ARCHIVE_DIR = path.join(DATA_DIR, 'chats_archive');
const STATUS_CAPTURE_DIR = path.join(DATA_DIR, 'captured_statuses');

for (const dir of [CHATS_ARCHIVE_DIR, STATUS_CAPTURE_DIR]) {
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
}

// In-memory Contacts Map: cleanNumber -> { number, jid, name, notify, verifiedName, isGroupMember, updatedAt }
const contactsMap = new Map();

// In-memory Chat Messages Map: cleanNumber -> Array<{ id, fromMe, senderJid, senderName, text, mediaType, timestamp, isoTime }>
const chatHistoryMap = new Map();
const MAX_MESSAGES_PER_CHAT = 500;

// In-memory Status Cache: messageId -> { id, senderJid, senderNumber, senderName, mediaType, baileyType, mediaNode, mimeType, caption, cachedBuffer, fileName, timestamp }
const statusCache = new Map();
const MAX_STATUS_CACHE = 250;
const recentStatusForwards = new Map(); // `${statusId}:${emoji}` -> timestamp

function normalizeDigits(raw) {
    if (!raw) return '';
    let str = String(raw).trim();
    if (str.includes('@g.us') || str.includes('@newsletter') || str.includes('@broadcast') || str.includes('@lid')) {
        return '';
    }
    let digits = str.split('@')[0].split(':')[0].replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.startsWith('0') && digits.length === 11) {
        digits = '92' + digits.slice(1);
    }
    if (digits.length < 7 || digits.length > 15) return '';
    return digits;
}

function normalizeUserJid(raw) {
    const digits = normalizeDigits(raw);
    return digits ? `${digits}@s.whatsapp.net` : null;
}

function loadContactsFromDisk() {
    for (const filePath of [CONTACTS_STORE_PATH, REPO_CONTACTS_STORE_PATH]) {
        try {
            if (fs.existsSync(filePath)) {
                const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                const list = Array.isArray(parsed?.contacts) ? parsed.contacts : (Array.isArray(parsed) ? parsed : []);
                for (const item of list) {
                    const num = normalizeDigits(item.number || item.jid || item.id);
                    if (!num) continue;
                    contactsMap.set(num, {
                        number: num,
                        jid: `${num}@s.whatsapp.net`,
                        name: item.name || item.notify || item.verifiedName || `+${num}`,
                        notify: item.notify || '',
                        verifiedName: item.verifiedName || '',
                        source: item.source || 'synced',
                        updatedAt: item.updatedAt || Date.now()
                    });
                }
            }
        } catch (_) {}
    }
}

loadContactsFromDisk();

let saveContactsTimer = null;
function scheduleSaveContactsToDisk() {
    if (saveContactsTimer) return;
    saveContactsTimer = setTimeout(() => {
        saveContactsTimer = null;
        saveContactsToDiskNow();
    }, 1500);
}

function saveContactsToDiskNow() {
    const contacts = Array.from(contactsMap.values()).sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''))
    );
    const payload = {
        total: contacts.length,
        updatedAt: new Date().toISOString(),
        contacts
    };
    try {
        fs.writeFileSync(CONTACTS_STORE_PATH, JSON.stringify(payload, null, 2), 'utf8');
    } catch (_) {}
    try {
        if (REPO_CONTACTS_STORE_PATH !== CONTACTS_STORE_PATH && fs.existsSync(path.dirname(REPO_CONTACTS_STORE_PATH))) {
            fs.writeFileSync(REPO_CONTACTS_STORE_PATH, JSON.stringify(payload, null, 2), 'utf8');
        }
    } catch (_) {}
}

/**
 * Upsert a single contact into the persistent Contacts Map
 */
function upsertContactRecord(rawJidOrNumber, fields = {}) {
    const num = normalizeDigits(rawJidOrNumber);
    if (!num) return null;

    const existing = contactsMap.get(num) || {
        number: num,
        jid: `${num}@s.whatsapp.net`,
        name: `+${num}`,
        notify: '',
        verifiedName: '',
        source: 'whatsapp',
        updatedAt: Date.now()
    };

    const candidateName = String(fields.name || fields.verifiedName || '').trim();
    const candidateNotify = String(fields.notify || fields.pushName || '').trim();

    let bestName = existing.name;
    if (candidateName && !candidateName.startsWith('+')) {
        bestName = candidateName;
    } else if ((!bestName || bestName.startsWith('+')) && candidateNotify) {
        bestName = candidateNotify;
    } else if (!bestName) {
        bestName = `+${num}`;
    }

    const updated = {
        ...existing,
        number: num,
        jid: `${num}@s.whatsapp.net`,
        name: bestName,
        notify: candidateNotify || existing.notify || '',
        verifiedName: fields.verifiedName || existing.verifiedName || '',
        source: fields.source || existing.source || 'whatsapp',
        updatedAt: Date.now()
    };

    contactsMap.set(num, updated);
    scheduleSaveContactsToDisk();
    return updated;
}

/**
 * Load & Save Per-Chat Archive on Disk
 */
function getChatArchivePath(cleanNumber) {
    return path.join(CHATS_ARCHIVE_DIR, `chat_${cleanNumber}.json`);
}

function loadChatMessagesForNumber(rawNumber) {
    const clean = normalizeDigits(rawNumber);
    if (!clean) return [];
    if (chatHistoryMap.has(clean)) {
        return chatHistoryMap.get(clean);
    }
    const filePath = getChatArchivePath(clean);
    try {
        if (fs.existsSync(filePath)) {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (Array.isArray(parsed)) {
                chatHistoryMap.set(clean, parsed);
                return parsed;
            }
        }
    } catch (_) {}
    chatHistoryMap.set(clean, []);
    return [];
}

function saveChatMessagesForNumber(cleanNumber) {
    const clean = normalizeDigits(cleanNumber);
    if (!clean) return;
    const list = chatHistoryMap.get(clean) || [];
    try {
        fs.writeFileSync(getChatArchivePath(clean), JSON.stringify(list, null, 2), 'utf8');
    } catch (_) {}
}

/**
 * Extract readable text, media type, and details from any Baileys message
 */
function extractChatMessageRecord(msg) {
    if (!msg || !msg.key || !msg.message) return null;
    const remoteJid = msg.key.remoteJid || '';
    if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) return null;

    let m = msg.message;
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    if (m.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;
    if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;

    if (m.protocolMessage || m.reactionMessage || m.senderKeyDistributionMessage) return null;

    let text = '';
    let mediaType = 'text';

    if (typeof m.conversation === 'string' && m.conversation) {
        text = m.conversation;
    } else if (m.extendedTextMessage?.text) {
        text = m.extendedTextMessage.text;
    } else if (m.imageMessage) {
        mediaType = 'image';
        text = m.imageMessage.caption ? `[Photo] ${m.imageMessage.caption}` : '[Photo]';
    } else if (m.videoMessage) {
        mediaType = m.videoMessage.ptv ? 'ptv' : 'video';
        text = m.videoMessage.caption ? `[Video] ${m.videoMessage.caption}` : '[Video]';
    } else if (m.audioMessage) {
        mediaType = m.audioMessage.ptt ? 'voice' : 'audio';
        text = m.audioMessage.ptt ? '[Voice Note (PTT)]' : '[Audio File]';
    } else if (m.documentMessage) {
        mediaType = 'document';
        text = `[Document: ${m.documentMessage.fileName || 'File'}] ${m.documentMessage.caption || ''}`.trim();
    } else if (m.stickerMessage) {
        mediaType = 'sticker';
        text = '[Sticker]';
    } else if (m.locationMessage || m.liveLocationMessage) {
        mediaType = 'location';
        const loc = m.locationMessage || m.liveLocationMessage;
        text = `[Location: ${loc.degreesLatitude}, ${loc.degreesLongitude}]`;
    } else if (m.contactMessage || m.contactsArrayMessage) {
        mediaType = 'contact';
        text = `[Contact Card: ${m.contactMessage?.displayName || 'Shared Contact'}]`;
    } else {
        return null;
    }

    const rawTs = Number(msg.messageTimestamp || 0);
    const timestamp = rawTs > 0 ? (rawTs < 1e12 ? rawTs * 1000 : rawTs) : Date.now();
    const fromMe = Boolean(msg.key.fromMe);
    const isGroup = remoteJid.endsWith('@g.us');
    const participantJid = isGroup ? (msg.key.participant || msg.participant || '') : remoteJid;
    const chatNumber = isGroup ? '' : normalizeDigits(remoteJid);
    const senderNumber = fromMe ? 'Me' : (normalizeDigits(participantJid) || chatNumber || 'Contact');
    const senderName = fromMe
        ? 'Me (Owner)'
        : (msg.pushName || contactsMap.get(senderNumber)?.name || `+${senderNumber}`);

    // Also record contact in contactsMap
    if (!isGroup && chatNumber) {
        upsertContactRecord(chatNumber, {
            notify: !fromMe ? (msg.pushName || '') : '',
            source: 'chat'
        });
    } else if (isGroup && participantJid) {
        const pDigits = normalizeDigits(participantJid);
        if (pDigits) {
            upsertContactRecord(pDigits, {
                notify: !fromMe ? (msg.pushName || '') : '',
                source: 'group'
            });
        }
    }

    if (!chatNumber) return null;

    return {
        chatNumber,
        record: {
            id: msg.key.id || `MSG_${timestamp}`,
            key: msg.key,
            fromMe,
            senderNumber,
            senderName,
            text,
            mediaType,
            timestamp,
            isoTime: new Date(timestamp).toISOString()
        }
    };
}

function recordChatMessage(msg) {
    const parsed = extractChatMessageRecord(msg);
    if (!parsed || !parsed.chatNumber) return;

    const list = loadChatMessagesForNumber(parsed.chatNumber);
    if (list.some(item => item.id === parsed.record.id)) return;

    list.push(parsed.record);
    list.sort((a, b) => a.timestamp - b.timestamp);
    if (list.length > MAX_MESSAGES_PER_CHAT) {
        list.splice(0, list.length - MAX_MESSAGES_PER_CHAT);
    }
    chatHistoryMap.set(parsed.chatNumber, list);
    saveChatMessagesForNumber(parsed.chatNumber);
}

/**
 * Download media buffer helper
 */
async function downloadBufferFromNode(mediaNode, baileyType) {
    if (!mediaNode || !baileyType) return null;
    try {
        const stream = await downloadContentFromMessage(mediaNode, baileyType);
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    } catch (err) {
        console.warn(`[statusCapture] downloadContentFromMessage (${baileyType}) warning:`, err.message);
        return null;
    }
}

/**
 * Extract Status (status@broadcast) media or text details
 */
function extractStatusDetails(msg) {
    if (!msg || !msg.message) return null;
    let m = msg.message;
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;

    let mediaType = 'text';
    let baileyType = null;
    let mediaNode = null;
    let mimeType = 'text/plain';
    let caption = '';

    if (m.imageMessage) {
        mediaType = 'image';
        baileyType = 'image';
        mediaNode = m.imageMessage;
        mimeType = m.imageMessage.mimetype || 'image/jpeg';
        caption = m.imageMessage.caption || '';
    } else if (m.videoMessage) {
        mediaType = 'video';
        baileyType = 'video';
        mediaNode = m.videoMessage;
        mimeType = m.videoMessage.mimetype || 'video/mp4';
        caption = m.videoMessage.caption || '';
    } else if (m.audioMessage) {
        mediaType = 'audio';
        baileyType = 'audio';
        mediaNode = m.audioMessage;
        mimeType = m.audioMessage.mimetype || 'audio/ogg; codecs=opus';
        caption = 'Voice Status (PTT)';
    } else if (m.extendedTextMessage?.text) {
        mediaType = 'text';
        caption = m.extendedTextMessage.text;
    } else if (typeof m.conversation === 'string' && m.conversation) {
        mediaType = 'text';
        caption = m.conversation;
    } else {
        return null;
    }

    return {
        mediaType,
        baileyType,
        mediaNode,
        mimeType,
        caption
    };
}

/**
 * Cache incoming status@broadcast message so when owner replies with any emoji, we have it ready
 */
async function cacheIncomingStatusMessage(msg) {
    if (!msg || !msg.key || msg.key.remoteJid !== 'status@broadcast') return;
    const details = extractStatusDetails(msg);
    if (!details) return;

    const statusId = msg.key.id;
    const participant = msg.key.participant || msg.participant || '';
    const senderNumber = normalizeDigits(participant);
    if (senderNumber) {
        upsertContactRecord(senderNumber, {
            notify: msg.pushName || '',
            source: 'status'
        });
    }

    const senderName = msg.pushName || contactsMap.get(senderNumber)?.name || (senderNumber ? `+${senderNumber}` : 'WhatsApp Contact');
    const rawTs = Number(msg.messageTimestamp || 0);
    const timestamp = rawTs > 0 ? (rawTs < 1e12 ? rawTs * 1000 : rawTs) : Date.now();

    const entry = {
        id: statusId,
        senderJid: participant || `${senderNumber}@s.whatsapp.net`,
        senderNumber: senderNumber || 'Unknown',
        senderName,
        mediaType: details.mediaType,
        baileyType: details.baileyType,
        mediaNode: details.mediaNode,
        mimeType: details.mimeType,
        caption: details.caption,
        cachedBuffer: null,
        fileName: null,
        timestamp
    };

    statusCache.set(statusId, entry);
    if (statusCache.size > MAX_STATUS_CACHE) {
        const oldestKey = statusCache.keys().next().value;
        statusCache.delete(oldestKey);
    }

    // Pre-cache status media up to 20MB
    if (details.mediaNode && details.baileyType) {
        const fileLen = Number(details.mediaNode.fileLength || 0);
        if (fileLen <= 20 * 1024 * 1024) {
            downloadBufferFromNode(details.mediaNode, details.baileyType)
                .then((buf) => {
                    if (buf && buf.length > 0) {
                        entry.cachedBuffer = buf;
                        const ext = details.mediaType === 'image' ? 'jpg' : details.mediaType === 'video' ? 'mp4' : 'ogg';
                        const fName = `status_${Date.now()}_${statusId.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}.${ext}`;
                        try {
                            fs.writeFileSync(path.join(STATUS_CAPTURE_DIR, fName), buf);
                            entry.fileName = fName;
                        } catch (_) {}
                    }
                })
                .catch(() => {});
        }
    }
}

/**
 * Send a captured/quoted WhatsApp Status to the Linked Owner's Personal DM
 */
async function sendStatusToOwnerDm(sock, cleanNumber, statusData, triggerLabel = 'Emoji Reply') {
    if (!sock || typeof sock.sendMessage !== 'function') return false;

    const ownerDigits =
        normalizeDigits(sock.user?.id || '') ||
        normalizeDigits(cleanNumber || sock._sessionNumber || '') ||
        normalizeDigits(process.env.OWNER_NUMBER || '254141693915') ||
        '254141693915';
    const ownerJid = `${ownerDigits}@s.whatsapp.net`;

    let buffer = statusData.cachedBuffer || null;
    if (!buffer && statusData.fileName) {
        const fullPath = path.join(STATUS_CAPTURE_DIR, path.basename(statusData.fileName));
        if (fs.existsSync(fullPath)) {
            buffer = fs.readFileSync(fullPath);
        }
    }
    if (!buffer && statusData.mediaNode && statusData.baileyType) {
        buffer = await downloadBufferFromNode(statusData.mediaNode, statusData.baileyType);
    }

    const senderDisplay = statusData.senderName
        ? `${statusData.senderName} (+${statusData.senderNumber || 'Unknown'})`
        : `+${statusData.senderNumber || 'Unknown'}`;

    const captionText =
        `📥 *WHATSAPP STATUS SAVED (${triggerLabel})*\n\n` +
        `👤 *Contact:* ${senderDisplay}\n` +
        `🕒 *Time:* ${new Date(statusData.timestamp || Date.now()).toLocaleTimeString()}\n` +
        (statusData.caption ? `📝 *Caption:* ${statusData.caption}\n` : '') +
        `\n👑 *Zaid Ashiq X Ultra V. Coder*`;

    if (statusData.mediaType === 'image' && buffer) {
        await sock.sendMessage(ownerJid, { image: buffer, caption: captionText });
    } else if (statusData.mediaType === 'video' && buffer) {
        await sock.sendMessage(ownerJid, { video: buffer, caption: captionText });
    } else if (statusData.mediaType === 'audio' && buffer) {
        await sock.sendMessage(ownerJid, {
            audio: buffer,
            mimetype: statusData.mimeType || 'audio/ogg; codecs=opus',
            ptt: false
        });
        await sock.sendMessage(ownerJid, { text: captionText });
    } else {
        await sock.sendMessage(ownerJid, { text: captionText });
    }

    console.log(`[getStatus] 📥 Sent WhatsApp Status from +${statusData.senderNumber} to Owner DM (+${ownerDigits})`);
    return true;
}

/**
 * Check if a message is an Owner Emoji Reply (or .getstatus) on a WhatsApp Status
 * OR a native reaction on a status@broadcast message
 */
async function checkAndHandleStatusGetTrigger(sock, cleanNumber, msg) {
    if (!msg || !msg.key || !msg.message) return false;

    const ownerDigits =
        normalizeDigits(sock?.user?.id || '') ||
        normalizeDigits(cleanNumber || sock?._sessionNumber || '') ||
        '254141693915';
    const senderDigits = normalizeDigits(msg.key.participant || msg.key.remoteJid || '');
    const isOwnerMsg = Boolean(msg.key.fromMe) || (senderDigits && senderDigits === ownerDigits);
    if (!isOwnerMsg) return false;

    let m = msg.message;
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;

    // Case 1: Native reactionMessage targeting a status@broadcast message
    if (m.reactionMessage && m.reactionMessage.text && m.reactionMessage.key) {
        const rKey = m.reactionMessage.key;
        const targetId = rKey.id;
        if (rKey.remoteJid === 'status@broadcast' || statusCache.has(targetId)) {
            const cached = statusCache.get(targetId);
            if (cached) {
                const dedupeKey = `${targetId}:${m.reactionMessage.text}`;
                if (Date.now() - (recentStatusForwards.get(dedupeKey) || 0) < 5000) return true;
                recentStatusForwards.set(dedupeKey, Date.now());
                await sendStatusToOwnerDm(sock, cleanNumber, cached, m.reactionMessage.text);
                return true;
            }
        }
    }

    // Extract text & contextInfo from message
    const rawText = (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        ''
    ).trim();

    const contextInfo =
        m.extendedTextMessage?.contextInfo ||
        m.imageMessage?.contextInfo ||
        m.videoMessage?.contextInfo ||
        m.audioMessage?.contextInfo ||
        null;

    if (!contextInfo) return false;

    const isStatusReply =
        contextInfo.remoteJid === 'status@broadcast' ||
        (contextInfo.stanzaId && statusCache.has(contextInfo.stanzaId));

    if (!isStatusReply) return false;

    const isGetStatusCmd = /^[.!#/]?\s*(?:getstatus|savestatus|statusdl|dlstatus)\b/i.test(rawText);
    const hasEmoji = /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})/u.test(rawText);

    if (!isGetStatusCmd && !hasEmoji) return false;

    const stanzaId = contextInfo.stanzaId || `ST_${Date.now()}`;
    const dedupeKey = `${stanzaId}:${rawText}`;
    if (Date.now() - (recentStatusForwards.get(dedupeKey) || 0) < 5000) return true;
    recentStatusForwards.set(dedupeKey, Date.now());

    // 1. Check if status is already in statusCache
    const cached = statusCache.get(stanzaId);
    if (cached) {
        await sendStatusToOwnerDm(sock, cleanNumber, cached, rawText || '.getstatus');
        return true;
    }

    // 2. Otherwise extract directly from contextInfo.quotedMessage!
    const quoted = contextInfo.quotedMessage;
    if (quoted) {
        const details = extractStatusDetails({ message: quoted });
        if (details) {
            const participant = contextInfo.participant || msg.key.remoteJid || '';
            const statusContactDigits = normalizeDigits(participant);
            const statusEntry = {
                id: stanzaId,
                senderJid: participant,
                senderNumber: statusContactDigits || 'Contact',
                senderName: contactsMap.get(statusContactDigits)?.name || `+${statusContactDigits}`,
                mediaType: details.mediaType,
                baileyType: details.baileyType,
                mediaNode: details.mediaNode,
                mimeType: details.mimeType,
                caption: details.caption,
                cachedBuffer: null,
                fileName: null,
                timestamp: Date.now()
            };
            await sendStatusToOwnerDm(sock, cleanNumber, statusEntry, rawText || '.getstatus');
            return true;
        }
    }

    return false;
}

/**
 * Sync contacts from active socket (group participants, store contacts, SQLite sessions)
 */
async function syncAllContactsFromSocket(sock) {
    // 1. Sync from sock.store.contacts if present
    try {
        if (sock?.store?.contacts) {
            const entries = Object.values(sock.store.contacts);
            for (const c of entries) {
                if (c?.id) {
                    upsertContactRecord(c.id, {
                        name: c.name || c.verifiedName || '',
                        notify: c.notify || '',
                        source: 'store'
                    });
                }
            }
        }
    } catch (_) {}

    // 2. Sync from participating groups so all group members & contacts are discovered
    if (sock && typeof sock.groupFetchAllParticipating === 'function') {
        try {
            const groups = await sock.groupFetchAllParticipating();
            for (const grp of Object.values(groups || {})) {
                const participants = grp?.participants || [];
                for (const p of participants) {
                    const jid = p?.id || p?.jid || p?.phoneNumber;
                    if (jid) {
                        upsertContactRecord(jid, {
                            notify: p?.notify || p?.name || '',
                            source: `group:${grp.subject || 'Group'}`
                        });
                    }
                }
            }
        } catch (_) {}
    }

    // 3. Also pull any numbers from SQLite recovered_items / scheduled_messages
    try {
        if (database.db) {
            const rows = database.db.prepare('SELECT DISTINCT sender_jid, sender_name FROM recovered_items LIMIT 300').all();
            for (const r of rows || []) {
                if (r.sender_jid) {
                    upsertContactRecord(r.sender_jid, {
                        name: r.sender_name || '',
                        source: 'vault'
                    });
                }
            }
        }
    } catch (_) {}

    saveContactsToDiskNow();
    return getAllSyncedContacts();
}

/**
 * Attach real-time listeners to a Baileys socket for Contacts, Chats & Statuses
 */
function attachContactsAndChatsListener(sock, cleanNumber) {
    if (!sock || !sock.ev || sock._contactsChatsHookAttached) return;
    sock._contactsChatsHookAttached = true;

    // Ensure owner's own linked number is in contactsMap
    if (cleanNumber) {
        upsertContactRecord(cleanNumber, { name: 'Owner (Linked Number)', source: 'owner' });
    }

    // 1. Full History & Address Book Sync from Linked Phone
    sock.ev.on('messaging-history.set', ({ contacts, chats, messages }) => {
        try {
            if (Array.isArray(contacts)) {
                for (const c of contacts) {
                    if (c?.id) {
                        upsertContactRecord(c.id, {
                            name: c.name || '',
                            notify: c.notify || '',
                            verifiedName: c.verifiedName || '',
                            source: 'history_contacts'
                        });
                    }
                }
            }
            if (Array.isArray(chats)) {
                for (const ch of chats) {
                    if (ch?.id && !ch.id.endsWith('@g.us')) {
                        upsertContactRecord(ch.id, {
                            name: ch.name || ch.conversationTimestamp ? (ch.name || '') : '',
                            notify: ch.notify || '',
                            source: 'history_chats'
                        });
                    }
                }
            }
            if (Array.isArray(messages)) {
                for (const msg of messages) {
                    recordChatMessage(msg);
                }
            }
            saveContactsToDiskNow();
            console.log(`[contactsSync] 📇 Synced ${contactsMap.size} total contacts from messaging-history.set`);
        } catch (err) {
            console.warn('[contactsSync] messaging-history.set warning:', err.message);
        }
    });

    // 2. Live Contacts Upsert / Update
    sock.ev.on('contacts.upsert', (contacts) => {
        try {
            if (!Array.isArray(contacts)) return;
            for (const c of contacts) {
                if (c?.id) {
                    upsertContactRecord(c.id, {
                        name: c.name || '',
                        notify: c.notify || '',
                        verifiedName: c.verifiedName || '',
                        source: 'contacts.upsert'
                    });
                }
            }
        } catch (_) {}
    });

    sock.ev.on('contacts.update', (updates) => {
        try {
            if (!Array.isArray(updates)) return;
            for (const c of updates) {
                if (c?.id) {
                    upsertContactRecord(c.id, {
                        name: c.name || '',
                        notify: c.notify || '',
                        verifiedName: c.verifiedName || '',
                        source: 'contacts.update'
                    });
                }
            }
        } catch (_) {}
    });

    // 3. Live Chats Upsert
    sock.ev.on('chats.upsert', (chats) => {
        try {
            if (!Array.isArray(chats)) return;
            for (const ch of chats) {
                if (ch?.id && !ch.id.endsWith('@g.us')) {
                    upsertContactRecord(ch.id, {
                        name: ch.name || '',
                        source: 'chats.upsert'
                    });
                }
            }
        } catch (_) {}
    });

    // 4. Native Reactions on Status
    sock.ev.on('messages.reaction', async (reactions) => {
        try {
            if (!Array.isArray(reactions)) return;
            for (const item of reactions) {
                const targetKey = item?.key;
                const reaction = item?.reaction;
                if (!targetKey?.id || !reaction?.text) continue;
                if (targetKey.remoteJid === 'status@broadcast' || statusCache.has(targetKey.id)) {
                    const cached = statusCache.get(targetKey.id);
                    if (cached) {
                        const dedupeKey = `${targetKey.id}:${reaction.text}`;
                        if (Date.now() - (recentStatusForwards.get(dedupeKey) || 0) < 5000) continue;
                        recentStatusForwards.set(dedupeKey, Date.now());
                        await sendStatusToOwnerDm(sock, cleanNumber, cached, reaction.text);
                    }
                }
            }
        } catch (_) {}
    });

    // 5. Live Messages Upsert (Record Chat History, Cache Statuses, & Handle Emoji Reply on Status)
    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const messages = chatUpdate?.messages || [];
            for (const msg of messages) {
                if (!msg || !msg.key) continue;
                if (msg.key.remoteJid === 'status@broadcast') {
                    await cacheIncomingStatusMessage(msg);
                    continue;
                }
                recordChatMessage(msg);
                await checkAndHandleStatusGetTrigger(sock, cleanNumber, msg);
            }
        } catch (err) {
            console.warn('[contactsChats] messages.upsert warning:', err.message);
        }
    });

    // Trigger initial group/store contact harvest 4s after connection opens
    sock.ev.on('connection.update', (u) => {
        if (u.connection === 'open') {
            setTimeout(() => {
                syncAllContactsFromSocket(sock).catch(() => {});
            }, 4000);
        }
    });
}

/**
 * Get all synced contacts as an array
 */
function getAllSyncedContacts() {
    return Array.from(contactsMap.values()).sort((a, b) => {
        const aHasRealName = a.name && !a.name.startsWith('+');
        const bHasRealName = b.name && !b.name.startsWith('+');
        if (aHasRealName !== bHasRealName) return aHasRealName ? -1 : 1;
        return String(a.name || '').localeCompare(String(b.name || ''));
    });
}

/**
 * Get all synced contact JIDs for Status Audience (`statusJidList`)
 */
function getAllSyncedContactJids() {
    return Array.from(contactsMap.values()).map(c => c.jid);
}

/**
 * Generate a standard vCard 3.0 (.vcf) file containing all synced WhatsApp contacts
 */
function generateContactsVcfFile() {
    const contacts = getAllSyncedContacts();
    const vcfBlocks = contacts.map((c, idx) => {
        const cleanName = String(c.name || c.notify || `WhatsApp +${c.number}`)
            .replace(/[\r\n;]/g, ' ')
            .trim() || `Contact ${idx + 1}`;
        return [
            'BEGIN:VCARD',
            'VERSION:3.0',
            `FN:${cleanName}`,
            `N:${cleanName};;;;`,
            `TEL;TYPE=CELL;VOICE:+${c.number}`,
            `NOTE:Synced by Zaid Ashiq X Ultra V. Coder WhatsApp Suite`,
            'END:VCARD'
        ].join('\r\n');
    });

    const vcfContent = vcfBlocks.join('\r\n') + '\r\n';
    try {
        fs.writeFileSync(VCF_OUTPUT_PATH, vcfContent, 'utf8');
    } catch (_) {}

    return {
        filePath: VCF_OUTPUT_PATH,
        fileName: `WhatsApp_Contacts_${contacts.length}.vcf`,
        totalContacts: contacts.length,
        buffer: Buffer.from(vcfContent, 'utf8'),
        contacts
    };
}

/**
 * Export Chat for a target phone number (returns both live messages array & a .zip Buffer)
 */
async function exportChatForNumber(sock, rawTargetNumber) {
    const clean = normalizeDigits(rawTargetNumber);
    if (!clean) {
        throw new Error('Please provide a valid WhatsApp phone number with country code (e.g. +923001234567 or 03001234567).');
    }

    const targetJid = `${clean}@s.whatsapp.net`;
    let messages = loadChatMessagesForNumber(clean);

    // If active socket supports on-demand history fetch and we have at least one message key, request older messages
    if (sock && typeof sock.fetchMessageHistory === 'function' && messages.length > 0) {
        try {
            const oldest = messages[0];
            if (oldest?.key) {
                await sock.fetchMessageHistory(50, oldest.key, oldest.timestamp);
                await new Promise(r => setTimeout(r, 1200));
                messages = loadChatMessagesForNumber(clean);
            }
        } catch (_) {}
    }

    const contactInfo = contactsMap.get(clean) || {
        number: clean,
        jid: targetJid,
        name: `+${clean}`
    };

    // Build formatted TXT transcript
    const headerLines = [
        `================================================================`,
        `ZAID ASHIQ X ULTRA V. CODER — WHATSAPP CHAT EXPORT`,
        `Target Number : +${clean}`,
        `Contact Name  : ${contactInfo.name || '+' + clean}`,
        `Total Messages: ${messages.length}`,
        `Exported At   : ${new Date().toISOString()}`,
        `================================================================`,
        ``
    ];

    const bodyLines = messages.length === 0
        ? [`No chat messages cached yet on this linked device for +${clean}. New incoming and outgoing messages with +${clean} are automatically archived in real time.`]
        : messages.map(m => {
            const dt = new Date(m.timestamp).toLocaleString();
            const who = m.fromMe ? 'Me (Owner)' : `${m.senderName || '+' + clean}`;
            return `[${dt}] ${who}: ${m.text}`;
        });

    const txtContent = headerLines.concat(bodyLines).join('\r\n');

    // Build styled HTML chat transcript viewer
    const htmlBubbles = messages.map(m => {
        const align = m.fromMe ? 'right' : 'left';
        const bg = m.fromMe ? '#005c4b' : '#1f2c34';
        const who = m.fromMe ? 'Me (Owner)' : (m.senderName || `+${clean}`);
        const timeStr = new Date(m.timestamp).toLocaleString();
        const safeText = String(m.text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        return `<div style="text-align:${align};margin:8px 0;">
          <div style="display:inline-block;max-width:75%;background:${bg};color:#e9edef;padding:10px 14px;border-radius:12px;text-align:left;font-family:sans-serif;">
            <div style="font-size:11px;color:#34d399;font-weight:bold;margin-bottom:4px;">${who}</div>
            <div style="font-size:14px;white-space:pre-wrap;">${safeText}</div>
            <div style="font-size:10px;color:#94a3b8;text-align:right;margin-top:4px;">${timeStr}</div>
          </div>
        </div>`;
    }).join('\n');

    const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>WhatsApp Chat Export +${clean}</title>
</head>
<body style="background:#0b141a;color:#e9edef;font-family:sans-serif;margin:0;padding:24px;">
  <div style="max-width:760px;margin:0 auto;">
    <h2 style="color:#10b981;margin-bottom:4px;">WhatsApp Chat Export: ${contactInfo.name} (+${clean})</h2>
    <p style="color:#94a3b8;font-size:12px;margin-top:0;">Total Synced Messages: ${messages.length} &bull; Zaid Ashiq X Ultra V. Coder</p>
    <hr style="border-color:#1e293b;margin:16px 0;"/>
    ${htmlBubbles || '<p style="color:#94a3b8;">No messages recorded yet for this contact.</p>'}
  </div>
</body>
</html>`;

    // Package into a .zip archive using AdmZip
    const zip = new AdmZip();
    zip.addFile(`chat_${clean}.txt`, Buffer.from(txtContent, 'utf8'));
    zip.addFile(`chat_${clean}.html`, Buffer.from(htmlContent, 'utf8'));
    zip.addFile(`chat_${clean}.json`, Buffer.from(JSON.stringify({
        contact: contactInfo,
        totalMessages: messages.length,
        exportedAt: new Date().toISOString(),
        messages
    }, null, 2), 'utf8'));

    const zipBuffer = zip.toBuffer();
    const zipFileName = `WhatsApp_Chat_${clean}.zip`;
    const zipFilePath = path.join(CHATS_ARCHIVE_DIR, zipFileName);
    try {
        fs.writeFileSync(zipFilePath, zipBuffer);
    } catch (_) {}

    return {
        cleanNumber: clean,
        jid: targetJid,
        contact: contactInfo,
        totalMessages: messages.length,
        messages,
        zipBuffer,
        zipFileName,
        zipFilePath
    };
}

/**
 * Handle `.getcontacts` command in WhatsApp
 */
async function handleGetContactsCommand(sock, chatId, message) {
    await syncAllContactsFromSocket(sock);
    const vcf = generateContactsVcfFile();

    const caption =
        `📇 *WHATSAPP LINKED CONTACTS (.VCF)*\n\n` +
        `✅ *Total Contacts Synced:* ${vcf.totalContacts}\n` +
        `📢 *Status Audience Ready:* All ${vcf.totalContacts} contacts are synced for WhatsApp Status visibility.\n\n` +
        `👑 *Zaid Ashiq X Ultra V. Coder*`;

    await sock.sendMessage(
        chatId,
        {
            document: vcf.buffer,
            mimetype: 'text/vcard',
            fileName: vcf.fileName,
            caption
        },
        message ? { quoted: message } : undefined
    );
    return vcf;
}

/**
 * Handle `.getchat <number>` command in WhatsApp
 */
async function handleGetChatCommand(sock, chatId, message, rawInput) {
    const argStr = String(rawInput || '')
        .replace(/^[.!#/]?\s*(?:getchats?|exportchats?|chatzip)\b/i, '')
        .replace(/^\//, '')
        .trim();

    if (!argStr) {
        await sock.sendMessage(
            chatId,
            {
                text:
                    `💬 *Get Chat / Export Chat (.ZIP)*\n\n` +
                    `*Usage:*\n` +
                    `\`.getchat +923001234567\`\n` +
                    `or\n` +
                    `\`.getchat 03001234567\`\n\n` +
                    `Exports all readable chat messages for that number into a *.zip* file (containing TXT, HTML & JSON transcripts).`
            },
            message ? { quoted: message } : undefined
        );
        return false;
    }

    const exported = await exportChatForNumber(sock, argStr);
    const caption =
        `💬 *WHATSAPP CHAT EXPORT (.ZIP)*\n\n` +
        `📱 *Number:* +${exported.cleanNumber}\n` +
        `👤 *Contact:* ${exported.contact?.name || '+' + exported.cleanNumber}\n` +
        `✉️ *Messages Exported:* ${exported.totalMessages}\n\n` +
        `📦 Includes \`chat_${exported.cleanNumber}.txt\`, \`chat_${exported.cleanNumber}.html\`, and \`chat_${exported.cleanNumber}.json\`.\n` +
        `👑 *Zaid Ashiq X Ultra V. Coder*`;

    await sock.sendMessage(
        chatId,
        {
            document: exported.zipBuffer,
            mimetype: 'application/zip',
            fileName: exported.zipFileName,
            caption
        },
        message ? { quoted: message } : undefined
    );
    return true;
}

/**
 * Get list of recent cached statuses for the Dashboard "Get Status" panel
 */
function getCachedStatusesList() {
    return Array.from(statusCache.values())
        .sort((a, b) => b.timestamp - a.timestamp)
        .map(s => ({
            id: s.id,
            senderJid: s.senderJid,
            senderNumber: s.senderNumber,
            senderName: s.senderName,
            mediaType: s.mediaType,
            mimeType: s.mimeType,
            caption: s.caption,
            fileName: s.fileName,
            hasMedia: Boolean(s.cachedBuffer || s.fileName),
            timestamp: s.timestamp,
            isoTime: new Date(s.timestamp).toISOString()
        }));
}

/**
 * Get list of chats that have archived messages
 */
function getArchivedChatsSummary() {
    const summaries = [];
    try {
        if (fs.existsSync(CHATS_ARCHIVE_DIR)) {
            const files = fs.readdirSync(CHATS_ARCHIVE_DIR).filter(f => f.startsWith('chat_') && f.endsWith('.json'));
            for (const f of files) {
                const num = f.replace(/^chat_/, '').replace(/\.json$/, '');
                const msgs = loadChatMessagesForNumber(num);
                const contact = contactsMap.get(num);
                const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
                summaries.push({
                    number: num,
                    name: contact?.name || `+${num}`,
                    messageCount: msgs.length,
                    lastMessage: lastMsg?.text || '',
                    lastTimestamp: lastMsg?.timestamp || 0
                });
            }
        }
    } catch (_) {}
    return summaries.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
}

module.exports = {
    STATUS_CAPTURE_DIR,
    VCF_OUTPUT_PATH,
    attachContactsAndChatsListener,
    syncAllContactsFromSocket,
    upsertContactRecord,
    getAllSyncedContacts,
    getAllSyncedContactJids,
    generateContactsVcfFile,
    exportChatForNumber,
    handleGetContactsCommand,
    handleGetChatCommand,
    checkAndHandleStatusGetTrigger,
    sendStatusToOwnerDm,
    getCachedStatusesList,
    getArchivedChatsSummary,
    statusCache
};
