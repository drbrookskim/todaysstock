import requests
import zipfile
import io
import xml.etree.ElementTree as ET
import json

api_key = "42d504a4f6fa80f7a741f72aab727c72aa468524"

# 1. Get corpCode mapping
url = f"https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key={api_key}"
resp = requests.get(url)
if resp.status_code == 200:
    with zipfile.ZipFile(io.BytesIO(resp.content)) as z:
        with z.open('CORPCODE.xml') as f:
            tree = ET.parse(f)
            root = tree.getroot()
            
    corp_code = None
    for item in root.findall('list'):
        stock_code = item.find('stock_code').text.strip() if item.find('stock_code').text else ""
        if stock_code == "005930":
            corp_code = item.find('corp_code').text
            break
            
    print("Samsung Corp Code:", corp_code)
    
    # 2. Get company basic info
    if corp_code:
        url2 = f"https://opendart.fss.or.kr/api/company.json?crtfc_key={api_key}&corp_code={corp_code}"
        resp2 = requests.get(url2).json()
        print(json.dumps(resp2, indent=2, ensure_ascii=False))
