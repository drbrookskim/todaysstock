
const API_BASE_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname === '') 
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
        console.error(`[DEBUG] fetchWithTimeout Error (${resource}):`, error);
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

// ── 클라이언트 측 종목 캐시 (stocks.json 로드 후 즉시 검색용) ──
let _stocksCache = [];

(async function _loadStocksCache() {
    try {
        const r = await fetch('./static/stocks.json');
        if (r.ok) {
            _stocksCache = await r.json();
            console.log(`[Stocks] 클라이언트 캐시 로드 완료: ${_stocksCache.length}개`);
        }
    } catch (e) {
        console.warn('[Stocks] stocks.json 로드 실패 — 서버 API 사용:', e);
    }
})();
let currentWatchlist = [];
let currentIndexChart = null; // Lightweight Chart instance
let currentStock = null;
let _lastAnalysisData = null;
let sectionScrollPositions = {};
let currentActiveSectionId = 'dashboardHome'; // Track currently visible section
let currentChartDrawType = 'standard'; // Default to Standard Candle
window.setChartType = function(type) {
    currentChartDrawType = type;
    document.getElementById('btnChartStandard').classList.remove('active');
    document.getElementById('btnChartHeikin').classList.remove('active');
    if (type === 'standard') {
        document.getElementById('btnChartStandard').classList.add('active');
    } else {
        document.getElementById('btnChartHeikin').classList.add('active');
    }
    if (_lastAnalysisData && _lastAnalysisData.recent_candles) {
        renderCandleChart(_lastAnalysisData.recent_candles);
    } else if (currentStock && homeStockContext.data && homeStockContext.data.recent_candles) {
        renderCandleChart(homeStockContext.data.recent_candles);
    }
};

// --- Independent Section Contexts ---
let homeStockContext = { item: null, data: null, analysis: null };
let watchlistStockContext = { item: null, data: null, analysis: null };

let _lastMacroLoadTime = 0;

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
            selectStock(item, 'search');
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
            
            const targetId = sections[item.id];
            if (!targetId) return;

            // --- 1. Prevent refresh if already in section ---
            if (targetId === currentActiveSectionId && e.isTrusted) {
                return; 
            }

            // --- 2. Scroll Persistence: Save current ---
            if (currentActiveSectionId) {
                sectionScrollPositions[currentActiveSectionId] = window.scrollY;
            }

            if (targetId) {
                showSection(targetId);
                currentActiveSectionId = targetId;
                navItems.forEach(i => i.classList.toggle('active', i === item));

                if (targetId === 'analysisSection') {
                    const emptyState = document.getElementById('analysisEmptyState');
                    const contentWrapper = document.getElementById('analysisContentWrapper');
                    const currentStockLabel = document.getElementById('analysisCurrentStock');

                    // [CORRECTED] If we have a stock, show analysis content and trigger analysis
                    if (currentStock) {
                        emptyState?.classList.add('hidden');
                        contentWrapper?.classList.remove('hidden');
                        if (currentStockLabel) {
                            const ctx = (homeStockContext.item && homeStockContext.item.code === currentStock.code) ? homeStockContext : 
                                        ((watchlistStockContext.item && watchlistStockContext.item.code === currentStock.code) ? watchlistStockContext : null);
                            const data = ctx ? ctx.data : null;
                            
                            if (data) {
                                // Market Hours Logic (KST: 09:00 - 15:30)
                                const now = new Date();
                                const hour = now.getHours();
                                const min = now.getMinutes();
                                const isMarketOpen = (hour > 9 || (hour === 9 && min >= 0)) && (hour < 15 || (hour === 15 && min <= 30));
                                
                                let priceLabel = "종가"; // Fixed to 종가 as requested
                                
                                // Price Selection: Close as requested
                                let displayPrice = data.close || data.price;
                                
                                const price = displayPrice ? displayPrice.toLocaleString() : '0';
                                const change = data.change || 0;
                                const priceClass = change > 0 ? 'up' : (change < 0 ? 'down' : '');
                                const changeFormatted = data.change_percent ? ` (${data.change > 0 ? '+' : ''}${data.change_percent.toFixed(2)}%)` : '';
                                
                                // NXT Extended Hours Logic
                                let extendedHtml = '';
                                const isNXT = (currentStock.code === 'NXT' || currentStock.ticker === 'NXT' || (currentStock.name?.toUpperCase().includes('NXT')));
                                if (isNXT && data.extended_price) {
                                    extendedHtml = ` <span class="analysis-extended-price" style="font-size:0.85rem; color:var(--text-muted); opacity:0.8;">| 시간 외 거래가 ${data.extended_price.toLocaleString()}원</span>`;
                                }

                                const ticker = currentStock.code || currentStock.ticker || '';
                                currentStockLabel.innerHTML = `
                                    <span class="analysis-stock-name">${currentStock.name}(${ticker})</span>
                                    <span class="analysis-stock-divider">|</span>
                                    <span class="analysis-stock-price-label">${priceLabel}</span>
                                    <span class="analysis-stock-price ${priceClass}">${price} 원${changeFormatted}</span>
                                    ${extendedHtml}
                                `;
                            } else {
                                const ticker = currentStock.code || currentStock.ticker || '';
                                currentStockLabel.textContent = `${currentStock.name}(${ticker})`;
                            }
                        }
                        
                        const stockCode = currentStock.code || currentStock.ticker;
                        // --- 3. Analysis Cache: Check if already analyzed this stock ---
                        if (!_lastAnalysisData || _lastAnalysisData.code !== stockCode) {
                            triggerFullDeepAnalysis(stockCode);
                        } else {
                            console.log('[DEBUG] Skipping deep analysis - already loaded for', stockCode);
                            const patternReportSection = document.getElementById('patternReportSection');
                            if (patternReportSection) patternReportSection.classList.remove('hidden');
                        }
                    } else {
                        // No stock selected - show empty state
                        emptyState?.classList.remove('hidden');
                        contentWrapper?.classList.add('hidden');
                        if (currentStockLabel) currentStockLabel.textContent = '';
                    }
                } else if (targetId === 'valueChainSection') {
                    // [MOD] Load value chain data when section is opened
                    if (typeof initValueChain === 'function') {
                        initValueChain();
                    }
                }

                // --- Section Persistence Restore ---
                if (targetId === 'dashboardHome') {
                    // [MOD] 주 사용자가 메뉴를 직접 클릭해도 정상적으로 컨텍스트(HTML 노드 위치 및 검색 상태)를 복원해야 결과창이 소실되지 않음
                    resetDashboardHome(false); 
                    restoreStockContext('home');
                } else if (targetId === 'watchlistSection') {
                    // [MOD] If current stock is in watchlist, ensure it's shown in watchlist tab too
                    if (currentStock && isInWatchlist(currentStock.code)) {
                        watchlistStockContext = { item: currentStock, data: (homeStockContext.item?.code === currentStock.code) ? homeStockContext.data : null };
                    }
                    restoreStockContext('watchlist');
                }

                // --- Scroll Persistence: Restore target ---
                if (targetId !== 'dashboardHome') {
                    requestAnimationFrame(() => {
                        const savedPos = sectionScrollPositions[targetId] || 0;
                        window.scrollTo({ top: savedPos, behavior: 'auto' });
                    });
                }
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


/**
 * [NEW] Consolidated function to reset the Home dashboard view.
 * Ensures search box is visible and result section is handled correctly.
 * @param {boolean} force - If true, it resets the current stock and context.
 */
function resetDashboardHome(force = false) {
    const resSec = document.getElementById('resultSection');
    const searchHero = document.getElementById('mainSearchHero');
    const searchCard = document.getElementById('mainSearchCard');

    if (force) {
        console.log('[DEBUG] Executing full UI reset');
        if (resSec) {
            resSec.classList.add('hidden');
            resSec.style.display = 'none';
        }
        // Reset current search context ONLY on force (logo click, login/logout, etc.)
        currentStock = null; 
        _lastAnalysisData = null;
        sectionScrollPositions['dashboardHome'] = 0;
        
        if (searchHero) {
            searchHero.style.display = 'flex';
            searchHero.classList.remove('hidden');
            searchHero.style.opacity = '1';
        }

        window.scrollTo({ top: 0, behavior: 'auto' });
    } else {
        // --- 5. Robust State Restoration ---
        if (currentStock) {
            console.log('[DEBUG] Restoring search result for', currentStock.name);
            
            // Ensure section is visible through animation frame for state stability
            requestAnimationFrame(() => {
                const resSecMem = document.getElementById('resultSection');
                
                if (resSecMem) {
                    resSecMem.classList.remove('hidden');
                    // Physical Layer Override: Force through direct style to prevent any override
                    resSecMem.style.setProperty('display', 'block', 'important');
                    resSecMem.style.setProperty('visibility', 'visible', 'important');
                    resSecMem.style.setProperty('opacity', '1', 'important');
                }
                // if (heroMem) {
                //     heroMem.classList.add('hidden');
                //     heroMem.style.setProperty('display', 'none', 'important');
                // }
            });
            
            // No longer auto-filling searchInput to keep it clean for next search per user request
            // if (searchInput && !searchInput.value) searchInput.value = currentStock.name;

            // [FIX] Always ensure results are rendered if they exist in memory
            if (resSec && currentStock.data) {
                renderResult(currentStock.data);
            }
        }
    }

    // [CRITICAL] Search Bar stays visible always (Removed old hiding logic)
    if (searchHero) {
        searchHero.classList.remove('hidden');
        searchHero.style.setProperty('display', 'flex', 'important');
        searchHero.style.opacity = '1';
    }

    // Refresh macro/market state (cache handles heavy lifting)
    renderMacroIndicators();
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

    try {
        // [MOD] Basic resultSection is visible in Home OR Watchlist (if stock is in watchlist)
        const placeholderId = (type === 'home') ? 'mainResultPlaceholder' : 'watchlistResultPlaceholder';
        const placeholder = document.getElementById(placeholderId);
        
        // Skip if wrong type and not home (already handled home above)
        if (type !== 'home' && type !== 'watchlist') {
            if (resSec) resSec.classList.add('hidden');
            return;
        }
        
        // [MOD] If in watchlist tab, ensure the stock is actually in the watchlist
        if (type === 'watchlist' && context.item && !isInWatchlist(context.item.code)) {
            if (resSec) resSec.classList.add('hidden');
            return;
        }

        if (placeholder && resSec) {
            placeholder.parentNode.insertBefore(resSec, placeholder.nextSibling);
            resSec.classList.remove('hidden');

            // Restore State
            currentStock = context.item;
            renderResult(context.data);
            
            // On Home/Watchlist result views, we hide the pattern section (reserved for Deep Analysis)
            const patternReportSection = document.getElementById('patternReportSection');
            if (patternReportSection) patternReportSection.classList.add('hidden');
        }

        if (context.item && context.item.code) {
             // Avoid double loading if possible
             renderFundamentalReport(context.item.code);
        }
    
        // Final sanity check for result visibility
        if (resSec) resSec.classList.remove('hidden');
    } catch(err) {
        console.error('restoreStockContext error:', err);
    }
}

function showSection(id) {
    console.log(`[DEBUG] showSection: ${id}`);
    const sections = ['dashboardHome', 'analysisSection', 'historySection', 'watchlistSection', 'valueChainSection', 'resultSection', 'adminSection'];
    sections.forEach(s => {
        const el = document.getElementById(s);
        if (el) {
            el.classList.add('hidden');
        }
    });

    // --- [승인 시스템 적용] 승인되지 않은 사용자의 특정 섹션 접근 차단 ---
    const restrictedForUnapproved = ['analysisSection', 'valueChainSection', 'watchlistSection'];
    if (authUser?.logged_in && !authUser.is_approved && restrictedForUnapproved.includes(id)) {
        console.warn(`[AUTH] Access denied to ${id} (Not Approved)`);
        navigateToSection('navHome');
        return;
    }

    const target = document.getElementById(id);
    if (target) {
        target.classList.remove('hidden');
        target.style.display = '';
        currentActiveSectionId = id;
    }

    const resSec = document.getElementById('resultSection');
    // --- 6. Intelligent Result Hiding ---
    // resultSection should ONLY be hidden if we move to a section that doesn't support it (e.g., Value Chain)
    // Home and Watchlist support showing the shared result card.
    const supportsResult = ['dashboardHome', 'watchlistSection', 'resultSection'];
    if (resSec && !supportsResult.includes(id)) {
        resSec.classList.add('hidden');
        resSec.style.setProperty('display', 'none', 'important');
    }

    if (id === 'dashboardHome' || id === 'watchlistSection') {
        renderRecentSearches();
        // [CRITICAL FIX] Ensure search results are visible and prioritize display stability via inline-block-important
        if (currentStock) {
            console.log(`[DEBUG] ${id} visible - hard-forcing result card display for`, currentStock.name);
            requestAnimationFrame(() => {
                const resSecMem = document.getElementById('resultSection');
                if (resSecMem) {
                    resSecMem.classList.remove('hidden');
                    // Physical Layer Override: Force through direct style to prevent any JS-based override
                    resSecMem.style.setProperty('display', 'block', 'important');
                    resSecMem.style.setProperty('visibility', 'visible', 'important');
                    resSecMem.style.setProperty('opacity', '1', 'important');
                }
                // Robust scroll position restoration
                window.scrollTo({ top: 0, behavior: 'instant' });
            });
        }
        if (id === 'dashboardHome') resetDashboardHome(false); 
    } else if (id === 'analysisSection') {
        // Logo Reset
        const logoLink = document.querySelector('.logo-link');
        if (logoLink) {
            logoLink.addEventListener('click', (e) => {
                e.preventDefault();
                console.log('[DEBUG] Logo clicked - performing force reset');
                navigateToSection('navHome');
                resetDashboardHome(true);
            });
        }
        // [MOD] Ensure analysis report is unhidden even if it was hidden by other section logic
        const patternReportSection = document.getElementById('patternReportSection');
        if (patternReportSection && _lastAnalysisData && currentStock && _lastAnalysisData.code === (currentStock.code || currentStock.ticker)) {
            patternReportSection.classList.remove('hidden');
        }
    } else if (id === 'adminSection') {
        renderAdminDashboard();
    } else {
        requestAnimationFrame(() => {
            console.log(`[DEBUG] Section "${id}" is now active. Triggering renderers.`);
        });
    }
}

// ── Navigation Logic (Top Dock) ──
function initResizableSidebar() {
    // Legacy sidebar logic disabled for Top Dock Mode
    console.log("Navigation: Top Dock Mode active");
}

function updateSidebarWidth(width) {
    // No-op for top dock
}

function isSidebarExpanded() {
    const sidebar = document.getElementById('mainSidebar');
    return sidebar && !sidebar.classList.contains('collapsed');
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

    // [MOD] Always navigate to home when adding to watchlist to see the result card there
    navigateToSection('navHome');
    
    if (currentWatchlist.some(w => w.code === item.code)) return;
    
    // ── 낙관적 UI 업데이트 (Optimistic Update) ──
    const rollbackSnapshot = [...currentWatchlist];
    currentWatchlist.push(item);
    saveWatchlist(currentWatchlist);
    updateWatchlistBtn();
    showToast(`${item.name} 종목이 관심종목에 추가되었습니다.`, 'success');

    // [MOD] Ensure context sync for both Home and Watchlist tabs
    homeStockContext = { item: item, data: (currentStock?.code === item.code) ? currentStock.data : null };
    watchlistStockContext = { item: item, data: (currentStock?.code === item.code) ? currentStock.data : null };
    
    // Refresh Watchlist tab content if visible or if we are about to switch to it
    restoreStockContext('watchlist');

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
                 watchlistStockContext = { item: null, data: null, analysis: null };
            }
        }

        // Always redirect back to Home as per user request
        navigateToSection('navHome');
        return;
    }
    
    // ── 로그인 사용자: 낙관적 UI (Optimistic Update) ──
    const rollbackSnapshot = [...currentWatchlist];
    currentWatchlist = currentWatchlist.filter(w => w.code !== code);
    saveWatchlist(currentWatchlist);
    updateWatchlistBtn();
    
    // [MOD] Clear watchlist context if removed
    if (watchlistStockContext.item?.code === code) {
        watchlistStockContext = { item: null, data: null };
    }

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
    const list = getWatchlist();
    const container = document.getElementById('watchlistContainer');
    if (!container) return;

    if (list.length === 0) {
        container.innerHTML = `
            <div class="empty-watchlist" style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);">
                <i class="ph ph-star" style="font-size: 3rem; opacity: 0.2; margin-bottom: 12px;"></i>
                <p>관심종목이 없습니다. 별표를 눌러 추가해보세요!</p>
            </div>
        `;
        return;
    }

    // "관심종목에는 타일 형태만 표시" - Simplified tile layout
    container.innerHTML = list.map(item => {
        const market = item.market || 'KOSPI';
        const marketClass = market.toLowerCase();
        return `
        <div class="watchlist-tile animate-in" data-code="${escapeHtml(item.code)}" data-market="${escapeHtml(market)}" data-name="${escapeHtml(item.name)}">
            <div class="watchlist-tile-clickable-area">
                <div class="watchlist-tile-header">
                    <span class="watchlist-tile-market ${marketClass}">${escapeHtml(market)}</span>
                    <button class="watchlist-tile-remove" onclick="event.stopPropagation(); removeFromWatchlist('${escapeHtml(item.code)}')">
                        <i class="ph ph-x"></i>
                    </button>
                </div>
                <div class="watchlist-tile-body">
                    <span class="watchlist-tile-name">${escapeHtml(item.name)}</span>
                    <span class="watchlist-tile-code">${escapeHtml(item.code)}</span>
                </div>
            </div>
        </div>
    `}).join('');

    // Click behavior for tiles
    container.querySelectorAll('.watchlist-tile').forEach(tile => {
        const item = {
            code: tile.dataset.code,
            market: tile.dataset.market,
            name: tile.dataset.name
        };

        // 1. Click on body/header: Basic Analysis
        const clickableArea = tile.querySelector('.watchlist-tile-clickable-area');
        if (clickableArea) {
            clickableArea.addEventListener('click', () => {
                selectStock(item, 'search'); // Use 'search' origin to show basic analysis
            });
        }

    });
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
    const countEl = document.getElementById('watchlistCount');
    if (countEl) {
        countEl.textContent = currentWatchlist.length;
        countEl.style.display = currentWatchlist.length > 0 ? 'inline-flex' : 'none';
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

// ── Suggestions (클라이언트 캐시 우선, 서버 API 폴백) ──
async function fetchSuggestions(query) {
    try {
        // 1순위: 클라이언트 측 즉시 검색 (네트워크 0ms)
        if (_stocksCache.length > 0) {
            const q = query.trim().toUpperCase();
            let results = [];
            // 코드 정확 일치
            const exact = _stocksCache.find(s => s.code === query.trim());
            if (exact) results.push(exact);
            // 이름이 query로 시작
            for (const s of _stocksCache) {
                if (!results.includes(s) && s.name.toUpperCase().startsWith(q)) {
                    results.push(s);
                    if (results.length >= 20) break;
                }
            }
            // 이름에 포함
            if (results.length < 20) {
                for (const s of _stocksCache) {
                    if (!results.includes(s) && (s.name.toUpperCase().includes(q) || s.code.includes(query.trim()))) {
                        results.push(s);
                        if (results.length >= 20) break;
                    }
                }
            }
            suggestItems = results;
            activeIndex = -1;
            renderSuggestions(results, query);
            return;
        }
        // 2순위: 서버 API 폴백
        const res = await fetchWithTimeout(API_BASE_URL + `/api/suggest?q=${encodeURIComponent(query)}`, { timeout: 5000 });
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
        const market = item.market || 'KOSPI';
        const marketClass = market.toLowerCase();
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

// ── Inline Loading State for Results ──
function showStockLoadingState(item) {
    // 1. Basic Info Header
    const marketBadge = document.getElementById('stockMarketBadge');
    if (marketBadge) {
        marketBadge.textContent = item.market || '...';
        marketBadge.style.display = 'inline-block';
        marketBadge.className = `market-badge ${item.market ? item.market.toLowerCase() : ''}`;
    }
    const nameEl = document.getElementById('stockName');
    if (nameEl) nameEl.textContent = item.name;
    const codeEl = document.getElementById('stockCode');
    if (codeEl) codeEl.textContent = item.code;
    
    // 2. Clear previous data with premium glassmorphism placeholders
    const priceEl = document.getElementById('stockPrice');
    if (priceEl) {
        priceEl.innerHTML = '<div class="price-skeleton"></div>';
        priceEl.className = 'current-price';
    }
    const changeEl = document.getElementById('stockChange');
    if (changeEl) {
        changeEl.innerHTML = `
            <div class="glass-loading-pill">
                <i class="ph ph-circle-notch ph-spin"></i>
                <span>분석 진행 중...</span>
            </div>
        `;
        changeEl.className = 'price-change';
    }
    
    // 3. Toggle Inline Loaders
    document.querySelectorAll('.ai-inline-loader, .fund-inline-loader').forEach(el => el.classList.remove('hidden'));
    document.getElementById('recentWeekAnalysis')?.classList.add('hidden');
    document.getElementById('fundSignalTile')?.classList.add('hidden');
    document.getElementById('fundSummaryText')?.classList.add('hidden');

    // 4. Chart Area Placeholder
    const chartContainer = document.getElementById('chartContainer');
    if (chartContainer) {
        chartContainer.innerHTML = `
            <div class="chart-inline-loading">
                <i class="ph ph-chart-line-up ph-spin"></i>
                <span>차트 데이터를 불러오는 중...</span>
            </div>
        `;
    }

    // 5. Ensure blocks are visible
    document.getElementById('aiSummaryBlock')?.classList.remove('hidden');
    document.getElementById('aiSummaryBlock')?.classList.add('visible');
    document.getElementById('fundSummaryBlock')?.classList.remove('hidden');
    document.getElementById('fundSummaryBlock')?.classList.add('visible');

    // 6. Reveal Result Section
    const resSec = document.getElementById('resultSection');
    if (resSec) {
        resSec.classList.remove('hidden');
        resSec.style.setProperty('display', 'block', 'important');
    }
}

// ── Select & Fetch Stock Detail ──
async function selectStock(item, origin = 'search') {
    hideSuggestions();
    
    // Add to recent
    saveRecentSearch(item);
    
    if (searchInput) searchInput.value = ''; // Clear search box after selection per user request
    currentStock = item;
    
    // [PERSISTENCE] Save last stock for refresh recovery
    localStorage.setItem('signnith_last_stock', JSON.stringify(item));

    // Update watchlist button & sidebar highlight
    updateWatchlistBtn();
    
    console.log(`[DEBUG] selectStock - origin: ${origin}, stock: ${item.name}`);

    // [v179] Show Inline Loading UI
    showStockLoadingState(item);

    // Fetch basic stock data (Always needed for chart/summary)
    const url = `${API_BASE_URL}/api/stock?code=${item.code}&market=${item.market}&name=${encodeURIComponent(item.name)}`;
    try {
        const response = await fetchWithTimeout(url, { timeout: 30000 });
        if (!response.ok) throw new Error('데이터를 불러오는데 실패했습니다.');
        const data = await response.json();
        
        if (loadingSpinner) loadingSpinner.classList.add('hidden');

        if (origin === 'search' || origin === 'restore') {
            homeStockContext = { item, data, analysis: null };
            
            // Navigate to Home section
            navigateToSection('navHome');
            
            // Render the results (this will eventually hide the loaders)
            renderResult(data);
            
            // Smoothly scroll to the result ONLY for fresh searches
            if (origin === 'search') {
                requestAnimationFrame(() => {
                    const resSec = document.getElementById('resultSection');
                    if (resSec && !resSec.classList.contains('hidden')) {
                        resSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                });
            }
        } 
        else if (origin === 'watchlist') {
            // Deep Analysis View: Navigate to Full AI & Fundamental Analysis
            watchlistStockContext = { item, data, analysis: null };
            
            // Navigate to Analysis section
            navigateToSection('navAnalysis');
            
            const emptyState = document.getElementById('analysisEmptyState');
            const contentWrapper = document.getElementById('analysisContentWrapper');
            const currentLabel = document.getElementById('analysisCurrentStock');
            
            if (emptyState) emptyState.classList.add('hidden');
            if (contentWrapper) contentWrapper.classList.remove('hidden');
            if (currentLabel) {
                const price = data && data.price ? data.price.toLocaleString() : '0';
                const change = data && data.change ? data.change : 0;
                const priceClass = change > 0 ? 'up' : (change < 0 ? 'down' : '');
                const changeFormatted = data && data.change_percent ? ` (${data.change > 0 ? '+' : ''}${data.change_percent.toFixed(2)}%)` : '';
                
                currentLabel.innerHTML = `
                    <span class="analysis-stock-name">${item.name}</span>
                    <span class="analysis-stock-price ${priceClass}">${price}${changeFormatted}</span>
                `;
            }

            // triggerFullDeepAnalysis is now handled by navigateToSection -> initNavigation
        }
    } catch (err) {
        console.error('Stock selection failed:', err);
        if (loadingSpinner) loadingSpinner.classList.add('hidden');
        showToast('데이터 로딩에 실패했습니다.', 'error');
    }
}

// [v179] renderAnalysisReport moved to its original location (around line 1880)


async function triggerFullDeepAnalysis(code) {
    const globalLoading = document.getElementById('analysisGlobalLoading');
    const patternReportSection = document.getElementById('patternReportSection');
    const emptyState = document.getElementById('analysisEmptyState');
    const contentWrapper = document.getElementById('analysisContentWrapper');

    const fundBlocks = ['fundSummaryBlock', 'fundQuantBlock', 'fundEventBlock', 'fundSectorBlock', 'fundTargetBlock'];
    const aiBlocks = ['aiTrendBlock', 'aiBuySignalBlock', 'aiSellSignalBlock', 'aiPatternsBlock', 'aiChartBlock', 'aiSummaryBlock'];
    const allBlocks = [...fundBlocks, ...aiBlocks];

    try {
        console.log(`[DEBUG] triggerFullDeepAnalysis for ${code}`);
        
        // --- 1. Analysis Cache: Check if already analyzed this stock ---
        if (_lastAnalysisData && _lastAnalysisData.code === code) {
            console.log('[DEBUG] Analysis for', code, 'already exists. Re-rendering from cache instantly.');
            if (emptyState) emptyState.classList.add('hidden');
            if (contentWrapper) contentWrapper.classList.remove('hidden');
            if (globalLoading) globalLoading.classList.add('hidden');
            if (patternReportSection) patternReportSection.classList.remove('hidden');
            
            allBlocks.forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.classList.remove('hidden');
                    el.classList.add('visible');
                }
            });
            
            renderAnalysisReport(_lastAnalysisData);
            return; 
        }

        // [v179] Deactivate Global Loading Screen
        if (globalLoading) globalLoading.classList.add('hidden');

        // Show all blocks in Loading State (Localized)
        allBlocks.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.classList.remove('hidden');
                el.classList.add('visible');
            }
        });

        // Toggle specific inline loaders
        document.querySelectorAll('.ai-inline-loader, .fund-inline-loader').forEach(el => el.classList.remove('hidden'));
        document.getElementById('recentWeekAnalysis')?.classList.add('hidden');
        document.getElementById('fundSignalTile')?.classList.add('hidden');
        document.getElementById('fundSummaryText')?.classList.add('hidden');
        // Hide other sub-blocks during load
        document.getElementById('aiSignalsGrid')?.classList.add('hidden');
        document.getElementById('aiPatternsGrid')?.classList.add('hidden');
        // Step 1: Fetch AI Analysis
        const analysisData = await fetchAnalysisReport(currentStock || { code });
        
        // Hide global loading early if we have AI data to show
        if (analysisData) {
            console.log('[DEBUG] AI Analysis data received. Transitioning...');
            _lastAnalysisData = analysisData;
            if (patternReportSection) patternReportSection.classList.remove('hidden');
            
            // This renders the AI patterns/chart
            renderAnalysisReport(analysisData);
        }

        // Step 2: Show Fundamental loading status inside the progress bar or loading text
        if (loadingText) loadingText.textContent = '기업 펀더멘탈 및 공시 데이터 분석 중...';
        
        // Step 3: Start Fundamental Analysis
        // We await this to ensure the dashboard is fully populated before we hide the global loading finally
        await renderFundamentalReport(code);
        console.log('[DEBUG] Fundamental analysis rendering complete.');

    } catch (err) {
        console.error('Deep Analysis failed:', err);
        showToast(`심층 분석 데이터를 불러오지 못했습니다. (${err.message})`, 'error');
        
        // [MOD] Update UI to clear "Analyzing..." messages if stuck
        const reasonEl = document.getElementById('fundSignalReason');
        if (reasonEl && reasonEl.textContent === '데이터 분석 중…') {
            reasonEl.textContent = '❌ 분석 데이터를 불러오지 못했습니다.';
        }
        
        // Reveal blocks even on failure to show error state or empty state
        allBlocks.forEach(id => {
            const el = document.getElementById(id);
            if (el && el.classList.contains('hidden')) {
                el.classList.remove('hidden');
                requestAnimationFrame(() => el.classList.add('visible'));
            }
        });
    } finally {
        // Essential: Always hide the global analysis loading block
        if (globalLoading) globalLoading.classList.add('hidden');
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
    const market = data.market || '';
    marketBadge.textContent = market;
    marketBadge.className = `market-badge ${market ? market.toLowerCase() : ''}`;
    if (!market) marketBadge.style.display = 'none';
    else marketBadge.style.display = 'inline-block';

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
    const summaryContent = document.getElementById('companySummaryContent');
    if (data.company_summary) {
        if (summaryContent) summaryContent.innerHTML = data.company_summary;
        else summaryEl.innerHTML = data.company_summary; // Fallback
        summaryEl.classList.remove('hidden');
    } else {
        summaryEl.classList.add('hidden');
    }

    // --- NXT After-hours ---
    renderNxtCard(data.nxt);

    // Show result
    resultSection.classList.remove('hidden');

    // Reset analysis section
    const patternReportSection = document.getElementById('patternReportSection');
    if (patternReportSection) patternReportSection.classList.add('hidden');
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

    // --- 1. Cache Check: Skip if loaded within last 5 mins ---
    const now = Date.now();
    const hasData = indexList && indexList.innerHTML.length > 100 && !indexList.innerHTML.includes('ph-spinner');
    if (now - _lastMacroLoadTime < 300000 && hasData) {
        console.log('[DEBUG] Skipping macro indicators load - using session cache');
        return;
    }
    _lastMacroLoadTime = now;

    // Show Loading state
    if (indexList) {
        indexList.innerHTML = `
            <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding:40px 0; color:var(--text-muted); gap: 12px;">
                <i class="ph ph-spinner ph-spin" style="font-size:24px; color:var(--primary);"></i>
                <span style="font-size:0.9rem;">지표 데이터를 불러오는 중...</span>
                <span style="font-size:0.75rem; opacity:0.6;">(서버가 시작되는 중이면 최대 40초가 소요될 수 있습니다)</span>
            </div>
        `;
    }

    try {
        const url = `${API_BASE_URL}/api/macro?t=${Date.now()}`;
        console.log('[DEBUG] Fetching macro data from:', url);
        const resp = await fetchWithTimeout(url, { timeout: 45000 });
        if (!resp.ok) throw new Error(`HTTP Error: ${resp.status}`);
        const data = await resp.json() || {};
        if (data.error) console.warn('[DEBUG] Server reported error:', data.error);
        console.log('[DEBUG] Macro data received:', Object.keys(data));

        // [SAFEGUARD] Ensure data is handled even if partial
        const getVal = (key, format = 'num', decimals = 2) => {
            const val = data[key];
            if (val === undefined || val === null) return '-';
            if (format === 'num') return val.toLocaleString();
            if (format === 'fixed') return val.toFixed(decimals);
            return val;
        };

        const getChg = (key) => {
            const val = data[`${key}_chg`];
            if (val === undefined || val === null) return { change: '-', up: false };
            return { 
                change: `${val > 0 ? '+' : ''}${val.toFixed(2)}%`, 
                up: val > 0 
            };
        };

        // Data Mapping (시장 지수 대시보드용)
        const indexData = [
            { id: 'KOSPI', name: 'KOSPI', price: getVal('kospi'), ...getChg('kospi') },
            { id: 'KOSDAQ', name: 'KOSDAQ', price: getVal('kosdaq'), ...getChg('kosdaq') },
            { id: 'S&P 500', name: 'S&P 500', price: getVal('sp500'), ...getChg('sp500') },
            { id: 'NASDAQ', name: 'NASDAQ', price: getVal('nasdaq'), ...getChg('nasdaq') },
            { id: 'PHLX SEMI', name: '필라델피아 반도체', price: getVal('sox'), ...getChg('sox') },
            { id: 'DXY', name: '달러 인덱스', price: getVal('dxy'), ...getChg('dxy') },
            { id: 'WTI', name: 'WTI 유가', price: getVal('wti'), ...getChg('wti') }
        ];

        // 주요 경제 지표 (환율, 국채 등)
        const us10yVal = data.us10y != null ? `${data.us10y.toFixed(2)}%` : '-';
        const us10yChg = data.us10y_chg != null ? `${data.us10y_chg > 0 ? '+' : ''}${data.us10y_chg.toFixed(3)}` : '-';

        const economyData = [
            { id: 'USD/KRW', name: 'USD/KRW 환율', price: getVal('usd_krw'), ...getChg('usd_krw') },
            { id: 'US10Y', name: '미 국채 10년물', price: us10yVal, change: us10yChg, up: data.us10y_chg > 0 },
            { id: 'VIX', name: '공포지수 (VIX)', price: getVal('vix'), ...getChg('vix') }
        ];

        const cryptoData = [
            { id: 'BTC', name: '비트코인 (BTC)', price: getVal('btc'), ...getChg('btc') },
            { id: 'ETH', name: '이더리움 (ETH)', price: getVal('eth'), ...getChg('eth') },
            { id: 'USDT', name: '테더 (USDT)', price: getVal('usdt'), ...getChg('usdt') }
        ];

        const commodityData = [
            { id: 'GOLD', name: '금 (Gold)', price: getVal('gold'), ...getChg('gold') },
            { id: 'SILVER', name: '은 (Silver)', price: getVal('silver'), ...getChg('silver') },
            { id: 'COPPER', name: '구리 (Copper)', price: getVal('copper'), ...getChg('copper') }
        ];

        // 1. Render Indices List
        if (indexList) {
            indexList.innerHTML = indexData.map(idx => `
                <div class="indicator-row clickable" 
                     data-id="${idx.id}" 
                     data-name="${idx.name}" 
                     onclick="renderMacroSplitChart('${idx.id}', '${idx.name}', 'market'); document.querySelectorAll('#indexList .indicator-row.clickable').forEach(i => i.classList.remove('active')); this.classList.add('active');">
                    <span class="indicator-label">${idx.name}</span>
                    <div class="indicator-values">
                        <span class="indicator-price">${idx.price || '-'}</span>
                        <span class="indicator-change ${idx.up ? 'up' : 'down'}">${idx.change || '-'}</span>
                    </div>
                </div>
            `).join('');

            // Auto-select KOSPI
            const activeItem = indexList.querySelector('.indicator-row.clickable.active');
            if (!activeItem) {
                const kospi = indexList.querySelector('.indicator-row.clickable[data-id="KOSPI"]');
                if (kospi) {
                    kospi.classList.add('active');
                    renderMacroSplitChart('KOSPI', 'KOSPI', 'market');
                }
            }
        }

        // 2. Render Economy List
        if (economyGrid) {
            economyGrid.innerHTML = economyData.map(eco => `
                <div class="indicator-row clickable" 
                     data-id="${eco.id}" 
                     data-name="${eco.name}"
                     onclick="renderMacroSplitChart('${eco.id}', '${eco.name}', 'economy'); document.querySelectorAll('#economyGrid .indicator-row.clickable').forEach(i => i.classList.remove('active')); this.classList.add('active');">
                    <span class="indicator-label">${eco.name}</span>
                    <div class="indicator-values">
                        <span class="indicator-price">${eco.price}</span>
                        <span class="indicator-change ${eco.up ? 'up' : 'down'}">${eco.change}</span>
                    </div>
                </div>
            `).join('');

            // Auto-select USD/KRW
            const activeEco = economyGrid.querySelector('.indicator-row.clickable.active');
            if (!activeEco) {
                const usd = economyGrid.querySelector('.indicator-row.clickable[data-id="USD/KRW"]');
                if (usd) {
                    usd.classList.add('active');
                    renderMacroSplitChart('USD/KRW', 'USD/KRW 환율', 'economy');
                }
            }
        }

        // 3. Render Commodity List
        const commodityGrid = document.getElementById('commodityGrid');
        if (commodityGrid) {
            commodityGrid.innerHTML = commodityData.map(com => `
                <div class="indicator-row clickable" 
                     data-id="${com.id}" 
                     data-name="${com.name}"
                     onclick="renderMacroSplitChart('${com.id}', '${com.name}', 'commodity'); document.querySelectorAll('#commodityGrid .indicator-row.clickable').forEach(i => i.classList.remove('active')); this.classList.add('active');">
                    <span class="indicator-label">${com.name}</span>
                    <div class="indicator-values">
                        <span class="indicator-price">${com.price}</span>
                        <span class="indicator-change ${com.up ? 'up' : 'down'}">${com.change}</span>
                    </div>
                </div>
            `).join('');

            // Auto-select Gold
            const activeCom = commodityGrid.querySelector('.indicator-row.clickable.active');
            if (!activeCom) {
                const gold = commodityGrid.querySelector('.indicator-row.clickable[data-id="GOLD"]');
                if (gold) {
                    gold.classList.add('active');
                    renderMacroSplitChart('GOLD', '금 (Gold)', 'commodity');
                }
            }
        }

        // 4. Render Crypto List
        if (cryptoGrid) {
            cryptoGrid.innerHTML = cryptoData.map(cry => `
                <div class="indicator-row clickable" 
                     data-id="${cry.id}" 
                     data-name="${cry.name}"
                     onclick="renderMacroSplitChart('${cry.id}', '${cry.name}', 'crypto'); document.querySelectorAll('#cryptoGrid .indicator-row.clickable').forEach(i => i.classList.remove('active')); this.classList.add('active');">
                    <span class="indicator-label">${cry.name}</span>
                    <div class="indicator-values">
                        <span class="indicator-price">$${cry.price}</span>
                        <span class="indicator-change ${cry.up ? 'up' : 'down'}">${cry.change}</span>
                    </div>
                </div>
            `).join('');

            // Auto-select BTC
            const activeCry = cryptoGrid.querySelector('.indicator-row.clickable.active');
            if (!activeCry) {
                const btc = cryptoGrid.querySelector('.indicator-row.clickable[data-id="BTC"]');
                if (btc) {
                    btc.classList.add('active');
                    renderMacroSplitChart('BTC', '비트코인 (BTC)', 'crypto');
                }
            }
        }

        // Update Top Status Chips (기존 기능 유지)
        updateStatusChips(data);

    } catch (err) {
        console.error("renderMacroIndicators error:", err);
        const errorMsg = err.name === 'TimeoutError' ? '서버 응답 시간 초과 (45초)' : (err.message || '알 수 없는 오류');
        if (indexList) {
            indexList.innerHTML = `
                <div class="error-msg" style="padding: 20px; text-align: center;">
                    <div style="font-weight: bold; margin-bottom: 8px;">지표 로드 실패</div>
                    <div style="font-size: 12px; opacity: 0.7;">${errorMsg}</div>
                    <button onclick="renderMacroIndicators()" style="margin-top: 12px; padding: 4px 12px; font-size: 12px; cursor: pointer;">다시 시도</button>
                </div>
            `;
        }
        // Auto-retry once after 5 seconds (handles Render cold-start delays)
        if (!err._retried) {
            err._retried = true;
            console.log('[DEBUG] Auto-retrying macro fetch in 5s...');
            setTimeout(() => {
                _lastMacroLoadTime = 0; // reset cache so it re-fetches
                renderMacroIndicators();
            }, 5000);
        }
    }
}

