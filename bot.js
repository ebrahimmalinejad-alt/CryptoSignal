const axios = require('axios');
const fs = require('fs');
const { execSync } = require('child_process');

const TELEGRAM_BOT_TOKEN = "8952382896:AAGeV0YYvFF4exWp3hax0JnqSxtECRP-IsI";
const TELEGRAM_CHAT_LOG = "-1004340657482";   // Admin / Technical Channel
const TELEGRAM_CHAT_VIPI = "-1003909320436";  // VIP / Client Channel

const WATCHLIST_FILE = './watchlist.json';
const ACTIVE_TRADES_FILE = './active_trades.json';
const HISTORY_FILE = './trade_history.json';
const AUDIT_STATE_FILE = './daily_audit_lock.json';

function pullLatestChanges() {
    try {
        execSync('git config --global user.name "github-actions[bot]"');
        execSync('git config --global user.email "github-actions[bot]@users.noreply.github.com"');
        execSync('git pull --rebase origin main || true');
    } catch (e) {
        // Fallback for isolated runs
    }
}

function loadJson(file, fallback) {
    try {
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
    } catch (e) {
        console.error(`Error loading ${file}:`, e.message);
    }
    return fallback;
}

function saveStateAndSync(activeTrades, history) {
    try {
        fs.writeFileSync(ACTIVE_TRADES_FILE, JSON.stringify(activeTrades, null, 2), 'utf8');
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');

        pullLatestChanges();
        execSync(`git add ${ACTIVE_TRADES_FILE} ${HISTORY_FILE}`);
        execSync('git commit -m "Auto-sync trades & history [skip ci]" || true');
        execSync('git push origin main || true');
        console.log("State and history instantly synced to repository.");
    } catch (e) {
        console.error("Git Push Failure:", e.message);
    }
}

function getZoneInfo(rsi) {
    if (rsi >= 70) return { name: "Red", level: 5 };
    if (rsi >= 60) return { name: "Pink", level: 4 };
    if (rsi >= 40) return { name: "Grey", level: 3 };
    if (rsi >= 30) return { name: "Light Green", level: 2 };
    return { name: "Deep Green", level: 1 };
}

function calculateRSI(closes, period = 14) {
    if (!closes || closes.length <= period) return null;
    let gains = 0, losses = 0;

    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) {
            avgGain = (avgGain * (period - 1) + diff) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) - diff) / period;
        }
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return parseFloat((100 - (100 / (1 + rs))).toFixed(2));
}

async function getCandles(symbol, interval, limit = 50) {
    try {
        const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const res = await axios.get(url, { 
            timeout: 6000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (Array.isArray(res.data)) {
            return res.data.map(k => ({
                close: parseFloat(k[4]),
                volume: parseFloat(k[5])
            }));
        }
        return null;
    } catch (e) {
        return null;
    }
}

async function getFundingRate(symbol) {
    try {
        const url = `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`;
        const res = await axios.get(url, { timeout: 3500 });
        if (res.data && res.data.lastFundingRate) {
            return parseFloat(res.data.lastFundingRate);
        }
    } catch (e) {
        // Fallback
    }
    return 0.0001;
}

async function sendTelegramMessage(chatId, text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML'
        });
        console.log(`Alert delivered to chat: ${chatId}`);
    } catch (err) {
        console.error(`Telegram Message Error (${chatId}):`, err.response ? err.response.data : err.message);
    }
}

async function processSymbol(symbol) {
    const [candles1h, candles5m, fundingRate] = await Promise.all([
        getCandles(symbol, '1h'),
        getCandles(symbol, '5m'),
        getFundingRate(symbol)
    ]);

    if (!candles1h || !candles5m || candles1h.length < 20 || candles5m.length < 20) {
        return null;
    }

    const closes1h = candles1h.map(c => c.close);
    const closes5m = candles5m.map(c => c.close);

    const currRsi1h = calculateRSI(closes1h);
    const prevRsi1h = calculateRSI(closes1h.slice(0, -1));

    const currRsi5m = calculateRSI(closes5m);
    const prevRsi5m = calculateRSI(closes5m.slice(0, -1));

    if (currRsi1h === null || prevRsi1h === null || currRsi5m === null || prevRsi5m === null) {
        return null;
    }

    const recentVolumes = candles5m.slice(-15).map(c => c.volume);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    const currentVolume = candles5m[candles5m.length - 1].volume;
    const volumeRatio = parseFloat((currentVolume / (avgVolume || 1)).toFixed(2));

    const currentPrice = closes5m[closes5m.length - 1];

    return {
        symbol,
        currentPrice,
        currRsi1h,
        prevRsi1h,
        currRsi5m,
        prevRsi5m,
        fundingRate,
        volumeRatio
    };
}

