const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

function updateEnvFile(key, value) {
    const envPath = path.join(__dirname, '.env');
    let envContent = '';
    
    if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
    }
    
    const lines = envContent.split('\n');
    let keyExists = false;
    
    const updatedLines = lines.map(line => {
        if (line.trim().startsWith(`${key}=`)) {
            keyExists = true;
            return `${key}="${value}"`;
        }
        return line;
    });
    
    if (!keyExists) {
        updatedLines.push(`${key}="${value}"`);
    }
    
    fs.writeFileSync(envPath, updatedLines.join('\n').trim() + '\n', 'utf8');
    console.log(`\x1b[32m✔ Updated ${key} in .env file!\x1b[0m`);
}

const cleanEnvValue = (val) => {
    if (!val) return '';
    return val.trim().replace(/^["']|["']$/g, '');
};

async function main() {
    console.log('\n\x1b[36m==================================================');
    console.log('      TORRENT TO TELEGRAM BOT - LOGIN SETUP');
    console.log('==================================================\x1b[0m\n');
    
    // Check for API ID and API HASH
    let apiIdStr = cleanEnvValue(process.env.TELEGRAM_API_ID);
    let apiHash = cleanEnvValue(process.env.TELEGRAM_API_HASH);
    
    if (!apiIdStr) {
        apiIdStr = await askQuestion('Enter your Telegram API_ID (from my.telegram.org): ');
        updateEnvFile('TELEGRAM_API_ID', apiIdStr.trim());
    }
    
    if (!apiHash) {
        apiHash = await askQuestion('Enter your Telegram API_HASH (from my.telegram.org): ');
        updateEnvFile('TELEGRAM_API_HASH', apiHash.trim());
    }
    
    apiIdStr = cleanEnvValue(apiIdStr);
    apiHash = cleanEnvValue(apiHash);
    
    const apiId = parseInt(apiIdStr.trim(), 10);
    if (isNaN(apiId)) {
        console.error('\x1b[31m❌ API_ID must be a number!\x1b[0m');
        rl.close();
        process.exit(1);
    }
    
    const loginType = await askQuestion('Log in as [B]ot or [U]ser account? (B/U): ');
    const isBot = loginType.trim().toLowerCase() === 'b' || loginType.trim().toLowerCase() === 'bot';
    
    const stringSession = new StringSession('');
    const client = new TelegramClient(stringSession, apiId, apiHash.trim(), {
        connectionRetries: 5,
    });
    
    if (isBot) {
        let botToken = cleanEnvValue(process.env.TELEGRAM_BOT_TOKEN);
        if (!botToken) {
            botToken = await askQuestion('Enter your Telegram Bot Token (from @BotFather): ');
            updateEnvFile('TELEGRAM_BOT_TOKEN', botToken.trim());
        }
        
        botToken = cleanEnvValue(botToken);
        
        console.log('\nLogging in as Bot...');
        try {
            await client.start({
                botAuthToken: botToken.trim(),
            });
            console.log('\x1b[32m✔ Successfully logged in as Bot!\x1b[0m');
        } catch (err) {
            console.error('\x1b[31m❌ Login failed:\x1b[0m', err.message);
            rl.close();
            process.exit(1);
        }
    } else {
        console.log('\nLogging in as User (Required for Premium/4GB files)...');
        try {
            await client.start({
                phoneNumber: async () => await askQuestion('Enter your phone number (e.g. +1234567890): '),
                phoneCode: async () => await askQuestion('Enter the code you received on Telegram: '),
                password: async () => await askQuestion('Enter your 2FA Cloud Password (if enabled): '),
                onError: (err) => console.log('\x1b[31mError during auth step:\x1b[0m', err.message),
            });
            console.log('\x1b[32m✔ Successfully logged in as User!\x1b[0m');
        } catch (err) {
            console.error('\x1b[31m❌ Login failed:\x1b[0m', err.message);
            rl.close();
            process.exit(1);
        }
    }
    
    const sessionString = client.session.save();
    console.log('\n\x1b[32m✔ Generated Session String successfully!\x1b[0m');
    console.log('\x1b[33mSession String:\x1b[0m', sessionString);
    
    updateEnvFile('TELEGRAM_SESSION', sessionString);
    console.log('\n\x1b[36m==================================================');
    console.log('Setup Complete! You can now start the bot using:');
    console.log('node index.js');
    console.log('==================================================\x1b[0m\n');
    
    rl.close();
    await client.disconnect();
}

main().catch(err => {
    console.error('Unexpected error:', err);
    rl.close();
});
