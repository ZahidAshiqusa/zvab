const { sendButtons } = require('kango-wa');

/**
 * Always return true so every command and menu uses interactive buttons format.
 */
function isButtonModeOn() {
    return true;
}

/**
 * Send a message with interactive quick-reply buttons (kango-wa nativeFlowMessage).
 *
 * @param {object} sock
 * @param {string} jid
 * @param {object} opts  - { text, footer, buttons: [{ id, text }], image }
 * @param {object} quoted - original message to quote (optional)
 */
async function sendButtonMessage(sock, jid, opts, quoted) {
    const { text, footer = '⚡ Zaid Ashiq X Ultra V. Coder', image } = opts || {};
    let buttons = Array.isArray(opts?.buttons) && opts.buttons.length > 0
        ? opts.buttons
        : [
            { id: '.menu', text: '📋 Main Menu' },
            { id: '.help download', text: '📥 Download Menu' }
        ];

    try {
        const payload = { text, footer, buttons };
        if (image) payload.image = image;
        return await sendButtons(sock, jid, payload, quoted ? { quoted } : undefined);
    } catch (err) {
        return quoted
            ? sock.sendMessage(jid, { text }, { quoted })
            : sock.sendMessage(jid, { text });
    }
}

module.exports = { isButtonModeOn, sendButtonMessage };
