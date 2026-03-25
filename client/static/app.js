if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(registrations => {
        for (let registration of registrations) { registration.unregister(); }
    });
}

const API_BASE_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') 
    ? '' 
    : 'https://todaysstock.onrender.com';
console.log('[DEBUG] API_BASE_URL:', API_BASE_URL);
console.log('[DEBUG] Hostname:', window.location.hostname);
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

async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 30000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(resource, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        if (error.name === 'AbortError') {
            const err = new Error('서버 응답 시간이 초과되었습니다 (30초). 잠시 후 다시 시도해 주세요.');
            err.name = 'TimeoutError';
            throw err;
        }
        throw error;
    }
}

let suggestItems = [];
let activeIndex = -1;
let debounceTimer = null;
let currentWatchlist = [];
let currentIndexChart = null; // Lightweight Chart instance
let currentStock = null;
let _lastAnalysisData = null;
let sectionScrollPositions = {};
let currentActiveSectionId = 'dashboardHome'; // Track currently visible section

// --- Independent Section Contexts ---
let homeStockContext = { item: null, data: null, analysis: null };
let watchlistStockContext = { item: null, data: null, analysis: null };

// ── Watchlist Constants ──
const WATCHLIST_KEY = 'stockfinder-watchlist';

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

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = 'ph-info';
    if (type === 'error') icon = 'ph-warning-circle';
    if (type === 'success') icon = 'ph-check-circle';
    
    toast.innerHTML = `<i class="ph ${icon}"></i><span>${message}</span>`;
    container.appendChild(toast);

    // Auto remove
    setTimeout(() => {
        toast.classList.add('hide');
        setTimeout(() => toast.remove(), 400);
    }, 3000);
}

function renderRecentSearches() {
    const container = document.getElementById('recentSearches');
    const list = document.getElementById('recentList');
    if (!container || !list) return;
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

// ── Sidebar & Navigation ──
function initNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    const sections = {
        'navHome': 'dashboardHome',
        'navAnalysis': 'analysisSection',
        'navWatchlist': 'watchlistSection',
        'navValueChain': 'valueChainSection'
    };


    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            
            // --- Scroll Persistence: Save current ---
            if (currentActiveSectionId) {
                sectionScrollPositions[currentActiveSectionId] = window.scrollY;
            }

            const targetId = sections[item.id];
            if (targetId) {
                showSection(targetId);
                currentActiveSectionId = targetId;
                navItems.forEach(i => i.classList.toggle('active', i === item));

                if (targetId === 'analysisSection') {
                    const emptyState = document.getElementById('analysisEmptyState');
                    const contentWrapper = document.getElementById('analysisContentWrapper');
                    const currentStockLabel = document.getElementById('analysisCurrentStock');

                    if (!currentStock) {
                        emptyState?.classList.remove('hidden');
                        contentWrapper?.classList.add('hidden');
                        if (currentStockLabel) currentStockLabel.textContent = '';
                    } else {
                        emptyState?.classList.add('hidden');
                        contentWrapper?.classList.remove('hidden');
                        if (currentStockLabel) currentStockLabel.textContent = `${currentStock.name} (${currentStock.code || currentStock.ticker})`;
                        
                        // Force refresh metrics
                        if (_lastAnalysisData) {
                            renderAiInsights(_lastAnalysisData);
                        }
                        if (localStorage.getItem('stockfinder-fund-enabled') !== 'false') {
                            renderFundamentalReport(currentStock.code || currentStock.ticker);
                        }
                    }
                }

                // --- Section Persistence Restore ---
                if (targetId === 'dashboardHome') {
                    restoreStockContext('home');
                } else if (targetId === 'watchlistSection') {
                    restoreStockContext('watchlist');
                }

                // --- Scroll Persistence: Restore target ---
                requestAnimationFrame(() => {
                    const savedPos = sectionScrollPositions[targetId] || 0;
                    window.scrollTo({ top: savedPos, behavior: 'auto' });
                });
            }
        });
    });
}

function navigateToSection(navId) {
    const navItem = document.getElementById(navId);
    if (navItem) {
        navItem.click();
    }
}

function restoreStockContext(type) {
    const context = (type === 'home') ? homeStockContext : watchlistStockContext;
    const resSec = document.getElementById('resultSection');
    
    if (!context.item || !context.data) {
        // No previously searched stock for this section
        if (type === 'home') {
            // Home might show macro cards by default if result is hidden
        }
        return;
    }

    // Move resultSection back to the correct placeholder
    const placeholderId = (type === 'home') ? 'mainResultPlaceholder' : 'watchlistResultPlaceholder';
    const placeholder = document.getElementById(placeholderId);
    if (placeholder && resSec) {
        const triggerContainer = document.getElementById('analysisTriggerContainer');
        const patternReportSection = document.getElementById('patternReportSection');

        placeholder.parentNode.insertBefore(resSec, placeholder.nextSibling);
        resSec.classList.remove('hidden');

        // Restore State
        currentStock = context.item;
        renderResult(context.data);
        
        if (context.analysis) {
            if (triggerContainer) triggerContainer.style.display = 'none';
            if (patternReportSection) patternReportSection.classList.remove('hidden');
            renderAnalysisReport(context.analysis);
        } else {
            if (triggerContainer) triggerContainer.style.display = 'block';
            if (patternReportSection) patternReportSection.classList.add('hidden');
        }

        if (context.fundamental) {
            // Call renderFundamentalReport logic or just use cached d
            // Since Fundamental report is a bit long, if we don't want to re-fetch, we can just call it with the cached data
            // But currently renderFundamentalReport does its own fetch. 
            // Let's just re-fetch for simplicity or check if we can pass data.
            renderFundamentalReport(context.item.code); 
        } else {
            renderFundamentalReport(context.item.code);
        }
        
        // Final sanity check for result visibility
        resSec.classList.remove('hidden');
    }
}

function showSection(id) {
    const sections = ['dashboardHome', 'analysisSection', 'historySection', 'watchlistSection', 'valueChainSection'];
    sections.forEach(s => {
        const el = document.getElementById(s);
        if (el) {
            el.classList.add('hidden');
            el.style.display = ''; // Reset inline style to let CSS handle it
        }
    });

    const target = document.getElementById(id);
    if (target) {
        target.classList.remove('hidden');
        target.style.display = ''; // Let CSS handle visibility
        currentActiveSectionId = id; // Sync current active section for scroll persistence
        
        requestAnimationFrame(() => {
            console.log(`[DEBUG] Section "${id}" is now active. Triggering renderers.`);
            if (id === 'dashboardHome') renderMacroIndicators();
        });
    }
}

// ── Sidebar Pin & Toggle ──
const SIDEBAR_PIN_KEY = 'stockfinder-sidebar-pin';

function isSidebarPinned() {
    return localStorage.getItem(SIDEBAR_PIN_KEY) !== 'false';
}

function setSidebarPinned(pinned) {
    localStorage.setItem(SIDEBAR_PIN_KEY, pinned ? 'true' : 'false');
    applySidebarPinState();
}

function applySidebarPinState() {
    const sidebar = document.getElementById('mainSidebar');
    const pinBtn = document.getElementById('sidebarPinBtn');
    const overlay = document.getElementById('sidebarOverlay');
    if (!sidebar) return;
    
    if (isSidebarPinned()) {
        sidebar.classList.add('pinned');
        document.body.setAttribute('data-sidebar-pinned', 'true');
        if (overlay) overlay.classList.remove('show');
        if (pinBtn) {
            pinBtn.classList.add('active');
            pinBtn.title = '사이드바 고정 해제';
        }
    } else {
        sidebar.classList.remove('pinned');
        document.body.removeAttribute('data-sidebar-pinned');
        if (pinBtn) {
            pinBtn.classList.remove('active');
            pinBtn.title = '사이드바 고정';
        }
    }
}

function closeSidebar() {
    const sidebar = document.getElementById('mainSidebar');
    const overlay = document.getElementById('sidebarOverlay');
    if (sidebar) sidebar.classList.remove('mobile-open');
    if (overlay) overlay.classList.remove('show');
}

function toggleSidebarOpen() {
    const sidebar = document.getElementById('mainSidebar');
    const overlay = document.getElementById('sidebarOverlay');
    if (sidebar) sidebar.classList.toggle('mobile-open');
    if (overlay) overlay.classList.toggle('show');
}

document.getElementById('sidebarOverlay')?.addEventListener('click', () => {
    const sidebar = document.getElementById('mainSidebar');
    const overlay = document.getElementById('sidebarOverlay');
    if (sidebar) sidebar.classList.remove('mobile-open');
    if (overlay) overlay.classList.remove('show');
});

// ── Sidebar Toggle (Mobile) ──
function initMobileSidebar() {
    // Redundant toggle removed: toggleSidebarOpen handles both overlay and sidebar classes.
}

// ── Auth Tokens ──
const SUPA_TOKEN_KEY = 'supa-access-token';
let authUser = null; // { logged_in: boolean, username: string }

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

// ── Watchlist Helpers ──
function getWatchlist() {
    return currentWatchlist;
}

function saveWatchlist(list) {
    currentWatchlist = list;
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
    renderWatchlist();
    updateWatchlistCount();
}

