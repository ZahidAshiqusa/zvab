'use strict';

/**
 * WhatsApp Status (Story) Service using Baileys
 * Brand: Zaid Ashiq X Ultra V. Coder
 *
 * Capabilities:
 * 1. Upload Images, Videos, Text, and Audio Voice Notes to WhatsApp Status (status@broadcast)
 * 2. Converts any audio file (MP3, M4A, WAV, AAC, OGG, OPUS) via FFmpeg to Opus Voice Note (ptt: true)
 *    with computed duration (seconds), 64-bar waveform, and backgroundArgb so WhatsApp renders a real Voice Status
 * 3. Asks 3 Privacy Settings Buttons before posting status:
 *    - Everyone in contact
 *    - Only share with default setting
 *    - Exclude people default setting
 * 4. Strictly restricted to the owner of the linked WhatsApp number
 * 5. Maintains recent status upload history & default privacy lists for the dashboard
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { downloadContentFromMessage, downloadMediaMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');
const { DATA_DIR } = require('./storagePaths');

let sendButtons = null;
try {
    sendButtons = require('kango-wa').sendButtons;
} catch (_) {
    sendButtons = null;
}

const OWNER_CLEAN_NUMBER = '254141693915';
const OWNER_NAME = 'Zaid Ashiq X Ultra V. Coder';
const TINY_CAPTION = 'ᶻᵃⁱᵈ ᴬˢʰⁱզ ˣ ᵁˡᵗʳᵃ ᵛ. ᶜᵒᵈᵉʳ';
const DEFAULT_STATUS_BG = '#128C7E';
const STATUS_PRIVACY_PATH = path.join(DATA_DIR, 'status_privacy.json');

// In-memory status upload history (keeps last 30 uploads)
const statusUploadHistory = [];
// Recent real contact JIDs observed during runtime
const runtimeContactJids = new Set([`${OWNER_CLEAN_NUMBER}@s.whatsapp.net`]);
// Staged status uploads waiting for the owner's 3-button privacy choice (chatId -> payload)
const pendingStatusQueue = new Map();

function normalizePhoneDigits(raw) {
    if (!raw) return '';
    let digits = String(raw).split('@')[0].split(':')[0].replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.startsWith('0') && digits.length === 11) {
        digits = '92' + digits.slice(1);
    }
    return (digits.length >= 7 && digits.length <= 15) ? digits : '';
}

function normalizeToUserJid(raw) {
    if (!raw) return null;
    const str = String(raw).trim();
    if (!str) return null;
    if (str.endsWith('@g.us') || str.endsWith('@broadcast') || str.endsWith('@newsletter') || str.endsWith('@lid')) {
        return null;
    }
    try {
        const norm = jidNormalizedUser(str);
        if (norm && norm.endsWith('@s.whatsapp.net')) {
            const digits = normalizePhoneDigits(norm);
            if (digits) return `${digits}@s.whatsapp.net`;
        }
    } catch (_) {}
    const digits = normalizePhoneDigits(str);
    if (digits) {
        return `${digits}@s.whatsapp.net`;
    }
    return null;
}

/**
 * Verify if the incoming WhatsApp message was sent by the owner of the linked number ONLY
 */
function isLinkedSessionOwner(sock, message) {
    if (!message || !message.key) return false;
    if (Boolean(message.key.fromMe)) return true;

    const senderRaw = message.key.participant || message.key.remoteJid || '';
    const senderDigits = normalizePhoneDigits(senderRaw);
    if (!senderDigits) return false;

    const linkedDigits = normalizePhoneDigits(sock?.user?.id || sock?._sessionNumber || '');
    if (linkedDigits && senderDigits === linkedDigits) return true;

    const configuredOwner = normalizePhoneDigits(process.env.OWNER_NUMBER || OWNER_CLEAN_NUMBER);
    if (!linkedDigits && configuredOwner && senderDigits === configuredOwner) return true;

    return false;
}

/**
 * Load & Save Status Privacy Default Settings ("Everyone in contact", "Only share with", "Exclude people")
 */
