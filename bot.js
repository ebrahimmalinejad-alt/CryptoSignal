const axios = require('axios');
const fs = require('fs');
const { execSync } = require('child_process');

const TELEGRAM_BOT_TOKEN = "8952382896:AAGeV0YYvFF4exWp3hax0JnqSxtECRP-IsI";
const TELEGRAM_CHAT_LOG = "-1004340657482";   // Admin Channel
const TELEGRAM_CHAT_VIPI = "-1003909320436";  // VIP Channel

const ACTIVE_PUMPS_FILE = './active_pumps.json';
const HISTORY_FILE = './pump_history.json';
const AUDIT_STATE_FILE = './daily_audit_lock.json';

const MIN_24H_VOLUME_USD = 15000000; 

// ==========================================
// FILE PERSISTENCE & GIT FUNCTIONS
// ==========================================
function loadJson(file, fallback) {
    try {
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
    } catch (e) {
        console.error(`Error reading ${file}:`, e.message);
    }
    return fallback;
}

function saveStateAndSync(activePumps, history) {
    try {
        fs.writeFileSync(ACTIVE_PUMPS_FILE, JSON.stringify(activePumps, null, 2), 'utf8');
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');

        execSync('git config --global user.name "github-actions[bot]"');
        execSync('git config --global user.email "github-actions[bot]@users.noreply.github.com"');
        execSync('git pull --rebase origin main || true');
        execSync(`git add ${ACTIVE_PUMPS_FILE} ${HISTORY_FILE}`);
        execSync('git commit -m "Auto-sync pump radar [skip ci]" || true');
        execSync('git push origin main || true');
        console.log("Radar states successfully pushed to repository.");
    } catch (e) {
        console.error("Git Sync Error:", e.message);
    }
}

// ==========================================
// TELEGRAM NOTIFICATIONS
// ==========================================
async function sendTelegram(chatId, text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(url, { chat_id: chatId, text: text, parse_mode: 'HTML' });
    } catch (err) {
        console.error(`Telegram Error (${chatId}):`, err.response ? err.response.data : err.message);
    }
}

// ==========================================
// CROSS-EXCHANGE MARKET HARVESTING
// ==========================================
async function fetchBinanceSpotUniverse() {
    try {
        const res = await axios.get('https://data-api.binance.vision/api/v3/ticker/24hr', { timeout: 6000 });
        if (Array.isArray(res.data)) {
            const map = new Map();
            for (const item of res.data) {
                if (item.symbol.endsWith('USDT')) {
                    map.set(item.symbol, {
                        symbol: item.symbol,
                        lastPrice: parseFloat(item.lastPrice),
                        quoteVolume: parseFloat(item.quoteVolume),
                        priceChangePercent: parseFloat(item.priceChangePercent)
                    });
                }
            }
            return map;
        }
    } catch (e) {
        console.error("Error fetching Binance Spot Tickers:", e.message);
    }
    return new Map();
}

async function fetchBinanceFuturesUniverse() {
    try {
        const res = await axios.get('https://fapi.binance.com/fapi/v1/premiumIndex', { timeout: 6000 });
        if (Array.isArray(res.data)) {
            const map = new Map();
            for (const item of res.data) {
                if (item.symbol.endsWith('USDT')) {
                    map.set(item.symbol, {
                        fundingRate: parseFloat(item.lastFundingRate || 0.0001)
                    });
                }
            }
            return map;
        }
    } catch (e) {
        console.error("Error fetching Binance Futures Data:", e.message);
    }
    return new Map();
}

