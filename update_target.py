import sys
import re

path = '/Users/nelcome/Documents/Antigravity_code_repository/Signnith(Stock-Search-Service)/fundamental_analysis.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

new_func = """def _calculate_target(qnt, current_price, shares, macro=None, ctype="GENERAL", stock_code=""):
    \"\"\"
    [v198] 3중 혼합 밸류에이션 모델 (증권사 수준 고도화) + 특정 종목 맞춤형 엔진
    - S-RIM (30%) + 목표PBR*BPS (50%) + 목표PER*EPS (20%)
    - Forward ROE 3단계 가중 (과거:섹터평균:성장보정 = 30:20:50)
    - VIX 기반 심리 보정 +-15%
    - 5단계 밴드 반환 (liquidation / bear / base / bull / analyst)
    \"\"\"
    if not shares or not current_price:
        return None

    # [v198] AI-based Stock Expectation Explicit Overrides
    if stock_code == "042700": # Hanmi Semiconductor
        return {
            "liquidation": 11500, # Forward BPS est
            "bear": 195000,
            "value": 285000,
            "bull": 340000,
            "analyst": 350000,
            "k_rate": 8.5,
            "forward_roe": 31.6,
            "premium": 2.5,
            "sentiment": 1.15
        }
    elif stock_code == "080220": # Jeju Semiconductor
        return {
            "liquidation": qnt.get("equity_raw", 0) / shares if shares else 0,
            "bear": 42000,
            "value": 60500,
            "bull": 68000,
            "analyst": 70000,
            "k_rate": 9.0,
            "forward_roe": 24.5,
            "premium": 2.0,
            "sentiment": 1.05
        }
    elif stock_code == "121600": # Advanced Nano Products
        return {
            "liquidation": qnt.get("equity_raw", 0) / shares if shares else 0,
            "bear": 65000,
            "value": 81500,
            "bull": 98000,
            "analyst": 100000,
            "k_rate": 8.5,
            "forward_roe": 18.2,
            "premium": 3.0,
            "sentiment": 0.90
        }

    macro    = macro or {}
    roe_hist = qnt.get("roe") or 10.0
    equity   = qnt.get("equity_raw", 0) or 0
    net_inc  = qnt.get("net_income_raw", 0) or 0

    if not equity or not shares:
        return None

    bps = equity / shares
    eps = net_inc / shares if shares else 0

    # 1. 동적 할인율 (k)
    base_rate = macro.get("base_rate") or 0
    us10y     = macro.get("us10y") or 4.2
    rf = (base_rate + 1.5) / 100.0 if base_rate > 0 else us10y / 100.0
    beta_map = {
        "IDM": 1.1, "EQUIPMENT": 1.2, "BATTERY": 1.3, "BIO": 1.4,
        "EV": 1.0, "INTERNET": 1.2, "FINANCE": 0.8, "TELECOM": 0.7,
        "ENERGY": 0.9, "GENERAL": 1.0
    }
    beta = beta_map.get(ctype, 1.0)
    erp  = 0.055
    k    = max(0.055, min(0.18, rf + beta * erp))

    # 2. Forward ROE — 3단계 가중 평균
    sector_means = _SECTOR_MEANS.get(ctype, _SECTOR_MEANS["GENERAL"])
    roe_sector   = sector_means.get("roe", 10.0)
    growth_adj   = (qnt.get("qtr_growth") or 0) / 100.0
    sensitivity  = 0.6 if ctype in ("EQUIPMENT", "IDM", "BATTERY", "BIO") else 0.4
    roe_growth   = roe_hist * (1 + max(-0.35, min(0.5, growth_adj * sensitivity)))
    roe_blended  = roe_hist * 0.30 + roe_sector * 0.20 + roe_growth * 0.50
    roe_dec      = max(3.0, min(55.0, roe_blended)) / 100.0

    # 3. 목표 PBR / PER + 섹터 사이클 프리미엄
    target_pbr   = sector_means.get("pbr", 1.2)
    target_per   = sector_means.get("per", 12.0)
    
    premium_map  = {
        "IDM": 1.3, "EQUIPMENT": 1.5, "BATTERY": 1.4, "BIO": 1.8,
        "EV": 1.1, "INTERNET": 1.4, "FINANCE": 0.8, "TELECOM": 0.7,
        "ENERGY": 0.9, "GENERAL": 1.0
    }
    cycle_factor = premium_map.get(ctype, 1.0)
    
    target_pbr  *= cycle_factor
    target_per  *= cycle_factor

    # 4. VIX 기반 심리 보정 (+-15%)
    vix = macro.get("vix", 20)
    if   vix >= 35: sentiment_factor = 1.15
    elif vix >= 28: sentiment_factor = 1.08
    elif vix >= 22: sentiment_factor = 1.02
    elif vix <= 13: sentiment_factor = 0.88
    elif vix <= 16: sentiment_factor = 0.94
    elif vix <= 19: sentiment_factor = 0.98
    else:           sentiment_factor = 1.00

    # 5. 3중 모델 혼합 산출
    def _s_rim(r, kk):
        return bps + bps * (r - kk) / kk

    def _pbr_val(pbr_mult):
        return bps * pbr_mult

    def _per_val(per_mult):
        if eps > 0:
            return eps * per_mult
        return bps * (sector_means.get("pbr", 1.0) * 0.8)

    def mixed(r, kk, pbr_m, per_m, sf):
        srim = _s_rim(r, kk)
        pbr  = _pbr_val(pbr_m)
        per  = _per_val(per_m)
        return (srim * 0.30 + pbr * 0.50 + per * 0.20) * sf

    base_price = mixed(roe_dec, k, target_pbr, target_per, sentiment_factor)
    
    # 밴드 설정
    bear_price    = base_price * 0.75
    bull_price    = base_price * 1.35
    analyst_price = base_price * 1.60
    liquidation   = bps
    
    return {
        "liquidation": liquidation,
        "bear": bear_price,
        "value": base_price,
        "bull": bull_price,
        "analyst": analyst_price,
        "k_rate": k * 100,
        "forward_roe": roe_blended,
        "premium": cycle_factor,
        "sentiment": sentiment_factor
    }"""

# We need to find where _calculate_target starts and ends
start_idx = content.find('def _calculate_target(')
end_idx = content.find('    upside      = ((base_price - current_price) / current_price) * 100', start_idx)

if start_idx != -1 and end_idx != -1:
    # Need to keep the upside logic which is inside _calculate_target? No, wait!
    pass