// ── 전역 차트 인스턴스 관리 (v176) ──
let macroCharts = {
    market: null,
    economy: null,
    commodity: null,
    crypto: null
};

// ── 분할 뷰 전용 차트 렌더링 ──
async function renderMacroSplitChart(symbol, name, category) {
    const containerMap = {
        market: { id: 'marketChart', title: 'marketChartTitle', color: '#3b82f6' },
        economy: { id: 'economyChart', title: 'economyChartTitle', color: '#10b981' },
        commodity: { id: 'commodityChart', title: 'commodityChartTitle', color: '#f59e0b' },
        crypto: { id: 'cryptoChart', title: 'cryptoChartTitle', color: '#8b5cf6' }
    };

    const target = containerMap[category];
    const titleElem = document.getElementById(target.title);
    const container = document.getElementById(target.id);
    
    if (titleElem) titleElem.textContent = `${name} 상세 분석`;
    if (!container) return;

    // Clear existing
    container.innerHTML = '<div class="loading-chart">로딩 중...</div>';
    
    if (macroCharts[category]) {
        macroCharts[category].remove();
        macroCharts[category] = null;
    }

    try {
        const resp = await fetchWithTimeout(`${API_BASE_URL}/api/market-index/history?symbol=${encodeURIComponent(symbol)}`);
        if (!resp.ok) throw new Error('데이터 수집 실패');
        const data = await resp.json();

        container.innerHTML = '';
        
        if (container.clientWidth === 0 || container.clientHeight === 0) {
            await new Promise(resolve => requestAnimationFrame(resolve));
        }

        const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
        const textColor = isDark ? '#94a3b8' : '#64748b';
        const gridColor = isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';
        const themeColor = target.color;

        const chartOptions = {
            width: container.clientWidth || 400,
            height: container.clientHeight || 300,
            layout: { 
                background: { type: 'solid', color: 'transparent' },
                textColor: textColor,
                fontSize: 10,
                fontFamily: 'Inter, sans-serif'
            },
            grid: {
                vertLines: { color: gridColor },
                horzLines: { color: gridColor },
            },
            rightPriceScale: { borderColor: gridColor, borderVisible: false },
            timeScale: { borderColor: gridColor, borderVisible: false, timeVisible: true },
            handleScroll: true,
            handleScale: true,
        };

        const chart = LightweightCharts.createChart(container, chartOptions);
        const areaSeries = chart.addAreaSeries({
            topColor: `${themeColor}44`,
            bottomColor: `${themeColor}00`,
            lineColor: themeColor,
            lineWidth: 2,
            priceFormat: { type: 'price', precision: symbol.includes('USD') || symbol.includes('TNX') ? 3 : 2 },
        });

        if (data.history && data.history.length > 0) {
            areaSeries.setData(data.history);
        }

        if (data.history && data.history.length > 30) {
            const last = data.history[data.history.length - 1].time;
            const first = data.history[data.history.length - 30].time;
            chart.timeScale().setVisibleRange({ from: first, to: last });
        } else {
            chart.timeScale().fitContent();
        }

        macroCharts[category] = chart;

    } catch (err) {
        console.error(`[Chart Error] ${category}:`, err);
        container.innerHTML = `<div class="error-msg">데이터 없음</div>`;
    }
}

