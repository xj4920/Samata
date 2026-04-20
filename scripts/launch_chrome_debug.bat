@echo off
setlocal enabledelayedexpansion

:: === MUST run as Administrator (for netsh portproxy + firewall) ===
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo [!] This script needs to run as Administrator
    echo     Right-click launch_chrome_debug.bat -^> "Run as administrator"
    echo.
    pause
    exit /b 1
)

set PORT=9222
set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
:: Independent profile: avoids conflict with your daily Chrome.
:: First time you run this, you'll need to log in to sites you want (e.g. xiaohongshu).
:: Login state persists here across runs.
set PROFILE_DIR=C:\chrome-debug-profile

if not exist %CHROME% (
    echo Error: Chrome not found at %CHROME%
    pause
    exit /b 1
)

:: --- Step 1: Start Chrome with CDP on 127.0.0.1:PORT ---
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo [=] Port %PORT% already listening. Reusing existing Chrome instance.
) else (
    echo [+] Launching Chrome with remote debugging on 127.0.0.1:%PORT% ...
    echo     Profile dir: %PROFILE_DIR%
    start "" %CHROME% --remote-debugging-port=%PORT% --remote-allow-origins=* --user-data-dir="%PROFILE_DIR%" --no-first-run --no-default-browser-check

    echo     Waiting for Chrome CDP to be ready ...
    set /a WAIT=0
    :wait_loop
    timeout /t 1 /nobreak >nul
    curl -s http://127.0.0.1:%PORT%/json/version >nul 2>&1
    if errorlevel 1 (
        set /a WAIT+=1
        if !WAIT! geq 30 (
            echo [!] Chrome did not open CDP within 30s. Abort.
            pause
            exit /b 1
        )
        goto wait_loop
    )
    echo     Chrome CDP ready.
)

:: --- Step 2: Configure netsh portproxy: 0.0.0.0:PORT -> 127.0.0.1:PORT ---
echo.
echo [+] Configuring portproxy 0.0.0.0:%PORT% -^> 127.0.0.1:%PORT% ...
netsh interface portproxy delete v4tov4 listenport=%PORT% listenaddress=0.0.0.0 >nul 2>&1
netsh interface portproxy add v4tov4 listenport=%PORT% listenaddress=0.0.0.0 connectport=%PORT% connectaddress=127.0.0.1
if errorlevel 1 (
    echo [!] portproxy setup failed
    pause
    exit /b 1
)

:: --- Step 3: Open Windows firewall for the port ---
echo [+] Adding Windows Firewall rule for port %PORT% ...
netsh advfirewall firewall delete rule name="Chrome CDP %PORT%" >nul 2>&1
netsh advfirewall firewall add rule name="Chrome CDP %PORT%" dir=in action=allow protocol=TCP localport=%PORT% >nul

:: --- Step 4: Done, print current config ---
echo.
echo === Chrome CDP ready for WSL2 access ===
netsh interface portproxy show v4tov4
echo.
echo   From WSL2:
echo     curl http://172.19.32.1:%PORT%/json/version
echo.
echo   To remove portproxy later:
echo     netsh interface portproxy delete v4tov4 listenport=%PORT% listenaddress=0.0.0.0
echo.
echo Press any key to exit (Chrome keeps running).
pause >nul
