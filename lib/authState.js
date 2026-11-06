'use strict';
/**
 * lib/authState.js — Dual-Sync Session Storage (Railway Persistent Volume + Supabase Cloud)
 *
 * Capabilities:
 * 1. Dual-Sync Write-Through: Saves every WhatsApp session (creds + signal keys + Urooj~ token)
 *    simultaneously to Railway persistent disk (/app/data/sessions/<number>) AND Supabase Cloud.
 * 2. Dual Supabase Connection Modes:
 *    - Mode A (PostgreSQL URI): Uses SUPABASE_DB_URL or DATABASE_URL via pg.Pool (auto-creates tables).
 *    - Mode B (Supabase REST URL + Key): Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEY /
 *      SUPABASE_PUBLISHABLE_KEY / SUPABASE_KEY via PostgREST API.
 * 3. Startup Cloud Rehydration: Restores sessions from Supabase onto Railway disk if a container
 *    is redeployed or moved across hosts.
 * 4. Zero Auto-Logout Protection: Never automatically deletes credentials on disconnect.
 */

const path = require('path');
const fs   = require('fs');
const { Pool } = require('pg');
const { SESSIONS_DIR, DATA_DIR, CONFIG_PATH } = require('./storagePaths');

const {
    useMultiFileAuthState,
    initAuthCreds,
    BufferJSON,
} = require('@whiskeysockets/baileys');

const serialize   = (v) => JSON.stringify(v, BufferJSON.replacer);
const deserialize = (s) => JSON.parse(s, BufferJSON.reviver);

// =============================================================================
// SUPABASE DUAL-MODE ENGINE (Postgres Pool + PostgREST HTTP API)
// =============================================================================
let _pgPool = null;
let _pgPoolUrl = null;
let _pgTablesReady = false;
let _lastSupabaseSyncAt = null;
let _lastSupabaseError = null;
let _supabaseSyncedSessions = new Set();

function readSavedCloudConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch (_) {}
    return {};
}

function getSupabaseCredentials() {
    const fileCfg = readSavedCloudConfig();

    const supabaseUrl = String(
        process.env.SUPABASE_URL ||
        fileCfg.SUPABASE_URL ||
        ''
    ).trim().replace(/\/+$/, '');

    const supabaseKey = String(
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.SUPABASE_SECRET_KEY ||
        process.env.SUPABASE_KEY ||
        process.env.SUPABASE_PUBLISHABLE_KEY ||
        process.env.SUPABASE_ANON_KEY ||
        fileCfg.SUPABASE_SERVICE_ROLE_KEY ||
        fileCfg.SUPABASE_SECRET_KEY ||
        fileCfg.SUPABASE_KEY ||
        fileCfg.SUPABASE_PUBLISHABLE_KEY ||
        ''
    ).trim();

    let supabaseDbUrl = String(
        process.env.SUPABASE_DB_URL ||
        process.env.DATABASE_URL ||
        fileCfg.SUPABASE_DB_URL ||
        fileCfg.DATABASE_URL ||
        ''
    ).trim();

    // Strip sslmode from URL so pg Pool ssl config handles TLS cleanly without self-signed cert errors
    if (supabaseDbUrl && supabaseDbUrl.startsWith('postgres')) {
        supabaseDbUrl = supabaseDbUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/[?&]$/, '');
    } else {
        supabaseDbUrl = '';
    }

    const hasPostgresUri = Boolean(supabaseDbUrl);
    const hasRestApi = Boolean(supabaseUrl && supabaseKey && supabaseUrl.startsWith('http'));

    return {
        supabaseUrl,
        supabaseKey,
        supabaseDbUrl,
        hasPostgresUri,
        hasRestApi,
        isConfigured: hasPostgresUri || hasRestApi,
        mode: hasPostgresUri && hasRestApi
            ? 'postgres+rest'
            : hasPostgresUri
            ? 'postgres_uri'
            : hasRestApi
            ? 'rest_api'
            : 'local_volume_only'
    };
}