// ── Top Status Chips 업데이트 분리 ──
function updateStatusChips(data) {
    const kospiData = data.kospi ? { 
        name: 'KOSPI', 
        price: data.kospi.toLocaleString(), 
        change: data.kospi_chg != null ? (data.kospi_chg >= 0 ? '+' : '') + data.kospi_chg.toFixed(2) + '%' : '-', 
        up: data.kospi_chg >= 0 
    } : null;
    const kosdaqData = data.kosdaq ? { 
        name: 'KOSDAQ', 
        price: data.kosdaq.toLocaleString(), 
        change: data.kosdaq_chg != null ? (data.kosdaq_chg >= 0 ? '+' : '') + data.kosdaq_chg.toFixed(2) + '%' : '-', 
        up: data.kosdaq_chg >= 0 
    } : null;

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

// ── AI 캔들 패턴 분석 리포트 통합 페치 유틸리티 ──
async function fetchAnalysisReport(item) {
    if (!item || !item.code) return null;
    const globalLoading = document.getElementById('analysisGlobalLoading');

    try {
        const market = item.market || (currentStock && currentStock.code === item.code ? currentStock.market : 'KOSPI');
        const name = item.name || (currentStock && currentStock.code === item.code ? currentStock.name : '');
        
        const url = `${API_BASE_URL}/api/analysis?code=${item.code}&market=${market}&name=${encodeURIComponent(name)}`;
        const response = await fetchWithTimeout(url, { timeout: 30000 });
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

        return data; 
    } catch (err) {
        console.error('fetchAnalysis error:', err);
        return null;
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
    // [v179] Hide all inline loaders first
    document.querySelectorAll('.ai-inline-loader, .fund-inline-loader').forEach(el => el.classList.add('hidden'));
    document.getElementById('recentWeekAnalysis')?.classList.remove('hidden');
    document.getElementById('fundSignalTile')?.classList.remove('hidden');
    document.getElementById('fundSummaryText')?.classList.remove('hidden');

    _lastAnalysisData = data; 
    
    // Ensure parent container is visible immediately
    const contentWrapper = document.getElementById('analysisContentWrapper');
    const emptyState = document.getElementById('analysisEmptyState');
    if (contentWrapper) contentWrapper.classList.remove('hidden');
    if (emptyState) emptyState.classList.add('hidden');

    const globalLoading = document.getElementById('analysisGlobalLoading');
    if (globalLoading) globalLoading.classList.add('hidden');


    const hasBuyReport = data.buy_report && data.buy_report !== null;
    const hasSellReport = data.sell_report && data.sell_report !== null;
    
    // Sequential Reveal Logic (Updated v181 to match Top-Down hierarchy)
    const blocks = ['fundSummaryBlock', 'fundQuantBlock', 'fundEventBlock', 'fundSectorBlock', 'fundTargetBlock'];
    blocks.push('aiTrendBlock');
    if (hasBuyReport) blocks.push('aiBuySignalBlock');
    if (hasSellReport) blocks.push('aiSellSignalBlock');
    blocks.push('aiPatternsBlock', 'aiChartBlock', 'aiSummaryBlock');
    
    blocks.forEach((id, index) => {
        const el = document.getElementById(id);
        if (el) {
            el.classList.add('hidden');
            el.classList.remove('visible');
            
            // Staggered reveal
            setTimeout(() => {
                el.classList.remove('hidden');
                // Small delay to trigger CSS transition
                requestAnimationFrame(() => {
                    el.classList.add('visible');
                });
            }, index * 120);
        }
    });

    // ── 1. Trend Block ──
    const trendContainer = document.getElementById('trendContainer');
    if (data.trend) {
        if (trendContainer) trendContainer.classList.remove('hidden');
    }



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
    trendBadge.className = `trend-pill glass-mode ${data.trend}`;
    trendIcon.textContent = cfg.icon;
    
    // [UI REFINEMENT] Use a span for color-coded label text
    const cleanLabel = data.trend_label
        .replace(' (', '<br><span style="font-size: 0.88rem; opacity: 0.8; font-weight: 500; display: block; margin-top: 4px;">(')
        .replace(')', ')</span>');
    
    trendLabel.innerHTML = `<span class="trend-label-text">${cleanLabel}</span>`;

    // [VISUAL] Apply Signal Strength Gauge V2 Logic (Matching Fear & Greed)
    const trendSignalTile = document.getElementById('trendSignalTile');
    const trendSignalDesc = document.getElementById('trendSignalDesc');
    const trendGaugeFill = document.getElementById('trendGaugeFill');
    const trendGaugeNeedle = document.getElementById('trendGaugeNeedle');
    const strength = data.trend_strength || 0;
    
    if (trendSignalTile) {
        let signalClass = 'signal-weak';
        let signalText = '약한 신호';
        if (strength >= 70) {
            signalClass = 'signal-strong';
            signalText = '강한 신호';
        } else if (strength >= 50) {
            signalClass = 'signal-medium';
            signalText = '중간 신호';
        }
        
        trendSignalTile.className = `trend-signal-tile gauge-v2-mode ${signalClass}`;
        if (trendSignalDesc) trendSignalDesc.textContent = signalText;
        
        // Gauge V2 Rotation (Matching F&G)
        if (trendGaugeFill && trendGaugeNeedle) {
            const needleRotation = (strength / 100) * 180 - 90;
            const fillRotation = (strength / 100) * 180;
            trendGaugeNeedle.style.transform = `rotate(${needleRotation}deg)`;
            trendGaugeFill.style.transform = `rotate(${fillRotation}deg)`;
        }
    }

    trendText.textContent = `${strength}%`;


        // ── Legacy UX Restore: Rating & Financials ──
        const ratingBarsContainer = document.getElementById('ratingBarsContainer');
        const financialsGrid = document.getElementById('financialsGrid');
        const ratingScoreVal = document.getElementById('ratingScoreVal');

        if (ratingBarsContainer && financialsGrid) {
            // Deterministic mock logic (Unified with updateBasicAnalysis)
            const codeText = data.code || currentStock?.code || '005930';
            const hash = codeText.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
            const getMock = (min, max, offset = 0) => ((min + ((hash + offset) % (max - min))) / 10).toFixed(1);

            const overallScore = (6.0 + (hash % 35) / 10).toFixed(1);
            ratingScoreVal.textContent = data.score ? (data.score / 10).toFixed(1) : overallScore;

            const ratingLabels = ['수익성', '성장성', '안정성', '효율성', '시장평가'];
            const ratingGrades = ['부진', '보통', '양호', '우수', '매우 우수'];

            let barsHtml = '';
            ratingLabels.forEach((label, idx) => {
                // Use breakdown score if available, otherwise mock
                const scoreKey = ['roe', 'revenue_growth', 'debt_ratio', 'op_margin', 'market'][idx]; 
                const targetPct = (data.breakdown && data.breakdown[scoreKey]) ? data.breakdown[scoreKey] : Math.min(100, Math.max(30, 40 + (hash % 50) + (idx * 5)));
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

            // Animate bars
            observeElement(ratingBarsContainer, (el) => {
                el.querySelectorAll('.rating-fill').forEach((fillEl, idx) => {
                    fillEl.style.transitionDelay = `${idx * 0.1}s`;
                    void fillEl.offsetWidth;
                    fillEl.style.width = fillEl.getAttribute('data-target-width') + '%';
                });
            });

            // Financials Grid (ROE, PER, PBR, etc.) - Priority assigned to data from API
            const per = data.per || (getMock(50, 250) + 'x');
            const pbr = data.pbr || (getMock(5, 30, 7) + 'x');
            const roe = data.roe || (getMock(10, 250, 13) + '%');
            const debt = data.debt_ratio || (getMock(200, 1800, 17) + '%');

            financialsGrid.innerHTML = `
                <div class="finance-box"><span class="finance-label">PER</span><span class="finance-val">${per}</span></div>
                <div class="finance-box"><span class="finance-label">PBR</span><span class="finance-val">${pbr}</span></div>
                <div class="finance-box"><span class="finance-label">ROE</span><span class="finance-val">${roe}</span></div>
                <div class="finance-box"><span class="finance-label">부채비율</span><span class="finance-val">${debt}</span></div>
            `;

            // Add clarification note for ROE discrepancy
            const noteDiv = document.createElement('div');
            noteDiv.className = 'analysis-note';
            noteDiv.style.fontSize = '11px';
            noteDiv.style.color = '#94a3b8';
            noteDiv.style.marginTop = '12px';
            noteDiv.style.textAlign = 'center';
            noteDiv.style.width = '100%';
            noteDiv.innerHTML = '<i class="fas fa-info-circle"></i> ROE는 최근 결산 자료 기반이며, 계산 방식에 따라 실시간 지표와 차이가 있을 수 있습니다.';
            financialsGrid.parentNode.appendChild(noteDiv);
        }

    // ── 3. Patterns Block ──
    const aiPatternsBlock = document.getElementById('aiPatternsBlock');
    const patternsCard = document.getElementById('patternsCard');
    const patternsList = document.getElementById('patternsList');
    const noPatternsMsg = document.getElementById('noPatternsMsg');

    if (!data.patterns || data.patterns.length === 0) {
        if (aiPatternsBlock) {
            aiPatternsBlock.classList.remove('hidden'); // Always show the block header
            requestAnimationFrame(() => aiPatternsBlock.classList.add('visible'));
        }
        if (patternsCard) patternsCard.classList.remove('hidden');
        if (patternsList) patternsList.innerHTML = '';
        if (noPatternsMsg) noPatternsMsg.classList.remove('hidden');
    } else {
        if (aiPatternsBlock) {
            aiPatternsBlock.classList.remove('hidden');
            requestAnimationFrame(() => aiPatternsBlock.classList.add('visible'));
        }
        if (patternsCard) patternsCard.classList.remove('hidden');
        if (noPatternsMsg) noPatternsMsg.classList.add('hidden');
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

    // ── 4. Candle Chart Block ──
    const aiChartBlock = document.getElementById('aiChartBlock');
    const candleChartCard = document.getElementById('candleChartCard');
    if (data.recent_candles && data.recent_candles.length > 0) {
        if (aiChartBlock) {
            aiChartBlock.classList.remove('hidden', 'visible');
            requestAnimationFrame(() => aiChartBlock.classList.add('visible'));
        }
        if (candleChartCard) {
            candleChartCard.classList.remove('hidden', 'visible');
            requestAnimationFrame(() => candleChartCard.classList.add('visible'));
        }
        
        // [FIX] Ensure parent layout is reflowed before rendering chart to avoid 0-width issue
        setTimeout(() => {
            renderCandleChart(data.recent_candles);
        }, 100);
    } else {
        if (aiChartBlock) aiChartBlock.classList.add('hidden');
    }

    // ── 5. Recent Week Analysis / Summary Block ──
    const aiSummaryBlock = document.getElementById('aiSummaryBlock');
    const recentWeekAnalysis = document.getElementById('recentWeekAnalysis');
    const recentWeekList = document.getElementById('recentWeekList');

    if (data.recent_week_analysis && data.recent_week_analysis.length > 0) {
        if (aiSummaryBlock) {
            aiSummaryBlock.classList.remove('hidden');
            requestAnimationFrame(() => aiSummaryBlock.classList.add('visible'));
        }
        if (recentWeekAnalysis) recentWeekAnalysis.classList.remove('hidden');
        if (recentWeekList) {
            recentWeekList.innerHTML = '';
            data.recent_week_analysis.forEach(item => {
                const li = document.createElement('li');
                li.style.fontSize = "0.9rem";
                li.style.color = "var(--text-muted)";
                li.style.padding = "4px 0";
                li.style.listStyle = "none";
                li.style.borderBottom = "1px solid var(--border-soft)";
                if (data.recent_week_analysis.indexOf(item) === data.recent_week_analysis.length - 1) {
                    li.style.borderBottom = "none";
                }

                let colorStr = "var(--text-muted)";
                if (item.desc.includes('양봉')) colorStr = "var(--color-up)";
                else if (item.desc.includes('음봉')) colorStr = "var(--color-down)";

                li.innerHTML = `<span style="font-family: 'Space Grotesk', monospace; font-weight: 600; color: var(--text-main); margin-right: 12px;">${item.date}</span><span style="color: ${colorStr}; font-weight: 500;">${item.desc}</span>`;
                recentWeekList.appendChild(li);
            });
        }
    } else {
        if (recentWeekAnalysis) recentWeekAnalysis.classList.add('hidden');
    }

    // ── AI Insights: 확률점수 / ATR 목표가 / 거래량 이상 ──
    renderAiInsights(data);

    // ── 2. Buy/Sell Reports & Signals Block ──
    const signalsGrid = document.getElementById('aiSignalsGrid');
    const buyBlock = document.getElementById('aiBuySignalBlock');
    const sellBlock = document.getElementById('aiSellSignalBlock');
    
    // Check if reports exist (already declared at function top)
    renderBuyReport(data.buy_report);
    renderSellReport(data.sell_report, data.atr_targets);
    
    if (signalsGrid) {
        if (hasBuyReport || hasSellReport) {
            signalsGrid.classList.remove('hidden');
        } else {
            signalsGrid.classList.add('hidden');
        }
    }
    
    if (buyBlock) {
        if (!hasBuyReport) {
            buyBlock.classList.add('hidden');
            buyBlock.classList.remove('visible');
        }
    }
    
    if (sellBlock) {
        if (!hasSellReport) {
            sellBlock.classList.add('hidden');
            sellBlock.classList.remove('visible');
        }
    }

    // ── 3. Fundamental Analysis (Signal & Summary) ──
    // NO-OP: renderFundamentalReport is orchestrated exclusively by triggerFullDeepAnalysis
}

// ══════════════════════════════════════════════════════════
// 🧠  Fundamental Analysis Panel
// ══════════════════════════════════════════════════════════
async function renderFundamentalReport(stockCode) {
    const blocks = ['fundSummaryBlock', 'fundQuantBlock', 'fundEventBlock', 'fundSectorBlock', 'fundTargetBlock']
        .map(id => document.getElementById(id))
        .filter(el => !!el);

    // Ensure parent visibility for '데이터 분석 중…' state
    const contentWrapper = document.getElementById('analysisContentWrapper');
    const emptyState = document.getElementById('analysisEmptyState');
    if (contentWrapper) contentWrapper.classList.remove('hidden');
    if (emptyState) emptyState.classList.add('hidden');

    // Reveal summary block IMMEDIATELY for loading feedback, hide others to prepare sequence
    blocks.forEach(b => {
        b.classList.remove('visible');
        if (b.id === 'fundSummaryBlock') {
            b.classList.remove('hidden'); // SHOW LOADING
            requestAnimationFrame(() => b.classList.add('visible')); // ADD VISIBILITY FOR FADE
        } else {
            b.classList.add('hidden');
        }
    });

    // Skeleton state
    const reasonListInitial = document.getElementById('fundSummaryList');
    if (reasonListInitial) reasonListInitial.innerHTML = '<li class="fund-signal-reason" style="list-style: none; font-size: 0.9rem; color: var(--text-muted);">데이터 분석 중…</li>';
    const fundTypeBadge = document.getElementById('fundCompanyTypeBadge');
    const fundSignalBadge = document.getElementById('fundSignalBadge');
    if (fundTypeBadge) fundTypeBadge.textContent = '';
    if (fundSignalBadge) fundSignalBadge.textContent = '';
    
    document.getElementById('fundQuantContent').innerHTML = '<div class="skeleton-pulse" style="height:100px; width:100%;"></div>';
    document.getElementById('fundEventContent').innerHTML = '<div class="skeleton-pulse" style="height:60px; width:100%;"></div>';
    document.getElementById('fundSectorContent').innerHTML = '<div class="skeleton-pulse" style="height:120px; width:100%;"></div>';
    document.getElementById('fundTargetContent').innerHTML = '<div class="skeleton-pulse" style="height:150px; width:100%;"></div>';

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
        const reasonList = document.getElementById('fundSummaryList');
        if (reasonList) reasonList.innerHTML = `<li class="fund-signal-reason" style="list-style: none; font-size: 0.9rem; color: #ef4444;">❌ 펀더멘탈 데이터 로드 실패 (${e.message})</li>`;
        
        // Even on error, reveal the blocks that were hidden
        blocks.forEach((b, i) => {
            setTimeout(() => {
                b.classList.remove('hidden');
                requestAnimationFrame(() => b.classList.add('visible'));
            }, i * 100);
        });
        return;
    }

    // ── Header & Summary Setup ──
    const sigBadge = document.getElementById('fundSignalBadge');
    if (sigBadge) {
        sigBadge.textContent = d.signal_label || '';
        sigBadge.className = 'fund-signal-badge fund-signal-' + (d.signal || 'hold');
    }
    const typeBadge = document.getElementById('fundCompanyTypeBadge');
    if (typeBadge) {
        typeBadge.textContent = d.company_type_label || '';
    }

    // Update fundSummaryBlock with shared list style
    const summaryList = document.getElementById('fundSummaryList');
    if (summaryList) {
        summaryList.innerHTML = '';
        const reason = d.signal_reason || '분석 결과가 없습니다.';
        // Split if it contains ' | ' or render as single list item
        const reasonParts = reason.includes(' | ') ? reason.split(' | ') : [reason];
        
        reasonParts.forEach((part, idx) => {
            const li = document.createElement('li');
            li.style.fontSize = "0.9rem";
            li.style.color = "var(--text-secondary)";
            li.style.padding = "8px 0";
            li.style.listStyle = "none";
            li.style.borderBottom = (idx === reasonParts.length - 1) ? "none" : "1px solid var(--border-soft)";
            li.style.display = "flex";
            li.style.alignItems = "center";
            li.style.gap = "10px";
            
            // Add a small bullet or icon
            li.innerHTML = `<i class="ph ph-check-circle" style="color: var(--primary); font-size: 1.1rem; opacity: 0.8;"></i><span style="font-weight: 500;">${part}</span>`;
            summaryList.appendChild(li);
        });
    }

    // ── Quant Analysis ──
    const q = d.quant || {};
    const qRows = [
        ['ROE', q.roe != null ? q.roe + '%' : '—'],
        ['영업이익률', q.op_margin != null ? q.op_margin + '%' : '—'],
        ['부채비율', q.debt_ratio != null ? q.debt_ratio + '%' : '—'],
        ['연간 매출 성장', q.rev_growth != null ? (q.rev_growth > 0 ? '+' : '') + q.rev_growth + '%' : '—'],
        ['분기 매출 성장', q.qtr_growth != null ? (q.qtr_growth > 0 ? '+' : '') + q.qtr_growth + '%' : '—'],
    ];
    document.getElementById('fundQuantContent').innerHTML = `
        <div style="display:flex; flex-direction:column; gap:16px; width:100%;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <div style="font-size:0.85rem; color:var(--text-muted); font-weight:700;">분석 스코어</div>
                <div class="fund-score-badge" style="font-size:1.6rem; font-weight:900; color:var(--primary);">${q.score || '—'}점</div>
            </div>
            <table class="fund-metric-table" style="width:100%;">
                ${qRows.map(([k, v]) => `<tr><td style="color:var(--text-muted); font-size:0.85rem;">${k}</td><td style="text-align:right; font-weight:700; color:var(--text-main);">${v}</td></tr>`).join('')}
            </table>
            <div class="fund-score-desc" style="font-size:0.85rem; color:var(--text-sub); background:rgba(255,255,255,0.05); padding:12px; border-radius:12px; line-height:1.6;">
                ${q.score >= 75 ? '🔥 <b>매우 우수</b> - 강력한 펀더멘탈 기반' : q.score >= 55 ? '✅ <b>평균 이상</b> - 재무 안정성 확보' : '⚠️ <b>기준 미달</b> - 리스크 관리 필요'}
            </div>
            <div style="font-size:0.75rem; color:var(--text-muted); text-align:right;">${q.period || ''} ${q.qtr_period ? ' / ' + q.qtr_period : ''}</div>
        </div>`;

    // ── Event-Driven Analysis ──
    const evts = d.events || [];
    if (evts.length === 0) {
        document.getElementById('fundEventContent').innerHTML =
            '<div class="fund-no-data">최근 30일 주요 공시 없음</div>';
    } else {
        document.getElementById('fundEventContent').innerHTML = `
            <div style="display:flex; flex-direction:column; gap:12px; width:100%;">
                ${evts.map(ev => `
                <div class="fund-event-item fund-event-${ev.signal}" 
                     ${ev.rcept_no ? `onclick="window.open('https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${ev.rcept_no}', '_blank')"` : ''}
                     style="width:100%; padding:12px 16px; border-radius:12px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                        <span class="fund-event-label" style="font-size:0.8rem; font-weight:700;">${ev.label}</span>
                        <span class="fund-event-date" style="font-size:0.75rem; opacity:0.8;">${ev.date ? ev.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1.$2.$3') : ''}</span>
                    </div>
                    <div class="fund-event-title" title="${ev.title}" style="font-size:0.95rem; font-weight:600; line-height:1.5;">
                        ${ev.title.length > 40 ? ev.title.slice(0, 40) + '…' : ev.title}
                        ${ev.rcept_no ? '<i class="ph ph-arrow-square-out" style="font-size:0.85rem; margin-left:4px; opacity:0.6;"></i>' : ''}
                    </div>
                </div>`).join('')}
            </div>`;
    }

    // ── Sector Analysis ──
    const s = d.sector || {};
    const comps = s.comparisons || [];

    if (comps.length === 0) {
        document.getElementById('fundSectorContent').innerHTML =
            '<div class="fund-no-data">업종 비교 데이터 없음</div>';
    } else {
        document.getElementById('fundSectorContent').innerHTML = `
            <div style="display:flex; flex-direction:column; gap:10px; width:100%;">
                <div style="font-size:0.9rem; font-weight:700; color:var(--primary); margin-bottom:8px; display:flex; align-items:center; gap:6px;">
                    <i class="ph ph-trend-up" style="font-size:1.1rem;"></i>
                    ${s.name || '종합'} 업종 평균 대비
                </div>
                ${comps.map(c => `
                <div class="fund-event-item" style="width:100%; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); padding:12px 16px; border-radius:12px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                        <span style="font-size:0.8rem; color:var(--text-muted); font-weight:700;">${c.label}</span>
                        <span style="font-size:0.75rem; font-weight:900; color:${c.status === '우위' || c.status === '저평가' ? '#10b981' : '#ef4444'}; background:rgba(0,0,0,0.25); padding:2px 12px; border-radius:99px;">
                            ${c.status}
                        </span>
                    </div>
                    <div style="display:flex; justify-content:space-between; align-items:baseline;">
                        <span style="font-size:1.2rem; font-weight:800; color:var(--text-main);">${c.value}</span>
                        <span style="font-size:0.85rem; color:var(--text-muted); font-weight:600;">업계평균 ${c.avg}</span>
                    </div>
                </div>`).join('')}
            </div>`;
    }

    // ── Target Analysis ──
    const target = d.target;
    if (target) {
        const color = target.status === '저평가' || target.status === '매력' ? '#10b981' : (target.status === '고평가' ? '#ef4444' : '#6366f1');
        document.getElementById('fundTargetContent').innerHTML = `
            <div style="display:flex; flex-direction:column; gap:16px; width:100%;">
                <div style="text-align:center; padding:24px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); border-radius:20px; box-shadow: 0 4px 30px rgba(0,0,0,0.2);">
                    <div style="font-size:0.9rem; color:var(--text-muted); margin-bottom:10px; font-weight:700; letter-spacing:0.5px;">AI 예상 적정 가치</div>
                    <div style="font-size:2.2rem; font-weight:950; color:${color}; letter-spacing:-1px; line-height:1.1;">${Number(target.value).toLocaleString()}원</div>
                    <div style="font-size:1rem; margin-top:12px; display:flex; justify-content:center; align-items:center; gap:10px;">
                        <span style="background:${color}; color:white; padding:4px 14px; border-radius:99px; font-weight:900; font-size:0.85rem;">${target.status}</span>
                        <span style="color:var(--text-main); font-weight:700;">(기대수익: <span style="color:${target.upside > 0 ? '#10b981' : '#ef4444'}">${target.upside > 0 ? '+' : ''}${target.upside}%</span>)</span>
                    </div>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                    <div class="fund-tile-v2" style="background:rgba(255,255,255,0.03); padding:16px; border-radius:14px; border:1px solid rgba(255,255,255,0.06);">
                        <div class="tile-label" style="font-size:0.8rem; color:var(--text-muted); margin-bottom:6px; font-weight:600;">S-RIM 기반 가치</div>
                        <div class="tile-value" style="font-size:1.1rem; font-weight:800;">${Number(target.srim).toLocaleString()}<span style="font-size:0.8rem; margin-left:2px; opacity:0.7;">원</span></div>
                    </div>
                    <div class="fund-tile-v2" style="background:rgba(255,255,255,0.03); padding:16px; border-radius:14px; border:1px solid rgba(255,255,255,0.06);">
                        <div class="tile-label" style="font-size:0.8rem; color:var(--text-muted); margin-bottom:6px; font-weight:600;">청산 가치 (BPS)</div>
                        <div class="tile-value" style="font-size:1.1rem; font-weight:800;">${Number(target.basic).toLocaleString()}<span style="font-size:0.8rem; margin-left:2px; opacity:0.7;">원</span></div>
                    </div>
                </div>
                <div style="font-size:0.78rem; color:var(--text-muted); text-align:center; opacity:0.6; line-height:1.4;">
                    * ${target.method} (현금흐름할인법) 및 업종 멀티플 가중치 적용
                </div>
            </div>`;
    } else {
        document.getElementById('fundTargetContent').innerHTML = `
            <div class="fund-no-data" style="padding:30px;">재무 데이터 부족으로 산출 불가</div>`;
    }

    // ── 사용 축 태그 ──
    const axes = d.axes_used || [];
    const axesEl = document.getElementById('fundAxesUsed');
    if (axesEl) {
        axesEl.innerHTML = axes.map(a => `<span class="fund-axis-tag">${a}</span>`).join('');
    }

    // ── Final Reveal Orchestration (Reveal All Pillars) ──
    const pillarIds = ['fundSummaryBlock', 'fundQuantBlock', 'fundEventBlock', 'fundSectorBlock', 'fundTargetBlock'];
    pillarIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.classList.remove('hidden');
            el.classList.add('visible');
            el.style.setProperty('display', 'block', 'important');
            el.style.setProperty('opacity', '1', 'important');
            el.style.setProperty('transform', 'none', 'important');
        }
    });

    const tilesGrid = document.querySelector('.fund-tiles-grid');
    if (tilesGrid) {
        tilesGrid.classList.remove('hidden');
        tilesGrid.style.setProperty('display', 'grid', 'important');
        tilesGrid.style.setProperty('opacity', '1', 'important');
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
        // User Preference: Buy(High) = Blue, Sell(Low) = Red
        const scoreColor = score >= 50 ? '#3b82f6' : '#ef4444';
        const bd = prob.breakdown || {};
        const items = [
            { label: 'MA배열', val: bd.ma_alignment ?? 0, max: 35 },
            { label: 'RSI', val: bd.rsi ?? 0, max: 25 },
            { label: 'MACD', val: bd.macd ?? 0, max: 25 },
            { label: '거래량', val: bd.volume ?? 0, max: 15 },
        ];
        // ── 지표별 원형 인디케이터 (Parallel Circular Indicators) ──
        const indicatorCircles = items.map(it => {
            const pct = Math.min(100, Math.round((it.val / it.max) * 100));
            const r = 20;
            const circumference = 2 * Math.PI * r;
            const offset = circumference - (pct / 100) * circumference;
            return `
                <div class="ai-indicator-item">
                    <div class="ai-indicator-svg">
                        <svg viewBox="0 0 50 50" width="50" height="50">
                            <!-- Background Circle -->
                            <circle cx="25" cy="25" r="${r}" fill="none" stroke="var(--border-soft)" stroke-width="4"/>
                            <!-- Progress Circle -->
                            <circle cx="25" cy="25" r="${r}" fill="none" stroke="${scoreColor}" stroke-width="4"
                                stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"
                                stroke-linecap="round" transform="rotate(-90 25 25)"/>
                            <text x="25" y="29" text-anchor="middle" font-size="11" font-weight="800" fill="var(--text-main)">${pct}%</text>
                        </svg>
                    </div>
                    <div class="ai-indicator-meta">
                        <span class="ai-indicator-label">${it.label}</span>
                        <span class="ai-indicator-val">${it.val}/${it.max}</span>
                    </div>
                </div>`;
        }).join('');

        // ── 메인 세미 서클 확률 게이지 (Speedometer Style) ──
        const mainR = 40;
        // Semi-circle circumference for 180 degrees
        const arcLength = Math.PI * mainR; // ~125.6
        const mainOffset = arcLength - (score / 100) * arcLength;

        probHtml = `
        <div class="ai-insight-category-title">
            <i class="ph ph-target"></i>
            <span>매수 확률</span>
        </div>
        <div class="ai-insight-row">
            <div class="ai-row-main-content">
                <div class="ai-content-body">
                    <div class="ai-row-primary">
                        <div class="ai-gauge-container semi-circle">
                            <div class="ai-gauge-main">
                                <div class="ai-gauge-icon-labels">
                                    <div class="gauge-icon sell"><i class="ph ph-hand-palm"></i><span>매도</span></div>
                                    <div class="gauge-icon buy"><i class="ph ph-rocket"></i><span>매수</span></div>
                                </div>
                                <svg viewBox="0 0 100 60" width="160" height="100">
                                    <!-- Background Arc -->
                                    <path d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke="var(--border-soft)" stroke-width="10" stroke-linecap="round"/>
                                    <!-- Progress Arc -->
                                    <path d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke="${scoreColor}" stroke-width="10" 
                                        stroke-dasharray="${arcLength}" stroke-dashoffset="${mainOffset}"
                                        stroke-linecap="round" style="transition: stroke-dashoffset 1.5s ease-out;"/>
                                    <text x="50" y="45" text-anchor="middle" font-size="24" font-weight="900" fill="var(--text-main)">${score}%</text>
                                </svg>
                                <span class="ai-gauge-label" style="background:${scoreColor}15; color:${scoreColor}">${prob.label}</span>
                            </div>
                        </div>
                    </div>
                    <div class="ai-row-details">
                        <div class="ai-indicators-parallel">
                            ${indicatorCircles}
                        </div>
                    </div>
                </div>
            </div>
            <div class="ai-row-insight">
                <span>추세 강도, 탄력성, 거래량 및 캔들 패턴 가중 합산 결과입니다. 모든 게이지가 통일된 원형 디자인으로 표시됩니다.</span>
            </div>
        </div>`;
    }

    // ── 2. ATR 목표가/손절가 ──
    let atrHtml = '';
    if (atr) {
        const rrColor = (atr.rr_ratio ?? 0) >= 1.5 ? '#10b981' : '#f59e0b';
        atrHtml = `
        <div class="ai-insight-category-title">
            <i class="ph ph-chart-line"></i>
            <span>목표 / 손절</span>
        </div>
        <div class="ai-insight-row">
            <div class="ai-row-main-content">
                <div class="ai-content-body">
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
        volHtml = `
        <div class="ai-insight-category-title">
            <i class="ph ph-wave-sine"></i>
            <span>거래량 이상</span>
        </div>
        <div class="ai-insight-row">
            <div class="ai-row-main-content">
                <div class="ai-content-body">
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
                </div>
            </div>
            <div class="ai-row-insight">
                <span>평소 대비 20일 거래량 이탈 분석. ${vol.direction === 'up' ? '매수세 가담' : '매도세 출현'} 신호 감지.</span>
            </div>
        </div>`;
    }

    body.innerHTML = `
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
    // 컨테이너 패딩(24px * 2 = 48px)을 고려하여 너비 산출
    const parent = document.getElementById('cycleWidgetBody');
    const svgW = parent ? parent.clientWidth : 400; 
    const svgH = 150;
    const padL = 50, padR = 50, padTop = 35, padBot = 40;
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
            html += `<text x="${cx}" y="${lineY - 22}" text-anchor="middle" fill="${phaseColor}" font-size="16" font-weight="800">현재 (D-${cyc.est_remaining_days})</text>`;
        } else if (p.type === 'future') {
            // Target dot
            html += `<circle cx="${cx}" cy="${lineY}" r="8" fill="none" stroke="${futureColor}" stroke-width="3" stroke-dasharray="4,3"/>`;
            html += `<circle cx="${cx}" cy="${lineY}" r="3" fill="${futureColor}"/>`;
            html += `<text x="${cx}" y="${lineY - 22}" text-anchor="middle" fill="${futureColor}" font-size="16" font-weight="800">🎯 변곡점</text>`;
        } else {
            // Past peak dot (solid)
            html += `<circle cx="${cx}" cy="${lineY}" r="5" fill="${lineFill}" stroke="${isLight ? '#94a3b8' : '#475569'}" stroke-width="2"/>`;
        }

        // Date label below
        html += `<text x="${cx}" y="${lineY + 35}" text-anchor="middle" fill="${textFill}" font-size="14" font-weight="600">${p.label}</text>`;

        // Days between peaks (show above connecting line)
        if (i > 0 && p.days != null && p.type !== 'current') {
            const midX = padL + (i - 0.5) * stepW;
            const textColor = p.type === 'future' ? futureColor : textFill;
            html += `<text x="${midX}" y="${lineY - 14}" text-anchor="middle" fill="${textColor}" font-size="14" font-weight="700">${p.days}일</text>`;
        }
    });

    // Chart title
    html += `<text x="${padL}" y="20" fill="${textFill}" font-size="16" font-weight="800">📈 사이클 타임라인</text>`;
    html += `<text x="${svgW - padR}" y="18" fill="${textFill}" font-size="12" text-anchor="end">평균 ${cyc.avg_cycle_days}일 · ${cyc.cycles_detected}개 사이클</text>`;

    html += '</svg>';
    container.innerHTML = html;

    // [CRITICAL] Set initial scroll position to the far right (most recent data)
    // Wrap in requestAnimationFrame to ensure DOM is ready
    requestAnimationFrame(() => {
        container.scrollLeft = container.scrollWidth;
        console.log('[DEBUG] Candle chart scroll set to right:', container.scrollLeft);
    });
}


