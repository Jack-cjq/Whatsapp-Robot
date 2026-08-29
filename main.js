'use strict';

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const bot = require('./bot.js');
const { buildRuntimePaths } = require('./lib/runtime-paths');
const {
    migrateLegacyData,
    ensureFreshCapital,
    ensureFreshConfig
} = require('./lib/migrate-legacy');

if (process.platform === 'win32') {
    try {
        require('child_process').execSync('chcp 65001', { stdio: 'ignore' });
    } catch (error) {
        console.warn('[ConsoleEncoding] 无法切换到 UTF-8:', error.message);
    }
}

process.stdout.setDefaultEncoding('utf8');
process.stderr.setDefaultEncoding('utf8');

let mainWindow = null;
let runtimePaths = null;
let migrationResult = null;
let isQuitting = false;
let bootError = null;

// 单实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

function resolveIcon() {
    const ico = path.join(__dirname, 'assets', 'icon.ico');
    if (fs.existsSync(ico)) return ico;
    return undefined;
}

async function prepareRuntime() {
    runtimePaths = buildRuntimePaths(app);
    console.log('📁 用户数据根目录:', runtimePaths.userDataRoot);

    try {
        migrationResult = await migrateLegacyData(runtimePaths, app, console);
    } catch (err) {
        const { listLegacyDataCandidates } = require('./lib/runtime-paths');
        bootError = {
            type: 'migration',
            message: err.message,
            sourcePaths: listLegacyDataCandidates(app),
            destinationPath: runtimePaths.dataDir,
            userDataRoot: runtimePaths.userDataRoot
        };
        bot.setMigrationBlocked(true, err.message);
        throw err;
    }

    await ensureFreshCapital(runtimePaths);
    await ensureFreshConfig(runtimePaths, bot.ConfigManager.defaultConfig);

    bot.init({
        ...runtimePaths,
        migrationBlocked: false
    });
}

