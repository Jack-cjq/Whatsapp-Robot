'use strict';

/**
 * 旧 data → userData 迁移测试
 */
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const assert = require('assert');
const {
    migrateLegacyData,
    ensureFreshCapital,
    isValidCapital
} = require('../lib/migrate-legacy');
const { buildRuntimePaths, listLegacyDataCandidates } = require('../lib/runtime-paths');

async function withTempDir(fn) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wa-mig-'));
    try {
        return await fn(dir);
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }
}

function makeCapital(extra = {}) {
    return {
        _description: '资金管理配置文件 2.0',
        _keepUnknown: 'yes',
        groupA: {
            capital: 123.45,
            history: [
                {
                    id: 'h1',
                    operation: '+100',
                    customField: 'preserve'
                }
            ],
            statistics: {
                totalOperations: 1,
                createdDate: '2024-01-01T00:00:00.000Z'
            },
            extraGroupField: true
        },
        ...extra
    };
}

function makeConfig(extra = {}) {
    return {
        version: '2.0.0',
        adminIds: ['111111@lid'],
        allowedGroupIds: ['group-a@g.us'],
        maxConcurrentGroups: 4,
        maxHistoryRecords: 500,
        ...extra
    };
}

function fakeApp(userDataRoot) {
    return {
        getPath: (name) => {
            if (name === 'userData') return userDataRoot;
            return userDataRoot;
        },
        getAppPath: () => path.join(userDataRoot, 'app-fake')
    };
}

function pathsFor(root) {
    process.env.WHATSAPP_ROBOT_DATA_DIR = root;
    const app = fakeApp(root);
    return buildRuntimePaths(app);
}

async function writeJson(p, obj) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
}

async function testSafeCapitalMigration() {
    await withTempDir(async (tmp) => {
        const userRoot = path.join(tmp, 'user data 中文');
        const legacy = path.join(tmp, 'legacy data');
        await writeJson(path.join(legacy, 'capital.json'), makeCapital());
        await writeJson(path.join(legacy, 'config.json'), makeConfig());
        await fsp.mkdir(path.join(legacy, 'session-whatsapp-bot-v2', 'Default'), { recursive: true });
        await fsp.writeFile(path.join(legacy, 'session-whatsapp-bot-v2', 'Default', 'Cookies'), 'x');

        const rp = pathsFor(userRoot);
        const origCwd = process.cwd();
        process.chdir(tmp);
        // 在 cwd/data 放一份
        await fsp.mkdir(path.join(tmp, 'data'), { recursive: true });
        await fsp.cp(path.join(legacy, 'capital.json'), path.join(tmp, 'data', 'capital.json'));
        await fsp.cp(path.join(legacy, 'config.json'), path.join(tmp, 'data', 'config.json'));
        await fsp.cp(path.join(legacy, 'session-whatsapp-bot-v2'), path.join(tmp, 'data', 'session-whatsapp-bot-v2'), {
            recursive: true
        });
        const legacyData = path.join(tmp, 'data');
        try {
            const result = await migrateLegacyData(rp, fakeApp(userRoot), console, {
                legacyCandidates: [legacyData]
            });
            assert.strictEqual(result.capitalMigrated, true);
            assert.strictEqual(result.configMigrated, true);
            assert.strictEqual(result.sessionMigrated, true);
            const migrated = JSON.parse(await fsp.readFile(rp.capitalPath, 'utf8'));
            const migratedConfig = JSON.parse(await fsp.readFile(rp.configPath, 'utf8'));
            assert.strictEqual(migrated.groupA.capital, 123.45);
            assert.strictEqual(migrated._keepUnknown, 'yes');
            assert.strictEqual(migrated.groupA.history[0].customField, 'preserve');
            assert.strictEqual(migrated.groupA.extraGroupField, true);
            assert.deepStrictEqual(migratedConfig.adminIds, ['111111@lid']);
            assert.deepStrictEqual(migratedConfig.allowedGroupIds, ['group-a@g.us']);
            assert.ok(fs.existsSync(path.join(rp.sessionDir, 'Default', 'Cookies')));
            // 旧数据仍在
            assert.ok(fs.existsSync(path.join(tmp, 'data', 'capital.json')));
            assert.ok(fs.existsSync(rp.migrationMarkerPath));
        } finally {
            process.chdir(origCwd);
        }
    });
    console.log('✅ testSafeCapitalMigration');
}