async function addToWatchlist(item) {
    if (isInWatchlist(item.code)) return;

    if (!authUser || !authUser.logged_in) {
        showToast('관심종목을 등록하려면 로그인이 필요합니다.', 'error');
        const authModal = document.getElementById('authModal');
        if (authModal) authModal.classList.remove('hidden');
        return;
    }
    
    if (currentWatchlist.some(w => w.code === item.code)) return;
    
    // ── 낙관적 UI 업데이트 (Optimistic Update) ──
    const rollbackSnapshot = [...currentWatchlist];
    currentWatchlist.push(item);
    saveWatchlist(currentWatchlist);
    updateWatchlistBtn();
    showToast(`${item.name} 종목이 관심종목에 추가되었습니다.`, 'success');

    // Context handling (stay in Home)
    homeStockContext = { item: item, data: (homeStockContext.item?.code === item.code) ? homeStockContext.data : null, analysis: (homeStockContext.item?.code === item.code) ? homeStockContext.data : null };
    const resSec = document.getElementById('resultSection');
    const placeholder = document.getElementById('mainResultPlaceholder');
    if (resSec && placeholder) {
        placeholder.parentNode.insertBefore(resSec, placeholder.nextSibling);
        resSec.classList.remove('hidden');
    }

    // 백그라운드 서버 요청
    try {
        const res = await fetchWithTimeout(API_BASE_URL + '/api/watchlist', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ code: item.code, name: item.name, market: item.market }),
            timeout: 30000
        });
        
        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.message || '서버 오류');
        }
    } catch (e) {
        console.error('Watchlist add background error:', e);
        // 실패 시 롤백
        currentWatchlist = rollbackSnapshot;
        saveWatchlist(currentWatchlist);
        updateWatchlistBtn();
        showToast('추가 처리 중 오류가 발생했습니다: ' + e.message, 'error');
    }
}

async function removeFromWatchlist(code) {
    // Determine the item to remove
    const removedItem = currentWatchlist.find(w => w.code === code) || (currentStock?.code === code ? currentStock : null);
    
    if (!authUser || !authUser.logged_in) {
        currentWatchlist = currentWatchlist.filter(w => w.code !== code);
        saveWatchlist(currentWatchlist);
        updateWatchlistBtn();

        if (removedItem) {
            showToast(`"${removedItem.name || code}" 종목이 삭제되었습니다.`, 'info');
            // Sync context if the removed stock matches current context
            if (removedItem.code === currentStock?.code) {
                 homeStockContext = { item: removedItem, data: (removedItem.code === watchlistStockContext.item?.code) ? watchlistStockContext.data : null, analysis: (removedItem.code === watchlistStockContext.item?.code) ? watchlistStockContext.analysis : null };
                 watchlistStockContext = { item: null, data: null, analysis: null };
            }
        }

        // Always redirect back to Home as per user request
        navigateToSection('navHome');
        return;
    }
    
    // ── 로그인 사용자: 낙관적 UI (Optimistic Update) ──
    // 1. 즉시 UI에서 제거 (서버 응답 대기 없음)
    const rollbackSnapshot = [...currentWatchlist];
    currentWatchlist = currentWatchlist.filter(w => w.code !== code);
    saveWatchlist(currentWatchlist);
    updateWatchlistBtn();
    if (removedItem) {
        showToast(`"${removedItem.name || code}" 종목이 삭제되었습니다.`, 'info');
    }
    navigateToSection('navHome');

    // 2. 백그라운드에서 서버 DELETE 요청 (fire-and-forget)
    try {
        const res = await fetchWithTimeout(API_BASE_URL + '/api/watchlist', {
            method: 'DELETE',
            headers: getAuthHeaders(),
            body: JSON.stringify({ code: code }),
            timeout: 30000
        });
        if (!res.ok) throw new Error('Server delete failed');
    } catch (e) {
        // 3. 서버 실패 시 롤백
        console.error('Watchlist remove error (background):', e);
        currentWatchlist = rollbackSnapshot;
        saveWatchlist(currentWatchlist);
        updateWatchlistBtn();
        showToast('삭제 중 오류가 발생했습니다. 다시 시도해주세요.', 'error');
    }
}

function isInWatchlist(code) {
    return currentWatchlist.some(w => w.code === code);
}

function renderWatchlist() {
    const container = document.getElementById('watchlistContainer');
    if (!container) return;
    
    const list = getWatchlist();
    if (list.length === 0) {
        container.innerHTML = `
            <div class="empty-watchlist" style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);">
                <i class="ph ph-star" style="font-size: 3rem; opacity: 0.2; margin-bottom: 12px;"></i>
                <p>관심종목이 없습니다. 별표를 눌러 추가해보세요!</p>
            </div>
        `;
        return;
    }

    container.innerHTML = list.map(item => `
        <div class="watchlist-tile" data-code="${escapeHtml(item.code)}" data-market="${escapeHtml(item.market)}" data-name="${escapeHtml(item.name)}" onclick="selectStock({code:'${escapeHtml(item.code)}', market:'${escapeHtml(item.market)}', name:'${escapeHtml(item.name)}'})">
            <div class="watchlist-tile-header">
                <span class="watchlist-tile-market ${item.market.toLowerCase()}">${escapeHtml(item.market)}</span>
                <button class="watchlist-tile-remove" onclick="event.stopPropagation(); removeFromWatchlist('${escapeHtml(item.code)}')">
                    <i class="ph ph-x"></i>
                </button>
            </div>
            <div class="watchlist-tile-body">
                <span class="watchlist-tile-name">${escapeHtml(item.name)}</span>
                <span class="watchlist-tile-code">${escapeHtml(item.code)}</span>
            </div>
            <div class="watchlist-tile-footer">
                <div class="watchlist-tile-stats" id="tileStats-${escapeHtml(item.code)}">
                    <span class="loading-dots">•••</span>
                </div>
            </div>
        </div>
    `).join('');
    
    // Proactively fetch mini data for tiles
    list.forEach(item => updateTileData(item.code));
}

function updateWatchlistBtn() {
    const favBtns = document.querySelectorAll('.favorite-btn');
    if (!currentStock) return;

    const exists = isInWatchlist(currentStock.code);

    favBtns.forEach(favBtn => {
        if (exists) {
            favBtn.classList.add('active');
            favBtn.innerHTML = '<i class="ph ph-star ph-fill"></i>';
        } else {
            favBtn.classList.remove('active');
            favBtn.innerHTML = '<i class="ph ph-star"></i>';
        }
    });
}

