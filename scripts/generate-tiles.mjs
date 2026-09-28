// 타일 이미지(SVG)를 public/tiles/ 에 만든다.
//
//   npm run tiles            없는 파일만 새로 만든다 (직접 수정한 파일은 그대로 둠)
//   npm run tiles -- --force 모든 파일을 이 스크립트의 디자인으로 다시 만든다 (수정한 내용이 덮어써짐!)
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
import { mkdir, writeFile } from 'node:fs/promises';

const OUT = new URL('../public/tiles/', import.meta.url);
const force = process.argv.includes('--force');

const COLORS = {
  red: '#d7263d',
  orange: '#ef7d12',
  green: '#15935a',
  blue: '#2466d1',
  black: '#262626',
};
const NAMES = { red: '빨강', orange: '주황', green: '초록', blue: '파랑', black: '검정' };

// 타일 크기: 가로 100, 세로 108 (아래 7은 타일 옆면)
const W = 100;
const H = 108;
const EDGE = 7;
const FACE_H = H - EDGE - 2;
const SERIF = "Georgia, 'Noto Serif', 'Times New Roman', serif";
const SANS = "'Helvetica Neue', Arial, 'Noto Sans KR', sans-serif";

function tile(title, inner, { face = 'url(#face)', stroke = '#e0dacd' } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <title>${title}</title>
  <defs>
    <linearGradient id="face" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.55" stop-color="#faf9f5"/>
      <stop offset="1" stop-color="#ebe6db"/>
    </linearGradient>
    <linearGradient id="back" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#feda75"/>
      <stop offset="0.3" stop-color="#fa7e1e"/>
      <stop offset="0.6" stop-color="#d62976"/>
      <stop offset="1" stop-color="#4f5bd5"/>
    </linearGradient>
  </defs>
  <!-- 타일 옆면 -->
  <rect x="1" y="${EDGE + 1}" width="98" height="${FACE_H}" rx="17" fill="#d3ccbb"/>
  <!-- 타일 윗면 -->
  <rect x="1" y="1" width="98" height="${FACE_H}" rx="17" fill="${face}" stroke="${stroke}" stroke-width="1.5"/>
${inner}
</svg>
`;
}

function numberText(n, color, y, size) {
  return `  <text x="50" y="${y}" text-anchor="middle" font-family="${SERIF}" font-weight="700" font-size="${size}" letter-spacing="-3" fill="${color}">${n}</text>`;
}

function labelText(label, color, y, size) {
  return `  <text x="50" y="${y}" text-anchor="middle" font-family="${SANS}" font-weight="900" font-size="${size}" fill="${color}">${label}</text>`;
}

function numberTile(c, n) {
  const color = COLORS[c];
  const inner = n === 1
    ? [numberText(1, color, 64, 60), labelText('START', color, 84, 13)].join('\n')
    : numberText(n, color, 70, n >= 10 ? 54 : 60);
  return tile(`${NAMES[c]} ${n}`, inner);
}

function endTile(c) {
  const color = COLORS[c];
  return tile(`${NAMES[c]} 16 END`, [numberText(16, color, 64, 54), labelText('END', color, 84, 13)].join('\n'));
}

function restartTile(c) {
  const color = COLORS[c];
  // 16 둘레를 도는 화살표 테두리
  const loop = `  <g fill="none" stroke="${color}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M28 14 H70 a10 10 0 0 1 10 10 V42"/>
    <path d="M72 88 H30 a10 10 0 0 1 -10 -10 V60"/>
  </g>
  <path d="M71 40 L80 53 L89 40 Z" fill="${color}"/>
  <path d="M11 62 L20 49 L29 62 Z" fill="${color}"/>`;
  return tile(`${NAMES[c]} 16 RESTART`, [loop, numberText(16, color, 61, 38), labelText('RESTART', color, 75, 9)].join('\n'));
}

function iconTile(title, paths) {
  // 24x24 아이콘을 타일 가운데에 크게 그린다
  return tile(title, `  <g transform="translate(22 22) scale(2.33)" fill="none" stroke="#1f1f1f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    ${paths}
  </g>`);
}

function backTile() {
  return tile('가려진 타일', numberText(16, 'rgba(255,255,255,0.9)', 66, 44), { face: 'url(#back)', stroke: 'none' });
}

const files = {};
for (const c of Object.keys(COLORS)) {
  for (let n = 1; n <= 15; n++) files[`${c}-${n}.svg`] = numberTile(c, n);
  files[`${c}-restart.svg`] = restartTile(c);
  files[`${c}-end.svg`] = endTile(c);
}
files['scissors.svg'] = iconTile('가위', '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/>');
files['trash.svg'] = iconTile('쓰레기통', '<path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>');
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
