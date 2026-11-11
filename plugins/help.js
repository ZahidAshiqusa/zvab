// Interactive Buttons Menu & Category Submenus (.menu, .help, .downloadmenu, etc.)

const settings = require('../settings');
const { getLang } = require('../lib/lang');
const fs = require('fs');
const path = require('path');
const { pluginMap, bot } = require('../lib/pluginLoader');
const { readRandomBrandImage } = require('../lib/imagePicker');

let sendButtons;
try {
    sendButtons = require('kango-wa').sendButtons;
} catch (_) {
    sendButtons = null;
}

const OWNER_NAME = 'Zaid Ashiq X Ultra V. Coder';

function formatTime(seconds) {
    const days = Math.floor(seconds / (24 * 60 * 60));
    seconds = seconds % (24 * 60 * 60);
    const hours = Math.floor(seconds / (60 * 60));
    seconds = seconds % (60 * 60);
    const minutes = Math.floor(seconds / 60);
    seconds = Math.floor(seconds % 60);

    let time = '';
    if (days > 0) time += `${days}d `;
    if (hours > 0) time += `${hours}h `;
    if (minutes > 0) time += `${minutes}m `;
    if (seconds > 0 || time === '') time += `${seconds}s`;

    return time.trim();
}

const CATEGORY_META = {
    download: { emoji: '📥', title: 'Download' },
    ai:       { emoji: '🤖', title: 'AI' },
    tools:    { emoji: '💻', title: 'Tools' },
    owner:    { emoji: '🔒', title: 'Owner' },
    group:    { emoji: '👥', title: 'Group' },
    general:  { emoji: '🌐', title: 'General' },
    fun:      { emoji: '🎯', title: 'Fun' },
    games:    { emoji: '🎮', title: 'Games' },
    photo:    { emoji: '🎨', title: 'Photo' },
    religion: { emoji: '🕌', title: 'Religion' },
    text:     { emoji: '🔤', title: 'Text Art' },
    search:   { emoji: '🔍', title: 'Search' }
};

const CATEGORY_ORDER = ['download', 'ai', 'tools', 'owner', 'group', 'general', 'search', 'fun', 'games', 'photo', 'religion', 'text'];

function getCommandsByCategory(categoryKey) {
    const seen = new Set();
    const cmds = [];
    for (const [cmdName, { meta }] of pluginMap) {
        if ((meta.category || 'general') !== categoryKey) continue;
        if (meta.hidden) continue;
        const primary = Array.isArray(meta.command) ? meta.command[0] : meta.command;
        if (cmdName !== primary) continue;
        const menuCommands = Array.isArray(meta.menuCommands)
            ? meta.menuCommands
            : [primary];
        for (const menuCommand of menuCommands) {
            const normalized = String(menuCommand || '').toLowerCase().trim();
            if (!normalized || seen.has(normalized)) continue;
            seen.add(normalized);
            cmds.push(normalized.startsWith('.') || normalized.startsWith('@') ? normalized : '.' + normalized);
        }
    }
    return cmds;
}

