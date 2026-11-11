// YouTube Play Audio Command (.playaudio)
const { sendYtSelectionMenu } = require('../lib/ytPariApi');
const { getLang } = require('../lib/lang');
const { sendButtonMessage } = require('../lib/buttonHelper');
const { bot } = require('../lib/pluginLoader');

async function playCommand(sock, chatId, message) {
    try {
        const text = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
        const searchQuery = text.split(/\s+/).slice(1).join(' ').trim();

        if (!searchQuery) {
            return await sendButtonMessage(sock, chatId, {
                text: `🎵 *${getLang(sock).dl_no_song || 'Please provide a song name or YouTube URL!'}*\n\nExample: \`.playaudio Alan Walker Faded\``,
                footer: '⚡ Zaid Ashiq X Ultra V. Coder',
                buttons: [
                    { id: '.help download', text: '📥 Download Menu' },
                    { id: '.menu', text: '📋 Main Menu' }
                ]
            }, message);
        }

        await sendYtSelectionMenu(sock, chatId, message, searchQuery, 'YouTube Play Audio & Video');
    } catch (error) {
        console.error('Error in playCommand:', error.message);
        if (error.message?.includes('Connection Closed') || error.message?.includes('Connection Terminated')) return;
        try {
            await sock.sendMessage(chatId, { react: { text: '❌', key: message.key } });
            await sendButtonMessage(sock, chatId, {
                text: getLang(sock).dl_failed || '❌ Download failed.',
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
    command: ['playaudio'],
    description: 'Download audio/video from YouTube with interactive buttons',
    category: 'download',
}, async (sock, chatId, message) => {
    await playCommand(sock, chatId, message);
});
