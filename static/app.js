/**
 * Stock Finder — Frontend Logic
 * 코스피/코스닥 종목 검색, 결과 표시, 캔들 패턴 분석 리포트
 */

// ── DOM Elements ──
const searchInput = document.getElementById('searchInput');
const suggestDropdown = document.getElementById('suggestDropdown');
const loadingSpinner = document.getElementById('loadingSpinner');
const errorMessage = document.getElementById('errorMessage');
const resultSection = document.getElementById('resultSection');

// ── State ──
let suggestItems = [];
let activeIndex = -1;
let debounceTimer = null;
let currentStock = null;   // { code, market, name }

// ── Recent Searches ──
const RECENT_KEY = 'stockfinder-recent';
const MAX_RECENT = 8;

function getRecentSearches() {
    try {
        return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
    } catch { return []; }
}

function saveRecentSearch(item) {
    let recents = getRecentSearches();
    // Remove duplicate
    recents = recents.filter(r => r.code !== item.code);
    // Add to front
    recents.unshift({ code: item.code, market: item.market, name: item.name });
    // Keep max
    if (recents.length > MAX_RECENT) recents = recents.slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recents));
    renderRecentSearches();
}

function clearRecentSearches() {
    localStorage.removeItem(RECENT_KEY);
    renderRecentSearches();
}

function renderRecentSearches() {
    const container = document.getElementById('recentSearches');
    const list = document.getElementById('recentList');
    const recents = getRecentSearches();

    if (recents.length === 0) {
        container.classList.add('hidden');
        return;
    }

    container.classList.remove('hidden');
    list.innerHTML = recents.map(r =>
        `<button class="recent-chip" data-code="${r.code}" data-market="${r.market}" data-name="${r.name}">
            ${r.name}
        </button>`
    ).join('');

    list.querySelectorAll('.recent-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const item = {
                code: chip.dataset.code,
                market: chip.dataset.market,
                name: chip.dataset.name,
            };
            searchInput.value = item.name;
            selectStock(item);
        });
    });
}

// ── Sidebar Pin/Unpin ──
const SIDEBAR_PIN_KEY = 'stockfinder-sidebar-pinned';

function isSidebarPinned() {
    return localStorage.getItem(SIDEBAR_PIN_KEY) !== 'false'; // default: pinned
}

function setSidebarPinned(pinned) {
    localStorage.setItem(SIDEBAR_PIN_KEY, pinned ? 'true' : 'false');
    applySidebarPinState();
}

function applySidebarPinState() {
    const appLayout = document.querySelector('.app-layout');
    const pinBtn = document.getElementById('sidebarPinBtn');
    const sidebar = document.getElementById('watchlistSidebar');
    const overlay = document.getElementById('sidebarOverlay');
    const pinned = isSidebarPinned();

    if (pinned) {
        appLayout.classList.add('sidebar-pinned');
        pinBtn.classList.add('pinned');
        pinBtn.title = '사이드바 고정 해제';
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
    } else {
        appLayout.classList.remove('sidebar-pinned');
        pinBtn.classList.remove('pinned');
        pinBtn.title = '사이드바 고정';
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
    }
}

function toggleSidebarOpen() {
    const sidebar = document.getElementById('watchlistSidebar');
    const overlay = document.getElementById('sidebarOverlay');
    const toggle = document.getElementById('sidebarToggle');
    const isOpen = sidebar.classList.contains('open');

    if (isOpen) {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
        toggle.style.display = '';
    } else {
        sidebar.classList.add('open');
        overlay.classList.add('active');
        toggle.style.display = 'none';
    }
}

