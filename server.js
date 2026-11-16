const express = require('express');
const { execFile } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const execFileAsync = promisify(execFile);

const PORT = process.env.PORT || 3000;
const MUSIC_DIR = path.resolve(process.env.MUSIC_DIR || './music');
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
const URL_TTL = 30 * 60; // 30 menit
const AUDIO_EXT = new Set(['.flac', '.alac', '.m4a', '.wav', '.mp3', '.aac']);
const RANK = { low: 1, high: 2, lossless: 3, hires: 4 };

const probeCache = new Map();
const app = express();

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

const idFor = (rel) => Buffer.from(rel).toString('base64url');
const relFor = (id) => Buffer.from(id, 'base64url').toString('utf8');

function safePath(rel) {
  const full = path.resolve(MUSIC_DIR, rel);
  return full.startsWith(MUSIC_DIR + path.sep) ? full : null;
}

async function probe(file) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,bits_per_raw_sample,bits_per_sample,bit_rate:format=format_name,bit_rate',
    '-of', 'json',
    file
  ]);
  const j = JSON.parse(stdout);
  const s = j.streams?.[0] || {};
  const f = j.format || {};
  return {
    codec: s.codec_name || 'unknown',
    container: f.format_name || 'unknown',
    sampleRate: parseInt(s.sample_rate, 10) || null,
    bitDepth: parseInt(s.bits_per_raw_sample, 10) || parseInt(s.bits_per_sample, 10) || null,
    bitrate: Math.round((parseInt(s.bit_rate || f.bit_rate, 10) || 0) / 1000)
  };
}

async function getInfo(full) {
  const mtime = fs.statSync(full).mtimeMs;
  const cached = probeCache.get(full);
  if (cached && cached.mtime === mtime) return cached.info;
  const info = await probe(full);
  probeCache.set(full, { mtime, info });
  return info;
}

function classify(info) {
  const lossless = info.codec === 'flac' || info.codec === 'alac' || info.codec.startsWith('pcm_');
  if (lossless) {
    if ((info.sampleRate && info.sampleRate > 48000) || info.bitDepth === 24) return 'hires';
    return 'lossless';
  }
  if (info.codec === 'aac' || info.codec === 'mp3') {
    return info.bitrate >= 256 ? 'high' : 'low';
  }
  return 'low';
}

function signedUrl(id) {
  const exp = Math.floor(Date.now() / 1000) + URL_TTL;
  const sig = crypto.createHmac('sha256', SECRET).update(`${id}:${exp}`).digest('hex');
  return `${PUBLIC_URL}/file/${id}?exp=${exp}&sig=${sig}`;
}

app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'layyyz.bitchord.quality',
    name: 'Quality Labeler',
    version: '1.0.0',
    description: 'Label kualitas audio berdasarkan file asli',
    resources: ['search', 'stream'],
    settings: [
      {
        key: 'minQuality',
        type: 'select',
        title: 'Minimum kualitas',
        options: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' },
          { value: 'lossless', label: 'Lossless' },
          { value: 'hires', label: 'Hi-Res Lossless' }
        ],
        default: 'low'
      }
    ]
  });
});

app.get('/search', async (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const minQ = RANK[req.query.quality] ? req.query.quality : 'low';
  const tracks = [];

  for (const full of walk(MUSIC_DIR)) {
    const rel = path.relative(MUSIC_DIR, full);
    const parts = rel.split(path.sep);
    const title = path.basename(full, path.extname(full));
    const artist = parts.length >= 3 ? parts[0] : 'Unknown';
    const album = parts.length >= 3 ? parts[1] : 'Unknown';

    if (q && !`${title} ${artist} ${album}`.toLowerCase().includes(q)) continue;

    try {
      const quality = classify(await getInfo(full));
      if (RANK[quality] < RANK[minQ]) continue;
      tracks.push({ id: idFor(rel), title, artist, album, quality });
    } catch (err) {
      console.error('Gagal probe', rel, err.message);
    }
  }

  res.json({ tracks });
});

app.get('/stream/:id', async (req, res) => {
  const rel = relFor(req.params.id);
  const full = safePath(rel);
  if (!full || !fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });

  try {
    const info = await getInfo(full);
    const quality = classify(info);
    const minQ = RANK[req.query.quality] ? req.query.quality : 'low';
    if (RANK[quality] < RANK[minQ]) return res.json({ streams: [] });

    res.json({
      streams: [{
        url: signedUrl(req.params.id),
        ...info,
        quality,
        encrypted: false
      }]
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal membaca file' });
  }
});

app.get('/file/:id', (req, res) => {
  const { exp, sig } = req.query;
  const expected = crypto.createHmac('sha256', SECRET).update(`${req.params.id}:${exp}`).digest('hex');
  if (!sig || sig !== expected || Number(exp) < Math.floor(Date.now() / 1000)) {
    return res.status(403).send('Forbidden');
  }
  const full = safePath(relFor(req.params.id));
  if (!full || !fs.existsSync(full)) return res.status(404).send('Not found');
  res.sendFile(full);
});

app.listen(PORT, () => console.log(`Addon jalan di ${PUBLIC_URL}`));
