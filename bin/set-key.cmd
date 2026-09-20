@echo off
setlocal
cd /d "%~dp0.."
echo Paste your TypeSafe API key. It is stored in %%USERPROFILE%%\.cursor\cursor-jev.env
echo Get a key: https://console.typesafe.ai
echo.
node "%~dp0cli.mjs" set-key
if errorlevel 1 pause
