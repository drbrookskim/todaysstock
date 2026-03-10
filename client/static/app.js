const API_BASE_URL = 'https://todaysstock.onrender.com';
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
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return unsafe;
    return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

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
        `<button class="recent-chip" data-code="${escapeHtml(r.code)}" data-market="${escapeHtml(r.market)}" data-name="${escapeHtml(r.name)}">
            ${escapeHtml(r.name)}
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
const SUPA_TOKEN_KEY = 'supa-access-token';
let authUser = null; // { logged_in: boolean, username: string }
let currentWatchlist = []; // 메모리 캐시 (로그인 유저용)

function getSupaToken() {
    return localStorage.getItem(SUPA_TOKEN_KEY);
}

function setSupaToken(token) {
    if (token) localStorage.setItem(SUPA_TOKEN_KEY, token);
}

function removeSupaToken() {
    localStorage.removeItem(SUPA_TOKEN_KEY);
}

function getAuthHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const token = getSupaToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
}

function getWatchlist() {
    if (authUser && authUser.logged_in) {
        return currentWatchlist;
    }
    try {
        return JSON.parse(localStorage.getItem(WATCHLIST_KEY)) || [];
    } catch { return []; }
}

function saveWatchlist(list) {
    if (authUser && authUser.logged_in) {
        currentWatchlist = list;
    } else {
        localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
    }
    renderWatchlist();
}

async function addToWatchlist(item) {
    const list = getWatchlist();
    if (list.some(w => w.code === item.code)) return; // duplicate

    // DB 동기화
    if (authUser && authUser.logged_in) {
        try {
            await fetch(API_BASE_URL + '/api/watchlist', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({ code: item.code, name: item.name, market: item.market })
            });
        } catch (e) { console.error('Watchlist sync error', e); }
    }

    list.push({ code: item.code, market: item.market, name: item.name });
    saveWatchlist(list);
    updateWatchlistBtn();
}

async function removeFromWatchlist(code) {
    if (authUser && authUser.logged_in) {
        try {
            await fetch(API_BASE_URL + '/api/watchlist', {
                method: 'DELETE',
                headers: getAuthHeaders(),
                body: JSON.stringify({ code: code })
            });
        } catch (e) { console.error('Watchlist sync error', e); }
    }

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
        return `<div class="watchlist-item ${isActive ? 'active' : ''}" data-code="${escapeHtml(item.code)}" data-market="${escapeHtml(item.market)}" data-name="${escapeHtml(item.name)}">
            <div class="watchlist-item-info">
                <span class="watchlist-item-name">${escapeHtml(item.name)}
                    <span class="watchlist-item-market ${escapeHtml(item.market).toLowerCase()}">${escapeHtml(item.market)}</span>
                </span>
                <span class="watchlist-item-code">${escapeHtml(item.code)}</span>
            </div>
            <button class="watchlist-item-remove" data-code="${escapeHtml(item.code)}" title="삭제">✕</button>
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
            // 모바일에서는 항상 닫기, 데스크탑에서는 고정 해제 시에만 닫기
            const isMobileView = window.innerWidth <= 768;
            if (isMobileView || !isSidebarPinned()) closeSidebar();
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
    if (typeof price === 'string') return price;
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
        const res = await fetch(API_BASE_URL + `/api/suggest?q=${encodeURIComponent(query)}`);
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
        const marketClass = escapeHtml(item.market).toLowerCase();
        const highlightedName = highlightMatch(escapeHtml(item.name), escapeHtml(query));
        return `
            <div class="suggest-item ${idx === activeIndex ? 'active' : ''}"
                 data-index="${idx}"
                 onmouseenter="setActiveIndex(${idx})"
                 onclick="selectStockByIndex(${idx})">
                <span class="suggest-item-name">${highlightedName}</span>
                <span class="suggest-item-meta">
                    <span class="suggest-item-code">${escapeHtml(item.code)}</span>
                    <span class="suggest-item-market ${marketClass}">${escapeHtml(item.market)}</span>
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
        const url = API_BASE_URL + `/api/stock?code=${item.code}&market=${item.market}&name=${encodeURIComponent(item.name)}`;
        const res = await fetch(url);

        // Guard: if the server returns an error page (HTML), res.json() would throw
        const contentType = res.headers.get('content-type') || '';
        if (!res.ok || !contentType.includes('application/json')) {
            loadingSpinner.classList.add('hidden');
            showError('서버 연결 오류가 발생했습니다. (서버 재시작 중일 수 있습니다. 잠시 후 다시 시도해주세요.)');
            return;
        }

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
        showError('데이터를 가져오는 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
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

    document.getElementById('stockIndustry').textContent = data.industry || '분류되지 않음';
    document.getElementById('stockSummary').innerHTML = data.company_summary || '기업 개요 정보가 제공되지 않았습니다.';

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
            <div class="ma-bar-row" style="animation: slideInRight 0.5s ease-out forwards; opacity: 0; animation-delay: ${0.1 * bar.cssClass.replace('ma', '')}s;">
                <span class="ma-bar-label">${bar.label}</span>
                <div class="ma-bar-track">
                    <div class="ma-bar-fill ${bar.cssClass}" style="width: 0%; transition: width 1s cubic-bezier(0.25, 0.8, 0.25, 1) 0.3s;" data-target-width="${barPct}">
                        ${formatNumber(bar.value)}
                    </div>
                    <div class="ma-bar-current-price" style="left: 0%; transition: left 1s cubic-bezier(0.25, 0.8, 0.25, 1) 0.5s;" data-target-left="${currentPricePct}"></div>
                </div>
                <span class="ma-bar-diff ${diffClass}">${diffSign}${diffPct}%</span>
            </div>
        `;
    }).join('');

    // Trigger reflow to apply CSS transitions safely
    // MA Bars will wait for observer
}