async function testNoOverwriteExisting() {
    await withTempDir(async (tmp) => {
        const userRoot = path.join(tmp, 'user');
        const rp = pathsFor(userRoot);
        await writeJson(rp.capitalPath, makeCapital({ groupA: { capital: 999, history: [], statistics: {} } }));
        await fsp.mkdir(rp.sessionDir, { recursive: true });
        await fsp.writeFile(path.join(rp.sessionDir, 'marker'), 'new');

        const origCwd = process.cwd();
        process.chdir(tmp);
        await writeJson(path.join(tmp, 'data', 'capital.json'), makeCapital());
        await fsp.mkdir(path.join(tmp, 'data', 'session-whatsapp-bot-v2'), { recursive: true });
        await fsp.writeFile(path.join(tmp, 'data', 'session-whatsapp-bot-v2', 'old'), 'old');
        try {
            const result = await migrateLegacyData(rp, fakeApp(userRoot), console, {
                legacyCandidates: [path.join(tmp, 'data')]
            });
            assert.strictEqual(result.capitalMigrated, false);
            assert.strictEqual(result.sessionMigrated, false);
            const cur = JSON.parse(await fsp.readFile(rp.capitalPath, 'utf8'));
            assert.strictEqual(cur.groupA.capital, 999);
            assert.ok(fs.existsSync(path.join(rp.sessionDir, 'marker')));
            assert.ok(!fs.existsSync(path.join(rp.sessionDir, 'old')));
        } finally {
            process.chdir(origCwd);
        }
    });
    console.log('✅ testNoOverwriteExisting');
}

async function testConflictCopy() {
    await withTempDir(async (tmp) => {
        const userRoot = path.join(tmp, 'user');
        const rp = pathsFor(userRoot);
        await writeJson(rp.capitalPath, makeCapital({ groupA: { capital: 1, history: [], statistics: {} } }));

        const origCwd = process.cwd();
        process.chdir(tmp);
        await writeJson(path.join(tmp, 'data', 'capital.json'), makeCapital({ groupA: { capital: 2, history: [], statistics: {} } }));
        try {
            const result = await migrateLegacyData(rp, fakeApp(userRoot), console, {
                legacyCandidates: [path.join(tmp, 'data')]
            });
            assert.ok(result.conflicts.length >= 1);
            assert.strictEqual(JSON.parse(await fsp.readFile(rp.capitalPath, 'utf8')).groupA.capital, 1);
            const backups = await fsp.readdir(rp.backupDir);
            assert.ok(backups.some((n) => n.includes('legacy-conflict')));
        } finally {
            process.chdir(origCwd);
        }
    });
    console.log('✅ testConflictCopy');
}

async function testCorruptNewKeepsOld() {
    await withTempDir(async (tmp) => {
        const userRoot = path.join(tmp, 'user');
        const rp = pathsFor(userRoot);
        await fsp.mkdir(path.dirname(rp.capitalPath), { recursive: true });
        await fsp.writeFile(rp.capitalPath, '{broken', 'utf8');

        const origCwd = process.cwd();
        process.chdir(tmp);
        const oldCap = makeCapital();
        await writeJson(path.join(tmp, 'data', 'capital.json'), oldCap);
        try {
            let threw = false;
            try {
                await migrateLegacyData(rp, fakeApp(userRoot), console, {
                    legacyCandidates: [path.join(tmp, 'data')]
                });
            } catch (e) {
                threw = true;
                assert.ok(/损坏|人工/.test(e.message));
            }
            assert.ok(threw);
            // 新文件仍是损坏内容，未被空账本覆盖
            assert.strictEqual(await fsp.readFile(rp.capitalPath, 'utf8'), '{broken');
            // 旧文件不变
            assert.deepStrictEqual(
                JSON.parse(await fsp.readFile(path.join(tmp, 'data', 'capital.json'), 'utf8')),
                oldCap
            );
        } finally {
            process.chdir(origCwd);
        }
    });
    console.log('✅ testCorruptNewKeepsOld');
}