let currentChart = null;

function calculateRSI(data, period = 14) {
    if (data.length <= period) return [];
    const rsi = [];
    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        const change = data[i].close - data[i - 1].close;
        if (change > 0) gains += change;
        else losses -= change;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period; i < data.length; i++) {
        if (i > period) {
            const change = data[i].close - data[i - 1].close;
            avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
            avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period;
        }
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        const val = 100 - (100 / (1 + rs));
        rsi.push({ time: data[i].time, value: val });
    }
    return rsi;
}

function renderCandleChart(candles) {
    const container = document.getElementById('candleChart');
    if (!candles || candles.length === 0) {
        container.innerHTML = '<div class="no-patterns">캔들 데이터 없음</div>';
        return;
    }

    // Clear existing chart instance if any
    if (currentChart) {
        currentChart.remove();
        currentChart = null;
    }
    
    // 차트 컨테이너 초기화 시 범례(Legend) 요소 보존
    container.innerHTML = '<div id="chartLegend" class="macro-chart-legend"></div>';

    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    
    // Ensure container has width
    const containerWidth = container.clientWidth || (container.parentElement ? container.parentElement.clientWidth : 800);
    
    const chartOptions = {
        width: containerWidth,
        height: 600,
        layout: {
            background: { type: 'solid', color: 'transparent' },
            textColor: isLight ? '#1e293b' : '#f8fafc',
            fontFamily: 'Inter, sans-serif',
        },
        grid: {
            vertLines: { color: isLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)' },
            horzLines: { color: isLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)' },
        },
        crosshair: {
            mode: 1, // Normal crosshair
            vertLine: { labelBackgroundColor: '#6366f1' },
            horzLine: { labelBackgroundColor: '#6366f1' },
        },
        timeScale: {
            borderColor: isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)',
            timeVisible: true,
            secondsVisible: false,
        },
        handleScroll: {
            mouseWheel: true,
            pressedMouseMove: true,
            horzTouchDrag: true,
            vertTouchDrag: false,
        },
        handleScale: {
            mouseWheel: true,
            pinch: true,
            axisPressedMouseMove: true,
        },
    };

    const chart = LightweightCharts.createChart(container, chartOptions);
    currentChart = chart;

    // 1. Candlestick Series
    const candleSeries = chart.addCandlestickSeries({
        upColor: '#ef4444',
        downColor: '#3b82f6',
        borderVisible: false,
        wickUpColor: '#ef4444',
        wickDownColor: '#3b82f6',
        priceScaleId: 'right',
    });

    candleSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.05, bottom: 0.35 },
    });

    const ma5Options = { color: '#F59E0B', lineWidth: 1.5, title: '5', priceScaleId: 'right' };
    const ma20Options = { color: '#EC4899', lineWidth: 1.5, title: '20', priceScaleId: 'right' };
    const ma60Options = { color: '#06B6D4', lineWidth: 1.5, title: '60', priceScaleId: 'right' };
    const ma120Options = { color: '#8B5CF6', lineWidth: 1.5, title: '120', priceScaleId: 'right' };

    const ma5Series = chart.addLineSeries(ma5Options);
    const ma20Series = chart.addLineSeries(ma20Options);
    const ma60Series = chart.addLineSeries(ma60Options);
    const ma120Series = chart.addLineSeries(ma120Options);

    // 3. Volume Series (Pane 2)
    const volumeSeries = chart.addHistogramSeries({
        color: '#71717a',
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume', 
    });
    chart.priceScale('volume').applyOptions({
        scaleMargins: { top: 0.65, bottom: 0.20 },
    });

    // 4. RSI Series (Pane 3)
    const rsiSeries = chart.addLineSeries({
        color: '#818cf8',
        lineWidth: 2,
        priceScaleId: 'rsi',
        title: 'RSI(14)',
    });
    chart.priceScale('rsi').applyOptions({
        scaleMargins: { top: 0.80, bottom: 0.02 },
    });

    // Add RSI Levels
    rsiSeries.createPriceLine({
        price: 70,
        color: 'rgba(239, 68, 68, 0.4)',
        lineWidth: 1,
        lineStyle: 2, // Dashed
        axisLabelVisible: true,
        title: 'OVERBOUGHT',
    });
    rsiSeries.createPriceLine({
        price: 30,
        color: 'rgba(59, 130, 246, 0.4)',
        lineWidth: 1,
        lineStyle: 2, // Dashed
        axisLabelVisible: true,
        title: 'OVERSOLD',
    });

    // Prepare data
    // Original date format might be '2024-04-05' or similar
    const candleData = [];
    const volData = [];
    const ma5Data = [];
    const ma20Data = [];
    const ma60Data = [];
    const ma120Data = [];

    // Heikin-Ashi Calculation variables
    let haPrevOpen = null;
    let haPrevClose = null;

    candles.forEach((c, index) => {
        const time = c.date; // Expecting 'YYYY-MM-DD'
        
        let displayOpen = c.open;
        let displayClose = c.close;
        let displayHigh = c.high;
        let displayLow = c.low;
        let isBullish = c.is_bullish;
        
        if (currentChartDrawType === 'heikin_ashi') {
            let haClose = (c.open + c.high + c.low + c.close) / 4;
            let haOpen = index === 0 ? c.open : (haPrevOpen + haPrevClose) / 2;
            let haHigh = Math.max(c.high, haOpen, haClose);
            let haLow = Math.min(c.low, haOpen, haClose);
            
            displayOpen = haOpen;
            displayClose = haClose;
            displayHigh = haHigh;
            displayLow = haLow;
            isBullish = displayClose > displayOpen; // In standard HA, > is bullish. (Wait! In KR, red=bullish but close>open implies RED)
            // Wait, we defined UpColor='#ef4444'(Red), DownColor='#3b82f6'(Blue). The chart automatically colors it based on displayClose > displayOpen.
            
            haPrevOpen = haOpen;
            haPrevClose = haClose;
        }

        candleData.push({ time, open: displayOpen, high: displayHigh, low: displayLow, close: displayClose });
        volData.push({ 
            time, 
            value: c.volume, 
            color: isBullish ? 'rgba(239, 68, 68, 0.5)' : 'rgba(59, 130, 246, 0.5)' 
        });
        if (c.ma5) ma5Data.push({ time, value: c.ma5 });
        if (c.ma20) ma20Data.push({ time, value: c.ma20 });
        if (c.ma60) ma60Data.push({ time, value: c.ma60 });
        if (c.ma120) ma120Data.push({ time, value: c.ma120 });
    });

    // ── Data Application ──
    candleSeries.setData(candleData);
    volumeSeries.setData(volData);
    ma5Series.setData(ma5Data);
    ma20Series.setData(ma20Data);
    ma60Series.setData(ma60Data);
    ma120Series.setData(ma120Data);

    // Calculate and set RSI data
    const rsiData = calculateRSI(candleData, 14);
    rsiSeries.setData(rsiData);

    const totalCount = candleData.length;
    let isInitialAnimating = true;

    // Phase 1: Sliding Viewport Reveal (High-end sliding animation)
    // We want to show a 60-bar window (approx 3 months) eventually.
    // Start by showing only the left 1/3 of that window and expand right.
    const finalWindowSize = Math.min(totalCount, 60); 
    const startWindowSize = Math.min(totalCount, 15);
    let currentWindowSize = startWindowSize;

    function animateViewport() {
        if (currentWindowSize < finalWindowSize) {
            currentWindowSize++;
            chart.timeScale().setVisibleLogicalRange({
                from: totalCount - finalWindowSize,
                to: totalCount - finalWindowSize + currentWindowSize,
            });
            requestAnimationFrame(animateViewport);
        } else {
            isInitialAnimating = false;
        }
    }

    // Initial fixed view (before sliding)
    chart.timeScale().setVisibleLogicalRange({
        from: totalCount - finalWindowSize,
        to: totalCount - finalWindowSize + startWindowSize,
    });
    
    // Start sliding animation after a short delay
    setTimeout(animateViewport, 300);

    // Phase 2: Lazy Animation on Scroll (Discovering even older history)
    // We don't need a custom discovery loop anymore because data is already there.
    // However, to satisfy the "one after another" request for the past,
    // we can keep the discovery logic OR just let the user explore.
    // Given the previous request, the sliding reveal above handles the core "wow".
    
    // Check if user has navigated past the initial 60 bars (for the future-proofness)
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (isInitialAnimating || !range) return;
        // User is free to explore the pre-loaded 1 year of data.
    });

    let isRevealingPast = false;
    function revealPastData(targetIdx) {
        if (isRevealingPast) return;
        isRevealingPast = true;

        function step() {
            if (renderedStartIndex > targetIdx) {
                renderedStartIndex--;
                // Prepend 1 candle by updating the whole set (setData is required for prepending in LW Charts)
                const newVisibleData = candleData.slice(renderedStartIndex);
                candleSeries.setData(newVisibleData);
                volumeSeries.setData(volData.slice(renderedStartIndex));
                
                // Optimized MA filtering
                const visibleTimes = new Set(newVisibleData.map(d => d.time));
                ma5Series.setData(ma5Data.filter(d => visibleTimes.has(d.time)));
                ma20Series.setData(ma20Data.filter(d => visibleTimes.has(d.time)));
                ma60Series.setData(ma60Data.filter(d => visibleTimes.has(d.time)));
                ma120Series.setData(ma120Data.filter(d => visibleTimes.has(d.time)));

                setTimeout(step, 10); // Very fast reveal
            } else {
                isRevealingPast = false;
            }
        }
        step();
    }

    // Update Title with Dynamic Range Info
    const titleEl = document.getElementById('chartTitle');
    if (titleEl) {
        titleEl.innerHTML = `<i class="ph ph-chart-line-up" style="margin-right: 6px;"></i> 최근 12개월 주가 분석 (줌/드래그 지원)`;
    }

    // ── Top Legend Interaction ──
    const legend = document.getElementById('chartLegend');
    function updateLegend(param) {
        let data = null;
        if (param && param.time) {
            data = {
                time: param.time,
                open: param.seriesData.get(candleSeries)?.open,
                high: param.seriesData.get(candleSeries)?.high,
                low: param.seriesData.get(candleSeries)?.low,
                close: param.seriesData.get(candleSeries)?.close,
                ma5: param.seriesData.get(ma5Series),
                ma20: param.seriesData.get(ma20Series),
                ma60: param.seriesData.get(ma60Series),
                ma120: param.seriesData.get(ma120Series),
                rsi: param.seriesData.get(rsiSeries)
            };
        } else {
            // Default to last data point
            const lastIdx = candleData.length - 1;
            if (lastIdx >= 0) {
                const c = candleData[lastIdx];
                data = {
                    time: c.time,
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close,
                    ma5: ma5Data.find(d => d.time === c.time)?.value,
                    ma20: ma20Data.find(d => d.time === c.time)?.value,
                    ma60: ma60Data.find(d => d.time === c.time)?.value,
                    ma120: ma120Data.find(d => d.time === c.time)?.value,
                    rsi: rsiData.find(d => d.time === c.time)?.value
                };
            }
        }

        if (data && legend) {
            const isUp = data.close >= data.open;
            const colorClass = isUp ? 'bullish' : 'bearish';
            const fmt = (v) => v != null ? Math.round(v).toLocaleString() : '—';
            
            const dateParts = data.time.split('-');
            const displayDate = dateParts.length >= 3 ? `${dateParts[1]}-${dateParts[2]}` : data.time;
            
            legend.innerHTML = `
                <div class="legend-item"><span class="legend-label">일자</span><span class="legend-val">${displayDate}</span></div>
                <div class="legend-item"><span class="legend-label">RSI(14)</span><span class="legend-val" style="color:#818cf8;">${data.rsi ? data.rsi.toFixed(1) : '—'}</span></div>
                <div class="legend-item"><span class="legend-label ma5-label">5일선</span><span class="legend-val ma5-label">${fmt(data.ma5)}</span></div>
                <div class="legend-item"><span class="legend-label ma20-label">20일선</span><span class="legend-val ma20-label">${fmt(data.ma20)}</span></div>
                <div class="legend-item"><span class="legend-label ma60-label">60일선</span><span class="legend-val ma60-label">${fmt(data.ma60)}</span></div>
                <div class="legend-item"><span class="legend-label ma120-label">120일선</span><span class="legend-val ma120-label">${fmt(data.ma120)}</span></div>
            `;
        }
    }

    chart.subscribeCrosshairMove(updateLegend);
    updateLegend(); // Initial call

    // Resize handling is now managed globally to avoid listener accumulation
    // and performance issues on mobile zoom/resize events.

    // ── MA Visual Bars (The "Quicken" Style Bars below chart) ──
    const maVisualBarsContainer = document.getElementById('maVisualBars');
    if (maVisualBarsContainer) {
        setTimeout(() => {
            maVisualBarsContainer.querySelectorAll('.ma-bar-fill').forEach(fillEl => {
                const targetW = fillEl.getAttribute('data-target-width');
                if (targetW) fillEl.style.width = targetW + '%';
            });
            maVisualBarsContainer.querySelectorAll('.ma-bar-current-price').forEach(priceEl => {
                const targetL = priceEl.getAttribute('data-target-left');
                if (targetL) priceEl.style.left = targetL + '%';
            });
        }, 300);
    }
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

    // 1. Signal Strength Bar
    const strength = report.signal_strength || 0;
    const strengthPctEl = document.getElementById('buyStrengthPct');
    const strengthFillEl = document.getElementById('buyStrengthFill');
    if (strengthPctEl) strengthPctEl.textContent = `${strength}%`;
    if (strengthFillEl) {
        // Trigger animation
        setTimeout(() => {
            strengthFillEl.style.width = `${strength}%`;
        }, 100);
    }

    // 2. Pattern Detail
    document.getElementById('buySignalBadge').textContent = `신뢰도 ${strength}%`;
    document.getElementById('buyPattern').textContent = report.primary_pattern;
    document.getElementById('buyDesc').textContent = report.primary_pattern_desc;
    
    // 3. Price Grid
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

    // 1. Signal Strength Bar
    const strength = report.signal_strength || 0;
    const strengthPctEl = document.getElementById('sellStrengthPct');
    const strengthFillEl = document.getElementById('sellStrengthFill');
    if (strengthPctEl) strengthPctEl.textContent = `${strength}%`;
    if (strengthFillEl) {
        setTimeout(() => {
            strengthFillEl.style.width = `${strength}%`;
        }, 100);
    }

    // 2. Pattern Detail
    document.getElementById('sellSignalBadge').textContent = `신뢰도 ${strength}%`;
    document.getElementById('sellPattern').textContent = report.primary_pattern;
    document.getElementById('sellDesc').textContent = report.primary_pattern_desc;
    
    // 3. Price Grid
    document.getElementById('sellPrice').textContent = formatPrice(report.sell_price);
    document.getElementById('sellConservative').textContent = formatPrice(report.conservative_sell);
    document.getElementById('sellTarget').textContent = formatPrice(report.target_price);
    document.getElementById('sellStopLoss').textContent = formatPrice(report.stop_loss);
    
    document.getElementById('sellRiskReward').textContent = report.risk_reward;
    document.getElementById('sellVolume').innerHTML = `<i class="ph ph-chart-bar"></i> ${report.volume_note}`;
    document.getElementById('sellTip').innerHTML = `<i class="ph ph-lightbulb"></i> ${report.exit_tip}`;

    // ATR 비교 노트 표시 (Dynamic Injection if needed, or update Tip)
    if (atrTargets) {
        const patternSL = typeof report.stop_loss === 'number' ? report.stop_loss : null;
        const atrSL = atrTargets.stop_loss;
        const noteHtml = `<div id="sellAtrNote" class="atr-note">`
            + `<i class="ph ph-info" style="margin-right:4px;"></i>`
            + `<strong>ATR 기준 손절가:</strong> ${atrSL ? atrSL.toLocaleString() + '원' : '-'}`;
        
        let extra = '';
        if (patternSL && atrSL) {
            const diff = patternSL - atrSL;
            const pct = ((Math.abs(diff) / atrSL) * 100).toFixed(1);
            const dir = diff > 0 ? `패턴 기준이 ${pct}% 더 높음 (더 엄격)` : diff < 0 ? `ATR 기준이 ${pct}% 더 높음 (더 여유)` : '동일';
            extra = `<br><span style="opacity: 0.8; font-size: 0.75rem;">(${dir})</span>`;
        }
        
        const existingNote = document.getElementById('sellAtrNote');
        if (existingNote) existingNote.remove();
        
        card.insertAdjacentHTML('beforeend', noteHtml + extra + '</div>');
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
    
    // ── Sync Init (blocking is fine, these are instant DOM operations) ──
    const safeRun = (name, fn) => {
        try {
            console.log(`[DEBUG] Initializing: ${name}`);
            fn();
        } catch (err) {
            console.error(`[ERROR] Failed to initialize ${name}:`, err);
        }
    };

    safeRun('Theme', initTheme);
    safeRun('Navigation', initNavigation);
    safeRun('MobileSidebar', initMobileSidebar);
    safeRun('Watchlist', renderWatchlist);

    // ── Async Init (fire-and-forget, must NOT block UI rendering) ──
    renderMacroIndicators().catch(err => console.error('[ERROR] MacroIndicators failed:', err));
    initAuth().catch(err => console.error('[ERROR] initAuth failed:', err));

    if (searchInput) {
        searchInput.focus();
    }

    document.getElementById('themeToggle')?.addEventListener('click', toggleTheme);
    renderRecentSearches();
    document.getElementById('clearRecent')?.addEventListener('click', clearRecentSearches);

    // Unified Favorite Button Listener
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
    initResizableSidebar();
    document.getElementById('sidebarToggle')?.addEventListener('click', toggleSidebarOpen);
    document.getElementById('sidebarOverlay')?.addEventListener('click', closeSidebar);

    // Search Button Listener
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

    // [PERSISTENCE] Restore last searched stock if it exists to maintain context after refresh
    const lastStockStr = localStorage.getItem('signnith_last_stock');
    if (lastStockStr) {
        try {
            const lastStock = JSON.parse(lastStockStr);
            console.log('[DEBUG] Restoring last searched stock from storage:', lastStock.name);
            // Delay slightly to ensure all initializers are ready
            setTimeout(() => selectStock(lastStock, 'restore'), 300);
        } catch (e) {
            console.error('[ERROR] Failed to restore last stock:', e);
            localStorage.removeItem('signnith_last_stock');
        }
    }
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

    // WebView Warning Elements
    const webviewWarningOverlay = document.getElementById('webviewWarningOverlay');
    const webviewWarningModal = document.getElementById('webviewWarningModal');
    const webviewCloseBtn = document.getElementById('webviewCloseBtn');

    /**
     * 인앱 브라우저(WebView) 여부 감지
     */
    const getInAppBrowserInfo = () => {
        const ua = navigator.userAgent || navigator.vendor || window.opera;
        const info = {
            isInApp: false,
            isKakao: ua.indexOf('KAKAOTALK') > -1,
            isInstagram: ua.indexOf('Instagram') > -1,
            isFacebook: (ua.indexOf('FBAN') > -1) || (ua.indexOf('FBAV') > -1),
            isAndroid: ua.indexOf('Android') > -1,
            isIOS: /iPhone|iPad|iPod/i.test(ua)
        };
        
        info.isInApp = info.isKakao || info.isInstagram || info.isFacebook || 
                       ua.indexOf('Line') > -1 || ua.indexOf('NAVER') > -1;
        
        return info;
    };

    /**
     * 외부 브라우저(시스템 브라우저)로 강제 전환 시도
     */
    const autoExternalBrowser = () => {
        const info = getInAppBrowserInfo();
        if (!info.isInApp) return;

        const currentUrl = window.location.href;

        // 1. 카카오톡 전용 스키마 (iOS/Android 공통)
        if (info.isKakao) {
            window.location.href = `kakaotalk://web/openExternal?url=${encodeURIComponent(currentUrl)}`;
            return true;
        }

        // 2. 안드로이드 인텐트 스키마 (Chrome 강제 실행)
        if (info.isAndroid) {
            const intentUrl = `intent://${currentUrl.replace(/https?:\/\//, '')}#Intent;scheme=https;package=com.android.chrome;end`;
            window.location.href = intentUrl;
            return true;
        }

        // iOS 인스타그램/페이스북 등은 자동 전환이 제한적이므로 가이드 모달 노출 유지
        return false;
    };

    const isInAppBrowser = () => getInAppBrowserInfo().isInApp;

    const showWebviewWarning = () => {
        // 자동 전환 시도
        const success = autoExternalBrowser();
        
        // 자동 전환에 실패했거나(iOS 등), 사용자가 여전히 페이지에 머물러 있는 경우 모달 표시
        webviewWarningOverlay?.classList.add('active');
        webviewWarningModal?.classList.add('active');
    };

    const hideWebviewWarning = () => {
        webviewWarningOverlay?.classList.remove('active');
        webviewWarningModal?.classList.remove('active');
    };

    webviewCloseBtn?.addEventListener('click', hideWebviewWarning);
    webviewWarningOverlay?.addEventListener('click', hideWebviewWarning);
    
    // 수동 자동실행 시도 버튼 (모달 내 추가될 버튼)
    document.getElementById('webviewAutoOpenBtn')?.addEventListener('click', () => {
        autoExternalBrowser();
    });



    // 모달 열기/닫기 로직
    const showAuthModal = () => {
        authModalOverlay.classList.add('show');
        authModal.classList.add('show');
    };

    const hideAuthModal = () => {
        authModalOverlay.classList.remove('show');
        authModal.classList.remove('show');
        authErrorMsg.textContent = '';
    };

    sidebarUserSection?.addEventListener('click', async () => {
        if (!authUser || !authUser.logged_in) {
            showAuthModal();
        } else {
            // Logged in: Show logout confirmation modal
            const confirmed = await window.showConfirm('로그아웃', '정말 로그아웃 하시겠습니까?', 'info');
            if (confirmed) {
                await fetch(API_BASE_URL + '/api/logout', { method: 'POST', headers: getAuthHeaders() });
                removeSupaToken();
                authUser = null;
                currentWatchlist = [];
                updateAuthUI();
                renderWatchlist();
                updateWatchlistBtn();
                // Optionally close sidebar after logging out
                if (!isSidebarExpanded()) closeSidebar();
            }
        }
    });

    closeAuthModal?.addEventListener('click', hideAuthModal);
    authModalOverlay?.addEventListener('click', hideAuthModal);

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
        if (!sbClient) { await window.showModal('인증 오류', '구글 로그인을 사용할 수 없습니다.', 'error'); return; }
        
        // 인앱 브라우저 체크
        if (isInAppBrowser()) {
            hideAuthModal();
            showWebviewWarning();
            return;
        }

        if (oauthConfirmOverlay && oauthConfirmModal) {
            hideAuthModal();
            oauthConfirmOverlay.classList.add('active');
            oauthConfirmModal.classList.add('active');
        }
    });

    oauthCancelBtn?.addEventListener('click', () => {
        oauthConfirmOverlay.classList.remove('active');
        oauthConfirmModal.classList.remove('active');
        showAuthModal();
    });

    oauthContinueBtn?.addEventListener('click', async () => {
        if (!sbClient) { await window.showModal('인증 오류', '구글 로그인을 사용할 수 없습니다.', 'error'); return; }
        
        // 인앱 브라우저 이중 체크 (보안 정책 회피 대비)
        if (isInAppBrowser()) {
            oauthConfirmOverlay?.classList.remove('active');
            oauthConfirmModal?.classList.remove('active');
            showWebviewWarning();
            return;
        }

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
            await showModal('인증 오류', 'Google 로그인 오류: ' + (err.message || '알 수 없는 오류'), 'error');
            oauthConfirmOverlay?.classList.remove('active');
            oauthConfirmModal?.classList.remove('active');
        } finally {
            if (oauthContinueBtn) {
                oauthContinueBtn.disabled = false;
                oauthContinueBtn.style.opacity = '1';
            }
        }
    });



    const updateAuthUI = () => {
        const userNameEl = document.getElementById('sidebarUserName');
        const userStatusEl = document.getElementById('sidebarUserStatus');
        const navWatchlist = document.getElementById('navWatchlist');
        const navAnalysis = document.getElementById('navAnalysis');
        const navValueChain = document.getElementById('navValueChain');
        const addWatchlistBtnContainer = document.getElementById('addWatchlistBtnContainer');
        const pageGreeting = document.getElementById('pageGreeting');

        console.log('[DEBUG] updateAuthUI - logged_in:', authUser?.logged_in);
        if (authUser && authUser.logged_in) {
            console.log('[DEBUG] updateAuthUI - Updating UI for Logged In User');
            if (userNameEl) {
                const name = authUser.username ? authUser.username : 'User';
                userNameEl.innerHTML = name + (authUser.role === 'admin' ? ' <span class="admin-sidebar-badge" style="background:var(--primary); color:#fff; font-size:9px; padding:1px 5px; border-radius:4px; vertical-align:middle; font-weight:800; margin-left:4px;">ADMIN</span>' : '');
            }
            if (userStatusEl) userStatusEl.textContent = '';
            if (sidebarLogoutBtn) sidebarLogoutBtn.classList.remove('hidden');
            const sidebarWithdrawBtn = document.getElementById('sidebarWithdrawBtn');
            if (sidebarWithdrawBtn) {
                // 관리자는 계정 보호를 위해 탈퇴 메뉴를 노출하지 않음
                if (authUser.role === 'admin') {
                    sidebarWithdrawBtn.classList.add('hidden');
                } else {
                    sidebarWithdrawBtn.classList.remove('hidden');
                }
            }
            if (sidebarUserSection) {
                sidebarUserSection.style.cursor = 'pointer';
                sidebarUserSection.title = "클릭하면 로그아웃할 수 있습니다";
            }

            // Profile Image Handling
            const sidebarUserIcon = document.getElementById('sidebarUserIcon');
            const sidebarUserImg = document.getElementById('sidebarUserImg');
            if (authUser.avatar_url) {
                if (sidebarUserIcon) sidebarUserIcon.classList.add('hidden');
                if (sidebarUserImg) {
                    sidebarUserImg.src = authUser.avatar_url;
                    sidebarUserImg.classList.remove('hidden');
                }
            } else {
                if (sidebarUserIcon) sidebarUserIcon.classList.remove('hidden');
                if (sidebarUserImg) sidebarUserImg.classList.add('hidden');
            }

            if (addWatchlistBtnContainer) addWatchlistBtnContainer.classList.remove('remove');
            updateWatchlistCount();

            // --- [승인 시스템 적용] 승인 상태 배너 및 메뉴 제어 ---
            const pendingBanner = document.getElementById('pendingApprovalBanner');
            const navAdmin = document.getElementById('navAdmin');
            const navAnalysis = document.getElementById('navAnalysis');
            const navValueChain = document.getElementById('navValueChain');
            const navWatchlist = document.getElementById('navWatchlist');

            if (authUser.is_approved) {
                if (pendingBanner) pendingBanner.classList.add('hidden');
                if (navAnalysis) navAnalysis.style.display = 'flex';
                if (navValueChain) navValueChain.style.display = 'flex';
                if (navWatchlist) navWatchlist.style.display = 'flex';
            } else {
                if (pendingBanner) pendingBanner.classList.remove('hidden');
                if (navAnalysis) navAnalysis.style.display = 'none';
                if (navValueChain) navValueChain.style.display = 'none';
                if (navWatchlist) navWatchlist.style.display = 'none';
                
                // 승인 대기 중인데 차단된 섹션에 있다면 홈으로
                const restricted = ['watchlistSection', 'analysisSection', 'valueChainSection'];
                if (restricted.includes(currentActiveSectionId)) {
                    navigateToSection('navHome');
                }
            }

            // 관리자 메뉴 노출
            if (authUser.role === 'admin') {
                if (navAdmin) navAdmin.classList.remove('hidden');
            } else {
                if (navAdmin) navAdmin.classList.add('hidden');
            }
        } else {
            console.log('[DEBUG] updateAuthUI - Updating UI for Guest');
            if (userNameEl) userNameEl.textContent = 'Guest';
            if (userStatusEl) userStatusEl.textContent = '로그인이 필요합니다';
            
            if (sidebarLogoutBtn) sidebarLogoutBtn.classList.add('hidden');
            const sidebarWithdrawBtn = document.getElementById('sidebarWithdrawBtn');
            if (sidebarWithdrawBtn) sidebarWithdrawBtn.classList.add('hidden');
            if (sidebarUserSection) {
                sidebarUserSection.style.cursor = 'pointer';
                sidebarUserSection.title = "로그인하려면 클릭하세요";
            }

            // 비로그인(Guest)에게는 핵심 분석 메뉴를 숨김 (v54 Update)
            if (navAnalysis) navAnalysis.style.display = 'none';
            if (navValueChain) navValueChain.style.display = 'none';
            if (navWatchlist) navWatchlist.style.display = 'none';

            // 게스트가 제한된 섹션(관심종목 등) 접근 시 홈으로 리다이렉트
            const restricted = ['watchlistSection', 'analysisSection', 'valueChainSection'];
            if (restricted.includes(currentActiveSectionId)) {
                navigateToSection('navHome');
                showAuthModal(); // 로그인 유도 모달 노출
            }
            
            // Clear or hide watchlist for guest if needed
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
            console.log('[DEBUG] Session data received:', data);

            // authUser 형식 유지 (logged_in, username, email, is_approved, role)
            // [Safety] 이메일 기반으로 관리자 여부 확인 (username은 구글 실명이므로 nelcome9이 포함되지 않을 수 있음)
            const ADMIN_EMAIL = 'nelcome9@gmail.com';
            const forceAdmin = (data.email?.toLowerCase() === ADMIN_EMAIL) || data.role === 'admin';
            authUser = { 
                logged_in: data.logged_in, 
                username: data.username,
                email: data.email,
                avatar_url: data.avatar_url,
                is_approved: data.is_approved || forceAdmin,
                role: forceAdmin ? 'admin' : (data.role || 'user')
            };
            if (forceAdmin) console.log('👑 Admin session detected and verified for:', data.email);

            if (data.logged_in && data.watchlist) {
                currentWatchlist = data.watchlist;
                saveWatchlist(currentWatchlist);
            }

        } catch (error) {
            console.error("[DEBUG] fetchUserSession failed:", error);
        }
        updateAuthUI();
    };

    // 로드 시 초기 세션 확인 (비동기로 실행하여 메인 흐름 차단 방지)
    fetchUserSession().catch(err => console.error('[DEBUG] Initial session fetch failed:', err));
}

