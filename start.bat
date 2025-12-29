@echo off
chcp 65001 >nul
title WhatsApp资金管理机器人 2.0
echo 正在启动 WhatsApp资金管理机器人 2.0...
echo.

REM 检查Node.js是否安装
node --version >nul 2>&1
if errorlevel 1 (
    echo 错误: 未检测到Node.js，请先安装Node.js
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)

REM 检查依赖是否安装
if not exist "node_modules" (
    echo 正在安装依赖包...
    npm install
    if errorlevel 1 (
        echo 错误: 依赖安装失败
        pause
        exit /b 1
    )
)

REM 启动应用
echo 启动中...
npm start

pause
