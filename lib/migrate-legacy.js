'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { listLegacyDataCandidates } = require('./runtime-paths');

function stamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function isValidCapital(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    // 空账本合法
    for (const [k, v] of Object.entries(obj)) {
        if (k.startsWith('_')) continue;
        if (!v || typeof v !== 'object') return false;
        if (typeof v.capital !== 'number') return false;
        if (v.history != null && !Array.isArray(v.history)) return false;
    }
    return true;
}

function isPristineCapital(obj) {
    return isValidCapital(obj) && Object.keys(obj).every((key) => key.startsWith('_'));
}

function isValidConfig(obj) {
    return !!obj && typeof obj === 'object' && !Array.isArray(obj);
}

function isPristineConfig(obj, defaultConfig = null) {
    if (!isValidConfig(obj)) return false;
    if (isValidConfig(defaultConfig)) return isDeepStrictEqual(obj, defaultConfig);
    const admins = Array.isArray(obj.adminIds) ? obj.adminIds.filter(Boolean) : [];
    const groups = Array.isArray(obj.allowedGroupIds) ? obj.allowedGroupIds.filter(Boolean) : [];
    return admins.length === 0 && groups.length === 0;
}

async function readJsonSafe(file) {
    const text = await fsp.readFile(file, 'utf8');
    return JSON.parse(text);
}

async function pathExists(p) {
    try {
        await fsp.access(p);
        return true;
    } catch (_) {
        return false;
    }
}

async function copyFileSafe(src, dest) {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
}

async function copyDirRecursive(src, dest) {
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const ent of entries) {
        const s = path.join(src, ent.name);
        const d = path.join(dest, ent.name);
        if (ent.isDirectory()) await copyDirRecursive(s, d);
        else if (ent.isFile()) await fsp.copyFile(s, d);
    }
}

async function isDirectoryEmpty(dir) {
    if (!(await pathExists(dir))) return true;
    const entries = await fsp.readdir(dir);
    return entries.length === 0;
}

function normalizeComparablePath(p) {
    return path.normalize(path.resolve(p)).toLowerCase();
}

function jsonEqual(a, b) {
    return isDeepStrictEqual(a, b);
}

async function backupExistingFile(src, backupDir, prefix) {
    const dest = path.join(backupDir, `${prefix}-${stamp()}.json`);
    await copyFileSafe(src, dest);
    return dest;
}

/**
 * 迁移旧根目录 data → userData（复制，不删除旧数据）
 */