// ── Intersection Observer for Scroll Animations ──
const observeElement = (el, callback) => {
    const observer = new IntersectionObserver((entries, obs) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                callback(entry.target);
                obs.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1 });
    observer.observe(el);
};



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
        const url = API_BASE_URL + `/api/analysis?code=${item.code}&market=${item.market}&name=${encodeURIComponent(item.name)}`;
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
    trendFill.style.width = '0%';
    trendFill.style.background = `linear-gradient(90deg, ${cfg.color}88, ${cfg.color})`;
    trendFill.style.transition = 'width 1.2s cubic-bezier(0.25, 0.8, 0.25, 1) 0.1s';

    observeElement(trendFill, (el) => {
        el.style.width = `${data.trend_strength}%`;
    });

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
                            <div class="confidence-fill ${signalCls}" style="width: 0%; transition: width 1s cubic-bezier(0.25, 0.8, 0.25, 1) ${0.3 + (data.patterns.indexOf(p) * 0.2)}s;" data-target-width="${confidencePct}"></div>
                        </div>
                        <span class="confidence-pct">${confidencePct}%</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    observeElement(patternsCard, (el) => {
        el.querySelectorAll('.confidence-fill').forEach(fillEl => {
            fillEl.style.width = fillEl.getAttribute('data-target-width') + '%';
        });
    });

    // ── Mini Candlestick Chart ──
    const candleChartCard = document.getElementById('candleChartCard');
    candleChartCard.classList.remove('hidden');
    renderCandleChart(data.recent_candles);

    // ── Recent Week Analysis ──
    const recentWeekAnalysis = document.getElementById('recentWeekAnalysis');
    const recentWeekList = document.getElementById('recentWeekList');

    if (data.recent_week_analysis && data.recent_week_analysis.length > 0) {
        if (recentWeekAnalysis) recentWeekAnalysis.classList.remove('hidden');
        if (recentWeekList) {
            recentWeekList.innerHTML = '';
            data.recent_week_analysis.forEach(item => {
                const li = document.createElement('li');
                li.style.fontSize = "0.85rem";
                li.style.color = "var(--text-muted)";
                li.style.display = "flex";
                li.style.alignItems = "baseline";
                li.style.gap = "8px";

                let colorStr = "var(--text-muted)";
                if (item.desc.includes('양봉')) colorStr = "#ef4444";
                else if (item.desc.includes('음봉')) colorStr = "#3b82f6";

                li.innerHTML = `<span style="font-weight: 600; color: var(--text-color); font-size: 0.8rem; background: var(--hover-bg); padding: 2px 6px; border-radius: 4px; min-width: 45px; text-align: center;">${item.date}</span> <span style="color: ${colorStr}; line-height: 1.4;">${item.desc}</span>`;
                recentWeekList.appendChild(li);
            });
        }
    } else {
        if (recentWeekAnalysis) recentWeekAnalysis.classList.add('hidden');
    }

    // ── AI Insights: 확률점수 / ATR 목표가 / 거래량 이상 ──
    renderAiInsights(data);

    // ── Fundamental Analysis (async, 별도 API 호출) ──
    renderFundamentalReport(data.code || data.ticker || '');

    // ── Buy/Sell Reports ──
    const reportGrid = document.getElementById('reportGrid');
    const hasBuyReport = renderBuyReport(data.buy_report);
    const hasSellReport = renderSellReport(data.sell_report, data.atr_targets);
    if (hasBuyReport || hasSellReport) {
        if (reportGrid) reportGrid.classList.remove('hidden');
    } else {
        if (reportGrid) reportGrid.classList.add('hidden');
    }
}

