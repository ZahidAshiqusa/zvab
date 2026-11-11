'use strict';

const axios = require('axios');
const yts = require('yt-search');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

let sendButtons = null;
try {
    sendButtons = require('kango-wa').sendButtons;
} catch (_) {
    sendButtons = null;
}

const YT_PARI_API_URL = 'https://yt-down-pari.vercel.app/api/download';
const CNV_KEY_URL = 'https://cnv.cx/v2/sanity/key';
const CNV_CONVERTER_URL = 'https://cnv.cx/v2/converter';
const OWNER_BRAND = 'Zaid Ashiq X Ultra V. Coder';

const CNV_HEADERS = {
    'origin': 'https://frame.y2meta-uk.com',
    'referer': 'https://frame.y2meta-uk.com/',
    'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36',
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.9'
};

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
 * Sanitizes out creator/team/channel fields and returns clean media metadata & streams.
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
                'User-Agent': CNV_HEADERS['user-agent']
            },
            timeout: 25000
        }
    );

    const payload = response.data || {};
    const dataNode = payload?.result?.data || payload?.data || {};
    const rawMedias = Array.isArray(dataNode.medias) ? dataNode.medias : [];

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

/**
 * Authenticated tunnel stream generator via cnv.cx (returns non-IP-bound tunnel URLs)
 * Fixes 400 (missing ?link= parameter) and 403 (requires Origin & Referer headers on tunnel download).
 */
async function fetchCnvTunnelStream(youtubeUrlOrId, mode = 'audio') {
    const vid = extractYoutubeId(youtubeUrlOrId);
    const canonicalUrl = vid
        ? `https://www.youtube.com/watch?v=${vid}`
        : String(youtubeUrlOrId || '').trim();

    const normalizedMode = String(mode || 'audio').toLowerCase();
    const isAudio = ['audio', 'mp3', 'm4a'].includes(normalizedMode);

    const keyRes = await axios.get(`${CNV_KEY_URL}?link=${encodeURIComponent(canonicalUrl)}`, {
        headers: {
            ...CNV_HEADERS,
            'content-type': 'application/json'
        },
        timeout: 15000
    });

    const sanityKey = keyRes.data?.key;
    if (!sanityKey) {
        throw new Error('Failed to obtain tunnel key from cnv.cx');
    }

    const requestConversion = async (qualityNum) => {
        const params = isAudio
            ? new URLSearchParams({
                link: canonicalUrl,
                filenameStyle: 'pretty',
                format: 'mp3',
                audioBitrate: '128'
            })
            : new URLSearchParams({
                link: canonicalUrl,
                filenameStyle: 'pretty',
                format: 'mp4',
                videoQuality: String(qualityNum),
                audioBitrate: '128',
                vCodec: 'h264'
            });

        const convRes = await axios.post(CNV_CONVERTER_URL, params.toString(), {
            headers: {
                ...CNV_HEADERS,
                'content-type': 'application/x-www-form-urlencoded',
                'key': sanityKey
            },
            timeout: 35000
        });

        const data = convRes.data || {};
        if (!data.url || !String(data.url).startsWith('http')) {
            throw new Error(data.errorMsg || data.message || 'No tunnel URL returned');
        }

        const cleanTitle = data.filename
            ? String(data.filename)
                .replace(/\s*\(\d+p,\s*h264\)\.(mp4|mp3|m4a)$/i, '')
                .replace(/\.(mp4|mp3|m4a)$/i, '')
                .trim()
            : null;

        return {
            url: data.url,
            title: cleanTitle,
            filename: data.filename || null,
            quality: isAudio ? '128kbps' : `${qualityNum}p`,
            format: isAudio ? '.mp3' : '.mp4',
            isTunnel: true,
            headers: CNV_HEADERS
        };
    };

    if (isAudio) {
        return await requestConversion('128');
    }

    const desiredQuality = normalizedMode.includes('720')
        ? '720'
        : (normalizedMode.includes('480') ? '480' : '360');

    try {
        return await requestConversion(desiredQuality);
    } catch (err) {
        if (desiredQuality !== '360') {
            return await requestConversion('360');
        }
        throw err;
    }
}