async function testMarkerSkipsRepeat() {
    await withTempDir(async (tmp) => {
        const userRoot = path.join(tmp, 'user');
        const rp = pathsFor(userRoot);
        const legacyData = path.join(tmp, 'data');
        await writeJson(rp.capitalPath, makeCapital());
        await writeJson(rp.migrationMarkerPath, {
            version: 3,
            status: 'completed',
            migratedAt: '2020-01-01T00:00:00.000Z',
            sourcePath: legacyData,
            capitalMigrated: true
        });
        const origCwd = process.cwd();
        process.chdir(tmp);
        await writeJson(path.join(legacyData, 'capital.json'), makeCapital({ groupA: { capital: 777, history: [], statistics: {} } }));
        try {
            const result = await migrateLegacyData(rp, fakeApp(userRoot), console, {
                legacyCandidates: [legacyData]
            });
            assert.strictEqual(result.skipped, true);
            assert.strictEqual(JSON.parse(await fsp.readFile(rp.capitalPath, 'utf8')).groupA.capital, 123.45);
        } finally {
            process.chdir(origCwd);
        }
    });
    console.log('✅ testMarkerSkipsRepeat');
}

async function testFreshMarkerAllowsLaterMigration() {
    await withTempDir(async (tmp) => {
        const userRoot = path.join(tmp, 'user');
        const legacyData = path.join(tmp, 'legacy-data');
        const rp = pathsFor(userRoot);

        await writeJson(rp.capitalPath, { _description: 'fresh' });
        await fsp.mkdir(path.dirname(rp.configPath), { recursive: true });
        await fsp.copyFile(path.join(rp.defaultsDir, 'config.template.json'), rp.configPath);
        await writeJson(rp.migrationMarkerPath, {
            version: 2,
            sourcePath: null,
            note: 'fresh-install'
        });
        await writeJson(path.join(legacyData, 'capital.json'), makeCapital());
        await writeJson(path.join(legacyData, 'config.json'), makeConfig());

        const result = await migrateLegacyData(rp, fakeApp(userRoot), console, {
            legacyCandidates: [legacyData]
        });

        assert.strictEqual(result.skipped, false);
        assert.strictEqual(result.capitalMigrated, true);
        assert.strictEqual(result.configMigrated, true);
        assert.strictEqual(result.status, 'completed');
        assert.strictEqual(JSON.parse(await fsp.readFile(rp.capitalPath, 'utf8')).groupA.capital, 123.45);
        assert.deepStrictEqual(JSON.parse(await fsp.readFile(rp.configPath, 'utf8')).adminIds, ['111111@lid']);

        const backups = await fsp.readdir(rp.backupDir);
        assert.ok(backups.some((name) => name.startsWith('capital.pre-migration-')));
        assert.ok(backups.some((name) => name.startsWith('config.pre-migration-')));

        const marker = JSON.parse(await fsp.readFile(rp.migrationMarkerPath, 'utf8'));
        assert.strictEqual(marker.version, 3);
        assert.strictEqual(marker.sourcePath, legacyData);
    });
    console.log('✅ testFreshMarkerAllowsLaterMigration');
}