function evaluatePillars(trade, coinData) {
    const { currRsi1h, currRsi5m, fundingRate, volumeRatio } = coinData;
    const isLong = trade.type === 'BUY';

    let p1Status = "🟢 [HEALTHY]";
    let p1Desc = isLong ? "Momentum in favor of Long bias." : "Bearish momentum prevailing.";
    if (isLong && currRsi5m < 45) {
        p1Status = "🟡 [MOMENTUM WARNING]";
        p1Desc = "Short-term momentum weakening.";
    } else if (!isLong && currRsi5m > 55) {
        p1Status = "🟡 [MOMENTUM WARNING]";
        p1Desc = "Short-term buyer pressure detected.";
    }

    let p2Status = "🟢 [INTACT]";
    let p2Desc = isLong ? "Short sellers trapped by funding." : "Long buyers paying high funding.";
    if (isLong && fundingRate > 0.0003) {
        p2Status = "🔴 [TRAP INVALIDATED]";
        p2Desc = "Funding flipped positive against Longs.";
    } else if (!isLong && fundingRate < -0.0001) {
        p2Status = "🔴 [TRAP INVALIDATED]";
        p2Desc = "Funding turned negative against Shorts.";
    }

    let p3Status = "🟢 [FAVORABLE]";
    let p3Desc = "Volume matches current market movement.";
    if (volumeRatio < 0.7) {
        p3Status = "🟡 [EXHAUSTION RISK]";
        p3Desc = "Volume fading, momentum resting.";
    } else if (volumeRatio > 1.8) {
        p3Status = "🟢 [HIGH SURGE]";
        p3Desc = "Strong volume expansion recorded.";
    }

    let rationale = isLong 
        ? "Key structural pillars remain supportive." 
        : "Downside setup intact without counter volume breakout.";
    let riskPoint = isLong 
        ? "Watch 5M RSI breaking below 40.0." 
        : "Watch 1H RSI breaking above 60.0.";

    return { p1Status, p1Desc, p2Status, p2Desc, p3Status, p3Desc, rationale, riskPoint };
}

