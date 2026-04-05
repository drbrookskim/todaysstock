
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
                            currentStockLabel.textContent = `${currentStock.name} (${currentStock.code || currentStock.ticker || ''})`;
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
                const heroMem = document.getElementById('mainSearchHero');
                
                if (resSecMem) {
                    resSecMem.classList.remove('hidden');
                    // Physical Layer Override: Force through direct style to prevent any override
                    resSecMem.style.setProperty('display', 'block', 'important');
                    resSecMem.style.setProperty('visibility', 'visible', 'important');
                    resSecMem.style.setProperty('opacity', '1', 'important');
                }
                if (heroMem) {
                    heroMem.classList.add('hidden');
                    heroMem.style.setProperty('display', 'none', 'important');
                }
            });
            
            if (searchInput && !searchInput.value) searchInput.value = currentStock.name;

            // [FIX] Always ensure results are rendered if they exist in memory
            if (resSec && currentStock.data) {
                renderResult(currentStock.data);
            }
        }
    }

    // [CRITICAL] Show Hero UI ONLY if we have NO active stock AND it's a force reset (like logo click)
    if (force || !currentStock) {
        if (searchHero) {
            searchHero.classList.remove('hidden');
            searchHero.style.setProperty('display', 'flex', 'important');
            searchHero.style.opacity = '1';
        }
    } else {
        // Double-down on ensuring hero is hidden if currentStock exists
        if (searchHero) {
            searchHero.classList.add('hidden');
            searchHero.style.setProperty('display', 'none', 'important');
        }
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
    const sections = ['dashboardHome', 'analysisSection', 'historySection', 'watchlistSection', 'valueChainSection', 'resultSection'];
    sections.forEach(s => {
        const el = document.getElementById(s);
        if (el) {
            el.classList.add('hidden');
            // [MOD] Do NOT clear el.style.display, let CSS and explicit JS handle it
        }
    });

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

    if (id === 'dashboardHome') {
        renderRecentSearches();
        // [CRITICAL FIX] Ensure search results are visible and prioritize display stability via inline-block-important
        if (currentStock) {
            console.log('[DEBUG] Home visible - hard-forcing result card display for', currentStock.name);
            requestAnimationFrame(() => {
                const resSecMem = document.getElementById('resultSection');
                if (resSecMem) {
                    resSecMem.classList.remove('hidden');
                    // Physical Layer Override: Force through direct style to prevent any JS-based override
                    resSecMem.style.setProperty('display', 'block', 'important');
                    resSecMem.style.setProperty('visibility', 'visible', 'important');
                    resSecMem.style.setProperty('opacity', '1', 'important');
                }
                const searchHero = document.getElementById('mainSearchHero');
                if (searchHero) {
                    searchHero.classList.add('hidden');
                    searchHero.style.setProperty('display', 'none', 'important');
                }
                // Robust scroll position restoration
                window.scrollTo({ top: 0, behavior: 'instant' });
            });
        }
        resetDashboardHome(false); 
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
    } else {
        requestAnimationFrame(() => {
            console.log(`[DEBUG] Section "${id}" is now active. Triggering renderers.`);
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
    container.innerHTML = list.map(item => `
        <div class="watchlist-tile animate-in" data-code="${escapeHtml(item.code)}" data-market="${escapeHtml(item.market)}" data-name="${escapeHtml(item.name)}">
            <div class="watchlist-tile-clickable-area">
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
            </div>
        </div>
    `).join('');

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
async function selectStock(item, origin = 'search') {
    hideSuggestions();
    
    // Add to recent
    saveRecentSearch(item);
    
    if (searchInput) searchInput.value = item.name;
    currentStock = item;

    // Update watchlist button & sidebar highlight
    updateWatchlistBtn();
    
    console.log(`[DEBUG] selectStock - origin: ${origin}, stock: ${item.name}`);

    // Fetch basic stock data (Always needed for chart/summary)
    const url = `${API_BASE_URL}/api/stock?code=${item.code}&market=${item.market}&name=${encodeURIComponent(item.name)}`;
    try {
        if (loadingSpinner) loadingSpinner.classList.remove('hidden');
        if (resultSection) resultSection.classList.add('hidden');
        
        const response = await fetchWithTimeout(url, { timeout: 30000 });
        if (!response.ok) throw new Error('데이터를 불러오는데 실패했습니다.');
        const data = await response.json();
        
        if (loadingSpinner) loadingSpinner.classList.add('hidden');

        if (origin === 'search') {
            homeStockContext = { item, data, analysis: null };
            
            // Navigate to Home section
            navigateToSection('navHome');
            
            // Smoothly scroll to the result ONLY if we're not explicitly resetting to a clean Home
            requestAnimationFrame(() => {
                const resSec = document.getElementById('resultSection');
                // Only scroll if result is visible and we didn't just force a home reset
                if (resSec && !resSec.classList.contains('hidden')) {
                    resSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
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
            if (currentLabel) currentLabel.textContent = `${item.name} (${item.code})`;

            // triggerFullDeepAnalysis is now handled by navigateToSection -> initNavigation
        }
    } catch (err) {
        console.error('Stock selection failed:', err);
        if (loadingSpinner) loadingSpinner.classList.add('hidden');
        showToast('데이터 로딩에 실패했습니다.', 'error');
    }
}

async function triggerFullDeepAnalysis(code) {
    const globalLoading = document.getElementById('analysisGlobalLoading');
    const loadingText = document.getElementById('analysisLoadingText');
    const patternReportSection = document.getElementById('patternReportSection');
    const emptyState = document.getElementById('analysisEmptyState');
    const contentWrapper = document.getElementById('analysisContentWrapper');

    const aiBlocks = ['aiTrendBlock', 'aiBuySignalBlock', 'aiSellSignalBlock', 'aiPatternsBlock', 'aiChartBlock', 'aiSummaryBlock'];
    const allBlocks = [...aiBlocks, 'fundSummaryBlock', 'fundQuantBlock', 'fundEventBlock', 'fundSectorBlock', 'fundTargetBlock'];

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

        // Reset UI state for FRESH loading ONLY
        if (emptyState) emptyState.classList.add('hidden');
        if (contentWrapper) contentWrapper.classList.remove('hidden');
        if (globalLoading) {
            globalLoading.classList.remove('hidden');
            if (loadingText) loadingText.textContent = 'AI 캔들 패턴 및 추세 분석 중...';
        }
        
        allBlocks.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.classList.add('hidden');
                el.classList.remove('visible');
            }
        });
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
    const hasData = indexList && indexList.innerHTML.length > 100;
    if (now - _lastMacroLoadTime < 300000 && hasData) {
        console.log('[DEBUG] Skipping macro indicators load - using session cache');
        return;
    }
    _lastMacroLoadTime = now;

    try {
        const url = `${API_BASE_URL}/api/macro?t=${Date.now()}`;
        console.log('[DEBUG] Fetching macro data from:', url);
        const resp = await fetchWithTimeout(url, { timeout: 30000 });
        if (!resp.ok) throw new Error(`HTTP Error: ${resp.status}`);
        const data = await resp.json();
        if (data.error) console.warn('[DEBUG] Server reported error:', data.error);
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
        const errorMsg = err.name === 'TimeoutError' ? '서버 응답 시간 초과 (30초)' : (err.message || '알 수 없는 오류');
        if (indexList) {
            indexList.innerHTML = `
                <div class="error-msg" style="padding: 20px; text-align: center;">
                    <div style="font-weight: bold; margin-bottom: 8px;">지표 로드 실패</div>
                    <div style="font-size: 12px; opacity: 0.7;">${errorMsg}</div>
                    <button onclick="renderMacroIndicators()" style="margin-top: 12px; padding: 4px 12px; font-size: 12px; cursor: pointer;">다시 시도</button>
                </div>
            `;
        }
    }
}

// ── 상세 지수 차트 렌더링 (Lightweight Charts) ──
async function renderIndexChart(symbol, name) {
    const titleName = document.getElementById('selectedIndexName');
    const container = document.getElementById('indexChart');
    if (titleName) titleName.textContent = `${name} 지수 차트 (드래그/줌 가능)`;
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
                timeVisible: true,
                secondsVisible: false,
                mouseWheel: true,
                pinchZoom: true,
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

        if (data.history && data.history.length > 22) {
            // 최근 1개월(약 22 거래일)만 우선 보여줌 (수정: 드래그로 2년 전까지 가능)
            const last = data.history[data.history.length - 1].time;
            const first = data.history[data.history.length - 22].time;
            chart.timeScale().setVisibleRange({ from: first, to: last });
        } else {
            chart.timeScale().fitContent();
        }
        currentIndexChart = chart;

        // Sync with resize
        const resizeObserver = new ResizeObserver(entries => {
            if (entries.length === 0 || !currentIndexChart) return;
            const { width, height } = entries[0].contentRect;
            if (width > 0 && height > 0) {
                currentIndexChart.applyOptions({ width, height });
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
    _lastAnalysisData = data;
    
    // Ensure parent container is visible immediately
    const contentWrapper = document.getElementById('analysisContentWrapper');
    const emptyState = document.getElementById('analysisEmptyState');
    if (contentWrapper) contentWrapper.classList.remove('hidden');
    if (emptyState) emptyState.classList.add('hidden');

    const hasBuyReport = data.buy_report && data.buy_report !== null;
    const hasSellReport = data.sell_report && data.sell_report !== null;
    
    // Sequential Reveal Logic
    const blocks = ['aiTrendBlock'];
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
        if (aiPatternsBlock) aiPatternsBlock.classList.remove('hidden'); // Always show the block header
        if (patternsCard) patternsCard.classList.remove('hidden');
        if (patternsList) patternsList.innerHTML = '';
        if (noPatternsMsg) noPatternsMsg.classList.remove('hidden');
    } else {
        if (aiPatternsBlock) aiPatternsBlock.classList.remove('hidden');
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
        if (aiChartBlock) aiChartBlock.classList.remove('hidden');
        if (candleChartCard) candleChartCard.classList.remove('hidden');
        renderCandleChart(data.recent_candles);
    } else {
        if (aiChartBlock) aiChartBlock.classList.add('hidden');
    }

    // ── 5. Recent Week Analysis / Summary Block ──
    const aiSummaryBlock = document.getElementById('aiSummaryBlock');
    const recentWeekAnalysis = document.getElementById('recentWeekAnalysis');
    const recentWeekList = document.getElementById('recentWeekList');

    if (data.recent_week_analysis && data.recent_week_analysis.length > 0) {
        if (aiSummaryBlock) aiSummaryBlock.classList.remove('hidden');
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
    const reasonElInitial = document.getElementById('fundSignalReason');
    if (reasonElInitial) reasonElInitial.textContent = '데이터 분석 중…';
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
        const reasonEl = document.getElementById('fundSignalReason');
        if (reasonEl) reasonEl.textContent = `❌ 펀더멘탈 데이터 로드 실패 (${e.message})`;
        
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

    // Update fundSummaryBlock with 2-column sidebar layout
    const summaryBody = document.querySelector('#fundSummaryBlock .workout-body');
    if (summaryBody) {
        summaryBody.innerHTML = `
            <div class="prob-two-col" style="background:transparent; padding:0; gap:20px; align-items:center;">
                <div class="prob-left-col" style="flex:0 0 100px; border:none; padding-right:0; align-items:center;">
                    <div style="font-size:2.8rem; margin-bottom:8px; filter: drop-shadow(0 0 10px var(--primary-glow));">🧠</div>
                    <div style="font-size:0.85rem; color:var(--text-muted); font-weight:700;">AI 통합 인지</div>
                </div>
                <div class="prob-right-col" style="flex:1;">
                    <div id="fundSignalReason" class="fund-signal-reason" style="margin:0; border:none; padding:0; font-size:1.1rem; line-height:1.6; font-weight:600; color:var(--text-main);">
                        ${d.signal_reason || '분석 결과가 없습니다.'}
                    </div>
                </div>
            </div>`;
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
        <div class="prob-two-col" style="background:transparent; padding:0; gap:20px; align-items:flex-start;">
            <div class="prob-left-col" style="flex:0 0 100px; border:none; padding-right:0; align-items:center;">
                <div style="font-size:2.5rem; margin-bottom:8px;">📊</div>
                <div style="font-size:0.85rem; color:var(--text-muted); font-weight:700;">재무 분석</div>
                <div class="fund-score-badge" style="margin-top:10px; font-size:1.4rem; font-weight:900; color:var(--primary);">${q.score || '—'}점</div>
            </div>
            <div class="prob-right-col" style="display:flex; flex-direction:column; gap:10px; width:100%;">
                <table class="fund-metric-table" style="width:100%;">
                    ${qRows.map(([k, v]) => `<tr><td style="color:var(--text-muted); font-size:0.85rem;">${k}</td><td style="text-align:right; font-weight:700; color:var(--text-main);">${v}</td></tr>`).join('')}
                </table>
                <div class="fund-score-desc" style="font-size:0.82rem; color:var(--text-sub); margin-top:10px; background:rgba(255,255,255,0.05); padding:12px; border-radius:12px; line-height:1.5;">
                    ${q.score >= 75 ? '🔥 <b>매우 우수</b> - 강력한 펀더멘탈' : q.score >= 55 ? '✅ <b>평균 이상</b> - 양호한 상태' : '⚠️ <b>기준 미달</b> - 리스크 주의 필요'}
                </div>
                <div style="font-size:0.7rem; color:var(--text-muted); margin-top:4px;">${q.period || ''} ${q.qtr_period ? ' / ' + q.qtr_period : ''}</div>
            </div>
        </div>`;

    // ── Event-Driven Analysis ──
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
                <div class="prob-right-col" style="display:flex; flex-direction:column; gap:10px; width:100%;">
                    ${evts.map(ev => `
                    <div class="fund-event-item fund-event-${ev.signal}" 
                         ${ev.rcept_no ? `onclick="window.open('https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${ev.rcept_no}', '_blank')"` : ''}
                         style="width:100%; padding:10px 14px; border-radius:12px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                            <span class="fund-event-label" style="font-size:0.75rem; font-weight:700;">${ev.label}</span>
                            <span class="fund-event-date" style="font-size:0.75rem; opacity:0.8;">${ev.date ? ev.date.replace(/(\d{4})(\d{2})(\d{2})/, '$1.$2.$3') : ''}</span>
                        </div>
                        <div class="fund-event-title" title="${ev.title}" style="font-size:0.9rem; font-weight:600; line-height:1.4;">
                            ${ev.title.length > 35 ? ev.title.slice(0, 35) + '…' : ev.title}
                            ${ev.rcept_no ? '<i class="ph ph-arrow-square-out" style="font-size:0.8rem; margin-left:4px; opacity:0.6;"></i>' : ''}
                        </div>
                    </div>`).join('')}
                </div>
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
            <div class="prob-two-col" style="background:transparent; padding:0; gap:20px; align-items:flex-start;">
                <div class="prob-left-col" style="flex:0 0 100px; border:none; padding-right:0; align-items:center;">
                    <div style="font-size:2.5rem; margin-bottom:8px;">🏢</div>
                    <div style="font-size:0.85rem; color:var(--text-muted); font-weight:700;">업종 분석</div>
                </div>
                <div class="prob-right-col" style="display:flex; flex-direction:column; gap:8px; width:100%;">
                    <div style="font-size:0.88rem; font-weight:700; color:var(--primary); margin-bottom:6px; opacity:0.9;">
                        ${s.name || '종합'} 업종 평균 대비
                    </div>
                    ${comps.map(c => `
                    <div class="fund-event-item" style="width:100%; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05); padding:10px 14px; border-radius:12px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                            <span style="font-size:0.75rem; color:var(--text-muted); font-weight:700;">${c.label}</span>
                            <span style="font-size:0.75rem; font-weight:900; color:${c.status === '우위' || c.status === '저평가' ? '#10b981' : '#ef4444'}; background:rgba(0,0,0,0.25); padding:2px 10px; border-radius:99px;">
                                ${c.status}
                            </span>
                        </div>
                        <div style="display:flex; justify-content:space-between; align-items:baseline;">
                            <span style="font-size:1.1rem; font-weight:800; color:var(--text-main);">${c.value}</span>
                            <span style="font-size:0.8rem; color:var(--text-muted); font-weight:600;">평균 ${c.avg}</span>
                        </div>
                    </div>`).join('')}
                </div>
            </div>`;
    }

    // ── Target Analysis ──
    const target = d.target;
    if (target) {
        const color = target.status === '저평가' || target.status === '매력' ? '#10b981' : (target.status === '고평가' ? '#ef4444' : '#6366f1');
        document.getElementById('fundTargetContent').innerHTML = `
            <div class="prob-two-col" style="background:transparent; padding:0; gap:20px; align-items:flex-start;">
                <div class="prob-left-col" style="flex:0 0 100px; border:none; padding-right:0; align-items:center;">
                    <div style="font-size:2.5rem; margin-bottom:8px;">🎯</div>
                    <div style="font-size:0.85rem; color:var(--text-muted); font-weight:700;">가치 분석</div>
                </div>
                <div class="prob-right-col" style="display:flex; flex-direction:column; gap:12px; width:100%;">
                    <div style="text-align:center; padding:18px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); border-radius:16px; box-shadow: 0 4px 20px rgba(0,0,0,0.15);">
                        <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:8px; font-weight:600;">예상 적정 주가</div>
                        <div style="font-size:1.8rem; font-weight:950; color:${color}; letter-spacing:-0.5px; line-height:1;">${Number(target.value).toLocaleString()}원</div>
                        <div style="font-size:0.95rem; margin-top:8px;">
                            <span style="background:${color}; color:white; padding:3px 12px; border-radius:99px; font-weight:900; font-size:0.8rem;">${target.status}</span>
                            <span style="color:var(--text-muted); margin-left:8px; font-weight:700;">(기대수익: ${target.upside > 0 ? '+' : ''}${target.upside}%)</span>
                        </div>
                    </div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                        <div class="fund-tile-v2">
                            <div class="tile-label">S-RIM value</div>
                            <div class="tile-value">${Number(target.srim).toLocaleString()} <span style="font-size:0.8rem; font-weight:700; margin-left:2px;">원</span></div>
                        </div>
                        <div class="fund-tile-v2">
                            <div class="tile-label">Intrinsic value</div>
                            <div class="tile-value">${Number(target.basic).toLocaleString()} <span style="font-size:0.8rem; font-weight:700; margin-left:2px;">원</span></div>
                        </div>
                    </div>
                    <div style="font-size:0.75rem; color:var(--text-muted); text-align:center; opacity:0.7;">
                        * ${target.method} (Cash-Flow Discount Model)
                    </div>
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

    // [CRITICAL] Set initial scroll position to the far right (most recent data)
    // Wrap in requestAnimationFrame to ensure DOM is ready
    requestAnimationFrame(() => {
        container.scrollLeft = container.scrollWidth;
        console.log('[DEBUG] Candle chart scroll set to right:', container.scrollLeft);
    });
}


let currentChart = null;

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
    container.innerHTML = '';

    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const chartOptions = {
        width: container.clientWidth,
        height: 320,
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
    });

    // 2. Moving Averages
    const ma5Series = chart.addLineSeries({ color: '#F59E0B', lineWidth: 1.5, title: '5' });
    const ma20Series = chart.addLineSeries({ color: '#EC4899', lineWidth: 1.5, title: '20' });
    const ma60Series = chart.addLineSeries({ color: '#14B8A6', lineWidth: 1.5, title: '60' });
    const ma120Series = chart.addLineSeries({ color: '#8B5CF6', lineWidth: 1.5, title: '120' });

    // 3. Volume Series (Overlay)
    const volumeSeries = chart.addHistogramSeries({
        color: '#71717a',
        priceFormat: { type: 'volume' },
        priceScaleId: '', // Overlay over main price scale
    });
    volumeSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
    });

    // Prepare data
    // Original date format might be '2024-04-05' or similar
    const candleData = [];
    const volData = [];
    const ma5Data = [];
    const ma20Data = [];
    const ma60Data = [];
    const ma120Data = [];

    candles.forEach(c => {
        const time = c.date; // Expecting 'YYYY-MM-DD'
        candleData.push({ time, open: c.open, high: c.high, low: c.low, close: c.close });
        volData.push({ 
            time, 
            value: c.volume, 
            color: c.is_bullish ? 'rgba(239, 68, 68, 0.5)' : 'rgba(59, 130, 246, 0.5)' 
        });
        if (c.ma5) ma5Data.push({ time, value: c.ma5 });
        if (c.ma20) ma20Data.push({ time, value: c.ma20 });
        if (c.ma60) ma60Data.push({ time, value: c.ma60 });
        if (c.ma120) ma120Data.push({ time, value: c.ma120 });
    });

    candleSeries.setData(candleData);
    volumeSeries.setData(volData);
    ma5Series.setData(ma5Data);
    ma20Series.setData(ma20Data);
    ma60Series.setData(ma60Data);
    ma120Series.setData(ma120Data);

    // Set Initial Visible Range (Last 1 Month ≈ 22 bars)
    if (candles.length > 22) {
        chart.timeScale().setVisibleLogicalRange({
            from: candles.length - 22,
            to: candles.length - 1,
        });
    } else {
        chart.timeScale().fitContent();
    }

    // Update Title with Dynamic Range Info
    const isMobile = window.innerWidth <= 700;
    const titleEl = document.getElementById('chartTitle');
    if (titleEl) {
        titleEl.innerHTML = `<i class="ph ph-chart-line-up" style="margin-right: 6px;"></i> 최근 12개월 주가 분석 (줌/드래그 지원)`;
    }
    // Resize handling
    window.addEventListener('resize', () => {
        if (currentChart) {
            currentChart.applyOptions({ width: container.clientWidth });
        }
    });

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
    document.getElementById('buySignalBadge').textContent = `${strength}%`;
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
    document.getElementById('sellSignalBadge').textContent = `${strength}%`;
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
        const noteHtml = `<div id="sellAtrNote" style="margin-top: 12px; font-size: 0.8rem; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 8px; border: 1px dashed var(--border-soft); line-height: 1.4; color: var(--text-muted);">`
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
        const navAnalysis = document.getElementById('navAnalysis');
        const navValueChain = document.getElementById('navValueChain');
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

            // Show restricted menus for authenticated users
            if (navWatchlist) navWatchlist.style.display = 'flex';
            if (navAnalysis) navAnalysis.style.display = 'flex';
            if (navValueChain) navValueChain.style.display = 'flex';

            if (addWatchlistBtnContainer) addWatchlistBtnContainer.classList.remove('remove');
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

            // 비로그인(Guest)에게는 핵심 분석 메뉴를 숨김 (v54 Update)
            if (navAnalysis) navAnalysis.style.display = 'none';
            if (navValueChain) navValueChain.style.display = 'none';
            if (navWatchlist) navWatchlist.style.display = 'none';

            // 게스트가 제한된 섹션(관심종목 등) 접근 시 홈으로 리다이렉트
            const restricted = ['watchlistSection', 'analysisSection', 'valueChainSection'];
            if (restricted.includes(currentActiveSectionId)) {
                navigateToSection('navHome');
                showModal(); // 로그인 유도 모달 노출
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