async function getPgPool() {
    const { supabaseDbUrl, hasPostgresUri } = getSupabaseCredentials();
    if (!hasPostgresUri) return null;

    if (_pgPool && _pgPoolUrl === supabaseDbUrl) {
        return _pgPool;
    }

    if (_pgPool) {
        try { await _pgPool.end(); } catch (_) {}
        _pgPool = null;
        _pgTablesReady = false;
    }

    try {
        const pool = new Pool({
            connectionString: supabaseDbUrl,
            ssl: { require: true, rejectUnauthorized: false },
            max: 6,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000
        });

        pool.on('error', (err) => {
            _lastSupabaseError = err.message;
        });

        // Verify connection and auto-provision tables
        await pool.query(`
            CREATE TABLE IF NOT EXISTS auth_creds (
                "sessionId" VARCHAR(64) PRIMARY KEY,
                data TEXT NOT NULL,
                "sessionToken" TEXT,
                "updatedAt" TIMESTAMPTZ DEFAULT NOW()
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS auth_keys (
                "sessionId" VARCHAR(64) NOT NULL,
                type VARCHAR(32) NOT NULL,
                "keyId" VARCHAR(128) NOT NULL,
                data TEXT NOT NULL,
                PRIMARY KEY ("sessionId", type, "keyId")
            );
        `);

        // Ensure optional columns exist if table was created by older schema
        await pool.query(`ALTER TABLE auth_creds ADD COLUMN IF NOT EXISTS "sessionToken" TEXT;`).catch(() => {});
        await pool.query(`ALTER TABLE auth_creds ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ DEFAULT NOW();`).catch(() => {});

        _pgPool = pool;
        _pgPoolUrl = supabaseDbUrl;
        _pgTablesReady = true;
        _lastSupabaseError = null;
        return _pgPool;
    } catch (err) {
        _lastSupabaseError = err.message;
        console.warn('[authState] Supabase PostgreSQL URI connection warning:', err.message);
        return null;
    }
}

/**
 * Helper for Supabase PostgREST calls when SUPABASE_URL + SUPABASE_KEY is configured
 */