function updateWatchlistCount() {
    const countEl = document.getElementById('navWatchlistCount');
    if (countEl) {
        countEl.textContent = currentWatchlist.length;
        countEl.style.display = currentWatchlist.length > 0 ? 'flex' : 'none';
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
        const res = await fetchWithTimeout(API_BASE_URL + `/api/suggest?q=${encodeURIComponent(query)}`, { timeout: 30000 });
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
        const addedBadge = '';
        return `
            <div class="suggest-item ${idx === activeIndex ? 'active' : ''}"
                 data-index="${idx}"
                 onmouseenter="setActiveIndex(${idx})"
                 onclick="selectStockByIndex(${idx})">
                <span class="suggest-item-name">${highlightedName} ${addedBadge}</span>
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
        const url = `${API_BASE_URL}/api/stock?code=${item.code}&market=${item.market}&name=${encodeURIComponent(item.name)}`;
        console.log('[DEBUG] Fetching stock data from:', url);
        // 15초 타임아웃 적용하여 무한 로딩 방지
        const response = await fetchWithTimeout(url, { timeout: 30000 });
        if (!response.ok) throw new Error('데이터를 불러오는데 실패했습니다.');
        
        const data = await response.json();
        
        currentStock = item; // Store current stock

        // --- Handle Result Placement (Always in Home) ---
        const resSec = document.getElementById('resultSection');
        const placeholder = document.getElementById('mainResultPlaceholder');
        
        // Save to home context
        homeStockContext = {
            item: item,
            data: data,
            analysis: null
        };

        if (placeholder && resSec) {
            placeholder.parentNode.insertBefore(resSec, placeholder.nextSibling);
        }
        
        // Always navigate to Home when viewing a stock
        navigateToSection('navHome');
        resSec.classList.remove('hidden'); 


        renderResult(data);
        
        // Ensure fundamental report is also called if we were in analysis mode
        if (currentStock) {
            renderFundamentalReport(currentStock.code || currentStock.ticker || '');
        }
        // AI Analysis now triggered by button, no automatic fetch here
    } catch (err) {
        console.error('selectStock error:', err);
        showError(err.name === 'AbortError' ? '요청 시간이 초과되었습니다. 다시 시도해주세요.' : err.message);
    } finally {
        loadingSpinner.classList.add('hidden');
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
    updateWatchlistBtn();
    document.getElementById('stockCode').textContent = data.code;

    document.getElementById('stockIndustry').textContent = data.industry || '분류되지 않음';


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
    document.getElementById('stockLow').textContent = formatNumber(data.low);
    document.getElementById('stockVolume').textContent = formatNumber(data.volume);

    // --- Valuation Metrics (Phase 8) ---
    // Deterministic mock logic based on stock code if not provided by API
    const codeText = data.code || '';
    const hash = codeText.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
    const rand = (min, max, offset = 0) => ((min + ((hash + offset) % (max - min))) / 10).toFixed(1);

    const per = data.per || (rand(50, 250) + 'x');
    const pbr = data.pbr || (rand(5, 30, 7) + 'x');
    const roe = data.roe || (rand(10, 250, 13) + '%');
    const div = data.dividend_yield || (rand(0, 50, 19) + '%');
    
    const pcr = data.pcr || (rand(30, 180, 23) + 'x');
    const psr = data.psr || (rand(2, 50, 29) + 'x');
    const evSales = data.ev_sales || (rand(5, 60, 31) + 'x');
    const evEbitda = data.ev_ebitda || (rand(40, 200, 37) + 'x');

    const perEl = document.getElementById('valPER');
    const pbrEl = document.getElementById('valPBR');
    const roeEl = document.getElementById('valROE');
    const divEl = document.getElementById('valDiv');
    const pcrEl = document.getElementById('valPCR');
    const psrEl = document.getElementById('valPSR');
    const salesEl = document.getElementById('valEVSales');
    const ebitdaEl = document.getElementById('valEVEbitda');

    if (perEl) perEl.textContent = per;
    if (pbrEl) pbrEl.textContent = pbr;
    if (roeEl) roeEl.textContent = roe;
    if (divEl) divEl.textContent = div;
    if (pcrEl) pcrEl.textContent = pcr;
    if (psrEl) psrEl.textContent = psr;
    if (salesEl) salesEl.textContent = evSales;
    if (ebitdaEl) ebitdaEl.textContent = evEbitda;

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

    // --- Company Summary ---
    const summaryEl = document.getElementById('companySummary');
    if (data.company_summary) {
        summaryEl.innerHTML = data.company_summary;
        summaryEl.classList.remove('hidden');
    } else {
        summaryEl.classList.add('hidden');
    }

    // --- NXT After-hours ---
    renderNxtCard(data.nxt);

    // Show result
    resultSection.classList.remove('hidden');

    // Reset analysis section & trigger button
    const patternReportSection = document.getElementById('patternReportSection');
    const triggerContainer = document.getElementById('analysisTriggerContainer');
    const showAnalysisBtn = document.getElementById('btnShowAnalysis');

    if (patternReportSection) patternReportSection.classList.add('hidden');
    if (triggerContainer) triggerContainer.style.display = 'block';

    if (showAnalysisBtn) {
        // Remove previous listeners to avoid duplicates
        const newBtn = showAnalysisBtn.cloneNode(true);
        showAnalysisBtn.parentNode.replaceChild(newBtn, showAnalysisBtn);
        newBtn.addEventListener('click', () => {
            fetchAnalysis(currentStock);
        });
    }
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
        { label: '20일선', value: data.ma20, cssClass: 'ma20' },
        { label: '60일선', value: data.ma60, cssClass: 'ma60' },
        { label: '120일선', value: data.ma120, cssClass: 'ma120' },
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

        let delay = '0.3s';
        if (bar.cssClass === 'ma10') delay = '0.4s';
        if (bar.cssClass === 'ma20') delay = '0.5s';
        if (bar.cssClass === 'ma60') delay = '0.6s';

        return `
            <div class="ma-bar-row" style="animation: slideInRight 0.5s ease-out forwards; opacity: 0; animation-delay: ${delay};">
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

    observeElement(container, (el) => {
        el.querySelectorAll('.ma-bar-fill').forEach(fillEl => {
            fillEl.style.width = fillEl.getAttribute('data-target-width') + '%';
        });
        el.querySelectorAll('.ma-bar-current-price').forEach(dot => {
            dot.style.left = dot.getAttribute('data-target-left') + '%';
        });
    });
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
// 글로벌 매크로 지표 렌더링
// ═══════════════════════════════════════════════════

async function renderMacroIndicators() {
    const indexList = document.getElementById('indexList');
    const economyGrid = document.getElementById('economyGrid');
    const cryptoGrid = document.getElementById('cryptoGrid');
    const fgFill = document.getElementById('fgFill');
    const fgNeedle = document.getElementById('fgNeedle');
    const fgStatus = document.getElementById('fgStatus');
    const fgValue = document.getElementById('fgValue');

    if (!economyGrid) return;

    try {
        console.log('[DEBUG] Fetching macro data from:', `${API_BASE_URL}/api/macro`);
        const resp = await fetchWithTimeout(`${API_BASE_URL}/api/macro`, { timeout: 30000 });
        if (!resp.ok) throw new Error('Macro data fetch failed');
        const data = await resp.json();
        console.log('[DEBUG] Macro data received:', data);

        // Data Mapping (시장 지수 대시보드용)
        const indexData = [
            { id: 'KOSPI', name: 'KOSPI', price: data.kospi?.toLocaleString() || '-', change: `${data.kospi_chg > 0 ? '+' : ''}${data.kospi_chg != null ? data.kospi_chg.toFixed(2) : '-'}%`, up: data.kospi_chg > 0 },
            { id: 'KOSDAQ', name: 'KOSDAQ', price: data.kosdaq?.toLocaleString() || '-', change: `${data.kosdaq_chg > 0 ? '+' : ''}${data.kosdaq_chg != null ? data.kosdaq_chg.toFixed(2) : '-'}%`, up: data.kosdaq_chg > 0 },
            { id: 'S&P 500', name: 'S&P 500', price: data.sp500?.toLocaleString() || '-', change: `${data.sp500_chg > 0 ? '+' : ''}${data.sp500_chg != null ? data.sp500_chg.toFixed(2) : '-'}%`, up: data.sp500_chg > 0 },
            { id: 'NASDAQ', name: 'NASDAQ', price: data.nasdaq?.toLocaleString() || '-', change: `${data.nasdaq_chg > 0 ? '+' : ''}${data.nasdaq_chg != null ? data.nasdaq_chg.toFixed(2) : '-'}%`, up: data.nasdaq_chg > 0 },
            { id: 'PHLX SEMI', name: '필라델피아 반도체', price: data.sox?.toLocaleString() || '-', change: `${data.sox_chg > 0 ? '+' : ''}${data.sox_chg != null ? data.sox_chg.toFixed(2) : '-'}%`, up: data.sox_chg > 0 },
            { id: 'DXY', name: '달러 인덱스', price: data.dxy?.toLocaleString() || '-', change: `${data.dxy_chg > 0 ? '+' : ''}${data.dxy_chg != null ? data.dxy_chg.toFixed(2) : '-'}%`, up: data.dxy_chg > 0 },
            { id: 'WTI', name: 'WTI 유가', price: data.wti?.toLocaleString() || '-', change: `${data.wti_chg > 0 ? '+' : ''}${data.wti_chg != null ? data.wti_chg.toFixed(2) : '-'}%`, up: data.wti_chg > 0 }
        ];

        // 주요 경제 지표 (환율, 국채 등)
        const economyData = [
            { name: 'USD/KRW 환율', price: data.usd_krw?.toLocaleString() || '-', change: `${data.usd_krw_chg > 0 ? '+' : ''}${data.usd_krw_chg != null ? data.usd_krw_chg.toFixed(2) : '-'}%`, up: data.usd_krw_chg > 0 },
            { name: '미 국채 10년물', price: `${data.us10y != null ? data.us10y.toFixed(2) : '-'}%`, change: `${data.us10y_chg > 0 ? '+' : ''}${data.us10y_chg != null ? data.us10y_chg.toFixed(3) : '-'}`, up: data.us10y_chg > 0 },
            { name: '공포지수 (VIX)', price: data.vix?.toLocaleString() || '-', change: `${data.vix_chg > 0 ? '+' : ''}${data.vix_chg != null ? data.vix_chg.toFixed(2) : '-'}%`, up: data.vix_chg > 0 }
        ];

        const cryptoData = [
            { name: '비트코인 (BTC)', price: data.btc?.toLocaleString() || '-', change: `${data.btc_chg > 0 ? '+' : ''}${data.btc_chg != null ? data.btc_chg.toFixed(2) : '-'}%`, up: data.btc_chg > 0 },
            { name: '이더리움 (ETH)', price: data.eth?.toLocaleString() || '-', change: `${data.eth_chg > 0 ? '+' : ''}${data.eth_chg != null ? data.eth_chg.toFixed(2) : '-'}%`, up: data.eth_chg > 0 },
            { name: '테더 (USDT)', price: data.usdt?.toLocaleString() || '-', change: `${data.usdt_chg > 0 ? '+' : ''}${data.usdt_chg != null ? data.usdt_chg.toFixed(2) : '-'}%`, up: data.usdt_chg > 0 }
        ];

        const fearGreedValue = data.fear_greed || 50;

        // Render Indices List
        if (indexList) {
            indexList.innerHTML = indexData.map(idx => {
                const price = idx.price || '-';
                const change = idx.change || '-';
                const trendClass = idx.up ? 'up' : 'down';
                return `
                    <div class="index-item" 
                         data-id="${idx.id}" 
                         data-name="${idx.name}" 
                         onclick="renderIndexChart('${idx.id}', '${idx.name}'); document.querySelectorAll('.index-item').forEach(i => i.classList.remove('active')); this.classList.add('active');">
                        <span class="indicator-label">${idx.name}</span>
                        <div class="indicator-values">
                            <span class="indicator-price">${price}</span>
                            <span class="indicator-change ${trendClass}">${change}</span>
                        </div>
                    </div>
                `;
            }).join('');

            // Auto-select KOSPI if not already selecting something
            const activeItem = indexList.querySelector('.index-item.active');
            if (!activeItem) {
                const kospi = indexList.querySelector('.index-item[data-id="KOSPI"]');
                if (kospi) {
                    kospi.classList.add('active');
                    renderIndexChart('KOSPI', 'KOSPI');
                }
            }
        }

        // Render Economy
        economyGrid.innerHTML = economyData.map(eco => `
            <div class="indicator-row">
                <span class="indicator-label">${eco.name}</span>
                <div class="indicator-values">
                    <span class="indicator-price">${eco.price}</span>
                    <span class="indicator-change ${eco.up ? 'up' : 'down'}">${eco.change}</span>
                </div>
            </div>
        `).join('');

        // Render Crypto
        if (cryptoGrid) {
            cryptoGrid.innerHTML = cryptoData.map(cry => `
                <div class="indicator-row">
                    <span class="indicator-label">${cry.name}</span>
                    <div class="indicator-values">
                        <span class="indicator-price">$${cry.price}</span>
                        <span class="indicator-change ${cry.up ? 'up' : 'down'}">${cry.change}</span>
                    </div>
                </div>
            `).join('');
        }

        // Update Top Status Chips (기존 기능 유지)
        updateStatusChips(data);

        // Render Fear & Greed
        updateFearGreed(fearGreedValue);

    } catch (err) {
        console.error("renderMacroIndicators error:", err);
        if (indexList) indexList.innerHTML = '<div class="error-msg">지표 로드 실패</div>';
    }
}

// ── 상세 지수 차트 렌더링 (Lightweight Charts) ──
async function renderIndexChart(symbol, name) {
    const titleName = document.getElementById('selectedIndexName');
    const container = document.getElementById('indexChart');
    if (titleName) titleName.textContent = `${name} 1개월 차트`;
    if (!container) return;

    // Clear existing
    container.innerHTML = '<div class="loading-chart">데이터를 불러오는 중...</div>';
    if (currentIndexChart) {
        currentIndexChart.remove();
        currentIndexChart = null;
    }

    try {
        const resp = await fetchWithTimeout(`${API_BASE_URL}/api/market-index/history?symbol=${encodeURIComponent(symbol)}`);
        if (!resp.ok) throw new Error('History Fetch Failed');
        const data = await resp.json();

        container.innerHTML = '';
        
        // Ensure container has dimensions
        if (container.clientWidth === 0 || container.clientHeight === 0) {
            console.warn('[DEBUG] Container has 0 dimensions, waiting for next frame...');
            await new Promise(resolve => requestAnimationFrame(resolve));
        }

        const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
        const textColor = isDark ? '#94a3b8' : '#64748b';
        const gridColor = isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';

        const chartOptions = {
            width: container.clientWidth || 400,
            height: container.clientHeight || 300,
            layout: { 
                background: { type: 'solid', color: 'transparent' },
                textColor: textColor,
                fontSize: 11,
                fontFamily: 'Space Grotesk, sans-serif'
            },
            grid: {
                vertLines: { color: gridColor },
                horzLines: { color: gridColor },
            },
            crosshair: {
                mode: 1, // Normal
            },
            rightPriceScale: {
                borderColor: gridColor,
            },
            timeScale: {
                borderColor: gridColor,
            },
            handleScroll: true,
            handleScale: true,
        };

        const chart = LightweightCharts.createChart(container, chartOptions);

        let areaSeries;
        if (typeof chart.addAreaSeries === 'function') {
            areaSeries = chart.addAreaSeries({
                topColor: 'rgba(59, 130, 246, 0.4)',
                bottomColor: 'rgba(59, 130, 246, 0.0)',
                lineColor: '#3b82f6',
                lineWidth: 2,
            });
        } else if (typeof chart.addLineSeries === 'function') {
            areaSeries = chart.addLineSeries({
                color: '#3b82f6',
                lineWidth: 2,
            });
        } else {
            throw new Error('Chart object lacks series addition methods');
        }

        if (data.history && data.history.length > 0) {
            areaSeries.setData(data.history);
        }

        chart.timeScale().fitContent();
        currentIndexChart = chart;

        // Sync with resize
        const resizeObserver = new ResizeObserver(entries => {
            if (entries.length === 0 || !currentIndexChart) return;
            const { width, height } = entries[0].contentRect;
            if (width > 0 && height > 0) {
                currentIndexChart.applyOptions({ width, height });
                currentIndexChart.timeScale().fitContent();
            }
        });
        resizeObserver.observe(container);

    } catch (err) {
        console.error("renderIndexChart error:", err);
        container.innerHTML = `<div class="error-msg">차트 로드 실패: ${err.message}</div>`;
    }
}

// ── Top Status Chips 업데이트 분리 ──
function updateStatusChips(data) {
    const kospiData = data.kospi ? { name: 'KOSPI', price: data.kospi.toLocaleString(), change: (data.kospi_chg >= 0 ? '+' : '') + data.kospi_chg.toFixed(2) + '%', up: data.kospi_chg >= 0 } : null;
    const kosdaqData = data.kosdaq ? { name: 'KOSDAQ', price: data.kosdaq.toLocaleString(), change: (data.kosdaq_chg >= 0 ? '+' : '') + data.kosdaq_chg.toFixed(2) + '%', up: data.kosdaq_chg >= 0 } : null;

    if (kospiData) {
        const chip = document.getElementById('chipKospi');
        if (chip) {
            const labelEl = chip.querySelector('.label');
            if (labelEl) labelEl.textContent = `${kospiData.name} ${kospiData.price}`;
            const chgEl = chip.querySelector('.change');
            if (chgEl) {
                chgEl.textContent = kospiData.change;
                chgEl.className = `change ${kospiData.up ? 'up' : 'down'}`;
            }
        }
    }
    if (kosdaqData) {
        const chip = document.getElementById('chipKosdaq');
        if (chip) {
            const labelEl = chip.querySelector('.label');
            if (labelEl) labelEl.textContent = `${kosdaqData.name} ${kosdaqData.price}`;
            const chgEl = chip.querySelector('.change');
            if (chgEl) {
                chgEl.textContent = kosdaqData.change;
                chgEl.className = `change ${kosdaqData.up ? 'up' : 'down'}`;
            }
        }
    }
}

// ── Fear & Greed 업데이트 분리 ──
function updateFearGreed(value) {
    const fgFill = document.getElementById('fgFill');
    const fgNeedle = document.getElementById('fgNeedle');
    const fgStatus = document.getElementById('fgStatus');
    const fgValue = document.getElementById('fgValue');

    if (fgFill && fgNeedle) {
        const needleRotation = (value / 100) * 180 - 90;
        fgNeedle.style.transform = `rotate(${needleRotation}deg)`;
        fgFill.style.transform = `rotate(${(value / 100) * 180}deg)`;
        
        if (fgValue) fgValue.textContent = value;
        if (fgStatus) {
            if (value < 25) fgStatus.textContent = 'Extreme Fear';
            else if (value < 45) fgStatus.textContent = 'Fear';
            else if (value < 55) fgStatus.textContent = 'Neutral';
            else if (value < 75) fgStatus.textContent = 'Greed';
            else fgStatus.textContent = 'Extreme Greed';
        }
    }
}

// ═══════════════════════════════════════════════════
// AI 캔들 패턴 분석 리포트
// ═══════════════════════════════════════════════════

async function fetchAnalysis(item) {
    const patternReportSection = document.getElementById('patternReportSection');
    const triggerContainer = document.getElementById('analysisTriggerContainer');
    const analysisLoading = document.getElementById('analysisLoading');

    if (triggerContainer) triggerContainer.style.display = 'none';
    if (patternReportSection) patternReportSection.classList.remove('hidden');
    
    if (analysisLoading) analysisLoading.classList.remove('hidden');
    // Important: Center and show only loading first
    const trendContainer = document.getElementById('trendContainer');
    if (trendContainer) trendContainer.style.display = 'none';
    
    document.getElementById('patternsCard').classList.add('hidden');
    document.getElementById('candleChartCard').classList.add('hidden');
    document.getElementById('reportGrid').classList.add('hidden');

    try {
        const url = `${API_BASE_URL}/api/analysis?code=${item.code}&market=${item.market}&name=${encodeURIComponent(item.name)}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error('분석 데이터를 불러오는데 실패했습니다.');
        
        const data = await response.json();
        
        // Cache in context
        if (isInWatchlist(item.code)) {
            if (watchlistStockContext.item && watchlistStockContext.item.code === item.code) {
                watchlistStockContext.analysis = data;
            }
        } else {
            if (homeStockContext.item && homeStockContext.item.code === item.code) {
                homeStockContext.analysis = data;
            }
        }

        if (analysisLoading) analysisLoading.classList.add('hidden');
        renderAnalysisReport(data);
    } catch (err) {
        console.error('fetchAnalysis error:', err);
        if (analysisLoading) analysisLoading.classList.add('hidden');
    }
}

async function updateTileData(code) {
    const statEl = document.getElementById(`tileStats-${code}`);
    if (!statEl) return;

    try {
        const res = await fetchWithTimeout(`${API_BASE_URL}/api/stock?code=${code}`);
        if (!res.ok) return;
        const data = await res.json();
        
        const change = data.change || 0;
        const pct = data.change_pct || 0;
        const isUp = change >= 0;
        
        statEl.innerHTML = `
            <div class="tile-price">${data.price?.toLocaleString() || '—'}</div>
            <div class="tile-pct ${isUp ? 'up' : 'down'}">${isUp ? '+' : ''}${pct}%</div>
        `;
    } catch (e) {
        statEl.innerHTML = '—';
    }
}

function renderAnalysisReport(data) {
    _lastAnalysisData = data;
    // ── Trend Badge ──
    const trendContainer = document.getElementById('trendContainer');
    if (trendContainer) trendContainer.style.display = 'flex';


    const trendBadge = document.getElementById('trendBadge');
    const trendIcon = document.getElementById('trendIcon');
    const trendLabel = document.getElementById('trendLabel');
    const trendFill = document.getElementById('trendStrengthFill');
    const trendText = document.getElementById('trendStrengthText');

    const trendConfig = {
        bullish: { icon: '🔥', cls: 'trend-bullish', color: '#ef4444' },
        bearish: { icon: '🧊', cls: 'trend-bearish', color: '#3b82f6' },
        neutral: { icon: '⚖️', cls: 'trend-neutral', color: '#6b7280' },
    };

    // Reset Classes
    const cfg = trendConfig[data.trend] || trendConfig.neutral;
    trendBadge.className = `trend-pill ${data.trend}`;
    trendIcon.textContent = cfg.icon;
    trendLabel.textContent = data.trend_label;
    trendFill.style.width = '0%';
    
    // Apply matching bar colors
    let barColor = 'rgba(107, 114, 128, 0.8)';
    if (data.trend === 'bullish') barColor = 'rgba(239, 68, 68, 0.8)';
    if (data.trend === 'bearish') barColor = 'rgba(59, 130, 246, 0.8)';
    trendFill.style.backgroundColor = barColor;

    trendFill.style.transition = 'width 1.2s cubic-bezier(0.25, 0.8, 0.25, 1) 0.1s';

    observeElement(trendFill, (el) => {
        el.style.width = `${data.trend_strength}%`;
    });

    trendText.textContent = `${data.trend_strength}%`;


    // ── Legacy UX Restore: Rating & Financials ──
    const ratingBarsContainer = document.getElementById('ratingBarsContainer');
    const financialsGrid = document.getElementById('financialsGrid');
    const ratingScoreVal = document.getElementById('ratingScoreVal');

    if (ratingBarsContainer && financialsGrid) {
        // Deterministic mock data logic leveraging simple hash of stock code
        const codeText = data.code || currentStock?.code || '005930';
        const hash = codeText.split('').reduce((a,b)=>a+b.charCodeAt(0),0);
        const rand = (min, max) => min + (hash % (max - min));
        
        const overallScore = (rand(60, 95) / 10).toFixed(1);
        ratingScoreVal.textContent = overallScore;

        const ratingLabels = ['수익성', '성장성', '안정성', '효율성', '시장평가'];
        const ratingGrades = ['부진', '보통', '양호', '우수', '매우 우수'];
        
        let barsHtml = '';
        ratingLabels.forEach((label, idx) => {
            const targetPct = Math.min(100, Math.max(30, rand(30, 100) + (idx * 5) - (hash % (10 + idx))));
            const gradeIdx = Math.floor((targetPct - 30) / 14);
            const grade = ratingGrades[Math.min(4, Math.max(0, gradeIdx))];
            
            barsHtml += `
            <div class="rating-bar-row">
                <span class="rating-label">${label}</span>
                <div class="rating-track">
                    <div class="rating-fill" data-target-width="${targetPct}"></div>
                </div>
                <span class="rating-value">${grade}</span>
            </div>`;
        });
        ratingBarsContainer.innerHTML = barsHtml;

        // Animate bars on scroll/view
        observeElement(ratingBarsContainer, (el) => {
            el.querySelectorAll('.rating-fill').forEach((fillEl, idx) => {
                fillEl.style.transitionDelay = `${idx * 0.1}s`;
                // trigger layout reflow before assigning width
                void fillEl.offsetWidth;
                fillEl.style.width = fillEl.getAttribute('data-target-width') + '%';
            });
        });

        // Financials Grid Mock
        const per = (rand(50, 250) / 10).toFixed(1) + 'x';
        const pbr = (rand(5, 30) / 10).toFixed(1) + 'x';
        const roe = (rand(1, 25)).toFixed(1) + '%';
        const debt = (rand(20, 180)) + '%';

        financialsGrid.innerHTML = `
            <div class="finance-box"><span class="finance-label">PER</span><span class="finance-val">${per}</span></div>
            <div class="finance-box"><span class="finance-label">PBR</span><span class="finance-val">${pbr}</span></div>
            <div class="finance-box"><span class="finance-label">ROE</span><span class="finance-val">${roe}</span></div>
            <div class="finance-box"><span class="finance-label">부채비율</span><span class="finance-val">${debt}</span></div>
        `;
    }

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
    if (localStorage.getItem('stockfinder-fund-enabled') !== 'false') {
        renderFundamentalReport(data.code || data.ticker || '');
    }

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

    // Reset visibility if in analysisSection
    const emptyState = document.getElementById('analysisEmptyState');
    const contentWrapper = document.getElementById('analysisContentWrapper');
    if (emptyState) emptyState.classList.add('hidden');
    if (contentWrapper) contentWrapper.classList.remove('hidden');

    // 스켈레톤 로딩 표시
    document.getElementById('fundSignalReason').textContent = '데이터 로딩 중…';
    const fundTypeBadge = document.getElementById('fundCompanyTypeBadge');
    const fundSignalBadge = document.getElementById('fundSignalBadge');
    if (fundTypeBadge) fundTypeBadge.textContent = '';
    if (fundSignalBadge) fundSignalBadge.textContent = '';
    
    document.getElementById('fundQuantContent').innerHTML = '<div class="fund-loading">분석 중…</div>';
    document.getElementById('fundEventContent').innerHTML = '<div class="fund-loading">공시 스캔 중…</div>';
    document.getElementById('fundMacroContent').innerHTML = '<div class="fund-loading">거시 조회 중…</div>';

    let d;
    try {
        const res = await fetchWithTimeout(API_BASE_URL + `/api/fundamental/${encodeURIComponent(stockCode)}`);
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
        ['부채비율', q.debt_ratio != null ? q.debt_ratio + '%' : '—'],
        ['연간 매출 성장', q.rev_growth != null ? (q.rev_growth > 0 ? '+' : '') + q.rev_growth + '%' : '—'],
        ['분기 매출 성장', q.qtr_growth != null ? (q.qtr_growth > 0 ? '+' : '') + q.qtr_growth + '%' : '—'],
    ];
    const scoreColor = q.score >= 75 ? '#ef4444' : q.score >= 55 ? '#f59e0b' : '#3b82f6';
    document.getElementById('fundQuantContent').innerHTML = `
        <div class="prob-two-col" style="background:transparent; padding:0; gap:20px;">
            <div class="prob-left-col" style="flex:0 0 140px; border:none; padding-right:0;">
                <div class="fund-score-wrap" style="margin-bottom:10px;">
                    <div class="fund-score-num" style="color:${scoreColor}; font-size:2.2rem;">${q.score ?? '—'}</div>
                    <div class="fund-score-grade" style="color:${scoreColor}; font-size:1rem;">${q.grade ?? ''}</div>
                </div>
                <div class="fund-score-bar-bg" style="height:6px; width:100%;">
                    <div class="fund-score-bar" style="width:${Math.min(q.score ?? 0, 100)}%;background:${scoreColor}"></div>
                </div>
            </div>
            <div class="prob-right-col">
                <table class="fund-metric-table">
                    ${qRows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}
                </table>
            </div>
        </div>
        <div class="fund-score-desc" style="font-size:0.85rem; color:var(--text-color); margin-top:14px; background:rgba(255,255,255,0.05); padding:10px; border-radius:8px;">
            ${q.score >= 75 ? '🔥 <b>매우 우수</b> - 안정적이고 강력한 펀더멘탈' : q.score >= 55 ? '✅ <b>평균 이상</b> - 투자하기 무난한 양호한 재무 상태' : '⚠️ <b>기준 미달</b> - 재무 리스크가 있으므로 주의 필요'}
        </div>
        <div class="fund-period-note" style="margin-top:8px;">${q.period || ''} ${q.qtr_period ? '/ ' + q.qtr_period : ''}</div>`;

    // ── Event-Driven 축 ──
    const evts = d.events || [];
    if (evts.length === 0) {
        document.getElementById('fundEventContent').innerHTML =
            '<div class="fund-no-data">최근 30일 주요 공시 없음</div>';
    } else {
        document.getElementById('fundEventContent').innerHTML = `
            <div class="prob-two-col" style="background:transparent; padding:0; gap:20px; align-items:flex-start;">
                <div class="prob-left-col" style="flex:0 0 100px; border:none; padding-right:0; align-items:center;">
                    <div style="font-size:2.5rem; margin-bottom:8px;">📢</div>
                    <div style="font-size:0.85rem; color:var(--text-muted); font-weight:700;">공시 분석</div>
                </div>
                <div class="prob-right-col" style="display:flex; flex-direction:column; gap:8px; width:100%;">
                    ${evts.map(ev => `
                    <div class="fund-event-item fund-event-${ev.signal}" style="width:100%;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                            <span class="fund-event-label">${ev.label}</span>
                            <span class="fund-event-date" style="font-size:0.75rem;">${ev.date ? ev.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1.$2.$3') : ''}</span>
                        </div>
                        <div class="fund-event-title" title="${ev.title}" style="font-size:0.88rem; font-weight:500;">${ev.title.length > 35 ? ev.title.slice(0, 35) + '…' : ev.title}</div>
                    </div>`).join('')}
                </div>
            </div>`;
    }

    // ── Macro 축 ──
    const m = d.macro || {};
    const macroItems = [];
    if (m.usd_krw) macroItems.push(['USD/KRW', `${m.usd_krw.toLocaleString()}`, m.usd_krw_chg != null ? (m.usd_krw_chg >= 0 ? '+' : '') + m.usd_krw_chg + '%' : null]);
    if (m.nasdaq) macroItems.push(['나스닥 지수', `${m.nasdaq.toLocaleString()}`, m.nasdaq_chg != null ? (m.nasdaq_chg >= 0 ? '+' : '') + m.nasdaq_chg + '%' : null]);
    if (m.us10y) macroItems.push(['미 국채 10년물', `${m.us10y}%`, m.us10y_chg != null ? (m.us10y_chg >= 0 ? '+' : '') + m.us10y_chg + 'p' : null]);
    if (m.vix) macroItems.push(['VIX 공포지수', `${m.vix}`, m.vix_chg != null ? (m.vix_chg >= 0 ? '+' : '') + m.vix_chg + '%' : null]);

    if (macroItems.length === 0) {
        document.getElementById('fundMacroContent').innerHTML = '<div class="fund-no-data">데이터 로드 실패</div>';
    } else {
        document.getElementById('fundMacroContent').innerHTML = `
            <div class="prob-two-col" style="background:transparent; padding:0; gap:20px;">
                <div class="prob-left-col" style="flex:0 0 100px; border:none; padding-right:0; align-items:center;">
                    <div style="font-size:2.5rem; margin-bottom:8px;">🌐</div>
                    <div style="font-size:0.85rem; color:var(--text-muted); font-weight:700;">거시 경제</div>
                </div>
                <div class="prob-right-col" style="display:flex; flex-direction:column; gap:6px; width:100%;">
                    ${macroItems.map(([k, v, chg]) => {
                        const chgHtml = chg ? `<span class="fund-macro-chg ${parseFloat(chg) >= 0 ? 'fund-pos' : 'fund-neg'}" style="font-size:0.75rem; margin-left:6px;">${chg}</span>` : '';
                        return `<div class="fund-macro-row" style="display:flex; justify-content:space-between; border-bottom:1px solid rgba(255,255,255,0.05); padding-bottom:4px;"><span class="fund-macro-key" style="font-size:0.85rem;">${k}</span><span class="fund-macro-val" style="font-weight:600; font-size:0.9rem;">${v}${chgHtml}</span></div>`;
                    }).join('')}
                </div>
            </div>`;
    }

    // ── 사용 축 태그 ──
    const axes = d.axes_used || [];
    document.getElementById('fundAxesUsed').innerHTML =
        axes.map(a => `<span class="fund-axis-tag">${a}</span>`).join('');

    // Cache in context
    if (isInWatchlist(stockCode)) {
        if (watchlistStockContext.item && (watchlistStockContext.item.code === stockCode || watchlistStockContext.item.ticker === stockCode)) {
            watchlistStockContext.fundamental = d;
        }
    } else {
        if (homeStockContext.item && (homeStockContext.item.code === stockCode || homeStockContext.item.ticker === stockCode)) {
            homeStockContext.fundamental = d;
        }
    }
}

function renderAiInsights(data) {
    const container = document.getElementById('aiInsightsCard');
    const body = document.getElementById('aiInsightsBody');
    if (!container || !body) return;

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
            { label: 'MA배열', val: bd.ma_alignment ?? 0, max: 35 },
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
        <div class="ai-insight-row">
            <div class="ai-row-label">
                <i class="ph ph-target"></i>
                <span>매수 확률</span>
            </div>
            <div class="ai-row-primary">
                <div class="ai-gauge-mini">
                    <svg viewBox="0 0 100 100" width="60" height="60">
                        <circle cx="50" cy="50" r="40" fill="none" stroke="var(--border-soft)" stroke-width="12"/>
                        <circle cx="50" cy="50" r="40" fill="none" stroke="${scoreColor}" stroke-width="12"
                            stroke-dasharray="251" stroke-dashoffset="${dashOffset}"
                            stroke-linecap="round" transform="rotate(-90 50 50)"/>
                        <text x="50" y="55" text-anchor="middle" font-size="24" font-weight="800" fill="var(--text-main)">${score}</text>
                    </svg>
                    <span class="ai-gauge-text" style="color:${scoreColor}">${prob.label}</span>
                </div>
            </div>
            <div class="ai-row-details">
                <div class="ai-breakdown-container">
                    ${breakdownBars}
                </div>
            </div>
            <div class="ai-row-insight">
                <span>주가 방향성, 탄력, 추세 강도 및 거래량 가중 합산 결과입니다. 캔들 패턴 보너스(+/-5%) 포함.</span>
            </div>
        </div>`;
    }

    // ── 2. ATR 목표가/손절가 ──
    let atrHtml = '';
    if (atr) {
        const rrColor = (atr.rr_ratio ?? 0) >= 1.5 ? '#10b981' : '#f59e0b';
        atrHtml = `
        <div class="ai-insight-row">
            <div class="ai-row-label">
                <i class="ph ph-chart-line"></i>
                <span>목표 / 손절</span>
            </div>
            <div class="ai-row-primary">
                <div class="ai-price-pill-group">
                    <div class="price-pill green">
                        <span class="pill-label">Target</span>
                        <span class="pill-val">${atr.target?.toLocaleString()}</span>
                    </div>
                    <div class="price-pill red">
                        <span class="pill-label">Stop</span>
                        <span class="pill-val">${atr.stop_loss?.toLocaleString()}</span>
                    </div>
                </div>
            </div>
            <div class="ai-row-details">
                <div class="ai-ratio-box" style="color:${rrColor}">
                    <span class="ratio-label">R:R Ratio</span>
                    <span class="ratio-val">1 : ${atr.rr_ratio}</span>
                </div>
            </div>
            <div class="ai-row-insight">
                <span>ATR ${atr.atr?.toLocaleString()}원 기반. 변동성의 2배를 목표로, 1배를 손절로 설정한 기계적 전략입니다.</span>
            </div>
        </div>`;
    }

    // ── 3. 이상 거래량 배지 ──
    let volHtml = '';
    if (vol) {
        const levelClass = vol.level !== 'normal' ? `vol-${vol.level}` : '';
        const dirIcon = vol.direction === 'up' ? '🔴' : '🔵';
        volHtml = `
        <div class="ai-insight-row">
            <div class="ai-row-label">
                <i class="ph ph-wave-sine"></i>
                <span>거래량 이상</span>
            </div>
            <div class="ai-row-primary">
                <div class="status-pill premium ${vol.level}">
                    <span>${vol.label}</span>
                </div>
            </div>
            <div class="ai-row-details">
                <div class="ai-stats-row">
                    <div class="stat-unit">
                        <span class="unit-label">Ratio</span>
                        <span class="unit-val">${vol.ratio}x</span>
                    </div>
                    <div class="stat-unit">
                        <span class="unit-label">Z-Score</span>
                        <span class="unit-val">${vol.zscore}</span>
                    </div>
                </div>
            </div>
            <div class="ai-row-insight">
                <span>평소 대비 20일 거래량 이탈 분석. ${vol.direction === 'up' ? '매수세 가담' : '매도세 출현'} 신호 감지.</span>
            </div>
        </div>`;
    }

    body.innerHTML = `
        <div class="ai-widget-title">AI 인지형 투자 매력도</div>
        <div class="ai-insight-grid">
            ${probHtml}
            ${atrHtml}
            ${volHtml}
        </div>
    `;

    // ── 4. 사이클 타임 예측 (펀더멘탈 내부 컨테이너로 렌더링) ──
    const cyc = data.cycle_estimation;
    const cycContainer = document.getElementById('cycleWidgetContainer');
    const cycBody = document.getElementById('cycleWidgetBody');
    if (cyc && cycContainer && cycBody) {
        const isBullish = cyc.current_phase && cyc.current_phase.includes('상승');
        const isBearish = cyc.current_phase && cyc.current_phase.includes('하락');
        const phaseColor = isBullish ? '#ef4444' : (isBearish ? '#3b82f6' : '#f59e0b');
        const confLabel = cyc.confidence === 'high' ? '높음'
            : cyc.confidence === 'medium' ? '보통' : '낮음';
        const confColor = cyc.confidence === 'high' ? '#ef4444'
            : cyc.confidence === 'medium' ? '#f59e0b' : '#3b82f6';

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
            <div class="ai-widget-title">사이클 타임 예측 (변곡점 타이밍)</div>
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
        </div>

        <!-- 사이클 타임라인 차트 (현재 사이클 요약 바로 위) -->
        <div id="cycleTimelineChart" style="margin-top: 16px; margin-bottom: 12px;"></div>

            <!-- 사이클 상세 설명 -->
            <div class="cyc-desc-box">
                <div class="cyc-desc-item summary">
                    <strong>💡 현재 사이클 요약:</strong><br/>
                    현재 다음 변곡점(추세가 꺾이는 지점) 도달까지 <strong>${cyc.progress}% 진행</strong>되었으며, 주식 시장이 열리는 날 기준으로 <strong>약 ${cyc.est_remaining_days}일</strong> 정도 남은 것으로 추정됩니다. 과거 주기의 평균이 <strong>${cyc.avg_cycle_days}일</strong>이므로, 이 추세라면 다음 변곡점은 대략 <strong>${cyc.est_next_peak_date ? cyc.est_next_peak_date : '조만간'}</strong>에 나타날 가능성이 높습니다.
                </div>
                <div class="cyc-desc-item">
                    <strong>[진행률] 및 [잔여 거래일]:</strong> 과거 평균을 기준으로 다음 곡점(변곡점)이 오기까지 전체 주기 중 현재 몇 % 지점인지(진행률), 그리고 앞으로 주식 시장이 열리는 날 기준으로 며칠이 남았는지(잔여 거래일)를 알려주는 <strong>'타이밍'</strong> 지표입니다.
                </div>
                <div class="cyc-desc-item">
                    <strong>[예상 도달일] 및 [사이클 통계]:</strong> 주말과 공휴일을 제외하고 계산된 실제 다음 변곡점의 캘린더 날짜(예상 도달일)입니다. '사이클 통계'의 평균은 과거 주기의 평균 일수, 경과는 최근 고점부터 지금까지 지난 일수입니다.
                </div>
                <div class="cyc-desc-item">
                    <strong>사이클 감지 횟수 및 감지 강도:</strong> 과거 차트에서 주기적인 상승/하락 패턴이 몇 번이나 반복되었는지 보여주는 <strong>'감지 횟수'</strong>입니다. 이 횟수가 많을수록 데이터의 표본이 많다는 뜻입니다.
                </div>
                <div class="cyc-desc-item">
                    <strong>[상승/하락] 및 [신뢰도]:</strong> 현재 주가가 고점을 향하고 있는지(상승), 저점을 향하고 있는지(하락)를 나타냅니다. <strong>'신뢰도(높음/보통/낮음)'</strong>는 과거 사이클의 기간 길이나 변동폭이 얼마나 일정했는지를 분석한 결과입니다. 예를 들어 <strong>'하락 신뢰도: 낮음'</strong>이라면 "현재 단기적으로 하락 사이클을 타고 있긴 하지만, 과거 패턴의 주기 편차가 심해서 도착 예정일의 오차가 클 수 있으니 주의하라"는 의미입니다.
                </div>
                <div class="cyc-desc-item">
                    <strong>변수 보정 (피보나치, 저항선, 투자심리):</strong> 단순 일수 계산을 넘어, 황금비율(피보나치 타임존), 마디 가격(ex: 5만원, 10만원) 돌파 대기 시간, 그리고 거래량 폭주와 인간의 탐욕/공포(RSI)로 인한 속도 가속화 현상을 모두 자동 계산해 도달일을 정밀 예측합니다.
                </div>
            </div>
        </div>`;

        cycBody.innerHTML = cycHtml;
        cycContainer.classList.remove('hidden');

        // ── 📊 Dedicated Cycle Timeline SVG Chart ──
        renderCycleTimelineChart(cyc);
    } else if (cycContainer) {
        cycContainer.classList.add('hidden');
        if (cycBody) cycBody.innerHTML = '';
    }
}


function renderCycleTimelineChart(cyc) {
    const container = document.getElementById('cycleTimelineChart');
    if (!container || !cyc) return;

    const history = cyc.cycle_history || [];
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const textFill = isLight ? '#64748b' : '#94a3b8';
    const lineFill = isLight ? '#cbd5e1' : '#334155';
    const isBearish = cyc.current_phase && cyc.current_phase.includes('하락');
    const phaseColor = isBearish ? '#3b82f6' : '#ef4444';
    const futureColor = isBearish ? '#3b82f6' : '#ef4444';

    // Build timeline data points: past peaks + current + projected future
    const points = [];

    // Past cycle peaks from history
    history.forEach(h => {
        if (h.peak_date) points.push({ date: h.peak_date.slice(5), label: h.peak_date.slice(5), days: h.days, type: 'past' });
    });
    // Add the last peak from history's next_peak_date
    if (history.length > 0) {
        const lastH = history[history.length - 1];
        if (lastH.next_peak_date) {
            points.push({ date: lastH.next_peak_date.slice(5), label: lastH.next_peak_date.slice(5), days: null, type: 'last_peak' });
        }
    }
    // Current position (today)
    const today = new Date().toISOString().slice(5, 10);
    points.push({ date: today, label: '현재', days: cyc.days_since_peak, type: 'current' });

    // Future projected turning point
    if (cyc.est_remaining_days > 0 && cyc.est_next_peak_date) {
        points.push({ date: cyc.est_next_peak_date.slice(5), label: cyc.est_next_peak_date.slice(5), days: cyc.est_remaining_days, type: 'future' });
    }

    const count = points.length;
    if (count < 2) { container.innerHTML = ''; return; }

    // SVG Layout
    const padL = 50, padR = 50, padTop = 35, padBot = 40;
    const parentW = document.getElementById('cycleWidgetContainer')?.clientWidth || 0;
    const svgW = Math.max(parentW - 32, container.clientWidth || 400); 
    const svgH = 150;
    const lineY = padTop + 25;
    const usableW = svgW - padL - padR;
    const stepW = usableW / (count - 1);

    let html = `<svg width="100%" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" style="display:block;">`;

    // Draw horizontal baseline
    html += `<line x1="${padL}" y1="${lineY}" x2="${svgW - padR}" y2="${lineY}" stroke="${lineFill}" stroke-width="2"/>`;

    // Find the index where future zone starts (between "current" and "future")
    const currentIdx = points.findIndex(p => p.type === 'current');
    const futureIdx = points.findIndex(p => p.type === 'future');

    // Draw future shaded zone
    if (futureIdx >= 0 && currentIdx >= 0) {
        const curX = padL + currentIdx * stepW;
        const futX = padL + futureIdx * stepW;
        html += `<rect x="${curX}" y="${padTop}" width="${futX - curX}" height="50" rx="6" fill="${futureColor}" opacity="0.12"/>`;
        html += `<line x1="${futX}" y1="${padTop}" x2="${futX}" y2="${padTop + 50}" stroke="${futureColor}" stroke-width="2.5" stroke-dasharray="5,4" opacity="0.8"/>`;
    }

    // Draw connecting lines between each consecutive past/last_peak points
    points.forEach((p, i) => {
        if (i === 0) return;
        const x1 = padL + (i - 1) * stepW;
        const x2 = padL + i * stepW;
        const segColor = p.type === 'future' ? futureColor : (p.type === 'current' ? phaseColor : lineFill);
        const dash = p.type === 'future' ? 'stroke-dasharray="6,5"' : '';
        const opacity = p.type === 'future' ? '0.6' : '0.9';
        html += `<line x1="${x1}" y1="${lineY}" x2="${x2}" y2="${lineY}" stroke="${segColor}" stroke-width="3.5" ${dash} opacity="${opacity}"/>`;
    });

    // Draw dots & labels
    points.forEach((p, i) => {
        const cx = padL + i * stepW;

        if (p.type === 'current') {
            // Pulsing current position dot
            html += `<circle cx="${cx}" cy="${lineY}" r="9" fill="${phaseColor}" opacity="0.25"><animate attributeName="r" values="9;12;9" dur="2s" repeatCount="indefinite"/></circle>`;
            html += `<circle cx="${cx}" cy="${lineY}" r="6" fill="${phaseColor}" stroke="#fff" stroke-width="2"/>`;
            html += `<text x="${cx}" y="${lineY - 18}" text-anchor="middle" fill="${phaseColor}" font-size="11" font-weight="800">현재 (D-${cyc.est_remaining_days})</text>`;
        } else if (p.type === 'future') {
            // Target dot
            html += `<circle cx="${cx}" cy="${lineY}" r="8" fill="none" stroke="${futureColor}" stroke-width="3" stroke-dasharray="4,3"/>`;
            html += `<circle cx="${cx}" cy="${lineY}" r="3" fill="${futureColor}"/>`;
            html += `<text x="${cx}" y="${lineY - 18}" text-anchor="middle" fill="${futureColor}" font-size="11" font-weight="800">🎯 변곡점</text>`;
        } else {
            // Past peak dot (solid)
            html += `<circle cx="${cx}" cy="${lineY}" r="5" fill="${lineFill}" stroke="${isLight ? '#94a3b8' : '#475569'}" stroke-width="2"/>`;
        }

        // Date label below
        html += `<text x="${cx}" y="${lineY + 30}" text-anchor="middle" fill="${textFill}" font-size="10" font-weight="600">${p.label}</text>`;

        // Days between peaks (show above connecting line)
        if (i > 0 && p.days != null && p.type !== 'current') {
            const midX = padL + (i - 0.5) * stepW;
            const textColor = p.type === 'future' ? futureColor : textFill;
            html += `<text x="${midX}" y="${lineY - 12}" text-anchor="middle" fill="${textColor}" font-size="10" font-weight="700">${p.days}일</text>`;
        }
    });

    // Chart title
    html += `<text x="${padL}" y="18" fill="${textFill}" font-size="12" font-weight="800">📈 사이클 타임라인</text>`;
    html += `<text x="${svgW - padR}" y="14" fill="${textFill}" font-size="9" text-anchor="end">평균 ${cyc.avg_cycle_days}일 · ${cyc.cycles_detected}개 사이클</text>`;

    html += '</svg>';
    container.innerHTML = html;
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
        if (c.ma20 != null) prices.push(c.ma20);
        if (c.ma60 != null) prices.push(c.ma60);
        if (c.ma120 != null) prices.push(c.ma120);
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

    // ── Support & Resistance Lines (Phase 2 Layout) ──
    const highestC = Math.max(...candles.map(c => c.high));
    const lowestC = Math.min(...candles.map(c => c.low));
    const resY = toY(highestC);
    const supY = toY(lowestC);

    html += `<line x1="10" y1="${resY}" x2="${svgW - 50}" y2="${resY}" stroke="rgba(239, 68, 68, 0.8)" stroke-width="1.5" stroke-dasharray="4,4" opacity="0.8"/>`;
    html += `<text x="${svgW - 10}" y="${resY + 4}" text-anchor="end" fill="rgba(239, 68, 68, 0.9)" font-size="10" font-weight="700">저항선</text>`;

    html += `<line x1="10" y1="${supY}" x2="${svgW - 50}" y2="${supY}" stroke="rgba(59, 130, 246, 0.8)" stroke-width="1.5" stroke-dasharray="4,4" opacity="0.8"/>`;
    html += `<text x="${svgW - 10}" y="${supY + 4}" text-anchor="end" fill="rgba(59, 130, 246, 0.9)" font-size="10" font-weight="700">지지선</text>`;

    // ── Moving Average lines (Phase 2 Colors & MA120) ──
    const maConfigs = [
        { key: 'ma5', color: '#F59E0B', label: '5일선' },
        { key: 'ma20', color: '#EC4899', label: '20일선' },
        { key: 'ma60', color: '#14B8A6', label: '60일선' },
        { key: 'ma120', color: '#8B5CF6', label: '120일선' }
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

    // ── Resistance & Support Lines (Phase 2 - Attachment 4) ──
    const resistPrice = maxP * 0.98;
    const supportPrice = minP * 1.02;
    
    html += `<line x1="0" y1="${toY(resistPrice)}" x2="${svgW}" y2="${toY(resistPrice)}" 
                stroke="#ef4444" stroke-width="1" stroke-dasharray="4,4" stroke-opacity="0.6" />`;
    html += `<text x="${svgW - 45}" y="${toY(resistPrice) - 5}" fill="#ef4444" font-size="10" font-weight="600">저항선</text>`;

    html += `<line x1="0" y1="${toY(supportPrice)}" x2="${svgW}" y2="${toY(supportPrice)}" 
                stroke="#3b82f6" stroke-width="1" stroke-dasharray="4,4" stroke-opacity="0.6" />`;
    html += `<text x="${svgW - 45}" y="${toY(supportPrice) + 12}" fill="#3b82f6" font-size="10" font-weight="600">지지선</text>`;

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
        el.querySelectorAll('.vol-group').forEach(vg => {
            vg.style.transform = 'scaleY(1)';
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

    const now = new Date();
    const timeStr = `${now.getMonth() + 1}월 ${now.getDate()}일 ${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')} 분석`;
    const timeEl = document.getElementById('buyReportTime');
    if (timeEl) timeEl.textContent = timeStr;

    document.getElementById('buySignalBadge').textContent = `${report.signal_strength}%`;
    document.getElementById('buyPattern').textContent = report.primary_pattern;
    document.getElementById('buyDesc').textContent = report.primary_pattern_desc;
    document.getElementById('buyAggressive').textContent = formatPrice(report.aggressive_entry);
    document.getElementById('buyConservative').textContent = formatPrice(report.conservative_entry);
    document.getElementById('buyTarget').textContent = formatPrice(report.target_price);
    document.getElementById('buyStopLoss').textContent = formatPrice(report.stop_loss);
    document.getElementById('buyRiskReward').textContent = report.risk_reward;
    document.getElementById('buyVolume').innerHTML = `<i class="ph ph-chart-bar"></i> ${report.volume_note}`;
    document.getElementById('buyTip').innerHTML = `<i class="ph ph-lightbulb"></i> ${report.entry_tip}`;
    return true;
}

function renderSellReport(report, atrTargets) {
    const card = document.getElementById('sellReport');
    if (!report) {
        card.classList.add('hidden');
        return false;
    }
    card.classList.remove('hidden');

    const now = new Date();
    const timeStr = `${now.getMonth() + 1}월 ${now.getDate()}일 ${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')} 분석`;
    const timeEl = document.getElementById('sellReportTime');
    if (timeEl) timeEl.textContent = timeStr;

    document.getElementById('sellSignalBadge').textContent = `${report.signal_strength}%`;
    document.getElementById('sellPattern').textContent = report.primary_pattern;
    document.getElementById('sellDesc').textContent = report.primary_pattern_desc;
    document.getElementById('sellPrice').textContent = formatPrice(report.sell_price);
    document.getElementById('sellConservative').textContent = formatPrice(report.conservative_sell);
    document.getElementById('sellTarget').textContent = formatPrice(report.target_price);
    document.getElementById('sellStopLoss').textContent = formatPrice(report.stop_loss);
    document.getElementById('sellRiskReward').textContent = report.risk_reward;
    document.getElementById('sellVolume').innerHTML = `<i class="ph ph-chart-bar"></i> ${report.volume_note}`;
    document.getElementById('sellTip').innerHTML = `<i class="ph ph-lightbulb"></i> ${report.exit_tip}`;

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

// _lastAnalysisData handled at top

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
function startApp() {
    console.log('[DEBUG] startApp() executing. readyState:', document.readyState);
    
    initTheme();

    if (searchInput) {
        searchInput.focus();
    } else {
        console.warn('[DEBUG] searchInput not found during init');
    }

    document.getElementById('themeToggle')?.addEventListener('click', toggleTheme);
    renderRecentSearches();
    document.getElementById('clearRecent')?.addEventListener('click', clearRecentSearches);

    // Watchlist & Macro init
    renderWatchlist();
    renderMacroIndicators();
    updateWatchlistBtn();

    // Unified Favorite Button Listener (for all sections)
    document.addEventListener('click', (e) => {
        const favBtn = e.target.closest('.favorite-btn');
        if (favBtn) {
            e.preventDefault();
            if (!currentStock) return;
            if (isInWatchlist(currentStock.code)) {
                removeFromWatchlist(currentStock.code);
            } else {
                addToWatchlist(currentStock);
            }
        }
    });

    // Sidebar pin/toggle init
    applySidebarPinState();
    document.getElementById('sidebarPinBtn')?.addEventListener('click', () => {
        setSidebarPinned(!isSidebarPinned());
    });
    document.getElementById('sidebarToggle')?.addEventListener('click', toggleSidebarOpen);
    document.getElementById('sidebarOverlay')?.addEventListener('click', closeSidebar);

    // Core UI Init
    initNavigation();
    initMobileSidebar();

    // Search Button Listener (Moved outside initNavigation for robustness)
    const searchBtn = document.getElementById('searchBtn');
    searchBtn?.addEventListener('click', () => {
        const query = searchInput.value.trim();
        if (query.length > 0) {
            if (activeIndex >= 0 && suggestItems[activeIndex]) {
                selectStock(suggestItems[activeIndex]);
            } else if (suggestItems.length > 0) {
                selectStock(suggestItems[0]);
            } else {
                fetchSuggestions(query).then(() => {
                    if (suggestItems.length > 0) selectStock(suggestItems[0]);
                });
            }
        }
    });

    // Enter Key Search
    searchInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && activeIndex === -1) {
            searchBtn?.click();
        }
    });

    // Auth & Session Init
    initAuth();
}

if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', startApp);
} else {
    startApp();
}

// ── Auth & User Session ──
async function initAuth() {
    const authModalOverlay = document.getElementById('authModalOverlay');
    const authModal = document.getElementById('authModal');
    const closeAuthModal = document.getElementById('closeAuthModal');

    // Sidebar Auth Elements
    const sidebarUserSection = document.getElementById('sidebarUserSection');
    const sidebarLogoutBtn = document.getElementById('sidebarLogoutBtn');

    const googleAuthBtn = document.getElementById('googleAuthBtn');
    const authForm = document.getElementById('authForm');
    const authSubmitBtn = document.getElementById('authSubmitBtn');
    const authSwitchBtn = document.getElementById('authSwitchBtn');
    const authSwitchText = document.getElementById('authSwitchText');
    const authModalTitle = document.getElementById('authModalTitle');
    const authErrorMsg = document.getElementById('authErrorMsg');

    // OAuth Confirmation Elements
    const oauthConfirmOverlay = document.getElementById('oauthConfirmOverlay');
    const oauthConfirmModal = document.getElementById('oauthConfirmModal');
    const oauthCancelBtn = document.getElementById('oauthCancelBtn');
    const oauthContinueBtn = document.getElementById('oauthContinueBtn');

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

    sidebarUserSection?.addEventListener('click', () => {
        if (!authUser || !authUser.logged_in) showModal();
    });

    closeAuthModal?.addEventListener('click', hideModal);
    authModalOverlay?.addEventListener('click', hideModal);

    sidebarLogoutBtn?.addEventListener('click', async () => {
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
    googleAuthBtn?.addEventListener('click', async () => {
        if (!sbClient) { alert('구글 로그인을 사용할 수 없습니다.'); return; }
        if (oauthConfirmOverlay && oauthConfirmModal) {
            hideModal();
            oauthConfirmOverlay.classList.add('active');
            oauthConfirmModal.classList.add('active');
        }
    });

    oauthCancelBtn?.addEventListener('click', () => {
        oauthConfirmOverlay.classList.remove('active');
        oauthConfirmModal.classList.remove('active');
        showModal();
    });

    oauthContinueBtn?.addEventListener('click', async () => {
        if (!sbClient) { alert('구글 로그인을 사용할 수 없습니다.'); return; }
        try {
            if (oauthContinueBtn) {
                oauthContinueBtn.disabled = true;
                oauthContinueBtn.style.opacity = '0.7';
            }
            const redirectTo = window.location.origin + '/callback.html';
            const { error } = await sbClient.auth.signInWithOAuth({
                provider: 'google',
                options: { redirectTo }
            });
            if (error) throw error;
            // Supabase redirects the browser — nothing more to do here
        } catch (err) {
            alert('Google 로그인 오류: ' + (err.message || '알 수 없는 오류'));
            oauthConfirmOverlay?.classList.remove('active');
            oauthConfirmModal?.classList.remove('active');
        } finally {
            if (oauthContinueBtn) {
                oauthContinueBtn.disabled = false;
                oauthContinueBtn.style.opacity = '1';
            }
        }
    });

    // ── 로그인 ↔ 회원가입 전환 ──
    authSwitchBtn?.addEventListener('click', () => {
        isLoginMode = !isLoginMode;
        if (authModalTitle) authModalTitle.textContent = isLoginMode ? '로그인' : '회원가입';
        if (authSubmitBtn) authSubmitBtn.textContent = isLoginMode ? '로그인' : '회원가입';
        if (authSwitchText) authSwitchText.textContent = isLoginMode ? '아직 계정이 없으신가요?' : '이미 계정이 있으신가요?';
        if (authSwitchBtn) authSwitchBtn.textContent = isLoginMode ? '회원가입' : '로그인';
        if (authErrorMsg) authErrorMsg.textContent = '';
    });

    // ── 로그인/회원가입 폼 ──
    authForm?.addEventListener('submit', async (e) => {
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

    const updateAuthUI = () => {
        const userNameEl = document.getElementById('sidebarUserName');
        const userStatusEl = document.getElementById('sidebarUserStatus');
        const navWatchlist = document.getElementById('navWatchlist');
        const addWatchlistBtnContainer = document.getElementById('addWatchlistBtnContainer');
        const pageGreeting = document.getElementById('pageGreeting');

        console.log('[DEBUG] updateAuthUI - logged_in:', authUser?.logged_in);
        if (authUser && authUser.logged_in) {
            console.log('[DEBUG] updateAuthUI - Updating UI for Logged In User');
            if (userNameEl) userNameEl.textContent = authUser.username ? `Hello, ${authUser.username}` : 'Hello, User';
            if (userStatusEl) userStatusEl.textContent = '로그인됨';
            if (pageGreeting) pageGreeting.textContent = authUser.username ? `Hello, ${authUser.username} 🕊️` : 'Hello, User 🕊️';
            
            if (sidebarLogoutBtn) sidebarLogoutBtn.classList.remove('hidden');
            if (sidebarUserSection) {
                sidebarUserSection.style.cursor = 'default';
                sidebarUserSection.title = "사용자 정보";
            }

            // Watchlist is always visible
            if (navWatchlist) {
                navWatchlist.classList.remove('hidden');
            }
            if (addWatchlistBtnContainer) addWatchlistBtnContainer.classList.remove('remove');
            
            // Update UI count
            updateWatchlistCount();
        } else {
            console.log('[DEBUG] updateAuthUI - Updating UI for Guest');
            if (userNameEl) userNameEl.textContent = 'Guest';
            if (userStatusEl) userStatusEl.textContent = '로그인이 필요합니다';
            if (pageGreeting) pageGreeting.textContent = 'Hello, Signnith 🕊️';
            
            if (sidebarLogoutBtn) sidebarLogoutBtn.classList.add('hidden');
            if (sidebarUserSection) {
                sidebarUserSection.style.cursor = 'pointer';
                sidebarUserSection.title = "로그인하려면 클릭하세요";
            }

            // Watchlist is always visible
            if (navWatchlist) navWatchlist.classList.remove('hidden');
            if (addWatchlistBtnContainer) addWatchlistBtnContainer.classList.remove('hidden');
            
            // For Guest users, reset currentWatchlist to empty as requested
            currentWatchlist = [];
            renderWatchlist();
            updateWatchlistCount();
        }
    };

    // 서버에서 세션(및 관심종목) 가져오기 — /api/session 으로 1회 호출
    const fetchUserSession = async () => {
        try {
            const token = getSupaToken();
            console.log('Fetching session from:', API_BASE_URL + '/api/session');
            const res = await fetchWithTimeout(API_BASE_URL + '/api/session', {
                headers: token ? { 'Authorization': `Bearer ${token}` } : {}
            });
            console.log('Session response status:', res.status);
            const data = await res.json();
            console.log('Session data:', data);

            // authUser 형식 유지 (logged_in, username)
            authUser = { logged_in: data.logged_in, username: data.username };

            if (data.logged_in && data.watchlist) {
                currentWatchlist = data.watchlist;
                saveWatchlist(currentWatchlist);
            }

        } catch (error) {
            console.warn("Session check failed", error);
        }
        updateAuthUI();
    };

    // 로드 시 초기 세션 확인
    await fetchUserSession();
}
