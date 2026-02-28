import requests
import zipfile
import io
import xml.etree.ElementTree as ET
import os

DART_API_KEY = "42d504a4f6fa80f7a741f72aab727c72aa468524"

dart_corp_codes = {}

def load_dart_corp_codes():
    global dart_corp_codes
    try:
        url = f"https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key={DART_API_KEY}"
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200:
            with zipfile.ZipFile(io.BytesIO(resp.content)) as z:
                with z.open('CORPCODE.xml') as f:
                    tree = ET.parse(f)
                    root = tree.getroot()
                    
            for item in root.findall('list'):
                stock_code = item.find('stock_code').text
                if stock_code and stock_code.strip():
                    corp_code = item.find('corp_code').text
                    dart_corp_codes[stock_code.strip()] = corp_code.strip()
                    
        print(f"DART 기업코드 {len(dart_corp_codes)}개 로드 완료")
    except Exception as e:
        print(f"DART 기업코드 로드 실패: {e}")

load_dart_corp_codes()
print("Samsung (005930):", dart_corp_codes.get("005930"))
