const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const AdmZip = require('adm-zip');
const http = require('http');
const https = require('https');
const { google } = require('googleapis');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3017;

// Target Google Drive Folder ID
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || process.env.GOOGLE_DRIVE_FOLDER_ID || '1XihGWQM1jjQenAFxJdhB7kkdPjNmDycz';

// Silence Favicon 404 logs
app.get(['/favicon.ico', '/favicon.png'], (req, res) => res.status(204).end());

// --- 1. GOOGLE DRIVE SETUP ---
let oauth2Client = null;
let driveService = null;

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
    try {
        oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET
        );

        oauth2Client.setCredentials({
            refresh_token: process.env.GOOGLE_REFRESH_TOKEN
        });

        driveService = google.drive({ version: 'v3', auth: oauth2Client });
        console.log("Google Drive OAuth connected successfully.");
    } catch (e) {
        console.error('Failed to initialize Google Drive OAuth client:', e.message);
    }
} else {
    const credPath = path.join(__dirname, 'credentials.json');
    if (fs.existsSync(credPath)) {
        try {
            const auth = new google.auth.GoogleAuth({
                keyFile: credPath,
                scopes: ['https://www.googleapis.com/auth/drive']
            });
            oauth2Client = auth;
            driveService = google.drive({ version: 'v3', auth });
            console.log("Google Drive Service Account connected successfully.");
        } catch (e) {
            console.error('Failed to initialize Service Account:', e.message);
        }
    } else {
        console.error("Missing Google OAuth environment variables and credentials.json.");
    }
}

async function getAccessToken() {
    if (oauth2Client && typeof oauth2Client.getAccessToken === 'function') {
        const tokenRes = await oauth2Client.getAccessToken();
        return typeof tokenRes === 'string' ? tokenRes : tokenRes.token;
    } else if (oauth2Client && typeof oauth2Client.getClient === 'function') {
        const client = await oauth2Client.getClient();
        const tokenRes = await client.getAccessToken();
        return typeof tokenRes === 'string' ? tokenRes : tokenRes.token;
    }
    throw new Error('Google Auth client not initialized.');
}

// --- HELPER: SEARCH GOOGLE DRIVE BY FILENAME ---
async function findDriveFileByName(fileName) {
    if (!driveService || !fileName) return null;
    try {
        const query = `'${DRIVE_FOLDER_ID}' in parents and name = '${fileName.replace(/'/g, "\\'")}' and trashed = false`;
        const res = await driveService.files.list({
            q: query,
            fields: 'files(id, name, mimeType, size)',
            spaces: 'drive'
        });
        if (res.data.files && res.data.files.length > 0) {
            return res.data.files[0];
        }
    } catch (err) {
        console.error('Error searching Drive for pre-reserved file:', err.message);
    }
    return null;
}

// --- HELPER: TWO-WAY GOOGLE DRIVE SYNC FOR A SINGLE RECORD ---
async function syncRecordWithDrive(table, record) {
    if (!driveService || !record.drive_file_id || record.drive_file_id === 'PENDING_DIRECT_DRIVE_UPLOAD') {
        return record;
    }

    try {
        const driveRes = await driveService.files.get({
            fileId: record.drive_file_id,
            fields: 'id, name, trashed, size'
        });

        const driveFile = driveRes.data;

        if (driveFile.trashed) {
            await db.execute({ sql: `DELETE FROM ${table} WHERE id = ?`, args: [record.id] });
            await logActivity(`${table.toUpperCase()}_AUTO_DELETE_SYNC`, { id: record.id, driveId: record.drive_file_id });
            return null;
        }

        const currentLocalName = table === 'shared_files' ? (record.file_name || record.original_name) : record.original_name;
        if (driveFile.name && driveFile.name !== currentLocalName) {
            if (table === 'shared_files') {
                await db.execute({
                    sql: `UPDATE shared_files SET file_name = ?, original_name = ? WHERE id = ?`,
                    args: [driveFile.name, driveFile.name, record.id]
                });
                record.file_name = driveFile.name;
                record.original_name = driveFile.name;
            } else if (table === 'incoming_files') {
                await db.execute({
                    sql: `UPDATE incoming_files SET original_name = ? WHERE id = ?`,
                    args: [driveFile.name, record.id]
                });
                record.original_name = driveFile.name;
            }
            await logActivity(`${table.toUpperCase()}_AUTO_RENAME_SYNC`, { id: record.id, newName: driveFile.name });
        }

        return record;
    } catch (err) {
        if (err.code === 404 || (err.response && err.response.status === 404)) {
            await db.execute({ sql: `DELETE FROM ${table} WHERE id = ?`, args: [record.id] });
            await logActivity(`${table.toUpperCase()}_AUTO_DELETE_SYNC`, { id: record.id, driveId: record.drive_file_id });
            return null;
        }
        return record;
    }
}

// --- 2. TURSO / LIBSQL DATABASE SETUP ---
let tursoUrl = process.env.TURSO_DATABASE_URL || "file:share.db";
const tursoAuthToken = process.env.TURSO_AUTH_TOKEN || "";

if (tursoUrl.startsWith("libsql://")) {
    tursoUrl = tursoUrl.replace("libsql://", "https://");
}

const db = createClient({
    url: tursoUrl,
    authToken: tursoAuthToken
});

