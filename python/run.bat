@echo off
rem Betium node launcher for Windows - double-click this file.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1"
echo.
pause