// 1. Guaranteed 10-Minute Trade Status Report (With Breakeven & Risk Counters)
async function sendTenMinuteReport(validCoins, activeTrades, history, avgRsi1h, avgRsi5m) {
    const tradeKeys = Object.keys(activeTrades);
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const nowUtc = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

    const closedToday = history.filter(t => t.closeTime && t.closeTime.startsWith(todayStr));
    const winsToday = closedToday.filter(t => t.pnlPercent > 0).length;
    const lossesToday = closedToday.length - winsToday;
    const closedSummary = `${closedToday.length} (${winsToday}W - ${lossesToday}L)`;

    if (tradeKeys.length === 0) {
        const idleMessage = `🛰 <b>INSTITUTIONAL TELEMETRY | 10M PULSE</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `💼 <b>Active Positions:</b> 0 | 🏁 <b>Closed Today:</b> ${closedSummary}\n` +
            `🌐 <b>Market Climate:</b> 1H RSI [<code>${avgRsi1h}</code>] | 5M RSI [<code>${avgRsi5m}</code>]\n` +
            `• <b>Status:</b> Scanning watchlist for institutional setups...\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `⏱ <code>${nowUtc}</code>`;

        await sendTelegramMessage(TELEGRAM_CHAT_LOG, idleMessage);
        return;
    }

    let vipCards = [];
    let logCards = [];
    let totalFloatingPnL = 0;
    let updatedActiveTrades = { ...activeTrades };
    let hasChanges = false;

    for (const key of tradeKeys) {
        const trade = activeTrades[key];
        const coinData = validCoins.find(c => c.symbol === trade.symbol);
        if (!coinData) continue;

        const { currentPrice, currRsi1h, currRsi5m, fundingRate, volumeRatio } = coinData;

        let pnlPercent = trade.type === 'BUY'
            ? ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100
            : ((trade.entryPrice - currentPrice) / trade.entryPrice) * 100;

        totalFloatingPnL += pnlPercent;

        // Auto Breakeven Trigger (+2.0% profit)
        if (pnlPercent >= 2.0 && !trade.isRiskFree) {
            trade.isRiskFree = true;
            hasChanges = true;
        }

        const pnlFormatted = (pnlPercent >= 0 ? '+' : '') + pnlPercent.toFixed(2) + '%';
        const pnlIcon = pnlPercent >= 0 ? '🟢' : '🔴';

        const tpPrice = trade.type === 'BUY' 
            ? (trade.entryPrice * 1.035).toFixed(4) 
            : (trade.entryPrice * 0.965).toFixed(4);

        // SL updates to Entry if Risk-Free is triggered
        const slPrice = trade.isRiskFree 
            ? trade.entryPrice.toFixed(4) 
            : (trade.type === 'BUY' ? (trade.entryPrice * 0.975).toFixed(4) : (trade.entryPrice * 1.025).toFixed(4));

        let actionBanner = trade.isRiskFree 
            ? "🛡 [HOLD - RISK-FREE ACTIVE]" 
            : "⏳ [HOLD POSITION]";
        let isClosed = false;
        let closeReason = "";

        if (trade.type === 'BUY') {
            if (currRsi5m >= 70 || currRsi1h >= 70) {
                actionBanner = "💰 [TAKE PROFIT HIT]";
                isClosed = true;
                closeReason = "Take Profit";
            } else if (trade.isRiskFree && pnlPercent <= 0.0) {
                actionBanner = "🛡 [CLOSED AT BREAKEVEN / ZERO RISK]";
                isClosed = true;
                closeReason = "Breakeven Stop";
            } else if (!trade.isRiskFree && (pnlPercent <= -2.5 || currRsi5m <= 30)) {
                actionBanner = "🛑 [STOP LOSS TRIGGERED]";
                isClosed = true;
                closeReason = "Stop Loss";
            }
        } else { // SELL
            if (currRsi5m <= 30 || currRsi1h <= 30) {
                actionBanner = "💰 [TAKE PROFIT HIT]";
                isClosed = true;
                closeReason = "Take Profit";
            } else if (trade.isRiskFree && pnlPercent <= 0.0) {
                actionBanner = "🛡 [CLOSED AT BREAKEVEN / ZERO RISK]";
                isClosed = true;
                closeReason = "Breakeven Stop";
            } else if (!trade.isRiskFree && (pnlPercent <= -2.5 || currRsi5m >= 70)) {
                actionBanner = "🛑 [STOP LOSS TRIGGERED]";
                isClosed = true;
                closeReason = "Stop Loss";
            }
        }

        // VIP Client Message Card
        const vipCard = `🪙 <b>#${trade.symbol.replace('USDT', '')} [${trade.type} / ${trade.type === 'BUY' ? 'LONG' : 'SHORT'}]</b>\n` +
            `• Price: <code>$${trade.entryPrice}</code> ➔ <code>$${currentPrice}</code> (<b>${pnlFormatted}</b> ${pnlIcon})\n` +
            `• Target (TP): <code>$${tpPrice}</code> | Stop (SL): <code>$${slPrice}</code> ${trade.isRiskFree ? '🛡' : ''}\n` +
            `👉 ACTION ➔ <b>${actionBanner}</b>`;
        vipCards.push(vipCard);

        // Admin Detailed 3-Pillars Diagnostic Card
        const pillars = evaluatePillars(trade, coinData);
        const fundingPercent = (fundingRate * 100).toFixed(4) + '%';

        const logCard = `🪙 <b>#${trade.symbol.replace('USDT', '')} [${trade.type} / ${trade.type === 'BUY' ? 'LONG' : 'SHORT'}]</b>\n` +
            `• Price: <code>$${trade.entryPrice}</code> ➔ <code>$${currentPrice}</code> (<b>${pnlFormatted}</b> ${pnlIcon})\n` +
            `• Levels: TP: <code>$${tpPrice}</code> | SL: <code>$${slPrice}</code> ${trade.isRiskFree ? '🛡 (Risk-Free)' : ''}\n\n` +
            `🔍 <b>3-PILLAR HEALTH MATRIX:</b>\n` +
            `1️⃣ <b>Location (RSI):</b> ${pillars.p1Status}\n` +
            `   ↳ 1H [<code>${currRsi1h}</code>] • 5M [<code>${currRsi5m}</code>] | ${pillars.p1Desc}\n` +
            `2️⃣ <b>Crowd Trap (Funding):</b> ${pillars.p2Status}\n` +
            `   ↳ Rate [<code>${fundingPercent}</code>] | ${pillars.p2Desc}\n` +
            `3️⃣ <b>Fuel (Volume):</b> ${pillars.p3Status}\n` +
            `   ↳ Ratio [<code>${volumeRatio}x</code>] | ${pillars.p3Desc}\n\n` +
            `🧠 <b>DECISION: <b>${actionBanner}</b></b>\n` +
            `• <b>Rationale:</b> ${pillars.rationale}\n` +
            `• <b>Risk Point:</b> ${pillars.riskPoint}`;
        logCards.push(logCard);

        if (isClosed) {
            history.push({
                symbol: trade.symbol,
                type: trade.type,
                entryPrice: trade.entryPrice,
                exitPrice: currentPrice,
                pnlPercent: parseFloat(pnlPercent.toFixed(2)),
                openTime: trade.openTime || new Date(trade.timestamp).toISOString(),
                closeTime: now.toISOString(),
                reason: closeReason
            });
            delete updatedActiveTrades[key];
            hasChanges = true;
        }
    }

    const netIcon = totalFloatingPnL >= 0 ? '🟢' : '🔴';
    const netFormatted = (totalFloatingPnL >= 0 ? '+' : '') + totalFloatingPnL.toFixed(2) + '%';

    const vipReport = `📊 <b>TRADE STATUS UPDATE (10M Check)</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💼 <b>Active Positions:</b> ${tradeKeys.length} | 🏁 <b>Closed Today:</b> ${closedSummary}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        vipCards.join('\n─────────────────────\n') +
        `\n\n━━━━━━━━━━━━━━━━━━━━\n` +
        `⏱ <code>${nowUtc}</code>`;

    const logReport = `🛰 <b>INSTITUTIONAL TELEMETRY | 10M PULSE</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💼 <b>Active Positions:</b> ${tradeKeys.length} | 🏁 <b>Closed Today:</b> ${closedSummary}\n` +
        `📈 <b>Floating PnL:</b> <code>${netFormatted}</code> ${netIcon}\n` +
        `🌐 <b>Market Mood:</b> 1H RSI [<code>${avgRsi1h}</code>] • 5M RSI [<code>${avgRsi5m}</code>]\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        logCards.join('\n────────────────────\n') +
        `\n\n━━━━━━━━━━━━━━━━━━━━\n` +
        `⏱ <code>${nowUtc}</code>`;

    await sendTelegramMessage(TELEGRAM_CHAT_VIPI, vipReport);
    await sendTelegramMessage(TELEGRAM_CHAT_LOG, logReport);

    if (hasChanges) {
        saveStateAndSync(updatedActiveTrades, history);
    }

    return updatedActiveTrades;
}

