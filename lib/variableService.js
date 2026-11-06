'use strict';

/**
 * Unified Variables Manager Service (Dashboard + WhatsApp .variable Command)
 * Manages all Boolean Toggles, Bot Identity, Automation, Cloud/Database, and Custom Variables
 * Syncs across data/config.json, session config_<sid>.json, process.env, and env.z.env
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR, CONFIG_PATH, ROOT_DIR } = require('./storagePaths');
const { loadConfig, saveConfig } = require('./config');

let sendButtons = null;
try {
    sendButtons = require('kango-wa').sendButtons;
} catch (_) {
    sendButtons = null;
}

const ENV_FILE_PATH = path.join(ROOT_DIR, 'env.z.env');

// Complete catalog of managed variables
const VARIABLE_DEFINITIONS = [
    // ── Boolean / Toggle Variables ──
    {
        key: 'ALWAYSONLINE',
        label: '24/7 Always Online Presence',
        category: 'WhatsApp Presence & Automation',
        type: 'boolean',
        defaultValue: 'false',
        description: 'Keep bot online 24/7 (OFF by default)'
    },
    {
        key: 'AUTOREAD',
        label: 'Auto-Read Incoming Messages',
        category: 'WhatsApp Presence & Automation',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Automatically mark incoming messages as read (blue ticks)'
    },
    {
        key: 'AUTOTYPE',
        label: 'Auto-Typing Presence Indicator',
        category: 'WhatsApp Presence & Automation',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Show typing... indicator when messages arrive'
    },
    {
        key: 'AUTORECORD',
        label: 'Auto-Recording Presence Indicator',
        category: 'WhatsApp Presence & Automation',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Show recording audio... indicator when messages arrive'
    },
    {
        key: 'AUTORECORDTYPE',
        label: 'Hybrid Typing + Recording Presence',
        category: 'WhatsApp Presence & Automation',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Alternate between typing and recording presence'
    },
    {
        key: 'AUTO_STATUS_REACT',
        label: 'Auto-React to WhatsApp Statuses',
        category: 'WhatsApp Status',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Automatically react to contacts WhatsApp status updates'
    },
    {
        key: 'AUTO_STATUS_REPLY',
        label: 'Auto-Reply to WhatsApp Statuses',
        category: 'WhatsApp Status',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Automatically send status reply message when viewing statuses'
    },
    {
        key: 'STATUS_UPLOADER_ENABLED',
        label: 'WhatsApp Status Stories Uploader',
        category: 'WhatsApp Status',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Enable .status command and dashboard status story uploader'
    },
    {
        key: 'STATUS_VOICE_NOTE_ENABLED',
        label: 'Direct Audio-to-Voice Note PTT Status',
        category: 'WhatsApp Status',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Convert audio files into Opus Voice Notes on WhatsApp Status'
    },
    {
        key: 'BUTTONMODE',
        label: 'Interactive Button Messenger Mode',
        category: 'WhatsApp Presence & Automation',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Enable interactive native flow buttons in bot responses'
    },
    {
        key: 'ANTICALL',
        label: 'Anti-Call Protection Guard',
        category: 'WhatsApp Presence & Automation',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Automatically decline incoming WhatsApp voice/video calls'
    },
    {
        key: 'CHATBOT_ENABLED',
        label: 'ChatGPT Auto-Reply Chatbot',
        category: 'WhatsApp Presence & Automation',
        type: 'boolean',
        defaultValue: 'false',
        description: 'Automatic AI/ChatGPT replies to messages (OFF by default)'
    },
    {
        key: 'AUTOREPLY_ENABLED',
        label: 'First-Message DM Auto-Reply',
        category: 'WhatsApp Presence & Automation',
        type: 'boolean',
        defaultValue: 'false',
        description: 'Send automatic away message on first DM (OFF by default)'
    },
    {
        key: 'AUTO_REAUTH_ENABLED',
        label: 'Zero-Logout Session Auto-Reauth',
        category: 'Cloud & Session Persistence',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Automatically reconnect sessions without logging out'
    },
    {
        key: 'NEVER_AUTO_LOGOUT',
        label: 'Never Auto-Logout Sessions',
        category: 'Cloud & Session Persistence',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Prevent automatic deletion of sessions on disconnect or 401'
    },

    // ── Bot Identity & Behaviour Variables ──
    {
        key: 'BOT_NAME',
        label: 'Bot Name',
        category: 'Bot Identity & Behaviour',
        type: 'string',
        defaultValue: 'Zaid Ashiq X Ultra V. Coder',
        description: 'Display name of the WhatsApp bot suite'
    },
    {
        key: 'BOT_OWNER',
        label: 'Bot Owner Name',
        category: 'Bot Identity & Behaviour',
        type: 'string',
        defaultValue: 'Zaid Ashiq X Ultra V. Coder',
        description: 'Owner name displayed across bot menus and cards'
    },
    {
        key: 'OWNER_NUMBER',
        label: 'Owner WhatsApp Number',
        category: 'Bot Identity & Behaviour',
        type: 'string',
        defaultValue: '254141693915',
        description: 'Primary owner WhatsApp phone number (digits with country code)'
    },
    {
        key: 'PREFIX',
        label: 'Command Prefix',
        category: 'Bot Identity & Behaviour',
        type: 'string',
        defaultValue: '.',
        description: 'Command trigger prefix (e.g. . or ! or #)'
    },
    {
        key: 'COMMAND_MODE',
        label: 'Command Mode (public / private)',
        category: 'Bot Identity & Behaviour',
        type: 'string',
        defaultValue: 'public',
        description: 'Bot command access mode (public or private)'
    },
    {
        key: 'TIMEZONE',
        label: 'Bot Timezone',
        category: 'Bot Identity & Behaviour',
        type: 'string',
        defaultValue: 'Asia/Karachi',
        description: 'Timezone for timestamps, cron jobs, and scheduled messages'
    },
    {
        key: 'LANGUAGE',
        label: 'Bot Language',
        category: 'Bot Identity & Behaviour',
        type: 'string',
        defaultValue: 'en',
        description: 'Language code for bot responses (e.g. en)'
    },
    {
        key: 'AUTO_STATUS_MSG',
        label: 'Auto Status Reply Message',
        category: 'WhatsApp Status',
        type: 'string',
        defaultValue: 'Status Viewed by Zaid Ashiq X Ultra V. Coder',
        description: 'Default text sent when AUTO_STATUS_REPLY is enabled'
    },
    {
        key: 'PACK_NAME',
        label: 'Sticker Pack Name',
        category: 'Bot Identity & Behaviour',
        type: 'string',
        defaultValue: 'Zaid Ashiq X Ultra V. Coder',
        description: 'Sticker pack title metadata'
    },
    {
        key: 'PACK_AUTHOR',
        label: 'Sticker Pack Author',
        category: 'Bot Identity & Behaviour',
        type: 'string',
        defaultValue: 'Zaid Ashiq X Ultra V. Coder',
        description: 'Sticker pack author metadata'
    },

    // ── Cloud, Database & External Integrations ──
    {
        key: 'SESSION_ID',
        label: 'WhatsApp Session ID',
        category: 'Cloud & Session Persistence',
        type: 'string',
        defaultValue: '',
        description: 'Optional base64 session token (Urooj~...)'
    },
    {
        key: 'RAILWAY_BACKEND_URL',
        label: 'Railway Backend URL',
        category: 'Cloud & Session Persistence',
        type: 'string',
        defaultValue: '',
        description: 'Optional 24/7 Railway backend URL bridge'
    },
    {
        key: 'KEEP_ALIVE_INTERVAL_MS',
        label: 'Keep-Alive Interval (ms)',
        category: 'Cloud & Session Persistence',
        type: 'string',
        defaultValue: '45000',
        description: 'Heartbeat interval in milliseconds (default 45000)'
    },
    {
        key: 'SIM_DB_API_URL',
        label: 'SIM & CNIC Live API URL',
        category: 'External APIs & Databases',
        type: 'string',
        defaultValue: 'https://sim-db-api.faizankhichi.me/',
        description: 'Endpoint for live Pakistan SIM & CNIC lookups'
    },
    {
        key: 'SUPABASE_URL',
        label: 'Supabase Project URL',
        category: 'External APIs & Databases',
        type: 'string',
        defaultValue: '',
        description: 'Supabase project URL for cloud session dual-sync'
    },
    {
        key: 'SUPABASE_PUBLISHABLE_KEY',
        label: 'Supabase Publishable / Anon Key',
        category: 'External APIs & Databases',
        type: 'string',
        defaultValue: '',
        description: 'Supabase anon/publishable key'
    },
    {
        key: 'SUPABASE_SECRET_KEY',
        label: 'Supabase Secret / Service Role Key',
        category: 'External APIs & Databases',
        type: 'string',
        defaultValue: '',
        description: 'Supabase service_role key for cloud session persistence'
    },
    {
        key: 'SUPABASE_DB_URL',
        label: 'Supabase Postgres Connection URI',
        category: 'External APIs & Databases',
        type: 'string',
        defaultValue: '',
        description: 'Direct PostgreSQL URI for Supabase session dual-sync'
    },
    {
        key: 'DATABASE_URL',
        label: 'PostgreSQL Database URL',
        category: 'External APIs & Databases',
        type: 'string',
        defaultValue: '',
        description: 'Optional external Postgres database connection string'
    },
    {
        key: 'GIPHY_API_KEY',
        label: 'Giphy API Key',
        category: 'External APIs & Databases',
        type: 'string',
        defaultValue: '',
        description: 'Optional API key for GIF search commands'
    },
    {
        key: 'MONGO_URI',
        label: 'MongoDB Connection URI',
        category: 'External APIs & Databases',
        type: 'string',
        defaultValue: '',
        description: 'Optional MongoDB URI'
    },
    {
        key: 'REDIS_URL',
        label: 'Redis Connection URL',
        category: 'External APIs & Databases',
        type: 'string',
        defaultValue: '',
        description: 'Optional Redis cache URL'
    }
];

function normalizeBooleanString(val, fallback = 'false') {
    if (val === undefined || val === null || val === '') return fallback;
    const s = String(val).trim().toLowerCase();
    if (['true', '1', 'on', 'yes', 'enable', 'enabled', 'decline'].includes(s)) return 'true';
    if (['false', '0', 'off', 'no', 'disable', 'disabled'].includes(s)) return 'false';
    return fallback;
}

function readChatbotEnabled(sessionNumber = null) {
    try {
        const file = sessionNumber
            ? path.join(DATA_DIR, `chatbot_${sessionNumber}.json`)
            : path.join(DATA_DIR, 'chatbot.json');
        if (fs.existsSync(file)) {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            return data.enabled === true ? 'true' : 'false';
        }
    } catch (_) {}
    return 'false';
}

function writeChatbotEnabled(enabledBool, sessionNumber = null) {
    try {
        const targets = [path.join(DATA_DIR, 'chatbot.json')];
        if (sessionNumber) targets.push(path.join(DATA_DIR, `chatbot_${sessionNumber}.json`));
        const repoCopy = path.join(ROOT_DIR, 'data', 'chatbot.json');
        if (!targets.includes(repoCopy)) targets.push(repoCopy);

        for (const file of targets) {
            let current = {
                enabled: false,
                mode: 'dm',
                systemPrompt: 'You are Zaid Ashiq X Ultra V. Coder, a friendly WhatsApp bot.',
                replyMode: 'text'
            };
            if (fs.existsSync(file)) {
                try {
                    current = Object.assign(current, JSON.parse(fs.readFileSync(file, 'utf8')));
                } catch (_) {}
            }
            current.enabled = Boolean(enabledBool);
            fs.writeFileSync(file, JSON.stringify(current, null, 2), 'utf8');
        }
    } catch (_) {}
}

function readAutoReplyEnabled(sessionNumber = null) {
    try {
        const file = sessionNumber
            ? path.join(DATA_DIR, `autoreply_${sessionNumber}.json`)
            : path.join(DATA_DIR, 'autoreply.json');
        if (fs.existsSync(file)) {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            return data.enabled === true ? 'true' : 'false';
        }
    } catch (_) {}
    return 'false';
}

function writeAutoReplyEnabled(enabledBool, sessionNumber = null) {
    try {
        const targets = [path.join(DATA_DIR, 'autoreply.json')];
        if (sessionNumber) targets.push(path.join(DATA_DIR, `autoreply_${sessionNumber}.json`));
        for (const file of targets) {
            let current = {
                enabled: false,
                message: "my owners isn't available at the moment you can leave your message",
                seenUsers: []
            };
            if (fs.existsSync(file)) {
                try {
                    current = Object.assign(current, JSON.parse(fs.readFileSync(file, 'utf8')));
                } catch (_) {}
            }
            current.enabled = Boolean(enabledBool);
            fs.writeFileSync(file, JSON.stringify(current, null, 2), 'utf8');
        }
    } catch (_) {}
}

/**
 * Get all variables merged from config.json, session config, process.env, and userCfg
 */
