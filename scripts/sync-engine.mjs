// 게임 엔진 원본(supabase/functions/_shared/game.js)을 브라우저용 public/game.js 로 복사한다.
import { copyFile } from 'node:fs/promises';

await copyFile(
  new URL('../supabase/functions/_shared/game.js', import.meta.url),
  new URL('../public/game.js', import.meta.url),
);
console.log('public/game.js updated');