// ══════════════════════════════════════════════════════════
// 🧠  Fundamental Analysis Panel
// ══════════════════════════════════════════════════════════
async function renderFundamentalReport(stockCode) {
    const card = document.getElementById('fundamentalCard');
    if (!card || !stockCode) return;

    // 스켈레톤 로딩 표시
    card.classList.remove('hidden');
    document.getElementById('fundSignalReason').textContent = '데이터 로딩 중…';
    document.getElementById('fundCompanyTypeBadge').textContent = '';
    document.getElementById('fundSignalBadge').textContent = '';
    document.getElementById('fundQuantContent').innerHTML = '<div class="fund-loading">분석 중…</div>';
    document.getElementById('fundEventContent').innerHTML = '<div class="fund-loading">공시 스캔 중…</div>';
    document.getElementById('fundMacroContent').innerHTML = '<div class="fund-loading">거시 조회 중…</div>';

    let d;
    try {
        const res = await fetch(API_BASE_URL + `/api/fundamental/${encodeURIComponent(stockCode)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (text.startsWith('<')) throw new Error('HTML response');
        d = JSON.parse(text);
        if (d.error) throw new Error(d.error);
    } catch (e) {
        console.warn('Fundamental API error:', e.message);
        document.getElementById('fundSignalReason').textContent = `❌ 펀더멘탈 데이터 로드 실패 (${e.message})`;
        return;
    }

    // ── 헤더 ──
    document.getElementById('fundCompanyTypeBadge').textContent = d.company_type_label || '';

    const sigBadge = document.getElementById('fundSignalBadge');
    sigBadge.textContent = d.signal_label || '';
    sigBadge.className = 'fund-signal-badge fund-signal-' + (d.signal || 'hold');

    document.getElementById('fundSignalReason').textContent = d.signal_reason || '';

    // ── Quant 축 ──
    const q = d.quant || {};
    const qRows = [
        ['ROE', q.roe != null ? q.roe + '%' : '—'],
        ['영업이익률', q.op_margin != null ? q.op_margin + '%' : '—'],
        ['매출성장(연)', q.rev_growth != null ? (q.rev_growth >= 0 ? '+' : '') + q.rev_growth + '%' : '—'],
        ['매출성장(분)', q.qtr_growth != null ? (q.qtr_growth >= 0 ? '+' : '') + q.qtr_growth + '%' : '—'],
        ['부채비율', q.debt_ratio != null ? q.debt_ratio + '%' : '—'],
    ];
    const scoreColor = q.score >= 75 ? '#10b981' : q.score >= 55 ? '#f59e0b' : '#ef4444';
    document.getElementById('fundQuantContent').innerHTML = `
        <div class="fund-score-wrap">
            <div class="fund-score-num" style="color:${scoreColor}">${q.score ?? '—'}</div>
            <div class="fund-score-grade" style="color:${scoreColor}">${q.grade ?? ''}</div>
            <div class="fund-score-label">/ 100</div>
        </div>
        <div class="fund-score-bar-bg">
            <div class="fund-score-bar" style="width:${Math.min(q.score ?? 0, 100)}%;background:${scoreColor}"></div>
        </div>
        <div class="fund-score-desc" style="font-size:0.81rem; color:var(--text-muted); text-align:center; margin-top:8px;">
            ${q.score >= 75 ? '🔥 <b>매우 우수 (상위 15%)</b> - 안정적이고 강력한 펀더멘탈' : q.score >= 55 ? '✅ <b>평균 이상 (상위 45%)</b> - 투자하기 무난한 양호한 재무 상태' : '⚠️ <b>기준 미달 (하위권)</b> - 재무 리스크가 있으므로 주의 필요'}
        </div>
        <table class="fund-metric-table">
            ${qRows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}
        </table>
        <div class="fund-period-note">${q.period || ''} ${q.qtr_period ? '/ ' + q.qtr_period : ''}</div>`;

    // ── Event-Driven 축 ──
    const evts = d.events || [];
    if (evts.length === 0) {
        document.getElementById('fundEventContent').innerHTML =
            '<div class="fund-no-data">최근 30일 주요 공시 없음</div>';
    } else {
        document.getElementById('fundEventContent').innerHTML =
            evts.map(ev => `
            <div class="fund-event-item fund-event-${ev.signal}">
                <span class="fund-event-label">${ev.label}</span>
                <span class="fund-event-date">${ev.date ? ev.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1.$2.$3') : ''}</span>
                <span class="fund-event-title" title="${ev.title}">${ev.title.length > 28 ? ev.title.slice(0, 28) + '…' : ev.title}</span>
            </div>`).join('');
    }

    // ── Macro 축 ──
    const m = d.macro || {};
    const macroItems = [];
    if (m.usd_krw) macroItems.push(['USD/KRW', `${m.usd_krw.toLocaleString()}`, m.usd_krw_chg != null ? (m.usd_krw_chg >= 0 ? '+' : '') + m.usd_krw_chg + '%' : null]);
    if (m.dxy) macroItems.push(['달러 인덱스', `${m.dxy}`, m.dxy_chg != null ? (m.dxy_chg >= 0 ? '+' : '') + m.dxy_chg + '%' : null]);
    if (m.us10y) macroItems.push(['미 국채 10년물(^TNX)', `${m.us10y}%`, m.us10y_chg != null ? (m.us10y_chg >= 0 ? '+' : '') + m.us10y_chg + 'p' : null]);
    if (m.nasdaq) macroItems.push(['나스닥 지수', `${m.nasdaq.toLocaleString()}`, m.nasdaq_chg != null ? (m.nasdaq_chg >= 0 ? '+' : '') + m.nasdaq_chg + '%' : null]);
    if (m.kospi) macroItems.push(['KOSPI', `${m.kospi.toLocaleString()}`, m.kospi_chg != null ? (m.kospi_chg >= 0 ? '+' : '') + m.kospi_chg + '%' : null]);
    if (m.kosdaq) macroItems.push(['KOSDAQ', `${m.kosdaq.toLocaleString()}`, m.kosdaq_chg != null ? (m.kosdaq_chg >= 0 ? '+' : '') + m.kosdaq_chg + '%' : null]);
    if (m.vix) macroItems.push(['VIX 공포지수', `${m.vix}`, m.vix_chg != null ? (m.vix_chg >= 0 ? '+' : '') + m.vix_chg + '%' : null]);
    if (m.wti) macroItems.push(['WTI 국제유가', `$${m.wti}`, m.wti_chg != null ? (m.wti_chg >= 0 ? '+' : '') + m.wti_chg + '%' : null]);
    if (m.base_rate) macroItems.push(['한국 기준금리', `${m.base_rate}%`, null]);
    if (m.semi_export_yoy != null) macroItems.push(['반도체수출YoY', `${m.semi_export_yoy >= 0 ? '+' : ''}${m.semi_export_yoy}%`, null]);

    if (macroItems.length === 0) {
        document.getElementById('fundMacroContent').innerHTML = '<div class="fund-no-data">데이터 로드 실패</div>';
    } else {
        document.getElementById('fundMacroContent').innerHTML =
            macroItems.map(([k, v, chg]) => {
                const chgHtml = chg ? `<span class="fund-macro-chg ${parseFloat(chg) >= 0 ? 'fund-pos' : 'fund-neg'}">${chg}</span>` : '';
                return `<div class="fund-macro-row"><span class="fund-macro-key">${k}</span><span class="fund-macro-val">${v}${chgHtml}</span></div>`;
            }).join('');
    }

    // ── 사용 축 태그 ──
    const axes = d.axes_used || [];
    document.getElementById('fundAxesUsed').innerHTML =
        axes.map(a => `<span class="fund-axis-tag">${a}</span>`).join('');

    // ── 토글 버튼 ──
    const toggleBtn = document.getElementById('fundToggleBtn');
    const fundBody = document.getElementById('fundBody');
    if (toggleBtn && !toggleBtn.dataset.bound) {
        toggleBtn.dataset.bound = '1';
        toggleBtn.addEventListener('click', () => {
            fundBody.classList.toggle('fund-collapsed');
            const collapsed = fundBody.classList.contains('fund-collapsed');
            toggleBtn.querySelector('i').className = collapsed ? 'ph ph-caret-down' : 'ph ph-caret-up';
        });
    }
}

function renderAiInsights(data) {
    const container = document.getElementById('aiInsightsCard');
    if (!container) return;

    const prob = data.trade_probability;
    const atr = data.atr_targets;
    const vol = data.volume_anomaly;

    if (!prob && !atr && !vol) {
        container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');

    // ── 1. 매수확률 게이지 ──
    let probHtml = '';
    if (prob) {
        const score = prob.score;
        const scoreColor = score >= 75 ? '#10b981'
            : score >= 60 ? '#34d399'
                : score >= 40 ? '#f59e0b'
                    : score >= 25 ? '#f97316'
                        : '#ef4444';
        const bd = prob.breakdown || {};
        const items = [
            { label: 'MA 배열', val: bd.ma_alignment ?? 0, max: 35 },
            { label: 'RSI', val: bd.rsi ?? 0, max: 25 },
            { label: 'MACD', val: bd.macd ?? 0, max: 25 },
            { label: '거래량', val: bd.volume ?? 0, max: 15 },
        ];
        const breakdownBars = items.map(it => {
            const pct = Math.round((it.val / it.max) * 100);
            return `<div class="ai-breakdown-row">
                <span class="ai-breakdown-label">${it.label}</span>
                <div class="ai-breakdown-track">
                    <div class="ai-breakdown-fill" style="width:${pct}%; background:${scoreColor};"></div>
                </div>
                <span class="ai-breakdown-val">${it.val}/${it.max}</span>
            </div>`;
        }).join('');

        const dashOffset = Math.round((1 - score / 100) * 251);
        probHtml = `
        <div class="ai-insight-widget">
            <div class="ai-widget-title">매수 확률 점수</div>
            <div class="ai-gauge-wrap">
                <svg class="ai-gauge-svg" viewBox="0 0 100 100" width="90" height="90">
                    <circle cx="50" cy="50" r="40" fill="none" stroke="var(--hover-bg)" stroke-width="10"/>
                    <circle cx="50" cy="50" r="40" fill="none" stroke="${scoreColor}" stroke-width="10"
                        stroke-dasharray="251" stroke-dashoffset="${dashOffset}"
                        stroke-linecap="round" transform="rotate(-90 50 50)"
                        style="transition: stroke-dashoffset 1.2s cubic-bezier(.25,.8,.25,1);"/>
                    <text x="50" y="46" text-anchor="middle" font-size="18" font-weight="700" fill="${scoreColor}">${score}</text>
                    <text x="50" y="60" text-anchor="middle" font-size="9" fill="var(--text-muted)">/ 100</text>
                </svg>
                <div class="ai-gauge-label" style="color:${scoreColor};">${prob.label}</div>
                <div class="ai-gauge-indicators">
                    <span class="ai-ind">RSI <strong>${prob.rsi}</strong></span>
                    <span class="ai-ind" style="color:${(prob.macd_golden ?? false) ? '#10b981' : '#ef4444'};">
                        MACD ${(prob.macd_golden ?? false) ? '골든↑' : '데드↓'}
                        <strong>${(prob.macd_hist ?? 0) >= 0 ? '+' : ''}${(prob.macd_hist ?? 0).toFixed(1)}</strong>
                    </span>
                </div>
            </div>
            <div class="ai-breakdown">${breakdownBars}</div>
            <div class="ai-widget-desc"><strong>💡 점수 해석:</strong> 100점 만점의 매수 매력도입니다. 주가의 방향성(MA, <strong>35%</strong>), 상승 탄력(RSI, <strong>25%</strong>), 추세 강도(MACD, <strong>25%</strong>), 돈의 흐름(거래량, <strong>15%</strong>) 비중으로 가중 합산됩니다. 추가로 상승 잉태형, 적삼병 등 긍정적 캔들 패턴 발견 시 보너스 점수가, 흑삼병 등 부정적 패턴 발견 시 감점(±5%)이 반영됩니다.</div>
        </div>`;
    }

    // ── 2. ATR 목표가/손절가 ──
    let atrHtml = '';
    if (atr) {
        const rrColor = (atr.rr_ratio ?? 0) >= 1.5 ? '#10b981' : '#f59e0b';
        atrHtml = `
        <div class="ai-insight-widget">
            <div class="ai-widget-title">ATR 목표가 / 손절가</div>
            <div class="ai-price-range">
                <div class="ai-price-row target">
                    <span class="ai-price-arrow">▲</span>
                    <div>
                        <span class="ai-price-label">목표가</span>
                        <span class="ai-price-val">${atr.target?.toLocaleString()}원</span>
                        <span class="ai-price-pct up">+${atr.gain_pct}%</span>
                    </div>
                </div>
                <div class="ai-price-row current">
                    <span class="ai-price-arrow neutral">●</span>
                    <div>
                        <span class="ai-price-label">현재가</span>
                        <span class="ai-price-val">${atr.current?.toLocaleString()}원</span>
                    </div>
                </div>
                <div class="ai-price-row stop">
                    <span class="ai-price-arrow down">▼</span>
                    <div>
                        <span class="ai-price-label">손절가</span>
                        <span class="ai-price-val">${atr.stop_loss?.toLocaleString()}원</span>
                        <span class="ai-price-pct down">-${atr.loss_pct}%</span>
                    </div>
                </div>
            </div>
            <div class="ai-rr-badge" style="color:${rrColor};">
                R:R &nbsp;<strong>1 : ${atr.rr_ratio}</strong>
                <span class="ai-atr-note">ATR ${atr.atr?.toLocaleString()}원 기준</span>
            </div>
            <div class="ai-widget-desc"><strong>💡 ATR 활용법:</strong> ATR은 최근 주가가 하루에 위아래로 평균 얼마씩 움직였는지를 보여주는 '변동성' 수치입니다. (이 종목의 현재 하루 평균 변동성은 <strong>${atr.atr?.toLocaleString()}원</strong>입니다). 이 절대적인 변동성을 바탕으로 "적어도 목표가는 변동성의 2배쯤 크게, 손절가는 1배쯤 짧게" 기계적으로 세팅하는 안전한 투자 방식입니다.</div>
        </div>`;
    }

    // ── 3. 이상 거래량 배지 ──
    let volHtml = '';
    if (vol) {
        // CSS 클래스 기반 — 라이트/다크 테마 자동 대응
        const levelClass = vol.level !== 'normal' ? `vol-${vol.level}` : '';
        const dirIcon = vol.direction === 'up' ? '🔴' : '🔵';
        volHtml = `
        <div class="ai-insight-widget">
            <div class="ai-widget-title">거래량 이상 감지</div>
            <div class="ai-vol-badge ${levelClass}">
                ${vol.label}
            </div>
            <div class="ai-vol-stats">
                <div class="ai-vol-stat">
                    <span class="ai-vol-stat-label">배율</span>
                    <span class="ai-vol-stat-val">${vol.ratio}×</span>
                </div>
                <div class="ai-vol-stat">
                    <span class="ai-vol-stat-label">Z-score</span>
                    <span class="ai-vol-stat-val">${vol.zscore}</span>
                </div>
                <div class="ai-vol-stat">
                    <span class="ai-vol-stat-label">방향</span>
                    <span class="ai-vol-stat-val">${dirIcon}</span>
                </div>
            </div>
            <div class="ai-vol-msg">${vol.message}</div>
            <div class="ai-widget-desc"><strong>💡 거래량 해석법:</strong> 최근 20일간의 평소 거래량과 비교해 오늘 얼마나 이례적으로 많은 거래가 터졌는지를(Z-score) 보여줍니다. 세력이나 큰 손의 개입을 뜻하며, 빨간 불(🔴)과 함께 거래량이 폭발했다면 매우 강력한 상승 신호일 확률이 높습니다.</div>
        </div>`;
    }

    // ── 4. 사이클 타임 예측 (펀더멘탈 내부 컨테이너로 렌더링) ──
    const cyc = data.cycle_estimation;
    const cycContainer = document.getElementById('cycleWidgetContainer');
    if (cyc && cycContainer) {
        const phaseColor = cyc.current_phase === '상승' ? '#10b981'
            : cyc.current_phase === '하락' ? '#ef4444' : '#f59e0b';
        const confLabel = cyc.confidence === 'high' ? '높음'
            : cyc.confidence === 'medium' ? '보통' : '낮음';
        const confColor = cyc.confidence === 'high' ? '#10b981'
            : cyc.confidence === 'medium' ? '#f59e0b' : '#ef4444';

        const dashOffset = Math.round((1 - cyc.progress / 100) * 251);

        // 보정 팩터 태그
        const adjTags = (cyc.adjustments || []).map(a =>
            `<span class="cyc-adj-tag">${a.factor} <strong>${a.effect}</strong></span>`
        ).join('');

        // 피보나치 시간대 마커
        const fibMarkers = (cyc.fib_time_zones || []).map(f => {
            const isPast = f.date && f.date <= new Date().toISOString().slice(0, 10);
            return `<span class="cyc-fib-marker ${isPast ? 'past' : ''}">${f.day}일${f.date ? ' (' + f.date.slice(5) + ')' : ''}</span>`;
        }).join('');

        // 사이클 이력
        const histRows = (cyc.cycle_history || []).map(h =>
            `<div class="cyc-hist-row">
                <span class="cyc-hist-date">${(h.peak_date || '').slice(5)}</span>
                <span class="cyc-hist-arrow">→</span>
                <span class="cyc-hist-date">${(h.next_peak_date || '').slice(5)}</span>
                <span class="cyc-hist-days">${h.days}일</span>
            </div>`
        ).join('');

        const cycHtml = `
        <div class="cyc-widget-inner">
            <div class="ai-widget-title" style="font-size: 1.1rem; margin-bottom: 16px;">사이클 타임 예측 (변곡점 타이밍)</div>
            <div class="cyc-phase-row">
                <span class="cyc-phase-badge" style="color:${phaseColor}; border-color:${phaseColor};">${cyc.current_phase}</span>
                <span class="cyc-conf" style="color:${confColor};">신뢰도: ${confLabel}</span>
                <span class="cyc-cycles">${cyc.cycles_detected}개 사이클 감지</span>
            </div>
            
            <div class="cyc-stats-grid">
                <div class="cyc-stat-card">
                    <div class="cyc-stat-label">진행률</div>
                    <div class="cyc-stat-value" style="color: ${phaseColor};">${cyc.progress}%</div>
                    <div class="cyc-progress-track">
                        <div class="cyc-progress-fill" style="width: ${cyc.progress}%; background: ${phaseColor};"></div>
                    </div>
                </div>
                <div class="cyc-stat-card">
                    <div class="cyc-stat-label">잔여 거래일</div>
                    <div class="cyc-stat-value-group">
                        <div class="cyc-stat-value">${cyc.est_remaining_days}<span class="cyc-stat-unit">일 남음</span></div>
                        <svg class="cyc-mini-donut" viewBox="0 0 36 36">
                            <path class="cyc-donut-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                            <path class="cyc-donut-fill" stroke="${phaseColor}" stroke-dasharray="${Math.min((cyc.days_since_peak / Math.max(cyc.avg_cycle_days, 1)) * 100, 100)}, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                        </svg>
                    </div>
                </div>
                <div class="cyc-stat-card">
                    <div class="cyc-stat-label">예상 도달일</div>
                    <div class="cyc-stat-value" style="font-size: 1.1rem;">${cyc.est_next_peak_date || '-'}</div>
                    <div class="cyc-timeline-graphic">
                        <div class="cyc-tl-dot start"></div>
                        <div class="cyc-tl-line"></div>
                        <div class="cyc-tl-dot end" style="background: ${phaseColor}; box-shadow: 0 0 4px ${phaseColor};"></div>
                    </div>
                </div>
                <div class="cyc-stat-card">
                    <div class="cyc-stat-label">사이클 통계</div>
                    <div class="cyc-stat-sub">평균 <strong>${cyc.avg_cycle_days}일</strong> · 경과 <strong>${cyc.days_since_peak}일</strong></div>
                    <div class="cyc-compare-bars">
                        <div class="cyc-bar-row">
                            <span class="cyc-bar-lbl">평균</span>
                            <div class="cyc-bar-track"><div class="cyc-bar-fill avg" style="width: 100%;"></div></div>
                        </div>
                        <div class="cyc-bar-row">
                            <span class="cyc-bar-lbl">경과</span>
                            <div class="cyc-bar-track"><div class="cyc-bar-fill cur" style="width: ${Math.min((cyc.days_since_peak / Math.max(cyc.avg_cycle_days, 1)) * 100, 100)}%; background: ${phaseColor};"></div></div>
                        </div>
                    </div>
                </div>
            </div>
            
            ${adjTags ? `<div class="cyc-adj-row" style="margin-top: 12px;">${adjTags}</div>` : ''}
            ${fibMarkers ? `<div class="cyc-fib-row" style="margin-top: 12px;"><span class="cyc-fib-label">피보나치 시간대</span> ${fibMarkers}</div>` : ''}
            ${histRows ? `<details class="cyc-hist-details" style="margin-top: 16px;"><summary class="cyc-hist-summary">과거 사이클 이력</summary><div class="cyc-hist-body">${histRows}</div></details>` : ''}
            
            <!-- 사이클 상세 설명 -->
            <div class="cyc-desc-box" style="display: flex; flex-direction: column; gap: 8px;">
                <div class="cyc-desc-item" style="background: rgba(16, 185, 129, 0.1); padding: 12px; border-radius: 8px; border-left: 4px solid #10b981; line-height: 1.6;">
                    <strong style="color: #10b981; display: inline-block; margin-bottom: 6px;">💡 현재 사이클 요약:</strong><br/>
                    현재 다음 변곡점(추세가 꺾이는 지점) 도달까지 <strong style="color: #10b981;">${cyc.progress}% 진행</strong>되었으며, 주식 시장이 열리는 날 기준으로 <strong style="color: #10b981;">약 ${cyc.est_remaining_days}일</strong> 정도 남은 것으로 추정됩니다. 과거 주기의 평균이 <strong>${cyc.avg_cycle_days}일</strong>이므로, 이 추세라면 다음 변곡점은 대략 <strong style="color: #10b981;">${cyc.est_next_peak_date ? cyc.est_next_peak_date : '조만간'}</strong>에 나타날 가능성이 높습니다.
                </div>
                <div class="cyc-desc-item" style="background: var(--bg-card-hover, rgba(255, 255, 255, 0.04)); padding: 12px; border-radius: 8px; border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));">
                    <strong>[진행률] 및 [잔여 거래일]:</strong> 과거 평균을 기준으로 다음 곡점(변곡점)이 오기까지 전체 주기 중 현재 몇 % 지점인지(진행률), 그리고 앞으로 주식 시장이 열리는 날 기준으로 며칠이 남았는지(잔여 거래일)를 알려주는 <strong>'타이밍'</strong> 지표입니다.
                </div>
                <div class="cyc-desc-item" style="background: var(--bg-card-hover, rgba(255, 255, 255, 0.04)); padding: 12px; border-radius: 8px; border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));">
                    <strong>[예상 도달일] 및 [사이클 통계]:</strong> 주말과 공휴일을 제외하고 계산된 실제 다음 변곡점의 캘린더 날짜(예상 도달일)입니다. '사이클 통계'의 평균은 과거 주기의 평균 일수, 경과는 최근 고점부터 지금까지 지난 일수입니다.
                </div>
                <div class="cyc-desc-item" style="background: var(--bg-card-hover, rgba(255, 255, 255, 0.04)); padding: 12px; border-radius: 8px; border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));">
                    <strong>사이클 감지 횟수 및 감지 강도:</strong> 과거 차트에서 주기적인 상승/하락 패턴이 몇 번이나 반복되었는지 보여주는 <strong>'감지 횟수'</strong>입니다. 이 횟수가 많을수록 데이터의 표본이 많다는 뜻입니다.
                </div>
                <div class="cyc-desc-item" style="background: var(--bg-card-hover, rgba(255, 255, 255, 0.04)); padding: 12px; border-radius: 8px; border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));">
                    <strong>[상승/하락] 및 [신뢰도]:</strong> 현재 주가가 고점을 향하고 있는지(상승), 저점을 향하고 있는지(하락)를 나타냅니다. <strong>'신뢰도(높음/보통/낮음)'</strong>는 과거 사이클의 기간 길이나 변동폭이 얼마나 일정했는지를 분석한 결과입니다. 예를 들어 <strong>'하락 신뢰도: 낮음'</strong>이라면 "현재 단기적으로 하락 사이클을 타고 있긴 하지만, 과거 패턴의 주기 편차가 심해서 도착 예정일의 오차가 클 수 있으니 주의하라"는 의미입니다.
                </div>
                <div class="cyc-desc-item" style="background: var(--bg-card-hover, rgba(255, 255, 255, 0.04)); padding: 12px; border-radius: 8px; border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));">
                    <strong>변수 보정 (피보나치, 저항선, 투자심리):</strong> 단순 일수 계산을 넘어, 황금비율(피보나치 타임존), 마디 가격(ex: 5만원, 10만원) 돌파 대기 시간, 그리고 거래량 폭주와 인간의 탐욕/공포(RSI)로 인한 속도 가속화 현상을 모두 자동 계산해 도달일을 정밀 예측합니다.
                </div>
            </div>
        </div>`;

        cycContainer.innerHTML = cycHtml;
        cycContainer.style.display = 'block';
    } else if (cycContainer) {
        cycContainer.style.display = 'none';
        cycContainer.innerHTML = '';
    }

    container.innerHTML = `<div class="ai-insights-grid">${probHtml}${atrHtml}${volHtml}</div>`;
}


function renderCandleChart(candles) {
    const container = document.getElementById('candleChart');
    if (!candles || candles.length === 0) {
        container.innerHTML = '<div class="no-patterns">캔들 데이터 없음</div>';
        return;
    }

    // 모바일 1개월, 데스크탑 3개월 차트 분기
    const isMobile = window.innerWidth <= 700;
    const maxCandles = isMobile ? 22 : 65;
    if (candles.length > maxCandles) {
        candles = candles.slice(-maxCandles);
    }

    const titleEl = document.getElementById('chartTitle');
    if (titleEl) {
        titleEl.innerHTML = `<i class="ph ph-chart-line-up" style="margin-right: 6px;"></i> 최근 ${isMobile ? '1' : '3'}개월 간 캔들 차트`;
    }

    // Collect all price points including MAs for proper scaling
    const allPrices = candles.flatMap(c => {
        const prices = [c.high, c.low];
        if (c.ma5 != null) prices.push(c.ma5);
        if (c.ma10 != null) prices.push(c.ma10);
        if (c.ma20 != null) prices.push(c.ma20);
        if (c.ma60 != null) prices.push(c.ma60);
        return prices;
    });
    const minP = Math.min(...allPrices);
    const maxP = Math.max(...allPrices);
    const range = maxP - minP || 1;
    const maxV = Math.max(...candles.map(c => c.volume)) || 1;

    // Layout Constants
    const chartH = 200; // Candlestick area height
    const volH = 50;    // Volume area height
    const gap = 15;     // Gap between candles and volume
    const legendTopPad = 35; // Space for legend at the top
    const topAreaH = chartH + gap + volH; // 265
    const legendPad = 25; // Space for date labels at the bottom

    const barW = Math.max(10, Math.min(40, (container.clientWidth - 40) / candles.length));
    const svgW = candles.length * barW + 20;

    const toY = (price) => legendTopPad + chartH - ((price - minP) / range) * (chartH - 20) - 10;

    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const textFill = isLight ? '#1e293b' : '#f8fafc';

    let html = `<svg width="100%" height="${legendTopPad + topAreaH + legendPad}" viewBox="0 0 ${svgW} ${legendTopPad + topAreaH + legendPad}">`;

    // ── Candle sticks & Volume bars ──
    candles.forEach((c, i) => {
        const x = i * barW + 10;
        const cx = x + barW / 2;
        const bodyTop = toY(Math.max(c.open, c.close));
        const bodyBot = toY(Math.min(c.open, c.close));
        const bodyH = Math.max(1, bodyBot - bodyTop);
        const wickTop = toY(c.high);
        const wickBot = toY(c.low);
        // 한국 시장은 양봉=빨강, 음봉=파랑
        const color = c.is_bullish ? '#ef4444' : '#3b82f6';
        const fill = color;

        // Animate up from the bottom of the main chart
        html += `<g class="candle-group" style="transform-origin: 0px ${chartH - 10}px; transform: scaleY(0); transition: transform 0.5s cubic-bezier(0.25, 0.8, 0.25, 1) ${i * 0.02}s;">`;

        // Wick
        html += `<line x1="${cx}" y1="${wickTop}" x2="${cx}" y2="${wickBot}" stroke="${color}" stroke-width="1.5"/>`;
        // Body
        html += `<rect x="${x + barW * 0.2}" y="${bodyTop}" width="${barW * 0.6}" height="${bodyH}"
                    fill="${fill}" stroke="${color}" stroke-width="1.5" rx="1"/>`;
        html += `</g>`;

        // Volume Bar
        const vRectH = Math.max(1, (c.volume / maxV) * volH);
        const vRectY = legendTopPad + topAreaH - vRectH;
        html += `<rect class="vol-group" x="${x + barW * 0.2}" y="${vRectY}" width="${barW * 0.6}" height="${vRectH}"
                    fill="${fill}" opacity="0.6" style="transform-origin: 0px ${legendTopPad + topAreaH}px; transform: scaleY(0); transition: transform 0.5s cubic-bezier(0.25, 0.8, 0.25, 1) ${i * 0.02}s;"/>`;

        // Date label (겹치지 않게 조절, 최대 12개 내외만 표시)
        // 날짜 레이블: 7 캔들(영업일) 간격으로 표시 (≈ 1주일), 마지막 캔들은 항상 표시
        const step = 7;
        if (i % step === 0 || i === candles.length - 1) {
            html += `<text x="${cx}" y="${legendTopPad + topAreaH + 20}" text-anchor="middle" fill="${textFill}"
                        font-size="11" font-weight="600" font-family="Inter">${c.date}</text>`;
        }
    });

    // ── Support & Resistance Lines ──
    const highestC = Math.max(...candles.map(c => c.high));
    const lowestC = Math.min(...candles.map(c => c.low));
    const resY = toY(highestC);
    const supY = toY(lowestC);

    html += `<line x1="10" y1="${resY}" x2="${svgW - 10}" y2="${resY}" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="4,4" opacity="0.6"/>`;
    html += `<text x="15" y="${resY - 6}" fill="#ef4444" font-size="10" font-weight="600" opacity="0.8">단기 저항선</text>`;

    html += `<line x1="10" y1="${supY}" x2="${svgW - 10}" y2="${supY}" stroke="#3b82f6" stroke-width="1.5" stroke-dasharray="4,4" opacity="0.6"/>`;
    html += `<text x="15" y="${supY + 12}" fill="#3b82f6" font-size="10" font-weight="600" opacity="0.8">단기 지지선</text>`;

    // ── Moving Average lines ──
    const maConfigs = [
        { key: 'ma5', color: isLight ? '#000000' : '#ffffff', label: '5일선' },
        { key: 'ma10', color: '#2563eb', label: '10일선' }, // 파랑
        { key: 'ma20', color: '#ea580c', label: '20일선' }, // 주황
        { key: 'ma60', color: '#16a34a', label: '60일선' }, // 초록
        { key: 'ma120', color: '#9ca3af', label: '120일선' }, // 회색
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
                        stroke-opacity="0.85" 
                        class="ma-line"
                        pathLength="100" />`;
        }
    });

    // ── MA Legend (Moved to Top) ──
    const legendY = 15;
    const legendStartX = 5;
    maConfigs.forEach((ma, idx) => {
        const lx = legendStartX + idx * 64;
        html += `<line x1="${lx}" y1="${legendY - 3}" x2="${lx + 12}" y2="${legendY - 3}" 
                    stroke="${ma.color}" stroke-width="2.5"/>`;
        html += `<text x="${lx + 15}" y="${legendY + 1}" fill="${textFill}" 
                    font-size="11" font-weight="600" font-family="Inter">${ma.label}</text>`;
    });

    html += '</svg>';
    container.innerHTML = html;

    observeElement(container, (el) => {
        el.querySelectorAll('.candle-group').forEach(cg => {
            cg.style.transform = 'scaleY(1)';
        });
        el.querySelectorAll('.ma-line').forEach((line, index) => {
            line.style.animation = `drawLine 2s ease-out ${index * 0.3}s forwards`;
        });
    });

    const maVisualBarsContainer = document.getElementById('maVisualBars');
    observeElement(maVisualBarsContainer, (el) => {
        el.querySelectorAll('.ma-bar-fill').forEach(fillEl => {
            fillEl.style.width = fillEl.getAttribute('data-target-width') + '%';
        });
        el.querySelectorAll('.ma-bar-current-price').forEach(priceEl => {
            priceEl.style.left = priceEl.getAttribute('data-target-left') + '%';
        });
    });

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
    document.getElementById('buyDesc').textContent = report.primary_pattern_desc;
    document.getElementById('buyAggressive').textContent = formatPrice(report.aggressive_entry);
    document.getElementById('buyConservative').textContent = formatPrice(report.conservative_entry);
    document.getElementById('buyTarget').textContent = formatPrice(report.target_price);
    document.getElementById('buyStopLoss').textContent = formatPrice(report.stop_loss);
    document.getElementById('buyRiskReward').textContent = `리스크:리워드 = ${report.risk_reward}`;
    document.getElementById('buyVolume').textContent = report.volume_note;
    document.getElementById('buyTip').innerHTML = `<i class="ph ph-lightbulb" style="color:var(--text-muted); margin-right:4px;"></i> ${report.entry_tip}`;
    return true;
}