function getStatusPrivacyConfig() {
    try {
        if (fs.existsSync(STATUS_PRIVACY_PATH)) {
            const raw = JSON.parse(fs.readFileSync(STATUS_PRIVACY_PATH, 'utf8'));
            return {
                defaultMode: ['everyone', 'only_share', 'exclude'].includes(raw.defaultMode) ? raw.defaultMode : 'everyone',
                onlyShareList: Array.isArray(raw.onlyShareList)
                    ? raw.onlyShareList.map(normalizePhoneDigits).filter(Boolean)
                    : [],
                excludeList: Array.isArray(raw.excludeList)
                    ? raw.excludeList.map(normalizePhoneDigits).filter(Boolean)
                    : []
            };
        }
    } catch (_) {}
    return {
        defaultMode: 'everyone',
        onlyShareList: [],
        excludeList: []
    };
}

function saveStatusPrivacyConfig(updates = {}) {
    const current = getStatusPrivacyConfig();
    const parsePhoneArray = (input, fallback) => {
        if (input === undefined) return fallback;
        if (Array.isArray(input)) {
            return [...new Set(input.map(normalizePhoneDigits).filter(Boolean))];
        }
        if (typeof input === 'string') {
            return [...new Set(input.split(/[\s,;]+/).map(normalizePhoneDigits).filter(Boolean))];
        }
        return fallback;
    };

    const next = {
        defaultMode: ['everyone', 'only_share', 'exclude'].includes(updates.defaultMode)
            ? updates.defaultMode
            : current.defaultMode,
        onlyShareList: parsePhoneArray(updates.onlyShareList, current.onlyShareList),
        excludeList: parsePhoneArray(updates.excludeList, current.excludeList)
    };

    try {
        fs.mkdirSync(path.dirname(STATUS_PRIVACY_PATH), { recursive: true });
        fs.writeFileSync(STATUS_PRIVACY_PATH, JSON.stringify(next, null, 2), 'utf8');
    } catch (err) {
        console.warn('[statusService] Could not save status privacy config:', err.message);
    }
    return next;
}

function rememberStatusContactJid(jid) {
    const clean = normalizeToUserJid(jid);
    if (clean) {
        runtimeContactJids.add(clean);
    }
}

function recordStatusUpload(entry) {
    statusUploadHistory.unshift({
        id: entry.id || `status_${Date.now()}`,
        type: entry.type || 'media',
        caption: entry.caption || '',
        mimetype: entry.mimetype || '',
        isVoiceNote: Boolean(entry.isVoiceNote),
        privacyMode: entry.privacyMode || 'everyone',
        recipientCount: Number(entry.recipientCount) || 0,
        source: entry.source || 'Dashboard',
        timestamp: new Date().toISOString(),
        success: Boolean(entry.success)
    });
    if (statusUploadHistory.length > 30) {
        statusUploadHistory.pop();
    }
}

function getStatusUploadHistory() {
    return statusUploadHistory;
}

/**
 * Detect media category ('image' | 'video' | 'audio') from mimetype, filename, and magic bytes
 */
function detectMediaCategory({ mimetype = '', filename = '', buffer = null, isVoiceNote = false }) {
    const mime = String(mimetype || '').toLowerCase().trim();
    const ext = String(filename || '').toLowerCase().split('.').pop();

    const audioExts = new Set(['mp3', 'wav', 'ogg', 'opus', 'm4a', 'aac', 'flac', 'amr', 'wma', 'weba', 'caf']);
    const videoExts = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', '3gp']);
    const imageExts = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);

    if (mime.startsWith('audio/') || mime === 'application/ogg' || audioExts.has(ext)) {
        return 'audio';
    }
    if (mime.startsWith('image/') || imageExts.has(ext)) {
        return 'image';
    }
    if (mime.startsWith('video/') || videoExts.has(ext)) {
        return 'video';
    }

    if (buffer && Buffer.isBuffer(buffer) && buffer.length >= 12) {
        if (buffer[0] === 0x4f && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
            return 'audio';
        }
        if (
            (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) ||
            (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
        ) {
            return 'audio';
        }
        if (
            buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
            buffer[8] === 0x57 && buffer[9] === 0x41 && buffer[10] === 0x56 && buffer[11] === 0x45
        ) {
            return 'audio';
        }
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
            return 'image';
        }
        if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
            return 'image';
        }
        if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
            const brand = buffer.slice(8, 12).toString('ascii').toLowerCase();
            if (brand.includes('m4a') || brand.includes('mp4a')) return 'audio';
            return isVoiceNote ? 'audio' : 'video';
        }
    }

    if (isVoiceNote) return 'audio';
    return 'image';
}

/**
 * Generate a 64-bar voice note waveform (Uint8Array) from an audio buffer
 */
