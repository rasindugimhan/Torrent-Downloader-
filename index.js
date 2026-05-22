const { TelegramClient, Api } = require('telegram');
const { Button } = require('telegram/tl/custom/button');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { CallbackQuery } = require('telegram/events/CallbackQuery');
const path = require('path');
const fs = require('fs');
const { zipDirectory, splitFile, formatProgressBar, formatBytes } = require('./utils');
require('dotenv').config();

// Clean environment variables by stripping surrounding quotes
const cleanEnvValue = (val) => {
    if (!val) return '';
    return val.trim().replace(/^["']|["']$/g, '');
};

// Load Environment Configuration
const apiId = parseInt(cleanEnvValue(process.env.TELEGRAM_API_ID), 10);
const apiHash = cleanEnvValue(process.env.TELEGRAM_API_HASH);
const session = cleanEnvValue(process.env.TELEGRAM_SESSION);
const rawUploadLimit = parseFloat(cleanEnvValue(process.env.UPLOAD_LIMIT_GB || '2')); // in GB
const uploadLimitBytes = Math.floor(rawUploadLimit * 1024 * 1024 * 1024);
const downloadDir = cleanEnvValue(process.env.DOWNLOAD_DIR || './downloads');

// Robust Public Trackers List to optimize peer discovery and solve "connecting to peers" lockups
const bootstrapTrackers = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://tracker.coppersurfer.tk:6969/announce',
    'udp://tracker.leechers-paradise.org:6969/announce',
    'udp://open.stealth.si:80/announce',
    'udp://p4p.arenabg.com:1337/announce',
    'udp://tracker.internetwarriors.net:1337/announce',
    'http://tracker.opentrackr.org:1337/announce',
    'http://tracker.gbitt.info:80/announce',
    'http://tracker.files.fm:6969/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://tracker.tiny-vps.com:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.cyberia.is:6969/announce'
];

// Input Validation
if (isNaN(apiId) || !apiHash) {
    console.error('\x1b[31m❌ Configuration Error: TELEGRAM_API_ID and TELEGRAM_API_HASH must be configured in .env!\x1b[0m');
    console.error('Please run \x1b[33mnode login.js\x1b[0m to configure your environment first.');
    process.exit(1);
}

// Make sure global download directory exists
if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
}

// WebTorrent Client (will be initialized dynamically)
let torrentClient;

// Map to track active downloads and metadata sessions
const activeTasks = new Map();

// Helper to delete local temporary files/folders safely
function cleanupPath(p) {
    if (fs.existsSync(p)) {
        try {
            fs.rmSync(p, { recursive: true, force: true });
            console.log(`\x1b[33m🧹 Cleaned up: ${p}\x1b[0m`);
        } catch (err) {
            console.error(`\x1b[31m⚠️ Failed to clean up ${p}:\x1b[0m`, err.message);
        }
    }
}

// System status helper
function getSystemStatus() {
    const freeMem = require('os').freemem();
    const totalMem = require('os').totalmem();
    const activeCount = activeTasks.size;
    
    return `📊 **System & Bot Status**\n\n` +
           `• **Active Downloads:** ${activeCount} task(s)\n` +
           `• **Upload Split Limit:** ${rawUploadLimit} GB\n` +
           `• **Temporary Directory:** \`${downloadDir}\`\n` +
           `• **System Memory:** ${formatBytes(totalMem - freeMem)} / ${formatBytes(totalMem)} used\n` +
           `• **Node Version:** ${process.version}\n` +
           `• **Uptime:** ${Math.floor(process.uptime() / 60)} minutes`;
}

// Detailed Help Helper
function getHelpGuide() {
    return `📖 **Torrent Downloader Guide**\n\n` +
           `Using this bot is extremely simple and fast:\n\n` +
           `1️⃣ **Send a Torrent File**: Simply drag and drop or upload any \`.torrent\` file here.\n` +
           `2️⃣ **Send a Magnet Link**: Paste any magnet link (starts with \`magnet:?\`) as a text message.\n` +
           `3️⃣ **Metadata Parsing**: The bot will load the metadata and display the **list of files** and total sizes.\n` +
           `4️⃣ **Download & Upload**: Click the **⚡ Download & Send All** inline button. The bot will download the torrent and upload the files back to you directly!\n\n` +
           `💡 _Tips: If files are directories, they are zipped. Files larger than your upload limit (e.g. 2 GB or 4 GB) are automatically split and re-assembled on your machine easily!_`;
}