async function migrateLegacyData(runtimePaths, app, logger = console, options = {}) {
    const markerPath = runtimePaths.migrationMarkerPath;
    const result = {
        version: 3,
        status: 'pending',
        migratedAt: new Date().toISOString(),
        sourcePath: null,
        destinationPath: runtimePaths.dataDir,
        capitalMigrated: false,
        configMigrated: false,
        sessionMigrated: false,
        backupsMigrated: false,
        conflicts: [],
        skipped: false,
        error: null
    };

    let previousMarker = null;
    if (await pathExists(markerPath)) {
        try {
            previousMarker = await readJsonSafe(markerPath);
        } catch (error) {
            logger.warn?.(`⚠️ 旧迁移标记无法解析，将重新扫描: ${error.message}`);
        }
    }

    const destNorm = path.normalize(path.resolve(runtimePaths.dataDir)).toLowerCase();
    const rawCandidates = Array.isArray(options.legacyCandidates)
        ? options.legacyCandidates
        : listLegacyDataCandidates(app);
    const candidates = rawCandidates
        .map((p) => path.normalize(path.resolve(p)))
        .filter((p) => p.toLowerCase() !== destNorm);

    let sourceRoot = null;
    let backupOnlySource = null;
    for (const cand of candidates) {
        if (!(await pathExists(cand))) continue;
        const hasCapital = await pathExists(path.join(cand, 'capital.json'));
        const hasConfig = await pathExists(path.join(cand, 'config.json'));
        const hasSession = await pathExists(path.join(cand, 'session-whatsapp-bot-v2'));
        const hasBackups = await pathExists(path.join(cand, 'backups'));
        if (hasCapital || hasConfig || hasSession) {
            sourceRoot = cand;
            break;
        }
        if (hasBackups && !backupOnlySource) backupOnlySource = cand;
    }
    sourceRoot = sourceRoot || backupOnlySource;

    if (!sourceRoot) {
        // 全新用户：无旧数据
        result.status = 'fresh-install';
        result.sourcePath = null;
        await fsp.writeFile(markerPath, JSON.stringify({ ...result, note: 'fresh-install' }, null, 2));
        return result;
    }

    result.sourcePath = sourceRoot;

    // 只有确实从同一来源完成过迁移的 marker 才能跳过。
    // v2 的 fresh-install marker（sourcePath=null）不得阻断后续导入。
    if (
        previousMarker &&
        Number(previousMarker.version) >= 3 &&
        previousMarker.sourcePath &&
        options.force !== true
    ) {
        const sameSource =
            normalizeComparablePath(previousMarker.sourcePath) === normalizeComparablePath(sourceRoot);
        const sourceHasCapital = await pathExists(path.join(sourceRoot, 'capital.json'));
        const sourceHasConfig = await pathExists(path.join(sourceRoot, 'config.json'));
        const sourceHasSession = await pathExists(path.join(sourceRoot, 'session-whatsapp-bot-v2'));
        let capitalOk = !sourceHasCapital;
        let configOk = !sourceHasConfig;
        if (sourceHasCapital && (await pathExists(runtimePaths.capitalPath))) {
            try {
                capitalOk = isValidCapital(await readJsonSafe(runtimePaths.capitalPath));
            } catch (_) {
                capitalOk = false;
            }
        }
        if (sourceHasConfig && (await pathExists(runtimePaths.configPath))) {
            try {
                configOk = isValidConfig(await readJsonSafe(runtimePaths.configPath));
            } catch (_) {
                configOk = false;
            }
        }
        const sessionOk = !sourceHasSession || (await pathExists(runtimePaths.sessionDir));
        if (sameSource && capitalOk && configOk && sessionOk) {
            result.status = previousMarker.status || 'completed';
            result.skipped = true;
            logger.log?.('✅ 已从同一旧数据目录完成迁移，跳过重复迁移');
            return result;
        }
    }

    logger.log?.(`📦 发现旧数据目录: ${sourceRoot}`);

    try {
        // --- capital.json ---
        const oldCapital = path.join(sourceRoot, 'capital.json');
        const newCapital = runtimePaths.capitalPath;
        if (await pathExists(oldCapital)) {
            let oldObj;
            try {
                oldObj = await readJsonSafe(oldCapital);
                if (!isValidCapital(oldObj)) throw new Error('旧 capital.json 结构无效');
            } catch (e) {
                throw new Error(`旧 capital.json 无法解析: ${e.message}`);
            }

            if (!(await pathExists(newCapital))) {
                await copyFileSafe(oldCapital, newCapital);
                result.capitalMigrated = true;
                logger.log?.('✅ 已复制 capital.json → 用户目录');
            } else {
                let newObj;
                let newValid = false;
                try {
                    newObj = await readJsonSafe(newCapital);
                    newValid = isValidCapital(newObj);
                } catch (_) {
                    newValid = false;
                }

                if (newValid) {
                    if (!jsonEqual(oldObj, newObj) && isPristineCapital(newObj) && !isPristineCapital(oldObj)) {
                        const backupPath = await backupExistingFile(
                            newCapital,
                            runtimePaths.backupDir,
                            'capital.pre-migration'
                        );
                        await copyFileSafe(oldCapital, newCapital);
                        result.capitalMigrated = true;
                        result.conflicts.push({
                            type: 'capital-pristine-replaced',
                            action: 'backed-up-new-copied-old',
                            backupPath
                        });
                        logger.log?.('✅ EXE 为空账本，已备份空账本并迁入旧 capital.json');
                    } else if (!jsonEqual(oldObj, newObj)) {
                        const conflictName = `capital.legacy-conflict-${stamp()}.json`;
                        const conflictPath = path.join(runtimePaths.backupDir, conflictName);
                        await copyFileSafe(oldCapital, conflictPath);
                        result.conflicts.push({
                            type: 'capital',
                            action: 'kept-new-copied-old',
                            conflictPath
                        });
                        logger.warn?.(
                            `⚠️ 新旧 capital.json 不同，已保留新文件，旧文件备份到: ${conflictPath}`
                        );
                    }
                } else {
                    // 新文件损坏：不覆盖，保存损坏副本并报错
                    const corruptName = `capital.corrupt-${stamp()}.json`;
                    const corruptPath = path.join(runtimePaths.backupDir, corruptName);
                    let corruptBackedUp = false;
                    let backupError = null;
                    try {
                        await copyFileSafe(newCapital, corruptPath);
                        corruptBackedUp = true;
                    } catch (error) {
                        backupError = error.message;
                        logger.error?.(`❌ 损坏账本备份失败: ${error.message}`);
                    }
                    result.conflicts.push({
                        type: 'capital-corrupt-new',
                        corruptPath,
                        oldCapital,
                        backupError
                    });
                    throw new Error(
                        `新 capital.json 已损坏${
                            corruptBackedUp ? `，已备份至 ${corruptPath}` : '，且损坏副本备份失败'
                        }；请人工核对旧文件 ${oldCapital}，不会自动覆盖`
                    );
                }
            }
        }

        // --- config.json ---
        const oldConfig = path.join(sourceRoot, 'config.json');
        const newConfig = runtimePaths.configPath;
        if (await pathExists(oldConfig)) {
            let oldObj;
            try {
                oldObj = await readJsonSafe(oldConfig);
                if (!isValidConfig(oldObj)) throw new Error('旧 config.json 结构无效');
            } catch (e) {
                throw new Error(`旧 config.json 无法解析: ${e.message}`);
            }

            if (!(await pathExists(newConfig))) {
                await copyFileSafe(oldConfig, newConfig);
                result.configMigrated = true;
                logger.log?.('✅ 已复制 config.json → 用户配置目录');
            } else {
                let newObj;
                try {
                    newObj = await readJsonSafe(newConfig);
                    if (!isValidConfig(newObj)) throw new Error('新 config.json 结构无效');
                } catch (e) {
                    const corruptPath = await backupExistingFile(
                        newConfig,
                        runtimePaths.backupDir,
                        'config.corrupt'
                    ).catch(() => null);
                    throw new Error(
                        `新 config.json 已损坏${corruptPath ? `，已备份至 ${corruptPath}` : ''}；不会自动覆盖`
                    );
                }

                const defaultConfigPath = path.join(runtimePaths.defaultsDir, 'config.template.json');
                const defaultConfig = (await pathExists(defaultConfigPath))
                    ? await readJsonSafe(defaultConfigPath)
                    : null;
                if (
                    !jsonEqual(oldObj, newObj) &&
                    isPristineConfig(newObj, defaultConfig) &&
                    !isPristineConfig(oldObj, defaultConfig)
                ) {
                    const backupPath = await backupExistingFile(
                        newConfig,
                        runtimePaths.backupDir,
                        'config.pre-migration'
                    );
                    await copyFileSafe(oldConfig, newConfig);
                    result.configMigrated = true;
                    result.conflicts.push({
                        type: 'config-pristine-replaced',
                        action: 'backed-up-new-copied-old',
                        backupPath
                    });
                    logger.log?.('✅ EXE 为空配置，已备份并迁入旧 config.json');
                } else if (!jsonEqual(oldObj, newObj)) {
                    const conflictName = `config.legacy-conflict-${stamp()}.json`;
                    const conflictPath = path.join(runtimePaths.backupDir, conflictName);
                    await copyFileSafe(oldConfig, conflictPath);
                    result.conflicts.push({
                        type: 'config',
                        action: 'kept-new-copied-old',
                        conflictPath
                    });
                    logger.warn?.(`⚠️ 新旧 config.json 不同，已保留新配置，旧配置备份到: ${conflictPath}`);
                }
            }
        }

        // --- session ---
        const oldSession = path.join(sourceRoot, 'session-whatsapp-bot-v2');
        const newSession = runtimePaths.sessionDir;
        if (await pathExists(oldSession)) {
            if (!(await pathExists(newSession)) || (await isDirectoryEmpty(newSession))) {
                await copyDirRecursive(oldSession, newSession);
                result.sessionMigrated = true;
                logger.log?.('✅ 已复制 session-whatsapp-bot-v2 → 用户目录');
            } else if (options.replaceSession === true) {
                const sessionBackup = path.join(runtimePaths.backupDir, `session.pre-migration-${stamp()}`);
                await copyDirRecursive(newSession, sessionBackup);
                await fsp.rm(newSession, { recursive: true, force: true });
                await copyDirRecursive(oldSession, newSession);
                result.sessionMigrated = true;
                result.conflicts.push({
                    type: 'session-replaced-explicitly',
                    action: 'backed-up-new-copied-old',
                    backupPath: sessionBackup
                });
                logger.log?.('✅ 已按显式请求备份并替换 WhatsApp session');
            } else {
                result.conflicts.push({
                    type: 'session',
                    action: 'kept-new-manual-review',
                    sourcePath: oldSession,
                    destinationPath: newSession
                });
                logger.warn?.('⚠️ 新旧 WhatsApp session 均存在，已保留 EXE session，禁止自动合并');
            }
        }

        // --- backups ---
        const oldBackups = path.join(sourceRoot, 'backups');
        if (await pathExists(oldBackups)) {
            const entries = await fsp.readdir(oldBackups);
            for (const name of entries) {
                const src = path.join(oldBackups, name);
                const dest = path.join(runtimePaths.backupDir, name);
                if (!(await pathExists(dest))) {
                    const st = await fsp.stat(src);
                    if (st.isFile()) await copyFileSafe(src, dest);
                }
            }
            result.backupsMigrated = true;
        }

        // 校验最终 capital（若存在）
        if (await pathExists(newCapital)) {
            const finalObj = await readJsonSafe(newCapital);
            if (!isValidCapital(finalObj)) {
                throw new Error('迁移后 capital.json 校验失败');
            }
        }

        result.status = result.conflicts.some((item) =>
            ['capital', 'config', 'session'].includes(item.type)
        ) ? 'completed-with-conflicts' : 'completed';
        await fsp.writeFile(markerPath, JSON.stringify(result, null, 2), 'utf8');
        logger.log?.('✅ 迁移完成，已写入 migration-v2.json（旧 data 未删除）');
        return result;
    } catch (error) {
        result.error = error.message;
        logger.error?.('❌ 迁移失败:', error.message);
        // 不写成功标记；不删除旧文件
        try {
            await fsp.writeFile(
                path.join(runtimePaths.userDataRoot, `migration-v2-failed-${stamp()}.json`),
                JSON.stringify(result, null, 2),
                'utf8'
            );
        } catch (markerError) {
            logger.error?.(`❌ 无法写入迁移失败标记: ${markerError.message}`);
        }
        throw error;
    }
}