function getAllVariables(options = {}) {
    const { userId = null, sessionNumber = null, database = null } = options;

    let fileConfig = {};
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch (_) {}

    let sessionConfig = {};
    if (sessionNumber) {
        try {
            sessionConfig = loadConfig(sessionNumber) || {};
        } catch (_) {}
    }

    const userCfg = (userId && database && typeof database.getUserConfig === 'function')
        ? database.getUserConfig(userId)
        : null;
    const userSettings = userCfg?.settings || {};

    const valuesMap = {};
    const definedKeys = new Set(VARIABLE_DEFINITIONS.map(d => d.key));

    for (const def of VARIABLE_DEFINITIONS) {
        const k = def.key;
        let rawVal;

        if (k === 'CHATBOT_ENABLED') {
            rawVal = fileConfig.CHATBOT_ENABLED ?? readChatbotEnabled(sessionNumber);
        } else if (k === 'AUTOREPLY_ENABLED') {
            rawVal = fileConfig.AUTOREPLY_ENABLED ?? readAutoReplyEnabled(sessionNumber);
        } else if (k === 'BOT_NAME') {
            rawVal = userCfg?.botName || sessionConfig.BOT_NAME || fileConfig.BOT_NAME || process.env.BOT_NAME || def.defaultValue;
            if (rawVal === 'Urooj Choudhary') rawVal = 'Zaid Ashiq X Ultra V. Coder';
        } else if (k === 'BOT_OWNER') {
            rawVal = userCfg?.botOwner || sessionConfig.BOT_OWNER || fileConfig.BOT_OWNER || process.env.BOT_OWNER || def.defaultValue;
            if (rawVal === 'Urooj Choudhary' || rawVal === 'King Unkown') rawVal = 'Zaid Ashiq X Ultra V. Coder';
        } else if (k === 'OWNER_NUMBER') {
            rawVal = userCfg?.ownerNumber || sessionConfig.OWNER_NUMBER || fileConfig.OWNER_NUMBER || process.env.OWNER_NUMBER || def.defaultValue;
        } else if (k === 'PREFIX') {
            rawVal = userCfg?.prefix || sessionConfig.PREFIX || fileConfig.PREFIX || process.env.PREFIX || def.defaultValue;
        } else if (k === 'SESSION_ID') {
            rawVal = userCfg?.sessionId || fileConfig.SESSION_ID || process.env.SESSION_ID || def.defaultValue;
        } else if (k === 'RAILWAY_BACKEND_URL') {
            rawVal = userCfg?.railwayBackendUrl || fileConfig.RAILWAY_BACKEND_URL || process.env.RAILWAY_BACKEND_URL || def.defaultValue;
        } else {
            rawVal =
                (sessionNumber && sessionConfig[k] !== undefined ? sessionConfig[k] : undefined) ??
                userSettings[k] ??
                fileConfig[k] ??
                process.env[k] ??
                def.defaultValue;
        }

        if (def.type === 'boolean') {
            valuesMap[k] = normalizeBooleanString(rawVal, def.defaultValue);
        } else {
            valuesMap[k] = String(rawVal ?? def.defaultValue);
        }
    }

    // Also include any custom variables stored in fileConfig.CUSTOM_VARIABLES or top-level custom keys
    const customVars = {};
    const ignoredKeys = new Set(['CUSTOM_VARIABLES']);
    for (const [k, v] of Object.entries(fileConfig)) {
        if (!definedKeys.has(k) && !ignoredKeys.has(k) && typeof v !== 'object') {
            customVars[k] = String(v);
            valuesMap[k] = String(v);
        }
    }
    if (fileConfig.CUSTOM_VARIABLES && typeof fileConfig.CUSTOM_VARIABLES === 'object') {
        for (const [k, v] of Object.entries(fileConfig.CUSTOM_VARIABLES)) {
            if (!definedKeys.has(k)) {
                customVars[k] = String(v);
                valuesMap[k] = String(v);
            }
        }
    }

    const detailedList = VARIABLE_DEFINITIONS.map(def => ({
        ...def,
        value: def.type === 'boolean' ? valuesMap[def.key] === 'true' : valuesMap[def.key],
        stringValue: valuesMap[def.key]
    }));

    for (const [ck, cv] of Object.entries(customVars)) {
        const isBool = cv === 'true' || cv === 'false';
        detailedList.push({
            key: ck,
            label: ck.replace(/_/g, ' '),
            category: 'Custom Variables',
            type: isBool ? 'boolean' : 'string',
            defaultValue: cv,
            description: 'Custom user-defined variable',
            value: isBool ? cv === 'true' : cv,
            stringValue: cv,
            isCustom: true
        });
    }

    return {
        variables: detailedList,
        valuesMap,
        booleanVariables: detailedList.filter(v => v.type === 'boolean'),
        stringVariables: detailedList.filter(v => v.type !== 'boolean')
    };
}

