// YouTube Video Downloader (.video, .ytmp4) via https://yt-down-pari.vercel.app/api/download
const { sendYtSelectionMenu } = require('../lib/ytPariApi');
const { getLang } = require('../lib/lang');
const { sendButtonMessage } = require('../lib/buttonHelper');
const { bot } = require('../lib/pluginLoader');

async function videoCommand(sock, chatId, message) {
    try {
        const text = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
        const searchQuery = text.split(/\s+/).slice(1).join(' ').trim();

        if (!searchQuery) {
            return await sendButtonMessage(sock, chatId, {
                text: `🎬 *${getLang(sock).dl_no_video || 'Please provide a video title or YouTube URL!'}*\n\nExample: \`.video Alan Walker Faded\``,
                footer: '⚡ Zaid Ashiq X Ultra V. Coder',
                buttons: [
                    { id: '.help download', text: '📥 Download Menu' },
                    { id: '.menu', text: '📋 Main Menu' }
                ]
            }, message);
        }

        await sendYtSelectionMenu(sock, chatId, message, searchQuery, 'YouTube Video Downloader');
    } catch (error) {
        console.error('[video.js] Error:', error.message);
        try {
            await sock.sendMessage(chatId, { react: { text: '❌', key: message.key } });
            await sendButtonMessage(sock, chatId, {
                text: '❌ Download failed. Please try again later.',
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
    command: ['video', 'ytmp4', 'ytv'],
    menuCommands: ['video', 'ytmp4'],
    description: 'Download video from YouTube with interactive 360p/720p/MP3 buttons',
    category: 'download',
}, async (sock, chatId, message) => {
    await videoCommand(sock, chatId, message);
});