async function ensureFreshCapital(runtimePaths) {
    if (await pathExists(runtimePaths.capitalPath)) return false;
    const templatePath = path.join(runtimePaths.defaultsDir, 'capital.template.json');
    let template = {
        _description: '资金管理配置文件 2.0'
    };
    if (await pathExists(templatePath)) {
        template = await readJsonSafe(templatePath);
    }
    await fsp.mkdir(path.dirname(runtimePaths.capitalPath), { recursive: true });
    await fsp.writeFile(runtimePaths.capitalPath, JSON.stringify(template, null, 2), 'utf8');
    return true;
}

async function ensureFreshConfig(runtimePaths, defaultConfig) {
    if (await pathExists(runtimePaths.configPath)) return false;
    const templatePath = path.join(runtimePaths.defaultsDir, 'config.template.json');
    let cfg = defaultConfig || {
        version: '2.0.0',
        adminIds: [],
        maxConcurrentGroups: 8,
        maxHistoryRecords: 1000
    };
    if (await pathExists(templatePath)) {
        cfg = await readJsonSafe(templatePath);
    }
    await fsp.mkdir(runtimePaths.configDir, { recursive: true });
    await fsp.writeFile(runtimePaths.configPath, JSON.stringify(cfg, null, 2), 'utf8');
    return true;
}

module.exports = {
    migrateLegacyData,
    ensureFreshCapital,
    ensureFreshConfig,
    isValidCapital,
    isPristineCapital,
    isValidConfig,
    isPristineConfig
};
