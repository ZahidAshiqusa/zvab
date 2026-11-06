// Zaid Ashiq X Ultra V. Coder - Settings
// All values are read from environment variables.
// Copy .env.example to .env and fill in your details,
// OR set them as environment variables on your hosting platform.

require('dotenv').config({ override: true });

const settings = {
  // ── Bot Identity ─────────────────────────────────────────────────────────
  botName:     process.env.BOT_NAME     || 'Zaid Ashiq X Ultra V. Coder',
  botOwner:    process.env.BOT_OWNER    || 'Zaid Ashiq X Ultra V. Coder',
  ownerName:   process.env.BOT_OWNER    || 'Zaid Ashiq X Ultra V. Coder',
  packname:    process.env.PACK_NAME    || 'Zaid Ashiq X Ultra V. Coder',
  author:      process.env.PACK_AUTHOR  || 'Zaid Ashiq X Ultra V. Coder',
  description: 'Zaid Ashiq X Ultra V. Coder WhatsApp Automation Suite & Bot Management Platform.',
  version:     '1.0.0',

  // ── Owner & Session ──────────────────────────────────────────────────────
  // ownerNumber: your WhatsApp number with country code, no + or spaces
  ownerNumber: (process.env.OWNER_NUMBER || '254141693915').replace(/[^0-9]/g, '') || '254141693915',

  // ── Behaviour ────────────────────────────────────────────────────────────
  prefix:      process.env.PREFIX       || '.',
  timezone:    process.env.TIMEZONE     || 'Asia/Karachi',
  commandMode: process.env.COMMAND_MODE || 'public',   // 'public' or 'private'

  // ── Auto Features ────────────────────────────────────────────────────────
  AUTO_STATUS_REACT:  process.env.AUTO_STATUS_REACT  || 'false',
  AUTO_STATUS_REPLY:  process.env.AUTO_STATUS_REPLY  || 'false',
  AUTO_STATUS_MSG:    process.env.AUTO_STATUS_MSG     || 'Status Viewed by Zaid Ashiq X Ultra V. Coder',
  AUTOREAD:           process.env.AUTOREAD            || 'false',
  AUTOTYPE:           process.env.AUTOTYPE            || 'false',
  AUTORECORD:         process.env.AUTORECORD          || 'false',
  AUTORECORDTYPE:     process.env.AUTORECORDTYPE      || 'false',
  ALWAYSONLINE:       process.env.ALWAYSONLINE        || 'false',

  // ── API Keys ─────────────────────────────────────────────────────────────
  giphyApiKey: process.env.GIPHY_API_KEY || '',
};

module.exports = settings;