async function initDatabase() {
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS shared_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                slug TEXT UNIQUE,
                drive_file_id TEXT,
                original_name TEXT,
                file_name TEXT,
                mime_type TEXT,
                file_size INTEGER,
                password TEXT,
                expiration INTEGER,
                expires_at INTEGER,
                max_downloads INTEGER,
                downloads INTEGER DEFAULT 0,
                status TEXT DEFAULT 'active',
                created_at INTEGER
            )
        `);

        try { await db.execute(`ALTER TABLE shared_files ADD COLUMN expires_at INTEGER`); } catch (e) {}
        try { await db.execute(`ALTER TABLE shared_files ADD COLUMN expiration INTEGER`); } catch (e) {}
        try { await db.execute(`ALTER TABLE shared_files ADD COLUMN status TEXT DEFAULT 'active'`); } catch (e) {}
        try { await db.execute(`ALTER TABLE shared_files ADD COLUMN drive_file_id TEXT`); } catch (e) {}
        try { await db.execute(`ALTER TABLE shared_files ADD COLUMN original_name TEXT`); } catch (e) {}
        try { await db.execute(`ALTER TABLE shared_files ADD COLUMN file_name TEXT`); } catch (e) {}

        await db.execute(`
            CREATE TABLE IF NOT EXISTS file_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                slug TEXT UNIQUE,
                title TEXT,
                email TEXT,
                description TEXT,
                created_at INTEGER
            )
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS incoming_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                request_id INTEGER,
                drive_file_id TEXT,
                original_name TEXT,
                mime_type TEXT,
                file_size INTEGER,
                uploaded_at INTEGER
            )
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT,
                details TEXT,
                created_at INTEGER
            )
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        `);
        console.log("Turso Cloud Database connected and initialized.");
    } catch (e) {
        console.error("Database initialization error:", e.message);
    }
}
initDatabase();

// --- MIDDLEWARE ---
app.set('trust proxy', true);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

const upload = multer({ dest: os.tmpdir() });

// --- UTILITY HELPERS ---
function getClientIp(req) {
    return req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown IP';
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function logActivity(eventType, details) {
    try {
        await db.execute({
            sql: `INSERT INTO activity_logs (event_type, details, created_at) VALUES (?, ?, ?)`,
            args: [eventType, JSON.stringify(details), Date.now()]
        });
    } catch(e){}
}

async function verifyUserPassword(providedPwd) {
    try {
        const res = await db.execute({ sql: `SELECT value FROM settings WHERE key = 'user_password'`, args: [] });
        const row = res.rows[0];
        
        if (row && row.value !== undefined && row.value !== null) {
            if (row.value.trim() === '') return true;
            return (providedPwd || '').trim() === row.value.trim();
        }
        
        const envUserPwd = process.env.USER_PASSWORD;
        if (!envUserPwd) return true;
        return (providedPwd || '').trim() === envUserPwd.trim();
    } catch (e) {
        console.error('verifyUserPassword DB error, denying access:', e.message);
        return false;
    }
}

async function verifyAdminPassword(providedPwd) {
    try {
        const res = await db.execute({ sql: `SELECT value FROM settings WHERE key = 'admin_password'`, args: [] });
        const row = res.rows[0];
        
        if (row && row.value !== undefined && row.value !== null) {
            if (row.value.trim() === '') return true;
            return (providedPwd || '').trim() === row.value.trim();
        }
        
        const envAdminPwd = process.env.ADMIN_PASSWORD;
        if (!envAdminPwd) return true;
        return (providedPwd || '').trim() === envAdminPwd.trim();
    } catch (e) {
        console.error('verifyAdminPassword DB error, denying access:', e.message);
        return false;
    }
}

async function verifyAnyPassword(providedPwd) {
    const isUser = await verifyUserPassword(providedPwd);
    if (isUser) return true;
    const isAdmin = await verifyAdminPassword(providedPwd);
    return isAdmin;
}

// If DISCORD_RELAY_URL is set, notifications are POSTed to that relay (e.g. a
// Cloudflare Worker endpoint) instead of straight to discord.com. This exists
// because Render's shared outbound IPs can get Cloudflare-edge-blocked
// (HTTP 429 / "error code: 1015") before the request ever reaches Discord.
// The relay runs on infrastructure with a working egress path to Discord and
// simply forwards the payload on. DISCORD_RELAY_SECRET authenticates the
// request so the relay isn't an open proxy. If DISCORD_RELAY_URL isn't set,
// behavior falls back to the original direct-to-Discord call.
async function sendViaRelay(relayUrl, webhookUrl, payload, title) {
    return new Promise((resolve) => {
        let urlObj;
        try {
            urlObj = new URL(relayUrl);
        } catch (e) {
            console.error(`[Discord] Invalid DISCORD_RELAY_URL: ${e.message}`);
            resolve({ ok: false, reason: 'invalid_relay_url' });
            return;
        }

        const body = JSON.stringify({ webhookUrl, payload: JSON.parse(payload) });
        const reqOptions = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'x-relay-secret': process.env.DISCORD_RELAY_SECRET || ''
            },
            timeout: 10000
        };

        const client = urlObj.protocol === 'https:' ? https : http;
        const req = client.request(reqOptions, (relayRes) => {
            let resBody = '';
            relayRes.on('data', (chunk) => { resBody += chunk; });
            relayRes.on('end', () => {
                if (relayRes.statusCode >= 200 && relayRes.statusCode < 300) {
                    console.log(`[Discord] Relayed "${title}" via ${urlObj.hostname} (status ${relayRes.statusCode}).`);
                    resolve({ ok: true, status: relayRes.statusCode, via: 'relay' });
                } else {
                    console.error(`[Discord] Relay rejected "${title}": status ${relayRes.statusCode} body=${resBody.slice(0, 300)}`);
                    resolve({ ok: false, reason: 'relay_rejected', status: relayRes.statusCode, body: resBody.slice(0, 300) });
                }
            });
        });

        req.on('timeout', () => {
            console.error(`[Discord] Relay timed out sending "${title}".`);
            req.destroy();
            resolve({ ok: false, reason: 'relay_timeout' });
        });

        req.on('error', (err) => {
            console.error(`[Discord] Relay request error sending "${title}":`, err.message);
            resolve({ ok: false, reason: 'relay_request_error', message: err.message });
        });

        req.write(body);
        req.end();
    });
}

async function sendDiscordNotification(title, description, fields = []) {
    try {
        const res = await db.execute({ sql: `SELECT value FROM settings WHERE key = 'discord_webhook'`, args: [] });
        const row = res.rows[0];

        let webhookUrl = (row && row.value && row.value.trim() !== '')
            ? row.value.trim()
            : (process.env.DISCORD_WEBHOOK || '');

        if (!webhookUrl || (!webhookUrl.startsWith('http://') && !webhookUrl.startsWith('https://'))) {
            console.warn('[Discord] Skipped: no webhook URL configured.');
            return { ok: false, reason: 'no_webhook_configured' };
        }

        const payload = JSON.stringify({
            embeds: [{
                title, description, color: 3447003, fields,
                footer: { text: "Yankitz Cloud Manager" },
                timestamp: new Date().toISOString()
            }]
        });

        const relayUrl = process.env.DISCORD_RELAY_URL;
        if (relayUrl && relayUrl.trim() !== '') {
            return await sendViaRelay(relayUrl.trim(), webhookUrl, payload, title);
        }

        const urlObj = new URL(webhookUrl);
        const reqOptions = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 10000
        };

        const client = urlObj.protocol === 'https:' ? https : http;

        // Wrapped in a Promise and awaited by every caller so the request is
        // guaranteed to finish (or fail loudly) before the handler returns,
        // instead of being fire-and-forget and silently dropped mid-flight.
        const result = await new Promise((resolve) => {
            const req = client.request(reqOptions, (discordRes) => {
                let body = '';
                discordRes.on('data', (chunk) => { body += chunk; });
                discordRes.on('end', () => {
                    if (discordRes.statusCode >= 200 && discordRes.statusCode < 300) {
                        console.log(`[Discord] Sent "${title}" (status ${discordRes.statusCode}).`);
                        resolve({ ok: true, status: discordRes.statusCode });
                    } else {
                        console.error(`[Discord] Webhook rejected "${title}": status ${discordRes.statusCode} body=${body.slice(0, 300)}`);
                        resolve({ ok: false, reason: 'rejected', status: discordRes.statusCode, body: body.slice(0, 300) });
                    }
                });
            });

            req.on('timeout', () => {
                console.error(`[Discord] Timed out sending "${title}".`);
                req.destroy();
                resolve({ ok: false, reason: 'timeout' });
            });

            req.on('error', (err) => {
                console.error(`[Discord] Request error sending "${title}":`, err.message);
                resolve({ ok: false, reason: 'request_error', message: err.message });
            });

            req.write(payload);
            req.end();
        });
        return result;
    } catch (e) {
        console.error('[Discord] sendDiscordNotification failed:', e.message);
        return { ok: false, reason: 'exception', message: e.message };
    }
}

function parseRangeHeader(rangeHeader, fileSize) {
    if (!rangeHeader || typeof rangeHeader !== 'string' || !fileSize) return null;

    const trimmed = rangeHeader.trim();
    if (!trimmed.startsWith('bytes=')) return { invalid: true };

    const spec = trimmed.substring(6).trim();
    const parts = spec.split('-');
    if (parts.length !== 2) return { invalid: true };

    let start = parts[0] !== '' ? parseInt(parts[0], 10) : null;
    let end = parts[1] !== '' ? parseInt(parts[1], 10) : null;

    if (start === null && end !== null) {
        if (isNaN(end) || end <= 0) return { invalid: true };
        start = Math.max(0, fileSize - end);
        end = fileSize - 1;
    } else if (start !== null && end === null) {
        if (isNaN(start)) return { invalid: true };
        end = fileSize - 1;
    } else if (start !== null && end !== null) {
        if (isNaN(start) || isNaN(end)) return { invalid: true };
    } else {
        return { invalid: true };
    }

    if (start >= fileSize || end >= fileSize || start > end || start < 0) {
        return { invalid: true };
    }

    return { start, end, chunkSize: end - start + 1, invalid: false };
}

// --- PUBLIC TEMPLATES ---
const viewPageTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Yankitz Cloud Manager - View & Download</title>
    <style>
        :root { --primary: #0066ff; --primary-hover: #0052cc; --bg: #f4f6f9; --card-bg: #ffffff; --text: #1e293b; --muted: #64748b; --border: #e2e8f0; --danger: #ef4444; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: var(--bg); color: var(--text); display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
        .card { background: var(--card-bg); border-radius: 12px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.05); padding: 28px; width: 100%; max-width: 640px; text-align: center; border: 1px solid var(--border); }
        .preview-container { width: 100%; max-height: 420px; margin-bottom: 20px; border-radius: 8px; overflow: hidden; background-color: #0f172a; display: flex; align-items: center; justify-content: center; border: 1px solid var(--border); }
        .preview-container img, .preview-container video { max-width: 100%; max-height: 420px; object-fit: contain; }
        .preview-container iframe { width: 100%; height: 420px; border: none; }
        .icon-wrapper { width: 64px; height: 64px; background-color: #eff6ff; color: var(--primary); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px auto; }
        h2 { margin: 0 0 6px 0; font-size: 1.25rem; font-weight: 600; word-break: break-all; }
        .file-info { font-size: 0.875rem; color: var(--muted); margin-bottom: 20px; }
        .form-group { margin-bottom: 20px; text-align: left; }
        label { display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 6px; }
        input[type="password"] { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; font-size: 0.95rem; box-sizing: border-box; outline: none; }
        .btn { background-color: var(--primary); color: white; border: none; padding: 12px 20px; border-radius: 6px; font-size: 1rem; font-weight: 600; cursor: pointer; width: 100%; transition: background-color 0.2s; }
        .btn:hover { background-color: var(--primary-hover); }
        .brand { margin-top: 24px; font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }

        .dl-progress-card { background: #f8fafc; border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-top: 16px; text-align: left; display: none; }
        .dl-progress-card.active { display: block; }
        .dl-header { display: flex; justify-content: space-between; align-items: center; font-weight: 600; font-size: 0.875rem; margin-bottom: 8px; color: #1e293b; }
        .dl-bar-bg { width: 100%; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; margin-bottom: 8px; }
        .dl-bar-fill { height: 100%; width: 0%; background: var(--primary); transition: width 0.15s ease-out; }
        .dl-meta { display: flex; justify-content: space-between; font-size: 0.8rem; color: var(--muted); }
        
        .torrent-controls { display: flex; gap: 6px; }
        .btn-ctrl { background: #fff; border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; font-size: 0.75rem; font-weight: 600; cursor: pointer; color: #475569; }
        .btn-ctrl:hover { background: #f8fafc; }
        .btn-ctrl.danger { color: var(--danger); border-color: #fca5a5; }
    </style>
</head>
<body>
    <div class="card">
        <div id="previewArea" class="preview-container" style="display: none;"></div>
        <div class="icon-wrapper" id="defaultIcon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        </div>
        <h2 id="fileName">Loading file preview...</h2>
        <div class="file-info" id="fileSize"></div>
        <div id="passwordArea" style="display: none;">
            <div class="form-group">
                <label for="password">Password Protected File</label>
                <input type="password" id="password" placeholder="Enter password to access file">
            </div>
            <button class="btn" style="margin-bottom: 12px;" onclick="unlockAndLoad()">Unlock Preview</button>
        </div>
        
        <button class="btn" id="downloadBtn" onclick="handleDownload()">Download File</button>

        <div id="dlProgressCard" class="dl-progress-card">
            <div class="dl-header">
                <span id="dlStatusText">Status: Downloading...</span>
                <div class="torrent-controls">
                    <button class="btn-ctrl" id="btnDlPause" onclick="toggleDlPause()">Pause</button>
                    <button class="btn-ctrl danger" onclick="cancelDl()">Cancel</button>
                </div>
            </div>
            <div class="dl-bar-bg">
                <div id="dlBarFill" class="dl-bar-fill"></div>
            </div>
            <div class="dl-meta">
                <span id="dlBytes">0 MB / 0 MB</span>
                <span id="dlPercent" style="font-weight:700; color:var(--primary);">0%</span>
            </div>
            <div class="dl-meta" style="margin-top:2px;">
                <span id="dlSpeed">0 MB/s</span>
            </div>
        </div>

        <div class="brand">Yankitz Cloud Manager</div>
    </div>
    <script>
        const slug = window.location.pathname.split('/').pop();
        let fileMime = '';
        let totalFileSize = 0;
        let isDlPaused = false;
        let isDlCancelled = false;
        let dlAbortController = null;

        async function loadFileInfo() {
            try {
                const res = await fetch('/api/share-info/' + slug);
                const data = await res.json();
                if (!res.ok) {
                    document.getElementById('fileName').textContent = 'File Unavailable';
                    document.getElementById('fileSize').textContent = data.error || 'Link expired or deleted.';
                    document.getElementById('downloadBtn').style.display = 'none';
                    return;
                }

                if (data.status === 'pending_upload') {
                    document.getElementById('fileName').textContent = data.name;
                    document.getElementById('fileSize').textContent = '⚠️ Pending Google Drive Upload';
                    document.getElementById('downloadBtn').style.display = 'none';
                    alert('File is currently pending manual upload into your Google Drive folder.');
                    return;
                }

                document.getElementById('fileName').textContent = data.name;
                document.getElementById('fileSize').textContent = formatBytes(data.size);
                totalFileSize = data.size || 0;
                fileMime = data.mime || '';
                if (data.protected) {
                    document.getElementById('passwordArea').style.display = 'block';
                    document.getElementById('downloadBtn').style.display = 'none';
                } else {
                    renderPreview('/api/stream/' + slug);
                }
            } catch (err) {
                document.getElementById('fileName').textContent = 'Error Loading File';
            }
        }

        function unlockAndLoad() {
            const pwd = document.getElementById('password').value.trim();
            if (!pwd) return;
            document.getElementById('downloadBtn').style.display = 'block';
            renderPreview('/api/stream/' + slug + '?password=' + encodeURIComponent(pwd));
        }

        function renderPreview(streamUrl) {
            const previewArea = document.getElementById('previewArea');
            const defaultIcon = document.getElementById('defaultIcon');
            const fileName = document.getElementById('fileName').textContent.toLowerCase();
            previewArea.innerHTML = '';

            if (fileMime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(fileName)) {
                previewArea.innerHTML = '<img src="' + streamUrl + '" alt="Preview" />';
                previewArea.style.display = 'flex';
                defaultIcon.style.display = 'none';
            } else if (fileMime.startsWith('video/') || /\.(mp4|webm|mkv|mov)$/i.test(fileName)) {
                previewArea.innerHTML = '<video controls autoplay muted src="' + streamUrl + '"></video>';
                previewArea.style.display = 'flex';
                defaultIcon.style.display = 'none';
            } else if (fileMime === 'application/pdf' || fileName.endsWith('.pdf')) {
                previewArea.innerHTML = '<iframe src="' + streamUrl + '"></iframe>';
                previewArea.style.display = 'flex';
                defaultIcon.style.display = 'none';
            }
        }

        function toggleDlPause() {
            isDlPaused = !isDlPaused;
            const btn = document.getElementById('btnDlPause');
            const statusText = document.getElementById('dlStatusText');
            if (isDlPaused) {
                btn.textContent = 'Resume';
                statusText.textContent = '⏸️ Status: Paused';
            } else {
                btn.textContent = 'Pause';
                statusText.textContent = 'Status: Downloading...';
            }
        }

        function cancelDl() {
            isDlCancelled = true;
            if (dlAbortController) {
                dlAbortController.abort();
            }
            const progressCard = document.getElementById('dlProgressCard');
            const statusText = document.getElementById('dlStatusText');
            const btn = document.getElementById('downloadBtn');
            statusText.textContent = 'Status: Canceled';
            statusText.style.color = '#ef4444';
            btn.disabled = false;
            btn.textContent = 'Download File';
            setTimeout(() => progressCard.classList.remove('active'), 1500);
        }

        async function handleDownload() {
            const btn = document.getElementById('downloadBtn');
            const passwordInput = document.getElementById('password');
            const progressCard = document.getElementById('dlProgressCard');
            const statusText = document.getElementById('dlStatusText');
            const percentText = document.getElementById('dlPercent');
            const fillBar = document.getElementById('dlBarFill');
            const bytesText = document.getElementById('dlBytes');
            const speedText = document.getElementById('dlSpeed');

            btn.disabled = true;
            btn.textContent = 'Downloading File...';
            progressCard.classList.add('active');
            statusText.textContent = 'Status: Downloading...';
            statusText.style.color = '#1e293b';

            isDlPaused = false;
            isDlCancelled = false;
            document.getElementById('btnDlPause').textContent = 'Pause';

            dlAbortController = new AbortController();
            const pwd = passwordInput ? passwordInput.value.trim() : '';

            try {
                const response = await fetch('/api/download/' + slug, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: pwd }),
                    signal: dlAbortController.signal
                });

                if (!response.ok) {
                    const errData = await response.json();
                    throw new Error(errData.error || 'Download request failed.');
                }

                const contentLength = response.headers.get('Content-Length');
                const totalBytes = contentLength ? parseInt(contentLength, 10) : totalFileSize;

                const reader = response.body.getReader();
                let receivedBytes = 0;
                let startTime = Date.now();
                const chunks = [];

                while(true) {
                    if (isDlCancelled) return;

                    if (isDlPaused) {
                        while (isDlPaused) {
                            await new Promise(r => setTimeout(r, 500));
                            if (isDlCancelled) return;
                        }
                    }

                    const { done, value } = await reader.read();
                    if (done) break;

                    chunks.push(value);
                    receivedBytes += value.length;

                    const duration = (Date.now() - startTime) / 1000;
                    const speed = duration > 0 ? receivedBytes / duration : 0;
                    const percent = totalBytes ? Math.round((receivedBytes / totalBytes) * 100) : 0;

                    fillBar.style.width = percent + '%';
                    percentText.textContent = percent + '%';
                    bytesText.textContent = formatBytes(receivedBytes) + ' / ' + (totalBytes ? formatBytes(totalBytes) : 'Unknown');
                    speedText.textContent = formatBytes(speed) + '/s';
                }

                if (isDlCancelled) return;

                statusText.textContent = 'Status: Completed!';
                statusText.style.color = '#10b981';
                btn.textContent = 'Download Complete';

                const blob = new Blob(chunks, { type: fileMime || 'application/octet-stream' });
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = document.getElementById('fileName').textContent;
                document.body.appendChild(a);
                a.click();
                a.remove();
                window.URL.revokeObjectURL(url);

                setTimeout(() => {
                    btn.disabled = false;
                    btn.textContent = 'Download File';
                }, 3000);

            } catch (err) {
                if (err.name === 'AbortError' || isDlCancelled) return;
                statusText.textContent = 'Status: Failed';
                statusText.style.color = '#ef4444';
                alert(err.message);
                btn.textContent = 'Download File';
                btn.disabled = false;
            }
        }

        function formatBytes(bytes) {
            if (!bytes || bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }

        loadFileInfo();
    </script>
</body>
</html>`;