async function testConfigConflictKeepsExisting() {
    await withTempDir(async (tmp) => {
        const userRoot = path.join(tmp, 'user');
        const legacyData = path.join(tmp, 'legacy-data');
        const rp = pathsFor(userRoot);
        await writeJson(rp.configPath, makeConfig({
            adminIds: [],
            allowedGroupIds: [],
            maxConcurrentGroups: 99
        }));
        await writeJson(path.join(legacyData, 'config.json'), makeConfig({ adminIds: ['legacy@lid'] }));

        const result = await migrateLegacyData(rp, fakeApp(userRoot), console, {
            legacyCandidates: [legacyData]
        });

        assert.strictEqual(result.configMigrated, false);
        assert.strictEqual(result.status, 'completed-with-conflicts');
        const current = JSON.parse(await fsp.readFile(rp.configPath, 'utf8'));
        assert.deepStrictEqual(current.adminIds, []);
        assert.strictEqual(current.maxConcurrentGroups, 99);
        const backups = await fsp.readdir(rp.backupDir);
        assert.ok(backups.some((name) => name.startsWith('config.legacy-conflict-')));
    });
    console.log('✅ testConfigConflictKeepsExisting');
}

async function testExplicitSessionReplacementCreatesBackup() {
    await withTempDir(async (tmp) => {
        const userRoot = path.join(tmp, 'user');
        const legacyData = path.join(tmp, 'legacy-data');
        const rp = pathsFor(userRoot);
        await fsp.mkdir(rp.sessionDir, { recursive: true });
        await fsp.writeFile(path.join(rp.sessionDir, 'marker'), 'new-session');
        await fsp.mkdir(path.join(legacyData, 'session-whatsapp-bot-v2'), { recursive: true });
        await fsp.writeFile(path.join(legacyData, 'session-whatsapp-bot-v2', 'marker'), 'old-session');

        const result = await migrateLegacyData(rp, fakeApp(userRoot), console, {
            legacyCandidates: [legacyData],
            replaceSession: true
        });

        assert.strictEqual(result.sessionMigrated, true);
        assert.strictEqual(await fsp.readFile(path.join(rp.sessionDir, 'marker'), 'utf8'), 'old-session');
        const backups = await fsp.readdir(rp.backupDir);
        const sessionBackup = backups.find((name) => name.startsWith('session.pre-migration-'));
        assert.ok(sessionBackup);
        assert.strictEqual(
            await fsp.readFile(path.join(rp.backupDir, sessionBackup, 'marker'), 'utf8'),
            'new-session'
        );
    });
    console.log('✅ testExplicitSessionReplacementCreatesBackup');
}

async function testPortableCandidateDiscovery() {
    await withTempDir(async (tmp) => {
        const portableDir = path.join(tmp, 'dist-release');
        const previous = process.env.PORTABLE_EXECUTABLE_DIR;
        await fsp.mkdir(portableDir, { recursive: true });
        process.env.PORTABLE_EXECUTABLE_DIR = portableDir;
        try {
            const candidates = listLegacyDataCandidates(fakeApp(path.join(tmp, 'user')))
                .map((candidate) => path.normalize(candidate).toLowerCase());
            assert.ok(candidates.includes(path.join(portableDir, 'data').toLowerCase()));
            assert.ok(candidates.includes(path.join(tmp, 'data').toLowerCase()));
        } finally {
            if (previous === undefined) delete process.env.PORTABLE_EXECUTABLE_DIR;
            else process.env.PORTABLE_EXECUTABLE_DIR = previous;
        }
    });
    console.log('✅ testPortableCandidateDiscovery');
}

