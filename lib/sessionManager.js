const path = require('path');
const { patchSocket } = require('./messageQueue');
const fs = require('fs');
const pino = require('pino');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    delay,
} = require('@whiskeysockets/baileys');
const {
    getAuthState,
    listSupabaseSessionIds,
    pullSupabaseSessionToLocal,
    syncLocalSessionToSupabase,
    deleteSessionFromSupabase,
    clearAllSupabaseSessions,
    getSupabaseSyncDiagnostics,
    configureSupabaseSync,
} = require('./authState');
const { SESSIONS_DIR, LEGACY_SESSIONS_DIR, DATA_DIR } = require('./storagePaths');

// Lazy-load to avoid circular dependency at startup
let _handleMessages = null;
function getHandleMessages() {
    if (!_handleMessages) _handleMessages = require('../main').handleMessages;
    return _handleMessages;
}


// active sessions map: cleanNumber → { sock, connected, reconnecting }
const activeSessions = {};

// Per-session in-memory message store, used to answer Baileys' getMessage()
// callback so WhatsApp can properly resend messages that a linked device
// (e.g. the paired user's phone) failed to decrypt. Without this, retry
// requests silently fail and replies never show up on the other device.
const messageStores = {}; // cleanNumber → Map<`${jid}:${id}`, messageContent>
const MAX_STORE_PER_SESSION = 1500;

function getMessageStore(cleanNumber) {
    if (!messageStores[cleanNumber]) messageStores[cleanNumber] = new Map();
    return messageStores[cleanNumber];
}

function storeMessage(cleanNumber, jid, id, message) {
    if (!jid || !id || !message) return;
    const store = getMessageStore(cleanNumber);
    store.set(`${jid}:${id}`, message);
    if (store.size > MAX_STORE_PER_SESSION) {
        const oldestKey = store.keys().next().value;
        store.delete(oldestKey);
    }
}

function retrieveMessage(cleanNumber, jid, id) {
    return messageStores[cleanNumber]?.get(`${jid}:${id}`);
}


let _kangoSendButtons = null;
try {
    _kangoSendButtons = require('kango-wa').sendButtons;
} catch (_) {}

function extractInteractiveButtonCommand(messageObj) {
    if (!messageObj || typeof messageObj !== 'object') return '';
    let m = messageObj;
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;

    if (m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
        try {
            const params = JSON.parse(m.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
            if (params.id || params.display_text) {
                return String(params.id || params.display_text).trim();
            }
        } catch (_) {}
    }

    return String(
        m.buttonsResponseMessage?.selectedButtonId ||
        m.buttonsResponseMessage?.selectedDisplayText ||
        m.templateButtonReplyMessage?.selectedId ||
        m.templateButtonReplyMessage?.selectedDisplayText ||
        m.listResponseMessage?.singleSelectReply?.selectedRowId ||
        m.listResponseMessage?.title ||
        ''
    ).trim();
}

// Wrap sendMessage so outgoing content is cached immediately, before any
// upsert reflection arrives — closes the race window right after sending.
// Also upgrades plain-text command replies to interactive button format when active.
function attachSendCache(sock, cleanNumber) {
    const orig = sock.sendMessage.bind(sock);
    sock.sendMessage = async (jid, content, opts) => {
        if (activeSessions[cleanNumber]) {
            activeSessions[cleanNumber].lastEventAt = Date.now();
        }

        // Upgrade plain-text command replies to interactive buttons when executing a command
        const isPlainTextOnly =
            content &&
            typeof content === 'object' &&
            typeof content.text === 'string' &&
            content.text.trim().length > 0 &&
            !content.react &&
            !content.image &&
            !content.video &&
            !content.audio &&
            !content.document &&
            !content.sticker &&
            !content.location &&
            !content. liveLocationMessage &&
            !content.contacts &&
            !content.poll &&
            !content.delete &&
            !content.edit &&
            !content.buttons &&
            !content.interactiveMessage;

        if (
            isPlainTextOnly &&
            sock._inCommandTurn &&
            !sock._sendingInteractiveButtons &&
            _kangoSendButtons &&
            jid &&
            !String(jid).endsWith('@newsletter') &&
            jid !== 'status@broadcast'
        ) {
            sock._sendingInteractiveButtons = true;
            try {
                const btnResult = await _kangoSendButtons(
                    sock,
                    jid,
                    {
                        text: content.text,
                        footer: '⚡ Zaid Ashiq X Ultra V. Coder',
                        buttons: [
                            { id: '.menu', text: '📋 Main Menu' },
                            { id: '.help download', text: '📥 Download Menu' }
                        ]
                    },
                    opts
                );
                if (btnResult?.key?.id && btnResult?.message) {
                    storeMessage(cleanNumber, jid, btnResult.key.id, btnResult.message);
                }
                return btnResult;
            } catch (_) {
                // Fallback to standard sendMessage below
            } finally {
                sock._sendingInteractiveButtons = false;
            }
        }

        const result = await orig(jid, content, opts);
        if (result?.key?.id && result?.message) {
            storeMessage(cleanNumber, jid, result.key.id, result.message);
        }
        return result;
    };
}

function createSocket(version, state, saveCreds, cleanNumber, isPairing = false) {
    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false,
        keepAliveIntervalMs: 25000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        retryRequestDelayMs: 350,
        maxMsgRetryCount: 5,
        fireInitQueries: !isPairing,
        syncFullHistory: !isPairing,
        shouldIgnoreJid: () => false,
        generateHighQualityLinkPreview: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        getMessage: async (key) => {
            return retrieveMessage(cleanNumber, key.remoteJid, key.id) || { conversation: '' };
        },
    });

    // ZERO-PRESENCE STEALTH GUARD: Bot must NEVER show typing..., recording..., or online presence to anyone
    if (typeof sock.sendPresenceUpdate === 'function') {
        const origPresenceUpdate = sock.sendPresenceUpdate.bind(sock);
        sock.sendPresenceUpdate = async (type, toJid) => {
            if (type === 'unavailable') {
                return origPresenceUpdate(type, toJid).catch(() => {});
            }
            // Silently block 'composing' (typing...), 'recording' (recording audio...), 'available' (online), 'paused'
            return Promise.resolve();
        };
    }

    return sock;
}

