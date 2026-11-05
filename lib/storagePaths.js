'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Resolve unified persistent storage directory for Railway Volume, Cloud Run, or local data folder
const ROOT_DIR = path.join(__dirname, '..');
const DEFAULT_DATA_DIR = path.join(ROOT_DIR, 'data');
const TMP_FALLBACK_DIR = path.join(os.tmpdir(), 'urooj_suite_data');

function isDirectoryWritable(dirPath) {
    if (!dirPath) return false;
    try {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        const probeFile = path.join(dirPath, `.write_probe_${process.pid}_${Date.now()}`);
        fs.writeFileSync(probeFile, 'ok', 'utf8');
        fs.rmSync(probeFile, { force: true });
        return true;
    } catch (_) {
        return false;
    }
}

function resolveWritableDataDir() {
    const candidates = [
        process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH) : null,
        process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : null,
        TMP_FALLBACK_DIR,
        DEFAULT_DATA_DIR
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (isDirectoryWritable(candidate)) {
            return candidate;
        }
    }
    return TMP_FALLBACK_DIR;
}

const DATA_DIR = resolveWritableDataDir();
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const LEGACY_SESSIONS_DIR = path.join(ROOT_DIR, 'session');
const VAULT_DIR = path.join(DATA_DIR, 'vault');
const DB_PATH = path.join(DATA_DIR, 'urooj_suite.db');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Ensure all persistent subdirectories exist inside the verified writable DATA_DIR
for (const dir of [DATA_DIR, SESSIONS_DIR, VAULT_DIR]) {
    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    } catch (err) {
        console.warn(`[storage] Could not create directory ${dir}:`, err.message);
    }
}

// Seed default JSON files from ./data into DATA_DIR if DATA_DIR is external (/tmp or /app/data)
if (DATA_DIR !== DEFAULT_DATA_DIR && fs.existsSync(DEFAULT_DATA_DIR)) {
    try {
        const seedFiles = fs.readdirSync(DEFAULT_DATA_DIR);
        for (const f of seedFiles) {
            if (f.endsWith('.json') || f.endsWith('.js')) {
                const src = path.join(DEFAULT_DATA_DIR, f);
                const dest = path.join(DATA_DIR, f);
                if (!fs.existsSync(dest) && fs.statSync(src).isFile()) {
                    fs.copyFileSync(src, dest);
                }
            }
        }
    } catch (_) {}
}

// Migrate any existing session folders from legacy /session into persistent DATA_DIR/sessions
function migrateLegacySessions() {
    try {
        if (!fs.existsSync(LEGACY_SESSIONS_DIR)) return;
        const entries = fs.readdirSync(LEGACY_SESSIONS_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const srcDir = path.join(LEGACY_SESSIONS_DIR, entry.name);
            const destDir = path.join(SESSIONS_DIR, entry.name);
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
                const files = fs.readdirSync(srcDir);
                for (const file of files) {
                    const sFile = path.join(srcDir, file);
                    const dFile = path.join(destDir, file);
                    if (fs.statSync(sFile).isFile()) {
                        fs.copyFileSync(sFile, dFile);
                    }
                }
                console.log(`[storage] 🔄 Migrated session +${entry.name} into persistent volume: ${destDir}`);
            }
        }
    } catch (err) {
        console.warn('[storage] Legacy session migration warning:', err.message);
    }
}

migrateLegacySessions();

function getDirectoryStats(dirPath) {
    let fileCount = 0;
    let totalBytes = 0;
    try {
        if (!fs.existsSync(dirPath)) return { fileCount: 0, totalBytes: 0 };
        const walk = (current) => {
            const list = fs.readdirSync(current, { withFileTypes: true });
            for (const item of list) {
                const full = path.join(current, item.name);
                if (item.isDirectory()) {
                    walk(full);
                } else if (item.isFile()) {
                    fileCount++;
                    totalBytes += fs.statSync(full).size;
                }
            }
        };
        walk(dirPath);
    } catch (_) {}
    return { fileCount, totalBytes };
}

function getVolumeDiagnostics() {
    let isWritable = false;
    try {
        const probeFile = path.join(DATA_DIR, '.volume_probe');
        fs.writeFileSync(probeFile, String(Date.now()), 'utf8');
        fs.rmSync(probeFile, { force: true });
        isWritable = true;
    } catch (_) {
        isWritable = false;
    }

    let dbSizeBytes = 0;
    try {
        if (fs.existsSync(DB_PATH)) {
            dbSizeBytes = fs.statSync(DB_PATH).size;
        }
    } catch (_) {}

    const vaultStats = getDirectoryStats(VAULT_DIR);
    let sessionFoldersCount = 0;
    try {
        if (fs.existsSync(SESSIONS_DIR)) {
            sessionFoldersCount = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
                .filter(d => d.isDirectory() && /^\d+$/.test(d.name)).length;
        }
    } catch (_) {}

    const totalVolumeStats = getDirectoryStats(DATA_DIR);

    return {
        volumePath: DATA_DIR,
        sessionsPath: SESSIONS_DIR,
        vaultPath: VAULT_DIR,
        dbPath: DB_PATH,
        isWritable,
        dbSizeBytes,
        vaultFilesCount: vaultStats.fileCount,
        vaultSizeBytes: vaultStats.totalBytes,
        sessionFoldersCount,
        totalVolumeBytes: totalVolumeStats.totalBytes
    };
}

module.exports = {
    ROOT_DIR,
    DATA_DIR,
    SESSIONS_DIR,
    LEGACY_SESSIONS_DIR,
    VAULT_DIR,
    DB_PATH,
    CONFIG_PATH,
    getVolumeDiagnostics
};