async function supabaseRestRequest(table, { method = 'GET', query = '', body = null, prefer = '' } = {}) {
    const { supabaseUrl, supabaseKey, hasRestApi } = getSupabaseCredentials();
    if (!hasRestApi) return null;

    const url = `${supabaseUrl}/rest/v1/${table}${query ? `?${query}` : ''}`;
    const headers = {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json'
    };
    if (prefer) headers['Prefer'] = prefer;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const res = await fetch(url, {
            method,
            headers,
            body: body !== null ? JSON.stringify(body) : undefined,
            signal: controller.signal
        });
        clearTimeout(timer);
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status}: ${errText.slice(0, 160)}`);
        }
        const text = await res.text();
        return text ? JSON.parse(text) : [];
    } catch (err) {
        clearTimeout(timer);
        _lastSupabaseError = err.message;
        return null;
    }
}

/**
 * Save credentials blob to Supabase (via Postgres Pool and/or REST API)
 */
async function syncCredsToSupabase(sessionId, credsObj, sessionToken = null) {
    if (!sessionId || !credsObj) return false;
    const serialized = typeof credsObj === 'string' ? credsObj : serialize(credsObj);
    const { isConfigured, hasPostgresUri, hasRestApi } = getSupabaseCredentials();
    if (!isConfigured) return false;

    let ok = false;

    // 1. Try PostgreSQL URI Pool
    if (hasPostgresUri) {
        try {
            const pool = await getPgPool();
            if (pool) {
                await pool.query(
                    `INSERT INTO auth_creds ("sessionId", data, "sessionToken", "updatedAt")
                     VALUES ($1, $2, COALESCE($3, (SELECT "sessionToken" FROM auth_creds WHERE "sessionId" = $1)), NOW())
                     ON CONFLICT ("sessionId") DO UPDATE
                     SET data = EXCLUDED.data,
                         "sessionToken" = COALESCE(EXCLUDED."sessionToken", auth_creds."sessionToken"),
                         "updatedAt" = NOW()`,
                    [String(sessionId), serialized, sessionToken]
                );
                ok = true;
            }
        } catch (err) {
            _lastSupabaseError = err.message;
        }
    }

    // 2. Try Supabase PostgREST API if Postgres didn't succeed (or if only REST is configured)
    if (!ok && hasRestApi) {
        const payload = {
            sessionId: String(sessionId),
            data: serialized
        };
        const res = await supabaseRestRequest('auth_creds', {
            method: 'POST',
            query: 'on_conflict=sessionId',
            body: payload,
            prefer: 'resolution=merge-duplicates,return=minimal'
        });
        if (res !== null) ok = true;
    }

    if (ok) {
        _lastSupabaseSyncAt = new Date().toISOString();
        _supabaseSyncedSessions.add(String(sessionId));
        _lastSupabaseError = null;
    }
    return ok;
}

/**
 * Fetch credentials from Supabase for a given sessionId
 */
async function getCredsFromSupabase(sessionId) {
    if (!sessionId) return null;
    const { isConfigured, hasPostgresUri, hasRestApi } = getSupabaseCredentials();
    if (!isConfigured) return null;

    if (hasPostgresUri) {
        try {
            const pool = await getPgPool();
            if (pool) {
                const { rows } = await pool.query(
                    `SELECT data, "sessionToken" FROM auth_creds WHERE "sessionId" = $1 LIMIT 1`,
                    [String(sessionId)]
                );
                if (rows && rows[0] && rows[0].data) {
                    return {
                        creds: deserialize(rows[0].data),
                        raw: rows[0].data,
                        sessionToken: rows[0].sessionToken || null
                    };
                }
            }
        } catch (err) {
            _lastSupabaseError = err.message;
        }
    }

    if (hasRestApi) {
        const rows = await supabaseRestRequest('auth_creds', {
            method: 'GET',
            query: `sessionId=eq.${encodeURIComponent(String(sessionId))}&select=data&limit=1`
        });
        if (Array.isArray(rows) && rows[0]?.data) {
            try {
                return {
                    creds: deserialize(rows[0].data),
                    raw: rows[0].data,
                    sessionToken: null
                };
            } catch (_) {}
        }
    }

    return null;
}

/**
 * Sync signal keys batch to Supabase
 * Note: To honor "never logout any session automatically", we only upsert non-null keys
 * during normal runtime so transient signal key resets cannot corrupt cloud backup.
 */
async function syncKeysToSupabase(sessionId, dataMap) {
    if (!sessionId || !dataMap) return false;
    const { isConfigured, hasPostgresUri, hasRestApi } = getSupabaseCredentials();
    if (!isConfigured) return false;

    const upserts = [];
    for (const [type, keyMap] of Object.entries(dataMap || {})) {
        for (const [keyId, value] of Object.entries(keyMap || {})) {
            if (value != null) {
                upserts.push({
                    sessionId: String(sessionId),
                    type: String(type),
                    keyId: String(keyId),
                    data: serialize(value)
                });
            }
        }
    }
    if (upserts.length === 0) return true;

    let ok = false;
    if (hasPostgresUri) {
        try {
            const pool = await getPgPool();
            if (pool) {
                for (const item of upserts) {
                    await pool.query(
                        `INSERT INTO auth_keys ("sessionId", type, "keyId", data)
                         VALUES ($1, $2, $3, $4)
                         ON CONFLICT ("sessionId", type, "keyId") DO UPDATE SET data = EXCLUDED.data`,
                        [item.sessionId, item.type, item.keyId, item.data]
                    );
                }
                ok = true;
            }
        } catch (err) {
            _lastSupabaseError = err.message;
        }
    }

    if (!ok && hasRestApi) {
        const res = await supabaseRestRequest('auth_keys', {
            method: 'POST',
            query: 'on_conflict=sessionId,type,keyId',
            body: upserts,
            prefer: 'resolution=merge-duplicates,return=minimal'
        });
        if (res !== null) ok = true;
    }

    if (ok) {
        _lastSupabaseSyncAt = new Date().toISOString();
    }
    return ok;
}

/**
 * Fetch specific signal keys from Supabase when missing on local disk
 */
async function getKeysFromSupabase(sessionId, type, ids = []) {
    const result = {};
    if (!sessionId || !type || !ids || ids.length === 0) return result;
    const { isConfigured, hasPostgresUri, hasRestApi } = getSupabaseCredentials();
    if (!isConfigured) return result;

    if (hasPostgresUri) {
        try {
            const pool = await getPgPool();
            if (pool) {
                const { rows } = await pool.query(
                    `SELECT "keyId", data FROM auth_keys WHERE "sessionId" = $1 AND type = $2 AND "keyId" = ANY($3)`,
                    [String(sessionId), String(type), ids.map(String)]
                );
                for (const r of rows || []) {
                    try { result[r.keyId] = deserialize(r.data); } catch (_) {}
                }
                return result;
            }
        } catch (_) {}
    }

    if (hasRestApi) {
        const inList = ids.map(id => `"${String(id).replace(/"/g, '')}"`).join(',');
        const rows = await supabaseRestRequest('auth_keys', {
            method: 'GET',
            query: `sessionId=eq.${encodeURIComponent(String(sessionId))}&type=eq.${encodeURIComponent(String(type))}&keyId=in.(${encodeURIComponent(inList)})&select=keyId,data`
        });
        if (Array.isArray(rows)) {
            for (const r of rows) {
                try { result[r.keyId] = deserialize(r.data); } catch (_) {}
            }
        }
    }
    return result;
}

