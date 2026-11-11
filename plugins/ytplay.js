// YouTube Play (.ytplay) via https://yt-down-pari.vercel.app/api/download
const { sendYtSelectionMenu } = require('../lib/ytPariApi');
const { getLang } = require('../lib/lang');
const { sendButtonMessage } = require('../lib/buttonHelper');
const { bot } = require('../lib/pluginLoader');

async function ytplayCommand(sock, chatId, query, message) {
    if (!query) {
        return await sendButtonMessage(sock, chatId, {
            text: `🎬 *${getLang(sock).dl_no_youtube || 'Please enter a YouTube query or URL!'}*\n\nExample: \`.ytplay Faded\``,
            footer: '⚡ Zaid Ashiq X Ultra V. Coder',
            buttons: [
                { id: '.help download', text: '📥 Download Menu' },
                { id: '.menu', text: '📋 Main Menu' }
            ]
        }, message);
    }

    try {
        await sendYtSelectionMenu(sock, chatId, message, query, 'YouTube Play');
    } catch (error) {
        console.error('YTPlay Error:', error.message);
        await sock.sendMessage(chatId, { react: { text: '❌', key: message.key } });
        await sendButtonMessage(sock, chatId, {
            text: getLang(sock).dl_error || '❌ Error processing YouTube request.',
            footer: '⚡ Zaid Ashiq X Ultra V. Coder',
            buttons: [
                { id: '.help download', text: '📥 Download Menu' },
                { id: '.menu', text: '📋 Main Menu' }
            ]
        }, message);
    }
}

bot({
    command: ['ytplay'],
    description: 'Play YouTube audio/video with interactive quality buttons',
    category: 'download',
}, async (sock, chatId, message, args, query) => {
    await ytplayCommand(sock, chatId, query, message);
});