/**
 * Sync updated key-values into env.z.env if writable
 */
function syncEnvZFile(updatesMap) {
    try {
        if (!fs.existsSync(ENV_FILE_PATH)) return;
        let content = fs.readFileSync(ENV_FILE_PATH, 'utf8');
        for (const [rawKey, rawVal] of Object.entries(updatesMap)) {
            const key = String(rawKey).trim();
            if (!/^[A-Z0-9_]+$/i.test(key)) continue;
            const cleanVal = String(rawVal ?? '').replace(/[\r\n]+/g, ' ').trim();
            const regex = new RegExp(`^${key}=.*$`, 'm');
            if (regex.test(content)) {
                content = content.replace(regex, `${key}=${cleanVal}`);
            } else {
                content = content.trimEnd() + `\n${key}=${cleanVal}\n`;
            }
        }
        fs.writeFileSync(ENV_FILE_PATH, content, 'utf8');
    } catch (_) {}
}

/**
 * Update one or multiple variables and persist across all stores
 */
function updateVariables(updates = {}, options = {}) {
    const { userId = null, sessionNumber = null, database = null, sock = null } = options;

    let current = {};
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch (_) {}

    const defMap = new Map(VARIABLE_DEFINITIONS.map(d => [d.key.toUpperCase(), d]));
    const applied = {};
    const envUpdates = {};

    for (const [rawKey, rawValue] of Object.entries(updates)) {
        if (rawValue === undefined || rawValue === null) continue;
        const upperKey = String(rawKey).trim().toUpperCase();
        if (!upperKey) continue;

        const def = defMap.get(upperKey);
        let finalStr;
        if (def && def.type === 'boolean') {
            finalStr = normalizeBooleanString(rawValue, def.defaultValue);
        } else {
            const str = String(rawValue).trim();
            if (['on', 'enable', 'enabled'].includes(str.toLowerCase()) && !def) {
                finalStr = 'true';
            } else if (['off', 'disable', 'disabled'].includes(str.toLowerCase()) && !def) {
                finalStr = 'false';
            } else {
                finalStr = str;
            }
        }

        current[upperKey] = finalStr;
        process.env[upperKey] = finalStr;
        applied[upperKey] = finalStr;
        envUpdates[upperKey] = finalStr;

        if (upperKey === 'CHATBOT_ENABLED') {
            writeChatbotEnabled(finalStr === 'true', sessionNumber);
        }
        if (upperKey === 'AUTOREPLY_ENABLED') {
            writeAutoReplyEnabled(finalStr === 'true', sessionNumber);
        }
        if (upperKey === 'ALWAYSONLINE' && sock && typeof sock.sendPresenceUpdate === 'function') {
            sock.sendPresenceUpdate(finalStr === 'true' ? 'available' : 'unavailable').catch(() => {});
        }
    }

    // Save main CONFIG_PATH
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2), 'utf8');
    } catch (_) {}

    // Also sync to repo ./data/config.json if writable
    try {
        const repoConfigPath = path.join(ROOT_DIR, 'data', 'config.json');
        if (repoConfigPath !== CONFIG_PATH && fs.existsSync(path.dirname(repoConfigPath))) {
            fs.writeFileSync(repoConfigPath, JSON.stringify(current, null, 2), 'utf8');
        }
    } catch (_) {}

    // Sync to per-session config_<sid>.json if active
    try {
        const sid = sessionNumber || (sock && sock._sessionNumber) || null;
        if (sid) {
            const sessCfg = loadConfig(sid) || {};
            for (const [k, v] of Object.entries(applied)) {
                sessCfg[k] = v;
            }
            saveConfig(sessCfg, sid);
        }
        // Also update any other existing config_<sid>.json files in DATA_DIR so dashboard changes apply immediately
        if (fs.existsSync(DATA_DIR)) {
            const files = fs.readdirSync(DATA_DIR);
            for (const f of files) {
                if (/^config_\d+\.json$/.test(f)) {
                    const fp = path.join(DATA_DIR, f);
                    try {
                        const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
                        Object.assign(parsed, applied);
                        fs.writeFileSync(fp, JSON.stringify(parsed, null, 2), 'utf8');
                    } catch (_) {}
                }
            }
        }
    } catch (_) {}

    // Sync to SQLite user_configs if userId or default admin (1)
    try {
        const dbMod = database || require('./database');
        const targetUid = userId || 1;
        if (dbMod && typeof dbMod.saveUserConfig === 'function') {
            dbMod.saveUserConfig(targetUid, {
                botName: applied.BOT_NAME,
                botOwner: applied.BOT_OWNER,
                ownerNumber: applied.OWNER_NUMBER,
                prefix: applied.PREFIX,
                sessionId: applied.SESSION_ID,
                railwayBackendUrl: applied.RAILWAY_BACKEND_URL,
                settings: applied
            });
        }
    } catch (_) {}

    // Sync to env.z.env
    syncEnvZFile(envUpdates);

    return {
        applied,
        ...getAllVariables({ userId, sessionNumber, database })
    };
}

