'use strict';

/**
 * 打包前端样式资源验收
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const stylesPath = path.join(ROOT, 'styles.css');
const indexPath = path.join(ROOT, 'index.html');
const iconsPath = path.join(ROOT, 'assets', 'vendor', 'icons.css');

assert.ok(fs.existsSync(stylesPath), '源码 styles.css 必须存在');
const stylesSize = fs.statSync(stylesPath).size;
assert.ok(stylesSize > 5 * 1024, `styles.css 过小: ${stylesSize}`);

const indexHtml = fs.readFileSync(indexPath, 'utf8');
assert.ok(
    /href=["']\.\/styles\.css["']/.test(indexHtml) || /href=["']styles\.css["']/.test(indexHtml),
    'index.html 必须引用 styles.css'
);
assert.ok(!/cdnjs\.cloudflare\.com.*font-awesome/i.test(indexHtml), '不应依赖 Font Awesome CDN');
assert.ok(fs.existsSync(iconsPath), '本地 icons.css 必须存在');
assert.ok(indexHtml.includes('assets/vendor/icons.css'), 'index.html 应引用本地 icons.css');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const filesText = JSON.stringify(pkg.build.files || []);
assert.ok(filesText.includes('styles.css'), 'build.files 必须包含 styles.css');
assert.ok(!filesText.includes('!styles.css'), '排除规则不得误伤 styles.css');

const stageStyles = path.join(ROOT, '.release-stage', 'styles.css');
if (fs.existsSync(path.join(ROOT, '.release-stage'))) {
    assert.ok(fs.existsSync(stageStyles), '.release-stage 中必须有 styles.css');
    assert.ok(fs.statSync(stageStyles).size > 5 * 1024, '.release-stage/styles.css 过小');
}

const asarCandidates = [
    path.join(ROOT, 'dist-release', 'win-unpacked', 'resources', 'app.asar'),
    path.join(ROOT, '.release-stage', 'dist', 'win-unpacked', 'resources', 'app.asar'),
    path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar')
];
const asarPath = asarCandidates.find((p) => fs.existsSync(p));
const requireAsar = process.env.CHECK_PACKAGED_ASAR === '1';
if (asarPath) {
    const asarModuleCandidates = [
        path.join(ROOT, 'node_modules', '@electron', 'asar'),
        path.join(ROOT, '.release-stage', 'node_modules', '@electron', 'asar')
    ];
    const asarModulePath = asarModuleCandidates.find((candidate) =>
        fs.existsSync(path.join(candidate, 'package.json'))
    );
    if (!asarModulePath) {
        const msg = '未找到项目本地 @electron/asar，无法检查已打包文件';
        if (requireAsar) assert.fail(msg);
        console.warn('⚠️', msg);
    } else {
        const { listPackage } = require(asarModulePath);
        const list = listPackage(asarPath).join('\n');
        const hasStyles = list.includes('styles.css');
        if (!hasStyles) {
            const msg = `app.asar 尚未包含 styles.css (${asarPath})，需重新打包`;
            if (requireAsar) assert.fail(msg);
            console.warn('⚠️', msg);
        } else {
            assert.ok(list.includes('index.html'), 'app.asar 必须包含 index.html');
            assert.ok(list.includes('renderer.js'), 'app.asar 必须包含 renderer.js');
            assert.ok(!list.includes('session-whatsapp-bot-v2'), 'app.asar 不得包含 session');
            console.log('✅ asar 校验通过:', asarPath);
        }
    }
} else {
    if (requireAsar) assert.fail('未找到 app.asar');
    console.log('ℹ️ 尚未找到 app.asar，跳过 asar 内容检查（构建后会覆盖）');
}

// .container 在源 CSS 中应为 flex
const css = fs.readFileSync(stylesPath, 'utf8');
assert.ok(/\.container\s*\{[^}]*display\s*:\s*flex/s.test(css), '.container 应为 flex 布局');
assert.ok(!/https?:\/\/cdn/i.test(css), 'styles.css 不应依赖外部 CDN');

console.log('✅ packaging-styles.test.js 通过, styles.css=', stylesSize, 'bytes');
