'use strict';

/**
 * WhatsApp Status (Story) Service using Baileys
 *
 * Capabilities:
 * 1. Upload Images, Videos, Text, and Audio Voice Notes to WhatsApp Status (status@broadcast)
 * 2. Converts any audio file (MP3, M4A, WAV, AAC, OGG, OPUS) via FFmpeg to Opus Voice Note (ptt: true)
 *    with computed duration (seconds), 64-bar waveform, and backgroundArgb so WhatsApp renders a real Voice Status
 * 3. Resolves valid statusJidList recipients (self, owner, active chats, saved contacts, group participants)
 * 4. Handles WhatsApp bot command: reply to any media with `.status <caption?>` or `.poststatus <caption?>`
 * 5. Maintains recent status upload history for the dashboard
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { downloadContentFromMessage, downloadMediaMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');

const OWNER_CLEAN_NUMBER = '254141693915';
const OWNER_NAME = 'Mr. Unkown';
const TINY_CAPTION = 'ᵁʳᵒᵒʲ ᶜʰᵒᵘᵈʰᵃʳʸ ˣ ᴹʳ. ᵁⁿᵏᵒʷⁿ';
const DEFAULT_STATUS_BG = '#128C7E';

// In-memory status upload history (keeps last 30 uploads)
const statusUploadHistory = [];
// Recent real contact JIDs observed during runtime
const runtimeContactJids = new Set([`${OWNER_CLEAN_NUMBER}@s.whatsapp.net`]);

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
            const digits = norm.split('@')[0].replace(/\D/g, '');
            if (digits.length >= 7 && digits.length <= 15) {
                return `${digits}@s.whatsapp.net`;
            }
        }
    } catch (_) {}
    const digits = str.split('@')[0].split(':')[0].replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) {
        return `${digits}@s.whatsapp.net`;
    }
    return null;
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

    // Inspect magic bytes if buffer is present
    if (buffer && Buffer.isBuffer(buffer) && buffer.length >= 12) {
        // OGG ('OggS')
        if (buffer[0] === 0x4f && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
            return 'audio';
        }
        // ID3 ('ID3') or MP3 sync word (0xFF 0xFB / 0xFF 0xF3 / 0xFF 0xF2)
        if (
            (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) ||
            (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
        ) {
            return 'audio';
        }
        // RIFF WAVE
        if (
            buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
            buffer[8] === 0x57 && buffer[9] === 0x41 && buffer[10] === 0x56 && buffer[11] === 0x45
        ) {
            return 'audio';
        }
        // PNG
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
            return 'image';
        }
        // JPEG
        if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
            return 'image';
        }
        // MP4 / M4A ('ftyp')
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
 * and extract accurate duration in seconds + 64-bar waveform.
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
 * Resolve all recipient JIDs for status@broadcast (Required by Baileys relayMessage)
 */
