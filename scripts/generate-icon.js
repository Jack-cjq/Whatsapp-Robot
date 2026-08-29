'use strict';

/**
 * 生成含 16/32/48/256 尺寸的合法 Windows ICO（32bpp），满足 electron-builder >=256 要求
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
    return ~c >>> 0;
}

function makePng(size, rgba) {
    // minimal PNG encoder
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    function chunk(type, data) {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length, 0);
        const typeBuf = Buffer.from(type, 'ascii');
        const crcBuf = Buffer.alloc(4);
        crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
        return Buffer.concat([len, typeBuf, data, crcBuf]);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;
    ihdr[9] = 6; // RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    const raw = Buffer.alloc((size * 4 + 1) * size);
    for (let y = 0; y < size; y++) {
        const row = y * (size * 4 + 1);
        raw[row] = 0;
        for (let x = 0; x < size; x++) {
            const o = row + 1 + x * 4;
            const p = (y * size + x) * 4;
            raw[o] = rgba[p];
            raw[o + 1] = rgba[p + 1];
            raw[o + 2] = rgba[p + 2];
            raw[o + 3] = rgba[p + 3];
        }
    }
    const idat = zlib.deflateSync(raw, { level: 9 });
    return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function fillIconPixels(size) {
    const rgba = Buffer.alloc(size * size * 4);
    const cx = (size - 1) / 2;
    const cy = (size - 1) / 2;
    const rOuter = size * 0.46;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const o = (y * size + x) * 4;
            const dx = x - cx;
            const dy = y - cy;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d <= rOuter) {
                // WhatsApp-ish green circle
                rgba[o] = 37; // R
                rgba[o + 1] = 211; // G
                rgba[o + 2] = 102; // B
                rgba[o + 3] = 255;
                // simple white chat-dot
                if (d < rOuter * 0.28) {
                    rgba[o] = 255;
                    rgba[o + 1] = 255;
                    rgba[o + 2] = 255;
                }
            } else {
                rgba[o + 3] = 0;
            }
        }
    }
    return rgba;
}

function buildIco(sizes) {
    const images = sizes.map((s) => makePng(s, fillIconPixels(s)));
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(sizes.length, 4);

    const entries = [];
    let offset = 6 + 16 * sizes.length;
    for (let i = 0; i < sizes.length; i++) {
        const entry = Buffer.alloc(16);
        const s = sizes[i];
        entry[0] = s >= 256 ? 0 : s;
        entry[1] = s >= 256 ? 0 : s;
        entry[2] = 0;
        entry[3] = 0;
        entry.writeUInt16LE(1, 4);
        entry.writeUInt16LE(32, 6);
        entry.writeUInt32LE(images[i].length, 8);
        entry.writeUInt32LE(offset, 12);
        offset += images[i].length;
        entries.push(entry);
    }
    return Buffer.concat([header, ...entries, ...images]);
}

const out = path.join(__dirname, '..', 'assets', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
const buf = buildIco([16, 32, 48, 256]);
fs.writeFileSync(out, buf);
console.log('wrote', out, buf.length, 'bytes');