// ──────────────────────────────────────────────────────────────────
// ──  밸류체인 탐색기 (Value Chain Explorer)
// ──────────────────────────────────────────────────────────────────

let _vcData = { categories: [], sectors: {} };
let _vcCurrentCategory = null;
let _vcCurrentView = 'list';
let _vcGraph = null;
let _vcSearchTimeout = null;

async function initValueChain() {
    // 이미 로드됐으면 스킵
    if (_vcData.categories.length > 0) {
        _vcRenderCategories();
        return;
    }
    try {
        const res = await fetch(`${API_BASE_URL}/api/valuechain/categories`);
        const cats = await res.json();
        _vcData.categories = cats;
        _vcRenderCategories();
        // 첫 번째 카테고리 자동 선택
        if (cats.length > 0) {
            await _vcSelectCategory(cats[0]);
        }
    } catch (e) {
        console.error('[VC] Failed to load categories', e);
        const list = document.getElementById('vcCategoryList');
        if (list) list.innerHTML = '<p style="color:var(--text-muted);padding:12px;">데이터를 불러올 수 없습니다.</p>';
    }

    // 검색 이벤트
    const searchInput = document.getElementById('vcSearchInput');
    if (searchInput && !searchInput.dataset.vcInitialized) {
        searchInput.dataset.vcInitialized = '1';
        searchInput.addEventListener('input', (e) => {
            clearTimeout(_vcSearchTimeout);
            _vcSearchTimeout = setTimeout(() => _vcHandleSearch(e.target.value), 300);
        });
    }
}

function _vcRenderCategories() {
    const list = document.getElementById('vcCategoryList');
    if (!list) return;
    list.innerHTML = '';
    const icons = ['ph-cpu', 'ph-car', 'ph-battery-charging', 'ph-lightning', 'ph-wifi-high', 'ph-shield-check', 'ph-flask', 'ph-shopping-bag'];
    _vcData.categories.forEach((cat, i) => {
        const btn = document.createElement('button');
        btn.className = 'vc-cat-btn' + (cat === _vcCurrentCategory ? ' active' : '');
        const shortName = cat.replace(/^\d+\.\s*/, '').split(',')[0].split(' ')[0];
        btn.innerHTML = `<i class="ph ${icons[i % icons.length]}"></i><span>${shortName}</span>`;
        btn.title = cat;
        btn.onclick = () => _vcSelectCategory(cat);
        list.appendChild(btn);
    });
}

async function _vcSelectCategory(cat) {
    // [보안 지연 확인] 승인되지 않은 경우 접근 불가 안내 (v55)
    if (authUser && !authUser.is_approved) {
        showToast('관리자 승인 후 이용 가능합니다.', 'warning');
        return;
    }
    _vcCurrentCategory = cat;
    _vcRenderCategories();
    const label = document.getElementById('vcCategoryLabel');
    if (label) label.textContent = cat.replace(/^\d+\.\s*/, '');

    // 캐시 확인
    if (!_vcData.sectors[cat]) {
        try {
            const res = await fetch(`${API_BASE_URL}/api/valuechain/detail?category=${encodeURIComponent(cat)}`);
            _vcData.sectors[cat] = await res.json();
        } catch (e) {
            console.error('[VC] Failed to load sectors', e);
            return;
        }
    }

    // Render based on current view
    if (_vcCurrentView === 'list') {
        _vcRenderSectorList(_vcData.sectors[cat]);
    } else {
        _vcRenderForceGraph(_vcData.sectors[cat], cat);
    }
}

function _vcRenderSectorList(sectors) {
    const grid = document.getElementById('vcSectorGrid');
    if (!grid) return;
    grid.innerHTML = '';
    sectors.forEach(sec => {
        const card = document.createElement('div');
        card.className = 'vc-sector-card';
        const stockChips = sec.stocks.map(s =>
            `<button class="vc-stock-chip" onclick="_vcSearchStock('${s.replace(/'/g, "\\'")}')">` +
            `<i class="ph ph-trend-up"></i>${s}</button>`
        ).join('');
        card.innerHTML = `
            <div class="vc-sector-header">
                <i class="ph ph-tag"></i>
                <span class="vc-sector-name">${sec.sector}</span>
                <span class="vc-stock-count">${sec.stocks.length}개</span>
            </div>
            <div class="vc-stock-chips">${stockChips}</div>
        `;
        grid.appendChild(card);
    });
}

function setVcView(view) {
    _vcCurrentView = view;
    const listView = document.getElementById('vcListView');
    const graphView = document.getElementById('vcGraphView');
    const btnList = document.getElementById('vcBtnList');
    const btnGraph = document.getElementById('vcBtnGraph');

    if (view === 'list') {
        listView?.classList.remove('hidden');
        graphView?.classList.add('hidden');
        btnList?.classList.add('active');
        btnGraph?.classList.remove('active');
        if (_vcCurrentCategory && _vcData.sectors[_vcCurrentCategory]) {
            _vcRenderSectorList(_vcData.sectors[_vcCurrentCategory]);
        }
    } else {
        listView?.classList.add('hidden');
        graphView?.classList.remove('hidden');
        btnList?.classList.remove('active');
        btnGraph?.classList.add('active');
        if (_vcCurrentCategory && _vcData.sectors[_vcCurrentCategory]) {
            _vcRenderForceGraph(_vcData.sectors[_vcCurrentCategory], _vcCurrentCategory);
        }
    }
}

// ── Force Graph (Canvas 2D) ──
function _vcRenderForceGraph(sectors, categoryLabel) {
    const canvas = document.getElementById('vcForceCanvas');
    if (!canvas) return;

    const container = document.getElementById('vcGraphContainer');
    // Use actual pixel dimensions from container
    const W = Math.max(container.clientWidth, 600);
    const H = Math.max(container.clientHeight, 520);
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = '100%';
    canvas.style.height = H + 'px';

    // Build graph data
    const nodes = [];
    const links = [];
    const nodeMap = {};

    // Root node
    const rootLabel = categoryLabel.replace(/^\d+\.\s*/, '').split(',')[0];
    const rootNode = { id: 'root', label: rootLabel, type: 'root', x: W / 2, y: H / 2, vx: 0, vy: 0 };
    nodes.push(rootNode);
    nodeMap['root'] = rootNode;

    sectors.forEach((sec, si) => {
        const topicId = `topic_${si}`;
        const topicNode = { id: topicId, label: sec.sector, type: 'topic',
            x: W / 2 + Math.cos(si * 2 * Math.PI / sectors.length) * (W * 0.25),
            y: H / 2 + Math.sin(si * 2 * Math.PI / sectors.length) * (H * 0.25),
            vx: 0, vy: 0 };
        nodes.push(topicNode);
        nodeMap[topicId] = topicNode;
        links.push({ source: 'root', target: topicId });

        sec.stocks.forEach((stock, ki) => {
            const stockId = `stock_${si}_${ki}`;
            const angle = (ki * 2 * Math.PI / sec.stocks.length);
            const stockNode = { id: stockId, label: stock, type: 'stock',
                x: topicNode.x + Math.cos(angle) * 60 + (Math.random() - 0.5) * 30,
                y: topicNode.y + Math.sin(angle) * 60 + (Math.random() - 0.5) * 30,
                vx: 0, vy: 0 };
            nodes.push(stockNode);
            nodeMap[stockId] = stockNode;
            links.push({ source: topicId, target: stockId });
        });
    });

    // Resolve links
    const resolvedLinks = links.map(l => ({
        source: nodeMap[l.source],
        target: nodeMap[l.target]
    }));

    let linkDistance = parseInt(document.getElementById('vcLinkDistance')?.value || 120);
    let transform = { x: 0, y: 0, scale: 1 };
    let isDragging = false;
    let dragNode = null;
    let lastMouse = { x: 0, y: 0 };
    let hoveredNode = null;
    let animId = null;

    const getNodeRadius = (n) => n.type === 'root' ? 10 : n.type === 'topic' ? 6 : 3.5;
    const getNodeColor = (n) => n.type === 'root' ? '#5c85ff' : n.type === 'topic' ? '#818cf8' : '#94a3b8';

    function worldToScreen(wx, wy) {
        return { x: (wx + transform.x) * transform.scale, y: (wy + transform.y) * transform.scale };
    }
    function screenToWorld(sx, sy) {
        return { x: sx / transform.scale - transform.x, y: sy / transform.scale - transform.y };
    }
    function getNodeAt(sx, sy) {
        const { x: wx, y: wy } = screenToWorld(sx, sy);
        for (let i = nodes.length - 1; i >= 0; i--) {
            const n = nodes[i];
            const r = getNodeRadius(n) * 2.5;
            if (Math.hypot(n.x - wx, n.y - wy) < r) return n;
        }
        return null;
    }

    function tick() {
        // Force simulation
        const alpha = 0.3;
        // Repulsion
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i], b = nodes[j];
                const dx = b.x - a.x, dy = b.y - a.y;
                const dist = Math.max(Math.hypot(dx, dy), 1);
                
                // Strength by node types
                let charge = 1000; 
                if (a.type === 'root' || b.type === 'root') charge = 6000;
                else if (a.type === 'topic' || b.type === 'topic') charge = 3000;
                
                const force = charge / (dist * dist);
                const fx = force * dx / dist * alpha;
                const fy = force * dy / dist * alpha;
                
                a.vx -= fx;
                a.vy -= fy;
                b.vx += fx;
                b.vy += fy;

                // Simple collision avoidance
                const minChildDist = 45;
                const minParentDist = 80;
                const minDist = (a.type === 'stock' && b.type === 'stock') ? minChildDist : minParentDist;
                if (dist < minDist) {
                    const push = (minDist - dist) * 0.5 * alpha;
                    const px = push * dx / dist, py = push * dy / dist;
                    a.vx -= px; a.vy -= py;
                    b.vx += px; b.vy += py;
                }
            }
        }
        // Attraction (links)
        const currentLinkDist = parseInt(document.getElementById('vcLinkDistance')?.value || linkDistance);
        resolvedLinks.forEach(l => {
            const dx = l.target.x - l.source.x, dy = l.target.y - l.source.y;
            const dist = Math.max(Math.hypot(dx, dy), 1);
            const force = (dist - currentLinkDist) * 0.08 * alpha;
            const fx = force * dx / dist, fy = force * dy / dist;
            l.source.vx += fx; l.source.vy += fy;
            l.target.vx -= fx; l.target.vy -= fy;
        });
        // Center gravity (Slightly pull towards center to keep graph from floating away)
        nodes.forEach(n => {
            if (dragNode === n) return;
            n.vx += (W / 2 - n.x) * 0.0008 * alpha;
            n.vy += (H / 2 - n.y) * 0.0008 * alpha;
            n.vx *= 0.82;
            n.vy *= 0.82;
            n.x += n.vx;
            n.y += n.vy;
            // Bounds
            n.x = Math.max(20, Math.min(W - 20, n.x));
            n.y = Math.max(20, Math.min(H - 20, n.y));
        });
    }

    function draw() {
        const ctx = canvas.getContext('2d');
        const isDark = !document.documentElement.getAttribute('data-theme') || document.documentElement.getAttribute('data-theme') === 'dark';
        const bgColor = isDark ? '#0f172a' : '#f8fafc';
        const linkColor = isDark ? 'rgba(148,163,184,0.18)' : 'rgba(71,85,105,0.2)';
        const stockLabelColor = isDark ? 'rgba(200,210,255,0.85)' : 'rgba(30,41,59,0.85)';
        const topicLabelColor = isDark ? 'rgba(255,255,255,0.95)' : 'rgba(15,23,42,0.95)';
        const shadowColor = isDark ? 'rgba(0,0,0,0.9)' : 'rgba(255,255,255,0.9)';

        // Fill background
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, W, H);

        ctx.save();
        ctx.translate(transform.x * transform.scale, transform.y * transform.scale);
        ctx.scale(transform.scale, transform.scale);

        // Links
        resolvedLinks.forEach(l => {
            ctx.beginPath();
            ctx.moveTo(l.source.x, l.source.y);
            ctx.lineTo(l.target.x, l.target.y);
            ctx.strokeStyle = linkColor;
            ctx.lineWidth = 1;
            ctx.stroke();
        });

        // Nodes
        nodes.forEach(n => {
            const r = getNodeRadius(n);
            const color = getNodeColor(n);
            if (n.type === 'root') {
                ctx.shadowColor = '#5c85ff';
                ctx.shadowBlur = 20;
            } else if (n.type === 'topic') {
                ctx.shadowColor = '#818cf8';
                ctx.shadowBlur = 8;
            } else {
                ctx.shadowBlur = 0;
            }
            ctx.beginPath();
            ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
            ctx.fillStyle = n === hoveredNode ? '#ffffff' : color;
            ctx.fill();
            // Stroke for contrast
            ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)';
            ctx.lineWidth = 0.5;
            ctx.stroke();
            ctx.shadowBlur = 0;

            // Label
            const isRoot = n.type === 'root';
            const isTopic = n.type === 'topic';
            if (!isRoot && transform.scale < 0.5 && !isTopic) return; // hide stock labels when zoomed out
            const fontSize = Math.max(8, (isRoot ? 14 : isTopic ? 11 : 9) / transform.scale);
            ctx.font = `${isRoot ? '700' : isTopic ? '600' : '400'} ${fontSize}px Inter, 'Noto Sans KR', sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.shadowColor = shadowColor;
            ctx.shadowBlur = 5;
            ctx.fillStyle = isRoot ? (isDark ? '#fff' : '#0f172a') : isTopic ? topicLabelColor : stockLabelColor;
            ctx.fillText(n.label, n.x, n.y + r + 3);
            ctx.shadowBlur = 0;
        });

        ctx.restore();
    }

    function loop() {
        tick();
        draw();
        window._vcAnimId = requestAnimationFrame(loop);
    }

    // Stop previous animation
    if (window._vcAnimId) cancelAnimationFrame(window._vcAnimId);
    loop();

    // Mouse Events
    const rect = () => canvas.getBoundingClientRect();
    canvas.onwheel = (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        const r = rect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        transform.x -= mx / transform.scale;
        transform.y -= my / transform.scale;
        transform.scale = Math.max(0.2, Math.min(5, transform.scale * factor));
        transform.x += mx / transform.scale;
        transform.y += my / transform.scale;
    };
    // Track mousedown position to distinguish click vs drag
    let mouseDownPos = { x: 0, y: 0 };
    canvas.onmousedown = (e) => {
        const r = rect();
        const n = getNodeAt(e.clientX - r.left, e.clientY - r.top);
        mouseDownPos = { x: e.clientX, y: e.clientY };
        if (n) { dragNode = n; isDragging = true; }
        else { isDragging = true; }
        lastMouse = { x: e.clientX, y: e.clientY };
    };
    canvas.onmousemove = (e) => {
        const r = rect();
        hoveredNode = getNodeAt(e.clientX - r.left, e.clientY - r.top);
        canvas.style.cursor = hoveredNode ? 'pointer' : (isDragging ? 'grabbing' : 'grab');
        if (!isDragging) return;
        const dx = e.clientX - lastMouse.x, dy = e.clientY - lastMouse.y;
        if (dragNode) {
            const w = screenToWorld(e.clientX - r.left, e.clientY - r.top);
            dragNode.x = w.x; dragNode.y = w.y;
            dragNode.vx = 0; dragNode.vy = 0;
        } else {
            transform.x += dx / transform.scale;
            transform.y += dy / transform.scale;
        }
        lastMouse = { x: e.clientX, y: e.clientY };
    };
    canvas.onmouseup = (e) => {
        const r = rect();
        const movedX = Math.abs(e.clientX - mouseDownPos.x);
        const movedY = Math.abs(e.clientY - mouseDownPos.y);
        const isClick = movedX < 5 && movedY < 5; // threshold: 5px

        if (isClick) {
            // Treat as click – find node under cursor
            const n = getNodeAt(e.clientX - r.left, e.clientY - r.top);
            if (n && n.type === 'stock') {
                _vcSearchStock(n.label);
            }
        }
        dragNode = null;
        isDragging = false;
    };
    canvas.onmouseleave = () => { isDragging = false; dragNode = null; hoveredNode = null; };

    // Touch Events for Mobile Pinch-Zoom & Drag
    let initialPinchDistance = null;
    let initialPinchCenter = null;

    canvas.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
            // Prevent default to disable page scroll while dragging graph
            e.preventDefault(); 
            const touch = e.touches[0];
            const r = rect();
            const clientX = touch.clientX;
            const clientY = touch.clientY;
            
            const n = getNodeAt(clientX - r.left, clientY - r.top);
            mouseDownPos = { x: clientX, y: clientY };
            if (n) { dragNode = n; isDragging = true; }
            else { isDragging = true; }
            lastMouse = { x: clientX, y: clientY };
        } else if (e.touches.length === 2) {
            e.preventDefault();
            const t1 = e.touches[0];
            const t2 = e.touches[1];
            initialPinchDistance = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
            
            const r = rect();
            initialPinchCenter = {
                x: (t1.clientX + t2.clientX) / 2 - r.left,
                y: (t1.clientY + t2.clientY) / 2 - r.top
            };
            dragNode = null;
            isDragging = false;
        }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        const r = rect();
        if (e.touches.length === 1 && isDragging) {
            e.preventDefault();
            const touch = e.touches[0];
            const clientX = touch.clientX;
            const clientY = touch.clientY;
            const dx = clientX - lastMouse.x;
            const dy = clientY - lastMouse.y;
            
            if (dragNode) {
                const w = screenToWorld(clientX - r.left, clientY - r.top);
                dragNode.x = w.x; dragNode.y = w.y;
                dragNode.vx = 0; dragNode.vy = 0;
            } else {
                transform.x += dx / transform.scale;
                transform.y += dy / transform.scale;
            }
            lastMouse = { x: clientX, y: clientY };
        } else if (e.touches.length === 2 && initialPinchDistance !== null) {
            e.preventDefault();
            const t1 = e.touches[0];
            const t2 = e.touches[1];
            const currentDistance = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
            
            const factor = currentDistance / initialPinchDistance;
            
            transform.x -= initialPinchCenter.x / transform.scale;
            transform.y -= initialPinchCenter.y / transform.scale;
            transform.scale = Math.max(0.2, Math.min(5, transform.scale * factor));
            transform.x += initialPinchCenter.x / transform.scale;
            transform.y += initialPinchCenter.y / transform.scale;
            
            initialPinchDistance = currentDistance;
            initialPinchCenter = {
                x: (t1.clientX + t2.clientX) / 2 - r.left,
                y: (t1.clientY + t2.clientY) / 2 - r.top
            };
        }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
        if (e.touches.length === 0) {
            if (isDragging) {
                const movedX = Math.abs(lastMouse.x - mouseDownPos.x);
                const movedY = Math.abs(lastMouse.y - mouseDownPos.y);
                const isClick = movedX < 10 && movedY < 10; // larger threshold for touch precision
                
                if (isClick && lastMouse.x !== 0) { 
                    const r = rect();
                    const n = getNodeAt(lastMouse.x - r.left, lastMouse.y - r.top);
                    if (n && n.type === 'stock') {
                        _vcSearchStock(n.label);
                    }
                }
            }
            dragNode = null;
            isDragging = false;
            initialPinchDistance = null;
            initialPinchCenter = null;
        } else if (e.touches.length === 1) {
            const touch = e.touches[0];
            lastMouse = { x: touch.clientX, y: touch.clientY };
            initialPinchDistance = null;
        }
    });

    canvas.addEventListener('touchcancel', () => {
        dragNode = null;
        isDragging = false;
        initialPinchDistance = null;
        initialPinchCenter = null;
    });

    // Link distance slider
    const slider = document.getElementById('vcLinkDistance');
    if (slider) {
        slider.oninput = (e) => { linkDistance = parseInt(e.target.value); };
    }
}

async function _vcHandleSearch(query) {
    const grid = document.getElementById('vcSectorGrid');
    const listView = document.getElementById('vcListView');
    if (!grid) return;

    if (!query.trim()) {
        // Restore current category
        if (_vcCurrentCategory && _vcData.sectors[_vcCurrentCategory]) {
            setVcView('list');
            _vcRenderSectorList(_vcData.sectors[_vcCurrentCategory]);
        }
        return;
    }

    // Switch to list view
    setVcView('list');

    try {
        const res = await fetch(`${API_BASE_URL}/api/valuechain/search?q=${encodeURIComponent(query)}`);
        const results = await res.json();
        grid.innerHTML = '';
        if (results.length === 0) {
            grid.innerHTML = `<div class="vc-empty"><i class="ph ph-magnifying-glass"></i><p>검색 결과가 없습니다.</p></div>`;
            return;
        }
        results.forEach(sec => {
            const card = document.createElement('div');
            card.className = 'vc-sector-card';
            const chips = sec.stocks.map(s =>
                `<button class="vc-stock-chip" onclick="_vcSearchStock('${s.replace(/'/g, "\\'")}')">` +
                `<i class="ph ph-trend-up"></i>${s}</button>`
            ).join('');
            card.innerHTML = `
                <div class="vc-sector-header">
                    <i class="ph ph-tag"></i>
                    <span class="vc-sector-name">${sec.sector}</span>
                    <span class="vc-cat-badge">${sec.category.replace(/^\d+\.\s*/, '').split(',')[0]}</span>
                </div>
                <div class="vc-stock-chips">${chips}</div>
            `;
            grid.appendChild(card);
        });
    } catch (e) {
        console.error('[VC] Search failed', e);
    }
}

