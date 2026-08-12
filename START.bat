@echo off
echo ========================================
echo  College Chatbot 2 - Setup and Start
echo ========================================
echo.

cd /d "C:\Users\harsh\OneDrive\Desktop\clg chatbot2"

echo [1/3] Verifying package.json exists...
if exist "package.json" (
    echo   package.json found!
) else (
    echo   ERROR: package.json not found! Aborting.
    pause
    exit /b 1
)

echo.
echo [2/3] Installing npm packages (this may take a minute)...
call npm install

if %ERRORLEVEL% NEQ 0 (
    echo   ERROR: npm install failed!
    pause
    exit /b 1
)

echo.
echo [3/3] Starting the backend server...
echo   Server will be available at: http://localhost:5000
echo   Press CTRL+C to stop the server.
echo.
call npm run dev

pause
