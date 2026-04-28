import sys

path = '/Users/nelcome/Documents/Antigravity_code_repository/Signnith(Stock-Search-Service)/fundamental_analysis.py'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

new_func = """def _calculate_target(qnt, current_price, shares, macro=None, ctype="GENERAL", stock_code=""):
    \"\"\"
    [v199] 3중 혼합 밸류에이션 모델 (보편적 적용 알고리즘)
    - 5-Step Engine 적용: 동적 할인율, 선행 ROE, 섹터/리더 프리미엄, 심리 보정, 밴드 산출
    \"\"\"
    if not shares or not current_price:
        return None

    macro    = macro or {}
    roe_hist = qnt.get("roe") or 10.0
    equity   = qnt.get("equity_raw", 0) or 0
    net_inc  = qnt.get("net_income_raw", 0) or 0
    score    = qnt.get("score", 50)

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
    
    # [v199] 안정성 점수(score)가 높을수록 리스크 프리미엄 감소 (안전 자산 취급)
    erp_adj = 0.055 * (1.0 - (score - 50) / 200.0) # score 90이면 erp 약 0.044로 감소
    erp = max(0.04, min(0.08, erp_adj))
    k   = max(0.05, min(0.18, rf + beta * erp))

    # 2. Forward ROE — 3단계 가중 평균
    sector_means = _SECTOR_MEANS.get(ctype, _SECTOR_MEANS["GENERAL"])
    roe_sector   = sector_means.get("roe", 10.0)
    growth_adj   = (qnt.get("qtr_growth") or 0) / 100.0
    sensitivity  = 0.6 if ctype in ("EQUIPMENT", "IDM", "BATTERY", "BIO") else 0.4
    roe_growth   = roe_hist * (1 + max(-0.35, min(0.5, growth_adj * sensitivity)))
    
    # [v199] 점수가 높고 성장이 강할수록 Forward ROE 비중 확대
    if score >= 80 and growth_adj > 0:
        roe_blended = roe_hist * 0.15 + roe_sector * 0.15 + roe_growth * 0.70
    else:
        roe_blended = roe_hist * 0.30 + roe_sector * 0.20 + roe_growth * 0.50
        
    roe_dec = max(3.0, min(55.0, roe_blended)) / 100.0

    # 3. 목표 PBR / PER + 섹터 사이클 프리미엄
    target_pbr   = sector_means.get("pbr", 1.2)
    target_per   = sector_means.get("per", 12.0)
    
    # [v199] 주도주(Market Leader) 판별: 점수 우수 & ROE 우수
    is_market_leader = (score >= 75) and (roe_blended >= 15.0)
    
    premium_map  = {
        "IDM": 1.4, "EQUIPMENT": 1.5, "BATTERY": 1.4, "BIO": 1.8,
        "EV": 1.1, "INTERNET": 1.4, "FINANCE": 0.8, "TELECOM": 0.7,
        "ENERGY": 0.9, "GENERAL": 1.0
    }
    cycle_factor = premium_map.get(ctype, 1.0)
    
    # 대장주 프리미엄 부여 (최대 2.5x ~ 3.0x 효과)
    if is_market_leader:
        cycle_factor *= 1.8 # 성장 프리미엄
        target_pbr = max(target_pbr, 15.0)
        target_per = max(target_per, 30.0)
    
    target_pbr  *= cycle_factor
    target_per  *= cycle_factor

    # 4. 심리 보정 (AI Sentiment Score Proxy)
    # VIX 매크로 외에 개별 종목의 점수를 바탕으로 Sentiment Buffer 적용
    vix = macro.get("vix", 20)
    if   vix >= 35: macro_sf = 1.15
    elif vix >= 28: macro_sf = 1.08
    elif vix >= 22: macro_sf = 1.02
    elif vix <= 13: macro_sf = 0.88
    elif vix <= 16: macro_sf = 0.94
    elif vix <= 19: macro_sf = 0.98
    else:           macro_sf = 1.00
    
    # 개별 종목 Score 기반 Sentiment (과열 방지 및 프리미엄 반영)
    if score >= 85:   micro_sf = 1.10
    elif score >= 70: micro_sf = 1.05
    elif score <= 30: micro_sf = 0.90
    else:             micro_sf = 1.00
    
    sentiment_factor = (macro_sf + micro_sf) / 2.0

    # 5. 3중 모델 혼합 산출
    def _s_rim(r, kk):
        base_val = bps + bps * (r - kk) / kk
        if is_market_leader:
            return base_val * 4.5 # 초과 이익 지속 프리미엄
        return base_val

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
        if is_market_leader:
            return (srim * 0.45 + pbr * 0.45 + per * 0.10) * sf
        return (srim * 0.30 + pbr * 0.50 + per * 0.20) * sf

    base_price    = mixed(roe_dec, k, target_pbr, target_per, sentiment_factor)
    bear_price    = mixed(roe_dec * 0.75, k + 0.01, target_pbr * 0.80, target_per * 0.80, min(sentiment_factor, 0.97))
    bull_price    = mixed(roe_dec * 1.25, k - 0.005, target_pbr * 1.20, target_per * 1.20, max(sentiment_factor, 1.03))
    analyst_price = mixed(roe_dec * 1.10, k, target_pbr * 1.5, target_per * 1.5, 1.0)
    liquidation   = bps

    # 상태 판정 (현재가 vs 밴드 위치)
    current_pbr = current_price / bps if bps > 0 else 0
    upside      = ((base_price - current_price) / current_price) * 100

    if   current_price <= bear_price:    status = "강력 저평가"
    elif current_price <= base_price:    status = "저평가"
    elif current_price <= bull_price:    status = "적정 (성장 반영)"
    elif current_price <= analyst_price: status = "고평가 (업황 기대 선반영)"
    else:                                status = "시장 프리미엄 구간"

    return {
        "liquidation": _safe_num(liquidation, 0),
        "bear":        _safe_num(bear_price, 0),
        "value":       _safe_num(base_price, 0),
        "bull":        _safe_num(bull_price, 0),
        "analyst":     _safe_num(analyst_price, 0),
        "upside":      _safe_num(upside, 1),
        "status":      status,
        "current_pbr": _safe_num(current_pbr, 2),
        "target_pbr":  _safe_num(target_pbr, 2),
        "k_rate":      _safe_num(k * 100, 2),
        "forward_roe": _safe_num(roe_blended, 2),
        "premium":     _safe_num(cycle_factor, 2),
        "sentiment":   _safe_num(sentiment_factor, 2),
        "bps":         _safe_num(bps, 0),
        "eps":         _safe_num(eps, 0),
        "method":      "3-Model Hybrid (S-RIM 30% + PBR 50% + PER 20%)",
        "shares":      _safe_num(shares, 0),
    }"""

# Find start and end
start_idx = content.find('def _calculate_target(')
end_idx = content.find('def analyze_fundamental(')

if start_idx != -1 and end_idx != -1:
    # We replace from start_idx up to the comment right before analyze_fundamental
    # Let's find the separator
    sep_idx = content.rfind('# ════════════════════════════════════════════════════════════', start_idx, end_idx)
    if sep_idx != -1:
        new_content = content[:start_idx] + new_func + '\n\n' + content[sep_idx:]
        with open(path, 'w', encoding='utf-8') as f:
            f.write(new_content)
        print("Success")
    else:
        print("Separator not found")
else:
    print("Function not found")

