import requests
import yfinance as yf
from deep_translator import GoogleTranslator

print("Testing Ticker.info...")
info = yf.Ticker("005930.KS").info
print("Ticker.info done.")

print("Testing deep_translator...")
print(GoogleTranslator(source='en', target='ko').translate('Hello world'))
print("deep_translator done.")