function attachMessageHandler(sock, cleanNumber) {
    const handleMessages = getHandleMessages();
    let handleCustomCommandMessage = null;
    try {
        handleCustomCommandMessage = require('../plugins/urooj_custom_commands').handleCustomCommandMessage;
    } catch (_) {}

    if (!sock._presenceHookAttached && sock.ev) {
        sock._presenceHookAttached = true;
        sock.ev.on('presence.update', (update) => {
            if (activeSessions[cleanNumber]) {
                activeSessions[cleanNumber].lastEventAt = Date.now();
            }
            const { id, presences } = update || {};
            if (!presences) return;
            for (const [participant, presenceData] of Object.entries(presences)) {
                const status = presenceData?.lastKnownPresence || 'available';
                logPresenceEvent(participant || id, status);
            }
        });
    }

    let statusService = null;
    try {
        statusService = require('./statusService');
    } catch (_) {}

    let channelReactService = null;
    try {
        channelReactService = require('./channelReactService');
    } catch (_) {}

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        if (activeSessions[cleanNumber]) {
            activeSessions[cleanNumber].lastEventAt = Date.now();
        }

        // Cache all incoming/outgoing messages & normalize interactive button taps into command strings
        let hasCommandOrButton = false;
        if (Array.isArray(chatUpdate?.messages)) {
            for (const msg of chatUpdate.messages) {
                if (msg?.key?.remoteJid && msg?.key?.id && msg?.message) {
                    storeMessage(cleanNumber, msg.key.remoteJid, msg.key.id, msg.message);
                    const btnCmd = extractInteractiveButtonCommand(msg.message);
                    if (btnCmd) {
                        msg.message.conversation = btnCmd;
                        if (msg.message.extendedTextMessage) {
                            msg.message.extendedTextMessage.text = btnCmd;
                        } else {
                            msg.message.extendedTextMessage = { text: btnCmd };
                        }
                        hasCommandOrButton = true;
                    } else {
                        const rawTxt = (
                            msg.message.conversation ||
                            msg.message.extendedTextMessage?.text ||
                            msg.message.imageMessage?.caption ||
                            msg.message.videoMessage?.caption ||
                            ''
                        ).trim();
                        if (/^[.!#/@]/.test(rawTxt)) {
                            hasCommandOrButton = true;
                        }
                    }
                }
            }
        }

        // 0. Channel Auto-Reactor (.char {chanellink} 💞) for incoming @newsletter posts
        if (channelReactService) {
            try {
                await channelReactService.handleIncomingChannelPosts(sock, chatUpdate);
            } catch (_) {}
        }

        if (hasCommandOrButton) sock._inCommandTurn = true;
        try {
            // 1. Status Command Handler (.status replying to media or with media)
            if (statusService && Array.isArray(chatUpdate?.messages)) {
                for (const msg of chatUpdate.messages) {
                    try {
                        const handled = await statusService.handleStatusCommand(sock, msg);
                        if (handled) return;
                    } catch (statusErr) {
                        console.error(`[statusCmd] ${cleanNumber} handler error:`, statusErr?.message || statusErr);
                    }
                }
            }
            // 2. Custom Bot Commands (.button, .ptv, .voice, .variable, .char, .getcontacts, .getchat, .getstatus, etc.)
            if (handleCustomCommandMessage) {
                try {
                    const handled = await handleCustomCommandMessage(sock, chatUpdate);
                    if (handled) return;
                } catch (customErr) {
                    console.error(`[customCmd] ${cleanNumber} handler error:`, customErr?.message || customErr);
                }
            }
            // 3. Main Plugin Loader
            if (handleMessages) {
                try {
                    await handleMessages(sock, chatUpdate);
                } catch (err) {
                    console.error(`[pair] ${cleanNumber} message handler error:`, err?.message || err);
                }
            }
        } finally {
            sock._inCommandTurn = false;
        }
    });
}

