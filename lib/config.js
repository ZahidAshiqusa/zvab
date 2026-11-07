const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./storagePaths');

const DEFAULT_CONFIG = {
    AUTOREAD: 'false',
    AUTOTYPE: 'false',
    AUTORECORD: 'false',
    AUTORECORDTYPE: 'false',
    ALWAYSONLINE: 'false',
    AUTO_STATUS_REACT: 'false',
    AUTO_STATUS_REPLY: 'false',
    AUTO_STATUS_MSG: 'Viewed By Zaid Ashiq X Ultra V. Coder',
    ANTICALL: 'decline',
    BUTTONMODE: 'on',
    LANGUAGE: 'en',
    PREFIX: ''
};

function getConfigPath(sessionNumber) {
    if (!sessionNumber) return path.join(DATA_DIR, 'config.json');
    return path.join(DATA_DIR, 'config_' + sessionNumber + '.json');
}

function loadConfig(sessionNumber) {
    const configPath = getConfigPath(sessionNumber);
    try {
        if (!fs.existsSync(configPath)) {
            if (sessionNumber) {
                const mainCfg = loadConfig(null);
                const seeded = Object.assign({}, mainCfg);
                seeded.PREFIX = '';
                seeded.ALWAYSONLINE = 'false';
                seeded.AUTOTYPE = 'false';
                seeded.AUTORECORD = 'false';
                seeded.AUTORECORDTYPE = 'false';
                fs.writeFileSync(configPath, JSON.stringify(seeded, null, 2), 'utf8');
                return seeded;
            }
            return Object.assign({}, DEFAULT_CONFIG);
        }
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        parsed.ALWAYSONLINE = 'false';
        parsed.AUTOTYPE = 'false';
        parsed.AUTORECORD = 'false';
        parsed.AUTORECORDTYPE = 'false';
        return parsed;
    } catch (err) {
        console.error('Failed to load config for', sessionNumber || 'main', err);
        return Object.assign({}, DEFAULT_CONFIG);
    }
}

function saveConfig(newConfig, sessionNumber) {
    const configPath = getConfigPath(sessionNumber);
    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf8');
}

module.exports = { loadConfig, saveConfig };
