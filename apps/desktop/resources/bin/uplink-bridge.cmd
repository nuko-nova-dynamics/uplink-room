@echo off
rem Runs the bridge that ships inside Uplink Room, using the app's own Electron
rem binary as Node. Add to PATH in Settings, Setup puts this folder first in
rem your user PATH, so uplink-bridge works in any new terminal.
setlocal
set "UPLINK_BRIDGE_BIN_DIR=%~dp0"
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\Uplink Room.exe" "%~dp0..\app.asar\out\main\bridge.js" %*