/**
 * List all sessionIds stored in Supabase auth_creds table for automatic startup rehydration
 */
async function listSupabaseSessionIds() {
    const { isConfigured, hasPostgresUri, hasRestApi } = getSupabaseCredentials();
    if (!isConfigured) return [];

    const ids = new Set();
    if (hasPostgresUri) {
        try {
            const pool = await getPgPool();
            if (pool) {
                const { rows } = await pool.query(`SELECT "sessionId" FROM auth_creds LIMIT 100`);
                for (const r of rows || []) {
                    if (r.sessionId) ids.add(String(r.sessionId).trim());
                }
            }
        } catch (err) {
            _lastSupabaseError = err.message;
        }
    }

    if (ids.size === 0 && hasRestApi) {
        const rows = await supabaseRestRequest('auth_creds', {
            method: 'GET',
            query: 'select=sessionId&limit=100'
        });
        if (Array.isArray(rows)) {
            for (const r of rows) {
                if (r.sessionId) ids.add(String(r.sessionId).trim());
            }
        }
    }

    for (const id of ids) _supabaseSyncedSessions.add(id);
    return Array.from(ids);
}

/**
 * Pull a session from Supabase and write its creds.json onto the Railway persistent disk
 */
async function pullSupabaseSessionToLocal(sessionId, sessionDir) {
    const cleanId = String(sessionId || '').trim();
    if (!cleanId) return false;
    const targetDir = sessionDir || path.join(SESSIONS_DIR, cleanId);
    fs.mkdirSync(targetDir, { recursive: true });

    const remote = await getCredsFromSupabase(cleanId);
    if (!remote || !remote.raw) return false;

    const credsPath = path.join(targetDir, 'creds.json');
    fs.writeFileSync(credsPath, remote.raw, 'utf8');

    if (remote.sessionToken) {
        try {
            fs.writeFileSync(path.join(targetDir, 'session_id.txt'), remote.sessionToken, 'utf8');
        } catch (_) {}
    }

    console.log(`[authState] ☁️ Restored session +${cleanId} from Supabase to Railway Volume (${targetDir})`);
    return true;
}

/**
 * Push an existing local session folder (creds.json + session_id.txt) to Supabase
 */
async function syncLocalSessionToSupabase(sessionId, sessionDir, explicitToken = null) {
    const cleanId = String(sessionId || '').trim();
    if (!cleanId) return false;
    const targetDir = sessionDir || path.join(SESSIONS_DIR, cleanId);
    const credsPath = path.join(targetDir, 'creds.json');
    if (!fs.existsSync(credsPath)) return false;

    try {
        const rawCreds = fs.readFileSync(credsPath, 'utf8');
        let token = explicitToken;
        if (!token) {
            const tokenPath = path.join(targetDir, 'session_id.txt');
            if (fs.existsSync(tokenPath)) {
                token = fs.readFileSync(tokenPath, 'utf8').trim();
            }
        }
        return await syncCredsToSupabase(cleanId, rawCreds, token);
    } catch (err) {
        _lastSupabaseError = err.message;
        return false;
    }
}