function _vcSearchStock(stockName) {
    // Navigate to home and search the stock
    const navHome = document.getElementById('navHome');
    if (navHome) navHome.click();
    const input = document.getElementById('searchInput');
    if (input) {
        input.value = stockName;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        // Small delay to let autocomplete populate, then click first result or submit
        setTimeout(() => {
            const first = document.querySelector('#suggestDropdown .suggest-item');
            if (first) {
                first.click();
            } else {
                document.getElementById('searchBtn')?.click();
            }
        }, 400);
    }
}

// ── Value Chain Fullscreen Toggle ──
let isVcFullscreen = false;
window.toggleVcFullscreen = function() {
    const vcSection = document.getElementById('valueChainSection');
    const btnIcon = document.querySelector('#vcBtnFullscreen i');
    if (!vcSection) return;

    isVcFullscreen = !isVcFullscreen;
    if (isVcFullscreen) {
        document.body.classList.add('vc-fullscreen-active');
        vcSection.classList.add('fullscreen-mode');
        if (btnIcon) {
            btnIcon.classList.remove('ph-corners-out');
            btnIcon.classList.add('ph-corners-in');
        }
    } else {
        document.body.classList.remove('vc-fullscreen-active');
        vcSection.classList.remove('fullscreen-mode');
        if (btnIcon) {
            btnIcon.classList.remove('ph-corners-in');
            btnIcon.classList.add('ph-corners-out');
        }
    }

    // Ensure Force Graph gets properly resized if it is currently visible
    if (window._vcCurrentView === 'graph' && window._vcFg) {
        setTimeout(() => {
            const container = document.getElementById('vcGraphContainer');
            if (container && window._vcFg) {
                // Resize to new container dimension
                window._vcFg.width(container.clientWidth).height(Math.max(500, container.clientHeight - 40));
            }
        }, 150);
    }
}

// ──────────────────────────────────────────────────────────────────
// ── 관리자 대시보드 (Admin Dashboard)
// ──────────────────────────────────────────────────────────────────

/**
 * Supabase JS SDK로 최신 유효 토큰을 가져옵니다.
 * 세션이 만료된 경우 SDK가 자동 갱신하며, 로컬스토리지를 최신 상태로 유지합니다.
 */
async function getValidToken() {
    // 1) Supabase JS SDK가 사용 가능하면 SDK의 getSession으로 최신 토큰 획득
    if (window._supabaseClient) {
        try {
            const { data, error } = await window._supabaseClient.auth.getSession();
            if (!error && data?.session?.access_token) {
                const freshToken = data.session.access_token;
                setSupaToken(freshToken); // 로컬스토리지도 갱신
                return freshToken;
            }
        } catch (e) {
            console.warn('[AUTH] SDK getSession failed, falling back to localStorage token', e);
        }
    }
    // 2) 폴백: 로컬스토리지에 저장된 토큰 사용
    return getSupaToken();
}

async function renderAdminDashboard() {
    const listContainer = document.getElementById('adminUserList');
    if (!listContainer) return;

    // 초기화 및 로딩 표시
    listContainer.innerHTML = '<tr><td colspan="4" class="empty-msg">사용자 목록을 불러오는 중...</td></tr>';

    try {
        const token = await getValidToken();
        if (!token) {
            listContainer.innerHTML = '<tr><td colspan="4" class="empty-msg">인증 토큰이 없습니다. 다시 로그인해 주세요.</td></tr>';
            return;
        }

        console.log('[ADMIN] Fetching all users...');
        const res = await fetch(`${API_BASE_URL}/api/admin/users`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (res.status === 401) {
            listContainer.innerHTML = '<tr><td colspan="4" class="empty-msg" style="color:var(--color-down);">세션이 만료되었습니다. 다시 로그인해 주세요.</td></tr>';
            return;
        }
        if (res.status === 403) {
            listContainer.innerHTML = '<tr><td colspan="4" class="empty-msg" style="color:var(--color-down);">관리자 권한이 필요합니다.</td></tr>';
            return;
        }
        if (!res.ok) {
            throw new Error(`HTTP Error: ${res.status}`);
        }

        const data = await res.json();
        console.log('[ADMIN] Users data:', data);

        if (!data.success) {
            listContainer.innerHTML = `<tr><td colspan="4" class="empty-msg" style="color:var(--color-up)">${data.message || '권한이 없거나 요청에 실패했습니다.'}</td></tr>`;
            return;
        }

        if (!data.users || data.users.length === 0) {
            listContainer.innerHTML = '<tr><td colspan="4" class="empty-msg">가입된 사용자가 없습니다.</td></tr>';
            return;
        }

        listContainer.innerHTML = data.users.map(u => {
            const email = u.email || 'N/A';
            const dateStr = u.created_at ? new Date(u.created_at).toLocaleString() : 'N/A';
            
            // 상태 뱃지 및 작업 버튼 분기 처리
            const statusBadge = u.is_approved 
                ? '<span class="status-badge status-approved">승인 완료</span>' 
                : '<span class="status-badge status-pending">승인 대기</span>';
            
            const actionBtn = u.is_approved 
                ? '<span style="color:var(--accent); font-size: 1.2rem; margin-right: 8px;"><i class="ph ph-check-circle-fill"></i></span>'
                : `<button class="btn-approve" onclick="approveUser('${u.id}')" style="margin-right: 8px;"><i class="ph ph-check"></i> 승인</button>`;
                
            // 관리자(nelcome9)는 삭제 버튼을 표시하지 않음
            const isAdmin = email.toLowerCase() === 'nelcome9@gmail.com' || u.role === 'admin';
            const deleteBtn = isAdmin 
                ? '<span style="color:var(--text-muted); font-size: 0.8rem;">(관리자)</span>'
                : `<button onclick="deleteUser('${u.id}')" style="background:var(--color-down); color:#fff; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; font-size: 0.8rem;" class="btn-approve"><i class="ph ph-trash"></i> 삭제</button>`;

            return `
                <tr>
                    <td>
                        <div style="display:flex; align-items:center; gap:10px;">
                            ${u.avatar_url ? `<img src="${u.avatar_url}" style="width:24px; height:24px; border-radius:50%; object-fit:cover;">` : `<i class="ph ph-user" style="font-size:24px; color:var(--text-muted);"></i>`}
                            <span>${email}</span> ${isAdmin ? '<span class="admin-badge" style="background:var(--primary); color:#fff; font-size:10px; padding:2px 6px; border-radius:4px; margin-left:6px; font-weight:700;">ADMIN</span>' : ''}
                        </div>
                    </td>
                    <td>${dateStr}</td>
                    <td>${statusBadge}</td>
                    <td style="white-space: nowrap;">${actionBtn}${deleteBtn}</td>
                </tr>
            `;
        }).join('');

    } catch (e) {
        console.error('[ADMIN] Failed to load users', e);
        listContainer.innerHTML = `<tr><td colspan="4" class="empty-msg">목록 로드 중 오류가 발생했습니다: ${e.message}</td></tr>`;
    }
}

async function approveUser(userId) {
    const confirmed = await showConfirm('사용자 승인', '정말 이 사용자를 승인하시겠습니까?');
    if (!confirmed) return;

    try {
        const token = await getValidToken();
        const res = await fetch(`${API_BASE_URL}/api/admin/approve`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ user_id: userId })
        });
        const data = await res.json();

        if (data.success) {
            showToast('사용자 승인이 완료되었습니다.', 'success');
            renderAdminDashboard(); // 목록 갱신
        } else {
            showToast(data.message || '승인에 실패했습니다.', 'error');
        }
    } catch (e) {
        console.error('[ADMIN] Approve error', e);
        showToast('네트워크 오류가 발생했습니다.', 'error');
    }
}

