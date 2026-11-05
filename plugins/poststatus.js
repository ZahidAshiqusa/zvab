'use strict';

const statusService = require('../lib/statusService');
const { bot } = require('../lib/pluginLoader');

bot({
    command: ['status', 'poststatus', 'pstatus', 'setstatus'],
    description: 'Post photo, video, text, or audio voice note (PTT) to WhatsApp Status (status@broadcast)',
    category: 'owner'
}, async (sock, chatId, message) => {
    await statusService.handleStatusCommand(sock, message);
});