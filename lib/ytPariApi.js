'use strict';

const axios = require('axios');
const yts = require('yt-search');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let sendButtons = null;
try {
    sendButtons = require('kango-wa').sendButtons;
} catch (_) {
    sendButtons = null;
}

const YT_PARI_API_URL = 'https://yt-down-pari.vercel.app/api/download';
const OWNER_BRAND = 'Zaid Ashiq X Ultra V. Coder';

// Cache recent video search metadata by 11-char YouTube videoId
const videoMetaCache = new Map();
const MAX_CACHE_SIZE = 500;

function cacheVideoMeta(videoId, meta) {
    if (!videoId || !meta) return;
    videoMetaCache.set(videoId, {
        ...meta,
        cachedAt: Date.now()
    });
    if (videoMetaCache.size > MAX_CACHE_SIZE) {
        const oldest = videoMetaCache.keys().next().value;
        videoMetaCache.delete(oldest);
    }
}

function getCachedVideoMeta(videoId) {
    return videoMetaCache.get(videoId) || null;
}

function extractYoutubeId(input) {
    if (!input) return null;
    const str = String(input).trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(str)) return str;
    const match = str.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
}

async function resolveYoutubeVideo(queryOrUrl) {
    const trimmed = String(queryOrUrl || '').trim();
    if (!trimmed) return null;

    const directId = extractYoutubeId(trimmed);
    if (directId) {
        const cached = getCachedVideoMeta(directId);
        if (cached) return cached;

        try {
            const search = await yts({ videoId: directId });
            if (search && search.title) {
                const info = {
                    videoId: directId,
                    url: `https://www.youtube.com/watch?v=${directId}`,
                    title: search.title,
                    thumbnail: search.thumbnail || search.image || `https://i.ytimg.com/vi/${directId}/hqdefault.jpg`,
                    timestamp: search.timestamp || search.duration?.timestamp || 'N/A',
                    views: search.views ? Number(search.views).toLocaleString() : 'N/A',
                    author: search.author?.name || 'YouTube'
                };
                cacheVideoMeta(directId, info);
                return info;
            }
        } catch (_) {}

        const fallbackInfo = {
            videoId: directId,
            url: `https://www.youtube.com/watch?v=${directId}`,
            title: 'YouTube Media',
            thumbnail: `https://i.ytimg.com/vi/${directId}/hqdefault.jpg`,
            timestamp: 'N/A',
            views: 'N/A',
            author: 'YouTube'
        };
        cacheVideoMeta(directId, fallbackInfo);
        return fallbackInfo;
    }

    const { videos } = await yts(trimmed);
    if (!videos || videos.length === 0) return null;

    const v = videos[0];
    const vid = extractYoutubeId(v.url) || v.videoId;
    const info = {
        videoId: vid,
        url: `https://www.youtube.com/watch?v=${vid}`,
        title: v.title || 'YouTube Media',
        thumbnail: v.thumbnail || v.image || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
        timestamp: v.timestamp || v.duration?.timestamp || 'N/A',
        views: v.views ? Number(v.views).toLocaleString() : 'N/A',
        author: v.author?.name || 'YouTube'
    };
    if (vid) cacheVideoMeta(vid, info);
    return info;
}

/**
 * Calls POST https://yt-down-pari.vercel.app/api/download
 * Body: {"url":"https://www.youtube.com/watch?v=V2xlVM7V2Y0"}
 * Sanitizes out creator/team/channel fields and returns clean media streams.
 */
async function fetchYtPariDownloadData(youtubeUrlOrId) {
    const vid = extractYoutubeId(youtubeUrlOrId);
    const canonicalUrl = vid
        ? `https://www.youtube.com/watch?v=${vid}`
        : String(youtubeUrlOrId || '').trim();

    const response = await axios.post(
        YT_PARI_API_URL,
        { url: canonicalUrl },
        {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            },
            timeout: 45000
        }
    );

    const payload = response.data || {};
    const dataNode = payload?.result?.data || payload?.data || {};
    const rawMedias = Array.isArray(dataNode.medias) ? dataNode.medias : [];

    // Filter only unlocked streams that have a valid download URL
    const unlockedMedias = rawMedias.filter(
        m => m && m.url && m.locked !== true && String(m.url).startsWith('http')
    );

    return {
        videoId: vid,
        canonicalUrl,
        title: dataNode.title || null,
        imageUrl: dataNode.imageUrl || (vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : null),
        duration: dataNode.duration || null,
        medias: unlockedMedias
    };
}

