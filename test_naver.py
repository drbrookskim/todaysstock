import requests
from bs4 import BeautifulSoup

code = "005930"
url = f"https://finance.naver.com/item/main.naver?code={code}"
resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"})
soup = BeautifulSoup(resp.text, 'html.parser')

# 기업 개요
summary = soup.select_one('.summary_info p')
if summary:
    print("Summary:", summary.text.strip())

# 업종
industry = soup.select_one('.section.trade_compare .h_sub a')
if industry:
    print("Industry:", industry.text.strip())
