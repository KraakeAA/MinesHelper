// mines_helper.js
// This is a new, separate file for your Mines bot.

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { Pool } from 'pg';

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.MINES_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const BOT_ID = BOT_TOKEN.split(':')[0];

if (!BOT_TOKEN || !DATABASE_URL) {
    console.error("MINES HELPER: CRITICAL: MINES_BOT_TOKEN or DATABASE_URL is missing.");
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.DB_REJECT_UNAUTHORIZED === 'true' } : false,
});

const activeHelperGames = new Map();

// --- GAME CONSTANTS (Copied from main bot) ---
const UNIFIED_OFFER_TIMEOUT_MS = parseInt(process.env.UNIFIED_OFFER_TIMEOUT_MS, 10) || 30000;
const ACTIVE_GAME_TURN_TIMEOUT_MS = parseInt(process.env.ACTIVE_GAME_TURN_TIMEOUT_MS, 10) || 45000;
const TILE_EMOJI_HIDDEN = '❓';
const TILE_EMOJI_GEM = '💎';
const TILE_EMOJI_MINE = '💣';
const TILE_EMOJI_EXPLOSION = '💥';
const MINES_DIFFICULTY_CONFIG = {
    easy: {
        rows: 5, cols: 5, mines: 3, label: "Easy (5x5, 3 Mines)", emoji: '🟢',
        multipliers: [0, 1.08, 1.18, 1.29, 1.42, 1.55, 1.70, 1.88, 2.08, 2.30, 2.55, 2.85, 3.20, 3.60, 4.05, 4.50, 5.00, 6.00, 7.50, 10.00, 15.00, 25.00, 50.00]
    },
    medium: {
        rows: 5, cols: 5, mines: 5, label: "Medium (5x5, 5 Mines)", emoji: '🟡',
        multipliers: [0, 1.12, 1.28, 1.47, 1.70, 1.98, 2.30, 2.70, 3.15, 3.70, 4.35, 5.10, 6.00, 7.10, 8.50, 10.50, 13.00, 16.50, 22.00, 30.00, 75.00]
    },
    hard: {
        rows: 5, cols: 5, mines: 7, label: "Hard (5x5, 7 Mines)", emoji: '🔴',
        multipliers: [0, 1.18, 1.40, 1.68, 2.00, 2.40, 2.90, 3.50, 4.20, 5.10, 6.20, 7.50, 9.20, 11.50, 14.50, 18.00, 23.00, 30.00, 100.00]
    },
};

