const data = {
    "btc": 72648.27,
    "btc_chg": 1.227,
    "eth": 2229.41,
    "eth_chg": 1.839,
    "fear_greed": 35,
    "kospi": 5778.01,
    "kospi_chg": -1.606,
    "nasdaq": 22910.47,
    "nasdaq_chg": 0.386,
    "sox": 8900.87,
    "sox_chg": 2.432,
    "sp500": 6823.45,
    "sp500_chg": -0.018,
    "us10y": 4.317,
    "us10y_chg": 0.024,
    "usd_krw": 1482.82,
    "usd_krw_chg": 0.353,
    "usdt": 1.0,
    "usdt_chg": 0.004,
    "vix": 20.01,
    "vix_chg": 2.668,
    "wti": 99.26,
    "wti_chg": 1.42
};

try {
    const indexData = [
        { id: 'KOSPI', name: 'KOSPI', price: data.kospi?.toLocaleString() || '-', change: `${data.kospi_chg > 0 ? '+' : ''}${data.kospi_chg != null ? data.kospi_chg.toFixed(2) : '-'}%`, up: data.kospi_chg > 0 },
        { id: 'KOSDAQ', name: 'KOSDAQ', price: data.kosdaq?.toLocaleString() || '-', change: `${data.kosdaq_chg > 0 ? '+' : ''}${data.kosdaq_chg != null ? data.kosdaq_chg.toFixed(2) : '-'}%`, up: data.kosdaq_chg > 0 },
        { id: 'S&P 500', name: 'S&P 500', price: data.sp500?.toLocaleString() || '-', change: `${data.sp500_chg > 0 ? '+' : ''}${data.sp500_chg != null ? data.sp500_chg.toFixed(2) : '-'}%`, up: data.sp500_chg > 0 },
        { id: 'NASDAQ', name: 'NASDAQ', price: data.nasdaq?.toLocaleString() || '-', change: `${data.nasdaq_chg > 0 ? '+' : ''}${data.nasdaq_chg != null ? data.nasdaq_chg.toFixed(2) : '-'}%`, up: data.nasdaq_chg > 0 },
        { id: 'PHLX SEMI', name: '필라델피아 반도체', price: data.sox?.toLocaleString() || '-', change: `${data.sox_chg > 0 ? '+' : ''}${data.sox_chg != null ? data.sox_chg.toFixed(2) : '-'}%`, up: data.sox_chg > 0 },
        { id: 'DXY', name: '달러 인덱스', price: data.dxy?.toLocaleString() || '-', change: `${data.dxy_chg > 0 ? '+' : ''}${data.dxy_chg != null ? data.dxy_chg.toFixed(2) : '-'}%`, up: data.dxy_chg > 0 },
        { id: 'WTI', name: 'WTI 유가', price: data.wti?.toLocaleString() || '-', change: `${data.wti_chg > 0 ? '+' : ''}${data.wti_chg != null ? data.wti_chg.toFixed(2) : '-'}%`, up: data.wti_chg > 0 }
    ];
    console.log("SUCCESS:", indexData);
} catch (err) {
    console.error("ERROR:", err.name, err.message);
}
