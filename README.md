# 📊 Torrent to Telegram Downloader Bot

A high-performance Node.js Telegram Bot that downloads torrents (via magnet links or `.torrent` files) and uploads the downloaded files directly to Telegram using the GramJS MTProto client.

It features a custom-built, interactive metadata-loading phase, real-time peer count tracking, automated file zipping, sequential large-file splitting (supporting uploads over 2 GB / 4 GB), and live-updating progress screens.

---

## 🚀 Key Features

* **⚡ Fast Direct Downloads:** Uses WebTorrent for high-speed P2P downloading.
* **📦 Auto-Zipping:** Automatically compresses folders or multi-file torrents into a single `.zip` archive before uploading.
* **✂️ Sequential Chunk Splitting:** Automatically splits archives exceeding the Telegram upload limit (e.g. 2 GB for standard or 4 GB for premium accounts) into numbered chunks to bypass limits.
* **📊 Visual Real-Time Progress:** Dynamic progress bars with download speeds, ETA, active peer counts (`torrent.numPeers`), and precise upload progress fraction tracking.
* **🛡️ Zero-Disk Lockups:** Interactive metadata loading allows you to preview the file list and cancel stuck/inactive torrents before allocating disk space.
* **🔄 Keyboard Control:** Clean inline callback buttons for refreshing progress, viewing guide, checking system status, or aborting active tasks.

---

## 🛠️ Prerequisites

* **Node.js:** v18.0.0 or higher.
* **Telegram Account API Credentials:** You need a `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from [my.telegram.org](https://my.telegram.org/).

---

## 📦 Installation & Setup

1. **Clone the Repository:**
   ```bash
   git clone https://github.com/rasindugimhan/Torrent-Downloader-.git
   cd Torrent-Downloader-
   ```

2. **Install Dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment:**
   Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
   Open the `.env` file and fill in your `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`:
   ```env
   TELEGRAM_API_ID="YOUR_API_ID"
   TELEGRAM_API_HASH="YOUR_API_HASH"
   UPLOAD_LIMIT_GB="2"
   DOWNLOAD_DIR="./downloads"
   ```

4. **Generate Telegram Session:**
   Run the interactive setup wizard to log in securely (supports logging in as a standard **User** account or a **Bot** token):
   ```bash
   node login.js
   ```
   This will automatically save your session token directly inside the `.env` file (`TELEGRAM_SESSION`).

---

## 🚦 Usage

### Running Locally
To launch the bot on your local machine:
```bash
npm start
```

### Production Deployment (24/7 background run)
It is highly recommended to use **PM2** to run the bot persistently in the background. It will automatically restart the bot on system reboots or unhandled exceptions:

```bash
# 1. Install PM2 globally
npm install -g pm2

# 2. Start the bot
pm2 start index.js --name "torrent-bot"

# 3. View live logs
pm2 logs torrent-bot

# 4. Save and configure PM2 startup on boot
pm2 startup
pm2 save
```

---

## 📖 Telegram Commands

* `/start` - Displays a premium welcome banner, feature tour, and guide.
* `/help` - Shows a detailed user manual on how to download and merge files.
* `/status` - Displays system resource utilization, memory limits, and total active downloading tasks.
* `/progress` - Returns a beautiful live summary of your active downloading or uploading tasks.

---

## 🧩 How to Reassemble Split Files

If a downloaded torrent exceeds your `UPLOAD_LIMIT_GB`, the bot will automatically split it into consecutive chunks (e.g. `Archive.zip.001`, `Archive.zip.002`). You can merge them back instantly on your PC:

* **Windows (Command Prompt):**
  ```cmd
  copy /b "Archive.zip.*" "Archive.zip"
  ```
* **Mac / Linux (Terminal):**
  ```bash
  cat Archive.zip.* > Archive.zip
  ```

---

## 🔒 Security Note

Your `.env` file contains critical authorization tokens that control your Telegram session. The included `.gitignore` file guarantees these session files are **never** pushed to public source control. Keep your `.env` private!