function getHeader() {
    const currentTime = new Date().toLocaleString('en-US', {
        timeZone: settings.timezone,
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const currentDate = new Date().toLocaleString('en-US', {
        timeZone: settings.timezone,
        day: '2-digit', month: '2-digit', year: 'numeric',
    });
    const uptimeFormatted = formatTime(process.uptime());
    const botMode = settings.commandMode === 'public' ? 'public' : 'private';

    return `*『 👑 𝚉𝙰𝙸𝙳 𝙰𝚂𝙷𝙸𝚀 𝚇 𝚄𝙻𝚃𝚁𝙰 𝚅. 𝙲𝙾𝙳𝙴𝚁 』*
*│ 👤 ᴏᴡɴᴇʀ     : ${OWNER_NAME}*
*│ 📞 ɴᴜᴍʙᴇʀ    : +${settings.ownerNumber || '254141693915'}*
*│ 🌍 ᴍᴏᴅᴇ      : [ ${botMode} ]*
*│ ⏰ ᴛɪᴍᴇ      : ${currentTime}*
*│ 📅 ᴅᴀᴛᴇ      : ${currentDate}*
*│ 🛠️ ᴘʀᴇғɪx    : [ . ]*
*│ 🔄 ᴜᴘᴛɪᴍᴇ    : ${uptimeFormatted}*
*│ 🌐 ᴛɪᴍᴇᴢᴏɴᴇ : ${settings.timezone}*
*│ 🚀 ᴠᴇʀsɪᴏɴ   : ${settings.version}*
*╰─────────⟢*`;
}

function getCatTitle(key, sock) {
    const map = {
        ai:       'help_cat_ai',
        download: 'help_cat_download',
        fun:      'help_cat_fun',
        games:    'help_cat_games',
        group:    'help_cat_group',
        general:  'help_cat_general',
        owner:    'help_cat_owner',
        photo:    'help_cat_photo',
        religion: 'help_cat_religion',
        tools:    'help_cat_tools',
        text:     'help_cat_text',
    };
    const langKey = map[key];
    const lang = getLang(sock);
    return (langKey && lang[langKey]) ? lang[langKey] : (CATEGORY_META[key]?.title || key);
}

function buildCategoryText(key, sock) {
    const cat = CATEGORY_META[key];
    if (!cat) return null;
    const cmds = getCommandsByCategory(key);
    if (!cmds.length) return null;

    let text = `*『 ${cat.emoji} ${getCatTitle(key, sock)} ${getLang(sock).help_menu_suffix || 'Menu'} 』*\n`;
    for (const cmd of cmds) {
        text += `*│ ⬡ ${cmd}*\n`;
    }
    text += `*╰─────────⟢*`;
    return text;
}

function buildCategoryInteractiveButtons(key) {
    const cmds = getCommandsByCategory(key);
    // Pick up to 8 clean primary command buttons for this submenu + Back to Main Menu
    const actionButtons = cmds.slice(0, 8).map(cmdStr => {
        const cleanCmd = cmdStr.split(/\s+/)[0].trim();
        return {
            id: cleanCmd,
            text: `⚡ ${cleanCmd}`
        };
    });
    if (key !== 'download') {
        actionButtons.push({ id: '.help download', text: '📥 Download Menu' });
    }
    actionButtons.push({ id: '.menu', text: '⬅️ Back to Main Menu' });
    return actionButtons;
}

async function sendMenuAudio(sock, chatId) {
    const audioPath1 = path.join(__dirname, '../media/menu.mp3');
    const audioPath2 = path.join(__dirname, '../media/menu2.mp3');
    const tracks = [audioPath1, audioPath2];
    const chosen = tracks[Math.floor(Math.random() * tracks.length)];

    if (fs.existsSync(chosen)) {
        const audioBuffer = fs.readFileSync(chosen);
        await sock.sendMessage(chatId, {
            audio: audioBuffer,
            mimetype: 'audio/mpeg',
            fileName: 'menu.mp3',
            ptt: false,
        });
    }
}

async function sendWithImage(sock, chatId, text) {
    const imageBuffer = readRandomBrandImage();
    if (imageBuffer) {
        await sock.sendMessage(chatId, {
            image: imageBuffer,
            caption: text,
        });
    } else {
        await sock.sendMessage(chatId, {
            text,
        });
    }
}

async function helpCommand(sock, chatId, message, _, subCategory) {
    const menuImage = readRandomBrandImage();
    const normalizedSub = String(subCategory || '').toLowerCase().replace(/menu$/, '').trim();

    if (normalizedSub && CATEGORY_META[normalizedSub]) {
        const block = buildCategoryText(normalizedSub, sock);
        if (!block) {
            if (sendButtons) {
                return await sendButtons(sock, chatId, {
                    text: 'No commands in that category yet.',
                    footer: `⚡ ${OWNER_NAME}`,
                    buttons: [{ id: '.menu', text: '⬅️ Back to Main Menu' }]
                }, { quoted: message });
            }
            await sock.sendMessage(chatId, { text: 'No commands in that category yet.' });
            return;
        }

        const catText =
            getHeader() +
            '\n\n' +
            block +
            `\n\n👇 *Tap a command button below or return to Main Menu:*`;

        const catButtons = buildCategoryInteractiveButtons(normalizedSub);

        if (sendButtons) {
            try {
                const opts = {
                    text: catText,
                    footer: `⚡ ${OWNER_NAME}`,
                    buttons: catButtons,
                };
                if (menuImage) opts.image = menuImage;
                await sendButtons(sock, chatId, opts, { quoted: message });
                return;
            } catch (err) {
                console.warn('[HELP] Submenu image buttons fallback to text buttons:', err.message);
                try {
                    await sendButtons(sock, chatId, {
                        text: catText,
                        footer: `⚡ ${OWNER_NAME}`,
                        buttons: catButtons,
                    }, { quoted: message });
                    return;
                } catch (_) {}
            }
        }

        await sendWithImage(sock, chatId, catText);
        return;
    }

    // Main Menu with Interactive Category Buttons
    const menuText =
        getHeader() +
        '\n\n' +
        `✨ *Select a Menu Category button below to view commands in interactive buttons format:*`;

    const buttons = CATEGORY_ORDER
        .filter(key => CATEGORY_META[key] && getCommandsByCategory(key).length)
        .map(key => ({
            id: `.help ${key}`,
            text: `${CATEGORY_META[key].emoji} ${getCatTitle(key, sock)} Menu`,
        }));

    if (sendButtons) {
        try {
            const opts = {
                text: menuText,
                footer: `⚡ ${OWNER_NAME}`,
                buttons,
            };
            if (menuImage) opts.image = menuImage;
            await sendButtons(sock, chatId, opts, { quoted: message });
            await sendMenuAudio(sock, chatId);
            return;
        } catch (err) {
            console.warn('[HELP] Button menu image failed, retrying text buttons:', err.message);
            try {
                await sendButtons(sock, chatId, {
                    text: menuText,
                    footer: `⚡ ${OWNER_NAME}`,
                    buttons,
                }, { quoted: message });
                await sendMenuAudio(sock, chatId);
                return;
            } catch (_) {}
        }
    }

    await sendWithImage(sock, chatId, menuText);
}

bot({
    command: ['help', 'menu', 'bot', 'list', 'allmenu'],
    menuCommands: ['menu', 'help'],
    description: 'Show interactive command menu with category buttons',
    category: 'general',
}, async (sock, chatId, message, args) => {
    await helpCommand(sock, chatId, message, settings.channelLink, args[0]?.toLowerCase());
});

bot({
    command: ['downloadmenu', 'dlmenu', 'aimenu', 'toolsmenu', 'ownermenu', 'groupmenu', 'funmenu', 'gamesmenu'],
    menuCommands: ['downloadmenu', 'toolsmenu', 'aimenu'],
    description: 'Open specific category menu in interactive buttons format',
    category: 'general',
}, async (sock, chatId, message) => {
    let raw = message?.message?.conversation || message?.message?.extendedTextMessage?.text || '';
    const cmd = raw.trim().split(/\s+/)[0].replace(/^[.!#/]/, '').toLowerCase();
    const map = {
        downloadmenu: 'download',
        dlmenu: 'download',
        aimenu: 'ai',
        toolsmenu: 'tools',
        ownermenu: 'owner',
        groupmenu: 'group',
        funmenu: 'fun',
        gamesmenu: 'games'
    };
    await helpCommand(sock, chatId, message, settings.channelLink, map[cmd] || 'download');
});