// --- UTILITY FUNCTIONS ---
function escapeHTML(text) {
    if (text === null || typeof text === 'undefined') return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

async function safeSendMessage(chatId, text, options = {}) {
    try {
        return await bot.sendMessage(chatId, text, options);
    } catch (e) {
        console.error(`[Mines Helper] Failed to send message to ${chatId}: ${e.message}`);
        return null;
    }
}

// --- DATABASE INTERACTION ---

async function finalizeAndRecordOutcome(sessionId, finalStatus, finalGameState = {}) {
    const logPrefix = `[MinesHelper_Finalize SID:${sessionId}]`;
    console.log(`${logPrefix} Finalizing game with status: ${finalStatus}`);
    try {
        await pool.query(
            "UPDATE mines_sessions SET status = $1, game_state_json = $2, updated_at = NOW() WHERE session_id = $3",
            [finalStatus, JSON.stringify(finalGameState), sessionId]
        );
        activeHelperGames.delete(sessionId);
    } catch (e) {
        console.error(`${logPrefix} CRITICAL: Failed to write final outcome to DB: ${e.message}`);
    }
}

// --- CORE GAME LOGIC (PORTED FROM index.js) ---

function generateMinesGridAndData(rows, cols, numMines) {
    let grid = Array(rows).fill(null).map(() => Array(cols).fill(null).map(() => ({ isMine: false, isRevealed: false })));
    let minesPlaced = 0;
    const mineLocations = [];
    while (minesPlaced < numMines) {
        const r = Math.floor(Math.random() * rows);
        const c = Math.floor(Math.random() * cols);
        if (!grid[r][c].isMine) {
            grid[r][c].isMine = true;
            mineLocations.push([r, c]);
            minesPlaced++;
        }
    }
    return { grid, mineLocations };
}

function calculateMinesMultiplier(difficultyKey, gemsFound) {
    const difficultyConfig = MINES_DIFFICULTY_CONFIG[difficultyKey];
    if (!difficultyConfig || !difficultyConfig.multipliers) return 0.0;
    return difficultyConfig.multipliers[gemsFound] || 0.0;
}

function formatAndGenerateMinesMessage(session) {
    const { bet_amount_lamports, status, game_state_json: gs } = session;
    const { difficultyKey, gemsFound, grid } = gs;
    
    const difficultyConfig = MINES_DIFFICULTY_CONFIG[difficultyKey];
    const betDisplay = `${(Number(bet_amount_lamports) / 1e9).toFixed(4)} SOL`;
    const playerRef = escapeHTML(gs.initiatorName);
    
    let titleEmoji = TILE_EMOJI_MINE;
    if (status === 'completed_mine_hit') titleEmoji = TILE_EMOJI_EXPLOSION;
    else if (status === 'completed_cashed_out' || status === 'completed_all_gems_found') titleEmoji = '🎉';
    
    let messageText = `${titleEmoji} <b>Mines - ${escapeHTML(difficultyConfig.label)}</b> ${titleEmoji}\n\n`;
    messageText += `Player: ${playerRef}\nWager: <b>${betDisplay}</b>\n\n`;
    
    const totalGems = (difficultyConfig.rows * difficultyConfig.cols) - difficultyConfig.mines;
    messageText += `${TILE_EMOJI_GEM} Gems Found: <b>${gemsFound} / ${totalGems}</b>\n`;
    
    const currentMultiplier = calculateMinesMultiplier(difficultyKey, gemsFound);
    const potentialPayout = BigInt(Math.floor(Number(bet_amount_lamports) * currentMultiplier));
    
    if (status === 'in_progress') {
        if (gemsFound > 0) {
            messageText += `Current Payout: <b>x${currentMultiplier.toFixed(2)}</b> (${(Number(potentialPayout)/1e9).toFixed(4)} SOL)\n`;
        }
        const nextMultiplier = calculateMinesMultiplier(difficultyKey, gemsFound + 1);
        messageText += `Next Gem: <b>x${nextMultiplier.toFixed(2)}</b>\n\n`;
        messageText += `Click a tile to reveal it!`;
    }

    const keyboardRows = [];
    for (let r = 0; r < difficultyConfig.rows; r++) {
        const row = [];
        for (let c = 0; c < difficultyConfig.cols; c++) {
            const isRevealed = grid[r][c].isRevealed;
            const isMine = grid[r][c].isMine;
            let buttonText = TILE_EMOJI_HIDDEN;
            if (isRevealed) {
                buttonText = isMine ? TILE_EMOJI_EXPLOSION : TILE_EMOJI_GEM;
            }
            row.push({ text: buttonText, callback_data: isRevealed ? 'mines_noop' : `mines_helper_tile:${session.session_id}:${r}:${c}` });
        }
        keyboardRows.push(row);
    }
    
    if (status === 'in_progress' && gemsFound > 0) {
        keyboardRows.push([{ text: `💰 Cash Out (x${currentMultiplier.toFixed(2)})`, callback_data: `mines_helper_cashout:${session.session_id}` }]);
    }
    
    return { text: messageText, keyboard: { inline_keyboard: keyboardRows } };
}

async function updateGameMessage(session) {
    const { text, keyboard } = formatAndGenerateMinesMessage(session);
    try {
        await bot.editMessageText(text, {
            chat_id: session.chat_id,
            message_id: session.game_state_json.helperMessageId,
            parse_mode: 'HTML',
            reply_markup: keyboard
        });

        // Reset timeout on successful update
        if (session.timeoutId) clearTimeout(session.timeoutId);
        session.timeoutId = setTimeout(() => handleGameTimeout(session.session_id), ACTIVE_GAME_TURN_TIMEOUT_MS);
        activeHelperGames.set(session.session_id, session);
    } catch(e) {
        if (!e.message?.includes("message is not modified")) {
            console.error(`[MinesHelper] Failed to update game message for SID ${session.session_id}: ${e.message}`);
        }
    }
}

async function handleGameTimeout(sessionId) {
    const session = activeHelperGames.get(sessionId);
    if (!session) return;
    
    const finalGameState = session.game_state_json;
    finalGameState.grid.forEach(row => row.forEach(cell => cell.isRevealed = true));

    const {text, keyboard} = formatAndGenerateMinesMessage(session);
    await bot.editMessageText(`${text}\n\n<b>⏱️ Game timed out. Your bet was forfeited.</b>`, {
         chat_id: session.chat_id, message_id: finalGameState.helperMessageId, parse_mode: 'HTML', reply_markup: keyboard
    });
    
    await finalizeAndRecordOutcome(sessionId, 'completed_timeout', finalGameState);
}

// --- MAIN HANDLERS ---

async function handleNewGameSession(mainBotGameId) {
    const logPrefix = `[MinesHelper_HandleNew GID:${mainBotGameId}]`;
    let client = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const sessionRes = await client.query(
            "UPDATE mines_sessions SET status = 'awaiting_difficulty', helper_bot_id = $1 WHERE main_bot_game_id = $2 AND status = 'pending_pickup' RETURNING *",
            [BOT_ID, mainBotGameId]
        );

        if (sessionRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return;
        }
        const session = sessionRes.rows[0];
        await client.query('COMMIT');
        
        const gameState = session.game_state_json || {};
        const playerRef = escapeHTML(gameState.initiatorName || `Player ${session.initiator_id}`);
        const betDisplay = `${(Number(session.bet_amount_lamports) / 1e9).toFixed(4)} SOL`;

        let difficultyButtons = [];
        for (const diffKey in MINES_DIFFICULTY_CONFIG) {
            const diffConfig = MINES_DIFFICULTY_CONFIG[diffKey];
            difficultyButtons.push({ text: `${diffConfig.emoji} ${diffConfig.label}`, callback_data: `mines_helper_difficulty:${session.session_id}:${diffKey}`});
        }

        const messageText = `💣 <b>Mines Challenge!</b>\n\n${playerRef}, you wagered <b>${betDisplay}</b>.\n\nPlease select a difficulty to begin:`;
        const keyboard = { inline_keyboard: [difficultyButtons, [{text: '❌ Cancel', callback_data: `mines_helper_cancel:${session.session_id}`}]] };

        const sentMessage = await safeSendMessage(session.chat_id, messageText, { parse_mode: 'HTML', reply_markup: keyboard });
        if (sentMessage) {
            session.game_state_json.helperMessageId = sentMessage.message_id;
            session.timeoutId = setTimeout(() => handleGameTimeout(session.session_id, 'offer'), UNIFIED_OFFER_TIMEOUT_MS);
            activeHelperGames.set(session.session_id, session);
            await pool.query("UPDATE mines_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(session.game_state_json), session.session_id]);
        } else {
            await finalizeAndRecordOutcome(session.session_id, 'completed_error_ui', {error: 'Failed to send difficulty selection'});
        }

    } catch (e) {
        if (client) await client.query('ROLLBACK');
        console.error(`${logPrefix} Error handling new session: ${e.message}`);
    } finally {
        if (client) client.release();
    }
}

bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    const [action, sessionIdStr, ...params] = data.split(':');
    const sessionId = parseInt(sessionIdStr, 10);
    const clickerId = String(callbackQuery.from.id);

    const session = activeHelperGames.get(sessionId);
    if (!session || clickerId !== String(session.initiator_id)) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: "This is not your game.", show_alert: true });
        return;
    }

    if (session.timeoutId) clearTimeout(session.timeoutId);
    await bot.answerCallbackQuery(callbackQuery.id);

    let gameState = session.game_state_json;

    switch (action) {
        case 'mines_helper_difficulty':
            const difficultyKey = params[0];
            const config = MINES_DIFFICULTY_CONFIG[difficultyKey];
            const { grid, mineLocations } = generateMinesGridAndData(config.rows, config.cols, config.mines);
            
            session.status = 'in_progress';
            gameState.difficultyKey = difficultyKey;
            gameState.grid = grid;
            gameState.mineLocations = mineLocations;
            gameState.gemsFound = 0;
            
            await updateGameMessage(session);
            break;
        
        case 'mines_helper_tile':
            const r = parseInt(params[0], 10);
            const c = parseInt(params[1], 10);
            const cell = gameState.grid[r][c];
            cell.isRevealed = true;
            
            if (cell.isMine) {
                gameState.grid.forEach(row => row.forEach(cell => cell.isRevealed = true)); // Reveal all
                const {text, keyboard} = formatAndGenerateMinesMessage(session);
                await bot.editMessageText(`${text}\n\n<b>💥 BOOM! You hit a mine. Game over.</b>`, {chat_id: session.chat_id, message_id: gameState.helperMessageId, parse_mode: 'HTML', reply_markup: keyboard});
                await finalizeAndRecordOutcome(sessionId, 'completed_mine_hit', gameState);
            } else {
                gameState.gemsFound++;
                const totalGems = (gameState.grid.length * gameState.grid[0].length) - gameState.mineLocations.length;
                if(gameState.gemsFound >= totalGems){
                    const {text, keyboard} = formatAndGenerateMinesMessage(session);
                    await bot.editMessageText(`${text}\n\n<b>🎉 CONGRATULATIONS! You found all the gems!</b>`, {chat_id: session.chat_id, message_id: gameState.helperMessageId, parse_mode: 'HTML', reply_markup: keyboard});
                    await finalizeAndRecordOutcome(sessionId, 'completed_all_gems_found', gameState);
                } else {
                    await updateGameMessage(session);
                }
            }
            break;

        case 'mines_helper_cashout':
            gameState.grid.forEach(row => row.forEach(cell => cell.isRevealed = true));
            const {text, keyboard} = formatAndGenerateMinesMessage(session);
            await bot.editMessageText(`${text}\n\n<b>💰 You cashed out! Well played.</b>`, {chat_id: session.chat_id, message_id: gameState.helperMessageId, parse_mode: 'HTML', reply_markup: keyboard});
            await finalizeAndRecordOutcome(sessionId, 'completed_cashed_out', gameState);
            break;

        case 'mines_helper_cancel':
            await bot.deleteMessage(session.chat_id, gameState.helperMessageId).catch(() => {});
            await finalizeAndRecordOutcome(sessionId, 'completed_cancelled', gameState);
            break;
    }
});

// --- MAIN LISTENER ---

async function listenForNewGames() {
    const client = await pool.connect();
    client.on('notification', (msg) => {
        if (msg.channel === 'mines_session_pickup') {
            try {
                const payload = JSON.parse(msg.payload);
                if (payload.main_bot_game_id) {
                    console.log(`[MinesHelper] Received pickup notification for ${payload.main_bot_game_id}`);
                    handleNewGameSession(payload.main_bot_game_id);
                }
            } catch (e) {
                console.error("[MinesHelper] Error parsing notification payload:", e);
            }
        }
    });
    await client.query('LISTEN mines_session_pickup');
    const self = await bot.getMe();
    console.log(`✅ Mines Helper Bot (@${self.username}) is online and listening for games...`);
}

listenForNewGames().catch(e => {
    console.error("FATAL: Failed to start Mines Helper listener:", e);
    process.exit(1);
});