// User-specific active tasks progress helper
function getUserProgressText(chatId) {
    const userTasks = [];
    for (const [infoHash, task] of activeTasks.entries()) {
        if (task.chatId === chatId) {
            userTasks.push(task);
        }
    }
    
    if (userTasks.length === 0) {
        return `ℹ️ **You have no active torrent tasks at the moment.**\nTo start, send a \`.torrent\` file or paste a \`magnet:\` link!`;
    }
    
    let text = `📊 **Your Active Tasks Progress**\n\n`;
    
    userTasks.forEach((task, idx) => {
        const { torrent, stage } = task;
        const peers = torrent ? (torrent.numPeers || 0) : 0;
        text += `🔹 **Task #${idx + 1}:** \`${torrent?.name || task.customName || 'Unknown Torrent'}\`\n`;
        
        if (stage === 'metadata') {
            text += `• **Status:** 🧲 Resolving Metadata / Peer Discovery\n` +
                    `• **Connected Peers:** \`${peers}\` active\n`;
        } else if (stage === 'downloading') {
            text += `• **Status:** 📥 Downloading (Peers: \`${peers}\` active)\n` +
                    formatProgressBar(
                        torrent.progress,
                        torrent.downloadSpeed,
                        torrent.timeRemaining / 1000,
                        torrent.downloaded,
                        torrent.length
                    ) + `\n`;
        } else if (stage === 'compressing') {
            text += `• **Status:** 🤐 Zipping files...\n` +
                    `• **Total Size:** ${formatBytes(torrent?.length || 0)}\n`;
        } else if (stage === 'splitting') {
            text += `• **Status:** ✂️ Splitting archive into chunks...\n` +
                    `• **Total Size:** ${formatBytes(torrent?.length || 0)}\n`;
        } else if (stage === 'uploading') {
            const fraction = task.uploadProgressFraction || 0;
            const pct = (fraction * 100).toFixed(1);
            const filled = Math.round(fraction * 15);
            const empty = 15 - filled;
            
            text += `• **Status:** 📤 Uploading Part ${task.currentChunk || 1}/${task.totalChunks || 1}\n` +
                    `• **Chunk Name:** \`${task.chunkName || 'Unknown'}\`\n` +
                    `• **Progress:** [${'█'.repeat(filled)}${'░'.repeat(empty)}] ${pct}%\n`;
        } else {
            text += `• **Status:** ⏳ Initializing...\n`;
        }
        text += `\n`;
    });
    
    return text;
}