async function fetchBybitUniverse() {
    try {
        const res = await axios.get('https://api.bybit.com/v5/market/tickers?category=linear', { timeout: 6000 });
        if (res.data && res.data.result && Array.isArray(res.data.result.list)) {
            const map = new Map();
            for (const item of res.data.result.list) {
                if (item.symbol.endsWith('USDT')) {
                    map.set(item.symbol, {
                        bybitPrice: parseFloat(item.lastPrice),
                        turnover24h: parseFloat(item.turnover24h || 0),
                        openInterest: parseFloat(item.openInterest || 0),
                        bybitFunding: parseFloat(item.fundingRate || 0)
                    });
                }
            }
            return map;
        }
    } catch (e) {
        console.error("Error fetching Bybit Derivatives:", e.message);
    }
    return new Map();
}

async function fetchCandles5m(symbol, limit = 20) {
    try {
        const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=5m&limit=${limit}`;
        const res = await axios.get(url, { timeout: 4000 });
        if (Array.isArray(res.data)) {
            return res.data.map(k => ({
                close: parseFloat(k[4]),
                volume: parseFloat(k[5])
            }));
        }
    } catch (e) {}
    return null;
}

// ==========================================
// MODULAR PUMP & FLOW DETECTOR STRATEGIES
// ==========================================
function strategyLiquidityFilter(binanceSpot) {
    return binanceSpot && binanceSpot.quoteVolume >= MIN_24H_VOLUME_USD;
}

function strategyEarlyStageFilter(binanceSpot) {
    return binanceSpot.priceChangePercent >= 1.0 && binanceSpot.priceChangePercent <= 4.5;
}

function strategyVolumeIgnition(candles5m) {
    if (!candles5m || candles5m.length < 10) return { ignited: false, ratio: 1.0 };
    const recentVols = candles5m.slice(-10).map(c => c.volume);
    const avgVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
    const currentVol = candles5m[candles5m.length - 1].volume;
    const ratio = parseFloat((currentVol / (avgVol || 1)).toFixed(2));
    
    return {
        ignited: ratio >= 2.5,
        ratio: ratio
    };
}

function strategyCrowdTrap(binanceFutures) {
    if (!binanceFutures) return { isTrap: false, rate: 0.0001 };
    return {
        isTrap: binanceFutures.fundingRate <= 0.00005,
        rate: binanceFutures.fundingRate
    };
}

function strategyCrossExchangeConfirmation(bybitData) {
    if (!bybitData) return { confirmed: false };
    return {
        confirmed: bybitData.turnover24h > 5000000,
        openInterest: bybitData.openInterest
    };
}

// ==========================================
// POSITION MANAGEMENT (SILENT IF NO TRADES)
// ==========================================
async function manageActivePumps(binanceSpotMap, activePumps, history) {
    const pumpKeys = Object.keys(activePumps);
    
    // Silent mode: If no active trades, do NOT send any messages!
    if (pumpKeys.length === 0) {
        return activePumps;
    }

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const nowUtc = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

    let vipCards = [];
    let logCards = [];
    let updatedActivePumps = { ...activePumps };
    let hasChanges = false;

    for (const symbol of pumpKeys) {
        const trade = activePumps[symbol];
        const spot = binanceSpotMap.get(symbol);
        if (!spot) continue;

        const currentPrice = spot.lastPrice;
        let pnlPercent = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;

        // Auto Breakeven at +2.0%
        if (pnlPercent >= 2.0 && !trade.isRiskFree) {
            trade.isRiskFree = true;
            hasChanges = true;
        }

        const pnlFormatted = (pnlPercent >= 0 ? '+' : '') + pnlPercent.toFixed(2) + '%';
        const pnlIcon = pnlPercent >= 0 ? '🟢' : '🔴';

        const tpPrice = (trade.entryPrice * 1.050).toFixed(4); // +5.0% TP
        const slPrice = trade.isRiskFree ? trade.entryPrice.toFixed(4) : (trade.entryPrice * 0.975).toFixed(4); // -2.5% SL

        let actionBanner = trade.isRiskFree ? "🛡 [HOLD - RISK-FREE ACTIVE]" : "⏳ [HOLD POSITION]";
        let isClosed = false;
        let closeReason = "";

        if (pnlPercent >= 5.0) {
            actionBanner = "💰 [PUMP TARGET HIT (TP)]";
            isClosed = true;
            closeReason = "Take Profit (+5%)";
        } else if (trade.isRiskFree && pnlPercent <= 0.0) {
            actionBanner = "🛡 [CLOSED AT BREAKEVEN]";
            isClosed = true;
            closeReason = "Breakeven Stop";
        } else if (!trade.isRiskFree && pnlPercent <= -2.5) {
            actionBanner = "🛑 [STOP LOSS HIT]";
            isClosed = true;
            closeReason = "Stop Loss (-2.5%)";
        }

        let vipCard = `🪙 <b>#${symbol.replace('USDT', '')} [PUMP LONG]</b> ➔ <b>${actionBanner}</b>\n` +
            `• Price: <code>$${trade.entryPrice}</code> ➔ <code>$${currentPrice}</code> (<b>${pnlFormatted}</b> ${pnlIcon})`;
        if (!isClosed) {
            vipCard += `\n• Target (TP): <code>$${tpPrice}</code> | Stop (SL): <code>$${slPrice}</code> ${trade.isRiskFree ? '🛡' : ''}`;
        }
        vipCards.push(vipCard);

        let logCard = `🪙 <b>#${symbol.replace('USDT', '')}</b> | <b>${pnlFormatted}</b> ${pnlIcon}\n` +
            `• Entry: <code>$${trade.entryPrice}</code> | Now: <code>$${currentPrice}</code>\n` +
            `• TP: <code>$${tpPrice}</code> | SL: <code>$${slPrice}</code>\n` +
            `👉 Decision: <b>${actionBanner}</b>`;
        logCards.push(logCard);

        if (isClosed) {
            history.push({
                symbol: symbol,
                type: 'BUY',
                entryPrice: trade.entryPrice,
                exitPrice: currentPrice,
                pnlPercent: parseFloat(pnlPercent.toFixed(2)),
                openTime: trade.openTime,
                closeTime: now.toISOString(),
                reason: closeReason
            });
            delete updatedActivePumps[symbol];
            hasChanges = true;
        }
    }

    const remainingActiveCount = Object.keys(updatedActivePumps).length;
    const closedToday = history.filter(t => t.closeTime && t.closeTime.startsWith(todayStr));
    const winsToday = closedToday.filter(t => t.pnlPercent > 0).length;
    const lossesToday = closedToday.length - winsToday;
    const netDailyPnL = closedToday.reduce((acc, t) => acc + (t.pnlPercent || 0), 0);
    const netDailyFormatted = (netDailyPnL >= 0 ? '+' : '') + netDailyPnL.toFixed(2) + '%';
    const closedSummary = `${closedToday.length} (${winsToday}W - ${lossesToday}L) ${netDailyFormatted}`;

    const vipReport = `💼 <b>Active Pumps:</b> ${remainingActiveCount} | 🏁 <b>Closed Today:</b> ${closedSummary}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        vipCards.join('\n─────────────────────\n') +
        `\n\n━━━━━━━━━━━━━━━━━━━━\n` +
        `⏱ <code>${nowUtc}</code>`;

    const logReport = `💼 <b>Active Pumps:</b> ${remainingActiveCount} | 🏁 <b>Closed Today:</b> ${closedSummary}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        logCards.join('\n────────────────────\n') +
        `\n\n━━━━━━━━━━━━━━━━━━━━\n` +
        `⏱ <code>${nowUtc}</code>`;

    await sendTelegram(TELEGRAM_CHAT_VIPI, vipReport);
    await sendTelegram(TELEGRAM_CHAT_LOG, logReport);

    if (hasChanges) {
        saveStateAndSync(updatedActivePumps, history);
    }

    return updatedActivePumps;
}