/**
 * Delete a session from Supabase — ONLY called when user manually clicks Delete/Revoke/Clear
 */
async function deleteSessionFromSupabase(sessionId) {
    if (!sessionId) return false;
    const cleanId = String(sessionId).trim();
    _supabaseSyncedSessions.delete(cleanId);

    const { isConfigured, hasPostgresUri, hasRestApi } = getSupabaseCredentials();
    if (!isConfigured) return false;

    if (hasPostgresUri) {
        try {
            const pool = await getPgPool();
            if (pool) {
                await pool.query(`DELETE FROM auth_keys WHERE "sessionId" = $1`, [cleanId]);
                await pool.query(`DELETE FROM auth_creds WHERE "sessionId" = $1`, [cleanId]);
            }
        } catch (_) {}
    }

    if (hasRestApi) {
        await supabaseRestRequest('auth_keys', {
            method: 'DELETE',
            query: `sessionId=eq.${encodeURIComponent(cleanId)}`
        });
        await supabaseRestRequest('auth_creds', {
            method: 'DELETE',
            query: `sessionId=eq.${encodeURIComponent(cleanId)}`
        });
    }
    return true;
}

/**
 * Clear all sessions from Supabase — ONLY called when user manually clicks Clear All Sessions
 */
async function clearAllSupabaseSessions() {
    const ids = await listSupabaseSessionIds();
    for (const id of ids) {
        await deleteSessionFromSupabase(id);
    }
    _supabaseSyncedSessions.clear();
    return ids.length;
}

/**
 * Save Supabase credentials at runtime (from Dashboard UI) and test connection
 */
async function configureSupabaseSync({ supabaseUrl, supabaseKey, supabaseDbUrl } = {}) {
    let current = readSavedCloudConfig();

    if (supabaseUrl !== undefined) {
        const cleanUrl = String(supabaseUrl || '').trim().replace(/\/+$/, '');
        current.SUPABASE_URL = cleanUrl;
        process.env.SUPABASE_URL = cleanUrl;
    }
    if (supabaseKey !== undefined) {
        const cleanKey = String(supabaseKey || '').trim();
        current.SUPABASE_KEY = cleanKey;
        current.SUPABASE_SECRET_KEY = cleanKey;
        process.env.SUPABASE_KEY = cleanKey;
        process.env.SUPABASE_SECRET_KEY = cleanKey;
    }
    if (supabaseDbUrl !== undefined) {
        const cleanDb = String(supabaseDbUrl || '').trim();
        current.SUPABASE_DB_URL = cleanDb;
        process.env.SUPABASE_DB_URL = cleanDb;
    }

    try {
        fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2), 'utf8');
    } catch (_) {}

    // Reset pool to force fresh connection test
    if (_pgPool) {
        try { await _pgPool.end(); } catch (_) {}
        _pgPool = null;
        _pgTablesReady = false;
    }

    const creds = getSupabaseCredentials();
    if (creds.hasPostgresUri) {
        await getPgPool();
    }
    const cloudSessions = await listSupabaseSessionIds();
    return getSupabaseSyncDiagnostics(cloudSessions);
}

function getSupabaseSyncDiagnostics(knownCloudIds = null) {
    const creds = getSupabaseCredentials();
    return {
        configured: creds.isConfigured,
        mode: creds.mode,
        hasPostgresUri: creds.hasPostgresUri,
        hasRestApi: creds.hasRestApi,
        supabaseUrl: creds.supabaseUrl || '',
        hasSupabaseKey: Boolean(creds.supabaseKey),
        hasSupabaseDbUrl: Boolean(creds.supabaseDbUrl),
        pgTablesReady: _pgTablesReady,
        syncedSessionsCount: Array.isArray(knownCloudIds) ? knownCloudIds.length : _supabaseSyncedSessions.size,
        syncedSessionIds: Array.isArray(knownCloudIds) ? knownCloudIds : Array.from(_supabaseSyncedSessions),
        lastSyncAt: _lastSupabaseSyncAt,
        lastError: _lastSupabaseError,
        autoLogoutDisabled: true,
        railwayVolumePath: SESSIONS_DIR
    };
}

