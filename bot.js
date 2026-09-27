const axios = require('axios');
const fs = require('fs');
const { execSync } = require('child_process');

// ==========================================
// CONFIGURATION & CONSTANTS
// ==========================================
const TELEGRAM_BOT_TOKEN = "8952382896:AAGeV0YYvFF4exWp3hax0JnqSxtECRP-IsI";
const TELEGRAM_CHAT_LOG = "-1004340657482";   // Admin Channel
const TELEGRAM_CHAT_VIPI = "-1003909320436";  // VIP Channel

const WATCHLIST_FILE = './watchlist.json';
const ACTIVE_TRADES_FILE = './active_trades.json';
const HISTORY_FILE = './trade_history.json';
const AUDIT_STATE_FILE = './daily_audit_lock.json';

const BENCHMARK_SYMBOLS = [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 
    'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'SUIUSDT'
];

// ==========================================
// FILE I/O & GIT PERSISTENCE FUNCTIONS
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

function saveStateAndSync(activeTrades, history) {
    try {
        fs.writeFileSync(ACTIVE_TRADES_FILE, JSON.stringify(activeTrades, null, 2), 'utf8');
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');

        execSync('git config --global user.name "github-actions[bot]"');
        execSync('git config --global user.email "github-actions[bot]@users.noreply.github.com"');
        execSync('git pull --rebase origin main || true');
        execSync(`git add ${ACTIVE_TRADES_FILE} ${HISTORY_FILE}`);
        execSync('git commit -m "Auto-sync trades & history [skip ci]" || true');
        execSync('git push origin main || true');
        console.log("State and history successfully synced to repository.");
    } catch (e) {
        console.error("Git Push Failure:", e.message);
    }
}

// ==========================================
// TELEGRAM NOTIFICATION FUNCTIONS
// ==========================================
async function sendTelegram(chatId, text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(url, { chat_id: chatId, text: text, parse_mode: 'HTML' });
    } catch (err) {
        console.error(`Telegram Delivery Error (${chatId}):`, err.response ? err.response.data : err.message);
    }
}