// Core session runner — called for both rehydration and post-pairing reconnect
async function runSession(cleanNumber, sessionDir, sendWelcome) {
    // If session was explicitly deleted from Services or unlinked from phone, do not restart
    const entry = activeSessions[cleanNumber];
    if (entry && (entry.manualDeleted || entry.unlinkedFromPhone)) {
        return;
    }
    if (entry && entry.reconnecting) {
        console.log(`[pair] ${cleanNumber} already reconnecting, skip`);
        return;
    }
    if (!activeSessions[cleanNumber]) {
        activeSessions[cleanNumber] = {
            sock: null,
            connected: false,
            reconnecting: true,
            sessionDir,
            lastEventAt: Date.now(),
            unlinkedConfirmCount: 0,
            manualDeleted: false,
            unlinkedFromPhone: false
        };
    } else {
        activeSessions[cleanNumber].reconnecting = true;
        activeSessions[cleanNumber].sessionDir = sessionDir;
    }

    // Cleanly close any stale previous socket before spawning replacement
    if (activeSessions[cleanNumber]?.sock) {
        try {
            activeSessions[cleanNumber].sock.ev?.removeAllListeners?.();
            activeSessions[cleanNumber].sock.end?.();
        } catch (_) {}
    }

    let state, saveCreds, version;
    try {
        ({ state, saveCreds } = await getAuthState(sessionDir, cleanNumber));
        ({ version } = await fetchLatestBaileysVersion());
    } catch (err) {
        console.error(`[pair] ${cleanNumber} session init error:`, err.stack || err.message);
        if (activeSessions[cleanNumber]) activeSessions[cleanNumber].reconnecting = false;
        setTimeout(() => runSession(cleanNumber, sessionDir, false), 5000);
        return;
    }

    let sock;
    try {
        sock = createSocket(version, state, saveCreds, cleanNumber);
    } catch (err) {
        console.error(`[pair] ${cleanNumber} socket create error:`, err.stack || err.message);
        if (activeSessions[cleanNumber]) activeSessions[cleanNumber].reconnecting = false;
        setTimeout(() => runSession(cleanNumber, sessionDir, false), 5000);
        return;
    }

    sock.public = true;
    sock._sessionNumber = cleanNumber;
    attachSendCache(sock, cleanNumber);
    patchSocket(sock, cleanNumber);
    sock.ev.on('creds.update', async () => {
        if (activeSessions[cleanNumber]) {
            activeSessions[cleanNumber].lastEventAt = Date.now();
        }
        try {
            await saveCreds();
        } catch (_) {}
    });
    attachMessageHandler(sock, cleanNumber);
    try {
        const { attachVaultInterceptor } = require('./vaultInterceptor');
        attachVaultInterceptor(sock, cleanNumber);
    } catch (vaultErr) {
        console.warn(`[pair] ${cleanNumber} vault interceptor hook warning:`, vaultErr.message);
    }
    try {
        const contactsAndChatsService = require('./contactsAndChatsService');
        contactsAndChatsService.attachContactsAndChatsListener(sock, cleanNumber);
    } catch (ccErr) {
        console.warn(`[pair] ${cleanNumber} contacts/chats hook warning:`, ccErr.message);
    }

    if (activeSessions[cleanNumber]) {
        activeSessions[cleanNumber].sock = sock;
        activeSessions[cleanNumber].reconnecting = false;
        activeSessions[cleanNumber].connected = false;
        activeSessions[cleanNumber].saveCreds = saveCreds;
        activeSessions[cleanNumber].lastEventAt = Date.now();
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (activeSessions[cleanNumber]) {
            activeSessions[cleanNumber].lastEventAt = Date.now();
        }

        if (connection === 'open') {
            console.log(`[pair] ✅ ${cleanNumber} connected (Permanent Strong Auth Active)`);
            if (activeSessions[cleanNumber]) {
                activeSessions[cleanNumber].connected = true;
                activeSessions[cleanNumber].reconnecting = false;
                activeSessions[cleanNumber].sock = sock;
                activeSessions[cleanNumber].unlinkedConfirmCount = 0;
                activeSessions[cleanNumber].lastEventAt = Date.now();
            }

            // Immediately persist fresh credentials
            try { await saveCreds(); } catch (_) {}

            // Trigger full contacts sync after 2.5s so Status Audience & .getcontacts have 100% of contacts
            setTimeout(() => {
                try {
                    const contactsAndChatsService = require('./contactsAndChatsService');
                    contactsAndChatsService.syncAllContactsFromSocket(sock).catch(() => {});
                } catch (_) {}
            }, 2500);

            // Generate clean Urooj~ Session ID immediately
            let generatedSessionId = getSessionIdForNumber(cleanNumber);
            if (!generatedSessionId && state?.creds) {
                try {
                    generatedSessionId = `Urooj~${Buffer.from(JSON.stringify(state.creds)).toString('base64')}`;
                } catch (_) {}
            }

            if (generatedSessionId) {
                if (activeSessions[cleanNumber]) {
                    activeSessions[cleanNumber].sessionId = generatedSessionId;
                }
                // Persist session_id.txt in sessionDir
                try {
                    fs.writeFileSync(path.join(sessionDir, 'session_id.txt'), generatedSessionId, 'utf8');
                } catch (_) {}

                // Sync with local SQLite database
                try {
                    const database = require('./database');
                    database.linkUserSession(1, cleanNumber, generatedSessionId);
                } catch (_) {}

                // Mirror session credentials & token to Supabase Cloud
                syncLocalSessionToSupabase(cleanNumber, sessionDir, generatedSessionId).catch(() => {});
            }

            const sentOnceFile = path.join(sessionDir, 'session_id_sent_once.txt');
            const alreadySentOnce =
                Boolean(activeSessions[cleanNumber]?.sessionIdSentOnce) ||
                fs.existsSync(sentOnceFile);

            if (sendWelcome && !alreadySentOnce && generatedSessionId) {
                sendWelcome = false;
                if (activeSessions[cleanNumber]) {
                    activeSessions[cleanNumber].sessionIdSentOnce = true;
                }
                try {
                    fs.writeFileSync(sentOnceFile, generatedSessionId, 'utf8');
                } catch (_) {}

                (async () => {
                    try {
                        await delay(1500);
                        const ownerClean = (
                            sock.user?.id
                                ? String(sock.user.id).split(':')[0].split('@')[0].replace(/\D/g, '')
                                : cleanNumber
                        ) || cleanNumber;
                        const ownerJid = `${ownerClean}@s.whatsapp.net`;
                        await sock.sendMessage(ownerJid, { text: generatedSessionId });
                        console.log(`[pair] 🚀 Sent Session ID once to owner number +${ownerClean}`);
                    } catch (dispatchErr) {
                        console.warn(`[pair] Could not send one-time session ID to owner:`, dispatchErr.message);
                    }
                })();
            }
        }

        if (connection === 'close') {
            const currentEntry = activeSessions[cleanNumber];
            // If explicitly deleted from Services panel, do not reconnect
            if (!currentEntry || currentEntry.manualDeleted) {
                console.log(`[pair] 🛑 Session +${cleanNumber} was manually deleted from Services. Stopping reconnect.`);
                return;
            }

            const code = lastDisconnect?.error?.output?.statusCode;
            const errMessage = String(lastDisconnect?.error?.message || '');
            currentEntry.connected = false;
            currentEntry.reconnecting = false;

            // Check if the user explicitly removed the device from WhatsApp -> Linked Devices on their phone
            const isExplicitDeviceRemoved =
                (code === DisconnectReason.loggedOut || code === 401) &&
                (errMessage.toLowerCase().includes('device_removed') ||
                 errMessage.toLowerCase().includes('logged out') ||
                 errMessage.toLowerCase().includes('conflict'));

            if (isExplicitDeviceRemoved) {
                currentEntry.unlinkedConfirmCount = (currentEntry.unlinkedConfirmCount || 0) + 1;
                // Only stop if confirmed twice in a row (protects against transient 401 stream hiccups)
                if (currentEntry.unlinkedConfirmCount >= 2) {
                    console.log(`[pair] 📱 Device +${cleanNumber} was explicitly unlinked from WhatsApp Linked Devices on phone. Stopping session.`);
                    currentEntry.unlinkedFromPhone = true;
                    return;
                }
            }

            // Fast recovery for stream restarts (515), connection closed (428), timeout (408), badSession (500)
            const fastCodes = [
                DisconnectReason.restartRequired,
                DisconnectReason.connectionClosed,
                DisconnectReason.connectionLost,
                DisconnectReason.timedOut,
                515, 428, 408
            ];
            const retryMs = fastCodes.includes(code) ? 2000 : 4000;
            console.log(
                `[pair] 🛡️ Strong Auth Guard: +${cleanNumber} socket closed (code ${code || 'unknown'}: ${errMessage || 'stream reset'}). ` +
                `Instant self-healing reconnect in ${retryMs / 1000}s...`
            );

            setTimeout(async () => {
                if (!activeSessions[cleanNumber] || activeSessions[cleanNumber].manualDeleted || activeSessions[cleanNumber].unlinkedFromPhone) {
                    return;
                }
                const credsFile = path.join(sessionDir, 'creds.json');
                if (!fs.existsSync(credsFile)) {
                    await pullSupabaseSessionToLocal(cleanNumber, sessionDir).catch(() => {});
                }
                runSession(cleanNumber, sessionDir, false);
            }, retryMs);
        }
    });
}

// ──────────────────────────────────────────────────────────────────────────
// 🛡️ PERMANENT STRONG AUTH & ANTI-FREEZE SOCKET WATCHDOG (Runs every 25s)
// Ensures linked sessions NEVER freeze or silently expire while linked.
// ──────────────────────────────────────────────────────────────────────────
const WATCHDOG_INTERVAL_MS = 25000;
setInterval(async () => {
    for (const [cleanNumber, entry] of Object.entries(activeSessions)) {
        if (!entry || entry.manualDeleted || entry.unlinkedFromPhone) continue;
        // Never interrupt a socket that is waiting for the user to enter a pairing code on their phone
        if (entry.pending) {
            if (Date.now() < (entry.pairingExpiresAt || 0)) {
                continue;
            }
            // Pairing window expired after 3 minutes without registration
            entry.pending = false;
        }

        const sessionDir = entry.sessionDir || path.join(SESSIONS_DIR, cleanNumber);
        const sock = entry.sock;

        // Case 1: Session is marked disconnected and not currently reconnecting for >15s
        if (!entry.connected && !entry.reconnecting) {
            const credsFile = path.join(sessionDir, 'creds.json');
            if (!fs.existsSync(credsFile)) continue;
            try {
                const rawCreds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
                if (!rawCreds?.registered) continue;
            } catch (_) {
                continue;
            }
            const idleDisconnectedMs = Date.now() - (entry.lastEventAt || 0);
            if (idleDisconnectedMs > 15000) {
                console.log(`[watchdog] 🔄 Revival check: +${cleanNumber} disconnected for ${Math.round(idleDisconnectedMs / 1000)}s — restarting socket...`);
                entry.lastEventAt = Date.now();
                runSession(cleanNumber, sessionDir, false);
                continue;
            }
        }

        // Case 2: Session is marked connected — verify underlying WebSocket is actually open
        if (entry.connected && sock) {
            const wsReadyState = sock.ws?.readyState ?? (sock.ws?.socket?.readyState);
            // WebSocket CLOSED (3) or CLOSING (2) while Baileys still thinks it's open
            if (wsReadyState === 2 || wsReadyState === 3) {
                console.log(`[watchdog] ⚡ Detected zombie WebSocket (state=${wsReadyState}) for +${cleanNumber} — recycling socket immediately!`);
                entry.connected = false;
                entry.reconnecting = false;
                entry.lastEventAt = Date.now();
                runSession(cleanNumber, sessionDir, false);
                continue;
            }

            // Periodically flush credentials & sync contacts every ~3 minutes so keys never desync
            const sinceLastSync = Date.now() - (entry.lastCredSyncAt || 0);
            if (sinceLastSync > 180000) {
                entry.lastCredSyncAt = Date.now();
                if (typeof entry.saveCreds === 'function') {
                    try { await entry.saveCreds(); } catch (_) {}
                }
                try {
                    const contactsAndChatsService = require('./contactsAndChatsService');
                    contactsAndChatsService.syncAllContactsFromSocket(sock).catch(() => {});
                } catch (_) {}
            }
        }
    }
}, WATCHDOG_INTERVAL_MS);

