@echo off
title Brightspace MCP setup
echo.
echo  Brightspace MCP setup
echo  This connects D2L Brightspace to your AI apps. It only reads, never changes anything.
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is needed first. Opening the download page...
  echo  Install it, then double-click this file again.
  start "" https://nodejs.org/en/download
  echo.
  pause
  exit /b 1
)
call npx -y https://brightspacemcp.com/pro/brightspace-mcp-pro.tgz setup
echo.
pause