function selectBestStream(medias, mode = 'audio') {
    if (!Array.isArray(medias) || medias.length === 0) return null;

    const normalizedMode = String(mode || 'audio').toLowerCase();

    if (normalizedMode === 'audio' || normalizedMode === 'mp3' || normalizedMode === 'm4a') {
        // Prefer .m4a audio streams first, then .weba / audio streams, then smallest mp4 as fallback
        const m4aStreams = medias.filter(m => String(m.format || '').toLowerCase().includes('.m4a'));
        if (m4aStreams.length > 0) return m4aStreams[0];

        const webaStreams = medias.filter(m => String(m.format || '').toLowerCase().includes('.weba') || String(m.url || '').includes('mime=audio'));
        if (webaStreams.length > 0) return webaStreams[0];

        return medias[medias.length - 1];
    }

    // Video stream selection (720p, 480p, 360p, etc.)
    const mp4VideoStreams = medias.filter(m => {
        const fmt = String(m.format || '').toLowerCase();
        return fmt.includes('.mp4') && !fmt.includes('.m4a');
    });

    const pool = mp4VideoStreams.length > 0 ? mp4VideoStreams : medias;

    if (normalizedMode.includes('720')) {
        return (
            pool.find(m => String(m.quality || '').toLowerCase() === '720p') ||
            pool.find(m => String(m.quality || '').toLowerCase() === '480p') ||
            pool.find(m => String(m.quality || '').toLowerCase() === '360p') ||
            pool[0]
        );
    }

    if (normalizedMode.includes('480')) {
        return (
            pool.find(m => String(m.quality || '').toLowerCase() === '480p') ||
            pool.find(m => String(m.quality || '').toLowerCase() === '360p') ||
            pool.find(m => String(m.quality || '').toLowerCase() === '720p') ||
            pool[0]
        );
    }

    // Default 360p video
    return (
        pool.find(m => String(m.quality || '').toLowerCase() === '360p') ||
        pool.find(m => String(m.quality || '').toLowerCase() === '480p') ||
        pool.find(m => String(m.quality || '').toLowerCase() === '720p') ||
        pool.find(m => String(m.quality || '').toLowerCase() === '240p') ||
        pool[0]
    );
}

function convertAudioToMp3(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', [
            '-i', inputPath,
            '-vn',
            '-acodec', 'libmp3lame',
            '-ab', '128k',
            '-ar', '44100',
            '-y',
            outputPath
        ]);
        ff.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error('ffmpeg audio conversion exited with code ' + code));
        });
        ff.on('error', reject);
    });
}

function convertVideoToH264(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', [
            '-i', inputPath,
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '28',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            '-y',
            outputPath
        ]);
        ff.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error('ffmpeg video conversion exited with code ' + code));
        });
        ff.on('error', reject);
    });
}

/**
 * Step 1: Send Interactive Button Card (Audio MP3, Video 360p, Video 720p, Download Menu, Main Menu)
 */
