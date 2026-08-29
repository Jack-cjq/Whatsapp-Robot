'use strict';

/**
 * 校验 package.json 打包配置不会打入敏感数据 / 不要求管理员
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const build = pkg.build;

assert.ok(build, '缺少 build 配置');
assert.notStrictEqual(build.win?.requestedExecutionLevel, 'requireAdministrator');
assert.strictEqual(build.nsis?.perMachine, false);
assert.strictEqual(build.nsis?.deleteAppDataOnUninstall, false);
assert.ok(!build.extraFiles, '不应再用 extraFiles 复制 data/logs');
assert.ok(!build.extraResources || !JSON.stringify(build.extraResources).includes('"data"'), 'extraResources 不应包含 data');

const files = build.files || [];
const filesText = JSON.stringify(files);
assert.ok(filesText.includes('!data/**/*') || filesText.includes('!data/'), 'files 应排除 data');
assert.ok(filesText.includes('!logs/**/*') || filesText.includes('!logs/'), 'files 应排除 logs');
assert.ok(filesText.includes('better-sqlite3.disabled') || filesText.includes('better-sqlite3'), '应排除 better-sqlite3');
assert.ok(files.includes('styles.css') || filesText.includes('styles.css'), 'files 必须包含 styles.css');
assert.ok(files.includes('index.html'), 'files 必须包含 index.html');

assert.ok(pkg.scripts['dist:win'], '缺少 dist:win');
assert.ok(pkg.scripts['dist:all'], '缺少 dist:all');
assert.ok(!pkg.dependencies['better-sqlite3'], 'dependencies 不应包含 better-sqlite3');

const template = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'resources', 'defaults', 'capital.template.json'), 'utf8')
);
const groupKeys = Object.keys(template).filter((k) => !k.startsWith('_'));
assert.strictEqual(groupKeys.length, 0, '模板不得含真实账户');

const ico = path.join(__dirname, '..', 'assets', 'icon.ico');
if (!fs.existsSync(ico)) {
    console.warn('⚠️ assets/icon.ico 缺失，将尝试生成');
    require('../scripts/generate-icon.js');
}
assert.ok(fs.existsSync(ico), '需要有效的 assets/icon.ico');
assert.ok(fs.statSync(ico).size > 50, 'icon.ico 过小');

console.log('✅ packaging-config.test.js 通过');