// 2. Comprehensive Daily Performance Report (UTC 00:00 Midnight)
async function checkDailyPerformanceReport(history) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const currentHour = now.getUTCHours();

    const auditState = loadJson(AUDIT_STATE_FILE, { lastReportDate: "" });

    if (currentHour === 0 && auditState.lastReportDate !== today) {
        const closedToday = history.filter(t => t.closeTime && t.closeTime.startsWith(today));
        
        if (closedToday.length === 0) {
            const emptyMessage = `🏆 <b>DAILY AUDIT & PERFORMANCE REPORT</b>\n` +
                `📅 Date: ${today} | UTC Close\n\n` +
                `• No positions were closed today.\n` +
                `• System status: Operational and scanning setups.\n\n` +
                `💡 <i>Strict institutional execution guarantees long-term edge!</i>`;

            await sendTelegramMessage(TELEGRAM_CHAT_VIPI, emptyMessage);
            await sendTelegramMessage(TELEGRAM_CHAT_LOG, emptyMessage);

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
            return `${icon} #${t.symbol.replace('USDT', '')} [${t.type}] ➔ ${t.pnlPercent > 0 ? '+' : ''}${t.pnlPercent}% ${targetIcon} (${t.reason})`;
        });

        const dailyMessage = `🏆 <b>DAILY AUDIT & PERFORMANCE REPORT</b>\n` +
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
            `\n\n💡 <i>Strict institutional execution guarantees long-term edge!</i>`;

        await sendTelegramMessage(TELEGRAM_CHAT_VIPI, dailyMessage);
        await sendTelegramMessage(TELEGRAM_CHAT_LOG, dailyMessage);

        auditState.lastReportDate = today;
        fs.writeFileSync(AUDIT_STATE_FILE, JSON.stringify(auditState, null, 2), 'utf8');
    }
}

