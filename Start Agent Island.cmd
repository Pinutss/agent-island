@echo off
rem Starts the island without a console window staying open.
start "" "%~dp0app\node_modules\electron\dist\electron.exe" "%~dp0app"