async function resolveStatusJidList(sock, extraJids = []) {
    const jidSet = new Set();

    // 1. Bot's own connected JID
    const selfJid = normalizeToUserJid(sock?.user?.id);
    if (selfJid) jidSet.add(selfJid);

    // 2. Owner JID
    const ownerJid = normalizeToUserJid(process.env.OWNER_NUMBER || OWNER_CLEAN_NUMBER);
    if (ownerJid) jidSet.add(ownerJid);

    // 3. Any explicit JIDs (e.g. sender/chat where .status was triggered)
    for (const j of extraJids) {
        const clean = normalizeToUserJid(j);
        if (clean) jidSet.add(clean);
    }

    // 4. Runtime observed contacts
    for (const j of runtimeContactJids) {
        jidSet.add(j);
    }

    // 5. Contacts stored in database (recovered items, user sessions, scheduled messages)
    try {
        const database = require('./database');
        if (database && database.db) {
            try {
                const sessionRows = database.db.prepare('SELECT clean_number FROM user_sessions LIMIT 100').all();
                for (const r of sessionRows) {
                    const c = normalizeToUserJid(r.clean_number);
                    if (c) jidSet.add(c);
                }
            } catch (_) {}
            try {
                const itemRows = database.db.prepare('SELECT DISTINCT sender_jid FROM recovered_items LIMIT 200').all();
                for (const r of itemRows) {
                    const c = normalizeToUserJid(r.sender_jid);
                    if (c) jidSet.add(c);
                }
            } catch (_) {}
            try {
                const presRows = database.db.prepare('SELECT DISTINCT jid FROM presence_logs LIMIT 200').all();
                for (const r of presRows) {
                    const c = normalizeToUserJid(r.jid);
                    if (c) jidSet.add(c);
                }
            } catch (_) {}
        }
    } catch (_) {}

    // 6. Saved status_jids.json contacts (capped to avoid oversized USync queries)
    try {
        const statusJidsPath = path.join(__dirname, '..', 'data', 'status_jids.json');
        if (fs.existsSync(statusJidsPath)) {
            const raw = JSON.parse(fs.readFileSync(statusJidsPath, 'utf8'));
            if (Array.isArray(raw)) {
                for (const item of raw.slice(0, 250)) {
                    const c = normalizeToUserJid(item);
                    if (c) jidSet.add(c);
                }
            }
        }
    } catch (_) {}

    // 7. Active group participants from connected WhatsApp socket (capped at 350 total JIDs)
    if (sock && typeof sock.groupFetchAllParticipating === 'function' && jidSet.size < 350) {
        try {
            const groups = await Promise.race([
                sock.groupFetchAllParticipating(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('groupFetch timeout')), 4000))
            ]);
            if (groups && typeof groups === 'object') {
                for (const g of Object.values(groups)) {
                    const participants = Array.isArray(g?.participants) ? g.participants : [];
                    for (const p of participants) {
                        const c = normalizeToUserJid(p?.jid || p?.id);
                        if (c) jidSet.add(c);
                        if (jidSet.size >= 350) break;
                    }
                    if (jidSet.size >= 350) break;
                }
            }
        } catch (_) {}
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
    source = 'Dashboard'
}) {
    if (!sock || typeof sock.sendMessage !== 'function') {
        throw new Error('WhatsApp device is not connected. Please pair your WhatsApp session first.');
    }

    const statusJidList = await resolveStatusJidList(sock, extraJids);
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
        console.log(`[statusService] Broadcasting ${detectedType.toUpperCase()} status to ${statusJidList.length} contact(s)...`);
        const result = await sock.sendMessage('status@broadcast', messageContent, sendOptions);

        recordStatusUpload({
            id: result?.key?.id,
            type: detectedType,
            caption: caption || text,
            mimetype: detectedType === 'audio' ? 'audio/ogg; codecs=opus' : mimetype,
            isVoiceNote: detectedType === 'audio',
            recipientCount: statusJidList.length,
            source,
            success: true
        });

        return {
            success: true,
            type: detectedType,
            isVoiceNote: detectedType === 'audio',
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
            recipientCount: statusJidList.length,
            source,
            success: false
        });
        throw new Error(`Failed to publish status story: ${err.message}`);
    }
}

/**
 * Download a Baileys media node (imageMessage, videoMessage, audioMessage, documentMessage) into a Buffer
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

/**
 * Unwrap nested ephemeral / viewOnce / documentWithCaption message layers
 */
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

/**
 * Handle incoming WhatsApp bot command:
 * Reply to any photo, video, or audio/voice note with `.status <caption?>` (or `.poststatus`, `.pstatus`, `.setstatus`)
 * Or send `.status <text>` to post a text status story.
 */