async function sendYtSelectionMenu(sock, chatId, message, queryOrUrl, commandLabel = 'YouTube Downloader') {
    await sock.sendMessage(chatId, { react: { text: '🔍', key: message.key } });

    const info = await resolveYoutubeVideo(queryOrUrl);
    if (!info || !info.videoId) {
        await sock.sendMessage(chatId, { react: { text: '❌', key: message.key } });
        const errButtons = [
            { id: '.help download', text: '📥 Download Menu' },
            { id: '.menu', text: '📋 Main Menu' }
        ];
        if (sendButtons) {
            try {
                return await sendButtons(sock, chatId, {
                    text: `❌ *No YouTube results found for:* ${queryOrUrl}`,
                    footer: OWNER_BRAND,
                    buttons: errButtons
                }, { quoted: message });
            } catch (_) {}
        }
        return await sock.sendMessage(chatId, { text: `❌ No YouTube results found for: ${queryOrUrl}` }, { quoted: message });
    }

    const captionText =
        `🎬 *${commandLabel}*\n\n` +
        `📌 *Title:* ${info.title}\n` +
        `⏱️ *Duration:* ${info.timestamp}\n` +
        `👁️ *Views:* ${info.views}\n` +
        `📺 *Channel:* ${info.author}\n` +
        `🔗 *URL:* ${info.url}\n\n` +
        `👇 *Select a format button below to download:*`;

    const buttons = [
        { id: `.ytdl audio ${info.videoId}`, text: '🎵 Audio MP3' },
        { id: `.ytdl 360p ${info.videoId}`, text: '🎬 Video 360p' },
        { id: `.ytdl 720p ${info.videoId}`, text: '🎬 Video 720p (HD)' },
        { id: '.help download', text: '📥 Download Menu' },
        { id: '.menu', text: '📋 Main Menu' }
    ];

    await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });

    if (sendButtons) {
        try {
            let thumbBuffer = null;
            if (info.thumbnail) {
                try {
                    const imgRes = await axios.get(info.thumbnail, { responseType: 'arraybuffer', timeout: 10000 });
                    thumbBuffer = Buffer.from(imgRes.data);
                } catch (_) {}
            }
            const opts = {
                text: captionText,
                footer: `⚡ ${OWNER_BRAND}`,
                buttons
            };
            if (thumbBuffer) opts.image = thumbBuffer;
            return await sendButtons(sock, chatId, opts, { quoted: message });
        } catch (err) {
            console.warn('[ytPariApi] sendButtons with image failed, retrying text buttons:', err.message);
            try {
                return await sendButtons(sock, chatId, {
                    text: captionText,
                    footer: `⚡ ${OWNER_BRAND}`,
                    buttons
                }, { quoted: message });
            } catch (_) {}
        }
    }

    return await sock.sendMessage(chatId, {
        image: { url: info.thumbnail },
        caption: captionText
    }, { quoted: message });
}

/**
 * Step 2: Execute actual download from https://yt-down-pari.vercel.app/api/download
 * when user taps Audio MP3, Video 360p, or Video 720p button
 */