function buildVoiceNoteWaveform(buffer) {
    const bars = 64;
    const waveform = new Uint8Array(bars);
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
        for (let i = 0; i < bars; i++) waveform[i] = 35;
        return waveform;
    }
    const step = Math.max(1, Math.floor(buffer.length / bars));
    for (let i = 0; i < bars; i++) {
        let sum = 0;
        let count = 0;
        const start = i * step;
        const end = Math.min(buffer.length, start + Math.min(step, 256));
        for (let j = start; j < end; j++) {
            sum += Math.abs(buffer[j] - 128);
            count++;
        }
        const avg = count > 0 ? sum / count : 32;
        waveform[i] = Math.max(12, Math.min(96, Math.round((avg / 128) * 100)));
    }
    return waveform;
}

/**
 * Convert any audio/video buffer to WhatsApp-compatible OGG/Opus Voice Note (PTT) via FFmpeg
 */
async function convertToOpusVoiceNote(inputBuffer, extHint = 'mp3') {
    if (!inputBuffer || !Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
        throw new Error('Audio buffer is empty.');
    }

    const cleanExt = String(extHint || 'mp3').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp3';
    const tmpDir = os.tmpdir();
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const inputPath = path.join(tmpDir, `status_vn_in_${stamp}.${cleanExt}`);
    const outputPath = path.join(tmpDir, `status_vn_out_${stamp}.ogg`);

    try {
        await fs.promises.writeFile(inputPath, inputBuffer);

        const { durationSeconds } = await new Promise((resolve, reject) => {
            let stderrText = '';
            const proc = spawn('ffmpeg', [
                '-y',
                '-i', inputPath,
                '-vn',
                '-c:a', 'libopus',
                '-b:a', '64k',
                '-vbr', 'on',
                '-compression_level', '10',
                '-application', 'voip',
                '-ar', '48000',
                '-ac', '1',
                '-f', 'ogg',
                outputPath
            ]);

            proc.stderr.on('data', (chunk) => {
                stderrText += chunk.toString();
            });

            proc.on('error', (err) => reject(err));
            proc.on('close', (code) => {
                if (code !== 0) {
                    return reject(new Error(`FFmpeg exited with code ${code}`));
                }
                let secs = 0;
                const matches = [...stderrText.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
                const durMatch = stderrText.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
                const pick = matches.length > 0 ? matches[matches.length - 1] : durMatch;
                if (pick) {
                    secs = Math.ceil(Number(pick[1]) * 3600 + Number(pick[2]) * 60 + parseFloat(pick[3]));
                }
                resolve({ durationSeconds: Math.max(1, secs || 5) });
            });
        });

        const opusBuffer = await fs.promises.readFile(outputPath);
        return {
            buffer: opusBuffer,
            mimetype: 'audio/ogg; codecs=opus',
            seconds: durationSeconds,
            waveform: buildVoiceNoteWaveform(opusBuffer)
        };
    } catch (err) {
        console.warn('[statusService] FFmpeg Opus conversion fallback:', err.message);
        const estimatedSeconds = Math.max(1, Math.round(inputBuffer.length / 8000));
        return {
            buffer: inputBuffer,
            mimetype: 'audio/ogg; codecs=opus',
            seconds: estimatedSeconds,
            waveform: buildVoiceNoteWaveform(inputBuffer)
        };
    } finally {
        try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch (_) {}
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
    }
}

/**
 * Resolve recipient JIDs for status@broadcast according to selected Privacy Setting:
 * - 'everyone': Everyone in contact
 * - 'only_share': Only share with default setting (onlyShareList)
 * - 'exclude': Exclude people default setting (everyone except excludeList)
 */
async function resolveStatusJidList(sock, extraJids = [], privacyMode = 'everyone') {
    const privacyCfg = getStatusPrivacyConfig();
    const mode = ['everyone', 'only_share', 'exclude'].includes(privacyMode)
        ? privacyMode
        : privacyCfg.defaultMode;

    const selfJid = normalizeToUserJid(sock?.user?.id);
    const ownerJid = normalizeToUserJid(process.env.OWNER_NUMBER || OWNER_CLEAN_NUMBER);

    // Mode 2: Only share with default setting
    if (mode === 'only_share') {
        const onlySet = new Set();
        if (selfJid) onlySet.add(selfJid);
        for (const num of privacyCfg.onlyShareList || []) {
            const j = normalizeToUserJid(num);
            if (j) onlySet.add(j);
        }
        // Fallback if list is empty so status still posts to self/owner
        if (onlySet.size <= 1) {
            if (ownerJid) onlySet.add(ownerJid);
            for (const j of extraJids) {
                const clean = normalizeToUserJid(j);
                if (clean) onlySet.add(clean);
            }
        }
        return Array.from(onlySet);
    }

    // Collect full contact list for 'everyone' and 'exclude'
    const jidSet = new Set();
    if (selfJid) jidSet.add(selfJid);
    if (ownerJid) jidSet.add(ownerJid);

    for (const j of extraJids) {
        const clean = normalizeToUserJid(j);
        if (clean) jidSet.add(clean);
    }

    for (const j of runtimeContactJids) {
        jidSet.add(j);
    }

    // Include all synced contacts from contactsAndChatsService (full address book + history + groups)
    try {
        const contactsAndChatsService = require('./contactsAndChatsService');
        const syncedJids = contactsAndChatsService.getAllSyncedContactJids();
        for (const j of syncedJids) {
            const c = normalizeToUserJid(j);
            if (c) jidSet.add(c);
        }
    } catch (_) {}

    try {
        const database = require('./database');
        if (database && database.db) {
            try {
                const sessionRows = database.db.prepare('SELECT clean_number FROM user_sessions LIMIT 500').all();
                for (const r of sessionRows) {
                    const c = normalizeToUserJid(r.clean_number);
                    if (c) jidSet.add(c);
                }
            } catch (_) {}
            try {
                const itemRows = database.db.prepare('SELECT DISTINCT sender_jid FROM recovered_items LIMIT 1000').all();
                for (const r of itemRows) {
                    const c = normalizeToUserJid(r.sender_jid);
                    if (c) jidSet.add(c);
                }
            } catch (_) {}
            try {
                const presRows = database.db.prepare('SELECT DISTINCT jid FROM presence_logs LIMIT 1000').all();
                for (const r of presRows) {
                    const c = normalizeToUserJid(r.jid);
                    if (c) jidSet.add(c);
                }
            } catch (_) {}
        }
    } catch (_) {}

    try {
        const statusJidsPath = path.join(__dirname, '..', 'data', 'status_jids.json');
        if (fs.existsSync(statusJidsPath)) {
            const raw = JSON.parse(fs.readFileSync(statusJidsPath, 'utf8'));
            if (Array.isArray(raw)) {
                for (const item of raw) {
                    const c = normalizeToUserJid(item);
                    if (c) jidSet.add(c);
                }
            }
        }
    } catch (_) {}

    if (sock && typeof sock.groupFetchAllParticipating === 'function') {
        try {
            const groups = await Promise.race([
                sock.groupFetchAllParticipating(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('groupFetch timeout')), 4500))
            ]);
            if (groups && typeof groups === 'object') {
                for (const g of Object.values(groups)) {
                    const participants = Array.isArray(g?.participants) ? g.participants : [];
                    for (const p of participants) {
                        const c = normalizeToUserJid(p?.jid || p?.id);
                        if (c) jidSet.add(c);
                    }
                }
            }
        } catch (_) {}
    }

    // Persist discovered JIDs back to status_jids.json so future statuses always have full audience
    try {
        const statusJidsPath = path.join(__dirname, '..', 'data', 'status_jids.json');
        fs.mkdirSync(path.dirname(statusJidsPath), { recursive: true });
        fs.writeFileSync(statusJidsPath, JSON.stringify(Array.from(jidSet), null, 2), 'utf8');
    } catch (_) {}

    // Mode 3: Exclude people default setting
    if (mode === 'exclude' && Array.isArray(privacyCfg.excludeList) && privacyCfg.excludeList.length > 0) {
        const excludedJids = new Set(privacyCfg.excludeList.map(normalizeToUserJid).filter(Boolean));
        for (const ex of excludedJids) {
            if (ex !== selfJid) {
                jidSet.delete(ex);
            }
        }
    }

    return Array.from(jidSet);
}