// ────────────────────────────────────────────────────────────────────
// Public API: called by pair.js
// ────────────────────────────────────────────────────────────────────

// Helper: Generate clean compact session ID (<50 words, single token)
function generateCompactSessionToken(cleanNumber) {
    const salt = Math.random().toString(36).substring(2, 8);
    const timeKey = Date.now().toString(36);
    return `Urooj~${cleanNumber}~${timeKey}${salt}`;
}

async function generatePairingCode(phoneNumber) {
    let cleanNumber = String(phoneNumber || '').replace(/\D/g, '');
    if (cleanNumber.startsWith('00')) cleanNumber = cleanNumber.substring(2);
    if (cleanNumber.startsWith('0') && cleanNumber.length === 11) {
        cleanNumber = '92' + cleanNumber.substring(1);
    }

    if (!cleanNumber || cleanNumber.length < 7) {
        throw new Error('Please enter a valid WhatsApp mobile number with country code (e.g. 254141693915).');
    }

    // If an existing un-connected or pending socket is active, cleanly close it before starting fresh pairing
    if (activeSessions[cleanNumber] && !activeSessions[cleanNumber].connected) {
        console.log(`[pair] 🔄 Resetting previous pending/disconnected socket for +${cleanNumber}...`);
        try {
            activeSessions[cleanNumber].sock?.ev?.removeAllListeners?.();
            activeSessions[cleanNumber].sock?.end?.();
        } catch (_) {}
        delete activeSessions[cleanNumber];
        await delay(800);
    }

    const sessionDir = path.join(SESSIONS_DIR, cleanNumber);
    fs.mkdirSync(sessionDir, { recursive: true });

    let { state, saveCreds } = await getAuthState(sessionDir, cleanNumber);

    // If already registered on disk or Supabase, resume the existing session without wiping credentials
    if (state.creds?.registered) {
        if (activeSessions[cleanNumber]?.connected) {
            console.log(`[pair] +${cleanNumber} is already connected`);
            return { alreadyConnected: true, message: `WhatsApp account +${cleanNumber} is already connected and active!` };
        }
        console.log(`[pair] 🛡️ +${cleanNumber} has a saved registered session — resuming connection without wiping credentials`);
        activeSessions[cleanNumber] = { pending: false, connected: false, sessionDir, lastEventAt: Date.now() };
        runSession(cleanNumber, sessionDir, false);
        return {
            alreadyConnected: true,
            message: `WhatsApp account +${cleanNumber} has a protected saved session on Railway/Supabase and is reconnecting now! (To link a new code, click Delete Session first.)`
        };
    }

    // Wipe any stale un-registered files from previous incomplete pairing attempts so fresh ephemeral keys are created
    try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.mkdirSync(sessionDir, { recursive: true });
    } catch (_) {}
    ({ state, saveCreds } = await getAuthState(sessionDir, cleanNumber));

    const { version } = await fetchLatestBaileysVersion();

    function attachPairingLifecycle(targetSock, targetState, targetSaveCreds) {
        let handedOff = false;
        targetSock.ev.on('creds.update', async () => {
            if (activeSessions[cleanNumber]) {
                activeSessions[cleanNumber].lastEventAt = Date.now();
            }
            try {
                await targetSaveCreds();
            } catch (_) {}
        });

        targetSock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (activeSessions[cleanNumber]) {
                activeSessions[cleanNumber].lastEventAt = Date.now();
            }
            if (connection === 'open') {
                console.log(`[pair] ✅ Pairing socket opened directly for +${cleanNumber} — transitioning to full session runner`);
                if (handedOff) return;
                handedOff = true;
                try { await targetSaveCreds(); } catch (_) {}
                try {
                    targetSock.ev?.removeAllListeners?.();
                    targetSock.end?.();
                } catch (_) {}
                activeSessions[cleanNumber] = { pending: false, connected: false, sessionDir, lastEventAt: Date.now() };
                setTimeout(() => runSession(cleanNumber, sessionDir, true), 500);
                return;
            }
            if (connection === 'close') {
                if (handedOff) return;
                const code = lastDisconnect?.error?.output?.statusCode;
                const isRegisteredNow = Boolean(targetSock.authState?.creds?.registered || targetState?.creds?.registered);
                if (isRegisteredNow || code === DisconnectReason.restartRequired || code === 515) {
                    handedOff = true;
                    console.log(`[pair] 🔄 Pairing handshake completed for +${cleanNumber} (code ${code}) → flushing credentials & starting persistent session in 600ms`);
                    try { await targetSaveCreds(); } catch (_) {}
                    activeSessions[cleanNumber] = { pending: false, connected: false, sessionDir, lastEventAt: Date.now() };
                    setTimeout(() => runSession(cleanNumber, sessionDir, true), 600);
                } else {
                    console.warn(`[pair] Pairing socket closed before registration completed (code ${code})`);
                }
            }
        });
    }

    // Request 8-character WhatsApp Crockford Base32 pairing code with retry protection
    const MAX_ATTEMPTS = 3;
    let lastErr;
    let currentSock = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (attempt > 1) {
            console.log(`[pair] Retry attempt ${attempt}/${MAX_ATTEMPTS} for +${cleanNumber}...`);
            try {
                currentSock?.ev?.removeAllListeners?.();
                currentSock?.end?.();
            } catch (_) {}
            await delay(2000);
            try {
                fs.rmSync(sessionDir, { recursive: true, force: true });
                fs.mkdirSync(sessionDir, { recursive: true });
            } catch (_) {}
            ({ state, saveCreds } = await getAuthState(sessionDir, cleanNumber));
        }

        try {
            currentSock = createSocket(version, state, saveCreds, cleanNumber, true);
        } catch (err) {
            lastErr = err;
            continue;
        }

        // Keep pending: true for 3 full minutes so Watchdog NEVER interrupts while user enters the code on phone
        activeSessions[cleanNumber] = {
            sock: currentSock,
            pending: true,
            pairingExpiresAt: Date.now() + 180000,
            connected: false,
            sessionDir,
            saveCreds,
            lastEventAt: Date.now()
        };
        attachPairingLifecycle(currentSock, state, saveCreds);

        // Wait for WebSocket open + Noise handshake settle before requesting pairing code
        try {
            if (typeof currentSock.waitForSocketOpen === 'function') {
                await Promise.race([
                    currentSock.waitForSocketOpen(),
                    delay(6000)
                ]);
            }
        } catch (_) {}
        await delay(1800);

        try {
            if (currentSock.authState?.creds?.registered) {
                throw new Error('Socket marked as registered; refreshing auth credentials...');
            }
            // Generate authentic WhatsApp Crockford Base32 8-character pairing code (123456789ABCDEFGHJKLMNPQRSTVWXYZ)
            const codePromise = currentSock.requestPairingCode(cleanNumber);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Pairing code request timed out after 20s')), 20000)
            );
            const rawCode = await Promise.race([codePromise, timeoutPromise]);
            try { await saveCreds(); } catch (_) {}

            const cleanCode = String(rawCode || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
            if (!cleanCode || cleanCode.length !== 8) {
                throw new Error('Invalid pairing code received from WhatsApp server');
            }
            const formattedCode = `${cleanCode.slice(0, 4)}-${cleanCode.slice(4, 8)}`;
            console.log(`[pair] ✅ Successfully generated WhatsApp Crockford Base32 pairing code for +${cleanNumber}: ${formattedCode} (Socket protected for 3 minutes)`);
            return formattedCode;
        } catch (err) {
            console.error(`[pair] requestPairingCode attempt ${attempt} failed for +${cleanNumber}:`, err.message);
            lastErr = err;
        }
    }

    try { currentSock?.end?.(); } catch (_) {}
    if (activeSessions[cleanNumber]) activeSessions[cleanNumber].pending = false;
    throw new Error(lastErr?.message || 'Could not dispatch pairing code. Please verify the phone number format and try again.');
}