function closeSidebar() {
    document.getElementById('watchlistSidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('active');
    document.getElementById('sidebarToggle').style.display = '';
}

// ── Watchlist (관심종목) ──
const WATCHLIST_KEY = 'stockfinder-watchlist';

function getWatchlist() {
    try {
        return JSON.parse(localStorage.getItem(WATCHLIST_KEY)) || [];
    } catch { return []; }
}

function saveWatchlist(list) {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
    renderWatchlist();
}

function addToWatchlist(item) {
    const list = getWatchlist();
    if (list.some(w => w.code === item.code)) return; // duplicate
    list.push({ code: item.code, market: item.market, name: item.name });
    saveWatchlist(list);
    updateWatchlistBtn();
}

function removeFromWatchlist(code) {
    const list = getWatchlist().filter(w => w.code !== code);
    saveWatchlist(list);
    updateWatchlistBtn();
}

function isInWatchlist(code) {
    return getWatchlist().some(w => w.code === code);
}

function renderWatchlist() {
    const container = document.getElementById('watchlistItems');
    const emptyMsg = document.getElementById('watchlistEmpty');
    const countEl = document.getElementById('watchlistCount');
    const list = getWatchlist();

    countEl.textContent = list.length;

    if (list.length === 0) {
        container.innerHTML = '';
        emptyMsg.style.display = 'flex';
        return;
    }

    emptyMsg.style.display = 'none';
    container.innerHTML = list.map(item => {
        const isActive = currentStock && currentStock.code === item.code;
        return `<div class="watchlist-item ${isActive ? 'active' : ''}" data-code="${item.code}" data-market="${item.market}" data-name="${item.name}">
            <div class="watchlist-item-info">
                <span class="watchlist-item-name">${item.name}
                    <span class="watchlist-item-market ${item.market.toLowerCase()}">${item.market}</span>
                </span>
                <span class="watchlist-item-code">${item.code}</span>
            </div>
            <button class="watchlist-item-remove" data-code="${item.code}" title="삭제">✕</button>
        </div>`;
    }).join('');

    // Click to search
    container.querySelectorAll('.watchlist-item').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.closest('.watchlist-item-remove')) return;
            const item = {
                code: el.dataset.code,
                market: el.dataset.market,
                name: el.dataset.name,
            };
            searchInput.value = item.name;
            selectStock(item);
            // Auto-close sidebar if unpinned
            if (!isSidebarPinned()) closeSidebar();
        });
    });

    // Remove button
    container.querySelectorAll('.watchlist-item-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeFromWatchlist(btn.dataset.code);
        });
    });
}

function updateWatchlistBtn() {
    const btn = document.getElementById('addWatchlistBtn');
    if (!currentStock) {
        btn.disabled = true;
        btn.classList.remove('added');
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> 추가`;
        btn.title = '종목을 먼저 검색하세요';
        return;
    }

    btn.disabled = false;
    if (isInWatchlist(currentStock.code)) {
        btn.classList.add('added');
        btn.innerHTML = `✓ 추가됨`;
        btn.title = '이미 관심종목에 추가됨';
    } else {
        btn.classList.remove('added');
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> 추가`;
        btn.title = '관심종목에 추가';
    }
}

// ── Utility: 숫자 포맷 ──
function formatNumber(num) {
    if (num == null) return '-';
    return num.toLocaleString('ko-KR');
}

function formatPrice(price) {
    if (price == null) return '-';
    return price.toLocaleString('ko-KR') + '원';
}

// ── Search Input Handler ──
searchInput.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    clearTimeout(debounceTimer);

    if (query.length < 1) {
        hideSuggestions();
        return;
    }

    debounceTimer = setTimeout(() => fetchSuggestions(query), 200);
});

searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        navigateSuggestion(1);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        navigateSuggestion(-1);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < suggestItems.length) {
            selectStock(suggestItems[activeIndex]);
        } else if (suggestItems.length > 0) {
            selectStock(suggestItems[0]);
        }
    } else if (e.key === 'Escape') {
        hideSuggestions();
    }
});

// 드롭다운 바깥 클릭 시 닫기
document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-section')) {
        hideSuggestions();
    }
});