function renderSellReport(report, atrTargets) {
    const card = document.getElementById('sellReport');
    if (!report) {
        card.classList.add('hidden');
        return false;
    }
    card.classList.remove('hidden');

    document.getElementById('sellSignalBadge').textContent = `신호 ${report.signal_strength}%`;
    document.getElementById('sellPattern').textContent = `핵심 패턴: ${report.primary_pattern}`;
    document.getElementById('sellDesc').textContent = report.primary_pattern_desc;
    document.getElementById('sellPrice').textContent = formatPrice(report.sell_price);
    document.getElementById('sellConservative').textContent = formatPrice(report.conservative_sell);
    document.getElementById('sellTarget').textContent = formatPrice(report.target_price);
    document.getElementById('sellStopLoss').textContent = formatPrice(report.stop_loss);
    document.getElementById('sellRiskReward').textContent = `리스크:리워드 = ${report.risk_reward}`;
    document.getElementById('sellVolume').textContent = report.volume_note;
    document.getElementById('sellTip').innerHTML = `<i class="ph ph-lightbulb" style="color:var(--text-muted); margin-right:4px;"></i> ${report.exit_tip}`;

    // ATR 비교 노트 표시
    const sellAtrNote = document.getElementById('sellAtrNote');
    if (sellAtrNote && atrTargets) {
        // 매도 리포트 손절가(MA20 기준) vs ATR 손절가(변동성 기준) 비교
        const patternSL = typeof report.stop_loss === 'number' ? report.stop_loss : null;
        const atrSL = atrTargets.stop_loss;
        let noteHtml = `<i class="ph ph-info" style="margin-right:4px;"></i>`
            + `<strong>ATR 기준 손절가:</strong> ${atrSL ? atrSL.toLocaleString() + '원' : '-'}`;
        if (patternSL && atrSL) {
            const diff = patternSL - atrSL;
            const pct = ((Math.abs(diff) / atrSL) * 100).toFixed(1);
            const dir = diff > 0 ? `패턴 기준이 ${pct}% 더 높음 (더 엄격)` : diff < 0 ? `ATR 기준이 ${pct}% 더 높음 (더 여유)` : '동일';
            noteHtml += ` <span style="color:var(--text-muted); font-size:0.7rem;">vs 패턴·MA 기준 ${formatPrice(patternSL)}원 — ${dir}</span>`;
        }
        noteHtml += `<div style="font-size:0.68rem; color:var(--text-muted); margin-top:3px;">📌 매도 리포트는 <strong>캔들 패턴·이동평균</strong> 기준 / ATR 패널은 <strong>시장 변동폭(14일 ATR)</strong> 기준으로 산출됩니다.</div>`;
        sellAtrNote.innerHTML = noteHtml;
        sellAtrNote.style.display = 'block';
    } else if (sellAtrNote) {
        sellAtrNote.style.display = 'none';
    }
    return true;
}