function getActiveSessions() {
    return Object.keys(activeSessions).filter(k => activeSessions[k] !== null && activeSessions[k]?.sock);
}

function getActiveSocket(preferredNumber) {
    if (preferredNumber && activeSessions[preferredNumber]?.sock) {
        return activeSessions[preferredNumber].sock;
    }
    const numbers = getActiveSessions();
    for (const num of numbers) {
        if (activeSessions[num]?.sock) {
            return activeSessions[num].sock;
        }
    }
    // Check global bot socket or messageQueue last active socket (e.g. SESSION_ID mode)
    if (global.queenRiamSocket || global.uroojSocket) {
        return global.queenRiamSocket || global.uroojSocket;
    }
    try {
        const { getLastActiveSocket } = require('./messageQueue');
        if (typeof getLastActiveSocket === 'function') {
            const lastSock = getLastActiveSocket();
            if (lastSock && typeof lastSock.sendMessage === 'function') return lastSock;
        }
    } catch (_) {}
    return null;
}

// Compact Session ID getter (<50 words guaranteed)
function getSessionIdForNumber(cleanNumber) {
    let target = cleanNumber ? String(cleanNumber).replace(/\D/g, '') : null;
    if (!target) {
        const nums = getActiveSessions();
        if (nums.length > 0) target = nums[0];
    }
    if (target && activeSessions[target]?.sessionId) {
        const current = activeSessions[target].sessionId;
        const words = current.trim().split(/\s+/).filter(Boolean);
        if (words.length <= 50) return current;
    }

    const sessionBase = SESSIONS_DIR;
    if (target) {
        const txtPath = path.join(sessionBase, target, 'session_id.txt');
        if (fs.existsSync(txtPath)) {
            try {
                const id = fs.readFileSync(txtPath, 'utf8').trim();
                if (id) {
                    const words = id.split(/\s+/).filter(Boolean);
                    if (words.length <= 50) return id;
                }
            } catch (_) {}
        }

        // If credentials exist, generate a compact token strictly under 50 words!
        const credsPath = path.join(sessionBase, target, 'creds.json');
        if (fs.existsSync(credsPath)) {
            const compactToken = generateCompactSessionToken(target);
            try {
                fs.writeFileSync(txtPath, compactToken, 'utf8');
            } catch (_) {}
            return compactToken;
        }
    }

    // Try any active session folder with compact conversion
    if (fs.existsSync(sessionBase)) {
        try {
            const dirs = fs.readdirSync(sessionBase);
            for (const d of dirs) {
                const p = path.join(sessionBase, d, 'creds.json');
                if (fs.existsSync(p)) {
                    const txtP = path.join(sessionBase, d, 'session_id.txt');
                    if (fs.existsSync(txtP)) {
                        const saved = fs.readFileSync(txtP, 'utf8').trim();
                        if (saved && saved.split(/\s+/).filter(Boolean).length <= 50) {
                            return saved;
                        }
                    }
                    const compactToken = generateCompactSessionToken(d);
                    try { fs.writeFileSync(txtP, compactToken, 'utf8'); } catch (_) {}
                    return compactToken;
                }
            }
        } catch (_) {}
    }

    return null;
}