function selectBestStream(medias, mode = 'audio') {
    if (!Array.isArray(medias) || medias.length === 0) return null;

    const normalizedMode = String(mode || 'audio').toLowerCase();

    if (normalizedMode === 'audio' || normalizedMode === 'mp3' || normalizedMode === 'm4a') {
        const m4aStreams = medias.filter(m => String(m.format || '').toLowerCase().includes('.m4a'));
        if (m4aStreams.length > 0) return m4aStreams[0];

        const webaStreams = medias.filter(m => String(m.format || '').toLowerCase().includes('.weba') || String(m.url || '').includes('mime=audio'));
        if (webaStreams.length > 0) return webaStreams[0];

        return medias[medias.length - 1];
    }

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

    return (
        pool.find(m => String(m.quality || '').toLowerCase() === '360p') ||
        pool.find(m => String(m.quality || '').toLowerCase() === '480p') ||
        pool.find(m => String(m.quality || '').toLowerCase() === '720p') ||
        pool.find(m => String(m.quality || '').toLowerCase() === '240p') ||
        pool[0]
    );
}

function downloadWithCurl(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const args = ['-sL', '--fail', '--max-time', '90'];
        if (headers['user-agent'] || headers['User-Agent']) {
            args.push('-A', headers['user-agent'] || headers['User-Agent']);
        }
        if (headers['referer'] || headers['Referer']) {
            args.push('-H', `Referer: ${headers['referer'] || headers['Referer']}`);
        }
        if (headers['origin'] || headers['Origin']) {
            args.push('-H', `Origin: ${headers['origin'] || headers['Origin']}`);
        }
        args.push(url);

        execFile('curl', args, { encoding: 'buffer', maxBuffer: 80 * 1024 * 1024 }, (err, stdout) => {
            if (err) return reject(err);
            if (!stdout || stdout.length < 1024) {
                return reject(new Error('Downloaded buffer is empty or too small'));
            }
            resolve(Buffer.from(stdout));
        });
    });
}

async function fetchStreamBufferWithFallback(url, customHeaders = {}) {
    const reqHeaders = {
        ...CNV_HEADERS,
        ...customHeaders
    };

    try {
        const mediaRes = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 120000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            headers: reqHeaders
        });
        const buf = Buffer.from(mediaRes.data);
        if (buf.length > 1024) {
            return buf;
        }
    } catch (axiosErr) {
        try {
            return await downloadWithCurl(url, reqHeaders);
        } catch (_) {
            throw axiosErr;
        }
    }

    return await downloadWithCurl(url, reqHeaders);
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
 * Step 2: Execute actual download when user taps Audio MP3, Video 360p, or Video 720p button.
 * Combines yt-down-pari.vercel.app metadata with authenticated cnv.cx tunnel stream to prevent HTTP 403.
 */
