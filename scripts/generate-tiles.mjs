// 타일 이미지(SVG)를 public/tiles/ 에 만든다. 디자인은 실물 식스틴 타일을 따른다.
//
//   npm run tiles            없는 파일만 새로 만든다 (직접 수정한 파일은 그대로 둠)
//   npm run tiles -- --force 모든 파일을 이 스크립트의 디자인으로 다시 만든다 (수정한 내용이 덮어써짐!)
//
// 숫자(DM Serif Display)와 글자(Arimo)는 글꼴 파일에서 윤곽선(path)으로 변환해 넣으므로
// 어느 기기에서나 똑같이 보인다. 글꼴: SIL Open Font License (@fontsource 패키지).
//
// 파일 이름 규칙 (게임이 이 이름으로 불러온다)
//   {색}-{숫자}.svg   숫자 타일 1~15      예) red-7.svg
//   {색}-restart.svg  16 RESTART
//   {색}-end.svg      16 END
//   scissors.svg      가위
//   trash.svg         쓰레기통
//   back.svg          다른 사람의 가려진 타일 (뒷면)
//   색: red, orange, green, blue, black
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import opentype from 'opentype.js';

const OUT = new URL('../public/tiles/', import.meta.url);
const force = process.argv.includes('--force');

const COLORS = {
  red: '#e2231a',
  orange: '#f18a00',
  green: '#12924a',
  blue: '#1d74c4',
  black: '#141414',
};
const NAMES = { red: '빨강', orange: '주황', green: '초록', blue: '파랑', black: '검정' };

const loadFont = async (pkg, file) => {
  const buf = await readFile(new URL(`../node_modules/@fontsource/${pkg}/files/${file}`, import.meta.url));
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
};
const SERIF = await loadFont('dm-serif-display', 'dm-serif-display-latin-400-normal.woff');
const SANS = await loadFont('arimo', 'arimo-latin-700-normal.woff');

// 타일 크기: 가로 100, 세로 104 (흰 정사각 윗면 + 아래·오른쪽 그림자)
const W = 100;
const H = 104;

/** 글자를 한 글자씩 배치한 path (opentype.js 의 텍스트 셰이핑은 일부 글꼴에서 오류가 나서 쓰지 않는다) */
function glyphRun(font, text, x, y, size, spacing = 0) {
  const scale = size / font.unitsPerEm;
  const commands = [];
  let pen = x;
  for (const ch of text) {
    const g = font.charToGlyph(ch);
    commands.push(...g.getPath(pen, y, size).commands);
    pen += g.advanceWidth * scale + spacing * size;
  }
  return commands;
}

function bbox(commands) {
  const xs = [];
  const ys = [];
  for (const c of commands) {
    for (const k of ['x', 'x1', 'x2']) if (c[k] !== undefined) xs.push(c[k]);
    for (const k of ['y', 'y1', 'y2']) if (c[k] !== undefined) ys.push(c[k]);
  }
  return { x1: Math.min(...xs), x2: Math.max(...xs), y1: Math.min(...ys), y2: Math.max(...ys) };
}

/**
 * 글자를 윤곽선 path 로 변환한다.
 * height: 숫자(또는 대문자) 높이, cx: 가운데 x, cy: 글자 세로 가운데, maxW: 최대 너비
 */
function textPath(font, text, { height, cx, cy, maxW = 90, spacing = 0, ref = '8' }) {
  const probe = bbox(glyphRun(font, ref, 0, 0, 100));
  let size = (100 * height) / (probe.y2 - probe.y1);
  let box = bbox(glyphRun(font, text, 0, 0, size, spacing));
  if (box.x2 - box.x1 > maxW) {
    size *= maxW / (box.x2 - box.x1);
    box = bbox(glyphRun(font, text, 0, 0, size, spacing));
  }
  const capH = (probe.y2 - probe.y1) * (size / 100);
  const baseline = cy + capH / 2;
  const x = cx - (box.x1 + box.x2) / 2;
  return pathData(glyphRun(font, text, x, baseline, size, spacing));
}

// opentype.js 의 toPathData 는 8.000000000000009 같은 값을 NaN 으로 출력하는 버그가 있어 직접 만든다.
function pathData(commands) {
  const n = (v) => String(Math.round(v * 100) / 100);
  return commands.map((c) => {
    if (c.type === 'M' || c.type === 'L') return `${c.type}${n(c.x)} ${n(c.y)}`;
    if (c.type === 'Q') return `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`;
    if (c.type === 'C') return `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`;
    return 'Z';
  }).join('');
}

