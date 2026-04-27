import sys
import os
import json

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app import load_dart_corp_codes, DART_CORP_CODES

def check():
    load_dart_corp_codes()
    print("Hanmi Semiconductor Corp Code:", DART_CORP_CODES.get("042700"))

if __name__ == "__main__":
    check()
