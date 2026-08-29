'use strict';

/**
 * 在隔离目录准备发布依赖：将本地 whatsapp-web.js 打成 tgz 并以真实目录安装
 * 不修改开发工作区的 Junction
 *
 * RELEASE_REUSE_DEPS=1 时复用已有 .release-stage/node_modules（仅刷新源码）
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WWEB_SRC = process.env.WWEBJS_SRC || 'D:\\whatsapp-web.js';
const VENDOR = path.join(ROOT, 'vendor');
const STAGE = path.join(ROOT, '.release-stage');
const REUSE = process.env.RELEASE_REUSE_DEPS === '1';

function run(cmd, cwd) {
    console.log('>', cmd, '(cwd=' + cwd + ')');
    execSync(cmd, { cwd, stdio: 'inherit', shell: true });
}

function rimraf(p) {
    fs.rmSync(p, { recursive: true, force: true });
}

function copyFiltered(src, dest, { isRoot = false } = {}) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
        // 仅跳过项目根的 vendor/（tgz 缓存），不要跳过 assets/vendor
        if (
            [
                'node_modules',
                'dist',
                'dist-release',
                '.git',
                '.release-stage',
                '.release-stage-nm-bak',
                'data',
                'logs',
                '.wwebjs_cache',
                'test-out.txt',
                'test-out2.txt'
            ].includes(name) ||
            (isRoot && name === 'vendor')
        ) {
            continue;
        }
        const s = path.join(src, name);
        const d = path.join(dest, name);
        const st = fs.statSync(s);
        if (st.isDirectory()) {
            if (fs.existsSync(d)) rimraf(d);
            copyFiltered(s, d, { isRoot: false });
        } else {
            fs.mkdirSync(path.dirname(d), { recursive: true });
            fs.copyFileSync(s, d);
        }
    }
}

function assertFrontendAssets(stageRoot) {
    const required = ['index.html', 'styles.css', 'renderer.js', 'preload.js', 'main.js', 'bot.js'];
    for (const name of required) {
        const p = path.join(stageRoot, name);
        if (!fs.existsSync(p)) throw new Error('发布目录缺少前端/入口文件: ' + name);
    }
    const stylesSize = fs.statSync(path.join(stageRoot, 'styles.css')).size;
    if (stylesSize < 5 * 1024) throw new Error('发布目录 styles.css 过小: ' + stylesSize);
    const icons = path.join(stageRoot, 'assets', 'vendor', 'icons.css');
    if (!fs.existsSync(icons)) throw new Error('发布目录缺少 assets/vendor/icons.css');
    console.log('✅ 前端资源齐全, styles.css=', stylesSize, 'bytes');
}

function ensureVendorTgz() {
    fs.mkdirSync(VENDOR, { recursive: true });
    let tgz = fs.readdirSync(VENDOR).find((f) => f.startsWith('whatsapp-web.js-') && f.endsWith('.tgz'));
    if (tgz) {
        console.log('复用已有 vendor tgz:', tgz);
        return tgz;
    }
    if (!fs.existsSync(path.join(WWEB_SRC, 'package.json'))) {
        throw new Error('找不到本地 whatsapp-web.js: ' + WWEB_SRC);
    }
    const ver = JSON.parse(fs.readFileSync(path.join(WWEB_SRC, 'package.json'), 'utf8')).version;
    console.log('packing whatsapp-web.js@' + ver);
    run('npm pack', WWEB_SRC);
    const tgzName = `whatsapp-web.js-${ver}.tgz`;
    const packed = path.join(WWEB_SRC, tgzName);
    if (!fs.existsSync(packed)) {
        const found = fs.readdirSync(WWEB_SRC).find((f) => f.startsWith('whatsapp-web.js-') && f.endsWith('.tgz'));
        if (!found) throw new Error('npm pack 未生成 tgz');
        fs.copyFileSync(path.join(WWEB_SRC, found), path.join(VENDOR, found));
        tgz = found;
    } else {
        fs.copyFileSync(packed, path.join(VENDOR, tgzName));
        fs.unlinkSync(packed);
        tgz = tgzName;
    }
    console.log('vendor <-', tgz);
    return tgz;
}

function main() {
    const tgz = ensureVendorTgz();
    const stageNm = path.join(STAGE, 'node_modules');
    const canReuse =
        REUSE &&
        fs.existsSync(stageNm) &&
        fs.existsSync(path.join(stageNm, 'whatsapp-web.js', 'src', 'Client.js')) &&
        fs.existsSync(path.join(stageNm, 'electron')) &&
        fs.existsSync(path.join(stageNm, 'electron-builder'));

    if (canReuse) {
        console.log('♻️ 复用 .release-stage/node_modules，仅刷新源码');
        const keepNm = path.join(ROOT, '.release-stage-nm-bak');
        rimraf(keepNm);
        fs.renameSync(stageNm, keepNm);
        rimraf(STAGE);
        fs.mkdirSync(STAGE, { recursive: true });
        copyFiltered(ROOT, STAGE, { isRoot: true });
        fs.renameSync(keepNm, stageNm);
    } else {
        rimraf(STAGE);
        console.log('staging ->', STAGE);
        copyFiltered(ROOT, STAGE, { isRoot: true });
    }

    const pkgPath = path.join(STAGE, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.dependencies['whatsapp-web.js'] = `file:vendor/${tgz}`;
    fs.mkdirSync(path.join(STAGE, 'vendor'), { recursive: true });
    fs.copyFileSync(path.join(VENDOR, tgz), path.join(STAGE, 'vendor', tgz));
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    if (!canReuse) {
        if (fs.existsSync(path.join(STAGE, 'package-lock.json'))) {
            fs.unlinkSync(path.join(STAGE, 'package-lock.json'));
        }
        run('npm install --omit=dev', STAGE);
        run('npm install --save-dev electron electron-builder --no-fund --no-audit', STAGE);
    }

    const wweb = path.join(STAGE, 'node_modules', 'whatsapp-web.js');
    const st = fs.lstatSync(wweb);
    if (st.isSymbolicLink()) {
        throw new Error('发布目录 whatsapp-web.js 仍是软链接，拒绝打包');
    }
    if (!fs.existsSync(path.join(wweb, 'src', 'Client.js')) && !fs.existsSync(path.join(wweb, 'index.js'))) {
        throw new Error('发布目录缺少 whatsapp-web.js 源码 (src/Client.js)');
    }
    console.log('✅ whatsapp-web.js 已安装为真实目录:', wweb);

    assertFrontendAssets(STAGE);

    fs.writeFileSync(
        path.join(STAGE, '.release-ready'),
        JSON.stringify({ preparedAt: new Date().toISOString(), tgz, wwebReal: true, reused: !!canReuse }, null, 2)
    );
    console.log('准备完成:', STAGE);
}

main();