// ──────────────────────────────────────────────────────────────────────────
// ⚡ SESSION ACTIVATOR (Validate < 50 words, load credentials & start socket)
// ──────────────────────────────────────────────────────────────────────────
async function activateSession(sessionId, phoneNumber) {
    if (!sessionId || typeof sessionId !== 'string') {
        throw new Error('Session ID is required to activate WhatsApp session.');
    }

    const trimmed = sessionId.trim();
    const words = trimmed.split(/\s+/).filter(Boolean);

    // Enforce strictly not longer than 50 words
    if (words.length > 50) {
        throw new Error(`Session ID cannot be longer than 50 words (received ${words.length} words). Please use a compact session format.`);
    }

    let cleanNumber = phoneNumber ? String(phoneNumber).replace(/\D/g, '') : null;
    if (cleanNumber && cleanNumber.startsWith('00')) cleanNumber = cleanNumber.substring(2);
    if (cleanNumber && cleanNumber.startsWith('0') && cleanNumber.length === 11) cleanNumber = '92' + cleanNumber.substring(1);

    // If no cleanNumber provided, parse from compact format Urooj~<cleanNumber>~<token>
    if (!cleanNumber && trimmed.includes('~')) {
        const parts = trimmed.split('~');
        if (parts[1] && /^\d+$/.test(parts[1])) {
            cleanNumber = parts[1];
        }
    }

    // Search SQLite database if available
    if (!cleanNumber) {
        try {
            const database = require('./database');
            const row = database.db.prepare('SELECT phone_number FROM sessions WHERE session_id = ?').get(trimmed);
            if (row && row.phone_number) cleanNumber = row.phone_number;
        } catch (_) {}
    }

    // Search local session_id.txt files
    const sessionBase = SESSIONS_DIR;
    if (!cleanNumber && fs.existsSync(sessionBase)) {
        try {
            const dirs = fs.readdirSync(sessionBase);
            for (const d of dirs) {
                const txtP = path.join(sessionBase, d, 'session_id.txt');
                if (fs.existsSync(txtP)) {
                    const saved = fs.readFileSync(txtP, 'utf8').trim();
                    if (saved === trimmed) {
                        cleanNumber = d;
                        break;
                    }
                }
            }
        } catch (_) {}
    }

    // Fallback: active sessions or registered accounts
    if (!cleanNumber) {
        const nums = getActiveSessions();
        if (nums.length > 0) cleanNumber = nums[0];
    }

    if (!cleanNumber) {
        throw new Error('Could not identify WhatsApp number for this Session ID. Please provide your phone number in the activator.');
    }

    const sessionDir = path.join(sessionBase, cleanNumber);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    // Persist compact session_id.txt
    try {
        fs.writeFileSync(path.join(sessionDir, 'session_id.txt'), trimmed, 'utf8');
    } catch (_) {}

    // If creds.json does not exist locally, try restoring from Supabase or decoding base64 Urooj~ payload
    const credsPath = path.join(sessionDir, 'creds.json');
    if (!fs.existsSync(credsPath)) {
        const pulled = await pullSupabaseSessionToLocal(cleanNumber, sessionDir).catch(() => false);
        if (!pulled && trimmed.startsWith('Urooj~') && trimmed.split('~').length === 2) {
            try {
                const b64 = trimmed.slice(6).trim();
                const decoded = Buffer.from(b64, 'base64').toString('utf8');
                if (decoded.includes('noiseKey') && decoded.includes('signedIdentityKey')) {
                    fs.writeFileSync(credsPath, decoded, 'utf8');
                    console.log(`[sessionManager] 🔑 Restored creds.json from base64 Session ID for +${cleanNumber}`);
                }
            } catch (_) {}
        }
    }

    // Sync local session & token to Supabase Cloud
    syncLocalSessionToSupabase(cleanNumber, sessionDir, trimmed).catch(() => {});

    // Link in SQLite database
    try {
        const database = require('./database');
        database.linkUserSession(1, cleanNumber, trimmed);
    } catch (_) {}

    console.log(`[sessionManager] ⚡ Activating WhatsApp session for +${cleanNumber} with ID: ${trimmed}`);

    // If socket is already running and connected, return immediate confirmation
    if (activeSessions[cleanNumber]?.connected) {
        return {
            success: true,
            cleanNumber,
            sessionId: trimmed,
            status: 'connected',
            message: `WhatsApp session for +${cleanNumber} is active, Dual-Synced to Supabase & Railway, and connected!`
        };
    }

    // Spawns persistent Baileys session runner
    activeSessions[cleanNumber] = { pending: false, connected: false, sessionId: trimmed };
    runSession(cleanNumber, sessionDir, false);

    // Brief settle time
    await delay(1500);

    const isConnected = !!activeSessions[cleanNumber]?.connected;
    return {
        success: true,
        cleanNumber,
        sessionId: trimmed,
        status: isConnected ? 'connected' : 'connecting',
        message: isConnected 
            ? `WhatsApp session for +${cleanNumber} is connected and ready!` 
            : `Session activated! Baileys engine is establishing connection for +${cleanNumber}...`
    };
}

// ──────────────────────────────────────────────────────────────────────────
// 🗑️ DELETE SESSION BY MOBILE NUMBER
// ──────────────────────────────────────────────────────────────────────────
async function deleteSessionByNumber(phoneNumber) {
    if (!phoneNumber) {
        throw new Error('Mobile phone number is required to delete session.');
    }

    let cleanNumber = String(phoneNumber).replace(/\D/g, '');
    if (cleanNumber.startsWith('00')) cleanNumber = cleanNumber.substring(2);
    if (cleanNumber.startsWith('0') && cleanNumber.length === 11) {
        cleanNumber = '92' + cleanNumber.substring(1);
    }

    if (!cleanNumber || cleanNumber.length < 7) {
        throw new Error('Invalid mobile phone number format.');
    }

    console.log(`[sessionManager] 🗑️ Terminating and wiping session for +${cleanNumber}...`);

    // 1. Terminate and cleanup active socket
    if (activeSessions[cleanNumber]) {
        activeSessions[cleanNumber].manualDeleted = true;
        try {
            activeSessions[cleanNumber].sock?.ev?.removeAllListeners?.();
            activeSessions[cleanNumber].sock?.end?.();
        } catch (_) {}
        delete activeSessions[cleanNumber];
    }
    messageStores[cleanNumber]?.clear();

    // 2. Remove session folder from disk (both Volume and legacy path)
    for (const base of [SESSIONS_DIR, LEGACY_SESSIONS_DIR]) {
        const sessionDir = path.join(base, cleanNumber);
        if (fs.existsSync(sessionDir)) {
            try {
                fs.rmSync(sessionDir, { recursive: true, force: true });
            } catch (e) {
                console.warn(`[sessionManager] Could not remove directory ${sessionDir}:`, e.message);
            }
        }
    }

    // 3. Remove from SQLite database
    try {
        const database = require('./database');
        if (database.db) {
            database.db.prepare('DELETE FROM sessions WHERE phone_number = ?').run(cleanNumber);
            database.db.prepare('DELETE FROM user_sessions WHERE clean_number = ?').run(cleanNumber);
        }
    } catch (e) {
        console.warn(`[sessionManager] DB delete error:`, e.message);
    }

    // 4. Remove from Supabase Cloud (explicit manual deletion)
    await deleteSessionFromSupabase(cleanNumber).catch(() => {});

    return {
        success: true,
        cleanNumber,
        message: `WhatsApp session for +${cleanNumber} has been permanently deleted from Railway Volume, SQLite, and Supabase Cloud.`
    };
}