// ==========================================
// DAILY MIDNIGHT PERFORMANCE AUDIT (00:00 UTC)
// ==========================================
async function checkDailyPerformanceReport(history) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const currentHour = now.getUTCHours();

    const auditState = loadJson(AUDIT_STATE_FILE, { lastReportDate: "" });

    if (currentHour === 0 && auditState.lastReportDate !== today) {
        const closedToday = history.filter(t => t.closeTime && t.closeTime.startsWith(today));
        
        if (closedToday.length === 0) {
            auditState.lastReportDate = today;
            fs.writeFileSync(AUDIT_STATE_FILE, JSON.stringify(auditState, null, 2), 'utf8');
            return;
        }

        const wins = closedToday.filter(t => t.pnlPercent > 0);
        const losses = closedToday.filter(t => t.pnlPercent <= 0);
        const winRate = ((wins.length / closedToday.length) * 100).toFixed(1);
        const grossProfit = wins.reduce((acc, t) => acc + t.pnlPercent, 0);
        const grossLoss = losses.reduce((acc, t) => acc + t.pnlPercent, 0);
        const netPnL = (grossProfit + grossLoss).toFixed(2);

        let breakdownLines = closedToday.map(t => {
            const icon = t.pnlPercent > 0 ? "✅" : "❌";
            const targetIcon = t.pnlPercent > 0 ? "🎯" : "🛑";
            return `${icon} #${t.symbol.replace('USDT', '')} ➔ ${t.pnlPercent > 0 ? '+' : ''}${t.pnlPercent}% ${targetIcon} (${t.reason})`;
        });

        const dailyMsg = `🏆 <b>DAILY PUMP PERFORMANCE REPORT</b>\n` +
            `📅 Date: ${today} | UTC Close\n\n` +
            `📈 <b>CORE PERFORMANCE:</b>\n` +
            `• Total Trades: <b>${closedToday.length}</b>\n` +
            `• Win / Loss: <b>${wins.length}W - ${losses.length}L</b>\n` +
            `• Win Rate: <b>${winRate}% 🎯</b>\n` +
            `• Gross Profit: <b>+${grossProfit.toFixed(2)}%</b>\n` +
            `• Gross Loss: <b>${grossLoss.toFixed(2)}%</b>\n` +
            `🔥 <b>TOTAL NET PnL: ${netPnL >= 0 ? '+' : ''}${netPnL}% 🚀</b>\n` +
            `─────────────────────\n` +
            `📋 <b>CLOSED TRADES:</b>\n` +
            breakdownLines.join('\n') +
            `\n\n💡 <i>Cross-Exchange liquidity hunting guarantees early pump entry!</i>`;

        await sendTelegram(TELEGRAM_CHAT_VIPI, dailyMsg);
        await sendTelegram(TELEGRAM_CHAT_LOG, dailyMsg);

        auditState.lastReportDate = today;
        fs.writeFileSync(AUDIT_STATE_FILE, JSON.stringify(auditState, null, 2), 'utf8');
    }
}