// Start interactive download processing
async function startTaskDownload(client, infoHash) {
    const task = activeTasks.get(infoHash);
    if (!task) return;
    
    const { torrent, chatId, statusMsgId, taskDir, documentName, tempOutputs, replyToId } = task;
    
    task.stage = 'downloading';
    
    // Clear any metadata checking interval
    if (task.metadataInterval) {
        clearInterval(task.metadataInterval);
        task.metadataInterval = null;
    }
    
    // Remove inline keyboard buttons and transition to download
    try {
        await client.editMessage(chatId, {
            message: statusMsgId,
            text: `📥 **Starting download for:** \`${torrent.name}\`...\nPeers: \`${torrent.numPeers}\` active. Preparing disk storage allocation...`,
            buttons: [[Button.inline("🔄 Refresh Progress", Buffer.from("refresh_progress"))]]
        });
    } catch (e) {
        console.error('Failed to update status message for download start:', e.message);
    }
    
    // Resume downloading all files
    console.log(`\x1b[36m📥 Reselecting all files for torrent: ${torrent.name} to start downloading.\x1b[0m`);
    torrent.files.forEach(file => file.select());
    
    let lastEditTime = 0;
    
    const updateProgress = (force = false) => {
        const now = Date.now();
        if (force || now - lastEditTime > 4000) { // Throttle updates to avoid flooding Telegram
            const peers = torrent.numPeers || 0;
            const text = `📥 **Downloading Torrent** (Peers: \`${peers}\` active)\n` +
                         `Name: \`${torrent.name}\`\n\n` +
                         formatProgressBar(
                             torrent.progress,
                             torrent.downloadSpeed,
                             torrent.timeRemaining / 1000,
                             torrent.downloaded,
                             torrent.length
                         );
            
            client.editMessage(chatId, {
                message: statusMsgId,
                text: text,
                buttons: [[Button.inline("🔄 Refresh Progress", Buffer.from("refresh_progress"))]]
            }).catch(() => {});
            lastEditTime = now;
        }
    };

    torrent.on('download', () => updateProgress(false));
    
    // Force active updates every 4 seconds to show changes even during slow downloading, file allocation, or 0 speed.
    const progressInterval = setInterval(() => {
        updateProgress(true);
    }, 4000);
    
    torrent.on('done', async () => {
        clearInterval(progressInterval);
        console.log(`\x1b[32m✔ Torrent downloaded completely: ${torrent.name}\x1b[0m`);
        
        // Final download update
        await client.editMessage(chatId, {
            message: statusMsgId,
            text: `📦 **Download Complete!**\nName: \`${torrent.name}\`\nSize: ${formatBytes(torrent.length)}\n\n*Preparing files for upload...*`
        });

        try {
            const downloadedFiles = fs.readdirSync(taskDir).filter(f => f !== documentName);
            if (downloadedFiles.length === 0) {
                throw new Error('No downloaded files found in the directory.');
            }

            let fileToUpload = '';
            let isDir = false;

            if (downloadedFiles.length === 1) {
                const fullPath = path.join(taskDir, downloadedFiles[0]);
                const stats = fs.statSync(fullPath);
                if (stats.isDirectory()) {
                    isDir = true;
                } else {
                    fileToUpload = fullPath;
                }
            } else {
                isDir = true;
            }

            // If it's a directory or multiple files, zip them
            if (isDir) {
                task.stage = 'compressing';
                await client.editMessage(chatId, {
                    message: statusMsgId,
                    text: `🤐 **Compression Started**\nZipping folder contents into: \`${torrent.name}.zip\`\nThis may take some time...`,
                    buttons: [[Button.inline("🔄 Refresh Progress", Buffer.from("refresh_progress"))]]
                });

                const zipPath = path.join(downloadDir, `${torrent.name}_${infoHash}.zip`);
                tempOutputs.push(zipPath);

                // Zip it recursively
                await zipDirectory(taskDir, zipPath, (bytesProcessed) => {
                    // optional zipping progress if needed
                });

                fileToUpload = zipPath;
            }

            // Check final file size and split if necessary
            const finalStats = fs.statSync(fileToUpload);
            const fileSize = finalStats.size;

            let chunks = [];
            if (fileSize > uploadLimitBytes) {
                task.stage = 'splitting';
                await client.editMessage(chatId, {
                    message: statusMsgId,
                    text: `✂️ **File splitting required**\nTotal Size: ${formatBytes(fileSize)}\nSplitting into chunks of ${rawUploadLimit} GB...`,
                    buttons: [[Button.inline("🔄 Refresh Progress", Buffer.from("refresh_progress"))]]
                });

                const splitDir = path.join(downloadDir, `split_${infoHash}`);
                fs.mkdirSync(splitDir, { recursive: true });
                tempOutputs.push(splitDir);

                chunks = splitFile(fileToUpload, uploadLimitBytes, splitDir);
            } else {
                chunks = [fileToUpload];
            }

            // Upload chunks to user
            console.log(`\x1b[36m📤 Starting upload of ${chunks.length} parts...\x1b[0m`);
            
            for (let i = 0; i < chunks.length; i++) {
                const chunkPath = chunks[i];
                const chunkName = path.basename(chunkPath);
                const chunkStats = fs.statSync(chunkPath);
                
                // Track upload details for progress querying
                task.stage = 'uploading';
                task.currentChunk = i + 1;
                task.totalChunks = chunks.length;
                task.chunkName = chunkName;
                task.chunkStats = chunkStats;
                task.uploadProgressFraction = 0;

                let lastUploadEdit = 0;

                await client.editMessage(chatId, {
                    message: statusMsgId,
                    text: `📤 **Uploading Part ${i + 1}/${chunks.length}**\nFile: \`${chunkName}\`\nSize: ${formatBytes(chunkStats.size)}`,
                    buttons: [[Button.inline("🔄 Refresh Progress", Buffer.from("refresh_progress"))]]
                });

                await client.sendFile(chatId, {
                    file: chunkPath,
                    forceDocument: true,
                    workers: 8, // High concurrency for blazing-fast uploads
                    replyTo: replyToId,
                    progressCallback: (progressFraction) => {
                        const now = Date.now();
                        if (now - lastUploadEdit > 3500) {
                            const pct = (progressFraction * 100).toFixed(1);
                            const filled = Math.round(progressFraction * 15);
                            const empty = 15 - filled;
                            
                            task.uploadProgressFraction = progressFraction;
                            client.editMessage(chatId, {
                                message: statusMsgId,
                                text: `📤 **Uploading Part ${i + 1}/${chunks.length}**\n` +
                                     `File: \`${chunkName}\`\n` +
                                     `Progress: [${'█'.repeat(filled)}${'░'.repeat(empty)}] ${pct}%`,
                                buttons: [[Button.inline("🔄 Refresh Progress", Buffer.from("refresh_progress"))]]
                            }).catch(() => {});
                            lastUploadEdit = now;
                        }
                    }
                });
            }

            // Success notification
            let successText = `✅ **Success! All files uploaded.**\n\nName: \`${torrent.name}\`\nTotal Parts: ${chunks.length}\nTotal Size: ${formatBytes(fileSize)}`;
            if (chunks.length > 1) {
                successText += `\n\n💡 **How to Merge Parts:**\n` +
                               `• **Windows**: Open Command Prompt and run:\n` +
                               `  \`copy /b "${torrent.name}.zip.*" "${torrent.name}.zip"\`\n` +
                               `• **Mac/Linux**: Open Terminal and run:\n` +
                               `  \`cat "${torrent.name}.zip."* > "${torrent.name}.zip"\``;
            }

            await client.editMessage(chatId, {
                message: statusMsgId,
                text: successText
            });
            console.log(`\x1b[32m✔ Successfully uploaded torrent files for ${torrent.name}\x1b[0m`);

        } catch (err) {
            console.error('Error during zipping/splitting/uploading:', err);
            await client.editMessage(chatId, {
                message: statusMsgId,
                text: `❌ **Error preparing files:** ${err.message}`
            });
        } finally {
            // Cleanup
            cleanupPath(taskDir);
            tempOutputs.forEach(cleanupPath);
            activeTasks.delete(infoHash);
            torrent.destroy();
        }
    });

    torrent.on('error', async (err) => {
        clearInterval(progressInterval);
        console.error('WebTorrent Torrent Error:', err);
        await client.editMessage(chatId, {
            message: statusMsgId,
            text: `❌ **Torrent Error:** ${err.message}`
        });
        cleanupPath(taskDir);
        tempOutputs.forEach(cleanupPath);
        activeTasks.delete(infoHash);
        torrent.destroy();
    });
}