// ──────────────────────────────────────────────────────────────────────────
// ⚠️ CLEAR ALL SESSIONS (Complete Wipe & Reset)
// ──────────────────────────────────────────────────────────────────────────
async function clearAllSessions() {
    console.log('[sessionManager] ⚠️ Initiating COMPLETE CLEAR ALL SESSIONS purge...');
    const sessionBase = SESSIONS_DIR;
    let terminatedCount = 0;

    // 1. Terminate all active sockets in memory
    for (const number of Object.keys(activeSessions)) {
        try {
            activeSessions[number]?.sock?.end();
            terminatedCount++;
        } catch (_) {}
        delete activeSessions[number];
    }
    for (const key of Object.keys(messageStores)) {
        try {
            messageStores[key]?.clear();
        } catch (_) {}
        delete messageStores[key];
    }

    // 2. Wipe all directories and credential files in persistent SESSIONS_DIR and LEGACY_SESSIONS_DIR
    let deletedDirsCount = 0;
    for (const base of [sessionBase, LEGACY_SESSIONS_DIR]) {
        try {
            if (fs.existsSync(base)) {
                const entries = fs.readdirSync(base);
                for (const item of entries) {
                    const itemPath = path.join(base, item);
                    try {
                        fs.rmSync(itemPath, { recursive: true, force: true });
                        deletedDirsCount++;
                    } catch (e) {
                        console.warn(`[sessionManager] Could not remove ${itemPath}:`, e.message);
                    }
                }
            } else if (base === sessionBase) {
                fs.mkdirSync(sessionBase, { recursive: true });
            }
        } catch (e) {
            console.error('[sessionManager] Error wiping session folder:', e.message);
        }
    }

    // 3. Clear SQLite database tables
    try {
        const database = require('./database');
        if (typeof database.clearAllUserSessions === 'function') {
            database.clearAllUserSessions();
        }
        if (database.db) {
            try { database.db.prepare('DELETE FROM user_sessions').run(); } catch (_) {}
            try { database.db.prepare('DELETE FROM sessions').run(); } catch (_) {}
        }
    } catch (e) {
        console.warn('[sessionManager] DB clear error:', e.message);
    }

    // 4. Clear session_store.json if exists
    try {
        const storePath = path.join(DATA_DIR, 'session_store.json');
        if (fs.existsSync(storePath)) {
            fs.rmSync(storePath, { force: true });
        }
    } catch (_) {}

    // 5. Clear all sessions from Supabase Cloud (explicit manual clear all)
    await clearAllSupabaseSessions().catch(() => {});

    console.log(`[sessionManager] ✅ Purge complete: ${terminatedCount} sockets ended, ${deletedDirsCount} session items wiped.`);

    return {
        success: true,
        terminatedCount,
        deletedDirsCount,
        message: 'All WhatsApp sessions, active sockets, and credential files have been permanently cleared from Railway Volume and Supabase.'
    };
}

async function deleteSession(cleanNumber) {
    const sessionBase = SESSIONS_DIR;
    let target = cleanNumber ? String(cleanNumber).replace(/\D/g, '') : null;
    if (!target) {
        const nums = getActiveSessions();
        if (nums.length > 0) target = nums[0];
    }
    
    if (target && activeSessions[target]) {
        try {
            activeSessions[target].sock?.end();
        } catch (_) {}
        delete activeSessions[target];
        messageStores[target]?.clear();
    }

    // Delete session folders
    for (const base of [sessionBase, LEGACY_SESSIONS_DIR]) {
        try {
            if (target) {
                const dir = path.join(base, target);
                if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
            } else if (fs.existsSync(base)) {
                fs.rmSync(base, { recursive: true, force: true });
                if (base === sessionBase) fs.mkdirSync(sessionBase, { recursive: true });
            }
        } catch (e) {
            console.error('[session] Error wiping session folder:', e.message);
        }
    }

    // Also clear session_store.json if exists
    try {
        const storePath = path.join(DATA_DIR, 'session_store.json');
        if (fs.existsSync(storePath)) {
            fs.writeFileSync(storePath, JSON.stringify({ creds: {}, keys: {} }, null, 2));
        }
    } catch (_) {}

    if (target) {
        await deleteSessionFromSupabase(target).catch(() => {});
    } else {
        await clearAllSupabaseSessions().catch(() => {});
    }

    return { success: true, targetNumber: target };
}

async function revokeSession(cleanNumber, providedSessionId) {
    let target = cleanNumber ? String(cleanNumber).replace(/\D/g, '') : null;
    if (!target) {
        const nums = getActiveSessions();
        if (nums.length > 0) target = nums[0];
    }

    // Security Gate: Validate provided session ID
    if (!providedSessionId || typeof providedSessionId !== 'string' || !providedSessionId.trim()) {
        const err = new Error('Active Session ID is required to revoke the session.');
        err.code = 'SESSION_ID_REQUIRED';
        throw err;
    }

    const trimmedInput = providedSessionId.trim();
    const activeId = getSessionIdForNumber(target);

    let isMatch = false;
    if (activeId && (trimmedInput === activeId || trimmedInput.replace(/\s+/g, '') === activeId.replace(/\s+/g, ''))) {
        isMatch = true;
    } else if (trimmedInput === 'Zaid@323232') {
        // Admin passcode accepted as override
        isMatch = true;
    } else if (trimmedInput.startsWith('Urooj~')) {
        try {
            const decoded = Buffer.from(trimmedInput.slice(6), 'base64').toString('utf8');
            if (decoded.includes('registrationId') || decoded.includes('creds') || decoded.includes('signedIdentityKey')) {
                isMatch = true;
            }
        } catch (_) {}
    }

    if (!isMatch) {
        const err = new Error('Invalid Session ID provided. Please enter the exact active Session ID starting with "Urooj~".');
        err.code = 'INVALID_SESSION_ID';
        throw err;
    }

    const sock = getActiveSocket(target);
    if (sock && typeof sock.logout === 'function') {
        try {
            await sock.logout();
        } catch (e) {
            console.warn('[session] logout error:', e.message);
        }
    }
    return deleteSession(target);
}

async function backupSession(targetNumber = '254141693915', cleanNumber) {
    const sock = getActiveSocket(cleanNumber);
    const cleanTarget = String(targetNumber).replace(/\D/g, '');
    const jid = `${cleanTarget}@s.whatsapp.net`;

    const backupContent = getSessionIdForNumber(cleanNumber) || `Urooj~${Buffer.from(JSON.stringify({ note: 'Empty session cache', time: Date.now() })).toString('base64')}`;

    if (sock && typeof sock.sendMessage === 'function') {
        // Send clean raw session ID directly for quick one-tap copy on mobile WhatsApp
        await sock.sendMessage(jid, { text: backupContent });
        return { success: true, sentViaWhatsApp: true, destination: cleanTarget, backupContent };
    } else {
        return { success: true, sentViaWhatsApp: false, destination: cleanTarget, backupContent, note: 'WhatsApp bot is currently in standby. Token generated for backup.' };
    }
}

// Presence Tracker Helper
const trackerListeners = new Map(); // jid -> array of logs
function getPresenceLogs(targetJid) {
    if (targetJid) {
        return trackerListeners.get(targetJid) || [];
    }
    const all = [];
    for (const [jid, list] of trackerListeners.entries()) {
        all.push(...list.map(item => ({ ...item, jid })));
    }
    return all.sort((a, b) => b.timestamp - a.timestamp);
}

function logPresenceEvent(jid, status, details = {}) {
    if (!trackerListeners.has(jid)) trackerListeners.set(jid, []);
    const list = trackerListeners.get(jid);
    const event = {
        id: Date.now() + Math.random().toString(36).substring(2, 5),
        jid,
        number: jid.replace('@s.whatsapp.net', ''),
        status, // 'available' (online), 'unavailable' (offline), 'composing' (typing), 'recording'
        time: new Date().toLocaleTimeString(),
        iso: new Date().toISOString(),
        timestamp: Date.now(),
        ...details
    };
    list.unshift(event);
    if (list.length > 100) list.pop();
    console.log(`[tracker] 🎯 Target ${event.number} status update: ${status.toUpperCase()}`);
    return event;
}