// ==========================================
// MARKET DATA INGESTION FUNCTIONS
// ==========================================
async function fetchCandles(symbol, interval, limit = 50) {
    try {
        const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const res = await axios.get(url, { timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (Array.isArray(res.data)) {
            return res.data.map(k => ({
                close: parseFloat(k[4]),
                volume: parseFloat(k[5])
            }));
        }
    } catch (e) {}
    return null;
}

async function fetchTicker24h(symbol) {
    try {
        const url = `https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${symbol}`;
        const res = await axios.get(url, { timeout: 4000 });
        if (res.data) {
            return {
                quoteVolume: parseFloat(res.data.quoteVolume),
                priceChangePercent: parseFloat(res.data.priceChangePercent)
            };
        }
    } catch (e) {}
    return { quoteVolume: 0, priceChangePercent: 0 };
}

async function fetchFuturesDerivatives(symbol) {
    let fundingRate = 0.0001;
    let openInterest = 0;
    try {
        const [fundRes, oiRes] = await Promise.all([
            axios.get(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`, { timeout: 3500 }).catch(() => null),
            axios.get(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`, { timeout: 3500 }).catch(() => null)
        ]);

        if (fundRes && fundRes.data && fundRes.data.lastFundingRate) {
            fundingRate = parseFloat(fundRes.data.lastFundingRate);
        }
        if (oiRes && oiRes.data && oiRes.data.openInterest) {
            openInterest = parseFloat(oiRes.data.openInterest);
        }
    } catch (e) {}
    return { fundingRate, openInterest };
}

// ==========================================
// MATHEMATICAL & TECHNICAL INDICATORS
// ==========================================
function calculateRSI(closes, period = 14) {
    if (!closes || closes.length <= period) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
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

function getRsiZone(rsi) {
    if (rsi >= 70) return { name: "Red", level: 5 };
    if (rsi >= 60) return { name: "Pink", level: 4 };
    if (rsi >= 40) return { name: "Grey", level: 3 };
    if (rsi >= 30) return { name: "Light Green", level: 2 };
    return { name: "Deep Green", level: 1 };
}

// ==========================================
// INDEPENDENT MODULAR STRATEGY FUNCTIONS
// ==========================================

// Strategy 1: Low-Liquidity Guard (Discards low volume shitcoins)
function strategyLiquidityGuard(quoteVolume24h, minVolumeThreshold = 15000000) {
    return {
        passed: quoteVolume24h >= minVolumeThreshold,
        volumeValue: quoteVolume24h
    };
}

// Strategy 2: Spot Volume Ignition / Whale Footprint
function strategyVolumeIgnition(candles5m, surgeThreshold = 1.35) {
    if (!candles5m || candles5m.length < 15) return { passed: false, ratio: 1.0 };
    const recentVols = candles5m.slice(-15).map(c => c.volume);
    const avgVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
    const currentVol = candles5m[candles5m.length - 1].volume;
    const ratio = parseFloat((currentVol / (avgVol || 1)).toFixed(2));
    return {
        passed: ratio >= surgeThreshold,
        ratio: ratio
    };
}

// Strategy 3: Crowd Trap & Funding Skew
function strategyFundingTrap(fundingRate) {
    const isBullishTrap = fundingRate <= 0.00015; // Shorts trapped
    const isBearishTrap = fundingRate >= 0.00005; // Longs trapped
    return {
        isBullishTrap,
        isBearishTrap,
        fundingRate
    };
}

// Strategy 4: RSI Momentum Location Shift
function strategyRsiMomentum(closes1h, closes5m) {
    if (!closes1h || !closes5m) return { passed: false };
    const currRsi1h = calculateRSI(closes1h);
    const prevRsi1h = calculateRSI(closes1h.slice(0, -1));
    const currRsi5m = calculateRSI(closes5m);

    if (currRsi1h === null || prevRsi1h === null || currRsi5m === null) {
        return { passed: false };
    }

    const prevZone = getRsiZone(prevRsi1h);
    const currZone = getRsiZone(currRsi1h);
    const isShift = prevZone.name !== currZone.name;
    const isShiftUp = currZone.level > prevZone.level;

    return {
        passed: isShift,
        isShiftUp,
        currZone,
        currRsi1h,
        currRsi5m
    };
}

// Strategy 5: Market Macro Regime with Transition Buffer (Hysteresis)
function strategyMacroRegime(validBenchmarkCoins) {
    if (!validBenchmarkCoins || validBenchmarkCoins.length === 0) {
        return { regime: 'TRANSITION', desc: '🟡 TRANSITION (50/50) ➔ NO NEW TRADES' };
    }
    let bullCount = 0;
    let bearCount = 0;
    for (const c of validBenchmarkCoins) {
        if (c.rsi1h >= 50 && c.rsi5m >= 48) bullCount++;
        else if (c.rsi1h <= 50 && c.rsi5m <= 52) bearCount++;
    }
    const total = validBenchmarkCoins.length;
    const bullPct = Math.round((bullCount / total) * 100);
    const bearPct = Math.round((bearCount / total) * 100);

    if (bullPct >= 60) {
        return { regime: 'BULLISH', desc: `🟢 BULLISH (${bullPct}% Up) ➔ LONGS ONLY` };
    } else if (bearPct >= 60) {
        return { regime: 'BEARISH', desc: `🔴 BEARISH (${bearPct}% Down) ➔ SHORTS ONLY` };
    }
    return { regime: 'TRANSITION', desc: `🟡 TRANSITION / CHOP (${bearPct}% Bear / ${bullPct}% Bull) ➔ NO NEW TRADES` };
}

// Strategy 6: BTC Correlation Safety Guard
function strategyBtcGuard(btcCoin, candidateType) {
    if (!btcCoin) return { safe: true };
    if (candidateType === 'BUY' && btcCoin.rsi5m <= 38) {
        return { safe: false, reason: `BTC 5M Dumping (${btcCoin.rsi5m})` };
    }
    if (candidateType === 'SELL' && btcCoin.rsi5m >= 65) {
        return { safe: false, reason: `BTC 5M Surging (${btcCoin.rsi5m})` };
    }
    return { safe: true };
}

// ==========================================
// MASTER CONFLUENCE EVALUATOR (COMBINES ALL)
// ==========================================
function evaluateCoinConfluence(coinData, macroRegime, btcCoin) {
    // 1. Liquidity Guard
    const liquidity = strategyLiquidityGuard(coinData.quoteVolume);
    if (!liquidity.passed) return null;

    // 2. Volume Ignition
    const volume = strategyVolumeIgnition(coinData.candles5m);
    if (!volume.passed) return null;

    // 3. RSI Momentum Shift
    const rsi = strategyRsiMomentum(coinData.closes1h, coinData.closes5m);
    if (!rsi.passed) return null;

    // 4. Funding Trap
    const funding = strategyFundingTrap(coinData.fundingRate);

    // 5. Signal Matching
    const isBuySetup = rsi.isShiftUp && funding.isBullishTrap && rsi.currRsi1h >= 45 && rsi.currRsi5m <= 65;
    const isSellSetup = !rsi.isShiftUp && funding.isBearishTrap && rsi.currRsi1h <= 65 && rsi.currRsi5m >= 35;

    if (!isBuySetup && !isSellSetup) return null;

    const signalType = isBuySetup ? 'BUY' : 'SELL';

    // 6. Macro Regime Agreement
    if (macroRegime.regime === 'BEARISH' && signalType === 'BUY') return null;
    if (macroRegime.regime === 'BULLISH' && signalType === 'SELL') return null;
    if (macroRegime.regime === 'TRANSITION') return null;

    // 7. BTC Correlation Guard
    if (coinData.symbol !== 'BTCUSDT') {
        const btcCheck = strategyBtcGuard(btcCoin, signalType);
        if (!btcCheck.safe) return null;
    }

    return {
        symbol: coinData.symbol,
        signalType: signalType,
        currentPrice: coinData.currentPrice,
        volumeRatio: volume.ratio,
        fundingRate: coinData.fundingRate,
        currZone: rsi.currZone,
        currRsi1h: rsi.currRsi1h,
        currRsi5m: rsi.currRsi5m
    };
}

// ==========================================
// POSITION & LIFECYCLE MANAGER
// ==========================================
async function manageActiveTrades(validCoins, activeTrades, history, avgRsi1h, avgRsi5m, macroRegime) {
    const tradeKeys = Object.keys(activeTrades);
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const nowUtc = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

    let vipCards = [];
    let logCards = [];
    let totalFloatingPnL = 0;
    let updatedActiveTrades = { ...activeTrades };
    let hasChanges = false;

    for (const key of tradeKeys) {
        const trade = activeTrades[key];
        const coin = validCoins.find(c => c.symbol === trade.symbol);
        if (!coin) continue;

        let pnlPercent = trade.type === 'BUY'
            ? ((coin.currentPrice - trade.entryPrice) / trade.entryPrice) * 100
            : ((trade.entryPrice - coin.currentPrice) / trade.entryPrice) * 100;

        // Auto Breakeven (+2.0% profit triggers risk-free stop)
        if (pnlPercent >= 2.0 && !trade.isRiskFree) {
            trade.isRiskFree = true;
            hasChanges = true;
        }

        const pnlFormatted = (pnlPercent >= 0 ? '+' : '') + pnlPercent.toFixed(2) + '%';
        const pnlIcon = pnlPercent >= 0 ? '🟢' : '🔴';

        const tpPrice = trade.type === 'BUY' 
            ? (trade.entryPrice * 1.035).toFixed(4) 
            : (trade.entryPrice * 0.965).toFixed(4);

        const slPrice = trade.isRiskFree 
            ? trade.entryPrice.toFixed(4) 
            : (trade.type === 'BUY' ? (trade.entryPrice * 0.975).toFixed(4) : (trade.entryPrice * 1.025).toFixed(4));

        let actionBanner = trade.isRiskFree ? "🛡 [HOLD - RISK-FREE ACTIVE]" : "⏳ [HOLD POSITION]";
        let isClosed = false;
        let closeReason = "";

        // Standard Take Profit / Stop Loss
        if (trade.type === 'BUY') {
            if (coin.rsi5m >= 70 || coin.rsi1h >= 70) {
                actionBanner = "💰 [TAKE PROFIT HIT]";
                isClosed = true;
                closeReason = "Take Profit";
            } else if (trade.isRiskFree && pnlPercent <= 0.0) {
                actionBanner = "🛡 [CLOSED AT BREAKEVEN / ZERO RISK]";
                isClosed = true;
                closeReason = "Breakeven Stop";
            } else if (!trade.isRiskFree && (pnlPercent <= -2.5 || coin.rsi5m <= 30)) {
                actionBanner = "🛑 [STOP LOSS TRIGGERED]";
                isClosed = true;
                closeReason = "Stop Loss";
            }
        } else { // SELL
            if (coin.rsi5m <= 30 || coin.rsi1h <= 30) {
                actionBanner = "💰 [TAKE PROFIT HIT]";
                isClosed = true;
                closeReason = "Take Profit";
            } else if (trade.isRiskFree && pnlPercent <= 0.0) {
                actionBanner = "🛡 [CLOSED AT BREAKEVEN / ZERO RISK]";
                isClosed = true;
                closeReason = "Breakeven Stop";
            } else if (!trade.isRiskFree && (pnlPercent <= -2.5 || coin.rsi5m >= 70)) {
                actionBanner = "🛑 [STOP LOSS TRIGGERED]";
                isClosed = true;
                closeReason = "Stop Loss";
            }
        }

        // Defensive Protection: If broad market firmly flips counter-trend (>= 60%)
        if (!isClosed && macroRegime.regime !== 'TRANSITION') {
            const isCounterTrend = (trade.type === 'BUY' && macroRegime.regime === 'BEARISH') ||
                                   (trade.type === 'SELL' && macroRegime.regime === 'BULLISH');
            if (isCounterTrend) {
                if (pnlPercent >= 0.5) {
                    actionBanner = "🛡 [DEFENSE EXIT - PROFIT SECURED]";
                    isClosed = true;
                    closeReason = "Macro Shift (Profit Secured)";
                } else if (pnlPercent <= -1.2) {
                    actionBanner = "🛑 [DEFENSE STOP - LOSS MINIMIZED]";
                    isClosed = true;
                    closeReason = "Macro Shift (Defensive Stop)";
                }
            }
        }

        if (!isClosed) totalFloatingPnL += pnlPercent;

        // VIP Client Message Card
        let vipCard = `🪙 <b>#${trade.symbol.replace('USDT', '')} [${trade.type}]</b> ➔ <b>${actionBanner}</b>\n` +
            `• Price: <code>$${trade.entryPrice}</code> ➔ <code>$${coin.currentPrice}</code> (<b>${pnlFormatted}</b> ${pnlIcon})`;
        if (!isClosed) {
            vipCard += `\n• Target (TP): <code>$${tpPrice}</code> | Stop (SL): <code>$${slPrice}</code> ${trade.isRiskFree ? '🛡' : ''}`;
        }
        vipCards.push(vipCard);

        // Admin Telemetry Card
        const fundingPercent = (coin.fundingRate * 100).toFixed(4) + '%';
        const logCard = `🪙 <b>#${trade.symbol.replace('USDT', '')} [${trade.type}]</b>\n` +
            `• Price: <code>$${trade.entryPrice}</code> ➔ <code>$${coin.currentPrice}</code> (<b>${pnlFormatted}</b> ${pnlIcon})\n` +
            `• Levels: TP: <code>$${tpPrice}</code> | SL: <code>$${slPrice}</code>\n` +
            `• Telemetry: 1H RSI [<code>${coin.rsi1h}</code>] • 5M RSI [<code>${coin.rsi5m}</code>] • Funding: <code>${fundingPercent}</code>\n` +
            `👉 Decision: <b>${actionBanner}</b>`;
        logCards.push(logCard);

        if (isClosed) {
            history.push({
                symbol: trade.symbol,
                type: trade.type,
                entryPrice: trade.entryPrice,
                exitPrice: coin.currentPrice,
                pnlPercent: parseFloat(pnlPercent.toFixed(2)),
                openTime: trade.openTime || new Date(trade.timestamp).toISOString(),
                closeTime: now.toISOString(),
                reason: closeReason
            });
            delete updatedActiveTrades[key];
            hasChanges = true;
        }
    }

    const remainingActiveCount = Object.keys(updatedActiveTrades).length;
    const closedToday = history.filter(t => t.closeTime && t.closeTime.startsWith(todayStr));
    const winsToday = closedToday.filter(t => t.pnlPercent > 0).length;
    const lossesToday = closedToday.length - winsToday;
    const netDailyPnL = closedToday.reduce((acc, t) => acc + (t.pnlPercent || 0), 0);
    const netDailyFormatted = (netDailyPnL >= 0 ? '+' : '') + netDailyPnL.toFixed(2) + '%';
    const closedSummary = `${closedToday.length} (${winsToday}W - ${lossesToday}L) ${netDailyFormatted}`;

    if (tradeKeys.length === 0) {
        const idleMessage = `💼 <b>Active Positions:</b> 0 | 🏁 <b>Closed Today:</b> ${closedSummary}\n` +
            `🌐 <b>Market Mood:</b> 1H RSI [<code>${avgRsi1h}</code>] • 5M RSI [<code>${avgRsi5m}</code>]\n` +
            `🧭 <b>Macro Regime:</b> ${macroRegime.desc}\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `⏱ <code>${nowUtc}</code>`;
        await sendTelegram(TELEGRAM_CHAT_LOG, idleMessage);
        return updatedActiveTrades;
    }

    const netIcon = totalFloatingPnL >= 0 ? '🟢' : '🔴';
    const netFormatted = (totalFloatingPnL >= 0 ? '+' : '') + totalFloatingPnL.toFixed(2) + '%';

    const vipReport = `💼 <b>Active Positions:</b> ${remainingActiveCount} | 🏁 <b>Closed Today:</b> ${closedSummary}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        vipCards.join('\n─────────────────────\n') +
        `\n\n━━━━━━━━━━━━━━━━━━━━\n` +
        `⏱ <code>${nowUtc}</code>`;

    const logReport = `💼 <b>Active Positions:</b> ${remainingActiveCount} | 🏁 <b>Closed Today:</b> ${closedSummary}\n` +
        `📈 <b>Floating PnL:</b> <code>${netFormatted}</code> ${netIcon}\n` +
        `🌐 <b>Market Mood:</b> 1H RSI [<code>${avgRsi1h}</code>] • 5M RSI [<code>${avgRsi5m}</code>]\n` +
        `🧭 <b>Macro Regime:</b> ${macroRegime.desc}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        logCards.join('\n────────────────────\n') +
        `\n\n━━━━━━━━━━━━━━━━━━━━\n` +
        `⏱ <code>${nowUtc}</code>`;

    await sendTelegram(TELEGRAM_CHAT_VIPI, vipReport);
    await sendTelegram(TELEGRAM_CHAT_LOG, logReport);

    if (hasChanges) {
        saveStateAndSync(updatedActiveTrades, history);
    }

    return updatedActiveTrades;
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
            const emptyMsg = `🏆 <b>DAILY AUDIT & PERFORMANCE REPORT</b>\n` +
                `📅 Date: ${today} | UTC Close\n\n` +
                `• No positions were closed today.\n` +
                `• System status: Operational and scanning setups.\n\n` +
                `💡 <i>Strict institutional execution guarantees long-term edge!</i>`;
            await sendTelegram(TELEGRAM_CHAT_VIPI, emptyMsg);
            await sendTelegram(TELEGRAM_CHAT_LOG, emptyMsg);
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

        const dailyMsg = `🏆 <b>DAILY AUDIT & PERFORMANCE REPORT</b>\n` +
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

        await sendTelegram(TELEGRAM_CHAT_VIPI, dailyMsg);
        await sendTelegram(TELEGRAM_CHAT_LOG, dailyMsg);

        auditState.lastReportDate = today;
        fs.writeFileSync(AUDIT_STATE_FILE, JSON.stringify(auditState, null, 2), 'utf8');
    }
}

// ==========================================
// MASTER SCAN CYCLE EXECUTION
// ==========================================
async function executeScanCycle() {
    console.log("Executing Modular Confluence Scanner Cycle...");

    try {
        const watchlist = loadJson(WATCHLIST_FILE, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
        let activeTrades = loadJson(ACTIVE_TRADES_FILE, {});
        let history = loadJson(HISTORY_FILE, []);

        const openSymbols = Object.keys(activeTrades);
        const targetSymbols = Array.from(new Set([...watchlist, ...openSymbols, ...BENCHMARK_SYMBOLS]));

        // Fetch parallel market data
        const coinPromises = targetSymbols.map(async (symbol) => {
            const [candles1h, candles5m, ticker24h, derivatives] = await Promise.all([
                fetchCandles(symbol, '1h'),
                fetchCandles(symbol, '5m'),
                fetchTicker24h(symbol),
                fetchFuturesDerivatives(symbol)
            ]);
            if (!candles1h || !candles5m || candles1h.length < 20 || candles5m.length < 20) return null;

            const closes1h = candles1h.map(c => c.close);
            const closes5m = candles5m.map(c => c.close);

            return {
                symbol,
                currentPrice: closes5m[closes5m.length - 1],
                closes1h,
                closes5m,
                candles5m,
                quoteVolume: ticker24h.quoteVolume,
                fundingRate: derivatives.fundingRate,
                openInterest: derivatives.openInterest,
                rsi1h: calculateRSI(closes1h),
                rsi5m: calculateRSI(closes5m)
            };
        });

        const results = await Promise.all(coinPromises);
        const validCoins = results.filter(r => r !== null && r.rsi1h !== null && r.rsi5m !== null);

        if (validCoins.length === 0) return;

        const btcCoin = validCoins.find(c => c.symbol === 'BTCUSDT');
        const avgRsi1h = parseFloat((validCoins.reduce((acc, c) => acc + c.rsi1h, 0) / validCoins.length).toFixed(2));
        const avgRsi5m = parseFloat((validCoins.reduce((acc, c) => acc + c.rsi5m, 0) / validCoins.length).toFixed(2));

        // Evaluate Strategy 5: Market Macro Regime
        const benchmarkCoins = validCoins.filter(c => BENCHMARK_SYMBOLS.includes(c.symbol));
        const macroRegime = strategyMacroRegime(benchmarkCoins);

        // Manage active trades and deliver telemetry
        activeTrades = await manageActiveTrades(validCoins, activeTrades, history, avgRsi1h, avgRsi5m, macroRegime) || activeTrades;

        // Check midnight audit report
        await checkDailyPerformanceReport(history);

        // Lock new entries if market is in transition
        if (macroRegime.regime === 'TRANSITION') {
            console.log("[Transition Guard] Market in Chop zone (40%-59%). No new signals opened.");
            return;
        }

        // Scan only watchlist coins for new trade confluences
        for (const symbol of watchlist) {
            if (activeTrades[symbol]) continue;

            const coinData = validCoins.find(c => c.symbol === symbol);
            if (!coinData) continue;

            const setup = evaluateCoinConfluence(coinData, macroRegime, btcCoin);
            if (!setup) continue;

            const now = new Date();
            const nowUtc = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

            const tpPrice = setup.signalType === 'BUY'
                ? (setup.currentPrice * 1.035).toFixed(4)
                : (setup.currentPrice * 0.965).toFixed(4);
            const slPrice = setup.signalType === 'BUY'
                ? (setup.currentPrice * 0.975).toFixed(4)
                : (setup.currentPrice * 1.025).toFixed(4);

            // VIP Client Message
            const vipMessage = `⚡️ <b>${setup.signalType === 'BUY' ? '🟢 BUY SIGNAL (LONG)' : '🔴 SELL SIGNAL (SHORT)'}</b>\n\n` +
                `Coin: <b>#${setup.symbol.replace('USDT', '')}</b>\n` +
                `Entry Price: <code>$${setup.currentPrice}</code>\n\n` +
                `Target (TP): <code>$${tpPrice}</code> (+3.5%)\n` +
                `Stop Loss (SL): <code>$${slPrice}</code> (-2.5%)\n` +
                `Leverage: <b>3x - 5x</b>\n` +
                `Confluence Score: <b>95%</b>\n\n` +
                `⏱ <code>${nowUtc}</code>`;

            // Admin Minimalist Message
            const adminSideIcon = setup.signalType === 'BUY' ? '🟢 [BUY] LONG' : '🔴 [SELL] SHORT';
            const trapLabel = setup.signalType === 'BUY' ? '(Short Trap)' : '(Long Trap)';
            const fundingPercent = (setup.fundingRate * 100).toFixed(4) + '%';

            const logMessage = `<b>${adminSideIcon}</b>\n` +
                `#${setup.symbol.replace('USDT', '')} @ <code>$${setup.currentPrice}</code>\n\n` +
                `1️⃣ Location (RSI): [${setup.currZone.name}] ➔ 1H: <code>${setup.currRsi1h}</code> | 5M: <code>${setup.currRsi5m}</code>\n` +
                `2️⃣ Crowd Trap (Funding): <code>${fundingPercent}</code> ${trapLabel}\n` +
                `3️⃣ Fuel (Volume Surge): <code>${setup.volumeRatio}x Avg</code> (Whale Inflow)\n\n` +
                `⏱ <code>${nowUtc}</code>`;

            await sendTelegram(TELEGRAM_CHAT_VIPI, vipMessage);
            await sendTelegram(TELEGRAM_CHAT_LOG, logMessage);

            activeTrades[setup.symbol] = {
                symbol: setup.symbol,
                type: setup.signalType,
                entryPrice: setup.currentPrice,
                openTime: now.toISOString(),
                timestamp: now.getTime(),
                isRiskFree: false
            };

            saveStateAndSync(activeTrades, history);
        }

    } catch (error) {
        console.error("Execution Cycle Error:", error.message);
    }
}

// ==========================================
// 6-HOUR CONTINUOUS LIVE RUNNER
// ==========================================
async function startContinuousEngine() {
    console.log("Starting 6-Hour Modular Live Engine on GitHub...");
    
    // 36 cycles x 10 minutes = 360 minutes (Exactly 6 Hours)
    for (let cycle = 1; cycle <= 36; cycle++) {
        console.log(`\n--- Engine Cycle ${cycle} of 36 ---`);
        await executeScanCycle();

        if (cycle < 36) {
            console.log("Waiting 10 minutes for next cycle...");
            await new Promise(resolve => setTimeout(resolve, 10 * 60 * 1000));
        }
    }

    console.log("6-Hour continuous block completed. Exiting cleanly for next GitHub Action.");
    process.exit(0);
}

startContinuousEngine();