/**
 * Delete a custom variable
 */
function deleteCustomVariable(key) {
    const upperKey = String(key || '').trim().toUpperCase();
    if (!upperKey) return false;
    const isBuiltIn = VARIABLE_DEFINITIONS.some(d => d.key === upperKey);
    if (isBuiltIn) {
        throw new Error(`${upperKey} is a built-in system variable and cannot be deleted (you can change its value instead).`);
    }
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            delete current[upperKey];
            if (current.CUSTOM_VARIABLES) delete current.CUSTOM_VARIABLES[upperKey];
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2), 'utf8');
        }
        delete process.env[upperKey];
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Helper to send clean button message with NO caption/footer
 */
async function sendCleanVariableButtons(sock, chatId, text, buttons, quotedMsg) {
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
 * Handle WhatsApp .variable / .variables / .setvar / .getvar command & button replies
 */
async function handleVariableCommand(sock, chatId, message, rawText = '') {
    const sid = sock?._sessionNumber || null;
    const trimmed = String(rawText || '').trim();

    // Check if this is a button callback like .var_select:KEY or .var_set:KEY:VALUE
    const selectMatch = trimmed.match(/^[.!#/]?\s*var_select:([A-Z0-9_]+)$/i);
    if (selectMatch) {
        const targetKey = selectMatch[1].toUpperCase();
        const { variables } = getAllVariables({ sessionNumber: sid });
        const found = variables.find(v => v.key === targetKey);
        if (!found) {
            await sock.sendMessage(chatId, { text: `❌ Variable *${targetKey}* not found.` }, { quoted: message });
            return true;
        }
        if (found.type === 'boolean') {
            const statusLabel = found.value ? 'ON ✅' : 'OFF ❌';
            const msgText =
                `⚙️ *${found.key}*\n` +
                `📝 ${found.label}\n` +
                `📊 Current Status: *${statusLabel}*\n\n` +
                `Select ON or OFF below:`;
            await sendCleanVariableButtons(sock, chatId, msgText, [
                { id: `.var_set:${found.key}:true`, text: `${found.key} ON` },
                { id: `.var_set:${found.key}:false`, text: `${found.key} OFF` }
            ], message);
        } else {
            await sock.sendMessage(chatId, {
                text:
                    `⚙️ *${found.key}*\n` +
                    `📝 ${found.label}\n` +
                    `📊 Current Value: \`${found.stringValue || '(empty)'}\`\n\n` +
                    `To change this variable, type:\n` +
                    `\`.variable ${found.key} <new_value>\``
            }, { quoted: message });
        }
        return true;
    }

    const setBtnMatch = trimmed.match(/^[.!#/]?\s*var_set:([A-Z0-9_]+):(true|false|on|off)$/i);
    if (setBtnMatch) {
        const targetKey = setBtnMatch[1].toUpperCase();
        const targetVal = ['true', 'on'].includes(setBtnMatch[2].toLowerCase()) ? 'true' : 'false';
        updateVariables({ [targetKey]: targetVal }, { sessionNumber: sid, sock });
        const stateText = targetVal === 'true' ? 'ON ✅' : 'OFF ❌';
        await sock.sendMessage(chatId, {
            text: `✅ *${targetKey}* is now set to *${stateText}*`
        }, { quoted: message });
        return true;
    }

    // Parse command body after .variable / .variables / .setvar / .getvar / .var
    const body = trimmed.replace(/^[.!#/]?\s*(?:variables?|setvar|getvar|var)\b/i, '').trim();

    // 1. No args -> Show full overview of all variables + quick action buttons
    if (!body) {
        const { booleanVariables, stringVariables } = getAllVariables({ sessionNumber: sid });

        const boolLines = booleanVariables.map(v => {
            const icon = v.value ? '✅ ON' : '❌ OFF';
            return `• *${v.key}*: ${icon}`;
        }).join('\n');

        const coreStringKeys = [
            'BOT_NAME', 'BOT_OWNER', 'OWNER_NUMBER', 'PREFIX',
            'COMMAND_MODE', 'TIMEZONE', 'AUTO_STATUS_MSG', 'PACK_NAME'
        ];
        const strLines = stringVariables
            .filter(v => coreStringKeys.includes(v.key) || v.isCustom)
            .map(v => `• *${v.key}*: \`${v.stringValue || '(not set)'}\``)
            .join('\n');

        const menuText =
            `🧩 *Zaid Ashiq X Ultra V. Coder — Variables Manager*\n\n` +
            `*━━━ BOOLEAN TOGGLES ━━━*\n` +
            `${boolLines}\n\n` +
            `*━━━ BOT & SYSTEM VARIABLES ━━━*\n` +
            `${strLines}\n\n` +
            `*━━━ HOW TO MANAGE (.variable) ━━━*\n` +
            `• Toggle ON/OFF: \`.variable ALWAYSONLINE on\` or \`.variable ALWAYSONLINE off\`\n` +
            `• Change value: \`.variable PREFIX !\` or \`.variable BOT_NAME MyBot\`\n` +
            `• Inspect one variable: \`.variable ALWAYSONLINE\``;

        await sendCleanVariableButtons(sock, chatId, menuText, [
            { id: '.var_select:ALWAYSONLINE', text: 'Always Online ON/OFF' },
            { id: '.var_select:AUTOREAD', text: 'Auto Read ON/OFF' },
            { id: '.var_select:AUTO_STATUS_REACT', text: 'Status React ON/OFF' }
        ], message);
        return true;
    }

    // 2. Check if user passed KEY=VALUE or KEY VALUE
    let keyPart = '';
    let valPart = '';

    if (body.includes('=')) {
        const idx = body.indexOf('=');
        keyPart = body.slice(0, idx).trim().toUpperCase();
        valPart = body.slice(idx + 1).trim();
    } else {
        const tokens = body.split(/\s+/);
        keyPart = (tokens[0] || '').trim().toUpperCase();
        valPart = tokens.slice(1).join(' ').trim();
    }

    const { variables } = getAllVariables({ sessionNumber: sid });
    const existingVar = variables.find(v => v.key.toUpperCase() === keyPart);

    // If only KEY was provided (no value), inspect that variable and show ON/OFF buttons if boolean
    if (!valPart) {
        if (!existingVar) {
            await sock.sendMessage(chatId, {
                text:
                    `ℹ️ Variable *${keyPart}* is not set yet.\n\n` +
                    `To create or set it, type:\n` +
                    `\`.variable ${keyPart} <value>\``
            }, { quoted: message });
            return true;
        }

        if (existingVar.type === 'boolean') {
            const statusLabel = existingVar.value ? 'ON ✅' : 'OFF ❌';
            const msgText =
                `⚙️ *${existingVar.key}*\n` +
                `📝 ${existingVar.label}\n` +
                `📊 Current Status: *${statusLabel}*\n\n` +
                `Tap a button below to turn it ON or OFF:`;
            await sendCleanVariableButtons(sock, chatId, msgText, [
                { id: `.var_set:${existingVar.key}:true`, text: `${existingVar.key} ON` },
                { id: `.var_set:${existingVar.key}:false`, text: `${existingVar.key} OFF` }
            ], message);
        } else {
            await sock.sendMessage(chatId, {
                text:
                    `⚙️ *${existingVar.key}*\n` +
                    `📝 ${existingVar.label}\n` +
                    `📊 Current Value: \`${existingVar.stringValue || '(empty)'}\`\n\n` +
                    `To update it, type:\n` +
                    `\`.variable ${existingVar.key} <new_value>\``
            }, { quoted: message });
        }
        return true;
    }

    // 3. Both KEY and VALUE provided -> Update variable immediately
    const result = updateVariables({ [keyPart]: valPart }, { sessionNumber: sid, sock });
    const newVal = result.applied[keyPart];
    const updatedDef = result.variables.find(v => v.key === keyPart);

    if (updatedDef && updatedDef.type === 'boolean') {
        const badge = newVal === 'true' ? 'ON ✅' : 'OFF ❌';
        const confirmText =
            `✅ *Variable Updated*\n\n` +
            `• *Variable:* \`${keyPart}\`\n` +
            `• *New Status:* *${badge}*`;
        await sendCleanVariableButtons(sock, chatId, confirmText, [
            { id: `.var_set:${keyPart}:true`, text: `${keyPart} ON` },
            { id: `.var_set:${keyPart}:false`, text: `${keyPart} OFF` }
        ], message);
    } else {
        await sock.sendMessage(chatId, {
            text:
                `✅ *Variable Updated*\n\n` +
                `• *Variable:* \`${keyPart}\`\n` +
                `• *New Value:* \`${newVal}\``
        }, { quoted: message });
    }
    return true;
}

module.exports = {
    VARIABLE_DEFINITIONS,
    getAllVariables,
    updateVariables,
    deleteCustomVariable,
    handleVariableCommand
};