/**
 * Upload a media buffer or text status to status@broadcast via Baileys
 */
async function uploadMediaToStatus(sock, {
    buffer,
    mimetype = '',
    filename = '',
    caption = '',
    isVoiceNote = false,
    text = '',
    backgroundColor = DEFAULT_STATUS_BG,
    extraJids = [],
    privacyMode = 'everyone',
    source = 'Dashboard'
}) {
    if (!sock || typeof sock.sendMessage !== 'function') {
        throw new Error('WhatsApp device is not connected. Please pair your WhatsApp session first.');
    }

    const effectivePrivacy = ['everyone', 'only_share', 'exclude'].includes(privacyMode)
        ? privacyMode
        : getStatusPrivacyConfig().defaultMode;

    const statusJidList = await resolveStatusJidList(sock, extraJids, effectivePrivacy);
    let messageContent = null;
    let sendOptions = {
        statusJidList
    };
    let detectedType = 'text';

    if (buffer && Buffer.isBuffer(buffer) && buffer.length > 0) {
        const category = detectMediaCategory({ mimetype, filename, buffer, isVoiceNote });

        if (category === 'audio') {
            detectedType = 'audio';
            const extHint = String(filename || '').split('.').pop() || (mimetype.split('/')[1] || 'mp3').split(';')[0];
            const voiceData = await convertToOpusVoiceNote(buffer, extHint);

            messageContent = {
                audio: voiceData.buffer,
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true,
                seconds: voiceData.seconds,
                waveform: voiceData.waveform
            };
            sendOptions.backgroundColor = backgroundColor || DEFAULT_STATUS_BG;
        } else if (category === 'video') {
            detectedType = 'video';
            messageContent = {
                video: buffer,
                caption: caption || '',
                gifPlayback: false
            };
        } else {
            detectedType = 'image';
            messageContent = {
                image: buffer,
                caption: caption || ''
            };
            sendOptions.backgroundColor = backgroundColor || DEFAULT_STATUS_BG;
        }
    } else if (text || caption) {
        detectedType = 'text';
        messageContent = {
            text: text || caption
        };
        sendOptions.backgroundColor = backgroundColor || DEFAULT_STATUS_BG;
        sendOptions.font = 2;
    } else {
        throw new Error('No media file or text caption provided for status upload.');
    }

    try {
        console.log(`[statusService] Broadcasting ${detectedType.toUpperCase()} status (${effectivePrivacy}) to ${statusJidList.length} contact(s)...`);
        const result = await sock.sendMessage('status@broadcast', messageContent, sendOptions);

        recordStatusUpload({
            id: result?.key?.id,
            type: detectedType,
            caption: caption || text,
            mimetype: detectedType === 'audio' ? 'audio/ogg; codecs=opus' : mimetype,
            isVoiceNote: detectedType === 'audio',
            privacyMode: effectivePrivacy,
            recipientCount: statusJidList.length,
            source,
            success: true
        });

        return {
            success: true,
            type: detectedType,
            isVoiceNote: detectedType === 'audio',
            privacyMode: effectivePrivacy,
            recipientCount: statusJidList.length,
            messageId: result?.key?.id,
            timestamp: new Date().toISOString()
        };
    } catch (err) {
        console.error('[statusService] Broadcast error:', err.message);
        recordStatusUpload({
            type: detectedType,
            caption: caption || text,
            mimetype,
            isVoiceNote: detectedType === 'audio',
            privacyMode: effectivePrivacy,
            recipientCount: statusJidList.length,
            source,
            success: false
        });
        throw new Error(`Failed to publish status story: ${err.message}`);
    }
}