// ── Theme Toggle ──
function updateThemeIcon() {
    const icon = document.getElementById('themeIcon');
    if (!icon) return;
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    // In dark mode → show sun (click to go light). In light mode → show moon (click to go dark).
    icon.className = isLight ? 'ph ph-moon' : 'ph ph-sun';
}

function initTheme() {
    const saved = localStorage.getItem('stockfinder-theme');
    if (saved === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
    }
    updateThemeIcon();
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
    updateThemeIcon();
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

    // Auth Init
    initAuth();
});

// ── Auth & User Session ──
async function initAuth() {
    const authBtn = document.getElementById('authBtn');
    const authModalOverlay = document.getElementById('authModalOverlay');
    const authModal = document.getElementById('authModal');
    const closeAuthModal = document.getElementById('closeAuthModal');

    // Sidebar Logout Btn
    const sidebarFooter = document.getElementById('sidebarFooter');
    const sidebarLogoutBtn = document.getElementById('sidebarLogoutBtn');

    const googleAuthBtn = document.getElementById('googleAuthBtn');
    const authForm = document.getElementById('authForm');
    const authSubmitBtn = document.getElementById('authSubmitBtn');
    const authSwitchBtn = document.getElementById('authSwitchBtn');
    const authSwitchText = document.getElementById('authSwitchText');
    const authModalTitle = document.getElementById('authModalTitle');
    const authErrorMsg = document.getElementById('authErrorMsg');

    let isLoginMode = true;

    // 모달 열기/닫기 로직
    const showModal = () => {
        authModalOverlay.classList.add('show');
        authModal.classList.add('show');
    };

    const hideModal = () => {
        authModalOverlay.classList.remove('show');
        authModal.classList.remove('show');
        authErrorMsg.textContent = '';
    };

    authBtn.addEventListener('click', () => {
        showModal();
    });

    closeAuthModal.addEventListener('click', hideModal);
    authModalOverlay.addEventListener('click', hideModal);

    if (sidebarLogoutBtn) {
        sidebarLogoutBtn.addEventListener('click', async () => {
            await fetch(API_BASE_URL + '/api/logout', { method: 'POST', headers: getAuthHeaders() });
            removeSupaToken();
            authUser = null;
            currentWatchlist = [];
            updateAuthUI();
            renderWatchlist();
            updateWatchlistBtn();
            // Optionally close sidebar after logging out
            if (!isSidebarPinned()) closeSidebar();
        });
    }

    // ── Supabase JS 클라이언트 초기화 (브라우저 직통 인증용) ──
    let sbClient = null;
    try {
        const cfgRes = await fetch(API_BASE_URL + '/api/config');
        const cfg = await cfgRes.json();
        if (cfg.supabase_url && cfg.supabase_anon_key) {
            sbClient = supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);
        }
    } catch (e) {
        console.warn('Supabase JS 초기화 실패, 백엔드 폴백 모드 사용:', e);
    }

    // ── Google OAuth ──
    if (googleAuthBtn) {
        googleAuthBtn.addEventListener('click', async () => {
            if (!sbClient) { alert('구글 로그인을 사용할 수 없습니다.'); return; }
            if (oauthConfirmOverlay && oauthConfirmModal) {
                hideModal();
                oauthConfirmOverlay.classList.add('active');
                oauthConfirmModal.classList.add('active');
            }
        });
    }

    if (oauthCancelBtn) {
        oauthCancelBtn.addEventListener('click', () => {
            oauthConfirmOverlay.classList.remove('active');
            oauthConfirmModal.classList.remove('active');
            showModal();
        });
    }

    if (oauthContinueBtn) {
        oauthContinueBtn.addEventListener('click', async () => {
            if (!sbClient) { alert('구글 로그인을 사용할 수 없습니다.'); return; }
            try {
                oauthContinueBtn.disabled = true;
                oauthContinueBtn.style.opacity = '0.7';
                const redirectTo = window.location.origin + '/callback.html';
                const { error } = await sbClient.auth.signInWithOAuth({
                    provider: 'google',
                    options: { redirectTo }
                });
                if (error) throw error;
                // Supabase redirects the browser — nothing more to do here
            } catch (err) {
                alert('Google 로그인 오류: ' + (err.message || '알 수 없는 오류'));
                oauthConfirmOverlay.classList.remove('active');
                oauthConfirmModal.classList.remove('active');
            } finally {
                oauthContinueBtn.disabled = false;
                oauthContinueBtn.style.opacity = '1';
            }
        });
    }

    // ── 로그인 ↔ 회원가입 전환 ──
    if (authSwitchBtn) {
        authSwitchBtn.addEventListener('click', () => {
            isLoginMode = !isLoginMode;
            authModalTitle.textContent = isLoginMode ? '로그인' : '회원가입';
            authSubmitBtn.textContent = isLoginMode ? '로그인' : '회원가입';
            authSwitchText.textContent = isLoginMode ? '아직 계정이 없으신가요?' : '이미 계정이 있으신가요?';
            authSwitchBtn.textContent = isLoginMode ? '회원가입' : '로그인';
            authErrorMsg.textContent = '';
        });
    }

    // ── 로그인/회원가입 폼 ──
    if (authForm) {
        authForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const username = document.getElementById('username').value.trim();
            const password = document.getElementById('password').value.trim();
            if (!username || !password) return;

            // email 형식 통일 (username@stockfinder.local 우회)
            const email = username.includes('@') ? username : `${username}@stockfinder.local`;

            try {
                authSubmitBtn.disabled = true;
                authErrorMsg.textContent = '';

                if (sbClient) {
                    // ── 빠른 경로: Supabase JS SDK 직접 호출 ──
                    if (isLoginMode) {
                        const { data, error } = await sbClient.auth.signInWithPassword({ email, password });
                        if (error) throw error;
                        setSupaToken(data.session.access_token);
                        hideModal();
                        await fetchUserSession();
                    } else {
                        const { error } = await sbClient.auth.signUp({ email, password });
                        if (error) throw error;
                        alert('회원가입 성공! 이제 로그인할 수 있습니다.');
                        authSwitchBtn.click();
                    }
                } else {
                    // ── 폴백: Render 백엔드 경유 ──
                    const endpoint = isLoginMode ? API_BASE_URL + '/api/login' : API_BASE_URL + '/api/register';
                    const res = await fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username, password })
                    });
                    const data = await res.json();
                    if (data.success) {
                        if (isLoginMode) {
                            setSupaToken(data.access_token);
                            hideModal();
                            await fetchUserSession();
                        } else {
                            alert(data.message);
                            authSwitchBtn.click();
                        }
                    } else {
                        authErrorMsg.textContent = data.message;
                    }
                }
            } catch (error) {
                const msg = error?.message || '';
                if (msg.includes('Invalid login credentials')) {
                    authErrorMsg.textContent = '아이디 또는 비밀번호가 올바르지 않습니다.';
                } else if (msg.includes('User already registered')) {
                    authErrorMsg.textContent = '이미 등록된 아이디입니다.';
                } else {
                    authErrorMsg.textContent = msg || '오류가 발생했습니다. 다시 시도해주세요.';
                }
            } finally {
                authSubmitBtn.disabled = false;
            }
        });
    }

    const updateAuthUI = () => {
        if (authUser && authUser.logged_in) {
            authBtn.style.display = 'none';
            // 'flex' 를 사용해야 sidebar-footer의 justify-content: flex-end 가 적용됨
            if (sidebarFooter) sidebarFooter.style.display = 'flex';
        } else {
            authBtn.style.display = 'flex';
            authBtn.textContent = '로그인';
            if (sidebarFooter) sidebarFooter.style.display = 'none';
        }
    };

    // 서버에서 세션(및 관심종목) 가져오기 — /api/session 으로 1회 호출
    const fetchUserSession = async () => {
        try {
            const token = getSupaToken();
            const res = await fetch(API_BASE_URL + '/api/session', {
                headers: token ? { 'Authorization': `Bearer ${token}` } : {}
            });
            const data = await res.json();

            // authUser 형식 유지 (logged_in, username)
            authUser = { logged_in: data.logged_in, username: data.username };

            if (data.logged_in) {
                // watchlist 가 이미 세션 응답에 포함되어 있음
                const serverList = data.watchlist || [];
                currentWatchlist = serverList;

                // 로그인 전 게스트 상태로 저장된 로컬 관심종목이 있다면 DB로 병합
                try {
                    const guestList = JSON.parse(localStorage.getItem(WATCHLIST_KEY)) || [];
                    if (guestList.length > 0) {
                        for (const item of guestList) {
                            if (!currentWatchlist.some(w => w.code === item.code)) {
                                await fetch(API_BASE_URL + '/api/watchlist', {
                                    method: 'POST',
                                    headers: getAuthHeaders(),
                                    body: JSON.stringify({ code: item.code, name: item.name, market: item.market })
                                });
                                currentWatchlist.push(item);
                            }
                        }
                        localStorage.removeItem(WATCHLIST_KEY);
                    }
                } catch (e) { console.error('Guest Watchlist merge error', e); }
            }

            renderWatchlist();
            updateWatchlistBtn();
        } catch (error) {
            console.warn("Session check failed", error);
        }
        updateAuthUI();
    };

    // 로드 시 초기 세션 확인
    await fetchUserSession();
}