function createWindow() {
    const icon = resolveIcon();
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        title: 'WhatsApp资金管理机器人 2.0',
        icon,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    bot.setMainWindow(mainWindow);

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.webContents.on('did-finish-load', async () => {
        try {
            const diagnostics = await mainWindow.webContents.executeJavaScript(`
                ({
                    location: location.href,
                    styleSheets: Array.from(document.styleSheets).map(sheet => ({
                        href: sheet.href,
                        rulesAccessible: (() => {
                            try { return sheet.cssRules.length; }
                            catch (e) { return null; }
                        })()
                    })),
                    containerDisplay: (() => {
                        const el = document.querySelector('.container');
                        return el ? getComputedStyle(el).display : null;
                    })(),
                    bodyBackground: getComputedStyle(document.body).backgroundColor
                })
            `);
            console.log('[RendererStyles]', JSON.stringify(diagnostics));
        } catch (err) {
            console.warn('[RendererStyles] 诊断失败:', err.message);
        }

        if (bootError) {
            mainWindow.webContents.send('boot-error', bootError);
        }
        if (
            migrationResult &&
            (migrationResult.capitalMigrated ||
                migrationResult.configMigrated ||
                migrationResult.sessionMigrated ||
                migrationResult.conflicts.length > 0)
        ) {
            mainWindow.webContents.send('migration-status', migrationResult);
        }
        const browser = bot.getBrowserStatus();
        if (browser.missing) {
            mainWindow.webContents.send('browser-missing', {
                message: '未检测到 Microsoft Edge 或 Google Chrome，请安装后再使用 WhatsApp 连接'
            });
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    try {
        await prepareRuntime();
        createWindow();
        // 等 UI 就绪后再拉起 Puppeteer，降低首次启动浏览器进程 Code:0 失败概率
        await new Promise((resolve) => {
            if (!mainWindow || mainWindow.isDestroyed()) {
                resolve();
                return;
            }
            if (!mainWindow.webContents.isLoading()) {
                resolve();
                return;
            }
            mainWindow.webContents.once('did-finish-load', () => resolve());
            setTimeout(resolve, 5000);
        });
        await new Promise((r) => setTimeout(r, 600));

        bot.startBot().catch((err) => {
            console.error('机器人启动失败:', err);
            bootError = { type: 'startup', message: err.message };
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('boot-error', bootError);
            }
        });
    } catch (err) {
        console.error('运行时准备失败:', err);
        bootError = bootError || { type: 'runtime', message: err.message };
        // 仍打开窗口以显示错误
        createWindow();
    }
});

app.on('before-quit', async (event) => {
    if (isQuitting) return;
    event.preventDefault();
    isQuitting = true;
    try {
        await Promise.race([
            bot.flushAndShutdown(),
            new Promise((resolve) => setTimeout(resolve, 25000))
        ]);
    } catch (error) {
        console.error('退出前清理失败:', error.message);
    } finally {
        app.exit(0);
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function logsDir() {
    return (runtimePaths && runtimePaths.logsDir) || path.join(app.getPath('userData'), 'logs');
}

ipcMain.handle('request-logs', async () => {
    try {
        const logDate = new Date().toISOString().split('T')[0];
        const logPath = path.join(logsDir(), `${logDate}.log`);
        if (!fs.existsSync(logPath)) return ['暂无日志数据'];
        const logs = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim());
        return logs.map((line) => {
            try {
                const logData = JSON.parse(line);
                const time = new Date(logData.timestamp).toLocaleTimeString();
                return `[${time}] [${logData.type}] ${logData.event || logData.action || '未知操作'}`;
            } catch (_) {
                return line;
            }
        });
    } catch (error) {
        return ['读取日志失败'];
    }
});

ipcMain.handle('request-config', async () => bot.ConfigManager.getConfig());

ipcMain.handle('update-config', async (_e, configUpdates) => {
    try {
        const savedConfig = bot.ConfigManager.saveConfig(configUpdates);
        return { success: true, config: savedConfig };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('export-data', async (_e, groupId) => {
    try {
        const data = bot.CapitalManager2.getData();
        const dir = runtimePaths ? runtimePaths.dataDir : app.getPath('userData');
        const exportPath = path.join(
            dir,
            `export_${groupId}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
        );
        fs.writeFileSync(exportPath, JSON.stringify(data, null, 2));
        return { success: true, path: exportPath };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('request-group-data', async () => {
    try {
        const data = bot.CapitalManager2.getData() || {};
        let totalOperations = 0;
        let activeGroups = 0;
        Object.keys(data).forEach((key) => {
            if (key.startsWith('_')) return;
            const groupData = data[key];
            if (groupData && typeof groupData === 'object' && groupData.capital !== undefined) {
                activeGroups++;
                totalOperations += groupData.statistics?.totalOperations || 0;
            }
        });
        return { activeGroups, totalOperations };
    } catch (_) {
        return { activeGroups: 0, totalOperations: 0 };
    }
});

ipcMain.handle('request-message-stats', async () => {
    try {
        return bot.getMessageStats();
    } catch (_) {
        return { totalMessages: 0, processedMessages: 0, failedMessages: 0, lastReset: Date.now() };
    }
});

ipcMain.handle('request-connection-status', async () => {
    try {
        return bot.getConnectionStatus();
    } catch (_) {
        return { isConnected: false, reconnectAttempts: 0, lastHeartbeat: Date.now(), uptime: 0 };
    }
});

ipcMain.handle('request-queue-status', async () => {
    try {
        return bot.MessageManager.getQueueStatus();
    } catch (_) {
        return { queueLength: 0, isProcessing: false, sendingMessages: 0 };
    }
});

ipcMain.handle('request-runtime-info', async () => ({
    userDataRoot: runtimePaths?.userDataRoot,
    capitalPath: runtimePaths?.capitalPath,
    migrationResult,
    bootError
}));