async function executeYtDownload(sock, chatId, message, mode = 'audio', videoIdOrUrl = '') {
    const info = await resolveYoutubeVideo(videoIdOrUrl);
    if (!info || !info.videoId) {
        return await sock.sendMessage(chatId, { text: '❌ Invalid YouTube video ID or URL.' }, { quoted: message });
    }

    await sock.sendMessage(chatId, { react: { text: '⏳', key: message.key } });

    // Fetch metadata from yt-down-pari and authenticated tunnel stream in parallel
    const [pariResult, tunnelResult] = await Promise.allSettled([
        fetchYtPariDownloadData(info.url),
        fetchCnvTunnelStream(info.url, mode)
    ]);

    const apiData = pariResult.status === 'fulfilled' ? pariResult.value : { medias: [] };
    const tunnelStream = tunnelResult.status === 'fulfilled' ? tunnelResult.value : null;
    const pariStream = selectBestStream(apiData.medias, mode);

    if (!tunnelStream && (!pariStream || !pariStream.url)) {
        await sock.sendMessage(chatId, { react: { text: '❌', key: message.key } });
        return await sock.sendMessage(chatId, {
            text: `❌ Could not retrieve a playable download stream for *${info.title}*.`
        }, { quoted: message });
    }

    const finalTitle = apiData.title || tunnelStream?.title || info.title || 'YouTube_Media';
    const safeFileName = finalTitle.replace(/[^a-zA-Z0-9-_\.]/g, '_').slice(0, 80) || 'youtube_media';
    const isAudio = ['audio', 'mp3', 'm4a'].includes(String(mode).toLowerCase());

    await sock.sendMessage(chatId, { react: { text: '📥', key: message.key } });

    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    let rawBuffer = null;
    let usedTunnel = false;
    let chosenMeta = tunnelStream || pariStream;

    // 1. Primary download via authenticated tunnel (non-IP-locked, returns HTTP 200)
    if (tunnelStream && tunnelStream.url) {
        try {
            rawBuffer = await fetchStreamBufferWithFallback(tunnelStream.url, tunnelStream.headers || CNV_HEADERS);
            usedTunnel = true;
            chosenMeta = tunnelStream;
        } catch (tunnelErr) {
            console.warn('[ytPariApi] Tunnel stream fetch failed, trying pari stream:', tunnelErr.message);
        }
    }

    // 2. Fallback to yt-down-pari stream if needed
    if (!rawBuffer && pariStream && pariStream.url) {
        rawBuffer = await fetchStreamBufferWithFallback(pariStream.url, { 'User-Agent': 'Mozilla/5.0' });
        usedTunnel = false;
        chosenMeta = pariStream;
    }

    if (!rawBuffer || rawBuffer.length === 0) {
        throw new Error('Failed to download media stream buffer');
    }

    if (isAudio) {
        let finalAudioBuffer = rawBuffer;
        // Tunnel stream is already 128kbps MP3; only run ffmpeg conversion if fallback M4A/WebA stream was used
        if (!usedTunnel) {
            const rawAudioPath = path.join(tempDir, `${stamp}_in.m4a`);
            const outMp3Path = path.join(tempDir, `${stamp}_out.mp3`);
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
    let finalVideoBuffer = rawBuffer;
    if (!usedTunnel) {
        const rawVideoPath = path.join(tempDir, `${stamp}_raw.mp4`);
        const outVideoPath = path.join(tempDir, `${stamp}_out.mp4`);
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
    }

    const qualityLabel = chosenMeta?.quality || pariStream?.quality || mode || '360p';
    const sizeInfo = pariStream?.sizeStr || `${(finalVideoBuffer.length / (1024 * 1024)).toFixed(2)} MB`;

    await sock.sendMessage(chatId, {
        video: finalVideoBuffer,
        mimetype: 'video/mp4',
        fileName: `${safeFileName}_${qualityLabel}.mp4`,
        caption: `🎬 *${finalTitle}*\n📊 *Quality:* ${qualityLabel} (${sizeInfo})\n\n> *⚡ ${OWNER_BRAND}*`
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

/**
 * Direct helpers for lib/media.js compatibility (getAudio / getVideo)
 */
async function getAudio(youtubeUrl) {
    const info = await resolveYoutubeVideo(youtubeUrl);
    const targetUrl = info?.url || youtubeUrl;
    const tunnel = await fetchCnvTunnelStream(targetUrl, 'audio');
    const buffer = await fetchStreamBufferWithFallback(tunnel.url, tunnel.headers);
    return {
        buffer,
        title: tunnel.title || info?.title || 'YouTube Audio',
        thumbnail: info?.thumbnail || null
    };
}

async function getVideo(youtubeUrl, quality = '360p') {
    const info = await resolveYoutubeVideo(youtubeUrl);
    const targetUrl = info?.url || youtubeUrl;
    const tunnel = await fetchCnvTunnelStream(targetUrl, quality);
    const buffer = await fetchStreamBufferWithFallback(tunnel.url, tunnel.headers);
    return {
        fileUrl: tunnel.url,
        buffer,
        title: tunnel.title || info?.title || 'YouTube Video',
        thumbnail: info?.thumbnail || null
    };
}

module.exports = {
    YT_PARI_API_URL,
    CNV_HEADERS,
    extractYoutubeId,
    resolveYoutubeVideo,
    fetchYtPariDownloadData,
    fetchCnvTunnelStream,
    fetchStreamBufferWithFallback,
    selectBestStream,
    sendYtSelectionMenu,
    executeYtDownload,
    getAudio,
    getVideo
};
