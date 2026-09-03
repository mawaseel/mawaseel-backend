@echo off
chcp 65001 >nul
if not exist .env (
  echo [!] ملف .env غير موجود.
  echo انسخ .env.example إلى .env وضع FIREBASE_SERVICE_ACCOUNT_JSON الحقيقي.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)
echo Starting Mawaseel Admin API on http://127.0.0.1:8787
call npm start