async function handleStatusCommand(sock, message) {
    if (!sock || !message || !message.message) return false;

    const chatId = message.key?.remoteJid;
    const senderJid = message.key?.participant || chatId;
    if (senderJid) rememberStatusContactJid(senderJid);
    if (chatId) rememberStatusContactJid(chatId);

    const m = unwrapMessage(message.message);
    if (!m) return false;

    const rawText = (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        ''
    ).trim();

    // Match .status, .poststatus, .pstatus, .setstatus
    const statusMatch = rawText.match(/^[.!#/]\s*(?:status|poststatus|pstatus|setstatus)(?:\s+|\/|$)([\s\S]*)$/i);
    if (!statusMatch) return false;

    const customCaption = (statusMatch[1] || '').trim();

    // Check for quoted message
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

    // 1. Quoted Media Message
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

    // 2. Direct Media Message with .status as caption
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

    // 3. Quoted text message or direct text `.status Hello World`
    const quotedText = quoted?.conversation || quoted?.extendedTextMessage?.text || '';
    if (!targetMediaNode && (customCaption || quotedText)) {
        const textToPost = customCaption || quotedText;
        try {
            await sock.sendMessage(chatId, { react: { text: '⏳', key: message.key } });
        } catch (_) {}

        try {
            const res = await uploadMediaToStatus(sock, {
                text: textToPost,
                extraJids: [senderJid, chatId],
                source: 'bot_command'
            });
            try {
                await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });
            } catch (_) {}
            await sock.sendMessage(chatId, {
                text:
                    `✅ *Text Story Uploaded to WhatsApp Status!*\n\n` +
                    `• *Text:* ${textToPost}\n` +
                    `• *Recipients:* ${res.recipientCount} contact(s)\n\n` +
                    `👑 _${OWNER_NAME} • ${TINY_CAPTION}_`
            }, { quoted: message });
            return true;
        } catch (err) {
            await sock.sendMessage(chatId, {
                text: `❌ *Status Upload Failed:* ${err.message}`
            }, { quoted: message });
            return true;
        }
    }

    // If neither media nor text is present, show usage instructions
    if (!targetMediaNode) {
        await sock.sendMessage(chatId, {
            text:
                `📡 *WhatsApp Status Uploader*\n\n` +
                `*Usage:*\n` +
                `1. Reply to any *Photo*, *Video*, or *Audio/MP3/Voice Note* with \`.status\`\n` +
                `2. Add optional caption: \`.status Your Caption Here\`\n` +
                `3. Post a text status: \`.status Hello everyone!\`\n` +
                `4. Audio files are automatically converted & uploaded as *Voice Note Status Stories* 🎙️\n\n` +
                `👑 _${OWNER_NAME} • ${TINY_CAPTION}_`
        }, { quoted: message });
        return true;
    }

    // React with hourglass while uploading
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

        const uploadRes = await uploadMediaToStatus(sock, {
            buffer: fileBuffer,
            mimetype: targetMediaNode.mimetype || (targetMediaType === 'audio' ? 'audio/ogg; codecs=opus' : `${targetMediaType}/mp4`),
            filename,
            caption: finalCaption,
            isVoiceNote: targetMediaType === 'audio' || isVoiceNote,
            extraJids: [senderJid, chatId],
            source: 'bot_command'
        });

        try {
            await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });
        } catch (_) {}

        const typeLabel = uploadRes.type === 'audio'
            ? '🎙️ Voice Note Status (PTT)'
            : uploadRes.type === 'video'
            ? '🎥 Video Status'
            : '🖼️ Photo Status';

        await sock.sendMessage(chatId, {
            text:
                `✅ *Successfully Uploaded to WhatsApp Status!*\n\n` +
                `• *Type:* ${typeLabel}\n` +
                (finalCaption && uploadRes.type !== 'audio' ? `• *Caption:* ${finalCaption}\n` : '') +
                `• *Recipients:* ${uploadRes.recipientCount} contact(s)\n\n` +
                `👑 _${OWNER_NAME} • ${TINY_CAPTION}_`
        }, { quoted: message });

        return true;
    } catch (err) {
        console.error('[statusService] Command upload error:', err.message);
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
    convertToOpusVoiceNote
};
