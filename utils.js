const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

/**
 * Zips a directory recursively and writes it to a file.
 * @param {string} sourceDir 
 * @param {string} outPath 
 * @param {function} progressCallback - Called periodically with (bytesProcessed)
 * @returns {Promise<number>} - Resolves with the size of the zipped archive in bytes
 */
function zipDirectory(sourceDir, outPath, progressCallback) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outPath);
        const archive = archiver('zip', {
            zlib: { level: 9 }
        });

        output.on('close', () => {
            resolve(archive.pointer());
        });

        archive.on('warning', (err) => {
            if (err.code === 'ENOENT') {
                console.warn('Archiver Warning:', err);
            } else {
                reject(err);
            }
        });

        archive.on('error', (err) => {
            reject(err);
        });

        if (progressCallback) {
            archive.on('progress', (data) => {
                if (data.fs && data.fs.processedBytes) {
                    progressCallback(data.fs.processedBytes);
                }
            });
        }

        archive.pipe(output);
        archive.directory(sourceDir, false);
        archive.finalize();
    });
}

/**
 * Splits a file into sequential chunks of a specified size in bytes.
 * Named: [original_name].zip.001, [original_name].zip.002, etc.
 * Uses high-performance synchronous block streaming to prevent memory overhead.
 * @param {string} filePath 
 * @param {number} chunkSizeBytes 
 * @param {string} outputDir 
 * @returns {string[]} - List of chunk absolute paths
 */
function splitFile(filePath, chunkSizeBytes, outputDir) {
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const filename = path.basename(filePath);

    if (fileSize <= chunkSizeBytes) {
        return [filePath];
    }

    const chunkPaths = [];
    const sourceFd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(16 * 1024 * 1024); // 16MB buffer size for fast I/O

    let partNumber = 1;
    let position = 0;

    while (position < fileSize) {
        const partFilename = `${filename}.${String(partNumber).padStart(3, '0')}`;
        const partPath = path.join(outputDir, partFilename);
        const destFd = fs.openSync(partPath, 'w');

        let partWritten = 0;
        const partLimit = Math.min(chunkSizeBytes, fileSize - position);

        while (partWritten < partLimit) {
            const toRead = Math.min(buffer.length, partLimit - partWritten);
            const bytesRead = fs.readSync(sourceFd, buffer, 0, toRead, position);
            if (bytesRead === 0) break;

            fs.writeSync(destFd, buffer, 0, bytesRead);
            position += bytesRead;
            partWritten += bytesRead;
        }

        fs.closeSync(destFd);
        chunkPaths.push(partPath);
        partNumber++;
    }

    fs.closeSync(sourceFd);
    return chunkPaths;
}

/**
 * Formats a file size in bytes to a human-readable string.
 * @param {number} bytes 
 * @returns {string}
 */
function formatBytes(bytes) {
    if (bytes === 0 || isNaN(bytes)) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Formats duration in seconds to a human-readable string.
 * @param {number} seconds 
 * @returns {string}
 */
function formatTime(seconds) {
    if (isNaN(seconds) || seconds === Infinity || seconds === null) return 'Calculating...';
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    if (mins < 60) return `${mins}m ${secs}s`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hours}h ${remMins}m`;
}

/**
 * Generates a text-based progress bar and status stats.
 * @param {number} progress - Float between 0 and 1
 * @param {number} speed - Speed in bytes/sec
 * @param {number} eta - ETA in seconds
 * @param {number} downloadedBytes 
 * @param {number} totalBytes 
 * @returns {string}
 */
function formatProgressBar(progress, speed, eta, downloadedBytes, totalBytes) {
    const width = 15;
    const filledWidth = Math.min(width, Math.round(progress * width));
    const emptyWidth = width - filledWidth;
    
    const filledBar = '█'.repeat(filledWidth);
    const emptyBar = '░'.repeat(emptyWidth);
    
    const pct = (progress * 100).toFixed(1);
    
    return `Progress: [${filledBar}${emptyBar}] ${pct}%\n` +
           `Downloaded: ${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}\n` +
           `Speed: ${formatBytes(speed)}/s | ETA: ${formatTime(eta)}`;
}

module.exports = {
    zipDirectory,
    splitFile,
    formatBytes,
    formatTime,
    formatProgressBar
};
