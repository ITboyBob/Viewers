@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "COREPACK_HOME=%~dp0.cache\corepack"
echo OHIF Mask 演示将在 http://localhost:3000/local-mask 启动
echo 编译完成后，请在浏览器打开上述地址。
call corepack yarn dev:mask
pause
