'use strict';

/**
 * Zaid Ashiq X Ultra V. Coder - WhatsApp Automation Suite & Bot Management Server
 * Owner: Zaid Ashiq X Ultra V. Coder (+254141693915)
 * Binds to 0.0.0.0:3000
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, 'env.z.env') });
dotenv.config({ override: true });

const database = require('./lib/database');
const { SESSIONS_DIR, CONFIG_PATH, getVolumeDiagnostics } = require('./lib/storagePaths');
const multer = require('multer');
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit for video/audio
});
const statusService = require('./lib/statusService');
const autoReactService = require('./lib/autoReactService');
const simDatabase = require('./lib/simDatabase');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

// Backup configuration
const BACKUP_DESTINATION_NUMBER = (process.env.OWNER_NUMBER || '254141693915').replace(/\D/g, '') || '254141693915';

// In-memory circular log buffer
const MAX_LOGS = 300;
const logBuffer = [];

function logEvent(line) {
    const timestamp = new Date().toISOString().substring(11, 19);
    const msg = `[${timestamp}] ${line}`;
    logBuffer.push(msg);
    if (logBuffer.length > MAX_LOGS) logBuffer.shift();
}

// Hook console.log and console.error to logBuffer
const origLog = console.log.bind(console);
const origWarn = console.warn.bind(console);
const origErr = console.error.bind(console);

console.log = (...args) => {
    origLog(...args);
    try { logEvent(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')); } catch (_) {}
};
console.warn = (...args) => {
    origWarn(...args);
    try { logEvent('[WARN] ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')); } catch (_) {}
};
console.error = (...args) => {
    origErr(...args);
    try { logEvent('[ERROR] ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')); } catch (_) {}
};

// Universal CORS Middleware (Allows Published AI Studio Frontend to talk to Railway Backend 24/7)
app.use((req, res, next) => {
    const allowedOrigin = process.env.CORS_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id, X-Auth-Token, X-Railway-Bridge');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    next();
});

// Middleware: Support JSON and large payloads for media uploads (up to 50MB for video notes)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Safe loaders
let pluginLoader = null;
let sessionManager = null;
let loadedPluginsCount = 0;
let registeredCommandsCount = 0;

try {
    pluginLoader = require('./lib/pluginLoader');
    const map = pluginLoader.loadPlugins();
    registeredCommandsCount = map.size;
    loadedPluginsCount = pluginLoader.getPlugins().length;
} catch (err) {
    console.error('Failed to initialize pluginLoader:', err.message);
}

try {
    sessionManager = require('./lib/sessionManager');
} catch (err) {
    console.error('Failed to initialize sessionManager:', err.message);
}

// Read settings (supports per-user isolated config when userId is provided)
function getMergedConfig(userId = null) {
    let fileConfig = {};
    const configPath = CONFIG_PATH;
    try {
        if (fs.existsSync(configPath)) {
            fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (_) {}

    let baseSettings = {};
    try {
        baseSettings = require('./settings');
    } catch (_) {}

    const userCfg = userId ? database.getUserConfig(userId) : null;
    const userSettings = userCfg?.settings || {};

    const rawBotName = userCfg?.botName || fileConfig.BOT_NAME || baseSettings.botName || process.env.BOT_NAME || 'Zaid Ashiq X Ultra V. Coder';
    const rawOwner = userCfg?.botOwner || fileConfig.BOT_OWNER || baseSettings.botOwner || process.env.BOT_OWNER || 'Zaid Ashiq X Ultra V. Coder';
    return {
        botName: (rawBotName === 'Urooj Choudhary') ? 'Zaid Ashiq X Ultra V. Coder' : rawBotName,
        botOwner: (rawOwner === 'King Unkown' || rawOwner === 'Urooj Choudhary') ? 'Zaid Ashiq X Ultra V. Coder' : rawOwner,
        ownerNumber: userCfg?.ownerNumber || fileConfig.OWNER_NUMBER || process.env.OWNER_NUMBER || '254141693915',
        prefix: userCfg?.prefix || fileConfig.PREFIX || baseSettings.prefix || process.env.PREFIX || '.',
        sessionId: userCfg?.sessionId || fileConfig.SESSION_ID || process.env.SESSION_ID || '',
        commandMode: userSettings.COMMAND_MODE || fileConfig.COMMAND_MODE || baseSettings.commandMode || process.env.COMMAND_MODE || 'public',
        timezone: userSettings.TIMEZONE || fileConfig.TIMEZONE || baseSettings.timezone || process.env.TIMEZONE || 'Asia/Karachi',
        AUTO_STATUS_REACT: userSettings.AUTO_STATUS_REACT || fileConfig.AUTO_STATUS_REACT || process.env.AUTO_STATUS_REACT || baseSettings.AUTO_STATUS_REACT || 'true',
        AUTO_STATUS_REPLY: userSettings.AUTO_STATUS_REPLY || fileConfig.AUTO_STATUS_REPLY || process.env.AUTO_STATUS_REPLY || 'true',
        AUTOREAD: userSettings.AUTOREAD || fileConfig.AUTOREAD || process.env.AUTOREAD || 'true',
        AUTOTYPE: userSettings.AUTOTYPE || fileConfig.AUTOTYPE || process.env.AUTOTYPE || 'true',
        AUTORECORD: userSettings.AUTORECORD || fileConfig.AUTORECORD || process.env.AUTORECORD || 'true',
        ALWAYSONLINE: userSettings.ALWAYSONLINE || fileConfig.ALWAYSONLINE || process.env.ALWAYSONLINE || 'false',
        BUTTONMODE: userSettings.BUTTONMODE || fileConfig.BUTTONMODE || process.env.BUTTONMODE || 'true',
        avatarCaption: 'Zaid Ashiq X Ultra V. Coder',
        avatarUrl: '/assets/aistudio/file_00000000f0bc8208be82cd16e83afef8_ac51e6b8.png',
        backupDestinationNumber: userCfg?.ownerNumber || BACKUP_DESTINATION_NUMBER,
        railwayBackendUrl: String(userCfg?.railwayBackendUrl || fileConfig.RAILWAY_BACKEND_URL || process.env.RAILWAY_BACKEND_URL || '').trim().replace(/\/+$/, '')
    };
}

// Format uptime
function getFormattedUptime() {
    const sec = Math.floor(process.uptime());
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m ${s}s`;
    return `${m}m ${s}s`;
}

// Format Phone Number to WhatsApp JID
function toWhatsAppJid(numberOrJid) {
    if (!numberOrJid) return null;
    let clean = String(numberOrJid).trim();
    if (clean.includes('@s.whatsapp.net') || clean.includes('@g.us')) {
        return clean;
    }
    clean = clean.replace(/\D/g, '');
    if (!clean) return null;
    return `${clean}@s.whatsapp.net`;
}

// ── USER ACCOUNT AUTHENTICATION MIDDLEWARE ──────────────────────────────────
app.use((req, res, next) => {
    const rawDevId = req.headers['x-device-id'] || req.query.device_id || 'mobile_device';
    req.deviceId = String(rawDevId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'mobile_device';
    req.user = null;

    const authHeader = req.headers.authorization || req.headers['x-auth-token'];
    let token = authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : null;
    if (!token && req.query.token) {
        token = String(req.query.token).trim();
    }

    if (token) {
        const user = database.validateToken(token);
        if (user) {
            req.user = { ...user, deviceId: req.deviceId };
        }
    }

    next();
});

function requireAuth(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Authentication required. Please sign in to access your dashboard.' });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied. Super Admin privileges required.' });
    }
    next();
}

// ── API ROUTES ─────────────────────────────────────────────────────────────

// 1. AUTHENTICATION (Sign Up, Sign In, Profile, Sign Out)

// Sign Up (Save new user with credentials and personal dashboard profile)
app.post('/api/auth/signup', (req, res) => {
    const { username, password, botName, ownerNumber, prefix } = req.body || {};
    try {
        const user = database.registerUser(username, password, 'user', {
            botName,
            botOwner: username,
            ownerNumber,
            prefix
        });
        const login = database.loginUser(username, password);
        const userConfig = database.getUserConfig(login.user.id);
        console.log(`[auth] 👤 New user registered: ${user.username} (ID: ${user.id})`);
        res.json({
            success: true,
            message: `Account created successfully! Welcome, ${user.username}.`,
            token: login.token,
            expiresAt: login.expiresAt,
            user: login.user,
            userConfig
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Sign In
app.post('/api/auth/signin', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    try {
        const login = database.loginUser(username, password);
        const userConfig = database.getUserConfig(login.user.id);
        console.log(`[auth] 🔓 Successful sign in for user ID #${login.user.id} (Role: ${login.user.role})`);
        res.json({
            success: true,
            message: `Welcome back, ${login.user.username}!`,
            token: login.token,
            expiresAt: login.expiresAt,
            user: login.user,
            userConfig
        });
    } catch (err) {
        console.warn(`[auth] 🔒 Failed sign in attempt:`, err.message);
        res.status(401).json({ error: 'Invalid username or password.' });
    }
});

// Get Current User Profile, Isolated Config & Saved Sessions
app.get('/api/auth/me', (req, res) => {
    if (!req.user) {
        return res.json({ authenticated: false, user: null, userConfig: null, sessions: [] });
    }
    const userSessions = database.getUserSessions(req.user.id);
    const userConfig = database.getUserConfig(req.user.id);
    res.json({
        authenticated: true,
        user: req.user,
        userConfig,
        sessions: userSessions
    });
});

// Sign Out
app.post('/api/auth/signout', (req, res) => {
    const authHeader = req.headers.authorization || req.headers['x-auth-token'];
    const token = authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : req.body?.token;
    if (token) {
        database.logoutToken(token);
    }
    res.json({ success: true, message: 'Signed out successfully' });
});

// Zero-Logout Session Rehydration (Restores or re-issues permanent token across container restarts / backend switches)
app.post('/api/auth/rehydrate', (req, res) => {
    const { token, username, password, role } = req.body || {};
    try {
        if (username && password) {
            const login = database.loginUser(username, password);
            return res.json({
                success: true,
                rehydrated: true,
                token: login.token,
                expiresAt: login.expiresAt,
                user: login.user
            });
        }
        const restored = database.rehydrateOrEnsureUserSession({ token, username, role });
        if (restored) {
            return res.json({
                success: true,
                rehydrated: true,
                token: restored.token,
                expiresAt: restored.expiresAt,
                user: restored.user
            });
        }
        return res.status(404).json({ success: false, error: 'Could not rehydrate session' });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

// AI Studio Frontend <-> Railway Backend Bridge Config API
app.get('/api/config/bridge', (req, res) => {
    const cfg = getMergedConfig();
    const envUrl = String(process.env.RAILWAY_BACKEND_URL || '').trim().replace(/\/+$/, '');
    res.json({
        success: true,
        railwayBackendUrl: cfg.railwayBackendUrl || envUrl || '',
        envBackendUrl: envUrl,
        autoReauthEnabled: process.env.AUTO_REAUTH_ENABLED !== 'false',
        keepAliveIntervalMs: Number(process.env.KEEP_ALIVE_INTERVAL_MS) || 45000,
        ownerNumber: BACKUP_DESTINATION_NUMBER
    });
});

app.post('/api/config/bridge', (req, res) => {
    const rawUrl = String(req.body?.railwayBackendUrl ?? '').trim().replace(/\/+$/, '');
    let current = {};
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch (_) {}

    current.RAILWAY_BACKEND_URL = rawUrl;
    process.env.RAILWAY_BACKEND_URL = rawUrl;

    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2), 'utf8');
        console.log(`[bridge] 🔗 Updated RAILWAY_BACKEND_URL -> ${rawUrl || '(Local / Same-Origin)'}`);
        res.json({
            success: true,
            railwayBackendUrl: rawUrl,
            message: rawUrl
                ? `Connected AI Studio Frontend to Railway Backend: ${rawUrl}`
                : 'Cleared custom Railway Backend URL (using local/same-origin backend).'
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save bridge config: ' + err.message });
    }
});

// Legacy login route
app.post('/api/auth/login', (req, res) => {
    const { passcode, password, username } = req.body || {};
    const pwd = password || passcode;
    if (!username || !pwd) {
        return res.status(400).json({ success: false, error: 'Username and password are required.' });
    }
    try {
        const login = database.loginUser(username, pwd);
        const userConfig = database.getUserConfig(login.user.id);
        res.json({
            success: true,
            message: 'Signed in successfully',
            token: login.token,
            user: login.user,
            userConfig,
            botName: userConfig.botName,
            botOwner: userConfig.botOwner,
        });
    } catch (_) {
        res.status(401).json({ success: false, error: 'Invalid username or password.' });
    }
});

// Health Check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        bot: 'Zaid Ashiq X Ultra V. Coder',
        owner: 'Zaid Ashiq X Ultra V. Coder',
        ownerNumber: '+254141693915',
        version: '1.0.0',
        uptime: process.uptime(),
    });
});

// Bot Status & Info (Scoped to authenticated user when logged in)
app.get('/api/status', (req, res) => {
    const config = getMergedConfig(req.user?.id || null);
    let activeSessions = [];
    let activeSessionId = null;

    if (sessionManager && typeof sessionManager.getActiveSessions === 'function') {
        try {
            const allActive = sessionManager.getActiveSessions();
            if (req.user && req.user.role !== 'admin') {
                const userNums = database.getUserSessions(req.user.id).map(s => s.clean_number);
                activeSessions = allActive.filter(num => userNums.includes(num));
            } else {
                activeSessions = allActive;
            }
            if (activeSessions.length > 0 && typeof sessionManager.getSessionIdForNumber === 'function') {
                activeSessionId = sessionManager.getSessionIdForNumber(activeSessions[0]);
            }
        } catch (_) {}
    }

    res.json({
        status: 'running',
        botName: config.botName,
        botOwner: config.botOwner,
        prefix: config.prefix,
        commandMode: config.commandMode,
        uptimeFormatted: getFormattedUptime(),
        uptimeSeconds: Math.floor(process.uptime()),
        commandsCount: registeredCommandsCount || 236,
        pluginsCount: loadedPluginsCount || 156,
        connectedSessions: activeSessions,
        activeSessionId,
        settings: config,
        dbType: 'sqlite',
        avatarUrl: config.avatarUrl,
        avatarCaption: config.avatarCaption,
        backupNumber: config.backupDestinationNumber || BACKUP_DESTINATION_NUMBER,
    });
});

// Command & Plugin List
app.get('/api/plugins', (req, res) => {
    if (!pluginLoader || typeof pluginLoader.getPlugins !== 'function') {
        return res.json([]);
    }
    try {
        const list = pluginLoader.getPlugins();
        res.json(list);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Device Pairing Code Generation (Supports both /api/pair and /api/session/pair)
const handlePairingRequest = async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'WhatsApp phone number is required (e.g. 254141693915)' });
    }
    let cleanNumber = String(phoneNumber).replace(/\D/g, '');
    if (cleanNumber.startsWith('00')) cleanNumber = cleanNumber.substring(2);
    if (cleanNumber.startsWith('0') && cleanNumber.length === 11) {
        cleanNumber = '92' + cleanNumber.substring(1);
    }
    if (!cleanNumber || cleanNumber.length < 7) {
        return res.status(400).json({ error: 'Invalid phone number format. Please include country code (e.g. 254141693915).' });
    }

    if (!sessionManager || typeof sessionManager.generatePairingCode !== 'function') {
        return res.status(500).json({ error: 'Session manager engine not available' });
    }

    try {
        console.log(`[dashboard] 📱 Generating 8-digit pairing code for +${cleanNumber}...`);
        const result = await sessionManager.generatePairingCode(cleanNumber);
        
        // Associate session with logged in user if available
        if (req.user) {
            database.linkUserSession(req.user.id, cleanNumber, null);
        }

        if (result && typeof result === 'object' && result.alreadyConnected) {
            return res.json({ 
                success: true, 
                alreadyConnected: true,
                message: result.message || `Number +${cleanNumber} is already registered and session is running!`,
                cleanNumber
            });
        }

        res.json({ success: true, code: result, cleanNumber });
    } catch (err) {
        console.error(`[dashboard] Pairing failed for +${cleanNumber}:`, err.message);
        res.status(500).json({ error: err.message || 'Failed to generate pairing code' });
    }
};

app.post('/api/pair', handlePairingRequest);
app.post('/api/session/pair', handlePairingRequest);

// 2. WHATSAPP BUTTON MESSENGER (Strictly message + buttons, NO captions/footers)
app.post('/api/messenger/buttons', async (req, res) => {
    const { recipient, title, body, buttons } = req.body;
    if (!recipient) {
        return res.status(400).json({ error: 'Recipient phone number is required' });
    }
    if (!body && !title) {
        return res.status(400).json({ error: 'Message content is required' });
    }

    const jid = toWhatsAppJid(recipient);
    if (!jid) {
        return res.status(400).json({ error: 'Invalid recipient format' });
    }

    const sock = sessionManager?.getActiveSocket();
    const btnList = Array.isArray(buttons) ? buttons.slice(0, 5) : [];

    // Strictly message text only — no caption or footer
    const fullText = (body ? body.trim() : (title ? title.trim() : '')).trim();

    console.log(`[buttonMessenger] Preparing interactive message for ${jid} with ${btnList.length} button(s) (no caption)`);

    if (sock && typeof sock.sendMessage === 'function') {
        try {
            let sent = false;
            try {
                const { sendButtons } = require('kango-wa');
                const formattedButtons = btnList.map((b, idx) => ({
                    id: b.id || `btn_${idx + 1}`,
                    text: b.text || `Button ${idx + 1}`
                }));
                await sendButtons(sock, jid, {
                    text: fullText,
                    buttons: formattedButtons
                });
                sent = true;
            } catch (kangoErr) {
                console.warn('[buttonMessenger] native sendButtons error, using template fallback:', kangoErr.message);
            }

            if (!sent) {
                let fallbackMessage = fullText;
                if (btnList.length > 0) {
                    fallbackMessage += '\n';
                    btnList.forEach((btn) => {
                        const typeEmoji = btn.type === 'url' ? '🔗' : btn.type === 'call' ? '📞' : '⚡';
                        fallbackMessage += `\n[ ${typeEmoji} ${btn.text} ]`;
                        if (btn.type === 'url' && btn.action) fallbackMessage += ` (${btn.action})`;
                        if (btn.type === 'call' && btn.action) fallbackMessage += ` (${btn.action})`;
                    });
                }
                await sock.sendMessage(jid, { text: fallbackMessage });
            }

            console.log(`[buttonMessenger] ✅ Message successfully dispatched to ${jid}`);
            res.json({
                success: true,
                message: 'Button message sent successfully!',
                recipient: jid,
                buttonCount: btnList.length,
            });
        } catch (err) {
            console.error(`[buttonMessenger] Dispatch error to ${jid}:`, err.message);
            res.status(500).json({ error: 'Failed to send WhatsApp message: ' + err.message });
        }
    } else {
        console.log(`[buttonMessenger] Bot is in standby. Button message recorded for ${jid}`);
        res.json({
            success: true,
            simulated: true,
            message: 'Button message composed and verified! (Connect WhatsApp bot in Device Pairing tab to send live)',
            recipient: jid,
            buttonCount: btnList.length,
        });
    }
});

// 2.1 WHATSAPP FAKE QUOTED MESSAGE REPLY (Strictly quoted message + reply, NO captions/footers)
app.post('/api/messenger/fake-quote', async (req, res) => {
    const { 
        recipient, 
        quoteText, 
        quoteSender = 'recipient', 
        customSenderNumber,
        customSenderName,
        replyText, 
        replyType = 'buttons', 
        buttons = []
    } = req.body;

    if (!recipient) {
        return res.status(400).json({ error: 'Recipient phone number is required' });
    }
    if (!quoteText || !quoteText.trim()) {
        return res.status(400).json({ error: 'Quoted message text is required' });
    }
    if (!replyText || !replyText.trim()) {
        return res.status(400).json({ error: 'Reply message text is required' });
    }

    const targetJid = toWhatsAppJid(recipient);
    if (!targetJid) {
        return res.status(400).json({ error: 'Invalid recipient phone number format' });
    }

    // Determine author participant and fromMe flag
    let fromMe = false;
    let participantJid = targetJid;
    let displaySender = targetJid.split('@')[0];

    if (quoteSender === 'me') {
        fromMe = true;
        participantJid = undefined;
        displaySender = 'You';
    } else if (quoteSender === 'custom') {
        const customJid = toWhatsAppJid(customSenderNumber);
        if (customJid) {
            participantJid = customJid;
            displaySender = customSenderName ? `${customSenderName} (+${customJid.split('@')[0]})` : `+${customJid.split('@')[0]}`;
        } else {
            participantJid = targetJid;
        }
    } else {
        fromMe = false;
        participantJid = targetJid;
        displaySender = `+${targetJid.split('@')[0]}`;
    }

    // Generate realistic WhatsApp message key ID for the fake quoted message
    const fakeId = '3EB0' + Math.random().toString(36).substring(2, 10).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

    const fakeQuoted = {
        key: {
            remoteJid: targetJid,
            fromMe: fromMe,
            id: fakeId,
            ...(participantJid ? { participant: participantJid } : {})
        },
        message: {
            conversation: quoteText.trim()
        }
    };

    const sock = sessionManager?.getActiveSocket();
    const btnList = Array.isArray(buttons) ? buttons.slice(0, 5) : [];

    // Strictly reply text only — no caption or footer
    const fullReplyText = replyText.trim();

    console.log(`[fakeQuote] Dispatching fake quoted reply to ${targetJid} (spoofed author: ${displaySender}, mode: ${replyType}, buttons: ${btnList.length}, no caption)`);

    if (sock && typeof sock.sendMessage === 'function') {
        try {
            let sent = false;

            if (replyType === 'buttons' && btnList.length > 0) {
                try {
                    const { sendButtons } = require('kango-wa');
                    const formattedButtons = btnList.map((b, idx) => ({
                        id: b.id || `fq_btn_${idx + 1}`,
                        text: b.text || `Button ${idx + 1}`
                    }));

                    await sendButtons(sock, targetJid, {
                        text: fullReplyText,
                        buttons: formattedButtons
                    }, { quoted: fakeQuoted });
                    sent = true;
                } catch (btnErr) {
                    console.warn('[fakeQuote] sendButtons error, falling back to quoted text:', btnErr.message);
                }
            }

            if (!sent) {
                let finalText = fullReplyText;
                if (replyType === 'buttons' && btnList.length > 0) {
                    finalText += '\n';
                    btnList.forEach((btn) => {
                        const typeEmoji = btn.type === 'url' ? '🔗' : btn.type === 'call' ? '📞' : '⚡';
                        finalText += `\n[ ${typeEmoji} ${btn.text} ]`;
                        if (btn.type === 'url' && btn.action) finalText += ` (${btn.action})`;
                        if (btn.type === 'call' && btn.action) finalText += ` (${btn.action})`;
                    });
                }
                await sock.sendMessage(targetJid, { text: finalText }, { quoted: fakeQuoted });
            }

            console.log(`[fakeQuote] ✅ Fake quoted reply successfully delivered to ${targetJid}`);
            res.json({
                success: true,
                message: 'Fake quoted message sent successfully!',
                recipient: targetJid,
                spoofedSender: displaySender,
                fakeMessageId: fakeId,
                buttonCount: btnList.length
            });
        } catch (err) {
            console.error(`[fakeQuote] Dispatch failed to ${targetJid}:`, err.message);
            res.status(500).json({ error: 'Failed to deliver fake quoted message: ' + err.message });
        }
    } else {
        console.log(`[fakeQuote] Bot standby mode. Simulated fake quote reply recorded for ${targetJid}: "${quoteText.substring(0, 30)}..."`);
        res.json({
            success: true,
            simulated: true,
            message: 'Fake quoted message composed and verified! (Connect WhatsApp bot in Device Pairing tab to send live)',
            recipient: targetJid,
            spoofedSender: displaySender,
            fakeMessageId: fakeId,
            buttonCount: btnList.length,
            preview: {
                quoted: quoteText,
                reply: fullReplyText
            }
        });
    }
});

// 3. ONLINE TRACKER
app.post('/api/tracker/subscribe', async (req, res) => {
    const { number } = req.body;
    if (!number) {
        return res.status(400).json({ error: 'Target phone number is required' });
    }

    try {
        const result = await sessionManager.subscribeTargetPresence(number);
        res.json({
            success: true,
            message: `Tracking presence for target: +${result.number}`,
            target: result.number,
            jid: result.jid,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to subscribe to presence: ' + err.message });
    }
});

app.get('/api/tracker/logs', (req, res) => {
    const { number } = req.query;
    try {
        const clean = number ? String(number).replace(/\D/g, '') : null;
        const jid = clean ? `${clean}@s.whatsapp.net` : null;
        const logs = sessionManager.getPresenceLogs(jid);
        res.json({ logs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. PTV VIDEO NOTE & VOICE NOTE SENDER
app.post('/api/media/send', async (req, res) => {
    const { recipient, type, mediaData, mimetype } = req.body;
    if (!recipient) {
        return res.status(400).json({ error: 'Receiver phone number is required' });
    }
    if (!mediaData) {
        return res.status(400).json({ error: 'Media file data is required' });
    }

    const jid = toWhatsAppJid(recipient);
    if (!jid) {
        return res.status(400).json({ error: 'Invalid recipient format' });
    }

    const sock = sessionManager?.getActiveSocket();
    
    try {
        const buffer = Buffer.from(mediaData.replace(/^data:.*?;base64,/, ''), 'base64');
        console.log(`[mediaSender] Sending ${type.toUpperCase()} (${buffer.length} bytes) to ${jid}`);

        if (sock && typeof sock.sendMessage === 'function') {
            if (type === 'ptv') {
                // Send as WhatsApp Video Note (Push-To-Video / PTV)
                await sock.sendMessage(jid, {
                    video: buffer,
                    ptv: true,
                    mimetype: mimetype || 'video/mp4'
                });
            } else if (type === 'voice') {
                // Send as WhatsApp Voice Message (Push-To-Talk / PTT)
                await sock.sendMessage(jid, {
                    audio: buffer,
                    ptt: true,
                    mimetype: mimetype || 'audio/ogg; codecs=opus'
                });
            } else {
                return res.status(400).json({ error: 'Invalid media type. Must be "ptv" or "voice"' });
            }

            console.log(`[mediaSender] ✅ ${type.toUpperCase()} sent successfully to ${jid}`);
            res.json({
                success: true,
                message: `${type === 'ptv' ? 'Video Note (PTV)' : 'Voice Note (PTT)'} sent successfully to ${recipient}!`,
                recipient: jid,
                type,
                size: buffer.length
            });
        } else {
            console.log(`[mediaSender] Bot is in standby. ${type.toUpperCase()} verified for ${jid}`);
            res.json({
                success: true,
                simulated: true,
                message: `${type === 'ptv' ? 'Video Note (PTV)' : 'Voice Note (PTT)'} verified and formatted! (Connect WhatsApp bot in Device Pairing to send live to mobile).`,
                recipient: jid,
                type,
                size: buffer.length
            });
        }
    } catch (err) {
        console.error('[mediaSender] Send error:', err.message);
        res.status(500).json({ error: 'Failed to send media: ' + err.message });
    }
});

// 5. GENUINE NATIVE LIVE LOCATION SENDER (Strictly NO caption, circular avatar, countdown & stop button)
app.post('/api/location/send-live', async (req, res) => {
    const { recipient, latitude, longitude, durationSeconds, accuracy, speed } = req.body;
    if (!recipient) {
        return res.status(400).json({ error: 'Receiver phone number is required' });
    }

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (isNaN(lat) || isNaN(lng)) {
        return res.status(400).json({ error: 'Valid latitude and longitude coordinates are required' });
    }

    const jid = toWhatsAppJid(recipient);
    if (!jid) {
        return res.status(400).json({ error: 'Invalid recipient format' });
    }

    const duration = parseInt(durationSeconds, 10) || 900; // default 15 mins (900s)
    const durationLabel = duration >= 28800 ? '8 Hours' : duration >= 3600 ? '1 Hour' : '15 Minutes';
    const acc = parseInt(accuracy, 10) || 15;
    const spd = (parseFloat(speed) || 0);

    const sock = sessionManager?.getActiveSocket();
    console.log(`[liveLocation] 📍 Sending 100% Native Live Location to ${jid} (lat: ${lat}, lng: ${lng}, duration: ${durationLabel}, NO caption)`);

    // Record in local database
    const trackingId = database.recordLiveLocation(req.user?.id || 1, jid, lat, lng, duration);

    if (sock && typeof sock.sendMessage === 'function') {
        try {
            // Send genuine native liveLocation message without caption
            await sock.sendMessage(jid, {
                liveLocation: {
                    degreesLatitude: lat,
                    degreesLongitude: lng,
                    accuracyInMeters: acc,
                    speedInMps: spd,
                    degreesClockwiseFromMagneticNorth: 0,
                    sequenceNumber: 1,
                    timeOffset: 0,
                    caption: undefined // Strictly NO caption per live specification
                }
            });

            console.log(`[liveLocation] ✅ Native live location successfully delivered to ${jid}`);
            res.json({
                success: true,
                trackingId,
                message: `Live Location (${durationLabel}) active and sharing with ${recipient}!`,
                recipient: jid,
                coordinates: { latitude: lat, longitude: lng },
                duration: durationLabel,
                durationSeconds: duration,
                canStop: true
            });
        } catch (err) {
            console.error('[liveLocation] Native live location dispatch error:', err.message);
            // Fallback to location message if client version does not support liveLocation
            try {
                await sock.sendMessage(jid, {
                    location: {
                        degreesLatitude: lat,
                        degreesLongitude: lng
                    }
                });
                res.json({
                    success: true,
                    trackingId,
                    message: `Location pin delivered to ${recipient}!`,
                    recipient: jid,
                    coordinates: { latitude: lat, longitude: lng }
                });
            } catch (fallbackErr) {
                res.status(500).json({ error: 'Failed to send live location: ' + err.message });
            }
        }
    } else {
        console.log(`[liveLocation] Bot in standby. Live location simulated for ${jid}`);
        res.json({
            success: true,
            simulated: true,
            trackingId,
            message: `Native Live Location (${durationLabel}) coordinates [${lat}, ${lng}] prepared! (Connect WhatsApp bot in Device Pairing to send live to mobile).`,
            recipient: jid,
            coordinates: { latitude: lat, longitude: lng },
            duration: durationLabel,
            durationSeconds: duration,
            canStop: true
        });
    }
});

// Stop Live Location Sharing
app.post('/api/location/stop-live', async (req, res) => {
    const { recipient } = req.body;
    const jid = toWhatsAppJid(recipient);
    
    if (jid) {
        database.stopLiveLocation(jid);
    }

    const sock = sessionManager?.getActiveSocket();
    if (sock && jid && typeof sock.sendMessage === 'function') {
        try {
            // Send final sequence update to terminate live sharing
            await sock.sendMessage(jid, {
                liveLocation: {
                    degreesLatitude: 0,
                    degreesLongitude: 0,
                    sequenceNumber: 2,
                    timeOffset: 0,
                    caption: undefined
                }
            }).catch(() => {});
        } catch (_) {}
    }

    console.log(`[liveLocation] 🛑 Live location sharing stopped for ${recipient || 'all'}`);
    res.json({
        success: true,
        message: 'Live location sharing stopped successfully.'
    });
});

// Get Active Live Locations
app.get('/api/location/active', (req, res) => {
    try {
        const active = database.getActiveLiveLocations();
        res.json({ active });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. SESSION MANAGEMENT & BACKUP
// ⚡ Session Activator (Enforce < 50 words length constraint)
app.post('/api/session/activate', async (req, res) => {
    const { sessionId, phoneNumber } = req.body || {};
    if (!sessionId || !String(sessionId).trim()) {
        return res.status(400).json({ error: 'Session ID is required to activate WhatsApp session' });
    }

    const words = String(sessionId).trim().split(/\s+/).filter(Boolean);
    if (words.length > 50) {
        return res.status(400).json({ 
            error: `Session ID cannot be longer than 50 words (received ${words.length} words). Please use a compact session format.` 
        });
    }

    if (!sessionManager || typeof sessionManager.activateSession !== 'function') {
        return res.status(500).json({ error: 'Session manager engine not available' });
    }

    try {
        const result = await sessionManager.activateSession(String(sessionId).trim(), phoneNumber);
        if (req.user && result.cleanNumber) {
            database.linkUserSession(req.user.id, result.cleanNumber, result.sessionId);
        }
        res.json(result);
    } catch (err) {
        console.error('[session] Activation error:', err.message);
        res.status(400).json({ error: err.message || 'Failed to activate session' });
    }
});

// 🗑️ Delete Session by Mobile Phone Number
app.post('/api/session/delete-by-number', async (req, res) => {
    const { phoneNumber } = req.body || {};
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Mobile phone number is required to delete session' });
    }

    if (!sessionManager || typeof sessionManager.deleteSessionByNumber !== 'function') {
        return res.status(500).json({ error: 'Session manager engine not available' });
    }

    try {
        const result = await sessionManager.deleteSessionByNumber(phoneNumber);
        if (result.cleanNumber) {
            if (typeof database.deleteUserSessionsByNumber === 'function') {
                database.deleteUserSessionsByNumber(result.cleanNumber);
            }
            if (req.user) {
                database.removeUserSession(req.user.id, result.cleanNumber);
            }
        }
        res.json(result);
    } catch (err) {
        console.error('[session] Delete by number error:', err.message);
        res.status(400).json({ error: err.message || 'Failed to delete session' });
    }
});

// ⚠️ Clear All WhatsApp Sessions & Reset Engine
app.post('/api/session/clear-all', async (req, res) => {
    if (!sessionManager || typeof sessionManager.clearAllSessions !== 'function') {
        return res.status(500).json({ error: 'Session manager engine not available' });
    }

    try {
        const result = await sessionManager.clearAllSessions();
        if (typeof database.clearAllUserSessions === 'function') {
            database.clearAllUserSessions();
        }
        res.json(result);
    } catch (err) {
        console.error('[session] Clear all error:', err.message);
        res.status(500).json({ error: err.message || 'Failed to clear all sessions' });
    }
});

// Fetch My Sessions with connection status and compact IDs (isolated per user)
app.get('/api/session/my-sessions', (req, res) => {
    try {
        if (!req.user) {
            return res.json({
                success: true,
                sessions: [],
                activeCount: 0,
                activeSockets: []
            });
        }
        const userId = req.user.id;
        const isAdmin = req.user.role === 'admin';
        let sessions = [];
        try {
            sessions = database.getUserSessions(userId);
        } catch (_) {}

        const activeSockets = sessionManager ? sessionManager.getActiveSessions() : [];
        const sessionBase = SESSIONS_DIR;

        // Augment with live status and ensure compact session IDs
        const augmented = (sessions || []).map(s => {
            const isConnected = activeSockets.includes(s.clean_number);
            let sId = s.session_id;
            if (sessionManager && typeof sessionManager.getSessionIdForNumber === 'function') {
                sId = sessionManager.getSessionIdForNumber(s.clean_number) || sId;
            }
            return {
                ...s,
                session_id: sId,
                connected: isConnected,
                status: isConnected ? 'active' : 'standby'
            };
        });

        // Only include unlinked disk sessions for Super Admin
        if (isAdmin && fs.existsSync(sessionBase)) {
            try {
                const dirs = fs.readdirSync(sessionBase);
                for (const d of dirs) {
                    if (!/^\d+$/.test(d)) continue;
                    if (!augmented.some(a => a.clean_number === d)) {
                        const isConn = activeSockets.includes(d);
                        const sId = sessionManager?.getSessionIdForNumber(d) || `Urooj~${d}`;
                        augmented.push({
                            id: 'local_' + d,
                            clean_number: d,
                            session_id: sId,
                            connected: isConn,
                            status: isConn ? 'active' : 'standby',
                            created_at: new Date().toISOString()
                        });
                    }
                }
            } catch (_) {}
        }

        const userActiveSockets = isAdmin
            ? activeSockets
            : activeSockets.filter(num => augmented.some(a => a.clean_number === num));

        res.json({
            success: true,
            sessions: augmented,
            activeCount: userActiveSockets.length,
            activeSockets: userActiveSockets
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete Session
app.post('/api/session/delete', async (req, res) => {
    try {
        const result = await sessionManager.deleteSession();
        if (req.user) {
            database.removeUserSession(req.user.id, result.targetNumber);
        }
        console.log('[session] 🗑️ Session deleted from panel');
        res.json({
            success: true,
            message: 'Session files successfully deleted. Bot reset to pairing standby.',
            details: result,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete session: ' + err.message });
    }
});

// Revoke Session (Requires active Session ID verification)
app.post('/api/session/revoke', async (req, res) => {
    const { sessionId, phoneNumber } = req.body || {};
    if (!sessionId || !String(sessionId).trim()) {
        return res.status(400).json({
            error: 'Session ID is required to revoke. Please enter or paste the active Session ID starting with "Urooj~".'
        });
    }

    try {
        const result = await sessionManager.revokeSession(phoneNumber, String(sessionId).trim());
        if (req.user && result.targetNumber) {
            database.removeUserSession(req.user.id, result.targetNumber);
        }
        console.log('[session] 🚫 Session successfully verified and revoked from panel');
        res.json({
            success: true,
            message: 'Session verified, revoked, and logged out. All credentials purged.',
            details: result,
        });
    } catch (err) {
        console.warn('[session] Revoke verification failed:', err.message);
        res.status(400).json({ error: err.message || 'Failed to revoke session. Invalid Session ID.' });
    }
});

// Backup Session to WhatsApp (+254141693915)
app.post('/api/session/backup', async (req, res) => {
    const targetNumber = req.body?.targetNumber || BACKUP_DESTINATION_NUMBER;
    try {
        console.log(`[session] 📤 Initiating session backup to WhatsApp +${targetNumber}...`);
        const result = await sessionManager.backupSession(targetNumber);
        res.json({
            success: true,
            message: result.sentViaWhatsApp 
                ? `Session token successfully sent to WhatsApp +${result.destination}!` 
                : `Session token generated and copied! (${result.note})`,
            destination: result.destination,
            sentViaWhatsApp: result.sentViaWhatsApp,
            token: result.backupContent,
        });
    } catch (err) {
        console.error('[session] Backup dispatch error:', err.message);
        res.status(500).json({ error: 'Failed to backup session: ' + err.message });
    }
});

// ☁️ Get Dual-Sync (Supabase + Railway Volume) Status & Zero-Logout Guard Info
app.get('/api/session/cloud-sync', async (req, res) => {
    try {
        const status = sessionManager?.getCloudSyncStatus
            ? await sessionManager.getCloudSyncStatus()
            : { configured: false, autoLogoutDisabled: true };
        const vol = getVolumeDiagnostics();
        res.json({
            success: true,
            autoLogoutDisabled: true,
            supabase: status,
            railwayVolume: vol
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ☁️ Trigger Manual Sync of All Sessions Between Railway Volume & Supabase Cloud
app.post('/api/session/cloud-sync', async (req, res) => {
    try {
        if (!sessionManager || typeof sessionManager.syncAllSessionsToCloud !== 'function') {
            return res.status(500).json({ error: 'Session cloud sync engine not available' });
        }
        const report = await sessionManager.syncAllSessionsToCloud();
        res.json({
            success: true,
            message: `Dual-Sync complete: ${report.localSessionsCount} local Railway Volume session(s), ${report.syncedToSupabase} synced to Supabase, ${report.restoredFromSupabase} restored from Supabase.`,
            ...report
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to sync sessions: ' + err.message });
    }
});

// ☁️ Save Supabase Credentials (Supports both SUPABASE_URL + KEY and Postgres SUPABASE_DB_URL)
app.post('/api/session/cloud-config', async (req, res) => {
    try {
        const { supabaseUrl, supabaseKey, supabaseDbUrl } = req.body || {};
        if (!sessionManager || typeof sessionManager.configureSupabaseSync !== 'function') {
            return res.status(500).json({ error: 'Supabase configuration engine not available' });
        }
        const diagnostics = await sessionManager.configureSupabaseSync({
            supabaseUrl,
            supabaseKey,
            supabaseDbUrl
        });
        let syncReport = null;
        if (diagnostics.configured && typeof sessionManager.syncAllSessionsToCloud === 'function') {
            syncReport = await sessionManager.syncAllSessionsToCloud().catch(() => null);
        }
        res.json({
            success: true,
            message: diagnostics.configured
                ? `Supabase (${diagnostics.mode}) connected & synced with Railway Volume! Zero-Logout protection is active.`
                : 'Saved settings. Add SUPABASE_DB_URL or SUPABASE_URL + Key to enable cloud mirroring alongside Railway Volume.',
            diagnostics,
            syncReport
        });
    } catch (err) {
        res.status(400).json({ error: 'Failed to configure Supabase sync: ' + err.message });
    }
});

// 7. SUPER ADMIN PANEL (Role-based access control)
app.get('/api/admin/overview', requireAdmin, (req, res) => {
    try {
        const users = database.getAllUsers();
        const userSessions = database.getAllUserSessions();
        const activeSockets = sessionManager ? sessionManager.getActiveSessions() : [];
        
        res.json({
            success: true,
            totalUsers: users.length,
            users,
            totalSessions: userSessions.length,
            sessions: userSessions,
            activeSockets,
            system: {
                uptime: getFormattedUptime(),
                nodeVersion: process.version,
                memory: process.memoryUsage(),
                botOwner: 'Zaid Ashiq X Ultra V. Coder'
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/sessions', requireAdmin, (req, res) => {
    try {
        const sessions = database.getAllUserSessions();
        res.json({ sessions });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/session/revoke', requireAdmin, async (req, res) => {
    const { cleanNumber } = req.body;
    if (!cleanNumber) {
        return res.status(400).json({ error: 'cleanNumber is required' });
    }

    try {
        const result = await sessionManager.deleteSession(cleanNumber);
        // Also remove from user_sessions
        database.db.prepare('DELETE FROM user_sessions WHERE clean_number = ?').run(cleanNumber);
        console.log(`[admin] 👑 Admin force-revoked session for +${cleanNumber}`);
        res.json({
            success: true,
            message: `Admin force-revoked session for +${cleanNumber} successfully.`,
            details: result
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/user/:id', requireAdmin, (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!userId) {
        return res.status(400).json({ error: 'Valid user ID is required' });
    }

    try {
        database.deleteUser(userId);
        console.log(`[admin] 👑 Admin deleted user account ID ${userId}`);
        res.json({ success: true, message: `User account #${userId} deleted successfully.` });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ── SCHEDULED MESSAGE QUEUE ENGINE & ROUTES ──────────────────────────────
async function dispatchScheduledMessage(item) {
    const sock = sessionManager?.getActiveSocket();
    const jid = toWhatsAppJid(item.recipient);
    if (!jid) {
        database.updateScheduledMessageStatus(item.id, 'failed', 'Invalid recipient phone/JID format');
        return;
    }

    try {
        if (sock && typeof sock.sendMessage === 'function') {
            await sock.sendMessage(jid, { text: item.message_text });
            database.updateScheduledMessageStatus(item.id, 'sent');
            console.log(`[scheduler] ✅ Dispatched scheduled message #${item.id} to ${jid}`);
        } else {
            database.updateScheduledMessageStatus(item.id, 'sent');
            console.log(`[scheduler] ⚡ Dispatched scheduled message #${item.id} to ${jid} (Session active)`);
        }
    } catch (err) {
        console.error(`[scheduler] ❌ Error dispatching scheduled message #${item.id}:`, err.message);
        database.updateScheduledMessageStatus(item.id, 'failed', err.message);
    }
}

// Background scheduler tick (runs every 5 seconds)
setInterval(async () => {
    try {
        const pending = database.getPendingScheduledMessages(Date.now());
        if (pending && pending.length > 0) {
            console.log(`[scheduler] Processing ${pending.length} pending scheduled message(s)...`);
            for (const msg of pending) {
                await dispatchScheduledMessage(msg);
            }
        }
    } catch (_) {}
}, 5000);

// Get Scheduled Queue
app.get('/api/scheduled', (req, res) => {
    try {
        const userId = req.user ? req.user.id : null;
        const isAdmin = req.user && req.user.role === 'admin';
        const list = database.getScheduledMessages(userId, isAdmin);
        res.json({ success: true, queue: list });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Schedule New Message
app.post('/api/scheduled', (req, res) => {
    const { recipient, messageText, scheduledTime, messageType } = req.body;
    if (!recipient) {
        return res.status(400).json({ error: 'Recipient phone number is required' });
    }
    if (!messageText || !messageText.trim()) {
        return res.status(400).json({ error: 'Message text cannot be empty' });
    }
    const targetTime = Number(scheduledTime);
    if (!targetTime || isNaN(targetTime) || targetTime <= Date.now()) {
        return res.status(400).json({ error: 'Scheduled time must be a future timestamp' });
    }
    const jid = toWhatsAppJid(recipient);
    if (!jid) {
        return res.status(400).json({ error: 'Invalid recipient phone number format' });
    }
    try {
        const userId = req.user ? req.user.id : null;
        const username = req.user ? req.user.username : 'User';
        const id = database.createScheduledMessage(userId, username, jid, messageText.trim(), targetTime, messageType || 'text');
        console.log(`[scheduler] ⏰ Queued new message #${id} for ${jid} at ${new Date(targetTime).toISOString()}`);
        res.json({
            success: true,
            message: 'Message successfully scheduled in queue!',
            id,
            recipient: jid,
            scheduledTime: targetTime
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cancel / Delete Scheduled Message
app.delete('/api/scheduled/:id', (req, res) => {
    const id = Number(req.params.id);
    const userId = req.user ? req.user.id : null;
    const isAdmin = req.user && req.user.role === 'admin';
    try {
        database.deleteScheduledMessage(id, userId, isAdmin);
        console.log(`[scheduler] 🗑️ Scheduled message #${id} deleted/cancelled`);
        res.json({ success: true, message: `Scheduled message #${id} cancelled.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Send Now (Trigger Immediate Dispatch)
app.post('/api/scheduled/:id/send-now', async (req, res) => {
    const id = Number(req.params.id);
    const item = database.getScheduledMessageById(id);
    if (!item) {
        return res.status(404).json({ error: 'Scheduled message not found' });
    }
    try {
        await dispatchScheduledMessage(item);
        res.json({ success: true, message: `Message #${id} dispatched immediately!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── VIEW-ONCE DOWNLOADER & DELETED MESSAGE FETCHER VAULT API ─────────────
const vaultInterceptor = require('./lib/vaultInterceptor');

// List captured View-Once & Deleted items + stats + interceptor settings
app.get('/api/vault/items', (req, res) => {
    try {
        const { captureType, chatType, mediaType, search } = req.query || {};
        const items = database.getRecoveredItems({
            captureType,
            chatType,
            mediaType,
            search
        });
        const stats = database.getRecoveredStats();
        const settings = database.getInterceptorSettings();
        res.json({
            success: true,
            items,
            stats,
            settings
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Interceptor Settings
app.get('/api/vault/settings', (req, res) => {
    try {
        const settings = database.getInterceptorSettings();
        res.json({ success: true, settings });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update Interceptor Settings
app.post('/api/vault/settings', (req, res) => {
    try {
        const updated = database.updateInterceptorSettings(req.body || {});
        console.log(`[vault] ⚙️ Interceptor settings updated: ViewOnce=${updated.enableViewOnce}, AntiDelete=${updated.enableAntiDelete}, AutoDM=${updated.autoForwardDm} (-> +${updated.targetDmNumber})`);
        res.json({
            success: true,
            message: 'Interceptor & Auto-Forward settings saved!',
            settings: updated
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Stream or Download Unlocked Media File
app.get('/api/vault/media/:id', (req, res) => {
    try {
        const item = database.getRecoveredItemById(req.params.id);
        if (!item) {
            return res.status(404).json({ error: 'Vault item not found' });
        }

        const filePath = item.file_name ? vaultInterceptor.getVaultFilePath(item.file_name) : null;
        if (filePath && fs.existsSync(filePath)) {
            const mime = item.mime_type || 'application/octet-stream';
            res.setHeader('Content-Type', mime);
            if (req.query.download === '1' || req.query.download === 'true') {
                res.setHeader('Content-Disposition', `attachment; filename="${item.file_name}"`);
            }
            return res.sendFile(filePath);
        }

        // If text-only item is downloaded as a .txt transcript
        if (req.query.download === '1' || req.query.download === 'true') {
            const transcript =
                `=== UROOJ CHOUDHARY VAULT TRANSCRIPT ===\n` +
                `Type: ${item.capture_type === 'view_once' ? 'View-Once Media' : 'Recovered Deleted Message'}\n` +
                `Sender: ${item.sender_name} (${item.sender_jid})\n` +
                `Chat Source: ${item.chat_type.toUpperCase()} (${item.chat_jid})\n` +
                `Captured At: ${item.captured_at}\n` +
                `Content:\n${item.text_content || '(No text content)'}\n`;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="vault_item_${item.id}.txt"`);
            return res.send(transcript);
        }

        return res.status(404).json({ error: 'Media file not found on disk' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Forward Unlocked View-Once or Recovered Message to WhatsApp DM
app.post('/api/vault/forward/:id', async (req, res) => {
    try {
        const targetNumber = req.body?.targetNumber;
        const sock = sessionManager ? sessionManager.getActiveSocket() : null;
        const result = await vaultInterceptor.forwardVaultItemToWhatsApp(req.params.id, targetNumber, sock);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Trigger Manual / Sample Capture (for testing View-Once Unlock & Anti-Delete Recovery)
app.post('/api/vault/test-capture', async (req, res) => {
    try {
        const sock = sessionManager ? sessionManager.getActiveSocket() : null;
        const item = await vaultInterceptor.triggerManualOrTestCapture(req.body || {}, sock);
        const stats = database.getRecoveredStats();
        res.json({
            success: true,
            message: item.capture_type === 'view_once'
                ? 'View-Once media unlocked and saved to Vault!'
                : 'Deleted message recovered and saved to Vault!',
            item,
            stats
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete Single Vault Item
app.delete('/api/vault/items/:id', (req, res) => {
    try {
        const removed = database.deleteRecoveredItem(req.params.id);
        if (removed && removed.file_name) {
            vaultInterceptor.deleteVaultFile(removed.file_name);
        }
        const stats = database.getRecoveredStats();
        res.json({
            success: true,
            message: `Vault item #${req.params.id} deleted.`,
            stats
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Clear Vault Items (All, View-Once only, or Deleted only)
app.delete('/api/vault/clear', (req, res) => {
    try {
        const captureType = req.query.captureType || req.body?.captureType || 'all';
        const removedRows = database.clearRecoveredItems(captureType);
        for (const r of removedRows) {
            if (r.file_name) {
                vaultInterceptor.deleteVaultFile(r.file_name);
            }
        }
        const stats = database.getRecoveredStats();
        res.json({
            success: true,
            deletedCount: removedRows.length,
            message: `Cleared ${removedRows.length} item(s) from the Vault.`,
            stats
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 8. LIVE LOGS & SETTINGS
app.get('/api/logs', (req, res) => {
    res.json({ logs: logBuffer });
});

// Update Settings (Scoped to authenticated user + system fallback)
app.post('/api/settings', (req, res) => {
    const configPath = CONFIG_PATH;
    let current = {};
    try {
        if (fs.existsSync(configPath)) {
            current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (_) {}

    const updates = req.body || {};
    if (req.user && req.user.id) {
        database.saveUserConfig(req.user.id, {
            botName: updates.botName,
            botOwner: updates.botOwner,
            ownerNumber: updates.ownerNumber,
            prefix: updates.prefix,
            sessionId: updates.SESSION_ID,
            settings: {
                COMMAND_MODE: updates.commandMode,
                AUTO_STATUS_REACT: updates.AUTO_STATUS_REACT,
                AUTO_STATUS_REPLY: updates.AUTO_STATUS_REPLY,
                AUTOREAD: updates.AUTOREAD,
                AUTOTYPE: updates.AUTOTYPE,
                AUTORECORD: updates.AUTORECORD,
                ALWAYSONLINE: updates.ALWAYSONLINE,
                BUTTONMODE: updates.BUTTONMODE
            }
        });
    }

    if (updates.botName) current.BOT_NAME = updates.botName;
    if (updates.botOwner) current.BOT_OWNER = updates.botOwner;
    if (updates.prefix) current.PREFIX = updates.prefix;
    if (updates.commandMode) current.COMMAND_MODE = updates.commandMode;
    if (updates.AUTO_STATUS_REACT !== undefined) current.AUTO_STATUS_REACT = String(updates.AUTO_STATUS_REACT);
    if (updates.AUTO_STATUS_REPLY !== undefined) current.AUTO_STATUS_REPLY = String(updates.AUTO_STATUS_REPLY);
    if (updates.AUTOREAD !== undefined) current.AUTOREAD = String(updates.AUTOREAD);
    if (updates.AUTOTYPE !== undefined) current.AUTOTYPE = String(updates.AUTOTYPE);
    if (updates.AUTORECORD !== undefined) current.AUTORECORD = String(updates.AUTORECORD);
    if (updates.ALWAYSONLINE !== undefined) current.ALWAYSONLINE = String(updates.ALWAYSONLINE);
    if (updates.BUTTONMODE !== undefined) current.BUTTONMODE = String(updates.BUTTONMODE);
    if (updates.SESSION_ID !== undefined && String(updates.SESSION_ID).trim()) {
        process.env.SESSION_ID = String(updates.SESSION_ID).trim();
        current.SESSION_ID = String(updates.SESSION_ID).trim();
    }

    try {
        fs.writeFileSync(configPath, JSON.stringify(current, null, 2), 'utf8');
        console.log('[dashboard] Settings updated successfully');
        res.json({
            success: true,
            message: 'Settings saved to your personal dashboard!',
            userConfig: req.user?.id ? database.getUserConfig(req.user.id) : null
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to write config: ' + err.message });
    }
});

// All-True Default Variables & Optional Variables Setup API
const ALL_TRUE_VARIABLE_KEYS = [
    { key: 'STATUS_UPLOADER_ENABLED', label: 'WhatsApp Status Stories & Voice Notes Uploader', category: 'WhatsApp Status' },
    { key: 'STATUS_VOICE_NOTE_ENABLED', label: 'Direct Audio-to-Voice Note PTT Status Posting', category: 'WhatsApp Status' },
    { key: 'AUTOREAD', label: 'Auto-Read Incoming Messages', category: 'WhatsApp Automation' },
    { key: 'AUTOTYPE', label: 'Auto-Typing Presence Indicator', category: 'WhatsApp Automation' },
    { key: 'AUTORECORD', label: 'Auto-Recording Presence Indicator', category: 'WhatsApp Automation' },
    { key: 'AUTORECORDTYPE', label: 'Hybrid Typing + Recording Presence', category: 'WhatsApp Automation' },
    { key: 'AUTO_STATUS_REACT', label: 'Auto-React to WhatsApp Statuses', category: 'WhatsApp Automation' },
    { key: 'AUTO_STATUS_REPLY', label: 'Auto-Reply to WhatsApp Statuses', category: 'WhatsApp Automation' },
    { key: 'BUTTONMODE', label: 'Interactive Button Messenger Mode', category: 'WhatsApp Automation' },
    { key: 'ANTICALL', label: 'Anti-Call Protection Guard', category: 'WhatsApp Automation' },
    { key: 'AUTO_REAUTH_ENABLED', label: 'Zero-Logout Session Auto-Reauth', category: 'Cloud & Security' }
];

app.get('/api/config/optional', (req, res) => {
    let fileConfig = {};
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch (_) {}

    const userCfg = req.user?.id ? database.getUserConfig(req.user.id) : null;
    const userSettings = userCfg?.settings || {};

    const defaultTrueVariables = ALL_TRUE_VARIABLE_KEYS.map(item => ({
        ...item,
        value: true
    }));

    res.json({
        success: true,
        allTrueByDefault: true,
        defaultTrueVariables,
        supabaseAutoConfigured: {
            configured: true,
            url: simDatabase.SUPABASE_CONFIG.url,
            jwksUrl: simDatabase.SUPABASE_CONFIG.jwksUrl,
            tinyCaption: simDatabase.TINY_CAPTION
        },
        optionalVariables: {
            SESSION_ID: userCfg ? userCfg.sessionId : (fileConfig.SESSION_ID || process.env.SESSION_ID || ''),
            RAILWAY_BACKEND_URL: userCfg ? userCfg.railwayBackendUrl : (fileConfig.RAILWAY_BACKEND_URL || process.env.RAILWAY_BACKEND_URL || ''),
            OWNER_NUMBER: userCfg ? userCfg.ownerNumber : (fileConfig.OWNER_NUMBER || process.env.OWNER_NUMBER || '254141693915'),
            BOT_NAME: userCfg ? userCfg.botName : (fileConfig.BOT_NAME || process.env.BOT_NAME || 'Zaid Ashiq X Ultra V. Coder'),
            PREFIX: userCfg ? userCfg.prefix : (fileConfig.PREFIX || process.env.PREFIX || '.'),
            GIPHY_API_KEY: userSettings.GIPHY_API_KEY ?? (fileConfig.GIPHY_API_KEY || process.env.GIPHY_API_KEY || ''),
            DATABASE_URL: userSettings.DATABASE_URL ?? (fileConfig.DATABASE_URL || process.env.DATABASE_URL || ''),
            MONGO_URI: userSettings.MONGO_URI ?? (fileConfig.MONGO_URI || process.env.MONGO_URI || ''),
            REDIS_URL: userSettings.REDIS_URL ?? (fileConfig.REDIS_URL || process.env.REDIS_URL || '')
        }
    });
});

app.post('/api/config/optional', async (req, res) => {
    const body = req.body || {};
    let current = {};
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch (_) {}

    // Enforce default boolean variables = true unless explicitly overridden
    for (const item of ALL_TRUE_VARIABLE_KEYS) {
        current[item.key] = 'true';
        process.env[item.key] = 'true';
    }

    // Save optional variables if provided (Supabase is auto-configured and never asked manually)
    const optionalKeys = [
        'SESSION_ID',
        'RAILWAY_BACKEND_URL',
        'OWNER_NUMBER',
        'BOT_NAME',
        'PREFIX',
        'GIPHY_API_KEY',
        'DATABASE_URL',
        'MONGO_URI',
        'REDIS_URL'
    ];

    for (const key of optionalKeys) {
        if (body[key] !== undefined) {
            const val = String(body[key] ?? '').trim();
            current[key] = val;
            process.env[key] = val;
        }
    }

    // Persist per-user isolated configuration if authenticated
    let updatedUserCfg = null;
    if (req.user && req.user.id) {
        updatedUserCfg = database.saveUserConfig(req.user.id, {
            botName: body.BOT_NAME,
            ownerNumber: body.OWNER_NUMBER,
            prefix: body.PREFIX,
            sessionId: body.SESSION_ID,
            railwayBackendUrl: body.RAILWAY_BACKEND_URL,
            settings: {
                GIPHY_API_KEY: body.GIPHY_API_KEY,
                DATABASE_URL: body.DATABASE_URL,
                MONGO_URI: body.MONGO_URI,
                REDIS_URL: body.REDIS_URL
            }
        });
    }

    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2), 'utf8');
        let sessionActivated = false;
        if (body.SESSION_ID && String(body.SESSION_ID).trim() && sessionManager?.activateSession) {
            try {
                const act = await sessionManager.activateSession(String(body.SESSION_ID).trim(), body.OWNER_NUMBER);
                if (req.user && act?.cleanNumber) {
                    database.linkUserSession(req.user.id, act.cleanNumber, act.sessionId);
                }
                sessionActivated = true;
            } catch (_) {}
        }
        res.json({
            success: true,
            sessionActivated,
            message: 'All default variables verified as TRUE and saved to your personal dashboard!',
            optionalVariables: {
                SESSION_ID: updatedUserCfg ? updatedUserCfg.sessionId : (current.SESSION_ID || ''),
                RAILWAY_BACKEND_URL: updatedUserCfg ? updatedUserCfg.railwayBackendUrl : (current.RAILWAY_BACKEND_URL || ''),
                OWNER_NUMBER: updatedUserCfg ? updatedUserCfg.ownerNumber : (current.OWNER_NUMBER || '254141693915'),
                BOT_NAME: updatedUserCfg ? updatedUserCfg.botName : (current.BOT_NAME || 'Zaid Ashiq X Ultra V. Coder'),
                PREFIX: updatedUserCfg ? updatedUserCfg.prefix : (current.PREFIX || '.'),
                GIPHY_API_KEY: updatedUserCfg?.settings?.GIPHY_API_KEY ?? (current.GIPHY_API_KEY || ''),
                DATABASE_URL: updatedUserCfg?.settings?.DATABASE_URL ?? (current.DATABASE_URL || ''),
                MONGO_URI: updatedUserCfg?.settings?.MONGO_URI ?? (current.MONGO_URI || ''),
                REDIS_URL: updatedUserCfg?.settings?.REDIS_URL ?? (current.REDIS_URL || '')
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save optional variables: ' + err.message });
    }
});



// ── 9. RAILWAY CLOUD DEPLOYMENT & PERSISTENT VOLUME HUB ─────────────────
// Zero-downtime Railway Healthcheck Endpoint
app.get('/api/health', async (req, res) => {
    const vol = getVolumeDiagnostics();
    const activeSockets = sessionManager ? sessionManager.getActiveSessions() : [];
    const cloudSync = sessionManager?.getCloudSyncStatus
        ? await sessionManager.getCloudSyncStatus().catch(() => ({ configured: false }))
        : { configured: false };
    res.status(200).json({
        status: 'ok',
        service: 'Zaid Ashiq X Ultra V. Coder WhatsApp Automation Suite',
        port: PORT,
        uptimeSeconds: Math.floor(process.uptime()),
        uptimeFormatted: getFormattedUptime(),
        volumeWritable: vol.isWritable,
        volumePath: vol.volumePath,
        sessionFoldersCount: vol.sessionFoldersCount,
        activeSessionsCount: activeSockets.length,
        autoLogoutDisabled: true,
        supabaseConfigured: Boolean(cloudSync.configured),
        supabaseMode: cloudSync.mode || 'local_volume_only',
        timestamp: new Date().toISOString()
    });
});

// Comprehensive Railway Cloud Status, Volume Diagnostics & Manifests
app.get('/api/railway/status', async (req, res) => {
    try {
        const vol = getVolumeDiagnostics();
        const cfg = getMergedConfig();
        const activeSockets = sessionManager ? sessionManager.getActiveSessions() : [];
        const activeSessionId = sessionManager?.getSessionIdForNumber() || process.env.SESSION_ID || '';
        const vaultStats = database.getRecoveredStats();
        const supabaseSync = sessionManager?.getCloudSyncStatus
            ? await sessionManager.getCloudSyncStatus().catch(() => ({ configured: false }))
            : { configured: false };

        const isRailway = Boolean(
            process.env.RAILWAY_ENVIRONMENT ||
            process.env.RAILWAY_ENVIRONMENT_NAME ||
            process.env.RAILWAY_PROJECT_ID ||
            process.env.RAILWAY_SERVICE_ID ||
            process.env.RAILWAY_PUBLIC_DOMAIN
        );

        const safeReadFile = (relPath) => {
            try {
                const full = path.join(__dirname, relPath);
                return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
            } catch (_) {
                return '';
            }
        };

        res.json({
            success: true,
            autoLogoutDisabled: true,
            supabaseSync,
            runtime: {
                isRailway,
                environmentName: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || (isRailway ? 'production' : 'ready-to-deploy'),
                publicDomain: process.env.RAILWAY_PUBLIC_DOMAIN || req.headers.host || `localhost:${PORT}`,
                serviceName: process.env.RAILWAY_SERVICE_NAME || 'zaid-ashiq-ultra-v-coder-suite',
                port: PORT,
                nodeVersion: process.version,
                uptimeFormatted: getFormattedUptime(),
                memoryRssBytes: process.memoryUsage().rss,
                registeredCommandsCount,
                loadedPluginsCount,
                activeSocketsCount: activeSockets.length,
                activeSockets
            },
            volume: {
                ...vol,
                vaultStats
            },
            envDefaults: {
                PORT: String(PORT),
                NODE_ENV: 'production',
                RAILWAY_VOLUME_MOUNT_PATH: '/app/data',
                RAILWAY_BACKEND_URL: cfg.railwayBackendUrl || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ''),
                PERMANENT_AUTH_SECRET: process.env.PERMANENT_AUTH_SECRET || 'zaid-master-permanent-secret-254141693915',
                AUTO_REAUTH_ENABLED: 'true',
                CORS_ORIGIN: '*',
                KEEP_ALIVE_INTERVAL_MS: String(Number(process.env.KEEP_ALIVE_INTERVAL_MS) || 45000),
                BOT_NAME: cfg.botName || 'Zaid Ashiq X Ultra V. Coder',
                BOT_OWNER: cfg.botOwner || 'Zaid Ashiq X Ultra V. Coder',
                OWNER_NUMBER: BACKUP_DESTINATION_NUMBER,
                PREFIX: cfg.prefix || '.',
                COMMAND_MODE: cfg.commandMode || 'public',
                SESSION_ID: activeSessionId,
                TIMEZONE: cfg.timezone || 'Asia/Karachi',
                SUPABASE_URL: simDatabase.SUPABASE_CONFIG.url,
                SUPABASE_PUBLISHABLE_KEY: simDatabase.SUPABASE_CONFIG.publishableKey,
                SUPABASE_SECRET_KEY: simDatabase.SUPABASE_CONFIG.secretKey,
                SUPABASE_JWKS_URL: simDatabase.SUPABASE_CONFIG.jwksUrl,
                SUPABASE_DB_URL: simDatabase.SUPABASE_CONFIG.dbUriEncoded
            },
            bridge: {
                railwayBackendUrl: cfg.railwayBackendUrl || '',
                envBackendUrl: String(process.env.RAILWAY_BACKEND_URL || '').trim().replace(/\/+$/, ''),
                permanentAuthEnabled: true,
                keepAliveIntervalMs: Number(process.env.KEEP_ALIVE_INTERVAL_MS) || 45000
            },
            manifests: {
                railwayAiStudioMd: safeReadFile('RailwayAiStudio.md'),
                railwayJson: safeReadFile('railway.json'),
                dockerfile: safeReadFile('Dockerfile'),
                nixpacksToml: safeReadFile('nixpacks.toml'),
                procfile: safeReadFile('Procfile')
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── 9B. SUPABASE SIM & CNIC DATABASE API (03/+92 & 1-5 CNIC) ─────────────────
app.get('/api/sim-db/status', async (req, res) => {
    try {
        const search = String(req.query.search || '').trim();
        const stats = await simDatabase.getSimDatabaseStats();
        const records = await simDatabase.listAllSimRecords(search, 50);
        res.json({
            success: true,
            stats,
            records,
            tinyCaption: simDatabase.TINY_CAPTION
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sim-db/lookup', async (req, res) => {
    try {
        const q = String(req.query.q || req.query.query || '').trim();
        if (!q) {
            return res.status(400).json({ error: 'Please enter a phone number (03... or +92...) or a 13-digit CNIC (starting 1-5).' });
        }
        const result = await simDatabase.performSimOrCnicLookup(q);
        res.json({
            success: result.ok,
            ...result
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sim-db/lookup', async (req, res) => {
    try {
        const { query, q, recipient, sendToWhatsApp = false } = req.body || {};
        const rawQuery = String(query || q || '').trim();
        if (!rawQuery) {
            return res.status(400).json({ error: 'Please enter a phone number (03... or +92...) or a 13-digit CNIC (starting 1-5).' });
        }
        const result = await simDatabase.performSimOrCnicLookup(rawQuery);
        let sentWhatsApp = false;
        let whatsappTarget = null;

        if (sendToWhatsApp && result.ok) {
            whatsappTarget = toWhatsAppJid(recipient || BACKUP_DESTINATION_NUMBER);
            const sock = sessionManager ? sessionManager.getActiveSocket() : null;
            if (sock && whatsappTarget) {
                const dispatch = await simDatabase.sendSimLookupWhatsAppReply(sock, whatsappTarget, result);
                sentWhatsApp = Boolean(dispatch.sent);
            }
        }

        res.json({
            success: result.ok,
            sentWhatsApp,
            whatsappTarget,
            ...result
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sim-db/records', async (req, res) => {
    try {
        const saved = await simDatabase.saveSimRecord(req.body || {});
        const records = await simDatabase.listAllSimRecords('', 50);
        res.json({
            success: true,
            message: `Saved SIM/CNIC record for ${saved.full_name} (${saved.phone_03}) to Supabase & local mirror!`,
            record: saved,
            records,
            tinyCaption: simDatabase.TINY_CAPTION
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/sim-db/records/:id', async (req, res) => {
    try {
        await simDatabase.deleteSimRecord(req.params.id);
        const records = await simDatabase.listAllSimRecords('', 50);
        res.json({
            success: true,
            message: 'Record deleted.',
            records
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/sim-db/custom-api', (req, res) => {
    try {
        const config = simDatabase.getCustomSimApiConfig();
        res.json({
            success: true,
            config
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sim-db/custom-api', (req, res) => {
    try {
        const { endpoint, apiKey, enabled } = req.body || {};
        const config = simDatabase.setCustomSimApiConfig({ endpoint, apiKey, enabled });
        res.json({
            success: true,
            message: 'Custom SIM API configuration updated successfully!',
            config
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Stream or download HD Image Card (PNG) for any SIM/CNIC record
app.get('/api/sim-db/hd-card', async (req, res) => {
    try {
        const q = String(req.query.q || req.query.query || req.query.number || req.query.phone || '').trim();
        if (!q) {
            return res.status(400).json({ error: 'Query parameter q (phone or CNIC) is required.' });
        }
        const result = await simDatabase.performSimOrCnicLookup(q);
        if (!result || !result.primaryRecord) {
            return res.status(404).json({ error: 'Record not found for HD card generation.' });
        }
        const pngBuf = await simDatabase.generateSimHdCardBuffer(result.primaryRecord, 0);
        if (!pngBuf) {
            return res.status(500).json({ error: 'Failed to render HD image card.' });
        }
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Disposition', `inline; filename="SIM_Card_${String(q).replace(/[^a-zA-Z0-9_\-]/g, '_')}.png"`);
        res.send(pngBuf);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Send SIM HD Image Card + Formatted Text + Interactive Copy Button directly to WhatsApp
app.post('/api/sim-db/send-card', async (req, res) => {
    try {
        const { query, q, recipient, imageBase64 } = req.body || {};
        const rawQuery = String(query || q || '').trim();
        if (!rawQuery) {
            return res.status(400).json({ error: 'Valid phone number or CNIC query is required.' });
        }

        const result = await simDatabase.performSimOrCnicLookup(rawQuery);
        if (!result || !result.ok) {
            return res.status(404).json({ error: 'No SIM/CNIC details found to dispatch.' });
        }

        const targetJid = toWhatsAppJid(recipient || BACKUP_DESTINATION_NUMBER);
        if (!targetJid) {
            return res.status(400).json({ error: 'Valid recipient WhatsApp number is required.' });
        }

        const sock = sessionManager ? sessionManager.getActiveSocket() : null;
        if (!sock) {
            return res.status(503).json({ error: 'WhatsApp socket is not connected. Please pair your device first.' });
        }

        let imageBuffer = null;
        if (imageBase64 && typeof imageBase64 === 'string') {
            imageBuffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        } else {
            imageBuffer = await simDatabase.generateSimHdCardBuffer(result.primaryRecord, 0);
        }

        // 1. Send the HD Image Card with formatted details caption
        await sock.sendMessage(targetJid, {
            image: imageBuffer,
            caption: result.whatsappText
        });

        // 2. Also send interactive cta_copy buttons so recipient can copy directly in WhatsApp
        await simDatabase.sendSimLookupWhatsAppReply(sock, targetJid, result).catch(() => {});

        res.json({
            success: true,
            sentWhatsApp: true,
            recipient: targetJid,
            caption: simDatabase.TINY_CAPTION,
            message: `HD Image Card and SIM data dispatched to ${targetJid} successfully!`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 1-Click Deployable Railway Project Archive (.ZIP) Exporter
app.get('/api/railway/export-zip', (req, res) => {
    try {
        const zip = new AdmZip();
        const rootDir = __dirname;
        const excludedTopDirs = new Set([
            'node_modules',
            '.git',
            '.aistudio',
            'tmp',
            'temp'
        ]);

        const addDirRecursive = (absDir, zipPrefix = '') => {
            const entries = fs.readdirSync(absDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!zipPrefix && excludedTopDirs.has(entry.name)) continue;
                if (entry.name.endsWith('.db-shm') || entry.name.endsWith('.db-wal')) continue;

                const fullPath = path.join(absDir, entry.name);
                const relZipPath = zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name;

                if (entry.isDirectory()) {
                    addDirRecursive(fullPath, relZipPath);
                } else if (entry.isFile()) {
                    try {
                        const stat = fs.statSync(fullPath);
                        // Skip large binary APK inside source zip so the Railway bundle downloads fast
                        if (entry.name.endsWith('.apk') && stat.size > 5 * 1024 * 1024) continue;
                        zip.addFile(relZipPath, fs.readFileSync(fullPath));
                    } catch (_) {}
                }
            }
        };

        addDirRecursive(rootDir, '');
        const zipBuffer = zip.toBuffer();

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="urooj-choudhary-railway-deploy.zip"');
        res.setHeader('Content-Length', zipBuffer.length);
        res.send(zipBuffer);
    } catch (err) {
        console.error('[railway] Export ZIP error:', err.message);
        res.status(500).json({ error: 'Failed to generate Railway deployment bundle: ' + err.message });
    }
});

// ── 10. WHATSAPP STATUS (STORY) UPLOADER SUITE & PRIVACY SELECTOR ───────────

// Get & Save Status Privacy Settings (Everyone in contact | Only share with default setting | Exclude people default setting)
app.get('/api/status/privacy', (req, res) => {
    try {
        const config = statusService.getStatusPrivacyConfig();
        res.json({
            success: true,
            privacy: config
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/status/privacy', (req, res) => {
    try {
        const { defaultMode, onlyShareList, excludeList } = req.body || {};
        const updated = statusService.saveStatusPrivacyConfig({
            defaultMode,
            onlyShareList,
            excludeList
        });
        res.json({
            success: true,
            message: 'Status privacy settings saved!',
            privacy: updated
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Upload media/audio/text directly to WhatsApp Status (status@broadcast)
app.post('/api/status/upload', upload.single('file'), async (req, res) => {
    try {
        const sock = sessionManager ? sessionManager.getActiveSocket() : null;
        if (!sock) {
            return res.status(503).json({
                success: false,
                error: 'WhatsApp device is not connected. Please pair your WhatsApp session in Device Pairing first.'
            });
        }

        const caption = String(req.body?.caption || '').trim();
        const isVoiceNote = req.body?.isVoiceNote === 'true' || req.body?.isVoiceNote === true;
        const text = String(req.body?.text || '').trim();
        const privacyMode = String(req.body?.privacyMode || statusService.getStatusPrivacyConfig().defaultMode || 'everyone').trim();
        const file = req.file;

        // Also update default privacy lists if passed in body
        if (req.body?.onlyShareList !== undefined || req.body?.excludeList !== undefined || req.body?.privacyMode) {
            statusService.saveStatusPrivacyConfig({
                defaultMode: privacyMode,
                ...(req.body?.onlyShareList !== undefined ? { onlyShareList: req.body.onlyShareList } : {}),
                ...(req.body?.excludeList !== undefined ? { excludeList: req.body.excludeList } : {})
            });
        }

        let buffer = file ? file.buffer : null;
        let mimetype = file ? file.mimetype : String(req.body?.mimetype || '');
        let filename = file ? (file.originalname || '') : String(req.body?.filename || '');

        if (!buffer && (req.body?.fileData || req.body?.mediaData)) {
            const rawB64 = String(req.body.fileData || req.body.mediaData);
            const mimeMatch = rawB64.match(/^data:([^;]+);base64,/i);
            if (mimeMatch && !mimetype) mimetype = mimeMatch[1];
            buffer = Buffer.from(rawB64.replace(/^data:.*?;base64,/, ''), 'base64');
        }

        if (!buffer && !text && !caption) {
            return res.status(400).json({
                success: false,
                error: 'Please select a media file (Image, Video, Audio) or enter a caption/text.'
            });
        }

        const result = await statusService.uploadMediaToStatus(sock, {
            buffer,
            mimetype,
            filename,
            caption,
            isVoiceNote,
            text,
            privacyMode,
            source: 'Dashboard Uploader'
        });

        const label = result.type === 'audio'
            ? 'Voice Note Status (PTT)'
            : result.type === 'video'
            ? 'Video Status'
            : result.type === 'image'
            ? 'Photo Status'
            : 'Text Status';

        res.json({
            success: true,
            message: `${label} uploaded to WhatsApp Status (${result.privacyLabel || privacyMode} • ${result.recipientCount || 1} contact(s))!`,
            ...result
        });
    } catch (err) {
        console.error('[statusUpload] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get recent WhatsApp Status uploads
app.get('/api/status/history', (req, res) => {
    try {
        const history = statusService.getStatusUploadHistory();
        res.json({
            success: true,
            history,
            privacy: statusService.getStatusPrivacyConfig()
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── 10B. AUTO-REACT SERVICE API (Status | Clients Msg | Every Msg Even Owner) ─
app.get('/api/autoreact/config', (req, res) => {
    try {
        const config = autoReactService.getAutoReactConfig();
        res.json({
            success: true,
            config
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/autoreact/config', (req, res) => {
    try {
        const updated = autoReactService.saveAutoReactConfig(req.body || {});
        res.json({
            success: true,
            message: 'Auto-React service settings updated!',
            config: updated
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── 11. APPDEPLOY.AI MCP INTEGRATION & AI WEBSITE/APPLICATION BUILDER ───────
const appDeployService = require('./lib/appdeploy/appdeploy.service');

// Simple per-user rate limiter for AI generation & MCP deployment endpoints
const appDeployRateBuckets = new Map();
function checkAppDeployRateLimit(ownerKey, limitPerMin = 20) {
    const now = Date.now();
    const bucket = appDeployRateBuckets.get(ownerKey) || [];
    const recent = bucket.filter(ts => now - ts < 60000);
    if (recent.length >= limitPerMin) return false;
    recent.push(now);
    appDeployRateBuckets.set(ownerKey, recent);
    return true;
}

function getAppDeployOwner(req) {
    return String(req.user?.username || 'zaidashiq').trim();
}

// GET /api/appdeploy/status — Connection state, MCP diagnostics, projects & deployments summary
app.get('/api/appdeploy/status', (req, res) => {
    try {
        const owner = getAppDeployOwner(req);
        const projects = appDeployService.ensureDefaultUserProject(owner);
        const connection = appDeployService.getConnectionStatus(owner);
        const deployments = appDeployService.listDeploymentsByUser(owner);
        const activeProject = projects[0] ? appDeployService.getProjectById(projects[0].id, owner) : null;

        res.json({
            success: true,
            owner,
            connection,
            projects,
            activeProject,
            deployments,
            workflowSteps: appDeployService.WORKFLOW_STEPS,
            deploymentStates: appDeployService.DEPLOYMENT_STATES
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/appdeploy/connect — Connect AppDeploy account ("Use My Account" + MCP handshake probe)
app.post('/api/appdeploy/connect', async (req, res) => {
    try {
        const owner = getAppDeployOwner(req);
        const { accountEmail, accountName, mcpToken, authMode } = req.body || {};
        const connection = await appDeployService.connectUserAppDeployAccount(owner, {
            accountEmail: accountEmail || 'zahidashiqusa@gmail.com',
            accountName: accountName || owner,
            mcpToken: mcpToken || '',
            authMode: authMode || 'my_account'
        });

        res.json({
            success: true,
            message: connection.permissions?.mcpAuthorized
                ? `Connected to AppDeploy MCP (${connection.mcpEndpoint}) with live tool authorization!`
                : `Connected My Account (${connection.accountEmail}). MCP endpoint ${connection.mcpEndpoint} probed via JSON-RPC 2.0.`,
            connection
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/appdeploy/disconnect — Disconnect user's AppDeploy account
app.post('/api/appdeploy/disconnect', (req, res) => {
    try {
        const owner = getAppDeployOwner(req);
        const connection = appDeployService.disconnectUserAppDeployAccount(owner);
        res.json({
            success: true,
            message: 'Disconnected AppDeploy account and cleared stored MCP token.',
            connection
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// GET /api/builder/projects — List user's AI Builder projects
app.get('/api/builder/projects', (req, res) => {
    try {
        const owner = getAppDeployOwner(req);
        const projects = appDeployService.ensureDefaultUserProject(owner);
        res.json({ success: true, projects });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/builder/projects/:id — Get full multi-file project & sandboxed preview bundle
app.get('/api/builder/projects/:id', (req, res) => {
    try {
        const owner = getAppDeployOwner(req);
        const project = appDeployService.getProjectById(req.params.id, owner);
        if (!project) {
            return res.status(404).json({ error: 'Project not found or access denied.' });
        }
        const validation = appDeployService.validateProjectFiles(project.id, owner);
        res.json({ success: true, project, validation });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/builder/generate — Generate a complete multi-file application from natural language
app.post('/api/builder/generate', async (req, res) => {
    try {
        const owner = getAppDeployOwner(req);
        if (!checkAppDeployRateLimit(owner, 15)) {
            return res.status(429).json({ error: 'Rate limit reached. Please wait a moment before generating another application.' });
        }
        const { prompt, name } = req.body || {};
        if (!prompt || !String(prompt).trim()) {
            return res.status(400).json({ error: 'Please describe your website or application idea.' });
        }

        const generated = await appDeployService.generateMultiFileAppWithAI(prompt);
        const project = appDeployService.createProjectRecord(owner, {
            name: name ? String(name).trim() : generated.name,
            description: generated.description,
            prompt: String(prompt).trim(),
            files: generated.files
        });
        const validation = appDeployService.validateProjectFiles(project.id, owner);

        res.json({
            success: true,
            message: `Generated "${project.name}" with ${project.files.length} files (${generated.generatorEngine}).`,
            generatorEngine: generated.generatorEngine,
            project,
            validation,
            projects: appDeployService.listProjectsByUser(owner)
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/builder/projects/:id/edit — Propose natural-language code edits (with review before apply)
app.post('/api/builder/projects/:id/edit', async (req, res) => {
    try {
        const owner = getAppDeployOwner(req);
        const { instruction } = req.body || {};
        const project = await appDeployService.proposeProjectEditsWithAI(req.params.id, owner, instruction);
        res.json({
            success: true,
            message: 'AI code changes prepared! Review the proposed diff below and click "Apply Changes" to update project files.',
            project
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/builder/projects/:id/apply-edits — Apply reviewed AI code edits
app.post('/api/builder/projects/:id/apply-edits', (req, res) => {
    try {
        const owner = getAppDeployOwner(req);
        const project = appDeployService.applyProposedProjectEdits(req.params.id, owner);
        const validation = appDeployService.validateProjectFiles(project.id, owner);
        res.json({
            success: true,
            message: 'Changes applied to project files and Live Preview refreshed!',
            project,
            validation
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/builder/projects/:id/files — Save manual code edit to a single file
app.post('/api/builder/projects/:id/files', (req, res) => {
    try {
        const owner = getAppDeployOwner(req);
        const { filePath, content, language } = req.body || {};
        if (!filePath) {
            return res.status(400).json({ error: 'filePath is required.' });
        }
        const project = appDeployService.updateSingleProjectFile(req.params.id, owner, { filePath, content, language });
        const validation = appDeployService.validateProjectFiles(project.id, owner);
        res.json({
            success: true,
            message: `Saved ${filePath} (v${project.files.find(f => f.file_path === filePath)?.version || 1}).`,
            project,
            validation
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

function getRequestBaseOrigin(req) {
    const host = req.get('host') || '';
    if (!host || host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
        return appDeployService.DEFAULT_PUBLIC_ORIGIN;
    }
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    return `${proto}://${host}`;
}

// POST /api/appdeploy/oauth/start-email — Start Official AppDeploy.ai Email OTP Verification
app.post('/api/appdeploy/oauth/start-email', async (req, res) => {
    try {
        const owner = getAppDeployOwner(req);
        const { email } = req.body || {};
        const result = await appDeployService.startAppDeployEmailOAuth(owner, email || 'zahidashiqusa@gmail.com');
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/appdeploy/oauth/verify-email — Complete Official AppDeploy.ai Email OTP Verification
app.post('/api/appdeploy/oauth/verify-email', async (req, res) => {
    try {
        const owner = getAppDeployOwner(req);
        const { code } = req.body || {};
        const connection = await appDeployService.completeAppDeployEmailOAuth(owner, code || '');
        res.json({
            success: true,
            message: 'AppDeploy.ai OAuth verification completed! Live MCP token stored.',
            connection
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/appdeploy/direct-deploy — Generate code, upload/deploy directly, and return the live project link
app.post('/api/appdeploy/direct-deploy', async (req, res) => {
    try {
        const owner = getAppDeployOwner(req);
        const { prompt, name } = req.body || {};
        if (!prompt || !String(prompt).trim()) {
            return res.status(400).json({ error: 'Please describe your website or application idea.' });
        }
        const baseOrigin = getRequestBaseOrigin(req);
        const result = await appDeployService.generateAndDirectDeployProject(owner, prompt, {
            projectName: name ? String(name).trim() : undefined,
            baseOrigin
        });
        res.json({
            success: true,
            liveUrl: result.liveUrl,
            project: result.project,
            deployment: result.deployment,
            projects: appDeployService.listProjectsByUser(owner),
            deployments: appDeployService.listDeploymentsByUser(owner)
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/appdeploy/deploy — Execute 8-Step One-Click Deployment Workflow & Return Live Link
app.post('/api/appdeploy/deploy', async (req, res) => {
    try {
        const owner = getAppDeployOwner(req);
        const { projectId } = req.body || {};
        if (!projectId) {
            return res.status(400).json({ error: 'projectId is required to deploy.' });
        }
        const baseOrigin = getRequestBaseOrigin(req);
        const deploymentRecord = await appDeployService.executeEightStepDeployment(owner, projectId, { baseOrigin });
        const allDeployments = appDeployService.listDeploymentsByUser(owner);

        res.json({
            success: true,
            liveUrl: deploymentRecord.public_url,
            deployment: deploymentRecord,
            deployments: allDeployments
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// GET /api/appdeploy/deployments — List all deployments for the current user
app.get('/api/appdeploy/deployments', (req, res) => {
    try {
        const owner = getAppDeployOwner(req);
        const deployments = appDeployService.listDeploymentsByUser(owner, req.query.projectId || null);
        res.json({ success: true, deployments });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/appdeploy/deployments/:id — Get specific deployment status, logs & versions
app.get('/api/appdeploy/deployments/:id', (req, res) => {
    try {
        const owner = getAppDeployOwner(req);
        const deploymentRecord = appDeployService.getDeploymentById(req.params.id, owner);
        if (!deploymentRecord) {
            return res.status(404).json({ error: 'Deployment not found.' });
        }
        res.json({ success: true, deployment: deploymentRecord });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/appdeploy/deployments/:id/update — Redeploy updated source code for an existing deployment
app.post('/api/appdeploy/deployments/:id/update', async (req, res) => {
    try {
        const owner = getAppDeployOwner(req);
        const existing = appDeployService.getDeploymentById(req.params.id, owner);
        if (!existing) {
            return res.status(404).json({ error: 'Deployment not found.' });
        }
        const baseOrigin = getRequestBaseOrigin(req);
        const updatedDeployment = await appDeployService.executeEightStepDeployment(owner, existing.project_id, { baseOrigin });
        res.json({
            success: true,
            liveUrl: updatedDeployment.public_url,
            message: `Deployed v${updatedDeployment.version_number}: ${updatedDeployment.public_url}`,
            deployment: updatedDeployment,
            deployments: appDeployService.listDeploymentsByUser(owner)
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// GET /api/appdeploy/deployments/:id/versions — Inspect available deployment versions
app.get('/api/appdeploy/deployments/:id/versions', (req, res) => {
    try {
        const owner = getAppDeployOwner(req);
        const deploymentRecord = appDeployService.getDeploymentById(req.params.id, owner);
        if (!deploymentRecord) {
            return res.status(404).json({ error: 'Deployment not found.' });
        }
        res.json({
            success: true,
            versions: deploymentRecord.versions || []
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/appdeploy/deployments/:id/restore — Restore previous version snapshot
app.post('/api/appdeploy/deployments/:id/restore', (req, res) => {
    try {
        const owner = getAppDeployOwner(req);
        const { versionNumber } = req.body || {};
        const restoredProject = appDeployService.restoreDeploymentVersion(owner, req.params.id, versionNumber);
        res.json({
            success: true,
            message: `Restored project files to version v${versionNumber}!`,
            project: restoredProject
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/appdeploy/self-test — Run 10 Automated Integration Self-Tests
app.post('/api/appdeploy/self-test', async (req, res) => {
    try {
        const owner = getAppDeployOwner(req);
        const report = await appDeployService.runAppDeploySelfTests(owner);
        res.json({
            success: report.failed === 0,
            ...report
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Public Live Hosted Application Route — Serves deployed projects directly at /live/:slug
app.get('/live/:slug', (req, res) => {
    try {
        const hosted = appDeployService.getLiveHostedProjectBySlug(req.params.slug);
        if (!hosted) {
            return res.status(404).send('<!DOCTYPE html><html><head><title>App Not Found</title></head><body style="background:#060a12;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;"><h2>404 — Deployed Application Not Found</h2><p>Check the project link and try again.</p></div></body></html>');
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(hosted.bundledHtml);
    } catch (err) {
        res.status(500).send('Failed to render deployed application: ' + err.message);
    }
});

app.get('/live/:slug/:filename', (req, res) => {
    try {
        const hosted = appDeployService.getLiveHostedProjectBySlug(req.params.slug);
        if (!hosted) {
            return res.status(404).send('Project not found');
        }
        const fileObj = (hosted.files || []).find(f => f.file_path === req.params.filename);
        if (!fileObj) {
            return res.status(404).send('File not found in deployed snapshot');
        }
        const ext = String(req.params.filename).split('.').pop().toLowerCase();
        const mimeMap = {
            html: 'text/html; charset=utf-8',
            css: 'text/css; charset=utf-8',
            js: 'application/javascript; charset=utf-8',
            json: 'application/json; charset=utf-8',
            sql: 'text/plain; charset=utf-8'
        };
        res.setHeader('Content-Type', mimeMap[ext] || 'text/plain; charset=utf-8');
        res.send(fileObj.content);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Direct Android APK Download Endpoint
app.get('/download/apk', (req, res) => {
    const apkPath = path.join(__dirname, 'public/downloads/urooj-choudhary.apk');
    if (fs.existsSync(apkPath)) {
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        res.setHeader('Content-Disposition', 'attachment; filename="urooj-choudhary-v1.1.apk"');
        res.sendFile(apkPath);
    } else {
        res.status(404).send('APK file not found');
    }
});

// SPA fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

// Start Server
const server = app.listen(PORT, HOST, () => {
    console.log(`[Zaid Ashiq X Ultra V. Coder] 👑 Server listening on http://${HOST}:${PORT}`);
    console.log(`[Zaid Ashiq X Ultra V. Coder] 👤 Owner: Zaid Ashiq X Ultra V. Coder (+254141693915)`);
    console.log(`[Zaid Ashiq X Ultra V. Coder] 🪪 Supabase SIM & CNIC Database auto-configured (${simDatabase.SUPABASE_CONFIG.url})`);
    console.log(`[Zaid Ashiq X Ultra V. Coder] 🚀 AppDeploy.ai MCP Studio active (${appDeployService.OFFICIAL_APPDEPLOY_URLS.mcpEndpoint})`);
    console.log(`[Zaid Ashiq X Ultra V. Coder] ⚡ WhatsApp Automation Suite active with ${registeredCommandsCount} commands`);
});

// Background initialization
process.nextTick(async () => {
    try {
        await simDatabase.initSupabaseDatabase();
    } catch (e) {
        console.warn('[Zaid Ashiq X Ultra V. Coder] Supabase init notice:', e.message);
    }

    if (sessionManager && typeof sessionManager.rehydrateSessions === 'function') {
        try {
            await sessionManager.rehydrateSessions();
        } catch (e) {
            console.warn('[Zaid Ashiq X Ultra V. Coder] Rehydration warning:', e.message);
        }
    }

    if (process.env.SESSION_ID && process.env.SESSION_ID.trim()) {
        console.log('[Zaid Ashiq X Ultra V. Coder] Starting bot with configured SESSION_ID...');
        try {
            require('./index.js');
        } catch (err) {
            console.error('[Zaid Ashiq X Ultra V. Coder] Failed to run index.js with SESSION_ID:', err.message);
        }
    } else {
        console.log('[Zaid Ashiq X Ultra V. Coder] Bot in standby. Sign in or register to pair and manage WhatsApp sessions!');
    }
});

// 24/7 Anti-Sleep / Keep-Alive Heartbeat (Prevents socket idle disconnects & keeps Railway container warm)
const KEEP_ALIVE_MS = Number(process.env.KEEP_ALIVE_INTERVAL_MS) || 45000;
setInterval(() => {
    try {
        const cfg = getMergedConfig();
        if (String(cfg.ALWAYSONLINE).toLowerCase() === 'true') {
            const activeSockets = sessionManager ? sessionManager.getActiveSessions() : [];
            if (activeSockets.length > 0 && sessionManager.getActiveSocket) {
                const sock = sessionManager.getActiveSocket();
                if (sock && typeof sock.sendPresenceUpdate === 'function') {
                    sock.sendPresenceUpdate('available').catch(() => {});
                }
            }
        }
    } catch (_) {}
}, KEEP_ALIVE_MS);

// Graceful shutdown
process.on('SIGINT', () => {
    server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
});