// ==========================================
// MASTER MARKET-WIDE PUMP SCANNER
// ==========================================
async function executePumpScannerCycle() {
    try {
        let activePumps = loadJson(ACTIVE_PUMPS_FILE, {});
        let history = loadJson(HISTORY_FILE, []);

        // 1. Fetch complete market snapshots in parallel (~1.5s)
        const [binanceSpotMap, binanceFuturesMap, bybitMap] = await Promise.all([
            fetchBinanceSpotUniverse(),
            fetchBinanceFuturesUniverse(),
            fetchBybitUniverse()
        ]);

        if (binanceSpotMap.size === 0) return;

        // 2. Manage ongoing open positions (Silent if 0 positions)
        activePumps = await manageActivePumps(binanceSpotMap, activePumps, history) || activePumps;

        // 3. Daily Audit Check
        await checkDailyPerformanceReport(history);

        // 4. Filter Potential Ignition Candidates across the ENTIRE market
        const candidates = [];
        for (const [symbol, spot] of binanceSpotMap.entries()) {
            if (activePumps[symbol]) continue;
            if (!strategyLiquidityFilter(spot)) continue;
            if (!strategyEarlyStageFilter(spot)) continue;

            candidates.push(spot);
        }

        // Limit to top 15 candidates to avoid rate limits
        const topCandidates = candidates.slice(0, 15);

        for (const candidate of topCandidates) {
            const symbol = candidate.symbol;

            const candles5m = await fetchCandles5m(symbol, 15);
            if (!candles5m) continue;

            const volumeCheck = strategyVolumeIgnition(candles5m);
            if (!volumeCheck.ignited) continue;

            const futuresData = binanceFuturesMap.get(symbol);
            const trapCheck = strategyCrowdTrap(futuresData);

            const bybitData = bybitMap.get(symbol);
            const bybitCheck = strategyCrossExchangeConfirmation(bybitData);

            // Signal Trigger
            const now = new Date();
            const nowUtc = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

            const entryPrice = candidate.lastPrice;
            const tpPrice = (entryPrice * 1.050).toFixed(4); // +5.0%
            const slPrice = (entryPrice * 0.975).toFixed(4); // -2.5%
            const fundingFormatted = (trapCheck.rate * 100).toFixed(4) + '%';

            // VIP Clean Signal Alert
            const vipAlert = `⚡️ <b>🟢 PUMP IGNITION ➔ BUY (LONG)</b>\n\n` +
                `Coin: <b>#${symbol.replace('USDT', '')}</b>\n` +
                `Entry Price: <code>$${entryPrice}</code>\n\n` +
                `Target (TP): <code>$${tpPrice}</code> (+5.0%)\n` +
                `Stop Loss (SL): <code>$${slPrice}</code> (-2.5%)\n` +
                `Leverage: <b>3x - 5x</b>\n` +
                `Ignition Volume: <b>${volumeCheck.ratio}x Surge</b>\n\n` +
                `⏱ <code>${nowUtc}</code>`;

            // Admin Detailed Cross-Exchange Telemetry Alert
            const logAlert = `<b>🟢 [CROSS-EXCHANGE PUMP IGNITION]</b>\n` +
                `#${symbol.replace('USDT', '')} @ <code>$${entryPrice}</code>\n\n` +
                `1️⃣ Binance Volume: <code>${volumeCheck.ratio}x</code> Surge\n` +
                `2️⃣ Binance Funding: <code>${fundingFormatted}</code> ${trapCheck.isTrap ? '🔴 (Short Trap)' : ''}\n` +
                `3️⃣ Bybit Derivatives: ${bybitCheck.confirmed ? '🟢 Confirmed Deep Volume' : '🟡 Neutral'}\n\n` +
                `⏱ <code>${nowUtc}</code>`;

            await sendTelegram(TELEGRAM_CHAT_VIPI, vipAlert);
            await sendTelegram(TELEGRAM_CHAT_LOG, logAlert);

            activePumps[symbol] = {
                symbol: symbol,
                entryPrice: entryPrice,
                openTime: now.toISOString(),
                timestamp: now.getTime(),
                isRiskFree: false
            };

            saveStateAndSync(activePumps, history);
        }

    } catch (error) {
        console.error("Cycle execution error:", error.message);
    }
}

// ==========================================
// 6-HOUR ENGINE LOOP (72 CYCLES x 5 MINUTES)
// ==========================================
async function startPumpRadarEngine() {
    console.log("Starting 6-Hour Cross-Exchange Pump Radar Engine (5-Minute Cycles)...");

    // 72 cycles x 5 minutes = 360 minutes (Exactly 6 Hours)
    for (let cycle = 1; cycle <= 72; cycle++) {
        console.log(`\n--- Radar Cycle ${cycle} of 72 ---`);
        await executePumpScannerCycle();

        if (cycle < 72) {
            console.log("Waiting 5 minutes for next market sweep...");
            await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
        }
    }

    console.log("6-Hour continuous block completed successfully. Exiting for next workflow run.");
    process.exit(0);
}

startPumpRadarEngine();