// --- AUTOMATIC MODAL OPEN REQUEST PORTAL HTML ---
function getRequestPortalHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Yankitz Cloud Manager - Submit Uploads</title>
    <style>
        :root { --primary: #0066ff; --primary-hover: #0052cc; --bg: #64748b; --card-bg: #ffffff; --text: #1e293b; --muted: #64748b; --border: #e2e8f0; --danger: #ef4444; }
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background-color: var(--bg); color: var(--text); display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 0; }
        
        .drop-zone { border: 2px dashed #cbd5e1; border-radius: 10px; padding: 28px 16px; background: #f8fafc; cursor: pointer; margin-bottom: 16px; transition: border-color 0.2s, background-color 0.2s; }
        .drop-zone:hover, .drop-zone.dragover { border-color: var(--primary); background: #eff6ff; }
        .drop-zone-icon { width: 42px; height: 42px; color: var(--primary); margin: 0 auto 8px auto; }
        .drop-zone-text { font-size: 0.9rem; font-weight: 600; color: #334155; }
        .drop-zone-sub { font-size: 0.775rem; color: var(--muted); margin-top: 4px; }
        .file-input-hidden { display: none; }

        .file-list-preview { font-size: 0.825rem; color: #334155; text-align: left; background: #f1f5f9; padding: 8px 12px; border-radius: 6px; margin-bottom: 16px; max-height: 100px; overflow-y: auto; display: none; }
        
        .btn-group { display: flex; flex-direction: column; gap: 10px; }
        .btn { background-color: var(--primary); color: white; border: none; padding: 12px 16px; border-radius: 8px; font-size: 0.95rem; font-weight: 600; cursor: pointer; width: 100%; transition: background-color 0.2s; }
        .btn:hover { background-color: var(--primary-hover); }
        .btn-outline { background-color: #ffffff; color: #334155; border: 1px solid #cbd5e1; padding: 11px 16px; border-radius: 8px; font-size: 0.875rem; font-weight: 600; cursor: pointer; width: 100%; transition: background 0.15s; }
        .btn-outline:hover { background-color: #f8fafc; }
        
        .progress-box { margin-top: 16px; text-align: left; background: #f8fafc; border: 1px solid var(--border); border-radius: 8px; padding: 14px; display: none; }
        .progress-box.active { display: block; }
        .torrent-title { font-weight: 600; font-size: 0.875rem; color: #1e293b; display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
        .torrent-controls { display: flex; gap: 6px; }
        .btn-ctrl { background: #fff; border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; font-size: 0.75rem; font-weight: 600; cursor: pointer; color: #475569; }
        .btn-ctrl:hover { background: #f8fafc; }
        .btn-ctrl.danger { color: var(--danger); border-color: #fca5a5; }
        .progress-bar-bg { width: 100%; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; margin: 8px 0; }
        .progress-bar-fill { height: 100%; width: 0%; background: var(--primary); transition: width 0.15s ease-out; }
        .progress-meta { display: flex; justify-content: space-between; font-size: 0.8rem; color: var(--muted); margin-top: 4px; }
        
        .status { margin-top: 14px; font-size: 0.875rem; font-weight: 500; }

        /* DIRECT MODAL OVERLAY */
        .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(15, 23, 42, 0.65); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; z-index: 9999; padding: 16px; }
        .modal-container { background: #ffffff; border-radius: 14px; width: 100%; max-width: 440px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.2); overflow: hidden; animation: modalPop 0.2s ease-out; }
        @keyframes modalPop { from { transform: scale(0.95); opacity: 0; } to { transform: scale(1); opacity: 1; } }
        .modal-header { padding: 14px 18px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: #f8fafc; }
        .modal-header h3 { margin: 0; font-size: 0.95rem; color: #0f172a; font-weight: 600; }
        .modal-close { background: transparent; border: none; font-size: 1.25rem; font-weight: 700; color: #64748b; cursor: pointer; line-height: 1; padding: 4px; }
        .modal-body { padding: 20px; text-align: center; }
    </style>
</head>
<body>
    <div id="uploadModal" class="modal-overlay">
        <div class="modal-container">
            <div class="modal-header">
                <h3 id="modalReqTitle">Upload to: Request</h3>
                <button class="modal-close" onclick="closeUploadModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="drop-zone" id="dropZone" onclick="document.getElementById('fileInput').click()">
                    <svg class="drop-zone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                    <div class="drop-zone-text">Click or drop files here</div>
                    <div class="drop-zone-sub">Select one or multiple files</div>
                </div>

                <input type="file" id="fileInput" class="file-input-hidden" multiple>

                <div id="fileListPreview" class="file-list-preview"></div>

                <div class="btn-group">
                    <button class="btn" id="uploadBtn">Upload Files</button>
                    <button class="btn-outline" id="preReserveBtn">📌 Pre-reserve Link Only</button>
                </div>

                <div id="progressBox" class="progress-box">
                    <div class="torrent-title">
                        <span id="progState">Uploading...</span>
                        <div class="torrent-controls">
                            <button class="btn-ctrl" id="btnPause">Pause</button>
                            <button class="btn-ctrl danger" id="btnCancel">Cancel</button>
                        </div>
                    </div>
                    <div id="progFileName" style="font-size:0.85rem; color:#334155; font-weight:600; margin-bottom:4px; word-break:break-all;">File Name</div>
                    <div class="progress-bar-bg">
                        <div id="progFill" class="progress-bar-fill"></div>
                    </div>
                    <div class="progress-meta">
                        <span id="progSize">0 MB / 0 MB</span>
                        <span id="progPercent" style="font-weight:700; color:var(--primary);">0%</span>
                    </div>
                    <div class="progress-meta" style="margin-top:2px;">
                        <span id="progSpeedEta">Calculating...</span>
                    </div>
                </div>

                <div class="status" id="statusMsg"></div>
            </div>
        </div>
    </div>

    <script>
        // OVERRIDE BROWSER POPUPS WITH EXACT MATCH CUSTOM UI MODAL (RESIZED TO MATCH SHARES MODAL)
        function showCustomAlert(message, title) {
            var existingModal = document.getElementById('customAlertModal');
            if (existingModal) existingModal.remove();

            var overlay = document.createElement('div');
            overlay.id = 'customAlertModal';
            overlay.style.cssText = \`
                position: fixed;
                top: 0;
                left: 0;
                width: 100vw;
                height: 100vh;
                background: rgba(0, 0, 0, 0.35);
                backdrop-filter: blur(2px);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 99999;
                opacity: 0;
                transition: opacity 0.15s ease-in-out;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            \`;

            var displayTitle = title || message;
            var displayMessage = (title && message) ? message : '';

            overlay.innerHTML = \`
                <div style="
                    background: #ffffff;
                    color: #0f172a;
                    border-radius: 16px;
                    padding: 16px 20px;
                    max-width: 270px;
                    width: 75%;
                    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
                    text-align: center;
                    transform: scale(0.95);
                    transition: transform 0.15s ease-in-out;
                ">
                    <h3 style="
                        margin: 0 0 \` + (displayMessage ? '8px' : '14px') + \` 0;
                        font-size: 0.85rem;
                        font-weight: 800;
                        color: #0d1527;
                        letter-spacing: 0.02em;
                        text-transform: uppercase;
                        line-height: 1.3;
                    ">\` + displayTitle + \`</h3>

                    \` + (displayMessage ? \`<p style="margin: 0 0 14px 0; font-size: 0.8rem; color: #475569; line-height: 1.3;">\` + displayMessage + \`</p>\` : '') + \`

                    <div style="display: flex; justify-content: center;">
                        <button id="closeAlertBtn" style="
                            background: #3b82f6;
                            color: #ffffff;
                            border: none;
                            padding: 6px 22px;
                            border-radius: 6px;
                            font-weight: 700;
                            font-size: 0.85rem;
                            cursor: pointer;
                            box-shadow: 0 2px 6px rgba(59, 130, 246, 0.3);
                        ">OK</button>
                    </div>
                </div>
            \`;

            document.body.appendChild(overlay);

            requestAnimationFrame(function() {
                overlay.style.opacity = '1';
                overlay.firstElementChild.style.transform = 'scale(1)';
            });

            var closeBtn = overlay.querySelector('#closeAlertBtn');
            var close = function() {
                overlay.style.opacity = '0';
                overlay.firstElementChild.style.transform = 'scale(0.95)';
                setTimeout(function() { overlay.remove(); }, 150);
            };

            closeBtn.addEventListener('click', close);
            overlay.addEventListener('click', function(e) {
                if (e.target === overlay) close();
            });
        }

        // Intercept native browser popups
        window.alert = function(msg) {
            if (msg && msg.indexOf('Pre-reserved') !== -1) {
                showCustomAlert('', 'PRE-RESERVED LINK CREATED');
            } else {
                showCustomAlert(msg);
            }
        };

        var isCancelled = false;
        var isPaused = false;

        function closeUploadModal() {
            if (document.getElementById('uploadBtn').disabled && !isCancelled) {
                if (!confirm('An upload is currently in progress. Close modal?')) return;
            }
            if (window.history.length > 1) {
                window.history.back();
            } else {
                window.location.href = '/';
            }
        }

        function getSlug() {
            var p = window.location.pathname.split('/');
            return p[p.length - 1] || p[p.length - 2];
        }

        function formatBytes(bytes) {
            if (!bytes || bytes === 0) return '0 Bytes';
            var k = 1024;
            var sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
            var i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }

        function setupDragAndDrop() {
            var zone = document.getElementById('dropZone');
            var input = document.getElementById('fileInput');

            zone.addEventListener('dragover', function(e) {
                e.preventDefault();
                zone.classList.add('dragover');
            });

            zone.addEventListener('dragleave', function() {
                zone.classList.remove('dragover');
            });

            zone.addEventListener('drop', function(e) {
                e.preventDefault();
                zone.classList.remove('dragover');
                if (e.dataTransfer.files && e.dataTransfer.files.length) {
                    input.files = e.dataTransfer.files;
                    updatePreview();
                }
            });

            input.addEventListener('change', updatePreview);
        }

        function updatePreview() {
            var input = document.getElementById('fileInput');
            var preview = document.getElementById('fileListPreview');
            if (input.files && input.files.length) {
                var names = Array.from(input.files).map(f => f.name + ' (' + formatBytes(f.size) + ')');
                preview.innerHTML = '<strong>Selected Files:</strong><br>' + names.join('<br>');
                preview.style.display = 'block';
            } else {
                preview.style.display = 'none';
            }
        }

        function setupButtons() {
            var uploadBtn = document.getElementById('uploadBtn');
            var preReserveBtn = document.getElementById('preReserveBtn');
            var btnPause = document.getElementById('btnPause');
            var btnCancel = document.getElementById('btnCancel');

            if (uploadBtn) uploadBtn.onclick = handleUpload;
            if (preReserveBtn) preReserveBtn.onclick = handlePreReserve;

            if (btnPause) {
                btnPause.onclick = function() {
                    isPaused = !isPaused;
                    btnPause.textContent = isPaused ? 'Resume' : 'Pause';
                    document.getElementById('progState').textContent = isPaused ? '⏸️ Upload Paused' : 'Uploading...';
                };
            }

            if (btnCancel) {
                btnCancel.onclick = function() {
                    isCancelled = true;
                    document.getElementById('progressBox').classList.remove('active');
                    document.getElementById('uploadBtn').disabled = false;
                    var st = document.getElementById('statusMsg');
                    st.style.color = '#ef4444';
                    st.textContent = 'Upload cancelled.';
                };
            }
        }

        async function handlePreReserve() {
            var input = document.getElementById('fileInput');
            if (!input || !input.files || !input.files.length) {
                alert('Please select a file first.');
                return;
            }

            var slug = getSlug();
            var statusMsg = document.getElementById('statusMsg');
            statusMsg.style.color = '#0066ff';
            statusMsg.textContent = 'Pre-reserving link(s)...';

            var files = Array.from(input.files);
            var successCount = 0;

            for (var i = 0; i < files.length; i++) {
                var file = files[i];
                try {
                    var res = await fetch('/api/pre-reserve-incoming-link/' + slug, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            fileName: file.name,
                            mimeType: file.type || 'application/octet-stream',
                            fileSize: file.size
                        })
                    });

                    var data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Failed to pre-reserve link.');
                    successCount++;
                } catch (err) {
                    statusMsg.style.color = '#ef4444';
                    statusMsg.textContent = 'Error: ' + err.message;
                    alert('Pre-reserve error: ' + err.message);
                    return;
                }
            }

            statusMsg.style.color = '#10b981';
            statusMsg.textContent = '✅ ' + successCount + ' file entry pre-reserved!';
            alert('✅ Link Pre-reserved! Please upload file(s) directly to your designated Google Drive target folder.');
            input.value = '';
            updatePreview();
        }

        async function handleUpload() {
            var input = document.getElementById('fileInput');
            if (!input || !input.files || !input.files.length) {
                alert('Please select at least one file.');
                return;
            }

            var files = Array.from(input.files);
            isCancelled = false;
            isPaused = false;

            document.getElementById('uploadBtn').disabled = true;
            document.getElementById('progressBox').classList.add('active');
            document.getElementById('statusMsg').textContent = '';

            for (var i = 0; i < files.length; i++) {
                if (isCancelled) break;
                await uploadFileResumable(files[i]);
            }

            if (!isCancelled) {
                var st = document.getElementById('statusMsg');
                st.style.color = '#10b981';
                st.textContent = '✅ All file(s) uploaded successfully!';
                input.value = '';
                updatePreview();
                document.getElementById('uploadBtn').disabled = false;
                setTimeout(function() {
                    document.getElementById('progressBox').classList.remove('active');
                }, 2500);
            }
        }

        async function uploadFileResumable(file) {
            var slug = getSlug();
            document.getElementById('progFileName').textContent = file.name;

            var totalBytes = file.size;
            var chunkSize = 8 * 1024 * 1024;

            try {
                var sessionRes = await fetch('/api/get-drive-request-resumable-url/' + slug, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileName: file.name, mimeType: file.type || 'application/octet-stream', totalSize: totalBytes })
                });

                var sessionData = await sessionRes.json();
                if (!sessionRes.ok) throw new Error(sessionData.error || 'Failed upload session generation.');

                var resumableUrl = sessionData.resumableUrl;
                var startByte = 0;
                var startTime = Date.now();

                while (startByte < totalBytes) {
                    if (isCancelled) return;
                    if (isPaused) {
                        while (isPaused) {
                            await new Promise(function(r) { setTimeout(r, 500); });
                            if (isCancelled) return;
                        }
                    }

                    var endByte = Math.min(startByte + chunkSize, totalBytes);
                    var chunk = file.slice(startByte, endByte);

                    var chunkUploaded = false;
                    var retries = 0;

                    while (!chunkUploaded && retries < 3) {
                        if (isCancelled) return;
                        try {
                            var chunkUploadRes = await fetch('/api/upload-chunk', {
                                method: 'PUT',
                                headers: {
                                    'x-upload-url': resumableUrl,
                                    'Content-Range': 'bytes ' + startByte + '-' + (endByte - 1) + '/' + totalBytes,
                                    'Content-Type': 'application/octet-stream'
                                },
                                body: chunk
                            });

                            if (chunkUploadRes.status === 308 || chunkUploadRes.status === 200 || chunkUploadRes.status === 201) {
                                chunkUploaded = true;
                                startByte = endByte;
                                var percent = Math.round((startByte / totalBytes) * 100);
                                var duration = (Date.now() - startTime) / 1000;
                                var speed = duration > 0 ? startByte / duration : 0;

                                document.getElementById('progPercent').textContent = percent + '%';
                                document.getElementById('progFill').style.width = percent + '%';
                                document.getElementById('progSize').textContent = formatBytes(startByte) + ' / ' + formatBytes(totalBytes);
                                document.getElementById('progSpeedEta').textContent = formatBytes(speed) + '/s';

                                if (chunkUploadRes.status === 200 || chunkUploadRes.status === 201) {
                                    var driveData = await chunkUploadRes.json();
                                    await fetch('/api/finalize-incoming-upload/' + slug, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            driveFileId: driveData.id,
                                            fileName: file.name,
                                            mimeType: file.type || 'application/octet-stream',
                                            totalSize: totalBytes
                                        })
                                    });
                                }
                            } else {
                                throw new Error('Upload status: ' + chunkUploadRes.status);
                            }
                        } catch (err) {
                            retries++;
                            if (retries >= 3) throw err;
                            await new Promise(function(r) { setTimeout(r, 1000 * retries); });
                        }
                    }
                }
            } catch (err) {
                if (!isCancelled) {
                    var statusMsg = document.getElementById('statusMsg');
                    statusMsg.style.color = '#ef4444';
                    statusMsg.textContent = 'Upload error: ' + err.message;
                    document.getElementById('uploadBtn').disabled = false;
                    alert('Upload Error: ' + err.message);
                }
            }
        }

        async function fetchInfo() {
            try {
                var slug = getSlug();
                var res = await fetch('/api/request-info/' + slug);
                if (res.ok) {
                    var data = await res.json();
                    if (data.title) {
                        document.getElementById('modalReqTitle').textContent = 'Upload to: ' + data.title;
                    }
                }
            } catch (e) {}
        }

        document.addEventListener('DOMContentLoaded', function() {
            setupDragAndDrop();
            setupButtons();
            fetchInfo();
        });
    </script>
</body>
</html>`;
}

// Only Google's resumable upload endpoint may be proxied to, to prevent SSRF via x-upload-url.
const ALLOWED_UPLOAD_HOSTNAMES = new Set([
    'www.googleapis.com',
    'googleapis.com',
    'upload.googleapis.com'
]);

function isAllowedGoogleUploadUrl(candidate) {
    let urlObj;
    try {
        urlObj = new URL(candidate);
    } catch (e) {
        return null; // malformed URL
    }

    if (urlObj.protocol !== 'https:') return null;
    if (!ALLOWED_UPLOAD_HOSTNAMES.has(urlObj.hostname.toLowerCase())) return null;
    // Google Drive resumable upload URLs live under this path prefix.
    if (!urlObj.pathname.startsWith('/upload/drive/')) return null;

    return urlObj;
}

// --- STREAM PROXY ROUTE WITH RETRY & KEEP-ALIVE ---
app.put('/api/upload-chunk', (req, res) => {
    const targetUrl = req.headers['x-upload-url'];
    if (!targetUrl) return res.status(400).json({ error: 'Missing target upload URL.' });

    const reqHeaders = { 
        'Content-Type': 'application/octet-stream',
        'Connection': 'keep-alive'
    };
    if (req.headers['content-range']) reqHeaders['Content-Range'] = req.headers['content-range'];

    const urlObj = isAllowedGoogleUploadUrl(targetUrl);
    if (!urlObj) {
        return res.status(400).json({ error: 'Invalid or disallowed upload target URL.' });
    }

    const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'PUT',
        headers: reqHeaders,
        timeout: 120000
    };

    const googleReq = https.request(options, (googleRes) => {
        res.status(googleRes.statusCode);
        if (googleRes.headers['range']) res.setHeader('Range', googleRes.headers['range']);

        let bodyData = '';
        googleRes.on('data', c => bodyData += c);
        googleRes.on('end', () => {
            if (bodyData) {
                try { res.json(JSON.parse(bodyData)); } 
                catch(e) { res.send(bodyData); }
            } else {
                res.end();
            }
        });
    });

    googleReq.on('timeout', () => {
        googleReq.destroy();
        if (!res.headersSent) res.status(504).json({ error: 'Proxy request timeout.' });
    });

    googleReq.on('error', err => {
        if (!res.headersSent) res.status(500).json({ error: err.message });
    });

    req.pipe(googleReq);
});

// --- FORWARD INCOMING FILE TO PUBLIC SHARED FILE ENDPOINT ---
app.post('/api/forward-incoming/:id', async (req, res) => {
    const { password, slug, expiration, maxDownloads, user_auth_password } = req.body || {};

    const isValidUser = await verifyAnyPassword(user_auth_password);
    if (!isValidUser) return res.status(401).json({ error: 'Invalid Password' });

    const incomingId = req.params.id;

    try {
        const fileRes = await db.execute({ sql: `SELECT * FROM incoming_files WHERE id = ?`, args: [incomingId] });
        const row = fileRes.rows[0];

        if (!row) return res.status(404).json({ error: 'Incoming file not found.' });

        let customSlug = (slug && slug.trim()) ? slug.trim() : Math.random().toString(36).substring(2, 8);
        const clientIp = getClientIp(req);

        let expTimestamp = null;
        if (expiration && expiration !== 'never') {
            const now = Date.now();
            if (expiration === '1h') expTimestamp = now + 3600 * 1000;
            else if (expiration === '24h') expTimestamp = now + 86400 * 1000;
            else if (expiration === '7d') expTimestamp = now + 7 * 86400 * 1000;
        }

        const maxDl = maxDownloads ? parseInt(maxDownloads, 10) : null;
        const shareUrl = `${req.protocol}://${req.get('host')}/share/${customSlug}`;

        await db.execute({
            sql: `INSERT INTO shared_files 
                  (slug, drive_file_id, file_name, original_name, mime_type, file_size, password, expiration, expires_at, max_downloads, status, created_at) 
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
            args: [
                customSlug,
                row.drive_file_id,
                row.original_name,
                row.original_name,
                row.mime_type || 'application/octet-stream',
                row.file_size || 0,
                password ? password.trim() : null,
                expTimestamp,
                expTimestamp,
                maxDl,
                Date.now()
            ]
        });

        await logActivity('FORWARDED_INCOMING_FILE', { incomingId, slug: customSlug, fileName: row.original_name, ip: clientIp });

        await sendDiscordNotification("Incoming File Forwarded as Shared Link", `An incoming file was forwarded and protected.`, [
            { name: "File Name", value: row.original_name, inline: true },
            { name: "Share Slug", value: customSlug, inline: true },
            { name: "Protected", value: password ? "Yes 🔒" : "No 🔓", inline: true },
            { name: "URL", value: shareUrl, inline: false }
        ]);

        res.json({ success: true, slug: customSlug, url: shareUrl, fileName: row.original_name });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- PRE-RESERVE SHARED FILE LINK ENDPOINT ---
app.post('/api/pre-reserve-link', async (req, res) => {
    const { fileName, mimeType, fileSize, slug, password, expiration, maxDownloads, user_auth_password } = req.body || {};

    const isValidUser = await verifyAnyPassword(user_auth_password);
    if (!isValidUser) return res.status(401).json({ error: 'Invalid Password' });

    if (!fileName) return res.status(400).json({ error: 'File name is required.' });

    try {
        let customSlug = (slug && slug.trim()) ? slug.trim() : Math.random().toString(36).substring(2, 8);
        const clientIp = getClientIp(req);

        let expTimestamp = null;
        if (expiration && expiration !== 'never') {
            const now = Date.now();
            if (expiration === '1h') expTimestamp = now + 3600 * 1000;
            else if (expiration === '24h') expTimestamp = now + 86400 * 1000;
            else if (expiration === '7d') expTimestamp = now + 7 * 86400 * 1000;
        }

        const maxDl = maxDownloads ? parseInt(maxDownloads, 10) : null;
        const shareUrl = `${req.protocol}://${req.get('host')}/share/${customSlug}`;

        await db.execute({
            sql: `INSERT INTO shared_files 
                  (slug, drive_file_id, file_name, original_name, mime_type, file_size, password, expiration, expires_at, max_downloads, status, created_at) 
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                customSlug,
                'PENDING_DIRECT_DRIVE_UPLOAD',
                fileName.trim(),
                fileName.trim(),
                mimeType || 'application/octet-stream',
                fileSize || 0,
                password ? password.trim() : null,
                expTimestamp,
                expTimestamp,
                maxDl,
                'pending_upload',
                Date.now()
            ]
        });

        await logActivity('PRE_RESERVED_LINK', { slug: customSlug, fileName, ip: clientIp });

        await sendDiscordNotification("Pre-Reserved Link Created", `A link was pre-reserved for manual Google Drive upload.`, [
            { name: "File Name", value: fileName, inline: true },
            { name: "Share ID / Slug", value: customSlug, inline: true },
            { name: "URL", value: shareUrl, inline: false }
        ]);

        res.json({ success: true, slug: customSlug, url: shareUrl });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- DIRECT DRIVE RESUMABLE SESSION GENERATORS ---
app.post('/api/get-drive-resumable-url', async (req, res) => {
    const { fileName, mimeType, totalSize, user_auth_password } = req.body || {};

    const isValidUser = await verifyAnyPassword(user_auth_password);
    if (!isValidUser) return res.status(401).json({ error: 'Invalid Password' });

    try {
        const accessToken = await getAccessToken();

        const metadata = { name: fileName, mimeType: mimeType || 'application/octet-stream' };
        if (DRIVE_FOLDER_ID) metadata.parents = [DRIVE_FOLDER_ID];

        const sessionReq = https.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json; charset=UTF-8',
                'X-Upload-Content-Type': mimeType || 'application/octet-stream',
                'X-Upload-Content-Length': totalSize
            }
        }, (sessionRes) => {
            const locationUrl = sessionRes.headers['location'];
            if (locationUrl) {
                res.json({ success: true, resumableUrl: locationUrl });
            } else {
                res.status(500).json({ error: 'Failed to generate Google Drive upload session.' });
            }
        });

        sessionReq.on('error', (err) => res.status(500).json({ error: err.message }));
        sessionReq.write(JSON.stringify(metadata));
        sessionReq.end();

    } catch (err) {
        res.status(500).json({ error: 'Drive authentication error: ' + err.message });
    }
});

app.post('/api/finalize-drive-upload', async (req, res) => {
    const { driveFileId, fileName, mimeType, totalSize, slug, password, expiration, maxDownloads, user_auth_password } = req.body || {};

    const isValidUser = await verifyAnyPassword(user_auth_password);
    if (!isValidUser) return res.status(401).json({ error: 'Invalid Password' });

    try {
        let customSlug = (slug && slug.trim()) ? slug.trim() : Math.random().toString(36).substring(2, 8);
        const clientIp = getClientIp(req);

        let expTimestamp = null;
        if (expiration && expiration !== 'never') {
            const now = Date.now();
            if (expiration === '1h') expTimestamp = now + 3600 * 1000;
            else if (expiration === '24h') expTimestamp = now + 86400 * 1000;
            else if (expiration === '7d') expTimestamp = now + 7 * 86400 * 1000;
        }

        const maxDl = maxDownloads ? parseInt(maxDownloads, 10) : null;
        const shareUrl = `${req.protocol}://${req.get('host')}/share/${customSlug}`;

        await db.execute({
            sql: `INSERT INTO shared_files (slug, drive_file_id, file_name, original_name, mime_type, file_size, password, expiration, expires_at, max_downloads, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
            args: [customSlug, driveFileId, fileName, fileName, mimeType, totalSize, password ? password.trim() : null, expTimestamp, expTimestamp, maxDl, Date.now()]
        });

        await logActivity('FILE_UPLOAD', { slug: customSlug, fileName, size: totalSize, ip: clientIp });

        await sendDiscordNotification("New Shared File Created", `A file was shared via Yankitz Cloud Manager.`, [
            { name: "File Name", value: fileName, inline: true },
            { name: "File Size", value: formatBytes(totalSize), inline: true },
            { name: "Share ID / Slug", value: customSlug, inline: true },
            { name: "URL", value: shareUrl, inline: false }
        ]);

        res.json({ success: true, slug: customSlug, url: shareUrl });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/get-drive-request-resumable-url/:slug', async (req, res) => {
    const { slug } = req.params;
    const { fileName, mimeType, totalSize } = req.body || {};

    const reqRes = await db.execute({ sql: `SELECT id FROM file_requests WHERE slug = ?`, args: [slug] });
    if (!reqRes.rows.length) return res.status(404).json({ error: 'Request link not found.' });

    try {
        const accessToken = await getAccessToken();

        const metadata = { name: fileName, mimeType: mimeType || 'application/octet-stream' };
        if (DRIVE_FOLDER_ID) metadata.parents = [DRIVE_FOLDER_ID];

        const sessionReq = https.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json; charset=UTF-8',
                'X-Upload-Content-Type': mimeType || 'application/octet-stream',
                'X-Upload-Content-Length': totalSize
            }
        }, (sessionRes) => {
            const locationUrl = sessionRes.headers['location'];
            if (locationUrl) {
                res.json({ success: true, resumableUrl: locationUrl });
            } else {
                res.status(500).json({ error: 'Failed to generate Google Drive upload session.' });
            }
        });

        sessionReq.on('error', (err) => res.status(500).json({ error: err.message }));
        sessionReq.write(JSON.stringify(metadata));
        sessionReq.end();

    } catch (err) {
        res.status(500).json({ error: 'Drive authentication error: ' + err.message });
    }
});

app.post('/api/finalize-incoming-upload/:slug', async (req, res) => {
    const { slug } = req.params;
    const { driveFileId, fileName, mimeType, totalSize } = req.body || {};
    const clientIp = getClientIp(req);

    const reqRes = await db.execute({ sql: `SELECT * FROM file_requests WHERE slug = ?`, args: [slug] });
    const requestRow = reqRes.rows[0];

    if (!requestRow) return res.status(404).json({ error: 'Request link not found.' });

    try {
        await db.execute({
            sql: `INSERT INTO incoming_files (request_id, drive_file_id, original_name, mime_type, file_size, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)`,
            args: [requestRow.id, driveFileId, fileName, mimeType, totalSize, Date.now()]
        });

        await logActivity('INCOMING_FILE_UPLOAD', { requestTitle: requestRow.title, fileName, size: totalSize, ip: clientIp });

        await sendDiscordNotification("Incoming Requested File Uploaded", `A user uploaded a file for a request.`, [
            { name: "Request Title", value: requestRow.title, inline: true },
            { name: "File Name", value: fileName, inline: true },
            { name: "File Size", value: formatBytes(totalSize), inline: true }
        ]);

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/pre-reserve-incoming-link/:slug', async (req, res) => {
    const { slug } = req.params;
    const { fileName, mimeType, fileSize } = req.body || {};
    const clientIp = getClientIp(req);

    const reqRes = await db.execute({ sql: `SELECT * FROM file_requests WHERE slug = ?`, args: [slug] });
    const requestRow = reqRes.rows[0];

    if (!requestRow) return res.status(404).json({ error: 'Request link not found.' });

    try {
        await db.execute({
            sql: `INSERT INTO incoming_files (request_id, drive_file_id, original_name, mime_type, file_size, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)`,
            args: [requestRow.id, 'PENDING_DIRECT_DRIVE_UPLOAD', fileName.trim(), mimeType || 'application/octet-stream', fileSize || 0, Date.now()]
        });

        await logActivity('PRE_RESERVED_INCOMING', { requestTitle: requestRow.title, fileName, ip: clientIp });

        await sendDiscordNotification("Pre-Reserved Incoming File Created", `A user pre-reserved a file entry for a request portal.`, [
            { name: "Request Title", value: requestRow.title, inline: true },
            { name: "File Name", value: fileName, inline: true },
            { name: "File Size", value: formatBytes(fileSize), inline: true }
        ]);

        res.json({ success: true, message: 'Incoming file entry pre-reserved.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- AUTH VERIFICATION ROUTE ---
app.post('/api/verify-user-password', async (req, res) => {
    const { user_auth_password } = req.body || {};
    const isValid = await verifyAnyPassword(user_auth_password);
    if (isValid) {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Invalid Password' });
    }
});

app.post('/api/verify-admin-password', async (req, res) => {
    const { admin_auth_password } = req.body || {};
    const isValid = await verifyAdminPassword(admin_auth_password);
    if (isValid) {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Invalid Admin Password' });
    }
});

// --- SHARE MANAGER ENDPOINTS ---
app.get('/api/files', async (req, res) => {
    try {
        const result = await db.execute(`SELECT * FROM shared_files ORDER BY created_at DESC`);
        let rawFiles = result.rows || [];
        const syncedFiles = [];

        for (let file of rawFiles) {
            const updated = await syncRecordWithDrive('shared_files', file);
            if (updated) syncedFiles.push(updated);
        }

        res.json({ files: syncedFiles });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/files/rename/:id', async (req, res) => {
    const { user_auth_password, new_name } = req.body || {};
    const isValidUser = await verifyAnyPassword(user_auth_password);
    if (!isValidUser) return res.status(401).json({ error: 'Invalid Password' });

    if (!new_name || !new_name.trim()) return res.status(400).json({ error: 'Name cannot be empty.' });

    const fileId = req.params.id;
    try {
        const fileRes = await db.execute({ sql: `SELECT drive_file_id FROM shared_files WHERE id = ?`, args: [fileId] });
        const row = fileRes.rows[0];

        if (!row) return res.status(404).json({ error: 'File not found.' });

        const targetDriveId = row.drive_file_id;
        const trimmedName = new_name.trim();

        if (driveService && targetDriveId && targetDriveId !== 'PENDING_DIRECT_DRIVE_UPLOAD') {
            try {
                await driveService.files.update({
                    fileId: targetDriveId,
                    requestBody: { name: trimmedName }
                });
            } catch (driveErr) {
                console.error('Failed to rename file in Google Drive:', driveErr.message);
            }
        }

        await db.execute({
            sql: `UPDATE shared_files SET file_name = ?, original_name = ? WHERE id = ?`,
            args: [trimmedName, trimmedName, fileId]
        });
        await logActivity('FILE_RENAME', { id: fileId, newName: trimmedName });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/files/delete/:id', async (req, res) => {
    const { user_auth_password } = req.body || {};
    const isValidUser = await verifyAnyPassword(user_auth_password);
    if (!isValidUser) return res.status(401).json({ error: 'Invalid Password' });

    const fileId = req.params.id;
    try {
        const fileRes = await db.execute({ sql: `SELECT drive_file_id, file_name, original_name FROM shared_files WHERE id = ?`, args: [fileId] });
        const row = fileRes.rows[0];

        if (!row) return res.status(404).json({ error: 'File not found.' });

        const targetDriveId = row.drive_file_id;

        if (driveService && targetDriveId && targetDriveId !== 'PENDING_DIRECT_DRIVE_UPLOAD') {
            try { await driveService.files.delete({ fileId: targetDriveId }); } catch (e) {}
        }

        await db.execute({ sql: `DELETE FROM shared_files WHERE id = ?`, args: [fileId] });
        await logActivity('FILE_DELETE', { fileName: row.file_name || row.original_name });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/files/bulk-delete', async (req, res) => {
    const { ids, user_auth_password } = req.body || {};
    const isValidUser = await verifyAnyPassword(user_auth_password);
    if (!isValidUser) return res.status(401).json({ error: 'Invalid Password' });

    if (!ids || !Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ error: 'No files selected.' });
    }

    try {
        const placeholders = ids.map(() => '?').join(',');
        const fileRes = await db.execute({ sql: `SELECT drive_file_id FROM shared_files WHERE id IN (${placeholders})`, args: ids });

        if (driveService && fileRes.rows) {
            for (const row of fileRes.rows) {
                const targetDriveId = row.drive_file_id;
                if (targetDriveId && targetDriveId !== 'PENDING_DIRECT_DRIVE_UPLOAD') {
                    try { await driveService.files.delete({ fileId: targetDriveId }); } catch (e) {}
                }
            }
        }

        await db.execute({ sql: `DELETE FROM shared_files WHERE id IN (${placeholders})`, args: ids });
        await logActivity('BULK_FILE_DELETE', { count: ids.length });
        res.json({ success: true, count: ids.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/share/:slug', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(viewPageTemplate);
});

app.get('/api/share-info/:slug', async (req, res) => {
    const { slug } = req.params;
    const fileRes = await db.execute({ sql: `SELECT * FROM shared_files WHERE slug = ?`, args: [slug] });
    const row = fileRes.rows[0];

    if (!row) return res.status(404).json({ error: 'Shared file link not found or expired.' });

    const expTime = row.expires_at || row.expiration;
    if (expTime && Date.now() > expTime) return res.status(410).json({ error: 'This download link has expired.' });

    let currentDriveId = row.drive_file_id || row.file_id;
    let currentStatus = row.status;
    const nameToUse = row.file_name || row.original_name || 'Shared File';

    if (!currentDriveId || currentDriveId === 'PENDING_DIRECT_DRIVE_UPLOAD' || currentStatus === 'pending_upload') {
        const matchedDriveFile = await findDriveFileByName(nameToUse);
        if (matchedDriveFile) {
            currentDriveId = matchedDriveFile.id;
            currentStatus = 'active';

            await db.execute({
                sql: `UPDATE shared_files SET drive_file_id = ?, status = 'active', file_size = ? WHERE id = ?`,
                args: [matchedDriveFile.id, matchedDriveFile.size || row.file_size, row.id]
            });
        } else {
            return res.json({
                slug: row.slug,
                name: nameToUse,
                mime: row.mime_type,
                size: row.file_size,
                status: 'pending_upload',
                message: `File "${nameToUse}" is pending manual upload to Google Drive.`
            });
        }
    }

    res.json({
        slug: row.slug,
        name: nameToUse,
        mime: row.mime_type,
        size: row.file_size,
        status: currentStatus || 'active',
        protected: !!(row.password && row.password.trim() !== '')
    });
});

app.get('/api/stream/:slug', async (req, res) => {
    const { slug } = req.params;
    const password = (req.query.password || req.headers['x-file-password'] || '').trim();

    try {
        const fileRes = await db.execute({ sql: `SELECT * FROM shared_files WHERE slug = ?`, args: [slug] });
        const row = fileRes.rows[0];

        if (!row) return res.status(404).send('File not found');

        const expTime = row.expires_at || row.expiration;
        if (expTime && Date.now() > expTime) {
            return res.status(410).send('This shared link has expired');
        }

        if (row.password && row.password.trim() !== '' && row.password.trim() !== password) {
            return res.status(401).send('Incorrect password. Access denied.');
        }

        const nameToUse = row.file_name || row.original_name || 'Shared File';
        let driveFileId = row.drive_file_id || row.file_id;

        if (!driveFileId || driveFileId === 'PENDING_DIRECT_DRIVE_UPLOAD' || row.status === 'pending_upload') {
            const matchedDriveFile = await findDriveFileByName(nameToUse);
            if (matchedDriveFile) {
                driveFileId = matchedDriveFile.id;
                await db.execute({
                    sql: `UPDATE shared_files SET drive_file_id = ?, status = 'active', file_size = ? WHERE id = ?`,
                    args: [matchedDriveFile.id, matchedDriveFile.size || row.file_size, row.id]
                });
            } else {
                return res.status(404).send(`File "${nameToUse}" is pending manual upload to Google Drive.`);
            }
        }

        const fileSize = row.file_size ? parseInt(row.file_size, 10) : 0;
        const contentType = row.mime_type || 'video/mp4';
        const rangeHeader = req.headers.range;

        if (rangeHeader && fileSize > 0) {
            const parsed = parseRangeHeader(rangeHeader, fileSize);

            if (parsed && parsed.invalid) {
                res.setHeader('Content-Range', `bytes */${fileSize}`);
                return res.status(416).send('Requested Range Not Satisfiable');
            }

            if (parsed) {
                const { start, end, chunkSize } = parsed;

                const driveRes = await driveService.files.get(
                    { fileId: driveFileId, alt: 'media' },
                    { headers: { Range: `bytes=${start}-${end}` }, responseType: 'stream' }
                );

                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunkSize,
                    'Content-Type': contentType,
                    'Content-Disposition': `inline; filename="${nameToUse}"`
                });

                return driveRes.data.pipe(res);
            }
        }

        const driveRes = await driveService.files.get(
            { fileId: driveFileId, alt: 'media' },
            { responseType: 'stream' }
        );

        res.writeHead(200, {
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
            'Content-Length': fileSize,
            'Content-Disposition': `inline; filename="${nameToUse}"`
        });

        driveRes.data.pipe(res);

    } catch (e) {
        console.error('Error streaming shared file:', e);
        if (!res.headersSent) res.status(500).send('Streaming error: ' + e.message);
    }
});

// Shared helper function for downloading files by slug
async function handleSharedFileDownload(req, res, slug, password) {
    try {
        const fileRes = await db.execute({ sql: `SELECT * FROM shared_files WHERE slug = ?`, args: [slug] });
        const row = fileRes.rows[0];

        if (!row) return res.status(404).json({ error: 'File link not found.' });

        if (row.password && row.password.trim() !== '' && row.password.trim() !== (password || '').trim()) {
            return res.status(401).json({ error: 'Incorrect password. Access denied.' });
        }

        const nameToUse = row.file_name || row.original_name || 'Shared File';
        let driveFileId = row.drive_file_id || row.file_id;

        if (!driveFileId || driveFileId === 'PENDING_DIRECT_DRIVE_UPLOAD' || row.status === 'pending_upload') {
            const matchedDriveFile = await findDriveFileByName(nameToUse);
            if (matchedDriveFile) {
                driveFileId = matchedDriveFile.id;
                await db.execute({
                    sql: `UPDATE shared_files SET drive_file_id = ?, status = 'active', file_size = ? WHERE id = ?`,
                    args: [matchedDriveFile.id, matchedDriveFile.size || row.file_size, row.id]
                });
            } else {
                return res.status(404).json({ error: `File "${nameToUse}" is pending manual upload to Google Drive.` });
            }
        }

        const driveRes = await driveService.files.get(
            { fileId: driveFileId, alt: 'media' },
            { responseType: 'stream' }
        );

        await db.execute({ sql: `UPDATE shared_files SET downloads = downloads + 1 WHERE id = ?`, args: [row.id] });
        res.setHeader('Content-Disposition', `attachment; filename="${nameToUse}"`);
        if (row.file_size) res.setHeader('Content-Length', row.file_size);
        if (row.mime_type) res.setHeader('Content-Type', row.mime_type);

        driveRes.data.pipe(res);
    } catch (error) {
        res.status(500).json({ error: 'Failed to download file: ' + error.message });
    }
}

// Support GET requests (direct browser navigation/clicks)
app.get('/api/download/:slug', async (req, res) => {
    const { slug } = req.params;
    const password = (req.query.password || '').trim();
    await handleSharedFileDownload(req, res, slug, password);
});

// Support POST requests (API calls with JSON body)
app.post('/api/download/:slug', async (req, res) => {
    const { slug } = req.params;
    const { password } = (req.body || {});
    await handleSharedFileDownload(req, res, slug, password);
});

// --- FILE REQUESTS & INCOMING FILES ENDPOINTS ---
app.get('/request/:slug', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(getRequestPortalHtml());
});

app.get('/api/requests', async (req, res) => {
    try {
        const result = await db.execute(`SELECT * FROM file_requests ORDER BY created_at DESC`);
        res.json({ requests: result.rows || [] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/latest-request', async (req, res) => {
    try {
        const result = await db.execute(`SELECT * FROM file_requests ORDER BY created_at DESC LIMIT 1`);
        const row = result.rows[0];
        if (!row) return res.json({ request: null });
        const requestUrl = `${req.protocol}://${req.get('host')}/request/${row.slug}`;
        res.json({ request: row, url: requestUrl, link: requestUrl, slug: row.slug });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/requests', async (req, res) => {
    const { title, email, description, admin_auth_password } = req.body || {};

    const isValidAdmin = await verifyAdminPassword(admin_auth_password);
    if (!isValidAdmin) return res.status(401).json({ error: 'Invalid Admin Password' });

    if (!title) return res.status(400).json({ error: 'Title is required.' });

    const slug = Math.random().toString(36).substring(2, 8);
    const requestUrl = `${req.protocol}://${req.get('host')}/request/${slug}`;
    const clientIp = getClientIp(req);

    await db.execute({
        sql: `INSERT INTO file_requests (slug, title, email, description, created_at) VALUES (?, ?, ?, ?, ?)`,
        args: [slug, title, email || null, description || null, Date.now()]
    });

    await logActivity('REQUEST_CREATED', { slug, title, email, ip: clientIp });

    await sendDiscordNotification("New Upload Request Link Generated", `A file upload request link has been created.`, [
        { name: "Request Title", value: title, inline: true },
        { name: "Share ID / Slug", value: slug, inline: true },
        { name: "Recipient Email", value: email || "N/A", inline: true },
        { name: "URL", value: requestUrl, inline: false }
    ]);

    res.json({ success: true, slug, url: requestUrl, link: requestUrl });
});

app.get('/api/request-info/:slug', async (req, res) => {
    try {
        const result = await db.execute({ sql: `SELECT * FROM file_requests WHERE slug = ?`, args: [req.params.slug] });
        const row = result.rows[0];
        if (!row) return res.status(404).json({ error: 'Request not found' });
        res.json(row);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/incoming-files', async (req, res) => {
    try {
        const result = await db.execute(`
            SELECT incoming_files.id, incoming_files.drive_file_id, incoming_files.original_name, incoming_files.file_size, incoming_files.mime_type, incoming_files.uploaded_at as created_at, file_requests.title as request_title 
            FROM incoming_files 
            LEFT JOIN file_requests ON incoming_files.request_id = file_requests.id 
            ORDER BY incoming_files.uploaded_at DESC
        `);

        let rawFiles = result.rows || [];
        const syncedFiles = [];

        for (let f of rawFiles) {
            if (!f.drive_file_id || f.drive_file_id === 'PENDING_DIRECT_DRIVE_UPLOAD') {
                const matched = await findDriveFileByName(f.original_name);
                if (matched) {
                    f.drive_file_id = matched.id;
                    f.file_size = matched.size || f.file_size;
                    await db.execute({
                        sql: `UPDATE incoming_files SET drive_file_id = ?, file_size = ? WHERE id = ?`,
                        args: [matched.id, f.file_size, f.id]
                    });
                }
            }

            const updated = await syncRecordWithDrive('incoming_files', f);
            if (updated) syncedFiles.push(updated);
        }

        res.json({ files: syncedFiles });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/incoming-files/rename/:id', async (req, res) => {
    const { user_auth_password, new_name } = req.body || {};
    const isValidUser = await verifyAnyPassword(user_auth_password);
    if (!isValidUser) return res.status(401).json({ error: 'Invalid Password' });

    if (!new_name || !new_name.trim()) return res.status(400).json({ error: 'Name cannot be empty.' });

    const fileId = req.params.id;
    try {
        const fileRes = await db.execute({ sql: `SELECT drive_file_id FROM incoming_files WHERE id = ?`, args: [fileId] });
        const row = fileRes.rows[0];

        if (!row) return res.status(404).json({ error: 'File record not found.' });

        const targetDriveId = row.drive_file_id;
        const trimmedName = new_name.trim();

        if (driveService && targetDriveId && targetDriveId !== 'PENDING_DIRECT_DRIVE_UPLOAD') {
            try {
                await driveService.files.update({
                    fileId: targetDriveId,
                    requestBody: { name: trimmedName }
                });
            } catch (driveErr) {
                console.error('Failed to rename incoming file in Google Drive:', driveErr.message);
            }
        }

        await db.execute({
            sql: `UPDATE incoming_files SET original_name = ? WHERE id = ?`,
            args: [trimmedName, fileId]
        });
        await logActivity('INCOMING_FILE_RENAME', { id: fileId, newName: trimmedName });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/stream-incoming/:id', async (req, res) => {
    try {
        const fileRes = await db.execute({ sql: `SELECT * FROM incoming_files WHERE id = ?`, args: [req.params.id] });
        const row = fileRes.rows[0];
        if (!row) return res.status(404).send('File record not found');

        let driveFileId = row.drive_file_id;
        const nameToUse = row.original_name;

        if (!driveFileId || driveFileId === 'PENDING_DIRECT_DRIVE_UPLOAD') {
            const matchedDriveFile = await findDriveFileByName(nameToUse);
            if (matchedDriveFile) {
                driveFileId = matchedDriveFile.id;
                await db.execute({
                    sql: `UPDATE incoming_files SET drive_file_id = ?, file_size = ? WHERE id = ?`,
                    args: [matchedDriveFile.id, matchedDriveFile.size || row.file_size, row.id]
                });
            } else {
                return res.status(404).send(`File "${nameToUse}" is pending manual upload to Google Drive.`);
            }
        }

        const fileSize = row.file_size ? parseInt(row.file_size, 10) : 0;
        const contentType = row.mime_type || 'video/mp4';
        const rangeHeader = req.headers.range;

        if (rangeHeader && fileSize > 0) {
            const parsed = parseRangeHeader(rangeHeader, fileSize);

            if (parsed && parsed.invalid) {
                res.setHeader('Content-Range', `bytes */${fileSize}`);
                return res.status(416).send('Requested Range Not Satisfiable');
            }

            if (parsed) {
                const { start, end, chunkSize } = parsed;

                const driveRes = await driveService.files.get(
                    { fileId: driveFileId, alt: 'media' },
                    { headers: { Range: `bytes=${start}-${end}` }, responseType: 'stream' }
                );

                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunkSize,
                    'Content-Type': contentType,
                    'Content-Disposition': `inline; filename="${nameToUse}"`
                });

                return driveRes.data.pipe(res);
            }
        }

        const driveRes = await driveService.files.get(
            { fileId: driveFileId, alt: 'media' },
            { responseType: 'stream' }
        );

        res.writeHead(200, {
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
            'Content-Length': fileSize,
            'Content-Disposition': `inline; filename="${nameToUse}"`
        });

        driveRes.data.pipe(res);

    } catch (e) {
        console.error('Error streaming incoming file:', e);
        if (!res.headersSent) res.status(500).send('Error streaming incoming file: ' + e.message);
    }
});

// Helper function to process incoming downloads
async function handleIncomingFileDownload(req, res, id, userPwd) {
    const isValidUser = await verifyAnyPassword(userPwd);
    if (!isValidUser) return res.status(401).json({ error: 'Invalid Password' });

    const fileRes = await db.execute({ sql: `SELECT * FROM incoming_files WHERE id = ?`, args: [id] });
    const row = fileRes.rows[0];
    if (!row) return res.status(404).json({ error: 'File record not found' });

    let driveFileId = row.drive_file_id;
    const nameToUse = row.original_name;

    if (!driveFileId || driveFileId === 'PENDING_DIRECT_DRIVE_UPLOAD') {
        const matchedDriveFile = await findDriveFileByName(nameToUse);
        if (matchedDriveFile) {
            driveFileId = matchedDriveFile.id;
            await db.execute({
                sql: `UPDATE incoming_files SET drive_file_id = ?, file_size = ? WHERE id = ?`,
                args: [matchedDriveFile.id, matchedDriveFile.size || row.file_size, row.id]
            });
        } else {
            return res.status(404).json({ error: `File "${nameToUse}" is pending manual upload to Google Drive.` });
        }
    }

    try {
        const driveRes = await driveService.files.get(
            { fileId: driveFileId, alt: 'media' },
            { responseType: 'stream' }
        );

        res.setHeader('Content-Disposition', `attachment; filename="${nameToUse}"`);
        if (row.file_size) res.setHeader('Content-Length', row.file_size);
        if (row.mime_type) res.setHeader('Content-Type', row.mime_type);
        driveRes.data.pipe(res);
    } catch (e) {
        res.status(500).json({ error: 'Error downloading file: ' + e.message });
    }
}

app.get('/api/download-incoming/:id', async (req, res) => {
    const userPwd = (req.query.password || '').trim();
    await handleIncomingFileDownload(req, res, req.params.id, userPwd);
});

app.post('/api/download-incoming/:id', async (req, res) => {
    const { user_auth_password } = req.body || {};
    await handleIncomingFileDownload(req, res, req.params.id, user_auth_password);
});

app.post('/api/download-incoming-zip', async (req, res) => {
    const { ids, user_auth_password } = req.body || {};
    const isValidUser = await verifyAnyPassword(user_auth_password);
    if (!isValidUser) return res.status(401).json({ error: 'Invalid Password' });

    if (!ids || !Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ error: 'No files selected for download.' });
    }

    const placeholders = ids.map(() => '?').join(',');
    const fileRes = await db.execute({ sql: `SELECT * FROM incoming_files WHERE id IN (${placeholders})`, args: ids });
    const rows = fileRes.rows;

    if (!rows || !rows.length) return res.status(404).json({ error: 'Files not found.' });

    try {
        const zip = new AdmZip();
        for (const fileRow of rows) {
            let driveFileId = fileRow.drive_file_id;
            const nameToUse = fileRow.original_name;

            if (!driveFileId || driveFileId === 'PENDING_DIRECT_DRIVE_UPLOAD') {
                const matchedDriveFile = await findDriveFileByName(nameToUse);
                if (matchedDriveFile) {
                    driveFileId = matchedDriveFile.id;
                    await db.execute({
                        sql: `UPDATE incoming_files SET drive_file_id = ?, file_size = ? WHERE id = ?`,
                        args: [matchedDriveFile.id, matchedDriveFile.size || fileRow.file_size, fileRow.id]
                    });
                } else {
                    continue;
                }
            }

            const driveRes = await driveService.files.get(
                { fileId: driveFileId, alt: 'media' },
                { responseType: 'arraybuffer' }
            );
            zip.addFile(nameToUse, Buffer.from(driveRes.data));
        }

        const zipBuffer = zip.toBuffer();
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="Selected_Incoming_Files_${Date.now()}.zip"`);
        res.send(zipBuffer);
    } catch (e) {
        res.status(500).json({ error: 'Failed to create ZIP package: ' + e.message });
    }
});

app.delete('/api/incoming-files/:id', async (req, res) => {
    const { user_auth_password } = req.body || {};
    const isValidUser = await verifyAnyPassword(user_auth_password);
    if (!isValidUser) return res.status(401).json({ error: 'Invalid Password' });

    const id = req.params.id;
    const fileRes = await db.execute({ sql: `SELECT drive_file_id FROM incoming_files WHERE id = ?`, args: [id] });
    const row = fileRes.rows[0];

    if (!row) return res.status(404).json({ error: 'Incoming file not found.' });

    if (driveService && row.drive_file_id && row.drive_file_id !== 'PENDING_DIRECT_DRIVE_UPLOAD') {
        try { await driveService.files.delete({ fileId: row.drive_file_id }); } catch (e) {}
    }

    await db.execute({ sql: `DELETE FROM incoming_files WHERE id = ?`, args: [id] });
    res.json({ success: true });
});

// --- ANALYTICS & SETTINGS ENDPOINTS ---
app.get('/api/analytics', async (req, res) => {
    try {
        const row1Res = await db.execute(`SELECT COUNT(*) as activeFiles, SUM(file_size) as totalStorage, SUM(downloads) as totalDownloads FROM shared_files`);
        const row2Res = await db.execute(`SELECT COUNT(*) as totalRequests FROM file_requests`);
        const rows3Res = await db.execute(`SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 50`);

        const row1 = row1Res.rows[0];
        const row2 = row2Res.rows[0];

        res.json({
            stats: {
                activeFiles: row1 ? row1.activeFiles : 0,
                totalBytes: row1 ? (row1.totalStorage || 0) : 0,
                totalDownloads: row1 ? (row1.totalDownloads || 0) : 0,
                totalRequests: row2 ? row2.totalRequests : 0
            },
            activity: rows3Res.rows ? rows3Res.rows.map(r => ({
                id: r.id, event: r.event_type, details: JSON.parse(r.details || '{}'), created_at: r.created_at
            })) : []
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/logs/clear', async (req, res) => {
    const { ids, admin_auth_password } = req.body || {};
    const isValidAdmin = await verifyAdminPassword(admin_auth_password);
    if (!isValidAdmin) return res.status(401).json({ error: 'Invalid Admin Password' });

    if (!ids || !Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ error: 'No log IDs specified.' });
    }

    const placeholders = ids.map(() => '?').join(',');
    await db.execute({ sql: `DELETE FROM activity_logs WHERE id IN (${placeholders})`, args: ids });
    res.json({ success: true });
});

// --- DISCORD RELAY ENDPOINT ---
// Same codebase runs on Render, Railway, and Vercel. If Render's outbound IP
// gets Cloudflare-edge-blocked when calling Discord directly, Render can instead
// POST here on the Railway (or Vercel) deployment, which forwards to Discord from
// its own (working) network path. Protected by a shared secret so it can't be
// used as an open relay by anyone else, and the target URL is restricted to real
// Discord webhook URLs to prevent SSRF, same pattern as isAllowedGoogleUploadUrl.
function isAllowedDiscordWebhookUrl(candidate) {
    let urlObj;
    try {
        urlObj = new URL(candidate);
    } catch (e) {
        return null;
    }
    if (urlObj.protocol !== 'https:') return null;
    const host = urlObj.hostname.toLowerCase();
    if (host !== 'discord.com' && host !== 'discordapp.com') return null;
    if (!urlObj.pathname.startsWith('/api/webhooks/')) return null;
    return urlObj;
}

app.post('/api/relay/discord', (req, res) => {
    const secret = req.headers['x-relay-secret'];
    const expectedSecret = process.env.DISCORD_RELAY_SECRET;

    if (!expectedSecret || !secret || secret !== expectedSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { webhookUrl, payload } = req.body || {};
    if (!webhookUrl || typeof webhookUrl !== 'string') {
        return res.status(400).json({ error: 'Missing webhookUrl' });
    }
    if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ error: 'Missing payload' });
    }

    const urlObj = isAllowedDiscordWebhookUrl(webhookUrl);
    if (!urlObj) {
        return res.status(400).json({ error: 'Invalid or disallowed webhook URL' });
    }

    const body = JSON.stringify(payload);
    const reqOptions = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
        },
        timeout: 10000
    };

    const discordReq = https.request(reqOptions, (discordRes) => {
        let resBody = '';
        discordRes.on('data', (chunk) => { resBody += chunk; });
        discordRes.on('end', () => {
            console.log(`[Discord Relay] Forwarded notification: status ${discordRes.statusCode}`);
            res.status(discordRes.statusCode).send(resBody || '{}');
        });
    });

    discordReq.on('timeout', () => {
        discordReq.destroy();
        res.status(504).json({ error: 'Relay timeout reaching Discord' });
    });

    discordReq.on('error', (err) => {
        console.error('[Discord Relay] Error forwarding to Discord:', err.message);
        if (!res.headersSent) res.status(502).json({ error: err.message });
    });

    discordReq.write(body);
    discordReq.end();
});

// --- TEMPORARY DIAGNOSTIC: test the Discord webhook directly and see the real result. ---
// Visit in browser: /api/debug/discord-test?admin_auth_password=YOUR_ADMIN_PASSWORD
// Remove this route once the Discord notification issue is confirmed resolved.
app.get('/api/debug/discord-test', async (req, res) => {
    const isValidAdmin = await verifyAdminPassword(req.query.admin_auth_password);
    if (!isValidAdmin) return res.status(401).json({ error: 'Invalid Admin Password' });

    const result = await sendDiscordNotification(
        "Diagnostic Test",
        "This is a manual test triggered from /api/debug/discord-test.",
        [{ name: "Triggered At", value: new Date().toISOString(), inline: false }]
    );

    res.json({ discordResult: result });
});

app.get('/api/settings', async (req, res) => {
    try {
        const result = await db.execute(`SELECT * FROM settings`);
        const rawSettings = {};
        if (result.rows) result.rows.forEach(row => rawSettings[row.key] = row.value);

        const hasDiscordWebhook = !!((rawSettings.discord_webhook && rawSettings.discord_webhook.trim() !== '') || process.env.DISCORD_WEBHOOK);
        const hasAdminPassword = !!((rawSettings.admin_password !== undefined && rawSettings.admin_password !== null && rawSettings.admin_password.trim() !== '') || process.env.ADMIN_PASSWORD);
        const hasUserPassword = !!((rawSettings.user_password !== undefined && rawSettings.user_password !== null && rawSettings.user_password.trim() !== '') || process.env.USER_PASSWORD);

        // Never return the actual secret values (webhook URL, passwords) to the client.
        // Only expose whether each is currently configured.
        res.json({
            settings: {
                discord_webhook_set: hasDiscordWebhook,
                admin_password_set: hasAdminPassword,
                user_password_set: hasUserPassword
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/settings', async (req, res) => {
    const { discord_webhook, user_password, admin_password, clear_user_password, admin_auth_password } = req.body || {};

    const isValidAdmin = await verifyAdminPassword(admin_auth_password);
    if (!isValidAdmin) {
        return res.status(401).json({ error: 'Invalid Admin Password' });
    }

    try {
        if (clear_user_password) {
            await db.execute({
                sql: `INSERT INTO settings (key, value) VALUES ('user_password', '') ON CONFLICT(key) DO UPDATE SET value = ''`,
                args: []
            });
        } else if (user_password !== undefined && user_password.trim() !== '') {
            await db.execute({
                sql: `INSERT INTO settings (key, value) VALUES ('user_password', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                args: [user_password.trim()]
            });
        }

        if (admin_password !== undefined && admin_password.trim() !== '') {
            await db.execute({
                sql: `INSERT INTO settings (key, value) VALUES ('admin_password', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                args: [admin_password.trim()]
            });
        }

        if (discord_webhook !== undefined && discord_webhook.trim() !== '') {
            await db.execute({
                sql: `INSERT INTO settings (key, value) VALUES ('discord_webhook', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                args: [discord_webhook.trim()]
            });
        }

        res.json({ success: true, message: "Settings saved permanently in Turso Cloud Database." });
    } catch (err) {
        res.status(500).json({ error: "Failed to update settings: " + err.message });
    }
});

// --- MAIN CLIENT ROUTE ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- BACKGROUND TWO-WAY GOOGLE DRIVE SYNC WORKER ---
setInterval(async () => {
    if (!driveService) return;
    try {
        const sharedRes = await db.execute(`SELECT * FROM shared_files WHERE drive_file_id IS NOT NULL AND drive_file_id != 'PENDING_DIRECT_DRIVE_UPLOAD'`);
        for (let file of sharedRes.rows || []) {
            await syncRecordWithDrive('shared_files', file);
        }

        const incomingRes = await db.execute(`SELECT * FROM incoming_files WHERE drive_file_id IS NOT NULL AND drive_file_id != 'PENDING_DIRECT_DRIVE_UPLOAD'`);
        for (let file of incomingRes.rows || []) {
            await syncRecordWithDrive('incoming_files', file);
        }
    } catch (e) {
        console.error('Background Drive sync error:', e.message);
    }
}, 45000);

// --- START SERVER ---
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
server.timeout = 7200000;
server.keepAliveTimeout = 7200000;
server.headersTimeout = 7205000;
