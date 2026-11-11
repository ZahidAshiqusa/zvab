// YouTube Audio & Interactive Selector (.play, .song, .mp3, .music, .ytdl)
const { sendYtSelectionMenu, executeYtDownload } = require('../lib/ytPariApi');
const { getLang } = require('../lib/lang');
const { sendButtonMessage } = require('../lib/buttonHelper');
const { bot } = require('../lib/pluginLoader');

function getRawCommandText(message) {
    let m = message?.message || {};
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    if (m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
        try {
            const p = JSON.parse(m.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
            if (p.id || p.display_text) return (p.id || p.display_text).trim();
        } catch (_) {}
    }
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.buttonsResponseMessage?.selectedButtonId ||
        m.buttonsResponseMessage?.selectedDisplayText ||
        ''
    ).trim();
}

async function songCommand(sock, chatId, message) {
    try {
        const text = getRawCommandText(message);
        const searchQuery = text.split(/\s+/).slice(1).join(' ').trim();

        if (!searchQuery) {
            return await sendButtonMessage(sock, chatId, {
                text: `🎵 *${getLang(sock).dl_no_song || 'Please provide a song name or YouTube URL!' }*\n\nExample: \`.play Alan Walker Faded\``,
                footer: '⚡ Zaid Ashiq X Ultra V. Coder',
                buttons: [
                    { id: '.help download', text: '📥 Download Menu' },
                    { id: '.menu', text: '📋 Main Menu' }
                ]
            }, message);
        }

        await sendYtSelectionMenu(sock, chatId, message, searchQuery, 'YouTube Music & Video');
    } catch (error) {
        console.error('Error in songCommand:', error.message);
        if (error.message?.includes('Connection Closed') || error.message?.includes('Connection Terminated')) return;
        try {
            await sock.sendMessage(chatId, { react: { text: '❌', key: message.key } });
            await sendButtonMessage(sock, chatId, {
                text: getLang(sock).dl_failed || '❌ Download failed. Please try again.',
                footer: '⚡ Zaid Ashiq X Ultra V. Coder',
                buttons: [
                    { id: '.help download', text: '📥 Download Menu' },
                    { id: '.menu', text: '📋 Main Menu' }
                ]
            }, message);
        } catch (_) {}
    }
}

async function ytdlCallbackCommand(sock, chatId, message) {
    try {
        const text = getRawCommandText(message);
        const parts = text.split(/\s+/).slice(1);
        const mode = parts[0] || 'audio';
        const videoTarget = parts.slice(1).join(' ').trim();

        if (!videoTarget) {
            return await sendButtonMessage(sock, chatId, {
                text: '❌ Please specify a YouTube song or video first using `.play <query>` or `.video <query>`.',
                footer: '⚡ Zaid Ashiq X Ultra V. Coder',
                buttons: [
                    { id: '.help download', text: '📥 Download Menu' },
                    { id: '.menu', text: '📋 Main Menu' }
                ]
            }, message);
        }

        await executeYtDownload(sock, chatId, message, mode, videoTarget);
    } catch (error) {
        console.error('Error in ytdlCallbackCommand:', error.message);
        try {
            await sock.sendMessage(chatId, { react: { text: '❌', key: message.key } });
            await sendButtonMessage(sock, chatId, {
                text: `❌ Download error: ${error.message}`,
                footer: '⚡ Zaid Ashiq X Ultra V. Coder',
                buttons: [
                    { id: '.help download', text: '📥 Download Menu' },
                    { id: '.menu', text: '📋 Main Menu' }
                ]
            }, message);
        } catch (_) {}
    }
}

bot({
    command: ['play', 'song', 'mp3', 'music', 'ytmp3'],
    menuCommands: ['play', 'song', 'mp3'],
    description: 'Search & download YouTube Audio MP3 or Video with interactive buttons',
    category: 'download',
}, async (sock, chatId, message) => {
    await songCommand(sock, chatId, message);
});

bot({
    command: ['ytdl'],
    hidden: true,
    description: 'Internal callback for interactive YouTube Audio/Video quality buttons',
    category: 'download',
}, async (sock, chatId, message) => {
    await ytdlCallbackCommand(sock, chatId, message);
});