// Master Execution Function
async function executeScan() {
    console.log("Executing 3-Pillar Institutional Market Scanner...");

    try {
        pullLatestChanges();

        const watchlist = loadJson(WATCHLIST_FILE, [
            'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 
            'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'SUIUSDT'
        ]);

        let activeTrades = loadJson(ACTIVE_TRADES_FILE, {});
        let history = loadJson(HISTORY_FILE, []);

        // Always monitor BTC for correlation safety guard
        const openSymbols = Object.keys(activeTrades);
        const combinedSymbols = Array.from(new Set([...watchlist, ...openSymbols, 'BTCUSDT']));

        const results = await Promise.all(combinedSymbols.map(sym => processSymbol(sym)));
        const validCoins = results.filter(r => r !== null);

        if (validCoins.length === 0) {
            console.error("Zero assets fetched. Check network endpoint.");
            return;
        }

        const btcCoin = validCoins.find(c => c.symbol === 'BTCUSDT');
        const avgRsi1h = parseFloat((validCoins.reduce((acc, c) => acc + c.currRsi1h, 0) / validCoins.length).toFixed(2));
        const avgRsi5m = parseFloat((validCoins.reduce((acc, c) => acc + c.currRsi5m, 0) / validCoins.length).toFixed(2));

        // 1. Send 10-Minute Telemetry Report
        activeTrades = await sendTenMinuteReport(validCoins, activeTrades, history, avgRsi1h, avgRsi5m) || activeTrades;

        // 2. Check Daily Midnight Audit
        await checkDailyPerformanceReport(history);

        // 3. Scan ONLY Watchlist coins for NEW setups
        for (const symbol of watchlist) {
            const coin = validCoins.find(c => c.symbol === symbol);
            if (!coin) continue;

            // Never duplicate open trade
            if (activeTrades[symbol]) {
                continue; 
            }

            const { currentPrice, currRsi1h, prevRsi1h, currRsi5m, fundingRate, volumeRatio } = coin;

            const prevZone1h = getZoneInfo(prevRsi1h);
            const currZone1h = getZoneInfo(currRsi1h);

            // Pillar 1: Location Shift
            const is1hShift = prevZone1h.name !== currZone1h.name;
            if (!is1hShift) continue;

            const isShiftUp = currZone1h.level > prevZone1h.level;

            // Pillar 2: Crowd Trap (Funding Rate)
            const isFundingBullish = fundingRate <= 0.00015;
            const isFundingBearish = fundingRate >= 0.00005;

            // Pillar 3: Fuel (Volume Surge)
            const hasFuel = volumeRatio >= 1.15;

            // Confluence
            let isInstitutionalBuy = isShiftUp && isFundingBullish && hasFuel && avgRsi1h >= 45 && currRsi5m <= 65;
            let isInstitutionalSell = !isShiftUp && isFundingBearish && hasFuel && avgRsi1h <= 65 && currRsi5m >= 35;

            // BTC Correlation Guard: Discard buys if BTC is dumping (5M RSI <= 38), discard sells if BTC is pumping (5M RSI >= 65)
            if (btcCoin && symbol !== 'BTCUSDT') {
                if (isInstitutionalBuy && btcCoin.currRsi5m <= 38) {
                    console.log(`[BTC Guard] Blocked BUY on ${symbol} due to BTC 5M dumping (${btcCoin.currRsi5m})`);
                    isInstitutionalBuy = false;
                }
                if (isInstitutionalSell && btcCoin.currRsi5m >= 65) {
                    console.log(`[BTC Guard] Blocked SELL on ${symbol} due to BTC 5M surging (${btcCoin.currRsi5m})`);
                    isInstitutionalSell = false;
                }
            }

            if (isInstitutionalBuy || isInstitutionalSell) {
                const signalType = isInstitutionalBuy ? "BUY" : "SELL";
                const now = new Date();
                const formattedDate = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
                const fundingPercent = (fundingRate * 100).toFixed(4) + '%';

                const tpPrice = isInstitutionalBuy 
                    ? (currentPrice * 1.035).toFixed(4) 
                    : (currentPrice * 0.965).toFixed(4);
                const slPrice = isInstitutionalBuy 
                    ? (currentPrice * 0.975).toFixed(4) 
                    : (currentPrice * 1.025).toFixed(4);

                const confluenceScore = (hasFuel && Math.abs(fundingRate) > 0.0001) ? "95%" : "92%";

                // VIP Message
                const vipMessage = `⚡️ <b>${isInstitutionalBuy ? '🟢 BUY SIGNAL (LONG)' : '🔴 SELL SIGNAL (SHORT)'}</b>\n\n` +
                    `🪙 Coin: <b>#${symbol.replace('USDT', '')}</b>\n` +
                    `💵 Entry Price: <code>$${currentPrice}</code>\n\n` +
                    `🎯 Target (TP): <code>$${tpPrice}</code> (+3.5%)\n` +
                    `🛑 Stop Loss (SL): <code>$${slPrice}</code> (-2.5%)\n` +
                    `⚡️ Leverage: <b>3x - 5x</b>\n` +
                    `⭐️ Confluence Score: <b>${confluenceScore}</b>\n\n` +
                    `⏱ <code>${formattedDate}</code>`;

                // Admin Message
                const logMessage = `⚡️ <b>INSTITUTIONAL ALPHA SIGNAL [${signalType}]</b>\n` +
                    `🪙 <b>#${symbol.replace('USDT', '')}</b> @ <code>$${currentPrice}</code>\n\n` +
                    `🎯 <b>THE 3 PILLARS CONFLUENCE:</b>\n` +
                    `1️⃣ <b>Location (RSI):</b> [${currZone1h.name}] ➔ 1H: <code>${currRsi1h}</code> | 5M: <code>${currRsi5m}</code>\n` +
                    `2️⃣ <b>Crowd Trap (Funding):</b> <code>${fundingPercent}</code> ${isInstitutionalBuy ? '🔴 (Short Trap)' : '🟢 (Long Trap)'}\n` +
                    `3️⃣ <b>Fuel (Volume Surge):</b> <code>${volumeRatio}x Avg</code> 🟢 (Whale Inflow)\n\n` +
                    `💡 <b>Setup:</b> ${isInstitutionalBuy ? 'Short Squeeze Imminent' : 'Long Liquidation Cascade'}\n` +
                    `⭐️ Confluence: <b>${confluenceScore} (3/3 Matched)</b>\n\n` +
                    `⏱ <code>${formattedDate}</code>`;

                await sendTelegramMessage(TELEGRAM_CHAT_VIPI, vipMessage);
                await sendTelegramMessage(TELEGRAM_CHAT_LOG, logMessage);

                activeTrades[symbol] = {
                    symbol: symbol,
                    type: signalType,
                    entryPrice: currentPrice,
                    openTime: now.toISOString(),
                    timestamp: now.getTime(),
                    isRiskFree: false
                };

                saveStateAndSync(activeTrades, history);
            }
        }

        console.log("3-Pillar Institutional scan finished cleanly.");
    } catch (error) {
        console.error("Execution Failure:", error.message);
    }
}

async function startContinuousLoop() {
    console.log("Starting 5-hour continuous live runner on GitHub...");
    
    // 30 cycles x 10 minutes = 300 minutes (Exactly 5 Hours)
    for (let cycle = 1; cycle <= 30; cycle++) {
        console.log(`\n--- Cycle ${cycle} of 30 ---`);
        await executeScan();
        
        if (cycle < 30) {
            console.log("Waiting exactly 10 minutes for next check...");
            await new Promise(resolve => setTimeout(resolve, 10 * 60 * 1000));
        }
    }
    
    console.log("5-hour block completed successfully.");
    process.exit(0);
}

startContinuousLoop();