// ── Suggestions API ──
async function fetchSuggestions(query) {
    try {
        const res = await fetch(`/api/suggest?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        suggestItems = data;
        activeIndex = -1;
        renderSuggestions(data, query);
    } catch (err) {
        console.error('Suggest error:', err);
    }
}

function renderSuggestions(items, query) {
    if (items.length === 0) {
        suggestDropdown.innerHTML = `
            <div class="suggest-item" style="justify-content: center; color: var(--text-muted); cursor: default;">
                검색 결과가 없습니다
            </div>
        `;
        suggestDropdown.classList.remove('hidden');
        return;
    }

    suggestDropdown.innerHTML = items.map((item, idx) => {
        const marketClass = item.market.toLowerCase();
        const highlightedName = highlightMatch(item.name, query);
        return `
            <div class="suggest-item ${idx === activeIndex ? 'active' : ''}"
                 data-index="${idx}"
                 onmouseenter="setActiveIndex(${idx})"
                 onclick="selectStockByIndex(${idx})">
                <span class="suggest-item-name">${highlightedName}</span>
                <span class="suggest-item-meta">
                    <span class="suggest-item-code">${item.code}</span>
                    <span class="suggest-item-market ${marketClass}">${item.market}</span>
                </span>
            </div>
        `;
    }).join('');

    suggestDropdown.classList.remove('hidden');
}

function highlightMatch(text, query) {
    if (!query) return text;
    const idx = text.toUpperCase().indexOf(query.toUpperCase());
    if (idx === -1) return text;
    return text.substring(0, idx) +
        `<strong style="color: var(--accent-cyan);">${text.substring(idx, idx + query.length)}</strong>` +
        text.substring(idx + query.length);
}

function hideSuggestions() {
    suggestDropdown.classList.add('hidden');
    suggestItems = [];
    activeIndex = -1;
}

function navigateSuggestion(direction) {
    if (suggestItems.length === 0) return;
    activeIndex = Math.max(-1, Math.min(suggestItems.length - 1, activeIndex + direction));
    updateActiveHighlight();
}

function updateActiveHighlight() {
    const items = suggestDropdown.querySelectorAll('.suggest-item');
    items.forEach((el, idx) => {
        el.classList.toggle('active', idx === activeIndex);
    });

    if (activeIndex >= 0 && items[activeIndex]) {
        items[activeIndex].scrollIntoView({ block: 'nearest' });
    }
}

// Global helpers (called from inline onclick)
window.setActiveIndex = (idx) => { activeIndex = idx; updateActiveHighlight(); };
window.selectStockByIndex = (idx) => { selectStock(suggestItems[idx]); };

// ── Select & Fetch Stock Detail ──
async function selectStock(item) {
    hideSuggestions();
    saveRecentSearch(item);
    searchInput.value = item.name;
    currentStock = item;

    // Update watchlist button & sidebar highlight
    updateWatchlistBtn();
    renderWatchlist();

    // Show loading
    resultSection.classList.add('hidden');
    errorMessage.classList.add('hidden');
    loadingSpinner.classList.remove('hidden');

    try {
        const url = `/api/stock?code=${item.code}&market=${item.market}&name=${encodeURIComponent(item.name)}`;
        const res = await fetch(url);
        const data = await res.json();

        loadingSpinner.classList.add('hidden');

        if (data.error) {
            showError(data.error);
            return;
        }

        renderResult(data);

        // Fetch analysis in parallel after basic data is shown
        fetchAnalysis(item);
    } catch (err) {
        loadingSpinner.classList.add('hidden');
        showError('데이터를 가져오는 중 오류가 발생했습니다: ' + err.message);
    }
}

function showError(msg) {
    errorMessage.textContent = msg;
    errorMessage.classList.remove('hidden');
}

// ── Render Result ──
function renderResult(data) {
    // --- Stock Header ---
    const marketBadge = document.getElementById('stockMarketBadge');
    marketBadge.textContent = data.market;
    marketBadge.className = `market-badge ${data.market.toLowerCase()}`;

    document.getElementById('stockName').textContent = data.name;
    document.getElementById('stockCode').textContent = data.code;
    document.getElementById('stockDate').textContent = `기준일: ${data.date}`;

    // Price
    const priceEl = document.getElementById('stockPrice');
    priceEl.textContent = formatPrice(data.price);

    const changeEl = document.getElementById('stockChange');
    const sign = data.change > 0 ? '+' : '';
    const arrow = data.change > 0 ? '▲' : data.change < 0 ? '▼' : '–';
    changeEl.textContent = `${arrow} ${formatNumber(Math.abs(data.change))}원 (${sign}${data.change_pct}%)`;

    // Color class
    const colorClass = data.change > 0 ? 'price-up' : data.change < 0 ? 'price-down' : 'price-neutral';
    priceEl.className = `current-price ${colorClass}`;
    changeEl.className = `price-change ${colorClass}`;

    // OHLV
    document.getElementById('stockOpen').textContent = formatNumber(data.open);
    document.getElementById('stockHigh').textContent = formatNumber(data.high);
    document.getElementById('stockLow').textContent = formatNumber(data.low);
    document.getElementById('stockVolume').textContent = formatNumber(data.volume);

    // --- Moving Averages ---
    const maItems = [
        { key: 'ma5', domValue: 'ma5Value', domDiff: 'ma5Diff', value: data.ma5 },
        { key: 'ma10', domValue: 'ma10Value', domDiff: 'ma10Diff', value: data.ma10 },
        { key: 'ma20', domValue: 'ma20Value', domDiff: 'ma20Diff', value: data.ma20 },
        { key: 'ma60', domValue: 'ma60Value', domDiff: 'ma60Diff', value: data.ma60 },
    ];

    maItems.forEach(ma => {
        const valueEl = document.getElementById(ma.domValue);
        const diffEl = document.getElementById(ma.domDiff);

        if (ma.value != null) {
            valueEl.textContent = formatPrice(ma.value);
            const diff = data.price - ma.value;
            const diffPct = ((diff / ma.value) * 100).toFixed(2);
            const diffSign = diff > 0 ? '+' : '';
            diffEl.textContent = `현재가 대비 ${diffSign}${formatNumber(diff)}원 (${diffSign}${diffPct}%)`;
            diffEl.className = `ma-diff ${diff > 0 ? 'up' : diff < 0 ? 'down' : 'neutral'}`;
        } else {
            valueEl.textContent = '데이터 없음';
            diffEl.textContent = '-';
            diffEl.className = 'ma-diff neutral';
        }
    });

    // --- Visual Bars ---
    renderVisualBars(data);

    // --- NXT After-hours ---
    renderNxtCard(data.nxt);

    // Show result
    resultSection.classList.remove('hidden');

    // Reset analysis section
    const analysisSection = document.getElementById('analysisSection');
    analysisSection.classList.add('hidden');
}

function renderNxtCard(nxt) {
    const card = document.getElementById('nxtCard');
    if (!nxt || !nxt.nxt_available) {
        card.classList.add('hidden');
        return;
    }

    card.classList.remove('hidden');

    // Status badge
    const statusEl = document.getElementById('nxtStatus');
    const isOpen = nxt.nxt_status === 'OPEN';
    statusEl.textContent = isOpen ? '거래중' : '마감';
    statusEl.className = `nxt-status ${isOpen ? 'open' : 'closed'}`;

    // Time
    const timeEl = document.getElementById('nxtTime');
    if (nxt.nxt_time) {
        try {
            const d = new Date(nxt.nxt_time);
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            timeEl.textContent = `${hh}:${mm} 기준`;
        } catch {
            timeEl.textContent = '';
        }
    }

    // Price
    const priceEl = document.getElementById('nxtPrice');
    priceEl.textContent = formatPrice(nxt.nxt_price);

    // Change
    const changeEl = document.getElementById('nxtChange');
    const ch = nxt.nxt_change;
    const sign = ch > 0 ? '+' : '';
    const arrow = ch > 0 ? '▲' : ch < 0 ? '▼' : '–';
    changeEl.textContent = `${arrow} ${formatNumber(Math.abs(ch))}원 (${sign}${nxt.nxt_change_pct}%)`;

    const colorClass = ch > 0 ? 'price-up' : ch < 0 ? 'price-down' : 'price-neutral';
    priceEl.className = `nxt-price ${colorClass}`;
    changeEl.className = `nxt-change ${colorClass}`;

    // Detail
    document.getElementById('nxtHigh').textContent = formatNumber(nxt.nxt_high);
    document.getElementById('nxtLow').textContent = formatNumber(nxt.nxt_low);
    document.getElementById('nxtVolume').textContent = formatNumber(nxt.nxt_volume);
}

function renderVisualBars(data) {
    const container = document.getElementById('maVisualBars');
    const bars = [
        { label: '5일선', value: data.ma5, cssClass: 'ma5' },
        { label: '10일선', value: data.ma10, cssClass: 'ma10' },
        { label: '20일선', value: data.ma20, cssClass: 'ma20' },
        { label: '60일선', value: data.ma60, cssClass: 'ma60' },
    ];

    const allValues = [data.price, ...bars.map(b => b.value)].filter(v => v != null);
    const minVal = Math.min(...allValues) * 0.95;
    const maxVal = Math.max(...allValues) * 1.05;
    const range = maxVal - minVal;

    const currentPricePct = ((data.price - minVal) / range) * 100;

    container.innerHTML = bars.map(bar => {
        if (bar.value == null) return '';

        const barPct = ((bar.value - minVal) / range) * 100;
        const diff = data.price - bar.value;
        const diffPct = ((diff / bar.value) * 100).toFixed(2);
        const diffSign = diff > 0 ? '+' : '';
        const diffClass = diff > 0 ? 'up' : diff < 0 ? 'down' : '';

        return `
            <div class="ma-bar-row">
                <span class="ma-bar-label">${bar.label}</span>
                <div class="ma-bar-track">
                    <div class="ma-bar-fill ${bar.cssClass}" style="width: ${barPct}%">
                        ${formatNumber(bar.value)}
                    </div>
                    <div class="ma-bar-current-price" style="left: ${currentPricePct}%"></div>
                </div>
                <span class="ma-bar-diff ${diffClass}">${diffSign}${diffPct}%</span>
            </div>
        `;
    }).join('');
}


// ═══════════════════════════════════════════════════
// AI 캔들 패턴 분석 리포트
// ═══════════════════════════════════════════════════

async function fetchAnalysis(item) {
    const analysisSection = document.getElementById('analysisSection');
    const analysisLoading = document.getElementById('analysisLoading');

    analysisSection.classList.remove('hidden');
    analysisLoading.classList.remove('hidden');
    document.getElementById('trendContainer').style.display = 'none';
    document.getElementById('patternsCard').classList.add('hidden');
    document.getElementById('candleChartCard').classList.add('hidden');
    document.getElementById('reportGrid').classList.add('hidden');

    try {
        const url = `/api/analysis?code=${item.code}&market=${item.market}&name=${encodeURIComponent(item.name)}`;
        const res = await fetch(url);
        const data = await res.json();

        analysisLoading.classList.add('hidden');

        if (data.error) {
            console.error('Analysis error:', data.error);
            return;
        }

        renderAnalysisReport(data);
    } catch (err) {
        analysisLoading.classList.add('hidden');
        console.error('Analysis fetch error:', err);
    }
}

function renderAnalysisReport(data) {
    _lastAnalysisData = data;
    // ── Trend Badge ──
    const trendContainer = document.getElementById('trendContainer');
    trendContainer.style.display = 'flex';

    const trendBadge = document.getElementById('trendBadge');
    const trendIcon = document.getElementById('trendIcon');
    const trendLabel = document.getElementById('trendLabel');
    const trendFill = document.getElementById('trendStrengthFill');
    const trendText = document.getElementById('trendStrengthText');

    const trendConfig = {
        bullish: { icon: '🔥', cls: 'trend-bullish', color: '#10b981' },
        bearish: { icon: '🧊', cls: 'trend-bearish', color: '#ef4444' },
        neutral: { icon: '⚖️', cls: 'trend-neutral', color: '#6b7280' },
    };

    const cfg = trendConfig[data.trend] || trendConfig.neutral;
    trendBadge.className = `trend-badge ${cfg.cls}`;
    trendIcon.textContent = cfg.icon;
    trendLabel.textContent = data.trend_label;
    trendFill.style.width = `${data.trend_strength}%`;
    trendFill.style.background = `linear-gradient(90deg, ${cfg.color}88, ${cfg.color})`;
    trendText.textContent = `추세 강도: ${data.trend_strength}%`;

    // ── Patterns List ──
    const patternsCard = document.getElementById('patternsCard');
    const patternsList = document.getElementById('patternsList');
    const noPatternsMsg = document.getElementById('noPatternsMsg');

    patternsCard.classList.remove('hidden');

    if (data.patterns.length === 0) {
        patternsList.innerHTML = '';
        noPatternsMsg.classList.remove('hidden');
    } else {
        noPatternsMsg.classList.add('hidden');
        patternsList.innerHTML = data.patterns.map(p => {
            const signalCls = p.signal === 'bullish' ? 'pattern-bullish' : 'pattern-bearish';
            const signalLabel = p.signal === 'bullish' ? '상승' : '하락';
            const confidencePct = Math.round(p.confidence * 100);
            const volumeTag = p.volume_surge ? '<span class="volume-surge-tag">📊 거래량↑</span>' : '';

            return `
                <div class="pattern-item ${signalCls}">
                    <div class="pattern-header">
                        <span class="pattern-name">${p.name}</span>
                        <div class="pattern-badges">
                            <span class="pattern-signal ${signalCls}">${signalLabel}</span>
                            ${volumeTag}
                        </div>
                    </div>
                    <div class="pattern-desc">${p.description}</div>
                    <div class="pattern-confidence">
                        <span class="confidence-label">신뢰도</span>
                        <div class="confidence-bar">
                            <div class="confidence-fill ${signalCls}" style="width: ${confidencePct}%"></div>
                        </div>
                        <span class="confidence-pct">${confidencePct}%</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    // ── Mini Candlestick Chart ──
    const candleChartCard = document.getElementById('candleChartCard');
    candleChartCard.classList.remove('hidden');
    renderCandleChart(data.recent_candles);

    // ── Buy/Sell Reports ──
    const reportGrid = document.getElementById('reportGrid');
    const hasBuyReport = renderBuyReport(data.buy_report);
    const hasSellReport = renderSellReport(data.sell_report);
    if (hasBuyReport || hasSellReport) {
        reportGrid.classList.remove('hidden');
    } else {
        reportGrid.classList.add('hidden');
    }
}

function renderCandleChart(candles) {
    const container = document.getElementById('candleChart');
    if (!candles || candles.length === 0) {
        container.innerHTML = '<div class="no-patterns">캔들 데이터 없음</div>';
        return;
    }

    // Collect all price points including MAs for proper scaling
    const allPrices = candles.flatMap(c => {
        const prices = [c.high, c.low];
        if (c.ma5 != null) prices.push(c.ma5);
        if (c.ma10 != null) prices.push(c.ma10);
        if (c.ma20 != null) prices.push(c.ma20);
        return prices;
    });
    const minP = Math.min(...allPrices);
    const maxP = Math.max(...allPrices);
    const range = maxP - minP || 1;
    const chartH = 200;
    const barW = Math.max(14, Math.min(40, (container.clientWidth - 40) / candles.length));
    const svgW = candles.length * barW + 20;

    const toY = (price) => chartH - ((price - minP) / range) * (chartH - 20) - 10;

    let html = `<svg width="100%" height="${chartH + 50}" viewBox="0 0 ${svgW} ${chartH + 50}">`;

    // ── Candle sticks ──
    candles.forEach((c, i) => {
        const x = i * barW + 10;
        const cx = x + barW / 2;
        const bodyTop = toY(Math.max(c.open, c.close));
        const bodyBot = toY(Math.min(c.open, c.close));
        const bodyH = Math.max(1, bodyBot - bodyTop);
        const wickTop = toY(c.high);
        const wickBot = toY(c.low);
        // 블루 = 양봉(꽉찬), 레드 = 음봉(꽉찬)
        const color = c.is_bullish ? '#3b82f6' : '#ef4444';
        const fill = color;

        // Wick
        html += `<line x1="${cx}" y1="${wickTop}" x2="${cx}" y2="${wickBot}" stroke="${color}" stroke-width="1.5"/>`;
        // Body
        html += `<rect x="${x + barW * 0.2}" y="${bodyTop}" width="${barW * 0.6}" height="${bodyH}"
                    fill="${fill}" stroke="${color}" stroke-width="1.5" rx="1"/>`;
        // Date label
        html += `<text x="${cx}" y="${chartH + 22}" text-anchor="middle" fill="var(--text-muted)"
                    font-size="9" font-family="Inter">${c.date}</text>`;
    });

    // ── Moving Average lines ──
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const maConfigs = [
        { key: 'ma5', color: isLight ? '#1e293b' : '#ffffff', label: '5일선' },
        { key: 'ma10', color: '#3b82f6', label: '10일선' },
        { key: 'ma20', color: '#f59e0b', label: '20일선' },
    ];

    maConfigs.forEach(ma => {
        const points = [];
        candles.forEach((c, i) => {
            if (c[ma.key] != null) {
                const cx = i * barW + 10 + barW / 2;
                const cy = toY(c[ma.key]);
                points.push(`${cx},${cy}`);
            }
        });
        if (points.length >= 2) {
            html += `<polyline points="${points.join(' ')}" 
                        fill="none" stroke="${ma.color}" stroke-width="1.5" 
                        stroke-linecap="round" stroke-linejoin="round" 
                        stroke-opacity="0.85"/>`;
        }
    });

    // ── MA Legend ──
    const legendY = chartH + 36;
    const legendStartX = 10;
    maConfigs.forEach((ma, idx) => {
        const lx = legendStartX + idx * 70;
        html += `<line x1="${lx}" y1="${legendY}" x2="${lx + 14}" y2="${legendY}" 
                    stroke="${ma.color}" stroke-width="2"/>`;
        html += `<text x="${lx + 18}" y="${legendY + 4}" fill="var(--text-muted)" 
                    font-size="9" font-family="Inter">${ma.label}</text>`;
    });

    html += '</svg>';
    container.innerHTML = html;
}

function renderBuyReport(report) {
    const card = document.getElementById('buyReport');
    if (!report) {
        card.classList.add('hidden');
        return false;
    }
    card.classList.remove('hidden');

    document.getElementById('buySignalBadge').textContent = `신호 ${report.signal_strength}%`;
    document.getElementById('buyPattern').textContent = `핵심 패턴: ${report.primary_pattern}`;
    document.getElementById('buyAggressive').textContent = formatPrice(report.aggressive_entry);
    document.getElementById('buyConservative').textContent = formatPrice(report.conservative_entry);
    document.getElementById('buyTarget').textContent = formatPrice(report.target_price);
    document.getElementById('buyStopLoss').textContent = formatPrice(report.stop_loss);
    document.getElementById('buyRiskReward').textContent = `리스크:리워드 = ${report.risk_reward}`;
    document.getElementById('buyVolume').textContent = report.volume_note;
    document.getElementById('buyTip').textContent = `💡 ${report.entry_tip}`;
    return true;
}

function renderSellReport(report) {
    const card = document.getElementById('sellReport');
    if (!report) {
        card.classList.add('hidden');
        return false;
    }
    card.classList.remove('hidden');

    document.getElementById('sellSignalBadge').textContent = `신호 ${report.signal_strength}%`;
    document.getElementById('sellPattern').textContent = `핵심 패턴: ${report.primary_pattern}`;
    document.getElementById('sellPrice').textContent = formatPrice(report.sell_price);
    document.getElementById('sellConservative').textContent = formatPrice(report.conservative_sell);
    document.getElementById('sellTarget').textContent = formatPrice(report.target_price);
    document.getElementById('sellStopLoss').textContent = formatPrice(report.stop_loss);
    document.getElementById('sellRiskReward').textContent = `리스크:리워드 = ${report.risk_reward}`;
    document.getElementById('sellVolume').textContent = report.volume_note;
    document.getElementById('sellTip').textContent = `💡 ${report.exit_tip}`;
    return true;
}

// ── Theme Toggle ──
function initTheme() {
    const saved = localStorage.getItem('stockfinder-theme');
    if (saved === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
    }
}

let _lastAnalysisData = null;

function toggleTheme() {
    const html = document.documentElement;
    const isLight = html.getAttribute('data-theme') === 'light';
    if (isLight) {
        html.removeAttribute('data-theme');
        localStorage.setItem('stockfinder-theme', 'dark');
    } else {
        html.setAttribute('data-theme', 'light');
        localStorage.setItem('stockfinder-theme', 'light');
    }
    // Re-render candle chart so MA5 color adapts
    if (_lastAnalysisData && _lastAnalysisData.recent_candles) {
        renderCandleChart(_lastAnalysisData.recent_candles);
    }
}

// ── Init on page load ──
initTheme();
window.addEventListener('DOMContentLoaded', () => {
    searchInput.focus();
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);
    renderRecentSearches();
    document.getElementById('clearRecent').addEventListener('click', clearRecentSearches);

    // Watchlist init
    renderWatchlist();
    updateWatchlistBtn();
    document.getElementById('addWatchlistBtn').addEventListener('click', () => {
        if (currentStock && !isInWatchlist(currentStock.code)) {
            addToWatchlist(currentStock);
        }
    });

    // Sidebar pin/toggle init
    applySidebarPinState();
    document.getElementById('sidebarPinBtn').addEventListener('click', () => {
        setSidebarPinned(!isSidebarPinned());
    });
    document.getElementById('sidebarToggle').addEventListener('click', toggleSidebarOpen);
    document.getElementById('sidebarOverlay').addEventListener('click', closeSidebar);
});
