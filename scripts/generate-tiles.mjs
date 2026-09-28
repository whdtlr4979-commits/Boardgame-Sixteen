// 타일 이미지(SVG)를 public/tiles/ 에 만든다. 디자인은 실물 식스틴 타일을 따른다.
//
//   npm run tiles            없는 파일만 새로 만든다 (직접 수정한 파일은 그대로 둠)
//   npm run tiles -- --force 모든 파일을 이 스크립트의 디자인으로 다시 만든다 (수정한 내용이 덮어써짐!)
//
// 숫자와 글자는 Baloo 2 ExtraBold 글꼴 파일에서 윤곽선(path)으로 변환해 넣으므로
// 어느 기기에서나 똑같이 보인다. 글꼴: SIL Open Font License (@fontsource/baloo-2).
// 모든 숫자(한 자리·두 자리)는 같은 글자 크기를 써서 획 두께가 똑같다.
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
const FONT = await loadFont('baloo-2', 'baloo-2-latin-800-normal.woff');

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
function textPath(font, text, { height, size: fixedSize, cx, cy, maxW = 90, spacing = 0, ref = '8' }) {
  const probe = bbox(glyphRun(font, ref, 0, 0, 100));
  let size = fixedSize ?? (100 * height) / (probe.y2 - probe.y1);
  let box = bbox(glyphRun(font, text, 0, 0, size, spacing));
  if (!fixedSize && box.x2 - box.x1 > maxW) {
    size *= maxW / (box.x2 - box.x1);
    box = bbox(glyphRun(font, text, 0, 0, size, spacing));
  }
  const capH = (probe.y2 - probe.y1) * (size / 100);
  const baseline = cy + capH / 2;
  const x = cx - (box.x1 + box.x2) / 2;
  return pathData(glyphRun(font, text, x, baseline, size, spacing));
}

// 모든 숫자 타일에 쓰는 하나의 글자 크기: 숫자 높이 50, 가장 넓은 두 자리 숫자도 너비 76 안에 들어가게
const NUM_HEIGHT = 50;
const NUM_MAX_W = 76;
const NUM_SIZE = (() => {
  const probe = bbox(glyphRun(FONT, '8', 0, 0, 100));
  let size = (100 * NUM_HEIGHT) / (probe.y2 - probe.y1);
  for (let n = 10; n <= 16; n++) {
    const b = bbox(glyphRun(FONT, String(n), 0, 0, size));
    if (b.x2 - b.x1 > NUM_MAX_W) size *= NUM_MAX_W / (b.x2 - b.x1);
  }
  return size;
})();
const numPath = (text, cy) => textPath(FONT, text, { size: NUM_SIZE, cx: 49, cy });
const labelPath = (text, cy, height = 11, maxW = 60) => textPath(FONT, text, { height, cx: 49, cy, maxW, ref: text[0] });

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

function numberTile(c, n) {
  const color = COLORS[c];
  const parts = [];
  if (n === 1) {
    parts.push(pathEl(numPath('1', 40), color));
    parts.push(pathEl(labelPath('START', 79), color));
  } else if (n === 6 || n === 9) {
    // 6과 9를 구분하는 점
    parts.push(pathEl(numPath(String(n), 44), color));
    parts.push(`  <circle cx="49" cy="83" r="4.6" fill="${color}"/>`);
  } else {
    parts.push(pathEl(numPath(String(n), 49), color));
  }
  return tile(`${NAMES[c]} ${n}`, parts.join('\n'));
}

function endTile(c) {
  const color = COLORS[c];
  return tile(`${NAMES[c]} 16 END`, [pathEl(numPath('16', 40), color), pathEl(labelPath('END', 79), color)].join('\n'));
}

function restartTile(c) {
  const color = COLORS[c];
  // 16 둘레를 반시계 방향으로 도는 화살표 4개 (둥글고 통통한 스타일)
  const loop = `  <g fill="none" stroke="${color}" stroke-width="8.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M84 44 V26 a12 12 0 0 0 -12 -12 H44"/>
    <path d="M28 14 H26 a12 12 0 0 0 -12 12 V36"/>
    <path d="M14 56 V72 a12 12 0 0 0 12 12 H54"/>
    <path d="M70 84 H72 a12 12 0 0 0 12 -12 V62"/>
  </g>
  <g fill="${color}" stroke="${color}" stroke-width="4.5" stroke-linejoin="round">
    <path d="M44 5.5 L44 22.5 L32 14 Z"/>
    <path d="M5.5 36 L22.5 36 L14 48 Z"/>
    <path d="M54 75.5 L54 92.5 L66 84 Z"/>
    <path d="M75.5 62 L92.5 62 L84 50 Z"/>
  </g>`;
  return tile(`${NAMES[c]} 16 RESTART`, [
    loop,
    // 화살표 안쪽 공간이 좁아 RESTART 타일의 16만 조금 작다
    pathEl(textPath(FONT, '16', { height: 34, cx: 49, cy: 42, maxW: 50 }), color),
    pathEl(labelPath('RESTART', 69, 8, 56), color),
  ].join('\n'));
}

const INK = '#2a2a2a';

function scissorsTile() {
  // 통통한 고리 손잡이 + 끝이 둥근 날 (두 날은 y=50 에서 교차)
  return tile('가위', `  <g fill="none" stroke="${INK}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M35 41 L87 63" stroke-width="9"/>
    <path d="M35 59 L87 37" stroke-width="9"/>
    <circle cx="25" cy="34" r="10.5" stroke-width="8"/>
    <circle cx="25" cy="66" r="10.5" stroke-width="8"/>
  </g>
  <circle cx="55.9" cy="50" r="3.2" fill="#fff"/>`);
}

function trashTile() {
  // 살짝 기울어진 둥근 뚜껑 + 둥근 통 + 흰 줄 3개
  return tile('쓰레기통', `  <g fill="${INK}" stroke="${INK}" stroke-width="3" stroke-linejoin="round">
    <g transform="rotate(-8 50 22)">
      <rect x="40" y="9" width="20" height="9" rx="4.5"/>
      <rect x="19" y="17" width="62" height="11" rx="5.5"/>
    </g>
    <path d="M25 34 H75 L70.5 84 Q70 91 63 91 H37 Q30 91 29.5 84 Z"/>
  </g>
  <g stroke="#fff" stroke-width="5.5" stroke-linecap="round">
    <path d="M38.5 45 L39.5 79"/>
    <path d="M50 45 V79"/>
    <path d="M61.5 45 L60.5 79"/>
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
  return tile('가려진 타일', pathEl(textPath(FONT, '16', { height: 40, cx: 49, cy: 49, maxW: 70 }), 'rgba(255,255,255,0.92)'),
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