async function deleteUser(userId) {
    const confirmed = await showConfirm('회원 강제탈퇴', `<span style='color:var(--color-down); font-weight:bold;'>정말로 이 회원을 영구적으로 삭제하시겠습니까?</span><br><br>이 작업은 되돌릴 수 없으며, 데이터베이스 상의 모든 연관 데이터가 파기됩니다.`);
    if (!confirmed) return;

    try {
        const token = await getValidToken();
        const res = await fetch(`${API_BASE_URL}/api/admin/user/${userId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        const data = await res.json();

        if (data.success) {
            showToast('회원 강제탈퇴가 완료되었습니다.', 'success');
            renderAdminDashboard(); // 목록 갱신
        } else {
            showToast(data.message || '삭제에 실패했습니다.', 'error');
        }
    } catch (e) {
        console.error('[ADMIN] Delete error', e);
        showToast('네트워크 오류가 발생했습니다.', 'error');
    }
}


/**
 * [NEW] 회원 탈퇴 처리 (withdrawal)
 */
async function withdrawAccount() {
    const confirm1 = await showConfirm("회원 탈퇴", "정말 회원 탈퇴를 진행하시겠습니까?\n모든 관심종목과 데이터가 복구 불가능하게 영구 삭제됩니다.");
    if (!confirm1) return;

    const confirm2 = await showConfirm("최종 확인", "마지막 확인입니다. 탈퇴하시겠습니까?");
    if (!confirm2) return;

    try {
        const token = getSupaToken();
        const res = await fetch(`${API_BASE_URL}/api/auth/withdrawal`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();

        if (data.success) {
            await showModal("탈퇴 완료", "회원 탈퇴가 완료되었습니다. 이용해 주셔서 감사합니다.", "success");
            // 세션 정리 및 페이지 새로고침
            localStorage.removeItem('supabase_token');
            window.location.reload();
        } else {
            showToast(data.message || "탈퇴 처리 중 오류가 발생했습니다.", "error");
        }
    } catch (e) {
        console.error("Withdrawal error:", e);
        showToast("서버 통신 오류가 발생했습니다.", "error");
    }
}

/**
 * [NEW] 전역 커스텀 모달 시스템 (Themed Modal Engine)
 */
window.showModal = function(title, message, type = 'info') {
    return new Promise((resolve) => {
        const modal = document.getElementById('customModal');
        const titleEl = document.getElementById('modalTitle');
        const messageEl = document.getElementById('modalMessage');
        const confirmBtn = document.getElementById('modalConfirmBtn');
        const cancelBtn = document.getElementById('modalCancelBtn');
        const iconEl = document.getElementById('modalIcon');

        if (!modal) return resolve(true);

        titleEl.textContent = title;
        messageEl.textContent = message;
        cancelBtn.style.display = 'none'; // Alert는 취소 버튼 없음
        confirmBtn.textContent = '확인';

        // 타입별 아이콘 설정
        iconEl.className = 'ph'; 
        if (type === 'success') iconEl.classList.add('ph-check-circle');
        else if (type === 'error') iconEl.classList.add('ph-warning-circle');
        else iconEl.classList.add('ph-info');

        modal.classList.remove('hidden');

        confirmBtn.onclick = () => {
            modal.classList.add('hidden');
            resolve(true);
        };
    });
};

window.showConfirm = function(title, message, type = 'warning') {
    return new Promise((resolve) => {
        const modal = document.getElementById('customModal');
        const titleEl = document.getElementById('modalTitle');
        const messageEl = document.getElementById('modalMessage');
        const confirmBtn = document.getElementById('modalConfirmBtn');
        const cancelBtn = document.getElementById('modalCancelBtn');
        const iconEl = document.getElementById('modalIcon');

        if (!modal) return resolve(false);

        titleEl.textContent = title;
        messageEl.textContent = message;
        cancelBtn.style.display = 'block';
        confirmBtn.textContent = '확인';
        cancelBtn.textContent = '취소';

        iconEl.className = 'ph ph-warning-circle';

        modal.classList.remove('hidden');

        confirmBtn.onclick = () => {
            modal.classList.add('hidden');
            resolve(true);
        };
        cancelBtn.onclick = () => {
            modal.classList.add('hidden');
            resolve(false);
        };
    });
};

// ─────────────────────────────────────────────────────────────────────────────
// ── Help Modal Controller (v32 — Dynamic Live-Data Guide)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 현재 DOM에서 실제 분석 수치를 읽어 동적 배너를 생성합니다.
 * topic별로 관련 지표를 읽어 가이드 상단에 "현재 분석 결과" 카드를 주입합니다.
 */
function _buildLiveBanner(topic) {
    const safe = (id) => {
        const el = document.getElementById(id);
        return el ? (el.textContent.trim() || '-') : '-';
    };

    let bannerHTML = '';

    if (topic === 'lesson1') {
        const trendLabel = safe('trendLabel');
        const trendPct   = safe('trendStrengthText');
        bannerHTML = `
            <div class="card highlight" style="margin-bottom:20px;">
                <h3>📡 현재 AI 추세 분석 결과</h3>
                <div class="table-wrapper" style="margin:12px 0 0;">
                    <table>
                        <tbody>
                            <tr><td><strong>추세 방향</strong></td><td>${trendLabel}</td></tr>
                            <tr><td><strong>추세 강도</strong></td><td>${trendPct}</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>`;
    } else if (topic === 'lesson_buy') {
        const pattern  = safe('buyPattern');
        const strength = safe('buyStrengthPct');
        const aggressive = safe('buyAggressive');
        const conservative = safe('buyConservative');
        const target   = safe('buyTarget');
        const stopLoss = safe('buyStopLoss');
        const rr       = safe('buyRiskReward');
        bannerHTML = `
            <div class="card highlight" style="margin-bottom:20px;">
                <h3>📡 현재 AI 매수 리포트 수치</h3>
                <div class="table-wrapper" style="margin:12px 0 0;">
                    <table>
                        <tbody>
                            <tr><td><strong>감지 패턴</strong></td><td>${pattern}</td></tr>
                            <tr><td><strong>시그널 강도</strong></td><td>${strength}</td></tr>
                            <tr><td><strong>공격적 진입가</strong></td><td>${aggressive}</td></tr>
                            <tr><td><strong>보수적 진입가</strong></td><td>${conservative}</td></tr>
                            <tr><td><strong>목표가</strong></td><td>${target}</td></tr>
                            <tr><td><strong>손절가</strong></td><td>${stopLoss}</td></tr>
                            <tr><td><strong>손익비</strong></td><td>${rr}</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>`;
    } else if (topic === 'lesson_sell') {
        const pattern  = safe('sellPattern');
        const strength = safe('sellStrengthPct');
        const sellPrice = safe('sellPrice');
        const conservative = safe('sellConservative');
        const target   = safe('sellTarget');
        const stopLoss = safe('sellStopLoss');
        const rr       = safe('sellRiskReward');
        bannerHTML = `
            <div class="card highlight" style="margin-bottom:20px;">
                <h3>📡 현재 AI 매도 리포트 수치</h3>
                <div class="table-wrapper" style="margin:12px 0 0;">
                    <table>
                        <tbody>
                            <tr><td><strong>감지 패턴</strong></td><td>${pattern}</td></tr>
                            <tr><td><strong>시그널 강도</strong></td><td>${strength}</td></tr>
                            <tr><td><strong>매도가</strong></td><td>${sellPrice}</td></tr>
                            <tr><td><strong>보수적 매도가</strong></td><td>${conservative}</td></tr>
                            <tr><td><strong>목표가</strong></td><td>${target}</td></tr>
                            <tr><td><strong>손절가</strong></td><td>${stopLoss}</td></tr>
                            <tr><td><strong>손익비</strong></td><td>${rr}</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>`;
    } else if (topic === 'lesson2') {
        const buyPat  = safe('buyPattern');
        const sellPat = safe('sellPattern');
        const detected = [buyPat, sellPat].filter(p => p && p !== '-').join(' / ');
        bannerHTML = `
            <div class="card highlight" style="margin-bottom:20px;">
                <h3>📡 현재 감지된 캔들 패턴</h3>
                <p>${detected ? `<strong>${detected}</strong> 패턴이 감지되었습니다. 아래에서 해당 패턴 설명을 확인하세요.` : '현재 특이 패턴이 감지되지 않았습니다.'}</p>
            </div>`;
    } else if (topic === 'ai_insight') {
        bannerHTML = `
            <div class="card highlight" style="margin-bottom:20px;">
                <h3>📡 현재 AI 인지형 투자 매력도 분석</h3>
                <p style="margin-top:10px; font-size:0.9rem; color:var(--text-sub);">
                    기술적 종합 지표와 거래량 에너지 분석을 통해 현재 종목의 투자 성숙도와 매력도를 실시간 산출 중입니다.
                </p>
            </div>`;
    } else if (topic === 'cycle_prediction') {
        bannerHTML = `
            <div class="card highlight" style="margin-bottom:20px;">
                <h3>📡 현재 사이클 예측 상태</h3>
                <p style="margin-top:10px; font-size:0.9rem; color:var(--text-sub);">
                    피보나치 시간대와 과거 이력을 바탕으로 다음 변곡점(Peak/Bottom) 도달 시점을 실시간 추적하고 있습니다.
                </p>
            </div>`;
    }

    return bannerHTML;
}

const HELP_CONTENT = {
    // ── 1. AI 추세 분석 ──────────────────────────────────────────────
    'lesson1': {
        title: 'AI 주가 추세 분석 가이드',
        body: `
            <h2 class="section-title">AI 주가 추세 분석이란?</h2>
            <p class="section-subtitle">머신러닝이 주가의 상승/하강을 예측하는 원리</p>
            <div class="card highlight">
                <h3>💡 핵심 개념</h3>
                <p>AI 추세 분석은 과거 주가 데이터(가격, 거래량, 시간)를 학습한 인공지능이 <strong>"주가가 앞으로 올라갈 확률"</strong>을 계산하는 기술입니다.<br><br>
                간단히 말하면: <strong>과거 패턴을 보고 미래를 예측하는 "똑똑한 통계"</strong></p>
            </div>
            <div class="table-wrapper">
                <table>
                    <thead><tr><th>단계</th><th>설명</th></tr></thead>
                    <tbody>
                        <tr><td><strong>수집</strong></td><td>매일의 주가, 거래량, 이동평균 기록</td></tr>
                        <tr><td><strong>학습</strong></td><td>AI가 상승 직전에 반복되는 패턴 자동 감지</td></tr>
                        <tr><td><strong>예측</strong></td><td>현재 신호로 향후 방향 확률 계산</td></tr>
                        <tr><td><strong>방향 표시</strong></td><td>상승(Bullish) / 하락(Bearish) / 중립(Neutral)</td></tr>
                        <tr><td><strong>강도 %</strong></td><td>신호가 얼마나 확실한지를 0~100% 로 표현</td></tr>
                    </tbody>
                </table>
            </div>
            <div class="infographic">
                <div class="infographic-item blue"><div class="infographic-number">70%+</div><div class="infographic-label">강한 신호</div></div>
                <div class="infographic-item orange"><div class="infographic-number">50~70%</div><div class="infographic-label">중간 신호</div></div>
                <div class="infographic-item red"><div class="infographic-number">50% 미만</div><div class="infographic-label">약한 신호</div></div>
            </div>
            <div class="card warning">
                <h3>⚠️ 주의사항</h3>
                <p>신뢰도 수치는 <strong>"반드시 그렇게 된다"</strong>는 뜻이 아닙니다. 확률 기반의 예측이므로 캔들 패턴·재무 지표와 함께 종합 판단해야 합니다.</p>
            </div>

            <div class="card" style="background: var(--bg-app); border-left: 4px solid var(--primary); margin-top: 20px; border-radius: 12px;">
                <h3 style="color: var(--primary); display: flex; align-items: center; gap: 8px; font-size: 1rem;">
                    <i class="ph ph-lightning"></i> 심층 분석 팁: 평균대세 활용
                </h3>
                <p style="margin-top: 8px; font-size: 0.95rem; color: var(--text-main);">
                    AI 추세 분석과 함께 **평균대세** 차트를 사용해 보세요. 
                    장중의 미세한 가격 흔들림(노이즈)을 제거하여, 현재의 상승/하강 추세가 얼마나 견고한지 시각적으로 한눈에 파악할 수 있도록 도와줍니다.
                </p>
                <div style="margin-top: 12px; font-size: 0.85rem; color: var(--text-sub);">
                    * 하단 차트 우측 상단의 [평균대세] 버튼으로 즉시 전환 가능합니다.
                </div>
            </div>
        `
    },

    // ── 5. AI 인지형 투자 매력도 ─────────────────────────────────────
    'ai_insight': {
        title: 'AI 인지형 투자 매력도 가이드',
        body: `
            <h2 class="section-title">투자 매력도 분석 원리</h2>
            <p class="section-subtitle">AI가 기술적 지표를 어떻게 해석하는지 알아봅니다</p>
            
            <div class="card highlight">
                <h3>💡 매수 확률 산출 방식</h3>
                <p>단순한 감이 아닌, 시장의 4대 핵심 요소를 가중 합산하여 0~100점 사이의 점수로 환산합니다.</p>
                <ul class="checklist" style="margin-top:12px;">
                    <li><strong>이동평균 배열 (35%):</strong> 정배열/역배열 및 이격도 분석</li>
                    <li><strong>RSI 과매도/과매수 (25%):</strong> 현재 가격의 심리적 위치</li>
                    <li><strong>MACD 추세 강도 (25%):</strong> 상승/하락 에너지의 크기</li>
                    <li><strong>거래량 분출 (15%):</strong> 신호의 실제 수급 뒷받침</li>
                </ul>
            </div>

            <div class="card">
                <h3>🎯 ATR 기반 목표/손절가</h3>
                <p>평균 실질 변동폭(ATR)을 활용한 기계적 전략입니다. 
                변동성의 <strong>2배를 수익 목표</strong>로, <strong>1배를 손실 제한</strong>으로 설정하여 수학적으로 유리한 '손익비' 구조를 설계합니다.</p>
            </div>

            <div class="card warning">
                <h3>📊 Z-Score 거래량 이상 신호</h3>
                <p>최근 20일 평균 거래량과 비교하여 현재 거래량이 통계적으로 얼마나 '이례적인지' 분석합니다. 
                급격한 Z-Score 상승은 곧 추세의 강력한 변화(폭등 또는 폭락의 시작)를 암시합니다.</p>
            </div>
        `
    },

    // ── 6. 사이클 타임 예측 ──────────────────────────────────────────
    'cycle_prediction': {
        title: '사이클 타임 예측 가이드',
        body: `
            <h2 class="section-title">변곡점 타이밍 예측 원리</h2>
            <p class="section-subtitle">주식 시장의 반복되는 리듬을 수치화합니다</p>

            <div class="card highlight">
                <h3>⏳ 피보나치 시간대 (Fibonacci Time Zones)</h3>
                <p>자연의 황금비율 숫자인 1, 2, 3, 5, 8, 13, 21, 34... 일 단위로 추세가 변하는 성질을 이용합니다. AI는 과거 주요 고점/저점으로부터 이 비율이 일치하는 지점을 찾아 변곡점을 예측합니다.</p>
            </div>

            <div class="table-wrapper">
                <table>
                    <thead><tr><th>지표</th><th>의미와 활용</th></tr></thead>
                    <tbody>
                        <tr><td><strong>진행률 (%)</strong></td><td>현재 추세가 전체 주기 중 어느 지점에 와 있는지 표시</td></tr>
                        <tr><td><strong>잔여 거래일</strong></td><td>통계적으로 예상되는 다음 변곡점까지 남은 영업일</td></tr>
                        <tr><td><strong>신뢰도</strong></td><td>과거 사이클의 주기가 얼마나 일정했는지에 따른 예측 정확도</td></tr>
                    </tbody>
                </table>
            </div>

            <div class="card success">
                <h3>💡 활용 팁</h3>
                <p>진행률이 <strong>80%~90%</strong>에 도달했다면, 현재 추세가 곧 마무리되고 반대 방향으로의 전환(변곡)이 일어날 가능성이 매우 높음을 의미하므로 포지션 정리를 준비해야 합니다.</p>
            </div>

            <div class="card warning">
                <h3>⚠️ 주의사항</h3>
                <p>사이클 예측은 '가격'이 아닌 **'시간'**에 집중합니다. 변곡점 도달 시 가격이 오를지 내릴지는 'AI 추세 분석' 및 '캔들 패턴' 신호와 결합하여 판단하세요.</p>
            </div>
        `
    },

    // ── 2. AI 매수 리포트 ─────────────────────────────────────────────
    'lesson_buy': {
        title: 'AI 매수 리포트 지표 설명',
        body: `
            <h2 class="section-title">AI 매수 리포트 지표 해설</h2>
            <p class="section-subtitle">각 수치가 무엇을 의미하는지 정확히 알아봅니다</p>
            <div class="card highlight">
                <h3>⚡ 시그널 강도 / 신뢰도 (%)</h3>
                <p>AI가 현재 차트에서 매수 신호가 얼마나 강한지를 나타냅니다. <strong>70% 이상이면 강한 매수 신호</strong>로 볼 수 있습니다.</p>
            </div>
            <div class="card">
                <h3>🎯 공격적 진입가</h3>
                <p>현재 시점에서 즉시 진입할 수 있는 가격대입니다. <strong>모멘텀이 강할 때 적합</strong>하지만, 리스크가 상대적으로 높습니다.</p>
            </div>
            <div class="card">
                <h3>🛡️ 보수적 진입가</h3>
                <p>일정 조정 이후 더 안전한 가격에 진입하는 전략입니다. <strong>리스크를 최소화</strong>하고 싶을 때 권장합니다.</p>
            </div>
            <div class="card success">
                <h3>🚀 목표가</h3>
                <p>AI가 추정하는 <strong>단기 ~ 중기 상승 목표 가격</strong>입니다. 이 수준에서 분할 매도를 고려할 수 있습니다.</p>
            </div>
            <div class="card danger">
                <h3>✂️ 손절가</h3>
                <p>이 가격 아래로 떨어지면 <strong>반드시 손실 한도를 지켜 매도</strong>해야 하는 기준선입니다. 지키지 않으면 큰 손실로 이어질 수 있습니다.</p>
            </div>
            <div class="table-wrapper">
                <table>
                    <thead><tr><th>손익비 (Risk/Reward)</th><th>의미</th></tr></thead>
                    <tbody>
                        <tr><td>3:1 이상</td><td><strong style="color:#10b981;">✓ 우수</strong> — 손실 1에 수익 3 이상 기대</td></tr>
                        <tr><td>2:1</td><td><strong style="color:#f59e0b;">△ 양호</strong> — 표준적인 매매 수준</td></tr>
                        <tr><td>1:1 미만</td><td><strong style="color:#ef4444;">✗ 비추천</strong> — 손익 구조가 불리함</td></tr>
                    </tbody>
                </table>
            </div>
            <div class="card warning">
                <h3>⚠️ 거래량 핵심 원칙</h3>
                <p>매수 시그널이 강하더라도 <strong>평균 거래량의 1.5배 이상</strong>이 수반되면 더욱 신뢰할 수 있습니다. 거래량 없는 상승은 지속되기 어렵습니다.</p>
            </div>
        `
    },

    // ── 3. AI 매도 리포트 ─────────────────────────────────────────────
    'lesson_sell': {
        title: 'AI 매도 리포트 지표 설명',
        body: `
            <h2 class="section-title">AI 매도 리포트 지표 해설</h2>
            <p class="section-subtitle">매도 타이밍과 각 수치의 의미를 정확히 이해합니다</p>
            <div class="card highlight">
                <h3>⚡ 시그널 강도 / 신뢰도 (%)</h3>
                <p>AI가 현재 차트에서 매도 신호가 얼마나 강한지를 나타냅니다. <strong>70% 이상이면 강한 매도 신호</strong>로 볼 수 있습니다.</p>
            </div>
            <div class="card danger">
                <h3>📉 매도가 (즉시 매도 기준)</h3>
                <p>현재 시점에서 가장 빠르게 포지션을 정리할 수 있는 가격입니다. 신호가 강할 때 <strong>즉각적인 리스크 차단</strong>에 유효합니다.</p>
            </div>
            <div class="card">
                <h3>🔄 보수적 매도가</h3>
                <p>약간의 반등을 기다려 더 유리한 가격에 매도하는 전략입니다. 단, <strong>추가 하락 리스크가 있으므로 주의</strong>가 필요합니다.</p>
            </div>
            <div class="card success">
                <h3>🎯 목표가 (공매도/숏 목표)</h3>
                <p>하락 흐름이 지속될 경우 AI가 예상하는 <strong>주가 저점 구간</strong>입니다.</p>
            </div>
            <div class="table-wrapper">
                <table>
                    <thead><tr><th>손절가의 역할</th><th>설명</th></tr></thead>
                    <tbody>
                        <tr><td><strong>숏/공매도용</strong></td><td>이 가격 위로 반등 시 즉시 포지션 청산</td></tr>
                        <tr><td><strong>보유 주식 용</strong></td><td>이 가격 아래로 하락 시 추가 손실 방지를 위해 매도</td></tr>
                    </tbody>
                </table>
            </div>
            <div class="card warning">
                <h3>⚠️ 매도 신호 활용 팁</h3>
                <p>매도 신호는 <strong>단독으로 사용하지 않고</strong> 재무 지표 악화, 거시경제 악재, 거래량 이상 급증 등 복합적 요인과 함께 판단해야 합니다.</p>
            </div>
        `
    },

    // ── 4. 캔들 패턴 감지 + 시각적 매핑 ──────────────────────────────
    'lesson2': {
        title: '캔들 패턴 & 시각적 매핑 가이드',
        body: `
            <h2 class="section-title">캔들 패턴 완전 가이드</h2>
            <p class="section-subtitle">AI가 감지하는 모든 패턴의 의미와 투자 해석</p>
            <div class="card highlight">
                <h3>💡 캔들 패턴이란?</h3>
                <p>캔들 패턴은 특정 봉 형태가 반복될 때 이후 주가 방향성을 예측하는 관찰법입니다. AI가 실시간으로 <strong>37가지 패턴</strong>을 자동 감지합니다. 감지된 패턴은 위 배너에 표시되며, 해당 패턴 카드가 자동으로 강조됩니다.</p>
            </div>

            <h3 style="margin:20px 0 12px; color:var(--color-up); font-size:1rem; font-weight:700;">🔺 단봉 상승 신호</h3>
            <div class="card" data-pattern-match="망치형 (Hammer)">
                <h3>🔺 망치형 (Hammer)</h3>
                <p><strong>형태:</strong> 본체가 위쪽에 있고, 아래꼬리가 본체 길이의 2배 이상인 봉.</p>
                <p><strong>의미:</strong> 저점에서 강력한 반등 신호. 매도세를 매수세가 되받아치며 종가를 고점 근처에서 마감.</p>
                <p><strong>매매 판단:</strong> 저점 권역에서 발생 시 매수 관심. 다음 봉 양봉 확인 후 진입 권장.</p>
            </div>
            <div class="card" data-pattern-match="역망치형 (Inverted Hammer)">
                <h3>🔺 역망치형 (Inverted Hammer)</h3>
                <p><strong>형태:</strong> 본체가 아래쪽, 위꼬리가 긴 형태.</p>
                <p><strong>의미:</strong> 하락 추세 끝에서 매수세 유입 시작을 암시.</p>
                <p><strong>매매 판단:</strong> 다음 봉 양봉 확인 후 매수 진입.</p>
            </div>
            <div class="card" data-pattern-match="잠자리형 도지 (Dragonfly Doji)">
                <h3>🔺 잠자리형 도지 (Dragonfly Doji)</h3>
                <p><strong>형태:</strong> 시가=종가, 아래꼬리만 긴 T자형 봉.</p>
                <p><strong>의미:</strong> 매도세가 강했으나 마감 직전 매수세가 완전히 회복. 강한 반전 신호.</p>
                <p><strong>매매 판단:</strong> 지지선 근처에서 발생 시 매수 고려.</p>
            </div>

            <h3 style="margin:24px 0 12px; color:var(--color-up); font-size:1rem; font-weight:700;">🔺 복수봉 상승 패턴</h3>
            <div class="card" data-pattern-match="샛별형 (Morning Star)">
                <h3>🔺 샛별형 (Morning Star)</h3>
                <p><strong>형태:</strong> 음봉 → 짧은 봉(갭 하락) → 장대 양봉(하락폭 50% 이상 회복) 3봉 패턴.</p>
                <p><strong>의미:</strong> 하락 추세 종료와 상승 반전 시작. 3일째 양봉이 길수록 신뢰도 상승.</p>
                <p><strong>매매 판단:</strong> 하락 추세 바닥에서의 최적 매수 시점.</p>
            </div>
            <div class="card" data-pattern-match="상승 장악형 (Bullish Engulfing)">
                <h3>🔺 상승 장악형 (Bullish Engulfing)</h3>
                <p><strong>형태:</strong> 전날 음봉을 완전히 감싸는 큰 양봉.</p>
                <p><strong>의미:</strong> 매수 세력이 매도 세력을 압도. 강한 전환 신호.</p>
                <p><strong>매매 판단:</strong> 거래량 증가 동반 시 신뢰도 더욱 높음.</p>
            </div>
            <div class="card" data-pattern-match="관통형 (Piercing Line)">
                <h3>🔺 관통형 (Piercing Line)</h3>
                <p><strong>형태:</strong> 하락 후 양봉이 전날 음봉의 50% 이상 회복.</p>
                <p><strong>의미:</strong> 약한 반전 신호. 상승 장악형보다 신뢰도 낮음.</p>
                <p><strong>매매 판단:</strong> 3일봉 추가 확인 후 진입.</p>
            </div>
            <div class="card" data-pattern-match="적삼병 (Three White Soldiers)">
                <h3>🔺 적삼병 (Three White Soldiers)</h3>
                <p><strong>형태:</strong> 연속 3개의 장대 양봉이 계단식 상승.</p>
                <p><strong>의미:</strong> 강한 상승 추세 진입. 매수세가 3일 연속 시장 지배.</p>
                <p><strong>매매 판단:</strong> 추세 초기 발생 시 강한 매수 신호. 고점에서 발생 시 과열 주의.</p>
            </div>
            <div class="card" data-pattern-match="이중 바닥형 (Double Bottom / 쌍바닥)">
                <h3>🔺 이중 바닥형 (Double Bottom / 쌍바닥)</h3>
                <p><strong>형태:</strong> W자 형태로 같은 저점을 두 번 테스트 후 상승.</p>
                <p><strong>의미:</strong> 강력한 지지선 확인 후 상승 반전. 넥라인(중간 고점) 돌파 시 매수 신호.</p>
                <p><strong>매매 판단:</strong> 넥라인 돌파 + 거래량 증가 조합이 최고 신뢰도.</p>
            </div>
            <div class="card" data-pattern-match="삼중 바닥형 (Triple Bottom)">
                <h3>🔺 삼중 바닥형 (Triple Bottom)</h3>
                <p><strong>형태:</strong> 같은 저점을 3차례 테스트 후 반등.</p>
                <p><strong>의미:</strong> 쌍바닥보다 강한 지지선 검증. 반전 신뢰도 최상.</p>
                <p><strong>매매 판단:</strong> 3번째 저점 반등 확인 후 분할 매수.</p>
            </div>
            <div class="card" data-pattern-match="역 헤드 앤 숄더 (Inverse H&S)">
                <h3>🔺 역 헤드 앤 숄더 (Inverse H&S)</h3>
                <p><strong>형태:</strong> 중앙 저점(머리)이 양옆 저점(어깨)보다 아래 위치.</p>
                <p><strong>의미:</strong> 강한 하락 추세 종료와 상승 반전 예고. 신뢰도 매우 높음.</p>
                <p><strong>매매 판단:</strong> 넥라인(저항선) 돌파 시 강한 매수 신호.</p>
            </div>
            <div class="card" data-pattern-match="원형 바닥형 (Rounding Bottom)">
                <h3>🔺 원형 바닥형 (Rounding Bottom)</h3>
                <p><strong>형태:</strong> 장기간 완만하게 하락 후 U자 형태로 반전.</p>
                <p><strong>의미:</strong> 안정적이고 지속적인 상승 반전 예고. 기관 투자자 선호 패턴.</p>
                <p><strong>매매 판단:</strong> 분할 매수 최적 기회.</p>
            </div>
            <div class="card" data-pattern-match="상승 삼각형 (Ascending Triangle)">
                <h3>🔺 상승 삼각형 (Ascending Triangle)</h3>
                <p><strong>형태:</strong> 상단 수평 저항선, 하단 우상향 지지선 수렴.</p>
                <p><strong>의미:</strong> 매수 압력이 점점 높아지며 상단 돌파 시 강한 상승.</p>
                <p><strong>매매 판단:</strong> 저항선 돌파 + 거래량 급증 시 매수.</p>
            </div>
            <div class="card" data-pattern-match="대칭 삼각형 상방 돌파 (Symmetrical Triangle Breakout)">
                <h3>🔺 대칭 삼각형 상방 돌파</h3>
                <p><strong>의미:</strong> 방향성 불확실 압축 구간 해소 후 상방 돌파. 목표가 = 삼각형 최대폭 만큼 상승.</p>
                <p><strong>매매 판단:</strong> 상방 돌파 확인 후 매수.</p>
            </div>
            <div class="card" data-pattern-match="박스권 상단 돌파 (Rectangle Breakout)">
                <h3>🔺 박스권 상단 돌파 (Rectangle Breakout)</h3>
                <p><strong>의미:</strong> 축적 완료 후 상승 추세 시작 신호.</p>
                <p><strong>매매 판단:</strong> 돌파 당일 또는 다음날 풀백 시 매수.</p>
            </div>
            <div class="card" data-pattern-match="하락 쐐기형 돌파 (Falling Wedge Breakout)">
                <h3>🔺 하락 쐐기형 돌파 (Falling Wedge Breakout)</h3>
                <p><strong>의미:</strong> 하락 추세에서 힘이 빠지며 상방 반전 시작. 강한 매수 신호.</p>
                <p><strong>매매 판단:</strong> 상단 저항 돌파 확인 후 매수.</p>
            </div>
            <div class="card" data-pattern-match="상승 깃발/페넌트형 (Bullish Flag/Pennant)">
                <h3>🔺 상승 깃발/페넌트형 (Bullish Flag/Pennant)</h3>
                <p><strong>의미:</strong> 급등 후 짧은 조정 이후 상승 추세 재개. 주요 추세 지속 패턴.</p>
                <p><strong>매매 판단:</strong> 깃발 상방 돌파 확인 후 매수.</p>
            </div>
            <div class="card" data-pattern-match="V자형 반등 (V-Bottom)">
                <h3>🔺 V자형 반등 (V-Bottom)</h3>
                <p><strong>의미:</strong> 강한 매수세가 갑자기 유입되어 낙폭을 빠르게 회복.</p>
                <p><strong>매매 판단:</strong> 반등 초기 포착 시 수익성 최고. 진입 타이밍이 핵심.</p>
            </div>
            <div class="card" data-pattern-match="잠재적 이중 바닥형 (Double Bottom 가능성)">
                <h3>🔺 잠재적 이중 바닥형 (Double Bottom 가능성)</h3>
                <p><strong>의미:</strong> 아직 넥라인을 돌파하지 않은 이중 바닥 형성 중. 확정 전.</p>
                <p><strong>매매 판단:</strong> 넥라인 돌파 확인 후 진입. 섣부른 매수 금지.</p>
            </div>
            <div class="card" data-pattern-match="잠재적 헤드 앤 숄더 (H&S 가능성)">
                <h3>🔺 잠재적 헤드 앤 숄더 (H&S 가능성)</h3>
                <p><strong>의미:</strong> 헤드앤숄더 형성 중이나 아직 오른쪽 어깨 단계.</p>
                <p><strong>매매 판단:</strong> 완전 형성 + 넥라인 이탈 확인 전까지 관망.</p>
            </div>
            <div class="card" data-pattern-match="피보나치 되돌림 (Fibonacci)">
                <h3>📐 피보나치 되돌림 (Fibonacci)</h3>
                <p><strong>의미:</strong> 주요 파동의 38.2%, 50%, 61.8% 구간에서 지지·저항 반응 감지.</p>
                <p><strong>매매 판단:</strong> 61.8% 지지 반응 시 매수. 61.8% 저항 실패 시 추가 하락 주의.</p>
            </div>

            <h3 style="margin:24px 0 12px; color:var(--color-down); font-size:1rem; font-weight:700;">🔻 단봉 하락 신호</h3>
            <div class="card" data-pattern-match="교수형 (Hanging Man)">
                <h3>🔻 교수형 (Hanging Man)</h3>
                <p><strong>형태:</strong> 상승 추세 고점에서 나타나는 망치형 모양.</p>
                <p><strong>의미:</strong> 매도 압력이 나타나기 시작한 경고 신호.</p>
                <p><strong>매매 판단:</strong> 다음 봉 음봉 확인 후 익절/감량 고려.</p>
            </div>
            <div class="card" data-pattern-match="유성형 (Shooting Star)">
                <h3>🔻 유성형 (Shooting Star)</h3>
                <p><strong>형태:</strong> 위꼬리가 길고 본체가 아래쪽에 위치하는 봉.</p>
                <p><strong>의미:</strong> 상승 추세 고점에서 매도세 급증.</p>
                <p><strong>매매 판단:</strong> 분할 매도 또는 손절선 하향 조정.</p>
            </div>
            <div class="card" data-pattern-match="비석형 도지 (Gravestone Doji)">
                <h3>🔻 비석형 도지 (Gravestone Doji)</h3>
                <p><strong>형태:</strong> 시가=종가, 위꼬리만 긴 역T자형.</p>
                <p><strong>의미:</strong> 고점에서 매수세가 매도세에 완전히 막혔음을 나타냄.</p>
                <p><strong>매매 판단:</strong> 강한 매도 신호. 익절 고려.</p>
            </div>

            <h3 style="margin:24px 0 12px; color:var(--color-down); font-size:1rem; font-weight:700;">🔻 복수봉 하락 패턴</h3>
            <div class="card" data-pattern-match="석별형 (Evening Star)">
                <h3>🔻 석별형 (Evening Star)</h3>
                <p><strong>형태:</strong> 양봉 → 짧은 봉 → 장대 음봉 3봉 패턴. 샛별형의 반대.</p>
                <p><strong>의미:</strong> 상승 추세 종료와 하락 반전을 강하게 알리는 신호.</p>
                <p><strong>매매 판단:</strong> 보유 중이면 즉시 익절 또는 손절선 상향 조정.</p>
            </div>
            <div class="card" data-pattern-match="하락 장악형 (Bearish Engulfing)">
                <h3>🔻 하락 장악형 (Bearish Engulfing)</h3>
                <p><strong>형태:</strong> 전날 양봉을 완전히 감싸는 큰 음봉.</p>
                <p><strong>의미:</strong> 매도 세력이 매수 세력을 완전히 압도. 강한 하락 신호.</p>
                <p><strong>매매 판단:</strong> 거래량 동반 시 강도 높은 매도 신호.</p>
            </div>
            <div class="card" data-pattern-match="흑운형 (Dark Cloud Cover)">
                <h3>🔻 흑운형 (Dark Cloud Cover)</h3>
                <p><strong>형태:</strong> 갭 상승 후 전날 양봉의 50% 이상 침범하는 음봉.</p>
                <p><strong>의미:</strong> 상승 모멘텀이 급격히 약화. 관통형의 반대 패턴.</p>
                <p><strong>매매 판단:</strong> 이익 실현 또는 매도 포지션 고려.</p>
            </div>
            <div class="card" data-pattern-match="흑삼병 (Three Black Crows)">
                <h3>🔻 흑삼병 (Three Black Crows)</h3>
                <p><strong>형태:</strong> 연속 3개의 장대 음봉이 계단식 하락.</p>
                <p><strong>의미:</strong> 강한 매도세가 3일 연속 지속. 하락 추세 강도 매우 높음.</p>
                <p><strong>매매 판단:</strong> 보유 중이면 즉시 손절. 신규 매수 금지.</p>
            </div>
            <div class="card" data-pattern-match="이중 천장형 (Double Top / 쌍봉)">
                <h3>🔻 이중 천장형 (Double Top / 쌍봉)</h3>
                <p><strong>형태:</strong> M자 형태로 같은 고점을 두 번 테스트 후 하락.</p>
                <p><strong>의미:</strong> 저항선 확인 후 하락 반전. 넥라인 이탈 시 하락 신호 확정.</p>
                <p><strong>매매 판단:</strong> 넥라인 이탈 확인 후 손절/매도.</p>
            </div>
            <div class="card" data-pattern-match="삼중 천장형 (Triple Top)">
                <h3>🔻 삼중 천장형 (Triple Top)</h3>
                <p><strong>형태:</strong> 같은 고점에서 3번 저항받고 하락.</p>
                <p><strong>의미:</strong> 쌍봉보다 강한 저항선 확인. 반전 신뢰도 최상.</p>
                <p><strong>매매 판단:</strong> 3번째 저항 확인 후 즉시 매도 포지션 고려.</p>
            </div>
            <div class="card" data-pattern-match="헤드 앤 숄더 (Head & Shoulders)">
                <h3>🔻 헤드 앤 숄더 (Head & Shoulders)</h3>
                <p><strong>형태:</strong> 중앙 고점(머리)과 양 어깨 형성 후 하락.</p>
                <p><strong>의미:</strong> 가장 신뢰도 높은 추세 전환 패턴.</p>
                <p><strong>매매 판단:</strong> 넥라인 이탈 시 목표 하락폭 = 머리~넥라인 거리.</p>
            </div>
            <div class="card" data-pattern-match="원형 천장형 (Rounding Top)">
                <h3>🔻 원형 천장형 (Rounding Top)</h3>
                <p><strong>의미:</strong> 장기간 완만한 상승 후 역U자 형태로 반전. 점진적 하락 예고.</p>
                <p><strong>매매 판단:</strong> 초기 반전 확인 후 분할 매도.</p>
            </div>
            <div class="card" data-pattern-match="하락 삼각형 (Descending Triangle)">
                <h3>🔻 하락 삼각형 (Descending Triangle)</h3>
                <p><strong>의미:</strong> 매도 압력이 높아지며 수평 지지선 이탈 시 급락.</p>
                <p><strong>매매 판단:</strong> 지지선 이탈 + 거래량 급증 시 손절.</p>
            </div>
            <div class="card" data-pattern-match="대칭 삼각형 하방 이탈 (Symmetrical Triangle Breakdown)">
                <h3>🔻 대칭 삼각형 하방 이탈</h3>
                <p><strong>의미:</strong> 압축 구간이 하방으로 이탈. 하락 추세 지속 신호.</p>
                <p><strong>매매 판단:</strong> 하방 이탈 확인 후 손절가 조정 또는 매도.</p>
            </div>
            <div class="card" data-pattern-match="박스권 하단 이탈 (Rectangle Breakdown)">
                <h3>🔻 박스권 하단 이탈 (Rectangle Breakdown)</h3>
                <p><strong>의미:</strong> 분산 완료 후 하락 추세 시작 신호.</p>
                <p><strong>매매 판단:</strong> 이탈 확인 즉시 손절 또는 매도.</p>
            </div>
            <div class="card" data-pattern-match="상승 쐐기형 이탈 (Rising Wedge Breakdown)">
                <h3>🔻 상승 쐐기형 이탈 (Rising Wedge Breakdown)</h3>
                <p><strong>의미:</strong> 상승 추세 힘이 약해지며 반전. 하락폭이 큰 편.</p>
                <p><strong>매매 판단:</strong> 하단 지지 이탈 확인 시 즉시 매도.</p>
            </div>
            <div class="card" data-pattern-match="하락 깃발/페넌트형 (Bearish Flag/Pennant)">
                <h3>🔻 하락 깃발/페넌트형 (Bearish Flag/Pennant)</h3>
                <p><strong>의미:</strong> 급락 후 짧은 반등 이후 재하락. 하락 추세 지속 패턴.</p>
                <p><strong>매매 판단:</strong> 깃발 구간 이탈 후 추가 매도.</p>
            </div>
            <div class="card" data-pattern-match="잠재적 이중 천장형 (Double Top 가능성)">
                <h3>🔻 잠재적 이중 천장형 (Double Top 가능성)</h3>
                <p><strong>의미:</strong> 넥라인 이탈 전 이중 천장 형성 중. 아직 확정 아님.</p>
                <p><strong>매매 판단:</strong> 익절 비중 조절 및 손절선 상향 준비.</p>
            </div>

            <h3 style="margin:24px 0 12px; color:var(--text-main); font-size:1rem; font-weight:700;">📊 시각적 패턴 매핑이란?</h3>
            <div class="card highlight">
                <h3>🗺️ 차트 위 패턴 시각화</h3>
                <p>감지된 캔들 패턴은 시각적 패턴 매핑 섹션에서 <strong>실제 차트 위에 직접 표시</strong>됩니다.</p>
                <div class="table-wrapper" style="margin-top:12px;">
                    <table>
                        <thead><tr><th>색상</th><th>의미</th></tr></thead>
                        <tbody>
                            <tr><td><strong style="color:#10b981;">초록</strong></td><td>상승 반전 패턴 (매수 관련)</td></tr>
                            <tr><td><strong style="color:#ef4444;">빨강</strong></td><td>하락 반전 패턴 (매도 관련)</td></tr>
                            <tr><td><strong style="color:#f59e0b;">주황</strong></td><td>중립 / 방향 미확정 패턴</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- 🕯️ 평균대세 상세 가이드 추가 -->
            <div class="card" style="background: var(--bg-app); border-top: 4px solid var(--primary); margin-top: 40px; border-radius: 12px; padding: 24px;">
                <h2 style="color: var(--primary); font-size: 1.4rem; margin-bottom: 16px; display: flex; align-items: center; gap: 10px;">
                    <i class="ph ph-sparkle" style="font-size: 1.8rem;"></i> 평균대세 가이드
                </h2>
                
                <p style="font-size: 1rem; line-height: 1.7; color: var(--text-main); margin-bottom: 20px;">
                    평균대세는 어제의 가격 에너지를 오늘의 캔들에 결합하여 <strong>추세의 연속성을 극대화</strong>해서 보여주는 프로 트레이딩 기법입니다.
                </p>

                <div class="table-wrapper" style="margin-bottom: 24px; background: var(--bg-card); border-radius: 8px; border: 1px solid var(--border-heavy);">
                    <table style="width: 100%; border-collapse: collapse;">
                        <thead style="background: var(--bg-app);">
                            <tr>
                                <th style="padding: 12px; border-bottom: 2px solid var(--primary); text-align: left; font-size: 0.9rem; color: var(--primary);">비교 항목</th>
                                <th style="padding: 12px; border-bottom: 2px solid var(--primary); text-align: left; font-size: 0.9rem; color: var(--primary);">일반 캔들</th>
                                <th style="padding: 12px; border-bottom: 2px solid var(--primary); text-align: left; font-size: 0.9rem; color: var(--primary);">평균대세</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td style="padding: 10px; border-bottom: 1px solid var(--border-soft); font-weight: 600; color: var(--text-main);">데이터 산출</td>
                                <td style="padding: 10px; border-bottom: 1px solid var(--border-soft); color: var(--text-sub);">당일 가격 팩트 기반</td>
                                <td style="padding: 10px; border-bottom: 1px solid var(--border-soft); color: var(--text-sub);">전일+당일 평균값 기반</td>
                            </tr>
                            <tr>
                                <td style="padding: 10px; border-bottom: 1px solid var(--border-soft); font-weight: 600; color: var(--text-main);">시각적 노이즈</td>
                                <td style="padding: 10px; border-bottom: 1px solid var(--border-soft); color: var(--text-sub);">많음 (잦은 색상 변화)</td>
                                <td style="padding: 10px; border-bottom: 1px solid var(--border-soft); color: var(--text-sub);">적음 (매끄러운 색상 유지)</td>
                            </tr>
                            <tr>
                                <td style="padding: 10px; font-weight: 600; color: var(--text-main);">활용 용도</td>
                                <td style="padding: 10px; color: var(--text-sub);">정확한 가격 및 패턴 확인</td>
                                <td style="padding: 10px; color: var(--text-sub);">중장기 추세 지속성 판단</td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px;">
                    <div style="background: rgba(239, 68, 68, 0.1); padding: 12px; border-radius: 8px; border-left: 3px solid var(--color-up);">
                        <strong style="color: var(--color-up); display: block; margin-bottom: 4px;">📈 상승 지속 신호</strong>
                        <span style="font-size: 0.85rem; color: var(--text-sub);">아래꼬리가 없는 강한 빨간 캔들이 연속될 때</span>
                    </div>
                    <div style="background: rgba(59, 130, 246, 0.1); padding: 12px; border-radius: 8px; border-left: 3px solid var(--color-down);">
                        <strong style="color: var(--color-down); display: block; margin-bottom: 4px;">📉 하락 지속 신호</strong>
                        <span style="font-size: 0.85rem; color: var(--text-sub);">위꼬리가 없는 강한 파란 캔들이 연속될 때</span>
                    </div>
                </div>

                <div class="card warning" style="margin: 0; padding: 16px; font-size: 0.95rem; border-radius: 8px; background: var(--bg-card); border: 1px solid var(--accent);">
                    <strong style="color: var(--accent);">💡 프로의 조언:</strong><br>
                    <p style="margin-top: 4px; color: var(--text-main);">평균대세 차트의 O,H,L,C 가격은 실제 거래 가격이 아닌 '가중 평균값'입니다. **실제 매매 주문을 넣으실 때는 반드시 [일반 캔들] 모드로 전환하여 현재가(Fact)를 다시 확인**하시는 것이 정석입니다.</p>
                </div>
            </div>
        `
    },

    // ── 5. 재무 건전성 및 가치 ──────────────────────────────────────
    'lesson3_4': {
        title: '재무 건전성 및 가치 분석 가이드',
        body: `
            <h2 class="section-title">수익성 & 안정성 & 가치 지표</h2>
            <p class="section-subtitle">회사가 돈을 잘 버는지, 튼튼한지, 저평가인지 확인하기</p>

            <div class="card highlight">
                <h3>📊 ROE (자기자본 수익률)</h3>
                <p>회사가 주주 자본으로 <strong>얼마나 효율적으로 이익을 창출</strong>하는지 보여줍니다. 수익성 핵심 지표.</p>
            </div>
            <div class="table-wrapper">
                <table>
                    <thead><tr><th>ROE 수준</th><th>평가</th><th>의미</th></tr></thead>
                    <tbody>
                        <tr><td>20% 이상</td><td><strong style="color:#10b981;">✓✓ 탁월</strong></td><td>워런 버핏이 선호하는 수준</td></tr>
                        <tr><td>15~20%</td><td><strong style="color:#10b981;">✓ 우수</strong></td><td>업계 평균 이상</td></tr>
                        <tr><td>10~15%</td><td><strong style="color:#f59e0b;">△ 양호</strong></td><td>전반적으로 무난한 수준</td></tr>
                        <tr><td>5% 미만</td><td><strong style="color:#ef4444;">✗ 약함</strong></td><td>수익 창출 효율 낮음</td></tr>
                    </tbody>
                </table>
            </div>

            <div class="card highlight" style="margin-top:24px;">
                <h3>📊 PER (주가수익비율)</h3>
                <p>현재 주가가 <strong>주당순이익 대비 몇 배에 거래</strong>되는지 나타냅니다. 낮을수록 저평가를 의미합니다.</p>
            </div>
            <div class="table-wrapper">
                <table>
                    <thead><tr><th>PER</th><th>평가</th></tr></thead>
                    <tbody>
                        <tr><td>10배 이하</td><td><strong style="color:#10b981;">✓ 저평가</strong> 가능성</td></tr>
                        <tr><td>10~20배</td><td><strong style="color:#f59e0b;">△ 적정</strong> 수준</td></tr>
                        <tr><td>30배 이상</td><td><strong style="color:#ef4444;">⚠ 고평가</strong> 주의 필요</td></tr>
                    </tbody>
                </table>
            </div>

            <div class="card highlight" style="margin-top:24px;">
                <h3>📊 PBR (주가순자산비율)</h3>
                <p>현재 주가가 <strong>장부가치(자산-부채) 대비 몇 배</strong>인지 나타냅니다. 1배 미만이면 이론적으로 저평가.</p>
            </div>

            <div class="card highlight" style="margin-top:24px;">
                <h3>🛡️ 부채비율</h3>
                <p>회사의 <strong>자기자본 대비 부채 규모</strong>입니다. 낮을수록 재무적으로 안전합니다.</p>
            </div>
            <div class="table-wrapper">
                <table>
                    <thead><tr><th>부채비율</th><th>평가</th></tr></thead>
                    <tbody>
                        <tr><td>50% 이하</td><td><strong style="color:#10b981;">✓✓ 매우 안전</strong></td></tr>
                        <tr><td>50~100%</td><td><strong style="color:#10b981;">✓ 안전</strong></td></tr>
                        <tr><td>100~200%</td><td><strong style="color:#f59e0b;">△ 평균</strong></td></tr>
                        <tr><td>200% 이상</td><td><strong style="color:#ef4444;">⚠️ 위험</strong></td></tr>
                    </tbody>
                </table>
            </div>

            <div class="card highlight" style="margin-top:24px;">
                <h3>💰 매출 성장률</h3>
                <p>전년 동기 대비 <strong>매출이 얼마나 성장했는지</strong>를 보여줍니다. 지속적인 매출 성장은 기업 경쟁력의 핵심 지표입니다.</p>
            </div>
            <div class="table-wrapper">
                <table>
                    <thead><tr><th>성장률</th><th>평가</th></tr></thead>
                    <tbody>
                        <tr><td>20% 이상</td><td><strong style="color:#10b981;">✓✓ 고성장</strong></td></tr>
                        <tr><td>5~20%</td><td><strong style="color:#f59e0b;">△ 안정 성장</strong></td></tr>
                        <tr><td>0~5%</td><td><strong style="color:#f59e0b;">△ 정체</strong></td></tr>
                        <tr><td>마이너스</td><td><strong style="color:#ef4444;">✗ 역성장</strong></td></tr>
                    </tbody>
                </table>
            </div>
        `
    },

    // ── 6. 주요 공시 및 모멘텀 ──────────────────────────────────────
    'lesson_event': {
        title: '주요 공시 및 모멘텀 가이드',
        body: `
            <h2 class="section-title">공시 및 모멘텀 분석</h2>
            <p class="section-subtitle">DART 공시와 최근 뉴스를 통한 재료 분석</p>
            <div class="card highlight">
                <h3>📢 공시 분석이란?</h3>
                <p>금융감독원 전자공시시스템(DART)에 올라오는 기업의 주요 결정을 분석하여 <strong>호재(주가 상승 재료)와 악재(주가 하락 재료)</strong>를 파악하는 과정입니다.</p>
            </div>
            <div class="card success">
                <h3>🔺 주요 호재성 공시 유형</h3>
                <ul class="checklist">
                    <li><strong>대규모 공급 계약</strong> — 매출 대비 비중 10% 이상 시 강력 호재</li>
                    <li><strong>무상증자</strong> — 주주 환원 의지 표명, 주가 상승 기대감 유발</li>
                    <li><strong>자사주 매입·소각</strong> — 주당 가치 상승 효과</li>
                    <li><strong>신규 사업·투자 유치</strong> — 미래 성장성 부각</li>
                    <li><strong>배당 증가</strong> — 이익의 주주 환원 강화 신호</li>
                </ul>
            </div>
            <div class="card danger">
                <h3>🔻 주요 악재성 공시 유형</h3>
                <ul class="checklist">
                    <li><strong>유상증자</strong> — 운영자금 조달 목적 시 주식 가치 희석</li>
                    <li><strong>최대주주 변경</strong> — 경영권 불안정으로 주가 변동성 확대</li>
                    <li><strong>횡령·배임 혐의</strong> — 기업 신뢰도 급격 하락</li>
                    <li><strong>계약 해지·정정 공시</strong> — 실적 기대치 하락</li>
                    <li><strong>대규모 손상차손</strong> — 자산 가치 하락 인식</li>
                </ul>
            </div>
            <div class="card highlight">
                <h3>📈 모멘텀이란?</h3>
                <p>모멘텀은 <strong>주가의 방향성과 속도</strong>를 의미합니다. 긍정적 모멘텀(뉴스·실적 기대)이 강할 때는 추세에 올라타는 전략이 유효합니다.</p>
            </div>
            <div class="table-wrapper">
                <table>
                    <thead><tr><th>모멘텀 유형</th><th>설명</th></tr></thead>
                    <tbody>
                        <tr><td><strong>실적 모멘텀</strong></td><td>어닝 서프라이즈, 가이던스 상향</td></tr>
                        <tr><td><strong>정책 모멘텀</strong></td><td>정부 지원·규제 완화</td></tr>
                        <tr><td><strong>산업 모멘텀</strong></td><td>업황 사이클 회복기 진입</td></tr>
                        <tr><td><strong>수급 모멘텀</strong></td><td>외국인·기관 연속 순매수</td></tr>
                    </tbody>
                </table>
            </div>
        `
    },

    // ── 7. 업종 및 시장 지위 ────────────────────────────────────────
    'lesson_sector': {
        title: '업종 및 시장 지위 가이드',
        body: `
            <h2 class="section-title">업종 및 시장 지위 분석</h2>
            <p class="section-subtitle">산업 내 경쟁력과 지배력이 왜 중요한가</p>
            <div class="card highlight">
                <h3>🏢 시장 지위의 중요성</h3>
                <p>업계 1위 기업(대장주)은 <strong>불황에도 견디는 힘</strong>이 강하며, 호황기에는 수익성이 가장 크게 개선됩니다. 진입 장벽이 높아 경쟁자가 쉽게 따라오지 못합니다.</p>
            </div>
            <div class="table-wrapper">
                <table>
                    <thead><tr><th>시장 지위</th><th>특징</th><th>투자 관점</th></tr></thead>
                    <tbody>
                        <tr><td><strong>시장 주도주</strong></td><td>가격 결정권 보유, 브랜드 가치</td><td>프리미엄 벨류에이션 부여</td></tr>
                        <tr><td><strong>기술 선도자</strong></td><td>핵심 특허·원천 기술 보유</td><td>진입 장벽으로 장기 성장성 우위</td></tr>
                        <tr><td><strong>규모의 경제</strong></td><td>시장 점유율 1위, 원가 우위</td><td>불황기 경쟁력 유지</td></tr>
                        <tr><td><strong>틈새 강자</strong></td><td>특정 분야 독점적 입지</td><td>M&A 타깃 가능성 → 프리미엄</td></tr>
                    </tbody>
                </table>
            </div>
            <div class="card highlight">
                <h3>🌐 산업 사이클 분석</h3>
                <p>업종은 <strong>확장 → 정점 → 침체 → 회복</strong> 사이클을 반복합니다. 어느 단계인지에 따라 투자 전략이 완전히 달라집니다.</p>
            </div>
            <div class="table-wrapper">
                <table>
                    <thead><tr><th>사이클 단계</th><th>특징</th><th>투자 판단</th></tr></thead>
                    <tbody>
                        <tr><td><strong>회복기</strong></td><td>재고 감소, 신규 수주 증가</td><td><strong style="color:#10b981;">✓ 매수 최적 시기</strong></td></tr>
                        <tr><td><strong>확장기</strong></td><td>실적 급성장, 설비 투자</td><td><strong style="color:#10b981;">✓ 보유 유지</strong></td></tr>
                        <tr><td><strong>정점기</strong></td><td>재고 급증, 마진 압박 시작</td><td><strong style="color:#f59e0b;">△ 분할 매도 고려</strong></td></tr>
                        <tr><td><strong>침체기</strong></td><td>감산, 영업손실 발생</td><td><strong style="color:#ef4444;">✗ 매도/관망</strong></td></tr>
                    </tbody>
                </table>
            </div>
            <div class="card">
                <h3>🔬 ECOS 데이터 활용</h3>
                <p>한국은행 경제통계시스템(ECOS)의 산업 생산·재고 통계를 바탕으로 현재 해당 업종이 <strong>어느 사이클 단계</strong>에 있는지 분석합니다.</p>
            </div>
        `
    },

    // ── 8. 적정 가치 및 목표가 ──────────────────────────────────────
    'lesson_target': {
        title: '적정 가치 및 목표가 가이드',
        body: `
            <h2 class="section-title">적정 가치 & 목표가 산출 원리</h2>
            <p class="section-subtitle">이 주식이 지금 '비싼지 싼지' 판단하는 방법</p>
            <div class="card highlight">
                <h3>🎯 목표가 산정 4가지 방식</h3>
                <ul class="checklist">
                    <li><strong>PER 밸류에이션</strong> — 업종 평균 PER × 예상 EPS</li>
                    <li><strong>PBR 밸류에이션</strong> — 업종 평균 PBR × BPS</li>
                    <li><strong>DCF (현금흐름 할인)</strong> — 미래 현금흐름의 현재 가치</li>
                    <li><strong>PEG 비율</strong> — PER ÷ 이익 성장률 (성장주 판단)</li>
                </ul>
            </div>
            <div class="table-wrapper">
                <table>
                    <thead><tr><th>밸류에이션 방식</th><th>적합한 주식 유형</th></tr></thead>
                    <tbody>
                        <tr><td><strong>PER</strong></td><td>이익이 안정적인 성숙 기업</td></tr>
                        <tr><td><strong>PBR</strong></td><td>자산 규모가 중요한 금융·제조업</td></tr>
                        <tr><td><strong>DCF</strong></td><td>미래 이익 예측이 중요한 성장주</td></tr>
                        <tr><td><strong>PSR (주가매출비율)</strong></td><td>아직 이익이 없는 초기 성장 기업</td></tr>
                    </tbody>
                </table>
            </div>
            <div class="comparison">
                <div class="comparison-item card">
                    <h3>📈 성장주 목표가</h3>
                    <p>미래 이익(Earnings) 성장에 비중을 둡니다. 꿈이 크지만 변동성도 큽니다. PEG < 1이면 성장 대비 저평가.</p>
                </div>
                <div class="comparison-item card">
                    <h3>🏦 가치주 목표가</h3>
                    <p>현재 자산(Asset) 가치에 비중을 둡니다. PBR < 1인 경우 청산 가치 이하로 거래 중을 의미합니다.</p>
                </div>
            </div>
            <div class="card success">
                <h3>📐 안전마진 (Margin of Safety)</h3>
                <p>워런 버핏이 강조하는 개념으로, <strong>산출된 적정 가치보다 30% 이상 낮을 때 매수</strong>하는 원칙입니다. 예상치 못한 리스크에 대한 완충 역할을 합니다.</p>
            </div>
            <div class="card warning">
                <h3>⚠️ 목표가의 한계</h3>
                <p>목표가는 이론적 수치입니다. 시황, 수급, 금리 변화에 따라 실제와 괴리가 발생할 수 있으므로 <strong>보수적·분할 접근</strong>이 필수입니다.</p>
            </div>
        `
    },

    // ── 9. AI 통합 총평 ─────────────────────────────────────────────
    'lesson5': {
        title: '종합 분석 & 투자 결정 가이드',
        body: `
            <h2 class="section-title">투자 결정 체크리스트</h2>
            <p class="section-subtitle">4개 축의 분석을 종합해 최종 판단하는 방법</p>
            <div class="card highlight">
                <h3>🧠 AI 총평은 어떻게 만들어지나?</h3>
                <p>AI 통합 분석 총평은 다음 4개 축의 점수를 종합하여 산출됩니다:</p>
                <ol style="margin-top:12px; padding-left:20px; line-height:2;">
                    <li><strong>퀀트 분석축</strong> — ROE, PER, 부채비율, 성장률</li>
                    <li><strong>이벤트 분석축</strong> — 최근 공시, 뉴스 모멘텀</li>
                    <li><strong>섹터 분석축</strong> — 업종 사이클, 시장 지위</li>
                    <li><strong>가치 분석축</strong> — 적정 가치 대비 현재가 위치</li>
                </ol>
            </div>
            <div class="card success">
                <h3>✅ 매수 전 필수 확인 (황금 조건)</h3>
                <ul class="checklist">
                    <li>AI 추세 신호 강도 <strong>60% 이상</strong></li>
                    <li>긍정적 캔들 패턴 (망치형, 샛별형 등) <strong>감지</strong></li>
                    <li>ROE <strong>15% 이상</strong>, 부채비율 <strong>100% 이하</strong></li>
                    <li>현재가가 AI 산출 적정가 <strong>이하</strong></li>
                    <li>매출 성장률 <strong>플러스(+)</strong> 유지</li>
                    <li>최근 공시 중 <strong>호재성 재료 존재</strong></li>
                </ul>
            </div>
            <div class="card danger">
                <h3>🚫 매수 회피 신호 (위험 조건)</h3>
                <ul class="checklist">
                    <li>AI 신호 강도 <strong>50% 미만</strong> 지속</li>
                    <li>하락 캔들 패턴 (헤드앤숄더, 삼중천정 등) 감지</li>
                    <li>부채비율 <strong>200% 초과</strong></li>
                    <li>최근 유상증자·횡령 등 <strong>악재 공시</strong> 발생</li>
                    <li>업종 침체기 진입</li>
                </ul>
            </div>
            <div class="table-wrapper">
                <table>
                    <thead><tr><th>종합 점수</th><th>투자 판단</th></tr></thead>
                    <tbody>
                        <tr><td><strong>4/4 충족</strong></td><td><strong style="color:#10b981;">✓✓ 강한 매수 고려</strong></td></tr>
                        <tr><td><strong>3/4 충족</strong></td><td><strong style="color:#10b981;">✓ 분할 매수 고려</strong></td></tr>
                        <tr><td><strong>2/4 충족</strong></td><td><strong style="color:#f59e0b;">△ 관망 또는 소량 접근</strong></td></tr>
                        <tr><td><strong>1/4 이하</strong></td><td><strong style="color:#ef4444;">✗ 회피 권장</strong></td></tr>
                    </tbody>
                </table>
            </div>
            <div class="card warning">
                <h3>⚠️ 리스크 관리 원칙</h3>
                <p>아무리 지표가 좋아도 <strong>거시 경제 충격, 돌발 지정학 리스크</strong>는 항상 존재합니다. 분할 매수와 손절가 기계적 준수가 필수입니다.</p>
            </div>
        `
    }
};

function openHelpModal(topic) {
    const modal = document.getElementById('helpModal');
    const titleEl = document.getElementById('helpModalTitle');
    const bodyEl = document.getElementById('helpModalBody');
    
    const content = HELP_CONTENT[topic];
    if (!content) return;

    titleEl.textContent = content.title;

    // 동적 배너(현재 분석 수치) 삽입
    const liveBanner = _buildLiveBanner(topic);
    bodyEl.innerHTML = liveBanner + content.body;
    
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    
    // ── 캔들 패턴 강조 로직 (bidirectional match) ──
    if (topic === 'lesson2') {
        const buyPat  = (document.getElementById('buyPattern')?.textContent || '').trim();
        const sellPat = (document.getElementById('sellPattern')?.textContent || '').trim();
        // 감지된 패턴 전체 (매수 우선, 없으면 매도)
        const detectedText = (buyPat && buyPat !== '-') ? buyPat : sellPat;
        
        if (detectedText && detectedText !== '-') {
            const cards = bodyEl.querySelectorAll('.card[data-pattern-match]');
            let targetCard = null;
            let bestScore = 0;
            
            cards.forEach(card => {
                const matchText = card.getAttribute('data-pattern-match');
                // 양방향 포함 매칭 + 정확도 스코어
                const exactMatch = matchText === detectedText;
                const forwardMatch = detectedText.includes(matchText);
                const reverseMatch = matchText.includes(detectedText);
                const score = exactMatch ? 3 : (forwardMatch && reverseMatch ? 2 : (forwardMatch || reverseMatch ? 1 : 0));
                if (score > bestScore) {
                    bestScore = score;
                    targetCard = card;
                }
            });
            
            if (targetCard && bestScore > 0) {
                targetCard.classList.add('guide-highlight');
                setTimeout(() => targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
            }
        }
    }
    
    // Modal animation reset
    const container = modal.querySelector('.modal-container');
    container.style.animation = 'none';
    container.offsetHeight;
    container.style.animation = null;
}




function closeHelpModal() {
    const modal = document.getElementById('helpModal');
    modal.classList.add('hidden');
    document.body.style.overflow = ''; // Scroll unlock
}


// ──────────────────────────────────────────────────────────────────
// ── Global Event Handlers (Optimization) ─────────────
// ──────────────────────────────────────────────────────────────────

/**
 * 전역 Resize 핸들러 — 불필요한 이벤트 중복 방지 및 모달 리프레시 방지
 */
const debounce = (func, wait) => {
    let timeout;
    return (...args) => {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
};

window.addEventListener('resize', debounce(() => {
    // 1. 하이킨아시/표준 차트 리사이즈
    if (window.currentChart) {
        const container = document.getElementById('chartContainer');
        if (container) {
            const newW = container.clientWidth || (container.parentElement ? container.parentElement.clientWidth : 800);
            window.currentChart.applyOptions({ width: newW });
        }
    }
    
    // 2. 시장 지수 차트 리사이즈
    if (window.currentIndexChart) {
        const container = document.getElementById('indexChartContainer');
        if (container) {
            const { width, height } = container.getBoundingClientRect();
            if (width > 0 && height > 0) {
                window.currentIndexChart.applyOptions({ width, height });
            }
        }
    }
    
    // 3. 지배력(Force Graph) 리사이즈 (기존 로직 통합)
    if (window._vcCurrentView === 'graph' && window._vcFg) {
        const container = document.getElementById('vcGraphContainer');
        if (container && window._vcFg) {
            window._vcFg.width(container.clientWidth).height(Math.max(500, container.clientHeight - 40));
        }
    }
}, 150));

// Global escape key to close modals
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeHelpModal();
        closeModal(); // System modal check
    }
});
