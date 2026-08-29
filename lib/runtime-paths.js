'use strict';

const path = require('path');
const fs = require('fs');

/**
 * 统一运行时路径（全部落在 Electron userData，可被 WHATSAPP_ROBOT_DATA_DIR 覆盖）
 */
function buildRuntimePaths(app) {
    const envOverride = process.env.WHATSAPP_ROBOT_DATA_DIR;
    const userDataRoot = envOverride
        ? path.resolve(envOverride)
        : app.getPath('userData');

    const dataDir = path.join(userDataRoot, 'data');
    const paths = {
        userDataRoot,
        dataDir,
        capitalPath: path.join(dataDir, 'capital.json'),
        sessionDataPath: dataDir,
        sessionDir: path.join(dataDir, 'session-whatsapp-bot-v2'),
        backupDir: path.join(dataDir, 'backups'),
        logsDir: path.join(userDataRoot, 'logs'),
        configDir: path.join(userDataRoot, 'config'),
        configPath: path.join(userDataRoot, 'config', 'config.json'),
        migrationMarkerPath: path.join(userDataRoot, 'migration-v2.json'),
        defaultsDir: path.join(__dirname, '..', 'resources', 'defaults')
    };

    for (const key of ['dataDir', 'backupDir', 'logsDir', 'configDir']) {
        fs.mkdirSync(paths[key], { recursive: true });
    }
    return paths;
}

function listLegacyDataCandidates(app) {
    const candidates = [];
    const explicitLegacyDir = process.env.WHATSAPP_ROBOT_LEGACY_DATA_DIR;
    if (explicitLegacyDir) {
        candidates.push(path.resolve(explicitLegacyDir));
    }

    // electron-builder Portable 会从临时目录运行真正的 exe；原始 exe 所在目录
    // 只能通过 PORTABLE_EXECUTABLE_DIR 找到。
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (portableDir) {
        const resolvedPortableDir = path.resolve(portableDir);
        candidates.push(path.join(resolvedPortableDir, 'data'));

        // 本项目正式产物位于 dist-release/（本地构建也可能位于 dist/）。
        // 仅在这两个明确目录名下检查父目录，避免任意扫描用户目录。
        const dirName = path.basename(resolvedPortableDir).toLowerCase();
        if (dirName === 'dist-release' || dirName === 'dist') {
            candidates.push(path.join(path.dirname(resolvedPortableDir), 'data'));
        }
    }

    candidates.push(
        path.join(__dirname, '..', 'data'),
        path.join(process.cwd(), 'data'),
        path.join(path.dirname(process.execPath), 'data')
    );
    if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'data'));
    }
    if (app && typeof app.getAppPath === 'function') {
        candidates.push(path.join(app.getAppPath(), 'data'));
    }
    const seen = new Set();
    const out = [];
    for (const p of candidates) {
        const n = path.normalize(path.resolve(p));
        if (seen.has(n.toLowerCase())) continue;
        seen.add(n.toLowerCase());
        out.push(n);
    }
    return out;
}

module.exports = {
    buildRuntimePaths,
    listLegacyDataCandidates
};
