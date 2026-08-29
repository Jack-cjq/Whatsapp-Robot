'use strict';

const fs = require('fs');
const path = require('path');

function findEdgePath() {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const candidates = [
        path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        localAppData ? path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function findChromePath() {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const candidates = [
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : null
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function listBrowserCandidates() {
    const edge = findEdgePath();
    const chrome = findChromePath();
    return [edge, chrome].filter((candidate, index, list) => candidate && list.indexOf(candidate) === index);
}

function getLocalAuthSessionDir(sessionDataPath) {
    return path.join(sessionDataPath, 'session-whatsapp-bot-v2');
}

function prepareBrowserProfileDir(sessionDataPath) {
    const sessionDir = getLocalAuthSessionDir(sessionDataPath);
    fs.mkdirSync(sessionDir, { recursive: true });
    const staleNames = [
        'SingletonLock',
        'SingletonCookie',
        'SingletonSocket',
        'lockfile',
        'RunningChromeVersion'
    ];
    for (const name of staleNames) {
        const stalePath = path.join(sessionDir, name);
        if (!fs.existsSync(stalePath)) continue;
        fs.unlinkSync(stalePath);
    }
}

function isBrowserLaunchError(error) {
    const message = String((error && error.message) || error || '');
    return /Failed to launch the browser/i.test(message) || /browser process/i.test(message);
}

function buildPuppeteerConfig(browserPath) {
    return {
        headless: false,
        executablePath: browserPath || undefined,
        ignoreDefaultArgs: ['--disable-extensions'],
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-gpu',
            '--disable-background-networking',
            '--window-size=1280,720'
        ],
        timeout: 120000,
        protocolTimeout: 120000
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
    findEdgePath,
    findChromePath,
    listBrowserCandidates,
    getLocalAuthSessionDir,
    prepareBrowserProfileDir,
    isBrowserLaunchError,
    buildPuppeteerConfig,
    sleep
};