// =============================================================================
// DUAL-SYNC AUTH STATE (Local Railway Volume + Supabase Cloud Mirror)
// =============================================================================
async function useDualSyncAuthState(sessionDir, sessionId = 'main') {
    const targetDir = sessionDir || path.join(SESSIONS_DIR, String(sessionId));
    fs.mkdirSync(targetDir, { recursive: true });

    const credsFile = path.join(targetDir, 'creds.json');

    // 1. If local creds.json is missing on Railway Volume, attempt to restore from Supabase Cloud first
    if (!fs.existsSync(credsFile)) {
        try {
            await pullSupabaseSessionToLocal(sessionId, targetDir);
        } catch (e) {
            console.warn(`[authState] Supabase restore check for ${sessionId}:`, e.message);
        }
    }

    // 2. Initialize fast local multi-file auth state on Railway Volume
    const fileAuth = await useMultiFileAuthState(targetDir);

    // 3. Mirror existing registered credentials to Supabase in the background
    if (fileAuth.state?.creds?.registered) {
        syncLocalSessionToSupabase(sessionId, targetDir).catch(() => {});
    }

    // 4. Wrap keys.get and keys.set for dual-sync with Supabase
    const origKeysGet = fileAuth.state.keys.get.bind(fileAuth.state.keys);
    const origKeysSet = fileAuth.state.keys.set.bind(fileAuth.state.keys);

    const dualKeys = {
        get: async (type, ids) => {
            const localResult = await origKeysGet(type, ids);
            if (!ids || !ids.length) return localResult;

            const missingIds = ids.filter(id => localResult[id] === undefined);
            if (missingIds.length > 0 && getSupabaseCredentials().isConfigured) {
                try {
                    const remoteKeys = await getKeysFromSupabase(sessionId, type, missingIds);
                    const recoveredToSave = {};
                    for (const [kId, val] of Object.entries(remoteKeys)) {
                        if (val !== undefined) {
                            localResult[kId] = val;
                            recoveredToSave[kId] = val;
                        }
                    }
                    if (Object.keys(recoveredToSave).length > 0) {
                        await origKeysSet({ [type]: recoveredToSave });
                    }
                } catch (_) {}
            }
            return localResult;
        },
        set: async (data) => {
            // Write immediately to Railway persistent disk
            await origKeysSet(data);
            // Mirror non-null keys to Supabase asynchronously
            if (getSupabaseCredentials().isConfigured) {
                syncKeysToSupabase(sessionId, data).catch(() => {});
            }
        }
    };

    const saveCreds = async () => {
        // 1. Save to Railway persistent volume
        await fileAuth.saveCreds();
        // 2. Mirror to Supabase Cloud
        if (getSupabaseCredentials().isConfigured) {
            syncCredsToSupabase(sessionId, fileAuth.state.creds).catch(() => {});
        }
    };

    return {
        state: {
            creds: fileAuth.state.creds,
            keys: dualKeys
        },
        saveCreds
    };
}

// =============================================================================
// LEGACY / OPTIONAL BACKENDS (Sequelize / MongoDB / Redis)
// =============================================================================
async function useFileAuthState(sessionDir) {
    fs.mkdirSync(sessionDir, { recursive: true });
    return useMultiFileAuthState(sessionDir);
}

async function useSupabaseAuthState(sessionId = 'main') {
    const sessionDir = path.join(SESSIONS_DIR, String(sessionId));
    return useDualSyncAuthState(sessionDir, sessionId);
}

async function getAuthState(sessionDir = './session', sessionId = 'main') {
    const targetDir = sessionDir || path.join(SESSIONS_DIR, String(sessionId));
    return useDualSyncAuthState(targetDir, sessionId);
}

module.exports = {
    getAuthState,
    useDualSyncAuthState,
    useFileAuthState,
    useSupabaseAuthState,
    getSupabaseCredentials,
    getSupabaseSyncDiagnostics,
    configureSupabaseSync,
    listSupabaseSessionIds,
    pullSupabaseSessionToLocal,
    syncLocalSessionToSupabase,
    syncCredsToSupabase,
    deleteSessionFromSupabase,
    clearAllSupabaseSessions
};