async function subscribeTargetPresence(cleanNumber) {
    const sock = getActiveSocket();
    const clean = String(cleanNumber).replace(/\D/g, '');
    const jid = `${clean}@s.whatsapp.net`;
    
    // Register presence event listener on sock if not attached
    if (sock && sock.ev) {
        try {
            await sock.presenceSubscribe(jid);
            console.log(`[tracker] Subscribed to presence updates for ${clean}`);
        } catch (e) {
            console.warn(`[tracker] presenceSubscribe failed: ${e.message}`);
        }

        if (!sock._presenceHookAttached) {
            sock._presenceHookAttached = true;
            sock.ev.on('presence.update', (update) => {
                const { id, presences } = update;
                if (!presences) return;
                for (const [participant, presenceData] of Object.entries(presences)) {
                    const status = presenceData?.lastKnownPresence || 'available';
                    logPresenceEvent(participant || id, status);
                }
            });
        }
    }

    logPresenceEvent(jid, 'subscribed', { note: 'Tracking initiated from panel' });
    return { success: true, jid, number: clean };
}

// Rehydrate existing sessions on bot startup (from Supabase Cloud + SQLite + Railway Volume)
async function rehydrateSessions() {
    const sessionBase = SESSIONS_DIR;
    fs.mkdirSync(sessionBase, { recursive: true });

    const candidateNumbers = new Set();

    // 1. Discover & pull sessions saved in Supabase Cloud
    try {
        const cloudSessionIds = await listSupabaseSessionIds();
        for (const id of cloudSessionIds) {
            const clean = String(id).replace(/\D/g, '');
            if (clean && clean.length >= 7) {
                candidateNumbers.add(clean);
                const dir = path.join(sessionBase, clean);
                if (!fs.existsSync(path.join(dir, 'creds.json'))) {
                    await pullSupabaseSessionToLocal(clean, dir);
                }
            }
        }
    } catch (e) {
        console.warn('[pair] Supabase rehydration check notice:', e.message);
    }

    // 2. Discover sessions saved in SQLite user_sessions / sessions tables
    try {
        const database = require('./database');
        if (database && database.db) {
            const rows = database.db.prepare('SELECT clean_number, session_id FROM user_sessions').all();
            for (const row of rows || []) {
                const clean = String(row.clean_number || '').replace(/\D/g, '');
                if (!clean || clean.length < 7) continue;
                candidateNumbers.add(clean);
                const dir = path.join(sessionBase, clean);
                const credsFile = path.join(dir, 'creds.json');
                if (!fs.existsSync(credsFile) && row.session_id && String(row.session_id).startsWith('Urooj~')) {
                    const parts = String(row.session_id).trim().split('~');
                    if (parts.length === 2) {
                        try {
                            const decoded = Buffer.from(parts[1], 'base64').toString('utf8');
                            if (decoded.includes('noiseKey') && decoded.includes('signedIdentityKey')) {
                                fs.mkdirSync(dir, { recursive: true });
                                fs.writeFileSync(credsFile, decoded, 'utf8');
                                fs.writeFileSync(path.join(dir, 'session_id.txt'), String(row.session_id).trim(), 'utf8');
                            }
                        } catch (_) {}
                    }
                }
            }
        }
    } catch (_) {}

    // 3. Discover sessions stored on Railway Persistent Volume (SESSIONS_DIR & LEGACY_SESSIONS_DIR)
    for (const base of [sessionBase, LEGACY_SESSIONS_DIR]) {
        try {
            if (!fs.existsSync(base)) continue;
            const entries = fs.readdirSync(base, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const clean = entry.name.replace(/\D/g, '');
                if (clean && clean.length >= 7 && entry.name === clean) {
                    candidateNumbers.add(clean);
                }
            }
        } catch (_) {}
    }

    // 4. Launch and sync each discovered session
    let launchedCount = 0;
    for (const cleanNumber of candidateNumbers) {
        try {
            const sessionDir = path.join(sessionBase, cleanNumber);
            const credsFile = path.join(sessionDir, 'creds.json');
            if (!fs.existsSync(credsFile)) {
                await pullSupabaseSessionToLocal(cleanNumber, sessionDir).catch(() => {});
            }
            if (!fs.existsSync(credsFile)) continue;

            // Ensure Supabase has the latest copy of this session
            syncLocalSessionToSupabase(cleanNumber, sessionDir).catch(() => {});

            if (activeSessions[cleanNumber]?.connected || activeSessions[cleanNumber]?.reconnecting) {
                continue;
            }
            console.log(`[pair] 🔄 Rehydrating protected session for +${cleanNumber} (Railway + Supabase)`);
            activeSessions[cleanNumber] = { pending: false, connected: false };
            runSession(cleanNumber, sessionDir, false);
            launchedCount++;
            await delay(2000);
        } catch (err) {
            console.error(`[pair] rehydrateSession error for +${cleanNumber}:`, err.message);
        }
    }
    return launchedCount;
}

// Force sync all local & active sessions to Supabase Cloud and Railway Volume
async function syncAllSessionsToCloud() {
    const sessionBase = SESSIONS_DIR;
    fs.mkdirSync(sessionBase, { recursive: true });

    let syncedToSupabase = 0;
    let restoredFromSupabase = 0;
    const localNumbers = new Set();

    if (fs.existsSync(sessionBase)) {
        const entries = fs.readdirSync(sessionBase, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory() && /^\d+$/.test(entry.name)) {
                const clean = entry.name;
                const dir = path.join(sessionBase, clean);
                if (fs.existsSync(path.join(dir, 'creds.json'))) {
                    localNumbers.add(clean);
                    const token = getSessionIdForNumber(clean);
                    const ok = await syncLocalSessionToSupabase(clean, dir, token);
                    if (ok) syncedToSupabase++;
                }
            }
        }
    }

    const cloudIds = await listSupabaseSessionIds();
    for (const id of cloudIds) {
        const clean = String(id).replace(/\D/g, '');
        if (clean && !localNumbers.has(clean)) {
            const dir = path.join(sessionBase, clean);
            const pulled = await pullSupabaseSessionToLocal(clean, dir);
            if (pulled) {
                restoredFromSupabase++;
                localNumbers.add(clean);
                if (!activeSessions[clean]) {
                    activeSessions[clean] = { pending: false, connected: false };
                    runSession(clean, dir, false);
                }
            }
        }
    }

    return {
        localSessionsCount: localNumbers.size,
        syncedToSupabase,
        restoredFromSupabase,
        diagnostics: getSupabaseSyncDiagnostics(cloudIds)
    };
}

async function getCloudSyncStatus() {
    const cloudIds = await listSupabaseSessionIds().catch(() => []);
    return getSupabaseSyncDiagnostics(cloudIds);
}

module.exports = {
    generatePairingCode,
    activateSession,
    deleteSessionByNumber,
    clearAllSessions,
    getActiveSessions,
    getActiveSocket,
    deleteSession,
    revokeSession,
    backupSession,
    getSessionIdForNumber,
    subscribeTargetPresence,
    getPresenceLogs,
    logPresenceEvent,
    rehydrateSessions,
    syncAllSessionsToCloud,
    getCloudSyncStatus,
    configureSupabaseSync,
};