// Cancel a parsing or downloading task
async function cancelTask(client, infoHash) {
    const task = activeTasks.get(infoHash);
    if (!task) return;
    
    const { torrent, chatId, statusMsgId, taskDir, tempOutputs, metadataInterval } = task;
    
    if (metadataInterval) {
        clearInterval(metadataInterval);
    }
    
    try {
        await client.editMessage(chatId, {
            message: statusMsgId,
            text: `❌ **Torrent cancelled.**\nName: \`${torrent ? (torrent.name || 'Unknown') : (task.customName || 'Unknown')}\``
        });
    } catch (e) {
        console.error('Error deleting/modifying for cancellation:', e.message);
    }
    
    cleanupPath(taskDir);
    tempOutputs.forEach(cleanupPath);
    activeTasks.delete(infoHash);
    if (torrent) {
        torrent.destroy();
    }
}

async function startBot() {
    // Dynamically import pure ESM WebTorrent package
    const WebTorrent = (await import('webtorrent')).default;
    torrentClient = new WebTorrent();
    torrentClient.on('error', (err) => {
        console.error('⚠️ WebTorrent Client Error:', err.message);
    });

    console.log('\n\x1b[36m==================================================');
    console.log('      TORRENT TO TELEGRAM BOT - STARTING');
    console.log('==================================================\x1b[0m');
    console.log(`📡 Upload limit: \x1b[33m${rawUploadLimit} GB\x1b[0m`);
    console.log(`📂 Downloads path: \x1b[33m${downloadDir}\x1b[0m\n`);

    const stringSession = new StringSession(session);
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });

    await client.connect();
    
    // Check if authenticated
    const me = await client.getMe();
    if (!me) {
        console.error('\x1b[31m❌ Connection failed! Session might be expired. Please re-run node login.js\x1b[0m');
        process.exit(1);
    }

    const botUsername = me.username || 'Userbot';
    console.log(`\x1b[32m✔ Authenticated successfully as: @${botUsername} (${me.firstName})\x1b[0m`);

    // Dynamically Register Bot Commands in Telegram
    try {
        await client.invoke(new Api.bots.SetBotCommands({
            scope: new Api.BotCommandScopeDefault(),
            langCode: '',
            commands: [
                new Api.BotCommand({ command: 'start', description: '🚀 Get welcome message & intro' }),
                new Api.BotCommand({ command: 'help', description: '📖 Detailed usage guide' }),
                new Api.BotCommand({ command: 'status', description: '📊 Check bot & server status' }),
                new Api.BotCommand({ command: 'progress', description: '📊 Show active task progress' })
            ]
        }));
        console.log('\x1b[32m✔ Telegram bot commands configured successfully!\x1b[0m');
    } catch (err) {
        console.log('\x1b[33m⚠️ Could not configure bot commands menu (expected if logged in as userbot).\x1b[0m');
    }

    console.log('\x1b[36m--------------------------------------------------');
    console.log('        Waiting for torrents/magnet links...');
    console.log('--------------------------------------------------\x1b[0m\n');

    // Message handler for /start, /help, /status, and torrent inputs
    client.addEventHandler(async (event) => {
        const message = event.message;
        if (!message) return;

        // Process only Private Messages (DMs) to avoid noise in groups
        if (!message.isPrivate) return;

        const text = message.text || '';
        const chatId = message.chatId.toString();

        // Handle commands
        if (text === '/start') {
            const welcomeText = `👋 **Welcome to the Advanced Torrent Downloader Bot!**\n\n` +
                                `This premium bot downloads torrent files or magnet links and uploads them directly to your Telegram chat!\n\n` +
                                `🚀 **Features:**\n` +
                                `• **Up to 2GB/4GB file uploads** using Telegram MTProto directly.\n` +
                                `• **File list view** with size details before initiating downloads.\n` +
                                `• **Auto-zipping** for folders & multi-file torrents.\n` +
                                `• **Sequential split** support for heavy torrents (5GB - 80GB+).\n` +
                                `• **Visual live downloading & uploading** progress bars.\n\n` +
                                `👉 **To get started:** Simply upload a \`.torrent\` file or send a \`magnet:\` link to this chat!`;
            
            await client.sendMessage(chatId, {
                message: welcomeText,
                buttons: [
                    [
                        Button.inline("📖 Help Guide", Buffer.from("help")),
                        Button.inline("📊 System Status", Buffer.from("status"))
                    ],
                    [
                        Button.inline("📊 My Progress", Buffer.from("my_progress"))
                    ]
                ]
            });
            return;
        }

        if (text === '/help') {
            await client.sendMessage(chatId, {
                message: getHelpGuide(),
                buttons: [
                    [
                        Button.inline("📊 System Status", Buffer.from("status")),
                        Button.inline("📊 My Progress", Buffer.from("my_progress"))
                    ]
                ]
            });
            return;
        }

        if (text === '/status') {
            await client.sendMessage(chatId, {
                message: getSystemStatus(),
                buttons: [
                    [
                        Button.inline("📊 My Progress", Buffer.from("my_progress")),
                        Button.inline("📖 Help Guide", Buffer.from("help"))
                    ]
                ]
            });
            return;
        }

        if (text === '/progress') {
            await client.sendMessage(chatId, {
                message: getUserProgressText(chatId),
                buttons: [
                    [
                        Button.inline("🔄 Refresh Progress", Buffer.from("refresh_progress")),
                        Button.inline("📖 Help Guide", Buffer.from("help"))
                    ]
                ]
            });
            return;
        }

        const isMagnet = text.startsWith('magnet:?');

        // Check for .torrent files
        let isTorrentFile = false;
        let documentName = '';
        if (message.media && message.media.document) {
            const document = message.media.document;
            const attributes = document.attributes || [];
            const filenameAttr = attributes.find(attr => attr.className === 'DocumentAttributeFilename');
            if (filenameAttr && filenameAttr.fileName.toLowerCase().endsWith('.torrent')) {
                isTorrentFile = true;
                documentName = filenameAttr.fileName;
            }
        }

        if (!isMagnet && !isTorrentFile) return;

        const sender = await message.getSender();
        const senderName = sender ? (sender.firstName || sender.username || 'User') : 'User';

        console.log(`\x1b[36m📥 New torrent request from ${senderName} (${chatId}):\x1b[0m`, isMagnet ? 'Magnet Link' : documentName);

        // Create a unique temporary directory for this session
        const downloadId = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        const taskDir = path.join(downloadDir, `task_${downloadId}`);
        const tempOutputs = []; 

        let statusMsg;
        try {
            statusMsg = await client.sendMessage(chatId, {
                message: '⏳ Initializing torrent request...',
                replyTo: message.id
            });
        } catch (err) {
            console.error('Failed to send initial status message:', err.message);
            return;
        }

        try {
            fs.mkdirSync(taskDir, { recursive: true });
            
            let torrentSource = text.trim();

            if (isTorrentFile) {
                await client.editMessage(chatId, {
                    message: statusMsg.id,
                    text: '📥 Downloading .torrent file metadata...'
                });
                
                const localTorrentPath = path.join(taskDir, documentName);
                const buffer = await client.downloadMedia(message.media);
                fs.writeFileSync(localTorrentPath, buffer);
                torrentSource = localTorrentPath;
            }

            // Parse torrent/magnet to check for duplicate downloads first
            let infoHashToCheck = null;
            try {
                const parseTorrent = (await import('parse-torrent')).default;
                let torrentData = torrentSource;
                if (isTorrentFile) {
                    torrentData = fs.readFileSync(torrentSource);
                }
                const parsed = await parseTorrent(torrentData);
                infoHashToCheck = parsed.infoHash;
            } catch (err) {
                // ignore parsing error here, let WebTorrent handle it
            }

            if (infoHashToCheck && (activeTasks.has(infoHashToCheck) || (await torrentClient.get(infoHashToCheck)))) {
                await client.editMessage(chatId, {
                    message: statusMsg.id,
                    text: `⚠️ **This torrent is already being processed or downloaded!**`
                });
                cleanupPath(taskDir);
                return;
            }

            // Start WebTorrent client to load metadata
            const torrentOptions = {
                path: taskDir,
                announce: bootstrapTrackers
            };

            const torrent = torrentClient.add(torrentSource, torrentOptions);
            const torrentHash = torrent.infoHash;

            // Register metadata parsing event to deselect files immediately as soon as they are populated
            torrent.on('metadata', () => {
                console.log(`\x1b[35m🧲 Metadata parsed for ${torrent.name || torrentHash}. Deselecting all files to prevent background download.\x1b[0m`);
                torrent.files.forEach(file => file.deselect());
            });

            // Track early stage with infoHash
            const initialTask = {
                torrent,
                chatId,
                statusMsgId: statusMsg.id,
                taskDir,
                documentName,
                tempOutputs,
                replyToId: message.id,
                stage: 'metadata',
                customName: isMagnet ? 'Magnet Link' : documentName,
                metadataInterval: null
            };
            activeTasks.set(torrentHash, initialTask);

            // Display loading screen with live peer counts & cancel button
            let metadataAttempts = 0;
            const metadataInterval = setInterval(async () => {
                metadataAttempts++;
                const peers = torrent.numPeers || 0;
                
                try {
                    await client.editMessage(chatId, {
                        message: statusMsg.id,
                        text: `🧲 **Connecting to peers and parsing metadata...**\n\n` +
                              `• **Connected Peers:** \`${peers}\` active\n` +
                              `• **Time Elapsed:** \`${metadataAttempts * 4}s\`\n\n` +
                              `_Ensure your torrent has healthy seeds if it gets stuck here!_`,
                        buttons: [[Button.inline("❌ Cancel", Buffer.from(`cancel:${torrentHash}`))]]
                    });
                } catch (e) {
                    // Ignore transient network errors during rapid polling
                }
            }, 4000);

            initialTask.metadataInterval = metadataInterval;

            torrent.on('ready', async () => {
                clearInterval(metadataInterval);
                initialTask.metadataInterval = null;
                initialTask.stage = 'ready';
                console.log(`\x1b[32m✔ Metadata parsed for: ${torrent.name}\x1b[0m`);

                // Generate a beautiful files list
                let fileList = torrent.files.map((f, idx) => `  • \`${f.name}\` (${formatBytes(f.length)})`).join('\n');
                if (fileList.length > 800) {
                    fileList = fileList.substring(0, 800) + '\n  ...and more files.';
                }

                const infoText = `🗂️ **Torrent Metadata Loaded!**\n\n` +
                                 `• **Name:** \`${torrent.name}\`\n` +
                                 `• **Total Size:** \`${formatBytes(torrent.length)}\`\n` +
                                 `• **Total Files:** \`${torrent.files.length}\`\n\n` +
                                 `**Files inside Torrent:**\n${fileList}\n\n` +
                                 `Click below to download the files and upload them to Telegram.`;

                // Display file list and start action buttons
                client.editMessage(chatId, {
                    message: statusMsg.id,
                    text: infoText,
                    buttons: [
                        [
                            Button.inline("⚡ Download & Send All", Buffer.from(`dl_all:${torrentHash}`)),
                            Button.inline("❌ Cancel", Buffer.from(`cancel:${torrentHash}`))
                        ]
                    ]
                }).catch(err => {
                    console.error('Failed to edit with file list buttons:', err.message);
                });
            });

            torrent.on('error', async (err) => {
                clearInterval(metadataInterval);
                initialTask.metadataInterval = null;
                console.error('WebTorrent Load Error:', err);
                await client.editMessage(chatId, {
                    message: statusMsg.id,
                    text: `❌ **Metadata Parsing Error:** ${err.message}`
                });
                cleanupPath(taskDir);
                tempOutputs.forEach(cleanupPath);
                activeTasks.delete(torrentHash);
                torrent.destroy();
            });

        } catch (err) {
            console.error('General Handler Error:', err);
            await client.editMessage(chatId, {
                message: statusMsg.id,
                text: `❌ **Error:** ${err.message}`
            });
            cleanupPath(taskDir);
            tempOutputs.forEach(cleanupPath);
        }
    }, new NewMessage({}));

    // Register Inline Keyboard Callbacks
    client.addEventHandler(async (event) => {
        const data = event.data ? event.data.toString() : '';
        if (!data) return;

        const chatId = event.query.userId.toString();

        if (data.startsWith('dl_all:')) {
            const infoHash = data.substring(7);
            await event.answer({ message: "📥 Starting high-speed download..." });
            startTaskDownload(client, infoHash);
        } else if (data.startsWith('cancel:')) {
            const infoHash = data.substring(7);
            await event.answer({ message: "❌ Request cancelled." });
            cancelTask(client, infoHash);
        } else if (data === 'help') {
            await event.answer();
            await client.sendMessage(chatId, {
                message: getHelpGuide(),
                buttons: [
                    [
                        Button.inline("📊 System Status", Buffer.from("status")),
                        Button.inline("📊 My Progress", Buffer.from("my_progress"))
                    ]
                ]
            });
        } else if (data === 'status') {
            await event.answer();
            await client.sendMessage(chatId, {
                message: getSystemStatus(),
                buttons: [
                    [
                        Button.inline("📊 My Progress", Buffer.from("my_progress")),
                        Button.inline("📖 Help Guide", Buffer.from("help"))
                    ]
                ]
            });
        } else if (data === 'my_progress') {
            await event.answer();
            await client.sendMessage(chatId, {
                message: getUserProgressText(chatId),
                buttons: [
                    [
                        Button.inline("🔄 Refresh Progress", Buffer.from("refresh_progress")),
                        Button.inline("📖 Help Guide", Buffer.from("help"))
                    ]
                ]
            });
        } else if (data === 'refresh_progress') {
            const progressText = getUserProgressText(chatId);
            try {
                await event.edit({
                    message: progressText,
                    buttons: [
                        [
                            Button.inline("🔄 Refresh Progress", Buffer.from("refresh_progress")),
                            Button.inline("📖 Help Guide", Buffer.from("help"))
                        ]
                    ]
                });
                await event.answer({ message: "🔄 Progress refreshed!" });
            } catch (err) {
                await event.answer({ message: "⚠️ No change in progress yet." });
            }
        }
    }, new CallbackQuery({}));
}

startBot().catch(err => {
    console.error('Fatal initialization error:', err);
});