async function executeYtDownload(sock, chatId, message, mode = 'audio', videoIdOrUrl = '') {
    const info = await resolveYoutubeVideo(videoIdOrUrl);
    if (!info || !info.videoId) {
        return await sock.sendMessage(chatId, { text: '❌ Invalid YouTube video ID or URL.' }, { quoted: message });
    }

    await sock.sendMessage(chatId, { react: { text: '⏳', key: message.key } });

    const apiData = await fetchYtPariDownloadData(info.url);
    const chosenStream = selectBestStream(apiData.medias, mode);

    if (!chosenStream || !chosenStream.url) {
        await sock.sendMessage(chatId, { react: { text: '❌', key: message.key } });
        return await sock.sendMessage(chatId, {
            text: `❌ Could not retrieve an unlocked download stream for *${info.title}*.`
        }, { quoted: message });
    }

    const finalTitle = apiData.title || info.title || 'YouTube_Media';
    const safeFileName = finalTitle.replace(/[^a-zA-Z0-9-_\.]/g, '_').slice(0, 80) || 'youtube_media';
    const isAudio = ['audio', 'mp3', 'm4a'].includes(String(mode).toLowerCase());

    await sock.sendMessage(chatId, { react: { text: '📥', key: message.key } });

    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const mediaRes = await axios.get(chosenStream.url, {
        responseType: 'arraybuffer',
        timeout: 120000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const rawBuffer = Buffer.from(mediaRes.data);

    if (isAudio) {
        const rawAudioPath = path.join(tempDir, `${stamp}_in.m4a`);
        const outMp3Path = path.join(tempDir, `${stamp}_out.mp3`);
        let finalAudioBuffer = rawBuffer;

        try {
            fs.writeFileSync(rawAudioPath, rawBuffer);
            await convertAudioToMp3(rawAudioPath, outMp3Path);
            if (fs.existsSync(outMp3Path)) {
                finalAudioBuffer = fs.readFileSync(outMp3Path);
            }
        } catch (_) {
            finalAudioBuffer = rawBuffer;
        } finally {
            try { if (fs.existsSync(rawAudioPath)) fs.unlinkSync(rawAudioPath); } catch (_) {}
            try { if (fs.existsSync(outMp3Path)) fs.unlinkSync(outMp3Path); } catch (_) {}
        }

        await sock.sendMessage(chatId, {
            audio: finalAudioBuffer,
            mimetype: 'audio/mpeg',
            fileName: `${safeFileName}.mp3`,
            ptt: false
        }, { quoted: message });

        await sock.sendMessage(chatId, { react: { text: '🎶', key: message.key } });

        if (sendButtons) {
            try {
                await sendButtons(sock, chatId, {
                    text: `✅ *Audio Downloaded*\n🎵 *${finalTitle}*`,
                    footer: `⚡ ${OWNER_BRAND}`,
                    buttons: [
                        { id: `.ytdl 360p ${info.videoId}`, text: '🎬 Video 360p' },
                        { id: `.ytdl 720p ${info.videoId}`, text: '🎬 Video 720p (HD)' },
                        { id: '.help download', text: '📥 Download Menu' },
                        { id: '.menu', text: '📋 Main Menu' }
                    ]
                }, { quoted: message });
            } catch (_) {}
        }
        return;
    }

    // Video handling
    const rawVideoPath = path.join(tempDir, `${stamp}_raw.mp4`);
    const outVideoPath = path.join(tempDir, `${stamp}_out.mp4`);
    let finalVideoBuffer = rawBuffer;

    try {
        fs.writeFileSync(rawVideoPath, rawBuffer);
        await convertVideoToH264(rawVideoPath, outVideoPath);
        if (fs.existsSync(outVideoPath)) {
            finalVideoBuffer = fs.readFileSync(outVideoPath);
        }
    } catch (_) {
        finalVideoBuffer = rawBuffer;
    } finally {
        try { if (fs.existsSync(rawVideoPath)) fs.unlinkSync(rawVideoPath); } catch (_) {}
        try { if (fs.existsSync(outVideoPath)) fs.unlinkSync(outVideoPath); } catch (_) {}
    }

    const qualityLabel = chosenStream.quality || mode || '360p';

    await sock.sendMessage(chatId, {
        video: finalVideoBuffer,
        mimetype: 'video/mp4',
        fileName: `${safeFileName}_${qualityLabel}.mp4`,
        caption: `🎬 *${finalTitle}*\n📊 *Quality:* ${qualityLabel}${chosenStream.sizeStr ? ` (${chosenStream.sizeStr})` : ''}\n\n> *⚡ ${OWNER_BRAND}*`
    }, { quoted: message });

    await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });

    if (sendButtons) {
        try {
            const altQuality = String(qualityLabel).includes('720') ? '360p' : '720p';
            await sendButtons(sock, chatId, {
                text: `✅ *Video (${qualityLabel}) Sent!*\nTap below for Audio MP3, ${altQuality} Video, or Menus:`,
                footer: `⚡ ${OWNER_BRAND}`,
                buttons: [
                    { id: `.ytdl audio ${info.videoId}`, text: '🎵 Audio MP3' },
                    { id: `.ytdl ${altQuality} ${info.videoId}`, text: `🎬 Video ${altQuality}` },
                    { id: '.help download', text: '📥 Download Menu' },
                    { id: '.menu', text: '📋 Main Menu' }
                ]
            }, { quoted: message });
        } catch (_) {}
    }
}

module.exports = {
    YT_PARI_API_URL,
    extractYoutubeId,
    resolveYoutubeVideo,
    fetchYtPariDownloadData,
    selectBestStream,
    sendYtSelectionMenu,
    executeYtDownload
};