async function testPrimaryDataBeatsBackupOnlyCandidate() {
    await withTempDir(async (tmp) => {
        const userRoot = path.join(tmp, 'user');
        const backupOnly = path.join(tmp, 'backup-only');
        const primary = path.join(tmp, 'primary');
        const rp = pathsFor(userRoot);
        await fsp.mkdir(path.join(backupOnly, 'backups'), { recursive: true });
        await fsp.writeFile(path.join(backupOnly, 'backups', 'old.json'), '{}');
        await writeJson(path.join(primary, 'capital.json'), makeCapital());

        const result = await migrateLegacyData(rp, fakeApp(userRoot), console, {
            legacyCandidates: [backupOnly, primary]
        });

        assert.strictEqual(result.sourcePath, primary);
        assert.strictEqual(result.capitalMigrated, true);
        assert.strictEqual(JSON.parse(await fsp.readFile(rp.capitalPath, 'utf8')).groupA.capital, 123.45);
    });
    console.log('✅ testPrimaryDataBeatsBackupOnlyCandidate');
}

async function testFreshInit() {
    await withTempDir(async (tmp) => {
        const userRoot = path.join(tmp, 'brand-new');
        const rp = pathsFor(userRoot);
        const created = await ensureFreshCapital(rp);
        assert.strictEqual(created, true);
        const obj = JSON.parse(await fsp.readFile(rp.capitalPath, 'utf8'));
        assert.ok(isValidCapital(obj));
        assert.ok(!obj.groupA);
        const keys = Object.keys(obj).filter((k) => !k.startsWith('_'));
        assert.strictEqual(keys.length, 0);
    });
    console.log('✅ testFreshInit');
}

async function testRuntimePathsPointUserData() {
    await withTempDir(async (tmp) => {
        const userRoot = path.join(tmp, 'AppData Roaming App');
        const rp = pathsFor(userRoot);
        assert.ok(rp.capitalPath.startsWith(userRoot));
        assert.ok(rp.dataDir.startsWith(userRoot));
        assert.ok(rp.sessionDataPath.startsWith(userRoot));
        assert.ok(rp.backupDir.startsWith(userRoot));
        assert.ok(rp.logsDir.startsWith(userRoot));
        assert.ok(rp.configDir.startsWith(userRoot));
        assert.ok(!rp.capitalPath.includes(path.join('Whatsapp-Robot', 'data')));
        const cands = listLegacyDataCandidates(fakeApp(userRoot));
        assert.ok(cands.length >= 2);
    });
    console.log('✅ testRuntimePathsPointUserData');
}

async function testReadonlyInstallDirStillWritableUserData() {
    await withTempDir(async (tmp) => {
        const installDir = path.join(tmp, 'Program Files App');
        const userRoot = path.join(tmp, 'Roaming App');
        await fsp.mkdir(installDir, { recursive: true });
        // 模拟安装目录无 data 可写：不在 install 写，只写 userRoot
        const rp = pathsFor(userRoot);
        await ensureFreshCapital(rp);
        await fsp.writeFile(path.join(rp.logsDir, 't.log'), 'ok');
        assert.ok(fs.existsSync(rp.capitalPath));
        assert.ok(!fs.existsSync(path.join(installDir, 'data', 'capital.json')));
    });
    console.log('✅ testReadonlyInstallDirStillWritableUserData');
}

async function main() {
    console.log('🧪 迁移测试开始');
    try {
        await testSafeCapitalMigration();
        await testNoOverwriteExisting();
        await testConflictCopy();
        await testCorruptNewKeepsOld();
        await testMarkerSkipsRepeat();
        await testFreshMarkerAllowsLaterMigration();
        await testConfigConflictKeepsExisting();
        await testExplicitSessionReplacementCreatesBackup();
        await testPortableCandidateDiscovery();
        await testPrimaryDataBeatsBackupOnlyCandidate();
        await testFreshInit();
        await testRuntimePathsPointUserData();
        await testReadonlyInstallDirStillWritableUserData();
        console.log('🎉 迁移测试全部通过');
    } finally {
        delete process.env.WHATSAPP_ROBOT_DATA_DIR;
    }
}

main().catch((err) => {
    console.error('❌', err);
    process.exit(1);
});
