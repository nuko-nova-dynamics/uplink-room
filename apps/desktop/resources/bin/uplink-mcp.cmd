@echo off
rem Runs the Room API's MCP server that ships inside Uplink Room, using the app's own Electron
rem binary as Node (ADR 0042). Add to PATH in Settings puts this folder first in your user PATH.
setlocal
set "UPLINK_BIN_DIR=%~dp0"
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\Uplink Room.exe" "%~dp0..\app.asar\out\main\uplink-mcp.js" %*
