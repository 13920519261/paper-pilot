@echo off
chcp 936 >nul
rem PaperPilot 后台启动管理器 - 统一控制台（GUI）
rem 双击后无窗拉起 scripts\launcher.ps1（经临时 vbs 过渡，wscript 无窗口启动）。
rem 账号后台启停 / AI 模型通道增减切换实测 / 账号注册管理 全部在图形界面完成。
if not exist "%~dp0scripts\launcher.ps1" (
  echo 未找到 scripts\launcher.ps1，请确认本 bat 位于项目根目录。
  pause
  exit
)
set "tmpvbs=%TEMP%\paperpilot-launcher-bridge.vbs"
> "%tmpvbs%" echo Set s=CreateObject("Wscript.Shell"):s.Run "powershell -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File ""%~dp0scripts\launcher.ps1""",0,False
wscript.exe "%tmpvbs%"
exit