/**
 * Download a Baileys media node into a Buffer
 */
async function downloadMediaNode(mediaNode, mediaType, fullMessage = null, sock = null) {
    if (!mediaNode) throw new Error('Media node is missing.');
    try {
        const stream = await downloadContentFromMessage(mediaNode, mediaType);
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        const buf = Buffer.concat(chunks);
        if (buf.length > 0) return buf;
    } catch (primaryErr) {
        if (fullMessage) {
            const buf = await downloadMediaMessage(
                fullMessage,
                'buffer',
                {},
                { logger: undefined, reuploadRequest: sock?.updateMediaMessage }
            );
            if (buf && buf.length > 0) return buf;
        }
        throw primaryErr;
    }
    throw new Error('Downloaded media buffer was empty.');
}

function unwrapMessage(msgObj) {
    let m = msgObj;
    if (!m) return null;
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    if (m.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;
    if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
    return m;
}

function extractStatusButtonChoice(m) {
    if (!m) return { buttonId: '', text: '' };
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

    const rawText = (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        buttonText ||
        ''
    ).trim();

    return {
        buttonId: String(buttonId || '').trim().toLowerCase(),
        text: String(rawText || '').trim()
    };
}

const PRIVACY_LABELS = {
    everyone: 'Everyone in contact',
    only_share: 'Only share with default setting',
    exclude: 'Exclude people default setting'
};

/**
 * Send the 3-Button Status Privacy Prompt before posting status
 */
async function sendStatusPrivacyButtons(sock, chatId, stagedSummary, message) {
    const priv = getStatusPrivacyConfig();
    const promptText =
        `📢 *Status Privacy Settings*\n` +
        `Ready to upload: *${stagedSummary}*\n\n` +
        `Choose who can view this status:\n` +
        `1. *Everyone in contact*\n` +
        `2. *Only share with default setting* (${priv.onlyShareList.length} saved)\n` +
        `3. *Exclude people default setting* (${priv.excludeList.length} excluded)`;

    const buttons = [
        { id: 'status_priv_everyone', text: 'Everyone in contact' },
        { id: 'status_priv_only', text: 'Only share with default setting' },
        { id: 'status_priv_exclude', text: 'Exclude people default setting' }
    ];

    let sent = false;
    if (sendButtons) {
        try {
            await sendButtons(
                sock,
                chatId,
                {
                    text: promptText,
                    buttons
                },
                { quoted: message }
            );
            sent = true;
        } catch (err) {
            console.warn('[statusService] 3-button prompt fallback:', err.message);
        }
    }

    if (!sent) {
        await sock.sendMessage(
            chatId,
            {
                text:
                    `${promptText}\n\n` +
                    `Reply with *1*, *2*, or *3* to publish immediately.`
            },
            { quoted: message }
        );
    }
}

/**
 * Execute a staged status upload once the owner clicks one of the 3 privacy buttons
 */
async function publishStagedStatus(sock, chatId, staged, privacyMode, triggerMsg) {
    pendingStatusQueue.delete(chatId);
    try {
        await sock.sendMessage(chatId, { react: { text: '⏳', key: triggerMsg.key } });
    } catch (_) {}

    try {
        const uploadRes = await uploadMediaToStatus(sock, {
            ...staged,
            privacyMode,
            source: 'bot_command'
        });

        try {
            await sock.sendMessage(chatId, { react: { text: '✅', key: triggerMsg.key } });
        } catch (_) {}

        const typeLabel = uploadRes.type === 'audio'
            ? '🎙️ Voice Note Status (PTT)'
            : uploadRes.type === 'video'
            ? '🎥 Video Status'
            : uploadRes.type === 'image'
            ? '🖼️ Photo Status'
            : '📝 Text Status';

        await sock.sendMessage(chatId, {
            text:
                `✅ *Uploaded to WhatsApp Status!*\n\n` +
                `• *Type:* ${typeLabel}\n` +
                `• *Privacy:* ${PRIVACY_LABELS[privacyMode] || privacyMode}\n` +
                (staged.caption && uploadRes.type !== 'audio' ? `• *Caption:* ${staged.caption}\n` : '') +
                `• *Recipients:* ${uploadRes.recipientCount} contact(s)\n\n` +
                `👑 _${OWNER_NAME} • ${TINY_CAPTION}_`
        }, { quoted: triggerMsg });
        return true;
    } catch (err) {
        try {
            await sock.sendMessage(chatId, { react: { text: '❌', key: triggerMsg.key } });
        } catch (_) {}
        await sock.sendMessage(chatId, {
            text: `❌ *Status Upload Failed:* ${err.message}`
        }, { quoted: triggerMsg });
        return true;
    }
}

/**
 * Handle incoming WhatsApp bot command (.status) and 3-button privacy responses
 * Strictly restricted to the owner of the linked WhatsApp number!
 */
async function handleStatusCommand(sock, message) {
    if (!sock || !message || !message.message) return false;

    const chatId = message.key?.remoteJid;
    const senderJid = message.key?.participant || chatId;
    if (senderJid) rememberStatusContactJid(senderJid);
    if (chatId) rememberStatusContactJid(chatId);

    const m = unwrapMessage(message.message);
    if (!m) return false;

    const { buttonId, text: rawText } = extractStatusButtonChoice(m);
    const lowerText = rawText.toLowerCase();

    // 1. Check if this is a 3-Button Status Privacy click or reply for a staged status
    const staged = pendingStatusQueue.get(chatId);
    let selectedPrivacy = null;

    if (buttonId === 'status_priv_everyone' || lowerText === 'everyone in contact') {
        selectedPrivacy = 'everyone';
    } else if (buttonId === 'status_priv_only' || lowerText === 'only share with default setting') {
        selectedPrivacy = 'only_share';
    } else if (buttonId === 'status_priv_exclude' || lowerText === 'exclude people default setting') {
        selectedPrivacy = 'exclude';
    } else if (staged && Date.now() - staged.timestamp < 5 * 60 * 1000) {
        if (lowerText === '1') selectedPrivacy = 'everyone';
        else if (lowerText === '2') selectedPrivacy = 'only_share';
        else if (lowerText === '3') selectedPrivacy = 'exclude';
    }

    if (selectedPrivacy) {
        if (!isLinkedSessionOwner(sock, message)) return true;
        if (!staged) {
            saveStatusPrivacyConfig({ defaultMode: selectedPrivacy });
            await sock.sendMessage(chatId, {
                text: `✅ Default Status Privacy updated to: *${PRIVACY_LABELS[selectedPrivacy]}*`
            }, { quoted: message });
            return true;
        }
        return await publishStagedStatus(sock, chatId, staged, selectedPrivacy, message);
    }

    // 2. Match .status, .poststatus, .pstatus, .setstatus
    const statusMatch = rawText.match(/^[.!#/]\s*(?:status|poststatus|pstatus|setstatus)(?:\s+|\/|$)([\s\S]*)$/i);
    if (!statusMatch) return false;

    // OWNER-ONLY GUARD: Only the owner of the linked WhatsApp number can use .status
    if (!isLinkedSessionOwner(sock, message)) {
        return true;
    }

    const customCaption = (statusMatch[1] || '').trim();

    // Allow configuring default lists via `.status onlyshare +92300...` or `.status exclude +92300...`
    const configCmdMatch = customCaption.match(/^(onlyshare|exclude)\s+([\s\S]+)$/i);
    if (configCmdMatch) {
        const listType = configCmdMatch[1].toLowerCase();
        const numbersRaw = configCmdMatch[2];
        const updated = listType === 'onlyshare'
            ? saveStatusPrivacyConfig({ onlyShareList: numbersRaw })
            : saveStatusPrivacyConfig({ excludeList: numbersRaw });
        await sock.sendMessage(chatId, {
            text:
                `✅ *Status Privacy Default Setting Saved!*\n\n` +
                `• *Only share with:* ${updated.onlyShareList.length} contact(s)\n` +
                `• *Exclude people:* ${updated.excludeList.length} contact(s)`
        }, { quoted: message });
        return true;
    }

    const contextInfo =
        m.extendedTextMessage?.contextInfo ||
        m.imageMessage?.contextInfo ||
        m.videoMessage?.contextInfo ||
        m.audioMessage?.contextInfo ||
        m.documentMessage?.contextInfo ||
        null;

    const quoted = unwrapMessage(contextInfo?.quotedMessage || null);

    let targetMediaNode = null;
    let targetMediaType = null;
    let downloadStreamType = null;
    let isVoiceNote = false;
    let originalCaption = '';
    let filename = '';
    let syntheticTargetMsg = null;

    if (quoted) {
        syntheticTargetMsg = {
            key: {
                remoteJid: chatId,
                id: contextInfo?.stanzaId || message.key.id,
                participant: contextInfo?.participant
            },
            message: quoted
        };

        if (quoted.imageMessage) {
            targetMediaNode = quoted.imageMessage;
            targetMediaType = 'image';
            downloadStreamType = 'image';
            originalCaption = quoted.imageMessage.caption || '';
        } else if (quoted.videoMessage || quoted.ptvMessage) {
            targetMediaNode = quoted.videoMessage || quoted.ptvMessage;
            targetMediaType = 'video';
            downloadStreamType = 'video';
            originalCaption = targetMediaNode.caption || '';
        } else if (quoted.audioMessage) {
            targetMediaNode = quoted.audioMessage;
            targetMediaType = 'audio';
            downloadStreamType = 'audio';
            isVoiceNote = true;
        } else if (quoted.documentMessage) {
            const docMime = (quoted.documentMessage.mimetype || '').toLowerCase();
            const docName = (quoted.documentMessage.fileName || '').toLowerCase();
            filename = docName;
            const cat = detectMediaCategory({ mimetype: docMime, filename: docName });
            targetMediaNode = quoted.documentMessage;
            targetMediaType = cat;
            downloadStreamType = 'document';
            if (cat === 'audio') isVoiceNote = true;
            originalCaption = quoted.documentMessage.caption || '';
        }
    }

    if (!targetMediaNode) {
        syntheticTargetMsg = message;
        if (m.imageMessage) {
            targetMediaNode = m.imageMessage;
            targetMediaType = 'image';
            downloadStreamType = 'image';
        } else if (m.videoMessage || m.ptvMessage) {
            targetMediaNode = m.videoMessage || m.ptvMessage;
            targetMediaType = 'video';
            downloadStreamType = 'video';
        } else if (m.audioMessage) {
            targetMediaNode = m.audioMessage;
            targetMediaType = 'audio';
            downloadStreamType = 'audio';
            isVoiceNote = true;
        } else if (m.documentMessage) {
            const docMime = (m.documentMessage.mimetype || '').toLowerCase();
            const docName = (m.documentMessage.fileName || '').toLowerCase();
            filename = docName;
            const cat = detectMediaCategory({ mimetype: docMime, filename: docName });
            targetMediaNode = m.documentMessage;
            targetMediaType = cat;
            downloadStreamType = 'document';
            if (cat === 'audio') isVoiceNote = true;
        }
    }

    const quotedText = quoted?.conversation || quoted?.extendedTextMessage?.text || '';
    if (!targetMediaNode && (customCaption || quotedText)) {
        const textToPost = customCaption || quotedText;
        pendingStatusQueue.set(chatId, {
            text: textToPost,
            extraJids: [senderJid, chatId],
            timestamp: Date.now()
        });
        await sendStatusPrivacyButtons(sock, chatId, `Text Story ("${textToPost.slice(0, 40)}")`, message);
        return true;
    }

    if (!targetMediaNode) {
        await sock.sendMessage(chatId, {
            text:
                `📡 *WhatsApp Status Uploader*\n\n` +
                `*Usage:*\n` +
                `1. Reply to any *Photo*, *Video*, or *Audio/MP3/Voice Note* with \`.status\`\n` +
                `2. Select one of the *3 Privacy Buttons*:\n` +
                `   • Everyone in contact\n` +
                `   • Only share with default setting\n` +
                `   • Exclude people default setting\n` +
                `3. Configure default lists:\n` +
                `   • \`.status onlyshare +923001234567\`\n` +
                `   • \`.status exclude +923009999999\`\n\n` +
                `👑 _${OWNER_NAME} • ${TINY_CAPTION}_`
        }, { quoted: message });
        return true;
    }

    try {
        await sock.sendMessage(chatId, { react: { text: '⏳', key: message.key } });
    } catch (_) {}

    try {
        const fileBuffer = await downloadMediaNode(
            targetMediaNode,
            downloadStreamType || targetMediaType,
            syntheticTargetMsg,
            sock
        );
        const finalCaption = customCaption || originalCaption || '';

        pendingStatusQueue.set(chatId, {
            buffer: fileBuffer,
            mimetype: targetMediaNode.mimetype || (targetMediaType === 'audio' ? 'audio/ogg; codecs=opus' : `${targetMediaType}/mp4`),
            filename,
            caption: finalCaption,
            isVoiceNote: targetMediaType === 'audio' || isVoiceNote,
            extraJids: [senderJid, chatId],
            timestamp: Date.now()
        });

        const summaryLabel = (targetMediaType === 'audio' || isVoiceNote)
            ? 'Voice Note Status (Audio -> Opus PTT)'
            : targetMediaType === 'video'
            ? 'Video Status'
            : 'Photo Status';

        await sendStatusPrivacyButtons(sock, chatId, summaryLabel, message);
        return true;
    } catch (err) {
        console.error('[statusService] Command stage error:', err.message);
        try {
            await sock.sendMessage(chatId, { react: { text: '❌', key: message.key } });
            await sock.sendMessage(chatId, {
                text: `❌ *Status Upload Failed:* ${err.message}`
            }, { quoted: message });
        } catch (_) {}
        return true;
    }
}

module.exports = {
    uploadMediaToStatus,
    handleStatusCommand,
    getStatusUploadHistory,
    rememberStatusContactJid,
    convertToOpusVoiceNote,
    getStatusPrivacyConfig,
    saveStatusPrivacyConfig,
    isLinkedSessionOwner
};