function tile(title, inner, { face = '#ffffff', stroke = '#e6e6e6', defs = '' } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <title>${title}</title>
  <defs>
    <filter id="soft" x="-10%" y="-10%" width="130%" height="130%"><feGaussianBlur stdDeviation="1.6"/></filter>${defs}
  </defs>
  <!-- 그림자 -->
  <rect x="4" y="6" width="95" height="95" rx="16" fill="#000" opacity="0.18" filter="url(#soft)"/>
  <!-- 타일 윗면 -->
  <rect x="1.5" y="1.5" width="95" height="95" rx="16" fill="${face}" stroke="${stroke}" stroke-width="1.2"/>
${inner}
</svg>
`;
}

const pathEl = (d, fill) => `  <path d="${d}" fill="${fill}"/>`;
// 라벨(START/END/RESTART)은 실물처럼 굵게 보이도록 같은 색 테두리를 살짝 두른다
const labelEl = (d, fill, w = 0.9) => `  <path d="${d}" fill="${fill}" stroke="${fill}" stroke-width="${w}" stroke-linejoin="round"/>`;

function numberTile(c, n) {
  const color = COLORS[c];
  const parts = [];
  if (n === 1) {
    parts.push(pathEl(textPath(SERIF, '1', { height: 52, cx: 49, cy: 38 }), color));
    parts.push(labelEl(textPath(SANS, 'START', { height: 10, cx: 49, cy: 77, maxW: 56, ref: 'S' }), color));
  } else if (n === 6 || n === 9) {
    // 6과 9를 구분하는 점
    parts.push(pathEl(textPath(SERIF, String(n), { height: 56, cx: 49, cy: 44 }), color));
    parts.push(`  <circle cx="49" cy="83" r="4.2" fill="${color}"/>`);
  } else {
    parts.push(pathEl(textPath(SERIF, String(n), { height: 60, cx: 49, cy: 48, maxW: 82 }), color));
  }
  return tile(`${NAMES[c]} ${n}`, parts.join('\n'));
}

function endTile(c) {
  const color = COLORS[c];
  return tile(`${NAMES[c]} 16 END`, [
    pathEl(textPath(SERIF, '16', { height: 52, cx: 49, cy: 40, maxW: 82 }), color),
    labelEl(textPath(SANS, 'END', { height: 10, cx: 49, cy: 78, maxW: 60, ref: 'E' }), color),
  ].join('\n'));
}

function restartTile(c) {
  const color = COLORS[c];
  // 16 둘레를 반시계 방향으로 도는 화살표 4개
  const loop = `  <g fill="none" stroke="${color}" stroke-width="7" stroke-linejoin="round">
    <path d="M85 45 V21 a8 8 0 0 0 -8 -8 H41"/>
    <path d="M27 13 H21 a8 8 0 0 0 -8 8 V37"/>
    <path d="M13 54 V77 a8 8 0 0 0 8 8 H57"/>
    <path d="M71 85 H77 a8 8 0 0 0 8 -8 V61"/>
  </g>
  <g fill="${color}">
    <path d="M42 3 L42 23 L28 13 Z"/>
    <path d="M3 36 L23 36 L13 50 Z"/>
    <path d="M56 75 L56 95 L70 85 Z"/>
    <path d="M75 62 L95 62 L85 48 Z"/>
  </g>`;
  return tile(`${NAMES[c]} 16 RESTART`, [
    loop,
    pathEl(textPath(SERIF, '16', { height: 38, cx: 49, cy: 42, maxW: 52 }), color),
    labelEl(textPath(SANS, 'RESTART', { height: 8, cx: 49, cy: 70, maxW: 58, ref: 'R' }), color, 0.7),
  ].join('\n'));
}

function scissorsTile() {
  return tile('가위', `  <g fill="#141414">
    <!-- 날 (위 손잡이 → 아래쪽 날, 아래 손잡이 → 위쪽 날) -->
    <path d="M28 40 L38 41.5 L51 47.5 L96 57 L93.5 61 L49 55 L31 47.5 Z"/>
    <path d="M28 60 L38 58.5 L51 52.5 L96 43 L93.5 39 L49 45 L31 52.5 Z"/>
  </g>
  <g fill="none" stroke="#141414" stroke-width="5.5">
    <!-- 손잡이 -->
    <ellipse cx="20" cy="36" rx="9.5" ry="8.5"/>
    <ellipse cx="20" cy="64" rx="9.5" ry="8.5"/>
  </g>
  <circle cx="50" cy="50" r="1.8" fill="#fff"/>`);
}

function trashTile() {
  return tile('쓰레기통', `  <g fill="#141414">
    <!-- 뚜껑 -->
    <g transform="rotate(-4 49 20)">
      <rect x="42" y="10" width="14" height="6" rx="1.5"/>
      <rect x="19" y="16" width="61" height="8" rx="2"/>
    </g>
    <!-- 통 -->
    <path d="M24 30 H74 L69 86 a5 5 0 0 1 -5 4.5 H34 a5 5 0 0 1 -5 -4.5 Z"/>
  </g>
  <g fill="#fff">
    <rect x="34" y="38" width="7" height="44" rx="3.5"/>
    <rect x="45.5" y="38" width="7" height="44" rx="3.5"/>
    <rect x="57" y="38" width="7" height="44" rx="3.5"/>
  </g>`);
}

function backTile() {
  const defs = `
    <linearGradient id="back" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#feda75"/>
      <stop offset="0.3" stop-color="#fa7e1e"/>
      <stop offset="0.6" stop-color="#d62976"/>
      <stop offset="1" stop-color="#4f5bd5"/>
    </linearGradient>`;
  return tile('가려진 타일', pathEl(textPath(SERIF, '16', { height: 40, cx: 49, cy: 49, maxW: 70 }), 'rgba(255,255,255,0.92)'),
    { face: 'url(#back)', stroke: 'none', defs });
}

const files = {};
for (const c of Object.keys(COLORS)) {
  for (let n = 1; n <= 15; n++) files[`${c}-${n}.svg`] = numberTile(c, n);
  files[`${c}-restart.svg`] = restartTile(c);
  files[`${c}-end.svg`] = endTile(c);
}
files['scissors.svg'] = scissorsTile();
files['trash.svg'] = trashTile();
files['back.svg'] = backTile();

await mkdir(OUT, { recursive: true });
let written = 0;
let skipped = 0;
for (const [name, svg] of Object.entries(files)) {
  const url = new URL(name, OUT);
  if (!force && existsSync(url)) {
    skipped++;
    continue;
  }
  await writeFile(url, svg);
  written++;
}
console.log(`public/tiles: ${written}개 생성, ${skipped}개 유지${skipped && !force ? ' (다시 만들려면 --force)' : ''}`);
